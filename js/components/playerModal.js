/**
 * Cinematic Video Streaming Player Modal Component
 * Full-featured player with custom controls, quality toggle, audio/subtitles, progress tracking,
 * live Torrent Stream Sources selector (Prowlarr/Torznab), direct Magnet Link streaming, and VPS Bridge Settings
 */

import { store } from '../state/store.js';
import { streamingBridge } from '../services/streamingBridge.js';
import { toast } from './toast.js';

export class PlayerModalManager {
  constructor() {
    this.modal = null;
    this.currentMovie = null;
    this.videoElement = null;
    this.progressTimer = null;
    this.duration = 7200; // 2 hours default
    this.currentTime = 0;
    this.isPlaying = false;
    this.currentStreamTitle = null;
  }

  open(movie, options = {}) {
    this.close();

    this.currentMovie = movie;
    const isTV = movie.media_type === 'tv' || (!movie.title && movie.name);
    const title = movie.title || movie.name;
    const releaseDate = movie.release_date || movie.first_air_date || '';
    const year = releaseDate ? releaseDate.substring(0, 4) : '';
    const season = options.season || 1;
    const episode = options.episode || 1;
    const existingProgress = store.getMovieProgress(movie.id);

    // Accurate runtime calculation from TMDB
    const runtimeMinutes = movie.runtime || (movie.episode_run_time && movie.episode_run_time[0]) || (isTV ? 55 : 120);
    this.totalRuntimeSeconds = runtimeMinutes * 60;

    // Initial starting time
    this.currentTime = (existingProgress && existingProgress.currentTime) ? existingProgress.currentTime : 0;
    this.duration = this.totalRuntimeSeconds;

    const modal = document.createElement('div');
    modal.className = 'player-modal-backdrop animate-fade-in';
    modal.id = 'streaming-player-modal';

    modal.innerHTML = `
      <div class="player-container" id="player-container">
        <!-- Video Element -->
        <video class="main-video-element" id="main-video-element" preload="auto" playsinline crossorigin="anonymous">
          <source src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4" type="video/mp4">
        </video>

        <!-- Player Top Bar Overlay -->
        <div class="player-top-bar animate-fade-in">
          <button class="player-btn-back" id="player-btn-back" title="Exit Player">
            <span class="btn-icon">←</span>
            <span class="btn-text">Back to CineStream</span>
          </button>

          <div class="player-title-info">
            <h2 class="player-video-title">${_escape(title)}</h2>
            ${isTV ? `<span class="player-episode-badge">S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}</span>` : ''}
            <span class="player-stream-source-badge" id="player-active-source-badge" style="display:none;"></span>
          </div>

          <div class="player-top-actions">
            <!-- Torrent Sources Button -->
            <button class="player-top-btn player-btn-sources" id="player-btn-sources" title="Torrent Stream Sources">
              <span class="btn-icon">📡</span>
              <span class="btn-text">Sources</span>
            </button>

            <!-- Custom Magnet Input Button -->
            <button class="player-top-btn" id="player-btn-paste-magnet" title="Stream Custom Magnet Link">
              <span class="btn-icon">🧲</span>
              <span class="btn-text">Paste Magnet</span>
            </button>

            <!-- VPS Settings Button -->
            <button class="player-top-btn" id="player-btn-bridge-settings" title="Streaming Server & VPS Settings">
              <span class="btn-icon">⚙️</span>
            </button>

            <span class="player-quality-pill">4K HDR</span>
          </div>
        </div>

        <!-- Center Big Play/Pause Splash -->
        <div class="player-center-splash" id="player-center-splash" style="display:none;">
          <span class="splash-icon">▶</span>
        </div>

        <!-- Live Buffering & Swarm Connection HUD -->
        <div class="player-buffering-hud" id="player-buffering-hud" style="display:none;">
          <div class="buffering-spinner-ring"></div>
          <div class="buffering-text-wrap">
            <h3 class="buffering-title" id="buffering-title">Connecting to Swarm...</h3>
            <p class="buffering-subtext" id="buffering-subtext">Requesting sequential download pieces via VPS qBittorrent bridge...</p>
            <div class="buffering-progress-bar-wrap">
              <div class="buffering-progress-bar-fill"></div>
            </div>
          </div>
        </div>

        <!-- Torrent Sources Drawer / Modal -->
        <div class="player-sources-overlay" id="player-sources-overlay" style="display:none;">
          <div class="player-sources-dialog animate-scale-in">
            <div class="sources-header">
              <div class="sources-title-wrap">
                <span class="sources-eyebrow">TORRENT STREAM SOURCES</span>
                <h3 class="sources-title">Available Releases for "${_escape(title)}"</h3>
              </div>
              <button class="sources-close-btn" id="sources-close-btn">&times;</button>
            </div>

            <div class="sources-server-status-bar" id="sources-server-status-bar">
              <span class="server-dot server-dot-checking"></span>
              <span class="server-status-text">Checking VPS Streaming Bridge (${streamingBridge.getStreamServerUrl()})...</span>
            </div>

            <div class="sources-list-container" id="sources-list-container">
              <div class="sources-loading-state">
                <div class="spinner"></div>
                <span>Searching Prowlarr indexers for streaming releases...</span>
              </div>
            </div>

            <div class="sources-footer">
              <div class="sources-custom-magnet-row">
                <input type="text" class="form-input sources-magnet-input" id="sources-direct-magnet-input" placeholder="Or paste any magnet:?xt=urn:btih:... link directly" />
                <button class="btn btn-primary btn-sm" id="btn-stream-direct-magnet">▶ Stream Magnet</button>
              </div>
            </div>
          </div>
        </div>

        <!-- VPS / Server Settings Modal -->
        <div class="player-settings-overlay" id="player-settings-overlay" style="display:none;">
          <div class="player-settings-dialog animate-scale-in">
            <div class="sources-header">
              <h3 class="sources-title">⚙️ Streaming Server & VPS Configuration</h3>
              <button class="sources-close-btn" id="settings-close-btn">&times;</button>
            </div>

            <div class="modal-body">
              <div class="form-group">
                <label class="form-label" for="setting-vps-url">STREAMING BRIDGE SERVER (VPS / LOCAL)</label>
                <input type="text" id="setting-vps-url" class="form-input" placeholder="e.g. http://192.168.1.50:8888 or http://YOUR_VPS_IP:8888" value="${streamingBridge.getStreamServerUrl()}" />
                <span class="text-muted text-sm mt-1">The Node.js streaming server (running on your Ubuntu VPS or local machine).</span>
              </div>

              <div class="form-group">
                <label class="form-label" for="setting-prowlarr-url">PROWLARR / TORZNAB SEARCH URL</label>
                <input type="text" id="setting-prowlarr-url" class="form-input" placeholder="http://localhost:9696" value="${streamingBridge.getProwlarrConfig().baseUrl}" />
              </div>

              <div class="form-group">
                <label class="form-label" for="setting-prowlarr-key">PROWLARR API KEY</label>
                <input type="text" id="setting-prowlarr-key" class="form-input" placeholder="5a197b3359f247e8a69c7866650058e4" value="${streamingBridge.getProwlarrConfig().apiKey}" />
              </div>
            </div>

            <div class="modal-footer">
              <button class="btn btn-secondary" id="btn-test-server-health">🩺 Test Server</button>
              <button class="btn btn-primary" id="btn-save-vps-settings">Save Settings</button>
            </div>
          </div>
        </div>

        <!-- Bottom Controls Overlay -->
        <div class="player-bottom-controls animate-fade-in" id="player-bottom-controls">
          <!-- Timeline / Scrubber -->
          <div class="player-timeline-wrap" id="player-timeline-wrap">
            <div class="player-timeline-buffered" style="width: 80%;"></div>
            <div class="player-timeline-progress" id="player-timeline-progress" style="width: 0%;"></div>
            <div class="player-timeline-handle" id="player-timeline-handle" style="left: 0%;"></div>
            <div class="player-timeline-tooltip" id="player-timeline-tooltip" style="display:none;">00:00</div>
          </div>

          <!-- Controls Button Bar -->
          <div class="player-controls-bar">
            <div class="player-controls-left">
              <!-- Play / Pause -->
              <button class="player-ctrl-btn" id="ctrl-play-pause" title="Play/Pause (Space)">
                <span class="ctrl-icon" id="ctrl-play-icon">▶</span>
              </button>

              <!-- Skip -10s -->
              <button class="player-ctrl-btn" id="ctrl-skip-back" title="Rewind 10s (←)">
                <span class="ctrl-icon">↺ 10</span>
              </button>

              <!-- Skip +10s -->
              <button class="player-ctrl-btn" id="ctrl-skip-forward" title="Forward 10s (→)">
                <span class="ctrl-icon">10 ↻</span>
              </button>

              <!-- Volume Control -->
              <div class="player-volume-group">
                <button class="player-ctrl-btn" id="ctrl-volume-btn" title="Mute/Unmute (M)">
                  <span class="ctrl-icon" id="ctrl-vol-icon">🔊</span>
                </button>
                <input type="range" class="player-volume-slider" id="player-volume-slider" min="0" max="1" step="0.05" value="0.9" />
              </div>

              <!-- Time display -->
              <div class="player-time-display">
                <span id="player-current-time">00:00:00</span> / <span id="player-total-duration">02:00:00</span>
              </div>
            </div>

            <div class="player-controls-right">
              <!-- Audio & Subtitles -->
              <button class="player-ctrl-btn" id="ctrl-subs-btn" title="Subtitles (English)">
                <span class="ctrl-icon">💬</span>
                <span class="ctrl-label">CC</span>
              </button>

              <!-- Speed Selector -->
              <select class="player-select-ctrl" id="ctrl-speed-select" title="Playback Speed">
                <option value="0.75">0.75x</option>
                <option value="1" selected>1.0x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
              </select>

              <!-- Quality -->
              <select class="player-select-ctrl" id="ctrl-quality-select" title="Stream Quality">
                <option value="4k" selected>4K UHD</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
              </select>

              <!-- Fullscreen -->
              <button class="player-ctrl-btn" id="ctrl-fullscreen-btn" title="Fullscreen (F)">
                <span class="ctrl-icon">⛶</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modal = modal;
    this.videoElement = modal.querySelector('#main-video-element');

    this._bindPlayerEvents(isTV, season, episode, title, year);

    // If starting from saved progress
    if (this.currentTime > 0) {
      toast.info(`Resuming "${title}" from ${this._formatTime(this.currentTime)}`);
    }

    // Auto open sources drawer if requested or by default
    if (options.openSources !== false) {
      const sourcesOverlay = this.modal.querySelector('#player-sources-overlay');
      if (sourcesOverlay) {
        sourcesOverlay.style.display = 'flex';
        this._loadTorrentSources(isTV, title, year, season, episode);
      }
    }

    // Auto play
    this._play();
  }

  _bindPlayerEvents(isTV, season, episode, title, year) {
    const backBtn = this.modal.querySelector('#player-btn-back');
    const playPauseBtn = this.modal.querySelector('#ctrl-play-pause');
    const skipBackBtn = this.modal.querySelector('#ctrl-skip-back');
    const skipFwdBtn = this.modal.querySelector('#ctrl-skip-forward');
    const volBtn = this.modal.querySelector('#ctrl-volume-btn');
    const volSlider = this.modal.querySelector('#player-volume-slider');
    const fullscreenBtn = this.modal.querySelector('#ctrl-fullscreen-btn');
    const subsBtn = this.modal.querySelector('#ctrl-subs-btn');
    const speedSelect = this.modal.querySelector('#ctrl-speed-select');
    const timeline = this.modal.querySelector('#player-timeline-wrap');
    const sourcesBtn = this.modal.querySelector('#player-btn-sources');
    const pasteMagnetBtn = this.modal.querySelector('#player-btn-paste-magnet');
    const bridgeSettingsBtn = this.modal.querySelector('#player-btn-bridge-settings');
    const sourcesOverlay = this.modal.querySelector('#player-sources-overlay');
    const sourcesCloseBtn = this.modal.querySelector('#sources-close-btn');
    const settingsOverlay = this.modal.querySelector('#player-settings-overlay');
    const settingsCloseBtn = this.modal.querySelector('#settings-close-btn');
    const saveSettingsBtn = this.modal.querySelector('#btn-save-vps-settings');
    const testHealthBtn = this.modal.querySelector('#btn-test-server-health');
    const directMagnetInput = this.modal.querySelector('#sources-direct-magnet-input');
    const streamDirectBtn = this.modal.querySelector('#btn-stream-direct-magnet');

    const video = this.videoElement;

    // Back to app
    backBtn.addEventListener('click', () => this.close());

    // Play / Pause
    playPauseBtn.addEventListener('click', () => this._togglePlay());
    video.addEventListener('click', () => this._togglePlay());

    // Skip forward/back
    skipBackBtn.addEventListener('click', () => {
      this._seekTo(Math.max(0, this._getEffectiveTime() - 10));
    });

    skipFwdBtn.addEventListener('click', () => {
      this._seekTo(this._getEffectiveTime() + 10);
    });

    // Volume
    volSlider.addEventListener('input', (e) => {
      video.volume = e.target.value;
      video.muted = false;
      this._updateVolIcon(video.volume);
    });

    volBtn.addEventListener('click', () => {
      video.muted = !video.muted;
      this._updateVolIcon(video.muted ? 0 : video.volume);
    });

    // Speed
    speedSelect.addEventListener('change', (e) => {
      video.playbackRate = Number(e.target.value);
    });

    // Subtitles
    subsBtn.addEventListener('click', () => {
      subsBtn.classList.toggle('is-active');
      toast.info(subsBtn.classList.contains('is-active') ? 'Subtitles: English [CC] ON' : 'Subtitles: OFF');
    });

    // Fullscreen
    fullscreenBtn.addEventListener('click', () => {
      const container = this.modal.querySelector('#player-container');
      if (!document.fullscreenElement) {
        container.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Torrent Stream Sources Button
    sourcesBtn.addEventListener('click', () => {
      sourcesOverlay.style.display = 'flex';
      this._loadTorrentSources(isTV, title, year, season, episode);
    });

    sourcesCloseBtn.addEventListener('click', () => {
      sourcesOverlay.style.display = 'none';
    });

    // Custom Paste Magnet button
    pasteMagnetBtn.addEventListener('click', () => {
      const magnet = prompt('Enter or paste torrent magnet link:');
      if (magnet && magnet.trim().startsWith('magnet:')) {
        this.streamMagnet(magnet.trim(), 'Custom Magnet Stream');
      }
    });

    // Direct magnet inside sources dialog
    if (streamDirectBtn && directMagnetInput) {
      streamDirectBtn.addEventListener('click', () => {
        const magnet = directMagnetInput.value.trim();
        if (magnet.startsWith('magnet:')) {
          sourcesOverlay.style.display = 'none';
          this.streamMagnet(magnet, 'Direct Magnet Stream');
        } else {
          toast.error('Please enter a valid magnet link starting with magnet:?xt=');
        }
      });
    }

    // Bridge Settings
    bridgeSettingsBtn.addEventListener('click', () => {
      settingsOverlay.style.display = 'flex';
    });

    settingsCloseBtn.addEventListener('click', () => {
      settingsOverlay.style.display = 'none';
    });

    saveSettingsBtn.addEventListener('click', () => {
      const vpsUrl = this.modal.querySelector('#setting-vps-url').value.trim();
      const prowlarrUrl = this.modal.querySelector('#setting-prowlarr-url').value.trim();
      const prowlarrKey = this.modal.querySelector('#setting-prowlarr-key').value.trim();

      streamingBridge.setStreamServerUrl(vpsUrl);
      streamingBridge.setProwlarrConfig({ baseUrl: prowlarrUrl, apiKey: prowlarrKey });

      toast.success('Streaming & VPS settings updated!', '⚙️');
      settingsOverlay.style.display = 'none';
    });

    testHealthBtn.addEventListener('click', async () => {
      testHealthBtn.textContent = 'Testing...';
      const health = await streamingBridge.checkServerHealth();
      if (health) {
        toast.success(`Server Connected! Active torrents: ${health.activeTorrents}`, '✅');
      } else {
        toast.error(`Could not reach ${streamingBridge.getStreamServerUrl()}. Please ensure the server is running.`, '✕');
      }
      testHealthBtn.textContent = '🩺 Test Server';
    });

    // Video metadata & timeupdate
    video.addEventListener('loadedmetadata', () => {
      if (video.duration && isFinite(video.duration) && video.duration > 300) {
        this.duration = video.duration;
      } else {
        this.duration = this.totalRuntimeSeconds || 3300;
      }
      if (this.currentTime > 0) {
        video.currentTime = this.currentTime;
      }
      this._updateTimeDisplay();
    });

    video.addEventListener('waiting', () => {
      this._showBufferingHUD('Buffering Stream...', 'Receiving next sequential chunks from seeders via qBittorrent...');
    });

    video.addEventListener('playing', () => {
      this._hideBufferingHUD();
    });

    video.addEventListener('canplay', () => {
      this._hideBufferingHUD();
    });

    video.addEventListener('progress', () => {
      this._updateBufferedRange();
    });

    video.addEventListener('error', () => {
      this._showBufferingHUD('Connecting to Stream Source...', 'qBittorrent is acquiring initial pieces from swarm. Buffering stream...');
      setTimeout(() => {
        if (this.videoElement && this.videoElement.paused) {
          this.videoElement.load();
          this._play();
        }
      }, 3500);
    });

    video.addEventListener('timeupdate', () => {
      this.currentTime = video.currentTime;
      this._updateProgressBar();
      this._updateTimeDisplay();
    });

    // Timeline Scrubbing
    let isScrubbing = false;
    timeline.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      this._scrub(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isScrubbing) this._scrub(e);
    });

    window.addEventListener('mouseup', () => {
      if (isScrubbing) isScrubbing = false;
    });

    // Keyboard Shortcuts
    this._keydownHandler = (e) => {
      if (!this.modal) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (sourcesOverlay.style.display !== 'none') {
          sourcesOverlay.style.display = 'none';
        } else if (settingsOverlay.style.display !== 'none') {
          settingsOverlay.style.display = 'none';
        } else {
          this.close();
        }
      } else if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        this._togglePlay();
      } else if (e.key === 'ArrowLeft') {
        video.currentTime = Math.max(0, video.currentTime - 10);
      } else if (e.key === 'ArrowRight') {
        video.currentTime = Math.min(video.duration || this.duration, video.currentTime + 10);
      } else if (e.key === 'f') {
        fullscreenBtn.click();
      } else if (e.key === 'm') {
        volBtn.click();
      }
    };
    window.addEventListener('keydown', this._keydownHandler);

    // Auto-save progress
    this.progressTimer = setInterval(() => {
      if (this.currentMovie && this.currentTime > 5) {
        store.saveProgress({
          movie: this.currentMovie,
          currentTime: this.currentTime,
          duration: this.duration || 7200
        });
      }
    }, 5000);
  }

  /**
   * Load and render torrent stream sources from Prowlarr/Torznab
   */
  async _loadTorrentSources(isTV, title, year, season, episode) {
    const listContainer = this.modal.querySelector('#sources-list-container');
    const statusBar = this.modal.querySelector('#sources-server-status-bar');
    if (!listContainer) return;

    listContainer.innerHTML = `
      <div class="sources-loading-state">
        <div class="spinner"></div>
        <span>Searching indexer for available torrent stream releases...</span>
      </div>
    `;

    // Check server health
    const health = await streamingBridge.checkServerHealth();
    if (statusBar) {
      if (health) {
        statusBar.innerHTML = `<span class="server-dot server-dot-online"></span> <span class="server-status-text text-green">VPS Bridge Online (${streamingBridge.getStreamServerUrl()}) • ${health.activeTorrents} active streams</span>`;
      } else {
        statusBar.innerHTML = `<span class="server-dot server-dot-offline"></span> <span class="server-status-text text-amber">Bridge unreachable at ${streamingBridge.getStreamServerUrl()} (Make sure server is running on VPS/Local)</span>`;
      }
    }

    try {
      const releases = isTV
        ? await streamingBridge.searchTVStreams(title, season, episode)
        : await streamingBridge.searchMovieStreams(title, year);

      if (releases.length === 0) {
        listContainer.innerHTML = `
          <div class="sources-empty-state">
            <span class="sources-empty-icon">📡</span>
            <h4>No Indexer Sources Returned</h4>
            <p>Could not reach Prowlarr at ${streamingBridge.getProwlarrConfig().baseUrl} or no matching torrents were found. You can paste a magnet link directly below.</p>
          </div>
        `;
        return;
      }

      listContainer.innerHTML = `
        <div class="sources-table">
          ${releases.map((rel, idx) => `
            <div class="source-item-row" data-idx="${idx}">
              <div class="source-info-col">
                <div class="source-badge-row">
                  <span class="source-pill pill-${rel.resolution.replace(/\s+/g, '').toLowerCase()}">${rel.resolution}</span>
                  ${rel.isHDR ? `<span class="source-pill pill-hdr">HDR</span>` : ''}
                  <span class="source-pill pill-audio">${rel.audioBadge || (rel.isAtmos ? '5.1 ATMOS' : 'Stereo')}</span>
                  <span class="source-pill pill-codec">${rel.codec}</span>
                  ${rel.isUniversal ? `<span class="source-pill" style="background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34,197,94,0.4);">⭐ Web Audio (AAC)</span>` : ''}
                  <span class="source-indexer-tag">${_escape(rel.indexer)}</span>
                </div>
                <h4 class="source-release-title" title="${_escape(rel.title)}">${_escape(rel.title)}</h4>
                <div class="source-meta-row">
                  <span class="source-size">💾 ${rel.size}</span>
                  <span class="source-seeds text-green">🟢 ${Number(rel.seeders).toLocaleString()} seeders</span>
                  <span class="source-leeches text-muted">🔴 ${Number(rel.leechers).toLocaleString()} leechers</span>
                </div>
              </div>

              <div class="source-action-col">
                <button class="btn btn-primary btn-sm btn-connect-stream" data-magnet="${_escape(rel.magnet)}" data-title="${_escape(rel.title)}">
                  <span class="btn-icon">▶</span>
                  <span class="btn-text">Stream Now</span>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `;

      // Attach connect handlers
      listContainer.querySelectorAll('.btn-connect-stream').forEach(btn => {
        btn.addEventListener('click', () => {
          const magnet = btn.dataset.magnet;
          const relTitle = btn.dataset.title;
          this.modal.querySelector('#player-sources-overlay').style.display = 'none';
          this.streamMagnet(magnet, relTitle);
        });
      });

    } catch (err) {
      listContainer.innerHTML = `
        <div class="sources-empty-state">
          <p>Failed to query torrent sources: ${err.message}</p>
        </div>
      `;
    }
  }

