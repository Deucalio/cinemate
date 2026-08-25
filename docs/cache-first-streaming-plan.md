# Cache-First Streaming — Implementation Plan & Change Log

> **Status:** Phase 0 (approved, not started)
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

- [ ] `GET /api/stream/status?magnet=…` → `{ state, progress, dlSpeed, etaSeconds, ready }`.
      Cheap: one `torrents/info` call, no file resolution, no probe.
- [ ] `prepare` gains `readyState: 'downloading' | 'ready'` and stops being the blocking step.
- [ ] Player polls status every 2 s while waiting.
- [ ] Buffering HUD renders the real figure: `Downloading 42% · 71 MB/s · ~40s remaining`.
      Same element, truthful contents; delete the fake bar animation.
- [ ] Load the stream URL exactly once, when `ready`.

**Outcome:** _(fill in when landed)_

---

### Phase 2 — Serve completed files simply

- [ ] `REQUIRE_COMPLETE=1` (env, default on): `prepare` withholds the stream URL until
      `progress === 1`.
- [ ] **Direct path:** plain `fs.createReadStream` + 206 ranges. No piece gating.
- [ ] **Remux path:** FFmpeg reads the **local file path** (`-i /path/file.mkv`), not the loopback
      HTTP URL. `-ss` becomes instant and frame-accurate. Drop `-reconnect*` and `-seekable`.
- [ ] Keep `/internal/piece-file` and `createPieceAwareTorrentStream` in the tree but unused on this
      path, behind the flag, so Phase 4 can revive them.

**Why the FFmpeg input change matters:** the loopback HTTP endpoint exists *only* so FFmpeg could
seek across piece-gated reads. Against a complete local file that indirection is pure overhead and
the source of the `Input/output error` / `Stream ends prematurely` noise.

**Outcome:** _(fill in when landed)_

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

## 5. Change log

Append one entry per landed change. Newest first.

| Date | Commit | Phase | What changed |
|---|---|---|---|
| 2026-08-25 | `a955c7e` | pre | Enforce sequential download on pre-existing torrents; log every torrent deletion with its reason; one FFmpeg per playback session |
| 2026-08-25 | `a236618` | pre | Drag-scrubbing no longer spawns an FFmpeg per mousemove; removed auto-resume; made player controls honest; `[Stream Start]` logs live download % |
| 2026-08-25 | `f6417b5` | pre | `piece_size` read from `/torrents/properties` instead of guessing 2 MB |
| 2026-08-25 | `f5652e9` | pre | Report unreadable download directories (`EACCES`) instead of "retry in a few seconds" |
| 2026-08-25 | `4a8469b` | pre | Auto-GC no longer wipes all torrents on restart; resume paused torrents during resolution |
| 2026-08-25 | `0cec5d5` | pre | Resolve media from the torrent file table rather than scanning disk (`.!qB` handling) |
| 2026-08-25 | `dd0b314` | pre | Initial piece-aware overhaul — see [project.md §9](../project.md) for the full 26-item catalogue |
