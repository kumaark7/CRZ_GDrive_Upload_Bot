#!/usr/bin/env python3
"""
Generic Movie Bypasser – stops at the final download page and extracts ALL 4 links.
"""

import requests
from bs4 import BeautifulSoup
import re
import sys
import argparse
import logging
import time
import random
import json
from urllib.parse import urljoin, urlparse
from dataclasses import dataclass, asdict
from typing import Optional, List, Dict, Callable, Any
from functools import wraps
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import cloudscraper

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stderr)]
)
logger = logging.getLogger(__name__)


@dataclass
class BypassResult:
    success: bool
    url: Optional[str] = None
    error: Optional[str] = None
    steps_taken: List[str] = None
    metadata: Dict[str, Any] = None
    
    def __post_init__(self):
        if self.steps_taken is None:
            self.steps_taken = []
        if self.metadata is None:
            self.metadata = {}
    
    def to_dict(self) -> Dict:
        return asdict(self)
    
    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


class RateLimiter:
    def __init__(self, min_delay: float = 1.0, max_delay: float = 3.0):
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.last_request_time: Optional[float] = None
    
    def wait(self):
        if self.last_request_time is not None:
            elapsed = time.time() - self.last_request_time
            delay = random.uniform(self.min_delay, self.max_delay)
            if elapsed < delay:
                sleep_time = delay - elapsed
                logger.debug(f"Rate limiting: sleeping for {sleep_time:.2f}s")
                time.sleep(sleep_time)
        self.last_request_time = time.time()


class CircuitBreaker:
    def __init__(self, threshold: int = 5, timeout: int = 60):
        self.threshold = threshold
        self.timeout = timeout
        self.failures = 0
        self.last_failure_time: Optional[float] = None
        self.state = "CLOSED"
    
    def call(self, func: Callable, *args, **kwargs):
        if self.state == "OPEN":
            if time.time() - self.last_failure_time > self.timeout:
                self.state = "HALF_OPEN"
                self.failures = 0
            else:
                raise Exception("Circuit breaker is OPEN - too many failures")
        try:
            result = func(*args, **kwargs)
            if self.state == "HALF_OPEN":
                self.state = "CLOSED"
                self.failures = 0
            return result
        except Exception as e:
            self.failures += 1
            self.last_failure_time = time.time()
            if self.failures >= self.threshold:
                self.state = "OPEN"
                logger.error(f"Circuit breaker opened after {self.failures} failures")
            raise


def retry_on_failure(max_retries: int = 3, backoff_factor: float = 2.0):
    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            retries = 0
            last_exception = None
            while retries < max_retries:
                try:
                    return func(*args, **kwargs)
                except requests.exceptions.RequestException as e:
                    last_exception = e
                    retries += 1
                    if retries < max_retries:
                        wait_time = backoff_factor ** retries
                        logger.warning(f"Attempt {retries} failed: {e}. Retrying in {wait_time:.1f}s...")
                        time.sleep(wait_time)
            logger.error(f"All {max_retries} attempts failed")
            raise last_exception
        return wrapper
    return decorator


