/**
 * Phase 3 — retention and LRU eviction.
 *
 * The previous policy deleted EVERY idle torrent the instant the disk crossed 88%, discarding the
 * whole cache — including titles about to be rewatched — to reclaim space one or two files would
 * have covered. Eviction is now least-recently-played first, one at a time, and stops as soon as
 * usage is back under the target.
 *
 * Disk usage is forced with DISK_USAGE_OVERRIDE_PCT so the policy can be tested without filling a
 * real volume.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PIECE_SIZE = 1048576;
const FILE_SIZE = 6000000;
const TOTAL_PIECES = Math.ceil(FILE_SIZE / PIECE_SIZE);

const BRIDGE_PORT = 8977;
const MOCK_QBT_PORT = 18094;
const ADMIN_TOKEN = 'test-admin-token';

// Four torrents. Eviction order must be oldest-played first: COLD, then WARM, then RECENT.
// PINNED must never be touched.
const T = {
  COLD:   { hash: 'a1'.repeat(20), name: 'Cold.Release',   idleMinutes: 240 },
  WARM:   { hash: 'b2'.repeat(20), name: 'Warm.Release',   idleMinutes: 120 },
  RECENT: { hash: 'c3'.repeat(20), name: 'Recent.Release', idleMinutes: 5 },
  PINNED: { hash: 'd4'.repeat(20), name: 'Pinned.Release', idleMinutes: 999 }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-lru-'));
const cacheDir = path.join(root, '.cache');
const lruPath = path.join(cacheDir, 'torrent-lru.json');
fs.mkdirSync(cacheDir, { recursive: true });

// Seed persisted playback history, which also exercises restart survival.
const now = Date.now();
const seeded = {};
for (const t of Object.values(T)) {
  seeded[t.hash] = {
    name: t.name,
    lastActive: now - t.idleMinutes * 60000,
    pinned: t.name === 'Pinned.Release'
  };
  const dir = path.join(root, t.name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${t.name}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(1024));
  fs.truncateSync(f, FILE_SIZE);
}
fs.writeFileSync(lruPath, JSON.stringify(seeded));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const deleted = [];
let live = new Set(Object.values(T).map(t => t.hash));

const torrentsPayload = () => Object.values(T)
  .filter(t => live.has(t.hash))
  .map(t => ({
    hash: t.hash, name: t.name, save_path: root,
    content_path: path.join(root, t.name),
    added_on: Math.floor(now / 1000) - 7200,
    state: 'stalledUP', progress: 1, num_seeds: 4, num_leechs: 0, dlspeed: 0,
    amount_left: 0, total_size: FILE_SIZE, seq_dl: true, f_l_piece_prio: true,
    magnet_uri: `magnet:?xt=urn:btih:${t.hash}`
  }));

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/v2/torrents/properties') {
    return send({ piece_size: PIECE_SIZE, pieces_num: TOTAL_PIECES, total_size: FILE_SIZE });
  }
  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') return send(torrentsPayload());
  if (url.pathname === '/api/v2/torrents/pieceStates') return send(new Array(TOTAL_PIECES).fill(2));
  if (url.pathname === '/api/v2/torrents/files') return send([]);

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    if (url.pathname === '/api/v2/torrents/delete') {
      const hashes = new URLSearchParams(body).get('hashes') || '';
      for (const h of hashes.split('|')) {
        if (h) { deleted.push(h.toLowerCase()); live.delete(h.toLowerCase()); }
      }
    }
    res.writeHead(200); res.end('Ok.');
  });
});

await new Promise(r => mockQbt.listen(MOCK_QBT_PORT, '127.0.0.1', r));

// 91% forces eviction (>= 88) and must stop once under 80. Each eviction is reported by the mock
// removing the torrent, but usage is fixed, so the bridge should evict every unpinned candidate and
// then warn -- which is exactly the "cannot get under target" path we want covered.
const bridge = spawn(process.execPath, ['index.js'], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  env: {
    ...process.env,
    PORT: String(BRIDGE_PORT),
    QBT_URL: `http://127.0.0.1:${MOCK_QBT_PORT}`,
    ADMIN_TOKEN,
    LRU_STATE_PATH: lruPath,
    DISK_USAGE_OVERRIDE_PCT: '91',
    IDLE_TTL_MINUTES: '600',       // long, so pass 1 does not interfere with the LRU test
    HEARTBEAT_FRESH_MS: '2000',
    REQUIRE_COMPLETE: '1'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const base = `http://127.0.0.1:${BRIDGE_PORT}`;

// ---- Persisted history is restored ----------------------------------------
console.log('\n--- Playback history survives a restart ---');
check('restores persisted LRU state at boot', /\[LRU\] Restored playback history for 4 torrent\(s\)/.test(log),
  (log.match(/\[LRU\][^\n]*/g) || []).join(' | '));

