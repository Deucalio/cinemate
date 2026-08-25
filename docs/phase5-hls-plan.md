# Phase 5′ — Progressive HLS Transcode

> **Status:** Planned, not started
> **Supersedes:** the original Phase 5 ("per-title `.web.mp4` transcode cache") in
> [cache-first-streaming-plan.md](./cache-first-streaming-plan.md). HLS delivers everything that
> plan did *and* removes the cold-start wait, so building the MP4 version first would be doing the
> same work twice.

---

## 1. The two problems this solves

### Seeking respawns FFmpeg, every time

From production logs, one person watching one episode:

```
16:00:04  [Remux] start=201s      16:00:23  [Remux] start=1033s
16:00:12  [Remux] start=25s       16:00:42  [Remux] start=1047s
16:00:16  [Remux] start=16s       16:01:13  [Remux] start=1643s
16:00:18  [Remux] start=6s        16:01:17  [Remux] start=2139s
```

Ten seeks in two minutes, each spawning **two** FFmpeg processes — roughly twenty transcodes
started and killed. Every one is several seconds of black screen. This happens because a `.mkv`
cannot be handed to a browser, so it is transcoded **live, per viewer, per seek, forever**, and
progressive fMP4 carries no index to seek within.

### Cold start waits for the whole download

Cache-first (Phase 2) fixed correctness by refusing to serve an incomplete file. The cost is ~60 s
for a 2–3 GB release before anything plays.

---

## 2. Why HLS, and why it is *simpler* than what we have

Transcode into segments as the download progresses, with a playlist that grows:

```
qBittorrent ──► /internal/piece-file ──► ffmpeg (ONE per title) ──► seg00000.ts
                (piece-verified,          -f hls -hls_time 4         seg00001.ts
                 blocks until ready)      -hls_playlist_type event   seg00002.ts …
                                                    │
                                    playlist.m3u8 ◄─┘  (grows as segments land)
                                                    │
                                                    ▼
                                        hls.js plays what exists
```

**The property that matters: every segment served is a complete, finished file.** Not a partial
read, not a sparse region, not a piece-gated stream. The entire class of bug this project spent a
day on — sparse zeros, `invalid as first byte of an EBML number`, piece verification, frontier
clamping, `Stream ends prematurely` — *cannot occur*, because a file is only ever served after it
has been fully written and renamed into place.

A second point worth stating plainly: the piece-aware reader was painful when it served **browsers**
(many concurrent readers, random access, per-request lifecycles, 120-second timeouts). Here it gets
exactly **one consumer**, FFmpeg, reading **linearly, forwards, once**. Blocking is the correct
behaviour rather than a hazard. It is a much better fit for the machinery we already have and have
now tested.

### What it delivers

| | Today | After |
|---|---|---|
| Cold start | ~60 s (full download) | **~10 s** (3–4 segments) |
| Seeking | FFmpeg respawn, seconds of black | **Instant**, native, within the transcoded range |
| CPU per title | `O(viewers × seeks)` | `O(1)` — one transcode, ever |
| Re-watch | Live remux again | Instant, segments already on disk |
| FFmpeg in the playback path | Yes | **No** |
| CDN-ready | No | Yes — segments are static, cacheable files |

---

## 3. Design decisions

### 3.1 HLS only when it is actually needed

A release that is already **MP4 + H.264 + AAC stereo** stays on the `direct` path. It already seeks
natively at zero CPU, and segmenting it would only cost disk and time. HLS applies exactly where
remux applies today: non-browser-native containers or codecs.

### 3.2 Lazy, not eager

Segmenting starts on the **first `prepare` for a title**, not when the download starts. Transcoding
things nobody watches would waste CPU and double the disk footprint of the whole cache.

### 3.3 One transcode per title, shared by all viewers

A registry keyed by infohash. A second viewer joins the existing job rather than starting another.
This retires `ffmpegBySession` and the per-session supersede logic entirely.

### 3.4 `event` playlist, promoted to VOD on completion

`-hls_playlist_type event` grows the playlist and never removes entries. When FFmpeg finishes it
writes `#EXT-X-ENDLIST`, at which point hls.js treats it as a normal VOD asset with full seeking.

Before that, seeking is limited to the transcoded range. Since transcode runs many times faster than
playback, the head pulls away quickly and this stops being noticeable within a minute or two.

### 3.5 Atomic segments

`-hls_flags temp_file` makes FFmpeg write `segNNNNN.ts.tmp` and rename on completion. A segment
named in the playlist is therefore always complete on disk. This is what makes the "no partial
reads" guarantee real rather than merely likely.

### 3.6 Segments live outside the torrent directory

`/var/lib/cinemate/hls/<infohash>/` — **not** under the download path, so qBittorrent never sees
them, never rechecks them, and never moves them.

### 3.7 MPEG-TS segments for v1

`.ts` with H.264 + AAC is the most broadly supported combination in hls.js and needs no init
segment. fMP4 (`-hls_segment_type fmp4`) is a later option if HEVC or byte-range playlists ever
matter.

### 3.8 Disk: roughly 2× per transcoded title

Video is copied and audio shrinks (AAC stereo vs AC3/EAC3 5.1), so segments come out close to the
source size. While both exist, a title costs about double.

Mitigation is Phase 3's LRU eviction, extended to treat the HLS directory as part of the title's
footprint. **Deferred decision:** whether to delete the source torrent once its segments are
complete. That halves the footprint and stops seeding, at the cost of not being able to re-derive.
Not doing it in v1.

