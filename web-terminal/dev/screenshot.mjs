// Visual check of the Bangla rendering in a phone-sized browser.
//   node dev/bridge-server.mjs & npx vite preview --port 4173 &
//   node dev/screenshot.mjs <outDir>
import { createRequire } from 'node:module';

// Playwright is pre-installed globally in the dev container; resolve it via NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright');

const out = process.argv[2] ?? '.';
const url = process.env.URL ?? 'http://localhost:4173/?selftest=1';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2 });
page.on('console', (m) => console.log('[console]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForTimeout(1200);
// sessions from an earlier run are restored and shown; go back home first
if ((await page.getAttribute('body', 'data-screen')) === 'term') await page.click('#home-btn');
await page.screenshot({ path: `${out}/01-home.png` });

await page.click('#hero .btn-secondary');
await page.waitForTimeout(800);
const lines = [
  "printf '\\e[1;36m✦ Antigravity\\e[0m বাংলা টেস্ট\\n'",
  "echo 'ক্ষমা স্ত্রী সন্ত্রাস কৃষ্ণ জ্ঞান উজ্জ্বল — Hello World'",
  "echo 'আমি বাংলায় গান গাই। কি খবর? ১২৩৪৫'",
  "printf '╭──────────────────────────╮\\n│ আমার সোনার বাংলা  │ OK │\\n╰──────────────────────────╯\\n'",
  "printf '\\e[42;30m সবুজ পটভূমি \\e[0m \\e[31mলাল লেখা\\e[0m \\e[1mমোটা বাংলা\\e[0m\\n'",
];
for (const l of lines) {
  await page.evaluate((t) => window.__selftest.send(t), l);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/02-terminal.png` });
const text = await page.evaluate(() => window.__selftest.screen());
console.log('HAS_BANGLA', text.includes('ক্ষমা স্ত্রী সন্ত্রাস'));

await page.click('#more-btn');
await page.click('.action:has-text("Reader view")');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/03-reader.png` });
await browser.close();