// ---- Wait for a GC sweep --------------------------------------------------
console.log('\n--- LRU eviction under disk pressure ---');
await sleep(18000);

check('evicted least-recently-played first',
  deleted[0] === T.COLD.hash, `first evicted: ${deleted[0]} (expected COLD ${T.COLD.hash})`);
check('then the next least-recently-played',
  deleted[1] === T.WARM.hash, `second evicted: ${deleted[1]} (expected WARM ${T.WARM.hash})`);
check('a pinned torrent is never evicted', !deleted.includes(T.PINNED.hash),
  `deleted: ${deleted.join(', ')}`);
check('eviction is reported with the reason', /LRU at 91% disk, last played \d+m ago/.test(log),
  (log.match(/Evicting[^\n]*/g) || []).join(' | ').slice(0, 220));
check('warns when it cannot reach the target', /the remaining torrents are all in use or pinned/.test(log));
// Logged by the first sweep, which lands ~15s after boot — hence the check sits after the wait.
check('tracks restored torrents without resetting their idle clock',
  /restored playback history/.test(log),
  (log.match(/Now tracking[^\n]*/g) || []).join(' | ').slice(0, 200));

// ---- Cache inspection endpoint --------------------------------------------
console.log('\n--- /api/cache ---');
const cache = await (await fetch(`${base}/api/cache`)).json();
check('reports thresholds', cache.ok === true && cache.thresholds.evictAbovePercent === 88,
  JSON.stringify(cache.thresholds || {}));
check('lists what survived', Array.isArray(cache.cached), JSON.stringify(cache.cached || []).slice(0, 160));
check('the pinned entry is flagged',
  (cache.cached || []).some(c => c.hash === T.PINNED.hash && c.pinned === true),
  JSON.stringify((cache.cached || []).map(c => `${c.name}:${c.pinned}`)));
// Pinned but idle is NOT "in use" — conflating them would mislead anyone deciding what to unpin.
check('a pinned but idle torrent is not reported as in use',
  (cache.cached || []).some(c => c.hash === T.PINNED.hash && c.inUse === false),
  JSON.stringify((cache.cached || []).map(c => `${c.name}:inUse=${c.inUse}`)));

// ---- Pin endpoint ----------------------------------------------------------
console.log('\n--- Pin endpoint ---');
// PINNED is the only survivor at this point, so it is what the endpoint is exercised against.
const noAuth = await fetch(`${base}/api/torrent/pin`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hash: T.PINNED.hash })
});
check('pinning requires the admin token', noAuth.status === 401, String(noAuth.status));

const unpin = await (await fetch(`${base}/api/torrent/pin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
  body: JSON.stringify({ hash: T.PINNED.hash, pinned: false })
})).json();
check('unpins with a valid token', unpin.ok === true && unpin.pinned === false, JSON.stringify(unpin));

const repin = await fetch(`${base}/api/torrent/pin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
  body: JSON.stringify({ hash: T.PINNED.hash, pinned: true })
});
const pinBody = await repin.json();
check('pins with a valid token', repin.status === 200 && pinBody.pinned === true,
  JSON.stringify(pinBody));
check('the pin is persisted to disk', (() => {
  try {
    const st = JSON.parse(fs.readFileSync(lruPath, 'utf8'));
    return st[T.PINNED.hash] && st[T.PINNED.hash].pinned === true;
  } catch { return false; }
})());

const unknown = await fetch(`${base}/api/torrent/pin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
  body: JSON.stringify({ hash: '0'.repeat(40), pinned: true })
});
check('pinning an unknown hash returns 404', unknown.status === 404, String(unknown.status));

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await sleep(150);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
