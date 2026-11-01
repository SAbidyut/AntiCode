import { createBridge, type Bridge, type HostState, type SessionKind } from './bridge';
import { TerminalSession } from './term/session';
import { THEMES } from './term/renderer';
import { androidKeySeq, applyMods, domKeySeq, namedKeySeq, type Mods, type NamedKey } from './term/keys';

// ---------------------------------------------------------------- prefs
interface Prefs {
  fontSize: number;
  theme: keyof typeof THEMES;
  bnScale: number;
  remoteUrl: string;
}
const DEFAULT_PREFS: Prefs = {
  fontSize: 14,
  theme: 'night',
  bnScale: 1,
  remoteUrl: 'https://antigravity.google.com',
};
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('prefs') ?? '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
function savePrefs() {
  try {
    localStorage.setItem('prefs', JSON.stringify(prefs));
  } catch { /* storage unavailable */ }
}
const prefs = loadPrefs();

// ---------------------------------------------------------------- helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
const bnDigits = (n: number | string) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[+d]);
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout((t as unknown as { _t: number })._t);
  (t as unknown as { _t: number })._t = window.setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------- state
const sessions = new Map<string, TerminalSession>();
const early = new Map<string, Uint8Array[]>();
let active: TerminalSession | null = null;
let hostState: HostState = { host: 'dev', ubuntu: 'none' };
const latch: Mods = {};
let screen: 'home' | 'term' = 'home';

const bridge: Bridge = createBridge({
  onOutput(id, data) {
    const s = sessions.get(id);
    if (s) s.write(data);
    else {
      // output can arrive before createSession() has returned to us — keep it
      const q = early.get(id) ?? [];
      q.push(data);
      early.set(id, q);
    }
  },
  onExit(id, code) {
    sessions.get(id)?.markExited(code);
    renderTabs();
  },
  onState(state) {
    hostState = state;
    renderHome();
  },
  onImeText(text) {
    if (!active) return;
    active.input(applyMods(text, consumeLatch()));
  },
  onImeKey(keyCode, ctrl, alt, shift) {
    if (!active) return;
    const l = consumeLatch();
    const seq = androidKeySeq(keyCode, { ctrl: ctrl || l.ctrl, alt: alt || l.alt, shift }, active.appCursor);
    if (seq) active.input(seq);
  },
  onBack() {
    if (active?.isReaderOpen) {
      active.toggleReader(false);
      updateReaderBtn();
      return true;
    }
    if (screen === 'term') {
      showHome();
      return true;
    }
    return false;
  },
});

function consumeLatch(): Mods {
  const m = { ...latch };
  if (latch.ctrl || latch.alt) {
    latch.ctrl = latch.alt = false;
    document.querySelectorAll('.key.latch').forEach((k) => k.classList.remove('on'));
  }
  return m;
}

function rendererOpts() {
  return { fontSize: prefs.fontSize, theme: THEMES[prefs.theme], bnScale: prefs.bnScale };
}

// ---------------------------------------------------------------- sessions
function addSession(id: string, kind: SessionKind): TerminalSession {
  const s = new TerminalSession(bridge, id, kind, rendererOpts());
  s.onTitle = renderTabs;
  sessions.set(id, s);
  for (const d of early.get(id) ?? []) s.write(d);
  early.delete(id);
  $('#sessions').append(s.el);
  bindTerminalGestures(s);
  return s;
}

async function newSession(kind: SessionKind) {
  if ((kind === 'ubuntu' || kind === 'agy') && hostState.ubuntu !== 'ready') {
    toast('আগে Ubuntu সেটআপ করুন');
    showHome();
    return;
  }
  showTerm();
  const box = $('#sessions').getBoundingClientRect();
  const probe = new TerminalSession(bridge, '_probe', kind, rendererOpts());
  const { cols, rows } = probe.renderer.fit(box.width, box.height);
  probe.dispose();
  const id = await bridge.createSession(kind, cols, rows);
  if (!id) {
    toast('সেশন শুরু করা যায়নি');
    if (!sessions.size) showHome();
    return;
  }
  const s = addSession(id, kind);
  activate(s);
}

function activate(s: TerminalSession | null) {
  for (const x of sessions.values()) {
    x.el.hidden = x !== s;
    x.setFocused(false);
  }
  active = s;
  if (s) {
    showTerm();
    requestAnimationFrame(() => s.fit());
  }
  renderTabs();
  updateReaderBtn();
}

