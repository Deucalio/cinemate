# Stream Platform — Status Report

TV-series streaming platform. Control plane on a VPS, media in Cloudflare R2,
automated acquisition via Sonarr/Prowlarr/qBittorrent, adaptive HLS delivery.

**Report date:** end of Phase 1D
**Status:** 1A, 1B, 1C, 1D complete and verified. 1E next.

---

## 1. Executive summary

Four of eleven Phase 1 subphases are complete. The system currently:

- runs six isolated services on a shared production host, all loopback-bound,
  without disrupting the company services already on that machine
- stores media in Cloudflare R2 through the standard S3 API, with source and
  playback content in separate buckets
- refuses to ingest any content that lacks a licence record, enforced by a
  database constraint rather than convention
- **automatically acquires TV episodes end to end** — verified with a real
  1.12 GiB download that flowed from indexer discovery through to a queued
  transcode job with no manual intervention

What it cannot yet do: transcode, package, or play anything. Those are 1E–1I.

---

## 2. Host context and constraints

The platform was deployed onto an existing Ubuntu 22.04 production server
already running company workloads:

| Existing service | Port | Status after deployment |
|---|---|---|
| nginx (11 vhosts) | 80, 443 | untouched |
| PostgreSQL 14 `main` | 5432 | untouched |
| Redis 7.4.1 | 6379 | untouched, never restarted by us |
| pgbouncer | 6432 | untouched |
| gunicorn ×5 | 5000–5014 | untouched |
| Node apps ×6 | 3000–4100, 8080 | untouched |
| Postfix, SSH, xrdp, Cockpit | 25, 22, 3389, 9090 | untouched |

This constraint shaped nearly every technical decision below.

### Isolation strategy

| Concern | Approach | Rationale |
|---|---|---|
| Database | separate PostgreSQL **cluster** on 5433 | a database inside the existing cluster would share WAL, checkpointer, connection slots and backups; a runaway query would hit company APIs |
| Queue | separate Redis on a **unix socket** | another app's `FLUSHALL` or eviction policy would silently destroy queued jobs |
| Python | isolated venv at `/opt/stream/venv` | verified system Python still cannot import `boto3` |
| Web | new nginx vhost, `reload` not `restart` | existing sites never edited or interrupted |
| Containers | **none** | Docker rewrites iptables and creates bridge networks; too risky on a live host |
| CPU/IO | `Nice`, `CPUQuota`, `IOWeight`, `MemoryMax` on every unit | transcoding and downloads must not starve production services |
| Network | every service binds `127.0.0.1` | nothing new publicly reachable |

### Incidents

**needrestart service bounce.** Installing `postgresql-client` triggered
Ubuntu's needrestart hook, which restarted nginx, PostgreSQL, Redis, pgbouncer,
xrdp and the gunicorn apps unattended. All recovered; no data loss. The
`apt-get -s` simulation had correctly predicted no upgrades — needrestart acts
after installation and is independent of that. All subsequent installs use
`NEEDRESTART_MODE=l`, which lists affected services instead of restarting them.
Worth adopting for the company's routine patching too.

**Disabled Redis repository.** `packages.redis.io` returned HTTP 403, blocking
`apt-get update`. The repo was disabled to proceed. Redis is now potentially
orphaned from security updates; the redislabs PPA may cover it, but this needs
verifying.

---

## 3. Running services

| Service | Bind | Nice | CPUQuota | MemoryMax | Purpose |
|---|---|---|---|---|---|
| `stream-api` | 127.0.0.1:18000 | 0 | 100% | 1G | catalog, ingest, playback auth |
| `stream-worker` | — | 10 | 200% | 4G | transcoding (stub until 1E) |
| `stream-redis` | `/run/stream/redis.sock` | 0 | — | 512M | job queue |
| `stream-sonarr` | 127.0.0.1:8989 | 5 | 100% | 1G | series monitoring, import |
| `stream-download` | 127.0.0.1:18080 | 15 | 100% | 2G | qBittorrent |
| `stream-prowlarr` | 127.0.0.1:9696 | 10 | 50% | 512M | indexer management |
| `postgresql@14-stream` | 127.0.0.1:5433 | — | — | — | catalog database |

All units carry `ProtectSystem=strict`, `NoNewPrivileges`, empty
`CapabilityBoundingSet`, and explicit `ReadWritePaths`.

Admin UIs are reached only by SSH tunnel:

```
ssh -o ServerAliveInterval=60 \
    -L 8989:127.0.0.1:8989 -L 18080:127.0.0.1:18080 -L 9696:127.0.0.1:9696 \
    <user>@<host>
```

---

## 4. Phase 1A — Infrastructure

