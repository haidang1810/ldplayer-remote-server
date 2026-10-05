#!/usr/bin/env bash
# Install / redeploy the relay on a VPS that already has Node.js 22+, nginx, certbot and git.
#
#   First install (as root):
#     curl -fsSLo install.sh https://raw.githubusercontent.com/haidang1810/ldplayer-remote-server/main/deploy/install.sh
#     bash install.sh <domain> [port]          # port: local port for the relay, default 8090
#
#   Redeploy the latest code (password, domain and port are kept):
#     ldplayer-relay-deploy                     # add --force to reinstall even if nothing changed
#
# The relay listens only on 127.0.0.1:<port>; nginx terminates HTTPS and proxies to it.
# Firewall rules are left untouched. relay.env (password, agent key) is never regenerated.
set -euo pipefail

APP_DIR=/opt/ldplayer-remote-server
REPO=https://github.com/haidang1810/ldplayer-remote-server.git
BRANCH=main
APP_USER=ldremote
SERVICE=ldplayer-relay
SITE=ldplayer-remote
ENV_FILE=$APP_DIR/relay.env
BACKUP_DIR=/var/backups/ldplayer-relay
DEPLOY_CMD=/usr/local/sbin/ldplayer-relay-deploy

fail() { echo "LỖI: $*" >&2; exit 1; }
step() { echo "==> $*"; }

env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 || true; }
env_set() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}

check_requirements() {
  [ "$(id -u)" = 0 ] || fail "hãy chạy bằng root."
  command -v node >/dev/null || fail "chưa có Node.js."
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "cần Node.js 22+, đang có $(node --version)."
  local cmd
  for cmd in npm git nginx certbot curl; do command -v "$cmd" >/dev/null || fail "chưa có $cmd."; done
}

