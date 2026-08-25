/**
 * Covers /api/stream/prepare and the session lifecycle that used to tear torrents down mid-watch.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PIECE_SIZE = 1048576;
const PAD_SIZE = 3000000;
const MOVIE_SIZE = 12000000;
const TOTAL_PIECES = Math.ceil((PAD_SIZE + MOVIE_SIZE) / PIECE_SIZE);
// What /torrents/properties reports. Real qBittorrent exposes piece_size ONLY here.
const TOTAL_PIECES_FOR_MOCK = TOTAL_PIECES;
const TOTAL_SIZE_FOR_MOCK = PAD_SIZE + MOVIE_SIZE;

const HASH = 'b'.repeat(40);
const MOCK_QBT_PORT = 18098;
const BRIDGE_PORT = 8973;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-life-'));
const releaseDir = path.join(root, 'MockRelease');
fs.mkdirSync(releaseDir);
fs.writeFileSync(path.join(releaseDir, 'pad.bin'), Buffer.alloc(PAD_SIZE, 1));
fs.writeFileSync(path.join(releaseDir, 'movie.mp4'), Buffer.alloc(MOVIE_SIZE, 2));

const calls = { stop: 0, start: 0, delete: 0 };

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
  if (url.pathname === '/api/v2/torrents/info') {
    return send([{
      hash: HASH, name: 'MockRelease', save_path: root, content_path: releaseDir,
      added_on: Math.floor(Date.now() / 1000) - 3600,
      magnet_uri: `magnet:?xt=urn:btih:${HASH}`
    }]);
  }
  if (url.pathname === '/api/v2/torrents/files') {
    return send([
      { index: 0, name: 'MockRelease/pad.bin', size: PAD_SIZE, piece_range: [0, 2] },
      { index: 1, name: 'MockRelease/movie.mp4', size: MOVIE_SIZE, piece_range: [2, TOTAL_PIECES - 1] }
    ]);
  }
  if (url.pathname === '/api/v2/torrents/pieceStates') {
    return send(new Array(TOTAL_PIECES).fill(2));
  }
  if (url.pathname === '/api/v2/torrents/stop') { calls.stop++; res.writeHead(200); return res.end('Ok.'); }
  if (url.pathname === '/api/v2/torrents/start') { calls.start++; res.writeHead(200); return res.end('Ok.'); }
  if (url.pathname === '/api/v2/torrents/delete') { calls.delete++; res.writeHead(200); return res.end('Ok.'); }
  if (url.pathname === '/api/v2/torrents/piecePriority') { res.writeHead(404); return res.end('Not found'); }
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
    IDLE_TTL_MINUTES: '60',
    STREAM_IDLE_GRACE_MS: '2000',   // shrink the grace window so the test can observe it
    HEARTBEAT_FRESH_MS: '3000'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const base = `http://127.0.0.1:${BRIDGE_PORT}`;
const magnet = encodeURIComponent(`magnet:?xt=urn:btih:${HASH}`);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- prepare ----------------------------------------------------------------
console.log('\n--- /api/stream/prepare ---');
const prepRes = await fetch(`${base}/api/stream/prepare?magnet=${magnet}&title=MockRelease`);
const prep = await prepRes.json();
check('returns 200 with ok:true', prepRes.status === 200 && prep.ok === true, JSON.stringify(prep).slice(0, 200));
check('reports the delivery mode', prep.mode === 'direct', `mode=${prep.mode}`);
check('reports the torrent-declared file size', prep.fileSizeBytes === MOVIE_SIZE, String(prep.fileSizeBytes));
check('reports the resolved infoHash', prep.infoHash === HASH, prep.infoHash);
check('reports the media file it picked', prep.fileName === 'movie.mp4', prep.fileName);
check('direct mode advertises native seeking', prep.seekable === true);

const badPrep = await fetch(`${base}/api/stream/prepare`);
check('missing magnet returns a JSON 400', badPrep.status === 400 &&
  (await badPrep.json()).ok === false);

// ---- torrent is NOT paused while a connection is live -----------------------
console.log('\n--- lifecycle: no pause mid-playback ---');
calls.stop = 0;
const live = await fetch(`${base}/api/stream?magnet=${magnet}&title=MockRelease&sessionId=life1`, {
  headers: { Range: 'bytes=0-2000000' }
});
await live.arrayBuffer();
const stopsRightAfterClose = calls.stop;
check('closing one range request does not immediately pause the torrent',
  stopsRightAfterClose === 0, `${stopsRightAfterClose} stop call(s)`);

// ---- heartbeats hold the torrent open past the grace window ------------------
console.log('\n--- lifecycle: heartbeats keep it alive ---');
calls.stop = 0;
for (let i = 0; i < 4; i++) {
  await fetch(`${base}/api/stream/session/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'life1', infoHash: HASH, currentTime: i * 10 })
  });
  await sleep(700);
}
check('a heart-beating (even paused) player is never paused',
  calls.stop === 0, `${calls.stop} stop call(s) during heartbeats`);

// ---- with no connection AND no heartbeat, it pauses after the grace window ---
console.log('\n--- lifecycle: pauses once genuinely idle ---');
calls.stop = 0;
await fetch(`${base}/api/stream?magnet=${magnet}&title=MockRelease&sessionId=life2`, {
  headers: { Range: 'bytes=0-1000' }
}).then(r => r.arrayBuffer());
await sleep(5000);
check('torrent is paused after the idle grace window elapses',
  calls.stop >= 1, `${calls.stop} stop call(s)`);

// ---- concurrency guard -------------------------------------------------------
console.log('\n--- guards ---');
const hcRes = await fetch(`${base}/health`);
const hc = await hcRes.json();
check('health reports the toolchain', typeof hc.toolchain === 'object' && 'ffmpeg' in hc.toolchain);
check('health reports security posture', hc.security && hc.security.internalEndpointLoopbackOnly === true);

console.log('\n=== BRIDGE LOG (tail) ===');
console.log(log.split('\n').filter(l => l.trim()).slice(-8).join('\n'));

bridge.kill('SIGKILL');
mockQbt.close();
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
