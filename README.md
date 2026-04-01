# Cache Timer Extension for Cursor

A VS Code / Cursor extension that tracks the 5-minute prompt cache TTL for your LLM chat sessions.

## Features

- **Status bar countdown** — shows `Cache: M:SS` for the most recent chat, color-coded green/yellow/red as time expires
- **Sidebar panel** — lists all tracked chats grouped by Today, Yesterday, Last Week, and Older (collapsed by default)
- **Click to open chat** — click any chat card in the sidebar to open that conversation in Cursor
- **Chat titles from Cursor** — reads the actual chat titles from Cursor's internal database
- **Expiry alerts** — warning notification at 30s remaining, error notification when cache expires
- **Auto-detection** — watches Cursor's agent transcript files and resets the timer when the assistant responds
- **Configurable TTL** — defaults to 280 seconds (4 minutes 40 seconds), adjustable via settings
- **Settings gear** — click the gear icon in the sidebar title bar to open extension settings

## How it works

The extension monitors `~/.cursor/projects/<workspace-slug>/agent-transcripts/` for `.jsonl` file changes. When a new assistant message is detected, the cache timer for that chat resets to the configured TTL and begins counting down.

Chat titles are read from Cursor's workspace-specific SQLite database (`state.vscdb`) and refreshed every 10 seconds.

## Installation (from VSIX)

1. Get a `.vsix` file (e.g. a release asset named `cache-timer-extension-<version>.vsix`, or build one locally with `make package` in this repo).
2. Install it using one of the following:
   - **Command line (Cursor):** `cursor --install-extension /path/to/cache-timer-extension-<version>.vsix`
   - **Command line (VS Code):** `code --install-extension /path/to/cache-timer-extension-<version>.vsix`
   - **UI:** open **Extensions**, click **`...`** on the Extensions view title bar, choose **Install from VSIX...**, and pick the file.

Restart the editor if the extension does not activate immediately.

## Installation (development)

```bash
pnpm install
pnpm run build
```

Then press **F5** in Cursor/VS Code to launch the Extension Development Host.

## Settings

| Setting | Default | Description |
|---|---|---|
| `cacheTimer.ttlSeconds` | `280` | Cache time-to-live in seconds |

## Commands

| Command | Description |
|---|---|
| `Cache Timer: Reset All Timers` | Clears all tracked timers |
| `Cache Timer: Show Panel` | Opens the sidebar timer panel |
| `Cache Timer: Open Settings` | Opens extension settings |
