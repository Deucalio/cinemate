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
    this.currentStreamMode = null;   // 'direct' (byte-range, natively seekable) | 'remux' (fMP4)
    this.currentStartSec = 0;        // remux only: offset FFmpeg started the output at
    this.probedDuration = 0;         // real duration from ffprobe, when available
    this.userVolume = 0.9;           // matches the slider's initial value
    this._pendingSeekSec = 0;
    this._streamGeneration = 0;
    this._remuxAttempted = false;
    this._pendingLoad = null;   // { generation, startSec } while waiting for the download
    this._hls = null;           // hls.js instance, when playing a segmented representation
    this._transcodedDurationSec = 0;
    this._hlsStartBufferSec = 8;
    this._seekWaitingForSec = null;  // a seek accepted beyond the transcode head
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

    // Accurate runtime calculation from TMDB
    const runtimeMinutes = movie.runtime || (movie.episode_run_time && movie.episode_run_time[0]) || (isTV ? 55 : 120);
    this.totalRuntimeSeconds = runtimeMinutes * 60;

    // Always start at the beginning. Auto-resuming from saved progress meant a freshly-added
    // torrent had to be downloaded up to that timestamp before anything could play, which looked
    // like the player jumping to a random time and then hanging. Progress is still recorded for
    // the library views; it just no longer drives playback.
    this.currentTime = 0;
    this.duration = this.totalRuntimeSeconds;

    // Reset per-open stream state
    this.currentStreamMode = null;
    this.currentStartSec = 0;
    this.probedDuration = 0;
    this._pendingSeekSec = 0;
    this._remuxAttempted = false;
    this.currentMagnet = null;
    this.currentInfoHash = null;

    const modal = document.createElement('div');
    modal.className = 'player-modal-backdrop animate-fade-in';
    modal.id = 'streaming-player-modal';

    modal.innerHTML = `
      <div class="player-container" id="player-container">
        <!-- Video Element -->
        <!-- No src until a torrent source is chosen. It previously auto-played a Google sample
             clip, which made a broken bridge look like working playback. -->
        <video class="main-video-element" id="main-video-element" preload="auto" playsinline crossorigin="anonymous"></video>

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

            <!-- Populated from the bridge's actual probe of the chosen release. -->
            <span class="player-quality-pill" id="player-stream-info" title="Actual stream format">—</span>
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
              <div class="buffering-progress-bar-fill is-indeterminate" id="buffering-bar-fill"></div>
            </div>
            <div class="buffering-stats" id="buffering-stats" style="display:none;">
              <span id="buffering-stat-progress"></span>
              <span id="buffering-stat-speed"></span>
              <span id="buffering-stat-eta"></span>
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
                <input type="text" id="setting-vps-url" class="form-input" placeholder="e.g. http://192.168.1.50:8899 or http://YOUR_VPS_IP:8899" value="${streamingBridge.getStreamServerUrl()}" />
                <span class="text-muted text-sm mt-1">The Node.js streaming server (running on your Ubuntu VPS or local machine).</span>
              </div>

              <div class="form-group">
                <label class="form-label" for="setting-prowlarr-url">PROWLARR / TORZNAB SEARCH URL</label>
                <input type="text" id="setting-prowlarr-url" class="form-input" placeholder="http://localhost:9696" value="${streamingBridge.getProwlarrConfig().baseUrl}" />
              </div>

              <div class="form-group">
                <label class="form-label" for="setting-prowlarr-key">PROWLARR API KEY</label>
                <input type="text" id="setting-prowlarr-key" class="form-input" placeholder="Prowlarr API key" value="${streamingBridge.getProwlarrConfig().apiKey}" />
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
            <!-- How much has been transcoded. Seeking inside this is instant; beyond it waits. -->
            <div class="player-timeline-transcoded" id="player-timeline-transcoded" style="width: 0%;"></div>
            <div class="player-timeline-buffered" style="width: 0%;"></div>
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
              <!-- Speed Selector -->
              <select class="player-select-ctrl" id="ctrl-speed-select" title="Playback Speed">
                <option value="0.75">0.75x</option>
                <option value="1" selected>1.0x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
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

    // Auto open sources drawer if requested or by default
    if (options.openSources !== false) {
      const sourcesOverlay = this.modal.querySelector('#player-sources-overlay');
      if (sourcesOverlay) {
        sourcesOverlay.style.display = 'flex';
        this._loadTorrentSources(isTV, title, year, season, episode);
      }
    }

    this._showBufferingHUD(
      'Choose a Stream Source',
      'Pick a torrent release from the Sources panel, or paste a magnet link, to begin playback.'
    );
  }

  _bindPlayerEvents(isTV, season, episode, title, year) {
    const backBtn = this.modal.querySelector('#player-btn-back');
    const playPauseBtn = this.modal.querySelector('#ctrl-play-pause');
    const skipBackBtn = this.modal.querySelector('#ctrl-skip-back');
    const skipFwdBtn = this.modal.querySelector('#ctrl-skip-forward');
    const volBtn = this.modal.querySelector('#ctrl-volume-btn');
    const volSlider = this.modal.querySelector('#player-volume-slider');
    const fullscreenBtn = this.modal.querySelector('#ctrl-fullscreen-btn');
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
      this.userVolume = Number(e.target.value);
      video.volume = this.userVolume;
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
        toast.success(`Bridge online — ${health.activeTorrentsCount} active torrent(s), ` +
          `FFmpeg ${health.toolchain && health.toolchain.ffmpeg ? 'ready' : 'MISSING'}`, '✅');
      } else {
        toast.error(`Could not reach ${streamingBridge.getStreamServerUrl()}. Please ensure the server is running.`, '✕');
      }
      testHealthBtn.textContent = '🩺 Test Server';
    });

    // ---- Video element state ----
    video.addEventListener('loadedmetadata', () => {
      // Progressive fMP4 out of the remuxer reports Infinity/NaN, so fall back to the probed
      // duration and finally to the TMDB runtime -- the scrubber must span the real film.
      if (isFinite(video.duration) && video.duration > 300) {
        this.duration = video.duration;
      } else if (this.probedDuration > 300) {
        this.duration = this.probedDuration;
      } else {
        this.duration = this.totalRuntimeSeconds || 3300;
      }

      if (this._pendingSeekSec > 0) {
        const target = this._pendingSeekSec;
        this._pendingSeekSec = 0;
        try { video.currentTime = target; } catch {}
      }

      this._updateTimeDisplay();
    });

    video.addEventListener('waiting', () => {
      if (!this.currentMagnet) return;

      // What the player is waiting FOR depends on the delivery mode. Reporting a download stall
      // while the HUD also says "100.0% downloaded" is a straight contradiction.
      if (this.currentStreamMode === 'hls') {
        this._showBufferingHUD(
          'Waiting for the transcoder...',
          'Playback has caught up with conversion. It will resume as more is converted.'
        );
      } else {
        this._showBufferingHUD(
          'Buffering Stream...',
          'The player has caught up with the download. Waiting for more of the file...'
        );
      }

      this._startStatusPolling();
    });

    video.addEventListener('playing', () => {
      this._hideBufferingHUD();
      this._stopStatusPolling();
    });
    video.addEventListener('canplay', () => {
      this._hideBufferingHUD();
      this._stopStatusPolling();
    });
    video.addEventListener('progress', () => {
      this._updateBufferedRange();
      this._updateTranscodedRange();
    });

    // Single, state-aware handler. The old one blind-reloaded the element every 3.5s forever,
    // which both hid the real failure and raced the remux fallback by reloading the failed
    // direct URL on top of it.
    video.addEventListener('error', () => this._handleVideoError());

    video.addEventListener('timeupdate', () => {
      this.currentTime = this._getEffectiveTime();
      this._updateProgressBar();
      this._updateTimeDisplay();
    });

    // Timeline scrubbing.
    //
    // Dragging must NOT seek on every mousemove. In remux mode a seek restarts FFmpeg, so one drag
    // across the bar spawned dozens of transcodes and stream requests, all competing for the same
    // pieces. The drag now only previews; the seek is committed once, on release.
    //
    // These listeners are on `window` (a drag continues outside the timeline), so they must be
    // removed on close — previously they leaked, and every re-open added another live handler.
    let isScrubbing = false;
    let pendingSeekSec = null;
    const tooltip = this.modal.querySelector('#player-timeline-tooltip');

    const positionToSeconds = (e) => {
      const rect = timeline.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      return Math.floor(ratio * this._totalDuration());
    };

    const previewAt = (e) => {
      const seconds = positionToSeconds(e);
      pendingSeekSec = seconds;

      const percent = Math.min(100, Math.max(0, (seconds / this._totalDuration()) * 100));
      const fill = this.modal.querySelector('#player-timeline-progress');
      const handle = this.modal.querySelector('#player-timeline-handle');
      if (fill) fill.style.width = `${percent}%`;
      if (handle) handle.style.left = `${percent}%`;
      if (tooltip) {
        tooltip.textContent = this._formatTime(seconds);
        tooltip.style.left = `${percent}%`;
        tooltip.style.display = 'block';
      }
    };

    timeline.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      previewAt(e);
    });

    this._onTimelineMove = (e) => {
      if (isScrubbing) previewAt(e);
    };

    this._onTimelineUp = () => {
      if (!isScrubbing) return;
      isScrubbing = false;
      if (tooltip) tooltip.style.display = 'none';
      if (pendingSeekSec === null) return;
      const target = pendingSeekSec;
      pendingSeekSec = null;
      this._seekTo(target);
    };

    window.addEventListener('mousemove', this._onTimelineMove);
    window.addEventListener('mouseup', this._onTimelineUp);

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
        this._seekTo(Math.max(0, this._getEffectiveTime() - 10));
      } else if (e.key === 'ArrowRight') {
        this._seekTo(this._getEffectiveTime() + 10);
      } else if (e.key === 'f') {
        fullscreenBtn.click();
      } else if (e.key === 'm') {
        volBtn.click();
      }
    };
    window.addEventListener('keydown', this._keydownHandler);

    // Closing the TAB never ran close(), so the leave beacon was only sent when the player was
    // dismissed from inside the app. A closed tab therefore left the torrent running until the
    // heartbeat went stale — up to a minute of pointless swarm traffic, and a session lingering in
    // the bridge's registry.
    //
    // 'pagehide' rather than 'beforeunload': it fires on mobile and on back/forward-cache
    // navigations, where beforeunload does not.
    this._pageHideHandler = () => {
      streamingBridge.sendLeave(this.sessionId, this.currentInfoHash);
    };
    window.addEventListener('pagehide', this._pageHideHandler);

    // Auto-save progress
    this.progressTimer = setInterval(() => {
      if (this.currentMovie && this.currentTime > 5) {
        store.saveProgress({
          movie: this.currentMovie,
          currentTime: this.currentTime,
          duration: this._totalDuration()
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
        const ffmpegReady = health.toolchain ? health.toolchain.ffmpeg : true;
        statusBar.innerHTML = `<span class="server-dot server-dot-online"></span> <span class="server-status-text text-green">VPS Bridge Online (${streamingBridge.getStreamServerUrl()}) • ${health.activeTorrentsCount} active torrent(s)${ffmpegReady ? '' : ' • ⚠ FFmpeg missing — only MP4/H.264/AAC releases will play'}</span>`;
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
                  ${rel.isUniversal ? `<span class="source-pill" style="background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34,197,94,0.4);">⭐ Plays Directly</span>` : ''}
                  ${rel.codec === 'HEVC' ? `<span class="source-pill" style="background: rgba(239, 68, 68, 0.18); color: #fca5a5; border: 1px solid rgba(239,68,68,0.4);">⚠ HEVC — browsers cannot decode</span>` : ''}
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
   * Point the player at a torrent, via the bridge.
   *
   * The bridge is asked to RESOLVE the release first (/api/stream/prepare) so we know the
   * delivery mode, real duration and codec compatibility before <video> ever sees a URL. A
   * <video> element only surfaces opaque MEDIA_ERR_* codes, so without this step "no seeders",
   * "unsupported codec" and "disk full" all looked identical: an endless buffering spinner.
   */
  async streamMagnet(magnetLink, releaseTitle = 'Torrent Stream', startSec = 0) {
    if (!this.sessionId) {
      this.sessionId = `sess_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    }

    const hashMatch = magnetLink.match(/urn:btih:([a-zA-Z0-9]+)/i);
    this.currentInfoHash = hashMatch ? hashMatch[1].toLowerCase() : null;
    this.currentMagnet = magnetLink;
    this.currentStreamTitle = releaseTitle;
    this.currentStartSec = 0;
    this.probedDuration = 0;
    this._remuxAttempted = false;
    this._pendingLoad = null;
    this._transcodedDurationSec = 0;
    this._seekWaitingForSec = null;
    this._hlsPlaylistUrl = null;
    this._destroyHls();

    // Guards against a slow prepare for an abandoned source overwriting a newer selection.
    const generation = ++this._streamGeneration;

    const shortTitle = releaseTitle.length > 40 ? `${releaseTitle.substring(0, 40)}...` : releaseTitle;
    const sourceBadge = this.modal.querySelector('#player-active-source-badge');
    if (sourceBadge) {
      sourceBadge.textContent = `🟡 RESOLVING: ${shortTitle}`;
      sourceBadge.style.display = 'inline-block';
    }

    this._showBufferingHUD(
      'Connecting to BitTorrent Swarm...',
      `Resolving "${shortTitle}" and checking browser compatibility. A cold torrent can take ~20s.`
    );
    toast.info('Connecting to torrent stream via bridge...', '🧲');

    // Start heart-beating immediately so Auto-GC never deletes the torrent while it resolves.
    this._startHeartbeat();
    // Show real download progress from the first second, rather than an indeterminate spinner.
    this._startStatusPolling();

    await this._resolveAndLoad(generation, startSec);
  }

  /**
   * Asks the bridge for a delivery plan and loads it — or waits, if the file is still downloading.
   *
   * Under cache-first the bridge withholds a plan until the download completes, reporting
   * `readyState: 'downloading'` instead. Rather than failing, we park and let the status poller
   * call back once it is ready. Each attempt is tagged with the stream generation so an abandoned
   * source can never load over a newer one.
   */
  async _resolveAndLoad(generation, startSec = 0) {
    const plan = await streamingBridge.prepareStream(
      this.currentMagnet, this.currentStreamTitle, this.sessionId
    );

    // Superseded by a newer source, or the player closed while we waited.
    if (generation !== this._streamGeneration || !this.modal) return;

    if (!plan || !plan.ok) {
      this._showStreamError(
        (plan && plan.error) || 'The bridge could not prepare this release.',
        plan && plan.code
      );
      return;
    }

    if (plan.infoHash) this.currentInfoHash = plan.infoHash;

    // Still downloading to the server — park until the poller reports ready.
    if (plan.readyState === 'downloading') {
      this._pendingLoad = { generation, startSec, kind: 'download' };
      this._showBufferingHUD(
        'Downloading to the server...',
        plan.message || 'Playback starts once the file is complete.'
      );
      return;
    }

    this._pendingLoad = null;
    this.probedDuration = plan.durationSec || 0;
    if (plan.durationSec > 300) this.duration = plan.durationSec;

    if (plan.mode === 'hls') {
      this._hlsPlaylistUrl = plan.playlistUrl;
      this._hlsStartBufferSec = plan.startBufferSec || 8;
      this._transcodedDurationSec = (plan.transcode && plan.transcode.transcodedDurationSec) || 0;

      const enough = this._transcodedDurationSec >= this._hlsStartBufferSec;
      const done = plan.transcode && plan.transcode.state === 'complete';

      if (!enough && !done) {
        // Park until the transcoder is far enough ahead; the status poller calls back.
        this._pendingLoad = { generation, startSec, kind: 'transcode' };
        this._showBufferingHUD(
          'Preparing playback...',
          `${plan.reason} — converting to a browser-playable stream. Playback starts shortly.`
        );
        this._startStatusPolling();
        return;
      }
    }

    const shortTitle = this.currentStreamTitle.length > 40
      ? `${this.currentStreamTitle.substring(0, 40)}...`
      : this.currentStreamTitle;

    const sourceBadge = this.modal.querySelector('#player-active-source-badge');
    if (sourceBadge) {
      const remuxNote = plan.audio && plan.audio.willTranscode ? ' • AAC remux' : '';
      sourceBadge.textContent = `🟢 ${plan.mode === 'direct' ? 'DIRECT' : 'REMUX'}: ${shortTitle}${remuxNote}`;
    }

    // Replace the old hard-coded "4K HDR" pill with what the bridge actually probed.
    const streamInfo = this.modal.querySelector('#player-stream-info');
    if (streamInfo) {
      const parts = [];
      if (plan.video && plan.video.codec) parts.push(String(plan.video.codec).toUpperCase());
      if (plan.audio && plan.audio.codec) {
        parts.push(`${String(plan.audio.codec).toUpperCase()}${plan.audio.channels ? ` ${plan.audio.channels}ch` : ''}`);
      }
      parts.push(plan.mode === 'direct' ? 'Direct' : 'Remux');
      streamInfo.textContent = parts.join(' · ');
      streamInfo.title = `${plan.fileName || ''} — ${plan.reason || ''}`;
    }

    this._showBufferingHUD(
      plan.mode === 'remux' ? 'Remuxing for your browser...' : 'Starting playback...',
      plan.mode === 'remux'
        ? `${plan.reason} — FFmpeg is rewrapping this release with stereo AAC audio.`
        : 'Streaming from the completed file — native seeking enabled.'
    );

    this._loadStreamUrl(plan.mode, startSec);
  }

  /**
   * Points <video> at the bridge for a given delivery mode.
   *
   * direct : the bridge serves real byte ranges, so the element's clock IS the film's clock and
   *          the browser seeks natively.
   * remux  : FFmpeg starts its output AT startSec, so the element's clock restarts at zero and
   *          we carry the offset in `currentStartSec`.
   */
  _loadStreamUrl(mode, startSec = 0) {
    if (!this.currentMagnet || !this.videoElement) return;

    this.currentStreamMode = mode;

    if (mode === 'hls') {
      // Segments carry their own timeline, so there is no offset to track and no restart on seek.
      this.currentStartSec = 0;
      this._pendingSeekSec = startSec > 0 ? startSec : 0;
      this._attachHls(this._hlsPlaylistUrl).catch((err) => {
        console.warn('[Player] could not load the HLS engine', err);
        this._showStreamError('Could not load the playback engine for this stream.', 'HLS_LOAD_FAILED');
      });
      return;
    }

    // Any previous segmented playback must be torn down before a plain <video> src is used.
    this._destroyHls();

    if (mode === 'direct') {
      this.currentStartSec = 0;
      this._pendingSeekSec = startSec > 0 ? startSec : 0;
    } else {
      this.currentStartSec = startSec;
      this._pendingSeekSec = 0;
    }

    const url = streamingBridge.getStreamUrl(
      this.currentMagnet,
      this.currentStreamTitle,
      this.sessionId,
      mode === 'remux' ? startSec : 0,
      mode,
      this.probedDuration || this.totalRuntimeSeconds || 0
    );

    this.videoElement.src = url;
    this.videoElement.load();
    this._play();
  }

  /**
   * Attaches a segmented (HLS) representation.
   *
   * Safari plays HLS natively and hls.js explicitly recommends deferring to it there rather than
   * driving Media Source Extensions.
   */
  async _attachHls(playlistUrl) {
    this._destroyHls();

    const video = this.videoElement;
    if (!video) return;

    const url = `${streamingBridge.getStreamServerUrl()}${playlistUrl}`;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.load();
      this._play();
      return;
    }

    // Loaded on demand: hls.js is ~400 kB and irrelevant to browser-native releases, so it should
    // not be in the bundle every visitor downloads.
    const generation = this._streamGeneration;
    const { default: Hls } = await import('hls.js');
    if (generation !== this._streamGeneration || !this.modal) return;
    this._Hls = Hls;

    if (!Hls.isSupported()) {
      this._showStreamError('This browser cannot play segmented streams (no MSE support).', 'HLS_UNSUPPORTED');
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      // The playlist grows while transcoding, so hls.js must keep re-reading it rather than
      // treating the current end as the end of the asset.
      liveSyncDurationCount: 3,
      backBufferLength: 90
    });

    this._hls = hls;
    hls.on(Hls.Events.ERROR, (_evt, data) => this._handleHlsError(hls, data));
    hls.on(Hls.Events.MANIFEST_PARSED, () => this._play());
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  _destroyHls() {
    if (!this._hls) return;
    try { this._hls.destroy(); } catch {}
    this._hls = null;
  }

  /**
   * hls.js reports many non-fatal errors that it recovers from itself; only fatal ones need us.
   *
   * A network error is expected here rather than exceptional: while transcoding, the player can
   * reach the end of the segments that exist and ask for one that has not been written yet.
   * Reloading is the correct response, not an error message.
   */
  _handleHlsError(hls, data) {
    const Hls = this._Hls;
    if (!Hls || !data || !data.fatal) return;

    console.warn('[Player] fatal HLS error', data.type, data.details);

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      this._showBufferingHUD('Waiting for more of the film...', 'The transcoder has not reached this point yet.');
      this._startStatusPolling();
      try { hls.startLoad(); } catch {}
      return;
    }

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      try { hls.recoverMediaError(); return; } catch {}
    }

    this._destroyHls();
    this._showStreamError(`Playback failed (${data.details}). Try a different source.`, data.details);
  }

  /**
   * Escalates at most once: a direct stream the browser cannot decode is retried through the
   * FFmpeg remuxer. Anything else is reported instead of retried in a loop.
   */
  _handleVideoError() {
    const mediaError = this.videoElement ? this.videoElement.error : null;
    const code = mediaError ? mediaError.code : 0;
    const label = {
      1: 'MEDIA_ERR_ABORTED',
      2: 'MEDIA_ERR_NETWORK',
      3: 'MEDIA_ERR_DECODE',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
    }[code] || `MEDIA_ERR_${code}`;

    console.warn(`[Player] ${label}`, mediaError && mediaError.message);

    if (!this.currentMagnet) return; // nothing streaming yet
    if (code === 1) return;          // we aborted it ourselves (source switch or close)

    if (this.currentStreamMode === 'direct' && !this._remuxAttempted && (code === 3 || code === 4)) {
      this._remuxAttempted = true;
      this._showBufferingHUD(
        'Switching to FFmpeg Remuxer...',
        `${label} — rewrapping to MP4 with stereo AAC audio for your browser.`
      );
      toast.info('Browser could not decode this release directly. Remuxing...', '🎛️');
      this._loadStreamUrl('remux', this._getEffectiveTime() || 0);
      return;
    }

    this._showStreamError(
      code === 2
        ? 'The connection to the streaming bridge dropped. Check that the bridge is running and reachable.'
        : `Your browser could not play this release (${label}). Try a different source.`,
      label
    );
  }

  _showStreamError(message, code = '') {
    console.warn('[Player] stream failed', code || '', message);
    this._stopHeartbeat();
    this._stopStatusPolling();
    this._showBufferingHUD('⚠️ Stream Unavailable', message);

    const hud = this.modal ? this.modal.querySelector('#player-buffering-hud') : null;
    if (hud) {
      const spinner = hud.querySelector('.buffering-spinner-ring');
      if (spinner) spinner.style.display = 'none';
      const bar = hud.querySelector('.buffering-progress-bar-wrap');
      if (bar) bar.style.display = 'none';
      // Download figures are meaningless next to a playback failure, and "0.0% downloaded" under
      // an error message reads as a second, contradictory fault.
      const stats = hud.querySelector('#buffering-stats');
      if (stats) stats.style.display = 'none';
    }

    const badge = this.modal ? this.modal.querySelector('#player-active-source-badge') : null;
    if (badge) badge.textContent = '🔴 STREAM FAILED — choose another source';

    toast.error(message, '✕');
  }

  /**
   * Heartbeats run for as long as the player is open, PAUSED OR NOT. Gating them on
   * `!video.paused` meant a paused viewer stopped being counted as active and Auto-GC deleted
   * the torrent out from under them.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    const beat = () => {
      if (!this.modal || !this.currentInfoHash) return;
      streamingBridge.sendHeartbeat(this.sessionId, this.currentInfoHash, this._getEffectiveTime());
    };
    beat();
    this._heartbeatTimer = setInterval(beat, 10000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Polls the bridge for real download progress while the player is waiting.
   *
   * Replaces an indeterminate spinner over a permanently-animating fake bar, under which a
   * legitimate 60-second download and a permanent hang looked identical.
   */
  _startStatusPolling() {
    this._stopStatusPolling();
    if (!this.currentMagnet) return;

    const generation = this._streamGeneration;

    const poll = async () => {
      if (!this.modal || generation !== this._streamGeneration) return this._stopStatusPolling();

      const status = await streamingBridge.getStreamStatus(this.currentMagnet, this.currentStreamTitle);
      if (!this.modal || generation !== this._streamGeneration) return this._stopStatusPolling();
      if (!status || !status.ok) return;

      this._renderDownloadProgress(status);

      if (status.transcode) {
        this._transcodedDurationSec = status.transcode.transcodedDurationSec || 0;
        this._updateTranscodedRange();
      }

      const pending = this._pendingLoad;
      if (pending && pending.generation === generation) {
        if (pending.kind === 'transcode') {
          // Enough transcoded video exists to start, or the whole thing is done.
          const t = status.transcode;
          const ready = t && (t.state === 'complete' || t.transcodedDurationSec >= this._hlsStartBufferSec);
          if (ready) {
            this._pendingLoad = null;
            this._loadStreamUrl('hls', pending.startSec);
          }
        } else if (status.ready) {
          // Cache-first: the file finished downloading, so a plan is now available.
          this._pendingLoad = null;
          this._showBufferingHUD('Download complete', 'Preparing playback...');
          this._resolveAndLoad(generation, pending.startSec);
        }
      }

      // A seek was accepted beyond the transcode head; perform it once that point exists.
      if (this._seekWaitingForSec !== null &&
          this._transcodedDurationSec >= this._seekWaitingForSec) {
        const target = this._seekWaitingForSec;
        this._seekWaitingForSec = null;
        this._hideBufferingHUD();
        try { this.videoElement.currentTime = target; } catch {}
      }
    };

    poll();
    this._statusTimer = setInterval(poll, 2000);
  }

  _stopStatusPolling() {
    if (this._statusTimer) {
      clearInterval(this._statusTimer);
      this._statusTimer = null;
    }
  }

  _renderDownloadProgress(status) {
    if (!this.modal) return;

    const bar = this.modal.querySelector('#buffering-bar-fill');
    const stats = this.modal.querySelector('#buffering-stats');
    const progressEl = this.modal.querySelector('#buffering-stat-progress');
    const speedEl = this.modal.querySelector('#buffering-stat-speed');
    const etaEl = this.modal.querySelector('#buffering-stat-eta');

    // Still waiting on metadata: genuinely unknown, so the pulse is honest here.
    if (status.state === 'resolving') {
      if (bar) { bar.classList.add('is-indeterminate'); bar.style.width = ''; }
      if (stats) stats.style.display = 'none';
      return;
    }

    // Once the download is done, the transcode is what the viewer is actually waiting on — so that
    // is what the numbers should describe.
    const transcode = status.transcode;
    const showTranscode = Boolean(
      transcode && transcode.state !== 'absent' && (status.ready || this.currentStreamMode === 'hls')
    );

    if (showTranscode) {
      const percent = typeof transcode.progressPercent === 'number' ? transcode.progressPercent : 0;

      if (bar) {
        bar.classList.remove('is-indeterminate');
        bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      }

      if (stats) stats.style.display = 'flex';
      if (progressEl) progressEl.innerHTML = `<strong>${percent.toFixed(1)}%</strong> converted`;
      if (speedEl) {
        speedEl.innerHTML = transcode.transcodedDurationSec
          ? `<strong>${this._formatDuration(transcode.transcodedDurationSec)}</strong> ready to watch`
          : 'starting conversion...';
      }
      if (etaEl) {
        etaEl.innerHTML = transcode.state === 'complete' ? 'conversion complete' : '';
      }
      return;
    }

    const percent = typeof status.progressPercent === 'number' ? status.progressPercent : 0;

    if (bar) {
      bar.classList.remove('is-indeterminate');
      bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }

    if (stats) stats.style.display = 'flex';
    if (progressEl) progressEl.innerHTML = `<strong>${percent.toFixed(1)}%</strong> downloaded`;
    if (speedEl) {
      const mbps = (status.dlSpeed || 0) / 1048576;
      speedEl.innerHTML = mbps > 0
        ? `<strong>${mbps.toFixed(1)}</strong> MB/s · ${status.seeds || 0} seeds`
        : `${status.seeds || 0} seeds`;
    }
    if (etaEl) {
      etaEl.innerHTML = status.etaSeconds > 0
        ? `~<strong>${this._formatDuration(status.etaSeconds)}</strong> left`
        : '';
    }
  }

  _formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return '—';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const sec = Math.round(seconds % 60);
    return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  }

  _showBufferingHUD(title = 'Connecting to Swarm...', subtext = 'Requesting sequential download pieces via VPS qBittorrent bridge...') {
    const hud = this.modal ? this.modal.querySelector('#player-buffering-hud') : null;
    if (!hud) return;

    const titleEl = hud.querySelector('#buffering-title');
    const subEl = hud.querySelector('#buffering-subtext');
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtext;

    // Restore the animated bits in case a previous error state hid them.
    const spinner = hud.querySelector('.buffering-spinner-ring');
    if (spinner) spinner.style.display = '';
    const bar = hud.querySelector('.buffering-progress-bar-wrap');
    if (bar) bar.style.display = '';

    hud.style.display = 'flex';
  }

  _hideBufferingHUD() {
    const hud = this.modal ? this.modal.querySelector('#player-buffering-hud') : null;
    if (hud) hud.style.display = 'none';
  }

  /**
   * The film's full duration, preferring the element, then ffprobe, then the TMDB runtime.
   */
  _totalDuration() {
    // For a segmented stream the element only knows about what has been transcoded so far, so the
    // probed duration is authoritative — otherwise the scrubber would shrink to the transcode head.
    if (this.currentStreamMode === 'hls' && this.probedDuration > 300) return this.probedDuration;
    if (this.duration && this.duration > 300) return this.duration;
    if (this.probedDuration && this.probedDuration > 300) return this.probedDuration;
    return this.totalRuntimeSeconds || 3300;
  }

  _isBuffered(elementTime) {
    const buf = this.videoElement ? this.videoElement.buffered : null;
    if (!buf) return false;
    for (let i = 0; i < buf.length; i++) {
      if (elementTime >= buf.start(i) && elementTime <= buf.end(i)) return true;
    }
    return false;
  }

  /**
   * Draws how much of the film has been transcoded. The boundary matters to the viewer: seeking
   * inside it is instant, beyond it waits — so it has to be visible rather than implied.
   */
  _updateTranscodedRange() {
    const el = this.modal ? this.modal.querySelector('#player-timeline-transcoded') : null;
    if (!el) return;

    if (this.currentStreamMode !== 'hls' || !this._transcodedDurationSec) {
      el.style.width = '0%';
      return;
    }

    const percent = Math.min(100, Math.max(0, (this._transcodedDurationSec / this._totalDuration()) * 100));
    el.style.width = `${percent}%`;
  }

  _updateBufferedRange() {
    const bufferedEl = this.modal ? this.modal.querySelector('.player-timeline-buffered') : null;
    const video = this.videoElement;
    if (!bufferedEl || !video) return;

    const totalDur = this._totalDuration();

    if (video.buffered && video.buffered.length > 0) {
      // In remux mode the element's timeline starts at currentStartSec, not at zero.
      const bufferedEnd = video.buffered.end(video.buffered.length - 1) + (this.currentStartSec || 0);
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
    if (!this.videoElement || !this.videoElement.getAttribute('src')) return;

    // Respect whatever the viewer last set. This used to slam volume back to 1.0 on every play,
    // including the automatic re-loads after a source switch.
    const volume = typeof this.userVolume === 'number' ? this.userVolume : 0.9;
    this.videoElement.muted = false;
    this.videoElement.volume = volume;
    this._updateVolIcon(volume);

    const volSlider = this.modal ? this.modal.querySelector('#player-volume-slider') : null;
    if (volSlider) volSlider.value = volume;

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
    const video = this.videoElement;
    if (!video) return;

    const totalDur = this._totalDuration();
    const clamped = Math.max(0, Math.min(totalDur, targetSeconds));

    if (this.currentStreamMode === 'hls') {
      // Inside the transcoded range this is an ordinary seek — hls.js fetches the segment that
      // covers it. Beyond the head the segment does not exist yet, so the seek is ACCEPTED and
      // deferred rather than refused: the scrubber should not lie about where you can go.
      const head = this._transcodedDurationSec;
      const complete = head > 0 && head >= this._totalDuration() - 1;

      if (!complete && head > 0 && clamped > head) {
        this._seekWaitingForSec = clamped;
        try { video.currentTime = Math.max(0, head - 1); } catch {}
        this._showBufferingHUD(
          'Waiting for the transcoder...',
          `Seeking to ${this._formatTime(clamped)} — transcoded up to ${this._formatTime(head)} so far.`
        );
        this._startStatusPolling();
      } else {
        this._seekWaitingForSec = null;
        try { video.currentTime = clamped; } catch {}
      }
    } else if (!this.currentMagnet || this.currentStreamMode === 'direct') {
      // Byte-range backed: seek natively and let the bridge map the offset onto torrent pieces.
      try { video.currentTime = clamped; } catch {}
    } else {
      // Progressive fMP4 carries no index, so a seek outside the buffered window means restarting
      // FFmpeg at the new timestamp. The previous code restarted the whole stream on EVERY seek,
      // including seeks into already-buffered territory.
      const local = clamped - (this.currentStartSec || 0);
      if (local >= 0 && this._isBuffered(local)) {
        try { video.currentTime = local; } catch {}
      } else {
        this._showBufferingHUD('Seeking...', `Restarting the remuxed stream at ${this._formatTime(clamped)}...`);
        this._loadStreamUrl('remux', clamped);
      }
    }

    this._updateProgressBar();
    this._updateTimeDisplay();
  }

  _updateProgressBar() {
    const progressFill = this.modal ? this.modal.querySelector('#player-timeline-progress') : null;
    const progressHandle = this.modal ? this.modal.querySelector('#player-timeline-handle') : null;
    if (!progressFill || !progressHandle) return;

    const totalDur = this._totalDuration();
    const current = this._getEffectiveTime();
    const percent = Math.min(100, Math.max(0, (current / totalDur) * 100));

    progressFill.style.width = `${percent}%`;
    progressHandle.style.left = `${percent}%`;
  }

  _updateTimeDisplay() {
    const curEl = this.modal ? this.modal.querySelector('#player-current-time') : null;
    const durEl = this.modal ? this.modal.querySelector('#player-total-duration') : null;
    const totalDur = this._totalDuration();
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

  close() {
    streamingBridge.sendLeave(this.sessionId, this.currentInfoHash);

    this._stopHeartbeat();
    this._stopStatusPolling();
    this._destroyHls();

    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    if (this.currentMovie && this.currentTime > 5) {
      store.saveProgress({
        movie: this.currentMovie,
        currentTime: this.currentTime,
        duration: this._totalDuration()
      });
    }

    if (this._keydownHandler) {
      window.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
    if (this._onTimelineMove) {
      window.removeEventListener('mousemove', this._onTimelineMove);
      this._onTimelineMove = null;
    }
    if (this._onTimelineUp) {
      window.removeEventListener('mouseup', this._onTimelineUp);
      this._onTimelineUp = null;
    }
    if (this._pageHideHandler) {
      window.removeEventListener('pagehide', this._pageHideHandler);
      this._pageHideHandler = null;
    }

    // Detaching the source stops the browser holding the bridge connection open after close.
    if (this.videoElement) {
      try {
        this.videoElement.pause();
        this.videoElement.removeAttribute('src');
        this.videoElement.load();
      } catch {}
    }

    // Invalidate any prepare() still in flight for this player.
    this._streamGeneration++;
    this.currentMagnet = null;
    this.currentInfoHash = null;
    this.currentStreamMode = null;
    this.sessionId = null;

    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
    this.videoElement = null;
  }
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const playerModal = new PlayerModalManager();
