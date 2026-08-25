# Cache-First Streaming — Implementation Plan & Change Log

> **Status:** Phases 0–2 complete · Phase 3 next · Phases 4–5 optional
> **Owner:** Deucalio
> **Created:** 2026-08-25

This document is both the plan and the running record. As each phase lands, fill in its
**Outcome** section with what actually changed and anything learned. Keep it honest — the value is
in recording what surprised us, not in looking tidy.

Bugs already fixed on the *current* (piece-aware) architecture are catalogued in
[project.md §9](../project.md). This document covers what comes next and why.

---

## 1. Why we are changing architecture

Piece-aware streaming is the right design when download speed is slow relative to playback. **Ours
is not.** Measured on this VPS: **12–70 MB/s** from the swarm. A 2.4 GB release completes in roughly
60 seconds.

We are running a distributed-systems-grade piece scheduler to avoid a one-minute wait, and paying
for it with an entire category of failure modes. That is a bad trade.

### What cache-first eliminates outright

| Currently fighting | After cache-first |
|---|---|
| `piece_size` sourced from the wrong qBittorrent endpoint | irrelevant — no piece math |
| Sparse-zero reads → `0x00 … invalid as first byte of an EBML number` | impossible — file is whole |
| `Piece N was not verified within 120000ms` | impossible |
| `.!qB` incomplete-suffix path resolution mid-download | file has its final name |
| Enforcing `seq_dl` / `f_l_piece_prio` on pre-existing torrents | irrelevant — order stops mattering |
| FFmpeg `-reconnect`, `Stream ends prematurely`, `Input/output error` | reads a real local file |
| `pieceStates` polling load on the qBittorrent WebUI | gone |
| `/api/stream` requests piling up pending on every seek | gone — see below |

### The two observed symptoms this fixes

Both reported symptoms are consequences of the same thing: **every seek restarts the entire
pipeline** (new `/api/stream` → re-resolve → new FFmpeg → new piece-aware reader).

- *"Pending `/api/stream` requests stack up when I seek"* — each one is an open piece-aware reader
  waiting up to 120 s for pieces that may never arrive in the order requested.
- *"Seeking removes the file and re-downloads it"* — repeated re-resolution churns the torrent.

Once the file is complete and served with plain HTTP 206, **the browser seeks natively**. No new
request reaches the bridge at all.

### The honest cost

- **Time-to-first-frame becomes full download time.** ~60 s for 2–3 GB; ~3–5 min for an 8 GB 4K
  release; substantially worse on a thin swarm.
- **Bandwidth and disk are spent on media the viewer may abandon** after 20 seconds.

Accepted deliberately. Phase 4 exists if we later want the wait back down.

---

## 2. Phases

### Phase 1 — Make waiting honest

*Highest value per line changed. Needed regardless of which architecture ultimately wins.*

The player currently shows an indeterminate "Buffering Stream…" spinner over a **fake animated
progress bar**. It conveys nothing, so a 60-second wait is indistinguishable from a permanent hang —
which is precisely why every failure so far looked identical.

- [x] `GET /api/stream/status?magnet=…` → `{ state, progress, dlSpeed, etaSeconds, ready }`.
      Cheap: one `torrents/info` call, no file resolution, no probe.
- [x] `prepare` gains `readyState: 'downloading' | 'ready'`.
- [x] Player polls status every 2 s while waiting.
- [x] Buffering HUD renders the real figure.
- [x] Fake bar animation removed.
- [ ] ~~Load the stream URL exactly once, when `ready`~~ — deferred to Phase 2, which is where
      withholding the URL until complete actually belongs.

**Outcome** (`707d138` Vite, Phase 1 commit below):

- `/api/stream/status` returns `state`, `progress`, `progressPercent`, `dlSpeed`, `etaSeconds`,
  `seeds`, `peers`. An unresolved magnet reports `state: 'resolving'` rather than erroring, so the
  client can distinguish "waiting on metadata" from "downloading".
- **ETA is computed from `amount_left / dlspeed`, not passed through.** qBittorrent reports
  `eta: 8640000` as its "no estimate" sentinel; forwarding that would have rendered "~100 days left".
  Its own value is only used when it is present and below that sentinel.
- The HUD bar is now determinate, driven by real percentage. The pulsing animation survives as an
  opt-in `.is-indeterminate` class used *only* while waiting on swarm metadata — the one phase where
  progress genuinely is unknown.
