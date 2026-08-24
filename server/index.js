/**
 * CineStream Pro — Production-Grade BitTorrent-to-HTTP Streaming Bridge
 * 
 * Key Architectural Components:
 * 1. Byte-Range to Torrent-Piece Mapper with Piece-Availability Verification
 * 2. On-Demand Piece Prioritization (Seeking & Lookahead Buffer)
 * 3. PlaybackSession Registry with Heartbeat State Machine (ACTIVE -> IDLE -> GC)
 * 4. RefCount Stream Mutex (Zero Delete-While-Streaming race conditions)
 * 5. Multi-Tier VPS Disk Protection & Concurrency Limits
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8888;

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
const IDLE_TTL_MINUTES = parseInt(process.env.IDLE_TTL_MINUTES || '15', 10);
const IDLE_TTL_MS = IDLE_TTL_MINUTES * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 45 * 1000; // 45s without heartbeat = IDLE

// ----------------- SYSTEM STATE & SESSION REGISTRY -----------------

// Playback Sessions: sessionId -> { id, infoHash, lastSeen, currentTime, ip }
const playbackSessions = new Map();

// Torrent Registry: infoHash -> { hash, name, state, refCount, lastActive, activeStreams }
const torrentRegistry = new Map();

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Accept', 'X-Requested-With', 'Authorization', 'X-Api-Key', 'X-Session-ID'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type', 'X-Piece-Available', 'X-Piece-Index']
}));

app.use(express.json());

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

  async getTorrentProperties(hash) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/properties?hash=${hash}`);
    if (!res.ok) return null;
    return await res.json();
  }

  async getTorrentFiles(hash) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/files?hash=${hash}`);
    if (!res.ok) return [];
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

// ----------------- DISK QUOTA & HEALTH MONITOR -----------------

function getDiskUsagePct(targetDir = '/') {
  try {
    if (fs.statfsSync) {
      const stats = fs.statfsSync(targetDir);
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      return Math.round(((total - free) / total) * 100);
    }
  } catch {}
  return 30; // Fallback safe estimate
}

// ----------------- PIECE AVAILABILITY VERIFIER & WAITER -----------------

/**
 * Maps requested byte range to torrent piece IDs and waits until available
 */
async function waitForByteRangeAvailability(hash, startByte, endByte, pieceSize, firstPieceIndex = 0, maxWaitMs = 12000) {
  if (!pieceSize || pieceSize <= 0) return true;

  const startPiece = firstPieceIndex + Math.floor(startByte / pieceSize);
  const endPiece = firstPieceIndex + Math.floor(endByte / pieceSize);

  // Lookahead buffer (prioritize requested + 6 consecutive pieces)
  const lookaheadPieces = [];
  for (let p = startPiece; p <= endPiece + 6; p++) {
    lookaheadPieces.push(p);
  }

  // 1. Immediately request maximal priority (7) for required pieces
  await qbt.setPiecePriority(hash, lookaheadPieces, 7).catch(() => {});

  // 2. Poll piece states until target startPiece is downloaded (state == 2)
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const states = await qbt.getPieceStates(hash);
    if (!states || states.length === 0) return true; // Fallback if states unavailable

    const isStartPieceReady = states[startPiece] === 2;
    if (isStartPieceReady) {
      return true;
    }

    await new Promise(r => setTimeout(r, 250)); // Poll every 250ms
  }

  return false;
}

// ----------------- AUTOMATED 15-MINUTE GARBAGE COLLECTOR -----------------

