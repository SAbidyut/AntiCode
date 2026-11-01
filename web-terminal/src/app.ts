import './polyfills';
import { createBridge, type Bridge, type HostState, type SessionKind } from './bridge';
import { TerminalSession } from './term/session';
import { THEMES } from './term/renderer';
import { androidKeySeq, applyMods, domKeySeq, namedKeySeq, type Mods, type NamedKey } from './term/keys';
import { hydrateIcons, icon } from './icons';

// ================================================================ prefs
type ThemeName = 'midnight' | 'dracula' | 'solarized' | 'paper';
type CursorStyle = 'block' | 'bar' | 'underline';
interface Prefs {
  fontSize: number;
  theme: ThemeName;
  bnScale: number;
  remoteUrl: string;
  /** Claude Code's remote dashboard (Remote Control sessions). */
  claudeUrl: string;
  cursor: CursorStyle;
  /** Keyboard compatibility mode (keyboards that misbehave with raw keys). */
  kbCompat: boolean;
  /** Fade-in output, gliding cursor, sliding scroll. */
  animations: boolean;
}
const DEFAULT_PREFS: Prefs = {
  fontSize: 14,
  theme: 'midnight',
  bnScale: 1,
  remoteUrl: 'https://antigravity.google.com',
  claudeUrl: 'https://claude.ai/code',
  cursor: 'block',
  kbCompat: false,
  animations: true,
};
const THEME_LABELS: Record<ThemeName, string> = {
  midnight: 'Midnight',
  dracula: 'Dracula',
  solarized: 'Solarized',
  paper: 'Paper',
};
function loadPrefs(): Prefs {
  let p: Prefs;
  try {
    p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('prefs') ?? '{}') };
  } catch {
    p = { ...DEFAULT_PREFS };
  }
  const legacy: Record<string, ThemeName> = { night: 'midnight', light: 'paper' };
  p.theme = legacy[p.theme] ?? p.theme;
  if (!(p.theme in THEMES)) p.theme = 'midnight';
  return p;
}
function savePrefs() {
  try {
    localStorage.setItem('prefs', JSON.stringify(prefs));
  } catch { /* storage unavailable */ }
}
const prefs = loadPrefs();

// ================================================================ helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
}
function svg(name: string, cls = ''): Node {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstChild!;
}
const haptic = () => navigator.vibrate?.(6);

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2400);
}

// JavaScript errors are collected so the user can send them with the debug log.
const jsErrors: string[] = [];
function reportError(msg: string) {
  jsErrors.push(`${new Date().toISOString()} ${msg}`);
  if (jsErrors.length > 20) jsErrors.shift();
  toast('Something went wrong — use ⋮ → Copy debug log and send it');
}
window.addEventListener('error', (e) => reportError(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) => reportError(`unhandled rejection: ${String(e.reason)}`));

