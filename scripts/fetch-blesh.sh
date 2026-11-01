#!/usr/bin/env bash
# Downloads ble.sh (Bash Line Editor: fish-like autosuggestions, completion menu and
# syntax highlighting for bash, BSD-3-Clause) and packs it into the APK's assets.
# The app unpacks it into Ubuntu's /usr/share/blesh.
#
#   scripts/fetch-blesh.sh
set -euo pipefail
VERSION=0.4.0-devel3
SHA256=c8612ee612bc6b10dbfd6e85c6cbdfd7caf152a12d1f9de22ea0a9d735b3080c
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/android/app/src/main/assets"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL -o "$WORK/ble.tar.xz" \
  "https://github.com/akinomyoga/ble.sh/releases/download/v$VERSION/ble-$VERSION.tar.xz"
echo "$SHA256  $WORK/ble.tar.xz" | sha256sum -c -
mkdir -p "$WORK/x"
tar -xJf "$WORK/ble.tar.xz" -C "$WORK/x"
# repack without the top folder (the app reads gzip, not xz)
tar -czf "$ASSETS/blesh.tar.gz" -C "$WORK/x/ble-$VERSION" .
echo "$VERSION" > "$ASSETS/blesh.version"
ls -la "$ASSETS/blesh.tar.gz"