function closeSession(s: TerminalSession) {
  if (s.alive && !confirm(`"${s.title}" সেশন বন্ধ করবেন? এর ভিতরে চলা প্রোগ্রাম বন্ধ হয়ে যাবে।`)) return;
  bridge.close(s.id);
  sessions.delete(s.id);
  s.dispose();
  const next = [...sessions.values()].pop() ?? null;
  activate(next);
  if (!next) showHome();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.replaceChildren(
    ...[...sessions.values()].map((s) => {
      const icon = s.kind === 'agy' ? '✦' : s.kind === 'ubuntu' ? '◉' : '▣';
      const tab = h('div', { class: 'tab' + (s === active ? ' active' : '') + (s.alive ? '' : ' dead') },
        h('span', { class: 'ti' }, icon), h('span', { class: 'tt' }, s.title));
      const x = h('button', { class: 'tx', 'aria-label': 'বন্ধ' }, '×');
      x.onclick = (e) => {
        e.stopPropagation();
        closeSession(s);
      };
      tab.append(x);
      tab.onclick = () => activate(s);
      return tab;
    }),
  );
  renderHomeSessions();
}

// ---------------------------------------------------------------- screens
function showHome() {
  screen = 'home';
  document.body.dataset.screen = 'home';
  bridge.setTerminalKeyboard(false);
  bridge.hideKeyboard();
  renderHome();
}
function showTerm() {
  screen = 'term';
  document.body.dataset.screen = 'term';
  requestAnimationFrame(() => active?.fit());
}

function renderHome() {
  const card = $('#ubuntu-card');
  const st = hostState;
  const body: (Node | string)[] = [];
  if (st.ubuntu === 'ready') {
    const agy = h('button', { class: 'btn primary big' }, '✦ Antigravity চালান');
    agy.onclick = () => newSession('agy');
    const ub = h('button', { class: 'btn' }, '◉ Ubuntu টার্মিনাল');
    ub.onclick = () => newSession('ubuntu');
    body.push(
      h('p', { class: 'muted' }, 'Ubuntu প্রস্তুত। প্রথমবার Antigravity চালালে অটোমেটিক ইনস্টল হবে, তারপর Google অ্যাকাউন্টে লগইন চাইবে।'),
      h('div', { class: 'row' }, agy, ub),
    );
  } else if (st.ubuntu === 'installing') {
    const pct = Math.round((st.progress ?? 0) * 100);
    body.push(
      h('p', {}, st.message ?? 'Ubuntu নামানো হচ্ছে…'),
      h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })),
      h('p', { class: 'muted' }, `${bnDigits(pct)}% — অ্যাপ খোলা রাখুন`),
    );
  } else {
    const btn = h('button', { class: 'btn primary big' }, st.ubuntu === 'error' ? 'আবার চেষ্টা করুন' : 'Ubuntu সেটআপ করুন');
    btn.onclick = () => {
      if (hostState.host === 'dev') {
        toast('ডেভ মোডে Ubuntu লাগে না');
        return;
      }
      bridge.installUbuntu();
    };
    body.push(
      st.ubuntu === 'error' ? h('p', { class: 'err' }, st.message ?? 'সমস্যা হয়েছে') : '',
      h('p', { class: 'muted' }, 'একবারই করতে হবে: ফোনের ভিতরে পুরো Ubuntu 24.04 নামানো হবে (~৩০MB ডাউনলোড, পরে ~৫০০MB জায়গা)। এরপর অ্যাপ খুললেই সরাসরি Ubuntu।'),
      btn,
    );
  }
  card.querySelector('.card-body')!.replaceChildren(...body);
  renderHomeSessions();
}

function renderHomeSessions() {
  const box = $('#home-sessions');
  const list = [...sessions.values()];
  box.hidden = list.length === 0;
  box.querySelector('.list')!.replaceChildren(
    ...list.map((s) => {
      const item = h('button', { class: 'list-item' },
        h('span', { class: 'dot' + (s.alive ? ' on' : '') }), h('span', {}, s.title));
      item.onclick = () => activate(s);
      return item;
    }),
  );
}

// ---------------------------------------------------------------- input
const kbd = $<HTMLTextAreaElement>('#kbd');
let composing = false;