**Delivered:** PostgreSQL 14 cluster `stream` on 5433 (`shared_buffers=256MB`,
`max_connections=50`, loopback only). Dedicated Redis on a unix socket with
`noeviction` and AOF persistence, and `FLUSHALL`/`FLUSHDB`/`CONFIG` renamed
away. Service account `streamsvc` (uid 998, nologin). Python 3.10 venv. Four
hardened systemd units plus a grouping target. tmpfiles rule so
`/run/stream` survives reboot.

**Notable decisions.** Docker was abandoned mid-plan in favour of native
systemd, specifically to avoid iptables rewriting on a live host. PostgreSQL 16
was originally specified; the host runs 14, and an audit of all migrations
confirmed nothing required anything past PG 13, so 14 was used.

**Verified:** both clusters online on separate ports; existing Redis process
uptime unchanged; only two new loopback listeners; all company services active.

---

## 5. Phase 1B — Schema and storage

**Delivered:** migrations 001–008 — catalog (titles/seasons/episodes),
licensing (`licenses` + `license_provider_grants`), providers +
`asset_sources`, assets + renditions + audio tracks + subtitles, ingest jobs
and origins, playback tables. Storage abstraction in `shared/storage/` with a
`StorageBackend` ABC, `S3Backend`, canonical key layout, and cache-control
policy. Cloudflare R2 registered as the single provider `r2-primary`.

**Notable decisions.**

*Two buckets, not two prefixes.* A prefix inside one bucket cannot be excluded
from a public custom domain. `stream-mezzanine` (private sources) and
`stream-media` (CDN-facing output) are separate buckets, and the application
refuses to start if they are equal.

*S3-compatibility as the boundary, not R2.* No Cloudflare-specific construct
appears in the code path. Switching backends is an environment change.

*R2 checksum compatibility.* boto3 ≥ 1.36 sends CRC32 headers that R2 rejects;
the client sets `request_checksum_calculation="when_required"` with a
`TypeError` fallback for older botocore.

*Rights as a first-class table.* `licenses` and `license_provider_grants`
encode not just "you may distribute" but "from these origins".

**Verified:** nine storage checks passed — bucket distinctness, reachability,
write, read-back, list, s3v4 presigned GET, mezzanine isolation, cache-control
policy, cleanup.

---

## 6. Phase 1C — Ingestion

**Delivered:** migration 009 (TV-only constraints, `acquisition_state`
lifecycle, `acquisition_sources` registry). `POST /api/ingest` — the canonical
contract. Catalog write endpoints. Redis Streams consumer group. Direct-upload
client script.

**Notable decisions.**

*One contract, three producers.* Direct upload, watch folder, and partner
delivery all converge on `/api/ingest`. Nothing downstream branches on which.

*Episode targeting by natural key.* `tvdb_id + season + episode` is what any TV
acquisition source can supply without knowing internal UUIDs. This is what
makes the acquisition layer swappable.

*Two-layer idempotency.* A unique index on
`(acquisition_source_id, external_ref)` catches replayed webhooks; an
existing-`ready`-asset check catches re-delivery. Both return the original
asset. Essential once automation is driving ingestion, since webhooks retry.

*Streams over lists.* A worker dying mid-job leaves its message in the pending
list, reclaimable rather than lost. PostgreSQL remains the source of truth.

*Presigned multipart upload.* Bytes go client-direct to R2; the control plane
handles only JSON.

**Verified:** invalid licence → 422 with no asset created. 42 MB file uploaded
with host disk flat throughout. Identical re-run returned `idempotent_replay`
with no second asset and no queue growth.

---

## 7. Phase 1D — Acquisition

The largest phase, and the one with the most iteration.

### Architecture

```
OPERATOR SIDE                        |  PLATFORM BOUNDARY
  authorized indexer                 |
        |                            |
  Prowlarr    :9696  indexer mgmt    |
        |  fullSync via API          |
  Sonarr      :8989  monitoring      |
        |  drives                    |
  qBittorrent :18080 downloading     |
        |                            |
  /var/lib/stream/incoming           |
        |  On Import webhook         |
        +----------------------------+--> POST /hooks/sonarr
                                     |         |
                                     |    POST /api/ingest
                                     |    (canonical boundary)
```

### The boundary

| Sonarr does | Sonarr does not |
|---|---|
| monitor series, decide grabs | touch PostgreSQL |
| drive the download client | touch Redis |
| rename and organise | touch R2 |
| fire a webhook | participate in playback, catalog, or search |

Prowlarr and qBittorrent never cross the boundary at all. No platform code
imports them; no table references them. Removing Prowlarr requires no platform
change. Removing Sonarr means deleting one adapter file and one router import.

### Delivered

