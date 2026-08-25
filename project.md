# CineStream Pro (CineMate) — Technical Architecture & Specification

> **Cinema Discovery + Cache-First BitTorrent Streaming**
> Vite-bundled vanilla JavaScript client, TMDB metadata, Prowlarr Torznab indexer aggregation, a
> dedicated qBittorrent instance driven over its WebUI API, FFmpeg remuxing, and PostgreSQL via
> Prisma ORM.

**Companion documents**

| Document | Purpose |
|---|---|
| [docs/cache-first-streaming-plan.md](docs/cache-first-streaming-plan.md) | The architecture change from piece-aware to cache-first, phase by phase, with outcomes |
| [docs/phase5-hls-plan.md](docs/phase5-hls-plan.md) | Next up — progressive HLS transcode |
| [docs/dedicated-qbittorrent.md](docs/dedicated-qbittorrent.md) | Runbook for the bridge's own qBittorrent instance |
| [docs/scaling-roadmap.md](docs/scaling-roadmap.md) | What breaks at 200 concurrent viewers, and in what order |

---

## 1. Architecture Overview

The bridge downloads a release to the VPS, waits for it to complete, then serves it — either as
plain HTTP 206 byte ranges (when the browser can decode it) or through FFmpeg (when it cannot).

**This is deliberately not progressive streaming.** The swarm runs at 12–70 MB/s on this host, so a
2–3 GB release lands in about a minute. Paying that once buys a delivery path with no piece
verification, no sparse reads, and native browser seeking. The piece-aware progressive engine is
retained behind `REQUIRE_COMPLETE=0` and still feeds `ffprobe`. See
[docs/cache-first-streaming-plan.md](docs/cache-first-streaming-plan.md) for why.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       CLIENT BROWSER — Vite dev server :3000                            │
│                                                                                         │
│   ┌─────────────────────┐   ┌─────────────────────┐   ┌──────────────────────────┐      │
│   │  Discover / Home    │   │ User Auth & Modals  │   │  Cinema Theater Player   │      │
│   │  Trending, Genres   │   │ Diary & Reviews     │   │  Timeline, Progress HUD  │      │
│   └──────────┬──────────┘   └──────────┬──────────┘   └────────────┬─────────────┘      │
└──────────────┼─────────────────────────┼───────────────────────────┼────────────────────┘
               │                         │                           │
               ▼                         ▼                           ▼
      ┌─────────────────┐       ┌────────────────────────────────────────────────────────┐
      │    TMDB API     │       │              VPS BACKEND BRIDGE :8899                  │
      │  v3 / Discover  │       │   Express · Prisma ORM · Delivery-Mode Decision Engine │
      └─────────────────┘       └───────────┬──────────────────────────────┬─────────────┘
                                            │                              │
                             ┌──────────────┴───────────┐                  │
                             ▼                          ▼                  ▼
                ┌─────────────────────────┐  ┌────────────────────────┐    │
                │    PostgreSQL :5432     │  │     Prowlarr :9696     │    │
                │   Prisma Managed DB     │  │ Torznab Community Feeds│    │
                │  Users, Progress, Lists │  │  (Loopback Protected)  │    │
                └─────────────────────────┘  └────────────────────────┘    │
                                                                           ▼
                                                    ┌──────────────────────────────────┐
                                                    │  qBittorrent :18081 (DEDICATED)  │
                                                    │  own profile · own storage       │
                                                    │  category "cinemate"             │
                                                    └───────────────┬──────────────────┘
                                                                    │ download completes
                                                                    ▼
                                        ┌───────────────────────────────────────────────┐
                                        │            DELIVERY MODE DECISION             │
                                        │  ffprobe → container + codecs + channels      │
                                        ├───────────────────────┬───────────────────────┤
                                        │ DIRECT                │ REMUX                 │
                                        │ MP4/WebM + H.264 +    │ everything else       │
                                        │ AAC ≤ 2ch             │ FFmpeg → fMP4         │
                                        │ HTTP 206, native seek │ video copy, AAC audio │
                                        │ zero CPU              │ restart-on-seek       │
                                        └───────────────────────┴───────────────────────┘
