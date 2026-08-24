/**
 * Advanced Discover & Filter View
 * Filter by Type, Keywords, Genre, Release Year, Minimum Rating, and Sort Criteria
 */

import { tmdbApi, MOVIE_GENRES, TV_GENRES } from '../api/tmdb.js';
import { createMovieCard } from '../components/movieCard.js';

export async function renderDiscoverView(container, searchParams = {}) {
  const initialQuery = searchParams.query || '';

  container.innerHTML = `
    <div class="catalog-page-container">
      <div class="catalog-header">
        <h1 class="catalog-title">Discover & Filter Cinema</h1>
        <p class="catalog-subtitle">Fine-tune your exploration across the global TMDB library by decade, rating, and genre.</p>
      </div>

      <!-- Advanced Filter Panel -->
      <div class="discover-filter-panel">
        <div class="discover-filter-row">
          <!-- Search input -->
          <div class="form-group flex-2">
            <label class="form-label" for="discover-search-input">KEYWORD SEARCH</label>
            <div class="input-with-icon">
              <span class="input-icon">🔍</span>
              <input type="text" id="discover-search-input" class="form-input" placeholder="e.g. Blade Runner, Christopher Nolan, cyberpunk..." value="${_escape(initialQuery)}" />
            </div>
          </div>

          <!-- Media Type -->
          <div class="form-group flex-1">
            <label class="form-label" for="discover-type-select">MEDIA TYPE</label>
            <select id="discover-type-select" class="form-select">
              <option value="all">Movies & Series</option>
              <option value="movie" selected>Movies Only</option>
              <option value="tv">TV Shows Only</option>
            </select>
          </div>

          <!-- Genre -->
          <div class="form-group flex-1">
            <label class="form-label" for="discover-genre-select">GENRE</label>
            <select id="discover-genre-select" class="form-select">
              <option value="all">All Genres</option>
              ${Object.entries(MOVIE_GENRES).map(([id, name]) => `
                <option value="${id}">${name}</option>
              `).join('')}
            </select>
          </div>

          <!-- Release Era / Year -->
          <div class="form-group flex-1">
            <label class="form-label" for="discover-year-select">ERA / YEAR</label>
            <select id="discover-year-select" class="form-select">
              <option value="all">Any Year</option>
              <option value="2024">2024</option>
              <option value="2023">2023</option>
              <option value="2022">2022</option>
              <option value="2020">2020s</option>
              <option value="2010">2010s</option>
              <option value="2000">2000s</option>
              <option value="1990">1990s</option>
              <option value="1980">1980s Classics</option>
            </select>
          </div>

          <!-- Min Rating -->
          <div class="form-group flex-1">
            <label class="form-label" for="discover-rating-select">MIN. RATING</label>
            <select id="discover-rating-select" class="form-select">
              <option value="0">Any Rating</option>
              <option value="8.0">★ 8.0+ Masterpieces</option>
              <option value="7.0">★ 7.0+ High Quality</option>
              <option value="6.0">★ 6.0+ Decent</option>
            </select>
          </div>

          <!-- Sort By -->
          <div class="form-group flex-1">
            <label class="form-label" for="discover-sort-select">SORT BY</label>
            <select id="discover-sort-select" class="form-select">
              <option value="popularity.desc">Most Popular</option>
              <option value="vote_average.desc">Highest Rated</option>
              <option value="primary_release_date.desc">Newest First</option>
              <option value="primary_release_date.asc">Oldest First</option>
            </select>
          </div>
        </div>

        <div class="discover-action-buttons">
          <button class="btn btn-secondary" id="btn-reset-filters">Reset Filters</button>
          <button class="btn btn-primary" id="btn-apply-filters">
            <span class="btn-icon">⚡</span>
            <span class="btn-text">Apply Filters</span>
          </button>
        </div>
      </div>

      <!-- Results Grid -->
      <div class="catalog-grid" id="discover-grid">
        <div class="catalog-loading">
          <div class="spinner"></div>
          <span>Discovering titles...</span>
        </div>
      </div>

      <!-- Load More -->
      <div class="catalog-load-more-wrap" id="discover-load-more-wrap" style="display:none;">
        <button class="btn btn-secondary btn-lg" id="btn-load-more-discover">
          <span class="btn-text">Load More Results</span>
        </button>
      </div>
    </div>
  `;

  const searchInput = document.getElementById('discover-search-input');
  const typeSelect = document.getElementById('discover-type-select');
  const genreSelect = document.getElementById('discover-genre-select');
  const yearSelect = document.getElementById('discover-year-select');
  const ratingSelect = document.getElementById('discover-rating-select');
  const sortSelect = document.getElementById('discover-sort-select');
  const resetBtn = document.getElementById('btn-reset-filters');
  const applyBtn = document.getElementById('btn-apply-filters');
  const grid = document.getElementById('discover-grid');
  const loadMoreWrap = document.getElementById('discover-load-more-wrap');
  const loadMoreBtn = document.getElementById('btn-load-more-discover');

  let currentPage = 1;
  let totalPages = 1;
  let isLoading = false;

  async function executeSearch(reset = false) {
    if (isLoading) return;
    isLoading = true;

    if (reset) {
      currentPage = 1;
      grid.innerHTML = `
        <div class="catalog-loading">
          <div class="spinner"></div>
          <span>Searching titles...</span>
        </div>
      `;
      loadMoreWrap.style.display = 'none';
    }

    const query = searchInput.value.trim();
    const mediaType = typeSelect.value;
    const genre = genreSelect.value;
    const year = yearSelect.value;
    const minRating = ratingSelect.value;
    const sortBy = sortSelect.value;

    try {
      let results = [];

      if (query.length > 0) {
        // Keyword multi search
        const data = await tmdbApi.searchMulti(query, currentPage);
        results = (data.results || []).filter(item => {
          if (mediaType === 'movie') return item.media_type === 'movie';
          if (mediaType === 'tv') return item.media_type === 'tv';
          return item.media_type === 'movie' || item.media_type === 'tv';
        });
        totalPages = data.total_pages || 1;
      } else {
        // Discover endpoint
        const params = {
          page: currentPage,
          sort_by: sortBy
        };
        if (genre !== 'all') params.with_genres = genre;
        if (Number(minRating) > 0) {
          params['vote_average.gte'] = minRating;
          params['vote_count.gte'] = 100; // Filter out low-sample titles
        }
        if (year !== 'all') {
          if (year === '2024' || year === '2023' || year === '2022') {
            params.primary_release_year = year;
          } else {
            const startYear = `${year}-01-01`;
            const endYear = `${Number(year) + 9}-12-31`;
            params['primary_release_date.gte'] = startYear;
            params['primary_release_date.lte'] = endYear;
          }
        }

        if (mediaType === 'tv') {
          const data = await tmdbApi.discoverTV(params);
          results = (data.results || []).map(r => ({ ...r, media_type: 'tv' }));
          totalPages = data.total_pages || 1;
        } else {
          const data = await tmdbApi.discoverMovies(params);
          results = (data.results || []).map(r => ({ ...r, media_type: 'movie' }));
          totalPages = data.total_pages || 1;
        }
      }

      if (reset) grid.innerHTML = '';

      if (results.length === 0 && reset) {
        grid.innerHTML = `
          <div class="empty-state-card">
            <span class="empty-icon">🔍</span>
            <h3>No matching titles found</h3>
            <p>Try broadening your search query or relaxing your filter constraints.</p>
          </div>
        `;
        loadMoreWrap.style.display = 'none';
        return;
      }

      results.forEach(item => {
        const card = createMovieCard(item);
        grid.appendChild(card);
      });

      if (currentPage < totalPages) {
        loadMoreWrap.style.display = 'flex';
      } else {
        loadMoreWrap.style.display = 'none';
      }

    } catch (err) {
      console.error('Discover error:', err);
      if (reset) {
        grid.innerHTML = `<div class="empty-state-card"><p>Failed to execute search query.</p></div>`;
      }
    } finally {
      isLoading = false;
    }
  }

  // Filter change handlers
  applyBtn.addEventListener('click', () => executeSearch(true));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeSearch(true);
  });

  resetBtn.addEventListener('click', () => {
    searchInput.value = '';
    typeSelect.value = 'movie';
    genreSelect.value = 'all';
    yearSelect.value = 'all';
    ratingSelect.value = '0';
    sortSelect.value = 'popularity.desc';
    executeSearch(true);
  });

  loadMoreBtn.addEventListener('click', () => {
    currentPage++;
    executeSearch(false);
  });

  // Initial search
  executeSearch(true);
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
