# LDPlayer Remote: server (relay)

Phần chạy trên **VPS**: phục vụ trang web điều khiển, quản lý tài khoản và API key, và nối trình duyệt với
PC chạy LDPlayer. PC chạy [ldplayer-remote-client](https://github.com/haidang1810/ldplayer-remote-client)
(agent) **tự kết nối ra** server này, nên PC không cần mở port.

```
[Trình duyệt]──https──▶[nginx + certbot]──▶[relay 127.0.0.1:8090]◀──wss──[PC: agent]──adb──▶[LDPlayer]
```

Với mỗi người xem, agent mở thêm một kết nối "channel" riêng tới server, rồi server nối hai đầu với nhau.
Có cơ chế backpressure: người xem chậm thì server ngừng đọc từ agent, và agent tự bỏ frame.

## Cài đặt

Yêu cầu: VPS Debian/Ubuntu đã có **Node.js 22.5+**, **nginx**, **certbot**, git, và một tên miền trỏ A record về VPS.
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

Script cũng cài **coturn** (TURN server) để WebRTC vẫn chạy khi điện thoại và PC không nối thẳng được (thường gặp với 4G).

Script **không** đụng tới firewall. Bạn tự mở:
- `80/tcp`, `443/tcp` cho nginx;
- `3478/tcp`, `3478/udp` và `49160-49300/udp` cho TURN.

Port của relay (8090) không cần mở.

Cập nhật code: chạy `ldplayer-relay-deploy`. Lệnh này giữ nguyên mật khẩu, domain và port; sao lưu `relay.env` vào `/var/backups/ldplayer-relay/`; tự quay về bản cũ nếu bản mới không khởi động được. Thêm `--force` để cài lại kể cả khi code không đổi.
Xem log: `journalctl -u ldplayer-relay -f`

## Tài khoản

- Lần cài đầu, script hỏi tên và mật khẩu admin. Người khác tự đăng ký trên trang web, tài khoản ở trạng thái **chờ duyệt** cho tới khi admin bấm *Duyệt* trong trang **Tài khoản** (biểu tượng người ở góc trên).
- Mỗi người tạo **API key** trong trang Tài khoản rồi nhập vào agent trên PC. Một key dùng được cho nhiều PC: mỗi PC gửi kèm mã máy riêng nên hiện thành từng máy. Mỗi người chỉ thấy PC của mình.
- Xoá key → các PC dùng key đó bị ngắt ngay. Khoá hoặc xoá tài khoản → mọi phiên đăng nhập và PC của người đó bị ngắt.
- Dữ liệu nằm trong SQLite `/var/lib/ldplayer-relay/relay.db` (ngoài thư mục code, redeploy không đụng tới).
- Từ shell trên VPS:
  - `ldplayer-relay-admin users`: liệt kê tài khoản
  - `ldplayer-relay-admin admin <tên>`: tạo admin, hoặc nâng một tài khoản lên admin và đặt lại mật khẩu
  - `ldplayer-relay-admin password <tên>`: đặt lại mật khẩu

**Nâng cấp từ bản một mật khẩu:** lần đầu chạy bản mới, mật khẩu cũ (`PASSWORD_HASH`) thành tài khoản **`admin`**, đăng nhập bằng tên `admin` + mật khẩu cũ. `AGENT_KEY` cũ vẫn dùng được và gắn vào tài khoản admin, nên PC đang chạy không cần sửa gì ngay.

## Cấu hình (`relay.env`)

| Biến | Ý nghĩa |
|---|---|
| `DB_PATH` | file SQLite, mặc định `$STATE_DIRECTORY/relay.db` hoặc `data/relay.db` |
| `ALLOW_REGISTER` | `0` để tắt đăng ký (mặc định `1`) |
| `PORT` / `HOST` | mặc định `8090` / `127.0.0.1` |
| `TRUST_PROXY` | `1` khi chạy sau nginx (lấy IP thật từ `X-Forwarded-For`) |
| `TURN_SECRET` / `TURN_HOST` / `TURN_PORT` | coturn, script tự đặt |
| `PASSWORD_HASH` / `AGENT_KEY` | chỉ còn để tương thích bản cũ (xem trên) |

Chạy thử trên máy: `npm install && npm start`, mở http://127.0.0.1:8090 rồi đăng ký: tài khoản đầu tiên của database trống tự thành admin.

## Bảo mật

- Phiên đăng nhập lưu trong database (cookie ngẫu nhiên `HttpOnly`, `Secure`, `SameSite=Strict`, 30 ngày); đổi mật khẩu thì các trình duyệt khác bị đăng xuất.
- Mật khẩu băm bằng scrypt; API key chỉ lưu SHA-256.
- Sai mật khẩu 8 lần trên một IP trong 15 phút (hoặc 60 lần tổng trong 1 giờ) thì tạm khoá đăng nhập; mỗi IP đăng ký tối đa 5 lần/giờ.
- WebSocket kiểm tra Origin. Trang không cho nhúng vào iframe.
- Băng thông: toàn bộ video đi qua VPS (8 Mbps ≈ 3.6 GB/giờ).