Migration 010 (`sonarr_series_id`, `default_license_id`,
`acquisition_events`). Sonarr, Prowlarr and qBittorrent as hardened systemd
units. Idempotent provisioning script for root folder, naming and webhook.
Prowlarr↔Sonarr link script with `syncLevel=fullSync` and TV-only category
filtering. The `/hooks/sonarr` adapter with episode matching, idempotency and
state transitions. Series onboarding endpoint. `/api/acquisition/status` which
reports indexer and client presence without ever returning URLs or keys.

### Notable decisions

*`titles.default_license_id`.* Automated acquisition has no human in the loop
to choose a licence, so the series carries one from onboarding. The webhook
returns 422 rather than ingesting without it. This is what keeps the licence
constraint meaningful under automation.

*`acquisition_events` logs everything.* Every webhook is recorded with its
outcome (`ingested`, `replayed`, `skipped`, `unmatched`, `no_license`, `error`)
and its raw payload. This proved its worth immediately — the adapter bug in
section 7.1 was diagnosed from stored payloads rather than guesswork.

*Prowlarr included despite a single indexer.* Not required, but it decouples
indexer management from Sonarr. Adding a second licensed endpoint later is one
entry in Prowlarr rather than a change to Sonarr's config and the docs.

*Port choices.* qBittorrent's default 8080 collides with an existing Node
service, so its WebUI runs on 18080. All install scripts refuse to run on a
port collision and stop the service if a post-start bind check finds anything
other than loopback.

### 7.1 Problems encountered

**`socket_keepalive` on a unix socket.** redis-py's
`UnixDomainSocketConnection` rejects this TCP-only option, crashing API
startup. Compounded by systemd reporting `active (running)` because uvicorn's
master process survives a failed startup hook — so `is-active` gave a false
pass. `deploy_update.sh` now polls `/healthz` for 20 seconds and dumps the
error log on failure. The fix was initially applied to `/opt/stream` only and
was overwritten by the next deploy; source-tree edits are now the rule.

**Docker-era path in `check_s3.py`.** Hard-coded `/app`; changed to resolve
relative to the script location.

**Manual scripts have no environment.** systemd loads
`/etc/stream/stream.env` for services, but hand-run scripts do not inherit it.
Standard wrapper documented.

**Sonarr auth lock-out.** The generated `config.xml` enabled Forms
authentication before any user existed, producing an unsatisfiable login page.
Same issue recurred with Prowlarr. Resolved by disabling auth, creating the
account, re-enabling.

**`ProtectSystem=strict` and staging paths.** A staging directory created
outside Sonarr's `ReadWritePaths` was invisible to the service, which reported
"folder doesn't exist" while it was plainly present. Moved inside `incoming`.

**Scan versus import.** A file discovered by disk scan raises
`EpisodeFileAddedEvent`, which does not fire notifications; only
`EpisodeImportedEvent` does. Several attempts failed for this reason before
switching to a real download.

**Payload shape varies by event type.** `Download` carries a single
`episodeFile` object; `ImportComplete` carries an `episodeFiles` array. The
adapter read only the former, producing spurious `unmatched` outcomes. Patch
written; idempotency meant no functional impact.

### 7.2 Content licensing

Three attempts were made to test with commercial series (*Lanterns*,
*The Decameron*, and a 1980 BBC adaptation incorrectly assumed public domain
because its source novel is). None were licensed for this platform, and one was
onboarded with a Creative Commons `document_uri` that did not apply to it —
which inverts the purpose of the licence field, since `ingest_origins` exists
precisely to be the evidence that content was authorized. That record was
removed.

Testing proceeded with **Pioneer One** (2010), released under CC BY-NC-SA and
distributed by its creators for free redistribution. It is a genuine test of
the pipeline and carries a licence URL that actually applies.

**Open question.** The platform's design assumes licensed content. No licensing
arrangement is currently in place for anything beyond CC and public-domain
material. This is a commercial prerequisite, not a technical one, and it gates
any real use of the system.

### 7.3 Verified end to end

A complete automated acquisition, with no manual step:

```
Prowlarr search       ->  release found
Sonarr grab decision  ->  sent to qBittorrent 23:54:58
qBittorrent           ->  1.12 GiB into incoming/tv-stream/
Sonarr import         ->  renamed to Pioneer One/Season 01/... .mkv
On Import webhook     ->  POST /hooks/sonarr
adapter               ->  tvdb 170551 + S01E01 matched
licence gate          ->  default_license_id satisfied
POST /api/ingest      ->  asset 792914dc-... created
acquisition_state     ->  wanted -> acquired -> ingesting
job                   ->  queued
```

`acquisition_events` id 21: `outcome: ingested`. Sonarr held no database,
Redis, or R2 credentials at any point.

---

## 8. Current state

