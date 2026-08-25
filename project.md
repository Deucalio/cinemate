# CineStream Pro (CineMate) — Production Technical Architecture & Specification

> **Next-Generation Cinema Discovery & Piece-Aware Distributed Media Streaming Engine**
> Built with vanilla JavaScript, modern CSS design tokens, TMDB metadata, Prowlarr Torznab indexer aggregation, native qBittorrent HTTP 206 piece-aware streaming, and a PostgreSQL database powered by Prisma ORM.

---

## 1. Executive Architecture Overview

CineStream Pro bridges a cinematic web client with an on-demand, piece-aware BitTorrent streaming daemon and a persistent PostgreSQL database. Rather than waiting for full multi-gigabyte media downloads, the bridge maps HTTP byte-range requests directly to BitTorrent piece indices, dynamically prioritizes required chunks from the swarm, verifies piece readiness on disk, and pipes continuous media streams to the browser while synchronizing user accounts, watch progress, and social reviews.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                CLIENT BROWSER (PORT 3000)                              │
│                                                                                        │
│   ┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────────────────┐   │
│   │   Discover / Home   │    │  User Auth & Modals │    │  Cinema Theater Player   │   │
│   │   Trending, Genres  │    │  Diary & Reviews    │    │  Timeline, Buffering HUD │   │
│   └──────────┬──────────┘    └──────────┬──────────┘    └────────────┬─────────────┘   │
└──────────────┼──────────────────────────┼────────────────────────────┼─────────────────┘
               │                          │                            │
               ▼                          ▼                            ▼
      ┌─────────────────┐        ┌───────────────────────────────────────────────────────┐
      │    TMDB API     │        │              VPS BACKEND BRIDGE (:8899)               │
      │  v3 / Discover  │        │       Express + Prisma ORM + Piece-Aware Engine       │
      └─────────────────┘        └────────────┬─────────────────────────────┬────────────┘
                                              │                             │
                               ┌──────────────┴──────────────┐              │
                               ▼                             ▼              ▼
                  ┌─────────────────────────┐   ┌────────────────────────┐  │
                  │     PostgreSQL :5432    │   │     Prowlarr :9696     │  │
                  │   Prisma Managed DB     │   │ Torznab Community Feeds│  │
                  │  Users, Progress, Lists │   │ (Loopback Protected)   │  │
                  └─────────────────────────┘   └────────────────────────┘  │
                                                                            │
                                                                            ▼
                                                               ┌─────────────────────────┐
                                                               │   qBittorrent :18080    │
                                                               │  Sequential C++ Engine  │
                                                               └────────────┬────────────┘
                                                                            │ (Piece Verification)
                                                                            ▼
                                                               ┌─────────────────────────┐
                                                               │  HTTP 206 Piece Stream  │
                                                               │  Heartbeat Auto-GC      │
                                                               └─────────────────────────┘
```

---

## 2. Database Schema & User Account Architecture (Prisma + PostgreSQL)

The system utilizes PostgreSQL via **Prisma ORM** for persistent data, enforcing relational integrity, foreign key cascading, and type-safe transactions.

### Database Models ([server/prisma/schema.prisma](file:///d:/vscode/netflix/server/prisma/schema.prisma))

```prisma
model User {
  id           String            @id @default(uuid())
  username     String            @unique
  email        String            @unique
  passwordHash String            @map("password_hash")
  avatarUrl    String?           @map("avatar_url")
  role         String            @default("user")
  createdAt    DateTime          @default(now()) @map("created_at")
  updatedAt    DateTime          @updatedAt @map("updated_at")

  watchProgress WatchProgress[]
  reviews       Review[]
  userLists     UserList[]
  sessions      PlaybackSession[]

  @@map("users")
}

