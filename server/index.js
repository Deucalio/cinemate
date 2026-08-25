/**
 * CineStream Pro — High-Performance BitTorrent-to-HTTP Streaming Bridge
 * 
 * Key Architectural Components:
 * 1. qBittorrent Native C++ Engine with Sequential Piece Priority & High-Speed Swarm Connectivity
 * 2. Piece-Aware Sequential Streamer (Checks qBittorrent pieceStates to guarantee zero-byte reads NEVER occur)
 * 3. Real-Time FFmpeg Remuxer (Untouched Video Copy + Universal Stereo AAC Audio in Progressive fMP4)
 * 4. Automated 1-Minute Idle Torrent & Disk Space Garbage Collector
 * 5. Prowlarr Torznab Search Proxy & Prisma PostgreSQL User/Auth API
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8899;

// Security & Admin Credentials
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cinestream_secure_admin_token_8899';

// qBittorrent & Prowlarr Configurations
const QBT_URL = process.env.QBT_URL || 'http://127.0.0.1:18080';
const QBT_USER = process.env.QBT_USER || 'admin';
const QBT_PASS = process.env.QBT_PASS || 'adminadmin';

const PROWLARR_URL = process.env.PROWLARR_URL || 'http://127.0.0.1:9696';
const PROWLARR_KEY = process.env.PROWLARR_KEY || '5a197b3359f247e8a69c7866650058e4';

// Resource, Concurrency & Quota Limits
const MAX_ACTIVE_TORRENTS = parseInt(process.env.MAX_ACTIVE_TORRENTS || '5', 10);
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS || '15', 10);
const DISK_MAX_USAGE_PCT = parseInt(process.env.DISK_MAX_USAGE_PCT || '85', 10);
const IDLE_TTL_MINUTES = parseInt(process.env.IDLE_TTL_MINUTES || '1', 10); // 1 minute auto-delete
const IDLE_TTL_MS = IDLE_TTL_MINUTES * 60 * 1000;

// Piece-Aware Reader Tuning
const PIECE_STATE_CACHE_MS = parseInt(process.env.PIECE_STATE_CACHE_MS || '500', 10);
const PIECE_POLL_MS = parseInt(process.env.PIECE_POLL_MS || '250', 10);
const PIECE_WAIT_TIMEOUT_MS = parseInt(process.env.PIECE_WAIT_TIMEOUT_MS || '120000', 10);
const READ_CHUNK_BYTES = parseInt(process.env.READ_CHUNK_BYTES || '262144', 10); // 256 KB

// A browser opens and abandons many short-lived connections per video. Torrents must NOT be paused
// the instant one closes -- only after this grace window with no connection and no heartbeat.
const STREAM_IDLE_GRACE_MS = parseInt(process.env.STREAM_IDLE_GRACE_MS || '45000', 10);
// One <video> element issues dozens of range requests per minute (seeking, re-buffering, codec
// probing). The old 25/min cap throttled ordinary playback into failure.
const STREAM_RATE_LIMIT_PER_MIN = parseInt(process.env.STREAM_RATE_LIMIT_PER_MIN || '600', 10);
const HEARTBEAT_FRESH_MS = parseInt(process.env.HEARTBEAT_FRESH_MS || '45000', 10);

// Transcoding
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
// Realtime HEVC->H.264 encoding does not keep up on a small VPS, so it is opt-in.
const ALLOW_VIDEO_TRANSCODE = process.env.ALLOW_VIDEO_TRANSCODE === '1';

// What an HTML5 <video> element can actually decode without help
const BROWSER_SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);
const BROWSER_SAFE_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);

// Top Tier High-Speed BitTorrent Trackers (Auto-injected into bare magnets)
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://9.rarbg.to:2920/announce',
  'udp://tracker.dler.org:6969/announce'
];

/**
 * Injects public trackers into bare magnet links to prevent DHT delay
 */
function enrichMagnetWithTrackers(magnet) {
  if (!magnet || !magnet.startsWith('magnet:')) return magnet;
  let enriched = magnet;
  for (const tr of DEFAULT_TRACKERS) {
    if (!enriched.includes(encodeURIComponent(tr)) && !enriched.includes(tr)) {
      enriched += `&tr=${encodeURIComponent(tr)}`;
    }
  }
  return enriched;
}

// ----------------- QBITTORRENT API CLIENT -----------------

class QBittorrentClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.cookie = null;
    // hash -> { at, states, inflight } short-lived pieceStates cache (avoids hammering qBt per read)
    this._pieceCache = new Map();
    // one-shot diagnostics so unsupported endpoints are reported once, not on every read
    this._warned = new Set();
  }

  warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(message);
  }

  async login() {
    try {
      const params = new URLSearchParams();
      params.append('username', this.username);
      params.append('password', this.password);
      const res = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        this.cookie = setCookie.split(';')[0];
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async fetchWithAuth(url, options = {}) {
    if (!this.cookie) await this.login();
    const headers = options.headers || {};
    if (this.cookie) headers['Cookie'] = this.cookie;
    let res = await fetch(url, { ...options, headers });
    if (res.status === 403 || res.status === 401) {
      await this.login();
      if (this.cookie) headers['Cookie'] = this.cookie;
      res = await fetch(url, { ...options, headers });
    }
    return res;
  }

  extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  async addTorrent(magnet) {
    try {
      await this.login();
      const formData = new URLSearchParams();
      // Inject high-availability public trackers so bare magnets do not stall on DHT bootstrap
      formData.append('urls', enrichMagnetWithTrackers(magnet));
      formData.append('sequentialDownload', 'true');
      formData.append('firstLastPiecePrio', 'true');
      const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });
      if (!res.ok) console.warn(`[qBittorrent] torrents/add returned ${res.status}`);
      return res.ok;
    } catch (err) {
      console.warn('[qBittorrent] torrents/add failed:', err.message);
      return false;
    }
  }

  /**
   * File list for a torrent. Used to map a file's byte offset onto GLOBAL torrent piece indices.
   * Entries expose { index, name, size, priority, piece_range: [first, last] }.
   */
  async getFiles(hash) {
    try {
      const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/files?hash=${hash}`);
      if (!res.ok) return [];
      const files = await res.json();
      return Array.isArray(files) ? files : [];
    } catch {
      return [];
    }
  }

  /**
   * Focus the swarm on the file we are actually streaming: target file at max priority and every
   * other file (samples, extras, subtitles) at 0, so no bandwidth or disk is spent on payload we
   * will never serve. This is the read-ahead lever that qBittorrent actually supports.
   */
  async setFilePriority(hash, fileIndexes, priority) {
    if (!Array.isArray(fileIndexes) || fileIndexes.length === 0) return;
    try {
      const params = new URLSearchParams();
      params.append('hash', hash);
      params.append('id', fileIndexes.join('|'));
      params.append('priority', String(priority));
      await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/filePrio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
    } catch {}
  }

  async getAllTorrents() {
    try {
      const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/info`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /**
   * pieceStates returns one entry per piece for the WHOLE torrent (tens of thousands of ints on a
   * large release). Fetching it per 128 KB chunk saturates the qBittorrent WebUI, so results are
   * cached for `maxAgeMs` and concurrent callers share a single in-flight request.
   */
  async getPieceStates(hash, maxAgeMs = PIECE_STATE_CACHE_MS) {
    const key = String(hash || '').toLowerCase();
    if (!key) return [];

    const now = Date.now();
    const entry = this._pieceCache.get(key);

    if (entry && entry.inflight) return entry.inflight;
    if (entry && (now - entry.at) < maxAgeMs) return entry.states;

    const prevStates = entry ? entry.states : [];

    const inflight = this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/pieceStates?hash=${key}`)
      .then(async (res) => {
        if (!res.ok) return prevStates;
        const states = await res.json();
        return Array.isArray(states) ? states : prevStates;
      })
      .catch(() => prevStates)
      .then((states) => {
        this._pieceCache.set(key, { at: Date.now(), states, inflight: null });
        return states;
      });

    this._pieceCache.set(key, { at: now, states: prevStates, inflight });
    return inflight;
  }

  invalidatePieceCache(hash) {
    this._pieceCache.delete(String(hash || '').toLowerCase());
  }

  /**
   * BEST EFFORT ONLY. qBittorrent's WebUI API v2 documents pieceStates / pieceHashes for reading
   * but no piece-level priority setter, so on most builds this 404s and is a silent no-op. The
   * result is logged once per process so it is visible whether this host supports it. Real
   * read-ahead control comes from sequentialDownload + firstLastPiecePrio + filePrio.
   */
  async setPiecePriority(hash, pieceIndices, priority = 7) {
    if (!pieceIndices || pieceIndices.length === 0) return false;
    if (this._warned.has('piecePriority:unsupported')) return false;
    try {
      const params = new URLSearchParams();
      params.append('hash', hash);
      params.append('pieces', pieceIndices.join('|'));
      params.append('priority', priority.toString());
      const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/piecePriority?${params.toString()}`);
      if (!res.ok) {
        this.warnOnce('piecePriority:unsupported',
          `[qBittorrent] piecePriority returned ${res.status} — this build exposes no piece-level ` +
          `priority API. Using sequential download + firstLastPiecePrio + filePrio instead.`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * qBittorrent 5.x renamed pause/resume to stop/start. Try the modern name first and fall back
   * transparently so the bridge works against both 4.x and 5.x hosts.
   */
  async _transitionTorrents(modernAction, legacyAction, hashes) {
    if (!hashes || hashes.length === 0) return false;
    const body = new URLSearchParams();
    body.append('hashes', Array.isArray(hashes) ? hashes.join('|') : hashes);
    const post = (action) => this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    try {
      let res = await post(modernAction);
      if (res.ok) return true;
      res = await post(legacyAction);
      if (!res.ok) {
        this.warnOnce(`transition:${modernAction}`,
          `[qBittorrent] Neither /${modernAction} nor /${legacyAction} was accepted (status ${res.status}).`);
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  async pauseTorrents(hashes) {
    return this._transitionTorrents('stop', 'pause', hashes);
  }

  async resumeTorrents(hashes) {
    return this._transitionTorrents('start', 'resume', hashes);
  }

  async deleteTorrent(hash, deleteFiles = true) {
    if (!hash) return false;
    try {
      const formData = new URLSearchParams();
      formData.append('hashes', hash);
      formData.append('deleteFiles', deleteFiles ? 'true' : 'false');
      const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async findTorrent(infoHash, nameHint = '', magnet = '') {
    const list = await this.getAllTorrents();
    if (!Array.isArray(list) || list.length === 0) return null;

    if (infoHash) {
      const match = list.find(t =>
        t.hash.toLowerCase() === infoHash.toLowerCase() ||
        (t.magnet_uri && t.magnet_uri.toLowerCase().includes(infoHash.toLowerCase()))
      );
      if (match) return match;
    }

    const dnMatch = magnet ? magnet.match(/[?&]dn=([^&]+)/i) : null;
    const dnName = dnMatch ? decodeURIComponent(dnMatch[1]).toLowerCase() : '';
    const searchTarget = (nameHint || dnName).toLowerCase();

    if (searchTarget) {
      const keywords = searchTarget.split(/[\s.\-_]+/).filter(w => w.length > 2);
      let bestMatch = null;
      let maxScore = 0;

      for (const t of list) {
        const tName = (t.name || '').toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (tName.includes(kw)) score++;
        }
        if (score > maxScore && score >= 2) {
          maxScore = score;
          bestMatch = t;
        }
      }
      if (bestMatch) return bestMatch;
    }

    return null;
  }
}

const qbt = new QBittorrentClient(QBT_URL, QBT_USER, QBT_PASS);

// ----------------- DEFENSIVE MEDIA FILE DISCOVERY & PATH SANITIZATION -----------------

const ALLOWED_MEDIA_EXTS = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.avi', '.ts']);
const FORBIDDEN_EXTS = new Set(['.exe', '.bat', '.scr', '.vbs', '.cmd', '.ps1', '.sh', '.msi', '.iso']);
const MIN_MEDIA_FILE_BYTES = 5 * 1024 * 1024; // 5 MB minimum to ignore junk / samples

// qBittorrent appends ".!qB" to files that are still downloading (Options > Downloads >
// "Append .!qB extension to incomplete files", ON by default). On disk the movie is therefore
// "Movie.mp4.!qB" until it completes -- an extension no media whitelist will ever match.
const INCOMPLETE_SUFFIX_RE = /\.!qB$/i;

function stripIncompleteSuffix(name) {
  return String(name || '').replace(INCOMPLETE_SUFFIX_RE, '');
}

function isSampleName(name) {
  const lower = path.basename(String(name || '')).toLowerCase();
  return lower.includes('sample') || lower.includes('trailer') || lower.includes('featurette');
}

/**
 * Picks the media file to stream from the TORRENT'S OWN FILE TABLE rather than by scanning disk.
 *
 * The table carries final names and final sizes and is valid the instant metadata arrives, so this
 * works before a single byte has been written. Disk scanning could not: it needed the file to
 * already exist, to already be >= 5 MB, and to not be wearing a ".!qB" suffix.
 *
 * Returns { index, name, size } or null.
 */
function selectMediaFileFromTable(files) {
  if (!Array.isArray(files) || files.length === 0) return null;

  let best = null;
  let sampleFallback = null;

  files.forEach((f, i) => {
    const index = typeof f.index === 'number' ? f.index : i;
    const name = stripIncompleteSuffix(f.name || '');
    const ext = path.extname(name).toLowerCase();
    const size = f.size || 0;

    if (FORBIDDEN_EXTS.has(ext)) return;
    if (!ALLOWED_MEDIA_EXTS.has(ext)) return;
    if (size < MIN_MEDIA_FILE_BYTES) return;

    const entry = { index, name, size };

    if (isSampleName(name)) {
      if (!sampleFallback || size > sampleFallback.size) sampleFallback = entry;
      return;
    }
    if (!best || size > best.size) best = entry;
  });

  return best || sampleFallback;
}

/**
 * Finds where a torrent file currently lives on disk.
 *
 * qBittorrent moves and renames files as a torrent progresses, so the same logical file may be at
 * `save_path/name`, at `download_path/name` (the "keep incomplete torrents in" directory), or under
 * `content_path` -- and while incomplete it carries a ".!qB" suffix. Every plausible location is
 * tried, and the winner is checked to be inside a directory qBittorrent itself reported.
 */
function resolveMediaFileOnDisk(torrentInfo, relName) {
  const savePath = torrentInfo.save_path || '';
  const contentPath = torrentInfo.content_path || '';
  const downloadPath = torrentInfo.download_path || '';
  const torrentName = torrentInfo.name || '';
  const baseName = path.basename(relName);

  const candidates = [];
  const push = (candidate) => {
    if (!candidate) return;
    candidates.push(candidate);
    candidates.push(`${candidate}.!qB`);
  };

  if (savePath) push(path.resolve(savePath, relName));
  if (downloadPath) push(path.resolve(downloadPath, relName));

  if (contentPath) {
    // Single-file torrent: content_path IS the file.
    push(contentPath);
    // Multi-file torrent: content_path is the root folder.
    push(path.resolve(contentPath, baseName));
    if (torrentName && relName.startsWith(`${torrentName}/`)) {
      push(path.resolve(contentPath, relName.slice(torrentName.length + 1)));
    }
  }

  const roots = [savePath, downloadPath, contentPath]
    .filter(Boolean)
    .map(r => path.resolve(r));

  // Path traversal guard: never serve anything outside a qBittorrent-declared directory.
  const insideRoot = (resolved) =>
    roots.some(root => resolved === root || resolved.startsWith(root + path.sep));

  // fs.existsSync() returns false for BOTH "no such file" and "permission denied", which made an
  // unreadable download directory look identical to a torrent that had not started writing yet --
  // the bridge told users to "retry in a few seconds" forever. EACCES is captured separately.
  let permissionError = null;

  const tryFile = (resolved) => {
    try {
      return fs.statSync(resolved).isFile();
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') permissionError = err;
      return false;
    }
  };

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!insideRoot(resolved)) continue;
    if (tryFile(resolved)) return { path: resolved, reason: 'found' };
  }

  // Fallback: qBittorrent may have sanitised or renamed the file. Scan the directories it told us
  // about for an entry matching the basename once any ".!qB" suffix is stripped.
  const searchDirs = [];
  if (savePath) searchDirs.push(path.resolve(savePath, path.dirname(relName)));
  if (downloadPath) searchDirs.push(path.resolve(downloadPath, path.dirname(relName)));
  if (contentPath) {
    searchDirs.push(path.resolve(contentPath));
    searchDirs.push(path.dirname(path.resolve(contentPath)));
  }

  const wanted = stripIncompleteSuffix(baseName).toLowerCase();

  for (const dir of searchDirs) {
    if (!insideRoot(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (stripIncompleteSuffix(entry).toLowerCase() !== wanted) continue;
        const full = path.resolve(dir, entry);
        if (insideRoot(full) && tryFile(full)) return { path: full, reason: 'found' };
      }
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') permissionError = err;
    }
  }

  if (permissionError) {
    return {
      path: null,
      reason: 'permission-denied',
      detail: `${permissionError.code} on ${permissionError.path || savePath || contentPath}`
    };
  }

  return { path: null, reason: 'not-created' };
}

/**
 * Maps a media file inside a torrent onto GLOBAL torrent piece indices.
 *
 * This matters because a piece index is relative to the WHOLE torrent, not to one file. Most
 * releases ship the movie alongside subtitles/samples/NFOs, so the video does not start at piece 0.
 * Checking `floor(byteOffset / pieceSize)` (the previous behaviour) therefore verified the WRONG
 * pieces and happily served sparse zero-bytes from a not-yet-downloaded region.
 *
 * Returns { fileIndex, fileOffsetInTorrent, fileSize, otherIndexes, exact }.
 */
function computeFileMapping(files, chosen, pieceSize) {
  const result = {
    fileIndex: chosen.index,
    fileOffsetInTorrent: 0,
    fileSize: chosen.size || 0,
    otherIndexes: [],
    exact: false
  };

  const ordered = files
    .map((f, i) => ({ ...f, index: (typeof f.index === 'number' ? f.index : i) }))
    .sort((a, b) => a.index - b.index);

  let running = 0;
  let match = null;
  let matchOffset = 0;

  for (const f of ordered) {
    if (f.index === chosen.index) {
      match = f;
      matchOffset = running;
    }
    running += (f.size || 0);
  }

  if (!match) return result;

  result.otherIndexes = ordered.filter(f => f.index !== chosen.index).map(f => f.index);

  // Cross-check the summed offset against qBittorrent's own piece_range. If libtorrent hid padding
  // files from the listing the sum is wrong, and trusting it would UNDER-estimate the offset --
  // which resolves to a too-low piece index and reads unverified bytes. So only trust the sum when
  // it agrees with piece_range; otherwise round the offset UP to the next piece boundary, which can
  // only ever make us wait for one extra piece (safe) rather than read a missing one (corrupt).
  const pieceRange = Array.isArray(match.piece_range) ? match.piece_range : null;
  const firstPieceFromRange = pieceRange && typeof pieceRange[0] === 'number' ? pieceRange[0] : null;

  if (firstPieceFromRange === null) {
    result.fileOffsetInTorrent = matchOffset;
    result.exact = true;
  } else if (Math.floor(matchOffset / pieceSize) === firstPieceFromRange) {
    result.fileOffsetInTorrent = matchOffset;
    result.exact = true;
  } else {
    result.fileOffsetInTorrent = (firstPieceFromRange + 1) * pieceSize;
    result.exact = false;
    console.warn(
      `[Piece Mapping] Summed offset ${matchOffset} disagrees with piece_range[0]=${firstPieceFromRange} ` +
      `(likely hidden padding files). Using the conservative offset ${result.fileOffsetInTorrent}.`
    );
  }

  return result;
}

/**
 * Readable stream that only ever emits bytes qBittorrent has VERIFIED on disk.
 *
 * Implemented as a single async pump rather than work inside _read(). The previous version could
 * return from _read() without pushing (when a chunk computed to 0 bytes, or while a check was
 * already in flight), and Node then never called _read() again -- the stream deadlocked and the
 * player sat on "Buffering..." forever. The pump loop always either pushes, ends, or errors.
 */
function createPieceAwareTorrentStream(filePath, infoHash, startByte, endByte, pieceSize, fileOffsetInTorrent = 0) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    const dead = new Readable({ read() {} });
    process.nextTick(() => dead.destroy(err));
    return dead;
  }

  let offset = startByte;
  let closed = false;
  let pumping = false;

  const closeFd = () => {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
      fd = null;
    }
  };

  const stream = new Readable({
    highWaterMark: Math.max(READ_CHUNK_BYTES, 1024 * 1024),
    read() { pump(); },
    destroy(err, callback) {
      closed = true;
      closeFd();
      callback(err);
    }
  });

  async function waitForPiece(globalPiece) {
    const deadline = Date.now() + PIECE_WAIT_TIMEOUT_MS;
    let nudged = false;

    while (!closed && Date.now() < deadline) {
      const states = await qbt.getPieceStates(infoHash);
      if (Array.isArray(states) && states.length > globalPiece && states[globalPiece] === 2) return true;

      if (!nudged) {
        nudged = true;
        // The reader has outrun the download head. Make sure the torrent is actually running --
        // an earlier connection close may have paused it.
        qbt.resumeTorrents([infoHash]).catch(() => {});
        qbt.setPiecePriority(infoHash, [globalPiece, globalPiece + 1, globalPiece + 2], 7).catch(() => {});
      }

      await new Promise(r => setTimeout(r, PIECE_POLL_MS));
    }
    return false;
  }

  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed) {
        if (offset > endByte || fd === null) {
          closed = true;
          closeFd();
          stream.push(null);
          return;
        }

        const globalPiece = Math.floor((fileOffsetInTorrent + offset) / pieceSize);
        const ready = await waitForPiece(globalPiece);
        if (closed) return;

        if (!ready) {
          // Ending the stream silently here would hand the browser a truncated file that looks
          // exactly like the "stuck buffering" symptom. Fail loudly instead.
          closed = true;
          closeFd();
          stream.destroy(new Error(
            `Piece ${globalPiece} was not verified within ${PIECE_WAIT_TIMEOUT_MS}ms (swarm too slow or stalled)`
          ));
          return;
        }

        // Never read past the end of the piece we just verified.
        const pieceEndInFile = ((globalPiece + 1) * pieceSize - 1) - fileOffsetInTorrent;
        const readUntil = Math.min(endByte, pieceEndInFile);
        const bytesToRead = Math.min(READ_CHUNK_BYTES, readUntil - offset + 1);

        if (bytesToRead <= 0) {
          // Defensive: always make forward progress, never spin or stall.
          offset = readUntil + 1;
          continue;
        }

        if (fd === null) continue;
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);

        if (bytesRead <= 0) {
          closed = true;
          closeFd();
          stream.push(null);
          return;
        }

        offset += bytesRead;
        // push() returning false means the consumer is full; _read() resumes the pump on drain.
        if (!stream.push(buffer.subarray(0, bytesRead))) return;
      }
    } catch (err) {
      closed = true;
      closeFd();
      stream.destroy(err);
    } finally {
      pumping = false;
    }
  }

  return stream;
}

