#!/usr/bin/env bash
# One-shot installer / updater for Debian or Ubuntu. Run as root:
#   curl -fsSLo install.sh https://raw.githubusercontent.com/haidang1810/ldplayer-remote-server/main/deploy/install.sh
#   bash install.sh your.domain.com
# Re-running it updates the code and keeps the existing password (relay.env).
set -euo pipefail

DOMAIN="$(echo "${1:?usage: bash install.sh <domain>}" | tr '[:upper:]' '[:lower:]')"
APP_DIR=/opt/ldplayer-remote-server
REPO=https://github.com/haidang1810/ldplayer-remote-server.git
APP_USER=ldremote

[ "$(id -u)" = 0 ] || { echo "Hãy chạy bằng root."; exit 1; }
command -v apt-get >/dev/null || { echo "Script này cần Debian/Ubuntu."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Gói hệ thống"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Mã nguồn ($APP_DIR)"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git config --global --add safe.directory "$APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -f "$APP_DIR/relay.env" ]; then
  echo "==> Đặt mật khẩu đăng nhập web"
  runuser -u "$APP_USER" -- node src/setup.js </dev/tty
fi

echo "==> Dịch vụ systemd"
cp deploy/ldplayer-relay.service /etc/systemd/system/ldplayer-relay.service
systemctl daemon-reload
systemctl enable ldplayer-relay >/dev/null
systemctl restart ldplayer-relay

echo "==> Caddy cho $DOMAIN"
printf '%s {\n\treverse_proxy 127.0.0.1:8090\n}\n' "$DOMAIN" > /etc/caddy/ldplayer-remote.caddy
if grep -q 'root \* /usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  # Stock placeholder config from the package: replace it.
  echo 'import /etc/caddy/ldplayer-remote.caddy' > /etc/caddy/Caddyfile
elif ! grep -q 'ldplayer-remote.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  echo 'import /etc/caddy/ldplayer-remote.caddy' >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

if ss -ltnp | grep -E ':(80|443)\s' | grep -vq caddy; then
  echo "CẢNH BÁO: cổng 80/443 đang bị chương trình khác chiếm (nginx/apache?), Caddy không xin được HTTPS."
fi

sleep 2
systemctl is-active --quiet ldplayer-relay && echo "relay: đang chạy" || { echo "relay: LỖI"; journalctl -u ldplayer-relay -n 20 --no-pager; }
echo
echo "Xong. Mở https://$DOMAIN"
echo "AGENT_KEY cho file agent.env trên PC:"
grep '^AGENT_KEY=' "$APP_DIR/relay.env"
