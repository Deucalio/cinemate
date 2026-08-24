/**
 * User Profile & Statistics View (Letterboxd Style)
 * Profile banner, "Favorite 4" marquee, rating distribution histogram, stats, and activity tabs
 */

import { store } from '../state/store.js';
import { getPosterUrl } from '../api/tmdb.js';
import { generateListCollageHtml } from '../components/listModal.js';
import { toast } from '../components/toast.js';

export function renderProfileView(container) {
  function render() {
    const profile = store.getProfile();
    const stats = store.getStatistics();
    const diary = store.getDiary();
    const reviews = store.getReviews();
    const customLists = store.getCustomLists();
    const favorites = store.getFavorites();

    // Favorite 4 posters
    const favFourMovies = favorites.slice(0, 4);

    container.innerHTML = `
      <div class="profile-page-container animate-fade-in">
        <!-- Profile Header Box -->
        <div class="profile-header-card">
          <div class="profile-avatar-wrap">
            <img src="${profile.avatar}" alt="${_escape(profile.username)}" class="profile-large-avatar" />
          </div>

          <div class="profile-details">
            <div class="profile-title-row">
              <h1 class="profile-name">${_escape(profile.displayName)}</h1>
              <span class="profile-username">@${_escape(profile.username)}</span>
              <button class="btn btn-secondary btn-sm ml-auto" id="btn-edit-profile">
                <span class="btn-icon">✎</span>
                <span class="btn-text">Edit Profile</span>
              </button>
            </div>

            <p class="profile-bio-text">${_escape(profile.bio || 'Film enthusiast building their cinema archive on CineStream.')}</p>

            <div class="profile-meta-badges">
              <span class="badge-pill">📅 Member since ${profile.joinedDate}</span>
              <span class="badge-pill">🎬 Cinephile Tier</span>
            </div>
          </div>
        </div>

        <!-- Favorite Four Films Showcase (Iconic Letterboxd Feature) -->
        <section class="profile-fav-four-section">
          <div class="section-heading-row">
            <h2 class="section-heading">Favorite Four Films</h2>
            <span class="text-muted text-sm">Pin your all-time essentials</span>
          </div>

          <div class="fav-four-grid">
            ${[0, 1, 2, 3].map(idx => {
              const movie = favFourMovies[idx];
              if (movie) {
                return `
                  <div class="fav-four-card" data-id="${movie.id}">
                    <img src="${getPosterUrl(movie.poster_path, 'w500')}" class="fav-four-poster" alt="${_escape(movie.title)}" />
                    <div class="fav-four-overlay">
                      <span class="fav-four-title">${_escape(movie.title)}</span>
                    </div>
                  </div>
                `;
              } else {
                return `
                  <a href="#discover" class="fav-four-card fav-four-empty">
                    <span class="empty-plus">＋</span>
                    <span class="empty-label">Add Favorite</span>
                  </a>
                `;
              }
            }).join('')}
          </div>
        </section>

        <!-- Statistics & Rating Distribution Grid -->
        <div class="profile-stats-dashboard-grid">
          <!-- Left: Big Numbers -->
          <div class="profile-stats-col">
            <h3 class="subsection-heading">Cinema Statistics</h3>
            <div class="stat-boxes-container">
              <div class="stat-box-item">
                <span class="stat-box-num text-blue">${stats.totalWatched}</span>
                <span class="stat-box-lbl">Watched Films</span>
              </div>
              <div class="stat-box-item">
                <span class="stat-box-num text-emerald">${stats.hoursWatched}</span>
                <span class="stat-box-lbl">Hours Logged</span>
              </div>
              <div class="stat-box-item">
                <span class="stat-box-num text-gold">${stats.avgRating}★</span>
                <span class="stat-box-lbl">Average Rating</span>
              </div>
              <div class="stat-box-item">
                <span class="stat-box-num text-pink">${stats.totalFavorites}</span>
                <span class="stat-box-lbl">Favorites</span>
              </div>
              <div class="stat-box-item">
                <span class="stat-box-num text-purple">${stats.totalReviews}</span>
                <span class="stat-box-lbl">Reviews Written</span>
              </div>
              <div class="stat-box-item">
                <span class="stat-box-num text-cyan">${stats.totalLists}</span>
                <span class="stat-box-lbl">Custom Lists</span>
              </div>
            </div>
          </div>

          <!-- Right: Rating Distribution Histogram (0.5 to 5.0) -->
          <div class="profile-histogram-col">
            <h3 class="subsection-heading">Rating Distribution</h3>
            <div class="rating-histogram-chart">
              ${Object.entries(stats.ratingDistribution).map(([stars, count]) => {
                const maxCount = Math.max(...Object.values(stats.ratingDistribution), 1);
                const heightPercent = Math.max(8, (count / maxCount) * 100);
                return `
                  <div class="histogram-bar-group" title="${stars} Stars: ${count} ratings">
                    <div class="histogram-bar-track">
                      <div class="histogram-bar-fill" style="height: ${heightPercent}%;">
                        ${count > 0 ? `<span class="histogram-count-val">${count}</span>` : ''}
                      </div>
                    </div>
                    <span class="histogram-bar-label">${stars}★</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <!-- Recent Reviews & Activity Section -->
        <section class="profile-recent-section">
          <div class="section-heading-row">
            <h2 class="section-heading">Recent Personal Reviews</h2>
            <a href="#diary" class="view-all-link">View All Activity →</a>
          </div>

          ${reviews.length === 0 ? `
            <div class="empty-state-small">
              <p>You haven't written any reviews yet. Click <strong>Write Review</strong> on any movie to express your thoughts.</p>
            </div>
          ` : `
            <div class="profile-reviews-grid">
              ${reviews.slice(0, 3).map(rev => {
                const diaryEntry = diary.find(d => Number(d.movieId) === Number(rev.movieId));
                const title = diaryEntry ? diaryEntry.title : `Movie #${rev.movieId}`;
                const poster = diaryEntry ? getPosterUrl(diaryEntry.poster_path, 'w185') : '';
                return `
                  <div class="profile-review-card">
                    <div class="review-card-top">
                      ${poster ? `<img src="${poster}" class="profile-review-thumb" />` : ''}
                      <div class="profile-review-movie-info">
                        <h4 class="profile-review-title">${_escape(title)}</h4>
                        <div class="profile-review-stars">
                          <span class="star-gold">${rev.rating ? '★'.repeat(Math.floor(rev.rating)) + (rev.rating % 1 !== 0 ? '½' : '') : 'Logged'}</span>
                          <span class="review-date-muted">${new Date(rev.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                    <p class="profile-review-body">“${_escape(rev.text)}”</p>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </section>

        <!-- Custom Lists by User -->
        <section class="profile-recent-section mt-5">
          <div class="section-heading-row">
            <h2 class="section-heading">Created Collections (${customLists.length})</h2>
            <a href="#lists" class="view-all-link">Manage Collections →</a>
          </div>

          <div class="custom-lists-grid">
            ${customLists.map(l => `
              <a href="#list/${l.id}" class="custom-list-card">
                <div class="list-card-collage-wrap">
                  ${generateListCollageHtml(l.movies)}
                </div>
                <div class="list-card-info">
                  <h3 class="list-card-title">${_escape(l.name)}</h3>
                  <span class="list-card-count">${l.movies.length} titles • ${l.visibility}</span>
                </div>
              </a>
            `).join('')}
          </div>
        </section>
      </div>
    `;

    // Edit Profile Modal
    const editBtn = container.querySelector('#btn-edit-profile');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const newName = prompt('Display Name:', profile.displayName);
        if (newName && newName.trim()) {
          const newBio = prompt('Bio:', profile.bio);
          const newAvatar = prompt('Avatar Image URL:', profile.avatar);
          store.updateProfile({
            displayName: newName.trim(),
            bio: (newBio || '').trim(),
            avatar: (newAvatar && newAvatar.trim()) ? newAvatar.trim() : profile.avatar
          });
          toast.success('Profile updated!');
          render();
        }
      });
    }

    // Fav four clicks open movie details
    container.querySelectorAll('.fav-four-card[data-id]').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        window.app.openDetailModal({ id, media_type: 'movie' });
      });
    });
  }

  render();
}

function _escape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
