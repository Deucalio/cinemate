# CineStream Pro (CineMate) — Complete Technical Documentation

> **Next-Generation Cinema Discovery & Distributed Streaming Web Application**  
> Built with modern vanilla JavaScript, high-performance CSS design system, TMDB metadata integration, Prowlarr indexer aggregation, and native qBittorrent HTTP 206 sequential media streaming.

---

## 1. Executive Architecture Overview

CineStream Pro brings a cinematic streaming interface together with a distributed, real-time media acquisition bridge. Users can browse global trending entertainment, view high-definition trailers, manage personal watch diaries and custom collections, and stream available torrent releases directly in their browser without waiting for whole files to download.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                CLIENT BROWSER (PORT 3000)                              │
│                                                                                        │
│   ┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────────────────┐   │
│   │   Discover / Home   │    │  Movie & TV Modals  │    │  Cinema Theater Player   │   │
│   │   Trending, Genres  │    │  Trailers & Reviews │    │  Timeline, Buffering HUD │   │
│   └──────────┬──────────┘    └──────────┬──────────┘    └────────────┬─────────────┘   │
└──────────────┼──────────────────────────┼────────────────────────────┼─────────────────┘
               │                          │                            │
               ▼                          ▼                            ▼
      ┌─────────────────┐        ┌─────────────────┐          ┌──────────────────┐
      │    TMDB API     │        │  LocalStorage   │          │ VPS Bridge :8888 │
      │  v3 / Discover  │        │  State & Diary  │          │ Express Backend  │
      └─────────────────┘        └─────────────────┘          └────────┬─────────┘
                                                                       │
                                      ┌────────────────────────────────┴────────────────┐
                                      │                                                 │
                                      ▼                                                 ▼
                         ┌─────────────────────────┐                       ┌─────────────────────────┐
                         │     Prowlarr :9696      │                       │   qBittorrent :18080    │
                         │ Torznab Community Feeds │                       │  Sequential C++ Engine  │
                         └─────────────────────────┘                       └────────────┬────────────┘
                                                                                        │ (Sequential Pieces)
                                                                                        ▼
                                                                           ┌─────────────────────────┐
                                                                           │  HTTP 206 Media Stream  │
                                                                           │  Auto-GC (15 min idle)  │
                                                                           └─────────────────────────┘
```

---

## 2. Core Feature Inventory

### 🎬 1. Cinematic Frontend & User Experience
- **Dynamic Hero Billboard:** High-impact backdrop spotlight with automated rotation, trailers preview, quick play, and watchlist toggling.
- **Categorized Carousels:** Trending Movies, Popular TV Shows, Top Rated, Action, Sci-Fi, Drama, and Documentaries powered by TMDB.
- **Deep Discovery View:** Multi-filter exploration supporting custom sorting (Popularity, Rating, Release Date), genre tags, release year filters, and minimum rating sliders.
- **Letterboxd-Style Social Features:**
  - **Watch Diary:** Log viewings with specific watch dates, personal rewatch counter, and custom notes.
  - **Star Rating & In-Depth Reviews:** Rate on a 5-star scale (with half-stars) and write long-form reviews saved to your local profile.
  - **Custom Curated Lists:** Create named public/private watchlists with custom descriptions and drag-and-drop item management.
  - **Profile & Analytics:** Visual stats on total movies watched, hours logged, favorite genres breakdown, and top-rated titles.

### 📡 2. Media Bridge & Indexer Search
- **Community Indexer Aggregation (Prowlarr Proxy):**
  - Searches active indexers via Prowlarr's Torznab API.
  - The VPS bridge proxies search queries on loopback (`http://127.0.0.1:9696`), completely bypassing browser CORS restrictions and eliminating the need for client-side SSH tunnels.
  - Automatically parses release names for resolution tags (`4K UHD`, `1080p`, `720p`), audio profiles (`Dolby Atmos`, `5.1 DTS`), video codecs (`HEVC`, `x264`), file sizes, and active seeder/leecher counts.
  - Intelligently sorts releases with the highest health and seeder availability at the top.

