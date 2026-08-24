/**
 * Home View
 * Cinematic Hero + Personalized dynamic shelves (Continue Watching, Because You Watched...) + TMDB Trending & Genres
 */

import { tmdbApi } from '../api/tmdb.js';
import { HeroBanner } from '../components/hero.js';
import { createMovieCard } from '../components/movieCard.js';
import { getPersonalizedRecommendations } from '../services/recommendations.js';

export async function renderHomeView(container) {
  container.innerHTML = `
    <!-- Hero Container -->
    <div id="hero-container" class="hero-banner-container">
      <div class="hero-skeleton">
        <div class="spinner"></div>
      </div>
    </div>

    <!-- Main Content Shelves -->
    <div class="home-shelves-container" id="home-shelves-container">
      <div class="shelves-loading">
        <div class="spinner"></div>
        <span>Loading your personalized cinema feed...</span>
      </div>
    </div>
  `;

  const heroBanner = new HeroBanner('hero-container');
  const shelvesContainer = document.getElementById('home-shelves-container');

  try {
    // 1. Fetch Trending items for Hero & Top row
    const trendingData = await tmdbApi.getTrendingAll('day');
    const trendingResults = trendingData.results || [];

    // Render Hero with top 5 featured items
    heroBanner.render(trendingResults);

    // 2. Fetch personalized recommendations
    const personalRows = await getPersonalizedRecommendations();

    // 3. Fetch standard TMDB Discovery rows in parallel
    const [popularMovies, popularTV, topRated, sciFiMovies, actionMovies] = await Promise.all([
      tmdbApi.getPopularMovies(1),
      tmdbApi.getPopularTV(1),
      tmdbApi.getTopRatedMovies(1),
      tmdbApi.discoverMovies({ with_genres: '878', sort_by: 'popularity.desc' }),
      tmdbApi.discoverMovies({ with_genres: '28', sort_by: 'popularity.desc' })
    ]);

    // Clear loading spinner
    shelvesContainer.innerHTML = '';

    // A. Render Personalized Dynamic Rows First (Continue Watching, Because You Watched, etc.)
    personalRows.forEach(row => {
      _renderShelf(shelvesContainer, row.title, row.subtitle, row.items, {
        isPersonal: true,
        isContinueWatching: row.isContinueWatching
      });
    });

    // B. Render Trending Now Row
    _renderShelf(shelvesContainer, 'Trending Today', 'Top movies and series making waves right now', trendingResults.map(item => ({
      ...item,
      media_type: item.media_type || (item.title ? 'movie' : 'tv')
    })));

    // C. Popular Movies
    if (popularMovies && popularMovies.results) {
      _renderShelf(shelvesContainer, 'Popular Movies', 'Most watched films globally', popularMovies.results.map(m => ({ ...m, media_type: 'movie' })));
    }

    // D. Popular TV Series
    if (popularTV && popularTV.results) {
      _renderShelf(shelvesContainer, 'Binge-Worthy TV Series', 'Critically acclaimed and trending television', popularTV.results.map(t => ({ ...t, media_type: 'tv' })));
    }

    // E. Mind-Bending Sci-Fi
    if (sciFiMovies && sciFiMovies.results) {
      _renderShelf(shelvesContainer, 'Cosmic & Dystopian Sci-Fi', 'Journeys into future worlds and spacetime', sciFiMovies.results.map(m => ({ ...m, media_type: 'movie' })));
    }

    // F. High-Octane Action
    if (actionMovies && actionMovies.results) {
      _renderShelf(shelvesContainer, 'High-Octane Action & Thrills', 'Adrenaline-fueled blockbusters', actionMovies.results.map(m => ({ ...m, media_type: 'movie' })));
    }

    // G. Top Rated Masterpieces
    if (topRated && topRated.results) {
      _renderShelf(shelvesContainer, 'All-Time Cinematic Masterpieces', 'Highest rated by global film communities', topRated.results.map(m => ({ ...m, media_type: 'movie' })));
    }

  } catch (err) {
    console.error('Failed to load homepage feeds:', err);
    shelvesContainer.innerHTML = `
      <div class="empty-state-card">
        <span class="empty-icon">⚠️</span>
        <h3>Failed to load cinema feed</h3>
        <p>Could not connect to TMDB API. Please verify your connection.</p>
      </div>
    `;
  }
}

/**
 * Render a horizontal scrolling movie shelf
 */
function _renderShelf(parent, title, subtitle, items, options = {}) {
  if (!items || items.length === 0) return;

  const shelfWrap = document.createElement('section');
  shelfWrap.className = `movie-shelf-section ${options.isPersonal ? 'shelf-personalized' : ''}`;

  shelfWrap.innerHTML = `
    <div class="shelf-header">
      <div class="shelf-title-group">
        <h2 class="shelf-title">${_escape(title)}</h2>
        ${subtitle ? `<span class="shelf-subtitle">${_escape(subtitle)}</span>` : ''}
      </div>
      <div class="shelf-nav-controls">
        <button class="shelf-arrow shelf-arrow-left" aria-label="Scroll left">❮</button>
        <button class="shelf-arrow shelf-arrow-right" aria-label="Scroll right">❯</button>
      </div>
    </div>
    <div class="shelf-cards-track"></div>
  `;

  const track = shelfWrap.querySelector('.shelf-cards-track');
  const leftArrow = shelfWrap.querySelector('.shelf-arrow-left');
  const rightArrow = shelfWrap.querySelector('.shelf-arrow-right');

  items.forEach(movie => {
    const card = createMovieCard(movie, {
      isContinueWatching: options.isContinueWatching
    });
    track.appendChild(card);
  });

  // Smooth shelf scrolling
  leftArrow.addEventListener('click', () => {
    track.scrollBy({ left: -window.innerWidth * 0.7, behavior: 'smooth' });
  });

  rightArrow.addEventListener('click', () => {
    track.scrollBy({ left: window.innerWidth * 0.7, behavior: 'smooth' });
  });

  parent.appendChild(shelfWrap);
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
