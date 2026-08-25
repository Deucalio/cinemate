# Runbook: Give CineStream Its Own qBittorrent

> **Why:** the bridge currently shares `stream-download.service` with a Sonarr/Radarr stack. That
> stack's *Completed Download Handling* imports finished downloads and then removes the torrent and
> its data, which is what deleted files mid-playback (see
> [cache-first-streaming-plan.md §3](./cache-first-streaming-plan.md)).
>
> The `QBT_CATEGORY` fix stops \*arr claiming our torrents. This removes the shared-instance problem
> altogether.
>
> **Time:** ~30 minutes. **Reversible:** yes — see Rollback.

---

## What sharing costs us

| Problem | Consequence |
|---|---|
| \*arr retention policy | Deletes our files mid-stream |
| Our `sequentialDownload` / `firstLastPiecePrio` toggles | Change *their* torrents' download behaviour |
| Our `filePrio` calls | Deprioritise files in torrents we do not own |
| `MAX_ACTIVE_TORRENTS` | Counts torrents belonging to another service |
| Storage owned by `streamsvc` | Requires the ACL workaround; blocks Phase 5 writing derived files |

---

## 1. Storage owned by the bridge user

The bridge runs under pm2 as `rdpuser`. Running its qBittorrent as the **same user** removes every
permission problem — no ACLs, no group juggling, and Phase 5 can write `.web.mp4` files freely.

```bash
sudo mkdir -p /var/lib/cinemate/qbt /var/lib/cinemate/downloads/.incomplete
sudo chown -R rdpuser:rdpuser /var/lib/cinemate
sudo mkdir -p /var/log/cinemate && sudo chown rdpuser:rdpuser /var/log/cinemate
```

*(If you would rather keep a dedicated service account, create `cinemate:cinemate`, run the unit as
that user, and add `rdpuser` to the `cinemate` group. It is more hardened and more setup — the ACL
lesson from `/var/lib/stream` applies.)*

## 2. Write the config before first launch

Setting this up front avoids the first-run password dance and gets the settings right immediately.
**Port 18081**, bound to loopback only.

```bash
mkdir -p /var/lib/cinemate/qbt/qBittorrent/config
cat > /var/lib/cinemate/qbt/qBittorrent/config/qBittorrent.conf <<'CONF'
[BitTorrent]
Session\DefaultSavePath=/var/lib/cinemate/downloads
Session\TempPath=/var/lib/cinemate/downloads/.incomplete
Session\TempPathEnabled=true
Session\Preallocation=false
Session\QueueingSystemEnabled=false
Session\GlobalMaxRatio=-1
Session\MaxRatioAction=0
Session\DHTEnabled=true
Session\PeXEnabled=true
Session\LSDEnabled=true

[Preferences]
WebUI\Address=127.0.0.1
WebUI\Port=18081
WebUI\LocalHostAuth=false
WebUI\CSRFProtection=false
WebUI\HostHeaderValidation=false
Downloads\SavePath=/var/lib/cinemate/downloads
Downloads\TempPath=/var/lib/cinemate/downloads/.incomplete
Downloads\TempPathEnabled=true
Downloads\PreAllocation=false
CONF
```

Notes on the choices:

- **`QueueingSystemEnabled=false`** — queueing is what put torrents in `queuedDL` and stalled
  streaming on the shared instance.
- **`MaxRatioAction=0`** — Pause, never remove. Deletion is the bridge's decision, nobody else's.
- **`WebUI\LocalHostAuth=false`** with **`Address=127.0.0.1`** — the WebUI is unreachable from
  outside the host, and the bridge connects without credentials. If you would rather keep auth on,
  drop that line and set `QBT_USER` / `QBT_PASS` in `server/.env` instead.
- **`Preallocation=false`** — matches the existing setup; files stay sparse while downloading.

## 3. The systemd unit

Modelled on `stream-download.service`, which is well written. Same hardening, own paths, own port.

```bash
sudo tee /etc/systemd/system/cinemate-qbt.service > /dev/null <<'UNIT'
[Unit]
Description=CineStream download client (qBittorrent-nox)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rdpuser
Group=rdpuser
UMask=0002

ExecStart=/usr/bin/qbittorrent-nox --profile=/var/lib/cinemate/qbt --webui-port=18081

Restart=on-failure
RestartSec=10s
TimeoutStopSec=60s
KillSignal=SIGTERM

# Downloads are IO-heavy far more than CPU-heavy; keep them off the other services' backs.
Nice=15
CPUWeight=10
IOWeight=10
MemoryHigh=1G
MemoryMax=2G
TasksMax=256

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=

ReadWritePaths=/var/lib/cinemate /var/log/cinemate

StandardOutput=append:/var/log/cinemate/qbt.log
StandardError=append:/var/log/cinemate/qbt.err.log

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now cinemate-qbt.service
sudo systemctl status cinemate-qbt.service --no-pager
```

> `ProtectHome=true` is deliberately **omitted** — the existing unit runs as `streamsvc`, but ours
> runs as `rdpuser` and would be unable to read its own home if that were set.

Confirm it is listening on loopback only:

```bash
sudo ss -lptn 'sport = :18081'
curl -s http://127.0.0.1:18081/api/v2/app/version
```

## 4. Point the bridge at it

```bash
# /opt/cinemate/server/.env
QBT_URL=http://127.0.0.1:18081
```

If you kept `LocalHostAuth=false`, remove any `QBT_USER` / `QBT_PASS` lines — they are ignored.

```bash
pm2 restart cinestream-bridge --update-env
curl -s http://localhost:8899/health | python3 -m json.tool | grep -E 'qBittorrent|activeTorrents'
```

Expect `"qBittorrentConnected": true` and `"activeTorrentsCount": 0` — a clean, empty instance.

## 5. Verify end to end

Stream something. Then confirm the files land in **our** directory and that the \*arr stack never
sees them:

```bash
ls -la /var/lib/cinemate/downloads/
ls -la /var/lib/cinemate/downloads/.incomplete/
```

Watch for a completed torrent surviving past completion — that is the behaviour that was broken.

## 6. Cleanup, once it is working

```bash
# The ACL workaround is no longer needed; the bridge owns its own storage now.
sudo setfacl -R -x u:rdpuser /var/lib/stream/incoming
sudo setfacl -x u:rdpuser /var/lib/stream
```

Also remove any leftover cinemate torrents from the **old** instance's WebUI on `:18080`, or they
will keep seeding and consuming its disk.

---

## Rollback

```bash
sudo systemctl disable --now cinemate-qbt.service
# restore QBT_URL=http://127.0.0.1:18080 in server/.env
pm2 restart cinestream-bridge --update-env
```

The old instance is untouched throughout, so rollback is just repointing the bridge.

---

## Follow-ups this unlocks

- **Phase 5** can write derived `.web.mp4` files beside the source with no permission problems and
  no risk of another service deleting them.
- `MAX_ACTIVE_TORRENTS` finally counts only our torrents.
- `IDLE_TTL` / LRU eviction govern the whole disk we are measuring, rather than a directory shared
  with another tool's library.
