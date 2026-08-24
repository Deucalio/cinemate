/**
 * Personalized Recommendation Engine
 * Analyzes user watch history, ratings, and favorites to construct smart dynamic rows
 */

import { store } from '../state/store.js';
import { tmdbApi } from '../api/tmdb.js';

export async function getPersonalizedRecommendations() {
  const diary = store.getDiary();
  const ratings = store.getRatings();
  const favorites = store.getFavorites();
  const watchlist = store.getWatchlist();
  const continueWatching = store.getContinueWatchingList();

  const dynamicRows = [];

  // 1. Continue Watching Row (Always first if exists)
  if (continueWatching.length > 0) {
    dynamicRows.push({
      id: 'continue-watching',
      title: 'Continue Watching',
      subtitle: 'Resume where you left off',
      isContinueWatching: true,
      items: continueWatching
    });
  }

  // 2. "Because You Watched [Most Recent Movie]"
  if (diary.length > 0) {
    const recentWatch = diary[0];
    try {
      let recs;
      if (recentWatch.media_type === 'tv') {
        recs = await tmdbApi.getTVRecommendations(recentWatch.movieId);
      } else {
        recs = await tmdbApi.getMovieRecommendations(recentWatch.movieId);
      }

      if (recs && recs.results && recs.results.length > 0) {
        dynamicRows.push({
          id: `because-watched-${recentWatch.movieId}`,
          title: `Because You Watched ${recentWatch.title}`,
          subtitle: `Recommended based on your recent viewing`,
          items: recs.results.slice(0, 16)
        });
      }
    } catch (e) {
      console.warn('Could not fetch recommendations for recent watch:', e);
    }
  }

  // 3. "Because You Loved / 5-Star Rated [Highest Rated Movie]"
  const fiveStarMovieIds = Object.entries(ratings)
    .filter(([_, rating]) => rating === 5.0)
    .map(([id]) => Number(id));

  if (fiveStarMovieIds.length > 0) {
    const randomFiveStarId = fiveStarMovieIds[Math.floor(Math.random() * fiveStarMovieIds.length)];
    // Find title from diary or favorites
    const knownItem = diary.find(d => Number(d.movieId) === randomFiveStarId) ||
                      favorites.find(f => Number(f.id) === randomFiveStarId);
    const title = knownItem ? knownItem.title : 'Masterpieces';

    try {
      const recs = await tmdbApi.getMovieSimilar(randomFiveStarId);
      if (recs && recs.results && recs.results.length > 0) {
        dynamicRows.push({
          id: `five-star-match-${randomFiveStarId}`,
          title: `Inspired by Your 5★ Rating: ${title}`,
          subtitle: 'Critically aligned films matching your highest praise',
          items: recs.results.slice(0, 16)
        });
      }
    } catch (e) {
      console.warn('Could not fetch similar items for 5-star movie:', e);
    }
  }

  // 4. "From Your Watchlist" (Quick row on homepage if user has items)
  if (watchlist.length >= 3) {
    dynamicRows.push({
      id: 'watchlist-shelf',
      title: 'From Your Watchlist',
      subtitle: `${watchlist.length} titles queued for your next movie night`,
      items: watchlist.slice(0, 16)
    });
  }

  return dynamicRows;
}
