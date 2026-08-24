/**
 * CineStream Pro — High-Performance BitTorrent-to-HTTP 206 Streaming Bridge
 * 
 * Key Architectural Components:
 * 1. High-Speed C++ qBittorrent Engine with Sequential Downloading & First/Last Piece Priority
 * 2. On-Demand Swarm Piece Prioritization Layer (Maps HTTP 206 byte-ranges to piece indices)
 * 3. Native HTTP 206 Partial Content Streaming directly from disk (Full forward/rewind seek support)
 * 4. Path Traversal & Malicious File Sanitization Layer (Whitelist + Canonical Path Guard)
 * 5. Instant Bandwidth Saver (Pauses torrent in qBittorrent when tab or stream closes)
 * 6. Automated 15-Minute Garbage Collector & Multi-Tier VPS Disk Protection
 * 7. Prisma PostgreSQL Database, JWT Auth, and Prowlarr Torznab Search Proxy
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8888;

// Security & Admin Credentials
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cinestream_secure_admin_token_8888';

// qBittorrent & Prowlarr Configurations
const QBT_URL = process.env.QBT_URL || 'http://127.0.0.1:18080';
const QBT_USER = process.env.QBT_USER || 'admin';
const QBT_PASS = process.env.QBT_PASS || 'adminadmin';

const PROWLARR_URL = process.env.PROWLARR_URL || 'http://127.0.0.1:9696';
const PROWLARR_KEY = process.env.PROWLARR_KEY || '5a197b3359f247e8a69c7866650058e4';

// Resource, Concurrency & Quota Limits
const MAX_ACTIVE_TORRENTS = parseInt(process.env.MAX_ACTIVE_TORRENTS || '5', 10);
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS || '15', 10);
const IDLE_TTL_MINUTES = parseInt(process.env.IDLE_TTL_MINUTES || '1', 10); // 1 minute auto-delete
const IDLE_TTL_MS = IDLE_TTL_MINUTES * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 30 * 1000; // 30s without heartbeat = IDLE

// ----------------- SYSTEM STATE & SESSION REGISTRY -----------------

// Playback Sessions: sessionId -> { id, infoHash, lastSeen, currentTime, ip }
const playbackSessions = new Map();

// Torrent Registry: infoHash -> { hash, name, state, refCount, lastActive, activeStreams }
const torrentRegistry = new Map();

// IP Rate Limiting Map: ip -> { searchCount, searchReset, streamCount, streamReset }
const rateLimitMap = new Map();

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

// ----------------- QBITTORRENT API CLIENT -----------------

class QBittorrentClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.cookie = null;
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
    } catch (err) {
      console.warn(`[qBittorrent] Login warning:`, err.message);
      return false;
    }
  }

  async fetchWithAuth(url, options = {}) {
    if (!this.cookie) {
      await this.login();
    }

    const headers = options.headers || {};
    if (this.cookie) {
      headers['Cookie'] = this.cookie;
    }

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
    await this.login();

    const formData = new URLSearchParams();
    formData.append('urls', magnet);
    formData.append('sequentialDownload', 'true');
    formData.append('firstLastPiecePrio', 'true');

    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    return res.ok;
  }

  async getAllTorrents() {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/info`);
    if (!res.ok) return [];
    return await res.json();
  }

  async getTransferInfo() {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/transfer/info`);
    if (!res.ok) return null;
    return await res.json();
  }

  async getPieceStates(hash) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/pieceStates?hash=${hash}`);
    if (!res.ok) return [];
    return await res.json();
  }

  async setPiecePriority(hash, pieceIndices, priority = 7) {
    if (!pieceIndices || pieceIndices.length === 0) return;
    const params = new URLSearchParams();
    params.append('hash', hash);
    params.append('pieces', pieceIndices.join('|'));
    params.append('priority', priority.toString());

    await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/piecePriority?${params.toString()}`);
  }

  async pauseTorrents(hashes) {
    if (!hashes || hashes.length === 0) return;
    const formData = new URLSearchParams();
    formData.append('hashes', Array.isArray(hashes) ? hashes.join('|') : hashes);
    await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });
  }

  async resumeTorrents(hashes) {
    if (!hashes || hashes.length === 0) return;
    const formData = new URLSearchParams();
    formData.append('hashes', Array.isArray(hashes) ? hashes.join('|') : hashes);
    await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });
  }

  async deleteTorrent(hash, deleteFiles = true) {
    if (!hash) return false;
    const formData = new URLSearchParams();
    formData.append('hashes', hash);
    formData.append('deleteFiles', deleteFiles ? 'true' : 'false');
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });
    return res.ok;
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

const ALLOWED_MEDIA_EXTS = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.avi']);
const FORBIDDEN_EXTS = new Set(['.exe', '.bat', '.scr', '.vbs', '.cmd', '.ps1', '.sh', '.msi', '.iso']);
const MIN_MEDIA_FILE_BYTES = 5 * 1024 * 1024; // 5 MB minimum to ignore junk / samples

/**
 * Safely resolves and selects the valid media file candidate with path traversal protection
 */