model WatchProgress {
  id          String   @id @default(uuid())
  userId      String   @map("user_id")
  mediaId     String   @map("media_id") // e.g. "movie_123" or "tv_456_s01e02"
  mediaType   String   @default("movie") @map("media_type")
  title       String
  posterPath  String?  @map("poster_path")
  season      Int?
  episode     Int?
  currentTime Float    @map("current_time") // Seconds
  duration    Float    // Total seconds
  isCompleted Boolean  @default(false) @map("is_completed")
  updatedAt   DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, mediaId])
  @@index([userId])
  @@map("watch_progress")
}

model Review {
  id           String    @id @default(uuid())
  userId       String    @map("user_id")
  mediaId      String    @map("media_id")
  mediaType    String    @default("movie") @map("media_type")
  title        String
  posterPath   String?   @map("poster_path")
  rating       Float     // 0.5 to 5.0 scale
  reviewText   String?   @map("review_text") @db.Text
  watchedDate  DateTime? @map("watched_date")
  rewatchCount Int       @default(0) @map("rewatch_count")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, mediaId])
  @@index([userId])
  @@map("reviews")
}

model UserList {
  id          String     @id @default(uuid())
  userId      String     @map("user_id")
  name        String
  description String?    @db.Text
  isPrivate   Boolean    @default(false) @map("is_private")
  createdAt   DateTime   @default(now()) @map("created_at")
  updatedAt   DateTime   @updatedAt @map("updated_at")

  user  User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  items ListItem[]

  @@index([userId])
  @@map("user_lists")
}

model ListItem {
  id         String   @id @default(uuid())
  listId     String   @map("list_id")
  mediaId    String   @map("media_id")
  mediaType  String   @default("movie") @map("media_type")
  title      String
  posterPath String?  @map("poster_path")
  addedAt    DateTime @default(now()) @map("added_at")

  list UserList @relation(fields: [listId], references: [id], onDelete: Cascade)

  @@unique([listId, mediaId])
  @@index([listId])
  @@map("list_items")
}

model PlaybackSession {
  id            String   @id @default(uuid())
  userId        String?  @map("user_id")
  sessionId     String   @unique @map("session_id")
  torrentHash   String   @map("torrent_hash")
  torrentName   String?  @map("torrent_name")
  clientIp      String?  @map("client_ip")
  lastHeartbeat DateTime @default(now()) @map("last_heartbeat")
  createdAt     DateTime @default(now()) @map("created_at")

  user User? @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([torrentHash])
  @@index([sessionId])
  @@map("playback_sessions")
}
```

---

## 3. Complete REST API Specifications

### 🔐 Authentication (`/api/auth`)

| Method   | Endpoint               | Description                                                 | Auth Required          |
| -------- | ---------------------- | ----------------------------------------------------------- | ---------------------- |
| `POST` | `/api/auth/register` | Register a new user (`username`, `email`, `password`) | No                     |
| `POST` | `/api/auth/login`    | Login with username/email & password, returns JWT           | No                     |
| `GET`  | `/api/auth/me`       | Fetch authenticated user profile & count metrics            | Yes (`Bearer <JWT>`) |

### 📊 User Data & Sync (`/api/user`)

| Method   | Endpoint                      | Description                                                 | Auth Required |
| -------- | ----------------------------- | ----------------------------------------------------------- | ------------- |
| `GET`  | `/api/user/progress`        | Fetch user's cross-device watch history & resume timestamps | Yes           |
| `POST` | `/api/user/progress`        | Upsert playback timestamp, duration, and completion status  | Yes           |
| `GET`  | `/api/user/reviews`         | Fetch personal watch diary & Letterboxd-style ratings       | Yes           |
| `POST` | `/api/user/reviews`         | Add or update star rating, watch date, and review text      | Yes           |
| `GET`  | `/api/user/lists`           | Fetch custom curated watchlists with included items         | Yes           |
| `POST` | `/api/user/lists`           | Create a new named custom collection (public or private)    | Yes           |
| `POST` | `/api/user/lists/:id/items` | Add title to a specific user collection                     | Yes           |

### 📡 Streaming, Telemetry & Maintenance

| Method   | Endpoint                          | Description                                               | Auth Required           |
| -------- | --------------------------------- | --------------------------------------------------------- | ----------------------- |
| `GET`  | `/api/stream`                   | Piece-aware HTTP 206 Partial Content video streaming      | Optional / Session      |
| `POST` | `/api/stream/session/heartbeat` | 10-second player heartbeat to maintain`ACTIVE` state    | No                      |
| `GET`  | `/api/search`                   | Rate-limited (30/min) Prowlarr Torznab proxy search       | No                      |
| `GET`  | `/api/status`                   | List active downloads, speeds, and state from qBittorrent | No                      |
| `POST` | `/api/cleanup`                  | Trigger manual disk garbage collection                    | Yes (`X-Admin-Token`) |
| `GET`  | `/health`                       | System health, RAM, Load Avg, Disk Usage & Bandwidth      | No                      |

---

## 4. The Piece-Aware Streaming Engine

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
   ├── 3. File-Level Prioritization
   │      Target file -> Priority 7, all other files (samples/subs/extras) -> Priority 0
   │      NOTE: qBittorrent's WebUI API v2 exposes no piece-level priority setter. Read-ahead is
   │      driven by sequentialDownload + firstLastPiecePrio + filePrio. The bridge probes for a
   │      piecePriority endpoint once at runtime and logs whether this build supports it.
   │
   ├── 4. Asynchronous Readiness Polling (250ms interval)
   │      Wait until target piece is verified on disk
   │
   └── 5. Stream from Disk
          fs.createReadStream(filePath, { start, end }) ──> HTTP 206 Partial Content
```

