#!/usr/bin/env bash
# Runs inside the emulator job of .github/workflows/android.yml.
# Installs the debug APK, starts its self test and follows logcat until it finishes.
set -uo pipefail
APK="$1"
PKG=com.sabidyut.agyterm
SHOTS=selftest-shots
mkdir -p "$SHOTS"
shot() { adb exec-out screencap -p > "$SHOTS/$1.png" 2>/dev/null || true; }

adb install -r "$APK"
# storage access, as if the user tapped "Allow" (the self test checks /sdcard inside Ubuntu)
adb shell pm grant "$PKG" android.permission.READ_EXTERNAL_STORAGE || true
adb shell pm grant "$PKG" android.permission.WRITE_EXTERNAL_STORAGE || true
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" --ez selftest true
sleep 5
adb shell pidof "$PKG" || { echo "app is not running"; adb logcat -d | tail -100; exit 1; }

LIB=$(adb shell pm path "$PKG" | tr -d '\r' | sed 's/^package://; s#/base.apk##')/lib/x86_64
echo "--- proot --version"
adb shell "mkdir -p /data/local/tmp/agylib && ln -sf $LIB/libtalloc.so /data/local/tmp/agylib/libtalloc.so.2 && LD_LIBRARY_PATH=/data/local/tmp/agylib:$LIB $LIB/libproot.so --version" | head -3

echo "--- self test (up to 30 min)"
# Phase 1: Ubuntu install + agy/claude setup + `--version`s     (SELFTEST_OK)
# Phase 2: `agy` opened through the real web UI draws its screen  (SELFTEST_AGY_OK)
# Phase 3: keys typed on the keyboard reach the shell             (SELFTEST_TYPE_OK)
#          …and still do after scrolling the terminal             (SELFTEST_TYPE_AFTER_SWIPE_OK)
#          ble.sh autosuggestions are attached in the shell       (SELFTEST_BLE_OK)
#          and the phone's storage is visible in /sdcard           (SELFTEST_STORAGE_OK)
# Phase 4: Claude Code opened through the real web UI draws        (SELFTEST_CLAUDE_OK)
deadline=$((SECONDS + 1800))
result=1
typed=0
shot_agy=0
suggest=0
while [ $SECONDS -lt $deadline ]; do
  log=$(adb logcat -d -s AgySelfTest:* AndroidRuntime:E 2>/dev/null)
  if [ $typed -eq 0 ] && grep -q "SELFTEST_TYPE_READY" <<<"$log"; then
    echo "--- typing 'expr 40 + 2' + Enter via adb (key events → focused view)"
    adb shell input text 'expr%s40%s+%s2'
    adb shell input keyevent 66
    typed=1
  fi
  if [ $shot_agy -eq 0 ] && grep -q "SELFTEST_AGY_OK" <<<"$log"; then shot 1-agy; shot_agy=1; fi
  if [ $suggest -eq 0 ] && grep -q "SELFTEST_SUGGEST_READY" <<<"$log"; then
    echo "--- typing 'exp' to see the history suggestion, then the completion menu"
    adb shell input text 'exp'
    sleep 3; shot 2-suggestion
    adb shell input keyevent 67 67 67
    adb shell input text 'ls%s/'
    adb shell input keyevent 61 61
    sleep 3; shot 3-completion
    adb shell input keyevent 111     # Esc closes the menu
    adb shell input keyevent 67 67 67 67
    suggest=1
  fi
  if [ $typed -eq 1 ] && grep -q "SELFTEST_SWIPE_READY" <<<"$log"; then
    echo "--- scrolling the terminal with a swipe, then typing 'expr 50 + 5'"
    adb shell input swipe 160 220 160 400 250
    sleep 1
    adb shell input text 'expr%s50%s+%s5'
    adb shell input keyevent 66
    typed=2
  fi
  if grep -q "SELFTEST_CLAUDE_OK" <<<"$log"; then sleep 2; shot 4-claude; result=0; break; fi
  if grep -qE "SELFTEST_FAIL|SELFTEST_AGY_FAIL|SELFTEST_TYPE_FAIL|SELFTEST_BLE_FAIL|SELFTEST_STORAGE_FAIL|SELFTEST_CLAUDE_FAIL|FATAL EXCEPTION" <<<"$log"; then break; fi
  if grep -q "session exited with code [^0]" <<<"$log"; then break; fi
  sleep 5
done
adb logcat -d -s AgySelfTest:* AgyWeb:* AndroidRuntime:E | grep -vE "out: (Get|Hit|Selecting|Preparing|Unpacking|Setting up|update-alternatives)" | tail -150
shot 9-final
if [ $result -eq 0 ]; then echo "SELF TEST PASSED"; else echo "SELF TEST FAILED"; fi
exit $result
