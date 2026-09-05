#!/bin/bash
# Cheese1.0 one-line installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/GITHUB_USER/cheese/main/install.sh | bash
# No Homebrew, no admin password. Downloads a private copy of Node, builds the app, installs it to /Applications.
set -euo pipefail

GITHUB_USER="${CHEESE_GITHUB_USER:-GITHUB_USER}"
REPO="https://github.com/${GITHUB_USER}/cheese"
APP="/Applications/Cheese1.0.app"
WORK="$HOME/.cheese-install"
NODE_DIR="$WORK/node"

say() { printf '\n\033[1;33m🧀 %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "This installer is for macOS only."
ARCH="$(uname -m)"; [[ "$ARCH" == "arm64" ]] && NODE_ARCH="darwin-arm64" || NODE_ARCH="darwin-x64"
[[ "$ARCH" == "arm64" ]] && EB_ARCH="arm64" || EB_ARCH="x64"

mkdir -p "$WORK"

# ---- Fast path: a prebuilt DMG attached to the GitHub release ----
DMG_URL="${REPO}/releases/latest/download/Cheese1.0-${EB_ARCH}.dmg"
if curl -fsSL -o "$WORK/Cheese1.0.dmg" "$DMG_URL" 2>/dev/null; then
  say "Found a prebuilt Cheese1.0 for your Mac, installing…"
  MNT="$(hdiutil attach -nobrowse -quiet "$WORK/Cheese1.0.dmg" | grep -o '/Volumes/.*' | head -1)"
  rm -rf "$APP"; cp -R "$MNT/Cheese1.0.app" "$APP"
  hdiutil detach -quiet "$MNT" || true
else
  # ---- Build from source ----
  say "Downloading Cheese1.0 source…"
  rm -rf "$WORK/src"; mkdir -p "$WORK/src"
  curl -fsSL "${REPO}/archive/refs/heads/main.zip" -o "$WORK/src.zip" || die "Could not download ${REPO}. Is the repo public and the username right?"
  unzip -q -o "$WORK/src.zip" -d "$WORK/src"
  SRC="$(find "$WORK/src" -maxdepth 1 -mindepth 1 -type d | head -1)"

  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
    if [[ ! -x "$NODE_DIR/bin/node" ]]; then
      say "Downloading a private copy of Node.js (no system changes)…"
      NODE_TGZ="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o "node-v22[0-9.]*-${NODE_ARCH}.tar.gz" | head -1)"
      [[ -n "$NODE_TGZ" ]] || die "Couldn't find a Node download."
      curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODE_TGZ}" -o "$WORK/node.tgz"
      rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
      tar -xzf "$WORK/node.tgz" -C "$NODE_DIR" --strip-components=1
    fi
    export PATH="$NODE_DIR/bin:$PATH"
  fi

  say "Installing dependencies (this can take a minute)…"
  cd "$SRC"
  npm install --no-audit --no-fund --loglevel=error

  say "Building the app…"
  npx electron-builder --mac --"$EB_ARCH" --publish never >"$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; die "Build failed — see $WORK/build.log"; }

  DMG="$(ls dist/*.dmg | head -1)"
  say "Installing to /Applications…"
  MNT="$(hdiutil attach -nobrowse -quiet "$DMG" | grep -o '/Volumes/.*' | head -1)"
  rm -rf "$APP"; cp -R "$MNT/Cheese1.0.app" "$APP"
  hdiutil detach -quiet "$MNT" || true
  cp "$DMG" "$HOME/Downloads/Cheese1.0.dmg" 2>/dev/null || true
fi

# Unsigned app → strip the quarantine flag so Gatekeeper doesn't block it.
xattr -cr "$APP" 2>/dev/null || true

say "Done! Cheese1.0 is in your Applications folder. Opening it now…"
echo "   • Add your API key in Settings (⚙), then click Start screen share."
echo "   • macOS will ask for Screen Recording permission — allow it, then quit & reopen Cheese once."
open "$APP"