/**
 * Parses an RFC 7233 Range header, including open-ended (`bytes=500-`) and suffix (`bytes=-500`)
 * forms that the previous naive split on '-' mis-handled.
 */
function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };

  const rawStart = match[1];
  const rawEnd = match[2];
  if (rawStart === '' && rawEnd === '') return { invalid: true };

  let start;
  let end;

  if (rawStart === '') {
    const suffixLength = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? fileSize - 1 : parseInt(rawEnd, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (end >= fileSize) end = fileSize - 1;
  }

  if (start < 0 || start >= fileSize || start > end) return { unsatisfiable: true };
  return { start, end };
}

/**
 * Serves a byte range for a torrent file over HTTP 206/200, backed by verified pieces only.
 * Shared by the public /api/stream endpoint and the loopback /internal/piece-file endpoint
 * that FFmpeg reads from.
 */
function servePieceAwareRange(req, res, ctx) {
  const { filePath, hash, pieceSize, fileOffsetInTorrent, fileSize, contentType } = ctx;
  const onRelease = typeof ctx.onRelease === 'function' ? ctx.onRelease : () => {};

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    onRelease();
  };

  const range = parseRangeHeader(req.headers.range, fileSize);

  if (range && range.invalid) {
    res.status(400).end();
    release();
    return;
  }

  if (range && range.unsatisfiable) {
    res.writeHead(416, {
      'Content-Range': `bytes */${fileSize}`,
      'Accept-Ranges': 'bytes'
    });
    res.end();
    release();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : fileSize - 1;
  const chunkSize = (end - start) + 1;

  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;

  res.writeHead(range ? 206 : 200, headers);

  // A HEAD probe just wants the headers; opening a piece-aware reader for it would block on the swarm.
  if (req.method === 'HEAD') {
    res.end();
    release();
    return;
  }

  const stream = createPieceAwareTorrentStream(filePath, hash, start, end, pieceSize, fileOffsetInTorrent);

  stream.on('error', (err) => {
    console.warn(`[Piece Stream] ${err.message}`);
    res.destroy();
    release();
  });

  res.on('close', () => {
    stream.destroy();
    release();
  });

  stream.pipe(res);
}

/**
 * Runs ffprobe and returns the parsed JSON, or null. Probing over the loopback piece-aware URL
 * (rather than the raw path) means ffprobe can SEEK, so it can reach a `moov` atom parked at the
 * end of the file -- the exact case that made piped FFmpeg hang forever.
 */
