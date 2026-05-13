# Changelog

## 2026-05-13

### Fixed
- Preserve `invoice_items` order while grouping related line items.
- Keep consecutive rows with the same line-item reference together instead of relying only on primary service detection.
- Treat standalone timed/account charges as their own groups so they are not incorrectly folded into the previous server.
- Only show add-on expanders for true service groups.

### Changed
- Updated the server cost query help text to describe the new grouping behaviour more accurately.