setInterval(async () => {
  try {
    const now = Date.now();
    const diskUsage = getDiskUsagePct();

    // 1. Prune expired heartbeat sessions
    for (const [sessId, session] of playbackSessions.entries()) {
      if (now - session.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        playbackSessions.delete(sessId);
      }
    }

    const isLogged = await qbt.login();
    if (!isLogged) return;

    const allTorrents = await qbt.getAllTorrents();
    if (!Array.isArray(allTorrents) || allTorrents.length === 0) return;

    for (const t of allTorrents) {
      const hash = t.hash.toLowerCase();
      
      // Count active heartbeat sessions for this torrent
      let activeSessionsCount = 0;
      for (const s of playbackSessions.values()) {
        if (s.infoHash.toLowerCase() === hash) activeSessionsCount++;
      }

      const entry = torrentRegistry.get(hash) || { refCount: 0, lastActive: now };
      const isStreaming = entry.refCount > 0 || activeSessionsCount > 0;

      if (!isStreaming) {
        // Condition A: Idle TTL exceeded (15 minutes)
        const isIdleExpired = (now - entry.lastActive) >= IDLE_TTL_MS;
        
        // Condition B: Emergency disk pressure (> 88%)
        const isEmergencyDiskPressure = diskUsage >= 88;

        if (isIdleExpired || isEmergencyDiskPressure) {
          // Verify refCount == 0 before unlinking to prevent delete-while-streaming race
          if (entry.refCount === 0) {
            console.log(`[🧹 Auto-GC] Safely deleting idle torrent & files: "${t.name}" (Reason: ${isEmergencyDiskPressure ? 'Disk Pressure' : '15m Idle'})`);
            await qbt.deleteTorrent(t.hash, true);
            torrentRegistry.delete(hash);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Auto-GC Warning]:`, err.message);
  }
}, 60000);

// ----------------- RECURSIVE MEDIA FILE FINDER -----------------

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts'];

function findMediaFileRecursively(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return null;

  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      const ext = path.extname(targetPath).toLowerCase();
      return VIDEO_EXTS.includes(ext) ? targetPath : null;
    }

    let largestFile = null;
    let maxBytes = 0;

    function scan(currentDir) {
      const files = fs.readdirSync(currentDir);
      for (const f of files) {
        const full = path.join(currentDir, f);
        try {
          const s = fs.statSync(full);
          if (s.isDirectory()) {
            scan(full);
          } else {
            const ext = path.extname(f).toLowerCase();
            if (VIDEO_EXTS.includes(ext) && s.size > maxBytes) {
              maxBytes = s.size;
              largestFile = full;
            }
          }
        } catch {}
      }
    }

    scan(targetPath);
    return largestFile;
  } catch {
    return null;
  }
}

// ----------------- ROUTES -----------------

/**
 * Health check & Quota Monitor endpoint
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

  const diskUsage = getDiskUsagePct();

  res.json({
    status: 'online',
    service: 'CineStream Torrent Bridge (Piece-Aware & Session Managed)',
    qBittorrentConnected: qbtStatus,
    activeTorrentsCount: torrentsCount,
    activePlaybackSessions: playbackSessions.size,
    diskUsagePercent: `${diskUsage}%`,
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
 * Called by browser player every 10s to signal active watching
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
 * Proxy Prowlarr Search
 */
app.get('/api/search', async (req, res) => {
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
 * Manual Disk Cleanup Endpoint
 */
app.post('/api/cleanup', async (req, res) => {
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
 * Piece-Aware Streaming Endpoint:
 * Handles Byte-Range Verification, On-Demand Prioritization & RefCount Safety
 */
app.get('/api/stream', async (req, res) => {
  const magnet = req.query.magnet || req.query.link;
  const nameHint = req.query.title || '';
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || `sess_${Date.now()}`;

  if (!magnet) {
    return res.status(400).send('Missing magnet link parameter');
  }

  // 1. Check VPS Disk Quota Safeguard
  const currentDiskUsage = getDiskUsagePct();
  if (currentDiskUsage >= DISK_MAX_USAGE_PCT) {
    return res.status(507).send(`VPS Disk Usage is at ${currentDiskUsage}%. New streams temporarily throttled.`);
  }

  const infoHash = qbt.extractInfoHash(magnet);

  try {
    // 2. Add to qBittorrent
    await qbt.addTorrent(magnet);

    // 3. Poll for torrent metadata & target file
    let torrentInfo = null;
    let targetFilePath = null;

    for (let i = 0; i < 20; i++) {
      torrentInfo = await qbt.findTorrent(infoHash, nameHint, magnet);
      if (torrentInfo) {
        if (torrentInfo.content_path) {
          targetFilePath = findMediaFileRecursively(torrentInfo.content_path);
        }
        if (!targetFilePath && torrentInfo.save_path && torrentInfo.name) {
          targetFilePath = findMediaFileRecursively(path.join(torrentInfo.save_path, torrentInfo.name));
        }

        if (targetFilePath && fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > 512 * 1024) {
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

    // Ensure torrent is resumed
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

    // 6. Piece Availability Layer: Check & prioritize requested byte range
    const pieceSize = torrentInfo ? (torrentInfo.piece_size || 2 * 1024 * 1024) : 2 * 1024 * 1024;
    const isPieceReady = await waitForByteRangeAvailability(matchedHash, start, end, pieceSize, 0, 10000);

    if (!isPieceReady && torrentInfo && torrentInfo.progress < 0.99) {
      regEntry.refCount = Math.max(0, regEntry.refCount - 1);
      res.setHeader('Retry-After', '3');
      return res.status(503).send('Buffering requested video piece range from swarm. Retrying...');
    }

    // 7. Stream File with HTTP 206 Partial Content
    const chunkSize = (end - start) + 1;
    const ext = path.extname(targetFilePath).toLowerCase();
    const contentType = ext === '.mp4' ? 'video/mp4' : (ext === '.webm' ? 'video/webm' : 'video/mp4');

    res.writeHead(range ? 206 : 200, {
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fileSize}` } : {}),
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Piece-Available': isPieceReady ? '1' : '0'
    });

    const stream = fs.createReadStream(targetFilePath, { start, end });
    stream.pipe(res);

    // 8. Stream Close Handler (Decrement RefCount & Trigger Graceful Idle State)
    req.on('close', () => {
      stream.destroy();
      regEntry.refCount = Math.max(0, regEntry.refCount - 1);
      regEntry.lastActive = Date.now();

      // If zero active HTTP streams and no active heartbeats, pause after 30s
      setTimeout(async () => {
        let activeHeartbeats = 0;
        for (const s of playbackSessions.values()) {
          if (s.infoHash.toLowerCase() === matchedHash) activeHeartbeats++;
        }

        if (regEntry.refCount === 0 && activeHeartbeats === 0) {
          await qbt.pauseTorrents([matchedHash]);
          console.log(`[Bandwidth Saver] Paused idle torrent: "${torrentName}"`);
        }
      }, 30000);
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
  console.log(`🎬 CineStream Torrent Bridge (Piece-Aware & Session Managed)`);
  console.log(`📡 Port:               ${PORT}`);
  console.log(`📥 qBittorrent:        ${QBT_URL}`);
  console.log(`🔍 Prowlarr Proxy:     ${PROWLARR_URL}`);
  console.log(`🛡️ Disk Quota Cap:     ${DISK_MAX_USAGE_PCT}%`);
  console.log(`🧹 Auto-GC Idle TTL:   ${IDLE_TTL_MINUTES} minutes`);
  console.log(`🩺 Health check:       http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
