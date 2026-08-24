/**
 * Custom Lists & Individual List Detail View
 * Supports collage generation, manual reordering (drag/click), Play All, Add All to My List, and sharing
 */

import { store } from '../state/store.js';
import { generateListCollageHtml } from '../components/listModal.js';
import { createMovieCard } from '../components/movieCard.js';
import { getPosterUrl } from '../api/tmdb.js';
import { toast } from '../components/toast.js';

/**
 * Render All Custom Lists Gallery
 */
export function renderCustomListsGallery(container) {
  const lists = store.getCustomLists();

  container.innerHTML = `
    <div class="catalog-page-container">
      <div class="catalog-header">
        <div class="header-badge-title-row">
          <h1 class="catalog-title">Custom Collections & Playlists</h1>
          <span class="catalog-counter-badge">${lists.length} ${lists.length === 1 ? 'list' : 'lists'}</span>
        </div>
        <p class="catalog-subtitle">Craft themed playlists, marathons, director showcases, and shareable collections.</p>
        <button class="btn btn-primary mt-3" id="btn-create-list-page">
          <span class="btn-icon">＋</span>
          <span class="btn-text">Create New Collection</span>
        </button>
      </div>

      ${lists.length === 0 ? `
        <div class="empty-state-card animate-fade-in">
          <span class="empty-icon">📁</span>
          <h3>YOUR COLLECTIONS ARE EMPTY</h3>
          <p>Create your first custom list to organize movies your way (e.g. "90s Sci-Fi Classics", "Date Night", "Oscar Winners").</p>
          <button class="btn btn-primary btn-lg mt-3" id="btn-empty-create-list">
            <span class="btn-icon">＋</span>
            <span class="btn-text">Create Your First List</span>
          </button>
        </div>
      ` : `
        <div class="custom-lists-grid-large" id="custom-lists-large-grid">
          ${lists.map(list => `
            <a href="#list/${list.id}" class="custom-list-card-large">
              <div class="list-collage-container">
                ${generateListCollageHtml(list.movies)}
                <span class="list-visibility-pill ${list.visibility}">${list.visibility.toUpperCase()}</span>
              </div>
              <div class="list-card-content">
                <h3 class="list-card-name">${_escape(list.name)}</h3>
                <span class="list-card-meta">${list.movies.length} titles • Updated ${new Date(list.updatedAt).toLocaleDateString()}</span>
                <p class="list-card-desc">${_escape(list.description || 'Curated personal playlist')}</p>
              </div>
            </a>
          `).join('')}
        </div>
      `}
    </div>
  `;

  const createBtns = container.querySelectorAll('#btn-create-list-page, #btn-empty-create-list');
  createBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      window.app.openCreateListModal((newList) => {
        window.location.hash = `#list/${newList.id}`;
      });
    });
  });
}

/**
 * Render Individual Custom List Detail Page
 */