function probeMedia(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      '-analyzeduration', '10M', '-probesize', '10M',
      url
    ];

    let proc;
    try {
      proc = spawn(FFPROBE_BIN, args);
    } catch {
      return resolve(null);
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`[ffprobe] could not run "${FFPROBE_BIN}": ${err.message}`);
      resolve(null);
    });

    proc.on('close', () => {
      clearTimeout(timer);
      if (stderr.trim()) console.warn('[ffprobe]', stderr.trim().split('\n')[0]);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

function summarizeProbe(probe) {
  if (!probe || !Array.isArray(probe.streams)) return null;

  const video = probe.streams.find(st => st.codec_type === 'video' && st.disposition && st.disposition.attached_pic !== 1)
    || probe.streams.find(st => st.codec_type === 'video');
  const audio = probe.streams.find(st => st.codec_type === 'audio');
  const rawDuration = probe.format && probe.format.duration ? parseFloat(probe.format.duration) : 0;

  return {
    durationSec: Number.isFinite(rawDuration) ? rawDuration : 0,
    formatName: (probe.format && probe.format.format_name) || '',
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    audioChannels: audio ? (audio.channels || 0) : 0
  };
}

/**
 * Chooses how to deliver this file. Direct HTTP 206 is always preferred -- it gives the browser
 * native seeking and zero CPU cost -- but only when the container AND both codecs are decodable by
 * an HTML5 <video>. Otherwise FFmpeg remuxes into progressive fragmented MP4.
 */
function decideStreamMode(summary, ext) {
  const containerOk = BROWSER_SAFE_CONTAINERS.has(ext);

  if (!summary) {
    return {
      mode: containerOk ? 'direct' : 'remux',
      reason: 'ffprobe unavailable — falling back on container extension',
      copyVideo: true,
      copyAudio: false
    };
  }

  const videoOk = summary.videoCodec === null || BROWSER_SAFE_VIDEO.has(summary.videoCodec);
  const audioOk = summary.audioCodec === null || BROWSER_SAFE_AUDIO.has(summary.audioCodec);
  const audioChannelsOk = summary.audioChannels <= 2;

  if (containerOk && videoOk && audioOk && audioChannelsOk) {
    return { mode: 'direct', reason: 'browser-native container and codecs', copyVideo: true, copyAudio: true };
  }

  const reasons = [];
  if (!containerOk) reasons.push(`container ${ext || 'unknown'}`);
  if (!videoOk) reasons.push(`video ${summary.videoCodec}`);
  if (!audioOk) reasons.push(`audio ${summary.audioCodec}`);
  else if (!audioChannelsOk) reasons.push(`audio ${summary.audioCodec} ${summary.audioChannels}ch`);

  return {
    mode: 'remux',
    reason: reasons.join(', '),
    copyVideo: videoOk,
    copyAudio: audioOk && audioChannelsOk
  };
}

/**
 * True while any playback session for this torrent has sent a heartbeat recently.
 */
function hasFreshSession(infoHash, maxAgeMs = HEARTBEAT_FRESH_MS) {
  const hash = String(infoHash || '').toLowerCase();
  const now = Date.now();
  for (const sess of playbackSessions.values()) {
    if (String(sess.infoHash || '').toLowerCase() === hash && (now - sess.lastSeen) < maxAgeMs) return true;
  }
  return false;
}

/**
 * Releases one connection reference on a torrent.
 *
 * A browser opens, abandons and re-opens many short-lived HTTP connections during a single video
 * (every seek, every re-buffer). The previous implementation paused the torrent in qBittorrent on
 * EVERY connection close, so the download was being halted constantly while the user was still
 * watching -- the reader then outran the download head and the player stalled.
 *
 * Now a close only starts a grace timer. The torrent is paused solely if, after the grace window,
 * there is still no open connection AND no fresh heartbeat. Deletion stays with the Auto-GC sweep.
 */
function releaseTorrentReference(infoHash, torrentName) {
  const hash = String(infoHash || '').toLowerCase();
  if (!hash) return;

  const entry = torrentRegistry.get(hash);
  if (!entry) return;

  entry.refCount = Math.max(0, entry.refCount - 1);
  entry.lastActive = Date.now();

  if (entry.cleanTimer) {
    clearTimeout(entry.cleanTimer);
    entry.cleanTimer = null;
  }

  if (entry.refCount > 0) return;

  armIdlePauseTimer(hash, torrentName);
}

/**
 * Arms (or re-arms) the deferred pause check for a torrent with no open connections.
 *
 * The check RE-ARMS itself while a heartbeat is still fresh. A paused-but-open player keeps
 * heart-beating with no HTTP connection, and without re-arming that first blocked check was the
 * only one that ever ran — the torrent then downloaded forever, never pausing.
 */
function armIdlePauseTimer(hash, torrentName) {
  const entry = torrentRegistry.get(hash);
  if (!entry) return;

  if (entry.cleanTimer) clearTimeout(entry.cleanTimer);

  entry.cleanTimer = setTimeout(async () => {
    const current = torrentRegistry.get(hash);
    if (!current) return;
    current.cleanTimer = null;

    // A new connection took over; the next release() will re-arm.
    if (current.refCount > 0) return;

    // Still being watched (player open, possibly paused) — check again next window.
    if (hasFreshSession(hash)) {
      armIdlePauseTimer(hash, torrentName);
      return;
    }

    console.log(
      `[Bandwidth Saver] No connections or heartbeats for ${Math.round(STREAM_IDLE_GRACE_MS / 1000)}s ` +
      `— pausing "${torrentName}" (${hash})`
    );
    await qbt.pauseTorrents([hash]).catch(() => {});
  }, STREAM_IDLE_GRACE_MS);
}

/**
 * Get disk usage statistics
 */
function getDiskUsageStats(targetDir = '/') {
  try {
    if (fs.statfsSync) {
      const stats = fs.statfsSync(targetDir);
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const usedPct = Math.round(((total - free) / total) * 100);
      return {
        usedPct,
        totalGb: (total / (1024 * 1024 * 1024)).toFixed(1),
        freeGb: (free / (1024 * 1024 * 1024)).toFixed(1)
      };
    }
  } catch {}
  return { usedPct: 30, totalGb: '100.0', freeGb: '70.0' };
}

// ----------------- SYSTEM STATE & SESSION REGISTRY -----------------

// Playback Sessions: sessionId -> { id, infoHash, lastSeen, currentTime, ip }
const playbackSessions = new Map();

// Torrent Registry: infoHash -> { hash, name, refCount, lastActive, cleanTimer }
const torrentRegistry = new Map();

// IP Rate Limiting Map: ip -> { searchCount, searchReset, streamCount, streamReset }
const rateLimitMap = new Map();

// Loopback capability tokens handed to FFmpeg/ffprobe: token -> { filePath, hash, ..., expiresAt }
// FFmpeg reads the file over HTTP rather than off disk so it can SEEK (see /internal/piece-file).
const internalStreamTokens = new Map();
const internalTokenByFile = new Map(); // `${hash}:${filePath}` -> token (so tokens are reused)

// ffprobe results: `${hash}:${filePath}` -> { at, summary }
const probeCache = new Map();

// Resolved stream descriptors: `${infoHash}` -> { at, prep, inflight }.
// A <video> element fires many range requests per file, and re-resolving swarm metadata (list all
// torrents, poll for the media file, fetch the file table, re-apply file priorities) on every one
// of them floods the qBittorrent WebUI. Resolution is done once and shared.
const preparedStreamCache = new Map();
const PREPARED_CACHE_MS = parseInt(process.env.PREPARED_CACHE_MS || '60000', 10);

// hash -> expiresAt. A stream spends up to ~25s waiting on swarm metadata before it can take a
// reference, and Auto-GC would happily delete the torrent inside that window. Reservations close
// that race.
const torrentReservations = new Map();

function reserveTorrent(infoHash, ttlMs = 90000) {
  const hash = String(infoHash || '').toLowerCase();
  if (!hash) return () => {};
  torrentReservations.set(hash, Date.now() + ttlMs);
  // Releasing shortens the reservation rather than dropping it, so the brief handoff between
  // setup finishing and the caller taking its refCount is still covered.
  return () => {
    const shortened = Date.now() + 15000;
    const current = torrentReservations.get(hash);
    if (current === undefined || current > shortened) torrentReservations.set(hash, shortened);
  };
}

function isReserved(infoHash) {
  const hash = String(infoHash || '').toLowerCase();
  const expiry = torrentReservations.get(hash);
  if (expiry === undefined) return false;
  if (expiry < Date.now()) {
    torrentReservations.delete(hash);
    return false;
  }
  return true;
}

const INTERNAL_BASE_URL = `http://127.0.0.1:${PORT}`;

function mintInternalToken(descriptor, ttlMs = 8 * 60 * 60 * 1000) {
  const fileKey = `${descriptor.hash}:${descriptor.filePath}`;
  const existing = internalTokenByFile.get(fileKey);
  const existingDesc = existing ? internalStreamTokens.get(existing) : null;

  if (existingDesc && existingDesc.expiresAt > Date.now() + 60000) {
    Object.assign(existingDesc, descriptor);
    return existing;
  }

  const token = crypto.randomBytes(24).toString('hex');
  internalStreamTokens.set(token, { ...descriptor, expiresAt: Date.now() + ttlMs });
  internalTokenByFile.set(fileKey, token);
  return token;
}

function internalUrlFor(token) {
  return `${INTERNAL_BASE_URL}/internal/piece-file?token=${token}`;
}

/**
 * ffprobe the file once per torrent/file and cache it. Concurrent callers share one probe.
 */
async function getProbeSummary(hash, filePath, token) {
  const key = `${hash}:${filePath}`;
  const cached = probeCache.get(key);
  if (cached && cached.inflight) return cached.inflight;
  if (cached) return cached.summary;

  const inflight = probeMedia(internalUrlFor(token))
    .then((probe) => {
      const summary = summarizeProbe(probe);
      probeCache.set(key, { at: Date.now(), summary, inflight: null });
      return summary;
    })
    .catch(() => {
      probeCache.set(key, { at: Date.now(), summary: null, inflight: null });
      return null;
    });

  probeCache.set(key, { at: Date.now(), summary: null, inflight });
  return inflight;
}

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Accept', 'X-Requested-With', 'Authorization', 'X-Api-Key', 'X-Session-ID', 'X-Admin-Token'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type', 'X-Piece-Available', 'X-Piece-Index']
}));

