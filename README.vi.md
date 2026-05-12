# OpenClaw Facebook Crawler

_Read this in other languages: [English](README.md)_

Plugin OpenClaw tự động quét các group Facebook, lọc bài đăng theo cấu hình từ khóa (require, block), phân loại vùng miền (locations), dùng regex trích xuất dữ liệu, và tổng hợp kết quả theo lịch cron.

## Tính Năng Đa Dụng

Plugin này không bị giới hạn ở một mục đích. Bạn có thể sử dụng cho:

- Săn hàng thanh lý, mua bán đồ cũ (xe máy, đồ công nghệ).
- Quét bài đăng việc làm, tuyển dụng.
- Tìm kiếm bất động sản, phòng trọ.

Tất cả được cấu hình thông qua file `config.json`.

- 🔍 Quét tuần tự nhiều Facebook groups.
- 🚫 Tự phát hiện và block các đối tượng (proseller, spam) dựa vào `blockKeywords`.
- ✅ Lọc những bài thỏa mãn yêu cầu dựa vào `requireKeywords`.
- 📍 Lọc vùng miền linh hoạt dựa vào bộ `locations`.
- 📞 Trích xuất dữ liệu tùy chỉnh bằng Regex (ví dụ: SĐT).
- ⏰ Chạy định kỳ thông qua cơ chế Cron sessions (chia nhỏ để tránh timeout bot).
- 💾 Lưu kết quả theo ngày (`data/results/YYYY-MM-DD.json`).
- 🛑 Chặn người dùng tự động (Blacklist UID).

## Slash Commands

| Lệnh                           | Mô tả                                        |
| ------------------------------ | -------------------------------------------- |
| `/help`                        | Xem toàn bộ lệnh                             |
| `/scan`                        | Quét toàn bộ các groups ngay                 |
| `/scan <key\|id>`              | Quét 1 group cụ thể (vd: `/scan nvx`)        |
| `/scan session <ID>`           | Chạy 1 session cron cụ thể                   |
| `/report`                      | Báo cáo kết quả hôm nay                      |
| `/report <YYYY-MM-DD>`         | Báo cáo ngày cụ thể                          |
| `/groups`                      | Xem danh sách groups đang theo dõi           |
| `/add-group <key> <tên> <url>` | Thêm group mới                               |
| `/remove-group <key\|id>`      | Xóa group                                    |
| `/blacklist`                   | Xem danh sách UID bị chặn                    |
| `/blacklist remove <uid>`      | Xóa UID khỏi blacklist                       |
| `/reset`                       | Xóa lịch sử đã quét, bắt đầu lại từ đầu      |
| `/cron`                        | Xem cấu hình lịch cron                       |
| `/status`                      | Trạng thái plugin (last run, tổng bài, v.v.) |
| `/set-notify`                  | Đặt chat hiện tại nhận báo cáo tự động       |

## Cài đặt

```bash
## Qua ClawHub

# Cài với OpenClaw Native
openclaw plugins install clawhub:openclaw-facebook-crawler
```

```bash
# Cài với OpenClaw Docker
docker exec openclaw-bot openclaw plugins install clawhub:openclaw-facebook-crawler --force
docker restart openclaw-bot
```

Hoặc qua local (sao chép vào thư mục `extensions/`), sau đó bật trong `openclaw.json`:

```json
"plugins": {
  "entries": {
    "openclaw-facebook-crawler": { "enabled": true }
  },
  "allow": ["openclaw-facebook-crawler"]
}
```

## Cấu Hình Tuỳ Chỉnh (`config.json`)

File `config.json` nằm trong thư mục gốc của plugin. Bạn có thể thay đổi để phục vụ các mục đích khác nhau:

```json
{
  "rules": {
    "requireKeywords": ["bán", "thanh lý"],
    "blockKeywords": ["cửa hàng", "salon"],
    "locations": {
      "hcm": ["hcm", "sài gòn", "q1", "q12"],
      "hanoi": ["hà nội", "hoàn kiếm"]
    },
    "extractRegex": {
      "phone": "(0[35789]\\d{8}|0[12]\\d{8})"
    }
  },
  "cronSchedule": [
    { "id": "A", "cron": "0 7 * * *", "groupSlice": [0, 5] },
    { "id": "B", "cron": "30 7 * * *", "groupSlice": [5, 10] }
  ],
  "groups": [
    { "id": 1, "key": "chotot", "name": "Chợ Tốt VN", "url": "https://..." }
  ]
}
```

## Ghi chú về Kiến trúc

Yêu cầu module `browser` (cung cấp API `browser-tool.js`) của hệ sinh thái OpenClaw phải được kích hoạt để đảm nhiệm việc điều khiển trình duyệt thực tế.
