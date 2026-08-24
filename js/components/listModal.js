/**
 * Custom Lists Modals Component
 * - Create New List Modal
 * - Add Movie to Lists Modal (Checkboxes for all lists + quick create)
 * - 2x2 Collage Generator for List Covers
 */

import { store } from '../state/store.js';
import { getPosterUrl } from '../api/tmdb.js';
import { toast } from './toast.js';

/**
 * Generate a dynamic 2x2 poster collage HTML for custom lists
 */
export function generateListCollageHtml(movies) {
  if (!movies || movies.length === 0) {
    return `
      <div class="list-collage-empty">
        <span class="collage-empty-icon">📁</span>
        <span class="collage-empty-text">Empty Collection</span>
      </div>
    `;
  }

  if (movies.length === 1) {
    const poster = getPosterUrl(movies[0].poster_path, 'w500');
    return `
      <div class="list-collage-single" style="background-image: url('${poster}');"></div>
    `;
  }

  // 2 to 4 items collage
  const collageItems = movies.slice(0, 4);
  return `
    <div class="list-collage-grid collage-count-${collageItems.length}">
      ${collageItems.map(m => `
        <div class="collage-cell" style="background-image: url('${getPosterUrl(m.poster_path, 'w342')}');"></div>
      `).join('')}
    </div>
  `;
}

export class ListModalsManager {
  constructor() {
    this.activeModal = null;
  }