// ================================================================ state
const sessions = new Map<string, TerminalSession>();
let notifyWhenDone = true;
let pendingOpen = '';
const early = new Map<string, Uint8Array[]>();
let active: TerminalSession | null = null;
let hostState: HostState = { host: 'dev', ubuntu: 'none' };
const latch: Mods = {};
let screen: 'home' | 'term' = 'home';
let keyboardShown = false;
let fitTimer = 0;
let navBottom = 0;

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
  onInsets(top, bottom, keyboard, settled) {
    // The page draws edge-to-edge; padding follows the bars and the keyboard frame by frame,
    // and the bottom-anchored terminal glides with it. Resize the terminal once it settles.
    const root = document.documentElement.style;
    root.setProperty('--safe-top', `${top}px`);
    root.setProperty('--safe-bottom', `${bottom}px`);
    // The keyboard's height doesn't resize the terminal (see TerminalSession.fit).
    if (!keyboard) navBottom = bottom;
    TerminalSession.keyboardInset = keyboard ? Math.max(0, bottom - navBottom) : 0;
    if (active) active.renderer.insetsMoving = !settled;
    active?.renderer.schedule();
    if (settled) {
      keyboardShown = keyboard;
      clearTimeout(fitTimer);
      active?.fit();
    }
  },
  onKeyboardReleased() {
    keyboardShown = false;
    active?.setFocused(false);
  },
  onOpenSession(id) {
    const s = sessions.get(id);
    if (s) activate(s);
    else pendingOpen = id; // the UI is still starting: open it once sessions are restored
  },
  onBack() {
    if (sheetOpen()) {
      closeSheet();
      return true;
    }
    if (active?.isReaderOpen) {
      active.toggleReader(false);
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
  return { fontSize: prefs.fontSize, theme: THEMES[prefs.theme], bnScale: prefs.bnScale, animate: prefs.animations };
}

// ================================================================ sessions
const KIND_ICON: Record<SessionKind, string> = { agy: 'sparkle', claude: 'claude', ubuntu: 'terminal', android: 'android' };

/** The remote dashboard that belongs to a session: claude.ai/code for Claude Code, else Antigravity's. */
function openDashboard(which: 'agy' | 'claude') {
  if (which === 'claude') bridge.openRemote(prefs.claudeUrl, 'Claude Code');
  else bridge.openRemote(prefs.remoteUrl, 'Antigravity');
}

function addSession(id: string, kind: SessionKind): TerminalSession {
  const s = new TerminalSession(bridge, id, kind, rendererOpts());
  s.renderer.el.dataset.cursor = prefs.cursor;
  s.onTitle = renderTabs;
  s.onMeta = renderTabs;
  sessions.set(id, s);
  for (const d of early.get(id) ?? []) s.write(d);
  early.delete(id);
  $('#sessions').append(s.el);
  bindTerminalGestures(s);
  return s;
}

async function newSession(kind: SessionKind) {
  if (kind !== 'android' && hostState.ubuntu !== 'ready') {
    toast('Install Ubuntu first');
    showHome();
    return;
  }
  showTerm();
  const box = $('#sessions').getBoundingClientRect();
  const probe = new TerminalSession(bridge, '_probe', kind, rendererOpts());
  const { cols, rows } = probe.renderer.fit(box.width, box.height + TerminalSession.keyboardInset);
  probe.dispose();
  console.info(`newSession ${kind}: area ${Math.round(box.width)}x${Math.round(box.height)}px (+${TerminalSession.keyboardInset}px keyboard) → ${cols}x${rows}`);
  const id = await bridge.createSession(kind, cols, rows);
  if (!id) {
    toast('Could not start the session');
    if (!sessions.size) showHome();
    return;
  }
  const s = addSession(id, kind);
  s.notePtySize(cols, rows);
  activate(s);
}

function activate(s: TerminalSession | null) {
  for (const x of sessions.values()) {
    x.el.hidden = x !== s;
    x.setFocused(false);
  }
  active = s;
  bridge.setActiveSession(s?.id ?? '');
  if (s) {
    showTerm();
    s.fit(); // layout is already known; don't wait for a frame (rAF is paused when the screen is off)
    requestAnimationFrame(() => s.fit());
  }
  renderTabs();
}

function closeSession(s: TerminalSession) {
  bridge.close(s.id);
  sessions.delete(s.id);
  s.dispose();
  // closing a background tab keeps the current one
  const next = active && active !== s && sessions.has(active.id) ? active : [...sessions.values()].pop() ?? null;
  activate(next);
  if (!next) showHome();
}

function confirmClose(s: TerminalSession) {
  if (!s.alive) {
    closeSession(s);
    return;
  }
  openSheet(
    `Close “${s.title}”?`,
    h('p', { class: 'note' }, 'Anything running in this session will be stopped.'),
    h('div', { class: 'action-list' },
      action('power', 'Close session', '', () => closeSession(s), true),
      action('x', 'Cancel', '', () => {}),
    ),
  );
}

function renderTabs() {
  const tabs = $('#tabs');
  for (const s of sessions.values()) bridge.setSessionLabel(s.id, s.customName || s.about || s.kindLabel);
  tabs.replaceChildren(
    ...[...sessions.values()].map((s) => {
      const tab = h('div', { class: 'tab' + (s === active ? ' active' : '') + (s.alive ? '' : ' dead') },
        svg(KIND_ICON[s.kind] ?? 'terminal'), h('span', { class: 'tt' }, s.label));
      const x = h('button', { class: 'tx', 'aria-label': 'Close' }, svg('x'));
      x.onclick = (e) => {
        e.stopPropagation();
        confirmClose(s);
      };
      tab.append(x);
      tab.onclick = () => {
        haptic();
        activate(s);
      };
      onLongPress(tab, () => openRenameSheet(s));
      return tab;
    }),
  );
  tabs.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  renderHomeSessions();
}

// ================================================================ screens
function showHome() {
  screen = 'home';
  bridge.setActiveSession(''); // looking at no session: all of them may notify
  document.body.dataset.screen = 'home';
  bridge.hideKeyboard();
  keyboardShown = false;
  renderHome();
}
function showTerm() {
  screen = 'term';
  if (active) bridge.setActiveSession(active.id);
  document.body.dataset.screen = 'term';
  requestAnimationFrame(() => active?.fit());
}

function renderHome() {
  const hero = $('#hero');
  const st = hostState;
  const pill = (cls: string, text: string) => h('span', { class: `status-pill ${cls}` }, h('span', { class: 'dot' }), text);
  const btn = (cls: string, ic: string, label: string, onClick: () => void) => {
    const b = h('button', { class: `btn ${cls}` }, svg(ic), h('span', {}, label));
    b.onclick = () => {
      haptic();
      onClick();
    };
    return b;
  };
  let body: Kid[];
  if (st.ubuntu === 'ready') {
    body = [
      pill('ok', 'Ubuntu 24.04 · ready'),
      h('h2', {}, 'Pick your agent'),
      h('p', {}, 'Each one runs in a real Ubuntu terminal. The first launch installs it and asks you to sign in.'),
      h('div', { class: 'agents' },
        agentTile('agy', 'sparkle', 'Antigravity', 'Google'),
        agentTile('claude', 'claude', 'Claude Code', 'Anthropic'),
      ),
      h('div', { class: 'actions' },
        btn('btn-secondary', 'terminal', 'Ubuntu shell', () => newSession('ubuntu')),
      ),
    ];
  } else if (st.ubuntu === 'installing') {
    const pct = Math.round((st.progress ?? 0) * 100);
    body = [
      pill('busy', 'Installing Ubuntu'),
      h('h2', {}, 'Setting things up'),
      h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'progress-row' }, h('span', {}, st.message ?? 'Downloading…'), h('span', {}, `${pct}%`)),
      h('p', { style: 'margin-top:12px' }, 'Keep the app open — this only happens once.'),
    ];
  } else {
    const failed = st.ubuntu === 'error';
    body = [
      failed ? pill('err', 'Setup failed') : pill('', 'Not installed yet'),
      h('h2', {}, failed ? 'Let’s try that again' : 'Welcome!'),
      failed && st.message ? h('p', { class: 'err' }, st.message) : null,
      h('p', {}, 'First, download a full Ubuntu 24.04 into the app (about 30 MB; ~500 MB once installed). After that, the terminal opens straight into Ubuntu.'),
      h('div', { class: 'actions' },
        btn('btn-primary', 'down', failed ? 'Try again' : 'Install Ubuntu', () => {
          if (hostState.host === 'dev') toast('Not needed in the browser preview');
          else bridge.installUbuntu();
        }),
      ),
    ];
  }
  hero.replaceChildren(...(body.filter(Boolean) as Node[]));
  renderStorage();
  renderHomeSessions();
}