- Polling starts the moment a source is chosen, stops on `playing`/`canplay`, and **restarts on
  `waiting`** — a mid-playback stall is a download problem again, so the numbers come back.
- Test coverage added to `session-lifecycle.test.mjs`, including the ETA-sentinel case. Suite is at
  **64 assertions**, all green.

Also folded in ahead of the phases (step 1 of the agreed order):

- **Vite adopted for the frontend** (`707d138`), vanilla — no framework change. HMR,
  `import.meta.env`, a real build step, and an opt-in `/bridge` dev proxy.
- TMDB / Prowlarr / bridge-URL credentials moved out of source into `.env.local`
  (see `.env.example`). **They remain in git history and should be rotated.**

---

### Phase 2 — Serve completed files simply

- [x] `REQUIRE_COMPLETE` (env, default **on**): `prepare` and `/api/stream` withhold delivery until
      `progress === 1`. Set `REQUIRE_COMPLETE=0` for the old progressive behaviour.
- [x] **Direct path:** plain `fs.createReadStream` + 206 ranges. No piece gating.
- [x] **Remux path:** FFmpeg reads the **local file path**; `-reconnect*` / `-seekable` dropped.
- [x] `/internal/piece-file` and `createPieceAwareTorrentStream` retained but unused on this path.

**Why the FFmpeg input change matters:** the loopback HTTP endpoint exists *only* so FFmpeg could
seek across piece-gated reads. Against a complete local file that indirection is pure overhead and
the source of the `Input/output error` / `Stream ends prematurely` noise.

**Outcome:**

- **Completeness is cached, not re-checked.** A torrent cannot become incomplete again, so once a
  hash is confirmed at 100 % it goes into `completedTorrents` and the check costs nothing for the
  rest of its life. Before that it is one `torrents/info` call per request.
- **An incomplete file is never probed.** `prepare` returns `readyState: 'downloading'` and exits
  before `ffprobe` runs. This removes the `probe unavailable → falling back on container extension`
  path entirely, which is what made every incomplete `.mkv` guess at its own codecs.
- **`/api/stream` refuses with `503 NOT_READY`** and includes `progressPercent`, so a client that
  requests too early gets a number rather than a hang.
- **The client parks and resumes.** `_resolveAndLoad()` is separated from `streamMagnet()`; when the
  bridge says `downloading`, the attempt is stored in `_pendingLoad` (tagged with the stream
  generation) and the Phase 1 status poller calls it back on completion. An abandoned source can
  never load over a newer one.
- **Native seeking now works.** Complete + direct means the browser issues its own range requests
  and the bridge answers them from a whole file. Seeking no longer restarts FFmpeg, re-resolves the
  torrent, or produces a new `/api/stream` request — which is what caused the pending-request
  pile-up and the churn that looked like "seeking re-downloads the file".

**Test coverage** — new `server/test/cache-first.test.mjs`, 16 assertions. The decisive one: the
mock reports **every piece as not-downloaded** while the torrent reports `progress: 1.0`. A
piece-aware read would block forever; the test asserts the bytes arrive, the sha256 matches, and
`pieceStates` is **never requested**. That is the only convincing proof the piece path is out of the
way rather than merely unlikely to trigger.

The three older suites now set `REQUIRE_COMPLETE=0` explicitly, since they exercise the progressive
path on purpose (piece gating, mid-download `.!qB` selection, progress reporting). Suite total:
**80 assertions**, all green.

---

### Phase 3 — Retention

- [ ] `IDLE_TTL_MINUTES=30`.
- [ ] Change eviction from "oldest idle" to **LRU by last playback**, so a rewatch does not force a
      re-download.
- [ ] Keep existing disk thresholds (85 % soft cap / 88 % aggressive GC / 95 % halt).
- [ ] Optional: a "pin" flag so a series you are mid-way through survives eviction.

**Outcome:** _(fill in when landed)_

---

### Phase 4 — Optional fast start *(only after Phase 2 is solid)*

Worth recording the insight even if we never build it:

> **With sequential download enabled, the download frontier is a single number.**

There is no need for per-read piece verification. Scan `pieceStates` once for the first non-`2`
index, cache it, derive `safeBytes`, and clamp every range to it. Refresh every few seconds.

