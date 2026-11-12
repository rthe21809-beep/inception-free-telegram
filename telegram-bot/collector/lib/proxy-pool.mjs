// ProxyPool — automatically sources fresh HTTP/SOCKS proxies from public
// lists, health-checks them, and hands them out on demand (rotating).
//
// Used by the collector so each warmup attempt can exit through a different
// IP. Proxies are refetched automatically when the pool runs low or ages.
//
// Sources (free public lists; plain-text or JSON):
//   - proxyscrape.com v2/v3 API
//   - geonode.com JSON API
//   - GitHub raw lists (TheSpeedX, monosans, etc.)
//
// Validation: each candidate is probed with `curl -x <proxy> -m 5
// https://api.ipify.org` (expects HTTP 200). A proxy that cannot reach the
// public internet in ~5s is discarded.

const SOURCES = [
  // proxyscrape v2: plain text, one "host:port" per line
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=yes&anonymity=all',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=all',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
  // geonode: JSON
  'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps%2Csocks4%2Csocks5',
  // GitHub raw lists
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  // other plain-text lists
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://www.proxy-list.download/api/v1/get?type=socks4',
  'https://www.proxy-list.download/api/v1/get?type=socks5',
  'https://api.openproxylist.xyz/http.txt',
  'https://api.openproxylist.xyz/socks4.txt',
  'https://api.openproxylist.xyz/socks5.txt',
  'https://proxyspace.pro/http.txt',
  'https://proxyspace.pro/socks4.txt',
  'https://proxyspace.pro/socks5.txt',
];

const KEEP_FRESH_MS = 30 * 60 * 1000;   // refetch sources after 30 min
const MIN_POOL = 5;                       // trigger refill below this
const MAX_VALIDATED = 25;                 // stop validating after this many
const VALIDATE_TIMEOUT_MS = 6000;

async function fetchTextCurl(url, timeoutMs = 25000) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '-m', String(Math.floor(timeoutMs / 1000)), '-L', url], { timeout: timeoutMs + 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`curl: ${String(stderr || err.message).slice(0, 120)}`));
      else resolve(stdout);
    });
  });
}

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'inception-collector/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    // fall back to curl (helps in minimal containers where undici TLS acts up)
    return fetchTextCurl(url, timeoutMs + 5000);
  } finally {
    clearTimeout(t);
  }
}

export function parseProxyLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // accept "host:port" or "protocol://host:port"
    let m = line.match(/^(?:(https?|socks4|socks5):\/\/)?([^:]+):(\d{1,5})$/i);
    if (!m) continue;
    const protocol = (m[1] || 'http').toLowerCase();
    const host = m[2];
    const port = parseInt(m[3], 10);
    if (!host || !port || port < 1 || port > 65535) continue;
    out.push({ host, port, protocol });
  }
  return out;
}

export function parseGeonodeJson(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data.data)) return [];
    return data.data.map(p => ({
      host: p.ip,
      port: parseInt(p.port, 10),
      protocol: (p.protocols && p.protocols.length ? p.protocols[0] : 'http').toLowerCase(),
    })).filter(p => p.host && p.port);
  } catch {
    return [];
  }
}

export async function fetchFreshProxies({ fetchImpl = null, max = 800, sources = SOURCES, onSource } = {}) {
  const get = fetchImpl || fetchText;
  const seen = new Set();
  const proxies = [];
  for (const url of sources) {
    try {
      const text = await get(url);
      const parsed = url.includes('geonode')
        ? parseGeonodeJson(text)
        : parseProxyLines(text);
      if (onSource) onSource(url, parsed.length, null);
      for (const p of parsed) {
        const key = `${p.protocol}://${p.host}:${p.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        proxies.push(p);
        if (proxies.length >= max) return proxies;
      }
    } catch (e) {
      if (onSource) onSource(url, 0, String(e?.message || e).slice(0, 120));
      // keep going with the next source
    }
  }
  return proxies;
}

// Probe a proxy with curl. Returns true when it can reach the public web.
export async function validateProxy(proxy, { curl = 'curl', timeoutMs = VALIDATE_TIMEOUT_MS } = {}) {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => {
    const scheme = proxy.protocol === 'socks4' ? 'socks4' : proxy.protocol === 'socks5' ? 'socks5' : 'http';
    const proxyUrl = `${scheme}://${proxy.host}:${proxy.port}`;
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, timeoutMs + 500);
    const child = execFile(curl, ['-x', proxyUrl, '-m', String(Math.floor(timeoutMs / 1000)), '-s', '-o', '/dev/null', '-w', '%{http_code}', 'https://api.ipify.org'], (err, stdout) => {
      clearTimeout(t);
      resolve(!err && String(stdout).trim() === '200');
    });
  });
}

export class ProxyPool {
  constructor({ fetchImpl = null, curl = 'curl', minPool = MIN_POOL, maxValidated = MAX_VALIDATED, sources = SOURCES } = {}) {
    this.fetchImpl = fetchImpl;   // null -> fetchText (fetch + curl fallback)
    this.curl = curl;
    this.minPool = minPool;
    this.maxValidated = maxValidated;
    this.sources = sources;
    this.pool = [];          // validated proxies
    this.candidates = [];    // unvalidated candidates awaiting validation
    this.lastFetch = 0;
    this.cursor = 0;
    this.stats = { fetched: 0, validated: 0, failed: 0, usable: 0 };
  }

  get size() { return this.pool.length; }

  // Ensure we have a pool: fetch candidates if stale, validate as needed.
  async ensurePool() {
    if (Date.now() - this.lastFetch > KEEP_FRESH_MS) {
      try {
        const fresh = await fetchFreshProxies({
          fetchImpl: this.fetchImpl || null,
          sources: this.sources,
          onSource: (url, n, err) => {
            if (err) console.log(`[proxy-pool] source FAILED ${url.slice(0, 70)} — ${err}`);
            else console.log(`[proxy-pool] source ok ${url.slice(0, 70)} — ${n} proxies`);
          },
        });
        this.candidates = fresh;
        this.lastFetch = Date.now();
        this.stats.fetched += fresh.length;
        console.log(`[proxy-pool] fetched ${fresh.length} candidates from ${this.sources.length} sources`);
      } catch (e) {
        console.log(`[proxy-pool] fetch failed: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    if (this.pool.length < this.minPool && this.candidates.length) {
      await this._validateBatch();
    }
    return this.pool.length > 0;
  }

  async _validateBatch() {
    const batch = this.candidates.splice(0, this.maxValidated * 2);
    const results = await Promise.allSettled(
      batch.map(async p => ({ p, ok: await validateProxy(p, { curl: this.curl }) }))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok && this.pool.length < this.maxValidated) {
        this.pool.push(r.value.p);
        this.stats.validated++;
      } else {
        this.stats.failed++;
      }
    }
    this.stats.usable = this.pool.length;
    console.log(`[proxy-pool] validated pool now ${this.pool.length} (${this.stats.failed} failed)`);
  }

  // Pull the next usable proxy (round-robin). Returns null if none.
  async next() {
    if (!(await this.ensurePool())) return null;
    const p = this.pool[this.cursor % this.pool.length];
    this.cursor++;
    return p;
  }

  toUrl(p) {
    const scheme = p.protocol === 'socks4' ? 'socks4' : p.protocol === 'socks5' ? 'socks5' : 'http';
    return `${scheme}://${p.host}:${p.port}`;
  }
}
