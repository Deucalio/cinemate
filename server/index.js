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

// Torrents are added under their own qBittorrent category.
//
// This host's qBittorrent is shared with a Sonarr/Radarr stack, whose "Completed Download Handling"
// imports a finished download and then REMOVES the torrent and its data from the client. Anything
// added without a category can fall into whatever those tools monitor, which is how completed
// torrents were vanishing seconds after playback started — qBittorrent logged
// "removed from the transfer list and hard disk" while this bridge logged nothing at all.
//
// *arr tools only manage their own category, so labelling ours keeps the two from fighting.
// Set QBT_CATEGORY='' to disable if the bridge ever gets a qBittorrent instance to itself.
const QBT_CATEGORY = process.env.QBT_CATEGORY !== undefined ? process.env.QBT_CATEGORY : 'cinemate';

const PROWLARR_URL = process.env.PROWLARR_URL || 'http://127.0.0.1:9696';
const PROWLARR_KEY = process.env.PROWLARR_KEY || '5a197b3359f247e8a69c7866650058e4';

// Resource, Concurrency & Quota Limits
const MAX_ACTIVE_TORRENTS = parseInt(process.env.MAX_ACTIVE_TORRENTS || '5', 10);
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS || '15', 10);
const DISK_MAX_USAGE_PCT = parseInt(process.env.DISK_MAX_USAGE_PCT || '85', 10);
// Above this, evict least-recently-played torrents until back under DISK_TARGET_PCT.
const DISK_AGGRESSIVE_PCT = parseInt(process.env.DISK_AGGRESSIVE_PCT || '88', 10);
const DISK_TARGET_PCT = parseInt(process.env.DISK_TARGET_PCT || '80', 10);
// Above this, stop all downloading to protect the host's other services.
const DISK_EMERGENCY_PCT = parseInt(process.env.DISK_EMERGENCY_PCT || '95', 10);
// Test seam: forces getDiskUsageStats() to report a fixed percentage.
const DISK_USAGE_OVERRIDE_PCT = process.env.DISK_USAGE_OVERRIDE_PCT
  ? parseInt(process.env.DISK_USAGE_OVERRIDE_PCT, 10)
  : null;

// Where LRU state survives restarts. Without this, every deploy resets the eviction order and a
// rewatch after a restart re-downloads a file that is still sitting on disk.
const LRU_STATE_PATH = process.env.LRU_STATE_PATH || path.join(process.cwd(), '.cache', 'torrent-lru.json');
// Cache-first makes a downloaded file worth keeping: a rewatch within the window is instant.
// The old 1-minute default deleted a torrent (and its data) if you paused for a phone call.
const IDLE_TTL_MINUTES = parseInt(process.env.IDLE_TTL_MINUTES || '30', 10);
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

