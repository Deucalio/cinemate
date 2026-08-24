/**
 * Cinematic Hero Banner Component
 * Features full-bleed backdrop, trailer preview, metadata badges, and multi-featured carousel
 */

import { getBackdropUrl, MOVIE_GENRES, TV_GENRES } from '../api/tmdb.js';
import { store } from '../state/store.js';
import { toast } from './toast.js';

export class HeroBanner {
  constructor(containerId = 'hero-container') {
    this.container = document.getElementById(containerId);
    this.featuredItems = [];
    this.currentIndex = 0;
    this.autoplayInterval = null;
  }

  render(featuredItems) {
    if (!this.container) return;
    this.featuredItems = (featuredItems || []).filter(item => item.backdrop_path).slice(0, 5);
    if (this.featuredItems.length === 0) {
      this.container.innerHTML = '';
      return;
    }

    this.currentIndex = 0;
    this._renderCurrent();
    this._startAutoplay();
  }

  _renderCurrent() {
    const movie = this.featuredItems[this.currentIndex];
    if (!movie) return;

    const title = movie.title || movie.name || 'Featured Title';
    const backdropUrl = getBackdropUrl(movie.backdrop_path, 'original');
    const releaseDate = movie.release_date || movie.first_air_date || '';
    const year = releaseDate ? releaseDate.substring(0, 4) : '2024';
    const rating = movie.vote_average ? movie.vote_average.toFixed(1) : '8.5';
    const inWatchlist = store.isInWatchlist(movie.id);
    const isFav = store.isFavorite(movie.id);
    const userRating = store.getUserRating(movie.id);
    const genresDict = movie.title ? MOVIE_GENRES : TV_GENRES;
    const genreNames = (movie.genre_ids || [])
      .slice(0, 3)
      .map(id => genresDict[id])
      .filter(Boolean)
      .join(' • ');

    this.container.innerHTML = `
      <div class="hero-banner animate-fade-in" style="background-image: url('${backdropUrl}');">
        <div class="hero-vignette-overlay"></div>
        <div class="hero-content-wrapper">
          <div class="hero-badges-row">
            <span class="hero-badge hero-badge-tmdb">★ TMDB ${rating}</span>
            <span class="hero-badge hero-badge-quality">4K ULTRA HD</span>
            <span class="hero-badge hero-badge-audio">DOLBY ATMOS</span>
            <span class="hero-badge hero-badge-year">${year}</span>
            ${userRating ? `<span class="hero-badge hero-badge-user-rating">★ Your Rating: ${userRating}</span>` : ''}
          </div>

          <h1 class="hero-title">${_escape(title)}</h1>

          ${genreNames ? `<p class="hero-genres">${genreNames}</p>` : ''}

          <p class="hero-overview">${_escape(movie.overview || 'Experience this cinematic masterpiece in ultra-high definition streaming.')}</p>

          <div class="hero-actions-row">
            <button class="btn btn-primary hero-btn-play" id="hero-btn-play">
              <span class="btn-icon">▶</span>
              <span class="btn-text">Play Now</span>
            </button>

            <button class="btn btn-secondary hero-btn-watchlist ${inWatchlist ? 'is-active' : ''}" id="hero-btn-watchlist">
              <span class="btn-icon">${inWatchlist ? '✓' : '＋'}</span>
              <span class="btn-text">${inWatchlist ? 'In Watchlist' : 'Add to Watchlist'}</span>
            </button>

            <button class="btn btn-glass hero-btn-rate" id="hero-btn-rate" title="Rate / Log">
              <span class="btn-icon">★</span>
              <span class="btn-text">${userRating ? `${userRating}★` : 'Rate'}</span>
            </button>

            <button class="btn btn-glass hero-btn-fav ${isFav ? 'text-pink' : ''}" id="hero-btn-fav" title="Favorite">
              <span class="btn-icon">${isFav ? '♥' : '♡'}</span>
            </button>

            <button class="btn btn-glass hero-btn-info" id="hero-btn-info" title="More Info">
              <span class="btn-icon">ℹ</span>
              <span class="btn-text">More Info</span>
            </button>
          </div>
        </div>

        <!-- Carousel Indicators -->
        <div class="hero-carousel-nav">
          <button class="hero-nav-arrow hero-nav-prev" id="hero-prev-btn" aria-label="Previous">❮</button>
          <div class="hero-indicators">
            ${this.featuredItems.map((_, idx) => `
              <button class="hero-indicator-dot ${idx === this.currentIndex ? 'is-active' : ''}" data-index="${idx}" aria-label="Slide ${idx + 1}"></button>
            `).join('')}
          </div>
          <button class="hero-nav-arrow hero-nav-next" id="hero-next-btn" aria-label="Next">❯</button>
        </div>
      </div>
    `;

    // Event Bindings
    const playBtn = document.getElementById('hero-btn-play');
    const watchlistBtn = document.getElementById('hero-btn-watchlist');
    const rateBtn = document.getElementById('hero-btn-rate');
    const favBtn = document.getElementById('hero-btn-fav');
    const infoBtn = document.getElementById('hero-btn-info');
    const prevBtn = document.getElementById('hero-prev-btn');
    const nextBtn = document.getElementById('hero-next-btn');

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        window.app.openPlayer(movie);
      });
    }

    if (watchlistBtn) {
      watchlistBtn.addEventListener('click', () => {
        const added = store.toggleWatchlist(movie);
        watchlistBtn.querySelector('.btn-text').textContent = added ? 'In Watchlist' : 'Add to Watchlist';
        watchlistBtn.querySelector('.btn-icon').textContent = added ? '✓' : '＋';
        watchlistBtn.classList.toggle('is-active', added);
        toast.success(added ? `Added "${title}" to Watchlist` : `Removed "${title}" from Watchlist`);
      });
    }

    if (rateBtn) {
      rateBtn.addEventListener('click', () => {
        window.app.openRateReviewModal(movie, { focusRate: true });
      });
    }

    if (favBtn) {
      favBtn.addEventListener('click', () => {
        const isFavNow = store.toggleFavorite(movie);
        favBtn.querySelector('.btn-icon').textContent = isFavNow ? '♥' : '♡';
        favBtn.classList.toggle('text-pink', isFavNow);
        if (isFavNow) {
          toast.favorite(`Added "${title}" to Favorites`);
        } else {
          toast.info(`Removed "${title}" from Favorites`);
        }
      });
    }

    if (infoBtn) {
      infoBtn.addEventListener('click', () => {
        window.app.openDetailModal(movie);
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        this.prev();
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        this.next();
      });
    }

    this.container.querySelectorAll('.hero-indicator-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        const idx = Number(dot.dataset.index);
        this.goTo(idx);
      });
    });
  }

  _startAutoplay() {
    this._stopAutoplay();
    this.autoplayInterval = setInterval(() => {
      this.next();
    }, 8500);
  }

  _stopAutoplay() {
    if (this.autoplayInterval) {
      clearInterval(this.autoplayInterval);
      this.autoplayInterval = null;
    }
  }

  next() {
    if (this.featuredItems.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.featuredItems.length;
    this._renderCurrent();
  }

  prev() {
    if (this.featuredItems.length <= 1) return;
    this.currentIndex = (this.currentIndex - 1 + this.featuredItems.length) % this.featuredItems.length;
    this._renderCurrent();
  }

  goTo(index) {
    if (index >= 0 && index < this.featuredItems.length) {
      this.currentIndex = index;
      this._renderCurrent();
    }
  }

  destroy() {
    this._stopAutoplay();
  }
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
