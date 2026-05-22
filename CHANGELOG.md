# Changelog

## 2026-05-22

### Added
- Add a v6 Invoice tab toggle that groups repeated service/date-range line groups under one service heading.

### Changed
- Grouped Invoice tab service rows now combine repeated primary service periods under one service heading, while add-ons/backups stay behind the existing Show add-ons disclosure.
- Service group totals continue to calculate from grouped source ex-GST values with GST/rounding applied at the displayed group level.

## 2026-05-13

### Fixed
- Preserve `invoice_items` order while grouping related line items.
- Keep consecutive rows with the same line-item reference together instead of relying only on primary service detection.
- Treat standalone timed/account charges as their own groups so they are not incorrectly folded into the previous server.
- Only show add-on expanders for true service groups.

### Changed
- Updated the server cost query help text to describe the new grouping behaviour more accurately.