  /**
   * Switch player source to Torrent HTTP Stream via the Bridge
   * Uses Hls.js progressive segmented streaming (HLS) for instant playback + universal AAC audio
   * Falls back to native HTTP 206 streaming for Safari/iOS which supports HLS natively
   */
  streamMagnet(magnetLink, releaseTitle = 'Torrent Stream', startSec = 0) {
    if (!this.sessionId) {
      this.sessionId = `sess_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    }

    const hashMatch = magnetLink.match(/urn:btih:([a-zA-Z0-9]+)/i);
    this.currentInfoHash = hashMatch ? hashMatch[1].toLowerCase() : 'custom';
    this.currentMagnet = magnetLink;
    this.currentStreamTitle = releaseTitle;
    this.currentStartSec = startSec;

    const sourceBadge = this.modal.querySelector('#player-active-source-badge');

    toast.info(`Connecting to torrent stream via bridge...`, '🧲');
    this._showBufferingHUD('Connecting to Stream...', `Streaming "${releaseTitle.substring(0, 35)}..." with Universal AAC Audio`);

    if (sourceBadge) {
      sourceBadge.textContent = `🟢 TORRENT: ${releaseTitle.substring(0, 30)}...`;
      sourceBadge.style.display = 'inline-block';
    }

    // Start 10s playback session heartbeat
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this.currentInfoHash && this.modal && !this.videoElement.paused) {
        streamingBridge.sendHeartbeat(this.sessionId, this.currentInfoHash, this.videoElement.currentTime + (this.currentStartSec || 0));
      }
    }, 10000);

    // Destroy previous HLS instance if any
    if (this._hlsInstance) {
      this._hlsInstance.destroy();
      this._hlsInstance = null;
    }

    // Build HLS URL with duration hint for accurate seeking
    const durationSec = this.totalRuntimeSeconds || this.duration || 0;
    const hlsUrl = streamingBridge.getHlsUrl(magnetLink, releaseTitle, this.sessionId, durationSec);

    // Use Hls.js for progressive HLS streaming (Chrome, Firefox, Edge)
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      console.log('[Player] Using Hls.js engine for progressive streaming');
      const hls = new Hls({
        maxBufferLength: 30,        // Buffer 30s ahead
        maxMaxBufferLength: 120,    // Up to 120s max
        startPosition: startSec,
        liveSyncDurationCount: 3,
        enableWorker: true,
        lowLatencyMode: false,
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(this.videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[HLS] Manifest parsed, starting playback');
        this._hideBufferingHUD();
        this._play();
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.warn('[HLS Error]:', data.type, data.details);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.warn('[HLS] Network error, retrying...');
              this._showBufferingHUD('Buffering...', 'Waiting for torrent pieces to download...');
              setTimeout(() => hls.startLoad(), 3000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.warn('[HLS] Media error, recovering...');
              hls.recoverMediaError();
              break;
            default:
              console.error('[HLS] Fatal error, falling back to direct stream');
              hls.destroy();
              this._hlsInstance = null;
              // Fallback to direct HTTP 206 stream
              this._directStreamFallback(magnetLink, releaseTitle, startSec);
              break;
          }
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        this._hideBufferingHUD();
        this._updateBufferedRange();
      });

      this._hlsInstance = hls;

    } else if (this.videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari/iOS — native HLS support
      console.log('[Player] Using native HLS (Safari/iOS)');
      this.videoElement.src = hlsUrl;
      this.videoElement.load();
      this._play();
    } else {
      // Final fallback: direct HTTP 206 byte-range stream
      console.log('[Player] Fallback to direct HTTP 206 stream');
      this._directStreamFallback(magnetLink, releaseTitle, startSec);
    }
  }

  /**
   * Direct HTTP 206 byte-range fallback (used when HLS is unavailable)
   */
  _directStreamFallback(magnetLink, releaseTitle, startSec) {
    const streamUrl = streamingBridge.getStreamUrl(magnetLink, releaseTitle, this.sessionId, null, startSec);
    this.videoElement.src = streamUrl;
    this.videoElement.load();
    this._play();
  }

  _showBufferingHUD(title = 'Connecting to Swarm...', subtext = 'Requesting sequential download pieces via VPS qBittorrent bridge...') {
    const hud = this.modal ? this.modal.querySelector('#player-buffering-hud') : null;
    if (!hud) return;
    const titleEl = hud.querySelector('#buffering-title');
    const subEl = hud.querySelector('#buffering-subtext');
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtext;
    hud.style.display = 'flex';
  }

  _hideBufferingHUD() {
    const hud = this.modal ? this.modal.querySelector('#player-buffering-hud') : null;
    if (hud) hud.style.display = 'none';
  }

  _updateBufferedRange() {
    const bufferedEl = this.modal ? this.modal.querySelector('.player-timeline-buffered') : null;
    const video = this.videoElement;
    if (!bufferedEl || !video) return;

    const totalDur = (this.duration && this.duration > 300) ? this.duration : (this.totalRuntimeSeconds || 3300);

    if (video.buffered && video.buffered.length > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      const percent = Math.min(100, Math.max(0, (bufferedEnd / totalDur) * 100));
      bufferedEl.style.width = `${percent}%`;
    }
  }

  _togglePlay() {
    if (this.videoElement.paused) {
      this._play();
    } else {
      this._pause();
    }
  }

  _play() {
    this.videoElement.muted = false;
    this.videoElement.volume = 1.0;
    this._updateVolIcon(1.0);

    const volSlider = this.modal ? this.modal.querySelector('#ctrl-vol-slider') : null;
    if (volSlider) volSlider.value = 1.0;

    this.videoElement.play().then(() => {
      this.isPlaying = true;
      const icon = this.modal ? this.modal.querySelector('#ctrl-play-icon') : null;
      if (icon) icon.textContent = '❚❚';
    }).catch(() => {
      // Browser autoplay restriction fallback: start muted then unmute on user interaction
      this.videoElement.muted = true;
      this.videoElement.play().then(() => {
        this.isPlaying = true;
        const icon = this.modal ? this.modal.querySelector('#ctrl-play-icon') : null;
        if (icon) icon.textContent = '❚❚';
        toast.info('Click anywhere on the video or press Space to unmute audio!', '🔊');
      }).catch(() => {
        this.isPlaying = false;
      });
    });
  }

  _pause() {
    this.videoElement.pause();
    this.isPlaying = false;
    const icon = this.modal.querySelector('#ctrl-play-icon');
    if (icon) icon.textContent = '▶';
  }

  _getEffectiveTime() {
    return (this.currentStartSec || 0) + (this.videoElement ? this.videoElement.currentTime : 0);
  }

  _seekTo(targetSeconds) {
    const totalDur = (this.duration && this.duration > 300) ? this.duration : (this.totalRuntimeSeconds || 3300);
    const clamped = Math.max(0, Math.min(totalDur, targetSeconds));

    if (this.videoElement) {
      this.videoElement.currentTime = clamped;
      this._updateProgressBar();
      this._updateTimeDisplay();
    }
  }

  _scrub(e) {
    const timeline = this.modal.querySelector('#player-timeline-wrap');
    if (!timeline) return;
    const rect = timeline.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const totalDur = (this.duration && this.duration > 300) ? this.duration : (this.totalRuntimeSeconds || 3300);
    const targetSeconds = Math.floor(pos * totalDur);
    this._seekTo(targetSeconds);
  }

  _updateProgressBar() {
    const progressFill = this.modal ? this.modal.querySelector('#player-timeline-progress') : null;
    const progressHandle = this.modal ? this.modal.querySelector('#player-timeline-handle') : null;
    if (!progressFill || !progressHandle) return;

    const totalDur = (this.duration && this.duration > 300) ? this.duration : (this.totalRuntimeSeconds || 3300);
    const current = this._getEffectiveTime();
    const percent = Math.min(100, Math.max(0, (current / totalDur) * 100));

    progressFill.style.width = `${percent}%`;
    progressHandle.style.left = `${percent}%`;
  }

  _updateTimeDisplay() {
    const curEl = this.modal ? this.modal.querySelector('#player-current-time') : null;
    const durEl = this.modal ? this.modal.querySelector('#player-total-duration') : null;
    const totalDur = (this.duration && this.duration > 300) ? this.duration : (this.totalRuntimeSeconds || 3300);
    const current = this._getEffectiveTime();

    if (curEl) curEl.textContent = this._formatTime(current);
    if (durEl) durEl.textContent = this._formatTime(totalDur);
  }

  _updateVolIcon(vol) {
    const icon = this.modal.querySelector('#ctrl-vol-icon');
    if (!icon) return;
    if (vol === 0) icon.textContent = '🔇';
    else if (vol < 0.5) icon.textContent = '🔉';
    else icon.textContent = '🔊';
  }

  _formatTime(seconds) {
    if (isNaN(seconds)) return '00:00:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  _sendLeaveBeacon() {
    if (this.sessionId && this.currentInfoHash) {
      const serverUrl = streamingBridge.getStreamServerUrl();
      const payload = JSON.stringify({ sessionId: this.sessionId, infoHash: this.currentInfoHash });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(`${serverUrl}/api/stream/session/leave`, payload);
        } else {
          fetch(`${serverUrl}/api/stream/session/leave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true
          }).catch(() => {});
        }
      } catch {}
    }
  }

  close() {
    this._sendLeaveBeacon();

    // Destroy Hls.js instance
    if (this._hlsInstance) {
      this._hlsInstance.destroy();
      this._hlsInstance = null;
    }

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.currentMovie && this.currentTime > 5) {
      store.saveProgress({
        movie: this.currentMovie,
        currentTime: this.currentTime,
        duration: this.duration || 7200
      });
    }
    if (this._keydownHandler) {
      window.removeEventListener('keydown', this._keydownHandler);
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const playerModal = new PlayerModalManager();