export function renderListDetailView(container, listId) {
  const list = store.getListById(listId);

  if (!list) {
    container.innerHTML = `
      <div class="catalog-page-container">
        <div class="empty-state-card">
          <span class="empty-icon">⚠️</span>
          <h3>List Not Found</h3>
          <p>This custom collection may have been removed or does not exist.</p>
          <a href="#lists" class="btn btn-primary mt-3">Back to All Lists</a>
        </div>
      </div>
    `;
    return;
  }

  let viewMode = 'detailed'; // 'detailed' | 'grid'

  function render() {
    container.innerHTML = `
      <div class="list-detail-page animate-fade-in">
        <!-- List Header Showcase -->
        <div class="list-detail-header">
          <div class="list-detail-cover-box">
            ${generateListCollageHtml(list.movies)}
          </div>

          <div class="list-detail-info">
            <div class="list-detail-badges">
              <span class="badge-pill">${list.movies.length} TITLES</span>
              <span class="badge-pill ${list.visibility}">🌐 ${list.visibility.toUpperCase()}</span>
              <span class="badge-pill">CURATED BY YOU</span>
            </div>

            <h1 class="list-detail-title">${_escape(list.name)}</h1>
            <p class="list-detail-desc">${_escape(list.description || 'No description provided for this collection.')}</p>

            <div class="list-detail-meta-row">
              <span>Created: ${new Date(list.createdAt).toLocaleDateString()}</span>
              <span>•</span>
              <span>Updated: ${new Date(list.updatedAt).toLocaleDateString()}</span>
            </div>

            <!-- Action Bar -->
            <div class="list-action-bar">
              ${list.movies.length > 0 ? `
                <button class="btn btn-primary" id="btn-play-all-list">
                  <span class="btn-icon">▶</span>
                  <span class="btn-text">Play All</span>
                </button>

                <button class="btn btn-secondary" id="btn-add-all-watchlist">
                  <span class="btn-icon">＋</span>
                  <span class="btn-text">Add All to My List</span>
                </button>
              ` : ''}

              <a href="#discover" class="btn btn-secondary" id="btn-add-movies-to-list">
                <span class="btn-icon">🔍</span>
                <span class="btn-text">Add Movies</span>
              </a>

              <button class="btn btn-glass" id="btn-share-list" title="Share Collection Link">
                <span class="btn-icon">🔗</span>
                <span class="btn-text">Share</span>
              </button>

              <button class="btn btn-glass" id="btn-edit-list-meta" title="Edit Collection">
                <span class="btn-icon">✎</span>
                <span class="btn-text">Edit</span>
              </button>

              <button class="btn btn-glass text-red" id="btn-delete-list" title="Delete Collection">
                <span class="btn-icon">🗑</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Movies in the Collection -->
        <div class="list-movies-container">
          <div class="section-heading-row">
            <h2 class="section-heading">Films in Collection (${list.movies.length})</h2>
            <div class="list-view-switcher">
              <button class="btn-toggle-view ${viewMode === 'detailed' ? 'is-active' : ''}" id="btn-view-detailed" title="Detailed Ordered List">☰ List Order</button>
              <button class="btn-toggle-view ${viewMode === 'grid' ? 'is-active' : ''}" id="btn-view-grid" title="Poster Grid View">▦ Poster Grid</button>
            </div>
          </div>

          ${list.movies.length === 0 ? `
            <div class="empty-state-card mt-3">
              <span class="empty-icon">🎬</span>
              <h3>THIS LIST IS EMPTY</h3>
              <p>Start adding movies by searching or browsing titles, and clicking <strong>＋ Add to Custom List</strong>.</p>
              <a href="#discover" class="btn btn-primary mt-3">Browse & Add Titles</a>
            </div>
          ` : (
            viewMode === 'detailed' ? `
              <div class="ordered-movies-list" id="ordered-movies-list">
                ${list.movies.map((movie, index) => {
                  const numStr = (index + 1).toString().padStart(2, '0');
                  const poster = getPosterUrl(movie.poster_path, 'w185');
                  const userRating = store.getUserRating(movie.id);
                  return `
                    <div class="ordered-movie-row" data-id="${movie.id}" data-index="${index}">
                      <div class="ordered-movie-pos">
                        <span class="pos-number">${numStr}</span>
                        <div class="reorder-arrows">
                          ${index > 0 ? `<button class="btn-arrow btn-arrow-up" data-dir="up" title="Move Up">▲</button>` : ''}
                          ${index < list.movies.length - 1 ? `<button class="btn-arrow btn-arrow-down" data-dir="down" title="Move Down">▼</button>` : ''}
                        </div>
                      </div>

                      <img src="${poster}" class="ordered-movie-thumb" alt="${_escape(movie.title)}" />

                      <div class="ordered-movie-info">
                        <h3 class="ordered-movie-title">${_escape(movie.title)}</h3>
                        <div class="ordered-movie-meta">
                          <span>${(movie.release_date || '').substring(0, 4)}</span>
                          <span>•</span>
                          <span class="text-gold">★ ${movie.vote_average ? movie.vote_average.toFixed(1) : '8.0'}</span>
                          ${userRating ? `<span class="badge-user-rating">★ Your Rating: ${userRating}</span>` : ''}
                        </div>
                      </div>

                      <div class="ordered-movie-actions">
                        <button class="btn btn-sm btn-primary btn-play-row" data-id="${movie.id}">▶ Play</button>
                        <button class="btn btn-sm btn-glass btn-details-row" data-id="${movie.id}">ℹ Details</button>
                        <button class="btn btn-sm btn-glass text-red btn-remove-row" data-id="${movie.id}" title="Remove from list">✕</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `
              <div class="catalog-grid" id="list-grid-view"></div>
            `
          )}
        </div>
      </div>
    `;

    // Populate grid mode if active
    if (viewMode === 'grid') {
      const gridContainer = container.querySelector('#list-grid-view');
      if (gridContainer) {
        list.movies.forEach(movie => {
          const card = createMovieCard(movie);
          gridContainer.appendChild(card);
        });
      }
    }

    _bindDetailActions(container, list, render, viewMode, (newMode) => {
      viewMode = newMode;
      render();
    });
  }

  render();
}

function _bindDetailActions(container, list, reRender, currentMode, setMode) {
  const playAllBtn = container.querySelector('#btn-play-all-list');
  const addAllWatchlistBtn = container.querySelector('#btn-add-all-watchlist');
  const shareBtn = container.querySelector('#btn-share-list');
  const editBtn = container.querySelector('#btn-edit-list-meta');
  const deleteBtn = container.querySelector('#btn-delete-list');
  const viewDetailedBtn = container.querySelector('#btn-view-detailed');
  const viewGridBtn = container.querySelector('#btn-view-grid');

  if (viewDetailedBtn) viewDetailedBtn.addEventListener('click', () => setMode('detailed'));
  if (viewGridBtn) viewGridBtn.addEventListener('click', () => setMode('grid'));

  if (playAllBtn && list.movies.length > 0) {
    playAllBtn.addEventListener('click', () => {
      window.app.openPlayer(list.movies[0]);
      toast.info(`Playing collection: "${list.name}"`);
    });
  }

  if (addAllWatchlistBtn && list.movies.length > 0) {
    addAllWatchlistBtn.addEventListener('click', () => {
      list.movies.forEach(m => store.addToWatchlist(m));
      toast.success(`Added ${list.movies.length} titles to your Watchlist!`, '📑');
    });
  }

  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      const shareUrl = `${window.location.origin}${window.location.pathname}#list/${list.id}`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        toast.success(`Collection share link copied to clipboard!`, '🔗');
      });
    });
  }

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const newName = prompt('Edit Collection Name:', list.name);
      if (newName && newName.trim()) {
        const newDesc = prompt('Edit Description:', list.description || '');
        store.updateCustomList(list.id, {
          name: newName.trim(),
          description: (newDesc || '').trim()
        });
        toast.success('Collection updated!');
        reRender();
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Are you sure you want to delete "${list.name}"? This action cannot be undone.`)) {
        store.deleteCustomList(list.id);
        toast.info(`Deleted list "${list.name}"`);
        window.location.hash = '#lists';
      }
    });
  }

  // Row reordering & removal
  container.querySelectorAll('.btn-arrow').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const row = btn.closest('.ordered-movie-row');
      const idx = Number(row.dataset.index);
      const dir = btn.dataset.dir;

      const newMovies = [...list.movies];
      const targetIdx = dir === 'up' ? idx - 1 : idx + 1;

      if (targetIdx >= 0 && targetIdx < newMovies.length) {
        // Swap
        const temp = newMovies[idx];
        newMovies[idx] = newMovies[targetIdx];
        newMovies[targetIdx] = temp;

        store.reorderCustomList(list.id, newMovies);
        reRender();
      }
    });
  });

  container.querySelectorAll('.btn-remove-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const movieId = btn.dataset.id;
      store.removeMovieFromCustomList(list.id, movieId);
      toast.info('Removed title from collection');
      reRender();
    });
  });

  container.querySelectorAll('.btn-play-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const movie = list.movies.find(m => Number(m.id) === Number(btn.dataset.id));
      if (movie) window.app.openPlayer(movie);
    });
  });

  container.querySelectorAll('.btn-details-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const movie = list.movies.find(m => Number(m.id) === Number(btn.dataset.id));
      if (movie) window.app.openDetailModal(movie);
    });
  });
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