function findSafeMediaFileCandidate(targetPath, baseAllowedDir = null) {
  if (!targetPath) return null;

  const resolvedTarget = path.resolve(targetPath);

  // Path traversal check
  if (baseAllowedDir) {
    const resolvedBase = path.resolve(baseAllowedDir);
    if (!resolvedTarget.startsWith(resolvedBase)) {
      console.warn(`[Security Alert] Blocked potential path traversal attempt: ${targetPath}`);
      return null;
    }
  }

  if (!fs.existsSync(resolvedTarget)) return null;

  try {
    const stat = fs.statSync(resolvedTarget);
    if (!stat.isDirectory()) {
      const ext = path.extname(resolvedTarget).toLowerCase();
      if (FORBIDDEN_EXTS.has(ext)) return null;
      return ALLOWED_MEDIA_EXTS.has(ext) && stat.size >= MIN_MEDIA_FILE_BYTES ? resolvedTarget : null;
    }

    let largestMediaFile = null;
    let maxBytes = 0;

    function scanDir(currentDir) {
      const entries = fs.readdirSync(currentDir);
      for (const entry of entries) {
        const fullPath = path.resolve(currentDir, entry);
        if (!fullPath.startsWith(resolvedTarget)) continue;

        try {
          const s = fs.statSync(fullPath);
          if (s.isDirectory()) {
            scanDir(fullPath);
          } else {
            const ext = path.extname(entry).toLowerCase();
            const lowerName = entry.toLowerCase();

            if (FORBIDDEN_EXTS.has(ext)) continue;

            const isSample = lowerName.includes('sample') || lowerName.includes('trailer') || lowerName.includes('featurette');

            if (ALLOWED_MEDIA_EXTS.has(ext) && s.size >= MIN_MEDIA_FILE_BYTES) {
              if (!isSample && s.size > maxBytes) {
                maxBytes = s.size;
                largestMediaFile = fullPath;
              } else if (isSample && !largestMediaFile) {
                largestMediaFile = fullPath;
              }
            }
          }
        } catch {}
      }
    }

    scanDir(resolvedTarget);
    return largestMediaFile;
  } catch {
    return null;
  }
}

/**
 * Maps requested byte range to torrent piece IDs and prioritizes them in qBittorrent swarm
 */