class GenericBypasser:
    QUALITY_PRIORITIES = {
        '2160': 5, '2160p': 5, '4k': 5, 'uhd': 5,
        '1080': 4, '1080p': 4, 'fhd': 4,
        '720': 3, '720p': 3, 'hd': 3,
        '480': 2.5, '480p': 2.5,
        '360': 2, '360p': 2,
        '320': 1.5, '320p': 1.5,
        '240': 1, '240p': 1,
    }
    
    FOLDER_SELECTORS = [
        'div.folder a',
        'div.f a',
        'div.movie-item a',
        'div.movie a',
        'div.post a',
        'div.entry a',
        'a[href*="/movie/"]',
        'a[href*="/film/"]',
        'div.content a',
    ]
    
    ENTRY_SELECTORS = [
        'div.folder a.coral',
        'div.f a',
        'a[href*="/download/"]',
        'a.download',
        'a.btn',
        'a[href*="/file/"]',
    ]
    
    def __init__(
        self,
        base_url: str = "",
        timeout: int = 15,
        max_depth: int = 15,
        min_delay: float = 1.0,
        max_delay: float = 3.0,
        max_retries: int = 3,
        proxy: Optional[str] = None
    ):
        self.base_url = base_url.rstrip('/') if base_url else None
        self.timeout = timeout
        self.max_depth = max_depth
        self.rate_limiter = RateLimiter(min_delay, max_delay)
        self.circuit_breaker = CircuitBreaker(threshold=5, timeout=60)
        self.visited_urls: set = set()
        
        self.session = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
        )
        retry_strategy = Retry(
            total=max_retries,
            backoff_factor=1.0,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "OPTIONS"]
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)
        
        # Keep cloudscraper's own browser headers. Overriding User-Agent /
        # Accept-Encoding can make some sites return a different or stripped page.
        self.session.headers.update({
            'Accept-Language': 'en-US,en;q=0.5',
        })
        if proxy:
            self.session.proxies = {'http': proxy, 'https': proxy}
            logger.info(f"Using proxy: {proxy}")
    
    def _rotate_user_agent(self):
        # cloudscraper already provides a consistent browser fingerprint.
        return
    
    def _normalize_url(self, url: str) -> str:
        if not url:
            return ""
        url = url.strip()
        if url.startswith('/'):
            if self.base_url:
                return self.base_url + url
            return url
        if not url.startswith(('http://', 'https://')):
            if self.base_url:
                return self.base_url + '/' + url.lstrip('/')
            return f"https://{url}"
        return url
    
    def _is_valid_url(self, url: str) -> bool:
        try:
            result = urlparse(url)
            return all([result.scheme, result.netloc])
        except:
            return False
    
    @retry_on_failure(max_retries=3, backoff_factor=2.0)
    def _fetch_page(self, url: str) -> BeautifulSoup:
        if not self._is_valid_url(url):
            raise ValueError(f"Invalid URL: {url}")
        if url in self.visited_urls:
            logger.warning(f"Already visited {url}, possible loop")
        self.visited_urls.add(url)
        self.rate_limiter.wait()
        logger.debug(f"Fetching: {url}")
        try:
            response = self.circuit_breaker.call(
                self.session.get, url, timeout=self.timeout, allow_redirects=True
            )
            response.raise_for_status()
            soup = BeautifulSoup(response.text, 'html.parser')
            logger.debug(
                "Fetched %s status=%s bytes=%s title=%r links=%s",
                response.url,
                response.status_code,
                len(response.text),
                soup.title.get_text(' ', strip=True) if soup.title else None,
                len(soup.find_all('a', href=True)),
            )
            return soup
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 403:
                logger.error("Access forbidden")
            elif e.response.status_code == 404:
                logger.error(f"Page not found: {url}")
            raise
    
    def _extract_quality_score(self, text: str) -> float:
        text_lower = text.lower()
        score = 0
        for pattern, priority in self.QUALITY_PRIORITIES.items():
            if pattern in text_lower:
                score = max(score, priority)
        if any(kw in text_lower for kw in ['full', 'movie', 'complete', 'original', 'hq']):
            score += 0.5
        return score
    
    def get_best_folder(self, soup: BeautifulSoup) -> Optional[str]:
        best_link = None
        best_score = -1
        
        for selector in self.FOLDER_SELECTORS:
            try:
                links = soup.select(selector)
                for link in links:
                    href = link.get('href', '')
                    text = link.get_text(strip=True)
                    if not href or href == '#':
                        continue
                    if not text or len(text) < 3:
                        continue
                    text_lower = text.lower()
                    if any(bad in text_lower for bad in ['trailer', 'demo', 'sample', 'login', 'register', 'home', 'telegram', 'facebook', 'twitter']):
                        continue
                    full_url = self._normalize_url(href)
                    if not self._is_valid_url(full_url):
                        continue
                    # Never choose the page we are already processing. Some movie pages
                    # contain a self-link with a good score, which previously prevented
                    # the real next page (for example an Original/HD page) from being used.
                    if full_url in self.visited_urls:
                        continue

                    href_lower = href.lower()
                    score = self._extract_quality_score(text)
                    if any(key in href_lower for key in ['original', 'movie-original', '-hd', '/download/', '/file/']):
                        score += 2.0
                    if score > best_score:
                        best_score = score
                        best_link = full_url
            except:
                continue
        
        if best_link is None:
            for link in soup.find_all('a', href=True):
                href = link['href']
                text = link.get_text(strip=True)
                if not href or not text:
                    continue
                if href == '#':
                    continue
                text_lower = text.lower()
                if any(bad in text_lower for bad in ['trailer', 'demo', 'sample']):
                    continue

                href_lower = href.lower()
                if (
                    'movie' in href_lower
                    or 'film' in href_lower
                    or 'download' in href_lower
                    or 'original' in href_lower
                    or 'hd' in href_lower
                    or 'original' in text_lower
                    or 'full movie' in text_lower
                ):
                    full_url = self._normalize_url(href)
                    if self._is_valid_url(full_url) and full_url not in self.visited_urls:
                        return full_url
        return best_link
    
    def get_movie_entry(self, soup: BeautifulSoup) -> Optional[str]:
        for selector in self.ENTRY_SELECTORS:
            try:
                links = soup.select(selector)
                for link in links:
                    href = link.get('href', '')
                    text = link.get_text(strip=True).lower()
                    if not href or href == '#':
                        continue
                    if any(bad in text for bad in ['trailer', 'demo', 'sample']):
                        continue
                    full_url = self._normalize_url(href)
                    if self._is_valid_url(full_url):
                        return full_url
            except:
                continue
        for link in soup.find_all('a', href=True):
            href = link['href']
            text = link.get_text(strip=True).lower()
            if not href or href == '#':
                continue
            if any(bad in text for bad in ['trailer', 'demo', 'sample']):
                continue
            if 'download' in href or 'download' in text:
                full_url = self._normalize_url(href)
                if self._is_valid_url(full_url):
                    return full_url
        return None
    
    def get_server_links(self, soup: BeautifulSoup, current_domain: str) -> List[str]:
        server_links = []
        for container in soup.select('div.dlink'):
            for link in container.find_all('a', href=True):
                href = link['href']
                if href and href.startswith(('http://', 'https://')):
                    if href not in server_links:
                        server_links.append(href)
        server_containers = soup.select('div.server, div.servers, div.download-links, div.download-options')
        for container in server_containers:
            for link in container.find_all('a', href=True):
                href = link['href']
                if href and href.startswith(('http://', 'https://')):
                    if href not in server_links:
                        server_links.append(href)
        for link in soup.find_all('a', href=True):
            href = link['href']
            if not href.startswith(('http://', 'https://')):
                continue
            parsed = urlparse(href)
            if parsed.netloc == current_domain:
                continue
            path = parsed.path.lower()
            if any(seg in path for seg in ['/download/', '/file/', '/view/', '/get/', '/server']):
                if href not in server_links:
                    server_links.append(href)
        if not server_links:
            for link in soup.find_all('a', href=True):
                href = link['href']
                if not href.startswith(('http://', 'https://')):
                    continue
                parsed = urlparse(href)
                if parsed.netloc == current_domain:
                    continue
                if 'download' in href.lower() or 'file' in href.lower():
                    if href not in server_links:
                        server_links.append(href)
        return server_links
    
    def get_final_download_url(self, soup: BeautifulSoup) -> Optional[str]:
        patterns = [
            r'https?://.*download\.php',
            r'https?://.*/get/',
            r'https?://.*/file/',
            r'https?://.*\.(?:mp4|mkv|avi|zip|rar)',
        ]
        for pattern in patterns:
            regex = re.compile(pattern, re.IGNORECASE)
            links = soup.find_all('a', href=regex)
            if links:
                return links[0]['href']
        forms = soup.find_all('form', action=True)
        for form in forms:
            action = form['action']
            if 'download' in action:
                return action
        for link in soup.find_all('a', href=True):
            text = link.get_text(strip=True)
            if 'Download Server' in text or 'Server' in text:
                href = link['href']
                if href.startswith(('http://', 'https://')):
                    return href
        for link in soup.find_all('a', href=True):
            href = link['href']
            if any(href.lower().endswith(ext) for ext in ['.mp4', '.mkv', '.avi', '.zip', '.rar']):
                return href
            if 'download.php' in href:
                return href
        return None
    
    def _extract_all_links_from_page(self, soup: BeautifulSoup) -> List[str]:
        """Extract all 'Download Server' and 'Watch Online Server' links from the page."""
        all_links = []
        for link in soup.find_all('a', href=True):
            text = link.get_text(strip=True)
            href = link['href']
            if 'Download Server' in text or 'Watch Online Server' in text:
                if href.startswith(('http://', 'https://')):
                    all_links.append(href)
        # If none found by text, try common containers
        if not all_links:
            for container in soup.select('div.dlink, div.wlink, div.links, div.download-options, div.watch-options'):
                for link in container.find_all('a', href=True):
                    href = link['href']
                    if href.startswith(('http://', 'https://')):
                        if href not in all_links:
                            all_links.append(href)
        return all_links

    def _extract_choices_from_page(self, soup: BeautifulSoup) -> List[Dict[str, str]]:
        """Return labeled download/watch choices while preserving page order."""
        choices = []
        seen = set()
        for link in soup.find_all('a', href=True):
            text = ' '.join(link.get_text(' ', strip=True).split())
            href = link['href']
            low = text.lower()
            if 'download server' not in low and 'watch online server' not in low:
                continue
            if not href.startswith(('http://', 'https://')) or href in seen:
                continue
            seen.add(href)
            choices.append({
                'label': text or ('Watch Server' if 'watch' in low else 'Download Server'),
                'type': 'stream' if 'watch' in low else 'download',
                'url': href,
            })

        if not choices:
            for container in soup.select('div.dlink, div.wlink, div.links, div.download-options, div.watch-options'):
                for link in container.find_all('a', href=True):
                    href = link['href']
                    if not href.startswith(('http://', 'https://')) or href in seen:
                        continue
                    text = ' '.join(link.get_text(' ', strip=True).split())
                    low = text.lower()
                    seen.add(href)
                    choices.append({
                        'label': text or f'Server {len(choices) + 1}',
                        'type': 'stream' if 'watch' in low else 'download',
                        'url': href,
                    })
        return choices
    
    def bypass(self, start_url: str) -> BypassResult:
        result = BypassResult(success=False)
        current_url = self._normalize_url(start_url)
        if not self.base_url:
            parsed = urlparse(current_url)
            self.base_url = f"{parsed.scheme}://{parsed.netloc}"
        current_domain = urlparse(current_url).netloc
        depth = 0
        
        if not self._is_valid_url(current_url):
            return BypassResult(success=False, error=f"Invalid URL: {start_url}")
        
        logger.info(f"Starting bypass from: {current_url}")
        
        try:
            while depth < self.max_depth:
                depth += 1
                logger.info(f"Step {depth}: Processing {current_url}")
                result.steps_taken.append(f"Step {depth}: {current_url}")
                
                soup = self._fetch_page(current_url)
                
                # ------------------------------------------------------------
                # DETECT DOWNLOAD PAGE AND EXTRACT ALL 4 LINKS
                # ------------------------------------------------------------
                if '/download/file/' in current_url or '/download/page/' in current_url or '/download/view/' in current_url:
                    logger.info("Reached download page – extracting links")
                    
                    # First, try to extract all links from this page
                    all_links = self._extract_all_links_from_page(soup)
                    
                    # If we got 4 links, we're done
                    if len(all_links) >= 4:
                        result.success = True
                        result.url = all_links[0]
                        result.metadata['server_links'] = all_links[:4]  # backward compatibility
                        choices = self._extract_choices_from_page(soup)
                        if choices:
                            result.metadata['choices'] = choices[:4]
                        result.steps_taken.append(f"Extracted 4 links: {all_links[:4]}")
                        logger.info(f"SUCCESS: Extracted 4 links: {all_links[:4]}")
                        return result
                    
                    # If we got 2 links (typical for intermediate page like download.moviespage.xyz),
                    # and they point to a different domain, follow the first one.
                    if len(all_links) == 2:
                        # Check if both links point to a different domain
                        first_domain = urlparse(all_links[0]).netloc
                        if first_domain and first_domain != current_domain:
                            logger.info(f"Following intermediate server link to final page: {all_links[0]}")
                            current_url = all_links[0]
                            # Continue the loop to fetch this new URL
                            continue
                        else:
                            # Same domain – maybe it's the final page but only 2 links found? Try fallback.
                            # We'll still treat as failure if we can't get 4.
                            pass
                    
                    # If we still don't have 4 links, try a different approach:
                    # Maybe the page has the download links in div.dlink etc.
                    # We already did that, so if we still have fewer than 4, error.
                    if len(all_links) < 4:
                        # Check if there are any server links we can follow to another page
                        server_links = self.get_server_links(soup, current_domain)
                        # Filter out those that point to another domain
                        external_servers = [l for l in server_links if urlparse(l).netloc != current_domain]
                        if external_servers:
                            logger.info(f"Following external server link to get more links: {external_servers[0]}")
                            current_url = external_servers[0]
                            continue
                        else:
                            result.error = f"Expected 4 links but found only {len(all_links)}: {all_links}"
                            return result
                # ------------------------------------------------------------
                
                # 1. Try to find a better quality folder
                folder_link = self.get_best_folder(soup)
                if folder_link and folder_link not in self.visited_urls:
                    current_url = folder_link
                    logger.info(f"Navigating to quality folder: {current_url}")
                    continue
                
                # 2. Look for movie entry (exclude trailers)
                entry_link = self.get_movie_entry(soup)
                if entry_link:
                    logger.info(f"Found movie entry: {entry_link}")
                    result.steps_taken.append(f"Movie entry: {entry_link}")
                    try:
                        entry_soup = self._fetch_page(entry_link)
                    except Exception as e:
                        result.error = f"Failed to fetch entry page: {str(e)}"
                        return result
                    
                    server_links = self.get_server_links(entry_soup, current_domain)
                    if not server_links:
                        if any(seg in entry_link for seg in ['/download/', '/file/', '/view/']):
                            server_links = [entry_link]
                        else:
                            result.error = "No server links found on entry page"
                            return result
                    
                    logger.info(f"Found {len(server_links)} server links: {server_links}")
                    # Follow the first server link (which is usually to the intermediate page)
                    if server_links:
                        current_url = server_links[0]
                        logger.info(f"Following first server link: {current_url}")
                        continue
                
                # 3. Fallback: direct download link
                dl_links = soup.find_all('a', href=re.compile(r'/download/.*?/'))
                if dl_links:
                    href = dl_links[0]['href']
                    current_url = self._normalize_url(href)
                    logger.info(f"Following direct download link: {current_url}")
                    continue
                
                result.error = f"No navigable elements found at depth {depth}"
                return result
            
            result.error = f"Maximum depth ({self.max_depth}) reached"
            return result
        
        except Exception as e:
            logger.exception("Unexpected error")
            result.error = f"Unexpected error: {str(e)}"
            return result
    
    def search_movie(self, query: str) -> Optional[str]:
        if not self.base_url:
            logger.error("No base URL set")
            return None
        try:
            logger.info(f"Searching for: {query}")
            soup = self._fetch_page(self.base_url)
            query_lower = query.lower()
            matches = []
            for link in soup.find_all('a', href=True):
                text = link.get_text(strip=True)
                href = link.get('href', '')
                if not text or not href:
                    continue
                text_lower = text.lower()
                score = 0
                if query_lower == text_lower:
                    score = 100
                elif query_lower in text_lower:
                    score = 50
                elif any(word in text_lower for word in query_lower.split()):
                    score = 25
                if score > 0:
                    full_url = self._normalize_url(href)
                    if self._is_valid_url(full_url):
                        matches.append((score, full_url, text))
            if matches:
                matches.sort(reverse=True)
                logger.info(f"Best match: {matches[0][2]} -> {matches[0][1]}")
                return matches[0][1]
            return None
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return None


