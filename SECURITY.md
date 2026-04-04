# Security policy

## Supported versions

We address security issues in the **latest release** published from this repository (see [CHANGELOG.md](CHANGELOG.md) and git tags). Older versions may not receive fixes.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for undisclosed security problems.

- Prefer **[GitHub private vulnerability reporting](https://github.com/agastalver/cache-timer-extension/security/advisories/new)** for this repository (if enabled).
- If that is unavailable, contact the maintainer via a **private** channel (for example, email shown on their GitHub profile) and include enough detail to reproduce or assess impact.

We aim to acknowledge reasonable reports promptly. Timelines depend on severity and maintainer availability.

## Scope and threat model

This extension is intended to run **locally** inside Cursor. It:

- Reads **workspace files** under `.cursor/` (and related paths) to detect agent transcripts and drive timers, as described in the README.
- Uses a **webview** for the sidebar UI; messages between the webview and the extension host stay **in-process** (no network by design for that channel).

It does **not** implement its own telemetry, analytics, or remote servers. If you find **any** unexpected network access or data exfiltration, treat that as a security-relevant bug and report it as above.

## Out of scope

- Issues that require **malicious workspace content** or **compromised local tooling** beyond what a normal extension can assume.
- Problems in **Cursor** or **third-party extensions** unless this extension is clearly at fault.
