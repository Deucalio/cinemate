/**
 * Navigation Bar Component
 * Desktop header with live search autocomplete, profile dropdown, and mobile navigation
 */

import { tmdbApi, getPosterUrl } from '../api/tmdb.js';
import { store } from '../state/store.js';

export function initNavbar() {
  const header = document.getElementById('main-header');
  if (!header) return;

  const profile = store.getProfile();

  header.innerHTML = `
    <div class="nav-container">
      <div class="nav-left">
        <a href="#home" class="brand-logo" id="brand-logo">
          <span class="brand-icon">🎬</span>
          <span class="brand-name">CINE<span class="brand-accent">STREAM</span></span>
          <span class="brand-badge">PRO</span>
        </a>

        <nav class="desktop-nav-links" id="desktop-nav-links">
          <a href="#home" class="nav-link is-active" data-route="home">Home</a>
          <a href="#movies" class="nav-link" data-route="movies">Movies</a>
          <a href="#tv" class="nav-link" data-route="tv">TV Shows</a>
          <a href="#discover" class="nav-link" data-route="discover">Discover</a>
          <a href="#watchlist" class="nav-link" data-route="watchlist">Watchlist</a>
          <a href="#lists" class="nav-link" data-route="lists">Lists</a>
          <a href="#diary" class="nav-link" data-route="diary">Diary</a>
          <a href="#library" class="nav-link" data-route="library">Library</a>
        </nav>
      </div>

      <div class="nav-right">
        <!-- Live Search -->
        <div class="search-box-wrap" id="search-box-wrap">
          <div class="search-input-group">
            <span class="search-icon">🔍</span>
            <input type="text" id="nav-search-input" class="search-input" placeholder="Search movies, TV, cast..." autocomplete="off" />
            <button class="search-clear-btn" id="search-clear-btn" style="display:none;">&times;</button>
          </div>
          <!-- Live search dropdown -->
          <div class="search-autocomplete-dropdown" id="search-autocomplete-dropdown"></div>
        </div>

        <!-- Quick Create List Button -->
        <button class="btn-create-list-quick" id="btn-create-list-quick" title="Create Custom List">
          <span class="btn-icon">＋</span> <span class="btn-text">New List</span>
        </button>

        <!-- Profile & Account Dropdown -->
        <div class="profile-menu-wrap" id="profile-menu-wrap">
          <button class="profile-avatar-btn" id="profile-avatar-btn" aria-label="User profile">
            <img src="${profile.avatar}" alt="${profile.username}" class="profile-avatar-img" />
            <span class="profile-caret">▼</span>
          </button>

          <div class="profile-dropdown-menu" id="profile-dropdown-menu">
            <div class="profile-dropdown-header">
              <img src="${profile.avatar}" class="profile-dropdown-avatar" />
              <div class="profile-dropdown-user-info">
                <span class="profile-display-name">${_escape(profile.displayName)}</span>
                <span class="profile-handle">@${_escape(profile.username)}</span>
              </div>
            </div>
            <div class="dropdown-divider"></div>
            <a href="#profile" class="dropdown-item"><span class="dropdown-item-icon">👤</span> Profile & Stats</a>
            <a href="#library" class="dropdown-item"><span class="dropdown-item-icon">🏛</span> My Library</a>
            <a href="#watchlist" class="dropdown-item"><span class="dropdown-item-icon">📑</span> Watchlist</a>
            <a href="#diary" class="dropdown-item"><span class="dropdown-item-icon">👁</span> Watched Diary</a>
            <a href="#favorites" class="dropdown-item"><span class="dropdown-item-icon">♥</span> Favorites</a>
            <a href="#lists" class="dropdown-item"><span class="dropdown-item-icon">📚</span> Custom Collections</a>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item btn-seed-reset" id="btn-reset-demo-data">
              <span class="dropdown-item-icon">🔄</span> Reset Demo Library
            </button>
          </div>
        </div>

        <!-- Mobile Menu Toggle -->
        <button class="mobile-menu-toggle" id="mobile-menu-toggle" aria-label="Toggle navigation">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>

    <!-- Mobile Drawer -->
    <div class="mobile-nav-drawer" id="mobile-nav-drawer">
      <div class="mobile-nav-content">
        <a href="#home" class="mobile-nav-link" data-route="home">🏠 Home</a>
        <a href="#movies" class="mobile-nav-link" data-route="movies">🎬 Movies</a>
        <a href="#tv" class="mobile-nav-link" data-route="tv">📺 TV Shows</a>
        <a href="#discover" class="mobile-nav-link" data-route="discover">✨ Discover & Filter</a>
        <a href="#watchlist" class="mobile-nav-link" data-route="watchlist">📑 Watchlist</a>
        <a href="#lists" class="mobile-nav-link" data-route="lists">📚 Custom Lists</a>
        <a href="#diary" class="mobile-nav-link" data-route="diary">👁 Watched Diary</a>
        <a href="#favorites" class="mobile-nav-link" data-route="favorites">♥ Favorites</a>
        <a href="#library" class="mobile-nav-link" data-route="library">🏛 My Library Hub</a>
        <a href="#profile" class="mobile-nav-link" data-route="profile">👤 Profile & Stats</a>
      </div>
    </div>
  `;

  // Init Search Autocomplete
  _initSearchAutocomplete();

  // Init Profile Dropdown
  const avatarBtn = document.getElementById('profile-avatar-btn');
  const profileMenu = document.getElementById('profile-dropdown-menu');
  if (avatarBtn && profileMenu) {
    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      profileMenu.classList.toggle('is-open');
    });

    document.addEventListener('click', (e) => {
      if (!avatarBtn.contains(e.target) && !profileMenu.contains(e.target)) {
        profileMenu.classList.remove('is-open');
      }
    });
  }

  // Quick Create List Button
  const createListBtn = document.getElementById('btn-create-list-quick');
  if (createListBtn) {
    createListBtn.addEventListener('click', () => {
      window.app.openCreateListModal();
    });
  }

  // Reset Demo Data
  const resetBtn = document.getElementById('btn-reset-demo-data');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Reset your library to the initial demo seed with sample lists, diary, and ratings?')) {
        localStorage.clear();
        window.location.reload();
      }
    });
  }

  // Mobile Drawer Toggle
  const mobileToggle = document.getElementById('mobile-menu-toggle');
  const mobileDrawer = document.getElementById('mobile-nav-drawer');
  if (mobileToggle && mobileDrawer) {
    mobileToggle.addEventListener('click', () => {
      mobileDrawer.classList.toggle('is-open');
      mobileToggle.classList.toggle('is-active');
    });

    // Close on navigation
    mobileDrawer.querySelectorAll('.mobile-nav-link').forEach(link => {
      link.addEventListener('click', () => {
        mobileDrawer.classList.remove('is-open');
        mobileToggle.classList.remove('is-active');
      });
    });
  }

  // Sticky header background on scroll
  window.addEventListener('scroll', () => {
    if (window.scrollY > 30) {
      header.classList.add('header-scrolled');
    } else {
      header.classList.remove('header-scrolled');
    }
  });
}