import authRouter from './routes/auth.js';
import userDataRouter from './routes/userData.js';

app.use(express.json());

// ----------------- ROUTE MOUNTS -----------------
app.use('/api/auth', authRouter);
app.use('/api/user', userDataRouter);

// ----------------- RATE LIMITING MIDDLEWARE -----------------

function checkRateLimit(type = 'search', limit = 30, windowMs = 60000) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    if (!rateLimitMap.has(ip)) {
      rateLimitMap.set(ip, {
        searchCount: 0,
        searchReset: now + windowMs,
        streamCount: 0,
        streamReset: now + windowMs
      });
    }

    const tracker = rateLimitMap.get(ip);
    const countKey = `${type}Count`;
    const resetKey = `${type}Reset`;

    if (now > tracker[resetKey]) {
      tracker[countKey] = 0;
      tracker[resetKey] = now + windowMs;
    }

    tracker[countKey]++;

    if (tracker[countKey] > limit) {
      return res.status(429).json({
        error: `Rate limit exceeded for ${type}. Max ${limit} requests per minute.`,
        retryAfterMs: tracker[resetKey] - now
      });
    }

    next();
  };
}

// ----------------- AUTOMATED IDLE GARBAGE COLLECTOR -----------------

/**
 * Drops cached state belonging to a torrent that no longer exists on disk.
 */
function purgeTorrentCaches(hash) {
  torrentRegistry.delete(hash);
  torrentReservations.delete(hash);
  qbt.invalidatePieceCache(hash);

  for (const [key, entry] of preparedStreamCache) {
    if (key === hash || (entry.prep && entry.prep.matchedHash === hash)) {
      preparedStreamCache.delete(key);
    }
  }

  for (const [key] of probeCache) {
    if (key.startsWith(`${hash}:`)) probeCache.delete(key);
  }
  for (const [fileKey, token] of internalTokenByFile) {
    if (fileKey.startsWith(`${hash}:`)) {
      internalStreamTokens.delete(token);
      internalTokenByFile.delete(fileKey);
    }
  }
}

setInterval(async () => {
  try {
    const now = Date.now();

    // Expire loopback capability tokens.
    for (const [token, desc] of internalStreamTokens) {
      if (desc.expiresAt < now) {
        internalStreamTokens.delete(token);
        internalTokenByFile.delete(`${desc.hash}:${desc.filePath}`);
      }
    }

    // Drop playback sessions nobody is heart-beating any more.
    for (const [id, sess] of playbackSessions) {
      if ((now - sess.lastSeen) > (HEARTBEAT_FRESH_MS * 3)) playbackSessions.delete(id);
    }

    const diskStats = getDiskUsageStats();

    const isLogged = await qbt.login();
    if (!isLogged) return;

    const allTorrents = await qbt.getAllTorrents();
    if (!Array.isArray(allTorrents)) return;

    const liveHashes = new Set(allTorrents.map(t => t.hash.toLowerCase()));
    for (const hash of [...torrentRegistry.keys()]) {
      if (!liveHashes.has(hash)) purgeTorrentCaches(hash);
    }

    for (const t of allTorrents) {
      const hash = t.hash.toLowerCase();

      let entry = torrentRegistry.get(hash);
      if (!entry) {
        // Start the idle clock NOW, not at the torrent's original added_on.
        //
        // torrentRegistry lives in memory, so after any restart every existing torrent is unknown.
        // Back-dating to added_on made them all instantly older than IDLE_TTL, so the first sweep
        // 15s after boot deleted every torrent AND its downloaded data — a full re-download on
        // every deploy, and a stream that was mid-resolution lost the files underneath it.
        entry = { hash, name: t.name, refCount: 0, lastActive: now, cleanTimer: null };
        torrentRegistry.set(hash, entry);
        console.log(`[Auto-GC] Now tracking pre-existing torrent "${t.name}" (idle timer starts now)`);
      }

      // In use if a connection holds a reference, a player is heart-beating, or a stream is
      // still resolving swarm metadata for it.
      if (entry.refCount > 0 || hasFreshSession(hash) || isReserved(hash)) {
        entry.lastActive = now;
        continue;
      }

      const isIdleExpired = (now - entry.lastActive) >= IDLE_TTL_MS;
      const isEmergency = diskStats.usedPct >= 88;

      if (isIdleExpired || isEmergency) {
        console.log(
          `[Auto-GC] Deleting idle torrent and its files: "${t.name}" ` +
          `(${isEmergency ? `disk pressure ${diskStats.usedPct}%` : `idle ${IDLE_TTL_MINUTES}m`})`
        );
        if (entry.cleanTimer) clearTimeout(entry.cleanTimer);
        await qbt.deleteTorrent(t.hash, true).catch(() => {});
        purgeTorrentCaches(hash);
      }
    }
  } catch (err) {
    console.warn('[Auto-GC Warning]:', err.message);
  }
}, 15000);

// ----------------- LOOPBACK PIECE-AWARE FILE ENDPOINT (FFmpeg input) -----------------

/**
 * Serves the torrent file to FFmpeg/ffprobe over loopback HTTP with full Range support.
 *
 * This exists to fix the central bug in the old remuxer: it piped bytes into `ffmpeg -i pipe:0`,
 * and a pipe is NOT seekable. A standard .mp4 release keeps its `moov` index atom at the END of the
 * file, so a non-seekable FFmpeg had to read the entire multi-gigabyte file before it could emit a
 * single frame — which is exactly why the player sat on "Buffering Stream..." forever.
 *
 * Over HTTP, FFmpeg issues a Range request, jumps straight to `moov`, and starts muxing in seconds.
 * Every byte served is still piece-verified, so it never sees sparse zeros.
 *
 * Access is restricted to loopback: these tokens map to absolute paths on disk.
 */
app.get('/internal/piece-file', (req, res) => {
  const remote = req.socket.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLoopback) {
    return res.status(403).end('Loopback access only');
  }

  const token = String(req.query.token || '');
  const desc = internalStreamTokens.get(token);
  if (!desc || desc.expiresAt < Date.now()) {
    return res.status(404).end('Unknown or expired internal stream token');
  }

  servePieceAwareRange(req, res, {
    filePath: desc.filePath,
    hash: desc.hash,
    pieceSize: desc.pieceSize,
    fileOffsetInTorrent: desc.fileOffsetInTorrent,
    fileSize: desc.fileSize,
    contentType: 'application/octet-stream'
  });
});

// ----------------- PRIMARY STREAMING ENDPOINT -----------------

/**
 * Resolves a magnet into a verified, streamable media file on disk.
 * Returns { ok: true, ... } or { ok: false, status, message }.
 */
async function prepareTorrentStream(magnet, nameHint) {
  const infoHash = qbt.extractInfoHash(magnet);
  const key = infoHash || magnet;

  const cached = preparedStreamCache.get(key);
  if (cached) {
    // Concurrent range requests for the same file share one resolution.
    if (cached.inflight) return cached.inflight;

    const isFresh = (Date.now() - cached.at) < PREPARED_CACHE_MS;
    // Auto-GC may have deleted the files since, so re-validate before trusting the entry.
    if (isFresh && cached.prep && cached.prep.ok && fs.existsSync(cached.prep.targetFilePath)) {
      return cached.prep;
    }
    preparedStreamCache.delete(key);
  }

  const releaseReservation = reserveTorrent(infoHash);

  const inflight = prepareTorrentStreamInner(magnet, nameHint, infoHash)
    .then((prep) => {
      // Only cache success — a failure (no seeders yet, no media file yet) must be retried.
      if (prep && prep.ok) {
        preparedStreamCache.set(key, { at: Date.now(), prep, inflight: null });
      } else {
        preparedStreamCache.delete(key);
      }
      return prep;
    })
    .catch((err) => {
      preparedStreamCache.delete(key);
      throw err;
    })
    .finally(() => releaseReservation());

  preparedStreamCache.set(key, { at: Date.now(), prep: null, inflight });
  return inflight;
}

