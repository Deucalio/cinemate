#!/usr/bin/env bash
# ==============================================================================
# CineStream Torrent HTTP Streaming Bridge — Ubuntu VPS Auto-Installer Script
# ==============================================================================
# Usage:
#   chmod +x setup-ubuntu.sh
#   sudo ./setup-ubuntu.sh
# ==============================================================================

set -e

echo "🎬 Starting CineStream Streaming Server setup on Ubuntu..."

# 1. Update system packages
echo "📦 Updating apt packages..."
apt-get update -y
apt-get install -y curl git build-essential ufw

# 2. Install Node.js 20 LTS
echo "📦 Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "✅ Node version: $(node -v)"
echo "✅ NPM version: $(npm -v)"

# 3. Install PM2 Process Manager globally
echo "📦 Installing PM2 process manager..."
npm install -g pm2

# 4. Install server dependencies
echo "📦 Installing project dependencies..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
npm install

# 5. Configure Firewall (Port 8888)
echo "🛡️ Configuring UFW firewall for port 8888..."
ufw allow 8888/tcp || true

# 6. Start with PM2
echo "🚀 Starting CineStream Streaming Bridge with PM2..."
pm2 delete cinestream-bridge 2>/dev/null || true
pm2 start index.js --name "cinestream-bridge" --time
pm2 save
pm2 startup systemd -u root --hp /root || true

echo "=============================================================================="
echo "🎉 SUCCESS! CineStream Streaming Server is running on your VPS!"
echo "📡 Stream Endpoint: http://$(curl -s ifconfig.me):8888/api/stream"
echo "🩺 Health Check:    http://$(curl -s ifconfig.me):8888/health"
echo "📜 View logs:       pm2 logs cinestream-bridge"
echo "=============================================================================="
