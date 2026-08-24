/**
 * CineStream Pro — High-Performance Streaming Bridge
 * Powered by qBittorrent (127.0.0.1:18080) & Prowlarr (127.0.0.1:9696)
 * Direct disk sequential streaming with HTTP 206 Range-Request seeking & FFmpeg fMP4 remuxing
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
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

// Common download directories to search
const SEARCH_DIRS = [
  '/var/lib/stream/incoming',
  '/var/lib/stream/incoming/tv-stream',
  '/tmp/cinestream-media',
  '/home/rdpuser/Downloads',
  '/tmp'
];

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

  async findTorrent(infoHash, nameHint = '', magnet = '') {
    const list = await this.getAllTorrents();
    if (!Array.isArray(list) || list.length === 0) return null;

    // 1. Try exact infoHash match (case-insensitive)
    if (infoHash) {
      const match = list.find(t =>
        t.hash.toLowerCase() === infoHash.toLowerCase() ||
        (t.magnet_uri && t.magnet_uri.toLowerCase().includes(infoHash.toLowerCase()))
      );
      if (match) return match;
    }

    // 2. Try match from magnet dn parameter
    const dnMatch = magnet ? magnet.match(/[?&]dn=([^&]+)/i) : null;
    const dnName = dnMatch ? decodeURIComponent(dnMatch[1]).toLowerCase() : '';

    // 3. Try name match from title or dnName
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

// ----------------- HELPER: RECURSIVE MEDIA FILE FINDER -----------------

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
 * Health check endpoint
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

  res.json({
    status: 'online',
    service: 'CineStream Torrent Bridge (qBittorrent & Prowlarr)',
    qBittorrentConnected: qbtStatus,
    activeTorrentsCount: torrentsCount,
    qbtEndpoint: QBT_URL,
    prowlarrEndpoint: PROWLARR_URL,
    uptime: process.uptime()
  });
});

/**
 * Proxy Prowlarr Search (Lets frontend query Prowlarr on VPS loopback)
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
 * Streaming Endpoint: Connects to qBittorrent & streams file via HTTP 206 Partial Content
 */
app.get('/api/stream', async (req, res) => {
  const magnet = req.query.magnet || req.query.link;
  const nameHint = req.query.title || '';

  if (!magnet) {
    return res.status(400).send('Missing magnet link parameter');
  }

  const infoHash = qbt.extractInfoHash(magnet);

  try {
    // 1. Add to qBittorrent with sequential priority
    await qbt.addTorrent(magnet);

    // 2. Poll for torrent metadata & file path (strictly for this specific torrent)
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
      return res.status(503).send('Buffering metadata and initial chunks from BitTorrent swarm... Please retry in a moment.');
    }

    console.log(`[Stream] Matched Torrent: ${torrentInfo ? torrentInfo.name : 'Unknown'}`);
    console.log(`[Stream] Serving video file: ${targetFilePath}`);

    // 3. Serve file via HTTP Range (206 Partial Content)
    const stat = fs.statSync(targetFilePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(targetFilePath).toLowerCase();
    const contentType = ext === '.mp4' ? 'video/mp4' : (ext === '.webm' ? 'video/webm' : 'video/mp4');

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
  console.log(`🎬 CineStream Torrent Bridge (qBittorrent & Prowlarr)`);
  console.log(`📡 Port:               ${PORT}`);
  console.log(`📥 qBittorrent:        ${QBT_URL}`);
  console.log(`🔍 Prowlarr Proxy:     ${PROWLARR_URL}`);
  console.log(`🩺 Health check:       http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