```

**Why the qBittorrent instance is dedicated.** The bridge originally shared the host's
`stream-download.service` with a Sonarr/Radarr stack, whose Completed Download Handling imported
finished downloads and then deleted the torrent *and its data* — removing files the moment playback
began. Full diagnosis in §9.3.

---

## 2. Database Schema (Prisma + PostgreSQL)

Persistent data uses PostgreSQL via **Prisma ORM**, with relational integrity, foreign-key cascading
and type-safe transactions.

### Models ([server/prisma/schema.prisma](server/prisma/schema.prisma))

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

## 3. REST API

### 🔐 Authentication (`/api/auth`)

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register (`username`, `email`, `password`) | No |
| `POST` | `/api/auth/login` | Login, returns JWT | No |
| `GET` | `/api/auth/me` | Profile & count metrics | `Bearer <JWT>` |

### 📊 User Data & Sync (`/api/user`)

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/user/progress` | Cross-device watch history & resume timestamps | Yes |
| `POST` | `/api/user/progress` | Upsert playback timestamp, duration, completion | Yes |
| `GET` | `/api/user/reviews` | Watch diary & Letterboxd-style ratings | Yes |
| `POST` | `/api/user/reviews` | Add or update rating, watch date, review text | Yes |
| `GET` | `/api/user/lists` | Custom watchlists with items | Yes |
| `POST` | `/api/user/lists` | Create a named collection | Yes |
| `POST` | `/api/user/lists/:id/items` | Add a title to a collection | Yes |

### 📡 Streaming

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/stream/prepare` | **Resolve a magnet and return the delivery plan** — mode, codecs, duration, readiness — or a typed error, *before* `<video>` sees a URL | No |
| `GET` | `/api/stream/status` | Cheap download-progress poll: `progress`, `dlSpeed`, `etaSeconds`, `seeds`. One `torrents/info` call, safe every 2 s | No |
| `GET` | `/api/stream` | The stream itself. HTTP 206 byte ranges (direct) or progressive fMP4 (remux) | Optional / Session |
| `POST` | `/api/stream/session/heartbeat` | 10-second player heartbeat maintaining `ACTIVE` state | No |
| `POST` | `/api/stream/session/leave` | Explicit teardown, sent on player close and tab close (`pagehide`) | No |

`prepare` exists because a `<video>` element reports failures only as an opaque `MEDIA_ERR_*` code —
"no seeders", "unsupported codec" and "disk full" were all indistinguishable, and every one of them
presented as an endless spinner.

### 🗄️ Cache & Maintenance

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/cache` | Cached titles with `pinned` / `inUse` / `idleMinutes`, plus active thresholds. Eviction order is the reverse of the listing | No |
| `POST` | `/api/torrent/pin` | Pin or unpin a title, exempting it from idle expiry and LRU eviction. Persisted | `X-Admin-Token` |
| `POST` | `/api/cleanup` | Manual disk garbage collection | `X-Admin-Token` |
| `GET` | `/api/search` | Rate-limited Prowlarr Torznab proxy search | No |
| `GET` | `/api/status` | Raw qBittorrent torrent list | No |
| `GET` | `/health` | Health, toolchain, telemetry, limits, cache stats | No |

### 🔒 Internal

| Method | Endpoint | Description | Access |
|---|---|---|---|
| `GET` | `/internal/piece-file` | Piece-verified file bytes with full Range support, for FFmpeg / ffprobe | **Loopback only**, capability token |

This endpoint exists so FFmpeg can **seek**. A standard `.mp4` keeps its `moov` index at the end of
the file; piping into `ffmpeg -i pipe:0` is non-seekable, so it had to read the entire
multi-gigabyte file before emitting a frame. Over HTTP it issues a Range request and starts in
seconds. Against a *complete* file FFmpeg now reads the path directly and this endpoint is used only
by `ffprobe` and by the progressive path.

---

## 4. Delivery Modes

