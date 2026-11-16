// End-to-end checks of the web terminal against the dev bridge (real bash).
//   npm run devbridge &  npx vite preview --port 4173 &  node dev/e2e.mjs
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const url = process.env.URL ?? 'http://localhost:4173/?selftest=1&linktoken=t0k3n';
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 412, height: 860 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
const page = await context.newPage();
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
// it asks which folder to start in: the first offer (the last one used, or home)
await page.waitForSelector('#sheet:not([hidden]) .fp-row.recent', { timeout: 5000 }).catch(() => {});
check('Ubuntu shell asks for a folder', await page.evaluate(() => /Open Ubuntu shell in/.test(document.querySelector('#sheet:not([hidden]) h3')?.textContent ?? '')));
await page.click('#sheet:not([hidden]) .fp-row.recent');
check('terminal screen opens', await waitFor(async () => (await page.getAttribute('body', 'data-screen')) === 'term'));
// a line of input, as typed and sent with Enter (the self-test hook)
const send = (text) => page.evaluate((t) => window.__selftest.send(t), text);
check('key bar is one row', await page.evaluate(() => {
  const keys = [...document.querySelectorAll('#extra-keys .key')];
  return keys.length > 5 && new Set(keys.map((k) => Math.round(k.getBoundingClientRect().top))).size === 1;
}));

