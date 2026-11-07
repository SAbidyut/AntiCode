# AntiCode

ফোনের ভিতরে পুরো **Ubuntu** + **Antigravity CLI (`agy`)** + **Claude Code (`claude`)** + **Codex CLI (`codex`)** + **OpenCode (`opencode`)**, এমন টার্মিনালে যেখানে **বাংলা (Kalpurush) আর English দুটোই নিখুঁত** দেখায়।
সাথে Mac/PC তে চলা Antigravity আর Claude Code কে ফোন থেকে **রিমোট কন্ট্রোল** করার শর্টকাট।

## ফোনে ইনস্টল

1. এই রিপোর **Releases → `latest`** পেজ ফোনে খুলুন, **`AntiCode.apk`** নামান।
2. ইনস্টল করুন (প্রথমবার "অজানা উৎস থেকে ইনস্টল" অনুমতি চাইবে)।
   Android সতর্ক করতে পারে যে অ্যাপটা পুরোনো Android এর জন্য বানানো — এটা ইচ্ছাকৃত (নিচে দেখুন), "Install anyway" চাপুন।
3. অ্যাপ খুলে **Ubuntu সেটআপ করুন** চাপুন (একবারই, ~৩০MB ডাউনলোড)।
4. **✦ Antigravity চালান** চাপুন। প্রথমবার নিজে থেকেই `curl`, `git` ইত্যাদি আর Google এর অফিসিয়াল ইনস্টলার
   (`curl -fsSL https://antigravity.google/cli/install.sh | bash`) দিয়ে `agy` ইনস্টল হবে, তারপর Google লগইন চাইবে —
   লগইন লিংক ফোনের ব্রাউজারে খুলে যাবে।
5. **Claude Code** টাইলে চাপুন। প্রথমবার Anthropic এর অফিসিয়াল ইনস্টলার (`curl -fsSL https://claude.ai/install.sh | bash`,
   ~১২০MB ডাউনলোড) দিয়ে `claude` ইনস্টল হবে, তারপর Claude অ্যাকাউন্টে লগইন চাইবে।
6. **Codex** টাইলে চাপুন। প্রথমবার OpenAI এর অফিসিয়াল npm প্যাকেজের ফোনের জন্য বানানো প্রোগ্রাম (`@openai/codex`,
   ~১৭০MB ডাউনলোড; Node.js লাগে না) নামিয়ে `codex` ইনস্টল হবে, তারপর ChatGPT দিয়ে লগইন বা API key চাইবে।
   Android এ Codex এর sandbox চলে না (Linux namespaces বন্ধ), তাই `~/.codex/config.toml` এ
   `sandbox_mode = "danger-full-access"` বসানো হয় — কমান্ড চালানোর আগে Codex তবুও অনুমতি চায়।
7. **OpenCode** টাইলে চাপুন। প্রথমবার OpenCode 2 এর অফিসিয়াল npm প্যাকেজের প্রোগ্রাম (`@opencode/cli-linux-arm64`, ~১২০MB) দিয়ে
   `opencode` ইনস্টল হবে। `/models` এ মডেল বাছুন (কয়েকটা ফ্রি), `/connect` দিয়ে কোনো provider এ সাইন ইন।
   শুরু থেকেই ইনপুট বক্স নিচে রাখতে OpenCode এর ছোট ভিউ (`opencode mini`) খোলে।

## ব্যবহার

অ্যাপের UI ইংরেজিতে; টার্মিনালের লেখায় বাংলা (Kalpurush) পুরোপুরি সাপোর্টেড।

