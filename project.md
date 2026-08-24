# CineStream Pro (CineMate) — Production Technical Architecture & Specification

> **Next-Generation Cinema Discovery & Piece-Aware Distributed Media Streaming Engine**  
> Built with vanilla JavaScript, modern CSS design tokens, TMDB metadata, Prowlarr Torznab indexer aggregation, and native qBittorrent HTTP 206 piece-aware streaming.

---

## 1. Executive Architecture Overview

CineStream Pro bridges a cinematic web client with an on-demand, piece-aware BitTorrent streaming daemon. Rather than waiting for full multi-gigabyte media downloads, the bridge maps HTTP byte-range requests directly to BitTorrent piece indices, dynamically prioritizes required chunks from the swarm, verifies piece readiness on disk, and pipes continuous media streams to the browser.

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
      ┌─────────────────┐        ┌─────────────────┐          ┌──────────────────────────┐
      │    TMDB API     │        │  LocalStorage   │          │   VPS Bridge (:8888)     │
      │  v3 / Discover  │        │  State & Diary  │          │   Express + Piece Engine │
      └─────────────────┘        └─────────────────┘          └────────────┬─────────────┘
                                                                           │
                                      ┌────────────────────────────────────┴──────────────────────────┐
                                      │                                                               │
                                      ▼                                                               ▼
                         ┌─────────────────────────┐                                     ┌─────────────────────────┐
                         │     Prowlarr :9696      │                                     │   qBittorrent :18080    │
                         │ Torznab Community Feeds │                                     │  Sequential C++ Engine  │
                         └─────────────────────────┘                                     └────────────┬────────────┘
                                                                                                      │ (Piece Verification)
                                                                                                      ▼
                                                                                         ┌─────────────────────────┐
                                                                                         │  HTTP 206 Piece Stream  │
                                                                                         │  Heartbeat Auto-GC      │
                                                                                         └─────────────────────────┘
```

---

## 2. Core Feature Inventory

### 🎬 1. Cinematic Frontend & User Experience
- **Dynamic Hero Spotlight:** High-impact backdrop billboard with automated rotation, video trailer previews, instant playback, and watchlist integration.
- **Categorized Carousels:** Trending Movies, Popular TV Shows, Top Rated, Action, Sci-Fi, Drama, and Documentaries powered by TMDB.
- **Deep Discovery View:** Multi-parameter catalog exploration with custom sorting (Popularity, Rating, Release Date), genre multi-select, release year filters, and minimum rating sliders.
- **Letterboxd-Style Social Features:**
  - **Watch Diary:** Log viewings with specific watch dates, personal rewatch counters, and custom notes.
  - **Star Rating & In-Depth Reviews:** Rate on a 5-star scale (with half-stars) and write long-form reviews stored locally.
  - **Custom Curated Lists:** Create named public/private watchlists with custom descriptions and drag-and-drop item management.
  - **Profile & Analytics:** Visual charts of total movies watched, hours logged, favorite genre breakdown, and top-rated titles.

### 📡 2. Media Bridge & Indexer Search
- **Community Indexer Aggregation (Prowlarr Proxy):**
  - Queries Torznab feeds via Prowlarr on the VPS loopback (`http://127.0.0.1:9696`), bypassing browser CORS and eliminating SSH tunnel requirements.
  - Parses releases for resolution tags (`4K UHD`, `1080p`, `720p`), audio profiles (`Dolby Atmos`, `5.1 DTS`), video codecs (`HEVC`, `x264`), file sizes, and active seeder counts.
  - Intelligently ranks releases with the highest health and seeder availability at the top.

### 🍿 3. Cinema Theater Player
- **HTML5 Streaming Video Player:**
  - Fullscreen toggle, timeline scrubber with progress and buffered ranges, 10s skip/rewind shortcuts, volume slider with mute toggle, and playback speed control (0.5x to 2x).
  - **Live Buffering & Swarm HUD:** Visual overlay providing feedback during connection, peer discovery, piece availability polling, and stream buffering.
  - **Interactive Stream Sources Drawer:** Browse available releases or paste custom `magnet:?xt=` links directly inside the player.
  - **Seamless Resume Playback:** Remembers your exact timestamp and progress across sessions.

---

## 3. The Piece-Aware Streaming Engine

A standard `fs.createReadStream()` call on an in-progress torrent file does not guarantee byte availability, because torrent clients pre-allocate sparse file boundaries on disk. CineStream Pro implements a **Byte-Range to Torrent-Piece Mapper & Availability Layer**:

```
Browser Request
   │
   │ Range: bytes=80,000,000 - 90,000,000
   ▼
Streaming Bridge
   │
   ├── 1. Compute Global Torrent Offset & File Piece Range
   │      startPiece = firstPiece + floor(startByte / pieceSize)
   │      endPiece   = firstPiece + floor(endByte / pieceSize)
   │
   ├── 2. Query qBittorrent Piece States (/api/v2/torrents/pieceStates)
   │      [Piece 412: Have ✓] [Piece 413: Have ✓] [Piece 414: Missing ✗]
   │
   ├── 3. Dynamic On-Demand Prioritization
   │      Set Priority 7 (Maximal) on [Piece 412 ... 418] (Requested + Lookahead Buffer)
   │
   ├── 4. Asynchronous Readiness Polling (250ms interval)
   │      Wait until target piece is verified on disk
   │
   └── 5. Stream from Disk
          fs.createReadStream(filePath, { start, end }) ──> HTTP 206 Partial Content
```

