#!/usr/bin/env node
// Offline tests for the automatic proxy pool — no real network.

import { fetchFreshProxies, parseProxyLines, parseGeonodeJson, ProxyPool } from './collector/lib/proxy-pool.mjs';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// fake source responses
const texts = {
  'http://api.a/plain': '1.2.3.4:8080\n5.6.7.8:3128\nbadline\n9.9.9.9:99999\n',
  'http://api.geonode/json': JSON.stringify({ data: [
    { ip: '10.0.0.1', port: '80', protocols: ['http'] },
    { ip: '10.0.0.2', port: 443, protocols: ['socks5'] },
  ] }),
};
const fakeFetch = async url => texts[url] ?? '';
const FAKE_SOURCES = ['http://api.a/plain', 'http://api.geonode/json'];

try {
  // ---- parse ----
  {
    const parsed = parseProxyLines('1.2.3.4:8080\nsocks5://5.6.7.8:1080\nhttp://9.9.9.9:3128\ngarbage\n');
    check(parsed.length === 3, 'plain text parsing accepts host:port + scheme');
    check(parsed[1].protocol === 'socks5', 'protocol preserved for socks5');
    check(parsed[2].protocol === 'http', 'protocol normalized to http');
  }
  {
    const geo = parseGeonodeJson(texts["http://api.geonode/json"]);
    check(geo.length === 2, 'geonode JSON parsing works');
    check(geo[1].protocol === 'socks5', 'geonode protocol mapped');
  }

  // ---- fetchFreshProxies ----
  {
    const list = await fetchFreshProxies({ fetchImpl: fakeFetch, max: 100, sources: FAKE_SOURCES });
    check(list.length >= 3, 'fetched and merged across sources');
    const keys = new Set(list.map(p => `${p.protocol}://${p.host}:${p.port}`));
    check(keys.size === list.length, 'no duplicates');
  }

  // ---- ProxyPool with fake validator ----
  {
    const good = ['1.2.3.4:8080', '5.6.7.8:3128'];
    const pool = new ProxyPool({
      fetchImpl: fakeFetch,
      curl: 'fake',
      minPool: 2,
      maxValidated: 10,
    });
    // patch validateProxy to use the fake list (host:port matches "good")
    const orig = (await import('./collector/lib/proxy-pool.mjs')).validateProxy;
    const real = (await import('./collector/lib/proxy-pool.mjs')).validateProxy;
    // We can't easily monkeypatch ESM import binding; instead test the class
    // by injecting through _validateBatch override: use a subclass.
    class FakePool extends ProxyPool {
      async _validateBatch() {
        const batch = this.candidates.splice(0, this.maxValidated * 2);
        for (const p of batch) {
          const key = `${p.host}:${p.port}`;
          if (good.includes(key)) this.pool.push(p);
          else this.stats.failed++;
        }
        this.stats.usable = this.pool.length;
      }
    }
    const fp = new FakePool({ fetchImpl: fakeFetch, minPool: 2, maxValidated: 10, sources: FAKE_SOURCES });
    const ok = await fp.ensurePool();
    check(ok === true, 'pool becomes usable after validation');
    check(fp.size >= 2, 'only good proxies in pool');
    const a = await fp.next();
    const b = await fp.next();
    check(a && b && a.host !== b.host, 'rotation returns different proxies');
    check(fp.toUrl(a) === 'http://1.2.3.4:8080', 'toUrl renders correctly');
  }
} catch (e) {
  failures++;
  console.error('FATAL', e);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall pool checks passed');
process.exit(failures ? 1 : 0);
