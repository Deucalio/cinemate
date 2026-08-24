/**
 * CineStream Centralized Reactive State Store
 * Manages Watchlist, Custom Playlists, Diary/History, Half-star Ratings,
 * Reviews, Favorites, Playback Progress & Profile Stats in LocalStorage
 */

const STORAGE_KEYS = {
  WATCHLIST: 'cinestream_watchlist',
  CUSTOM_LISTS: 'cinestream_custom_lists',
  DIARY: 'cinestream_diary',
  RATINGS: 'cinestream_ratings',
  REVIEWS: 'cinestream_reviews',
  FAVORITES: 'cinestream_favorites',
  PROGRESS: 'cinestream_playback_progress',
  PROFILE: 'cinestream_user_profile'
};

class Store {
  constructor() {
    this.listeners = new Map();
    this.init();
  }

  init() {
    // Seed default collections if empty for a rich out-of-the-box demo experience
    if (!localStorage.getItem(STORAGE_KEYS.CUSTOM_LISTS)) {
      const defaultLists = [
        {
          id: 'list_scifi_masterpieces',
          name: 'Mind-Bending Sci-Fi Masterpieces',
          description: 'A curated anthology of thought-provoking science fiction exploring time, cosmos, consciousness, and dystopia.',
          visibility: 'public',
          coverImage: null, // Will auto-collage from movie posters
          createdAt: new Date(Date.now() - 86400000 * 12).toISOString(),
          updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
          movies: [
            { id: 157336, title: 'Interstellar', poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', media_type: 'movie', release_date: '2014-11-05', vote_average: 8.4 },
            { id: 693134, title: 'Dune: Part Two', poster_path: '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', media_type: 'movie', release_date: '2024-02-27', vote_average: 8.2 },
            { id: 27205, title: 'Inception', poster_path: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg', media_type: 'movie', release_date: '2010-07-15', vote_average: 8.4 },
            { id: 335984, title: 'Blade Runner 2049', poster_path: '/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg', media_type: 'movie', release_date: '2017-10-04', vote_average: 7.6 },
            { id: 329865, title: 'Arrival', poster_path: '/x2O0m2896x6OP6s8425gXgO7fIe.jpg', media_type: 'movie', release_date: '2016-11-10', vote_average: 7.9 }
          ]
        },
        {
          id: 'list_nolan_essentials',
          name: 'Christopher Nolan Essentials',
          description: 'Non-linear narratives, practical effects, and existential stakes.',
          visibility: 'public',
          coverImage: null,
          createdAt: new Date(Date.now() - 86400000 * 20).toISOString(),
          updatedAt: new Date(Date.now() - 86400000 * 5).toISOString(),
          movies: [
            { id: 155, title: 'The Dark Knight', poster_path: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg', media_type: 'movie', release_date: '2008-07-16', vote_average: 8.5 },
            { id: 872585, title: 'Oppenheimer', poster_path: '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', media_type: 'movie', release_date: '2023-07-19', vote_average: 8.1 },
            { id: 157336, title: 'Interstellar', poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', media_type: 'movie', release_date: '2014-11-05', vote_average: 8.4 },
            { id: 27205, title: 'Inception', poster_path: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg', media_type: 'movie', release_date: '2010-07-15', vote_average: 8.4 }
          ]
        }
      ];
      this._save(STORAGE_KEYS.CUSTOM_LISTS, defaultLists);
    }

    // Seed initial diary entries if empty
    if (!localStorage.getItem(STORAGE_KEYS.DIARY)) {
      const initialDiary = [
        {
          id: 'diary_1',
          movieId: 693134,
          title: 'Dune: Part Two',
          poster_path: '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg',
          media_type: 'movie',
          watchedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
          rating: 5.0,
          review: 'An absolute audiovisual masterpiece. The scale, sound design, and Hans Zimmer score in IMAX was breathtaking.',
          isSpoiler: false,
          rewatch: false,
          favorite: true
        },
        {
          id: 'diary_2',
          movieId: 155,
          title: 'The Dark Knight',
          poster_path: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
          media_type: 'movie',
          watchedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
          rating: 5.0,
          review: 'Heath Ledger gave one of the greatest antagonist performances in cinema history. Timeless.',
          isSpoiler: false,
          rewatch: true,
          favorite: true
        },
        {
          id: 'diary_3',
          movieId: 872585,
          title: 'Oppenheimer',
          poster_path: '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
          media_type: 'movie',
          watchedAt: new Date(Date.now() - 86400000 * 6).toISOString(),
          rating: 4.5,
          review: 'A tense, relentless biopic that plays like a thriller. Cillian Murphy gave everything.',
          isSpoiler: false,
          rewatch: false,
          favorite: false
        }
      ];
      this._save(STORAGE_KEYS.DIARY, initialDiary);
    }

    // Seed initial ratings & favorites
    if (!localStorage.getItem(STORAGE_KEYS.RATINGS)) {
      this._save(STORAGE_KEYS.RATINGS, {
        693134: 5.0,
        155: 5.0,
        872585: 4.5,
        157336: 5.0,
        27205: 4.5
      });
    }

    if (!localStorage.getItem(STORAGE_KEYS.FAVORITES)) {
      this._save(STORAGE_KEYS.FAVORITES, [
        { id: 693134, title: 'Dune: Part Two', poster_path: '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', media_type: 'movie', release_date: '2024-02-27', vote_average: 8.2 },
        { id: 155, title: 'The Dark Knight', poster_path: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg', media_type: 'movie', release_date: '2008-07-16', vote_average: 8.5 },
        { id: 157336, title: 'Interstellar', poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', media_type: 'movie', release_date: '2014-11-05', vote_average: 8.4 },
        { id: 27205, title: 'Inception', poster_path: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg', media_type: 'movie', release_date: '2010-07-15', vote_average: 8.4 }
      ]);
    }

    if (!localStorage.getItem(STORAGE_KEYS.PROGRESS)) {
      this._save(STORAGE_KEYS.PROGRESS, {
        157336: {
          id: 157336,
          title: 'Interstellar',
          poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
          backdrop_path: '/rAiYTpiVVGh0Fu4sSDkbgW7zVTB.jpg',
          media_type: 'movie',
          currentTime: 5400,
          duration: 10140,
          percent: 53,
          updatedAt: new Date(Date.now() - 3600000 * 4).toISOString()
        }
      });
    }

    // Seed Profile
    if (!localStorage.getItem(STORAGE_KEYS.PROFILE)) {
      this._save(STORAGE_KEYS.PROFILE, {
        username: 'cinephile_alex',
        displayName: 'Alex Rivers',
        bio: 'Cinematography addict & Sci-Fi enthusiast. Documenting my journey through 70mm dreams and contemporary masterworks.',
        avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop&q=80',
        joinedDate: 'January 2024',
        favFour: [693134, 155, 157336, 27205]
      });
    }
  }

  // Generic Helpers
  _get(key, defaultValue = null) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultValue;
    } catch (e) {
      console.error(`Store error reading ${key}:`, e);
      return defaultValue;
    }
  }

  _save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      this.emit(key, data);
      this.emit('change', { key, data });
    } catch (e) {
      console.error(`Store error writing ${key}:`, e);
    }
  }

  // Event Pub/Sub
  subscribe(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event).delete(callback);
  }

  emit(event, payload) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try {
          cb(payload);
        } catch (err) {
          console.error(`Error in listener for ${event}:`, err);
        }
      });
    }
  }

  // ==================== WATCHLIST (MY LIST) ====================
  getWatchlist() {
    return this._get(STORAGE_KEYS.WATCHLIST, []);
  }

  isInWatchlist(id) {
    const list = this.getWatchlist();
    return list.some(item => Number(item.id) === Number(id));
  }

  addToWatchlist(item) {
    const list = this.getWatchlist();
    if (!this.isInWatchlist(item.id)) {
      const entry = {
        id: item.id,
        title: item.title || item.name,
        poster_path: item.poster_path,
        backdrop_path: item.backdrop_path,
        media_type: item.media_type || (item.title ? 'movie' : 'tv'),
        release_date: item.release_date || item.first_air_date,
        vote_average: item.vote_average,
        genre_ids: item.genre_ids || (item.genres ? item.genres.map(g => g.id) : []),
        addedAt: new Date().toISOString()
      };
      list.unshift(entry);
      this._save(STORAGE_KEYS.WATCHLIST, list);
      return true;
    }
    return false;
  }

  removeFromWatchlist(id) {
    const list = this.getWatchlist().filter(item => Number(item.id) !== Number(id));
    this._save(STORAGE_KEYS.WATCHLIST, list);
  }

  toggleWatchlist(item) {
    if (this.isInWatchlist(item.id)) {
      this.removeFromWatchlist(item.id);
      return false;
    } else {
      this.addToWatchlist(item);
      return true;
    }
  }

  // ==================== CUSTOM LISTS / PLAYLISTS ====================
  getCustomLists() {
    return this._get(STORAGE_KEYS.CUSTOM_LISTS, []);
  }

  getListById(listId) {
    return this.getCustomLists().find(l => l.id === listId);
  }

  createCustomList({ name, description = '', visibility = 'private', coverImage = null }) {
    const lists = this.getCustomLists();
    const newList = {
      id: `list_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name: name.trim(),
      description: description.trim(),
      visibility, // 'private' | 'unlisted' | 'public'
      coverImage,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      movies: []
    };
    lists.unshift(newList);
    this._save(STORAGE_KEYS.CUSTOM_LISTS, lists);
    return newList;
  }

  updateCustomList(listId, updates) {
    const lists = this.getCustomLists();
    const index = lists.findIndex(l => l.id === listId);
    if (index !== -1) {
      lists[index] = {
        ...lists[index],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      this._save(STORAGE_KEYS.CUSTOM_LISTS, lists);
      return lists[index];
    }
    return null;
  }

  deleteCustomList(listId) {
    const lists = this.getCustomLists().filter(l => l.id !== listId);
    this._save(STORAGE_KEYS.CUSTOM_LISTS, lists);
  }

  addMovieToCustomList(listId, movie) {
    const lists = this.getCustomLists();
    const target = lists.find(l => l.id === listId);
    if (target) {
      const alreadyIn = target.movies.some(m => Number(m.id) === Number(movie.id));
      if (!alreadyIn) {
        target.movies.push({
          id: movie.id,
          title: movie.title || movie.name,
          poster_path: movie.poster_path,
          backdrop_path: movie.backdrop_path,
          media_type: movie.media_type || (movie.title ? 'movie' : 'tv'),
          release_date: movie.release_date || movie.first_air_date,
          vote_average: movie.vote_average,
          addedAt: new Date().toISOString()
        });
        target.updatedAt = new Date().toISOString();
        this._save(STORAGE_KEYS.CUSTOM_LISTS, lists);
        return true;
      }
    }
    return false;
  }

  removeMovieFromCustomList(listId, movieId) {
    const lists = this.getCustomLists();
    const target = lists.find(l => l.id === listId);
    if (target) {
      target.movies = target.movies.filter(m => Number(m.id) !== Number(movieId));
      target.updatedAt = new Date().toISOString();
      this._save(STORAGE_KEYS.CUSTOM_LISTS, lists);
    }
  }

  reorderCustomList(listId, reorderedMovies) {
    const lists = this.getCustomLists();
    const target = lists.find(l => l.id === listId);
    if (target) {
      target.movies = reorderedMovies;
      target.updatedAt = new Date().toISOString();
      this._save(STORAGE_KEYS.CUSTOM_LISTS, lists);
    }
  }

  getListsContainingMovie(movieId) {
    return this.getCustomLists().filter(l => 
      l.movies.some(m => Number(m.id) === Number(movieId))
    );
  }

  // ==================== DIARY & WATCHED HISTORY ====================
  getDiary() {
    return this._get(STORAGE_KEYS.DIARY, []);
  }

  isWatched(movieId) {
    return this.getDiary().some(entry => Number(entry.movieId) === Number(movieId));
  }

  getWatchedCount(movieId) {
    return this.getDiary().filter(entry => Number(entry.movieId) === Number(movieId)).length;
  }

  logWatched({ movie, rating = null, review = '', isSpoiler = false, rewatch = false, watchedAt = null }) {
    const diary = this.getDiary();
    const existingWatches = diary.filter(d => Number(d.movieId) === Number(movie.id)).length;
    const isRewatch = rewatch || existingWatches > 0;

    const entry = {
      id: `diary_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      movieId: movie.id,
      title: movie.title || movie.name,
      poster_path: movie.poster_path,
      backdrop_path: movie.backdrop_path,
      media_type: movie.media_type || (movie.title ? 'movie' : 'tv'),
      release_date: movie.release_date || movie.first_air_date,
      vote_average: movie.vote_average,
      watchedAt: watchedAt || new Date().toISOString(),
      rating: rating !== null ? Number(rating) : null,
      review: review.trim(),
      isSpoiler: Boolean(isSpoiler),
      rewatch: isRewatch,
      favorite: this.isFavorite(movie.id)
    };

    diary.unshift(entry);
    this._save(STORAGE_KEYS.DIARY, diary);

    if (rating !== null) {
      this.setRating(movie.id, rating);
    }

    if (review && review.trim()) {
      this.saveReview(movie.id, {
        rating,
        text: review.trim(),
        isSpoiler
      });
    }

    return entry;
  }

  deleteDiaryEntry(entryId) {
    const diary = this.getDiary().filter(d => d.id !== entryId);
    this._save(STORAGE_KEYS.DIARY, diary);
  }

  // ==================== RATINGS (0.5 - 5.0 STARS) ====================
  getRatings() {
    return this._get(STORAGE_KEYS.RATINGS, {});
  }

  getUserRating(movieId) {
    const ratings = this.getRatings();
    return ratings[movieId] !== undefined ? Number(ratings[movieId]) : null;
  }

  setRating(movieId, stars) {
    const ratings = this.getRatings();
    if (stars === null || stars === 0) {
      delete ratings[movieId];
    } else {
      ratings[movieId] = Math.min(5, Math.max(0.5, Math.round(stars * 2) / 2));
    }
    this._save(STORAGE_KEYS.RATINGS, ratings);
  }

  removeRating(movieId) {
    const ratings = this.getRatings();
    delete ratings[movieId];
    this._save(STORAGE_KEYS.RATINGS, ratings);
  }

  // ==================== REVIEWS ====================
  getReviews() {
    return this._get(STORAGE_KEYS.REVIEWS, []);
  }

  getMovieReviews(movieId) {
    return this.getReviews().filter(r => Number(r.movieId) === Number(movieId));
  }

  saveReview(movieId, { rating = null, text = '', isSpoiler = false }) {
    const reviews = this.getReviews();
    const existingIndex = reviews.findIndex(r => Number(r.movieId) === Number(movieId));
    
    const reviewData = {
      id: existingIndex >= 0 ? reviews[existingIndex].id : `rev_${Date.now()}`,
      movieId: Number(movieId),
      rating: rating !== null ? Number(rating) : this.getUserRating(movieId),
      text: text.trim(),
      isSpoiler: Boolean(isSpoiler),
      createdAt: existingIndex >= 0 ? reviews[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      reviews[existingIndex] = reviewData;
    } else {
      reviews.unshift(reviewData);
    }

    this._save(STORAGE_KEYS.REVIEWS, reviews);
    return reviewData;
  }

  deleteReview(reviewId) {
    const reviews = this.getReviews().filter(r => r.id !== reviewId);
    this._save(STORAGE_KEYS.REVIEWS, reviews);
  }

  // ==================== FAVORITES ====================
  getFavorites() {
    return this._get(STORAGE_KEYS.FAVORITES, []);
  }

  isFavorite(movieId) {
    return this.getFavorites().some(f => Number(f.id) === Number(movieId));
  }

  toggleFavorite(movie) {
    let favs = this.getFavorites();
    const isFav = this.isFavorite(movie.id);
    if (isFav) {
      favs = favs.filter(f => Number(f.id) !== Number(movie.id));
    } else {
      favs.unshift({
        id: movie.id,
        title: movie.title || movie.name,
        poster_path: movie.poster_path,
        backdrop_path: movie.backdrop_path,
        media_type: movie.media_type || (movie.title ? 'movie' : 'tv'),
        release_date: movie.release_date || movie.first_air_date,
        vote_average: movie.vote_average,
        favoritedAt: new Date().toISOString()
      });
    }
    this._save(STORAGE_KEYS.FAVORITES, favs);
    return !isFav;
  }

  // ==================== PLAYBACK PROGRESS (CONTINUE WATCHING) ====================
  getProgressMap() {
    return this._get(STORAGE_KEYS.PROGRESS, {});
  }

  getMovieProgress(movieId) {
    const progressMap = this.getProgressMap();
    return progressMap[movieId] || null;
  }

  saveProgress({ movie, currentTime, duration }) {
    const progressMap = this.getProgressMap();
    const percent = Math.min(100, Math.round((currentTime / duration) * 100));
    
    // If watched over 92%, mark as completed in diary & remove from continue watching
    if (percent >= 92) {
      delete progressMap[movie.id];
      this._save(STORAGE_KEYS.PROGRESS, progressMap);
      if (!this.isWatched(movie.id)) {
        this.logWatched({ movie, rewatch: false });
      }
      return;
    }

    progressMap[movie.id] = {
      id: movie.id,
      title: movie.title || movie.name,
      poster_path: movie.poster_path,
      backdrop_path: movie.backdrop_path,
      media_type: movie.media_type || (movie.title ? 'movie' : 'tv'),
      currentTime: Math.round(currentTime),
      duration: Math.round(duration),
      percent,
      updatedAt: new Date().toISOString()
    };

    this._save(STORAGE_KEYS.PROGRESS, progressMap);
  }

  removeProgress(movieId) {
    const progressMap = this.getProgressMap();
    delete progressMap[movieId];
    this._save(STORAGE_KEYS.PROGRESS, progressMap);
  }

  getContinueWatchingList() {
    const map = this.getProgressMap();
    return Object.values(map).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // ==================== PROFILE & STATISTICS ====================
  getProfile() {
    return this._get(STORAGE_KEYS.PROFILE, {
      username: 'cinephile',
      displayName: 'Film Explorer',
      bio: 'Cinema enthusiast and curator.',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop&q=80',
      joinedDate: '2024',
      favFour: []
    });
  }

  updateProfile(updates) {
    const profile = { ...this.getProfile(), ...updates };
    this._save(STORAGE_KEYS.PROFILE, profile);
    return profile;
  }

  getStatistics() {
    const diary = this.getDiary();
    const ratings = this.getRatings();
    const reviews = this.getReviews();
    const customLists = this.getCustomLists();
    const favorites = this.getFavorites();

    const totalWatched = diary.length;
    // Assume average runtime of 115 mins per movie/episode
    const totalMinutes = totalWatched * 115;
    const hoursWatched = Math.round(totalMinutes / 60);

    const ratingValues = Object.values(ratings).filter(r => r > 0);
    const totalRatings = ratingValues.length;
    const avgRating = totalRatings > 0 
      ? (ratingValues.reduce((sum, r) => sum + r, 0) / totalRatings).toFixed(1)
      : '0.0';

    // Rating distribution for Letterboxd histogram (0.5 to 5.0)
    const ratingDistribution = {
      '0.5': 0, '1.0': 0, '1.5': 0, '2.0': 0, '2.5': 0,
      '3.0': 0, '3.5': 0, '4.0': 0, '4.5': 0, '5.0': 0
    };
    ratingValues.forEach(val => {
      const key = Number(val).toFixed(1);
      if (ratingDistribution[key] !== undefined) {
        ratingDistribution[key]++;
      }
    });

    return {
      totalWatched,
      hoursWatched,
      totalRatings,
      avgRating,
      totalReviews: reviews.length,
      totalLists: customLists.length,
      totalFavorites: favorites.length,
      ratingDistribution
    };
  }
}

export const store = new Store();