| কাজ | কীভাবে |
|---|---|
| টার্মিনালে টাইপ | টার্মিনালে ট্যাপ করুন — কীবোর্ড খুলবে, প্রতিটা অক্ষর সাথে সাথে টার্মিনালে যাবে |
| Esc, Tab, Ctrl, ^C, তীর | কীবোর্ডের উপরের এক সারির কী-বার; ⌨ বাটনে কীবোর্ড খোলা/বন্ধ |
| Auto-suggestion / auto-complete | লিখতে শুরু করলে আগের কমান্ড ধূসর রঙে দেখায় (→ বা End দিয়ে নিন); Tab = মেনু; বন্ধ করতে `agy-autocomplete off` |
| কাজ শেষের notification | এজেন্টের উত্তর বা লম্বা কমান্ড শেষ হলে notification আসে (যে সেশন দেখছেন সেটা বাদে); ট্যাপ করলে সেই সেশন খোলে। Settings থেকে বন্ধ করা যায় |
| সেশনের নাম | হোম আর ট্যাবে প্রতিটা সেশনের কাজ দেখায়; লম্বা চাপ দিয়ে নাম বদলান |
| ফোনের ফাইল | হোমে **Phone storage → Allow access**, বা Ubuntu তে `setup-storage`; তারপর `/sdcard` আর `~/storage/downloads`, `dcim`, `pictures` … |
| Mac এর রিমোট ড্যাশবোর্ড | হোমে Remote control → **Open**, বা টপবারের রিমোট আইকন — অ্যাপের ভিতরের নিজস্ব প্যানেলে খোলে |
| পড়া/কপি, পেস্ট, টেক্সট ছোট-বড়, থিম | টপবারের ⋮ মেনু; Settings (Midnight / Dracula / Solarized / Paper, কার্সর, Animations) |
| স্ক্রল / ফন্ট | আঙুলে স্ক্রল (মোমেন্টাম সহ), দুই আঙুলে পিঞ্চ; লম্বা চাপ = Reader view |
| কীবোর্ড ঠিকমতো টাইপ না করলে | Settings → **Keyboard compatibility mode** |
| prompt এর ডিজাইন | Oh-My-Posh ধাঁচের powerline prompt; `agy-prompt simple` বা `agy-prompt powerline` |
| আবার সেটআপ | Ubuntu তে `agy-setup` / `claude-setup` / `codex-setup` / `opencode-setup` (শুধু apt টুল: `term-setup`) |
| কিছু ঠিকমতো না চললে | ⋮ → **Copy debug log** → চ্যাটে পেস্ট করুন |

অ্যাপ বন্ধ করলেও সেশন চলতে থাকে (নোটিফিকেশনে দেখা যায়); নোটিফিকেশনের "Stop all" দিয়ে থামানো যায়।
অ্যাপ ব্যাকগ্রাউন্ডে গেলে টার্মিনালের স্ক্রিন কোনো কাজ করে না (আউটপুট অ্যাপের ভিতরে জমা থাকে); ৩ মিনিট পর, অনেক আউটপুট জমলে,
বা ফোনে মেমোরি কম পড়লে স্ক্রিনটা পুরো ছেড়ে দেয় — মেমোরি অন্য অ্যাপ পায়, ফিরে এলে সেশনগুলো আগের মতো আবার দেখা যায়।

## Mac/PC এর রিমোট কন্ট্রোল

### Antigravity

Mac এর টার্মিনালে `agy --remote-control` (বা চলমান agy তে `/remote-control`) দিন।
তারপর অ্যাপের হোমে **রিমোট ড্যাশবোর্ড খুলুন** — একই Google অ্যাকাউন্টে লগইন করলে Mac এ চলা সব কাজ দেখা ও কন্ট্রোল করা যায়।
ড্যাশবোর্ড অ্যাপের নিজস্ব প্যানেলে খোলে (ব্রাউজারের URL বার ছাড়া, ← দিয়ে ফেরা)। Google নিরাপত্তার কারণে অ্যাপের
ভিতরের ব্রাউজারে Google লগইন করতে দেয় না — পেজ Google লগইনে গেলে সেই সাইট নিজে থেকেই Chrome ট্যাবে চলে যায়
(পরের বার থেকে সরাসরি)। ঠিকানা Settings এ বদলানো যায়।

### Claude Code

Mac এর টার্মিনালে `claude --remote-control` দিন (বা চলমান Claude Code এ `/remote-control`)। সবসময় চালু রাখতে Claude Code এ
`/config` → **Enable Remote Control for all sessions**। তারপর অ্যাপের হোমে Claude Code → **Open** — একই Claude অ্যাকাউন্টে
(Pro/Max প্ল্যান) লগইন করলে সেশনগুলো দেখা ও কন্ট্রোল করা যায়। অ্যাপের ভিতরে থাকতে "Continue with email" দিয়ে লগইন করুন
(Google দিয়ে লগইন করলে Chrome ট্যাবে খুলবে)।

## কীভাবে কাজ করে

