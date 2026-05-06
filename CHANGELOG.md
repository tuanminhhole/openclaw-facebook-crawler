# Changelog

All notable changes to this project will be documented in this file.

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
