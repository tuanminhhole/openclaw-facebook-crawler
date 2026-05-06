# openclaw-facebook-crawler

Plugin OpenClaw tá»± Ä‘á»™ng quÃ©t cÃ¡c group Facebook, lá»c bÃ i Ä‘Äƒng theo cáº¥u hÃ¬nh tá»« khÃ³a (require, block), phÃ¢n loáº¡i vÃ¹ng miá»n (locations), dÃ¹ng regex trÃ­ch xuáº¥t dá»¯ liá»‡u, vÃ  tá»•ng há»£p káº¿t quáº£ theo lá»‹ch cron.

## TÃ­nh NÄƒng Äa Dá»¥ng

Plugin nÃ y khÃ´ng bá»‹ giá»›i háº¡n á»Ÿ má»™t má»¥c Ä‘Ã­ch. Báº¡n cÃ³ thá»ƒ sá»­ dá»¥ng cho:
- SÄƒn hÃ ng thanh lÃ½, mua bÃ¡n Ä‘á»“ cÅ© (xe mÃ¡y, Ä‘á»“ cÃ´ng nghá»‡).
- QuÃ©t bÃ i Ä‘Äƒng viá»‡c lÃ m, tuyá»ƒn dá»¥ng.
- TÃ¬m kiáº¿m báº¥t Ä‘á»™ng sáº£n, phÃ²ng trá».

Táº¥t cáº£ Ä‘Æ°á»£c cáº¥u hÃ¬nh thÃ´ng qua file `config.json`.

- ðŸ” QuÃ©t tuáº§n tá»± nhiá»u Facebook groups.
- ðŸš« Tá»± phÃ¡t hiá»‡n vÃ  block cÃ¡c Ä‘á»‘i tÆ°á»£ng (proseller, spam) dá»±a vÃ o `blockKeywords`.
- âœ… Lá»c nhá»¯ng bÃ i thá»a mÃ£n yÃªu cáº§u dá»±a vÃ o `requireKeywords`.
- ðŸ“ Lá»c vÃ¹ng miá»n linh hoáº¡t dá»±a vÃ o bá»™ `locations`.
- ðŸ“ž TrÃ­ch xuáº¥t dá»¯ liá»‡u tÃ¹y chá»‰nh báº±ng Regex (vÃ­ dá»¥: SÄT).
- â° Cháº¡y Ä‘á»‹nh ká»³ thÃ´ng qua cÆ¡ cháº¿ Cron sessions (chia nhá» Ä‘á»ƒ trÃ¡nh timeout bot).
- ðŸ’¾ LÆ°u káº¿t quáº£ theo ngÃ y (`data/results/YYYY-MM-DD.json`).
- ðŸš· Cháº·n ngÆ°á»i dÃ¹ng tá»± Ä‘á»™ng (Blacklist UID).

## Slash Commands

| Lá»‡nh | MÃ´ táº£ |
|---|---|
| `/help` | Xem toÃ n bá»™ lá»‡nh |
| `/scan` | QuÃ©t toÃ n bá»™ cÃ¡c groups ngay |
| `/scan <key\|id>` | QuÃ©t 1 group cá»¥ thá»ƒ (vd: `/scan nvx`) |
| `/scan session <ID>` | Cháº¡y 1 session cron cá»¥ thá»ƒ |
| `/report` | BÃ¡o cÃ¡o káº¿t quáº£ hÃ´m nay |
| `/report <YYYY-MM-DD>` | BÃ¡o cÃ¡o ngÃ y cá»¥ thá»ƒ |
| `/groups` | Xem danh sÃ¡ch groups Ä‘ang theo dÃµi |
| `/add-group <key> <tÃªn> <url>` | ThÃªm group má»›i |
| `/remove-group <key\|id>` | XÃ³a group |
| `/blacklist` | Xem danh sÃ¡ch UID bá»‹ cháº·n |
| `/blacklist remove <uid>` | XÃ³a UID khá»i blacklist |
| `/reset` | XÃ³a lá»‹ch sá»­ Ä‘Ã£ quÃ©t, báº¯t Ä‘áº§u láº¡i tá»« Ä‘áº§u |
| `/cron` | Xem cáº¥u hÃ¬nh lá»‹ch cron |
| `/status` | Tráº¡ng thÃ¡i plugin (last run, tá»•ng bÃ i, v.v.) |
| `/set-notify` | Äáº·t chat hiá»‡n táº¡i nháº­n bÃ¡o cÃ¡o tá»± Ä‘á»™ng |

## CÃ i Ä‘áº·t

```bash
# Qua ClawHub
openclaw plugins install clawhub:openclaw-facebook-crawler
```

Hoáº·c qua local (sao chÃ©p vÃ o thÆ° má»¥c `extensions/`), sau Ä‘Ã³ báº­t trong `openclaw.json`:
```json
"plugins": {
  "entries": {
    "openclaw-facebook-crawler": { "enabled": true }
  },
  "allow": ["openclaw-facebook-crawler"]
}
```

## Cáº¥u HÃ¬nh Tuá»³ Chá»‰nh (`config.json`)

File `config.json` náº±m trong thÆ° má»¥c gá»‘c cá»§a plugin. Báº¡n cÃ³ thá»ƒ thay Ä‘á»•i Ä‘á»ƒ phá»¥c vá»¥ cÃ¡c má»¥c Ä‘Ã­ch khÃ¡c nhau:

```json
{
  "rules": {
    "requireKeywords": ["bÃ¡n", "thanh lÃ½"],
    "blockKeywords": ["cá»­a hÃ ng", "salon"],
    "locations": {
      "hcm": ["hcm", "sÃ i gÃ²n", "q1", "q12"],
      "hanoi": ["hÃ  ná»™i", "hoÃ n kiáº¿m"]
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
    { "id": 1, "key": "chotot", "name": "Chá»£ Tá»‘t VN", "url": "https://..." }
  ]
}
```

## License
MIT