  /**
   * Open "Create New List" modal
   */
  openCreateListModal(onCreated = null) {
    this.close();

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop animate-fade-in';
    modal.id = 'create-list-modal';

    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-medium animate-scale-in">
        <div class="modal-header">
          <div class="modal-title-wrap">
            <span class="modal-eyebrow">CURATE YOUR CINEMA</span>
            <h2 class="modal-title">Create New Collection</h2>
          </div>
          <button class="modal-close-btn" id="create-list-close">&times;</button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="new-list-name">LIST NAME *</label>
            <input type="text" id="new-list-name" class="form-input" placeholder="e.g. 90s Cyberpunk, Date Night, Nolan Marathon..." autofocus />
          </div>

          <div class="form-group">
            <label class="form-label" for="new-list-desc">DESCRIPTION (OPTIONAL)</label>
            <textarea id="new-list-desc" class="form-textarea" placeholder="Describe the mood, theme, or criteria of this collection..." rows="3"></textarea>
          </div>

          <div class="form-group">
            <label class="form-label" for="new-list-visibility">VISIBILITY</label>
            <select id="new-list-visibility" class="form-select">
              <option value="private">🔒 Private (Only visible to you)</option>
              <option value="unlisted">🔗 Unlisted (Anyone with share link)</option>
              <option value="public" selected>🌐 Public (Featured on your profile)</option>
            </select>
          </div>

          <div class="list-cover-preview-hint">
            <span>💡 Tip:</span> A dynamic 2x2 poster collage will automatically be generated from the movies you add.
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" id="btn-cancel-create-list">Cancel</button>
          <button class="btn btn-primary" id="btn-submit-create-list">
            <span class="btn-icon">＋</span>
            <span class="btn-text">Create Collection</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.activeModal = modal;

    const nameInput = modal.querySelector('#new-list-name');
    const descInput = modal.querySelector('#new-list-desc');
    const visSelect = modal.querySelector('#new-list-visibility');
    const closeBtn = modal.querySelector('#create-list-close');
    const cancelBtn = modal.querySelector('#btn-cancel-create-list');
    const submitBtn = modal.querySelector('#btn-submit-create-list');

    const handleClose = () => this.close();
    closeBtn.addEventListener('click', handleClose);
    cancelBtn.addEventListener('click', handleClose);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) handleClose();
    });

    submitBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast.error('Please enter a list name');
        nameInput.focus();
        return;
      }

      const newList = store.createCustomList({
        name,
        description: descInput.value.trim(),
        visibility: visSelect.value
      });

      toast.success(`Created collection "${newList.name}"!`, '📚');
      this.close();

      if (onCreated) {
        onCreated(newList);
      }
    });
  }

  /**
   * Open "Add to List" selector modal
   */
  openAddToListModal(movie) {
    this.close();

    const lists = store.getCustomLists();
    const inWatchlist = store.isInWatchlist(movie.id);
    const title = movie.title || movie.name;

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop animate-fade-in';
    modal.id = 'add-to-list-modal';

    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-medium animate-scale-in">
        <div class="modal-header">
          <div class="modal-title-wrap">
            <span class="modal-eyebrow">SAVE TO COLLECTIONS</span>
            <h2 class="modal-title">Add "${_escape(title)}" to...</h2>
          </div>
          <button class="modal-close-btn" id="add-to-list-close">&times;</button>
        </div>

        <div class="modal-body modal-add-to-list-body">
          <div class="list-selection-container">
            <!-- Watchlist item -->
            <label class="list-select-item">
              <input type="checkbox" class="list-checkbox" data-type="watchlist" ${inWatchlist ? 'checked' : ''} />
              <div class="list-select-info">
                <span class="list-select-name">📑 My Watchlist</span>
                <span class="list-select-desc">Quick queue of films to stream next</span>
              </div>
              <span class="list-select-status">${inWatchlist ? 'Saved' : ''}</span>
            </label>

            <div class="dropdown-divider"></div>
            <div class="list-select-header-label">YOUR CUSTOM LISTS (${lists.length})</div>

            ${lists.map(l => {
              const isAlreadyIn = l.movies.some(m => Number(m.id) === Number(movie.id));
              return `
                <label class="list-select-item">
                  <input type="checkbox" class="list-checkbox" data-list-id="${l.id}" ${isAlreadyIn ? 'checked' : ''} />
                  <div class="list-select-info">
                    <span class="list-select-name">📁 ${_escape(l.name)}</span>
                    <span class="list-select-count">${l.movies.length} titles • ${l.visibility}</span>
                  </div>
                  <span class="list-select-status">${isAlreadyIn ? 'Included' : ''}</span>
                </label>
              `;
            }).join('')}
          </div>

          <div class="add-to-list-quick-create">
            <button class="btn btn-secondary btn-full" id="btn-quick-create-from-selector">
              <span class="btn-icon">＋</span>
              <span class="btn-text">Create New List</span>
            </button>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-primary" id="btn-done-add-to-list">
            <span class="btn-text">Done</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.activeModal = modal;

    const closeBtn = modal.querySelector('#add-to-list-close');
    const doneBtn = modal.querySelector('#btn-done-add-to-list');
    const quickCreateBtn = modal.querySelector('#btn-quick-create-from-selector');

    const handleClose = () => this.close();
    closeBtn.addEventListener('click', handleClose);
    doneBtn.addEventListener('click', handleClose);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) handleClose();
    });

    // Checkbox changes
    modal.querySelectorAll('.list-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const isChecked = cb.checked;
        const type = cb.dataset.type;
        const listId = cb.dataset.listId;

        if (type === 'watchlist') {
          if (isChecked) {
            store.addToWatchlist(movie);
            toast.success(`Added to Watchlist`);
          } else {
            store.removeFromWatchlist(movie.id);
            toast.info(`Removed from Watchlist`);
          }
        } else if (listId) {
          const targetList = store.getListById(listId);
          if (isChecked) {
            store.addMovieToCustomList(listId, movie);
            toast.success(`Added to "${targetList.name}"`, '📚');
          } else {
            store.removeMovieFromCustomList(listId, movie.id);
            toast.info(`Removed from "${targetList.name}"`);
          }
        }
      });
    });

    // Quick create shortcut
    if (quickCreateBtn) {
      quickCreateBtn.addEventListener('click', () => {
        this.openCreateListModal((newList) => {
          store.addMovieToCustomList(newList.id, movie);
          toast.success(`Added "${title}" to new list "${newList.name}"!`);
          this.openAddToListModal(movie);
        });
      });
    }
  }

  close() {
    if (this.activeModal) {
      this.activeModal.remove();
      this.activeModal = null;
    }
  }
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const listModals = new ListModalsManager();