// (the shell's first prompt first: a line typed before bash has started can be lost)
await waitFor(async () => /[$#] *$/m.test(await screenText()), 10000);
// 2. Bangla command
await send("echo 'ক্ষমা-'$((40+2))");
check('runs a Bangla command', await waitFor(async () => (await screenText()).includes('ক্ষমা-42'), 8000));

// 2b. the queries the Antigravity CLI sends at startup must not break the terminal
//     (regression: a minifier bug made DECRQM throw and froze the screen) and get answers.
await send("printf '\\e[>q\\e[c\\e[?2026$p\\e[?2027$p\\e]11;?\\a\\e]7501;?\\a\\e[?u'; read -rs -t 1 -N 300 r; " +
    "printf '%q\\n' \"$r\" | tr -d '\\\\' | head -c 600; echo; echo AFTER-$((2+2))",
);
check('agy startup queries keep the screen alive', await waitFor(async () => (await screenText()).includes('AFTER-4')));
const replies = await screenText();
check('DA1 + DECRQM + XTVERSION answered', replies.includes('?1;2c') && replies.includes('2026;2$y') && replies.includes('AgyTerminal'));
check('grapheme clustering (mode 2027) reported as on', replies.replace(/\s*\n/g, '').includes('2027;3$y'));
check('background colour (OSC 11) answered', replies.includes('11;rgb:'));

// 2c. Bangla with a different colour on every letter (how streaming CLIs fade text in)
//     must still be shaped: no text piece may start with a vowel sign / virama.
await send("python3 -c \"import sys;w='ফাইলটি সফলভাবে আপনার ফোল্ডারে';sys.stdout.write(''.join('\\x1b[38;2;%d;200;220m'%(150+i)+c for i,c in enumerate(w))+'\\x1b[0m\\n')\"",
);
await waitFor(async () => (await screenText()).includes('ফোল্ডারে'));
const brokenPieces = await page.evaluate(() =>
  [...document.querySelectorAll('.session:not([hidden]) .bi')].flatMap((bi) =>
    [...bi.childNodes].map((n) => n.textContent ?? '').filter((t) => /^[\u0981-\u0983\u09bc\u09be-\u09cd\u09d7]/.test(t)),
  ),
);
check(`per-letter coloured Bangla stays shaped (${brokenPieces.length} broken pieces)`, brokenPieces.length === 0);

// 3. direct typing (hardware keyboard path)
await page.focus('#kbd');
await page.keyboard.type('echo typed-$((6*7))');
await page.keyboard.press('Enter');
check('direct typing + Enter', await waitFor(async () => (await screenText()).includes('typed-42'), 8000));

// 4. key bar: Ctrl latch + c interrupts
await page.focus('#kbd');
await page.keyboard.type('sleep 30');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await page.locator('.key', { hasText: '^C' }).dispatchEvent('pointerdown');
await send('echo after-$((1+1))');
check('^C key interrupts', await waitFor(async () => (await screenText()).includes('after-2')));

// 5. OSC 7770 (our xdg-open shim, signed with the session's token) opens the URL
const popup = page.waitForEvent('popup', { timeout: 4000 }).then(() => true).catch(() => false);
await send("printf '\\033]7770;open;t0k3n;https://example.com/login\\007'");
check('xdg-open escape opens the browser', await popup);
// the same escape without the token (e.g. `cat` of a downloaded file) only asks
let popped = false;
page.once('popup', () => { popped = true; });
await send("printf '\\033]7770;open;https://example.com/unsigned\\007'");
await page.waitForTimeout(800);
const asked = await page.evaluate(() => document.querySelector('#sheet .link-ask')?.textContent ?? '');
check('unsigned link asks first', !popped && asked.includes('example.com/unsigned'));
await page.click('#sheet-backdrop').catch(() => {});
await page.waitForTimeout(400);

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
await send('stty size');
await page.waitForTimeout(500);
const txt = await screenText();
const m = txt.match(/(\d+) (\d+)\s*\S*\$?\s*$/m) ?? txt.match(/\b(\d{2}) (\d{2,3})\b(?![\s\S]*\b\d{2} \d{2,3}\b)/);
check(`resize reaches the PTY (stty: ${m?.[0]?.trim()}, width ${Math.round(cols)}px)`, !!m && +m[2] > 60);

// 8. reload → session restored with its output
await page.reload();
await page.waitForTimeout(1500);
check('session restored after reload', await waitFor(async () => (await screenText()).includes('typed-42')));

// 9. reading history while output keeps deleting/scrolling lines on the screen: every
//    drawn row still shows its own line (no off-by-n rows after false "trims")
await send("clear; for i in $(seq 1 300); do echo L$i; done");
await page.waitForTimeout(1200);
await send("sleep 1; for k in 1 2 3; do printf '\\e[3A\\e[M\\e[3B'; printf '\\e[S'; echo M$k; sleep 0.2; done");
await page.waitForTimeout(300);
await page.evaluate(() => window.__selftest.session().scrollLines(20));
await page.waitForTimeout(2500);
const rowCheck = await page.evaluate(() => {
  const s = window.__selftest.session();
  const b = s.term.buffer.active;
  const lh = s.renderer.lineHeight;
  let bad = 0;
  for (const r of document.querySelectorAll('.session:not([hidden]) .term-row')) {
    const y = Number(/translateY\(([-\d.]+)px\)/.exec(r.style.transform)?.[1] ?? 0);
    if (r.textContent.trim() !== (b.getLine(Math.round(y / lh))?.translateToString(true).trim() ?? '')) bad++;
  }
  return { bad, scrolled: s.renderer.scrollPx > 0 };
});
check(`history rows stay right while lines are deleted (${rowCheck.bad} wrong)`, rowCheck.scrolled && rowCheck.bad === 0);
await page.evaluate(() => window.__selftest.session().scrollToBottom());

// 10. taps on links and file names the way agents print them (the text is put straight into
//     the terminal, as a program would print it — what's tested is the tap, not the shell)
const show = (text) => page.evaluate((t) => {
  const s = window.__selftest.session();
  return new Promise((done) => s.term.write(`\x1b[H\x1b[2J${t}`, () => { s.renderer.schedule(); setTimeout(done, 150); }));
}, text);
const termCols = await page.evaluate(() => window.__selftest.session().term.cols);
// (cut as Claude Code's wrapper cuts a word longer than the line: in equal pieces, an indent each)
const cutRows = (word, indent = '  ') => {
  const w = termCols - indent.length;
  const rows = [];
  for (let i = 0; i < word.length; i += w) rows.push(indent + word.slice(i, i + w));
  return rows;
};
const tapRow = async (piece, frac = 0.5) => page.evaluate(([t, f]) => {
  const row = [...document.querySelectorAll('.session:not([hidden]) .term-row')].find((r) => r.textContent.includes(t));
  if (!row) return null;
  const r = row.getBoundingClientRect();
  const s = window.__selftest.session();
  const i = row.textContent.indexOf(t);
  const x = r.left + (i + t.length * f) * s.renderer.cellWidth;
  const y = r.top + r.height / 2;
  return { url: s.urlAt(x, y), file: s.fileAt(x, y), link: s.linkAt(x, y) };
}, [piece, frac]);
//     (a) a link longer than the screen, broken into rows by the program itself (Claude Code's
//     sign-in link): a tap on any piece opens all of it
const longUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A45831%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=Qx3vKk2dV6&state=AbCdEf0123';
const urlRows = cutRows(longUrl);
await show(['Browser did not open? Use the url below to sign in:', ...urlRows, '  Paste code here if prompted >'].join('\r\n'));
const pieces = urlRows.map((r) => r.trim());
const mid = await tapRow(pieces[Math.floor(pieces.length / 2)]);
const first = await tapRow(pieces[0], 0.9);
const last = await tapRow(pieces[pieces.length - 1], 0.2);
check(`a link broken into rows opens whole (${pieces.length} rows)`, pieces.length > 3 && mid?.url === longUrl && first?.url === longUrl && last?.url === longUrl);
//     (b) a link a program put on its text (OSC 8): the label opens it
await show('see \x1b]8;;https://example.com/docs/page\x1b\\the docs\x1b]8;;\x1b\\ now\r\n');
check('a hyperlink label (OSC 8) opens its link', (await tapRow('the docs'))?.link === 'https://example.com/docs/page');
//     (c) a path broken into rows (an agent's "Wrote … to …"); prose that fills a row isn't joined
const longPath = '/sdcard/Documents/Math16N7_30/Class9_ICT_question_answers_chapter_three_with_solutions_and_notes_bangla_version.md';
const pathRows = cutRows(longPath);
await show(['  Wrote 42 lines to', ...pathRows].join('\r\n'));
check(`a path broken into rows is found whole (${pathRows.length} rows)`, (await tapRow(pathRows[pathRows.length - 1].trim(), 0.3))?.file === longPath);
const prose = 'See https://example.com/a for it ';
const filler = prose + 'x'.repeat(termCols - prose.length);
await show(`${filler}\r\nnext line here\r\n`);
check('a link ending a full row of prose isn\'t joined to the next row', (await tapRow('example.com/a'))?.url === 'https://example.com/a');
//     (d) Claude Code's sign-in page (now on claude.com) asks which account first
await show('\x1b]7770;open;t0k3n;https://claude.com/cai/oauth/authorize?code=true&client_id=x\x07');
const claudeAsked = await waitFor(async () => /Sign in to Claude Code with/.test(await page.textContent('#sheet:not([hidden]) h3').catch(() => '')));
check('Claude sign-in asks which account', claudeAsked && await page.isVisible('#sheet:not([hidden]) .action:has-text("Another email")'));
await page.click('#sheet-backdrop', { position: { x: 10, y: 10 } });
await page.waitForTimeout(400);
//     (e) back with a code on the clipboard while the agent asks for one: offered
await show('  Paste code here if prompted >');
await page.evaluate(() => navigator.clipboard.writeText('AbCdEf0123456789xyzXYZ_-#state987654'));
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
check('a copied sign-in code is offered', await waitFor(async () => /Paste the sign-in code/.test(await page.textContent('#sheet:not([hidden]) h3').catch(() => '')), 3000));
await page.click('#sheet-backdrop', { position: { x: 10, y: 10 } });
await page.waitForTimeout(400);
await page.evaluate(() => window.__selftest.keys('\x0c')); // (the shell draws its prompt again)

// 11. an agent's menu or dialog (its cursor hidden, as Claude Code's /model, /usage) taller than
//     the room above the keyboard: its last lines stay in sight when the keyboard comes up
await page.evaluate(() => { window.__selftest.session().renderer.anchorBottom = true; });
const dialog = ['Select model', ...Array.from({ length: 34 }, (_, i) => `  ${i + 1}. option ${i + 1}`), '  Enter to confirm · Esc to cancel'];
await show(`\x1b[?25l${dialog.join('\r\n')}`);
for (let b = 0; b <= 340; b += 85) {
  await page.evaluate((x) => window.__native.onInsets(0, x, x > 0, false, 0, 0, false), b);
  await page.waitForTimeout(16);
}
await page.evaluate(() => window.__native.onInsets(0, 340, true, true, 0, 0, false));
await page.waitForTimeout(800);
const dialogEnd = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.session:not([hidden]) .term-row')].find((r) => r.textContent.includes('Esc to cancel'));
  const bar = document.querySelector('#extra-keys').getBoundingClientRect();
  return row ? row.getBoundingClientRect().bottom <= bar.top + 1 : false;
});
check('a dialog\'s last line stays above the keyboard', dialogEnd);
await page.evaluate(() => window.__native.onInsets(0, 0, false, true, 0, 0, false));
await page.evaluate(() => { const s = window.__selftest.session(); s.renderer.anchorBottom = false; s.term.write('\x1b[?25h'); });
await page.waitForTimeout(300);