function agentTile(kind: SessionKind, ic: string, name: string, maker: string) {
  const b = h('button', { class: `agent-tile agent-${kind}` },
    h('span', { class: 'agent-icon' }, svg(ic)),
    h('span', { class: 'agent-name' }, name),
    h('span', { class: 'agent-sub' }, maker),
    h('span', { class: 'agent-go' }, 'Launch', svg('chevron')));
  b.onclick = () => {
    haptic();
    newSession(kind);
  };
  return b;
}

function renderStorage() {
  const status = $('#storage-status');
  const button = $('#storage-btn');
  $('#storage-card').hidden = false;
  if (hostState.host === 'dev') {
    status.textContent = 'Available in the Android app.';
    button.hidden = true;
  } else if (hostState.storage) {
    // Nothing left to do here once access is granted.
    $('#storage-card').hidden = true;
    return;
  } else {
    status.textContent = 'Not allowed yet.';
    button.hidden = false;
  }
}

function renderHomeSessions() {
  const box = $('#home-sessions');
  const list = [...sessions.values()];
  box.hidden = list.length === 0;
  box.querySelector('.list')!.replaceChildren(
    ...list.map((s) => {
      const status = s.alive ? 'Running' : 'Finished';
      const item = h('button', { class: 'list-item' },
        h('span', { class: `li-icon kind-${s.kind}` }, svg(KIND_ICON[s.kind] ?? 'terminal')),
        h('span', { class: 'li-main' },
          h('div', { class: 'li-title' }, s.customName || s.kindLabel),
          h('div', { class: 'li-sub' },
            h('span', { class: 'li-dot' + (s.alive ? ' on' : '') }),
            h('span', { class: 'li-sub-text' }, s.about ? `${s.about} · ${status}` : status))),
        svg('chevron', 'chev'));
      item.onclick = () => activate(s);
      onLongPress(item, () => openRenameSheet(s));
      return item;
    }),
  );
}

