/**
 * Watchlist (My List) View
 * Filter by Type, Sort by Date Added/Rating/Title, Grid & Compact List modes, Empty State
 */

import { store } from '../state/store.js';
import { createMovieCard } from '../components/movieCard.js';

export function renderMyListView(container) {
  let activeFilter = 'all';
  let activeSort = 'added_desc';
  let viewMode = 'grid'; // 'grid' | 'compact'

  function render() {
    const rawWatchlist = store.getWatchlist();

    // Filter
    let items = rawWatchlist.filter(item => {
      if (activeFilter === 'movie') return item.media_type === 'movie';
      if (activeFilter === 'tv') return item.media_type === 'tv';
      return true;
    });

    // Sort
    if (activeSort === 'added_desc') {
      items.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
    } else if (activeSort === 'added_asc') {
      items.sort((a, b) => new Date(a.addedAt || 0) - new Date(b.addedAt || 0));
    } else if (activeSort === 'rating_desc') {
      items.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    } else if (activeSort === 'title_asc') {
      items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }

    container.innerHTML = `
      <div class="catalog-page-container">
        <div class="catalog-header">
          <div class="header-badge-title-row">
            <h1 class="catalog-title">My Watchlist</h1>
            <span class="catalog-counter-badge">${items.length} ${items.length === 1 ? 'title' : 'titles'}</span>
          </div>
          <p class="catalog-subtitle">Your personal queue of films and series to stream next.</p>
        </div>

        <!-- Controls Bar -->
        <div class="catalog-filters-bar">
          <div class="category-tabs" id="watchlist-type-tabs">
            <button class="category-tab ${activeFilter === 'all' ? 'is-active' : ''}" data-filter="all">All Titles (${rawWatchlist.length})</button>
            <button class="category-tab ${activeFilter === 'movie' ? 'is-active' : ''}" data-filter="movie">Movies</button>
            <button class="category-tab ${activeFilter === 'tv' ? 'is-active' : ''}" data-filter="tv">TV Shows</button>
          </div>

          <div class="catalog-controls-right">
            <select class="form-select catalog-sort-select" id="watchlist-sort-select">
              <option value="added_desc" ${activeSort === 'added_desc' ? 'selected' : ''}>Recently Added</option>
              <option value="added_asc" ${activeSort === 'added_asc' ? 'selected' : ''}>Oldest First</option>
              <option value="rating_desc" ${activeSort === 'rating_desc' ? 'selected' : ''}>Highest Rated</option>
              <option value="title_asc" ${activeSort === 'title_asc' ? 'selected' : ''}>Alphabetical (A-Z)</option>
            </select>
          </div>
        </div>

        <!-- Watchlist Items -->
        ${items.length === 0 ? `
          <div class="empty-state-card animate-fade-in">
            <span class="empty-icon">📑</span>
            <h3>YOUR WATCHLIST IS EMPTY</h3>
            <p>Save movies and television series you want to watch later by clicking the <strong>＋ My List</strong> button anywhere.</p>
            <a href="#discover" class="btn btn-primary btn-lg mt-3">
              <span class="btn-icon">✨</span>
              <span class="btn-text">Explore Cinema</span>
            </a>
          </div>
        ` : `
          <div class="catalog-grid" id="watchlist-grid"></div>
        `}
      </div>
    `;

    // Populate Cards
    const grid = container.querySelector('#watchlist-grid');
    if (grid) {
      items.forEach(movie => {
        const card = createMovieCard(movie);
        grid.appendChild(card);
      });
    }

    // Attach Event Handlers
    container.querySelectorAll('#watchlist-type-tabs .category-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeFilter = tab.dataset.filter;
        render();
      });
    });

    const sortSelect = container.querySelector('#watchlist-sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        activeSort = e.target.value;
        render();
      });
    }
  }

  render();
}