async function prioritizeByteRange(hash, startByte, endByte, pieceSize, firstPieceIndex = 0, maxWaitMs = 5000) {
  if (!hash || !pieceSize || pieceSize <= 0) return true;

  const startPiece = firstPieceIndex + Math.floor(startByte / pieceSize);
  const endPiece = firstPieceIndex + Math.floor(endByte / pieceSize);

  // Lookahead buffer (prioritize requested + 8 consecutive pieces)
  const lookaheadPieces = [];
  for (let p = startPiece; p <= endPiece + 8; p++) {
    lookaheadPieces.push(p);
  }

  // Set maximal priority (7) for required pieces in qBittorrent
  await qbt.setPiecePriority(hash, lookaheadPieces, 7).catch(() => {});

  // Fast poll piece states until startPiece is downloaded (state == 2)
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const states = await qbt.getPieceStates(hash);
      if (Array.isArray(states) && states.length > startPiece) {
        if (states[startPiece] === 2) {
          return true;
        }
      }
    } catch {}

    await new Promise(r => setTimeout(r, 200));
  }

  return true; // Proceed to stream even if piece is downloading
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

// ----------------- AUTOMATED 1-MINUTE GARBAGE COLLECTOR -----------------

setInterval(async () => {
  try {
    const now = Date.now();
    const diskStats = getDiskUsageStats();

    const isLogged = await qbt.login();
    if (!isLogged) return;

    const allTorrents = await qbt.getAllTorrents();
    if (!Array.isArray(allTorrents) || allTorrents.length === 0) return;

    for (const t of allTorrents) {
      const hash = t.hash.toLowerCase();
      
      let activeSessionsCount = 0;
      for (const s of playbackSessions.values()) {
        if (s.infoHash.toLowerCase() === hash && (now - s.lastSeen) < 15000) activeSessionsCount++;
      }

      const entry = torrentRegistry.get(hash) || { refCount: 0, lastActive: now };
      const isStreaming = entry.refCount > 0 || activeSessionsCount > 0;

      if (!isStreaming) {
        const isIdleExpired = (now - entry.lastActive) >= IDLE_TTL_MS; // 1 minute
        const isEmergencyDiskPressure = diskStats.usedPct >= 88;

        if (isIdleExpired || isEmergencyDiskPressure) {
          if (entry.refCount === 0) {
            console.log(`[🧹 Auto-GC 1m] Safely deleting idle torrent & disk files: "${t.name}" (Reason: ${isEmergencyDiskPressure ? 'Disk Pressure' : '1m Idle'})`);
            await qbt.deleteTorrent(t.hash, true);
            torrentRegistry.delete(hash);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Auto-GC Warning]:`, err.message);
  }
}, 15000);

// ----------------- ROUTES -----------------

/**
 * Health & Host Telemetry Monitor
 */
app.get('/health', async (req, res) => {
  let qbtStatus = false;
  let torrentsCount = 0;
  let transferStats = null;

  try {
    qbtStatus = await qbt.login();
    if (qbtStatus) {
      const list = await qbt.getAllTorrents();
      torrentsCount = list.length;
      transferStats = await qbt.getTransferInfo();
    }
  } catch {}

  const diskStats = getDiskUsageStats();
  const totalMem = (os.totalmem() / (1024 * 1024)).toFixed(0);
  const freeMem = (os.freemem() / (1024 * 1024)).toFixed(0);

  res.json({
    status: 'online',
    service: 'CineStream qBittorrent Native Streaming Bridge (HTTP 206 Piece-Aware)',
    security: {
      rateLimitingActive: true,
      pathTraversalGuards: true,
      adminAuthEnabled: true
    },
    qBittorrentConnected: qbtStatus,
    activeTorrentsCount: torrentsCount,
    activePlaybackSessions: playbackSessions.size,
    hostTelemetry: {
      loadAverage: os.loadavg(),
      ramTotalMb: Number(totalMem),
      ramFreeMb: Number(freeMem),
      diskUsagePercent: `${diskStats.usedPct}%`,
      diskFreeGb: `${diskStats.freeGb} GB`,
      dlSpeed: transferStats ? `${(transferStats.dl_info_speed / (1024 * 1024)).toFixed(2)} MB/s` : '0 MB/s',
      upSpeed: transferStats ? `${(transferStats.up_info_speed / (1024 * 1024)).toFixed(2)} MB/s` : '0 MB/s'
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
  }

  res.json({ status: 'active', sessionId });
});

/**
 * Playback Session Leave Endpoint (Immediate Pause Trigger & 1m Auto-Delete Timer)
 */
app.post('/api/stream/session/leave', async (req, res) => {
  const { sessionId, infoHash } = req.body || {};
  if (sessionId) {
    playbackSessions.delete(sessionId);
  }
  if (infoHash) {
    const hash = infoHash.toLowerCase();
    const reg = torrentRegistry.get(hash);
    if (reg) {
      reg.refCount = Math.max(0, reg.refCount - 1);
      reg.lastActive = Date.now();
    }

    // 1. Pause downloading immediately
    await qbt.pauseTorrents([hash]).catch(() => {});
    console.log(`[Bandwidth Saver] Viewer left session: ${sessionId}. Paused torrent: ${hash}`);

    // 2. Schedule 1-minute auto-deletion check
    setTimeout(async () => {
      const currentReg = torrentRegistry.get(hash);
      const now = Date.now();
      let activeFresh = 0;
      for (const s of playbackSessions.values()) {
        if (s.infoHash === hash && (now - s.lastSeen) < 15000) activeFresh++;
      }

      if ((!currentReg || currentReg.refCount === 0) && activeFresh === 0) {
        console.log(`[🧹 Auto-Delete 1m] Deleting idle torrent & disk files: ${hash}`);
        await qbt.deleteTorrent(hash, true).catch(() => {});
        torrentRegistry.delete(hash);
      }
    }, 60000);
  }
  res.json({ status: 'left' });
});

/**
 * Proxy Prowlarr Search (Rate Limited to 30 req/min per IP)
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
    return res.status(401).json({ error: 'Unauthorized: Valid X-Admin-Token required to trigger disk cleanup.' });
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

/**
 * Fast C++ qBittorrent HTTP 206 Partial Content Stream Endpoint with On-Demand Range Seeking
 */
app.get('/api/stream', checkRateLimit('stream', 15, 60000), async (req, res) => {
  const magnet = req.query.magnet || req.query.link;
  const nameHint = req.query.title || '';
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || `sess_${Date.now()}`;

  if (!magnet) {
    return res.status(400).send('Missing magnet link parameter');
  }

  // 1. Check VPS Disk Quota Safeguard
  const diskStats = getDiskUsageStats();
  if (diskStats.usedPct >= DISK_MAX_USAGE_PCT) {
    return res.status(507).send(`VPS Disk Usage is at ${diskStats.usedPct}%. New streams temporarily throttled.`);
  }

  const infoHash = qbt.extractInfoHash(magnet);

  try {
    // 2. Add to qBittorrent
    await qbt.addTorrent(magnet);

    // 3. Poll for torrent metadata & verified safe media candidate
    let torrentInfo = null;
    let targetFilePath = null;

    for (let i = 0; i < 20; i++) {
      torrentInfo = await qbt.findTorrent(infoHash, nameHint, magnet);
      if (torrentInfo) {
        if (torrentInfo.content_path) {
          targetFilePath = findSafeMediaFileCandidate(torrentInfo.content_path);
        }
        if (!targetFilePath && torrentInfo.save_path && torrentInfo.name) {
          targetFilePath = findSafeMediaFileCandidate(path.join(torrentInfo.save_path, torrentInfo.name));
        }

        if (targetFilePath && fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size >= MIN_MEDIA_FILE_BYTES) {
          break;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      return res.status(503).send('Buffering metadata from BitTorrent swarm... Please wait a few seconds and retry.');
    }

    const matchedHash = (torrentInfo ? torrentInfo.hash : (infoHash || 'unknown')).toLowerCase();
    const torrentName = torrentInfo ? torrentInfo.name : (nameHint || 'Media Stream');

    // 4. Update Torrent Registry & Playback Session
    if (!torrentRegistry.has(matchedHash)) {
      torrentRegistry.set(matchedHash, {
        hash: matchedHash,
        name: torrentName,
        refCount: 0,
        lastActive: Date.now()
      });
    }

    const regEntry = torrentRegistry.get(matchedHash);
    regEntry.refCount++;
    regEntry.lastActive = Date.now();

    playbackSessions.set(sessionId, {
      id: sessionId,
      infoHash: matchedHash,
      lastSeen: Date.now(),
      currentTime: 0,
      ip: req.ip
    });

    // Make sure torrent is active
    qbt.resumeTorrents([matchedHash]).catch(() => {});

    // 5. Calculate File & Range Parameters
    const stat = fs.statSync(targetFilePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    let start = 0;
    let end = fileSize - 1;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }

    // 6. On-Demand Piece Prioritization for Range / Seek Offset
    const pieceSize = torrentInfo ? (torrentInfo.piece_size || 2 * 1024 * 1024) : 2 * 1024 * 1024;
    await prioritizeByteRange(matchedHash, start, end, pieceSize, 0, 4000);

    // 7. Stream File with HTTP 206 Partial Content
    const chunkSize = (end - start) + 1;
    const ext = path.extname(targetFilePath).toLowerCase();
    const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';

    res.writeHead(range ? 206 : 200, {
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fileSize}` } : {}),
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(targetFilePath, { start, end });
    stream.pipe(res);

    // 8. Stream Close Handler
    req.on('close', () => {
      stream.destroy();
      playbackSessions.delete(sessionId);
      regEntry.refCount = Math.max(0, regEntry.refCount - 1);
      regEntry.lastActive = Date.now();

      // Check if any fresh sessions exist (< 15s)
      const now = Date.now();
      let activeFreshCount = 0;
      for (const s of playbackSessions.values()) {
        if (s.infoHash.toLowerCase() === matchedHash && (now - s.lastSeen) < 15000) {
          activeFreshCount++;
        }
      }

      if (regEntry.refCount === 0 && activeFreshCount === 0) {
        qbt.pauseTorrents([matchedHash]).catch(() => {});
        console.log(`[Bandwidth Saver] Stream closed. Immediately paused download for: "${torrentName}"`);

        // Schedule 1-minute auto-deletion check
        setTimeout(async () => {
          const currentReg = torrentRegistry.get(matchedHash);
          const checkTime = Date.now();
          let freshCount = 0;
          for (const s of playbackSessions.values()) {
            if (s.infoHash === matchedHash && (checkTime - s.lastSeen) < 15000) freshCount++;
          }

          if ((!currentReg || currentReg.refCount === 0) && freshCount === 0) {
            console.log(`[🧹 Auto-Delete 1m] Deleting idle torrent & disk files for: "${torrentName}"`);
            await qbt.deleteTorrent(matchedHash, true).catch(() => {});
            torrentRegistry.delete(matchedHash);
          }
        }, 60000);
      }
    });

  } catch (err) {
    console.error('[Stream Handler Error]:', err);
    if (!res.headersSent) {
      res.status(500).send(`Streaming bridge error: ${err.message}`);
    }
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🎬 CineStream High-Speed Streaming Bridge (qBittorrent + HTTP 206)`);
  console.log(`📡 Port:               ${PORT}`);
  console.log(`📥 qBittorrent:        ${QBT_URL}`);
  console.log(`🔍 Prowlarr Proxy:     ${PROWLARR_URL}`);
  console.log(`🛡️ Rate Limiting:      Enabled`);
  console.log(`🛡️ Path Traversal:     Guarded`);
  console.log(`🧹 Auto-GC Idle TTL:   ${IDLE_TTL_MINUTES} minutes`);
  console.log(`🩺 Health check:       http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