/** Long-press (contextmenu on touch) without the browser's own menu. */
function onLongPress(el: HTMLElement, run: () => void) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    haptic();
    run();
  });
}

function openRenameSheet(s: TerminalSession) {
  const input = h('input', { class: 'text-input', type: 'text', maxlength: '60', placeholder: s.about || s.kindLabel, spellcheck: 'false' }) as HTMLInputElement;
  input.value = s.customName;
  const save = () => {
    s.rename(input.value);
    closeSheet();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  const saveBtn = h('button', { class: 'btn btn-primary' }, 'Save');
  saveBtn.onclick = save;
  openSheet('Name this session',
    h('p', { class: 'note' }, 'Shown in the tabs and on the home screen.'),
    input,
    h('div', { class: 'sheet-actions' }, saveBtn));
  setTimeout(() => input.focus(), 250);
}

// ================================================================ keyboard input
const kbd = $<HTMLTextAreaElement>('#kbd');
let composing = false;

function focusTerminalKeyboard() {
  if (!active) return;
  active.setFocused(true);
  keyboardShown = true;
  if (bridge.host === 'android') {
    // Leave any text field (settings): the native key view takes over the keyboard.
    (document.activeElement as HTMLElement | null)?.blur?.();
    bridge.setTerminalKeyboard(true);
    bridge.showKeyboard();
  } else {
    kbd.focus({ preventScroll: true });
  }
}
function hideKeyboard() {
  keyboardShown = false;
  active?.setFocused(false);
  (document.activeElement as HTMLElement | null)?.blur?.();
  bridge.hideKeyboard();
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

// ================================================================ touch: tap, scroll (with inertia), pinch, long-press
function bindTerminalGestures(s: TerminalSession) {
  const el = s.renderer.el;
  let startX = 0, startY = 0, lastY = 0, lastT = 0, acc = 0, moved = false, t0 = 0, vel = 0;
  let longTimer = 0, inertia = 0;
  let pinch0 = 0, font0 = prefs.fontSize, pinchSize = prefs.fontSize;
  const touches = new Map<number, { x: number; y: number }>();

  const stopInertia = () => {
    cancelAnimationFrame(inertia);
    inertia = 0;
  };
  /** Scroll by pixels. Scrollback moves pixel-smooth; full-screen apps get wheel steps. */
  const scrollBy = (px: number, x: number, y: number): boolean => {
    if (s.term.buffer.active.type !== 'alternate') return s.renderer.scrollByPixels(px);
    acc += px;
    const lh = s.renderer.lineHeight;
    const lines = Math.trunc(acc / lh);
    if (lines) {
      acc -= lines * lh;
      s.scrollLines(lines, x, y);
    }
    return true;
  };
  const startInertia = (v: number, x: number, y: number) => {
    if (s.term.buffer.active.type === 'alternate') return;
    let prev = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - prev);
      prev = now;
      const moving = scrollBy(v * dt, x, y);
      v *= Math.pow(0.95, dt / 16);
      inertia = moving && Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    inertia = requestAnimationFrame(step);
  };

  el.addEventListener('pointerdown', (e) => {
    stopInertia();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      font0 = pinchSize = prefs.fontSize;
      clearTimeout(longTimer);
      return;
    }
    startX = e.clientX;
    startY = lastY = e.clientY;
    lastT = performance.now();
    acc = 0;
    vel = 0;
    moved = false;
    t0 = Date.now();
    clearTimeout(longTimer);
    longTimer = window.setTimeout(() => {
      if (!moved) {
        haptic();
        s.toggleReader(true);
        toast('Reader view — select text to copy. Back to return.');
      }
    }, 650);
  });
  el.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinch0) {
      // Pinch: only scale the picture now (smooth); resize the terminal once at the end.
      const [a, b] = [...touches.values()];
      pinchSize = Math.round(Math.max(9, Math.min(28, font0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch0))));
      s.renderer.previewZoom(pinchSize / font0);
      moved = true;
      return;
    }
    if (Math.abs(e.clientY - startY) > 8 || Math.abs(e.clientX - startX) > 8) {
      moved = true;
      clearTimeout(longTimer);
    }
    if (!moved) return;
    const now = performance.now();
    const dy = e.clientY - lastY;
    const dt = Math.max(1, now - lastT);
    vel = 0.7 * (dy / dt) + 0.3 * vel;
    lastY = e.clientY;
    lastT = now;
    scrollBy(dy, e.clientX, e.clientY);
  });
  const end = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    clearTimeout(longTimer);
    if (pinch0) {
      if (touches.size === 0) {
        pinch0 = 0;
        s.renderer.previewZoom(null);
        if (pinchSize !== prefs.fontSize) setFontSize(pinchSize, true);
      }
      return;
    }
    if (e.type !== 'pointerup') return;
    if (moved) {
      if (performance.now() - lastT < 80 && Math.abs(vel) > 0.2) startInertia(vel, e.clientX, e.clientY);
      return;
    }
    if (Date.now() - t0 < 600) {
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
    scrollBy(-e.deltaY, e.clientX, e.clientY);
  }, { passive: false });
}

