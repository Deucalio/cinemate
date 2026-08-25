# Phase 5′ — Progressive HLS Transcode

> **Status:** Spec agreed, not started
> **Revision 2** — incorporates an architecture review. The material change from r1 is the
> **cache-representations model** (§3), which turns source deletion into a policy rather than a
> migration, and gives eviction a correct footprint.
> **Supersedes:** the original Phase 5 (per-title `.web.mp4` cache) in
> [cache-first-streaming-plan.md](./cache-first-streaming-plan.md).

---

## 1. The two problems

### Seeking respawns FFmpeg, every time

From production logs — one person, one episode:

```
16:00:04  [Remux] start=201s      16:00:23  [Remux] start=1033s
16:00:12  [Remux] start=25s       16:00:42  [Remux] start=1047s
16:00:16  [Remux] start=16s       16:01:13  [Remux] start=1643s
16:00:18  [Remux] start=6s        16:01:17  [Remux] start=2139s
```

Ten seeks in two minutes, each spawning **two** FFmpeg processes. Every one is several seconds of
black screen. A `.mkv` cannot be handed to a browser, so it is transcoded **live, per viewer, per
seek, forever**, and progressive fMP4 carries no index to seek within.

### Cold start waits for the whole download

Cache-first (Phase 2) bought correctness by refusing to serve an incomplete file. The cost is ~60 s
for a 2–3 GB release before anything plays.

---

## 2. The inversion

Today the expensive, stateful operation lives in the **request/session layer**:

```
viewer ──► FFmpeg ──► torrent
```

It moves to the **cache layer**:

```
torrent ──► FFmpeg ──► durable HLS representation ──► viewers
```

Playback then becomes boring, which is the point:

```
prepare ──► playlist ──► segments ──► hls.js
```

No FFmpeg lifecycle attached to a seek. No `startSec`. No per-request process ownership.

### Why this is *less* machinery, not more

**Every segment served is a complete, finished file.** Not a partial read, not a sparse region, not
a piece-gated stream. Sparse zeros, `invalid as first byte of an EBML number`, piece verification,
frontier clamping and `Stream ends prematurely` **cannot occur**, because a file is only served
after it has been fully written and renamed into place.

**The piece-aware reader finally gets a workload it suits.** It was asked to answer:

> *Can arbitrary browser requests safely read arbitrary byte ranges from a partially downloaded
> torrent?*

Now it answers:

> *Can one consumer seek once, then read forward to the end, blocking until the next piece exists?*

No random access, no concurrent readers, no request cancellation, no seek-aware piece arithmetic for
browsers. Blocking becomes the correct behaviour rather than a hazard.

*(Precisely: FFmpeg seeks once at the start to read the Matroska header and cues, then reads
linearly. `ffprobe` already exercises this path successfully.)*

---

## 3. The cache model

**A cached title is a source plus zero or more representations.** This is the structural decision;
everything else follows from it.

```
CacheEntry            (keyed by infohash)
├── source
│   ├── torrentHash · name · mediaPath · sizeBytes
│   ├── lastPlayedAt · pinned
│   └── state: downloading │ complete │ evicted
└── representations
    └── hls
        ├── dir · manifest.json · playlist.m3u8 · seg*.ts
        ├── state: absent │ running │ complete │ failed
        └── sizeBytes
```

State transitions become a lookup rather than special-casing:

| source | hls | action |
|---|---|---|
| complete | absent | start the job |
| complete | running | join the existing job |
| complete | complete | serve it |
| complete | failed | report, allow retry |
| evicted | any | delete the representation too |
| deleted *(future policy)* | complete | HLS becomes the retained representation |

### What this fixes that r1 got wrong

Eviction currently operates on **torrents**. With representations it operates on **cache entries**,
so:

- **LRU footprint** = `source.sizeBytes + Σ representations.sizeBytes` — the real cost of a title
- `/api/cache` reports that real cost, not just the torrent
- Evicting a title necessarily removes its derived files; there is no separate cleanup path to
  forget about
- **Source deletion later is a policy flip, not a migration**

