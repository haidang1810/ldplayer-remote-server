#!/usr/bin/env bash
# Installer / updater for a VPS that already has Node.js 22+, nginx and certbot. Run as root:
#   curl -fsSLo install.sh https://raw.githubusercontent.com/haidang1810/ldplayer-remote-server/main/deploy/install.sh
#   bash install.sh <domain> [port]        # port: local port for the relay, default 8090
# The relay only listens on 127.0.0.1:<port>; nginx terminates HTTPS and proxies to it.
# Firewall rules are left untouched. Re-running updates the code and keeps relay.env (password).
set -euo pipefail

DOMAIN="$(echo "${1:?usage: bash install.sh <domain> [port]}" | tr '[:upper:]' '[:lower:]')"
PORT="${2:-8090}"
APP_DIR=/opt/ldplayer-remote-server
REPO=https://github.com/haidang1810/ldplayer-remote-server.git
APP_USER=ldremote
SITE=ldplayer-remote

fail() { echo "LỖI: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "hãy chạy bằng root."
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "port không hợp lệ: $PORT"
command -v node >/dev/null || fail "chưa có Node.js."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "cần Node.js 22+, đang có $(node --version)."
command -v nginx >/dev/null || fail "chưa có nginx."
command -v certbot >/dev/null || fail "chưa có certbot."
command -v git >/dev/null || fail "chưa có git."

if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! systemctl is-active --quiet ldplayer-relay; then
  fail "port $PORT đang bị chương trình khác dùng, chọn port khác: bash install.sh $DOMAIN <port>"
fi

echo "==> Mã nguồn ($APP_DIR)"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
git config --global --add safe.directory "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -f relay.env ]; then
  echo "==> Đặt mật khẩu đăng nhập web (tối thiểu 10 ký tự)"
  runuser -u "$APP_USER" -- node src/setup.js </dev/tty
fi
sed -i -e "s/^PORT=.*/PORT=$PORT/" -e "s/^HOST=.*/HOST=127.0.0.1/" -e "s/^TRUST_PROXY=.*/TRUST_PROXY=1/" relay.env
chmod 600 relay.env
chown "$APP_USER:$APP_USER" relay.env

echo "==> Dịch vụ systemd (127.0.0.1:$PORT)"
NODE_BIN="$(readlink -f "$(command -v node)")"
if [[ "$NODE_BIN" == /root/* || "$NODE_BIN" == /home/* ]]; then
  # nvm-style installs live in a home directory the service user cannot read (and the unit sets
  # ProtectHome), so give the service its own copy of the standalone node binary.
  install -m 755 "$NODE_BIN" /usr/local/bin/ldr-node
  NODE_BIN=/usr/local/bin/ldr-node
fi
sed "s#/usr/bin/node#$NODE_BIN#" deploy/ldplayer-relay.service > /etc/systemd/system/ldplayer-relay.service
systemctl daemon-reload
systemctl enable ldplayer-relay >/dev/null
systemctl restart ldplayer-relay

echo "==> nginx cho $DOMAIN"
if [ -d /etc/nginx/sites-available ]; then
  CONF=/etc/nginx/sites-available/$SITE.conf
  ln -sf "$CONF" /etc/nginx/sites-enabled/$SITE.conf
else
  CONF=/etc/nginx/conf.d/$SITE.conf
fi
# Only write the HTTP block on first install; afterwards certbot has added the TLS parts to it.
if [ ! -f "$CONF" ] || ! grep -q "ssl_certificate" "$CONF"; then
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" deploy/nginx.conf > "$CONF"
else
  sed -i "s#proxy_pass http://127.0.0.1:[0-9]*;#proxy_pass http://127.0.0.1:$PORT;#" "$CONF"
fi
nginx -t
systemctl reload nginx

echo "==> HTTPS (certbot)"
if ! grep -q "ssl_certificate" "$CONF"; then
  certbot --nginx -d "$DOMAIN" --redirect --non-interactive \
    || fail "certbot chưa cấp được chứng chỉ. Chạy tay: certbot --nginx -d $DOMAIN --redirect"
fi

sleep 1
if systemctl is-active --quiet ldplayer-relay; then
  echo "relay: đang chạy trên 127.0.0.1:$PORT"
else
  journalctl -u ldplayer-relay -n 20 --no-pager
  fail "relay không chạy được (log ở trên)."
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || true)
echo "https://$DOMAIN -> HTTP $code"
echo
echo "AGENT_KEY cho file agent.env trên PC:"
grep '^AGENT_KEY=' relay.env
