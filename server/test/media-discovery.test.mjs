/**
 * Media file discovery against the shapes qBittorrent actually presents mid-download.
 *
 * Regression cover for the failure that reached production: file selection scanned the DISK, so a
 * still-downloading movie named "Movie.mp4.!qB" (qBittorrent's incomplete-file suffix, on by
 * default) had extension ".!qb", matched no media whitelist, and the bridge reported
 * "no playable media file was found" on a perfectly healthy torrent.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PIECE_SIZE = 1048576;
const MOVIE_SIZE = 12000000;
const SUB_SIZE = 40000;
const SAMPLE_SIZE = 6000000;
const BRIDGE_PORT = 8974;
const MOCK_QBT_PORT = 18097;

// What /torrents/properties reports. Real qBittorrent exposes piece_size ONLY here.
const TOTAL_PIECES_FOR_MOCK = 64;
const TOTAL_SIZE_FOR_MOCK = TOTAL_PIECES_FOR_MOCK * PIECE_SIZE;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-media-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// Each scenario describes one torrent layout: what qBittorrent reports, and what is on disk.
const scenarios = {
  // Still downloading: the movie wears the .!qB suffix and lives beside a subtitle and a sample.
  incomplete: {
    hash: 'c'.repeat(40),
    dir: 'Incomplete.Release',
    files: [
      { index: 0, name: 'Incomplete.Release/Incomplete.Release.srt', size: SUB_SIZE, piece_range: [0, 0] },
      { index: 1, name: 'Incomplete.Release/Incomplete.Release.mp4', size: MOVIE_SIZE, piece_range: [0, 11] }
    ],
    onDisk: [
      ['Incomplete.Release.srt', SUB_SIZE],
      ['Incomplete.Release.mp4.!qB', MOVIE_SIZE]   // <-- the suffix that broke discovery
    ],
    expectFile: 'Incomplete.Release.mp4',
    expectSize: MOVIE_SIZE
  },
  // A sample must never win over the feature, even though it is listed first.
  sample: {
    hash: 'd'.repeat(40),
    dir: 'Sampled.Release',
    files: [
      { index: 0, name: 'Sampled.Release/sample-Sampled.Release.mp4', size: SAMPLE_SIZE, piece_range: [0, 5] },
      { index: 1, name: 'Sampled.Release/Sampled.Release.mp4', size: MOVIE_SIZE, piece_range: [5, 17] }
    ],
    onDisk: [
      ['sample-Sampled.Release.mp4', SAMPLE_SIZE],
      ['Sampled.Release.mp4.!qB', MOVIE_SIZE]
    ],
    expectFile: 'Sampled.Release.mp4',
    expectSize: MOVIE_SIZE
  },
  // Matroska is never browser-native, so it must route away from direct regardless of codecs.
  matroska: {
    hash: 'f'.repeat(40),
    dir: 'Matroska.Release',
    files: [
      { index: 0, name: 'Matroska.Release/Matroska.Release.mkv', size: MOVIE_SIZE, piece_range: [0, 11] }
    ],
    onDisk: [['Matroska.Release.mkv.!qB', MOVIE_SIZE]],
    expectFile: 'Matroska.Release.mkv'
  },
  // qBittorrent reports no usable piece size. The bridge must refuse rather than guess.
  noPieceSize: {
    hash: '9'.repeat(40),
    dir: 'NoPieceSize.Release',
    files: [
      { index: 0, name: 'NoPieceSize.Release/NoPieceSize.Release.mp4', size: MOVIE_SIZE, piece_range: [0, 11] }
    ],
    onDisk: [['NoPieceSize.Release.mp4', MOVIE_SIZE]]
  },
  // Nothing streamable: must fail fast and clearly, not poll for 24 seconds.
  archive: {
    hash: 'e'.repeat(40),
    dir: 'Archive.Release',
    files: [
      { index: 0, name: 'Archive.Release/disc.iso', size: MOVIE_SIZE, piece_range: [0, 11] },
      { index: 1, name: 'Archive.Release/readme.nfo', size: 2000, piece_range: [11, 11] }
    ],
    onDisk: [['disc.iso', MOVIE_SIZE], ['readme.nfo', 2000]],
    expectFail: 415
  }
};

for (const sc of Object.values(scenarios)) {
  const dir = path.join(root, sc.dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, size] of sc.onDisk) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(Math.min(size, 1024)));
    fs.truncateSync(path.join(dir, name), size);
  }
}

const byHash = Object.fromEntries(Object.values(scenarios).map(sc => [sc.hash, sc]));

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  // piece_size and pieces_num live ONLY here — /torrents/info does not carry them.
  if (url.pathname === '/api/v2/torrents/properties') {
    const h = (url.searchParams.get('hash') || '').toLowerCase();
    if (h === scenarios.noPieceSize.hash) return send({});
    return send({ piece_size: PIECE_SIZE, pieces_num: TOTAL_PIECES_FOR_MOCK, total_size: TOTAL_SIZE_FOR_MOCK });
  }
  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') {
    return send(Object.values(scenarios).map(sc => ({
      hash: sc.hash,
      name: sc.dir,
      save_path: root,
      content_path: path.join(root, sc.dir),
      added_on: Math.floor(Date.now() / 1000),
      magnet_uri: `magnet:?xt=urn:btih:${sc.hash}`
    })));
  }
  if (url.pathname === '/api/v2/torrents/files') {
    const sc = byHash[(url.searchParams.get('hash') || '').toLowerCase()];
    return send(sc ? sc.files : []);
  }
  if (url.pathname === '/api/v2/torrents/pieceStates') {
    return send(new Array(64).fill(2));
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
    // This suite covers file selection mid-download (the .!qB suffix), which only
    // exists while a torrent is incomplete.
    REQUIRE_COMPLETE: '0',
    PIECE_POLL_MS: '80',
    PIECE_STATE_CACHE_MS: '80',
    IDLE_TTL_MINUTES: '60'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

await new Promise(r => setTimeout(r, 2500));

const base = `http://127.0.0.1:${BRIDGE_PORT}`;
const prepare = async (hash) => {
  const res = await fetch(`${base}/api/stream/prepare?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${hash}`)}`);
  return { status: res.status, body: await res.json() };
};

console.log('\n--- Incomplete download (.!qB suffix) ---');
const inc = await prepare(scenarios.incomplete.hash);
check('resolves a still-downloading .!qB file', inc.body.ok === true,
  inc.body.ok ? '' : `${inc.status} ${inc.body.error}`);
check('reports the LOGICAL media file name, not the .!qB path',
  inc.body.fileName === scenarios.incomplete.expectFile, inc.body.fileName);
// A still-downloading .mp4 is still an .mp4: its container must be judged on the logical name,
// or every incomplete browser-native file gets needlessly pushed through FFmpeg.
check('an incomplete .mp4 still resolves to direct mode', inc.body.mode === 'direct',
  `mode=${inc.body.mode} reason=${inc.body.reason}`);
check('uses the torrent-declared size, not the on-disk size',
  inc.body.fileSizeBytes === scenarios.incomplete.expectSize, String(inc.body.fileSizeBytes));
check('ignores the subtitle file', inc.body.fileName !== 'Incomplete.Release.srt');

console.log('\n--- Sample file must not win ---');
const smp = await prepare(scenarios.sample.hash);
check('picks the feature over the sample', smp.body.ok === true && smp.body.fileName === scenarios.sample.expectFile,
  smp.body.fileName || smp.body.error);
check('feature size reported', smp.body.fileSizeBytes === scenarios.sample.expectSize,
  String(smp.body.fileSizeBytes));

console.log('\n--- Piece size must come from /torrents/properties, never a guess ---');
// piece_size is NOT a field of /torrents/info. Reading it from there yielded undefined and fell
// back to a guessed 2 MB; when the real piece size is smaller, the computed piece index lands on an
// already-downloaded piece and the reader serves sparse zeros — FFmpeg then reports
// "0x00 ... invalid as first byte of an EBML number" and nothing plays until the torrent hits 100%.
const nps = await prepare(scenarios.noPieceSize.hash);
check('refuses to stream when the piece size is unknown', nps.body.ok === false,
  JSON.stringify(nps.body).slice(0, 140));
check('says why, instead of silently guessing',
  typeof nps.body.error === 'string' && /piece size/i.test(nps.body.error), nps.body.error);

console.log('\n--- Matroska routes away from direct ---');
const mkv = await prepare(scenarios.matroska.hash);
// With FFmpeg present this is ok:true/mode:remux; without it, a clear FFMPEG_MISSING. Both are
// correct — what must never happen is an .mkv being handed to <video> as a direct stream.
check('an .mkv is never served in direct mode',
  mkv.body.mode === 'remux' || mkv.body.code === 'FFMPEG_MISSING',
  `mode=${mkv.body.mode} code=${mkv.body.code}`);
check('the .!qB suffix did not hide the .mkv container',
  !/\.!qb/i.test(JSON.stringify(mkv.body)), JSON.stringify(mkv.body).slice(0, 160));

console.log('\n--- No streamable media ---');
const t0 = Date.now();
const arc = await prepare(scenarios.archive.hash);
const elapsed = Date.now() - t0;
check('rejects an ISO/NFO-only torrent', arc.status === 415, `status ${arc.status}`);
check('fails fast instead of polling for 24s', elapsed < 5000, `${elapsed}ms`);
check('explains why', typeof arc.body.error === 'string' && arc.body.error.includes('no streamable video'),
  arc.body.error);
check('does not offer .iso as media', !String(arc.body.fileName || '').endsWith('.iso'));

console.log('\n--- Piece mapping across the selected file ---');
check('logs the chosen file and its torrent offset', /\[Media Select\].*Incomplete\.Release\.mp4/.test(log),
  (log.match(/\[Media Select\][^\n]*/g) || []).join(' | ').slice(0, 220));

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await new Promise(r => setTimeout(r, 150));
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
