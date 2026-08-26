/**
 * Phase 5′ §7 — the testing gaps left by §6.2 and §6.3.
 *
 * Three things were listed as needing coverage and did not have it:
 *
 *   1. The FFmpeg argument list. It was deliberately split into buildHlsFfmpegArgs() "so it can be
 *      asserted without spawning" — and then never was. The manifest records the exact args before
 *      the process is spawned, so they can be read back through the real code path.
 *   2. A completed representation is REUSED, not rebuilt.
 *   3. EXTINF summation, which drives both transcode progress and the seek boundary.
 *
 * Nothing here spawns FFmpeg: FFMPEG_BIN points at something that does not exist, and the manifest
 * is written before the spawn is attempted.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const BRIDGE_PORT = 8981;
const MOCK_QBT_PORT = 18090;
const PIECE_SIZE = 1048576;
const SIZE = 8000000;
const PIECES = Math.ceil(SIZE / PIECE_SIZE);

const FRESH  = 'd1'.repeat(20);   // no representation — a job must start
const REUSED = 'd2'.repeat(20);   // complete representation — must be reused untouched

// Deliberately non-uniform, which is the entire reason progress is summed from EXTINF rather than
// multiplied out from a segment count.
const EXTINF = [3.900, 4.050, 2.125];
const EXTINF_TOTAL = 10.1;        // 10.075, rounded to one decimal by hlsStatus()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-hlsjob-'));
const hlsRoot = path.join(root, 'hls');
fs.mkdirSync(hlsRoot, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- Sources ---------------------------------------------------------------
const sources = {};
for (const hash of [FRESH, REUSED]) {
  const dir = path.join(root, hash);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${hash.slice(0, 6)}.mkv`);
  fs.writeFileSync(f, Buffer.alloc(1024));
  fs.truncateSync(f, SIZE);
  sources[hash] = f;
}

// ---- A completed representation for the reuse case -------------------------
const reusedDir = path.join(hlsRoot, REUSED);
fs.mkdirSync(reusedDir, { recursive: true });
const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4'];
EXTINF.forEach((dur, i) => {
  const name = `seg${String(i).padStart(5, '0')}.ts`;
  fs.writeFileSync(path.join(reusedDir, name), Buffer.alloc(2048));
  lines.push(`#EXTINF:${dur.toFixed(3)},`, name);
});
lines.push('#EXT-X-ENDLIST');
fs.writeFileSync(path.join(reusedDir, 'playlist.m3u8'), lines.join('\n') + '\n');

const reusedStat = fs.statSync(sources[REUSED]);
const reusedManifest = {
  version: 1,
  infohash: REUSED,
  source: { path: sources[REUSED], sizeBytes: reusedStat.size, mtimeMs: Math.round(reusedStat.mtimeMs) },
  media: { durationSec: 20, videoCodec: 'h264', audioCodec: 'eac3', audioChannels: 6 },
  hls: {
    segmentDurationSec: 4,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date().toISOString(),
    ffmpegArgs: ['-marker-from-the-original-build']
  }
};
fs.writeFileSync(path.join(reusedDir, 'manifest.json'), JSON.stringify(reusedManifest));

// ---- Probe results: both are Matroska, so both need HLS ---------------------
const probe = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p' },
    { codec_type: 'audio', codec_name: 'eac3', channels: 6 }
  ],
  format: { duration: '20.0', format_name: 'matroska,webm' }
};
const probePath = path.join(root, 'probes.json');
fs.writeFileSync(probePath, JSON.stringify(
  Object.fromEntries(Object.values(sources).map(p => [path.basename(p), probe]))
));

const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') {
    return send([FRESH, REUSED].map(h => ({
      hash: h, name: `T-${h.slice(0, 4)}`, save_path: root,
      content_path: path.join(root, h),
      added_on: Math.floor(Date.now() / 1000),
      state: 'stalledUP', progress: 1, num_seeds: 4, num_leechs: 0, dlspeed: 0,
      amount_left: 0, total_size: SIZE, seq_dl: true, f_l_piece_prio: true,
      magnet_uri: `magnet:?xt=urn:btih:${h}`
    })));
  }
  if (url.pathname === '/api/v2/torrents/properties') return send({ piece_size: PIECE_SIZE, pieces_num: PIECES, total_size: SIZE });
  if (url.pathname === '/api/v2/torrents/pieceStates') return send(new Array(PIECES).fill(2));
  if (url.pathname === '/api/v2/torrents/files') {
    const h = (url.searchParams.get('hash') || '').toLowerCase();
    return send(sources[h] ? [{ index: 0, name: `${h}/${path.basename(sources[h])}`, size: SIZE, piece_range: [0, PIECES - 1] }] : []);
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
    HLS_SEGMENT_SECONDS: '4',
    PROBE_OVERRIDE_PATH: probePath,
    TOOLCHAIN_OVERRIDE: 'ffmpeg,ffprobe',
    FFMPEG_BIN: 'definitely-not-ffmpeg',   // the manifest is written BEFORE the spawn is attempted
    LRU_STATE_PATH: path.join(root, '.cache', 'lru.json'),
    IDLE_TTL_MINUTES: '600'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

const base = `http://127.0.0.1:${BRIDGE_PORT}`;
const magnetFor = (h) => encodeURIComponent(`magnet:?xt=urn:btih:${h}`);
const prepare = async (h) => (await fetch(`${base}/api/stream/prepare?magnet=${magnetFor(h)}`)).json();

// ---- 1. The FFmpeg argument list -------------------------------------------
console.log('\n--- FFmpeg arguments (read back from the manifest, never executed) ---');
const freshPlan = await prepare(FRESH);
check('a title with no representation gets a job', freshPlan.mode === 'hls',
  `${freshPlan.mode} ${freshPlan.error || ''}`);

const freshManifest = JSON.parse(fs.readFileSync(path.join(hlsRoot, FRESH, 'manifest.json'), 'utf8'));
const args = freshManifest.hls.ffmpegArgs || [];
const argStr = args.join(' ');

check('video is stream-copied', argStr.includes('-c:v copy'), argStr.slice(0, 120));
check('audio is re-encoded to stereo AAC',
  argStr.includes('-c:a aac') && argStr.includes('-ac 2'), argStr.slice(0, 160));
check('output is HLS', argStr.includes('-f hls'));
check('segment length matches configuration', argStr.includes('-hls_time 4'));
// The playlist must grow rather than roll, or hls.js loses the beginning of the film.
check('playlist type is event', argStr.includes('-hls_playlist_type event'));
check('the playlist never drops entries', argStr.includes('-hls_list_size 0'));
// temp_file is what makes "a segment named in the playlist is complete on disk" true.
check('segments are written atomically', /-hls_flags \S*temp_file/.test(argStr), argStr.slice(0, 200));
check('segments are named predictably', /-hls_segment_filename \S+seg%05d\.ts/.test(argStr));

// The source is complete, so FFmpeg must open the file directly rather than the loopback reader.
check('a complete source is read from the local path, not loopback',
  args.includes(sources[FRESH]) && !argStr.includes('/internal/piece-file'),
  argStr.slice(argStr.indexOf('-i'), argStr.indexOf('-i') + 90));
check('and carries no HTTP reconnect options', !argStr.includes('-reconnect'),
  argStr.slice(0, 120));
check('the log records which input was used', /input=local-file/.test(log),
  (log.match(/\[HLS\] Transcoding[^\n]*/g) || []).join(' | ').slice(0, 200));

