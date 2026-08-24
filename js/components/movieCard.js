/**
 * Movie / TV Show Card Component
 * Supports poster image, hover actions, rating badge, watchlist status & progress bar
 */

import { getPosterUrl } from '../api/tmdb.js';
import { store } from '../state/store.js';
import { actionMenu } from './actionMenu.js';
import { toast } from './toast.js';

export function createMovieCard(movie, options = {}) {
  const card = document.createElement('div');
  card.className = `movie-card ${options.compact ? 'movie-card-compact' : ''}`;
  card.dataset.id = movie.id;
  card.dataset.mediaType = movie.media_type || (movie.title ? 'movie' : 'tv');

  const title = movie.title || movie.name || 'Untitled';
  const releaseDate = movie.release_date || movie.first_air_date || '';
  const year = releaseDate ? releaseDate.substring(0, 4) : '';
  const posterUrl = getPosterUrl(movie.poster_path, 'w500');
  const tmdbRating = movie.vote_average ? movie.vote_average.toFixed(1) : null;
  const inWatchlist = store.isInWatchlist(movie.id);
  const isFav = store.isFavorite(movie.id);
  const userRating = store.getUserRating(movie.id);
  const isWatched = store.isWatched(movie.id);
  const progress = options.progress || (options.isContinueWatching ? movie.percent : null);

  card.innerHTML = `
    <div class="movie-poster-wrap">
      <img src="${posterUrl}" alt="${_escape(title)}" class="movie-poster" loading="lazy" />
      
      <div class="poster-badge-row">
        ${tmdbRating ? `<span class="badge-rating tmdb-badge">★ ${tmdbRating}</span>` : ''}
        ${userRating ? `<span class="badge-rating user-badge" title="Your rating">★ ${userRating}</span>` : ''}
        ${isWatched && !userRating ? `<span class="badge-rating watched-badge" title="Watched">👁</span>` : ''}
      </div>

      ${progress ? `
        <div class="card-progress-bar-wrap">
          <div class="card-progress-bar-fill" style="width: ${progress}%;"></div>
        </div>
      ` : ''}

      <div class="poster-overlay">
        <div class="overlay-top-actions">
          <button class="icon-btn btn-fav ${isFav ? 'is-active text-pink' : ''}" title="Favorite" aria-label="Favorite">
            ${isFav ? '♥' : '♡'}
          </button>
          <button class="icon-btn btn-watchlist ${inWatchlist ? 'is-active text-green' : ''}" title="Watchlist" aria-label="Watchlist">
            ${inWatchlist ? '✓' : '＋'}
          </button>
        </div>

        <button class="overlay-play-btn" title="Play / Stream" aria-label="Play">
          <span class="play-icon">▶</span>
        </button>

        <div class="overlay-bottom-actions">
          <button class="icon-btn btn-more action-menu-trigger" title="More Actions" aria-label="More Actions">
            ⋯
          </button>
        </div>
      </div>
    </div>

    <div class="movie-info">
      <h3 class="movie-title" title="${_escape(title)}">${_escape(title)}</h3>
      <div class="movie-meta">
        ${year ? `<span class="movie-year">${year}</span>` : ''}
        <span class="movie-type-tag">${(movie.media_type || (movie.title ? 'movie' : 'tv')).toUpperCase()}</span>
      </div>
    </div>
  `;

  // Attach Event Handlers
  const posterWrap = card.querySelector('.movie-poster-wrap');
  const playBtn = card.querySelector('.overlay-play-btn');
  const favBtn = card.querySelector('.btn-fav');
  const watchlistBtn = card.querySelector('.btn-watchlist');
  const moreBtn = card.querySelector('.btn-more');

  // Click entire card to open detail modal
  card.addEventListener('click', (e) => {
    // If clicked on quick action buttons, do not trigger card detail
    if (e.target.closest('.icon-btn') || e.target.closest('.overlay-play-btn')) return;
    window.app.openDetailModal(movie);
  });

  // Play button
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.app.openPlayer(movie);
  });

  // Quick Favorite toggle
  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowFav = store.toggleFavorite(movie);
    favBtn.innerHTML = nowFav ? '♥' : '♡';
    favBtn.classList.toggle('is-active', nowFav);
    favBtn.classList.toggle('text-pink', nowFav);
    if (nowFav) {
      toast.favorite(`Added "${title}" to Favorites`);
    } else {
      toast.info(`Removed "${title}" from Favorites`);
    }
  });

  // Quick Watchlist toggle
  watchlistBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowIn = store.toggleWatchlist(movie);
    watchlistBtn.innerHTML = nowIn ? '✓' : '＋';
    watchlistBtn.classList.toggle('is-active', nowIn);
    watchlistBtn.classList.toggle('text-green', nowIn);
    toast.success(nowIn ? `Added "${title}" to Watchlist` : `Removed "${title}" from Watchlist`);
  });

  // More action menu trigger
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actionMenu.open(movie, moreBtn);
  });

  return card;
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