### 4.1 The decision

`ffprobe` runs once per file and the result is cached:

```
container ∈ {mp4, m4v, webm}
  AND video ∈ {h264, vp8, vp9, av1}
  AND audio ∈ {aac, mp3, opus, vorbis}
  AND channels ≤ 2
   │
   ├── yes ──> DIRECT : fs.createReadStream + HTTP 206. Native seeking, zero CPU.
   └── no  ──> REMUX  : FFmpeg → progressive fMP4. Video copied, audio → stereo AAC 192k.
```

Override per request with `?mode=direct|remux`. The legacy `?remux=1` flag still works.

While a torrent is incomplete, `prepare` returns `readyState: 'downloading'` with progress and
**exits before ffprobe runs** — probing a sparse file is what produced the
`probe unavailable → falling back on container extension` path that made every incomplete `.mkv`
guess at its own codecs.

### 4.2 Byte offset → global piece index *(progressive path only)*

A piece index is relative to the **whole torrent**, not to one file. Most releases ship the movie
alongside subtitles, samples and NFOs, so the video does not begin at piece 0:

```
globalPiece = floor((fileOffsetInTorrent + byteOffsetInFile) / pieceSize)
```

- `pieceSize` comes from **`/api/v2/torrents/properties`** — it is *not* a field of `torrents/info`.
- `fileOffsetInTorrent` comes from `/api/v2/torrents/files`, summing preceding file sizes and
  cross-checking against qBittorrent's own `piece_range`. When the two disagree (libtorrent can hide
  padding files) the offset is rounded **up** to the next piece boundary: waiting for one extra
  piece is safe, reading one piece early serves sparse zeros.

### 4.3 Read-ahead control

qBittorrent's WebUI API v2 exposes **no piece-level priority setter**. Read-ahead comes from:

- `sequentialDownload` and `firstLastPiecePrio` — set at add time, and **explicitly toggled on for
  pre-existing torrents**, since `torrents/add` is a no-op for a torrent the client already has
- `filePrio` — target file to 7, everything else to 0, but only while `progress < 1`

The consequence is that **seeking ahead of the download head cannot be made instant.** The bridge
cannot make the download head jump; it can only wait for sequential progress to reach the offset.
Under cache-first this stops mattering, since playback only begins once the file is whole.

---

## 5. Defensive Security & Torrent Sanitization

```
Torrent Contents (Untrusted Swarm Data)
   │
   ├── 1. Select from the torrent's FILE TABLE, not by scanning disk
   │      Final names and sizes are valid the moment metadata lands
   │
   ├── 2. Forbidden Extension Blacklist
   │      Block .exe, .bat, .cmd, .scr, .vbs, .ps1, .sh, .iso, .msi
   │
   ├── 3. Media Whitelist & Minimum Size Threshold
   │      Allow .mp4, .mkv, .webm, .m4v, .avi, .ts  (size ≥ 5 MB)
   │      Samples, trailers and featurettes lose to the feature
   │
   ├── 4. Path Traversal Guard
   │      The resolved path must stay inside a directory qBittorrent itself reported
   │      (save_path, download_path or content_path)
   │
   └── 5. Safe Candidate Selected for Streaming
```

Extensions are matched against the **logical** filename with any `.!qB` incomplete suffix stripped —
qBittorrent appends it while downloading, so `Movie.mp4` is `Movie.mp4.!qB` on disk and matches no
whitelist.

**Other guards:** the internal file endpoint is loopback-only with capability tokens; admin
endpoints require `X-Admin-Token`; per-IP rate limiting on search and stream; a disk soft cap
returning `507`.

> **Not yet addressed:** `/api/stream` and `/api/search` have no authentication. Anyone who can
> reach the host can use the bridge. Acceptable for single-user local use; see
> [docs/scaling-roadmap.md](docs/scaling-roadmap.md) §5 before exposing it.

---

## 6. Playback Session Lifecycle

Browsers open and abandon dozens of short-lived connections per video, so **TCP connection state**
is kept separate from **playback session state**.

