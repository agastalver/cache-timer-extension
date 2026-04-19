# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.6] - 2026-04-19

### Fixed

- Memory footprint reduced by roughly an order of magnitude. The extension no longer spawns `sqlite3` every 5 seconds against the multi-GB global state DB and pulls the entire composer header JSON into Node; queries now filter server-side with `json_each`/`json_extract` and return only the current workspace's rows.
- `execFile`/`execFileSync` calls that read Cursor's state DBs now set `maxBuffer: 32 MiB` (and `8 MiB` for the AI tracking DB). The previous default of 1 MiB was silently overflowed by larger installs, causing title resolution to fail silently.
- `ChatTitleResolver` no longer blocks extension activation with a synchronous sqlite call, no longer clears and rebuilds its title cache on every refresh (diff-based updates fire `onDidRefresh` only when titles actually change), and now polls every 30 s instead of every 5 s. A `forceRefresh()` call is triggered on-demand when a brand-new chat appears so titles still show up promptly.
- `TranscriptWatcher` now tail-reads the last 512 KB of each JSONL to get the most recent entry and head-reads the first 64 KB (once per chat) to extract a fallback title, rather than `fs.readFileSync`-ing the whole transcript on every change and every rescan. Rescans skip inert files (same size, older than 15 s).

### Changed

- `TimerManager` auto-evicts timers whose `lastAssistantTime` is older than `TTL + 1 hour`, and `TranscriptWatcher` evicts per-chat state for chats whose transcript file has disappeared or been idle for over an hour. Long-running sessions no longer accumulate per-chat state indefinitely.
- Sidebar webview updates are now coalesced (~100 ms) and de-duplicated by serialized payload, so bursty events no longer cause repeated full re-renders.
- `CacheKeepManager` stops opening its own duplicate `Cache Timer` output channel and now shares the one created in `extension.ts`. Internal per-tick chat lookup is O(1) instead of a full sorted-list scan.

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

[Unreleased]: https://github.com/agastalver/cache-timer-extension/compare/v1.0.6...HEAD
[1.0.6]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.6
[1.0.5]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.5
[1.0.4]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.4
[1.0.3]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.3
[1.0.2]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.2
[1.0.1]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.1
[1.0.0]: https://github.com/agastalver/cache-timer-extension/releases/tag/v1.0.0
