/**
 * End-to-end check of the piece-aware streaming path against a mock qBittorrent.
 *
 * The scenario is the one that broke the real bridge: a MULTI-FILE torrent where the video does not
 * start at piece 0. A padding file occupies the first 3 MB, so the movie's byte 0 lives in global
 * piece 2. Code that computes `floor(byteOffset / pieceSize)` would check piece 0 and stream
 * unverified (sparse) bytes.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const PIECE_SIZE = 1048576;          // 1 MB
const PAD_SIZE = 3000000;            // pushes the movie's first byte into piece 2
const MOVIE_SIZE = 12000000;
const TOTAL = PAD_SIZE + MOVIE_SIZE;
const TOTAL_PIECES = Math.ceil(TOTAL / PIECE_SIZE);

// What /torrents/properties reports. Real qBittorrent exposes piece_size ONLY here.
const TOTAL_PIECES_FOR_MOCK = TOTAL_PIECES;
const TOTAL_SIZE_FOR_MOCK = TOTAL;

const HASH = 'a'.repeat(40);
const MOCK_QBT_PORT = 18099;
const BRIDGE_PORT = 8972;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-test-'));
const releaseDir = path.join(root, 'MockRelease');
fs.mkdirSync(releaseDir);

// Deterministic, position-dependent content so a wrong offset is detectable.
function patternBuffer(size, seed) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + seed * 31) & 0xff;
  return buf;
}

const padBuf = patternBuffer(PAD_SIZE, 1);
const movieBuf = patternBuffer(MOVIE_SIZE, 2);
fs.writeFileSync(path.join(releaseDir, 'pad.bin'), padBuf);
fs.writeFileSync(path.join(releaseDir, 'movie.mp4'), movieBuf);
const movieSha = crypto.createHash('sha256').update(movieBuf).digest('hex');

// ---- Mock qBittorrent -------------------------------------------------------
// Pieces 0..availableUpTo are verified (state 2); everything above is missing (state 0).
let availableUpTo = 5;
let pieceStateRequests = 0;
let filePrioCalls = [];

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // piece_size and pieces_num live ONLY here — /torrents/info does not carry them.
  if (url.pathname === '/api/v2/torrents/properties') {
    return send({ piece_size: PIECE_SIZE, pieces_num: TOTAL_PIECES_FOR_MOCK, total_size: TOTAL_SIZE_FOR_MOCK });
  }
  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=testsid; path=/' });
    return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/add') { res.writeHead(200); return res.end('Ok.'); }
  if (url.pathname === '/api/v2/torrents/info') {
    return send([{
      hash: HASH,
      name: 'MockRelease',
      save_path: root,
      content_path: releaseDir,
      added_on: Math.floor(Date.now() / 1000),
      magnet_uri: `magnet:?xt=urn:btih:${HASH}`
    }]);
  }
  if (url.pathname === '/api/v2/torrents/files') {
    return send([
      { index: 0, name: 'MockRelease/pad.bin', size: PAD_SIZE, priority: 1, piece_range: [0, 2] },
      { index: 1, name: 'MockRelease/movie.mp4', size: MOVIE_SIZE, priority: 1, piece_range: [2, TOTAL_PIECES - 1] }
    ]);
  }
  if (url.pathname === '/api/v2/torrents/pieceStates') {
    pieceStateRequests++;
    const states = [];
    for (let i = 0; i < TOTAL_PIECES; i++) states.push(i <= availableUpTo ? 2 : 0);
    return send(states);
  }
  if (url.pathname === '/api/v2/torrents/filePrio') {
    let body = '';
    req.on('data', d => body += d);
    return req.on('end', () => { filePrioCalls.push(body); res.writeHead(200); res.end('Ok.'); });
  }
  // stop/start/pause/resume/delete/piecePriority
  res.writeHead(url.pathname === '/api/v2/torrents/piecePriority' ? 404 : 200);
  res.end('Ok.');
});

await new Promise(r => mockQbt.listen(MOCK_QBT_PORT, '127.0.0.1', r));

// ---- Bridge under test ------------------------------------------------------
const bridge = spawn(process.execPath, ['index.js'], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  env: {
    ...process.env,
    PORT: String(BRIDGE_PORT),
    QBT_URL: `http://127.0.0.1:${MOCK_QBT_PORT}`,
    // Own LRU file per suite: the default lives in server/.cache and would carry
    // playback history between runs, making torrents look long-idle.
    LRU_STATE_PATH: path.join(root, '.cache', 'lru.json'),
    // This suite exercises the PROGRESSIVE piece-aware path (Phase 4 territory),
    // which cache-first bypasses by design.
    REQUIRE_COMPLETE: '0',
    PIECE_POLL_MS: '80',
    PIECE_STATE_CACHE_MS: '80',
    PIECE_WAIT_TIMEOUT_MS: '15000',
    IDLE_TTL_MINUTES: '60'
  }
});
let bridgeLog = '';
bridge.stdout.on('data', d => { bridgeLog += d.toString(); });
bridge.stderr.on('data', d => { bridgeLog += d.toString(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const streamUrl = `http://127.0.0.1:${BRIDGE_PORT}/api/stream` +
  `?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${HASH}`)}&title=MockRelease`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- Test 1: piece gating honours the file's offset within the torrent ------
console.log('\n--- Test 1: piece-gated progressive read (multi-file offset) ---');
const res1 = await fetch(streamUrl, { headers: { Range: 'bytes=0-', 'X-Session-ID': 'test1' } });

check('status is 206 Partial Content', res1.status === 206, `got ${res1.status}`);
check('Content-Range uses the torrent-declared file size',
  res1.headers.get('content-range') === `bytes 0-${MOVIE_SIZE - 1}/${MOVIE_SIZE}`,
  res1.headers.get('content-range'));
check('Content-Length matches the requested range',
  res1.headers.get('content-length') === String(MOVIE_SIZE),
  res1.headers.get('content-length'));

// Pieces 0..5 verified. The movie starts at byte 3,000,000 of the torrent, so the last readable
// in-file byte is (6 * PIECE_SIZE - 1) - PAD_SIZE.
const expectedStall = (6 * PIECE_SIZE) - PAD_SIZE;

const chunks = [];
let received = 0;
const reader = res1.body.getReader();
let done = false;
const pump = (async () => {
  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
    chunks.push(Buffer.from(value));
    received += value.length;
  }
})();

await sleep(2500);
const stalledAt = received;
check('stream stops exactly at the last VERIFIED piece boundary',
  stalledAt === expectedStall,
  `stalled at ${stalledAt}, expected ${expectedStall}`);
check('did not serve unverified (sparse) bytes past the download head',
  stalledAt <= expectedStall,
  `served ${stalledAt} bytes`);

// ---- Test 2: resumes and completes when the swarm catches up ----------------
console.log('\n--- Test 2: resumes when remaining pieces are verified ---');
availableUpTo = TOTAL_PIECES - 1;
await Promise.race([pump, sleep(20000)]);
done = true;

const body = Buffer.concat(chunks);
check('delivered the whole file', body.length === MOVIE_SIZE, `${body.length} of ${MOVIE_SIZE}`);
check('bytes are correct (sha256 matches source file)',
  crypto.createHash('sha256').update(body).digest('hex') === movieSha);

// ---- Test 3: pieceStates polling is cached, not per-chunk -------------------
console.log('\n--- Test 3: qBittorrent is not hammered ---');
check('pieceStates polled a bounded number of times',
  pieceStateRequests < 200,
  `${pieceStateRequests} requests for ${Math.ceil(MOVIE_SIZE / 262144)} chunks`);

// ---- Test 4: file priority focused on the streamed file ---------------------
console.log('\n--- Test 4: swarm focused on the streamed file ---');
check('target file set to priority 7', filePrioCalls.some(c => c.includes('id=1') && c.includes('priority=7')),
  JSON.stringify(filePrioCalls));
check('other files deprioritised to 0', filePrioCalls.some(c => c.includes('id=0') && c.includes('priority=0')),
  JSON.stringify(filePrioCalls));

// ---- Test 5: Range header edge cases ---------------------------------------
console.log('\n--- Test 5: RFC 7233 range parsing ---');
const suffixRes = await fetch(streamUrl, { headers: { Range: 'bytes=-1048576', 'X-Session-ID': 'test-suffix' } });
check('suffix range (bytes=-N) resolves to the last N bytes',
  suffixRes.headers.get('content-range') === `bytes ${MOVIE_SIZE - 1048576}-${MOVIE_SIZE - 1}/${MOVIE_SIZE}`,
  suffixRes.headers.get('content-range'));
await suffixRes.arrayBuffer();

const openRes = await fetch(streamUrl, { headers: { Range: 'bytes=11000000-', 'X-Session-ID': 'test-open' } });
check('open-ended range (bytes=N-) runs to EOF',
  openRes.headers.get('content-range') === `bytes 11000000-${MOVIE_SIZE - 1}/${MOVIE_SIZE}`,
  openRes.headers.get('content-range'));
await openRes.arrayBuffer();

const badRes = await fetch(streamUrl, { headers: { Range: `bytes=${MOVIE_SIZE + 500}-`, 'X-Session-ID': 'test-416' } });
check('unsatisfiable range returns 416', badRes.status === 416, `got ${badRes.status}`);
check('416 carries Content-Range: bytes */size',
  badRes.headers.get('content-range') === `bytes */${MOVIE_SIZE}`,
  badRes.headers.get('content-range'));
await badRes.arrayBuffer();

// ---- Test 6: HEAD does not block on the swarm ------------------------------
console.log('\n--- Test 6: HEAD probe ---');
availableUpTo = 2; // starve the swarm again
const headStart = Date.now();
const headRes = await fetch(streamUrl, { method: 'HEAD', headers: { 'X-Session-ID': 'test-head' } });
const headMs = Date.now() - headStart;
check('HEAD returns headers without waiting for pieces', headRes.status === 200 || headRes.status === 206,
  `status ${headRes.status} in ${headMs}ms`);
check('HEAD advertises byte-range support', headRes.headers.get('accept-ranges') === 'bytes');

console.log('\n=== BRIDGE LOG ===');
console.log(bridgeLog.split('\n').filter(l => l.trim()).slice(-12).join('\n'));

bridge.kill('SIGKILL');
mockQbt.close();
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