```
        ┌──────────────────────────────────────────────────────────────┐
        │                   ACTIVE (Viewer Watching)                   │
        │  Player heartbeats every 10s, whether playing OR PAUSED      │
        └───────────────────────────────┬──────────────────────────────┘
                                        │  no open connection AND
                                        │  no heartbeat for
                                        │  STREAM_IDLE_GRACE_MS (45s)
                                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                   IDLE (Bandwidth Saver)                     │
        │  Torrent paused in qBittorrent, files kept on disk           │
        │  Re-checks itself while heartbeats remain fresh              │
        └───────────────────────────────┬──────────────────────────────┘
                                        │  idle > IDLE_TTL_MINUTES
                                        │  OR disk ≥ DISK_AGGRESSIVE_PCT
                                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │              EVICTION CANDIDATE (LRU by last playback)       │
        │  Skipped when: refCount > 0 · fresh heartbeat · reserved     │
        │               · pinned                                       │
        └───────────────────────────────┬──────────────────────────────┘
                                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                     DELETED & UNLINKED                       │
        │  deleteTorrent(hash, deleteFiles: true) — logged with reason │
        └──────────────────────────────────────────────────────────────┘
```

Three details that were each a bug:

- **Heartbeats run while paused.** Gating them on `!video.paused` meant a paused viewer stopped
  counting as active and Auto-GC deleted the torrent underneath them.
- **A connection close only *arms* a pause timer**, and that check **re-arms itself** while a
  heartbeat is fresh. Pausing on every close halted the download constantly mid-playback.
- **Reservations** cover the ~25 s window where a stream is resolving swarm metadata and holds no
  reference yet.

`lastActive` is persisted to `server/.cache/torrent-lru.json`, so eviction order and pins survive a
restart.

---

## 7. Disk Protection & Quota System

| Threshold | Condition | Action |
|---|---|---|
| **Normal** | usage < `DISK_TARGET_PCT` (80%) | Standard operation; idle Auto-GC at `IDLE_TTL_MINUTES` |
| **Soft Cap** | usage ≥ `DISK_MAX_USAGE_PCT` (85%) | Reject new streams with `507 Insufficient Storage`; existing streams continue |
| **LRU Eviction** | usage ≥ `DISK_AGGRESSIVE_PCT` (88%) | Evict **least-recently-played first, one at a time**, until back under `DISK_TARGET_PCT` |
| **Emergency Halt** | usage ≥ `DISK_EMERGENCY_PCT` (95%) | Pause all *downloading* torrents to protect the host. Seeding and playback of completed files continue |

Eviction is incremental by design. The previous policy deleted **every** idle torrent the instant
the disk crossed 88 %, discarding the whole cache — including titles about to be rewatched — to
reclaim space one or two files would have covered.

---

## 8. Setup & Deployment

### Local development (frontend)

```bash
git clone https://github.com/Deucalio/cinemate.git
cd cinemate
npm install
cp .env.example .env.local     # then fill in the TMDB key and bridge URL
npm run dev                    # Vite on http://localhost:3000
```

`VITE_*` values are **inlined into the client bundle** at build time. They are configuration, not a
secret store — the bridge's `ADMIN_TOKEN`, `JWT_SECRET` and `DATABASE_URL` belong in `server/.env`
only.

### VPS production

```bash
cd /opt/cinemate
git pull

# Dedicated qBittorrent (once) — see docs/dedicated-qbittorrent.md
sudo bash deploy/install-qbt.sh

cd server
npm install
npx prisma db push
pm2 restart cinestream-bridge --update-env

curl -s http://localhost:8899/health | python3 -m json.tool
```

> **FFmpeg is required.** `sudo apt install -y ffmpeg` provides both `ffmpeg` and `ffprobe`. The
> bridge checks at boot, logs the result, and reports it under `toolchain` in `/health`. Without
> them only already-browser-native releases can play.

