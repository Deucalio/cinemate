/**
 * Personal Library Hub View (Letterboxd + Netflix Style)
 * Unified dashboard for Watchlist, Continue Watching, Watched History, Favorites, Reviews, and Custom Playlists
 */

import { store } from '../state/store.js';
import { createMovieCard } from '../components/movieCard.js';
import { generateListCollageHtml } from '../components/listModal.js';

export function renderLibraryView(container) {
  const stats = store.getStatistics();
  const continueWatching = store.getContinueWatchingList();
  const watchlist = store.getWatchlist();
  const diary = store.getDiary();
  const favorites = store.getFavorites();
  const customLists = store.getCustomLists();
  const reviews = store.getReviews();

  container.innerHTML = `
    <div class="library-dashboard-container animate-fade-in">
      <!-- Header / Profile Quick Bar -->
      <div class="library-header">
        <div class="library-header-left">
          <span class="library-eyebrow">YOUR PERSONAL CINEMA ARCHIVE</span>
          <h1 class="library-title">My Cinema Library</h1>
        </div>
        <div class="library-header-actions">
          <button class="btn btn-primary" id="btn-library-create-list">
            <span class="btn-icon">＋</span>
            <span class="btn-text">New Custom List</span>
          </button>
          <a href="#diary" class="btn btn-secondary">
            <span class="btn-icon">👁</span>
            <span class="btn-text">View Full Diary</span>
          </a>
        </div>
      </div>

      <!-- Quick Stats Dashboard -->
      <div class="library-stats-grid">
        <a href="#diary" class="stat-card">
          <span class="stat-icon">👁</span>
          <div class="stat-info">
            <span class="stat-value text-blue">${stats.totalWatched}</span>
            <span class="stat-label">Watched Titles</span>
          </div>
        </a>

        <div class="stat-card">
          <span class="stat-icon">⏳</span>
          <div class="stat-info">
            <span class="stat-value text-emerald">${stats.hoursWatched}h</span>
            <span class="stat-label">Hours Logged</span>
          </div>
        </div>

        <a href="#profile" class="stat-card">
          <span class="stat-icon">★</span>
          <div class="stat-info">
            <span class="stat-value text-gold">${stats.avgRating} <small class="text-muted">/ 5.0</small></span>
            <span class="stat-label">Avg Rating (${stats.totalRatings})</span>
          </div>
        </a>

        <a href="#watchlist" class="stat-card">
          <span class="stat-icon">📑</span>
          <div class="stat-info">
            <span class="stat-value text-purple">${watchlist.length}</span>
            <span class="stat-label">In Watchlist</span>
          </div>
        </a>

        <a href="#favorites" class="stat-card">
          <span class="stat-icon">♥</span>
          <div class="stat-info">
            <span class="stat-value text-pink">${favorites.length}</span>
            <span class="stat-label">Favorites</span>
          </div>
        </a>

        <a href="#lists" class="stat-card">
          <span class="stat-icon">📚</span>
          <div class="stat-info">
            <span class="stat-value text-cyan">${customLists.length}</span>
            <span class="stat-label">Custom Lists</span>
          </div>
        </a>
      </div>

      <!-- 1. Continue Watching -->
      ${continueWatching.length > 0 ? `
        <section class="library-section">
          <div class="section-heading-row">
            <h2 class="section-heading">Continue Watching (${continueWatching.length})</h2>
          </div>
          <div class="shelf-cards-track" id="library-continue-track"></div>
        </section>
      ` : ''}

      <!-- 2. Custom Lists Section -->
      <section class="library-section">
        <div class="section-heading-row">
          <h2 class="section-heading">Your Custom Lists (${customLists.length})</h2>
          <a href="#lists" class="view-all-link">Manage All Lists →</a>
        </div>
        
        <div class="custom-lists-grid" id="library-custom-lists-grid">
          ${customLists.map(list => `
            <a href="#list/${list.id}" class="custom-list-card">
              <div class="list-card-collage-wrap">
                ${generateListCollageHtml(list.movies)}
                <span class="list-visibility-tag">${list.visibility.toUpperCase()}</span>
              </div>
              <div class="list-card-info">
                <h3 class="list-card-title">${_escape(list.name)}</h3>
                <span class="list-card-count">${list.movies.length} ${list.movies.length === 1 ? 'film' : 'films'}</span>
                <p class="list-card-desc">${_escape(list.description || 'Curated personal playlist')}</p>
              </div>
            </a>
          `).join('')}
        </div>
      </section>

      <!-- 3. Recent Diary Activity -->
      <section class="library-section">
        <div class="section-heading-row">
          <h2 class="section-heading">Recent Diary Logs</h2>
          <a href="#diary" class="view-all-link">Full Viewing Diary →</a>
        </div>

        ${diary.length === 0 ? `
          <div class="empty-state-small">
            <p>You haven't logged any movies to your diary yet.</p>
          </div>
        ` : `
          <div class="diary-compact-list">
            ${diary.slice(0, 4).map(entry => `
              <div class="diary-row-item">
                <div class="diary-item-date">${new Date(entry.watchedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                <div class="diary-item-thumb-wrap">
                  <img src="https://image.tmdb.org/t/p/w185${entry.poster_path}" class="diary-item-thumb" />
                </div>
                <div class="diary-item-details">
                  <h4 class="diary-item-title">${_escape(entry.title)}</h4>
                  <div class="diary-item-rating-row">
                    ${entry.rating ? `<span class="star-gold">${'★'.repeat(Math.floor(entry.rating)) + (entry.rating % 1 !== 0 ? '½' : '')}</span>` : '<span class="text-muted">Unrated</span>'}
                    ${entry.rewatch ? `<span class="badge-rewatch">🔄 Rewatch</span>` : ''}
                    ${entry.favorite ? `<span class="text-pink">♥ Favorite</span>` : ''}
                  </div>
                  ${entry.review ? `<p class="diary-item-review-snippet">“${_escape(entry.review)}”</p>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </section>

      <!-- 4. Watchlist Preview -->
      <section class="library-section">
        <div class="section-heading-row">
          <h2 class="section-heading">From Your Watchlist (${watchlist.length})</h2>
          <a href="#watchlist" class="view-all-link">View All Watchlist →</a>
        </div>
        ${watchlist.length === 0 ? `
          <div class="empty-state-small">
            <p>Your watchlist is empty. Explore and add movies to your queue.</p>
          </div>
        ` : `
          <div class="shelf-cards-track" id="library-watchlist-track"></div>
        `}
      </section>

      <!-- 5. Favorites Showcase -->
      ${favorites.length > 0 ? `
        <section class="library-section">
          <div class="section-heading-row">
            <h2 class="section-heading">Favorite Titles (${favorites.length})</h2>
            <a href="#favorites" class="view-all-link">All Favorites →</a>
          </div>
          <div class="shelf-cards-track" id="library-favorites-track"></div>
        </section>
      ` : ''}
    </div>
  `;

  // Populate dynamic cards
  const continueTrack = container.querySelector('#library-continue-track');
  if (continueTrack) {
    continueWatching.forEach(item => {
      const card = createMovieCard(item, { isContinueWatching: true });
      continueTrack.appendChild(card);
    });
  }

  const watchlistTrack = container.querySelector('#library-watchlist-track');
  if (watchlistTrack) {
    watchlist.slice(0, 10).forEach(item => {
      const card = createMovieCard(item);
      watchlistTrack.appendChild(card);
    });
  }

  const favoritesTrack = container.querySelector('#library-favorites-track');
  if (favoritesTrack) {
    favorites.slice(0, 10).forEach(item => {
      const card = createMovieCard(item);
      favoritesTrack.appendChild(card);
    });
  }

  // Create list button
  const createListBtn = container.querySelector('#btn-library-create-list');
  if (createListBtn) {
    createListBtn.addEventListener('click', () => {
      window.app.openCreateListModal();
    });
  }
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