// 12. wide view (the key bar's ↔): twice the columns, slid sideways by a finger; off again
await page.click('.k-wide');
await page.waitForTimeout(1500);
const wideOn = await page.evaluate(() => { const s = window.__selftest.session(); return { cols: s.term.cols, max: s.renderer.maxScrollX(), lit: document.querySelector('.k-wide').classList.contains('on') }; });
await page.evaluate(() => new Promise((done) => {
  const el = document.querySelector('.session:not([hidden]) .term-screen');
  const r = el.getBoundingClientRect();
  const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 9, isPrimary: true, pointerType: 'touch', clientX: x, clientY: r.top + 100, bubbles: true }));
  let i = 0;
  ev('pointerdown', r.right - 40);
  const t = setInterval(() => {
    i++;
    ev('pointermove', r.right - 40 - i * 25);
    if (i === 10) { clearInterval(t); ev('pointerup', r.right - 290); setTimeout(done, 400); }
  }, 16);
}));
const slid = await page.evaluate(() => window.__selftest.session().renderer.scrollX);
// …and a swipe up or down that starts a little slanted (as a thumb does) isn't taken for one
const slanted = await page.evaluate(() => new Promise((done) => {
  const s = window.__selftest.session();
  s.renderer.scrollX = 0;
  const x0 = s.renderer.scrollX;
  const el = document.querySelector('.session:not([hidden]) .term-screen');
  const r = el.getBoundingClientRect();
  const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: 10, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
  let i = 0;
  ev('pointerdown', r.left + 150, r.top + 100);
  const t = setInterval(() => {
    i++;
    ev('pointermove', r.left + 150 + i * 10, r.top + 100 + i * 8 + (i > 1 ? i * 20 : 0));
    if (i === 8) { clearInterval(t); ev('pointerup', r.left + 230, r.top + 324); setTimeout(() => done(s.renderer.scrollX === x0), 300); }
  }, 16);
}));
check('a slanted swipe up or down doesn\'t slide sideways', slanted);
await page.click('.k-wide');
await page.waitForTimeout(1500);
const wideOff = await page.evaluate(() => { const s = window.__selftest.session(); return { cols: s.term.cols, sx: s.renderer.scrollX, lit: document.querySelector('.k-wide').classList.contains('on') }; });
check(`wide view: ${wideOn.cols} columns, slides sideways (${Math.round(slid)}px), back to ${wideOff.cols}`,
  wideOn.lit && wideOn.max > 0 && slid > 100 && !wideOff.lit && wideOff.sx === 0 && wideOff.cols * 1.5 < wideOn.cols);

