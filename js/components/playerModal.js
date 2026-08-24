/**
 * Cinematic Video Streaming Player Modal Component
 * Full-featured player with custom controls, quality toggle, audio/subtitles, progress tracking, and TV episode switching
 */

import { store } from '../state/store.js';
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
  }

  open(movie, options = {}) {
    this.close();

    this.currentMovie = movie;
    const isTV = movie.media_type === 'tv' || (!movie.title && movie.name);
    const title = movie.title || movie.name;
    const season = options.season || 1;
    const episode = options.episode || 1;
    const existingProgress = store.getMovieProgress(movie.id);

    // Initial starting time (resume from continue watching if exists)
    this.currentTime = (existingProgress && existingProgress.currentTime) ? existingProgress.currentTime : 0;
    this.duration = (existingProgress && existingProgress.duration) ? existingProgress.duration : 7200;

    const modal = document.createElement('div');
    modal.className = 'player-modal-backdrop animate-fade-in';
    modal.id = 'streaming-player-modal';

    modal.innerHTML = `
      <div class="player-container" id="player-container">
        <!-- Video Element / Stream Simulation -->
        <video class="main-video-element" id="main-video-element" preload="auto" playsinline>
          <source src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4" type="video/mp4">
          <source src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" type="video/mp4">
        </video>

        <!-- Player Top Bar Overlay -->
        <div class="player-top-bar animate-fade-in">
          <button class="player-btn-back" id="player-btn-back" title="Exit Player">
            <span class="btn-icon">←</span>
            <span class="btn-text">Back to CineStream</span>
          </button>

          <div class="player-title-info">
            <h2 class="player-video-title">${_escape(title)}</h2>
            ${isTV ? `<span class="player-episode-badge">Season ${season}, Episode ${episode}</span>` : ''}
          </div>

          <div class="player-top-actions">
            <span class="player-quality-pill">4K HDR</span>
          </div>
        </div>

        <!-- Center Big Play/Pause Splash -->
        <div class="player-center-splash" id="player-center-splash" style="display:none;">
          <span class="splash-icon">▶</span>
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

    this._bindPlayerEvents(isTV, season, episode);

    // If starting from saved progress
    if (this.currentTime > 0) {
      toast.info(`Resuming "${title}" from ${this._formatTime(this.currentTime)}`);
    }

    // Auto play
    this._play();
  }

  _bindPlayerEvents(isTV, season, episode) {
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
    const video = this.videoElement;

    // Back to app
    backBtn.addEventListener('click', () => this.close());

    // Play / Pause
    playPauseBtn.addEventListener('click', () => this._togglePlay());
    video.addEventListener('click', () => this._togglePlay());

    // Skip
    skipBackBtn.addEventListener('click', () => {
      video.currentTime = Math.max(0, video.currentTime - 10);
    });

    skipFwdBtn.addEventListener('click', () => {
      video.currentTime = Math.min(video.duration || this.duration, video.currentTime + 10);
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

    // Video loaded metadata
    video.addEventListener('loadedmetadata', () => {
      this.duration = video.duration || this.duration;
      if (this.currentTime > 0) {
        video.currentTime = this.currentTime;
      }
      this._updateTimeDisplay();
    });

    // Video timeupdate
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
      if (e.key === 'Escape') {
        this.close();
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

    // Auto-save progress to store every 5 seconds
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

  _togglePlay() {
    if (this.videoElement.paused) {
      this._play();
    } else {
      this._pause();
    }
  }

  _play() {
    this.videoElement.play().then(() => {
      this.isPlaying = true;
      const icon = this.modal.querySelector('#ctrl-play-icon');
      if (icon) icon.textContent = '❚❚';
    }).catch(() => {
      this.isPlaying = false;
    });
  }

  _pause() {
    this.videoElement.pause();
    this.isPlaying = false;
    const icon = this.modal.querySelector('#ctrl-play-icon');
    if (icon) icon.textContent = '▶';
  }

  _scrub(e) {
    const timeline = this.modal.querySelector('#player-timeline-wrap');
    if (!timeline) return;
    const rect = timeline.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.videoElement.currentTime = pos * (this.videoElement.duration || this.duration);
  }

  _updateProgressBar() {
    const progressFill = this.modal.querySelector('#player-timeline-progress');
    const progressHandle = this.modal.querySelector('#player-timeline-handle');
    if (!progressFill || !progressHandle) return;

    const percent = ((this.videoElement.currentTime / (this.videoElement.duration || this.duration)) * 100) || 0;
    progressFill.style.width = `${percent}%`;
    progressHandle.style.left = `${percent}%`;
  }

  _updateTimeDisplay() {
    const curEl = this.modal.querySelector('#player-current-time');
    const durEl = this.modal.querySelector('#player-total-duration');
    if (curEl) curEl.textContent = this._formatTime(this.videoElement.currentTime);
    if (durEl) durEl.textContent = this._formatTime(this.videoElement.duration || this.duration);
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