### Seeking Support
When a user scrubs from `00:03:00` to `01:25:00`, the browser requests a new byte offset far ahead of current sequential progress. The bridge instantly intercepts the range, maps the new offset to the corresponding piece indices, deprioritizes stale pieces, and elevates the new target pieces to Priority 7.

---

## 4. Container & Codec Compatibility

Web browsers decode media formats through hardware/software decoders:

| Container | Video Codec | Audio Codec | Browser Playback Status | Strategy |
|---|---|---|---|---|
| **MP4** | H.264 (AVC) | AAC | 🟢 **100% Native (Universal)** | Direct HTTP 206 Range Stream |
| **WebM** | VP8 / VP9 / AV1 | Opus / Vorbis | 🟢 **100% Native (Chrome/Edge/Firefox)** | Direct HTTP 206 Range Stream |
| **MP4** | HEVC (H.265) | AAC / AC3 | 🟡 **Hardware Dependent (Safari, Edge, Chrome HEVC)** | Direct Stream with fallback notification |
| **MKV** | H.264 / HEVC | DTS / TrueHD | 🔴 **Unsupported natively by HTML5 `<video>`** | Remux to fMP4 container or prioritize MP4 releases |

*UI Guideline:* The sources drawer prioritizes releases with MP4 / H.264 / WebM badges for maximum plug-and-play browser compatibility.

---

## 5. Playback Session Architecture & Lifecycle

Browsers generate dozens of short-lived HTTP connections during single-stream playback (range chunking, pre-fetching, paused sockets). Relying solely on `req.on('close')` creates false disconnects. CineStream Pro separates **TCP connection state** from **Playback Session State**:

```
                  ┌─────────────────────────────────────────────────────────┐
                  │              ACTIVE (Viewer Watching)                   │
                  │  Player sends POST /api/stream/session/heartbeat (10s)  │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               │ No Heartbeat for 45s
                                               │ (Tab Closed or Modal Exited)
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │              IDLE (Bandwidth Saver)                     │
                  │  Torrent download is paused in qBittorrent              │
                  │  Saves VPS network bandwidth while keeping disk cache   │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               │ Idle TTL > 15 Minutes
                                               │ (OR Disk Usage > 88%)
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │              CANDIDATE_FOR_DELETE (Auto-GC)             │
                  │  Pre-Deletion Verification:                             │
                  │  1. Check refCount == 0 (No open file descriptors)      │
                  │  2. Re-verify activeSessions == 0                       │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               │ Safe to Purge
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │              DELETED & UNLINKED                         │
                  │  qbt.deleteTorrent(hash, deleteFiles: true)             │
                  │  Disk space fully reclaimed                             │
                  └─────────────────────────────────────────────────────────┘
```

---

## 6. Multi-Tier VPS Disk Protection & Quota System

To prevent disk starvation on production VPS hosts shared with other services:

| Threshold | Trigger Condition | System Action |
|---|---|---|
| **Normal Operation** | Disk Usage < 80% | Standard sequential streaming, 15-minute idle Auto-GC. |
| **Soft Cap** | Disk Usage ≥ 85% | Rejects new incoming torrent stream additions (`507 Insufficient Storage`). Existing active streams continue uninterrupted. |
| **Aggressive GC** | Disk Usage ≥ 88% | Auto-GC immediately purges all idle torrents regardless of the 15-minute timer. |
| **Emergency Halt** | Disk Usage ≥ 95% | Automatically pauses all background downloading daemons to protect host database and OS services. |

---

## 7. File Structure & Codebase Map

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
│   │   ├── playerModal.js  # HTML5 theater player with swarm HUD, session heartbeats & sources
│   │   ├── rateReviewModal.js # Letterboxd-style 5-star rating & review editor
│   │   ├── listModal.js    # Add-to-list & custom list creation modal
│   │   └── toast.js        # Global toast notification dispatch system
│   ├── services/
│   │   ├── streamingBridge.js # Prowlarr indexer search client, heartbeat sender & stream URL builder
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
│   ├── index.js            # Express Piece-Aware Bridge, qBittorrent & Prowlarr controllers
│   ├── package.json        # Server dependencies (express, cors, dotenv)
│   └── setup-ubuntu.sh     # Automated VPS installer & PM2 daemon config
├── index.html              # Single Page Application HTML entry
├── package.json            # Frontend dev server script (`npm run dev`)
└── project.md              # Technical architecture & specification document
```

---

## 8. Setup & Deployment Guide

### Local Development (Frontend)
```bash
# 1. Clone repository
git clone https://github.com/Deucalio/cinemate.git
cd cinemate

# 2. Install dependencies & start local dev server
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

# 5. Restart PM2 background daemon
sudo pm2 restart cinestream-bridge

# 6. Verify health
curl http://localhost:8888/health
```

Health endpoint response:
```json
{
  "status": "online",
  "service": "CineStream Torrent Bridge (Piece-Aware & Session Managed)",
  "qBittorrentConnected": true,
  "activeTorrentsCount": 1,
  "activePlaybackSessions": 1,
  "diskUsagePercent": "22%",
  "limits": {
    "maxActiveTorrents": 5,
    "maxConcurrentStreams": 15,
    "maxDiskUsagePercent": "85%",
    "idleCleanupMinutes": 15
  },
  "uptime": 128.5
}
```
