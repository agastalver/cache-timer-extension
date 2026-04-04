# Contributing

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [pnpm](https://pnpm.io/)

## Setup

```bash
pnpm install
pnpm run build
```

Use **F5** in the editor to launch the Extension Development Host and exercise the extension.

## Scripts

| Command | Purpose |
|--------|---------|
| `pnpm run build` | Development bundle (`dist/extension.js`) |
| `pnpm run watch` | Rebuild on file changes |
| `pnpm run vscode:prepublish` | Production (minified) build |

Optional: `make package` builds a `.vsix` with `vsce` (see [Makefile](Makefile)).

## Pull requests

- Keep changes focused and consistent with existing style.
- Run `pnpm run build` before submitting.
- Describe what changed and why in the PR text.

## Releasing (maintainers): version bump on `main`, then tag

Open VSX publishing runs in GitHub Actions when you push a **version tag** whose **semver matches** `version` in [package.json](package.json). The tagged commit **must** be on `main`.

1. On `main`, update **`package.json` `version`**, **[CHANGELOG.md](CHANGELOG.md)**, and merge.
2. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. The [Release (Open VSX + GitHub)](.github/workflows/release-openvsx.yml) workflow packages a **`.vsix`**, creates a **GitHub Release** for that tag with the `.vsix` attached, then publishes **`ovsx publish`** to Open VSX. Configure repository secret **`OVSX_PAT`** (Open VSX access token) in the repo settings.

**First-time Open VSX setup:** create an account at [open-vsx.org](https://open-vsx.org), accept the publisher agreement, create an access token, and ensure your namespace exists (for example `pnpm exec ovsx create-namespace <name> -p "$OVSX_PAT"` if needed).

If `package.json` does not match the tag, or the tag is not on `main`, the workflow **fails** and nothing is published.
