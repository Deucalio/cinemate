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
      │  v3 / Discover  │        │  State & Diary  │          │   Rate Limit + Piece Map │
      └─────────────────┘        └─────────────────┘          └────────────┬─────────────┘
                                                                           │
                                      ┌────────────────────────────────────┴──────────────────────────┐
                                      │                                                               │
                                      ▼                                                               ▼
                         ┌─────────────────────────┐                                     ┌─────────────────────────┐
                         │     Prowlarr :9696      │                                     │   qBittorrent :18080    │
                         │ Torznab Community Feeds │                                     │  Sequential C++ Engine  │
                         │ (Loopback Protected)    │                                     │ (Loopback Protected)    │
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

## 4. Defensive Security & Torrent Sanitization

CineStream adheres to strict defensive security practices when processing third-party torrent swarms:

```
Torrent Contents (Untrusted Swarm Data)
   │
   ├── 1. Enumerate all file entries
   │
   ├── 2. Path Traversal Guard
   │      Canonical check: path.resolve(filePath).startsWith(baseDownloadDir)
   │      Reject any ../ or out-of-boundary references
   │
   ├── 3. Forbidden Extension Blacklist
   │      Block .exe, .bat, .cmd, .scr, .vbs, .sh, .iso, .msi
   │
   ├── 4. Media Whitelist & Minimum Size Threshold
   │      Allow only .mp4, .webm, .mkv, .m4v (Size >= 5 MB)
   │      Filter out sample clips, trailers, and text/nfo junk
   │
   └── 5. Safe Candidate Selected for Streaming
```

### Zero-Trust Internal Service Isolation
- **Strict Loopback Binding:** qBittorrent (`127.0.0.1:18080`) and Prowlarr (`127.0.0.1:9696`) are bound exclusively to the VPS loopback interface.
- **Zero Credential Leakage:** Prowlarr API keys and qBittorrent admin passwords are stored in server-side `.env` files and never sent to or accessible by client browsers.

### API Rate Limiting & Admin Authorization
- **Search Rate Limiting:** Enforces a maximum of 30 search requests per minute per IP.
- **Stream Rate Limiting:** Enforces a maximum of 10 new stream initializations per minute per IP to prevent swarm flooding.
- **Admin Maintenance Token:** The `/api/cleanup` maintenance endpoint requires a valid `X-Admin-Token` header, preventing unauthorized callers from purging cached content.

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

## 6. Host Impact, Resource Bottlenecks & Telemetry

While the Node.js Express process uses minimal CPU for I/O piping, multi-stream torrent acquisition creates real load on **Disk I/O** and **Network Bandwidth**:

```
RESOURCE BOTTLENECK PROFILE (5 Concurrent Torrents)

CPU Load      ██░░░░░░░░  (Low-Moderate, mostly libtorrent encryption/hashing)
System RAM    ███░░░░░░░  (Controlled by PM2 & qBittorrent cache limits)
Disk I/O      ████████░░  (High during simultaneous writes & HTTP reads)
Network RX/TX ██████████  (High bandwidth consumption during active grabs)
```

### Live Host Telemetry in `/health`:
The `/health` endpoint exposes real-time host metrics:
```json
{
  "status": "online",
  "service": "CineStream Torrent Bridge (Protected & Piece-Aware)",
  "hostTelemetry": {
    "loadAverage": [0.42, 0.38, 0.35],
    "ramTotalMb": 7964,
    "ramFreeMb": 5120,
    "diskUsagePercent": "22%",
    "diskFreeGb": "314.5 GB",
    "dlSpeed": "10.05 MB/s",
    "upSpeed": "0.45 MB/s"
  },
  "limits": {
    "maxActiveTorrents": 5,
    "maxConcurrentStreams": 15,
    "maxDiskUsagePercent": "85%",
    "idleCleanupMinutes": 15
  }
}
```

### Multi-Tier VPS Disk Protection
| Threshold | Trigger Condition | System Action |
|---|---|---|
| **Normal Operation** | Disk Usage < 80% | Standard sequential streaming, 15-minute idle Auto-GC. |
| **Soft Cap** | Disk Usage ≥ 85% | Rejects new incoming torrent stream additions (`507 Insufficient Storage`). Existing active streams continue uninterrupted. |
| **Aggressive GC** | Disk Usage ≥ 88% | Auto-GC immediately purges all idle torrents regardless of the 15-minute timer. |
| **Emergency Halt** | Disk Usage ≥ 95% | Automatically pauses all background downloading daemons to protect host database and OS services. |

---

## 7. Container Compatibility & Future Transcoding Roadmap

### Phase 1: Native In-Browser Playback (Current)
HTML5 `<video>` decodes standard web-friendly containers:
- **MP4 (H.264 + AAC):** 🟢 100% Universal native support across all browsers.
- **WebM (VP8/VP9 + Opus):** 🟢 Native in Chrome, Edge, and Firefox.
- **MP4 (HEVC / H.265):** 🟡 Native on Safari & modern Chrome/Edge with hardware acceleration.

### Phase 2: Transcoding Escape Hatch (Future Roadmap)
For unsupported formats (e.g. MKV with DTS audio or 10-bit HEVC on legacy browsers), a future phase will introduce an asynchronous FFmpeg worker pipeline:

```
Torrent Media Source
        │
        ▼
ffprobe inspection
        │
        ├── Is Browser Compatible? (MP4 / H.264 / AAC)
        │         │
        │        YES ──> Direct HTTP 206 Stream (Phase 1)
        │
        └── NO (MKV / DTS / TrueHD / HEVC)
                  │
                  ▼
              FFmpeg Worker
                  │
                  ▼
          HLS / CMAF Packaging ──> Hls.js Adaptive Player
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
```bash
# 1. Connect to VPS
ssh rdpuser@<VPS_IP>

# 2. Navigate to project root & pull latest code
cd /opt/cinemate
sudo git pull

# 3. Restart PM2 background daemon
sudo pm2 restart cinestream-bridge

# 4. Verify health & security telemetry
curl http://localhost:8888/health
```
