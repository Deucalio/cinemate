# Cache-First Streaming — Implementation Plan & Change Log

> **Status:** Phases 0–3 complete · Phase 4 not recommended · Phase 5 superseded by [Phase 5′](./phase5-hls-plan.md)
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

- [x] `IDLE_TTL_MINUTES` default raised from **1** to **30**.
- [x] Eviction changed from "oldest idle" to **LRU by last playback**.
- [x] Disk thresholds kept and completed: 85 % soft cap · 88 % evict · 80 % target · 95 % halt.
- [x] Pin flag, admin-gated, persisted.
- [x] LRU state survives restarts.

**Outcome:**

- **Eviction is incremental.** The old policy deleted *every* idle torrent the instant the disk
  crossed 88 %, discarding the whole cache — including titles about to be rewatched — to reclaim
  space one or two files would have covered. Now the least-recently-played torrent is evicted one at
  a time, stopping as soon as usage is back under `DISK_TARGET_PCT` (80 %). If it runs out of
  evictable candidates it says so rather than failing silently.
- **The 95 % emergency halt now exists.** It was documented in project.md §7 but never implemented.
  Above `DISK_EMERGENCY_PCT` all *downloading* torrents are paused, protecting the host's other
  services. Seeding and playback of completed files continue.
- **LRU state persists** to `server/.cache/torrent-lru.json` and is restored at boot. Without it,
  every deploy reset the eviction order and a rewatch after a restart re-downloaded a file that was
  still sitting on disk.
- **"In use" and "protected from eviction" are separate predicates.** Conflating them made a pinned
  but idle torrent report as `inUse: true`, which is both wrong and actively misleading when
  deciding what to unpin. Pinning also no longer refreshes the idle clock — otherwise unpinning
  would silently grant a full extra TTL window.
- **New `GET /api/cache`** lists what is cached, sorted so that eviction order is the reverse of the
  listing, with `pinned` / `inUse` / `idleMinutes` per entry and the active thresholds.
- **New `POST /api/torrent/pin`** (admin token) pins or unpins; the state is persisted immediately.

**Test coverage** — new `server/test/lru-eviction.test.mjs`, 14 assertions, using a
`DISK_USAGE_OVERRIDE_PCT` test seam so the policy can be exercised without filling a real volume.
Asserts eviction order (COLD → WARM → RECENT), that pinned survives, that the reason is logged, and
that restart-restored history is honoured.

**Caught by the suite:** persisting LRU state to a shared default path made the *tests*
non-hermetic — they inherited playback history from previous runs, so torrents looked long-idle and
were evicted. Every suite now points `LRU_STATE_PATH` at its own temp directory.

Suite total: **96 assertions across 6 suites**, all green.

---

### Phase 4 — Optional fast start — NOT STARTED, and probably should not be

**Recommendation: leave this unbuilt.** It reintroduces exactly the piece-gating complexity Phase 2
removed, to save roughly 60 seconds on a host that downloads at 12–70 MB/s. Phase 5 delivers a
better experience than partial-file playback can. Revisit only if waiting becomes a real complaint —
for example if 8 GB 4K releases off thin swarms become normal.

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

### Phase 5 — Per-title transcode cache — SUPERSEDED

> Replaced by **[Phase 5′ — Progressive HLS](./phase5-hls-plan.md)**, which delivers everything
> below *and* removes the cold-start wait. Building the MP4 version first would mean doing the same
> work twice. The reasoning here is kept because it still explains why per-title transcoding is the
> right shape.

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

### Torrents disappearing mid-download — RESOLVED (2026-08-25)

**Cause: a Sonarr/Radarr stack sharing this qBittorrent instance.**

Established by elimination, in order:

1. qBittorrent's own log said `'<torrent>' was removed from the transfer list and hard disk` — its
   exact wording for an API delete with `deleteFiles=true`. So nothing was lost or reset; something
   *asked* for the deletion.