### `HLS_SOURCE_POLICY`

- `retain` **(v1 default)** — keep both. Costs ~2× disk per transcoded title.
- `delete-on-complete` *(not implemented)* — halves the footprint, stops seeding.

Retaining is deliberate. The source is needed to rebuild after corruption, change HLS parameters,
generate another representation, re-run `ffprobe`, debug, and support any future delivery mode. The
first implementation optimises for **correctness and observability**, not disk efficiency. Revisit
once source size, HLS size, completion time, rewatch frequency and cache hit rate have actually been
measured.

---

## 4. Design decisions

### 4.1 HLS only where the browser genuinely cannot cope

A release that is truly browser-native stays on `direct` — it seeks natively at zero CPU and
segmenting it would only cost disk and time.

The decision is a **policy function**, not a set-membership test, so browser-matrix quirks have
somewhere to live:

```
containers: .mp4 · .m4v · .webm
video:
  h264  profile ∈ {Baseline, Constrained Baseline, Main, High}
        AND pix_fmt ∈ {yuv420p, yuvj420p}
  vp8 · vp9 · av1   (container-dependent — see exceptions)
audio:
  aac · mp3 · opus · vorbis    channels ≤ 2
```

**The `h264` profile check is not optional.** `codec_name: h264` says nothing about profile — a
**High 10 / 4:2:2 / 4:4:4** release probes as `h264` and is undecodable in every browser. Declaring
it `direct` would reproduce the original bug exactly. `ffprobe` already returns `profile` and
`pix_fmt`; we simply have to look.

Known exceptions the policy should be able to express: Opus-in-MP4 (Safari), VP9/AV1-in-MP4
(inconsistent), and anything else discovered later. We do not need to solve the full matrix now —
only to have a place to put it.

### 4.2 Lazy, one job per title

Segmenting starts on the **first `prepare`**, never on download start — transcoding titles nobody
watches would waste CPU and double the whole cache's footprint. A second viewer **joins** the
existing job. This retires `ffmpegBySession` and the per-session supersede logic.

### 4.3 `event` playlist, promoted to VOD

`-hls_playlist_type event` grows the playlist and never drops entries. On completion FFmpeg writes
`#EXT-X-ENDLIST` and hls.js treats it as an ordinary VOD asset.

### 4.4 Atomic segments

`-hls_flags temp_file` writes `segNNNNN.ts.tmp` and renames. A segment named in the playlist is
therefore always complete on disk. This is what makes the "no partial reads" guarantee real rather
than merely likely.

### 4.5 Segments live outside the torrent directory

`/var/lib/cinemate/hls/<infohash>/` — **not** under the download path, so qBittorrent never sees
them, rechecks them, or moves them.

### 4.6 MPEG-TS for v1

`.ts` with H.264 + AAC is the most broadly supported combination in hls.js and needs no init
segment. fMP4 (`-hls_segment_type fmp4`) is a later option if HEVC or byte-range playlists matter.

### 4.7 Progress from `EXTINF`, not segment count

`segmentsWritten × hls_time` is an approximation — the final segment is short, and keyframe
alignment means segments are not exactly `hls_time`. Instead:

```
transcodedDurationSec = Σ EXTINF from the playlist
transcodeProgress     = transcodedDurationSec / durationSec
```

This is exact, and it is **not extra work**: the player needs `transcodedDurationSec` anyway to draw
the seek boundary. One source of truth instead of two.

### 4.8 Start on available duration, not segment count

```
ready when transcodedDurationSec >= HLS_START_BUFFER_SEC   (default 8)
```

Segment count is the wrong invariant: changing `hls_time` from 4 to 6 would silently turn "three
segments" from 12 s into 18 s. The real question is *"is there enough playable duration ahead of the
viewer."*

### 4.9 The seek contract, stated explicitly

```
[────────── transcoded ──────────●─────── not yet ───────]
                                head
```

- **Inside the transcoded range** — immediate, native, no server work.
- **Beyond the head** — the seek is *accepted*, and the progress HUD shows
  `waiting for transcode to reach 1:30:00 — currently 0:37:00, ~2 min`.