def main():
    parser = argparse.ArgumentParser(description='Generic movie download bypasser')
    parser.add_argument('input', nargs='?', help='Movie name or URL (if empty, prompted)')
    parser.add_argument('-p', '--proxy', help='HTTP proxy')
    parser.add_argument('-t', '--timeout', type=int, default=15)
    parser.add_argument('-d', '--max-depth', type=int, default=15)
    parser.add_argument('--min-delay', type=float, default=1.0)
    parser.add_argument('--max-delay', type=float, default=3.0)
    parser.add_argument('-v', '--verbose', action='store_true')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('-o', '--output', help='Output file')
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    input_value = args.input
    if not input_value:
        print("Enter movie name or URL (paste here):")
        input_value = input().strip()
        if not input_value:
            print("No input.")
            sys.exit(1)
    
    bypasser = GenericBypasser(
        timeout=args.timeout,
        max_depth=args.max_depth,
        min_delay=args.min_delay,
        max_delay=args.max_delay,
        proxy=args.proxy
    )
    
    if not input_value.startswith(('http://', 'https://')):
        logger.info(f"Searching for: {input_value}")
        resolved = bypasser.search_movie(input_value)
        if not resolved:
            print(f"ERROR: Could not find '{input_value}'")
            sys.exit(1)
        input_value = resolved
    else:
        parsed = urlparse(input_value)
        bypasser.base_url = f"{parsed.scheme}://{parsed.netloc}"
    
    result = bypasser.bypass(input_value)
    
    if args.json:
        output = result.to_json()
    else:
        if result.success:
            output = f"\n✅ SUCCESS!\n"
            if result.metadata.get('server_links'):
                output += "All extracted links:\n"
                for i, link in enumerate(result.metadata['server_links'], 1):
                    output += f"  {i}. {link}\n"
            else:
                output += f"URL: {result.url}\n"
            output += "\nSteps:\n" + "\n".join(result.steps_taken)
        else:
            output = f"\n❌ FAILED: {result.error}\n\nSteps:\n" + "\n".join(result.steps_taken)
    
    print(output)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        logger.info(f"Saved to {args.output}")
    
    sys.exit(0 if result.success else 1)


if __name__ == "__main__":
    main()