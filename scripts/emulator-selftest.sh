#!/usr/bin/env bash
# Runs inside the emulator job of .github/workflows/android.yml.
# Installs the debug APK, starts its self test and follows logcat until it finishes.
set -uo pipefail
APK="$1"
PKG=com.sabidyut.agyterm

adb install -r "$APK"
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" --ez selftest true
sleep 5
adb shell pidof "$PKG" || { echo "app is not running"; adb logcat -d | tail -100; exit 1; }

LIB=$(adb shell pm path "$PKG" | tr -d '\r' | sed 's/^package://; s#/base.apk##')/lib/x86_64
echo "--- proot --version"
adb shell "mkdir -p /data/local/tmp/agylib && ln -sf $LIB/libtalloc.so /data/local/tmp/agylib/libtalloc.so.2 && LD_LIBRARY_PATH=/data/local/tmp/agylib:$LIB $LIB/libproot.so --version" | head -3

echo "--- self test (up to 30 min)"
# Phase 1: Ubuntu install + agy-setup + `agy --version` (SELFTEST_OK)
# Phase 2: `agy` opened through the real web UI must draw its screen (SELFTEST_AGY_OK)
deadline=$((SECONDS + 1800))
result=1
while [ $SECONDS -lt $deadline ]; do
  log=$(adb logcat -d -s AgySelfTest:* AndroidRuntime:E 2>/dev/null)
  if grep -q "SELFTEST_AGY_OK" <<<"$log"; then result=0; break; fi
  if grep -qE "SELFTEST_FAIL|SELFTEST_AGY_FAIL|FATAL EXCEPTION" <<<"$log"; then break; fi
  if grep -q "session exited with code [^0]" <<<"$log"; then break; fi
  sleep 15
done
adb logcat -d -s AgySelfTest:* AgyWeb:* AndroidRuntime:E | grep -vE "out: (Get|Hit|Selecting|Preparing|Unpacking|Setting up|update-alternatives)" | tail -150
if [ $result -eq 0 ]; then echo "SELF TEST PASSED"; else echo "SELF TEST FAILED"; fi
exit $result