async function prepareTorrentStreamInner(magnet, nameHint, infoHash) {

  // Respect the active-torrent cap, but never reject a torrent that is already loaded.
  const existing = await qbt.getAllTorrents();
  const alreadyPresent = Array.isArray(existing) && existing.some(t =>
    infoHash && t.hash && t.hash.toLowerCase() === infoHash.toLowerCase());

  if (!alreadyPresent && Array.isArray(existing) && existing.length >= MAX_ACTIVE_TORRENTS) {
    return {
      ok: false,
      status: 503,
      message: `Bridge is at its ${MAX_ACTIVE_TORRENTS}-torrent limit. Close another stream and retry.`
    };
  }

  await qbt.addTorrent(magnet);

  // Poll for metadata, then for the chosen file to appear on disk.
  //
  // Selection is driven by the torrent's FILE TABLE, not by scanning the disk. The table has final
  // names and sizes as soon as metadata lands, whereas on disk the movie is still "Movie.mp4.!qB"
  // (qBittorrent's incomplete-file suffix) and may be zero bytes or in a different directory
  // entirely -- which is why disk scanning reported "no playable media file" on healthy torrents.
  let torrentInfo = null;
  let files = [];
  let chosen = null;
  let targetFilePath = null;

  let resumeAttempted = false;
  let lastResolution = null;

  for (let i = 0; i < 30; i++) {
    torrentInfo = await qbt.findTorrent(infoHash, nameHint, magnet);

    if (torrentInfo) {
      const hash = (torrentInfo.hash || infoHash || '').toLowerCase();
      const state = String(torrentInfo.state || 'unknown');

      // A paused torrent will never write a byte, so polling for its files just times out.
      // Nothing else resumes it at this point: /api/stream resumes only AFTER this function
      // returns, and /api/stream/prepare never did at all — so a torrent the Bandwidth Saver or a
      // previous session had paused could never be restarted, and every retry timed out the same way.
      // torrents/add does not resume an existing paused torrent either.
      if (!resumeAttempted && (/^(paused|stopped)/i.test(state) || state === 'queuedDL')) {
        resumeAttempted = true;
        console.log(`[Resolve] "${torrentInfo.name}" was ${state} — resuming it.`);
        await qbt.resumeTorrents([hash]);
      }

      if (state === 'missingFiles') {
        return {
          ok: false,
          status: 503,
          message:
            'qBittorrent reports missing files for this torrent — its data was deleted underneath it. ' +
            'Remove it from qBittorrent and start the stream again.'
        };
      }

      files = await qbt.getFiles(hash);
      chosen = selectMediaFileFromTable(files);

      if (chosen) {
        lastResolution = resolveMediaFileOnDisk(torrentInfo, chosen.name);
        targetFilePath = lastResolution.path;
        if (targetFilePath) break;
        // No amount of waiting fixes a permissions problem.
        if (lastResolution.reason === 'permission-denied') break;
      } else if (files.length > 0) {
        // Metadata is complete and genuinely contains no streamable media — polling will not help.
        break;
      }
    }

    await new Promise(r => setTimeout(r, 800));
  }

  if (!torrentInfo) {
    return {
      ok: false,
      status: 503,
      message: 'Timed out waiting for torrent metadata from the swarm. The release may have no seeders.'
    };
  }

  if (!chosen) {
    const listed = files.length
      ? files.slice(0, 5).map(f => path.basename(f.name || '')).join(', ')
      : 'none reported';
    console.warn(`[Media Select] No streamable file in "${torrentInfo.name}". Files: ${listed}`);
    return {
      ok: false,
      status: 415,
      message:
        `This torrent contains no streamable video file (looked for ` +
        `${[...ALLOWED_MEDIA_EXTS].join(', ')} of at least 5 MB). It may be an archive or disc image release.`
    };
  }

  if (!targetFilePath && lastResolution && lastResolution.reason === 'permission-denied') {
    const runAs = (() => { try { return os.userInfo().username; } catch { return 'the bridge user'; } })();
    const dir = torrentInfo.save_path || torrentInfo.content_path || 'the download directory';
    console.error(
      `[Resolve] Permission denied reading qBittorrent's downloads (${lastResolution.detail}). ` +
      `Bridge runs as "${runAs}".`
    );
    return {
      ok: false,
      status: 500,
      message:
        `The bridge cannot read qBittorrent's download directory (${lastResolution.detail}). ` +
        `It runs as "${runAs}", which needs read access to the files and execute (traverse) ` +
        `permission on ${dir} and every directory above it. ` +
        `Typically: add "${runAs}" to qBittorrent's group and make the download directory group-readable.`
    };
  }

  if (!targetFilePath) {
    // Report the swarm state rather than a generic "retry" — this is the difference between
    // "no peers have this release" and "it is downloading, just be patient".
    const seeds = torrentInfo.num_seeds !== undefined ? torrentInfo.num_seeds : '?';
    const peers = torrentInfo.num_leechs !== undefined ? torrentInfo.num_leechs : '?';
    const diag =
      `state=${torrentInfo.state} progress=${((torrentInfo.progress || 0) * 100).toFixed(1)}% ` +
      `seeds=${seeds} peers=${peers} dl=${((torrentInfo.dlspeed || 0) / 1024).toFixed(0)}KB/s`;

    console.warn(`[Resolve] "${chosen.name}" still absent from disk — ${diag} (save_path=${torrentInfo.save_path})`);

    return {
      ok: false,
      status: 503,
      message:
        `qBittorrent has not written "${path.basename(chosen.name)}" to disk yet (${diag}). ` +
        (seeds === 0
          ? 'No seeders have this release — pick a different source.'
          : 'It is still connecting to the swarm — retry in a few seconds.')
    };
  }

  const matchedHash = (torrentInfo.hash || infoHash || '').toLowerCase();
  reserveTorrent(matchedHash);
  const pieceSize = torrentInfo.piece_size || 2 * 1024 * 1024;

  const mapping = computeFileMapping(files, chosen, pieceSize);

  console.log(
    `[Media Select] "${torrentInfo.name}" -> ${path.basename(chosen.name)} ` +
    `(${(chosen.size / 1048576).toFixed(1)} MB, file #${chosen.index}, ` +
    `offset ${mapping.fileOffsetInTorrent}${mapping.exact ? '' : ' approx'}) at ${targetFilePath}`
  );

  // Spend swarm bandwidth and disk only on the file we are actually serving.
  if (mapping.fileIndex !== null) {
    await qbt.setFilePriority(matchedHash, [mapping.fileIndex], 7);
    if (mapping.otherIndexes.length > 0) {
      await qbt.setFilePriority(matchedHash, mapping.otherIndexes, 0);
    }
  }

  // The torrent's declared file size is authoritative. stat().size is wrong on a sparse,
  // not-yet-preallocated file, and a wrong Content-Length hands the browser a truncated video.
  let fileSize = mapping.fileSize;
  if (!fileSize) {
    try { fileSize = fs.statSync(targetFilePath).size; } catch { fileSize = 0; }
  }

  if (!fileSize) {
    return { ok: false, status: 503, message: 'Could not determine media file size yet. Retry shortly.' };
  }

  const token = mintInternalToken({
    hash: matchedHash,
    filePath: targetFilePath,
    pieceSize,
    fileOffsetInTorrent: mapping.fileOffsetInTorrent,
    fileSize
  });

  return {
    ok: true,
    torrentInfo,
    torrentName: torrentInfo.name || nameHint || 'Media Stream',
    matchedHash,
    targetFilePath,
    // The LOGICAL name, i.e. with any ".!qB" incomplete-suffix removed. Container decisions and
    // anything user-facing must use this: the on-disk path of a still-downloading MP4 ends in
    // ".!qB", whose extension matches no container and would force a pointless FFmpeg remux.
    mediaName: chosen.name,
    mediaExt: path.extname(chosen.name).toLowerCase(),
    pieceSize,
    fileSize,
    fileOffsetInTorrent: mapping.fileOffsetInTorrent,
    token
  };
}

/**
 * Resolve-and-describe endpoint. The client calls this BEFORE pointing <video> at a stream.
 *
 * An HTML5 <video> reports failures as an opaque MEDIA_ERR_* code and never exposes the HTTP status
 * or body, so "no seeders", "unsupported codec" and "disk full" were all indistinguishable to the
 * player — it just sat on "Buffering Stream..." forever. This endpoint answers the same questions
 * in JSON so the UI can say what is actually wrong and what to do about it.
 */
