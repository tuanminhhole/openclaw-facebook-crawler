# Changelog

All notable changes to this project will be documented in this file.

## [1.0.6] - 2026-05-08

### Added
- AI classifier pipeline (`analyzePostAI`) via internal LLM gateway — replaces keyword-only filtering for `banxe` profile.
- Raw-first 3-phase crawl pipeline: collect → deduplicate into monthly raw store → filter/classify.
- Multi-profile architecture: independent `groups`, `rules`, `cronSchedule`, state, and blacklist per profile.
- `vehicleKeywords` per-group guard for mixed-content groups.
- Per-profile state (`state_<profile>.json`) and blacklist (`blacklist_<profile>.json`) files.
- Post content saved to `data/content/<date>-<group>/<postId>/` with markdown text and downloaded images.
- SSE streaming response fallback parser for AI gateway.
- Scroll depth heuristic based on time since last run (2–10 scrolls).
- `/add-group`, `/remove-group`, `/cron` slash commands.
- `author` field (`tuanminhhole`) in `openclaw.plugin.json`.
- MIT `LICENSE` file added to repository.

### Changed
- `/scan [profile]` now auto-splits into sessions of 5 groups each.
- `/report` shows top 15 results with phone, price extraction and formatted layout.
- `README.md` updated to reflect multi-profile and AI-driven workflow.
- `docs/ARCHITECTURE.md` fully rewritten to reflect current implementation.

## [1.0.2] - 2026-05-06

### Changed
- Generalized `config.json` default template.
- Updated `README.md` and `README.vi.md` installation instructions for OpenClaw native `plugins install` command.
- Standardized `.agent/workflows/update.md` for AI-driven releases.

## [1.0.1] - 2026-05-06

### Fixed
- Included `config.json` in the `files` array of `package.json` so it is packaged correctly when published to ClawHub.

## [1.0.0] - 2026-05-06

### Added
- Initial release of OpenClaw Facebook Crawler as a generic plugin.
- Rule-based filtering (`requireKeywords`, `blockKeywords`).
- Regex extraction for custom fields.
- 9-session automated Native Cron schedule compatibility.