That is roughly 40 lines, and it is the design the current ~400 lines of piece machinery should have
been. Note the one wrinkle: `firstLastPiecePrio` fetches tail pieces early, so
`progress × totalSize` **overestimates** the contiguous prefix — derive the frontier from the first
missing piece, not from `progress`.

**Outcome:** _(fill in when landed)_

---

### Phase 5 — Per-title transcode cache

*The single highest-leverage change available, and only possible because of cache-first.*

Today FFmpeg runs **per viewer**, producing byte-identical output every time. The source file is
complete and immutable, so the result is cacheable.

- [ ] After a download completes, if the release is not browser-native, transcode **once** to
      `<name>.web.mp4` (H.264 + AAC stereo, `+faststart` so `moov` sits at the front) beside the
      original.
- [ ] `prepare` prefers the `.web.mp4` when present and reports `mode: 'direct'` for it.
- [ ] Run transcodes through a small queue (concurrency ≈ cores − 2) so they cannot starve serving.
- [ ] Report transcode progress through the existing `/api/stream/status` shape, so the client's
      progress HUD covers "downloading" and "preparing" with no new UI.
- [ ] Evict the derived file with its source.

**What it changes:** CPU goes from `O(concurrent viewers)` to `O(distinct titles)`, and every viewer
gets a plain `fs.createReadStream` with **native seeking** — no FFmpeg in the playback path at all.
Remux is roughly 20–50× realtime, so a 2-hour film costs ~3–6 minutes of one core, once, ever.

This is what Plex and Jellyfin call an "optimized version". Progressive streaming cannot do it — you
cannot pre-transcode a file you do not yet have.

**Outcome:** _(fill in when landed)_

---

## 3. Open questions

### Torrents disappearing mid-download — UNRESOLVED

Reported: seeking (and sometimes idle playback) removes the file and restarts the download. Not yet
attributed. Cache-first *masks* this (far fewer re-resolutions) but does not fix a genuine cause.

`deleteTorrent()` now logs every call with its reason (`a955c7e`), which makes this decidable:

- A `[Delete] … reason: …` line appears → the bridge did it; fix that specific path.
- The torrent vanishes with **no** `[Delete]` line → the bridge is not responsible; investigate
  qBittorrent's own settings and log.

**Do not design around this until it is attributed.**

### Verify the deployed revision

Production logs showed neither `[Sequential]` nor `[Delete]` lines. Confirm the VPS is actually on
`a955c7e` or later before drawing conclusions from any further logs.

---

## 4. Known architectural limits (not bugs — do not "fix")

- **Seeking ahead of the download head cannot be made instant.** qBittorrent's WebUI API exposes no
  piece-level priority setter, so the bridge cannot make the download head jump. Under cache-first
  this stops mattering, since playback only starts once the file is whole.
- **HEVC / x265 cannot play in a browser.** Real-time HEVC→H.264 transcoding does not fit on this
  VPS, so it is off by default (`ALLOW_VIDEO_TRANSCODE=0`) and such releases are rejected with a
  clear `415` and flagged in the sources list.

---

## 5. Scaling notes — 200 concurrent viewers, all watching *different* titles

Recorded because the answer is counter-intuitive: **the torrent engine is not the constraint.**

Assumptions: 1080p WEB-DL, ~6 Mbps, ~3 GB average file. Current host: 8 cores, 32 GB RAM, 300 GB
free, 1 Gbps.

| Resource | Needed for 200 distinct | Available | Verdict |
|---|---|---|---|
| **Disk** (all 200 files resident) | ~600 GB | 300 GB | ✗ **2× short — binds first** |
| **Egress** (sustained) | 1.2 Gbps | 1 Gbps | ✗ |
| **Egress** (monthly, ~4 h/day peak) | ~65 TB | typically 2–32 TB included | ✗ |
| **CPU** — per-viewer remux (~5 % core each) | ~10 cores | 8 | ✗ marginal |
| **CPU** — with Phase 5 + `sendfile()` | < 1 core | 8 | ✓ |
| **RAM** | ~8 GB | 32 GB | ✓ comfortable |
| **Ingest** (600 GB @ 70 MB/s) | ~2.4 h | — | ✓ queues, does not block |

**Realistic ceiling on the current box: ~80 concurrent distinct titles, disk-bound.**