function focusTerminalKeyboard() {
  if (!active) return;
  active.setFocused(true);
  if (bridge.host === 'android') {
    // Leave the compose box, otherwise tapping it again fires no focus event and
    // the keyboard would stay in raw terminal mode.
    (document.activeElement as HTMLElement | null)?.blur?.();
    bridge.setTerminalKeyboard(true);
    bridge.showKeyboard();
  } else {
    kbd.focus({ preventScroll: true });
  }
}

kbd.addEventListener('keydown', (e) => {
  if (!active || composing || e.isComposing) return;
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') return; // let paste through
  const seq = domKeySeq(e, active.appCursor, latch);
  if (seq !== null) {
    e.preventDefault();
    consumeLatch();
    active.input(seq);
  }
});
kbd.addEventListener('compositionstart', () => (composing = true));
kbd.addEventListener('compositionend', (e) => {
  composing = false;
  if (active && e.data) active.input(applyMods(e.data, consumeLatch()));
  kbd.value = '';
});
kbd.addEventListener('input', (e) => {
  const ie = e as InputEvent;
  if (!active || composing || ie.isComposing) return;
  if (ie.inputType === 'insertLineBreak') active.input('\r');
  else if (ie.inputType === 'deleteContentBackward') active.input('\x7f');
  else if (ie.data) active.input(applyMods(ie.data, consumeLatch()));
  kbd.value = '';
});
kbd.addEventListener('paste', (e) => {
  e.preventDefault();
  const t = e.clipboardData?.getData('text') ?? '';
  if (t && active) active.paste(t);
});
kbd.addEventListener('blur', () => active?.setFocused(false));

function bindTerminalGestures(s: TerminalSession) {
  const el = s.renderer.el;
  let startX = 0, startY = 0, lastY = 0, acc = 0, moved = false, t0 = 0;
  let longTimer = 0;
  let pinch0 = 0, font0 = prefs.fontSize;
  const touches = new Map<number, { x: number; y: number }>();

  el.addEventListener('pointerdown', (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      font0 = prefs.fontSize;
      clearTimeout(longTimer);
      return;
    }
    startX = e.clientX;
    startY = lastY = e.clientY;
    acc = 0;
    moved = false;
    t0 = Date.now();
    clearTimeout(longTimer);
    longTimer = window.setTimeout(() => {
      if (!moved) {
        s.toggleReader(true);
        updateReaderBtn();
        toast('পাঠ মোড: এখানে লেখা সিলেক্ট করে কপি করা যায়');
      }
    }, 650);
  });
  el.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinch0) {
      const [a, b] = [...touches.values()];
      const size = Math.round(Math.max(9, Math.min(28, font0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch0))));
      if (size !== prefs.fontSize) setFontSize(size, false);
      moved = true;
      return;
    }
    if (Math.abs(e.clientY - startY) > 8 || Math.abs(e.clientX - startX) > 8) {
      moved = true;
      clearTimeout(longTimer);
    }
    if (!moved) return;
    acc += e.clientY - lastY;
    lastY = e.clientY;
    const lh = s.renderer.lineHeight;
    const lines = Math.trunc(acc / lh);
    if (lines) {
      acc -= lines * lh;
      s.scrollLines(lines, e.clientX, e.clientY);
    }
  });
  const end = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    clearTimeout(longTimer);
    if (pinch0 && touches.size < 2) {
      if (touches.size === 0) {
        pinch0 = 0;
        setFontSize(prefs.fontSize, true);
      }
      return;
    }
    if (e.type === 'pointerup' && !moved && Date.now() - t0 < 600) {
      const url = s.urlAt(e.clientX, e.clientY);
      if (url) {
        bridge.openUrl(url);
        return;
      }
      s.click(e.clientX, e.clientY);
      focusTerminalKeyboard();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    s.scrollLines(Math.round(-e.deltaY / s.renderer.lineHeight) || (e.deltaY < 0 ? 1 : -1), e.clientX, e.clientY);
  }, { passive: false });
}

function setFontSize(size: number, persist: boolean) {
  prefs.fontSize = size;
  for (const s of sessions.values()) s.renderer.setOptions({ fontSize: size });
  active?.fit();
  if (persist) {
    savePrefs();
    toast(`ফন্ট সাইজ ${bnDigits(size)}`);
  }
}

