/**
 * Rate & Review & Diary Modal Component
 * Supports 0.5 - 5.0 half-star interactive ratings, spoiler-protected reviews, and date logging
 */

import { store } from '../state/store.js';
import { getPosterUrl } from '../api/tmdb.js';
import { toast } from './toast.js';

export class RateReviewModal {
  constructor() {
    this.modal = null;
    this.currentMovie = null;
    this.selectedRating = 0;
    this.tempRating = 0;
  }

  open(movie, options = {}) {
    this.currentMovie = movie;
    const existingRating = store.getUserRating(movie.id) || 0;
    this.selectedRating = existingRating;
    this.tempRating = existingRating;

    const existingReviews = store.getMovieReviews(movie.id);
    const userReview = existingReviews.length > 0 ? existingReviews[0] : null;
    const isWatchedAlready = store.isWatched(movie.id);

    const title = movie.title || movie.name;
    const posterUrl = getPosterUrl(movie.poster_path, 'w342');
    const releaseDate = movie.release_date || movie.first_air_date || '';
    const year = releaseDate ? releaseDate.substring(0, 4) : '';

    this._createModalHtml({
      title,
      posterUrl,
      year,
      existingRating,
      userReview,
      isWatchedAlready,
      options
    });
  }

  _createModalHtml({ title, posterUrl, year, existingRating, userReview, isWatchedAlready, options }) {
    this.close();

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop animate-fade-in';
    modal.id = 'rate-review-modal';

    const todayDate = new Date().toISOString().split('T')[0];

    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-letterboxd animate-scale-in">
        <div class="modal-header">
          <div class="modal-title-wrap">
            <span class="modal-eyebrow">I WATCHED...</span>
            <h2 class="modal-title">${_escape(title)} ${year ? `<span class="modal-year">(${year})</span>` : ''}</h2>
          </div>
          <button class="modal-close-btn" id="modal-rate-close">&times;</button>
        </div>

        <div class="modal-body modal-rate-body">
          <div class="rate-movie-preview">
            <img src="${posterUrl}" alt="${_escape(title)}" class="rate-movie-poster" />
            <div class="rate-movie-tmdb-info">
              <span class="text-muted">TMDB Community Rating:</span>
              <span class="text-gold font-bold">★ ${this.currentMovie.vote_average ? this.currentMovie.vote_average.toFixed(1) : '8.0'}/10</span>
            </div>
          </div>

          <div class="rate-form-content">
            <!-- 0.5 - 5.0 Star Interactive Picker -->
            <div class="rating-picker-section">
              <label class="form-label">YOUR RATING</label>
              <div class="star-rating-widget" id="star-rating-widget">
                <div class="star-interactive-container" id="star-interactive-container">
                  ${[1, 2, 3, 4, 5].map(starNum => `
                    <div class="star-box" data-star="${starNum}">
                      <div class="star-half star-half-left" data-value="${starNum - 0.5}"></div>
                      <div class="star-half star-half-right" data-value="${starNum}"></div>
                      <span class="star-visual">★</span>
                    </div>
                  `).join('')}
                </div>
                <div class="rating-label-display" id="rating-label-display">
                  ${this.selectedRating > 0 ? this._getRatingLabel(this.selectedRating) : 'Select a rating (Click star)'}
                </div>
                ${this.selectedRating > 0 ? `
                  <button class="btn-clear-rating" id="btn-clear-rating" title="Clear rating">Clear Rating</button>
                ` : ''}
              </div>
            </div>

            <!-- Date Watched & Rewatch -->
            <div class="form-row form-row-split">
              <div class="form-group">
                <label class="form-label" for="diary-watched-date">WATCH DATE</label>
                <input type="date" id="diary-watched-date" class="form-input" value="${todayDate}" />
              </div>
              <div class="form-group flex-center-bottom">
                <label class="checkbox-label" for="diary-rewatch-checkbox">
                  <input type="checkbox" id="diary-rewatch-checkbox" ${isWatchedAlready ? 'checked' : ''} />
                  <span class="checkbox-custom"></span>
                  <span class="checkbox-text">I've seen this before (Rewatch)</span>
                </label>
              </div>
            </div>

            <!-- Review Textarea -->
            <div class="form-group">
              <label class="form-label" for="diary-review-text">PERSONAL REVIEW / NOTES</label>
              <textarea id="diary-review-text" class="form-textarea" placeholder="Add your review, thoughts on direction, cinematography, themes..." rows="4">${userReview ? _escape(userReview.text) : ''}</textarea>
            </div>

            <!-- Spoilers Checkbox -->
            <div class="form-group">
              <label class="checkbox-label" for="diary-spoiler-checkbox">
                <input type="checkbox" id="diary-spoiler-checkbox" ${userReview && userReview.isSpoiler ? 'checked' : ''} />
                <span class="checkbox-custom"></span>
                <span class="checkbox-text">⚠️ This review contains spoilers</span>
              </label>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" id="btn-cancel-rate">Cancel</button>
          <button class="btn btn-primary" id="btn-save-rate-diary">
            <span class="btn-icon">✓</span>
            <span class="btn-text">Save to Diary & Library</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modal = modal;

    this._bindEvents();
    this._updateStarVisuals(this.selectedRating);

    // If options specify focusing review
    if (options.focusReview) {
      setTimeout(() => {
        const txt = document.getElementById('diary-review-text');
        if (txt) txt.focus();
      }, 100);
    }
  }