/** Resize after the layout has settled (keyboard animations fire many resizes). */
function fitSoon() {
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => active?.fit(), 110);
}

function setFontSize(size: number, persist: boolean) {
  prefs.fontSize = size;
  for (const s of sessions.values()) s.renderer.setOptions({ fontSize: size });
  active?.fit();
  if (persist) {
    savePrefs();
    toast(`Text size ${size}`);
  }
}

// ================================================================ extra keys
interface KeyDef {
  label?: string;
  icon?: string;
  key?: NamedKey;
  text?: string;
  latch?: 'ctrl' | 'alt';
  act?: 'keyboard';
  small?: boolean;
  repeat?: boolean;
}
// One row of the keys a phone keyboard lacks (everything else is on the keyboard).
const KEYS: KeyDef[] = [
  { label: 'Esc', key: 'Escape' },
  { label: 'Tab', key: 'Tab' },
  { label: 'Ctrl', latch: 'ctrl' },
  { label: '^C', text: '\x03' },
  { label: '←', key: 'ArrowLeft', repeat: true },
  { label: '↑', key: 'ArrowUp', repeat: true },
  { label: '↓', key: 'ArrowDown', repeat: true },
  { label: '→', key: 'ArrowRight', repeat: true },
  { icon: 'keyboard', act: 'keyboard' },
];

function buildKeyBar() {
  const bar = $('#extra-keys');
  {
    for (const k of KEYS) {
      const b = h('button', { class: 'key' + (k.latch ? ' latch' : '') + (k.small ? ' small' : '') });
      if (k.icon) b.append(svg(k.icon));
      else b.textContent = k.label!;
      if (k.act === 'keyboard') b.setAttribute('aria-label', 'Keyboard');
      let repeat = 0;
      const fire = () => {
        if (k.act === 'keyboard') {
          if (keyboardShown) hideKeyboard();
          else focusTerminalKeyboard();
          return;
        }
        if (!active) return;
        if (k.latch) {
          latch[k.latch] = !latch[k.latch];
          b.classList.toggle('on', !!latch[k.latch]);
          return;
        }
        const m = consumeLatch();
        active.input(k.key ? namedKeySeq(k.key, m, active.appCursor) : applyMods(k.text!, m));
      };
      // pointerdown + preventDefault keeps the soft keyboard open
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        haptic();
        b.classList.add('pressed');
        fire();
        if (k.repeat) {
          repeat = window.setTimeout(function loop() {
            fire();
            repeat = window.setTimeout(loop, 55);
          }, 380);
        }
      });
      const stop = () => {
        clearTimeout(repeat);
        b.classList.remove('pressed');
      };
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('pointercancel', stop);
      bar.append(b);
    }
  }
}

// ================================================================ bottom sheet
function sheetOpen() {
  return !$('#sheet').hidden;
}
let sheetHideTimer = 0;
function openSheet(title: string, ...content: Kid[]) {
  const sheet = $('#sheet');
  // an action that opens another sheet (⋮ → Settings) must not be hidden by the
  // previous sheet's closing animation
  clearTimeout(sheetHideTimer);
  sheet.classList.remove('closing');
  sheet.querySelector('.sheet-body')!.replaceChildren(...([title ? h('h3', {}, title) : null, ...content].filter(Boolean) as Node[]));
  $('#sheet-backdrop').hidden = false;
  sheet.hidden = false;
  sheet.scrollTop = 0;
}
function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  sheet.classList.add('closing');
  $('#sheet-backdrop').hidden = true;
  clearTimeout(sheetHideTimer);
  sheetHideTimer = window.setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove('closing');
  }, 190);
}
function action(ic: string, title: string, sub: string, run: () => void, danger = false) {
  const b = h('button', { class: 'action' + (danger ? ' danger' : '') },
    h('span', { class: 'a-icon' }, svg(ic)),
    h('span', { class: 'a-main' }, title, sub ? h('span', { class: 'a-sub' }, sub) : null));
  b.onclick = () => {
    haptic();
    closeSheet();
    run();
  };
  return b;
}