// Cache-first delivery (Phase 2): wait for the download to finish, then serve a complete file.
//
// On this host the swarm runs at 12-70 MB/s, so a 2-3 GB release lands in about a minute. Paying
// that once buys a delivery path with no piece gating, no sparse-zero reads, no .!qB path chasing
// and native browser seeking. Set REQUIRE_COMPLETE=0 to fall back to progressive piece-aware
// streaming (retained for Phase 4).
const REQUIRE_COMPLETE = process.env.REQUIRE_COMPLETE !== '0';

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
    // hashes already switched to sequential mode (the qBt endpoints are toggles, not setters)
    this._sequentialEnsured = new Set();
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
      // Keeps our torrents out of any *arr stack sharing this qBittorrent instance.
      if (QBT_CATEGORY) formData.append('category', QBT_CATEGORY);
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
   * Torrent properties. This is the ONLY place qBittorrent exposes `piece_size` and `pieces_num` —
   * they are NOT fields of /torrents/info, despite how often that is assumed.
   */
  async getProperties(hash) {
    try {
      const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/properties?hash=${hash}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
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

  /**
   * Guarantees sequential download and first/last piece priority are ON for a torrent.
   *
   * These are set in torrents/add — but add is a NO-OP for a torrent qBittorrent already has, so
   * any pre-existing torrent kept downloading rarest-first. The piece-aware reader then waited on
   * early pieces that arrive in arbitrary order: "Piece 1 was not verified" while the torrent sat
   * at 27%. Playback only worked once the download hit 100%, when order stopped mattering.
   *
   * Both endpoints are TOGGLES, not setters, so the current state must be read first. `seq_dl` and
   * `f_l_piece_prio` come from torrents/info. Guarded per hash so concurrent range requests cannot
   * toggle it twice and turn it back off.
   */
  async ensureSequentialDownload(torrentInfo) {
    const hash = String(torrentInfo.hash || '').toLowerCase();
    if (!hash || this._sequentialEnsured.has(hash)) return;
    this._sequentialEnsured.add(hash);

    const toggle = async (action) => {
      const body = new URLSearchParams();
      body.append('hashes', hash);
      await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
    };

    try {
      if (!torrentInfo.seq_dl) {
        await toggle('toggleSequentialDownload');
        console.log(`[Sequential] Enabled sequential download for "${torrentInfo.name}"`);
      }
      if (!torrentInfo.f_l_piece_prio) {
        await toggle('toggleFirstLastPiecePrio');
        console.log(`[Sequential] Enabled first/last piece priority for "${torrentInfo.name}"`);
      }
    } catch (err) {
      this._sequentialEnsured.delete(hash);
      console.warn('[Sequential] Could not set download order:', err.message);
    }
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

  async deleteTorrent(hash, deleteFiles = true, reason = 'unspecified') {
    if (!hash) return false;
    // Every deletion is logged with its caller. Torrents were vanishing mid-test with no record of
    // what removed them; this makes it unambiguous whether the bridge did it.
    console.log(`[Delete] Removing torrent ${hash} (deleteFiles=${deleteFiles}) — reason: ${reason}`);
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

      if (Array.isArray(states) && states.length > 0 && globalPiece >= states.length) {
        // The computed index is past the end of the torrent, which means the piece size we were
        // given does not match reality. Waiting cannot fix that — fail loudly.
        throw new Error(
          `Computed piece ${globalPiece} exceeds the torrent's ${states.length} pieces — ` +
          `the piece size used for mapping is wrong.`
        );
      }

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
 * Serves a byte range for a torrent file over HTTP 206/200.
 *
 * Two backings:
 *  - `pieceAware: false` (cache-first default) — a plain fs.createReadStream over a COMPLETE file.
 *    Nothing can be missing, so there is nothing to verify. This is the whole point of Phase 2.
 *  - `pieceAware: true` — the piece-verified reader, for streaming a file that is still downloading.
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

  const pieceAware = ctx.pieceAware !== false;

  const stream = pieceAware
    ? createPieceAwareTorrentStream(filePath, hash, start, end, pieceSize, fileOffsetInTorrent)
    : fs.createReadStream(filePath, { start, end });

  stream.on('error', (err) => {
    console.warn(`[${pieceAware ? 'Piece Stream' : 'File Stream'}] ${err.message}`);
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
 * Persists lastActive / pinned across restarts so eviction order and pinning survive a deploy.
 * Small file, written on the GC tick; losing it costs nothing but a reset eviction order.
 */
function saveLruState() {
  try {
    const state = {};
    for (const [hash, entry] of torrentRegistry) {
      state[hash] = { name: entry.name, lastActive: entry.lastActive, pinned: !!entry.pinned };
    }
    fs.mkdirSync(path.dirname(LRU_STATE_PATH), { recursive: true });
    fs.writeFileSync(LRU_STATE_PATH, JSON.stringify(state));
  } catch (err) {
    console.warn('[LRU] Could not persist state:', err.message);
  }
}

function loadLruState() {
  try {
    if (!fs.existsSync(LRU_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(LRU_STATE_PATH, 'utf8')) || {};
  } catch (err) {
    console.warn('[LRU] Could not read state:', err.message);
    return {};
  }
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
  if (DISK_USAGE_OVERRIDE_PCT !== null) {
    return { usedPct: DISK_USAGE_OVERRIDE_PCT, totalGb: '100.0', freeGb: '10.0' };
  }
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

// sessionId -> the FFmpeg process currently serving it. A <video> element opens more than one
// connection per source (metadata probe, then playback), and each was spawning its own transcode;
// two FFmpeg processes then competed for the same not-yet-downloaded pieces.
const ffmpegBySession = new Map();

// Sessions that have already logged their [Stream Start] line, so it appears once per playback
// rather than once per range request.
const loggedStreamStarts = new Set();

/**
 * Logs the torrent's LIVE download progress at the moment playback begins.
 *
 * This is the only way to tell "it streamed while downloading" from "it streamed because the file
 * had already finished downloading" — by the time a small release plays, it is often complete, and
 * the two are indistinguishable from the outside.
 */
function logStreamStart(sessionId, hash, torrentName, mode) {
  const key = `${sessionId}:${hash}`;
  if (loggedStreamStarts.has(key)) return;
  loggedStreamStarts.add(key);
  if (loggedStreamStarts.size > 500) loggedStreamStarts.clear();

  qbt.getAllTorrents()
    .then((list) => {
      const t = Array.isArray(list) ? list.find(x => x.hash && x.hash.toLowerCase() === hash) : null;
      if (!t) return;
      const pct = ((t.progress || 0) * 100).toFixed(1);
      console.log(
        `[Stream Start] "${torrentName}" mode=${mode} ` +
        `torrentProgress=${pct}% dl=${((t.dlspeed || 0) / 1048576).toFixed(1)}MB/s ` +
        `${Number(pct) < 99.9 ? '<-- PROGRESSIVE: playing while still downloading' : '(file already complete)'}`
      );
    })
    .catch(() => {});
}

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

// Hashes known to be 100% downloaded. A torrent cannot become incomplete again, so once a hash is
// in here the completeness check costs nothing for the rest of its life.
const completedTorrents = new Set();

async function isTorrentComplete(hash) {
  const key = String(hash || '').toLowerCase();
  if (!key) return false;
  if (completedTorrents.has(key)) return true;

  const list = await qbt.getAllTorrents();
  const torrent = Array.isArray(list) ? list.find(t => t.hash && t.hash.toLowerCase() === key) : null;
  if (torrent && (torrent.progress || 0) >= 1) {
    completedTorrents.add(key);
    return true;
  }
  return false;
}

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
  completedTorrents.delete(hash);
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

// Restored at boot so eviction order and pins survive a restart.
const persistedLru = loadLruState();
if (Object.keys(persistedLru).length > 0) {
  console.log(`[LRU] Restored playback history for ${Object.keys(persistedLru).length} torrent(s)`);
}

/**
 * True when something is actively reading or watching this torrent right now.
 */
function isTorrentInUse(hash, entry) {
  return Boolean(
    (entry && entry.refCount > 0) ||
    hasFreshSession(hash) ||
    isReserved(hash)
  );
}

/**
 * True when eviction must skip this torrent — in use, or deliberately pinned.
 * Kept distinct from isTorrentInUse so a pinned-but-idle torrent is not reported as "in use".
 */
function isEvictionProtected(hash, entry) {
  return isTorrentInUse(hash, entry) || Boolean(entry && entry.pinned);
}

async function evictTorrent(entry, torrent, reason) {
  console.log(`[Auto-GC] Evicting "${torrent.name}" — ${reason}`);
  if (entry && entry.cleanTimer) clearTimeout(entry.cleanTimer);
  await qbt.deleteTorrent(torrent.hash, true, reason).catch(() => {});
  purgeTorrentCaches(torrent.hash.toLowerCase());
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

    const isLogged = await qbt.login();
    if (!isLogged) return;

    const allTorrents = await qbt.getAllTorrents();
    if (!Array.isArray(allTorrents)) return;

    const liveHashes = new Set(allTorrents.map(t => t.hash.toLowerCase()));
    for (const hash of [...torrentRegistry.keys()]) {
      if (!liveHashes.has(hash)) purgeTorrentCaches(hash);
    }

    // Make sure every live torrent is tracked, restoring persisted history where we have it.
    for (const t of allTorrents) {
      const hash = t.hash.toLowerCase();
      if (torrentRegistry.has(hash)) continue;

      const restored = persistedLru[hash];
      torrentRegistry.set(hash, {
        hash,
        name: t.name,
        refCount: 0,
        // Start the idle clock now unless we have a real playback time from before the restart.
        lastActive: restored && restored.lastActive ? restored.lastActive : now,
        pinned: Boolean(restored && restored.pinned),
        cleanTimer: null
      });
      console.log(
        `[Auto-GC] Now tracking "${t.name}"` +
        (restored ? ' (restored playback history)' : ' (idle timer starts now)')
      );
    }

    // ---- Pass 1: ordinary idle expiry -------------------------------------------------------
    for (const t of allTorrents) {
      const hash = t.hash.toLowerCase();
      const entry = torrentRegistry.get(hash);
      if (!entry) continue;

      if (isEvictionProtected(hash, entry)) {
        // Only genuine activity refreshes the idle clock; pinning must not make a torrent look
        // permanently "just played", or unpinning it would grant a full extra TTL window.
        if (isTorrentInUse(hash, entry)) entry.lastActive = now;
        continue;
      }

      if ((now - entry.lastActive) >= IDLE_TTL_MS) {
        await evictTorrent(entry, t, `idle ${IDLE_TTL_MINUTES}m`);
      }
    }

    // ---- Pass 2: LRU eviction under disk pressure --------------------------------------------
    //
    // The previous behaviour deleted EVERY idle torrent the moment the disk crossed 88%, which
    // threw away the whole cache — including titles about to be rewatched — to reclaim space that
    // one or two files would have covered. Now the least-recently-played torrent is evicted one at
    // a time, and only until usage is back under DISK_TARGET_PCT.
    let disk = getDiskUsageStats();

    if (disk.usedPct >= DISK_AGGRESSIVE_PCT) {
      const remaining = await qbt.getAllTorrents();
      const candidates = (Array.isArray(remaining) ? remaining : [])
        .map(t => ({ torrent: t, entry: torrentRegistry.get(t.hash.toLowerCase()) }))
        .filter(({ torrent, entry }) => entry && !isEvictionProtected(torrent.hash.toLowerCase(), entry))
        .sort((a, b) => a.entry.lastActive - b.entry.lastActive); // least recently played first

      console.log(
        `[Auto-GC] Disk at ${disk.usedPct}% (>= ${DISK_AGGRESSIVE_PCT}%). ` +
        `Evicting least-recently-played of ${candidates.length} candidate(s) down to ${DISK_TARGET_PCT}%.`
      );

      for (const { torrent, entry } of candidates) {
        disk = getDiskUsageStats();
        if (disk.usedPct < DISK_TARGET_PCT) break;
        const idleMins = Math.round((now - entry.lastActive) / 60000);
        await evictTorrent(entry, torrent, `LRU at ${disk.usedPct}% disk, last played ${idleMins}m ago`);
      }

      disk = getDiskUsageStats();
      if (disk.usedPct >= DISK_TARGET_PCT) {
        console.warn(
          `[Auto-GC] Still at ${disk.usedPct}% after evicting everything evictable — ` +
          `the remaining torrents are all in use or pinned.`
        );
      }
    }

    // ---- Pass 3: emergency halt --------------------------------------------------------------
    if (disk.usedPct >= DISK_EMERGENCY_PCT) {
      const active = (await qbt.getAllTorrents()).filter(t => (t.progress || 0) < 1);
      if (active.length > 0) {
        console.error(
          `[Auto-GC] EMERGENCY: disk at ${disk.usedPct}%. Pausing ${active.length} downloading ` +
          `torrent(s) to protect the host.`
        );
        await qbt.pauseTorrents(active.map(t => t.hash)).catch(() => {});
      }
    }

    saveLruState();
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

  // Only add what is genuinely new. Re-POSTing an add for an existing torrent should be a no-op in
  // qBittorrent, but a completed torrent has been observed reverting to downloading right after
  // playback started, and this removes the bridge from that picture entirely. It is also simply
  // wasteful: prepare runs on every uncached resolution.
  if (!alreadyPresent) {
    await qbt.addTorrent(magnet);
  }

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
      // Must happen for pre-existing torrents too, not just ones we just added.
      await qbt.ensureSequentialDownload(torrentInfo);

      // A torrent under a different category is very likely managed by something else on this
      // host (Sonarr/Radarr import-then-delete, for example). Say so once rather than letting the
      // files disappear mid-playback with no explanation.
      if (QBT_CATEGORY && torrentInfo.category && torrentInfo.category !== QBT_CATEGORY) {
        qbt.warnOnce(
          `category:${torrentInfo.category}`,
          `[Category] "${torrentInfo.name}" is in qBittorrent category "${torrentInfo.category}", ` +
          `not "${QBT_CATEGORY}". Another tool may be managing it and can delete it on completion.`
        );
      }

      // A torrent that was complete and is now not complete has been reset by something outside
      // this process (qBittorrent recheck, external removal, storage moved). Say so loudly —
      // silently re-downloading is what made this look like the bridge's doing.
      const hashKey = (torrentInfo.hash || '').toLowerCase();
      if (completedTorrents.has(hashKey) && (torrentInfo.progress || 0) < 1) {
        console.warn(
          `[Integrity] "${torrentInfo.name}" was complete but now reports ` +
          `${((torrentInfo.progress || 0) * 100).toFixed(1)}% (state=${torrentInfo.state}). ` +
          `The bridge did not delete it — check qBittorrent's own log.`
        );
        completedTorrents.delete(hashKey);
      }

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

  // The piece size MUST come from /torrents/properties. It is not a field of /torrents/info, so
  // `torrentInfo.piece_size` was always undefined and silently fell back to a guessed 2 MB. When
  // the real piece size is smaller, floor(offset / 2MB) resolves to a piece index far LOWER than
  // the true one — an already-downloaded piece — so the reader ran ahead of the download frontier
  // and served sparse zeros. FFmpeg then reported "0x00 ... invalid as first byte of an EBML
  // number" and nothing played until the torrent hit 100%, at which point no zeros remained.
  //
  // Guessing is not acceptable here: a wrong piece size silently corrupts the stream. If it cannot
  // be established, refuse to serve.
  const props = await qbt.getProperties(matchedHash);
  const totalSize = torrentInfo.total_size || torrentInfo.size || 0;
  const piecesNum = props && props.pieces_num > 0 ? props.pieces_num : 0;

  let pieceSize = props && props.piece_size > 0 ? props.piece_size : 0;

  if (!pieceSize && piecesNum && totalSize) {
    // Derive it, rounding up to a power of two (libtorrent always uses one).
    pieceSize = 2 ** Math.ceil(Math.log2(totalSize / piecesNum));
    console.warn(`[Piece Size] properties.piece_size missing — derived ${pieceSize} from pieces_num=${piecesNum}`);
  }

  if (!pieceSize) {
    return {
      ok: false,
      status: 503,
      message:
        'qBittorrent did not report a piece size for this torrent (/torrents/properties returned ' +
        'nothing usable). Refusing to stream rather than guess, which would serve corrupt data.'
    };
  }

  if (piecesNum && totalSize) {
    const expected = Math.ceil(totalSize / pieceSize);
    if (expected !== piecesNum) {
      console.warn(
        `[Piece Size] Inconsistent: piece_size=${pieceSize} and total_size=${totalSize} imply ` +
        `${expected} pieces, but qBittorrent reports ${piecesNum}. Piece gating may be unreliable.`
      );
    }
  }

  const mapping = computeFileMapping(files, chosen, pieceSize);

  console.log(
    `[Media Select] "${torrentInfo.name}" -> ${path.basename(chosen.name)} ` +
    `(${(chosen.size / 1048576).toFixed(1)} MB, file #${chosen.index}, ` +
    `offset ${mapping.fileOffsetInTorrent}${mapping.exact ? '' : ' approx'}, ` +
    `pieceSize ${(pieceSize / 1024).toFixed(0)}KB x ${piecesNum || '?'}) at ${targetFilePath}`
  );

  // Focus the swarm on the file we are serving — but ONLY while there is still something to
  // download, and only when the priorities are not already what we want.
  //
  // Two reasons to be conservative here. Setting a file to priority 0 makes libtorrent discard that
  // file's data and recompute completeness; with TempPathEnabled that can move a finished torrent
  // back to the incomplete directory. And prepare runs on every uncached resolution, so this was
  // firing repeatedly against torrents that had nothing left to fetch.
  const isAlreadyComplete = (torrentInfo.progress || 0) >= 1;

  if (mapping.fileIndex !== null && !isAlreadyComplete) {
    const current = new Map(
      files.map((f, i) => [(typeof f.index === 'number' ? f.index : i), f.priority])
    );

    if (current.get(mapping.fileIndex) !== 7) {
      await qbt.setFilePriority(matchedHash, [mapping.fileIndex], 7);
    }

    const needsZeroing = mapping.otherIndexes.filter(i => current.get(i) !== 0);
    if (needsZeroing.length > 0) {
      await qbt.setFilePriority(matchedHash, needsZeroing, 0);
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
 * Cheap progress poll for the "waiting to start" state.
 *
 * The player used to show an indeterminate spinner over a FAKE animated bar, so a legitimate
 * 60-second download was indistinguishable from a permanent hang — which is exactly why every
 * failure so far looked identical to the user. This endpoint costs one torrents/info call: no file
 * resolution, no ffprobe, no piece work, so it is safe to poll every couple of seconds.
 */
app.get('/api/stream/status', checkRateLimit('stream', STREAM_RATE_LIMIT_PER_MIN, 60000), async (req, res) => {
  const magnet = req.query.magnet || req.query.link;
  if (!magnet) {
    return res.status(400).json({ ok: false, error: 'Missing magnet link parameter' });
  }

  const infoHash = qbt.extractInfoHash(magnet);

  try {
    const torrentInfo = await qbt.findTorrent(infoHash, req.query.title || '', magnet);

    if (!torrentInfo) {
      return res.json({
        ok: true,
        state: 'resolving',
        ready: false,
        progress: 0,
        message: 'Waiting for torrent metadata from the swarm...'
      });
    }

    const progress = torrentInfo.progress || 0;
    const dlSpeed = torrentInfo.dlspeed || 0;
    const amountLeft = torrentInfo.amount_left || 0;

    // qBittorrent's own `eta` is 8640000 when it has no estimate; compute our own when it can.
    let etaSeconds = 0;
    if (dlSpeed > 0 && amountLeft > 0) {
      etaSeconds = Math.round(amountLeft / dlSpeed);
    } else if (torrentInfo.eta && torrentInfo.eta > 0 && torrentInfo.eta < 8640000) {
      etaSeconds = torrentInfo.eta;
    }

    res.json({
      ok: true,
      state: torrentInfo.state || 'unknown',
      ready: progress >= 1,
      progress,
      progressPercent: Math.round(progress * 1000) / 10,
      dlSpeed,
      etaSeconds,
      seeds: torrentInfo.num_seeds || 0,
      peers: torrentInfo.num_leechs || 0,
      totalBytes: torrentInfo.total_size || torrentInfo.size || 0,
      name: torrentInfo.name || ''
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

    // Cache-first: while the file is incomplete there is nothing worth probing — ffprobe would be
    // reading sparse regions and failing, which is exactly the "probe unavailable" noise that made
    // every incomplete .mkv fall back to a guess. Report progress and let the client wait.
    if (REQUIRE_COMPLETE && !(await isTorrentComplete(prep.matchedHash))) {
      const live = await qbt.findTorrent(prep.matchedHash, nameHint, magnet);
      const progress = live ? (live.progress || 0) : 0;
      return res.json({
        ok: true,
        readyState: 'downloading',
        progress,
        progressPercent: Math.round(progress * 1000) / 10,
        infoHash: prep.matchedHash,
        torrentName: prep.torrentName,
        fileName: path.basename(prep.mediaName),
        fileSizeBytes: prep.fileSize,
        message: 'Downloading to the server. Playback starts once the file is complete.'
      });
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

    const progress = prep.torrentInfo.progress || 0;

    res.json({
      ok: true,
      mode: decision.mode,
      reason: decision.reason,
      // Phase 1: reported so the client can show real progress instead of a fake bar. Phase 2 will
      // additionally WITHHOLD the stream URL until this is 'ready'.
      readyState: progress >= 1 ? 'ready' : 'downloading',
      progress,
      progressPercent: Math.round(progress * 1000) / 10,
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

    // Cache-first gate. Serving an incomplete file is what every piece-related bug in this project
    // came from; under REQUIRE_COMPLETE we simply do not.
    const isComplete = await isTorrentComplete(matchedHash);
    if (REQUIRE_COMPLETE && !isComplete) {
      const live = await qbt.findTorrent(matchedHash, nameHint, magnet);
      const progress = live ? (live.progress || 0) : 0;
      playbackSessions.delete(sessionId);
      releaseTorrentReference(matchedHash, torrentName);
      registered = null;
      return res.status(503).json({
        error: 'Still downloading to the server. Playback starts once the file is complete.',
        code: 'NOT_READY',
        readyState: 'downloading',
        progress,
        progressPercent: Math.round(progress * 1000) / 10
      });
    }

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

    logStreamStart(sessionId, matchedHash, torrentName, mode);

    if (mode === 'direct') {
      const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';
      console.log(
        `[Direct 206] "${torrentName}" range=${req.headers.range || 'none'} ` +
        `size=${(fileSize / 1048576).toFixed(1)} MB source=${isComplete ? 'complete-file' : 'piece-aware'}`
      );

      servePieceAwareRange(req, res, {
        filePath: targetFilePath,
        hash: matchedHash,
        pieceSize,
        fileOffsetInTorrent,
        fileSize,
        contentType,
        // A complete file needs no piece verification — nothing in it can be missing.
        pieceAware: !isComplete,
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

    const ffmpegArgs = ['-hide_banner', '-loglevel', 'error'];

    // Against a COMPLETE file, FFmpeg reads the path directly. The loopback HTTP endpoint exists
    // only so FFmpeg could seek across piece-gated reads; on a whole file it is pure overhead and
    // was the source of the "Stream ends prematurely" / "Input/output error" noise.
    const ffmpegInput = isComplete ? targetFilePath : internalUrlFor(token);
    if (!isComplete) {
      ffmpegArgs.push('-seekable', '1', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10');
    }

    // Input seeking: fast and keyframe-accurate, with the container header intact.
    if (startSec > 0) ffmpegArgs.push('-ss', String(startSec));

    ffmpegArgs.push('-i', ffmpegInput);
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
      `audio=${auto.copyAudio ? 'copy' : 'aac-stereo'} input=${isComplete ? 'local-file' : 'loopback'} (${auto.reason})`
    );

    // Supersede any transcode already running for this session.
    const previous = ffmpegBySession.get(sessionId);
    if (previous) {
      try { previous.kill('SIGKILL'); } catch {}
      ffmpegBySession.delete(sessionId);
    }

    let ffmpeg;
    try {
      ffmpeg = spawn(FFMPEG_BIN, ffmpegArgs);
      ffmpegBySession.set(sessionId, ffmpeg);
    } catch (err) {
      release();
      return res.status(500).json({ error: `Could not start FFmpeg ("${FFMPEG_BIN}"): ${err.message}` });
    }

    // Progressive fMP4 has no index, so it cannot be seeked by the browser. The client restarts the
    // stream with &startSec= instead; advertise that so it does not try native seeking.
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      // Progressive fMP4 has no index, so the browser cannot seek it natively regardless of whether
      // the source file is complete. The client restarts the stream with &startSec= instead.
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
      if (ffmpegBySession.get(sessionId) === ffmpeg) ffmpegBySession.delete(sessionId);
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
      evictAbovePercent: `${DISK_AGGRESSIVE_PCT}%`,
      evictDownToPercent: `${DISK_TARGET_PCT}%`,
      emergencyHaltPercent: `${DISK_EMERGENCY_PCT}%`,
      idleCleanupMinutes: IDLE_TTL_MINUTES,
      deliveryMode: REQUIRE_COMPLETE ? 'cache-first' : 'progressive',
      evictionPolicy: 'lru-by-last-playback'
    },
    cache: {
      trackedTorrents: torrentRegistry.size,
      pinnedTorrents: [...torrentRegistry.values()].filter(e => e.pinned).length
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
 * Pin a torrent so LRU eviction and idle expiry skip it.
 *
 * Useful for a series you are working through, or anything expensive to re-acquire. Pinned torrents
 * are still counted against the disk thresholds — pinning too much simply means the emergency halt
 * fires instead of eviction, which is the correct and visible failure.
 */
app.post('/api/torrent/pin', async (req, res) => {
  const authHeader = req.headers['x-admin-token'] || req.headers['authorization'];
  const providedToken = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null;
  if (!providedToken || providedToken !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Valid X-Admin-Token required.' });
  }

  const hash = String((req.body && req.body.hash) || '').toLowerCase();
  const pinned = !(req.body && req.body.pinned === false);

  if (!hash) return res.status(400).json({ error: 'Missing hash' });

  const entry = torrentRegistry.get(hash);
  if (!entry) return res.status(404).json({ error: 'Unknown torrent hash' });

  entry.pinned = pinned;
  if (pinned) entry.lastActive = Date.now();
  saveLruState();

  console.log(`[Pin] "${entry.name}" ${pinned ? 'pinned — exempt from eviction' : 'unpinned'}`);
  res.json({ ok: true, hash, pinned, name: entry.name });
});

/**
 * Cache contents, most recently played first. Shows what eviction would remove and in what order.
 */
app.get('/api/cache', async (req, res) => {
  try {
    const torrents = await qbt.getAllTorrents();
    const now = Date.now();

    const rows = (Array.isArray(torrents) ? torrents : []).map((t) => {
      const hash = t.hash.toLowerCase();
      const entry = torrentRegistry.get(hash);
      return {
        hash,
        name: t.name,
        sizeBytes: t.total_size || t.size || 0,
        progress: t.progress || 0,
        pinned: Boolean(entry && entry.pinned),
        inUse: isTorrentInUse(hash, entry),
        idleMinutes: entry ? Math.round((now - entry.lastActive) / 60000) : null
      };
    }).sort((a, b) => (a.idleMinutes || 0) - (b.idleMinutes || 0));

    const disk = getDiskUsageStats();
    res.json({
      ok: true,
      diskUsagePercent: disk.usedPct,
      thresholds: {
        softCapPercent: DISK_MAX_USAGE_PCT,
        evictAbovePercent: DISK_AGGRESSIVE_PCT,
        evictDownToPercent: DISK_TARGET_PCT,
        emergencyHaltPercent: DISK_EMERGENCY_PCT,
        idleTtlMinutes: IDLE_TTL_MINUTES
      },
      // Eviction order is the reverse of this list, skipping pinned and in-use entries.
      cached: rows
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
        await qbt.deleteTorrent(t.hash, true, 'manual /api/cleanup');
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
  console.log(`🏷️ Torrent Category:   ${QBT_CATEGORY || '(none)'}`);
  console.log(`🔍 Prowlarr Proxy:     ${PROWLARR_URL}`);
  console.log(`🛡️ Rate Limiting:      Enabled`);
  console.log(`🧹 Auto-GC Idle TTL:   ${IDLE_TTL_MINUTES} minute(s)`);
  console.log(`⏳ Pause Grace Window: ${Math.round(STREAM_IDLE_GRACE_MS / 1000)}s after last connection`);
  console.log(`🎞️ Video Transcode:    ${ALLOW_VIDEO_TRANSCODE ? 'enabled' : 'disabled (set ALLOW_VIDEO_TRANSCODE=1)'}`);
  console.log(`📦 Delivery Mode:      ${REQUIRE_COMPLETE ? 'cache-first (wait for full download)' : 'progressive piece-aware'}`);
  console.log(`♻️ Eviction:           LRU by last playback · evict >${DISK_AGGRESSIVE_PCT}% down to ${DISK_TARGET_PCT}% · halt >${DISK_EMERGENCY_PCT}%`);
  console.log(`🩺 Health check:       http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
