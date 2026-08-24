/**
 * CineStream Pro Application Bootstrapper & Hash Router
 */

import { initNavbar, updateActiveNav } from './components/navbar.js';
import { detailModal } from './components/detailModal.js';
import { playerModal } from './components/playerModal.js';
import { rateReviewModal } from './components/rateReviewModal.js';
import { listModals } from './components/listModal.js';
import { store } from './state/store.js';

// Views
import { renderHomeView } from './views/homeView.js';
import { renderMoviesView } from './views/moviesView.js';
import { renderTVView } from './views/tvView.js';
import { renderDiscoverView } from './views/discoverView.js';
import { renderMyListView } from './views/myListView.js';
import { renderLibraryView } from './views/libraryView.js';
import { renderCustomListsGallery, renderListDetailView } from './views/customListsView.js';
import { renderDiaryView } from './views/diaryView.js';
import { renderFavoritesView } from './views/favoritesView.js';
import { renderProfileView } from './views/profileView.js';

class App {
  constructor() {
    this.mainContainer = document.getElementById('app-view-container');
    this.currentRoute = '';
  }

  init() {
    // 1. Initialize Navbar
    initNavbar();

    // 2. Setup Global Modal Controllers
    window.app = {
      openDetailModal: (movie) => detailModal.open(movie),
      openPlayer: (movie, options) => playerModal.open(movie, options),
      openRateReviewModal: (movie, options) => rateReviewModal.open(movie, options),
      openCreateListModal: (cb) => listModals.openCreateListModal(cb),
      openListSelectorModal: (movie) => listModals.openAddToListModal(movie),
      navigate: (hash) => { window.location.hash = hash; }
    };

    // 3. Setup Hash Router
    window.addEventListener('hashchange', () => this.handleRoute());

    // 4. Initial Route
    if (!window.location.hash) {
      window.location.hash = '#home';
    } else {
      this.handleRoute();
    }
  }

  async handleRoute() {
    const rawHash = window.location.hash.slice(1) || 'home';
    const [pathPart, queryPart] = rawHash.split('?');
    const pathSegments = pathPart.split('/');
    const rootRoute = pathSegments[0] || 'home';

    // Parse query params
    const queryParams = {};
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart);
      for (const [k, v] of searchParams.entries()) {
        queryParams[k] = v;
      }
    }

    this.currentRoute = rootRoute;
    updateActiveNav(rootRoute);

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'instant' });

    // Route dispatch
    if (rootRoute === 'home') {
      await renderHomeView(this.mainContainer);
    } else if (rootRoute === 'movies') {
      await renderMoviesView(this.mainContainer);
    } else if (rootRoute === 'tv') {
      await renderTVView(this.mainContainer);
    } else if (rootRoute === 'discover') {
      await renderDiscoverView(this.mainContainer, queryParams);
    } else if (rootRoute === 'watchlist' || rootRoute === 'my-list') {
      renderMyListView(this.mainContainer);
    } else if (rootRoute === 'library') {
      renderLibraryView(this.mainContainer);
    } else if (rootRoute === 'lists') {
      renderCustomListsGallery(this.mainContainer);
    } else if (rootRoute === 'list' && pathSegments[1]) {
      renderListDetailView(this.mainContainer, pathSegments[1]);
    } else if (rootRoute === 'diary' || rootRoute === 'history') {
      renderDiaryView(this.mainContainer);
    } else if (rootRoute === 'favorites') {
      renderFavoritesView(this.mainContainer);
    } else if (rootRoute === 'profile') {
      renderProfileView(this.mainContainer);
    } else if (rootRoute === 'movie' && pathSegments[1]) {
      // Direct deep link to movie detail
      await renderHomeView(this.mainContainer);
      detailModal.open({ id: pathSegments[1], media_type: 'movie' });
    } else {
      await renderHomeView(this.mainContainer);
    }
  }
}

// Bootstrap on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