function openNewSessionSheet() {
  openSheet('New session', h('div', { class: 'action-list' },
    action('sparkle', 'Antigravity', 'Launch the Antigravity CLI', () => newSession('agy')),
    action('claude', 'Claude Code', 'Launch Anthropic’s Claude Code', () => newSession('claude')),
    action('terminal', 'Ubuntu shell', 'Bash in Ubuntu 24.04', () => newSession('ubuntu')),
    action('android', 'Android shell', 'The phone’s own /system/bin/sh', () => newSession('android')),
  ));
}

function openMoreSheet() {
  const s = active;
  openSheet('', h('div', { class: 'action-list' },
    s && action('book', s.isReaderOpen ? 'Back to terminal' : 'Reader view', 'Read and copy text with perfect Bangla', () => s.toggleReader()),
    s && action('copy', 'Copy all text', '', () => {
      bridge.copyText(s.allText());
      toast('Copied');
    }),
    s && action('paste', 'Paste', '', async () => {
      const t = await bridge.readClipboard();
      if (t) s.paste(t);
    }),
    action('remote', 'Antigravity dashboard', 'Antigravity running on your computer', () => openDashboard('agy')),
    action('claude', 'Claude Code dashboard', 'claude.ai/code — Remote Control sessions', () => openDashboard('claude')),
    action('zoomIn', 'Bigger text', '', () => setFontSize(Math.min(28, prefs.fontSize + 1), true)),
    action('zoomOut', 'Smaller text', '', () => setFontSize(Math.max(9, prefs.fontSize - 1), true)),
    s && action('eraser', 'Clear screen', '', () => {
      s.term.clear();
      s.scrollToBottom();
    }),
    action('settings', 'Settings', '', openSettingsSheet),
    s && action('bug', 'Copy debug log', 'Paste it into a chat if something misbehaves', () => {
      bridge.copyText(
        [
          `AntiCode debug log — ${new Date().toISOString()}`,
          `host=${bridge.host} ubuntu=${hostState.ubuntu} storage=${hostState.storage} ua=${navigator.userAgent}`,
          `--- JavaScript errors (${jsErrors.length}) ---`,
          ...jsErrors,
          s.debugDump(),
        ].join('\n'),
      );
      toast('Debug log copied');
    }),
    s && action('power', 'Close session', '', () => confirmClose(s), true),
  ));
}

// ================================================================ settings
let sample: TerminalSession | null = null;
function samplePreview(): HTMLElement {
  sample?.dispose();
  sample = new TerminalSession({ write() {}, resize() {} } as unknown as Bridge, '_sample', 'ubuntu', rendererOpts());
  sample.renderer.el.dataset.cursor = prefs.cursor;
  sample.term.resize(38, 4);
  sample.term.write(
    '\x1b[38;2;166;227;161m~\x1b[0m \x1b[38;2;137;180;250m❯\x1b[0m agy "বাংলায় লিখুন"\r\n' +
    '\x1b[38;2;245;169;127m✦\x1b[0m Hello! ক্ষমা, স্ত্রী, কৃষ্ণ, জ্ঞান\r\n' +
    '\x1b[2m│\x1b[0m Bangla + English │ সন্ত্রাস │\r\n' +
    '\x1b[38;2;137;180;250m❯\x1b[0m ',
  );
  return h('div', { class: 'preview' }, sample.renderer.el);
}