### 🍿 3. Cinema Theater Player
- **HTML5 Streaming Video Player:**
  - Fullscreen toggle, timeline scrubber with progress and buffered ranges, 10s skip/rewind shortcuts, volume slider with mute toggle, and playback speed control (0.5x to 2x).
  - **Live Buffering & Swarm HUD:** Center overlay providing feedback during connection, peer discovery, and sequential piece buffering.
  - **Interactive Stream Sources Drawer:** Browse available releases or paste custom `magnet:?xt=` links directly inside the player.
  - **Seamless Resume Playback:** Remembers your exact timestamp and progress across sessions.

---

## 3. How Torrent Streaming Works (Under the Hood)

Traditional torrent clients download pieces in random order, meaning you must wait for the full multi-gigabyte file before playing. CineStream solves this through a **3-tier sequential streaming pipeline**:

### Step 1: Magnet Acquisition & Sequential Priority
When the user clicks **▶ Stream Now**, the client calls `http://<VPS_IP>:8888/api/stream?magnet=...&title=...`. The bridge server authenticates with the VPS qBittorrent daemon (`127.0.0.1:18080`) and injects the torrent with:
- `sequentialDownload = true`: Enforces linear piece downloading (Piece 0, 1, 2, 3...)
- `firstLastPiecePrio = true`: Prioritizes the container file header (moov atom / metadata) and index table.

### Step 2: Immediate HTTP 206 Partial Content Piping
As soon as the initial video header and first ~10 seconds of video data are written to disk (typically 5 to 15 seconds), the Express server opens an `fs.createReadStream` and serves the file over standard **HTTP 206 Partial Content** with byte-range headers (`Content-Range: bytes start-end/total`).

### Step 3: Background Buffering
The browser's native `<video>` element plays the incoming stream immediately while qBittorrent continues downloading subsequent pieces ahead of the playback scrubber.

---

## 4. Resource & Storage Management (Bandwidth Saver & Auto-GC)

To prevent VPS storage exhaustion and conserve network bandwidth when multiple users watch and leave, `server/index.js` implements active lifecycle management:

```
┌─────────────────────────┐     User Leaves Tab / Modal     ┌─────────────────────────┐
│ Active HTTP Connection  │ ──────────────────────────────> │ Decrement Active Viewer │
└─────────────────────────┘                                 └────────────┬────────────┘
                                                                         │
                                                                         ▼
┌─────────────────────────┐        Idle > 15 Minutes        ┌─────────────────────────┐
│ qbt.deleteTorrent()     │ ◄────────────────────────────── │ qbt.pauseTorrents()     │
│ Wipe file from VPS disk │   (Automated Background Cron)   │ Stop VPS Bandwidth Use  │
└─────────────────────────┘                                 └─────────────────────────┘
```

1. **Active Viewer Tracking:** Tracks real-time viewer count per torrent hash.
2. **Instant Bandwidth Saver:** When a viewer closes their browser tab or navigates away (`req.on('close')`), active viewers drop to 0. If no other client connects within 30 seconds, the download is automatically paused in qBittorrent.
3. **15-Minute Automated Garbage Collection (Auto-GC):** A background cron runs every 60 seconds. Any torrent with 0 active viewers that has remained idle for more than 15 minutes (`IDLE_TTL_MINUTES = 15`) is automatically deleted from qBittorrent along with its files on disk.
4. **Manual Cleanup Endpoint:** `POST /api/cleanup` wipes all idle, unwatched torrents on demand.

---

## 5. File Structure & Codebase Map

