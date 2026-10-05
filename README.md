# LDPlayer Remote: server (relay)

Phần chạy trên **VPS**: phục vụ trang web điều khiển, kiểm tra mật khẩu, và nối trình duyệt với
PC chạy LDPlayer. PC chạy [ldplayer-remote-client](https://github.com/haidang1810/ldplayer-remote-client)
(agent) **tự kết nối ra** server này, nên PC không cần mở port.

```
[Trình duyệt]──https──▶[Caddy]──▶[server :8090]◀──wss──[PC: agent]──adb──▶[LDPlayer]
```

Với mỗi người xem, agent mở thêm một kết nối "channel" riêng tới server, rồi server nối hai đầu với nhau.
Có cơ chế backpressure: người xem chậm thì server ngừng đọc từ agent, và agent tự bỏ frame.

## Cài đặt (Ubuntu)

Cần Node.js 22+, [Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian) và một tên miền có A record trỏ về VPS.

```bash
sudo useradd --system --home /opt/ldplayer-remote-server ldremote
sudo git clone https://github.com/haidang1810/ldplayer-remote-server.git /opt/ldplayer-remote-server
cd /opt/ldplayer-remote-server
sudo npm ci --omit=dev
sudo chown -R ldremote:ldremote /opt/ldplayer-remote-server
sudo -u ldremote npm run setup          # đặt mật khẩu web, in ra AGENT_KEY cho PC

sudo cp deploy/ldplayer-relay.service /etc/systemd/system/
sudo systemctl enable --now ldplayer-relay

# sửa tên miền trong deploy/Caddyfile rồi:
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Mở firewall cổng 80 và 443. Server chỉ nghe trên `127.0.0.1:8090`, chỉ Caddy (HTTPS) ra ngoài.

Cập nhật: `cd /opt/ldplayer-remote-server && sudo -u ldremote git pull && sudo systemctl restart ldplayer-relay`
Xem log: `journalctl -u ldplayer-relay -f`

## Cấu hình (`relay.env`, do `npm run setup` tạo)

| Biến | Ý nghĩa |
|---|---|
| `PASSWORD_HASH` | mật khẩu đăng nhập (scrypt) |
| `AGENT_KEY` | khoá để agent trên PC kết nối vào |
| `SESSION_SECRET` | khoá ký cookie đăng nhập |
| `PORT` / `HOST` | mặc định `8090` / `127.0.0.1` |
| `TRUST_PROXY` | `1` khi chạy sau Caddy (lấy IP thật từ `X-Forwarded-For`) |

Đổi mật khẩu, đăng xuất mọi thiết bị: `sudo -u ldremote npm run setup -- --force`. Lệnh này đổi luôn `AGENT_KEY`, nhớ cập nhật `agent.env` trên PC.

## Bảo mật

- Cookie phiên `HttpOnly`, `Secure`, `SameSite=Strict`, ký bằng HMAC, sống 30 ngày.
- Sai mật khẩu 5 lần trên một IP trong 15 phút (hoặc 30 lần tổng trong 1 giờ) thì tạm khoá đăng nhập.
- WebSocket kiểm tra Origin. Trang không cho nhúng vào iframe.
- Băng thông: toàn bộ video đi qua VPS (8 Mbps ≈ 3.6 GB/giờ).