app.get('/api/stream/prepare', checkRateLimit('stream', STREAM_RATE_LIMIT_PER_MIN, 60000), async (req, res) => {
  const magnet = req.query.magnet || req.query.link;
  const nameHint = req.query.title || '';

  if (!magnet) {
    return res.status(400).json({ ok: false, error: 'Missing magnet link parameter' });
  }

  const diskStats = getDiskUsageStats();
  if (diskStats.usedPct >= DISK_MAX_USAGE_PCT) {
    return res.status(507).json({
      ok: false,
      code: 'DISK_FULL',
      error: `VPS disk usage is at ${diskStats.usedPct}%. New streams are throttled until space is reclaimed.`
    });
  }

  try {
    const prep = await prepareTorrentStream(magnet, nameHint);
    if (!prep.ok) {
      return res.status(prep.status).json({ ok: false, code: 'NO_MEDIA', error: prep.message });
    }

    const ext = prep.mediaExt;
    const summary = await getProbeSummary(prep.matchedHash, prep.targetFilePath, prep.token);
    const decision = decideStreamMode(summary, ext);

    if (!decision.copyVideo && !ALLOW_VIDEO_TRANSCODE) {
      return res.status(415).json({
        ok: false,
        code: 'UNSUPPORTED_VIDEO_CODEC',
        videoCodec: summary ? summary.videoCodec : null,
        error:
          `This release is encoded with ${summary ? summary.videoCodec : 'an unsupported codec'}, which ` +
          `browsers cannot decode. Choose an H.264 / x264 release instead.`
      });
    }

    if (decision.mode === 'remux' && !toolchain.ffmpeg) {
      return res.status(503).json({
        ok: false,
        code: 'FFMPEG_MISSING',
        error:
          `This release needs remuxing (${decision.reason}) but FFmpeg is not installed on the bridge. ` +
          `Run "sudo apt install -y ffmpeg", or pick an MP4 / H.264 / AAC release.`
      });
    }

    res.json({
      ok: true,
      mode: decision.mode,
      reason: decision.reason,
      infoHash: prep.matchedHash,
      torrentName: prep.torrentName,
      fileName: path.basename(prep.mediaName),
      fileSizeBytes: prep.fileSize,
      durationSec: summary && summary.durationSec ? Math.round(summary.durationSec) : 0,
      seekable: decision.mode === 'direct',
      video: {
        codec: summary ? summary.videoCodec : null,
        browserSafe: decision.copyVideo
      },
      audio: {
        codec: summary ? summary.audioCodec : null,
        channels: summary ? summary.audioChannels : 0,
        browserSafe: decision.copyAudio,
        willTranscode: decision.mode === 'remux' && !decision.copyAudio
      },
      probed: Boolean(summary)
    });
  } catch (err) {
    console.error('[Prepare Error]', err);
    res.status(500).json({ ok: false, error: `Streaming bridge error: ${err.message}` });
  }
});

/**
 * Piece-Aware Progressive BitTorrent Stream.
 *
 * Two delivery modes, chosen automatically from an ffprobe of the real file:
 *  - direct : HTTP 206 byte ranges straight from verified pieces. Native browser seeking, no CPU.
 *  - remux  : FFmpeg reads the same piece-verified bytes over a SEEKABLE loopback URL and emits
 *             progressive fragmented MP4 with stereo AAC audio.
 * Override with ?mode=direct|remux.
 */
app.get('/api/stream', checkRateLimit('stream', STREAM_RATE_LIMIT_PER_MIN, 60000), async (req, res) => {
  const magnet = req.query.magnet || req.query.link;
  const nameHint = req.query.title || '';
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || `sess_${Date.now()}`;
  const startSec = Math.max(0, parseInt(req.query.startSec || '0', 10));

  // Backwards compatible with the old ?remux=1 flag.
  let requestedMode = String(req.query.mode || '').toLowerCase();
  if (!requestedMode && (req.query.remux === '1' || req.query.remux === 'true')) requestedMode = 'remux';
  if (!requestedMode && (req.query.direct === '1' || req.query.direct === 'true')) requestedMode = 'direct';

  if (!magnet) {
    return res.status(400).json({ error: 'Missing magnet link parameter' });
  }

  const diskStats = getDiskUsageStats();
  if (diskStats.usedPct >= DISK_MAX_USAGE_PCT) {
    return res.status(507).json({
      error: `VPS disk usage is at ${diskStats.usedPct}%. New streams are throttled until space is reclaimed.`
    });
  }

  if (playbackSessions.size >= MAX_CONCURRENT_STREAMS && !playbackSessions.has(sessionId)) {
    return res.status(503).json({
      error: `Bridge is at its ${MAX_CONCURRENT_STREAMS}-stream capacity. Try again shortly.`
    });
  }

  let registered = null;

  try {
    const prep = await prepareTorrentStream(magnet, nameHint);
    if (!prep.ok) {
      return res.status(prep.status).json({ error: prep.message });
    }

    const { torrentName, matchedHash, targetFilePath, pieceSize, fileSize, fileOffsetInTorrent, token } = prep;

    // Register the connection BEFORE any slow work so Auto-GC cannot delete it mid-setup.
    if (!torrentRegistry.has(matchedHash)) {
      torrentRegistry.set(matchedHash, {
        hash: matchedHash,
        name: torrentName,
        refCount: 0,
        lastActive: Date.now(),
        cleanTimer: null
      });
    }

    const regEntry = torrentRegistry.get(matchedHash);
    regEntry.refCount++;
    regEntry.lastActive = Date.now();
    regEntry.name = torrentName;
    if (regEntry.cleanTimer) {
      clearTimeout(regEntry.cleanTimer);
      regEntry.cleanTimer = null;
    }
    registered = { hash: matchedHash, name: torrentName };

    await qbt.resumeTorrents([matchedHash]).catch(() => {});

    playbackSessions.set(sessionId, {
      id: sessionId,
      infoHash: matchedHash,
      lastSeen: Date.now(),
      currentTime: startSec,
      ip: req.ip
    });

    // Decide how to deliver this specific file, from its LOGICAL extension.
    const ext = prep.mediaExt;
    const summary = await getProbeSummary(matchedHash, targetFilePath, token);
    const auto = decideStreamMode(summary, ext);
    const mode = (requestedMode === 'direct' || requestedMode === 'remux') ? requestedMode : auto.mode;

    if (summary) {
      console.log(
        `[Probe] "${torrentName}" ${ext} video=${summary.videoCodec} audio=${summary.audioCodec}` +
        `/${summary.audioChannels}ch duration=${Math.round(summary.durationSec)}s -> ${mode} (${auto.reason})`
      );
    } else {
      console.log(`[Probe] "${torrentName}" ${ext} probe unavailable -> ${mode} (${auto.reason})`);
    }

    const release = () => {
      playbackSessions.delete(sessionId);
      releaseTorrentReference(matchedHash, torrentName);
      registered = null;
    };

    if (mode === 'direct') {
      const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';
      console.log(
        `[Direct 206] "${torrentName}" range=${req.headers.range || 'none'} size=${(fileSize / 1048576).toFixed(1)} MB`
      );

      servePieceAwareRange(req, res, {
        filePath: targetFilePath,
        hash: matchedHash,
        pieceSize,
        fileOffsetInTorrent,
        fileSize,
        contentType,
        onRelease: release
      });
      return;
    }

    // ---- FFmpeg remux path ----
    if (!auto.copyVideo && !ALLOW_VIDEO_TRANSCODE) {
      release();
      return res.status(415).json({
        error:
          `This release uses ${summary ? summary.videoCodec : 'an unsupported'} video, which browsers cannot ` +
          `decode. Pick an H.264 / x264 release, or start the bridge with ALLOW_VIDEO_TRANSCODE=1 ` +
          `(CPU-intensive real-time re-encoding).`,
        code: 'UNSUPPORTED_VIDEO_CODEC',
        videoCodec: summary ? summary.videoCodec : null
      });
    }

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-seekable', '1',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '10'
    ];

    // Input seeking: accurate, cheap, and unlike the old byte-offset hack it lands on a keyframe
    // with the container header intact.
    if (startSec > 0) ffmpegArgs.push('-ss', String(startSec));

    ffmpegArgs.push('-i', internalUrlFor(token));
    ffmpegArgs.push('-map', '0:v:0?', '-map', '0:a:0?');

    if (auto.copyVideo) {
      ffmpegArgs.push('-c:v', 'copy');
    } else {
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    }

    if (auto.copyAudio) {
      ffmpegArgs.push('-c:a', 'copy');
    } else {
      ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    }

    ffmpegArgs.push(
      '-max_muxing_queue_size', '1024',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );

    console.log(
      `[Remux] "${torrentName}" start=${startSec}s video=${auto.copyVideo ? 'copy' : 'libx264'} ` +
      `audio=${auto.copyAudio ? 'copy' : 'aac-stereo'} (${auto.reason})`
    );

    let ffmpeg;
    try {
      ffmpeg = spawn(FFMPEG_BIN, ffmpegArgs);
    } catch (err) {
      release();
      return res.status(500).json({ error: `Could not start FFmpeg ("${FFMPEG_BIN}"): ${err.message}` });
    }

    // Progressive fMP4 has no index, so it cannot be seeked by the browser. The client restarts the
    // stream with &startSec= instead; advertise that so it does not try native seeking.
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Stream-Mode': 'remux',
      'X-Stream-Start-Sec': String(startSec),
      'X-Stream-Duration': String(summary && summary.durationSec ? Math.round(summary.durationSec) : 0)
    });

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn('[FFmpeg]', msg);
    });

    ffmpeg.on('error', (err) => {
      console.warn('[FFmpeg spawn error]', err.message);
      res.destroy();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== null) console.warn(`[FFmpeg] exited with code ${code}`);
      res.end();
    });

    let cleanedUp = false;
    const cleanup = () => {
      // req 'close' and res 'finish' can BOTH fire; without this guard refCount was decremented
      // twice per connection and the torrent was torn down while still being watched.
      if (cleanedUp) return;
      cleanedUp = true;
      try { ffmpeg.kill('SIGKILL'); } catch {}
      release();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

  } catch (err) {
    console.error('[Stream Handler Error]', err);
    if (registered) {
      playbackSessions.delete(sessionId);
      releaseTorrentReference(registered.hash, registered.name);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: `Streaming bridge error: ${err.message}` });
    } else {
      res.destroy();
    }
  }
});

