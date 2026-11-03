#!/usr/bin/env bash
# Builds public/fonts/AgySym*.woff2: symbols TUIs use (Claude Code's ⏵ ⏺ ⎿ ✻, spinners,
# braille, dingbats …) that JetBrains Mono lacks and many phones have no font for.
# Sources: Noto Sans Symbols 2, Noto Sans Symbols, Noto Sans Math (SIL OFL 1.1).
# Needs: curl, python3 with fonttools + brotli.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
base=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -fsSL -o "$tmp/sym2.ttf" "$base/notosanssymbols2/NotoSansSymbols2-Regular.ttf"
curl -fsSL -o "$tmp/sym.ttf" "$base/notosanssymbols/NotoSansSymbols%5Bwght%5D.ttf"
curl -fsSL -o "$tmp/math.ttf" "$base/notosansmath/NotoSansMath-Regular.ttf"
curl -fsSL -o public/fonts/OFL-NotoSansSymbols.txt "$base/notosanssymbols2/OFL.txt"
RANGES="U+2190-21FF,U+2300-23FF,U+2460-24FF,U+25A0-25FF,U+2600-27BF,U+2800-28FF,U+2900-297F,U+2B00-2BFF"
sub() { pyftsubset "$1" --unicodes="$2" --flavor=woff2 --output-file="$3" --layout-features='' --no-hinting --desubroutinize; }
sub "$tmp/sym2.ttf" "$RANGES" public/fonts/AgySym2.woff2
sub "$tmp/sym.ttf" "U+2300-23FF,U+2600-26FF,U+2700-27BF" public/fonts/AgySymTech.woff2
sub "$tmp/math.ttf" "U+2980-29FF,U+2A00-2AFF,U+27C0-27EF" public/fonts/AgySymMath.woff2
rm -rf "$tmp"
ls -la public/fonts/AgySym*.woff2
