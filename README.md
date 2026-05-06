# OpenClaw Facebook Crawler

*Read this in other languages: [Tiếng Việt](README.vi.md)*

A generic rule-based Facebook Group Crawler plugin for OpenClaw. It automates browser interactions to scrape posts from configured Facebook groups based on precise keywords, regex rules, and locations. 

It is designed to easily map and filter data (like tracking motorbike sales, real estate, or job listings) using a customizable `config.json` without modifying code.

## Features
- **Data-Driven Configuration**: Easily configure target groups, allowed/blocked keywords, and regex rules in JSON.
- **Location Filter**: Group and identify posts by region (e.g., mapping cities/provinces to custom tags).
- **Spam & Pro-seller Bypass**: Filter out commercial posts using blocklists.
- **Deduplication**: Remembers what it has scraped locally in `data/` to avoid duplicates.
- **Native Cron Integration**: Exposes `/scan session <id>` to work perfectly with OpenClaw Native Cron.
- **Zalo Admin Controls**: Provides slash commands in Zalo for full control.

## Installation

```bash
openclaw plugins install clawhub:openclaw-facebook-crawler
```

Or copy to your `extensions/` directory and enable in `openclaw.json`:
```json
"plugins": {
  "entries": {
    "openclaw-facebook-crawler": { "enabled": true }
  },
  "allow": ["openclaw-facebook-crawler"]
}
```

## Slash Commands
*(Available in Zalo)*
| Command | Action |
|---------|--------|
| `/scan` | Force scan all configured groups immediately |
| `/scan <key\|id>` | Scan a specific group by its key |
| `/scan session <ID>` | Run a specific cron session (e.g., `/scan session A`) |
| `/report` | Send a summary report for today |
| `/groups` | List all monitored groups |
| `/blacklist` | View the blocked UID list |
| `/reset` | Clear scanned history |
| `/cron` | View the cron configuration map |
| `/status` | View plugin stats and memory |
| `/set-notify` | Set the current chat to receive automatic reports |

## Architecture Notes
Requires `browser-tool.js` provided by the OpenClaw browser module to be active to perform the actual Facebook interaction.