check_port() {
  [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "port không hợp lệ: $PORT"
  local current
  current="$(env_get PORT)"
  if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! { systemctl is-active --quiet "$SERVICE" && [ "$current" = "$PORT" ]; }; then
    fail "port $PORT đang bị chương trình khác dùng, chọn port khác: bash install.sh $DOMAIN <port>"
  fi
}

backup_env() {
  [ -f "$ENV_FILE" ] || return 0
  install -d -m 700 "$BACKUP_DIR"
  cp -p "$ENV_FILE" "$BACKUP_DIR/relay.env.$(date +%Y%m%d-%H%M%S)"
  # keep the 10 most recent backups
  ls -1t "$BACKUP_DIR"/relay.env.* | tail -n +11 | xargs -r rm -f
}

update_code() {
  id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
    || git config --global --add safe.directory "$APP_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    PREV_COMMIT="$(git -C "$APP_DIR" rev-parse HEAD)"
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    # reset (not pull) so a shallow clone can never get stuck; relay.env and node_modules are
    # git-ignored and untouched by reset.
    git -C "$APP_DIR" reset --hard FETCH_HEAD
  else
    PREV_COMMIT=""
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
  fi
  NEW_COMMIT="$(git -C "$APP_DIR" rev-parse HEAD)"
}

install_deps() {
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    step "Đặt mật khẩu đăng nhập web (tối thiểu 10 ký tự)"
    (cd "$APP_DIR" && runuser -u "$APP_USER" -- node src/setup.js </dev/tty)
    FIRST_INSTALL=1
  fi
  env_set PORT "$PORT"
  env_set HOST 127.0.0.1
  env_set TRUST_PROXY 1
  env_set DOMAIN "$DOMAIN"
  chmod 600 "$ENV_FILE"
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
}

install_service() {
  local node_bin
  node_bin="$(readlink -f "$(command -v node)")"
  if [[ "$node_bin" == /root/* || "$node_bin" == /home/* ]]; then
    # nvm-style installs live in a home directory the service user cannot read (and the unit sets
    # ProtectHome), so give the service its own copy of the standalone node binary.
    install -m 755 "$node_bin" /usr/local/bin/ldr-node
    node_bin=/usr/local/bin/ldr-node
  fi
  sed "s#/usr/bin/node#$node_bin#" "$APP_DIR/deploy/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
}

healthy() {
  local i
  for i in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)" = 200 ] && return 0
    sleep 0.5
  done
  return 1
}

rollback() {
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  if [ -n "$PREV_COMMIT" ] && [ "$PREV_COMMIT" != "$NEW_COMMIT" ]; then
    step "Bản mới không chạy được, quay về ${PREV_COMMIT:0:7}"
    git -C "$APP_DIR" reset --hard "$PREV_COMMIT"
    install_deps
    install_service
    healthy && fail "bản ${NEW_COMMIT:0:7} lỗi, đã quay về ${PREV_COMMIT:0:7} (log ở trên)."
  fi
  fail "relay không chạy được (log ở trên)."
}

configure_nginx() {
  local conf
  if [ -d /etc/nginx/sites-available ]; then
    conf=/etc/nginx/sites-available/$SITE.conf
    ln -sf "$conf" "/etc/nginx/sites-enabled/$SITE.conf"
  else
    conf=/etc/nginx/conf.d/$SITE.conf
  fi
  if [ ! -f "$conf" ] || ! grep -q ssl_certificate "$conf"; then
    sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$APP_DIR/deploy/nginx.conf" > "$conf"
  else
    # certbot has added TLS to this file: only keep the upstream port in sync.
    sed -i "s#proxy_pass http://127.0.0.1:[0-9]*;#proxy_pass http://127.0.0.1:$PORT;#" "$conf"
  fi
  nginx -t
  systemctl reload nginx
  if ! grep -q ssl_certificate "$conf"; then
    step "Xin chứng chỉ HTTPS (certbot)"
    certbot --nginx -d "$DOMAIN" --redirect --non-interactive \
      || fail "certbot chưa cấp được chứng chỉ. Chạy tay: certbot --nginx -d $DOMAIN --redirect, rồi chạy lại $DEPLOY_CMD"
  fi
}

main() {
  local force=0 args=()
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      *) args+=("$a") ;;
    esac
  done

  check_requirements
  DOMAIN="$(echo "${args[0]:-$(env_get DOMAIN)}" | tr '[:upper:]' '[:lower:]')"
  PORT="${args[1]:-$(env_get PORT)}"
  PORT="${PORT:-8090}"
  [ -n "$DOMAIN" ] || fail "lần cài đầu cần tên miền: bash install.sh <domain> [port]"
  check_port
  FIRST_INSTALL=0

  step "Cập nhật mã nguồn ($APP_DIR)"
  backup_env
  update_code
  local changed=1
  [ "$PREV_COMMIT" = "$NEW_COMMIT" ] && changed=0
  if [ "$changed" = 1 ] || [ "$force" = 1 ] || [ ! -d "$APP_DIR/node_modules" ]; then
    install_deps
  fi

  ensure_env

  step "Dịch vụ $SERVICE (127.0.0.1:$PORT)"
  if [ "$changed" = 1 ] || [ "$force" = 1 ] || ! systemctl is-active --quiet "$SERVICE"; then
    install_service
  fi
  healthy || rollback

  step "nginx cho $DOMAIN"
  configure_nginx

  ln -sf "$APP_DIR/deploy/install.sh" "$DEPLOY_CMD"
  chmod 755 "$APP_DIR/deploy/install.sh"

  echo
  if [ -z "$PREV_COMMIT" ]; then
    echo "Đã cài bản ${NEW_COMMIT:0:7}."
  elif [ "$changed" = 1 ]; then
    echo "Đã cập nhật ${PREV_COMMIT:0:7} -> ${NEW_COMMIT:0:7}:"
    git -C "$APP_DIR" log --oneline "$PREV_COMMIT..$NEW_COMMIT" 2>/dev/null || true
  else
    echo "Đã là bản mới nhất (${NEW_COMMIT:0:7})."
  fi
  echo "https://$DOMAIN -> HTTP $(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || true)"
  echo "Lần sau cập nhật code: $DEPLOY_CMD"
  if [ "$FIRST_INSTALL" = 1 ]; then
    echo
    echo "AGENT_KEY cho file agent.env trên PC:"
    grep '^AGENT_KEY=' "$ENV_FILE"
  fi
}

# Everything runs from main() so bash has parsed the whole script before `git reset` can replace
# this very file during a redeploy.
main "$@"
exit 0
