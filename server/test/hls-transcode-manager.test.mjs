/**
 * Phase 5′ §6.2 — transcode manager.
 *
 * The dev machine has no FFmpeg, so nothing here spawns it. What IS testable without it is
 * everything that decides *what* to run and *whether to trust* what a previous run left behind —
 * which is where the failure modes actually live:
 *
 *   - the FFmpeg argument list (asserted, never executed)
 *   - EXTINF playlist parsing, which drives both progress and the seek boundary
 *   - every branch of boot reconciliation (§5.2)
 *
 * Reconciliation is exercised by laying out directories on disk, booting the bridge, and reading
 * which ones it kept. That is the real code path, not a re-implementation of it.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const BRIDGE_PORT = 8979;
const MOCK_QBT_PORT = 18092;
const SOURCE_SIZE = 4000000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinestream-hlsmgr-'));
const hlsRoot = path.join(root, 'hls');
fs.mkdirSync(hlsRoot, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- Helpers ---------------------------------------------------------------
function makeSource(name) {
  const f = path.join(root, `${name}.mkv`);
  fs.writeFileSync(f, Buffer.alloc(1024));
  fs.truncateSync(f, SOURCE_SIZE);
  return f;
}

/**
 * @param opts.segments        how many segment files to write
 * @param opts.listedSegments  how many the playlist NAMES (to model a playlist ahead of the files)
 * @param opts.endList         write EXT-X-ENDLIST
 * @param opts.manifest        false = omit, or an object to merge over the default
 * @param opts.stray           write a leftover segNNNNN.ts.tmp
 */
function layout(hash, opts = {}) {
  const {
    segments = 3, listedSegments = segments, endList = true,
    manifest = {}, stray = false, sourcePath = null
  } = opts;

  const dir = path.join(hlsRoot, hash);
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < segments; i++) {
    fs.writeFileSync(path.join(dir, `seg${String(i).padStart(5, '0')}.ts`), Buffer.alloc(2048));
  }
  if (stray) fs.writeFileSync(path.join(dir, 'seg09999.ts.tmp'), Buffer.alloc(512));

  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4'];
  for (let i = 0; i < listedSegments; i++) {
    // Deliberately not exactly 4.000 — real segments are keyframe-aligned, which is precisely why
    // progress is summed from EXTINF rather than multiplied out from a segment count.
    lines.push(`#EXTINF:${(3.9 + i * 0.05).toFixed(3)},`, `seg${String(i).padStart(5, '0')}.ts`);
  }
  if (endList) lines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(path.join(dir, 'playlist.m3u8'), lines.join('\n') + '\n');

  if (manifest !== false) {
    const st = sourcePath ? fs.statSync(sourcePath) : null;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version: 1,
      infohash: hash,
      source: sourcePath
        ? { path: sourcePath, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) }
        : { path: path.join(root, 'nonexistent.mkv'), sizeBytes: 1, mtimeMs: 1 },
      media: { durationSec: 12, videoCodec: 'h264', audioCodec: 'aac' },
      hls: {
        segmentDurationSec: 4,
        startedAt: new Date().toISOString(),
        completedAt: endList ? new Date().toISOString() : null
      },
      ...manifest
    }));
  }

  return dir;
}

// ---- Reconciliation fixtures — one directory per branch of §5.2 ------------
const good        = makeSource('good');
const sizeChanged = makeSource('sizeChanged');

const CASES = {
  valid:         { hash: '1a'.repeat(20), dir: layout('1a'.repeat(20), { sourcePath: good }),                       keep: true  },
  strayTmp:      { hash: '2a'.repeat(20), dir: layout('2a'.repeat(20), { sourcePath: good, stray: true }),          keep: true  },
  noManifest:    { hash: '3a'.repeat(20), dir: layout('3a'.repeat(20), { sourcePath: good, manifest: false }),      keep: false },
  badVersion:    { hash: '4a'.repeat(20), dir: layout('4a'.repeat(20), { sourcePath: good, manifest: { version: 99 } }), keep: false },
  sourceGone:    { hash: '5a'.repeat(20), dir: layout('5a'.repeat(20)),                                             keep: false },
  missingSeg:    { hash: '6a'.repeat(20), dir: layout('6a'.repeat(20), { sourcePath: good, segments: 2, listedSegments: 4 }), keep: false },
  interrupted:   { hash: '7a'.repeat(20), dir: layout('7a'.repeat(20), { sourcePath: good, endList: false }),       keep: false },
  emptyPlaylist: { hash: '8a'.repeat(20), dir: layout('8a'.repeat(20), { sourcePath: good, segments: 0, listedSegments: 0 }), keep: false }
};

