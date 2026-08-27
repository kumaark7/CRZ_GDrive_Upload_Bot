#!/usr/bin/env python3
import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

try:
    import libtorrent as lt
except Exception as exc:
    print(f"python3-libtorrent is required: {exc}", file=sys.stderr)
    sys.exit(2)

STOP = False

def on_signal(_sig, _frame):
    global STOP
    STOP = True

signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)

def emit(event_type, **kwargs):
    print(json.dumps({"type": event_type, **kwargs}, ensure_ascii=False), flush=True)

def make_session():
    # Keep settings conservative and reliable for a small VPS.
    settings = {
        "enable_dht": True,
        "enable_lsd": True,
        "enable_upnp": False,
        "enable_natpmp": False,
        "connections_limit": 250,
        "alert_mask": int(lt.alert.category_t.error_notification)
    }
    try:
        return lt.session(settings)
    except Exception:
        return lt.session()

def add_handle(ses, args):
    save_path = str(Path(args.save_path).resolve())
    Path(save_path).mkdir(parents=True, exist_ok=True)

    if args.magnet:
        atp = lt.parse_magnet_uri(args.magnet)
        atp.save_path = save_path
        return ses.add_torrent(atp)

    ti = lt.torrent_info(str(Path(args.torrent).resolve()))
    return ses.add_torrent({"ti": ti, "save_path": save_path})

def wait_metadata(handle):
    started = time.time()
    last = 0
    while not handle.has_metadata():
        if STOP:
            raise KeyboardInterrupt()
        now = time.time()
        if now - last >= 2:
            st = handle.status()
            emit(
                "metadata",
                elapsed=int(now - started),
                peers=int(getattr(st, "num_peers", 0)),
                seeds=int(getattr(st, "num_seeds", 0))
            )
            last = now
        if now - started > 180:
            raise RuntimeError("Timed out waiting for torrent metadata")
        time.sleep(0.5)

def torrent_files(handle):
    ti = handle.torrent_file()
    storage = ti.files()
    out = []
    for i in range(storage.num_files()):
        p = storage.file_path(i)
        size = int(storage.file_size(i))
        out.append({"index": i, "path": p, "name": os.path.basename(p), "size": size})
    return out

def tracker_count(handle):
    try:
        return len(handle.trackers())
    except Exception:
        return 0

def health_label(seeds, peers):
    if seeds >= 15:
        return "Excellent"
    if seeds >= 5:
        return "Good"
    if seeds >= 1:
        return "Fair"
    if peers >= 1:
        return "Poor"
    return "Unknown"

def do_preflight(args):
    ses = make_session()
    h = add_handle(ses, args)
    wait_metadata(h)

    files = torrent_files(h)
    try:
        h.prioritize_files([0] * len(files))
    except Exception:
        for f in files:
            try:
                h.file_priority(f["index"], 0)
            except Exception:
                pass

    started = time.time()
    best_seeds = 0
    best_peers = 0
    last = 0

    while time.time() - started < args.sample_seconds:
        if STOP:
            raise KeyboardInterrupt()
        st = h.status()
        best_seeds = max(best_seeds, int(getattr(st, "num_seeds", 0)))
        best_peers = max(best_peers, int(getattr(st, "num_peers", 0)))
        now = time.time()
        if now - last >= 2:
            emit(
                "health",
                elapsed=int(now - started),
                seeds=best_seeds,
                peers=best_peers,
                trackers=tracker_count(h),
                health=health_label(best_seeds, best_peers)
            )
            last = now
        time.sleep(0.5)

    emit(
        "result",
        mode="preflight",
        files=files,
        seeds=best_seeds,
        peers=best_peers,
        trackers=tracker_count(h),
        health=health_label(best_seeds, best_peers),
        name=h.status().name
    )

def set_one_file(handle, files, selected):
    priorities = [0] * len(files)
    if selected < 0 or selected >= len(files):
        raise RuntimeError("Invalid torrent file selection")
    priorities[selected] = 7
    try:
        handle.prioritize_files(priorities)
    except Exception:
        for i, prio in enumerate(priorities):
            handle.file_priority(i, prio)

def do_download(args):
    ses = make_session()
    h = add_handle(ses, args)
    wait_metadata(h)
    files = torrent_files(h)
    set_one_file(h, files, args.file_index)

    selected = files[args.file_index]
    started = time.time()
    last = 0
    previous_done = 0
    previous_time = started

    while True:
        if STOP:
            raise KeyboardInterrupt()

        st = h.status()
        wanted = int(getattr(st, "total_wanted", 0))
        done = int(getattr(st, "total_wanted_done", 0))
        rate = int(getattr(st, "download_rate", 0))
        seeds = int(getattr(st, "num_seeds", 0))
        peers = int(getattr(st, "num_peers", 0))

        now = time.time()
        if now - last >= 2:
            percent = int(done * 100 / wanted) if wanted else 0
            eta = int((wanted - done) / rate) if wanted and rate > 0 else None
            emit(
                "progress",
                done=done,
                total=wanted or selected["size"],
                percent=max(0, min(100, percent)),
                speed=rate,
                eta=eta,
                seeds=seeds,
                peers=peers,
                elapsed=int(now - started)
            )
            last = now

        if wanted > 0 and done >= wanted:
            break

        # Guard against impossible selection states.
        if now - started > 24 * 3600:
            raise RuntimeError("Torrent download exceeded 24 hours")
        time.sleep(0.5)

    full_path = str(Path(args.save_path).resolve() / selected["path"])
    if not os.path.exists(full_path):
        raise RuntimeError(f"Selected torrent file was not created: {full_path}")

    emit(
        "result",
        mode="download",
        file_path=full_path,
        filename=selected["name"],
        size=os.path.getsize(full_path)
    )

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["preflight", "download"])
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--magnet")
    src.add_argument("--torrent")
    parser.add_argument("--save-path", required=True)
    parser.add_argument("--sample-seconds", type=int, default=12)
    parser.add_argument("--file-index", type=int, default=-1)
    args = parser.parse_args()

    try:
        if args.mode == "preflight":
            do_preflight(args)
        else:
            do_download(args)
    except KeyboardInterrupt:
        emit("cancelled")
        sys.exit(130)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
