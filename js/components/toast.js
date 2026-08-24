/**
 * Toast Notification System
 */

class ToastManager {
  constructor() {
    this.container = null;
    this.init();
  }

  init() {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    this.container = container;
  }

  show(message, type = 'info', icon = null, duration = 3200) {
    if (!this.container) this.init();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type} animate-slide-in`;

    const iconHtml = icon ? `<span class="toast-icon">${icon}</span>` : this._getDefaultIcon(type);

    toast.innerHTML = `
      ${iconHtml}
      <div class="toast-message">${message}</div>
      <button class="toast-close" aria-label="Close">&times;</button>
    `;

    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => this.dismiss(toast));

    this.container.appendChild(toast);

    const timer = setTimeout(() => {
      this.dismiss(toast);
    }, duration);

    toast._timer = timer;
    return toast;
  }

  dismiss(toast) {
    if (!toast || toast._dismissing) return;
    toast._dismissing = true;
    clearTimeout(toast._timer);
    toast.classList.remove('animate-slide-in');
    toast.classList.add('animate-slide-out');
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 280);
  }

  _getDefaultIcon(type) {
    switch (type) {
      case 'success':
        return '<span class="toast-icon text-green">✓</span>';
      case 'error':
        return '<span class="toast-icon text-red">✕</span>';
      case 'warning':
        return '<span class="toast-icon text-amber">⚠</span>';
      case 'favorite':
        return '<span class="toast-icon text-pink">♥</span>';
      case 'rating':
        return '<span class="toast-icon text-gold">★</span>';
      default:
        return '<span class="toast-icon text-blue">ℹ</span>';
    }
  }

  success(msg, icon) { return this.show(msg, 'success', icon); }
  error(msg, icon) { return this.show(msg, 'error', icon); }
  favorite(msg) { return this.show(msg, 'favorite', '♥'); }
  rating(msg) { return this.show(msg, 'rating', '★'); }
  info(msg, icon) { return this.show(msg, 'info', icon); }
}

export const toast = new ToastManager();
