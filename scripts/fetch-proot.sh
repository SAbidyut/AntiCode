#!/usr/bin/env bash
# Downloads proot (+ its two libraries) built for Android from the Termux package
# repository and packs them as jniLibs so Android extracts them to the app's
# nativeLibraryDir, where they may be executed.
#
#   scripts/fetch-proot.sh            # arm64-v8a and x86_64
#
# Needs: curl, ar (binutils), tar, xz.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JNI="$ROOT/android/app/src/main/jniLibs"
REPO="https://packages.termux.dev/apt/termux-main"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

declare -A ABI=( [aarch64]=arm64-v8a [x86_64]=x86_64 )

for arch in aarch64 x86_64; do
  abi="${ABI[$arch]}"
  echo "==> $arch ($abi)"
  curl -fsSL "$REPO/dists/stable/main/binary-$arch/Packages" -o "$WORK/Packages-$arch"
  mkdir -p "$WORK/$arch" "$JNI/$abi"
  for pkg in proot libtalloc libandroid-shmem; do
    file=$(awk -v p="$pkg" '$1=="Package:"{cur=$2} $1=="Filename:" && cur==p {print $2; exit}' "$WORK/Packages-$arch")
    [ -n "$file" ] || { echo "package $pkg not found" >&2; exit 1; }
    echo "    $pkg: $file"
    curl -fsSL "$REPO/$file" -o "$WORK/$pkg.deb"
    (cd "$WORK/$arch" && ar x "../$pkg.deb" && tar -xf data.tar.* && rm -f data.tar.* control.tar.* debian-binary)
  done
  usr="$WORK/$arch/data/data/com.termux/files/usr"
  # Android only extracts files named lib*.so, so rename them. The binaries themselves
  # are NOT modified (patchelf output crashes on Android's linker): proot still asks for
  # "libtalloc.so.2", which the app provides as a symlink at runtime
  # (UbuntuManager.prepareLibs → files/lib/libtalloc.so.2 → nativeLibraryDir/libtalloc.so).
  cp "$usr/bin/proot"                      "$JNI/$abi/libproot.so"
  cp "$usr/libexec/proot/loader"           "$JNI/$abi/libproot-loader.so"
  [ -f "$usr/libexec/proot/loader32" ] && cp "$usr/libexec/proot/loader32" "$JNI/$abi/libproot-loader32.so"
  cp "$(readlink -f "$usr/lib/libtalloc.so.2")"       "$JNI/$abi/libtalloc.so"
  cp "$(readlink -f "$usr/lib/libandroid-shmem.so")"  "$JNI/$abi/libandroid-shmem.so"
  ls -l "$JNI/$abi"
done
echo "done → $JNI"