2. Zero `error`/`fail` lines in that log, so it was not a failed move or a disk problem.
3. The bridge logged nothing at those timestamps. Every deletion path logs `[Delete] … reason: …`
   (added in `a955c7e`) precisely so this question could be answered rather than argued.
4. No stray bridge process — the two unexplained `node index.js` processes on the host resolved to
   unrelated backends.
5. `[AutoRun]` was empty, ruling out a completion script.
6. `stream-download.service` carries `Documentation=file:///opt/stream/SONARR-SETUP.md`, and the
   download directory contained `Lanterns - S01E01 - Pilot.mkv` and `Stand by Me (1986)/` —
   Sonarr and Radarr naming conventions, not release names.

\*arr **Completed Download Handling** imports a finished download into the library and then removes
the torrent and its data from the client. That fires the moment a download completes, which is
exactly when playback was starting.

**Fix:** torrents are now added under their own qBittorrent category (`QBT_CATEGORY`, default
`cinemate`). \*arr tools only manage their configured category. The bridge also warns once when it
finds a torrent under a foreign category, since that means something else may be managing it.

**Better long-term fix:** give the bridge its own qBittorrent instance — runbook in
[dedicated-qbittorrent.md](./dedicated-qbittorrent.md). Sharing one means another
tool's retention policy can delete files mid-stream, our `filePrio` and sequential toggles alter its
torrents, and `MAX_ACTIVE_TORRENTS` counts torrents we do not own. See
[scaling-roadmap.md](./scaling-roadmap.md).

**Lesson worth keeping:** four wrong theories preceded the right one (ratio-limit removal, a failed
move-on-completion, our own `filePrio` calls, a stale bridge process). What settled it was making
the bridge log every deletion with a reason, then reading the *other* system's log. Neither of those
is guesswork.

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

## 5. Scaling

Moved to its own document: **[scaling-roadmap.md](./scaling-roadmap.md)**.

Short version — for 200 concurrent viewers each watching a *different* title, the current box binds
on **disk** first (~80 titles), then egress, then per-viewer remux CPU. None of those are fixed by
changing torrent engine, and Phase 5 removes the CPU wall for free.

---

## 6. Change log

Append one entry per landed change. Newest first.

| Date | Commit | Phase | What changed |
|---|---|---|---|
| 2026-08-25 | _(this commit)_ | 3 | LRU eviction by last playback, 30 m TTL, 95 % emergency halt, pin flag, persisted LRU state, `/api/cache` |
| 2026-08-25 | `6d59a1d` | 2 | Cache-first delivery: `REQUIRE_COMPLETE`, plain file reads, FFmpeg on the local path, client parks until ready |
| 2026-08-25 | `573eec0` | 1 | `/api/stream/status`, `readyState` on prepare, determinate progress HUD with speed and ETA |
| 2026-08-25 | `707d138` | 0 | Vite adopted (vanilla); credentials moved to `.env.local` |
| 2026-08-25 | `a955c7e` | pre | Enforce sequential download on pre-existing torrents; log every torrent deletion with its reason; one FFmpeg per playback session |
| 2026-08-25 | `a236618` | pre | Drag-scrubbing no longer spawns an FFmpeg per mousemove; removed auto-resume; made player controls honest; `[Stream Start]` logs live download % |
| 2026-08-25 | `f6417b5` | pre | `piece_size` read from `/torrents/properties` instead of guessing 2 MB |
| 2026-08-25 | `f5652e9` | pre | Report unreadable download directories (`EACCES`) instead of "retry in a few seconds" |
| 2026-08-25 | `4a8469b` | pre | Auto-GC no longer wipes all torrents on restart; resume paused torrents during resolution |
| 2026-08-25 | `0cec5d5` | pre | Resolve media from the torrent file table rather than scanning disk (`.!qB` handling) |
| 2026-08-25 | `dd0b314` | pre | Initial piece-aware overhaul — see [project.md §9](../project.md) for the full 26-item catalogue |
