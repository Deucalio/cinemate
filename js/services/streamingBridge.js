/**
 * Streaming Bridge & Prowlarr / Torznab Search Service
 * Connects CineStream to local/VPS torrent streaming backend and indexer search API
 */

import { store } from '../state/store.js';

export const streamingBridge = {
  /**
   * Get configured Streaming Bridge URL (Local or VPS)
   */
  getStreamServerUrl() {
    return localStorage.getItem('cinestream_stream_server_url') || 'http://77.37.74.7:8888';
  },

  setStreamServerUrl(url) {
    localStorage.setItem('cinestream_stream_server_url', url.replace(/\/$/, ''));
  },

  /**
   * Get configured Prowlarr / Torznab API URL & Key
   */
  getProwlarrConfig() {
    return {
      baseUrl: localStorage.getItem('cinestream_prowlarr_url') || 'http://localhost:9696',
      apiKey: localStorage.getItem('cinestream_prowlarr_key') || '5a197b3359f247e8a69c7866650058e4'
    };
  },

  setProwlarrConfig({ baseUrl, apiKey }) {
    if (baseUrl) localStorage.setItem('cinestream_prowlarr_url', baseUrl.replace(/\/$/, ''));
    if (apiKey) localStorage.setItem('cinestream_prowlarr_key', apiKey.trim());
  },

  /**
   * Search available torrent stream sources for a Movie
   */
  async searchMovieStreams(movieTitle, year = '') {
    const cleanTitle = movieTitle.replace(/[:\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const query = year ? `${cleanTitle} ${year}` : cleanTitle;
    return this.searchIndexer(query);
  },

  /**
   * Search available torrent stream sources for a TV Series Episode
   */
  async searchTVStreams(tvTitle, seasonNumber = 1, episodeNumber = 1) {
    const cleanTitle = tvTitle.replace(/[:\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const s = seasonNumber.toString().padStart(2, '0');
    const e = episodeNumber.toString().padStart(2, '0');
    const query = `${cleanTitle} S${s}E${e}`;
    return this.searchIndexer(query);
  },

  /**
   * Query Prowlarr Indexer API (via VPS Bridge proxy or direct)
   */
  async searchIndexer(query) {
    const serverUrl = this.getStreamServerUrl();
    const proxyEndpoint = `${serverUrl}/api/search?query=${encodeURIComponent(query)}&limit=20`;

    try {
      // 1. Try via VPS bridge proxy (handles loopback & API key automatically)
      const proxyRes = await fetch(proxyEndpoint);
      if (proxyRes.ok) {
        const results = await proxyRes.json();
        return this.parseAndRankReleases(results);
      }
    } catch (e) {
      // Fall through to direct
    }

    // 2. Fallback to direct Prowlarr URL
    try {
      const { baseUrl, apiKey } = this.getProwlarrConfig();
      const endpoint = `${baseUrl}/api/v1/search?query=${encodeURIComponent(query)}&limit=15`;
      const response = await fetch(endpoint, {
        headers: {
          'X-Api-Key': apiKey,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const results = await response.json();
        return this.parseAndRankReleases(results);
      }
    } catch (err) {
      console.warn(`Indexer search failed for "${query}":`, err.message);
    }

    return [];
  },

  /**
   * Parse raw indexer releases into structured stream items with quality tags and seed count
   */
  parseAndRankReleases(rawReleases) {
    if (!Array.isArray(rawReleases)) return [];

    const parsed = rawReleases.map(item => {
      const rawTitle = item.title || item.fileName || 'Unknown Release';
      const magnetUrl = item.guid && item.guid.startsWith('magnet:') ? item.guid : (item.magnetUrl || item.downloadUrl);
      const sizeBytes = item.size || 0;
      const sizeFormatted = sizeBytes > 1073741824
        ? `${(sizeBytes / 1073741824).toFixed(2)} GB`
        : `${(sizeBytes / 1048576).toFixed(0)} MB`;
      const seeders = item.seeders || 0;
      const leechers = item.leechers || 0;
      const indexerName = item.indexer || 'Indexer';

      // Detect resolution
      let resolution = '1080p';
      if (/2160p|4k|uhd/i.test(rawTitle)) resolution = '4K UHD';
      else if (/1080p|fhd/i.test(rawTitle)) resolution = '1080p';
      else if (/720p|hd/i.test(rawTitle)) resolution = '720p';
      else if (/480p|sd/i.test(rawTitle)) resolution = '480p';

      // Detect features
      const isHDR = /hdr|dolby|vision|dv/i.test(rawTitle);
      const isEAC3 = /ddp|dd\+|eac3|ac3|atmos/i.test(rawTitle);
      const isDTS = /dts/i.test(rawTitle);
      const isAAC = /aac|mp3|stereo|2\.0/i.test(rawTitle) || !isEAC3;
      const audioBadge = isEAC3 ? 'Dolby 5.1/Atmos' : (isDTS ? 'DTS 5.1' : 'AAC Stereo ✓');
      const isAtmos = isEAC3 || isDTS;
      const codec = /hevc|x265|h265/i.test(rawTitle) ? 'HEVC' : (/x264|h264/i.test(rawTitle) ? 'H.264' : 'Web');
      const isUniversal = isAAC && (codec === 'H.264' || /\.mp4/i.test(rawTitle));

      return {
        title: rawTitle,
        magnet: magnetUrl,
        infoHash: item.infoHash,
        size: sizeFormatted,
        seeders,
        leechers,
        resolution,
        isHDR,
        isAtmos,
        isAAC,
        audioBadge,
        codec,
        isUniversal,
        indexer: indexerName,
        publishDate: item.publishDate
      };
    });

    // Filter items with magnet and sort by compatibility & seeders descending
    return parsed
      .filter(item => Boolean(item.magnet))
      .sort((a, b) => {
        // Prioritize universal browser playback if seeders are comparable
        if (a.isUniversal && !b.isUniversal && (a.seeders >= 5)) return -1;
        if (!a.isUniversal && b.isUniversal && (b.seeders >= 5)) return 1;
        return (b.seeders || 0) - (a.seeders || 0);
      });
  },

  /**
   * Construct HTTP Stream URL for HTML5 <video>
   */
  getStreamUrl(magnetOrLink, releaseTitle = '', sessionId = null, fileIndex = null, startSec = 0) {
    const serverUrl = this.getStreamServerUrl();
    let url = `${serverUrl}/api/stream?magnet=${encodeURIComponent(magnetOrLink)}`;
    if (releaseTitle) {
      url += `&title=${encodeURIComponent(releaseTitle)}`;
    }
    if (sessionId) {
      url += `&sessionId=${encodeURIComponent(sessionId)}`;
    }
    if (fileIndex !== null) {
      url += `&fileIndex=${fileIndex}`;
    }
    if (startSec > 0) {
      url += `&startSec=${Math.floor(startSec)}`;
    }
    return url;
  },

  /**
   * Send Playback Session Heartbeat (Every 10s while player is active)
   */
  async sendHeartbeat(sessionId, infoHash, currentTime = 0) {
    if (!sessionId || !infoHash) return;
    const serverUrl = this.getStreamServerUrl();
    try {
      await fetch(`${serverUrl}/api/stream/session/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, infoHash, currentTime })
      });
    } catch {}
  },

  /**
   * Check if Streaming Server is reachable
   */
  async checkServerHealth() {
    const serverUrl = this.getStreamServerUrl();
    try {
      const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      return null;
    }
    return null;
  }
};
