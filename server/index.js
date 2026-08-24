/**
 * CineStream Pro — High-Performance Streaming Bridge
 * Powered by qBittorrent (127.0.0.1:18080) & Prowlarr (127.0.0.1:9696)
 * Direct disk sequential streaming with HTTP 206 Range-Request seeking
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
const QBT_SAVE_PATH = process.env.QBT_SAVE_PATH || '/tmp/cinestream-media';

const PROWLARR_URL = process.env.PROWLARR_URL || 'http://127.0.0.1:9696';
const PROWLARR_KEY = process.env.PROWLARR_KEY || '5a197b3359f247e8a69c7866650058e4';

// Ensure download directory exists
if (!fs.existsSync(QBT_SAVE_PATH)) {
  try {
    fs.mkdirSync(QBT_SAVE_PATH, { recursive: true });
  } catch (e) {
    console.warn(`Could not create ${QBT_SAVE_PATH}, fallback to /tmp`);
  }
}

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Accept', 'X-Requested-With', 'Authorization', 'X-Api-Key'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
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
        console.log(`[qBittorrent] Logged in successfully`);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[qBittorrent] Login failed:`, err.message);
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
      // Re-login and retry
      await this.login();
      if (this.cookie) headers['Cookie'] = this.cookie;
      res = await fetch(url, { ...options, headers });
    }
    return res;
  }

  extractInfoHash(magnet) {
    const match = magnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  async addTorrent(magnet, savePath = QBT_SAVE_PATH) {
    await this.login();

    const formData = new URLSearchParams();
    formData.append('urls', magnet);
    formData.append('savepath', savePath);
    formData.append('sequentialDownload', 'true');
    formData.append('firstLastPiecePrio', 'true');

    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    return res.ok;
  }

  async getTorrentInfo(infoHash) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/info?hashes=${infoHash}`);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  }

  async getTorrentFiles(infoHash) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/v2/torrents/files?hash=${infoHash}`);
    if (!res.ok) return [];
    return await res.json();
  }
}

const qbt = new QBittorrentClient(QBT_URL, QBT_USER, QBT_PASS);

// ----------------- HELPER: LOCATE VIDEO FILE ON DISK -----------------

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts'];

function findMediaFileRecursively(dir) {
  if (!fs.existsSync(dir)) return null;

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    const ext = path.extname(dir).toLowerCase();
    return VIDEO_EXTS.includes(ext) ? dir : null;
  }

  let largestFile = null;
  let maxBytes = 0;

  function scan(currentDir) {
    const files = fs.readdirSync(currentDir);
    for (const f of files) {
      const fullPath = path.join(currentDir, f);
      const s = fs.statSync(fullPath);
      if (s.isDirectory()) {
        scan(fullPath);
      } else {
        const ext = path.extname(f).toLowerCase();
        if (VIDEO_EXTS.includes(ext) && s.size > maxBytes) {
          maxBytes = s.size;
          largestFile = fullPath;
        }
      }
    }
  }

  scan(dir);
  return largestFile;
}

// ----------------- ROUTES -----------------

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
  let qbtStatus = false;
  try {
    qbtStatus = await qbt.login();
  } catch {}

  res.json({
    status: 'online',
    service: 'CineStream Torrent Bridge (qBittorrent & Prowlarr)',
    qBittorrentConnected: qbtStatus,
    qbtEndpoint: QBT_URL,
    prowlarrEndpoint: PROWLARR_URL,
    uptime: process.uptime()
  });
});

/**
 * Proxy Prowlarr Search (Lets frontend search VPS Prowlarr on 127.0.0.1 without tunnel)
 */
app.get('/api/search', async (req, res) => {
  const query = req.query.query;
  const limit = req.query.limit || 15;

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
 * Streaming Endpoint: Adds magnet to qBittorrent & streams file via HTTP 206 Partial Content
 */
app.get('/api/stream', async (req, res) => {
  const magnet = req.query.magnet || req.query.link;
  if (!magnet) {
    return res.status(400).send('Missing magnet link parameter');
  }

  const infoHash = qbt.extractInfoHash(magnet);

  try {
    // 1. Add to qBittorrent with sequential priority
    await qbt.addTorrent(magnet);

    // 2. Poll for torrent metadata & file path (up to 12 seconds)
    let torrentInfo = null;
    let targetFilePath = null;

    for (let i = 0; i < 12; i++) {
      if (infoHash) {
        torrentInfo = await qbt.getTorrentInfo(infoHash);
      }
      if (torrentInfo && torrentInfo.content_path) {
        targetFilePath = findMediaFileRecursively(torrentInfo.content_path);
        if (targetFilePath && fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > 1024 * 1024) {
          break;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // If content_path not yet created, search download dir directly
    if (!targetFilePath && torrentInfo && torrentInfo.name) {
      const directPath = path.join(QBT_SAVE_PATH, torrentInfo.name);
      targetFilePath = findMediaFileRecursively(directPath);
    }

    // 3. Fallback check inside download dir
    if (!targetFilePath) {
      targetFilePath = findMediaFileRecursively(QBT_SAVE_PATH);
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      return res.status(503).send('Buffering metadata from BitTorrent swarm... Please retry in a few seconds.');
    }

    // 4. Stream media file with HTTP 206 Partial Content (Range Requests)
    const stat = fs.statSync(targetFilePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(targetFilePath).toLowerCase();
    const contentType = ext === '.mp4' ? 'video/mp4' : (ext === '.webm' || ext === '.mkv' ? 'video/webm' : 'video/mp4');

    if (!range) {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(targetFilePath).pipe(res);
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(targetFilePath, { start, end });
    stream.pipe(res);

    req.on('close', () => {
      stream.destroy();
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
  console.log(`🎬 CineStream Torrent Bridge (qBittorrent Powered)`);
  console.log(`📡 Port:               ${PORT}`);
  console.log(`📥 qBittorrent:        ${QBT_URL}`);
  console.log(`🔍 Prowlarr Proxy:     ${PROWLARR_URL}`);
  console.log(`🩺 Health check:       http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