### Environment variables (`server/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8899` | Bridge listen port |
| `QBT_URL` | `http://127.0.0.1:18080` | qBittorrent WebUI — **set to `:18081`** for the dedicated instance |
| `QBT_USER` / `QBT_PASS` | `admin` / `adminadmin` | Ignored when the instance sets `WebUI\LocalHostAuth=false` |
| `QBT_CATEGORY` | `cinemate` | Keeps our torrents out of any \*arr stack sharing the client. `''` disables |
| `PROWLARR_URL` / `PROWLARR_KEY` | `http://127.0.0.1:9696` | Torznab search proxy |
| `REQUIRE_COMPLETE` | `1` | Cache-first. `0` restores progressive piece-aware streaming |
| `ALLOW_VIDEO_TRANSCODE` | `0` | Real-time HEVC→H.264 re-encoding. Will not keep up on 8 cores at any concurrency |
| `IDLE_TTL_MINUTES` | `30` | Idle time before a torrent and its files are deleted |
| `STREAM_IDLE_GRACE_MS` | `45000` | Quiet period before an unwatched torrent is paused |
| `HEARTBEAT_FRESH_MS` | `45000` | How long a heartbeat marks a session active |
| `MAX_ACTIVE_TORRENTS` | `5` | Concurrent torrent cap |
| `MAX_CONCURRENT_STREAMS` | `15` | Concurrent playback session cap |
| `DISK_MAX_USAGE_PCT` | `85` | Soft cap — reject new streams |
| `DISK_AGGRESSIVE_PCT` | `88` | Begin LRU eviction |
| `DISK_TARGET_PCT` | `80` | Evict down to this |
| `DISK_EMERGENCY_PCT` | `95` | Pause all downloads |
| `LRU_STATE_PATH` | `<cwd>/.cache/torrent-lru.json` | Where playback history and pins persist |
| `PREPARED_CACHE_MS` | `60000` | Resolved-stream descriptor cache TTL |
| `PIECE_STATE_CACHE_MS` | `500` | `pieceStates` cache TTL |
| `PIECE_POLL_MS` | `250` | Piece readiness poll interval |
| `PIECE_WAIT_TIMEOUT_MS` | `120000` | How long a read waits for a piece before failing loudly |
| `READ_CHUNK_BYTES` | `262144` | Piece-aware reader chunk size |
| `STREAM_RATE_LIMIT_PER_MIN` | `600` | Per-IP `/api/stream` cap |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | Binary paths |
| `DISK_USAGE_OVERRIDE_PCT` | — | **Test seam.** Forces a fixed disk percentage |

### Client variables (`.env.local`)

| Variable | Purpose |
|---|---|
| `VITE_TMDB_API_KEY` / `VITE_TMDB_TOKEN` | TMDB credentials |
| `VITE_STREAM_SERVER` | Bridge base URL |
| `VITE_PROWLARR_URL` / `VITE_PROWLARR_KEY` | Direct-to-Prowlarr fallback only |

### Test suite

```bash
cd server && npm test        # 96 assertions across 6 suites
```

Every suite runs the **real bridge** against a mock qBittorrent — no swarm, no FFmpeg, no database.

| Suite | Covers |
|---|---|
| `cache-first.test.mjs` | Incomplete torrents withheld; complete ones served **without consulting piece state at all** — asserted by reporting every piece as missing while the torrent reports 100 % |
| `piece-aware-stream.test.mjs` | Piece gating on a **multi-file** torrent (movie starts at piece 2), byte-exact delivery, cache pressure, `filePrio`, RFC 7233 ranges |
| `session-lifecycle.test.mjs` | `prepare` / `status` output including the ETA sentinel, and the pause lifecycle |
| `media-discovery.test.mjs` | `.!qB` suffix, samples losing to the feature, `.mkv` never served direct, ISO-only torrents failing fast, refusing to guess a piece size |
| `gc-and-resume.test.mjs` | Restart not wiping torrents; resuming stopped torrents; sequential mode forced on and never toggled twice |
| `lru-eviction.test.mjs` | Eviction order, pinned survival, restart-restored history, `/api/cache`, the pin endpoint |