// ----------------- HEALTH & HOST TELEMETRY -----------------

// Populated at boot. The remux path is useless without these binaries, and silently failing to
// spawn them was indistinguishable from "the swarm is slow".
const toolchain = { ffmpeg: false, ffprobe: false, checked: false };

function checkBinary(bin) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, ['-version']);
    } catch {
      return resolve(false);
    }
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
    proc.stdout.resume();
    proc.stderr.resume();
  });
}

async function verifyToolchain() {
  toolchain.ffmpeg = await checkBinary(FFMPEG_BIN);
  toolchain.ffprobe = await checkBinary(FFPROBE_BIN);
  toolchain.checked = true;

  if (!toolchain.ffmpeg || !toolchain.ffprobe) {
    console.warn(
      `[Toolchain] ffmpeg=${toolchain.ffmpeg ? 'ok' : 'MISSING'} ffprobe=${toolchain.ffprobe ? 'ok' : 'MISSING'}. ` +
      `Install with: sudo apt install -y ffmpeg. Without them the bridge can only serve releases ` +
      `that are already browser-native (MP4 + H.264 + AAC stereo).`
    );
  } else {
    console.log('[Toolchain] ffmpeg and ffprobe detected.');
  }
}

/**
 * Health & Telemetry Monitor
 */
app.get('/health', async (req, res) => {
  let qbtStatus = false;
  let torrentsCount = 0;

  try {
    qbtStatus = await qbt.login();
    if (qbtStatus) {
      const list = await qbt.getAllTorrents();
      torrentsCount = list.length;
    }
  } catch {}

  const diskStats = getDiskUsageStats();
  const totalMem = (os.totalmem() / (1024 * 1024)).toFixed(0);
  const freeMem = (os.freemem() / (1024 * 1024)).toFixed(0);

  res.json({
    status: 'online',
    service: 'CineStream Piece-Aware Progressive Torrent & FFmpeg AAC Streaming Bridge',
    engine: 'qBittorrent C++ Swarm + Piece-Aware Streamer + FFmpeg AAC Remuxer',
    security: {
      rateLimitingActive: true,
      pathTraversalGuards: true,
      adminAuthEnabled: true,
      internalEndpointLoopbackOnly: true
    },
    qBittorrentConnected: qbtStatus,
    activeTorrentsCount: torrentsCount,
    activePlaybackSessions: playbackSessions.size,
    toolchain: {
      ffmpeg: toolchain.ffmpeg,
      ffprobe: toolchain.ffprobe,
      videoTranscodeEnabled: ALLOW_VIDEO_TRANSCODE
    },
    hostTelemetry: {
      loadAverage: os.loadavg(),
      ramTotalMb: Number(totalMem),
      ramFreeMb: Number(freeMem),
      diskUsagePercent: `${diskStats.usedPct}%`,
      diskFreeGb: `${diskStats.freeGb} GB`
    },
    limits: {
      maxActiveTorrents: MAX_ACTIVE_TORRENTS,
      maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      maxDiskUsagePercent: `${DISK_MAX_USAGE_PCT}%`,
      idleCleanupMinutes: IDLE_TTL_MINUTES
    },
    uptime: process.uptime()
  });
});

/**
 * Playback Session Heartbeat Endpoint
 */
app.post('/api/stream/session/heartbeat', (req, res) => {
  const { sessionId, infoHash, currentTime } = req.body;
  if (!sessionId || !infoHash) {
    return res.status(400).json({ error: 'Missing sessionId or infoHash' });
  }

  const hash = infoHash.toLowerCase();
  playbackSessions.set(sessionId, {
    id: sessionId,
    infoHash: hash,
    lastSeen: Date.now(),
    currentTime: currentTime || 0,
    ip: req.ip
  });

  if (torrentRegistry.has(hash)) {
    const entry = torrentRegistry.get(hash);
    entry.lastActive = Date.now();
    if (entry.cleanTimer) {
      clearTimeout(entry.cleanTimer);
      entry.cleanTimer = null;
    }
  }

  res.json({ status: 'active', sessionId });
});

/**
 * Playback Session Leave — the viewer explicitly closed the player.
 */
app.post('/api/stream/session/leave', async (req, res) => {
  const { sessionId, infoHash } = req.body || {};
  if (sessionId) playbackSessions.delete(sessionId);

  const hash = String(infoHash || '').toLowerCase();
  if (hash) {
    const entry = torrentRegistry.get(hash);
    if (entry && entry.cleanTimer) {
      clearTimeout(entry.cleanTimer);
      entry.cleanTimer = null;
    }

    // Stop spending swarm bandwidth right away, but only if nothing else is still reading it.
    if ((!entry || entry.refCount === 0) && !hasFreshSession(hash, 5000) && !isReserved(hash)) {
      await qbt.pauseTorrents([hash]).catch(() => {});
      console.log(`[Session Leave] Paused "${entry ? entry.name : hash}"`);
    }
  }

  res.json({ status: 'left' });
});

/**
 * Proxy Prowlarr Search
 */
app.get('/api/search', checkRateLimit('search', 30, 60000), async (req, res) => {
  const query = req.query.query;
  const limit = req.query.limit || 20;

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  try {
    const endpoint = `${PROWLARR_URL}/api/v1/search?query=${encodeURIComponent(query)}&limit=${limit}`;
    const response = await fetch(endpoint, {
      headers: {
        'X-Api-Key': PROWLARR_KEY,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Prowlarr returned ${response.status}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[Prowlarr Proxy Error]:', err.message);
    res.status(500).json({ error: 'Failed to reach Prowlarr on VPS loopback' });
  }
});

/**
 * Active Torrents Status Endpoint
 */
app.get('/api/status', async (req, res) => {
  try {
    const list = await qbt.getAllTorrents();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Admin-Protected Manual Disk Cleanup Endpoint
 */
app.post('/api/cleanup', async (req, res) => {
  const authHeader = req.headers['x-admin-token'] || req.headers['authorization'];
  const providedToken = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null;

  if (!providedToken || providedToken !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Valid X-Admin-Token required.' });
  }

  try {
    await qbt.login();
    const list = await qbt.getAllTorrents();
    let cleaned = 0;

    for (const t of list) {
      const hash = t.hash.toLowerCase();
      const entry = torrentRegistry.get(hash);
      if (!entry || entry.refCount === 0) {
        await qbt.deleteTorrent(t.hash, true);
        torrentRegistry.delete(hash);
        cleaned++;
      }
    }

    res.json({ success: true, cleanedTorrents: cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  verifyToolchain();
  console.log(`====================================================`);
  console.log(`🎬 CineStream Piece-Aware Progressive Streaming Bridge`);
  console.log(`   Engine:             qBittorrent C++ + Piece-Aware Streamer + FFmpeg AAC`);
  console.log(`📡 Port:               ${PORT}`);
  console.log(`📥 qBittorrent:        ${QBT_URL}`);
  console.log(`🔍 Prowlarr Proxy:     ${PROWLARR_URL}`);
  console.log(`🛡️ Rate Limiting:      Enabled`);
  console.log(`🧹 Auto-GC Idle TTL:   ${IDLE_TTL_MINUTES} minute(s)`);
  console.log(`⏳ Pause Grace Window: ${Math.round(STREAM_IDLE_GRACE_MS / 1000)}s after last connection`);
  console.log(`🎞️ Video Transcode:    ${ALLOW_VIDEO_TRANSCODE ? 'enabled' : 'disabled (set ALLOW_VIDEO_TRANSCODE=1)'}`);
  console.log(`🩺 Health check:       http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