// ---------------------------------------------------------------- key bar
const KEYS: { label: string; key?: NamedKey; text?: string; latch?: 'ctrl' | 'alt'; act?: string }[] = [
  { label: 'Esc', key: 'Escape' },
  { label: 'Tab', key: 'Tab' },
  { label: 'Ctrl', latch: 'ctrl' },
  { label: 'Alt', latch: 'alt' },
  { label: '↑', key: 'ArrowUp' },
  { label: '↓', key: 'ArrowDown' },
  { label: '←', key: 'ArrowLeft' },
  { label: '→', key: 'ArrowRight' },
  { label: '^C', text: '\x03' },
  { label: '/', text: '/' },
  { label: '⏎', key: 'Enter' },
  { label: '-', text: '-' },
  { label: '|', text: '|' },
  { label: '~', text: '~' },
  { label: 'Home', key: 'Home' },
  { label: 'End', key: 'End' },
  { label: 'PgUp', key: 'PageUp' },
  { label: 'PgDn', key: 'PageDown' },
  { label: 'পেস্ট', act: 'paste' },
];

function buildKeyBar() {
  const bar = $('#keybar');
  for (const k of KEYS) {
    const b = h('button', { class: 'key' + (k.latch ? ' latch' : '') }, k.label);
    let repeat = 0;
    const fire = async () => {
      if (!active) return;
      if (k.latch) {
        latch[k.latch] = !latch[k.latch];
        b.classList.toggle('on', !!latch[k.latch]);
        return;
      }
      if (k.act === 'paste') {
        const t = await bridge.readClipboard();
        if (t) active.paste(t);
        return;
      }
      const m = consumeLatch();
      active.input(k.key ? namedKeySeq(k.key, m, active.appCursor) : applyMods(k.text!, m));
    };
    // pointerdown + preventDefault keeps the soft keyboard open
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      navigator.vibrate?.(8);
      fire();
      if (k.key?.startsWith('Arrow') || k.key === 'Backspace') {
        repeat = window.setTimeout(function loop() {
          fire();
          repeat = window.setTimeout(loop, 60);
        }, 400);
      }
    });
    const stop = () => clearTimeout(repeat);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
    bar.append(b);
  }
}

// ---------------------------------------------------------------- compose box
function bindCompose() {
  const ta = $<HTMLTextAreaElement>('#compose');
  const send = $('#send');
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  };
  ta.addEventListener('input', grow);
  const normalKeyboard = () => {
    bridge.setTerminalKeyboard(false);
    active?.setFocused(false);
  };
  ta.addEventListener('focus', normalKeyboard);
  ta.addEventListener('pointerdown', normalKeyboard);
  const doSend = () => {
    if (!active) return;
    const text = ta.value;
    if (!text) {
      active.input('\r');
      return;
    }
    active.sendLine(text);
    ta.value = '';
    grow();
  };
  send.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // keep focus (and the keyboard) in the textarea
    doSend();
  });
  ta.addEventListener('keydown', (e) => {
    // Enter sends on hardware keyboards; Shift+Enter = new line
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && bridge.host === 'dev') {
      e.preventDefault();
      doSend();
    }
  });
  $('#kbd-btn').onclick = () => focusTerminalKeyboard();
}

// ---------------------------------------------------------------- top bar & menus
function updateReaderBtn() {
  $('#reader-btn').classList.toggle('on', !!active?.isReaderOpen);
}

function bindTopBar() {
  $('#home-btn').onclick = () => showHome();
  $('#reader-btn').onclick = () => {
    if (!active) return;
    active.toggleReader();
    updateReaderBtn();
  };
  const plus = $('#plus-btn');
  const menu = $('#new-menu');
  plus.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  };
  menu.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => {
    b.onclick = () => {
      menu.hidden = true;
      newSession(b.dataset.kind as SessionKind);
    };
  });
  const more = $('#more-menu');
  $('#more-btn').onclick = (e) => {
    e.stopPropagation();
    more.hidden = !more.hidden;
  };
  more.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
    b.onclick = async () => {
      more.hidden = true;
      if (!active) return;
      switch (b.dataset.act) {
        case 'copy': bridge.copyText(active.allText()); toast('সব লেখা কপি হয়েছে'); break;
        case 'paste': { const t = await bridge.readClipboard(); if (t) active.paste(t); break; }
        case 'bigger': setFontSize(Math.min(28, prefs.fontSize + 1), true); break;
        case 'smaller': setFontSize(Math.max(9, prefs.fontSize - 1), true); break;
        case 'bottom': active.scrollToBottom(); break;
        case 'clear': active.term.clear(); break;
      }
    };
  });
  document.addEventListener('click', () => {
    menu.hidden = true;
    more.hidden = true;
  });
}