Suites that exercise the **progressive** path set `REQUIRE_COMPLETE=0` explicitly, so they cannot
pass for the wrong reason. Each uses its own `LRU_STATE_PATH`, since a shared default made them
inherit playback history between runs.

---

## 9. Fix Log

### 9.1 Why nothing ever played

The "stuck on *Buffering Stream…*" failure was a chain of independent defects, not one bug.

| # | Root cause | Fix |
|---|---|---|
| 1 | **The default path was not piece-aware at all.** `/api/stream` served ranges with a plain `fs.createReadStream`; the piece-aware reader ran only under `?remux=1`. Sparse regions read as zero-bytes and the demuxer stalled | All delivery paths routed through one range server |
| 2 | **Piece indices ignored the file's offset within the torrent.** `floor(byteOffset / pieceSize)` verified piece 0 while the movie began at piece 2 | Global offset computed from `/torrents/files`, cross-checked against `piece_range` |
| 3 | **The piece size was a guess.** `piece_size` is not a field of `torrents/info` — it lives in `/torrents/properties`. It was always `undefined`, falling back to a hard-coded 2 MB. A smaller real piece size resolves to an index *lower* than the truth — an already-downloaded piece — so the reader ran ahead of the download frontier and served zeros. **This defeated piece-awareness entirely** | Read from `/torrents/properties`, cross-checked against `pieces_num`, and the stream **refused** if it cannot be established |
| 4 | **Sequential download was never enabled on pre-existing torrents.** The flags are set in `torrents/add`, which is a **no-op** for a torrent the client already has. Those torrents downloaded rarest-first, so the reader waited on early pieces arriving in arbitrary order — `Piece 1 was not verified` at 27 % | `ensureSequentialDownload()` reads `seq_dl` / `f_l_piece_prio` and calls the toggles when false, guarded per hash (they are toggles, not setters) |
| 5 | **FFmpeg read from a non-seekable pipe.** A `.mp4` keeps `moov` at the end, so `ffmpeg -i pipe:0` had to read the whole file before emitting a frame | FFmpeg reads a **seekable loopback HTTP URL**, or the local path once complete |
| 6 | **The reader could deadlock.** `_read()` returned without pushing when a chunk computed to zero bytes; Node never called it again | Rewritten as an async pump that always pushes, ends, or errors |
| 7 | **Media discovery scanned the DISK**, needing a file that already existed, was ≥ 5 MB, and had a whitelisted extension. qBittorrent appends **`.!qB`** to incomplete files, so a downloading movie matched nothing | Selection from the torrent's **file table**; the disk path resolved separately across every directory qBittorrent reports |
| 8 | **Container decisions used the on-disk extension**, so `.mp4.!qB` looked like an unknown container and was forced through FFmpeg | Mode selection uses the **logical** name |
| 9 | **`Content-Length` came from `stat().size`** — wrong on a sparse file, handing the browser a truncated video | Uses the torrent-declared size |
| 10 | **Range parsing was a naive split on `-`**, mishandling `bytes=-500` and `bytes=500-`, never returning `416` | RFC 7233 parser with `416` + `Content-Range: bytes */size` |

### 9.2 Why it kept destroying itself