// ---- 2. A completed representation is reused --------------------------------
console.log('\n--- A completed representation is reused, not rebuilt ---');
const before = (log.match(/\[HLS\] Transcoding/g) || []).length;
const reusedPlan = await prepare(REUSED);
await sleep(500);
const after = (log.match(/\[HLS\] Transcoding/g) || []).length;

check('prepare returns an HLS plan', reusedPlan.mode === 'hls', `${reusedPlan.mode} ${reusedPlan.error || ''}`);
check('no new transcode is started', after === before, `${before} → ${after}`);
check('the existing manifest is untouched',
  JSON.parse(fs.readFileSync(path.join(reusedDir, 'manifest.json'), 'utf8'))
    .hls.ffmpegArgs[0] === '-marker-from-the-original-build');
check('it reports as complete', reusedPlan.transcode && reusedPlan.transcode.state === 'complete',
  JSON.stringify(reusedPlan.transcode));

// ---- 3. EXTINF summation ----------------------------------------------------
console.log('\n--- Progress is summed from EXTINF, not from segment count ---');
const status = await (await fetch(`${base}/api/stream/status?magnet=${magnetFor(REUSED)}`)).json();

check('transcoded duration is the sum of EXTINF values',
  status.transcode && status.transcode.transcodedDurationSec === EXTINF_TOTAL,
  `${status.transcode && status.transcode.transcodedDurationSec} (expected ${EXTINF_TOTAL})`);
// 3 segments x 4s would be 12s, which is what a count-based calculation would have reported.
check('and is NOT segments × target duration',
  status.transcode.transcodedDurationSec !== EXTINF.length * 4,
  `${status.transcode.transcodedDurationSec} vs naive ${EXTINF.length * 4}`);
check('segment count is reported separately',
  status.transcode.segmentsReady === EXTINF.length, String(status.transcode.segmentsReady));
check('progress is duration-derived',
  Math.abs(status.transcode.progress - (EXTINF_TOTAL / 20)) < 0.02,
  `${status.transcode.progress}`);

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await sleep(150);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