```
web-terminal/   টার্মিনাল UI (TypeScript): headless xterm.js + নিজস্ব DOM renderer
android/        Kotlin অ্যাপ: WebView, JNI PTY, foreground service, Ubuntu ইনস্টলার/লঞ্চার
scripts/        fetch-proot.sh — Termux এর proot বিল্ড jniLibs হিসেবে প্যাক করে
```

- **বাংলা কেন ঠিক দেখায়:** সাধারণ টার্মিনাল প্রতিটা অক্ষর আলাদা ঘরে আঁকে, তাই যুক্তাক্ষর (ক্ষ, স্ত্র) আর কার ভেঙে যায়।
  এখানে প্রতিটা বাংলা অংশ একসাথে ব্রাউজারের text shaper দিয়ে Kalpurush এ আঁকা হয়, তারপর ঠিক যতগুলো ঘর তার জন্য
  বরাদ্দ সেই মাপে বসানো হয় — ফলে বাংলা নিখুঁত, আর বক্স/কলাম/কার্সর গ্রিডেই থাকে (`web-terminal/src/term/renderer.ts`)।
- **Ubuntu:** অফিসিয়াল Ubuntu Base 24.04 অ্যাপের নিজস্ব স্টোরেজে নামিয়ে `proot` দিয়ে চালানো হয় — root লাগে না।
- **targetSdk 28:** Android 10+ এ নতুন target এর অ্যাপ নিজের নামানো ফাইল চালাতে পারে না; Ubuntu চালাতে এটা লাগে
  (Termux ও একই কাজ করে)। তাই অ্যাপটা Play Store এ নয়, সরাসরি APK হিসেবে দেওয়া হয়।

## নিজে বিল্ড করা

```bash
cd web-terminal && npm ci && npm run build && cd ..
scripts/fetch-proot.sh            # লাগবে: curl, ar, tar
cd android && ./gradlew assembleRelease
```

প্রতিবার push এ GitHub Actions নিজেই APK বানিয়ে `latest` রিলিজে দেয় (`.github/workflows/android.yml`)।
সব বিল্ড একই key (`android/app/agyterm-sideload.jks`) দিয়ে sign হয়, তাই নতুন APK পুরোনোটার উপরেই ইনস্টল হয় — Ubuntu/সেশন মুছে যায় না।

CI তে একটা Android emulator এ অ্যাপের **self test** চলে: Ubuntu নামানো → proot দিয়ে চালু → `agy-setup` (apt + অফিসিয়াল ইনস্টলার) → `agy --version`
+ `claude-setup` → `claude --version`
→ তারপর আসল UI দিয়ে `agy` আর Claude Code খুলে তাদের স্ক্রিন আঁকা হচ্ছে কিনা, কীবোর্ডে টাইপ করা লেখা শেলে পৌঁছায় কিনা, আর `/sdcard` এ ফোনের ফাইল দেখা যায় কিনা যাচাই। Web UI এর e2e টেস্টও (Chromium, আসল bash) CI তে চলে।
নিজে চালাতে: debug APK ইনস্টল করে `adb shell am start -n com.sabidyut.agyterm/.MainActivity --ez selftest true`, লগ: `adb logcat -s AgySelfTest`।

ব্রাউজারে UI ডেভেলপমেন্ট (আসল bash সহ, শুধু localhost এ):

```bash
cd web-terminal
npm run devbridge &          # 127.0.0.1:7681
npm run dev                  # তারপর Vite এর URL খুলুন
node dev/e2e.mjs             # end-to-end চেক (playwright লাগবে)
```

## লাইসেন্স / ক্রেডিট

- Kalpurush ফন্ট — Avro Font Development Project, OmicronLab (SIL OFL 1.0); JetBrains Mono, Noto Sans Symbols (SIL OFL 1.1)
- ble.sh — Koichi Murase (BSD-3-Clause)
- proot — Termux প্যাকেজ (GPL-2.0), xterm.js (MIT), Apache Commons Compress (Apache-2.0)
- Antigravity CLI Google এর, Claude Code Anthropic এর, Codex CLI OpenAI এর, OpenCode তার নির্মাতাদের; এই অ্যাপ শুধু তাদের অফিসিয়াল ইনস্টলার / প্যাকেজ চালায়।
