/**
 * Auto-GC restart safety, and resuming a paused torrent during resolution.
 *
 * Both are regression cover for failures seen in production:
 *
 *  1. torrentRegistry is in-memory, so after a restart every torrent is unknown. The sweep used to
 *     back-date lastActive to the torrent's added_on, which is already older than IDLE_TTL — so the
 *     first sweep 15s after boot deleted every torrent and its downloaded data.
 *
 *  2. Nothing resumed a paused torrent during resolution (/api/stream resumed only AFTER resolving,
 *     /api/stream/prepare never did). A torrent the Bandwidth Saver had paused could therefore never
 *     restart: it wrote no bytes, so resolution polled for its file until it timed out, every time.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PIECE_SIZE = 1048576;
const MOVIE_SIZE = 12000000;
const BRIDGE_PORT = 8975;
const MOCK_QBT_PORT = 18096;

const OLD_HASH = '1'.repeat(40);     // pre-existing, added long ago
const PAUSED_HASH = '2'.repeat(40);  // exists but stopped

// What /torrents/properties reports. Real qBittorrent exposes piece_size ONLY here.
const TOTAL_PIECES_FOR_MOCK = 12;
const TOTAL_SIZE_FOR_MOCK = TOTAL_PIECES_FOR_MOCK * PIECE_SIZE;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-gc-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const calls = { deleted: [], started: [] };
// The paused torrent only materialises its file once it has been resumed.
let pausedState = 'stoppedDL';
let pausedFileWritten = false;

for (const dir of ['Old.Release', 'Paused.Release']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
const oldFile = path.join(root, 'Old.Release', 'Old.Release.mp4');
fs.writeFileSync(oldFile, Buffer.alloc(1024));
fs.truncateSync(oldFile, MOVIE_SIZE);
const pausedFile = path.join(root, 'Paused.Release', 'Paused.Release.mp4.!qB');

const torrents = () => [
  {
    hash: OLD_HASH, name: 'Old.Release', save_path: root,
    content_path: path.join(root, 'Old.Release'),
    // Added two hours ago: far older than IDLE_TTL.
    added_on: Math.floor(Date.now() / 1000) - 7200,
    state: 'stalledUP', progress: 1, num_seeds: 3, num_leechs: 1, dlspeed: 0,
    magnet_uri: `magnet:?xt=urn:btih:${OLD_HASH}`
  },
  {
    hash: PAUSED_HASH, name: 'Paused.Release', save_path: root,
    content_path: path.join(root, 'Paused.Release'),
    added_on: Math.floor(Date.now() / 1000) - 7200,
    state: pausedState, progress: 0.1, num_seeds: 5, num_leechs: 2, dlspeed: 0,
    magnet_uri: `magnet:?xt=urn:btih:${PAUSED_HASH}`
  }
];

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  // piece_size and pieces_num live ONLY here — /torrents/info does not carry them.
  if (url.pathname === '/api/v2/torrents/properties') {
    return send({ piece_size: PIECE_SIZE, pieces_num: TOTAL_PIECES_FOR_MOCK, total_size: TOTAL_SIZE_FOR_MOCK });
  }
  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') return send(torrents());
  if (url.pathname === '/api/v2/torrents/files') {
    const h = (url.searchParams.get('hash') || '').toLowerCase();
    const name = h === OLD_HASH ? 'Old.Release/Old.Release.mp4' : 'Paused.Release/Paused.Release.mp4';
    return send([{ index: 0, name, size: MOVIE_SIZE, piece_range: [0, 11] }]);
  }
  if (url.pathname === '/api/v2/torrents/pieceStates') return send(new Array(12).fill(2));

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    if (url.pathname === '/api/v2/torrents/delete') {
      calls.deleted.push(body);
    }
    if (url.pathname === '/api/v2/torrents/start' || url.pathname === '/api/v2/torrents/resume') {
      calls.started.push(body);
      if (body.includes(PAUSED_HASH)) {
        // Resuming makes qBittorrent actually write the file, exactly as it would in reality.
        pausedState = 'downloading';
        if (!pausedFileWritten) {
          fs.writeFileSync(pausedFile, Buffer.alloc(1024));
          fs.truncateSync(pausedFile, MOVIE_SIZE);
          pausedFileWritten = true;
        }
      }
    }
    if (url.pathname === '/api/v2/torrents/piecePriority') { res.writeHead(404); return res.end(); }
    res.writeHead(200); res.end('Ok.');
  });
});

await new Promise(r => mockQbt.listen(MOCK_QBT_PORT, '127.0.0.1', r));

const bridge = spawn(process.execPath, ['index.js'], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  env: {
    ...process.env,
    PORT: String(BRIDGE_PORT),
    QBT_URL: `http://127.0.0.1:${MOCK_QBT_PORT}`,
    PIECE_POLL_MS: '80',
    PIECE_STATE_CACHE_MS: '80',
    IDLE_TTL_MINUTES: '1'   // the aggressive production default that exposed the bug
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const base = `http://127.0.0.1:${BRIDGE_PORT}`;

// ---- 1. Restart must not wipe pre-existing torrents -------------------------
console.log('\n--- Auto-GC must not delete torrents just because the process restarted ---');
// Two full sweep intervals (15s each) is far more than the 1-minute TTL would need if the idle
// clock were still being back-dated to added_on (2 hours ago).
await sleep(20000);
check('a torrent added long ago is NOT deleted right after boot',
  !calls.deleted.some(b => b.includes(OLD_HASH)),
  `delete calls: ${calls.deleted.length}`);
check('the sweep announces it is now tracking it',
  /Now tracking pre-existing torrent "Old\.Release"/.test(log));

// ---- 2. A paused torrent gets resumed during resolution ---------------------
console.log('\n--- Resolution must resume a paused torrent ---');
const res = await fetch(
  `${base}/api/stream/prepare?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${PAUSED_HASH}`)}`
);
const body = await res.json();

check('a stopped torrent is resumed, not polled until timeout', body.ok === true,
  body.ok ? '' : `${res.status} ${body.error}`);
check('resume was actually issued', calls.started.some(b => b.includes(PAUSED_HASH)),
  `start calls: ${calls.started.length}`);
check('logs why it resumed', /was stoppedDL — resuming it/.test(log),
  (log.match(/\[Resolve\][^\n]*/g) || []).join(' | ').slice(0, 200));
check('resolves the file once written', body.fileName === 'Paused.Release.mp4', body.fileName);

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await sleep(150);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