function openSettingsSheet() {
  const preview = h('div', {}, samplePreview());
  const refreshPreview = () => preview.replaceChildren(samplePreview());

  const range = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string,
    onInput: (v: number) => void, onDone: () => void) => {
    const val = h('span', { class: 'val' }, fmt(value));
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    input.oninput = () => {
      val.textContent = fmt(+input.value);
      onInput(+input.value);
    };
    input.onchange = onDone;
    return h('div', { class: 'setting' }, h('div', { class: 'setting-row' }, h('span', { class: 's-title' }, label), val), input);
  };

  const swatches = h('div', { class: 'swatches' },
    ...(Object.keys(THEME_LABELS) as ThemeName[]).map((name) => {
      const t = THEMES[name];
      const b = h('button', { class: 'swatch' + (prefs.theme === name ? ' on' : '') },
        h('div', { class: 'sw-colors' },
          ...[t.background, t.ansi[1], t.ansi[2], t.ansi[4], t.ansi[5]].map((c) => h('span', { style: `background:${c}` }))),
        THEME_LABELS[name]);
      b.onclick = () => {
        prefs.theme = name;
        savePrefs();
        applyTheme();
        swatches.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
        refreshPreview();
      };
      return b;
    }));

  const cursorSeg = h('div', { class: 'segmented' },
    ...(['block', 'bar', 'underline'] as CursorStyle[]).map((c) => {
      const b = h('button', { class: prefs.cursor === c ? 'on' : '' }, c[0].toUpperCase() + c.slice(1));
      b.onclick = () => {
        prefs.cursor = c;
        savePrefs();
        for (const s of sessions.values()) s.renderer.el.dataset.cursor = c;
        cursorSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        refreshPreview();
      };
      return b;
    }));

  const toggle = (title: string, sub: string, checked: boolean, onChange: (v: boolean) => void) => {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    return h('div', { class: 'setting' },
      h('div', { class: 'setting-row' },
        h('div', {}, h('div', { class: 's-title' }, title), h('div', { class: 's-sub' }, sub)),
        h('label', { class: 'switch' }, input, h('span', {}))));
  };

  const urlField = (key: 'remoteUrl' | 'claudeUrl') => {
    const input = h('input', { class: 'text-input', type: 'url', spellcheck: 'false' }) as HTMLInputElement;
    input.value = prefs[key];
    input.onchange = () => {
      prefs[key] = input.value.trim() || DEFAULT_PREFS[key];
      savePrefs();
    };
    return input;
  };

  openSheet('Settings',
    h('div', { class: 'setting' }, h('div', { class: 's-title' }, 'Theme'), swatches),
    h('div', { class: 'setting' }, h('div', { class: 's-title' }, 'Preview'), preview),
    range('Text size', 9, 24, 1, prefs.fontSize, (v) => `${v}px`, (v) => {
      setFontSize(v, false);
      sample?.renderer.setOptions({ fontSize: v });
    }, () => setFontSize(prefs.fontSize, true)),
    range('Bangla letter size', 0.8, 1.3, 0.05, prefs.bnScale, (v) => `${Math.round(v * 100)}%`, (v) => {
      prefs.bnScale = v;
      for (const s of sessions.values()) s.renderer.setOptions({ bnScale: v });
      sample?.renderer.setOptions({ bnScale: v });
    }, savePrefs),
    h('div', { class: 'setting' }, h('div', { class: 's-title' }, 'Cursor'), cursorSeg),
    toggle('Notify when a task finishes', 'A notification when an agent has answered or a long command is done — unless you are looking at it.', notifyWhenDone, (v) => {
      notifyWhenDone = v;
      bridge.setNotifyWhenDone(v);
    }),
    toggle('Animations', 'New output fades in, the cursor glides and the screen slides smoothly.', prefs.animations, (v) => {
      prefs.animations = v;
      savePrefs();
      for (const s of sessions.values()) s.renderer.setOptions({ animate: v });
    }),
    toggle('Keyboard compatibility mode', 'Turn on if your keyboard types nothing or wrong characters in the terminal.', prefs.kbCompat, (v) => {
      prefs.kbCompat = v;
      savePrefs();
      bridge.setKeyboardCompat(v);
    }),
    h('div', { class: 'setting' },
      h('div', { class: 's-title' }, 'Antigravity dashboard address'),
      h('div', { class: 's-sub' }, 'Paste the link agy shows if it differs.'),
      urlField('remoteUrl')),
    h('div', { class: 'setting' },
      h('div', { class: 's-title' }, 'Claude Code dashboard address'),
      h('div', { class: 's-sub' }, 'Where Remote Control sessions show up.'),
      urlField('claudeUrl')),
    h('p', { class: 'about-line' }, 'AntiCode · fonts: Kalpurush, JetBrains Mono, Noto Sans Symbols (SIL Open Font License)'),
  );
}

function applyTheme() {
  const t = THEMES[prefs.theme];
  document.body.dataset.theme = prefs.theme;
  document.body.style.setProperty('--term-bg', t.background);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.background);
  for (const s of sessions.values()) s.renderer.setOptions({ theme: t });
  const css = getComputedStyle(document.body);
  const v = (name: string) => css.getPropertyValue(name).trim();
  bridge.setThemeColors(v('--bg') || t.background, v('--text'), v('--muted'), v('--accent'));
}

