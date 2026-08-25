/**
 * Phase 5′ §6.1 — cache entries and representations.
 *
 * A cached title is a SOURCE plus zero or more REPRESENTATIONS derived from it. The properties that
 * matter, and that this asserts:
 *
 *   1. The eviction footprint is source + representations, not just the torrent.
 *   2. Evicting a title removes its derived files — they can never outlive their source.
 *   3. A title with a RUNNING representation is never evicted. Transcoding grows disk usage, so it
 *      can trigger the very eviction that would delete what it is building.
 *   4. Representations whose torrent no longer exists are reclaimed. Eviction only ever walks the
 *      torrent list, so an orphan would otherwise occupy disk forever, invisible to it.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PIECE_SIZE = 1048576;
const SOURCE_SIZE = 8000000;
const TOTAL_PIECES = Math.ceil(SOURCE_SIZE / PIECE_SIZE);

const BRIDGE_PORT = 8978;
const MOCK_QBT_PORT = 18093;
const ADMIN_TOKEN = 'test-admin-token';

const IDLE = { hash: 'e1'.repeat(20), name: 'Idle.Release' };       // evictable
const BUSY = { hash: 'e2'.repeat(20), name: 'Busy.Release' };       // transcoding — protected
const GONE = 'e3'.repeat(20);                                       // orphan HLS, no torrent

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-rep-'));
const hlsRoot = path.join(root, 'hls');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- Lay out sources and representations on disk ----------------------------
const REP_SEGMENT_BYTES = 300000;
const REP_SEGMENTS = 6;
const REP_SIZE = REP_SEGMENT_BYTES * REP_SEGMENTS;

function writeSource(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(1024));
  fs.truncateSync(f, SOURCE_SIZE);
  return f;
}

/**
 * Writes what FFmpeg would actually leave behind: segments, a playlist naming them, and a manifest
 * identifying the exact source. Boot reconciliation validates all three, so a fixture missing any
 * of them is correctly discarded — which is the behaviour under test elsewhere, not something to
 * work around here.
 */
function writeRepresentation(hash, { complete, sourcePath }) {
  const dir = path.join(hlsRoot, hash);
  fs.mkdirSync(dir, { recursive: true });

  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4',
                 '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT'];

  for (let i = 0; i < REP_SEGMENTS; i++) {
    const name = `seg${String(i).padStart(5, '0')}.ts`;
    const seg = path.join(dir, name);
    fs.writeFileSync(seg, Buffer.alloc(1024));
    fs.truncateSync(seg, REP_SEGMENT_BYTES);
    lines.push('#EXTINF:4.000,', name);
  }
  if (complete) lines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(path.join(dir, 'playlist.m3u8'), lines.join('\n') + '\n');

  const st = fs.statSync(sourcePath);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version: 1,
    infohash: hash,
    source: { path: sourcePath, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) },
    media: { durationSec: 24, videoCodec: 'h264', audioCodec: 'aac' },
    hls: {
      segmentDurationSec: 4,
      startedAt: new Date().toISOString(),
      // No completedAt means a job still in flight.
      completedAt: complete ? new Date().toISOString() : null
    }
  }));
  return dir;
}

// The footprint counts everything in the directory, manifest.json included — so measure rather
// than assume 6 x segment size.
function representationSizeOnDisk(dir) {
  return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
}

const idleSource = writeSource(IDLE.name);
const busySource = writeSource(BUSY.name);
const orphanSource = writeSource('Orphan.Release');

// Present before boot, so both must survive reconciliation: complete, valid, real sources.
const idleRepDir = writeRepresentation(IDLE.hash, { complete: true, sourcePath: idleSource });
const orphanRepDir = writeRepresentation(GONE, { complete: true, sourcePath: orphanSource });
const IDLE_REP_SIZE = representationSizeOnDisk(idleRepDir);

// BUSY's representation is written AFTER the bridge boots — see below. An in-flight job cannot
// exist across a restart by definition: there is no live process, so boot reconciliation discards
// the partial directory (§5.3, rebuild rather than resume).
const busyRepDir = path.join(hlsRoot, BUSY.hash);

// ---- Mock qBittorrent -------------------------------------------------------
const deleted = [];
const live = new Set([IDLE.hash, BUSY.hash]);

const torrents = () => [IDLE, BUSY].filter(t => live.has(t.hash)).map(t => ({
  hash: t.hash, name: t.name, save_path: root,
  content_path: path.join(root, t.name),
  added_on: Math.floor(Date.now() / 1000) - 7200,
  state: 'stalledUP', progress: 1, num_seeds: 2, num_leechs: 0, dlspeed: 0,
  amount_left: 0, total_size: SOURCE_SIZE, seq_dl: true, f_l_piece_prio: true,
  magnet_uri: `magnet:?xt=urn:btih:${t.hash}`
}));

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/v2/torrents/properties') {
    return send({ piece_size: PIECE_SIZE, pieces_num: TOTAL_PIECES, total_size: SOURCE_SIZE });
  }
  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') return send(torrents());
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

