/**
 * CineStream Pro — Torrent HTTP Streaming Bridge Server
 * Streams BitTorrent magnets & torrent files over HTTP with full 206 Partial Content (Range Requests)
 */

import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8888;

// Enable CORS for all origins & range request headers
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Accept', 'X-Requested-With', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

app.use(express.json());

// Initialize WebTorrent Client
const client = new WebTorrent({
  maxConns: 80,
  dht: true,
  webSeeds: true
});

// Video MIME type dictionary
const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/webm', // Many browsers play WebM/MKV VP8/VP9/H264 stream
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4'
};

function getMimeType(fileName) {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] || 'video/mp4';
}

function findLargestVideoFile(files) {
  const videoFiles = files.filter(file => {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    return MIME_TYPES[ext] !== undefined;
  });

  if (videoFiles.length === 0) {
    // If no explicit extension matched, find the largest file overall
    return files.reduce((prev, current) => (prev.length > current.length) ? prev : current);
  }

  // Return largest video file (main feature)
  return videoFiles.reduce((prev, current) => (prev.length > current.length) ? prev : current);
}

// Active stream activity trackers for garbage collection
const activeTorrents = new Map();

function trackTorrentActivity(infoHash) {
  activeTorrents.set(infoHash, {
    lastAccessed: Date.now()
  });
}

// Periodic cleanup of idle torrents (after 30 minutes of inactivity)
setInterval(() => {
  const now = Date.now();
  for (const [infoHash, data] of activeTorrents.entries()) {
    if (now - data.lastAccessed > 1800000) { // 30 minutes
      const torrent = client.get(infoHash);
      if (torrent) {
        console.log(`[GC] Destroying inactive torrent: ${torrent.name || infoHash}`);
        torrent.destroy();
      }
      activeTorrents.delete(infoHash);
    }
  }
}, 300000); // Check every 5 minutes

// ----------------- ROUTES -----------------

function getOrCreateTorrent(torrentId, callback) {
  let torrent = client.get(torrentId);

  if (torrent) {
    if (torrent.ready) {
      return callback(null, torrent);
    }
    torrent.on('ready', () => callback(null, torrent));
    torrent.on('error', (err) => callback(err));
    return;
  }

  try {
    torrent = client.add(torrentId, { destroyStoreOnDestroy: true }, (t) => {
      callback(null, t);
    });

    torrent.on('error', (err) => {
      console.error('[Torrent Error]:', err.message);
    });
  } catch (err) {
    // If already added
    const fallback = client.get(torrentId);
    if (fallback) {
      if (fallback.ready) return callback(null, fallback);
      fallback.on('ready', () => callback(null, fallback));
      return;
    }
    callback(err);
  }
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'CineStream Torrent Bridge',
    activeTorrents: client.torrents.length,
    downloadSpeed: client.downloadSpeed,
    uploadSpeed: client.uploadSpeed,
    ratio: client.ratio,
    uptime: process.uptime()
  });
});

/**
 * Torrent Info Endpoint
 */
app.get('/api/torrent-info', (req, res) => {
  const torrentId = req.query.magnet || req.query.link;
  if (!torrentId) {
    return res.status(400).json({ error: 'Missing magnet or link query parameter' });
  }

  getOrCreateTorrent(torrentId, (err, torrent) => {
    if (err || !torrent) {
      return res.status(500).json({ error: err ? err.message : 'Could not resolve torrent' });
    }

    trackTorrentActivity(torrent.infoHash);
    res.json({
      name: torrent.name,
      infoHash: torrent.infoHash,
      totalLength: torrent.length,
      numPeers: torrent.numPeers,
      progress: torrent.progress,
      downloadSpeed: torrent.downloadSpeed,
      files: (torrent.files || []).map((f, idx) => ({
        index: idx,
        name: f.name,
        length: f.length,
        path: f.path
      }))
    });
  });
});

/**
 * HTTP Range-Request Video Streaming Endpoint
 * Pipes the chosen video file directly to the client with sequential piece priority
 */
app.get('/api/stream', (req, res) => {
  const torrentId = req.query.magnet || req.query.link;
  const fileIndex = req.query.fileIndex !== undefined ? parseInt(req.query.fileIndex, 10) : null;

  if (!torrentId) {
    return res.status(400).send('Missing magnet or link query parameter');
  }

  getOrCreateTorrent(torrentId, (err, torrent) => {
    if (err || !torrent) {
      return res.status(500).send(err ? err.message : 'Failed to load torrent');
    }

    trackTorrentActivity(torrent.infoHash);

    // Select target video file
    let file = null;
    if (fileIndex !== null && fileIndex >= 0 && fileIndex < torrent.files.length) {
      file = torrent.files[fileIndex];
    } else {
      file = findLargestVideoFile(torrent.files);
    }

    if (!file) {
      return res.status(404).send('No compatible video file found in torrent');
    }

    const total = file.length;
    const range = req.headers.range;
    const mimeType = getMimeType(file.name);

    // Enable sequential downloading for instant start
    if (torrent.deselect) {
      torrent.deselect(0, torrent.pieces.length - 1, false);
    }
    file.select();

    if (!range) {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      });
      return file.createReadStream().pipe(res);
    }

    // Parse HTTP Range header (e.g. "bytes=1048576-")
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunkSize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache'
    });

    const stream = file.createReadStream({ start, end });
    stream.pipe(res);

    req.on('close', () => {
      stream.destroy();
    });
  });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🎬 CineStream Torrent Bridge running on port ${PORT}`);
  console.log(`📡 Local Stream URL:   http://localhost:${PORT}/api/stream`);
  console.log(`🩺 Health check:       http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
