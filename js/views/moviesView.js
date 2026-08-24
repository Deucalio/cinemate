/**
 * Movies Catalog View
 * Filter by Category (Popular, Top Rated, Now Playing, Upcoming), Genre chips, and Sorting
 */

import { tmdbApi, MOVIE_GENRES } from '../api/tmdb.js';
import { createMovieCard } from '../components/movieCard.js';

export async function renderMoviesView(container) {
  let activeCategory = 'popular';
  let activeGenre = 'all';
  let activeSort = 'popularity.desc';
  let currentPage = 1;
  let totalPages = 1;
  let isLoading = false;

  container.innerHTML = `
    <div class="catalog-page-container">
      <div class="catalog-header">
        <h1 class="catalog-title">Explore Movies</h1>
        <p class="catalog-subtitle">Browse theatrical releases, award-winning cinema, and hidden gems.</p>
      </div>

      <!-- Filters & Category Navigation -->
      <div class="catalog-filters-bar">
        <div class="category-tabs" id="movie-category-tabs">
          <button class="category-tab is-active" data-category="popular">Popular</button>
          <button class="category-tab" data-category="top_rated">Top Rated</button>
          <button class="category-tab" data-category="now_playing">In Theaters</button>
          <button class="category-tab" data-category="upcoming">Upcoming</button>
        </div>

        <div class="catalog-controls-right">
          <select class="form-select catalog-sort-select" id="movie-sort-select">
            <option value="popularity.desc">Most Popular</option>
            <option value="vote_average.desc">Highest Rated</option>
            <option value="primary_release_date.desc">Release Date (Newest)</option>
          </select>
        </div>
      </div>

      <!-- Genre Chips -->
      <div class="genre-chips-scroll" id="movie-genre-chips">
        <button class="genre-chip is-active" data-genre="all">All Genres</button>
        ${Object.entries(MOVIE_GENRES).map(([id, name]) => `
          <button class="genre-chip" data-genre="${id}">${name}</button>
        `).join('')}
      </div>

      <!-- Grid Results -->
      <div class="catalog-grid" id="movies-grid">
        <div class="catalog-loading">
          <div class="spinner"></div>
          <span>Loading movies...</span>
        </div>
      </div>

      <!-- Load More -->
      <div class="catalog-load-more-wrap" id="movies-load-more-wrap" style="display:none;">
        <button class="btn btn-secondary btn-lg" id="btn-load-more-movies">
          <span class="btn-text">Load More Titles</span>
        </button>
      </div>
    </div>
  `;

  const grid = document.getElementById('movies-grid');
  const loadMoreWrap = document.getElementById('movies-load-more-wrap');
  const loadMoreBtn = document.getElementById('btn-load-more-movies');
  const categoryTabs = document.querySelectorAll('#movie-category-tabs .category-tab');
  const genreChips = document.querySelectorAll('#movie-genre-chips .genre-chip');
  const sortSelect = document.getElementById('movie-sort-select');

  async function loadMovies(reset = false) {
    if (isLoading) return;
    isLoading = true;

    if (reset) {
      currentPage = 1;
      grid.innerHTML = `
        <div class="catalog-loading">
          <div class="spinner"></div>
          <span>Fetching cinematic catalogue...</span>
        </div>
      `;
      loadMoreWrap.style.display = 'none';
    }

    try {
      let data;
      if (activeGenre !== 'all' || activeSort !== 'popularity.desc') {
        // Use discover endpoint when filtering
        const params = {
          page: currentPage,
          sort_by: activeSort
        };
        if (activeGenre !== 'all') {
          params.with_genres = activeGenre;
        }
        data = await tmdbApi.discoverMovies(params);
      } else {
        // Use standard category endpoints
        if (activeCategory === 'popular') data = await tmdbApi.getPopularMovies(currentPage);
        else if (activeCategory === 'top_rated') data = await tmdbApi.getTopRatedMovies(currentPage);
        else if (activeCategory === 'now_playing') data = await tmdbApi.getNowPlayingMovies(currentPage);
        else if (activeCategory === 'upcoming') data = await tmdbApi.getUpcomingMovies(currentPage);
      }

      if (reset) grid.innerHTML = '';

      const results = (data && data.results) || [];
      totalPages = data ? data.total_pages : 1;

      if (results.length === 0 && reset) {
        grid.innerHTML = `
          <div class="empty-state-card">
            <span class="empty-icon">🎬</span>
            <h3>No movies found</h3>
            <p>Try switching genres or sorting criteria.</p>
          </div>
        `;
        loadMoreWrap.style.display = 'none';
        return;
      }

      results.forEach(movie => {
        movie.media_type = 'movie';
        const card = createMovieCard(movie);
        grid.appendChild(card);
      });

      if (currentPage < totalPages) {
        loadMoreWrap.style.display = 'flex';
      } else {
        loadMoreWrap.style.display = 'none';
      }

    } catch (err) {
      console.error('Error fetching movies:', err);
      if (reset) {
        grid.innerHTML = `<div class="empty-state-card"><p>Failed to load movies.</p></div>`;
      }
    } finally {
      isLoading = false;
    }
  }

  // Category Tab clicks
  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      categoryTabs.forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      activeCategory = tab.dataset.category;
      loadMovies(true);
    });
  });

  // Genre Chip clicks
  genreChips.forEach(chip => {
    chip.addEventListener('click', () => {
      genreChips.forEach(c => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      activeGenre = chip.dataset.genre;
      loadMovies(true);
    });
  });

  // Sort change
  sortSelect.addEventListener('change', (e) => {
    activeSort = e.target.value;
    loadMovies(true);
  });

  // Load more
  loadMoreBtn.addEventListener('click', () => {
    currentPage++;
    loadMovies(false);
  });

  // Initial load
  loadMovies(true);
}