Note the shape of the failure: nothing here is fixed by changing torrent engine.
`torrent-stream` / `peerflix` / TorrServer optimise *time-to-first-frame on a cold title*, which
caching already solves, and they make CPU **worse** because a remux of a partial file cannot be
cached. They are the wrong lever for throughput.

### The all-different case is the worst case

With any popularity skew, 200 viewers might touch only 30–50 distinct titles, which fits. Cache-first
degrades gracefully here: **only the first viewer of a title waits**, everyone after starts instantly.
Progressive streaming has no equivalent property — every viewer independently drives piece requests.

### Order of upgrades, by value per pound

1. **Phase 5 (per-title transcode cache)** — free, removes the CPU wall entirely.
2. **Serve files from nginx/Caddy rather than Node** — kernel `sendfile()` zero-copy.
3. **More disk.** Network block storage is fine for video (sequential throughput matters, not IOPS).
   Hetzner Volumes are roughly 4–5× cheaper per GB than DigitalOcean / Vultr / Linode block storage.
4. **A dedicated server with local disks and unmetered transfer.** Hetzner's dedicated line
   (AX-series for CPU, SX-series for bulk storage) costs about the same as a mid VPS but includes
   unmetered 1 Gbps, which removes the egress *cost* problem outright. This is usually the biggest
   single step.
5. **Object storage + CDN** — the only thing that reaches 200 distinct properly. Transcode to HLS
   segments, push to object storage, let a CDN serve viewers. The origin then never serves video
   bytes, and local disk only needs the working set being transcoded rather than all 200 files.

   Egress pricing dominates the choice:
   - **Cloudflare R2** — **zero egress**, ~$0.015/GB/month storage. Best fit by a wide margin.
   - **Backblaze B2** — ~$0.006/GB/month, egress free to Cloudflare via the Bandwidth Alliance.
   - **Wasabi** — ~$0.007/GB/month, no egress fee but minimum-retention and fair-use terms apply.
   - **AWS S3 / GCS** — avoid for video; ~$0.09/GB egress makes them an order of magnitude worse.

   At R2 pricing, 600 GB of segments is roughly **$9/month with no egress charge** — against ~65 TB
   of VPS egress it is not a close comparison.

   *(Prices are indicative and change; verify before committing.)*

### Target architecture, if this is ever real

```
qBittorrent ─► download ─► transcode/segment ─► object storage (R2)
   (compute tier: VPS or dedicated)                    │
                                                       ▼
   API + playlists ◄──────────────────────────────  CDN ──► viewers
```

The compute tier sizes to *ingest and transcode rate*, not to viewer count. Viewer count is absorbed
by the CDN. Disk sizes to the transcode working set, not the catalogue.

Both steps here depend on complete files: you cannot pre-transcode or pre-segment media you do not
yet have. **Cache-first is the enabler for the entire scaling path.**

---

## 6. Change log

Append one entry per landed change. Newest first.

| Date | Commit | Phase | What changed |
|---|---|---|---|
| 2026-08-25 | _(this commit)_ | 2 | Cache-first delivery: `REQUIRE_COMPLETE`, plain file reads, FFmpeg on the local path, client parks until ready |
| 2026-08-25 | `573eec0` | 1 | `/api/stream/status`, `readyState` on prepare, determinate progress HUD with speed and ETA |
| 2026-08-25 | `707d138` | 0 | Vite adopted (vanilla); credentials moved to `.env.local` |
| 2026-08-25 | `a955c7e` | pre | Enforce sequential download on pre-existing torrents; log every torrent deletion with its reason; one FFmpeg per playback session |
| 2026-08-25 | `a236618` | pre | Drag-scrubbing no longer spawns an FFmpeg per mousemove; removed auto-resume; made player controls honest; `[Stream Start]` logs live download % |
| 2026-08-25 | `f6417b5` | pre | `piece_size` read from `/torrents/properties` instead of guessing 2 MB |
| 2026-08-25 | `f5652e9` | pre | Report unreadable download directories (`EACCES`) instead of "retry in a few seconds" |
| 2026-08-25 | `4a8469b` | pre | Auto-GC no longer wipes all torrents on restart; resume paused torrents during resolution |
| 2026-08-25 | `0cec5d5` | pre | Resolve media from the torrent file table rather than scanning disk (`.!qB` handling) |
| 2026-08-25 | `dd0b314` | pre | Initial piece-aware overhaul — see [project.md §9](../project.md) for the full 26-item catalogue |
