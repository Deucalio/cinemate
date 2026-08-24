/**
 * TV Series Catalog View
 * Filter by Category (Popular, Top Rated, On The Air), TV Genre chips, and Sorting
 */

import { tmdbApi, TV_GENRES } from '../api/tmdb.js';
import { createMovieCard } from '../components/movieCard.js';

export async function renderTVView(container) {
  let activeCategory = 'popular';
  let activeGenre = 'all';
  let activeSort = 'popularity.desc';
  let currentPage = 1;
  let totalPages = 1;
  let isLoading = false;

  container.innerHTML = `
    <div class="catalog-page-container">
      <div class="catalog-header">
        <h1 class="catalog-title">TV Series & Shows</h1>
        <p class="catalog-subtitle">From gripping dramas to iconic mini-series and ongoing prestige TV.</p>
      </div>

      <!-- Filters & Category Navigation -->
      <div class="catalog-filters-bar">
        <div class="category-tabs" id="tv-category-tabs">
          <button class="category-tab is-active" data-category="popular">Popular Shows</button>
          <button class="category-tab" data-category="top_rated">Top Rated</button>
          <button class="category-tab" data-category="on_the_air">Currently Airing</button>
        </div>

        <div class="catalog-controls-right">
          <select class="form-select catalog-sort-select" id="tv-sort-select">
            <option value="popularity.desc">Most Popular</option>
            <option value="vote_average.desc">Highest Rated</option>
            <option value="first_air_date.desc">First Aired (Newest)</option>
          </select>
        </div>
      </div>

      <!-- TV Genre Chips -->
      <div class="genre-chips-scroll" id="tv-genre-chips">
        <button class="genre-chip is-active" data-genre="all">All Genres</button>
        ${Object.entries(TV_GENRES).map(([id, name]) => `
          <button class="genre-chip" data-genre="${id}">${name}</button>
        `).join('')}
      </div>

      <!-- Grid Results -->
      <div class="catalog-grid" id="tv-grid">
        <div class="catalog-loading">
          <div class="spinner"></div>
          <span>Loading TV series...</span>
        </div>
      </div>

      <!-- Load More -->
      <div class="catalog-load-more-wrap" id="tv-load-more-wrap" style="display:none;">
        <button class="btn btn-secondary btn-lg" id="btn-load-more-tv">
          <span class="btn-text">Load More Shows</span>
        </button>
      </div>
    </div>
  `;

  const grid = document.getElementById('tv-grid');
  const loadMoreWrap = document.getElementById('tv-load-more-wrap');
  const loadMoreBtn = document.getElementById('btn-load-more-tv');
  const categoryTabs = document.querySelectorAll('#tv-category-tabs .category-tab');
  const genreChips = document.querySelectorAll('#tv-genre-chips .genre-chip');
  const sortSelect = document.getElementById('tv-sort-select');

  async function loadTV(reset = false) {
    if (isLoading) return;
    isLoading = true;

    if (reset) {
      currentPage = 1;
      grid.innerHTML = `
        <div class="catalog-loading">
          <div class="spinner"></div>
          <span>Fetching series catalogue...</span>
        </div>
      `;
      loadMoreWrap.style.display = 'none';
    }

    try {
      let data;
      if (activeGenre !== 'all' || activeSort !== 'popularity.desc') {
        const params = {
          page: currentPage,
          sort_by: activeSort
        };
        if (activeGenre !== 'all') {
          params.with_genres = activeGenre;
        }
        data = await tmdbApi.discoverTV(params);
      } else {
        if (activeCategory === 'popular') data = await tmdbApi.getPopularTV(currentPage);
        else if (activeCategory === 'top_rated') data = await tmdbApi.getTopRatedTV(currentPage);
        else if (activeCategory === 'on_the_air') data = await tmdbApi.getOnTheAirTV(currentPage);
      }

      if (reset) grid.innerHTML = '';

      const results = (data && data.results) || [];
      totalPages = data ? data.total_pages : 1;

      if (results.length === 0 && reset) {
        grid.innerHTML = `
          <div class="empty-state-card">
            <span class="empty-icon">📺</span>
            <h3>No TV shows found</h3>
            <p>Try switching genres or sorting criteria.</p>
          </div>
        `;
        loadMoreWrap.style.display = 'none';
        return;
      }

      results.forEach(show => {
        show.media_type = 'tv';
        const card = createMovieCard(show);
        grid.appendChild(card);
      });

      if (currentPage < totalPages) {
        loadMoreWrap.style.display = 'flex';
      } else {
        loadMoreWrap.style.display = 'none';
      }

    } catch (err) {
      console.error('Error fetching TV shows:', err);
      if (reset) {
        grid.innerHTML = `<div class="empty-state-card"><p>Failed to load TV series.</p></div>`;
      }
    } finally {
      isLoading = false;
    }
  }

  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      categoryTabs.forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      activeCategory = tab.dataset.category;
      loadTV(true);
    });
  });

  genreChips.forEach(chip => {
    chip.addEventListener('click', () => {
      genreChips.forEach(c => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      activeGenre = chip.dataset.genre;
      loadTV(true);
    });
  });

  sortSelect.addEventListener('change', (e) => {
    activeSort = e.target.value;
    loadTV(true);
  });

  loadMoreBtn.addEventListener('click', () => {
    currentPage++;
    loadTV(false);
  });

  loadTV(true);
}