### Byte Offset → Global Piece Index

A piece index is relative to the **whole torrent**, not to one file. Most releases ship the movie
alongside subtitles, samples and NFOs, so the video does not begin at piece 0:

```
globalPiece = floor((fileOffsetInTorrent + byteOffsetInFile) / pieceSize)
```

`fileOffsetInTorrent` comes from `/api/v2/torrents/files`, by summing the sizes of preceding files
and cross-checking the result against qBittorrent's own `piece_range`. If the two disagree (libtorrent
can hide padding files from the listing) the bridge rounds the offset **up** to the next piece
boundary — waiting for one extra piece is safe; reading one piece too early serves sparse zero-bytes.

### Seeking Support

- **Direct mode** — the browser seeks natively with a normal `Range` request, and the bridge maps
  the new offset onto piece indices and waits for verification.
- **Remux mode** — progressive fMP4 carries no index, so seeking outside the buffered window
  restarts FFmpeg at the new timestamp via `-ss` (`&startSec=`). Seeks *into* buffered territory
  are served from the element's own buffer without restarting anything.

---

## 5. Defensive Security & Torrent Sanitization

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

---

## 6. Playback Session Architecture & Lifecycle

Browsers generate dozens of short-lived HTTP connections during single-stream playback. CineStream Pro separates **TCP connection state** from **Playback Session State**:

```
                  ┌─────────────────────────────────────────────────────────┐
                  │              ACTIVE (Viewer Watching)                   │
                  │  Player sends POST /api/stream/session/heartbeat (10s)  │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               │ No open connection AND no heartbeat
                                               │ for STREAM_IDLE_GRACE_MS (default 45s)
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

## 7. Multi-Tier VPS Disk Protection & Quota System

To prevent disk starvation on production VPS hosts shared with other services:

| Threshold                  | Trigger Condition | System Action                                                                                                                 |
| -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Normal Operation** | Disk Usage < 80%  | Standard sequential streaming, 15-minute idle Auto-GC.                                                                        |
| **Soft Cap**         | Disk Usage ≥ 85% | Rejects new incoming torrent stream additions (`507 Insufficient Storage`). Existing active streams continue uninterrupted. |
| **Aggressive GC**    | Disk Usage ≥ 88% | Auto-GC immediately purges all idle torrents regardless of the 15-minute timer.                                               |
| **Emergency Halt**   | Disk Usage ≥ 95% | Automatically pauses all background downloading daemons to protect host database and OS services.                             |

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

### VPS Production Setup (Ubuntu 22.04 LTS + PostgreSQL)

```bash
# 1. Connect to VPS
ssh rdpuser@<VPS_IP>

