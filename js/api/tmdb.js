/**
 * TMDB API Client
 * Uses credentials provided in TMDB_API_CHEATSHEET.md
 */

const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0';
const TMDB_API_KEY = '94b77b2f5be51b794ccfd399f60fa173';
const BASE_URL = 'https://api.themoviedb.org/3';
export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Image size constants
export const POSTER_SIZES = {
  sm: 'w185',
  md: 'w342',
  lg: 'w500',
  xl: 'w780',
  original: 'original'
};

export const BACKDROP_SIZES = {
  sm: 'w300',
  md: 'w780',
  lg: 'w1280',
  original: 'original'
};

export const PROFILE_SIZES = {
  sm: 'w45',
  md: 'w185',
  lg: 'h632',
  original: 'original'
};

// Helpers for image URLs
export function getPosterUrl(path, size = 'w500') {
  if (!path) return 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&auto=format&fit=crop&q=60';
  return `${IMAGE_BASE}/${size}${path}`;
}

export function getBackdropUrl(path, size = 'w1280') {
  if (!path) return 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1280&auto=format&fit=crop&q=60';
  return `${IMAGE_BASE}/${size}${path}`;
}

export function getProfileUrl(path, size = 'w185') {
  if (!path) return 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=185&auto=format&fit=crop&q=60';
  return `${IMAGE_BASE}/${size}${path}`;
}

export function getAuthorAvatarUrl(avatarPath) {
  if (!avatarPath) return 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80';
  if (avatarPath.startsWith('http')) return avatarPath;
  if (avatarPath.startsWith('/http')) return avatarPath.substring(1);
  return `${IMAGE_BASE}/w185${avatarPath}`;
}

// Genre dictionary
export const MOVIE_GENRES = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western'
};

export const TV_GENRES = {
  10759: 'Action & Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10762: 'Kids',
  9648: 'Mystery',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
  37: 'Western'
};

/**
 * Universal TMDB Fetcher with caching & robust error handling
 */
const cache = new Map();

export async function fetchTMDB(endpoint, params = {}, options = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.append('api_key', TMDB_API_KEY);
  url.searchParams.append('language', 'en-US');
  
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null) {
      url.searchParams.set(key, params[key]);
    }
  });

  const cacheKey = url.toString();
  if (!options.bypassCache && cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    // Cache for 5 minutes
    if (Date.now() - timestamp < 300000) {
      return data;
    }
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${TMDB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`TMDB Error ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.error(`Fetch failed for ${endpoint}:`, error);
    throw error;
  }
}

// ----------------- TMDB API METHODS -----------------

export const tmdbApi = {
  // Trending
  getTrendingAll: (timeWindow = 'day') => fetchTMDB(`/trending/all/${timeWindow}`),
  getTrendingMovies: (timeWindow = 'week') => fetchTMDB(`/trending/movie/${timeWindow}`),
  getTrendingTV: (timeWindow = 'week') => fetchTMDB(`/trending/tv/${timeWindow}`),

  // Movies
  getPopularMovies: (page = 1) => fetchTMDB('/movie/popular', { page }),
  getTopRatedMovies: (page = 1) => fetchTMDB('/movie/top_rated', { page }),
  getNowPlayingMovies: (page = 1) => fetchTMDB('/movie/now_playing', { page }),
  getUpcomingMovies: (page = 1) => fetchTMDB('/movie/upcoming', { page }),
  getMovieDetails: (id) => fetchTMDB(`/movie/${id}`, { 
    append_to_response: 'videos,credits,similar,recommendations,external_ids,release_dates,reviews' 
  }),
  getMovieReviews: (id, page = 1) => fetchTMDB(`/movie/${id}/reviews`, { page }),

  // TV Series
  getPopularTV: (page = 1) => fetchTMDB('/tv/popular', { page }),
  getTopRatedTV: (page = 1) => fetchTMDB('/tv/top_rated', { page }),
  getOnTheAirTV: (page = 1) => fetchTMDB('/tv/on_the_air', { page }),
  getTVDetails: (id) => fetchTMDB(`/tv/${id}`, { 
    append_to_response: 'videos,credits,similar,recommendations,external_ids,content_ratings,reviews' 
  }),
  getTVReviews: (id, page = 1) => fetchTMDB(`/tv/${id}/reviews`, { page }),
  getTVSeason: (tvId, seasonNumber) => fetchTMDB(`/tv/${tvId}/season/${seasonNumber}`),

  // Discovery
  discoverMovies: (params = {}) => fetchTMDB('/discover/movie', {
    include_adult: false,
    sort_by: 'popularity.desc',
    ...params
  }),
  discoverTV: (params = {}) => fetchTMDB('/discover/tv', {
    include_adult: false,
    sort_by: 'popularity.desc',
    ...params
  }),

  // Search
  searchMulti: (query, page = 1) => fetchTMDB('/search/multi', { query, page, include_adult: false }),
  searchMovies: (query, page = 1) => fetchTMDB('/search/movie', { query, page, include_adult: false }),
  searchTV: (query, page = 1) => fetchTMDB('/search/tv', { query, page, include_adult: false }),
  searchPeople: (query, page = 1) => fetchTMDB('/search/person', { query, page, include_adult: false }),

  // Person
  getPersonDetails: (id) => fetchTMDB(`/person/${id}`, {
    append_to_response: 'combined_credits,external_ids,images'
  }),

  // Recommendations & Similar
  getMovieRecommendations: (id) => fetchTMDB(`/movie/${id}/recommendations`),
  getTVRecommendations: (id) => fetchTMDB(`/tv/${id}/recommendations`),
  getMovieSimilar: (id) => fetchTMDB(`/movie/${id}/similar`),
  getTVSimilar: (id) => fetchTMDB(`/tv/${id}/similar`),

  // Genres
  getMovieGenres: () => fetchTMDB('/genre/movie/list'),
  getTVGenres: () => fetchTMDB('/genre/tv/list')
};