// 13. Codex (ratatui 0.30): a Bangla table scrolled line by line, drawn the way ratatui draws
//     it — each letter cluster one cell as wide as its code points, only the changed cells
//     written, the rest of a wide cluster left to the terminal to clear — must leave nothing
//     behind (it left a trail of ে ি র ষ while scrolling)
const ratatuiTrail = await page.evaluate((mode) => {
  const s = window.__selftest.session();
  const cols = 44, rows = 8;
  const seg = new Intl.Segmenter('bn', { granularity: 'grapheme' });
  const cpw = (ch) => (/\p{Grapheme_Extend}|\p{Default_Ignorable_Code_Point}/u.test(ch) ? 0 : 1);
  const gw = (g) => [...g].reduce((n, c) => n + cpw(c), 0);
  const lines = [
    'বিষয়        DeepSeek V4.1 Flash',
    'মূল কাজ     দ্রুত ও কম খরচে অনেক অনুরোধ',
    'শক্তি        দ্রুত উত্তর, কম খরচ, ছবি বোঝার সুবিধা',
    'প্রসঙ্গ ধারণক্ষমতা   ১ মিলিয়ন টোকেন',
    'API খরচ     প্রতি ১০ লাখ ইনপুট টোকেন',
    'কখন বেছে নেবেন  অনেক কাজ কম খরচে',
    'সহজ করে: মন্ত্রী স্ত্রী ক্ষমা জ্ঞানভিত্তিক',
    'দীর্ঘ সময়ের জটিল কোডিং ও জ্ঞানভিত্তিক কাজ',
    'বড় কোডবেসে পরিবর্তন, ডিবাগিং, বহু ধাপের কাজ',
    'অপেক্ষাকৃত সস্তা; কম্পিউটার ব্যবহারে জোর',
    'শেষ লাইন: ধন্যবাদ',
  ];
  const blank = () => Array.from({ length: rows * cols }, () => ({ sym: ' ', w: 1 }));
  const frame = (off) => {
    const b = blank();
    for (let y = 0; y < rows; y++) {
      const text = lines[(off + y) % lines.length];
      let x = 0;
      for (const { segment: g } of seg.segment(text)) {
        const w = gw(g);
        if (w === 0) continue;
        if (x + w > cols) break;
        b[y * cols + x] = { sym: g, w };
        for (let k = 1; k < w; k++) b[y * cols + x + k] = { sym: ' ', w: 1 }; // (reset)
        x += w;
      }
    }
    return b;
  };
  const expected = (b) => Array.from({ length: rows }, (_, y) => {
    let t = '';
    for (let x = 0; x < cols;) { const c = b[y * cols + x]; t += c.sym; x += Math.max(1, c.w); }
    return t.trimEnd();
  });
  let out = '';
  let cx = -1, cy = -1;
  const diff = (prev, next) => {
    for (let i = 0; i < next.length; i++) {
      const cur = next[i], old = prev[i];
      if (cur.sym === old.sym && cur.w === old.w) { i += cur.w - 1; continue; }
      const x = i % cols, y = Math.floor(i / cols);
      if (x !== cx || y !== cy) out += `\x1b[${y + 1};${x + 1}H`;
      out += cur.sym;
      cx = x + cur.w; cy = y;
      if (cur.w > 1) i += cur.w - 1;
    }
  };
  return new Promise((done) => {
    s.term.resize(cols, rows);
    // (the program's way of counting, as the shell names it for a program starting)
    s.term.write(`\x1b]7770;widths;t0k3n;${mode}\x07\x1b[?1049h\x1b[H\x1b[2J`, () => {
      let prev = blank();
      let bad = 0;
      let first = '';
      const step = (f) => {
        if (f > 14) {
          s.term.write('\x1b[?1049l\x1b]7770;widths;t0k3n;letters\x07', () => done({ bad, first }));
          return;
        }
        const next = frame(f);
        out = '';
        diff(prev, next);
        prev = next;
        s.term.write(out, () => {
          const want = expected(next);
          const buf = s.term.buffer.active;
          for (let y = 0; y < rows; y++) {
            const got = (buf.getLine(y)?.translateToString(true) ?? '').trimEnd();
            if (got !== want[y]) { bad++; if (!first) first = `frame ${f} row ${y}: got "${got}" want "${want[y]}"`; }
          }
          step(f + 1);
        });
      };
      step(1);
    });
  });
}, process.env.CODEX_MODE ?? 'clusters');
if (ratatuiTrail.bad) console.log('  ', ratatuiTrail.first);
check(`Codex's redraw of a scrolled Bangla table leaves nothing behind (${ratatuiTrail.bad} wrong rows)`, ratatuiTrail.bad === 0);
await page.evaluate(() => window.__selftest.session().fit(true));
await page.waitForTimeout(300);

// 14. the home screen isn't painted under the terminal
check('home screen hidden under the terminal', await page.evaluate(() => getComputedStyle(document.querySelector('#home')).visibility === 'hidden'));

check('no JavaScript errors', pageErrors.length === 0);

await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
