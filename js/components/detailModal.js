/**
 * Movie & TV Show Detail Modal Component
 * Comprehensive view with backdrop, video trailers, Cast & Crew, Seasons/Episodes, Reviews, Ratings, and Similar titles
 */

import { tmdbApi, getBackdropUrl, getPosterUrl, getProfileUrl, getAuthorAvatarUrl } from '../api/tmdb.js';
import { store } from '../state/store.js';
import { createMovieCard } from './movieCard.js';
import { toast } from './toast.js';

export class DetailModalManager {
  constructor() {
    this.modal = null;
    this.currentData = null;
  }

  async open(movie) {
    this.close();

    const isTV = movie.media_type === 'tv' || (!movie.title && movie.name);
    const mediaType = isTV ? 'tv' : 'movie';
    const id = movie.id;

    // Create modal shell with loading indicator
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop animate-fade-in';
    modal.id = 'detail-modal';
    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-fullscreen animate-scale-in">
        <div class="detail-loading-spinner">
          <div class="spinner"></div>
          <span>Loading Cinema Metadata...</span>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.modal = modal;

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.close();
    });

    try {
      const details = isTV 
        ? await tmdbApi.getTVDetails(id)
        : await tmdbApi.getMovieDetails(id);
      
      details.media_type = mediaType;
      this.currentData = details;
      this._renderContent(details);
    } catch (err) {
      console.error('Error loading details:', err);
      modal.querySelector('.modal-dialog').innerHTML = `
        <div class="modal-header">
          <h2 class="modal-title">Failed to load title</h2>
          <button class="modal-close-btn" id="modal-err-close">&times;</button>
        </div>
        <div class="modal-body text-center" style="padding: 40px;">
          <p>Could not retrieve movie details from TMDB. Please check your internet connection.</p>
        </div>
      `;
      document.getElementById('modal-err-close').addEventListener('click', () => this.close());
    }
  }

  _renderContent(details) {
    const isTV = details.media_type === 'tv';
    const title = details.title || details.name;
    const releaseDate = details.release_date || details.first_air_date || '';
    const year = releaseDate ? releaseDate.substring(0, 4) : '';
    const runtime = details.runtime ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m` : (details.episode_run_time && details.episode_run_time[0] ? `${details.episode_run_time[0]}m per ep` : '');
    const backdrop = getBackdropUrl(details.backdrop_path, 'original');
    const poster = getPosterUrl(details.poster_path, 'w500');
    const tmdbRating = details.vote_average ? details.vote_average.toFixed(1) : '8.0';
    const voteCount = details.vote_count ? Number(details.vote_count).toLocaleString() : '1,000+';
    const tagline = details.tagline || '';
    const genres = (details.genres || []).map(g => g.name).join(' • ');

    const inWatchlist = store.isInWatchlist(details.id);
    const isFav = store.isFavorite(details.id);
    const userRating = store.getUserRating(details.id);
    const isWatched = store.isWatched(details.id);

    // Find official trailer if available
    const videos = (details.videos && details.videos.results) || [];
    const trailer = videos.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')) || videos[0];

    // Cast members
    const cast = ((details.credits && details.credits.cast) || []).slice(0, 10);
    const director = ((details.credits && details.credits.crew) || []).find(c => c.job === 'Director');

    // Personal reviews from store
    const personalReviews = store.getMovieReviews(details.id);

    // Live TMDB community reviews
    const tmdbReviews = (details.reviews && details.reviews.results) || [];
    const totalTmdbReviews = (details.reviews && details.reviews.total_results) || tmdbReviews.length;

    const dialog = this.modal.querySelector('.modal-dialog');
    dialog.innerHTML = `
      <button class="modal-close-btn-floating" id="detail-modal-close" aria-label="Close dialog">&times;</button>

      <!-- Hero Header with Backdrop / Trailer -->
      <div class="detail-hero-banner" style="background-image: url('${backdrop}');">
        <div class="detail-hero-gradient"></div>
        
        ${trailer ? `
          <div class="trailer-container" id="trailer-container" style="display:none;">
            <iframe id="trailer-iframe" src="" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
            <button class="btn-close-trailer" id="btn-close-trailer">&times; Close Trailer</button>
          </div>
        ` : ''}

        <div class="detail-hero-content">
          <div class="detail-badges-row">
            <span class="badge-pill badge-tmdb">★ TMDB ${tmdbRating} (${voteCount} votes)</span>
            <span class="badge-pill badge-quality">4K UHD</span>
            <span class="badge-pill badge-audio">5.1 SURROUND</span>
            ${year ? `<span class="badge-pill">${year}</span>` : ''}
            ${runtime ? `<span class="badge-pill">${runtime}</span>` : ''}
          </div>

          <h1 class="detail-title">${_escape(title)}</h1>
          ${tagline ? `<p class="detail-tagline">“${_escape(tagline)}”</p>` : ''}
          ${genres ? `<p class="detail-genres">${genres}</p>` : ''}

          <!-- Action Buttons Bar -->
          <div class="detail-action-bar">
            <button class="btn btn-primary btn-play-detail" id="btn-play-detail">
              <span class="btn-icon">▶</span>
              <span class="btn-text">Stream / Play</span>
            </button>

            <button class="btn btn-secondary" id="btn-detail-sources" title="Find Torrent Streams via Prowlarr">
              <span class="btn-icon">📡</span>
              <span class="btn-text">Torrent Sources</span>
            </button>

            ${trailer ? `
              <button class="btn btn-glass" id="btn-watch-trailer">
                <span class="btn-icon">🎬</span>
                <span class="btn-text">Trailer</span>
              </button>
            ` : ''}

            <button class="btn btn-glass btn-action-toggle ${inWatchlist ? 'is-active text-green' : ''}" id="btn-detail-watchlist" title="Save to Watchlist">
              <span class="btn-icon">${inWatchlist ? '✓' : '＋'}</span>
              <span class="btn-text">${inWatchlist ? 'In Watchlist' : 'Watchlist'}</span>
            </button>

            <button class="btn btn-glass" id="btn-detail-custom-list" title="Add to Custom List">
              <span class="btn-icon">📁</span>
              <span class="btn-text">Add to List</span>
            </button>

            <button class="btn btn-glass btn-action-toggle ${isWatched ? 'is-active text-blue' : ''}" id="btn-detail-watched" title="Log to Diary">
              <span class="btn-icon">👁</span>
              <span class="btn-text">${isWatched ? 'Watched' : 'Log / Rate'}</span>
            </button>

            <button class="btn btn-glass btn-action-toggle ${isFav ? 'is-active text-pink' : ''}" id="btn-detail-fav" title="Favorite">
              <span class="btn-icon">${isFav ? '♥' : '♡'}</span>
            </button>

            <button class="btn btn-glass" id="btn-detail-share" title="Share Title">
              <span class="btn-icon">🔗</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Main Body Container -->
      <div class="detail-body-container">
        <!-- Two Column Layout: Left Details, Right Letterboxd Card -->
        <div class="detail-grid-layout">
          <!-- Left Column -->
          <div class="detail-main-col">
            <!-- Synopsis -->
            <section class="detail-section">
              <h3 class="section-heading">Storyline</h3>
              <p class="detail-overview-text">${_escape(details.overview || 'No synopsis available.')}</p>
            </section>

            <!-- TV Seasons Explorer (if TV Show) -->
            ${isTV && details.seasons && details.seasons.length > 0 ? `
              <section class="detail-section" id="tv-seasons-section">
                <div class="section-heading-row">
                  <h3 class="section-heading">Seasons & Episodes</h3>
                  <select class="form-select season-select" id="season-select-dropdown">
                    ${details.seasons.filter(s => s.season_number > 0).map(s => `
                      <option value="${s.season_number}">${s.name} (${s.episode_count} Episodes)</option>
                    `).join('')}
                  </select>
                </div>
                <div class="episodes-list-container" id="episodes-list-container">
                  <div class="loading-episodes">Loading episodes...</div>
                </div>
              </section>
            ` : ''}

            <!-- Cast & Crew -->
            ${cast.length > 0 ? `
              <section class="detail-section">
                <h3 class="section-heading">Top Cast</h3>
                <div class="cast-scroll-row">
                  ${cast.map(c => `
                    <div class="cast-card">
                      <img src="${getProfileUrl(c.profile_path, 'w185')}" class="cast-photo" alt="${_escape(c.name)}" loading="lazy" />
                      <span class="cast-name">${_escape(c.name)}</span>
                      <span class="cast-character">${_escape(c.character || 'Self')}</span>
                    </div>
                  `).join('')}
                </div>
              </section>
            ` : ''}

            <!-- Reviews Section -->
            <section class="detail-section">
              <div class="section-heading-row">
                <h3 class="section-heading">Personal & TMDB Community Reviews ${totalTmdbReviews > 0 ? `<span class="catalog-counter-badge text-gold">${totalTmdbReviews}</span>` : ''}</h3>
                <button class="btn btn-secondary btn-sm" id="btn-write-review-detail">✎ Write Review</button>
              </div>

              <div class="reviews-container">
                <!-- User's own personal reviews from store -->
                ${personalReviews.map(r => `
                  <div class="review-card personal-review-card">
                    <div class="review-header">
                      <div class="review-author-info">
                        <span class="review-badge-user">YOUR REVIEW</span>
                        <span class="star-gold">${r.rating ? '★'.repeat(Math.floor(r.rating)) + (r.rating % 1 !== 0 ? '½' : '') : ''}</span>
                      </div>
                      <span class="review-date">${new Date(r.createdAt).toLocaleDateString()}</span>
                    </div>
                    <p class="review-text">${_escape(r.text)}</p>
                  </div>
                `).join('')}

                <!-- Live TMDB Reviews -->
                ${tmdbReviews.map((rev, idx) => {
                  const authorName = rev.author_details && rev.author_details.name ? rev.author_details.name : (rev.author || 'TMDB User');
                  const username = rev.author_details && rev.author_details.username ? rev.author_details.username : rev.author;
                  const avatarUrl = getAuthorAvatarUrl(rev.author_details ? rev.author_details.avatar_path : null);
                  const ratingVal = rev.author_details && rev.author_details.rating ? rev.author_details.rating : null;
                  const dateStr = rev.created_at ? new Date(rev.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                  const content = rev.content || '';
                  const isLong = content.length > 320;
                  const isSpoiler = content.toLowerCase().includes('spoiler') || content.toLowerCase().includes('ending');

                  return `
                    <div class="review-card ${isSpoiler ? 'review-spoiler' : ''}" id="tmdb-rev-card-${idx}">
                      <div class="review-header">
                        <div class="review-author-info">
                          <img src="${avatarUrl}" class="review-avatar" alt="${_escape(authorName)}" loading="lazy" />
                          <div>
                            <span class="review-author">${_escape(authorName)}</span>
                            <span class="review-author-handle">@${_escape(username)}</span>
                          </div>
                          ${ratingVal ? `<span class="star-gold review-rating-pill">★ ${ratingVal}/10</span>` : ''}
                        </div>
                        <span class="review-date">${dateStr}</span>
                      </div>

                      ${isSpoiler ? `
                        <div class="spoiler-warning-box">
                          <span>⚠️ This review may contain spoilers</span>
                          <button class="btn btn-sm btn-glass btn-reveal-spoiler" data-target="tmdb-rev-card-${idx}">Show Review</button>
                        </div>
                        <div class="spoiler-hidden-text" style="display:none;">
                          <p class="review-text">${_escape(content)}</p>
                          ${rev.url ? `<a href="${rev.url}" target="_blank" rel="noopener noreferrer" class="review-tmdb-link">Read on TMDB ↗</a>` : ''}
                        </div>
                      ` : (
                        isLong ? `
                          <p class="review-text review-content-truncated" id="rev-text-${idx}">${_escape(content.substring(0, 300))}...</p>
                          <p class="review-text review-content-full" id="rev-full-${idx}" style="display:none;">${_escape(content)}</p>
                          <div class="review-expand-row">
                            <button class="btn-toggle-read-more" data-idx="${idx}">Read More ▼</button>
                            ${rev.url ? `<a href="${rev.url}" target="_blank" rel="noopener noreferrer" class="review-tmdb-link">Read on TMDB ↗</a>` : ''}
                          </div>
                        ` : `
                          <p class="review-text">${_escape(content)}</p>
                          ${rev.url ? `<a href="${rev.url}" target="_blank" rel="noopener noreferrer" class="review-tmdb-link">Read on TMDB ↗</a>` : ''}
                        `
                      )}
                    </div>
                  `;
                }).join('')}

                <!-- Empty State if no reviews -->
                ${personalReviews.length === 0 && tmdbReviews.length === 0 ? `
                  <div class="empty-state-small">
                    <p>No community reviews available for this title on TMDB yet.</p>
                    <button class="btn btn-primary btn-sm mt-3" id="btn-empty-write-rev">✎ Be the first to review!</button>
                  </div>
                ` : ''}
              </div>
            </section>
          </div>

          <!-- Right Sidebar: Poster + Letterboxd Activity Box -->
          <div class="detail-sidebar-col">
            <img src="${poster}" alt="${_escape(title)}" class="detail-poster-img" />

            <div class="letterboxd-status-box">
              <h4 class="status-box-title">YOUR LOG</h4>
              
              <div class="status-box-row">
                <span class="status-box-label">Status:</span>
                <span class="status-box-val">${isWatched ? '<span class="text-blue font-bold">✓ Watched</span>' : '<span class="text-muted">Unwatched</span>'}</span>
              </div>

              <div class="status-box-row">
                <span class="status-box-label">Your Rating:</span>
                <span class="status-box-val">${userRating ? `<span class="text-gold font-bold">★ ${userRating} / 5</span>` : '<span class="text-muted">Not rated</span>'}</span>
              </div>

              <div class="status-box-row">
                <span class="status-box-label">Favorited:</span>
                <span class="status-box-val">${isFav ? '<span class="text-pink">♥ Yes</span>' : '<span class="text-muted">No</span>'}</span>
              </div>

              <div class="status-box-row">
                <span class="status-box-label">In Watchlist:</span>
                <span class="status-box-val">${inWatchlist ? '<span class="text-green">✓ In Queue</span>' : '<span class="text-muted">No</span>'}</span>
              </div>

              <button class="btn btn-primary btn-full mt-3" id="btn-sidebar-log">
                <span class="btn-icon">👁</span>
                <span class="btn-text">Rate or Log Movie</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Similar & Recommended Movies Carousel -->
        ${((details.recommendations && details.recommendations.results) || (details.similar && details.similar.results) || []).length > 0 ? `
          <section class="detail-section mt-5">
            <h3 class="section-heading">More Like This</h3>
            <div class="cards-horizontal-shelf" id="shelf-similar-movies"></div>
          </section>
        ` : ''}
      </div>
    `;

    this._bindDetailEvents(details, trailer);

    // If TV show, load first season
    if (isTV && details.seasons && details.seasons.length > 0) {
      const firstSeason = details.seasons.find(s => s.season_number > 0) || details.seasons[0];
      this._loadSeasonEpisodes(details.id, firstSeason.season_number);
    }

    // Populate Similar Movies shelf
    const similarContainer = dialog.querySelector('#shelf-similar-movies');
    if (similarContainer) {
      const similarItems = (details.recommendations && details.recommendations.results && details.recommendations.results.length > 0)
        ? details.recommendations.results.slice(0, 10)
        : (details.similar && details.similar.results ? details.similar.results.slice(0, 10) : []);

      similarItems.forEach(item => {
        item.media_type = isTV ? 'tv' : 'movie';
        const card = createMovieCard(item, { compact: true });
        similarContainer.appendChild(card);
      });
    }
  }

  _bindDetailEvents(details, trailer) {
    const dialog = this.modal.querySelector('.modal-dialog');
    const closeBtn = dialog.querySelector('#detail-modal-close');
    const playBtn = dialog.querySelector('#btn-play-detail');
    const watchlistBtn = dialog.querySelector('#btn-detail-watchlist');
    const customListBtn = dialog.querySelector('#btn-detail-custom-list');
    const watchedBtn = dialog.querySelector('#btn-detail-watched');
    const favBtn = dialog.querySelector('#btn-detail-fav');
    const shareBtn = dialog.querySelector('#btn-detail-share');
    const writeRevBtn = dialog.querySelector('#btn-write-review-detail');
    const sidebarLogBtn = dialog.querySelector('#btn-sidebar-log');
    const trailerBtn = dialog.querySelector('#btn-watch-trailer');
    const trailerCloseBtn = dialog.querySelector('#btn-close-trailer');
    const trailerContainer = dialog.querySelector('#trailer-container');
    const trailerIframe = dialog.querySelector('#trailer-iframe');
    const seasonSelect = dialog.querySelector('#season-select-dropdown');

    const title = details.title || details.name;

    const sourcesDetailBtn = dialog.querySelector('#btn-detail-sources');

    closeBtn.addEventListener('click', () => this.close());

    playBtn.addEventListener('click', () => {
      this.close();
      window.app.openPlayer(details, { openSources: true });
    });

    if (sourcesDetailBtn) {
      sourcesDetailBtn.addEventListener('click', () => {
        this.close();
        window.app.openPlayer(details, { openSources: true });
      });
    }

    if (trailerBtn && trailer) {
      trailerBtn.addEventListener('click', () => {
        trailerIframe.src = `https://www.youtube.com/embed/${trailer.key}?autoplay=1&enablejsapi=1`;
        trailerContainer.style.display = 'block';
      });
    }

    if (trailerCloseBtn) {
      trailerCloseBtn.addEventListener('click', () => {
        trailerIframe.src = '';
        trailerContainer.style.display = 'none';
      });
    }

    watchlistBtn.addEventListener('click', () => {
      const added = store.toggleWatchlist(details);
      watchlistBtn.querySelector('.btn-text').textContent = added ? 'In Watchlist' : 'Watchlist';
      watchlistBtn.querySelector('.btn-icon').textContent = added ? '✓' : '＋';
      watchlistBtn.classList.toggle('is-active', added);
      watchlistBtn.classList.toggle('text-green', added);
      toast.success(added ? `Added "${title}" to Watchlist` : `Removed "${title}" from Watchlist`);
    });

    customListBtn.addEventListener('click', () => {
      window.app.openListSelectorModal(details);
    });

    const openLog = () => {
      window.app.openRateReviewModal(details);
    };

    watchedBtn.addEventListener('click', openLog);
    sidebarLogBtn.addEventListener('click', openLog);
    if (writeRevBtn) writeRevBtn.addEventListener('click', openLog);

    favBtn.addEventListener('click', () => {
      const isFavNow = store.toggleFavorite(details);
      favBtn.querySelector('.btn-icon').textContent = isFavNow ? '♥' : '♡';
      favBtn.classList.toggle('is-active', isFavNow);
      favBtn.classList.toggle('text-pink', isFavNow);
      if (isFavNow) {
        toast.favorite(`Added "${title}" to Favorites`);
      } else {
        toast.info(`Removed "${title}" from Favorites`);
      }
    });

    shareBtn.addEventListener('click', () => {
      const shareUrl = `${window.location.origin}${window.location.pathname}#movie/${details.id}`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        toast.success(`Share link copied to clipboard!`);
      });
    });

    // Spoiler reveal buttons
    dialog.querySelectorAll('.btn-reveal-spoiler').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.review-card');
        if (card) {
          const warnBox = card.querySelector('.spoiler-warning-box');
          const hiddenTxt = card.querySelector('.spoiler-hidden-text');
          if (warnBox) warnBox.style.display = 'none';
          if (hiddenTxt) hiddenTxt.style.display = 'block';
        }
      });
    });

    // Read More / Show Less toggle for long TMDB reviews
    dialog.querySelectorAll('.btn-toggle-read-more').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = btn.dataset.idx;
        const truncEl = dialog.querySelector(`#rev-text-${idx}`);
        const fullEl = dialog.querySelector(`#rev-full-${idx}`);
        if (truncEl && fullEl) {
          const isExpanded = fullEl.style.display !== 'none';
          if (isExpanded) {
            fullEl.style.display = 'none';
            truncEl.style.display = 'block';
            btn.textContent = 'Read More ▼';
          } else {
            fullEl.style.display = 'block';
            truncEl.style.display = 'none';
            btn.textContent = 'Show Less ▲';
          }
        }
      });
    });

    const emptyWriteBtn = dialog.querySelector('#btn-empty-write-rev');
    if (emptyWriteBtn) emptyWriteBtn.addEventListener('click', openLog);

    // Season change dropdown
    if (seasonSelect) {
      seasonSelect.addEventListener('change', (e) => {
        this._loadSeasonEpisodes(details.id, e.target.value);
      });
    }
  }

  async _loadSeasonEpisodes(tvId, seasonNumber) {
    const container = this.modal.querySelector('#episodes-list-container');
    if (!container) return;

    container.innerHTML = `<div class="loading-episodes">Loading Season ${seasonNumber} episodes...</div>`;

    try {
      const seasonData = await tmdbApi.getTVSeason(tvId, seasonNumber);
      const episodes = seasonData.episodes || [];

      if (episodes.length === 0) {
        container.innerHTML = `<div class="no-episodes">No episode details available.</div>`;
        return;
      }

      container.innerHTML = `
        <div class="episodes-grid">
          ${episodes.map(ep => {
            const still = ep.still_path ? getBackdropUrl(ep.still_path, 'w780') : 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=780&auto=format&fit=crop&q=60';
            return `
              <div class="episode-card" data-ep-number="${ep.episode_number}">
                <div class="episode-still-wrap">
                  <img src="${still}" class="episode-still-img" alt="${_escape(ep.name)}" loading="lazy" />
                  <button class="episode-play-overlay-btn" data-ep-id="${ep.id}">▶</button>
                  <span class="episode-number-badge">EP ${ep.episode_number}</span>
                </div>
                <div class="episode-meta">
                  <h4 class="episode-name">${ep.episode_number}. ${_escape(ep.name)}</h4>
                  <span class="episode-air-date">${ep.air_date || ''} • ${ep.runtime ? `${ep.runtime}m` : '45m'}</span>
                  <p class="episode-overview">${_escape(ep.overview || 'Episode stream ready.')}</p>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;

      // Play specific episode
      container.querySelectorAll('.episode-play-overlay-btn, .episode-card').forEach(item => {
        item.addEventListener('click', (e) => {
          const card = item.closest('.episode-card');
          const epNum = card ? card.dataset.epNumber : 1;
          this.close();
          window.app.openPlayer(this.currentData, { season: seasonNumber, episode: epNum });
        });
      });

    } catch (err) {
      container.innerHTML = `<div class="no-episodes">Could not load episodes for this season.</div>`;
    }
  }

  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const detailModal = new DetailModalManager();