// Disk pinned at 91% forces LRU eviction; both torrents are idle, but BUSY is transcoding.
const bridge = spawn(process.execPath, ['index.js'], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  env: {
    ...process.env,
    PORT: String(BRIDGE_PORT),
    QBT_URL: `http://127.0.0.1:${MOCK_QBT_PORT}`,
    ADMIN_TOKEN,
    HLS_DIR: hlsRoot,
    LRU_STATE_PATH: path.join(root, '.cache', 'lru.json'),
    DISK_USAGE_OVERRIDE_PCT: '91',
    IDLE_TTL_MINUTES: '600',
    HEARTBEAT_FRESH_MS: '2000',
    PIECE_POLL_MS: '80',
    PIECE_STATE_CACHE_MS: '80'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

// Now that boot reconciliation has run, stage an in-flight representation.
writeRepresentation(BUSY.hash, { complete: false, sourcePath: busySource });

const base = `http://127.0.0.1:${BRIDGE_PORT}`;

// ---- 1. Footprint includes representations ---------------------------------
console.log('\n--- Footprint = source + representations ---');
let cache = await (await fetch(`${base}/api/cache`)).json();
const idleRow = (cache.cached || []).find(c => c.hash === IDLE.hash);

check('reports the source size separately',
  idleRow && idleRow.source.sizeBytes === SOURCE_SIZE,
  idleRow ? String(idleRow.source.sizeBytes) : 'row missing');
check('reports the representation and its size',
  idleRow && idleRow.representations.hls && idleRow.representations.hls.sizeBytes === IDLE_REP_SIZE,
  `${idleRow && idleRow.representations.hls && idleRow.representations.hls.sizeBytes} (expected ${IDLE_REP_SIZE})`);
check('the reported size covers the whole directory, manifest included',
  IDLE_REP_SIZE > REP_SEGMENT_BYTES * REP_SEGMENTS,
  `${IDLE_REP_SIZE} > ${REP_SEGMENT_BYTES * REP_SEGMENTS}`);
check('footprint is source + representation, not just the torrent',
  idleRow && idleRow.footprintBytes === SOURCE_SIZE + IDLE_REP_SIZE,
  `${idleRow && idleRow.footprintBytes} (expected ${SOURCE_SIZE + IDLE_REP_SIZE})`);
check('a completed representation reads as complete',
  idleRow && idleRow.representations.hls.state === 'complete',
  idleRow && idleRow.representations.hls.state);
check('an in-flight representation reads as running',
  (cache.cached || []).some(c => c.hash === BUSY.hash && c.representations.hls.state === 'running'),
  JSON.stringify((cache.cached || []).map(c => `${c.name}:${c.representations.hls && c.representations.hls.state}`)));
check('the source retention policy is reported', cache.sourcePolicy === 'retain', cache.sourcePolicy);

// ---- 2. Orphan reclamation --------------------------------------------------
console.log('\n--- Orphan representations are reclaimed ---');
await sleep(16000);   // one GC sweep
check('a valid representation survives boot reconciliation',
  /Reconciled representations: \d+ usable/.test(log),
  (log.match(/\[HLS\][^\n]*/g) || []).join(' | ').slice(0, 200));
check('a representation with no torrent is deleted', !fs.existsSync(orphanRepDir),
  orphanRepDir);
check('and says why', /orphan — no matching torrent/.test(log),
  (log.match(/\[Cache\][^\n]*/g) || []).join(' | ').slice(0, 200));

// ---- 3. Eviction takes representations with it -----------------------------
console.log('\n--- Eviction removes derived files, and spares transcoding titles ---');
check('the idle title was evicted', deleted.includes(IDLE.hash), deleted.join(', '));
check('its representation went with it', !fs.existsSync(idleRepDir), idleRepDir);
check('eviction reported the reclaimed footprint', /reclaiming [\d.]+ MB/.test(log),
  (log.match(/Evicting[^\n]*/g) || []).join(' | ').slice(0, 200));

// The point of the exercise: a transcode in flight must survive disk pressure.
check('a transcoding title is NOT evicted', !deleted.includes(BUSY.hash), deleted.join(', '));
check('and its representation survives', fs.existsSync(busyRepDir), busyRepDir);

cache = await (await fetch(`${base}/api/cache`)).json();
check('the surviving title is flagged as transcoding',
  (cache.cached || []).some(c => c.hash === BUSY.hash && c.transcoding === true),
  JSON.stringify((cache.cached || []).map(c => `${c.name}:transcoding=${c.transcoding}`)));

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await sleep(150);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
