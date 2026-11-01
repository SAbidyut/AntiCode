// End-to-end checks of the web terminal against the dev bridge (real bash).
//   npm run devbridge &  npx vite preview --port 4173 &  node dev/e2e.mjs
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const url = process.env.URL ?? 'http://localhost:4173/';
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
const pageErrors = [];
page.on('pageerror', (e) => {
  pageErrors.push(e.message);
  console.log('[pageerror]', e.message);
});
await page.goto(url);
await page.waitForTimeout(1000);
if ((await page.getAttribute('body', 'data-screen')) === 'term') await page.click('#home-btn');

// Rows are absolutely positioned by line number; read them back in order.
const screenText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.session:not([hidden]) .term-row')]
      .map((r) => [Number(/translateY\(([-\d.]+)px\)/.exec(r.style.transform)?.[1] ?? 0), r.textContent])
      .sort((a, b) => a[0] - b[0])
      .map((r) => r[1])
      .join('\n'),
  );
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

// 1. new Ubuntu session from the home screen
await page.click('#hero .btn-secondary');
check('terminal screen opens', await waitFor(async () => (await page.getAttribute('body', 'data-screen')) === 'term'));
// the compose bar is optional: turn it on from the key bar
if (await page.isHidden('#compose-bar')) await page.dispatchEvent('#compose-key', 'pointerdown');
check('compose bar toggles on', await page.isVisible('#compose-bar'));

// 2. compose box → Bangla command
await page.fill('#compose', "echo 'ক্ষমা-'$((40+2))");
await page.dispatchEvent('#send', 'pointerdown');
check('compose box runs Bangla command', await waitFor(async () => (await screenText()).includes('ক্ষমা-42')));

// 2b. the queries the Antigravity CLI sends at startup must not break the terminal
//     (regression: a minifier bug made DECRQM throw and froze the screen) and get answers.
await page.fill(
  '#compose',
  "printf '\\e[>q\\e[c\\e[?2026$p\\e[?2027$p\\e]11;?\\a\\e]7501;?\\a\\e[?u'; read -rs -t 1 -N 300 r; " +
    "printf '%q\\n' \"$r\" | tr -d '\\\\' | head -c 200; echo; echo AFTER-$((2+2))",
);
await page.dispatchEvent('#send', 'pointerdown');
check('agy startup queries keep the screen alive', await waitFor(async () => (await screenText()).includes('AFTER-4')));
const replies = await screenText();
check('DA1 + DECRQM + XTVERSION answered', replies.includes('?1;2c') && replies.includes('2026;2$y') && replies.includes('AgyTerminal'));
check('background colour (OSC 11) answered', replies.includes('11;rgb:'));

// 3. direct typing (hardware keyboard path)
await page.focus('#kbd');
await page.keyboard.type('echo typed-$((6*7))');
await page.keyboard.press('Enter');
check('direct typing + Enter', await waitFor(async () => (await screenText()).includes('typed-42')));

// 4. key bar: Ctrl latch + c interrupts
await page.focus('#kbd');
await page.keyboard.type('sleep 30');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await page.locator('.key', { hasText: '^C' }).dispatchEvent('pointerdown');
await page.fill('#compose', 'echo after-$((1+1))');
await page.dispatchEvent('#send', 'pointerdown');
check('^C key interrupts', await waitFor(async () => (await screenText()).includes('after-2')));

// 5. OSC 7770 (our xdg-open shim) opens the URL
const popup = page.waitForEvent('popup', { timeout: 4000 }).then(() => true).catch(() => false);
await page.fill('#compose', "printf '\\033]7770;open;https://example.com/login\\007'");
await page.dispatchEvent('#send', 'pointerdown');
check('xdg-open escape opens the browser', await popup);

// 6. reader view (from the ⋮ sheet) shows logical lines
await page.click('#more-btn');
await page.click('.action:has-text("Reader view")');
await page.waitForTimeout(300);
const readerText = await page.evaluate(() => document.querySelector('.session:not([hidden]) .reader')?.textContent ?? '');
check('reader view has text', readerText.includes('ক্ষমা-42') && readerText.includes('typed-42'));
await page.click('#more-btn');
await page.click('.action:has-text("Back to terminal")');
await page.waitForTimeout(300);

// 7. resize → stty sees the new size
await page.setViewportSize({ width: 700, height: 860 });
await page.waitForTimeout(400);
const cols = await page.evaluate(() => {
  const w = document.querySelector('#sessions').getBoundingClientRect().width;
  return w;
});
await page.fill('#compose', 'stty size');
await page.dispatchEvent('#send', 'pointerdown');
await page.waitForTimeout(500);
const txt = await screenText();
const m = txt.match(/(\d+) (\d+)\s*\S*\$?\s*$/m) ?? txt.match(/\b(\d{2}) (\d{2,3})\b(?![\s\S]*\b\d{2} \d{2,3}\b)/);
check(`resize reaches the PTY (stty: ${m?.[0]?.trim()}, width ${Math.round(cols)}px)`, !!m && +m[2] > 60);

// 8. reload → session restored with its output
await page.reload();
await page.waitForTimeout(1500);
check('session restored after reload', await waitFor(async () => (await screenText()).includes('typed-42')));

check('no JavaScript errors', pageErrors.length === 0);

await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