---

## 4. Implementation

### 4.1 Server — transcode manager

- [ ] `hlsJobs` registry: `infohash -> { state, dir, playlistPath, proc, segments, startedAt, error }`
      with states `starting | running | complete | failed`.
- [ ] `startHlsJob(prep, summary)` — spawns FFmpeg reading the **loopback piece-aware URL** so it
      blocks on undownloaded regions instead of hitting EOF.
- [ ] Idempotent: a second caller for the same infohash joins the existing job.
- [ ] Resume: if the directory already has `#EXT-X-ENDLIST`, mark `complete` and skip FFmpeg.
- [ ] On exit: non-zero → `failed` with the last stderr lines retained for the client.
- [ ] Concurrency cap (`HLS_MAX_CONCURRENT`, default `cores - 2`) so transcodes never starve serving.

FFmpeg invocation:

```
-hide_banner -loglevel error
-i http://127.0.0.1:<port>/internal/piece-file?token=…
-map 0:v:0? -map 0:a:0?
-c:v copy                     (or libx264 when ALLOW_VIDEO_TRANSCODE and the codec is unusable)
-c:a aac -b:a 192k -ac 2
-f hls
-hls_time 4
-hls_playlist_type event
-hls_list_size 0
-hls_flags temp_file+independent_segments
-hls_segment_filename <dir>/seg%05d.ts
<dir>/playlist.m3u8
```

### 4.2 Server — serving

- [ ] `GET /api/stream/hls/:hash/playlist.m3u8` — static read of the growing playlist, `no-store`.
- [ ] `GET /api/stream/hls/:hash/:segment` — static read; validate the filename against
      `/^seg\d{5}\.ts$/` and confirm the resolved path stays inside the job directory.
- [ ] `prepare` gains `mode: 'hls'` with `playlistUrl`, `segmentsReady`, `transcodeProgress`.
- [ ] `/api/stream/status` reports transcode progress alongside download progress, so the existing
      HUD covers "downloading" → "preparing" → "ready" with no new UI.

Progress is `segmentsWritten × hlsTime ÷ durationSec` — duration comes from the ffprobe we already
run.

### 4.3 Server — lifecycle

- [ ] Eviction deletes the HLS directory with its torrent.
- [ ] `/api/cache` reports HLS size per title so the real footprint is visible.
- [ ] Kill any running job when its torrent is evicted.
- [ ] Orphan sweep at boot: HLS directories with no matching torrent.

### 4.4 Client

- [ ] Re-add `hls.js` — this time as an npm dependency bundled by Vite, not a CDN tag.
- [ ] `mode: 'hls'` → attach `Hls` to the video element; native HLS on Safari via
      `canPlayType('application/vnd.apple.mpegurl')`.
- [ ] Start playback once `segmentsReady >= HLS_START_SEGMENTS` (default 3).
- [ ] Scrubber spans the **full** duration (known from ffprobe), with the un-transcoded region
      visually distinct, and seeks clamped to what exists.
- [ ] Surface `Hls.Events.ERROR` through the existing error HUD.

### 4.5 Deletions this enables

- [ ] The per-request remux path and its `startSec` restart behaviour
- [ ] `ffmpegBySession` and the per-session supersede logic
- [ ] `currentStartSec` offset arithmetic, `_pendingSeekSec`, and the remux branch of `_seekTo`
- [ ] `Accept-Ranges: none` and the progressive-fMP4 special cases

---

## 5. Testing

The dev machine has no FFmpeg, so tests must not depend on running it.

- [ ] **Playlist and segment serving** — fabricate a directory of segment files and a playlist; assert
      correct serving, and that path traversal and non-matching filenames are rejected.
- [ ] **FFmpeg argument construction** — assert the arg list for copy, transcode and audio-only
      cases without spawning anything.
- [ ] **Job registry** — a second request joins rather than spawning; a completed directory is
      detected and reused; failures surface an error.
- [ ] **Progress reporting** — segment count maps to the expected percentage.
- [ ] **Eviction** — the HLS directory is removed with its torrent, and a running job is killed.
- [ ] **Mode selection** — a browser-native MP4 stays `direct` and never gets segmented.

Real FFmpeg output is verified manually on the VPS, where it exists.

---

## 6. Risks

| Risk | Assessment |
|---|---|
| FFmpeg reading the piece-aware URL while downloading | The reader is now tested, and here it has a single linear consumer — its easiest possible workload. |
| Transcode outruns the download | FFmpeg blocks on the reader. Slower, not broken. |
| Disk doubles per transcoded title | Real. Cache capacity roughly halves until the source-deletion question is settled. |
| Segment overhead | ~2–5 % versus a single MP4. Acceptable. |
| HEVC | Unchanged — still needs full video transcode, still off by default, still a clear `415`. |
| hls.js bundle size | ~150 KB gzipped. Loaded only when a stream needs it. |

---

## 7. Success criteria

1. A cold, non-native title starts playing within **~15 seconds** of choosing a source.
2. Seeking anywhere in the transcoded range is **instant** and spawns no process.
3. A title is transcoded **once**; a second viewer starts immediately.
4. Zero FFmpeg processes are running while a fully-transcoded title plays.
5. Evicting a title removes its segments too.
6. The existing suite still passes; new coverage for the above.
