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
    const saved = localStorage.getItem('cinestream_stream_server_url');
    // ':8888' was an old default that no longer matches the bridge's port; ignore it if stored.
    if (saved && !saved.includes(':8888')) return saved;

    const env = import.meta.env || {};
    return (env.VITE_STREAM_SERVER || 'http://127.0.0.1:8899').replace(/\/$/, '');
  },

  setStreamServerUrl(url) {
    localStorage.setItem('cinestream_stream_server_url', url.replace(/\/$/, ''));
  },

  /**
   * Get configured Prowlarr / Torznab API URL & Key
   */
  getProwlarrConfig() {
    const env = import.meta.env || {};
    return {
      baseUrl: localStorage.getItem('cinestream_prowlarr_url') || env.VITE_PROWLARR_URL || 'http://localhost:9696',
      // Only used by the direct-to-Prowlarr fallback; the normal path proxies through the bridge,
      // which holds the real key server-side.
      apiKey: localStorage.getItem('cinestream_prowlarr_key') || env.VITE_PROWLARR_KEY || ''
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

      // Detect features.
      // NOTE: HDR and Dolby ATMOS are unrelated (one is video, one is audio) — matching /dolby/
      // for HDR mislabels every DDP release as HDR, so Dolby Vision is matched explicitly.
      const isHDR = /\bhdr(10)?\b|dolby\s*vision|\bdv\b/i.test(rawTitle);
      const isEAC3 = /ddp|dd\+|eac3|e-ac3|ac3|atmos|truehd/i.test(rawTitle);
      const isDTS = /\bdts\b/i.test(rawTitle);
      // Previously `|| !isEAC3` — which declared every release without a Dolby tag to be AAC,
      // so untagged 5.1 releases were badged "AAC Stereo ✓" and ranked as browser-safe.
      const isAAC = /\baac\b|\bmp3\b|stereo|\b2\.0\b/i.test(rawTitle) && !isEAC3 && !isDTS;
      const audioBadge = isEAC3 ? 'Dolby 5.1/Atmos' : (isDTS ? 'DTS 5.1' : (isAAC ? 'AAC Stereo ✓' : 'Audio unknown'));
      const isAtmos = isEAC3 || isDTS;
      const isHEVC = /hevc|x265|h265/i.test(rawTitle);
      const codec = isHEVC ? 'HEVC' : (/x264|h264|avc/i.test(rawTitle) ? 'H.264' : 'Web');
      // Browsers cannot decode HEVC in MP4, so an HEVC release is never "universal" however it is
      // tagged. Anything else still plays after a server-side audio remux.
      const isUniversal = isAAC && !isHEVC && (codec === 'H.264' || /\.mp4|\bmp4\b/i.test(rawTitle));

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

    // Rank by how likely the release is to actually play, then by swarm health.
    const playabilityScore = (item) => {
      if (item.codec === 'HEVC') return 0;   // browsers cannot decode it at all
      if (item.isUniversal) return 3;        // plays directly, no server CPU
      if (item.codec === 'H.264') return 2;  // plays after a cheap audio-only remux
      return 1;
    };

    return parsed
      .filter(item => Boolean(item.magnet))
      .sort((a, b) => {
        const diff = playabilityScore(b) - playabilityScore(a);
        if (diff !== 0) return diff;
        return (b.seeders || 0) - (a.seeders || 0);
      });
  },

  /**
   * Ask the bridge to resolve a magnet and describe how it will be delivered, BEFORE handing the
   * URL to <video>. A video element only ever reports an opaque MEDIA_ERR_* code, so without this
   * the UI cannot tell "no seeders" from "unsupported codec" from "disk full".
   *
   * Resolves to the bridge's JSON: { ok: true, mode, durationSec, seekable, video, audio, ... }
   * or { ok: false, code, error }.
   */
  async prepareStream(magnetOrLink, releaseTitle = '', sessionId = null) {
    const serverUrl = this.getStreamServerUrl();
    let url = `${serverUrl}/api/stream/prepare?magnet=${encodeURIComponent(magnetOrLink)}`;
    if (releaseTitle) url += `&title=${encodeURIComponent(releaseTitle)}`;
    if (sessionId) url += `&sessionId=${encodeURIComponent(sessionId)}`;

    try {
      // Swarm metadata can legitimately take ~25s on a cold torrent.
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const data = await res.json().catch(() => null);
      if (data) return data;
      return { ok: false, code: 'BAD_RESPONSE', error: `Bridge returned HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        code: 'UNREACHABLE',
        error: `Could not reach the streaming bridge at ${serverUrl} (${err.message}).`
      };
    }
  },

  /**
   * Cheap download-progress poll, safe to call every couple of seconds.
   * Returns { ok, state, ready, progress, progressPercent, dlSpeed, etaSeconds, seeds, ... }.
   */
  async getStreamStatus(magnetOrLink, releaseTitle = '') {
    const serverUrl = this.getStreamServerUrl();
    let url = `${serverUrl}/api/stream/status?magnet=${encodeURIComponent(magnetOrLink)}`;
    if (releaseTitle) url += `&title=${encodeURIComponent(releaseTitle)}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json().catch(() => null);
      return data || { ok: false, error: `Bridge returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Construct the HTTP stream URL for an HTML5 <video>.
   * `mode` is 'direct' (native byte-range seeking) or 'remux' (progressive fMP4 from FFmpeg).
   */
  getStreamUrl(magnetOrLink, releaseTitle = '', sessionId = null, startSec = 0, mode = null, durationSec = 0) {
    const serverUrl = this.getStreamServerUrl();
    let url = `${serverUrl}/api/stream?magnet=${encodeURIComponent(magnetOrLink)}`;
    if (releaseTitle) {
      url += `&title=${encodeURIComponent(releaseTitle)}`;
    }
    if (sessionId) {
      url += `&sessionId=${encodeURIComponent(sessionId)}`;
    }
    if (startSec > 0) {
      url += `&startSec=${Math.floor(startSec)}`;
    }
    if (mode) {
      url += `&mode=${encodeURIComponent(mode)}`;
    }
    if (durationSec > 0) {
      url += `&duration=${Math.floor(durationSec)}`;
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
   * Tell the bridge a playback session ended so it can stop spending swarm bandwidth immediately
   * rather than waiting out the idle grace window.
   */
  sendLeave(sessionId, infoHash) {
    if (!sessionId || !infoHash) return;
    const serverUrl = this.getStreamServerUrl();
    const payload = JSON.stringify({ sessionId, infoHash });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(`${serverUrl}/api/stream/session/leave`, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(`${serverUrl}/api/stream/session/leave`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        }).catch(() => {});
      }
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
