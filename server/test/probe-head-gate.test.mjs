/**
 * Regression test: probing a source whose head has not downloaded yet.
 *
 * WHAT ACTUALLY BREAKS (measured against real ffprobe, not assumed):
 *
 *   ffprobe issues exactly ONE request for a Matroska source — `Range: bytes=0-` — and reads
 *   forward. It never seeks to the tail. Measured consumption before it is satisfied:
 *
 *       5.7 Mbps MKV, 2 streams .......... 1.00 MB
 *       5.8 Mbps MKV, 4 streams (2 audio
 *         + a subtitle whose first cue
 *         is at 90 s) .................... 1.00 MB
 *       20.9 Mbps MKV, 2 streams ......... 1.56 MB
 *
 *   So the demand is small and near enough bitrate-independent. What kills the probe is not the
 *   SIZE of the file but whether the first ~2 MB have been VERIFIED. Serving from a frontier below
 *   what ffprobe needs makes it hang, because `waitForPiece` resets its stall deadline every time
 *   the torrent verifies any piece — a healthy download therefore blocks the reader indefinitely,
 *   and only ffprobe's own timeout ends it:
 *
 *       frontier 0 / 64 KB / 128 KB / 256 KB / 512 KB -> TIMED OUT (10 s, no fields at all)
 *       frontier 1 MB / 2 MB / 4 MB ................. -> ok in ~90 ms, every field present
 *
 *   Truncation alone is harmless: a plain 1 MB head of the same file probes completely, duration
 *   included, because Matroska stores Duration in the Info element at the START of the segment.
 *
 * The two defects this pins down:
 *
 *   1. The probe is spawned without checking whether the head is available, so a prepare issued
 *      seconds after a torrent is added burns the entire ffprobe timeout and returns nothing.
 *   2. `probeCache` has no TTL, so that null latches under `hash:filePath`. Every later prepare
 *      returns the cached failure without re-probing, and the title reports `downloading` for the
 *      life of the process even once the head — or the whole file — has landed.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const PIECE_SIZE = 1048576;              // 1 MB
const HASH = 'c'.repeat(40);
const MOCK_QBT_PORT = 18103;
const BRIDGE_PORT = 8976;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// This suite is only meaningful against a real ffprobe: the whole point is how ffprobe behaves
// when its input stalls. Mocking it would assert our assumptions back at us.
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 &&
                   spawnSync('ffprobe', ['-version']).status === 0;
if (!haveFfmpeg) {
  console.log('SKIP  probe-head-gate — ffmpeg/ffprobe not on PATH');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-probegate-'));
const releaseDir = path.join(root, HASH);
fs.mkdirSync(releaseDir, { recursive: true });
const moviePath = path.join(releaseDir, 'movie.mkv');

// A real MKV, big enough to span several pieces so head-availability is a meaningful distinction.
const gen = spawnSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=40',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k', '-pix_fmt', 'yuv420p',
  '-c:a', 'eac3', '-ac', '6', '-b:a', '384k', moviePath
], { timeout: 120000 });
if (gen.status !== 0) {
  console.log('SKIP  probe-head-gate — could not build the fixture');
  process.exit(0);
}

const SIZE = fs.statSync(moviePath).size;
const PIECES = Math.ceil(SIZE / PIECE_SIZE);
check('fixture spans enough pieces to distinguish head from tail', PIECES >= 4, `${PIECES} pieces, ${SIZE} bytes`);

// ---- Mock qBittorrent -------------------------------------------------------
// `verifiedUpTo` is the download frontier: pieces 0..verifiedUpTo are state 2, the rest state 0.
// -1 means nothing has been verified yet, which is the state moments after a torrent is added.
let verifiedUpTo = -1;
let reportedProgress = 0.05;
let pieceStateRequests = 0;

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') {
    return send([{
      hash: HASH, name: `T-${HASH.slice(0, 4)}`, save_path: root, content_path: releaseDir,
      added_on: Math.floor(Date.now() / 1000),
      state: 'downloading', progress: reportedProgress, num_seeds: 6, num_leechs: 2,
      dlspeed: 2000000, amount_left: Math.round(SIZE * (1 - reportedProgress)),
      total_size: SIZE, seq_dl: true, f_l_piece_prio: true,
      magnet_uri: `magnet:?xt=urn:btih:${HASH}`
    }]);
  }
  if (url.pathname === '/api/v2/torrents/properties') {
    return send({ piece_size: PIECE_SIZE, pieces_num: PIECES, total_size: SIZE });
  }
  if (url.pathname === '/api/v2/torrents/pieceStates') {
    pieceStateRequests++;
    return send(Array.from({ length: PIECES }, (_, i) => (i <= verifiedUpTo ? 2 : 0)));
  }
  if (url.pathname === '/api/v2/torrents/files') {
    return send([{ index: 0, name: `${HASH}/movie.mkv`, size: SIZE, priority: 1, piece_range: [0, PIECES - 1] }]);
  }
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
    HLS_DIR: path.join(root, 'hls'),
    HLS_ENABLED: '1',
    LRU_STATE_PATH: path.join(root, '.cache', 'lru.json'),
    PIECE_POLL_MS: '80',
    PIECE_STATE_CACHE_MS: '80',
    IDLE_TTL_MINUTES: '600',
    // Keep HLS enabled (the toolchain check would otherwise disable it) but make the transcode
    // spawn fail: the manifest is written before the spawn, so the plan is still observable and
    // this suite stays about the probe that precedes it.
    TOOLCHAIN_OVERRIDE: 'ffmpeg,ffprobe',
    FFMPEG_BIN: 'definitely-not-ffmpeg'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const base = `http://127.0.0.1:${BRIDGE_PORT}`;

// Wait for the bridge to bind rather than guessing at a delay — the fixture build above makes
// startup timing unpredictable, and a bare ECONNREFUSED hides whatever the bridge actually said.
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) up = true;
  } catch { await sleep(250); }
}
if (!up) {
  console.log('FAIL  bridge never came up');
  console.log('--- bridge log ---\n' + log);
  process.exit(1);
}
const magnet = encodeURIComponent(`magnet:?xt=urn:btih:${HASH}`);
const prepare = async () => {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/stream/prepare?magnet=${magnet}`);
  const body = await r.json();
  return { ms: Date.now() - t0, body };
};

// ---- Test 1: nothing verified yet -------------------------------------------
// A prepare issued seconds after the torrent is added must not spawn a probe that cannot succeed.
console.log('\n--- Test 1: prepare with an unavailable head does not block on ffprobe ---');
const logBefore = log.length;
const first = await prepare();

check('prepare still answers', first.body.ok === true, JSON.stringify(first.body).slice(0, 160));
check('reports the title as still downloading', first.body.readyState === 'downloading', first.body.readyState);
check('answers promptly instead of burning the probe timeout',
  first.ms < 4000, `took ${first.ms}ms`);

const firstLog = log.slice(logBefore);
check('no doomed ffprobe was spawned against the unavailable head',
  !/\[ffprobe\].*FAILED/.test(firstLog),
  (firstLog.match(/\[ffprobe\].*/) || ['(none)'])[0]);

