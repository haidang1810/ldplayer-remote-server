# LDPlayer Remote: server (relay)

Phần chạy trên **VPS**: phục vụ trang web điều khiển, kiểm tra mật khẩu, và nối trình duyệt với
PC chạy LDPlayer. PC chạy [ldplayer-remote-client](https://github.com/haidang1810/ldplayer-remote-client)
(agent) **tự kết nối ra** server này, nên PC không cần mở port.

```
[Trình duyệt]──https──▶[nginx + certbot]──▶[relay 127.0.0.1:8090]◀──wss──[PC: agent]──adb──▶[LDPlayer]
```

Với mỗi người xem, agent mở thêm một kết nối "channel" riêng tới server, rồi server nối hai đầu với nhau.
Có cơ chế backpressure: người xem chậm thì server ngừng đọc từ agent, và agent tự bỏ frame.

## Cài đặt

Yêu cầu: VPS Debian/Ubuntu đã có **Node.js 22+**, **nginx**, **certbot**, git, và một tên miền trỏ A record về VPS.
Chạy bằng root:

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/haidang1810/ldplayer-remote-server/main/deploy/install.sh
bash install.sh ldlink.example.com          # thêm port làm tham số thứ 2 nếu 8090 đã bị dùng
```

Script sẽ:
- clone repo vào `/opt/ldplayer-remote-server` và chạy dưới user `ldremote`;
- hỏi mật khẩu web ở lần cài đầu;
- tạo dịch vụ systemd `ldplayer-relay` (chỉ nghe ở `127.0.0.1`);
- tạo site nginx (`deploy/nginx.conf`, có hỗ trợ WebSocket) và xin chứng chỉ HTTPS bằng `certbot --nginx`.

Script **không** đụng tới firewall: cổng 80/443 phải mở sẵn cho nginx, còn port của relay không cần mở.

Cập nhật code: chạy lại `bash install.sh <domain>` (mật khẩu cũ được giữ nguyên).
Xem log: `journalctl -u ldplayer-relay -f`

## Cấu hình (`relay.env`, do `npm run setup` tạo)

| Biến | Ý nghĩa |
|---|---|
| `PASSWORD_HASH` | mật khẩu đăng nhập (scrypt) |
| `AGENT_KEY` | khoá để agent trên PC kết nối vào |
| `SESSION_SECRET` | khoá ký cookie đăng nhập |
| `PORT` / `HOST` | mặc định `8090` / `127.0.0.1` |
| `TRUST_PROXY` | `1` khi chạy sau nginx (lấy IP thật từ `X-Forwarded-For`) |

Đổi mật khẩu, đăng xuất mọi thiết bị: `sudo -u ldremote npm run setup -- --force`. Lệnh này đổi luôn `AGENT_KEY`, nhớ cập nhật `agent.env` trên PC.

## Bảo mật

- Cookie phiên `HttpOnly`, `Secure`, `SameSite=Strict`, ký bằng HMAC, sống 30 ngày.
- Sai mật khẩu 5 lần trên một IP trong 15 phút (hoặc 30 lần tổng trong 1 giờ) thì tạm khoá đăng nhập.
- WebSocket kiểm tra Origin. Trang không cho nhúng vào iframe.
- Băng thông: toàn bộ video đi qua VPS (8 Mbps ≈ 3.6 GB/giờ).