# 2. Navigate to project root & pull latest code
cd /opt/cinemate
sudo git pull
sudo chown -R $USER:$USER /opt/cinemate

# 3. Install backend dependencies & sync Prisma database
cd /opt/cinemate/server
npm install
npx prisma db push

# 4. Restart PM2 background daemon
sudo pm2 restart cinestream-bridge

# 5. Verify health & telemetry
curl http://localhost:8899/health
```

Health endpoint response:

```json
{
  "status": "online",
  "service": "CineStream Piece-Aware Progressive Torrent & FFmpeg AAC Streaming Bridge",
  "security": {
    "rateLimitingActive": true,
    "pathTraversalGuards": true,
    "adminAuthEnabled": true,
    "internalEndpointLoopbackOnly": true
  },
  "qBittorrentConnected": true,
  "activeTorrentsCount": 1,
  "activePlaybackSessions": 1,
  "toolchain": {
    "ffmpeg": true,
    "ffprobe": true,
    "videoTranscodeEnabled": false
  },
  "hostTelemetry": {
    "loadAverage": [0.35, 0.40, 0.38],
    "ramTotalMb": 7964,
    "ramFreeMb": 4890,
    "diskUsagePercent": "22%",
    "diskFreeGb": "314.5 GB"
  },
  "limits": {
    "maxActiveTorrents": 5,
    "maxConcurrentStreams": 15,
    "maxDiskUsagePercent": "85%",
    "idleCleanupMinutes": 15
  },
  "uptime": 240.5
}
```

> **FFmpeg is required.** `sudo apt install -y ffmpeg` installs both `ffmpeg` and `ffprobe`. The
> bridge checks for them at boot, logs the result, and reports it under `toolchain` in `/health`.
> Without them only already-browser-native releases (MP4 + H.264 + AAC stereo) can play.

### Environment Variables

| Variable                                  | Default                                               | Purpose                                                     |
| ----------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| `PORT`                                  | `8899`                                              | Bridge listen port                                          |
| `QBT_URL` / `QBT_USER` / `QBT_PASS` | `http://127.0.0.1:18080`, `admin`, `adminadmin` | qBittorrent WebUI                                           |
| `PROWLARR_URL` / `PROWLARR_KEY`       | `http://127.0.0.1:9696`                             | Torznab search proxy                                        |
| `ALLOW_VIDEO_TRANSCODE`                 | `0`                                                 | Enable real-time HEVC→H.264 re-encoding (CPU-heavy)        |
| `STREAM_IDLE_GRACE_MS`                  | `45000`                                             | Quiet period before an unwatched torrent is paused          |
| `HEARTBEAT_FRESH_MS`                    | `45000`                                             | How long a heartbeat marks a session as active              |
| `IDLE_TTL_MINUTES`                      | `1`                                                 | Idle time before Auto-GC deletes a torrent and its files    |
| `PIECE_STATE_CACHE_MS`                  | `500`                                               | `pieceStates` cache TTL                                   |
| `PIECE_WAIT_TIMEOUT_MS`                 | `120000`                                            | How long a read waits for a piece before failing the stream |
| `STREAM_RATE_LIMIT_PER_MIN`             | `600`                                               | Per-IP`/api/stream` request cap                           |
| `FFMPEG_BIN` / `FFPROBE_BIN`          | `ffmpeg` / `ffprobe`                              | Binary paths                                                |

### Running the Test Suite

```bash
cd server
npm install
npm test
```

Both suites run the real bridge against a mock qBittorrent, so they need no swarm, no ffmpeg and
no database:

- `test/piece-aware-stream.test.mjs` — piece gating on a **multi-file** torrent (the movie starts
  at piece 2, not 0), byte-exact delivery, `pieceStates` cache pressure, `filePrio` focus, and
  RFC 7233 range parsing (suffix / open-ended / unsatisfiable / HEAD).
- `test/session-lifecycle.test.mjs` — `/api/stream/prepare` output, and the pause lifecycle:
  never on a single connection close, never while heartbeats are fresh, always once genuinely idle.

---

## 9. Fix Log — Progressive Streaming & Audio Playback

The "stuck on *Buffering Stream...*" failure was not one bug but a chain of them. All of the
following are now fixed in [server/index.js](file:///d:/vscode/netflix/server/index.js),
[js/components/playerModal.js](file:///d:/vscode/netflix/js/components/playerModal.js) and
[js/services/streamingBridge.js](file:///d:/vscode/netflix/js/services/streamingBridge.js).

### 9.1 Why nothing ever played

| #  | Root cause                                                                                                                                                                                                                                                       | Fix                                                                                                                         |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1  | **The default path was not piece-aware at all.** `/api/stream` served ranges with a plain `fs.createReadStream`; the piece-aware reader ran only under `?remux=1`. Sparse regions of an in-progress file read as zero-bytes, so the demuxer stalled. | All delivery paths now go through`servePieceAwareRange()`.                                                                |
| 2  | **Piece indices ignored the file's offset within the torrent.** `floor(byteOffset / pieceSize)` verified piece 0 while the movie actually began at piece 2, so "verified" bytes were still sparse zeros.                                                 | `resolveTorrentFileMapping()` computes the global offset from `/torrents/files`, cross-checked against `piece_range`. |
| 3  | **FFmpeg read from a non-seekable pipe.** A standard `.mp4` keeps its `moov` index at the *end*, so `ffmpeg -i pipe:0` had to read the entire file before emitting a frame.                                                                        | FFmpeg now reads a**seekable loopback HTTP URL** (`/internal/piece-file`) and jumps straight to `moov`.           |
| 4  | **The reader could deadlock.** `_read()` returned without pushing when a chunk computed to zero bytes or a check was in flight; Node then never called `_read()` again.                                                                                | Rewritten as a single async pump that always pushes, ends, or errors.                                                       |
| 5  | **The torrent was paused on every connection close.** A browser opens and abandons dozens of connections per video, so the download was halted constantly while the user watched.                                                                          | Closing arms a grace timer; pausing needs no connection*and* no fresh heartbeat.                                          |
| 6  | **The stream rate limit was 25/min.** Ordinary playback exceeded it within seconds and got `429`d.                                                                                                                                                       | Raised to 600/min (`STREAM_RATE_LIMIT_PER_MIN`).                                                                          |
| 7  | **Heartbeats stopped whenever the player was paused**, so Auto-GC deleted the torrent mid-session.                                                                                                                                                         | Heartbeats now run for as long as the player is open.                                                                       |
| 8  | **Auto-GC could delete a torrent during setup**, while the bridge was still waiting up to ~25s for swarm metadata.                                                                                                                                         | Reservations cover the whole setup window.                                                                                  |
| 9  | **`refCount` was decremented twice per remux connection** (`req.close` *and* `res.finish`), tearing down torrents still in use.                                                                                                                    | Single guarded`cleanup()`.                                                                                                |
| 10 | **`Content-Length` came from `stat().size`** — wrong on a sparse file, which hands the browser a truncated video.                                                                                                                                     | Uses the torrent-declared file size.                                                                                        |
| 11 | **Range parsing was a naive split on `-`**, mishandling `bytes=-500` and `bytes=500-`, and never returning `416`.                                                                                                                                  | RFC 7233 parser with proper`416` + `Content-Range: bytes */size`.                                                       |
| 12 | **`pieceStates` was fetched per 128 KB chunk** — tens of thousands of ints per read, saturating the qBittorrent WebUI.                                                                                                                                  | Cached (`PIECE_STATE_CACHE_MS`) with in-flight de-duplication.                                                            |
| 13 | **The client's error handler fought its own fallback**, blind-reloading the element every 3.5s and reloading the *failed* direct URL over the remux attempt.                                                                                             | One state-aware handler that escalates direct → remux exactly once, then reports.                                          |
| 14 | **The player auto-played a Google sample clip** (`TearsOfSteel.mp4`), so a completely broken bridge still looked like working playback.                                                                                                                  | Removed; the player prompts for a source instead.                                                                           |
| 15 | **A `<video>` element only reports opaque `MEDIA_ERR_*` codes**, so "no seeders", "unsupported codec" and "disk full" were indistinguishable.                                                                                                          | New`GET /api/stream/prepare` returns the delivery plan or a typed error before `<video>` sees a URL.                    |
| 16 | **`enrichMagnetWithTrackers()` was never called** — the tracker-injection feature was dead code, leaving bare magnets to stall on DHT bootstrap.                                                                                                        | Wired into`addTorrent()`.                                                                                                 |
| 17 | **`server/node_modules` was stale** — `bcryptjs`, `jsonwebtoken` and `@prisma/client` were declared but absent, so a fresh checkout died on startup with `ERR_MODULE_NOT_FOUND`. An existing deployment with them already installed was unaffected. | `npm install`; `webtorrent` (unused since the qBittorrent migration) dropped. |
| 18 | **Audio detection was inverted:** `isAAC = ...                                                                                                                                                                                                             |                                                                                                                             |
| 19 | **qBittorrent 5.x renamed `pause`/`resume` to `stop`/`start`**, so bandwidth control silently no-opped on 5.x hosts.                                                                                                                               | Tries the modern name, falls back to the legacy one.                                                                        |
| 20 | **`health.activeTorrents` did not exist** (the field is `activeTorrentsCount`), so the UI always showed `undefined`.                                                                                                                                 | Fixed, plus the volume-slider selector typo`#ctrl-vol-slider`.                                                            |

### 9.2 How delivery mode is chosen

`ffprobe` runs once per file, over the loopback piece-aware URL so it can seek to `moov`:

```
container ∈ {mp4, m4v, webm}  AND  video ∈ {h264, vp8, vp9, av1}
                             AND  audio ∈ {aac, mp3, opus, vorbis}  AND  channels ≤ 2
   ├── yes ──> DIRECT : HTTP 206 byte ranges, native seeking, zero CPU
   └── no  ──> REMUX  : FFmpeg -> progressive fMP4, video copied, audio -> stereo AAC 192k
```

Override per request with `?mode=direct|remux`. The legacy `?remux=1` flag still works.

### 9.3 Known limitations

- **HEVC / x265 releases cannot play in a browser.** Real-time HEVC→H.264 transcoding does not keep
  up on a small VPS, so it is **off by default**; `/api/stream/prepare` returns `415`
  `UNSUPPORTED_VIDEO_CODEC` and the UI flags those releases. Set `ALLOW_VIDEO_TRANSCODE=1` to
  enable it anyway.
- **Seeking in remux mode restarts the FFmpeg process**, costing a few seconds. Direct mode seeks
  natively. An HLS pipeline (segmented VOD playlist) would give indexed seeking over remuxed
  content — the frontend's `hls.js` dependency was removed since nothing used it, so re-add it if
  that route is taken.
- **Seeking far ahead of the download head still waits for the swarm.** qBittorrent's WebUI API has
  no piece-priority setter, so the bridge cannot make the download head jump to an arbitrary
  offset; it can only wait for sequential progress to reach it.
- **Piece waits fail loudly after `PIECE_WAIT_TIMEOUT_MS`** (default 120s) rather than ending the
  stream silently, since a silent EOF is indistinguishable from the original hang.