**Database:** 10 migrations. One series (Pioneer One, tvdb 170551), one season,
one episode, one licence (CC BY-NC-SA), one provider (`r2-primary`), three
acquisition sources, 22 acquisition events.

**Storage:** R2 verified. One 42 MB test mezzanine from 1C. The Pioneer One
file is still on local disk — the worker uploads it in 1E.

**Queue:** three messages. One valid (Pioneer One), one for the 42 MB test
file, one orphaned by a deleted asset.

**Disk:** ~3 GB in `incoming`, mostly the episode plus leftover test files.
317 GB free.

---

## 9. Next: Phase 1E — Worker and transcode

**Build.** `XREADGROUP` claim loop with `SELECT … FOR UPDATE SKIP LOCKED`,
heartbeats and stale-claim reclaim. For `local_path` jobs: upload the source to
the R2 mezzanine bucket, then optionally remove the local copy. For all jobs:
stream the mezzanine to scratch, `ffprobe`, encode the ABR ladder, wipe scratch
in a `finally` block.

**Ladder:** 240/360/480/720/1080 at 400/800/1400/3000/5000 kbps, capped at
source height. Pioneer One is 720p, so four rungs.

**Keyframe alignment** is the critical detail: `-g 96 -keyint_min 96
-sc_threshold 0 -force_key_frames expr:gte(t,n_forced*4)`. Without aligned IDR
frames across renditions, adaptive bitrate switching stutters or fails
outright. This is the most common cause of "it plays but quality switching is
broken".

**Acceptance:** job walks `queued → downloading → probing → transcoding`.
Scratch present during, absent after. A 720p source yields four rungs, not
five. Worker killed mid-job → job requeued, scratch swept on restart.
`CPUQuota=200%` observed under load; host stays responsive.

### Decisions needed before implementation

1. Delete the local mezzanine after upload to R2? (recommended: yes — the VPS
   is a control plane, not a warehouse)
2. Ladder rungs as specified, or different?
3. Concurrency 1, or allow 2?
4. Clear the two stale queue entries so Pioneer One is the single clean test?

---

## 10. Remaining Phase 1

| Phase | Delivers | Category |
|---|---|---|
| 1E | worker loop, ffmpeg ABR ladder | media |
| 1F | CMAF packaging, HLS/DASH manifests, `asset_sources` | media |
| 1G | playback authorization, signed URLs | API |
| 1H | CDN in front of the media bucket | infrastructure |
| 1I | hls.js test player | UI (harness) |
| 1J | catalog read + search API | API |
| 1K | web app: search → show → episode → Play | UI (product) |

**First usable product: 1K.** 1I proves playback works but is a test page with
a hardcoded asset ID, not something a person can operate.

---

## 11. Outstanding operational items

**Security**

- Rotate the R2 API token, the three application secrets, and the PostgreSQL
  password. All were exposed in a chat transcript during setup. Do this before
  any real content is stored.
- Verify Redis is still receiving security updates after the
  `packages.redis.io` repository was disabled.
- Unrelated but significant: PostgreSQL (5432), pgbouncer (6432) and several
  gunicorn workers on this host are bound to `0.0.0.0` with no firewall. Worth
  raising with whoever owns the server.

**Reliability**

- Log rotation for `/var/log/stream` — currently unbounded.
- Hourly disk check. A stuck transcode filling `/` is the one failure mode that
  could take down the neighbouring production PostgreSQL.
- `pg_dump` cron for the `stream` cluster — not covered by whatever backs up
  5432.

**Configuration**

- Apply the `episodeFiles` adapter patch.
- Trim Sonarr notification triggers to On File Import, On Import Complete, On
  File Upgrade. `Health` and `Grab` events are noise.
- Move qBittorrent downloads out of Sonarr's root folder — Sonarr's own health
  check flags this and it will cause odd scan behaviour eventually.
- Domain and TLS. `SITE_DOMAIN=stream.local` is a placeholder; the nginx vhost
  is not installed.

**Commercial**

- Content licensing. The platform enforces licence records structurally, but no
  arrangement exists for anything beyond CC and public-domain material.

---

## 12. Conventions

- Source tree: `~/projects/stream-platform`. Runtime: `/opt/stream`. Deploy
  with `sudo bash scripts/deploy_update.sh` — never patch `/opt/stream`
  directly, it is overwritten on every deploy.
- `/opt/stream` is `750 root:streamsvc`; use `sudo` or `sudo -u streamsvc`.
- Manual scripts need the environment loaded:
  `sudo bash -c 'set -a; . /etc/stream/stream.env; set +a; exec runuser -u streamsvc -- <cmd>'`
- Migrations are forward-only and recorded in `schema_migrations`.
  `migrate.sh` refuses to run unless the target database is named `stream`.
- Rollback: `sudo bash scripts/uninstall.sh [--purge]`.
