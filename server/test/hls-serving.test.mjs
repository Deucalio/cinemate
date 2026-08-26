/**
 * Phase 5′ §6.3 — serving, and §4.1 — the browser-playability policy.
 *
 * The codec policy is the part worth testing hardest. `codec_name: h264` says nothing about
 * profile: a **High 10** or **4:2:2** release probes as plain "h264" and no browser can decode it.
 * Declaring such a file `direct` would silently reproduce the original "why won't this play"
 * failure. Probe results are supplied through PROBE_OVERRIDE_PATH so this is testable without
 * ffprobe on the machine.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const BRIDGE_PORT = 8980;
const MOCK_QBT_PORT = 18091;
const PIECE_SIZE = 1048576;
const SIZE = 8000000;   // must exceed MIN_MEDIA_FILE_BYTES (5 MB) or discovery rejects it
const PIECES = Math.ceil(SIZE / PIECE_SIZE);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-hlssrv-'));
const hlsRoot = path.join(root, 'hls');
fs.mkdirSync(hlsRoot, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- Titles, each probing as a different codec shape ------------------------
const ffprobe = (streams, format = {}) => ({
  streams,
  format: { duration: '600.0', format_name: 'matroska,webm', ...format }
});
const v = (extra) => ({ codec_type: 'video', codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', ...extra });
const a = (extra) => ({ codec_type: 'audio', codec_name: 'aac', channels: 2, ...extra });

const TITLES = {
  native:      { hash: 'b1'.repeat(20), file: 'Native.mp4',      probe: ffprobe([v(), a()]),                                            expect: 'direct' },
  high10:      { hash: 'b2'.repeat(20), file: 'High10.mp4',      probe: ffprobe([v({ profile: 'High 10', pix_fmt: 'yuv420p10le' }), a()]), expect: 'not-direct' },
  chroma422:   { hash: 'b3'.repeat(20), file: 'Chroma422.mp4',   probe: ffprobe([v({ profile: 'High 4:2:2', pix_fmt: 'yuv422p' }), a()]),  expect: 'not-direct' },
  surround:    { hash: 'b4'.repeat(20), file: 'Surround.mp4',    probe: ffprobe([v(), a({ codec_name: 'eac3', channels: 6 })]),            expect: 'not-direct' },
  matroska:    { hash: 'b5'.repeat(20), file: 'Matroska.mkv',    probe: ffprobe([v(), a()]),                                              expect: 'not-direct' },
  hevc:        { hash: 'b6'.repeat(20), file: 'Hevc.mp4',        probe: ffprobe([v({ codec_name: 'hevc', profile: 'Main 10' }), a()]),     expect: 'not-direct' }
};

const probeTable = {};
for (const t of Object.values(TITLES)) {
  const dir = path.join(root, t.hash);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, t.file);
  fs.writeFileSync(f, Buffer.alloc(1024));
  fs.truncateSync(f, SIZE);
  t.path = f;
  probeTable[t.file] = t.probe;
}
const probePath = path.join(root, 'probes.json');
fs.writeFileSync(probePath, JSON.stringify(probeTable));

// ---- A pre-existing, completed representation to serve ---------------------
const SERVED = 'c1'.repeat(20);
const servedDir = path.join(hlsRoot, SERVED);
fs.mkdirSync(servedDir, { recursive: true });
const SEGMENT_BODY = Buffer.alloc(4096, 7);
const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4'];
for (let i = 0; i < 3; i++) {
  const name = `seg${String(i).padStart(5, '0')}.ts`;
  fs.writeFileSync(path.join(servedDir, name), SEGMENT_BODY);
  lines.push('#EXTINF:4.000,', name);
}
lines.push('#EXT-X-ENDLIST');
fs.writeFileSync(path.join(servedDir, 'playlist.m3u8'), lines.join('\n') + '\n');

// Without a manifest identifying its source, boot reconciliation discards the directory — which is
// correct behaviour, and exactly what a fixture must model rather than work around.
const servedSource = path.join(root, 'Served.mkv');
fs.writeFileSync(servedSource, Buffer.alloc(1024));
fs.truncateSync(servedSource, SIZE);
const servedStat = fs.statSync(servedSource);
fs.writeFileSync(path.join(servedDir, 'manifest.json'), JSON.stringify({
  version: 1,
  infohash: SERVED,
  source: { path: servedSource, sizeBytes: servedStat.size, mtimeMs: Math.round(servedStat.mtimeMs) },
  media: { durationSec: 12, videoCodec: 'h264', audioCodec: 'aac' },
  hls: { segmentDurationSec: 4, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }
}));
// A file outside any representation, to prove traversal is refused.
fs.writeFileSync(path.join(root, 'secret.txt'), 'do not serve me');

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') {
    return send(Object.values(TITLES).map(t => ({
      hash: t.hash, name: t.file.replace(/\.\w+$/, ''), save_path: root,
      content_path: path.join(root, t.hash),
      added_on: Math.floor(Date.now() / 1000),
      state: 'stalledUP', progress: 1, num_seeds: 5, num_leechs: 0, dlspeed: 0,
      amount_left: 0, total_size: SIZE, seq_dl: true, f_l_piece_prio: true,
      magnet_uri: `magnet:?xt=urn:btih:${t.hash}`
    })));
  }
  if (url.pathname === '/api/v2/torrents/properties') return send({ piece_size: PIECE_SIZE, pieces_num: PIECES, total_size: SIZE });
  if (url.pathname === '/api/v2/torrents/pieceStates') return send(new Array(PIECES).fill(2));
  if (url.pathname === '/api/v2/torrents/files') {
    const h = (url.searchParams.get('hash') || '').toLowerCase();
    const t = Object.values(TITLES).find(x => x.hash === h);
    return send(t ? [{ index: 0, name: `${h}/${t.file}`, size: SIZE, piece_range: [0, PIECES - 1] }] : []);
  }
  res.writeHead(200); res.end('Ok.');
});

await new Promise(r => mockQbt.listen(MOCK_QBT_PORT, '127.0.0.1', r));

const bridge = spawn(process.execPath, ['index.js'], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  env: {
    ...process.env,
    PORT: String(BRIDGE_PORT),
    QBT_URL: `http://127.0.0.1:${MOCK_QBT_PORT}`,
    HLS_DIR: hlsRoot,
    HLS_ENABLED: '1',
    PROBE_OVERRIDE_PATH: probePath,
    LRU_STATE_PATH: path.join(root, '.cache', 'lru.json'),
    IDLE_TTL_MINUTES: '600',
    // The HLS branch legitimately requires FFmpeg to EXIST, and this machine has none. The
    // assertions below are about the PLAN, not about produced output, so the toolchain probe is
    // satisfied directly rather than by pointing at something that merely exits zero.
    TOOLCHAIN_OVERRIDE: 'ffmpeg,ffprobe',
    FFMPEG_BIN: 'definitely-not-ffmpeg'   // a spawned job fails harmlessly; nothing here reads its output
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const base = `http://127.0.0.1:${BRIDGE_PORT}`;

// ---- 1. Serving -------------------------------------------------------------
console.log('\n--- Playlist and segment serving ---');
const plRes = await fetch(`${base}/api/stream/hls/${SERVED}/playlist.m3u8`);
const plBody = await plRes.text();
check('serves the playlist', plRes.status === 200, String(plRes.status));
check('with the HLS content type',
  plRes.headers.get('content-type') === 'application/vnd.apple.mpegurl',
  plRes.headers.get('content-type'));
check('and never caches it — it grows while transcoding',
  plRes.headers.get('cache-control') === 'no-store', plRes.headers.get('cache-control'));
check('the playlist names its segments', plBody.includes('seg00000.ts') && plBody.includes('#EXT-X-ENDLIST'));

const segRes = await fetch(`${base}/api/stream/hls/${SERVED}/seg00001.ts`);
const segBody = Buffer.from(await segRes.arrayBuffer());
check('serves a segment', segRes.status === 200, String(segRes.status));
check('with the transport-stream content type',
  segRes.headers.get('content-type') === 'video/mp2t', segRes.headers.get('content-type'));
// Segments never change once written, which is what makes a CDN in front of this trivial.
check('and caches it immutably',
  /immutable/.test(segRes.headers.get('cache-control') || ''), segRes.headers.get('cache-control'));
check('segment bytes are intact', segBody.equals(SEGMENT_BODY), `${segBody.length} bytes`);

console.log('\n--- Serving refuses anything unexpected ---');
for (const [label, url] of [
  ['path traversal',        `${base}/api/stream/hls/${SERVED}/..%2F..%2Fsecret.txt`],
  ['absolute-ish escape',   `${base}/api/stream/hls/${SERVED}/....//secret.txt`],
  ['a non-segment file',    `${base}/api/stream/hls/${SERVED}/manifest.json`],
  ['a wrong-shaped name',   `${base}/api/stream/hls/${SERVED}/seg1.ts`],
  ['a non-hex hash',        `${base}/api/stream/hls/not-a-hash/playlist.m3u8`],
  ['an unknown title',      `${base}/api/stream/hls/${'f'.repeat(40)}/playlist.m3u8`]
]) {
  const r = await fetch(url);
  check(`rejects ${label}`, r.status === 404 || r.status === 400, `status ${r.status}`);
}

// ---- 2. The codec policy ----------------------------------------------------
console.log('\n--- Browser-playability policy ---');
const prepare = async (t) =>
  (await fetch(`${base}/api/stream/prepare?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${t.hash}`)}`)).json();

const nativePlan = await prepare(TITLES.native);
check('MP4 + H.264 Main + AAC stereo → direct', nativePlan.mode === 'direct',
  `${nativePlan.mode} (${nativePlan.reason})`);

// The trap: these probe as "h264" and are undecodable everywhere.
// High 10 and 4:2:2 are REJECTED rather than routed to HLS, and that is correct: their video
// stream cannot be copied into anything a browser plays, so segmenting it would produce segments
// that still will not decode. Only a full re-encode helps, and that is opt-in.
const high10 = await prepare(TITLES.high10);
check('H.264 High 10 is rejected, not silently segmented',
  high10.ok === false && high10.code === 'UNSUPPORTED_VIDEO_CODEC', `${high10.code} ${high10.mode}`);
check('and names the profile rather than blaming "h264"',
  /High 10|pixel format|yuv420p10/.test(`${high10.reason} ${high10.error}`),
  `${high10.reason} | ${high10.error}`.slice(0, 140));

const chroma = await prepare(TITLES.chroma422);
check('H.264 4:2:2 is rejected too',
  chroma.ok === false && chroma.code === 'UNSUPPORTED_VIDEO_CODEC', `${chroma.code} ${chroma.mode}`);
check('and names the pixel format', /4:2:2|yuv422/.test(`${chroma.reason} ${chroma.error}`),
  `${chroma.reason} | ${chroma.error}`.slice(0, 140));

const surround = await prepare(TITLES.surround);
check('6-channel E-AC-3 is routed to HLS, not direct', surround.mode === 'hls',
  `${surround.mode} (${surround.reason || surround.error})`);
check('and says which audio', /eac3/.test(surround.reason || ''), surround.reason);

const mkv = await prepare(TITLES.matroska);
check('Matroska is routed to HLS, not direct', mkv.mode === 'hls',
  `${mkv.mode} (${mkv.reason || mkv.error})`);
check('and says the container is why', /\.mkv|container/.test(mkv.reason || ''), mkv.reason);

check('an HLS plan carries a playlist URL',
  typeof mkv.playlistUrl === 'string' && mkv.playlistUrl.includes('/playlist.m3u8'),
  mkv.playlistUrl);
check('and reports transcode state', mkv.transcode && typeof mkv.transcode.state === 'string',
  JSON.stringify(mkv.transcode));

const hevc = await prepare(TITLES.hevc);
check('HEVC is rejected outright without ALLOW_VIDEO_TRANSCODE',
  hevc.ok === false && hevc.code === 'UNSUPPORTED_VIDEO_CODEC',
  `${hevc.code} ${hevc.error || ''}`.slice(0, 120));

console.log('\n--- Health ---');
const health = await (await fetch(`${base}/health`)).json();
check('reports HLS configuration',
  health.hls && health.hls.enabled === true && health.hls.segmentSeconds === 4,
  JSON.stringify(health.hls));

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await sleep(150);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
