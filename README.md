# Cache Timer for Cursor

[![CI](https://img.shields.io/github/actions/workflow/status/agastalver/cache-timer-extension/ci.yml?branch=main)](https://github.com/agastalver/cache-timer-extension/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/agastalver/cache-timer-extension)](./LICENSE)
[![Open VSX](https://img.shields.io/open-vsx/v/agastalver/cache-timer-extension)](https://open-vsx.org/extension/agastalver/cache-timer-extension)

**Cache Timer** shows a per-chat countdown for the LLM prompt cache window in Cursor agent chats by reading Cursor’s agent transcript layout under `.cursor/` (for example `agent-transcripts/`).

## Screenshot

![Cache Timer overview](screenshot.png)

1. **Sidebar panel** — tracked chats with progress and countdown; each card has a **Cache Keep** control you can use to get nudged before the TTL runs out (see [Features](#features)).
2. **Expiry alert (≤30s)** — a notification when a chat’s cache is about to expire (there is also an alert when it has expired).
3. **Status bar** — one compact timer per open chat (`Cache: M:SS`), color-coded with the same urgency as the panel.

## Features

- **Status bar countdown** — each open chat gets its own status bar item showing `Cache: M:SS`, color-coded green/yellow/red as time expires
- **Sidebar panel** — lists all tracked chats grouped by Today, Last 7 Days, and Older
- **Click to open chat** — click any chat card in the sidebar to open that conversation in Cursor
- **Chat titles** — displays the actual chat titles assigned by Cursor
- **Streaming detection** — shows a streaming indicator when the assistant is actively responding
- **Expiry alerts** — warning notification at 30 seconds remaining, error notification when the cache expires
- **Cache Keep** — per-chat toggle that nudges you to send a keep-alive message before the cache TTL expires, extending the cache window for a configurable duration (default 30 minutes)
- **Auto-detection** — watches Cursor's agent transcript files and folder for changes; resets the timer when a new assistant response is detected
- **Configurable** — adjust both the cache TTL and keep-alive duration via settings or sidebar commands

## Why trust this extension?

- **Open source** — source is in this repository; you can review what runs on your machine.
- **Distributed via registries** — install from the Cursor/VS Code extension flow or from [Open VSX](https://open-vsx.org/extension/agastalver/cache-timer-extension) once published there.
- **No bundled telemetry** — the extension does not add its own analytics or phone home; behavior is local file watching and UI.
- **Responsible disclosure** — see [SECURITY.md](SECURITY.md) for how to report issues privately.
- **Automated checks** — CI runs on `main` (see badge above). Open VSX releases are published from GitHub Actions when a version tag is pushed from `main` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Privacy and security

- **Local data use** — the extension reads workspace files (under `.cursor/` and related paths) to find transcripts and titles so it can show timers. It does not upload that content to a remote service as part of its design.
- **No extra network** — extension code does not perform arbitrary outbound HTTP requests for core behavior. The sidebar uses a webview; messaging stays between the webview and the extension host.
- **Permissions** — follow Cursor’s extension permission prompts; they reflect what the host allows the extension to access in your workspace.

Details and scope: [SECURITY.md](SECURITY.md).

## Installation

**Requirements:** VS Code API `^1.85.0` (see `engines` in [package.json](package.json)). Works where Cursor supports that engine.

### From the Marketplace

In Cursor, open the Extensions view, search for **Cache Timer**, and click **Install**.

### From Open VSX

[Cache Timer on Open VSX](https://open-vsx.org/extension/agastalver/cache-timer-extension) (when published).

### From VSIX

1. Get a `.vsix` file (e.g. a release asset or build one locally with `make package`).
2. Install it using one of the following:
   - **Command line:** `cursor --install-extension cache-timer-extension-<version>.vsix`
   - **UI:** in Cursor, open **Extensions**, click **`...`** on the Extensions view title bar, choose **Install from VSIX...**, and pick the file.

Restart Cursor if the extension does not activate immediately.

## Known limitations

- **WSL projects:** Some users report that the extension does not work correctly when the workspace or project lives under WSL (Windows Subsystem for Linux). Timers and chat detection may not behave as expected in that setup. If you rely on WSL-hosted paths, consider tracking this as a known gap until a fix lands.

## Settings

| Setting | Default | Description |
|---|---|---|
| `cacheTimer.ttlSeconds` | `280` | Cache time-to-live in seconds (4 min 40 sec) |
| `cacheTimer.cacheKeepDurationSeconds` | `1800` | Duration of a cache-keep session in seconds (30 min). Minimum: 60 |

## Commands

| Command | Description |
|---|---|
| `Cache Timer: Show Panel` | Opens the sidebar timer panel |
| `Cache Timer: Open Chat` | Opens the selected chat in Cursor |
| `Cache Timer: Open Settings` | Opens extension settings |
| `Cache Timer: Edit TTL` | Prompts to change the cache TTL value |
| `Cache Timer: Edit Keep Duration` | Prompts to change the cache-keep session duration |
| `Cache Timer: Refresh` | Manually refreshes timer data and sidebar |

## Development

Install dependencies and build:

```bash
pnpm install
pnpm run build
```

**`package.json` scripts**

| Script | Purpose |
|--------|---------|
| `pnpm run build` | Development bundle (`dist/extension.js`) |
| `pnpm run watch` | Rebuild on file changes |
| `pnpm run vscode:prepublish` | Production (minified) build used before packaging (standard script name from the extension toolchain) |

**Makefile** (optional): `make install`, `make build`, `make watch`, `make package` (builds a `.vsix` via `vsce`), `make dev` (build + symlink into Cursor’s extensions folder for local testing).

Press **F5** in Cursor to launch the Extension Development Host and try the extension.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (including **release tagging** for Open VSX).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Marketplace vs this README

On the marketplace **listing**, users mainly see the extension **name** (`displayName` in `package.json`), **icon**, and the **short description** (the `description` field — one line). The **full README** is what appears on the extension **detail page** as the long description when you publish. Keep screenshots and setup notes here so that page stays clear for new users.

## License

Licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (SPDX: `AGPL-3.0`). The full license text is shipped with the extension as [LICENSE](LICENSE).
