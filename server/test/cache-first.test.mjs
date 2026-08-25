/**
 * Cache-first delivery (Phase 2).
 *
 * Two things must hold:
 *
 *  1. While a torrent is incomplete, the bridge withholds a plan and reports progress instead of
 *     probing or serving a partial file. Every piece-related bug in this project came from serving
 *     files that were not finished.
 *
 *  2. Once complete, delivery does NOT consult piece state at all. This is asserted the only way
 *     that is convincing: the mock reports every piece as NOT downloaded (state 0) while the
 *     torrent reports progress 1.0 and the file is whole on disk. A piece-aware read would block
 *     forever; a plain file read returns the bytes. If this test passes, the piece path is provably
 *     out of the way.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PIECE_SIZE = 1048576;
const MOVIE_SIZE = 9000000;
const TOTAL_PIECES = Math.ceil(MOVIE_SIZE / PIECE_SIZE);

const DONE_HASH = '7'.repeat(40);
const BUSY_HASH = '8'.repeat(40);

const BRIDGE_PORT = 8976;
const MOCK_QBT_PORT = 18095;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-cf-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// Deterministic content so we can verify byte-for-byte.
const movieBuf = Buffer.allocUnsafe(MOVIE_SIZE);
for (let i = 0; i < MOVIE_SIZE; i++) movieBuf[i] = (i * 13 + 7) & 0xff;
const movieSha = crypto.createHash('sha256').update(movieBuf).digest('hex');

fs.mkdirSync(path.join(root, 'Done.Release'), { recursive: true });
fs.mkdirSync(path.join(root, 'Busy.Release'), { recursive: true });
fs.writeFileSync(path.join(root, 'Done.Release', 'Done.Release.mp4'), movieBuf);
// Still downloading: on disk with the incomplete suffix.
fs.writeFileSync(path.join(root, 'Busy.Release', 'Busy.Release.mp4.!qB'), Buffer.alloc(1024));
fs.truncateSync(path.join(root, 'Busy.Release', 'Busy.Release.mp4.!qB'), MOVIE_SIZE);

let pieceStateRequests = 0;

const torrents = () => [
  {
    hash: DONE_HASH, name: 'Done.Release', save_path: root,
    content_path: path.join(root, 'Done.Release'),
    added_on: Math.floor(Date.now() / 1000),
    state: 'stalledUP', progress: 1, num_seeds: 9, num_leechs: 0, dlspeed: 0,
    amount_left: 0, total_size: MOVIE_SIZE, seq_dl: true, f_l_piece_prio: true,
    magnet_uri: `magnet:?xt=urn:btih:${DONE_HASH}`
  },
  {
    hash: BUSY_HASH, name: 'Busy.Release', save_path: root,
    content_path: path.join(root, 'Busy.Release'),
    added_on: Math.floor(Date.now() / 1000),
    state: 'downloading', progress: 0.311, num_seeds: 15, num_leechs: 3,
    dlspeed: 6 * 1048576, amount_left: 30 * 1048576, eta: 8640000,
    total_size: MOVIE_SIZE, seq_dl: true, f_l_piece_prio: true,
    magnet_uri: `magnet:?xt=urn:btih:${BUSY_HASH}`
  }
];

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/v2/torrents/properties') {
    return send({ piece_size: PIECE_SIZE, pieces_num: TOTAL_PIECES, total_size: MOVIE_SIZE });
  }
  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') return send(torrents());
  if (url.pathname === '/api/v2/torrents/files') {
    const h = (url.searchParams.get('hash') || '').toLowerCase();
    const name = h === DONE_HASH ? 'Done.Release/Done.Release.mp4' : 'Busy.Release/Busy.Release.mp4';
    return send([{ index: 0, name, size: MOVIE_SIZE, piece_range: [0, TOTAL_PIECES - 1] }]);
  }
  if (url.pathname === '/api/v2/torrents/pieceStates') {
    // EVERY piece reported as NOT downloaded. A piece-aware read would never proceed.
    pieceStateRequests++;
    return send(new Array(TOTAL_PIECES).fill(0));
  }
  if (url.pathname === '/api/v2/torrents/piecePriority') { res.writeHead(404); return res.end(); }
  res.writeHead(200); res.end('Ok.');
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
    PIECE_WAIT_TIMEOUT_MS: '4000',   // so a regression fails fast instead of hanging the suite
    IDLE_TTL_MINUTES: '60'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const base = `http://127.0.0.1:${BRIDGE_PORT}`;
const magnetFor = (h) => encodeURIComponent(`magnet:?xt=urn:btih:${h}`);

// ---- 1. Incomplete: withhold, report progress ------------------------------
console.log('\n--- Incomplete torrent is not served ---');
const busyPrep = await (await fetch(`${base}/api/stream/prepare?magnet=${magnetFor(BUSY_HASH)}`)).json();
check('prepare reports downloading rather than a plan', busyPrep.readyState === 'downloading',
  JSON.stringify(busyPrep).slice(0, 160));
check('no delivery mode is offered yet', busyPrep.mode === undefined, String(busyPrep.mode));
check('progress is reported so the client can render it', busyPrep.progressPercent === 31.1,
  String(busyPrep.progressPercent));

const busyStream = await fetch(`${base}/api/stream?magnet=${magnetFor(BUSY_HASH)}&sessionId=cf-busy`);
const busyBody = await busyStream.json();
check('the stream endpoint refuses with 503 NOT_READY', busyStream.status === 503 && busyBody.code === 'NOT_READY',
  `${busyStream.status} ${busyBody.code}`);
check('the refusal carries progress', busyBody.progressPercent === 31.1, String(busyBody.progressPercent));

// An incomplete file must never be probed — that is where "probe unavailable" came from.
check('ffprobe is not run against an incomplete file', !/Busy\.Release.*probe unavailable/.test(log),
  (log.match(/\[Probe\][^\n]*/g) || []).join(' | ').slice(0, 160));