// ---- Test 2: the head lands, and the earlier failure must not latch ---------
// Sequential download has delivered the first pieces. The source is still incomplete, so this is
// exactly the fast-start case: probe the head, decide the codecs, begin transcoding.
console.log('\n--- Test 2: once the head is verified, the probe runs and is not latched off ---');
verifiedUpTo = Math.min(PIECES - 1, 5);   // ~6 MB, comfortably past the ~1.6 MB ffprobe consumes
reportedProgress = 0.45;
// Outlast the piece-state cache. Now that a deferred probe returns immediately, back-to-back
// prepares would otherwise both read the same cached states; a real client retries seconds apart.
await sleep(500);

const logBefore2 = log.length;
const second = await prepare();
const secondLog = log.slice(logBefore2);

check('a probe was actually attempted this time',
  /\[ffprobe\]/.test(secondLog),
  /\[ffprobe\]/.test(secondLog) ? '' : 'no ffprobe line — the earlier null was cached and reused');
check('the probe succeeded against the verified head',
  /\[ffprobe\].*ok in/.test(secondLog),
  (secondLog.match(/\[ffprobe\].*/) || ['(none)'])[0]);
check('does not hold fast start back once the head is available',
  !/holding fast start/.test(secondLog),
  (secondLog.match(/.*holding fast start.*/) || [''])[0].slice(0, 120));
check('prepare reached an HLS plan rather than reporting downloading',
  second.body.mode === 'hls',
  JSON.stringify(second.body).slice(0, 200));

// ---- Test 3: the gate is cheap ----------------------------------------------
console.log('\n--- Test 3: the readiness check is cheap ---');
check('piece states were polled a bounded number of times',
  pieceStateRequests < 400, `${pieceStateRequests} requests`);

// ---- Teardown ---------------------------------------------------------------
bridge.kill('SIGKILL');
await sleep(300);                     // let the bridge's sockets drop before tearing the mock down
mockQbt.closeAllConnections?.();
await new Promise(r => mockQbt.close(() => r()));
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
if (failures > 0) {
  console.log('\n--- bridge log ---\n' + log.split('\n').slice(-40).join('\n'));
}
process.exit(failures === 0 ? 0 : 1);
