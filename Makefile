.PHONY: install build watch clean package install-ext uninstall-ext dev

EXTENSION_NAME := cache-timer-extension
VERSION := $(shell node -p "require('./package.json').version")
VSIX := $(EXTENSION_NAME)-$(VERSION).vsix
CURSOR_EXT_DIR := $(HOME)/.cursor/extensions/$(EXTENSION_NAME)

# Install dependencies
install:
	pnpm install

# Development build
build: install
	pnpm run build

# Watch mode for development (rebuilds on file changes)
watch: install
	pnpm run watch

# Production build (minified)
build-prod: install
	pnpm run vscode:prepublish

# Package into a .vsix file
package: build-prod
	@command -v vsce >/dev/null 2>&1 || { echo "Installing @vscode/vsce..."; pnpm add -g @vscode/vsce; }
	@cp package.json package.json.bak
	@node -e " \
		const fs = require('fs'); \
		const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
		delete p.scripts['vscode:prepublish']; \
		fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');"
	vsce package --no-dependencies --allow-missing-repository || { mv package.json.bak package.json; exit 1; }
	@mv package.json.bak package.json
	@echo "Packaged: $(VSIX)"

# Install the extension into Cursor via .vsix
install-ext: package
	@if command -v cursor >/dev/null 2>&1; then \
		cursor --install-extension $(VSIX); \
	else \
		echo "Cursor CLI not found. Install manually:"; \
		echo "  Extensions: Install from VSIX... -> $(VSIX)"; \
	fi

# Install via symlink (quick local development)
install-link: build
	@ln -sfn $(CURDIR) $(CURSOR_EXT_DIR)
	@echo "Symlinked to $(CURSOR_EXT_DIR)"
	@echo "Restart Cursor to load the extension."

# Uninstall the symlink
uninstall-link:
	@rm -f $(CURSOR_EXT_DIR)
	@echo "Removed symlink. Restart Cursor."

# Clean build artifacts
clean:
	rm -rf dist/*.js dist/*.map *.vsix

# Dev: build + symlink install
dev: build install-link