// ================================================================ wiring
function bindChrome() {
  $('#home-btn').onclick = () => showHome();
  $('#plus-btn').onclick = () => openNewSessionSheet();
  $('#more-btn').onclick = () => openMoreSheet();
  $('#remote-top-btn').onclick = () => openDashboard(active?.kind === 'claude' ? 'claude' : 'agy');
  $('#settings-btn').onclick = () => openSettingsSheet();
  $('#sheet-backdrop').onclick = () => closeSheet();
  $('#remote-btn').onclick = () => openDashboard('agy');
  $('#storage-btn').onclick = () => bridge.requestStorage();
  $('#claude-remote-btn').onclick = () => openDashboard('claude');
  $('#copy-remote-cmd').onclick = () => {
    bridge.copyText('agy --remote-control');
    toast('Command copied');
  };
  $('#copy-claude-cmd').onclick = () => {
    bridge.copyText('claude --remote-control');
    toast('Command copied');
  };
  // Any text field in the page (settings) takes the keyboard back from the terminal.
  document.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement;
    if ((t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.id !== 'kbd') {
      active?.setFocused(false);
      bridge.setTerminalKeyboard(false);
    }
  });
  // Keyboard closed by the system (back button / swipe) → forget it was open.
  let lastH = window.innerHeight;
  window.addEventListener('resize', () => {
    if (window.innerHeight > lastH + 120) keyboardShown = false;
    lastH = window.innerHeight;
  });
}

// ================================================================ boot
async function boot() {
  console.info(`boot: ${location.href} host=${bridge.host}`);
  // Hook for the emulator self test (debug builds load the page with ?selftest=1).
  if (new URLSearchParams(location.search).has('selftest')) {
    (window as unknown as Record<string, unknown>).__selftest = {
      open: (kind: SessionKind) => newSession(kind),
      focusKeys: () => focusTerminalKeyboard(),
      send: (line: string) => active?.sendLine(line),
      home: () => showHome(),
      /** the active session, for tests */
      session: () => active,
      /** raw keys, e.g. '\x03' */
      keys: (seq: string) => active?.input(seq),
      screen: () => (active ? active.logicalLines().slice(-40).join('\n') : ''),
      errors: () => jsErrors.join('\n'),
      dump: () => (active ? active.debugDump() : ''),
    };
  }
  hydrateIcons();
  buildKeyBar();
  bindChrome();
  applyTheme();
  document.body.dataset.host = bridge.host;
  if (prefs.kbCompat) bridge.setKeyboardCompat(true);
  showHome();

  // Measure the cell size only after the fonts are really there
  // (bounded: a font that never finishes loading must not stall the whole UI).
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`${prefs.fontSize}px "JetBrains Mono"`),
        document.fonts.load(`bold ${prefs.fontSize}px "JetBrains Mono"`),
        document.fonts.load(`${prefs.fontSize}px Kalpurush`, 'বাংলা'),
      ]),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
  } catch { /* fall back to whatever is available */ }
  console.info(`boot: fonts ready=${document.fonts.check(`${prefs.fontSize}px Kalpurush`, 'বাংলা')}`);

  notifyWhenDone = await bridge.getNotifyWhenDone();
  try {
    hostState = await bridge.getState();
  } catch {
    hostState = { host: bridge.host, ubuntu: 'error', message: 'Could not reach the app' };
  }
  renderHome();

  // Re-attach to sessions that kept running while the UI was gone.
  try {
    const list = await bridge.listSessions();
    // forget saved terminal modes of sessions that no longer exist
    try {
      const ids = new Set(list.map((i) => i.id));
      for (const k of Object.keys(localStorage)) {
        const m = /^(modes|meta):(.*)$/.exec(k);
        if (m && !ids.has(m[2])) localStorage.removeItem(k);
      }
    } catch { /* storage unavailable */ }
    for (const info of list) {
      const s = addSession(info.id, info.kind);
      s.title = info.title || s.title;
      if (!info.alive) s.alive = false;
      // replay the saved output at the size it was written for (background tabs too)
      if (info.cols && info.rows) s.notePtySize(info.cols, info.rows);
      s.restoreModes();
      bridge.attach(info.id);
    }
    if (list.length) activate((pendingOpen && sessions.get(pendingOpen)) || [...sessions.values()].pop()!);
    pendingOpen = '';
  } catch { /* nothing to restore */ }

  new ResizeObserver(() => {
    active?.renderer.schedule(); // re-pan right away; resize (if any) once things settle
    fitSoon();
  }).observe($('#sessions'));
  window.addEventListener('resize', fitSoon);
}

boot();