```
cinemate/
├── css/
│   ├── main.css            # Design tokens, typography, gradients, glassmorphism
│   ├── components.css      # Movie cards, carousels, buttons, form inputs, badges
│   ├── library.css         # Watch diary, rating cards, custom lists, profile styles
│   └── player.css          # Cinema player, buffering HUD, sources drawer, settings modal
├── js/
│   ├── api/
│   │   └── tmdb.js         # TMDB API client (movies, TV, search, genres, credits, reviews)
│   ├── components/
│   │   ├── navbar.js       # Navigation bar with live instant search & route dispatcher
│   │   ├── hero.js         # Billboard spotlight with trailer previews
│   │   ├── movieCard.js    # Interactive poster card with quick-actions & rating overlay
│   │   ├── detailModal.js  # Rich detail dialog with trailer playback, cast, reviews & sources
│   │   ├── playerModal.js  # HTML5 theater player with swarm HUD & sources manager
│   │   ├── rateReviewModal.js # Letterboxd-style 5-star rating & review editor
│   │   ├── listModal.js    # Add-to-list & custom list creation modal
│   │   └── toast.js        # Global toast notification dispatch system
│   ├── services/
│   │   ├── streamingBridge.js # Prowlarr indexer search client & stream URL builder
│   │   └── recommendations.js # Smart algorithm tailoring titles based on watch history
│   ├── state/
│   │   └── store.js        # Reactive state manager with LocalStorage persistence
│   ├── views/
│   │   ├── homeView.js     # Featured billboard & categorized carousels
│   │   ├── moviesView.js   # Filterable movies explorer
│   │   ├── tvView.js       # TV Series directory with season/episode breakdown
│   │   ├── discoverView.js # Advanced multi-parameter discovery grid
│   │   ├── myListView.js   # Personal watchlist grid
│   │   ├── diaryView.js    # Chronological viewing diary with review highlights
│   │   ├── customListsView.js # User-created curated collections
│   │   ├── favoritesView.js # Favorited titles
│   │   └── profileView.js  # User stats, viewing hours, genre breakdown chart
│   └── app.js              # Application entry point & URL hash router
├── server/
│   ├── index.js            # Express Streaming Bridge, qBittorrent & Prowlarr controllers
│   ├── package.json        # Server dependencies (express, cors, dotenv)
│   └── setup-ubuntu.sh     # Automated VPS installer & PM2 daemon config
├── index.html              # Single Page Application HTML entry
├── package.json            # Frontend dev server script (`npm run dev`)
└── project.md              # System documentation & architectural reference
```

---

## 6. Setup & Deployment Guide

### Local Development (Frontend)
```bash
# 1. Clone repository
git clone https://github.com/Deucalio/cinemate.git
cd cinemate

# 2. Install dependencies (if needed) & start local dev server
npm install
npm run dev

# 3. Open in browser
http://localhost:3000/#home
```

### VPS Production Bridge (Ubuntu 22.04 LTS)
The backend bridge runs alongside native qBittorrent (`127.0.0.1:18080`) and Prowlarr (`127.0.0.1:9696`) under PM2:

```bash
# 1. Connect to VPS
ssh rdpuser@<VPS_IP>

# 2. Navigate to project root
cd /opt/cinemate

# 3. Pull latest updates
sudo git pull

# 4. Install backend dependencies
cd /opt/cinemate/server
npm install

# 5. Start or restart PM2 background service
sudo pm2 restart cinestream-bridge || sudo pm2 start index.js --name cinestream-bridge

# 6. Verify health
curl http://localhost:8888/health
```

Health endpoint response:
```json
{
  "status": "online",
  "service": "CineStream Torrent Bridge (qBittorrent & Prowlarr)",
  "qBittorrentConnected": true,
  "activeTorrentsCount": 1,
  "idleCleanupTtlMinutes": 15,
  "qbtEndpoint": "http://127.0.0.1:18080",
  "prowlarrEndpoint": "http://127.0.0.1:9696"
}
```

---

## 7. Security & Isolation Standard

- **Loopback Service Binding:** All internal daemons (qBittorrent `:18080`, Prowlarr `:9696`) are bound strictly to `127.0.0.1` and never exposed directly to the public internet.
- **Sanitized Metadata Feeds:** Search indexers are accessed exclusively through internal API proxies. Secret credentials and API keys are stored in server environment variables and never leaked to the client browser.
- **Zero Host Starvation:** Streaming operations utilize standard non-blocking asynchronous Node.js streams, maintaining less than 1% CPU utilization on the VPS host.
