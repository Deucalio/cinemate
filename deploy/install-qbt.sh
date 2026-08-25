#!/usr/bin/env bash
#
# Installs a qBittorrent instance dedicated to CineStream.
#
# The bridge previously shared a qBittorrent with a Sonarr/Radarr stack, whose
# completed-download handling imported finished downloads and then deleted the
# torrent AND its data -- removing files mid-playback. See
# docs/dedicated-qbittorrent.md for the full diagnosis.
#
# Idempotent: safe to re-run. Never overwrites an existing config.
#
#   sudo bash deploy/install-qbt.sh
#
set -euo pipefail

QBT_USER="${QBT_USER:-rdpuser}"
QBT_PORT="${QBT_PORT:-18081}"
ROOT=/var/lib/cinemate
LOGDIR=/var/log/cinemate
UNIT=/etc/systemd/system/cinemate-qbt.service
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/install-qbt.sh" >&2
  exit 1
fi

if ! id "$QBT_USER" >/dev/null 2>&1; then
  echo "User '$QBT_USER' does not exist. Set QBT_USER=<name> and re-run." >&2
  exit 1
fi

if ! command -v qbittorrent-nox >/dev/null 2>&1; then
  echo "qbittorrent-nox is not installed. Run: sudo apt install -y qbittorrent-nox" >&2
  exit 1
fi

echo "==> Creating storage under $ROOT (owned by $QBT_USER)"
mkdir -p "$ROOT/qbt/qBittorrent/config" "$ROOT/downloads/.incomplete" "$LOGDIR"
chown -R "$QBT_USER:$QBT_USER" "$ROOT" "$LOGDIR"

CONF="$ROOT/qbt/qBittorrent/config/qBittorrent.conf"
if [[ -f "$CONF" ]]; then
  echo "==> Config already exists, leaving it alone: $CONF"
else
  echo "==> Writing config: $CONF"
  install -o "$QBT_USER" -g "$QBT_USER" -m 0644 "$HERE/qbittorrent.conf" "$CONF"
fi

echo "==> Installing systemd unit: $UNIT"
sed "s|__QBT_USER__|$QBT_USER|g" "$HERE/cinemate-qbt.service" > "$UNIT"
chmod 0644 "$UNIT"

echo "==> Enabling and starting cinemate-qbt"
systemctl daemon-reload
systemctl enable cinemate-qbt >/dev/null
systemctl restart cinemate-qbt

echo "==> Waiting for the WebUI to answer on 127.0.0.1:$QBT_PORT"
VERSION=""
for _ in $(seq 1 20); do
  sleep 1
  if VERSION="$(curl -fsS "http://127.0.0.1:$QBT_PORT/api/v2/app/version" 2>/dev/null)"; then
    break
  fi
  VERSION=""
done

echo
if [[ -n "$VERSION" ]]; then
  echo "SUCCESS: dedicated qBittorrent $VERSION is running on 127.0.0.1:$QBT_PORT"
  echo
  echo "Next:"
  echo "  cd /opt/cinemate/server"
  echo "  sed -i '/^QBT_URL=/d' .env"
  echo "  echo 'QBT_URL=http://127.0.0.1:$QBT_PORT' >> .env"
  echo "  pm2 restart cinestream-bridge --update-env"
else
  echo "FAILED: no response from 127.0.0.1:$QBT_PORT" >&2
  echo >&2
  echo "Diagnose with:" >&2
  echo "  systemctl status cinemate-qbt --no-pager" >&2
  echo "  journalctl -u cinemate-qbt -n 50 --no-pager" >&2
  echo "  tail -40 $LOGDIR/qbt.err.log" >&2
  exit 1
fi