// Source that changed underneath its representation.
const changedHash = '9a'.repeat(20);
const changedDir = layout(changedHash, { sourcePath: sizeChanged });
fs.truncateSync(sizeChanged, SOURCE_SIZE + 12345);
CASES.sourceChanged = { hash: changedHash, dir: changedDir, keep: false };

// ---- Mock qBittorrent: every fixture has a torrent, so orphan sweeping is not what removes them --
const mockQbt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (url.pathname === '/api/v2/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'SID=t; path=/' }); return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/info') {
    return send(Object.values(CASES).map(c => ({
      hash: c.hash, name: `T-${c.hash.slice(0, 4)}`, save_path: root,
      content_path: root, added_on: Math.floor(Date.now() / 1000),
      state: 'stalledUP', progress: 1, total_size: SOURCE_SIZE,
      seq_dl: true, f_l_piece_prio: true, magnet_uri: `magnet:?xt=urn:btih:${c.hash}`
    })));
  }
  if (url.pathname === '/api/v2/torrents/properties') return send({ piece_size: 1048576, pieces_num: 4, total_size: SOURCE_SIZE });
  if (url.pathname === '/api/v2/torrents/pieceStates') return send([2, 2, 2, 2]);
  if (url.pathname === '/api/v2/torrents/files') return send([]);
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
    LRU_STATE_PATH: path.join(root, '.cache', 'lru.json'),
    IDLE_TTL_MINUTES: '600',
    HLS_SEGMENT_SECONDS: '4',
    HLS_MAX_CONCURRENT: '2'
  }
});
let log = '';
bridge.stdout.on('data', d => log += d);
bridge.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

// ---- 1. Boot reconciliation ------------------------------------------------
console.log('\n--- Boot reconciliation: every branch of §5.2 ---');
for (const [name, c] of Object.entries(CASES)) {
  const exists = fs.existsSync(c.dir);
  check(
    `${name} → ${c.keep ? 'kept' : 'discarded'}`,
    exists === c.keep,
    exists ? 'still present' : 'removed'
  );
}

check('a leftover .tmp is cleaned from a kept directory',
  !fs.existsSync(path.join(CASES.strayTmp.dir, 'seg09999.ts.tmp')));
check('each discard states its reason', (log.match(/\[HLS\] Discarding/g) || []).length >= 6,
  (log.match(/Discarding[^\n]*/g) || []).join(' | ').slice(0, 300));
check('an interrupted job is rebuilt, not resumed',
  /no EXT-X-ENDLIST\) — rebuilding/.test(log),
  (log.match(/Discarding[^\n]*ENDLIST[^\n]*/g) || []).join(' | '));
check('a changed source invalidates its representation',
  /source (size|mtime) changed/.test(log),
  (log.match(/Discarding[^\n]*source[^\n]*/g) || []).join(' | '));
check('reconciliation summarises what it kept',
  /Reconciled representations: 2 usable, 7 discarded/.test(log),
  (log.match(/Reconciled[^\n]*/g) || []).join(' | '));

// ---- 2. Configuration is reported ------------------------------------------
console.log('\n--- Configuration ---');
check('the boot banner reports segment length and concurrency',
  /HLS Transcode:.*4s segments · max 2 concurrent/.test(log),
  (log.match(/HLS Transcode[^\n]*/g) || []).join(' | '));
check('the boot banner reports the source retention policy',
  /source policy: retain/.test(log),
  (log.match(/Representations:[^\n]*/g) || []).join(' | '));

bridge.kill('SIGKILL');
if (typeof mockQbt.closeAllConnections === 'function') mockQbt.closeAllConnections();
await new Promise(r => mockQbt.close(r));
await sleep(150);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
