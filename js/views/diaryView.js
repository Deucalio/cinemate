/**
 * Viewing Diary / Watch History View (Letterboxd Style)
 * Chronological viewing diary grouped by month/date with half-stars, rewatches, reviews and stats
 */

import { store } from '../state/store.js';
import { getPosterUrl } from '../api/tmdb.js';
import { toast } from '../components/toast.js';

export function renderDiaryView(container) {
  function render() {
    const rawDiary = store.getDiary();
    const stats = store.getStatistics();

    // Group entries by Month & Year
    const groups = {};
    rawDiary.forEach(entry => {
      const d = new Date(entry.watchedAt || Date.now());
      const monthYear = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      if (!groups[monthYear]) {
        groups[monthYear] = [];
      }
      groups[monthYear].push(entry);
    });

    container.innerHTML = `
      <div class="diary-page-container animate-fade-in">
        <div class="catalog-header">
          <div class="header-badge-title-row">
            <h1 class="catalog-title">Personal Movie Diary</h1>
            <span class="catalog-counter-badge">${rawDiary.length} ${rawDiary.length === 1 ? 'entry' : 'entries'}</span>
          </div>
          <p class="catalog-subtitle">Your chronological log of watched cinema, rewatches, personal ratings, and thoughts.</p>
        </div>

        <!-- Quick Summary Bar -->
        <div class="diary-summary-bar">
          <div class="diary-summary-stat">
            <span class="summary-num text-blue">${stats.totalWatched}</span>
            <span class="summary-lbl">Movies Logged</span>
          </div>
          <div class="diary-summary-stat">
            <span class="summary-num text-emerald">${stats.hoursWatched}h</span>
            <span class="summary-lbl">Total Time</span>
          </div>
          <div class="diary-summary-stat">
            <span class="summary-num text-gold">★ ${stats.avgRating}</span>
            <span class="summary-lbl">Average Rating</span>
          </div>
          <div class="diary-summary-stat">
            <span class="summary-num text-pink">♥ ${stats.totalFavorites}</span>
            <span class="summary-lbl">Favorites</span>
          </div>
        </div>

        <!-- Diary Entries Timeline -->
        ${rawDiary.length === 0 ? `
          <div class="empty-state-card animate-fade-in">
            <span class="empty-icon">👁</span>
            <h3>YOUR DIARY IS EMPTY</h3>
            <p>Keep a chronological record of everything you watch. Click <strong>Mark as Watched</strong> on any movie or TV show to log your first entry.</p>
            <a href="#discover" class="btn btn-primary btn-lg mt-3">
              <span class="btn-icon">🎬</span>
              <span class="btn-text">Browse & Log Movies</span>
            </a>
          </div>
        ` : `
          <div class="diary-timeline">
            ${Object.entries(groups).map(([monthYear, entries]) => `
              <div class="diary-month-group">
                <div class="diary-month-header">
                  <h2 class="diary-month-title">${monthYear.toUpperCase()}</h2>
                  <span class="diary-month-count">${entries.length} ${entries.length === 1 ? 'film' : 'films'}</span>
                </div>

                <div class="diary-entries-table">
                  <div class="diary-table-header">
                    <span class="col-date">DATE</span>
                    <span class="col-film">FILM</span>
                    <span class="col-rating">RATING</span>
                    <span class="col-rewatch">REWATCH</span>
                    <span class="col-review">REVIEW</span>
                    <span class="col-actions">ACTIONS</span>
                  </div>

                  ${entries.map(entry => {
                    const dateObj = new Date(entry.watchedAt);
                    const dayNum = dateObj.getDate().toString().padStart(2, '0');
                    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
                    const poster = getPosterUrl(entry.poster_path, 'w185');
                    const ratingStars = entry.rating
                      ? '★'.repeat(Math.floor(entry.rating)) + (entry.rating % 1 !== 0 ? '½' : '')
                      : null;

                    return `
                      <div class="diary-entry-row" data-entry-id="${entry.id}">
                        <div class="col-date">
                          <span class="diary-day-num">${dayNum}</span>
                          <span class="diary-day-name">${dayName}</span>
                        </div>

                        <div class="col-film">
                          <img src="${poster}" class="diary-film-poster" alt="${_escape(entry.title)}" loading="lazy" />
                          <div class="diary-film-info">
                            <h3 class="diary-film-title">${_escape(entry.title)}</h3>
                            <span class="diary-film-year">${(entry.release_date || '').substring(0, 4)}</span>
                          </div>
                        </div>

                        <div class="col-rating">
                          ${ratingStars ? `<span class="star-gold diary-rating-stars">${ratingStars}</span>` : '<span class="text-muted">—</span>'}
                        </div>

                        <div class="col-rewatch">
                          ${entry.rewatch ? `<span class="badge-rewatch" title="Rewatched film">🔄</span>` : ''}
                          ${entry.favorite ? `<span class="text-pink ml-1" title="Favorited">♥</span>` : ''}
                        </div>

                        <div class="col-review">
                          ${entry.review ? `
                            <div class="diary-review-cell ${entry.isSpoiler ? 'has-spoiler' : ''}">
                              ${entry.isSpoiler ? `<span class="spoiler-tag">⚠️ Spoiler</span>` : ''}
                              <p class="diary-review-text">“${_escape(entry.review)}”</p>
                            </div>
                          ` : '<span class="text-muted">—</span>'}
                        </div>

                        <div class="col-actions">
                          <button class="btn btn-sm btn-glass btn-diary-play" data-movie-id="${entry.movieId}" title="Play Film">▶</button>
                          <button class="btn btn-sm btn-glass btn-diary-details" data-movie-id="${entry.movieId}" title="View Details">ℹ</button>
                          <button class="btn btn-sm btn-glass text-red btn-diary-delete" data-entry-id="${entry.id}" title="Delete Entry">✕</button>
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;

    _bindDiaryEvents(container, render);
  }

  render();
}

function _bindDiaryEvents(container, reRender) {
  // Play
  container.querySelectorAll('.btn-diary-play').forEach(btn => {
    btn.addEventListener('click', () => {
      const movieId = Number(btn.dataset.movieId);
      const entry = store.getDiary().find(d => Number(d.movieId) === movieId);
      if (entry) {
        window.app.openPlayer({ id: entry.movieId, title: entry.title, poster_path: entry.poster_path, media_type: entry.media_type });
      }
    });
  });

  // Details
  container.querySelectorAll('.btn-diary-details').forEach(btn => {
    btn.addEventListener('click', () => {
      const movieId = Number(btn.dataset.movieId);
      const entry = store.getDiary().find(d => Number(d.movieId) === movieId);
      if (entry) {
        window.app.openDetailModal({ id: entry.movieId, title: entry.title, media_type: entry.media_type });
      }
    });
  });

  // Delete
  container.querySelectorAll('.btn-diary-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const entryId = btn.dataset.entryId;
      if (confirm('Delete this diary log entry?')) {
        store.deleteDiaryEntry(entryId);
        toast.info('Diary entry deleted');
        reRender();
      }
    });
  });
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