Accepting rather than snapping back is deliberate: the scrubber should not lie about where you can
go. The un-transcoded region is rendered visually distinct so the boundary is legible.

---

## 5. Durability and recovery

**The filesystem is the source of truth. `hlsJobs` tracks live processes only.**

This is the same class of bug that has already bitten this project twice: `torrentRegistry` being
in-memory is exactly what made Auto-GC wipe every torrent 15 s after a restart
([project.md §9.2](../project.md), fix 13), resolved by persisting `torrent-lru.json`. Applying the
lesson before it bites rather than after.

### 5.1 `manifest.json`

One per representation, written atomically (temp + rename):

```json
{
  "version": 1,
  "infohash": "…",
  "torrentHash": "…",
  "source": {
    "path": "/var/lib/cinemate/downloads/….mkv",
    "sizeBytes": 1828209077,
    "mtimeMs": 1787678400000
  },
  "media": {
    "durationSec": 3093,
    "videoCodec": "h264", "videoProfile": "Main", "pixFmt": "yuv420p",
    "audioCodec": "eac3", "audioChannels": 6
  },
  "hls": {
    "segmentDurationSec": 4,
    "startedAt": "2026-08-25T16:20:00Z",
    "completedAt": null,
    "ffmpegArgs": ["-c:v", "copy", "…"]
  }
}
```

`source.sizeBytes` and `mtimeMs` let reconciliation detect the source changed underneath a
representation. `ffmpegArgs` makes it obvious when a representation was built with parameters we no
longer use, and is invaluable when debugging a bad transcode.

### 5.2 Boot reconciliation

```
for each directory in /var/lib/cinemate/hls/:

    delete any *.tmp                       (FFmpeg died mid-segment — harmless)

    no manifest.json          ──► delete   (unidentifiable)
    manifest.version mismatch ──► delete   (rebuild under current rules)
    source missing/changed    ──► delete   (mtime or size differs)
    no matching torrent       ──► delete   (orphan)

    validate: every segment named in the playlist exists on disk
        all present + ENDLIST ──► complete
        all present, no END   ──► resumable  → rebuild (see below)
        any missing           ──► delete, rebuild
```

### 5.3 v1 rebuilds; it does not resume

An interrupted job is **discarded and rebuilt from scratch**, not resumed.

Resuming needs `-ss` plus `-hls_start_number` plus `append_list`, and risks timestamp
discontinuities — which surface as intermittent playback glitches, the hardest possible thing to
debug. A rebuild costs a few minutes of CPU. That is §3's principle applied: correctness and
observability first.

Resume-from-offset is a future optimisation, worth doing once we have measured how often
interruptions actually happen.

### 5.4 Piece waiting must be progress-based

`PIECE_WAIT_TIMEOUT_MS` is currently 120 s of **wall clock**. If a swarm stalls for two minutes
mid-transcode, the read fails and the job dies **halfway through a two-hour title**.

The condition must become *"the torrent has made no progress for N seconds"*, not *"N seconds have
elapsed"*. A slow-but-advancing download should block indefinitely; only a genuinely stalled torrent
should fail the job.

### 5.5 A transcoding title must be eviction-protected

Transcoding **grows** disk usage, which can cross `DISK_AGGRESSIVE_PCT` and trigger LRU eviction —
potentially evicting the very title being built. `isEvictionProtected()` must include *"has a
running HLS job."*

---

## 6. Implementation

### 6.1 Cache entries and representations — ✅ DONE

- [x] Torrent registry extended into `CacheEntry { source, representations }`.
- [x] Footprint = source + representations; eviction reports what it reclaims.
- [x] `isEvictionProtected()` includes "has a running representation".
- [x] Eviction removes representation directories with the source.
- [x] `/api/cache` reports per-representation size and state, plus `totalFootprintBytes`
      and `sourcePolicy`.
- [x] Orphan reconciliation — representations whose torrent is gone are reclaimed on the GC tick.
- [x] `HLS_DIR` (default `/var/lib/cinemate/hls`) and `HLS_SOURCE_POLICY` (default `retain`).

