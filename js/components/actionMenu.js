/**
 * Action Menu Component (Letterboxd Style)
 * Popover on desktop / Bottom sheet on mobile with movie/show actions
 */

import { store } from '../state/store.js';
import { toast } from './toast.js';

class ActionMenuManager {
  constructor() {
    this.activeMenu = null;
    this.backdrop = null;
    this.init();
  }

  init() {
    document.addEventListener('click', (e) => {
      if (this.activeMenu && !this.activeMenu.contains(e.target) && !e.target.closest('.action-menu-trigger')) {
        this.close();
      }
    });

    window.addEventListener('resize', () => {
      if (this.activeMenu) this.close();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.activeMenu) {
        this.close();
      }
    });
  }

  /**
   * Open the action menu for a movie
   * @param {Object} movie
   * @param {HTMLElement} triggerElement
   */
  open(movie, triggerElement = null) {
    this.close();

    const isMobile = window.innerWidth <= 768;
    const inWatchlist = store.isInWatchlist(movie.id);
    const isFav = store.isFavorite(movie.id);
    const isWatched = store.isWatched(movie.id);
    const userRating = store.getUserRating(movie.id);
    const title = movie.title || movie.name;

    const menu = document.createElement('div');
    menu.className = isMobile ? 'action-bottom-sheet animate-slide-up' : 'action-popover animate-scale-in';

    menu.innerHTML = `
      <div class="action-menu-header">
        <div class="action-menu-title-row">
          <span class="action-menu-title">${this._escape(title)}</span>
          <span class="action-menu-year">${(movie.release_date || movie.first_air_date || '').substring(0, 4)}</span>
        </div>
        ${userRating ? `<div class="action-menu-user-rating"><span class="star-gold">★</span> Your Rating: <strong>${userRating} / 5</strong></div>` : ''}
      </div>
      <div class="action-menu-divider"></div>
      <div class="action-menu-items">
        <button class="action-menu-item btn-play" data-action="play">
          <span class="action-item-icon">▶</span>
          <span class="action-item-text">Play / Stream</span>
        </button>

        <button class="action-menu-item ${inWatchlist ? 'is-active text-green' : ''}" data-action="watchlist">
          <span class="action-item-icon">${inWatchlist ? '✓' : '＋'}</span>
          <span class="action-item-text">${inWatchlist ? 'In Watchlist' : 'Add to Watchlist'}</span>
        </button>

        <button class="action-menu-item" data-action="add-to-list">
          <span class="action-item-icon">📑</span>
          <span class="action-item-text">Add to Custom List...</span>
        </button>

        <button class="action-menu-item ${isWatched ? 'is-active text-blue' : ''}" data-action="watched">
          <span class="action-item-icon">👁</span>
          <span class="action-item-text">${isWatched ? 'Watched (Log Again)' : 'Mark as Watched'}</span>
        </button>

        <button class="action-menu-item ${userRating ? 'is-active text-gold' : ''}" data-action="rate">
          <span class="action-item-icon">★</span>
          <span class="action-item-text">${userRating ? `Rated ${userRating}★ (Change)` : 'Rate (0.5 – 5 Stars)'}</span>
        </button>

        <button class="action-menu-item ${isFav ? 'is-active text-pink' : ''}" data-action="favorite">
          <span class="action-item-icon">${isFav ? '♥' : '♡'}</span>
          <span class="action-item-text">${isFav ? 'Favorited' : 'Add to Favorites'}</span>
        </button>

        <button class="action-menu-item" data-action="review">
          <span class="action-item-icon">✎</span>
          <span class="action-item-text">Write Review...</span>
        </button>

        <button class="action-menu-item" data-action="details">
          <span class="action-item-icon">ℹ</span>
          <span class="action-item-text">View Full Details</span>
        </button>

        <button class="action-menu-item" data-action="share">
          <span class="action-item-icon">🔗</span>
          <span class="action-item-text">Share Title</span>
        </button>
      </div>
    `;

    if (isMobile) {
      this._createBackdrop();
      document.body.appendChild(menu);
    } else {
      document.body.appendChild(menu);
      this._positionPopover(menu, triggerElement);
    }

    this.activeMenu = menu;

    // Attach click listeners to actions
    menu.querySelectorAll('.action-menu-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        this._handleAction(action, movie);
        this.close();
      });
    });
  }

  _positionPopover(menu, triggerElement) {
    if (!triggerElement) return;
    const rect = triggerElement.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX - (menuRect.width / 2) + (rect.width / 2);

    // Keep within window horizontal bounds
    if (left < 16) left = 16;
    if (left + menuRect.width > window.innerWidth - 16) {
      left = window.innerWidth - menuRect.width - 16;
    }

    // Flip upwards if overflowing bottom
    if (rect.bottom + menuRect.height > window.innerHeight - 16) {
      top = rect.top + window.scrollY - menuRect.height - 8;
    }

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  _createBackdrop() {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'modal-backdrop animate-fade-in';
    this.backdrop.addEventListener('click', () => this.close());
    document.body.appendChild(this.backdrop);
  }

  close() {
    if (this.activeMenu) {
      this.activeMenu.remove();
      this.activeMenu = null;
    }
    if (this.backdrop) {
      this.backdrop.remove();
      this.backdrop = null;
    }
  }

  _handleAction(action, movie) {
    const title = movie.title || movie.name;

    switch (action) {
      case 'play':
        window.app.openPlayer(movie);
        break;

      case 'watchlist':
        const added = store.toggleWatchlist(movie);
        toast.success(added ? `Added "${title}" to Watchlist` : `Removed "${title}" from Watchlist`);
        break;

      case 'add-to-list':
        window.app.openListSelectorModal(movie);
        break;

      case 'watched':
        window.app.openRateReviewModal(movie, { isWatchedPrompt: true });
        break;

      case 'rate':
        window.app.openRateReviewModal(movie, { focusRate: true });
        break;

      case 'favorite':
        const isFav = store.toggleFavorite(movie);
        if (isFav) {
          toast.favorite(`Added "${title}" to Favorites`);
        } else {
          toast.info(`Removed "${title}" from Favorites`);
        }
        break;

      case 'review':
        window.app.openRateReviewModal(movie, { focusReview: true });
        break;

      case 'details':
        window.app.openDetailModal(movie);
        break;

      case 'share':
        const shareUrl = `${window.location.origin}${window.location.pathname}#movie/${movie.id}`;
        navigator.clipboard.writeText(shareUrl).then(() => {
          toast.success(`Share link copied to clipboard!`);
        }).catch(() => {
          toast.info(`Link: ${shareUrl}`);
        });
        break;
    }
  }

  _escape(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

export const actionMenu = new ActionMenuManager();