| # | Root cause | Fix |
|---|---|---|
| 11 | **The torrent was paused on every connection close.** A browser opens dozens per video, so the download halted constantly while the user watched | A close only arms a grace timer, which **re-arms** while heartbeats are fresh |
| 12 | **Heartbeats stopped whenever the player was paused**, so Auto-GC deleted the torrent mid-session | Heartbeats run while the player is open, playing or not |
| 13 | **Auto-GC deleted every torrent ~15 s after any restart.** The in-memory registry back-dated `lastActive` to `added_on`, already older than the TTL. Every deploy wiped all downloaded data | Newly-observed torrents start their idle clock now; history persists across restarts |
| 14 | **Nothing resumed a paused torrent during resolution**, and `torrents/add` does not resume. Anything the Bandwidth Saver had paused wrote no bytes, so resolution polled until timeout every time | Resolution detects `paused*`/`stopped*`/`queuedDL` and resumes first |
| 15 | **Auto-GC could delete a torrent during setup**, in the ~25 s metadata window where it holds no reference | Reservations cover the whole setup window |
| 16 | **`refCount` was decremented twice per remux connection** (`req.close` *and* `res.finish`) | Single guarded cleanup |
| 17 | **`IDLE_TTL_MINUTES` defaulted to 1.** Pausing for a phone call deleted the torrent and its data | Default 30, with LRU eviction under pressure |
| 18 | **Eviction deleted the entire cache at 88 % disk**, to reclaim space one or two files covered | Least-recently-played first, one at a time, down to a target |
| 19 | **The 95 % emergency halt was documented but never implemented** | Implemented |
| 20 | **`pieceStates` was fetched per 128 KB chunk** — tens of thousands of ints per read, saturating the WebUI | Cached with in-flight de-duplication |
| 21 | **The stream rate limit was 25/min.** Ordinary playback exceeded it in seconds and got `429`d | Raised to 600/min |
| 22 | **Full metadata resolution ran on every range request** | Resolved descriptors cached for 60 s with in-flight sharing |

### 9.3 The disappearing files — RESOLVED

Completed downloads were deleted seconds after playback began. Established by elimination:

1. qBittorrent's log said `was removed from the transfer list and hard disk` — its exact wording for
   an API delete with `deleteFiles=true`. Nothing was lost or reset; something **asked**.
2. **Zero** `error`/`fail` lines in that log.
3. The bridge logged nothing at those timestamps — every deletion path logs `[Delete] … reason: …`,
   added precisely so this could be answered rather than argued.
4. No stray bridge process; both unexplained `node index.js` processes were unrelated backends.
5. `[AutoRun]` empty, ruling out a completion script.
6. `stream-download.service` carried `Documentation=file:///opt/stream/SONARR-SETUP.md`, and the
   download directory held `Lanterns - S01E01 - Pilot.mkv` and `Stand by Me (1986)/` — **\*arr
   naming conventions, not release names.**

**Cause:** a Sonarr/Radarr stack sharing the qBittorrent instance. Its Completed Download Handling
imports a finished download and then removes the torrent and its data — firing the instant a
download completes, which is exactly when playback started.

**Fix:** a **dedicated qBittorrent instance** (`:18081`, own profile, own storage, own systemd unit
— [docs/dedicated-qbittorrent.md](docs/dedicated-qbittorrent.md)), plus a `cinemate` category
applied to new *and* pre-existing torrents as a second line of defence.

**Worth recording:** four wrong theories preceded the right one — ratio-limit removal, a failed
move-on-completion, our own `filePrio` calls, and a stale bridge process. What settled it was making
the bridge log every deletion with a reason, then reading the *other* system's log. Neither of those
is guesswork.

### 9.4 Client-side defects

| # | Root cause | Fix |
|---|---|---|
| 23 | **Drag-scrubbing called `_seekTo` on every mousemove.** In remux mode each seek restarts FFmpeg, so one drag spawned dozens of concurrent transcodes competing for the same pieces | Dragging previews only; the seek commits once, on release |
| 24 | **Those `mousemove`/`mouseup` listeners were never removed**, so every re-open stacked another live handler | Removed on close |
| 25 | **The error handler fought its own fallback**, blind-reloading every 3.5 s and reloading the *failed* direct URL over the remux attempt | One state-aware handler: escalate direct → remux exactly once, then report |
| 26 | **The player auto-played a Google sample clip** (`TearsOfSteel.mp4`), so a completely broken bridge still looked like working playback | Removed |
| 27 | **Auto-resume restored a timestamp on a fresh torrent**, requiring download up to that point before anything played — presenting as a jump to a random time, then a hang | Playback always starts at 0; progress still recorded for the library |
| 28 | **A `<video>` reports only opaque `MEDIA_ERR_*` codes**, so "no seeders", "unsupported codec" and "disk full" were indistinguishable | `GET /api/stream/prepare` returns a plan or a typed error first |
| 29 | **The buffering HUD animated a bar wired to nothing**, so a legitimate 60-second download and a permanent hang looked identical | Real percentage, speed, seeds and ETA; the pulse survives only for the genuinely unknown metadata phase |
| 30 | **Closing the tab never sent the leave beacon** — `close()` only ran on in-app dismissal | `pagehide` listener |
| 31 | **Controls lied**: a hardcoded `4K HDR` pill, a quality selector that switched nothing, a CC button with no subtitle pipeline. `_play()` also reset volume to 1.0 on every play | Pill shows probed codecs and mode; dead controls removed; volume respected |
| 32 | **Audio detection was inverted** — `isAAC = … \|\| !isEAC3` badged every untagged 5.1 release as "AAC Stereo ✓" and ranked it browser-safe | Corrected; HEVC ranked last and flagged in the sources list |
| 33 | **`health.activeTorrents` did not exist** (the field is `activeTorrentsCount`) | Fixed, plus the `#ctrl-vol-slider` selector typo |

