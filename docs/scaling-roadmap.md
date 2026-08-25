# Scaling Roadmap

> **Status:** Reference only — not scheduled. Revisit after the cache-first phases and the UI
> cleanup are done.
> **Target discussed:** 200 concurrent viewers, each watching a *different* title (the worst case).
> **Current host:** 8 cores · 32 GB RAM · 300 GB free · 1 Gbps

See [cache-first-streaming-plan.md](./cache-first-streaming-plan.md) for the work actually in
flight. This document is the longer-range picture.

---

## 1. The headline

**The torrent engine is not the constraint, and swapping it would not help.**

Every wall below is disk, egress bandwidth, or transcode CPU. `torrent-stream`, `peerflix` and
TorrServer optimise *time-to-first-frame on a cold title* — a metric caching already solves — and
they make CPU **worse**, because a remux of a partially-downloaded file cannot be cached and reused.

---

## 2. Where the current box runs out

Assumptions: 1080p WEB-DL, ~6 Mbps, ~3 GB average file, 200 distinct titles resident at once.

| Resource | Needed | Available | Verdict |
|---|---|---|---|
| **Disk** (all files resident) | ~600 GB | 300 GB | ✗ **2× short — binds first** |
| **Egress** (sustained) | 1.2 Gbps | 1 Gbps | ✗ |
| **Egress** (monthly, ~4 h/day peak) | ~65 TB | typically 2–32 TB included | ✗ |
| **CPU** — per-viewer remux (~5 % of a core each) | ~10 cores | 8 | ✗ marginal |
| **CPU** — with per-title transcode + `sendfile()` | < 1 core | 8 | ✓ |
| **RAM** | ~8 GB | 32 GB | ✓ comfortable |
| **Ingest** (600 GB @ 70 MB/s) | ~2.4 h | — | ✓ queues, does not block |

### Realistic ceiling today: ~80 concurrent distinct titles, disk-bound

Sanity checks on the other limits at that size: 80 × 6 Mbps ≈ 480 Mbps (fits 1 Gbps); 80 × 5 % ≈ 4
cores (fits 8). Disk is genuinely the first wall, and it is the one that fails hardest — cache-first
requires the *whole* file before playback, so 80 concurrent distinct titles means 80 whole files.

### "All different" is the pathological case

With any realistic popularity skew, 200 viewers might touch only 30–50 distinct titles, which fits
today. Cache-first degrades gracefully in that direction: **only the first viewer of a title waits**;
everyone after starts instantly against a warm cache. Progressive streaming has no equivalent
property, since every viewer independently drives piece requests.

---

## 3. Upgrade path, ordered by value per pound

### Step 1 — Per-title transcode cache *(free)*

Phase 5 of the cache-first plan. FFmpeg currently runs per viewer, producing byte-identical output
from an immutable file. Transcoding once per title moves CPU from `O(viewers)` to `O(titles)` and
removes FFmpeg from the playback path entirely.

**Do this before spending any money.** It removes the CPU wall outright.

### Step 2 — Serve files from nginx/Caddy, not Node *(free)*

Kernel `sendfile()` does zero-copy disk→socket. Node pipes bytes through userland. At 80+ concurrent
streams this is a real difference in CPU and memory bandwidth, and Caddy is likely on the box anyway
for TLS.

Keep Node for the API; let the web server handle `/media/*`.

### Step 3 — More disk

Network block storage is fine for video: sequential throughput matters, IOPS does not.

| Provider | Approx. $/GB/month | Note |
|---|---|---|
| Hetzner Volumes | ~€0.044 | 4–5× cheaper than the others |
| DigitalOcean / Vultr / Linode | ~$0.10 | convenient if already there |

1 TB takes the ceiling from ~80 to ~300 concurrent distinct titles, at which point **egress becomes
the wall instead**.

### Step 4 — Dedicated server with unmetered transfer

Usually **the single biggest step**, because it deletes the egress *cost* problem rather than
mitigating it. Hetzner's dedicated line sits around mid-VPS pricing:

- **AX-series** — Ryzen, NVMe. Best when transcode throughput is the limit.
- **SX-series** — bulk HDD (tens of TB) plus NVMe cache. Best when catalogue size is the limit.

Both include unmetered 1 Gbps under fair use. Compare against ~65 TB/month of metered VPS egress
before dismissing the price.

### Step 5 — Object storage + CDN

The only thing that reaches 200 distinct properly, because it moves video bytes **off the origin
entirely**.

```
qBittorrent ─► download ─► transcode + segment (HLS) ─► object storage
        (compute tier)                                        │
                                                              ▼
        API + playlists ◄─────────────────────────────────── CDN ──► viewers
```

After this, the compute tier sizes to **ingest and transcode rate**, not viewer count — viewers are
absorbed by the CDN. Local disk sizes to the **transcode working set**, not the catalogue.

Egress pricing dominates the provider choice:

| Provider | Storage $/GB/mo | Egress | Verdict |
|---|---|---|---|
| **Cloudflare R2** | ~$0.015 | **$0** | Best fit by a wide margin |
| **Backblaze B2** | ~$0.006 | free to Cloudflare (Bandwidth Alliance) | Cheapest storage |
| Wasabi | ~$0.007 | $0, but minimum-retention + fair-use terms | Read the terms |
| AWS S3 / GCS | ~$0.023 | **~$0.09/GB** | Avoid for video — an order of magnitude worse |

600 GB of segments on R2 is roughly **$9/month with no egress charge**, against ~65 TB of metered
VPS egress. Not a close comparison.

*(All prices indicative and subject to change — verify before committing.)*

---

## 4. Why every step depends on cache-first

Steps 1 and 5 both require **complete files**:

- You cannot pre-transcode media you do not have yet.
- You cannot pre-segment media you do not have yet.

Progressive piece-aware streaming forecloses both. Cache-first is not merely the fix for the current
bugs — it is the precondition for the entire scaling path.

---

## 5. Things that will need attention before any of this is real

Recorded so they are not discovered late:

- **Authentication.** The bridge currently has no auth on `/api/stream` or `/api/search`. Anyone who
  knows the host can use it. Multi-user means real accounts, per-user rate limits and quotas.
- **HTTPS end-to-end.** Credentials over plain HTTP cross the network in the clear. Needed the
  moment there is a login.
- **Per-user concurrency limits.** `MAX_CONCURRENT_STREAMS` is global; it would need to be per
  account to stop one user consuming the box.
- **Disk quota fairness.** LRU eviction (Phase 3) is global. With many users, one person queuing a
  large catalogue would evict everyone else's cache.
- **Legal and hosting exposure.** A multi-user public service distributing torrented media is a
  materially different proposition from a personal one, and most hosts' terms address it directly.
  Worth resolving before, not after, the engineering.