  _bindEvents() {
    const closeBtn = document.getElementById('modal-rate-close');
    const cancelBtn = document.getElementById('btn-cancel-rate');
    const saveBtn = document.getElementById('btn-save-rate-diary');
    const starContainer = document.getElementById('star-interactive-container');
    const clearRatingBtn = document.getElementById('btn-clear-rating');

    if (closeBtn) closeBtn.addEventListener('click', () => this.close());
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());

    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });

    if (clearRatingBtn) {
      clearRatingBtn.addEventListener('click', () => {
        this.selectedRating = 0;
        this.tempRating = 0;
        this._updateStarVisuals(0);
        document.getElementById('rating-label-display').textContent = 'No rating selected';
        clearRatingBtn.style.display = 'none';
      });
    }

    // Star interactive hover and click (half-star precision)
    if (starContainer) {
      const halfStars = starContainer.querySelectorAll('.star-half');

      halfStars.forEach(half => {
        const val = Number(half.dataset.value);

        half.addEventListener('mouseenter', () => {
          this._updateStarVisuals(val);
          document.getElementById('rating-label-display').textContent = this._getRatingLabel(val);
        });

        half.addEventListener('click', () => {
          this.selectedRating = val;
          this._updateStarVisuals(val);
          document.getElementById('rating-label-display').textContent = this._getRatingLabel(val);
          const clrBtn = document.getElementById('btn-clear-rating');
          if (clrBtn) clrBtn.style.display = 'inline-block';
        });
      });

      starContainer.addEventListener('mouseleave', () => {
        this._updateStarVisuals(this.selectedRating);
        document.getElementById('rating-label-display').textContent = this.selectedRating > 0
          ? this._getRatingLabel(this.selectedRating)
          : 'Select a rating (Click star)';
      });
    }

    // Save action
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const dateInput = document.getElementById('diary-watched-date');
        const rewatchCheck = document.getElementById('diary-rewatch-checkbox');
        const reviewText = document.getElementById('diary-review-text');
        const spoilerCheck = document.getElementById('diary-spoiler-checkbox');

        const watchedAt = dateInput ? new Date(dateInput.value).toISOString() : new Date().toISOString();
        const rewatch = rewatchCheck ? rewatchCheck.checked : false;
        const text = reviewText ? reviewText.value.trim() : '';
        const isSpoiler = spoilerCheck ? spoilerCheck.checked : false;

        // Log entry to Diary
        store.logWatched({
          movie: this.currentMovie,
          rating: this.selectedRating > 0 ? this.selectedRating : null,
          review: text,
          isSpoiler,
          rewatch,
          watchedAt
        });

        // Set or remove rating in global map
        if (this.selectedRating > 0) {
          store.setRating(this.currentMovie.id, this.selectedRating);
        }

        const title = this.currentMovie.title || this.currentMovie.name;
        toast.success(`Logged "${title}" to your diary!`, '👁');
        this.close();
      });
    }
  }

  _updateStarVisuals(ratingValue) {
    const starContainer = document.getElementById('star-interactive-container');
    if (!starContainer) return;

    const starBoxes = starContainer.querySelectorAll('.star-box');
    starBoxes.forEach(box => {
      const starNum = Number(box.dataset.star);
      box.classList.remove('star-full', 'star-half-filled', 'star-empty');

      if (ratingValue >= starNum) {
        box.classList.add('star-full');
      } else if (ratingValue === starNum - 0.5) {
        box.classList.add('star-half-filled');
      } else {
        box.classList.add('star-empty');
      }
    });
  }

  _getRatingLabel(val) {
    const stars = '★'.repeat(Math.floor(val)) + (val % 1 !== 0 ? '½' : '');
    const labels = {
      0.5: '½ (Appalling)',
      1.0: '★ (Poor)',
      1.5: '★½ (Mediocre)',
      2.0: '★★ (Fair)',
      2.5: '★★½ (Average)',
      3.0: '★★★ (Good)',
      3.5: '★★★½ (Very Good)',
      4.0: '★★★★ (Great)',
      4.5: '★★★★½ (Exceptional)',
      5.0: '★★★★★ (Masterpiece)'
    };
    return `${stars} — ${labels[val] || `${val} Stars`}`;
  }

  close() {
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

export const rateReviewModal = new RateReviewModal();