/**
 * Live search autocomplete with debouncing
 */
function _initSearchAutocomplete() {
  const searchInput = document.getElementById('nav-search-input');
  const searchClear = document.getElementById('search-clear-btn');
  const dropdown = document.getElementById('search-autocomplete-dropdown');
  if (!searchInput || !dropdown) return;

  let debounceTimer = null;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    if (query.length > 0) {
      searchClear.style.display = 'block';
    } else {
      searchClear.style.display = 'none';
      dropdown.innerHTML = '';
      dropdown.classList.remove('is-open');
      return;
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (query.length < 2) return;
      dropdown.innerHTML = `<div class="search-dropdown-loading">Searching TMDB for "${_escape(query)}"...</div>`;
      dropdown.classList.add('is-open');

      try {
        const data = await tmdbApi.searchMulti(query);
        const results = (data.results || [])
          .filter(item => item.media_type === 'movie' || item.media_type === 'tv' || item.media_type === 'person')
          .slice(0, 7);

        if (results.length === 0) {
          dropdown.innerHTML = `<div class="search-dropdown-empty">No results found for "${_escape(query)}"</div>`;
          return;
        }

        dropdown.innerHTML = `
          <div class="search-dropdown-results">
            ${results.map(item => {
              const isPerson = item.media_type === 'person';
              const title = isPerson ? item.name : (item.title || item.name);
              const poster = isPerson 
                ? (item.profile_path ? getPosterUrl(item.profile_path, 'w185') : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=185&auto=format&fit=crop&q=60')
                : getPosterUrl(item.poster_path, 'w185');
              const date = item.release_date || item.first_air_date || '';
              const year = date ? date.substring(0, 4) : (isPerson ? 'Known for ' + (item.known_for_department || 'Acting') : '');
              const rating = item.vote_average ? `★ ${item.vote_average.toFixed(1)}` : '';

              return `
                <div class="search-dropdown-item" data-id="${item.id}" data-media-type="${item.media_type}">
                  <img src="${poster}" class="search-item-thumb" loading="lazy" />
                  <div class="search-item-info">
                    <span class="search-item-title">${_escape(title)}</span>
                    <div class="search-item-meta">
                      <span class="search-item-type">${item.media_type.toUpperCase()}</span>
                      ${year ? `<span class="search-item-year">${year}</span>` : ''}
                      ${rating ? `<span class="search-item-rating text-gold">${rating}</span>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
            <a href="#discover?query=${encodeURIComponent(query)}" class="search-dropdown-view-all">
              View all results for "${_escape(query)}" →
            </a>
          </div>
        `;

        // Click search items
        dropdown.querySelectorAll('.search-dropdown-item').forEach(itemEl => {
          itemEl.addEventListener('click', () => {
            const id = itemEl.dataset.id;
            const mediaType = itemEl.dataset.mediaType;
            dropdown.classList.remove('is-open');
            searchInput.value = '';
            searchClear.style.display = 'none';

            if (mediaType === 'movie' || mediaType === 'tv') {
              window.app.openDetailModal({ id, media_type: mediaType });
            } else {
              window.location.hash = `#discover?query=${encodeURIComponent(itemEl.querySelector('.search-item-title').textContent)}`;
            }
          });
        });

      } catch (err) {
        dropdown.innerHTML = `<div class="search-dropdown-empty">Search unavailable right now</div>`;
      }
    }, 280);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    dropdown.innerHTML = '';
    dropdown.classList.remove('is-open');
    searchInput.focus();
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('is-open');
    }
  });

  // Enter key press in search navigates to discover
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) {
      const q = searchInput.value.trim();
      dropdown.classList.remove('is-open');
      window.location.hash = `#discover?query=${encodeURIComponent(q)}`;
    }
  });
}

export function updateActiveNav(currentRoute) {
  document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(link => {
    const route = link.dataset.route;
    if (route === currentRoute) {
      link.classList.add('is-active');
    } else {
      link.classList.remove('is-active');
    }
  });
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