// ---- 2. Complete: served without consulting piece state --------------------
console.log('\n--- Complete torrent bypasses piece verification entirely ---');
pieceStateRequests = 0;

const donePrep = await (await fetch(`${base}/api/stream/prepare?magnet=${magnetFor(DONE_HASH)}`)).json();
check('prepare reports ready', donePrep.ok === true && donePrep.readyState === 'ready',
  `ok=${donePrep.ok} readyState=${donePrep.readyState}`);
check('direct mode is chosen for a browser-native file', donePrep.mode === 'direct', donePrep.mode);

// Every piece is reported missing. Piece-aware reading would stall; a plain read must not care.
const doneRes = await fetch(`${base}/api/stream?magnet=${magnetFor(DONE_HASH)}&sessionId=cf-done`, {
  headers: { Range: 'bytes=0-' }
});
check('serves 206 despite every piece being reported as missing', doneRes.status === 206,
  String(doneRes.status));

const body = Buffer.from(await doneRes.arrayBuffer());
check('delivers the whole file', body.length === MOVIE_SIZE, `${body.length} of ${MOVIE_SIZE}`);
check('bytes are correct (sha256 matches)',
  crypto.createHash('sha256').update(body).digest('hex') === movieSha);
check('pieceStates was never consulted for a complete torrent', pieceStateRequests === 0,
  `${pieceStateRequests} request(s)`);
check('log records the complete-file source', /source=complete-file/.test(log),
  (log.match(/\[Direct 206\][^\n]*/g) || []).join(' | ').slice(0, 160));

// ---- 3. Native seeking works on the completed file -------------------------
console.log('\n--- Native range seeking on a completed file ---');
const seekRes = await fetch(`${base}/api/stream?magnet=${magnetFor(DONE_HASH)}&sessionId=cf-seek`, {
  headers: { Range: 'bytes=8000000-8000999' }
});
const seekBody = Buffer.from(await seekRes.arrayBuffer());
check('a mid-file range returns immediately', seekRes.status === 206, String(seekRes.status));
check('the range is exactly what was asked for', seekBody.length === 1000, String(seekBody.length));
check('and it is the right bytes',
  seekBody.equals(movieBuf.subarray(8000000, 8001000)));

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await sleep(150);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