### 9.5 Environment & tooling

| # | Root cause | Fix |
|---|---|---|
| 34 | **`enrichMagnetWithTrackers()` was never called** — tracker injection was dead code, leaving bare magnets to stall on DHT bootstrap | Wired into `addTorrent()` |
| 35 | **qBittorrent 5.x renamed `pause`/`resume` to `stop`/`start`**, so bandwidth control silently no-opped on 5.x hosts | Tries the modern name, falls back |
| 36 | **`server/node_modules` was stale** — `bcryptjs`, `jsonwebtoken`, `@prisma/client` declared but absent, so a fresh checkout died with `ERR_MODULE_NOT_FOUND` | `npm install`; unused `webtorrent` dropped |
| 37 | **`fs.existsSync` returns false for permission errors identically to "not found"**, so an unreadable download directory looked like a torrent that had not started writing. The bridge said "retry in a few seconds" while reporting 71 % downloaded at 71 MB/s | `EACCES`/`EPERM` captured separately, retry loop stopped, and the running user and unreadable directory named |
| 38 | **qBittorrent's queueing parked torrents in `queuedDL`** and they downloaded nothing | Disabled in the dedicated instance's config |
| 39 | **Credentials were hardcoded in client source** and committed to git history | Moved to `.env.local` via `import.meta.env`. **The exposed TMDB and Prowlarr keys should still be rotated** |

### 9.6 Known limitations

- **Cold start waits for the full download** (~60 s for 2–3 GB). Deliberate. A rewatch is instant.
  [Phase 5′](docs/phase5-hls-plan.md) reduces this to ~10 s.
- **Seeking in remux mode restarts FFmpeg**, costing seconds. Direct mode seeks natively.
  [Phase 5′](docs/phase5-hls-plan.md) removes this entirely.
- **HEVC / x265 cannot play in a browser.** Real-time transcoding will not keep up on this VPS, so
  `prepare` returns `415 UNSUPPORTED_VIDEO_CODEC` and the UI flags those releases.
- **Seeking ahead of the download head waits for the swarm** on the progressive path — qBittorrent
  exposes no piece-priority setter.
- **No authentication on the streaming endpoints.** See §5.

---

## 10. Status

| Phase | State |
|---|---|
| Vite adoption, credentials out of source | ✅ Complete |
| Phase 1 — real download progress | ✅ Complete |
| Phase 2 — cache-first delivery | ✅ Complete |
| Phase 3 — LRU retention, pinning, emergency halt | ✅ Complete |
| Dedicated qBittorrent instance | ✅ Complete |
| Phase 4 — progressive fast start | ❌ Not recommended — would reinstate the complexity Phase 2 removed |
| **Phase 5′ — progressive HLS transcode** | 📋 **Planned — next** |
| UI polish pass | 📋 Pending |
| React + Vite migration | 📋 Pending — after the player shrinks |
| Authentication | 📋 Pending — wants HTTPS first |
