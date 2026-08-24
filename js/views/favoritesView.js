/**
 * Favorites View
 * Showcase all favorited movies & series with instant remove/play actions
 */

import { store } from '../state/store.js';
import { createMovieCard } from '../components/movieCard.js';

export function renderFavoritesView(container) {
  function render() {
    const favorites = store.getFavorites();

    container.innerHTML = `
      <div class="catalog-page-container">
        <div class="catalog-header">
          <div class="header-badge-title-row">
            <h1 class="catalog-title">Favorite Titles</h1>
            <span class="catalog-counter-badge text-pink">${favorites.length} ${favorites.length === 1 ? 'favorite' : 'favorites'}</span>
          </div>
          <p class="catalog-subtitle">The movies and series you especially love and hold dear.</p>
        </div>

        ${favorites.length === 0 ? `
          <div class="empty-state-card animate-fade-in">
            <span class="empty-icon text-pink">♥</span>
            <h3>NO FAVORITES SAVED YET</h3>
            <p>Click the <strong>♡ Favorite</strong> button on movie cards, detail pages, or action menus to save your all-time favorites here.</p>
            <a href="#discover" class="btn btn-primary btn-lg mt-3">
              <span class="btn-icon">🎬</span>
              <span class="btn-text">Discover Films</span>
            </a>
          </div>
        ` : `
          <div class="catalog-grid" id="favorites-grid"></div>
        `}
      </div>
    `;

    const grid = container.querySelector('#favorites-grid');
    if (grid) {
      favorites.forEach(movie => {
        const card = createMovieCard(movie);
        grid.appendChild(card);
      });
    }
  }

  render();
}
