const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const initData = tg?.initData || '';
const jsonHeaders = { 'X-Telegram-Init-Data': initData, 'Content-Type': 'application/json' };
const connection = document.querySelector('#connection');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
const refresh = document.querySelector('#refresh');
const uploads = document.querySelector('#uploads');
const fileInput = document.querySelector('#fileInput');
const chooseFile = document.querySelector('#chooseFile');
const fileMessage = document.querySelector('#fileMessage');
const urlInput = document.querySelector('#urlInput');
const uploadUrl = document.querySelector('#uploadUrl');
const urlMessage = document.querySelector('#urlMessage');
let connected = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...jsonHeaders, ...(options.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function stateLabel(item) {
  if (item.state === 'waiting') return `Waiting${item.queuePosition ? ` · #${item.queuePosition}` : ''}`;
  if (item.state === 'done') return '100% · Complete';
  if (item.state === 'cancelled') return 'Cancelled';
  if (item.state === 'failed') return `Failed${item.error ? ` · ${item.error}` : ''}`;
  return item.percent == null
    ? `${item.uploaded || '0 B'} uploaded`
    : `${item.percent}% · ${item.uploaded} / ${item.total}`;
}

function renderUploads(items) {
  if (!items.length) {
    uploads.innerHTML = '<span class="muted">No uploads yet.</span>';
    return;
  }

  uploads.innerHTML = items.map(item => {
    const running = item.state === 'waiting' || item.state === 'uploading';
    const stats = [item.elapsed ? `⏱ ${item.elapsed}` : '', item.averageSpeed ? `⚡ ${item.averageSpeed}` : '']
      .filter(Boolean).join(' · ');
    return `<div class="upload">
      <div class="uploadTop"><strong>${escapeHtml(item.filename)}</strong><span class="state ${item.state}">${escapeHtml(item.state)}</span></div>
      <span>${escapeHtml(stateLabel(item))}</span>
      ${stats ? `<span>${escapeHtml(stats)}</span>` : ''}
      <span>📁 ${escapeHtml(item.destination || '')}</span>
      ${running ? `<button class="cancelButton" data-cancel="${item.id}">Cancel</button>` : ''}
    </div>`;
  }).join('');

  uploads.querySelectorAll('[data-cancel]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/upload/${button.dataset.cancel}/cancel`, { method: 'POST' });
        await load();
      } catch (error) {
        tg?.showAlert?.(error.message);
      }
    });
  });
}

async function load() {
  try {
    const data = await api('/api/status');
    connected = data.connected;
    connection.textContent = data.connected ? 'Connected ✅' : 'Not Connected';
    connect.hidden = data.connected;
    disconnect.hidden = !data.connected;
    chooseFile.disabled = !data.connected;
    uploadUrl.disabled = !data.connected;
    renderUploads(data.uploads);
  } catch (error) {
    connected = false;
    connection.textContent = 'Open inside Telegram';
    uploads.textContent = error.message;
  }
}

connect.addEventListener('click', async () => {
  const { url } = await api('/api/connect', { method: 'POST' });
  tg?.openLink(url);
});

disconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect Google Drive?')) return;
  await api('/api/disconnect', { method: 'POST' });
  await load();
});

chooseFile.addEventListener('click', () => {
  if (!connected) return;
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  if (!files.length) return;
  fileMessage.textContent = `${files.length} file${files.length === 1 ? '' : 's'} selected`;

  const uploads = files.map(file => uploadBrowserFile(file));
  await Promise.allSettled(uploads);
  fileInput.value = '';
  fileMessage.textContent = 'File transfer submitted.';
  await load();
});

function uploadBrowserFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload/file');
    xhr.setRequestHeader('X-Telegram-Init-Data', initData);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) {
        fileMessage.textContent = `Sending ${file.name}...`;
        return;
      }
      const percent = Math.floor((event.loaded / event.total) * 100);
      fileMessage.textContent = `Sending ${file.name}: ${percent}%`;
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        try { reject(new Error(JSON.parse(xhr.responseText).error || 'Upload failed')); }
        catch { reject(new Error('Upload failed')); }
      }
    };
    xhr.onerror = () => reject(new Error('Network error while sending file'));
    xhr.send(file);
  });
}

uploadUrl.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  urlMessage.textContent = 'Adding URL...';
  try {
    await api('/api/upload/url', { method: 'POST', body: JSON.stringify({ url }) });
    urlInput.value = '';
    urlMessage.textContent = 'Added to upload queue.';
    await load();
  } catch (error) {
    urlMessage.textContent = error.message;
  }
});

refresh.addEventListener('click', load);
setInterval(load, 4000);
load();
