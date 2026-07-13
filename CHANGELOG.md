# Changelog

## v0.2.1

### Added

- Added a scroll jump bar for navigating the library.
- Added console search and badge-click filtering for regions, Virtual Console types, and consoles.
- Added Wii and 3DS SD-card copy support.
- Added Wii title verification support.
- Added support for Wii U demo (and UWUVCI AIO-injected) titles.
- Added cover image placeholders with correct aspect ratios, loading states, and failed-image states.

### Changed

- Improved badge alignment, sizing, tooltips, colors, borders, and header spacing.
- Improved region and Virtual Console filter handling by removing hardcoded region behavior.
- Improved GameTDB handling:
    - Prefer local archives.
    - Rebuild cached archive indexes without unnecessary network requests.
    - Probe TDB ZIP file lists before downloading.
    - Use non-English synopses when English text is unavailable.
- Split server route handling into separate route and action layers.
- Improved title platform typing across the codebase.
- Reduced unnecessary FAT32 device scans to library-refresh flows.
- Replaced hardcoded filenames with constants.
- Updated default ROM root behavior when config does not specify one.

### Fixed

- Fixed badge width and row alignment issues.
- Fixed direct Node runtime path handling.
- Prevented library verification work from blocking HTTP requests.
- Removed an unnecessary import.
- Adjusted config candidate display formatting.
- Optimized logo SVG and updated the app logo.

## v0.2.0

## v0.1.0

- Initial public release.
- Name has been changed to ROM Rack.

### Added

- Added Wii support.
- Added 3DS support.
- Added Virtual Console badges and filtering.
- Added download support in the UI.
- Added library validation UI.
- Added config settings sidebar and API.
- Added support for copying files to SD cards and other FAT32 partitions.
- Added multi-platform release builds.
- Added native launcher binaries.

### Changed

- Major refactors.
- Significant improvements to media handling.
- Split the release workflow to support future signing.
- Switched the project license to GPLv3 or later.
- Updated README documentation for newer features.
- Improved config handling and UI state syncing.
- Improved release packaging.

### Fixed

- Removed an unnecessary Windows prompt.
- Improved heartbeat behavior and error handling.