function bindHome() {
  $('#remote-btn').onclick = () => bridge.openRemote(prefs.remoteUrl);
  const url = $<HTMLInputElement>('#remote-url');
  url.value = prefs.remoteUrl;
  url.onchange = () => {
    prefs.remoteUrl = url.value.trim() || DEFAULT_PREFS.remoteUrl;
    savePrefs();
  };
  $('#copy-remote-cmd').onclick = () => {
    bridge.copyText('agy --remote-control');
    toast('কমান্ড কপি হয়েছে');
  };
  const theme = $<HTMLSelectElement>('#theme');
  theme.value = prefs.theme;
  theme.onchange = () => {
    prefs.theme = theme.value as Prefs['theme'];
    savePrefs();
    applyTheme();
  };
  const fs = $<HTMLInputElement>('#font-size');
  fs.value = String(prefs.fontSize);
  fs.oninput = () => setFontSize(+fs.value, false);
  fs.onchange = () => setFontSize(+fs.value, true);
  const bn = $<HTMLInputElement>('#bn-scale');
  bn.value = String(prefs.bnScale);
  bn.oninput = () => {
    prefs.bnScale = +bn.value;
    for (const s of sessions.values()) s.renderer.setOptions({ bnScale: prefs.bnScale });
    renderSample();
  };
  bn.onchange = () => savePrefs();
}

function applyTheme() {
  document.body.dataset.theme = prefs.theme;
  for (const s of sessions.values()) s.renderer.setOptions({ theme: THEMES[prefs.theme] });
  renderSample();
}

/** Small preview on the home screen so the user can judge the Bangla rendering. */
let sample: TerminalSession | null = null;
function renderSample() {
  const host = $('#sample');
  if (!sample) {
    sample = new TerminalSession({ write() {}, resize() {} } as unknown as Bridge, '_sample', 'ubuntu', rendererOpts());
    sample.term.resize(34, 4);
    host.append(sample.renderer.el);
    sample.term.write(
      '\x1b[32m❯\x1b[0m agy "বাংলায় ক্ষমা চাই"\r\n' +
      '\x1b[36m✦\x1b[0m ঠিক আছে! স্ত্রী, কৃষ্ণ, জ্ঞান\r\n' +
      '\x1b[33m│\x1b[0m Hello world │ সন্ত্রাস │\r\n' +
      '\x1b[2m১২৩ — বাংলা + English\x1b[0m',
    );
  } else {
    sample.renderer.setOptions(rendererOpts());
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  buildKeyBar();
  bindCompose();
  bindTopBar();
  bindHome();
  document.body.dataset.theme = prefs.theme;
  document.body.dataset.host = bridge.host;
  showHome();

  // Measure the cell size only after the fonts are really there.
  try {
    await Promise.all([
      document.fonts.load(`${prefs.fontSize}px "JetBrains Mono"`),
      document.fonts.load(`bold ${prefs.fontSize}px "JetBrains Mono"`),
      document.fonts.load(`${prefs.fontSize}px Kalpurush`, 'বাংলা'),
    ]);
  } catch { /* fall back to whatever is available */ }
  renderSample();

  try {
    hostState = await bridge.getState();
  } catch {
    hostState = { host: bridge.host, ubuntu: 'error', message: 'হোস্টের সাথে সংযোগ হয়নি' };
  }
  renderHome();

  // Re-attach to sessions that kept running while the UI was gone.
  try {
    const list = await bridge.listSessions();
    for (const info of list) {
      const s = addSession(info.id, info.kind);
      s.title = info.title || s.title;
      if (!info.alive) s.alive = false;
      bridge.attach(info.id);
    }
    if (list.length) activate([...sessions.values()].pop()!);
  } catch { /* nothing to restore */ }

  new ResizeObserver(() => active?.fit()).observe($('#sessions'));
  window.addEventListener('resize', () => active?.fit());
}

boot();
