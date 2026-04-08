# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.5] - 2026-04-08

### Fixed

- Open chat detection rewritten for Cursor 3.0 compatibility. Uses `composer.getOrderedSelectedComposerIds` as the primary detection method, with legacy command-prefix scanning as fallback.
- Updated `openCursorChat` to use Cursor 3.0 commands (`composer.openComposer`, `composer.focusComposer`, `composer.openChatAsEditor`) with legacy fallbacks.

## [1.0.4] - 2026-04-04

### Fixed

- Resolved new state location for Cursor 3.0 (`state.vscdb` path changes).
- Fixed chat title parsing for the updated Cursor 3.0 database schema.
- Improved status bar label sanitization: newlines collapsed, `$(` and `[` tokens escaped to prevent garbled rendering.

## [1.0.3] - 2026-04-04

### Added

- Repository automation: CI on `main`, tag-driven Open VSX release workflow, and contributor/security/changelog docs.

[Unreleased]: https://github.com/agastalver/cache-timer-extension/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.5
[1.0.4]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.4
[1.0.3]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.3
[1.0.2]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.2
[1.0.1]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.1
[1.0.0]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.0