**Notes from implementation:**

- `/api/cache` reads representation state **from disk**, not from the in-memory registry. The
  registry is populated by the GC sweep, so for the first 15 s after boot — and for any torrent the
  sweep has not yet reached — it is empty, and the endpoint would have understated every title's
  footprint. Consistent with §5: the filesystem is the source of truth.
- Orphan reclamation is genuinely necessary rather than defensive: eviction only ever walks the
  **torrent list**, so a representation whose source is gone is invisible to it and would occupy
  disk indefinitely.
- Footprint counts the whole directory, `manifest.json` included.

Covered by `server/test/cache-representations.test.mjs` (15 assertions), including the case that
motivates §5.5: under disk pressure, an idle title is evicted with its representation while a
**transcoding** title is spared.

### 6.2 Transcode manager — ✅ DONE

- [x] `hlsJobs` registry — **live processes only**, never authoritative.
- [x] `startHlsJob()` — FFmpeg reading the loopback piece-aware URL.
- [x] Idempotent: a second caller joins the running job.
- [x] `manifest.json` written **atomically** before spawning; `completedAt` stamped on clean exit.
- [x] Non-zero exit → `failed`, retaining the last stderr lines.
- [x] `HLS_MAX_CONCURRENT` (default `cores - 2`); at capacity a request reports `queued`.
- [x] Boot reconciliation per §5.2, every branch.
- [x] `buildHlsFfmpegArgs()` split out so it is assertable without spawning.
- [x] `parseHlsPlaylist()` — `EXTINF` sum, segment list, `ENDLIST` detection.
- [x] `hlsStatus()` — state, `segmentsReady`, `transcodedDurationSec`, `transcodeProgress`.
- [x] Eviction stops a running job before deleting its directory.
- [x] **§5.4 landed here too**: piece waiting is now a STALL timeout, not wall-clock.

**Notes from implementation:**

- `PIECE_WAIT_TIMEOUT_MS` became `PIECE_STALL_TIMEOUT_MS` (old name still honoured). The deadline
  resets whenever the torrent verifies another piece, so a slow-but-advancing download blocks
  indefinitely and only a genuinely stalled one fails. Without this a two-minute swarm stall would
  kill a transcode halfway through a two-hour title.
- `summarizeProbe()` now captures `videoProfile` and `pixFmt`, which §4.1's policy needs and the
  manifest records.
- Reconciliation re-`stat`s the source on every boot rather than trusting the manifest, so a source
  that changed underneath a representation is caught.

Covered by `server/test/hls-transcode-manager.test.mjs` (16 assertions). Reconciliation is tested by
laying out one directory per failure branch, booting the real bridge, and reading which survived —
the actual code path, not a re-implementation. Nothing spawns FFmpeg.

```
-hide_banner -loglevel error
-i http://127.0.0.1:<port>/internal/piece-file?token=…
-map 0:v:0? -map 0:a:0?
-c:v copy                    (libx264 only when ALLOW_VIDEO_TRANSCODE and the codec is unusable)
-c:a aac -b:a 192k -ac 2
-f hls
-hls_time 4
-hls_playlist_type event
-hls_list_size 0
-hls_flags temp_file+independent_segments
-hls_segment_filename <dir>/seg%05d.ts
<dir>/playlist.m3u8
```

### 6.3 Serving

- [ ] `GET /api/stream/hls/:hash/playlist.m3u8` — static read, `no-store`.
- [ ] `GET /api/stream/hls/:hash/:segment` — filename validated against `/^seg\d{5}\.ts$/`, and the
      resolved path confirmed inside the job directory.
- [ ] `prepare` gains `mode: 'hls'` with `playlistUrl`, `transcodedDurationSec`, `durationSec`,
      `transcodeProgress`, `ready`.
- [ ] `/api/stream/status` reports download **and** transcode progress:

```json
{
  "downloadProgress": 0.82,
  "transcodeProgress": 0.41,
  "transcodedDurationSec": 412,
  "durationSec": 1004,
  "segmentsReady": 103
}
```

### 6.4 Client

