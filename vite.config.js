import { defineConfig, loadEnv } from 'vite';

/**
 * CineStream Pro — Vite config
 *
 * The app is plain ES modules (no framework), so Vite serves `js/` and `css/` as-is. What it adds:
 *   - HMR instead of a manual refresh loop
 *   - `import.meta.env` so credentials come from .env.local rather than being hardcoded in source
 *   - a dev proxy, so the bridge can be reached same-origin when that is useful
 *   - a real build step, needed later for any hosted deployment
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const bridge = env.VITE_STREAM_SERVER || 'http://127.0.0.1:8899';

  return {
    // index.html lives at the repo root and already loads js/app.js as a module.
    root: '.',
    publicDir: false,

    server: {
      port: 3000,
      strictPort: false,
      open: false,

      /**
       * Same-origin access to the bridge at /bridge/*.
       *
       * NOT used by default: streamingBridge still talks to the absolute VPS URL, which works today
       * via CORS. This exists so a same-origin setup is one env var away (set
       * VITE_STREAM_SERVER_PROXY=1) without routing multi-gigabyte video through the dev proxy
       * before we have a reason to.
       */
      proxy: {
        '/bridge': {
          target: bridge,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/bridge/, '')
        }
      }
    },

    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Torrent/stream URLs are built at runtime; nothing here needs a legacy target.
      target: 'es2020',
      sourcemap: true
    }
  };
});
