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
      │    TMDB API     │        │              VPS BACKEND BRIDGE (:8888)               │
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
| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register a new user (`username`, `email`, `password`) | No |
| `POST` | `/api/auth/login` | Login with username/email & password, returns JWT | No |
| `GET` | `/api/auth/me` | Fetch authenticated user profile & count metrics | Yes (`Bearer <JWT>`) |

### 📊 User Data & Sync (`/api/user`)
| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/user/progress` | Fetch user's cross-device watch history & resume timestamps | Yes |
| `POST` | `/api/user/progress` | Upsert playback timestamp, duration, and completion status | Yes |
| `GET` | `/api/user/reviews` | Fetch personal watch diary & Letterboxd-style ratings | Yes |
| `POST` | `/api/user/reviews` | Add or update star rating, watch date, and review text | Yes |
| `GET` | `/api/user/lists` | Fetch custom curated watchlists with included items | Yes |
| `POST` | `/api/user/lists` | Create a new named custom collection (public or private) | Yes |
| `POST` | `/api/user/lists/:id/items` | Add title to a specific user collection | Yes |

### 📡 Streaming, Telemetry & Maintenance
| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/stream` | Piece-aware HTTP 206 Partial Content video streaming | Optional / Session |
| `POST` | `/api/stream/session/heartbeat` | 10-second player heartbeat to maintain `ACTIVE` state | No |
| `GET` | `/api/search` | Rate-limited (30/min) Prowlarr Torznab proxy search | No |
| `GET` | `/api/status` | List active downloads, speeds, and state from qBittorrent | No |
| `POST` | `/api/cleanup` | Trigger manual disk garbage collection | Yes (`X-Admin-Token`) |
| `GET` | `/health` | System health, RAM, Load Avg, Disk Usage & Bandwidth | No |

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

## 7. Multi-Tier VPS Disk Protection & Quota System

To prevent disk starvation on production VPS hosts shared with other services:

| Threshold | Trigger Condition | System Action |
|---|---|---|
| **Normal Operation** | Disk Usage < 80% | Standard sequential streaming, 15-minute idle Auto-GC. |
| **Soft Cap** | Disk Usage ≥ 85% | Rejects new incoming torrent stream additions (`507 Insufficient Storage`). Existing active streams continue uninterrupted. |
| **Aggressive GC** | Disk Usage ≥ 88% | Auto-GC immediately purges all idle torrents regardless of the 15-minute timer. |
| **Emergency Halt** | Disk Usage ≥ 95% | Automatically pauses all background downloading daemons to protect host database and OS services. |

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
curl http://localhost:8888/health
```

Health endpoint response:
```json
{
  "status": "online",
  "service": "CineStream Torrent Bridge (Protected & Piece-Aware)",
  "security": {
    "rateLimitingActive": true,
    "pathTraversalGuards": true,
    "adminAuthEnabled": true
  },
  "qBittorrentConnected": true,
  "activeTorrentsCount": 1,
  "activePlaybackSessions": 1,
  "hostTelemetry": {
    "loadAverage": [0.35, 0.40, 0.38],
    "ramTotalMb": 7964,
    "ramFreeMb": 4890,
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
  },
  "uptime": 240.5
}
```