- [ ] `hls.js` as an npm dependency bundled by Vite — not a CDN tag.
- [ ] `mode: 'hls'` → attach `Hls`; native HLS on Safari via
      `canPlayType('application/vnd.apple.mpegurl')`.
- [ ] Start once `transcodedDurationSec >= HLS_START_BUFFER_SEC`.
- [ ] Scrubber spans the **full** duration, with the un-transcoded region visually distinct.
- [ ] Seeks beyond the head accepted, with the waiting message from §4.9.
- [ ] `Hls.Events.ERROR` surfaced through the existing error HUD.

### 6.5 Deletions this enables

- [ ] The per-request remux path and its `startSec` restart behaviour
- [ ] `ffmpegBySession` and the per-session supersede logic
- [ ] `currentStartSec` arithmetic, `_pendingSeekSec`, and the remux branch of `_seekTo`
- [ ] `Accept-Ranges: none` and the progressive-fMP4 special cases

---

## 7. Testing

The dev machine has no FFmpeg, so tests must not depend on running it.

- [ ] **Playlist and segment serving** — fabricated segment directory; correct serving, and path
      traversal / non-matching filenames rejected.
- [ ] **FFmpeg argument construction** — asserted for copy, transcode and audio-only cases, without
      spawning anything.
- [ ] **Job registry** — a second request joins rather than spawning; a completed directory is
      reused; failures surface an error.
- [ ] **Boot reconciliation** — every branch of §5.2: missing manifest, version mismatch, changed
      source, orphan, missing segment, clean complete.
- [ ] **`EXTINF` progress** — a hand-written playlist maps to the expected duration and percentage.
- [ ] **Codec policy** — `h264` High 10 and 4:2:2 are **not** direct; `yuv420p` Main is.
- [ ] **Eviction** — footprint includes representations; a running job is protected; eviction removes
      the directory and kills the job.
- [ ] **Mode selection** — a browser-native MP4 stays `direct` and is never segmented.

Real FFmpeg output is verified manually on the VPS.

---

## 8. Risks

| Risk | Assessment |
|---|---|
| FFmpeg reading the piece-aware URL while downloading | Its easiest workload: one consumer, one seek, then linear. Mitigated further by §5.4. |
| Swarm stalls mid-transcode | §5.4 — progress-based waiting, so only a genuinely dead torrent fails the job. |
| Disk ~2× per transcoded title | Real. Cache capacity roughly halves under `retain`. Measured before revisiting. |
| Interrupted job wastes CPU on rebuild | Accepted for v1; resume is a later optimisation. |
| Segment overhead | ~2–5 % versus a single MP4. |
| HEVC | Unchanged — still needs full video transcode, still off by default, still a clear `415`. |
| hls.js bundle | ~150 KB gzipped, loaded only when needed. |

---

## 9. Success criteria

1. A cold, non-native title starts playing within **~15 s** of choosing a source.
2. Seeking **inside the transcoded range** is instant and spawns no process.
3. Seeking **beyond the head** shows an honest wait, never a hang.
4. A title is transcoded **once**; a second viewer starts immediately.
5. **Zero** FFmpeg processes running while a fully-transcoded title plays.
6. Killing the bridge mid-transcode and restarting recovers deterministically.
7. Evicting a title removes its segments, and `/api/cache` showed their cost beforehand.
8. The existing 96 assertions still pass, plus new coverage for the above.

---

## 10. Deferred, deliberately

- **Source deletion** (`HLS_SOURCE_POLICY=delete-on-complete`) — until the numbers are measured.
- **Resume-from-offset** after an interrupted job — until interruption frequency is known.
- **fMP4 segments** — only if HEVC or byte-range playlists become relevant.
- **Multiple bitrate ladders** — the scaling roadmap's concern, not this one.
- **The full browser-codec matrix** — the policy function has somewhere to put it; we populate it as
  real failures appear.

## 11. Noted, not solved

Cache identity is the **infohash**. A different release of the same episode is a different entry —
separate download, separate transcode, no reuse. Correct, but mildly surprising: "I'll just try
another source" costs a full cycle.
