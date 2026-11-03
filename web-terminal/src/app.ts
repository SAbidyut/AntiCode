import './polyfills';
import { createBridge, type Bridge, type DirListing, type HostState, type SessionKind } from './bridge';
import { TerminalSession } from './term/session';
import { BanglaRenderer, THEMES } from './term/renderer';
import { androidKeySeq, applyMods, domKeySeq, namedKeySeq, type Mods, type NamedKey } from './term/keys';
import { hydrateIcons, icon } from './icons';

// ================================================================ prefs
type ThemeName = 'midnight' | 'black' | 'dracula' | 'solarized' | 'paper';
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
  /** Smart keyboard: suggestions and Bangla transliteration, like in a chat app. */
  kbSmart: boolean;
  /** Fade-in output, gliding cursor, sliding scroll. */
  animations: boolean;
  /** Asked once (on the first session) to run without battery restrictions. */
  askedBackground: boolean;
}
/** Driven by the emulator self test (no system dialogs over the terminal then). */
const SELFTEST = new URLSearchParams(location.search).has('selftest');
const DEFAULT_PREFS: Prefs = {
  fontSize: 14,
  theme: 'midnight',
  bnScale: 1,
  remoteUrl: 'https://antigravity.google.com',
  claudeUrl: 'https://claude.ai/code',
  cursor: 'block',
  kbCompat: false,
  kbSmart: true,
  animations: true,
  askedBackground: false,
};
const THEME_LABELS: Record<ThemeName, string> = {
  midnight: 'Midnight',
  black: 'Black',
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
  toast('Something went wrong — Settings → Advanced → Copy debug log');
}
window.addEventListener('error', (e) => reportError(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) => reportError(`unhandled rejection: ${String(e.reason)}`));

// ================================================================ state
const sessions = new Map<string, TerminalSession>();
let accounts = { agy: '', claude: '' };
let notifyWhenDone = true;
let claudeFullscreen = false;
let restored = false;
let pendingOpen = '';
const early = new Map<string, Uint8Array[]>();
let active: TerminalSession | null = null;
let hostState: HostState = { host: 'dev', ubuntu: 'none' };
/** getState() has answered (until then the home screen shows a neutral "starting"). */
let stateKnown = false;
const latch: Mods = {};
let screen: 'home' | 'term' = 'home';
let keyboardShown = false;
let fitTimer = 0;
let navBottom = 0;
/** The keyboard is sliding (the app-wide state; the active session's renderer follows it). */
let insetsMoving = false;
/** The session showing the smart keyboard's word being composed. */
let preeditOwner: TerminalSession | null = null;

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
  onReplayed(id) {
    sessions.get(id)?.restoreModes();
  },
  onState(state) {
    hostState = state;
    stateKnown = true;
    renderHome();
  },
  onImeComposing(text) {
    const s = typingTarget();
    if (!text) {
      // the word ended (sent, or taken back): wherever it was drawn, it goes
      preeditOwner?.renderer.setPreedit('');
      preeditOwner = null;
      return;
    }
    if (!s) return;
    // Ctrl / Alt latched on the key bar: the letter just typed is a shortcut (Ctrl+C), not
    // part of a word
    if (latch.ctrl || latch.alt) {
      const prev = preeditOwner === s ? s.renderer.preedit : '';
      const added = text.startsWith(prev) ? text.slice(prev.length) : text;
      const letter = [...(added || text)].pop()!;
      if (prev) s.input(prev); // the word before it was typed for real
      s.renderer.setPreedit('');
      preeditOwner = null;
      bridge.discardComposing();
      s.input(applyMods(letter, consumeLatch()));
      return;
    }
    if (preeditOwner && preeditOwner !== s) preeditOwner.renderer.setPreedit('');
    preeditOwner = s;
    // typing while reading the history: back to the prompt, where the word shows
    if (s.renderer.scrollPx > 0) s.scrollToBottom();
    s.renderer.setPreedit(text);
  },
  onImeText(text) {
    if (!typingTarget()) return;
    // several lines at once (the keyboard's clipboard): a paste, not lines typed and run
    if (text.length > 1 && /[\r\n]/.test(text) && !latch.ctrl && !latch.alt) {
      active!.paste(text);
      return;
    }
    active!.input(applyMods(text, consumeLatch()));
  },
  onImeKey(keyCode, ctrl, alt, shift, ch) {
    if (!typingTarget()) return;
    const seq = androidKeySeq(keyCode, { ctrl: ctrl || latch.ctrl, alt: alt || latch.alt, shift }, active!.appCursor, ch ?? '');
    if (!seq) return; // e.g. Shift on its own: keep the Ctrl/Alt latch for the next key
    consumeLatch();
    active!.input(seq);
  },
  onInsets(top, bottom, keyboard, settled, left = 0, right = 0, floating = false) {
    // The page draws edge-to-edge; padding follows the bars and the keyboard frame by frame,
    // and the bottom-anchored terminal glides with it. Resize the terminal once it settles.
    const root = document.documentElement.style;
    root.setProperty('--safe-top', `${top}px`);
    root.setProperty('--safe-bottom', `${bottom}px`);
    root.setProperty('--safe-left', `${left}px`);
    root.setProperty('--safe-right', `${right}px`);
    // The keyboard's height doesn't resize the terminal (see TerminalSession.fit).
    if (!keyboard) navBottom = bottom;
    TerminalSession.keyboardInset = keyboard ? Math.max(0, bottom - navBottom) : 0;
    // landscape folds the key rail when a docked keyboard takes the bottom of the screen
    document.body.dataset.kb = floating ? 'floating' : keyboard ? 'docked' : '';
    BanglaRenderer.floatingKeyboard = floating;
    insetsMoving = !settled;
    if (active) active.renderer.insetsMoving = insetsMoving;
    active?.renderer.schedule();
    if (settled) {
      keyboardShown = keyboard || floating;
      clearTimeout(fitTimer);
      active?.fit();
      // (landscape: the tab rail got shorter or longer — keep the current tab in it)
      if (screen === 'term') $('#tabs').querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // a field in a sheet (Settings, rename) that the keyboard now covers
      const f = document.activeElement;
      if (keyboard && f instanceof HTMLInputElement && f.closest('.sheet')) f.scrollIntoView({ block: 'nearest' });
    }
  },
  onKeyboardReleased() {
    keyboardShown = false;
    active?.setFocused(false);
  },
  onOpenSession(id) {
    const s = sessions.get(id);
    if (s) activate(s);
    else if (!restored) pendingOpen = id; // still starting: open it once sessions are restored
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

/**
 * Typing is about to go somewhere else (another tab, home, a sheet, a key-bar key, a text
 * field): a word still being composed is typed into its session now, and the keyboard
 * forgets its copy of the line — the line in the terminal is about to change under it
 * (otherwise its next ⌫ would delete by a stale copy, or the word would be typed later
 * into the wrong place).
 */
function settleComposing() {
  const s = preeditOwner;
  preeditOwner = null;
  if (s && s.renderer.preedit) {
    if (sessions.get(s.id) === s && s.alive) s.input(s.renderer.preedit);
    s.renderer.setPreedit('');
  }
  if (bridge.host === 'android') bridge.discardComposing();
}

/** The session typing goes to: none while the home screen or a sheet covers it. */
function typingTarget(): TerminalSession | null {
  return active && screen === 'term' && !sheetOpen() ? active : null;
}

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

/**
 * A program asked to open a link. Our own xdg-open (Antigravity / Claude Code sign-in …)
 * opens web pages straight away; anything else — the same escape printed by `cat` of a
 * downloaded file, or a link to another app — only after the user says so.
 */
function openLink(url: string, trusted: boolean) {
  if (trusted && /^https?:\/\//i.test(url)) {
    bridge.openUrl(url);
    return;
  }
  openSheet(
    'Open this link?',
    h('p', { class: 'note link-ask' }, url.length > 400 ? `${url.slice(0, 400)}…` : url),
    h('div', { class: 'action-list' },
      action('external', 'Open', '', () => bridge.openUrl(url)),
      action('x', 'Cancel', '', () => {}),
    ),
  );
}

function addSession(id: string, kind: SessionKind): TerminalSession {
  const existing = sessions.get(id);
  if (existing) return existing; // listed and created at the same moment
  const s = new TerminalSession(bridge, id, kind, rendererOpts());
  s.onLink = openLink;
  s.renderer.el.dataset.cursor = prefs.cursor;
  s.onTitle = () => renderTabs();
  s.onMeta = () => renderTabs();
  s.onAccount = (email) => {
    if (email === accounts.agy) return;
    accounts.agy = email;
    bridge.setAntigravityAccount(email);
  };
  sessions.set(id, s);
  for (const d of early.get(id) ?? []) s.write(d);
  early.delete(id);
  $('#sessions').append(s.el);
  bindTerminalGestures(s);
  return s;
}

async function newSession(kind: SessionKind, cwd = '') {
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
  const id = await bridge.createSession(kind, cols, rows, cwd);
  if (!id) {
    toast('Could not start the session');
    if (!sessions.size) showHome();
    return;
  }
  const s = addSession(id, kind);
  s.notePtySize(cols, rows);
  s.startDir = cwd || homeDir();
  activate(s);
  // The first session: ask (once) to be left alone by battery optimisation — otherwise
  // Android may stop the app, and every session with it, while it's in the background.
  if (hostState.host === 'android' && hostState.background === false && !prefs.askedBackground && !SELFTEST) {
    prefs.askedBackground = true;
    savePrefs();
    toast('Allow AntiCode to keep running in the background');
    window.setTimeout(() => bridge.allowBackground(), 600);
  }
}

/** The app was killed with sessions running: say so, and offer to start them again. */
async function reportLostSessions() {
  const lost = await bridge.getLostSessions();
  if (!lost.length) return;
  bridge.forgetLostSessions();
  const names = lost.map((l) => l.label || ({ agy: 'Antigravity', claude: 'Claude Code', ubuntu: 'Ubuntu shell', android: 'Android shell' }[l.kind] ?? l.kind));
  const unique = [...new Set(names)];
  openSheet(
    lost.length === 1 ? 'A session was stopped' : `${lost.length} sessions were stopped`,
    h('p', { class: 'note' },
      `Android closed AntiCode while it was in the background (${unique.join(', ')}). `,
      hostState.background === false
        ? 'Allow it to run without battery limits so this doesn’t happen again.'
        : 'If it keeps happening, lock AntiCode in Recents (long-press its card → Lock).'),
    h('div', { class: 'action-list' },
      action('terminal', lost.length === 1 ? 'Open it again' : 'Open them again', 'Fresh sessions of the same kind', async () => {
        for (const l of lost) await newSession(l.kind);
      }),
      hostState.background === false ? action('shield', 'Allow running in the background', '', () => bridge.allowBackground()) : null,
      action('x', 'Not now', '', () => {}),
    ),
  );
}

function activate(s: TerminalSession | null) {
  if (s !== active) settleComposing();
  for (const x of sessions.values()) {
    x.el.hidden = x !== s;
    x.setFocused(false);
    x.renderer.insetsMoving = x === s && insetsMoving;
  }
  active = s;
  bridge.setActiveSession(s?.id ?? '');
  if (s) {
    showTerm();
    s.fit(); // layout is already known; don't wait for a frame (rAF is paused when the screen is off)
    requestAnimationFrame(() => s.fit());
  }
  renderTabs(true);
  saveUiState();
  if (s) showSessionPill(s);
}

let pillTimer = 0;
/**
 * Landscape has no tab titles (the sessions are icons in the side rail): say which session
 * this is for a moment, at the top right, then get out of the way.
 */
function showSessionPill(s: TerminalSession) {
  const pill = $('#session-pill');
  pill.replaceChildren(h('i', { class: s.alive ? 'on' : '' }), s.customName || s.kindLabel);
  if (s.about && !s.customName) pill.append(h('span', {}, ` · ${s.about}`));
  pill.classList.add('show');
  clearTimeout(pillTimer);
  pillTimer = window.setTimeout(() => pill.classList.remove('show'), 2600);
}

function closeSession(s: TerminalSession) {
  bridge.close(s.id);
  sessions.delete(s.id);
  early.delete(s.id);
  sentLabels.delete(s.id);
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
    `Close “${s.label}”?`,
    h('p', { class: 'note' }, 'Anything running in this session will be stopped.'),
    h('div', { class: 'action-list' },
      action('power', 'Close session', '', () => closeSession(s), true),
      action('x', 'Cancel', '', () => {}),
    ),
  );
}

let tabsSig = '';
const sentLabels = new Map<string, string>();

/** Tabs + the home list. Cheap when nothing they show changed (titles change a lot). */
function renderTabs(scrollToActive = false) {
  const tabs = $('#tabs');
  for (const s of sessions.values()) {
    const l = s.customName || s.about || s.kindLabel;
    if (sentLabels.get(s.id) === l) continue;
    sentLabels.set(s.id, l);
    bridge.setSessionLabel(s.id, l);
  }
  const sig = [...sessions.values()]
    .map((s) => [s.id, s.label, s.about, s.customName, s.alive].join('|'))
    .join('\n');
  if (sig !== tabsSig) {
    tabsSig = sig;
    syncTabs(tabs);
    renderHomeSessions();
  }
  // switching tabs only moves the highlight (existing tabs, so it eases)
  for (const el of tabs.children) {
    const on = (el as HTMLElement).dataset.id === active?.id;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  }
  if (scrollToActive) tabs.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

/** Update the tabs in place: same elements for the same sessions (no flash, no jump). */
function syncTabs(tabs: HTMLElement) {
  const existing = new Map<string, HTMLElement>();
  for (const el of tabs.children) existing.set((el as HTMLElement).dataset.id ?? '', el as HTMLElement);
  const order: HTMLElement[] = [];
  for (const s of sessions.values()) {
    const tab = existing.get(s.id) ?? makeTab(s);
    tab.classList.toggle('dead', !s.alive);
    tab.title = s.label;
    tab.setAttribute('aria-label', s.alive ? s.label : `${s.label} (finished)`);
    const tt = tab.querySelector('.tt')!;
    if (tt.textContent !== s.label) tt.textContent = s.label;
    order.push(tab);
  }
  if (order.length !== tabs.children.length || order.some((t, i) => tabs.children[i] !== t)) tabs.replaceChildren(...order);
}

function makeTab(s: TerminalSession): HTMLElement {
  const tab = h('div', { class: `tab kind-${s.kind}`, 'data-id': s.id, role: 'tab' },
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
}

// ================================================================ screens
/** Which tab was open, and whether the home screen was: back there after the UI restarts. */
function saveUiState() {
  if (!restored) return; // not before it was read back
  try {
    localStorage.setItem('ui', JSON.stringify({ active: active?.id ?? '', screen }));
  } catch { /* storage unavailable */ }
}

function showHome() {
  settleComposing(); // (before the keyboard goes: hiding it would commit the word nowhere)
  screen = 'home';
  saveUiState();
  bridge.setActiveSession(''); // looking at no session: all of them may notify
  document.body.dataset.screen = 'home';
  bridge.hideKeyboard();
  keyboardShown = false;
  renderHome();
}
/** The first appearance of the home screen: its parts rise in one after another. */
function enterHome() {
  const home = $('#home');
  home.classList.add('enter');
  showHome();
  window.setTimeout(() => home.classList.remove('enter'), 900);
}

function showTerm() {
  screen = 'term';
  saveUiState();
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
  // the hero is rebuilt only when what it shows changes (state updates come often: a rebuild
  // restarts its transitions and flashes); install progress is updated in place
  const kind = !stateKnown ? 'starting' : st.ubuntu === 'ready' || st.ubuntu === 'installing' ? st.ubuntu : `${st.ubuntu}|${st.message ?? ''}`;
  if (kind === 'installing' && hero.dataset.kind === 'installing') {
    updateInstallProgress(hero);
    finishRenderHome();
    return;
  }
  if (hero.dataset.kind === kind && hero.childElementCount) {
    finishRenderHome();
    return;
  }
  let body: Kid[];
  if (!stateKnown) {
    body = [pill('busy', 'Starting…')]; // not "Install Ubuntu" for a moment on every start
  } else if (st.ubuntu === 'ready') {
    body = [
      h('h2', {}, 'Pick your agent'),
      h('div', { class: 'agents' },
        agentTile('agy', 'sparkle', 'Antigravity', 'Google'),
        agentTile('claude', 'claude', 'Claude Code', 'Anthropic'),
      ),
      h('div', { class: 'actions' },
        btn('btn-secondary', 'terminal', 'Ubuntu shell', () => askFolder('ubuntu')),
      ),
    ];
  } else if (st.ubuntu === 'installing') {
    body = [
      pill('busy', 'Installing Ubuntu'),
      h('h2', {}, 'Setting things up'),
      h('div', { class: 'progress' }, h('div', { class: 'bar' })),
      h('div', { class: 'progress-row' }, h('span', { class: 'msg' }), h('span', { class: 'pct' })),
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
  hero.dataset.state = stateKnown ? st.ubuntu : 'starting'; // (the landscape layout trims the ready card)
  hero.dataset.kind = kind;
  // (not while the home screen's own entrance is playing: that already brings it in)
  const was = hero.childElementCount > 0 && document.body.dataset.screen === 'home' && !$('#home').classList.contains('enter');
  hero.replaceChildren(...(body.filter(Boolean) as Node[]));
  if (kind === 'installing') updateInstallProgress(hero);
  // a new state (installed, failed…) fades in rather than snapping
  if (was && prefs.animations) hero.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
  finishRenderHome();
}

function updateInstallProgress(hero: HTMLElement) {
  const st = hostState;
  const frac = Math.max(0, Math.min(1, st.progress ?? 0));
  const bar = hero.querySelector('.progress .bar') as HTMLElement | null;
  if (bar) bar.style.transform = `scaleX(${frac})`;
  const msg = hero.querySelector('.progress-row .msg');
  const text = st.message ?? 'Downloading…';
  if (msg && msg.textContent !== text) msg.textContent = text;
  const pct = hero.querySelector('.progress-row .pct');
  const p = `${Math.round(frac * 100)}%`;
  if (pct && pct.textContent !== p) pct.textContent = p;
}

function finishRenderHome() {
  renderStorage();
  // only on the phone, and only until it's allowed
  setCardShown($('#bg-card'), stateKnown && hostState.host === 'android' && hostState.background === false);
  renderHomeSessions();
}

/** A card's fold animation (kept here: older WebViews have no element.getAnimations). */
const folding = new WeakMap<HTMLElement, Animation>();
/** Shows / hides a home card; one that is done (permission given) folds away instead of vanishing. */
function setCardShown(el: HTMLElement, show: boolean) {
  if (show) {
    if (el.dataset.folding) {
      delete el.dataset.folding;
      folding.get(el)?.cancel();
    }
    el.hidden = false;
    return;
  }
  if (el.hidden || el.dataset.folding) return;
  if (!prefs.animations || document.body.dataset.screen !== 'home' || !el.offsetHeight) {
    el.hidden = true;
    return;
  }
  el.dataset.folding = '1';
  const cs = getComputedStyle(el);
  const from = { opacity: 1, height: `${el.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginBottom: cs.marginBottom };
  const to = { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px' };
  el.style.overflow = 'hidden';
  const a = el.animate([from, to], { duration: 280, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' });
  folding.set(el, a);
  const done = (hide: boolean) => {
    el.style.overflow = '';
    if (hide && el.dataset.folding) el.hidden = true;
    delete el.dataset.folding;
  };
  a.onfinish = () => done(true);
  a.oncancel = () => done(false);
}

function agentTile(kind: SessionKind, ic: string, name: string, maker: string) {
  const b = h('button', { class: `agent-tile agent-${kind}` },
    h('span', { class: 'agent-icon' }, svg(ic)),
    h('span', { class: 'agent-name' }, name),
    h('span', { class: 'agent-sub' }, maker),
    h('span', { class: 'agent-go' }, svg('chevron')));
  b.setAttribute('aria-label', `Launch ${name}`);
  b.onclick = () => {
    haptic();
    askFolder(kind);
  };
  return b;
}

function renderStorage() {
  const status = $('#storage-status');
  const button = $('#storage-btn');
  // nothing left to do here once access is granted
  setCardShown($('#storage-card'), stateKnown && !(hostState.host !== 'dev' && hostState.storage));
  if (!stateKnown) return;
  if (hostState.host === 'dev') {
    status.textContent = 'Available in the Android app.';
    button.hidden = true;
  } else if (!hostState.storage) {
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
  const input = h('input', { class: 'text-input', type: 'text', maxlength: '60', placeholder: s.about || s.kindLabel, spellcheck: 'false', 'data-autofocus': '1' }) as HTMLInputElement;
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
  let longTimer = 0, inertia = 0, caughtFling = false;
  /** Pulled past the top or bottom of the scrollback (px, the rubber band). */
  let stretch = 0;
  /** A drag: scrolls; past an end the content stretches, and pulling back undoes that first. */
  const dragScroll = (dy: number, x: number, y: number) => {
    if (s.term.buffer.active.type === 'alternate') {
      scrollBy(dy, x, y);
      return;
    }
    if (stretch && Math.sign(dy) !== Math.sign(stretch)) {
      const back = Math.sign(dy) * Math.min(Math.abs(dy), Math.abs(stretch));
      stretch += back;
      dy -= back;
      s.renderer.setOverscroll(stretch);
      if (!dy) return;
    }
    if (s.renderer.scrollByPixels(dy)) return;
    const max = s.renderer.maxOverscroll;
    // the further it's pulled, the harder it gets
    stretch = Math.max(-max, Math.min(max, stretch + dy * 0.55 * (1 - Math.abs(stretch) / max)));
    s.renderer.setOverscroll(stretch);
  };
  const letGo = () => {
    if (!stretch) return false;
    stretch = 0;
    s.renderer.releaseOverscroll();
    return true;
  };
  let pinch0 = 0, font0 = prefs.fontSize, pinchSize = prefs.fontSize;
  const touches = new Map<number, { x: number; y: number }>();

  const stopInertia = () => {
    cancelAnimationFrame(inertia);
    inertia = 0;
  };
  // Full-screen programs (vim, less, Claude Code's full-screen view) scroll themselves: they
  // get wheel steps, paced — at most 2 a frame, a short backlog — so a quick swipe doesn't
  // bury them in events they redraw one by one (and then jump to catch up).
  let wheelLines = 0, wheelFrame = 0, wheelX = 0, wheelY = 0;
  const flushWheel = () => {
    wheelFrame = 0;
    const n = Math.max(-2, Math.min(2, wheelLines));
    wheelLines -= n;
    if (n) s.scrollLines(n, wheelX, wheelY);
    if (wheelLines) wheelFrame = requestAnimationFrame(flushWheel);
  };
  /** Scroll by pixels. Scrollback moves pixel-smooth; full-screen apps get wheel steps. */
  const scrollBy = (px: number, x: number, y: number): boolean => {
    if (s.term.buffer.active.type !== 'alternate') return s.renderer.scrollByPixels(px);
    acc += px;
    const lh = s.renderer.lineHeight;
    const lines = Math.trunc(acc / lh);
    if (lines) {
      acc -= lines * lh;
      wheelLines = Math.max(-12, Math.min(12, wheelLines + lines));
      wheelX = x;
      wheelY = y;
      if (!wheelFrame) wheelFrame = requestAnimationFrame(flushWheel);
    }
    return true;
  };
  const startInertia = (v: number, x: number, y: number) => {
    let prev = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - prev);
      prev = now;
      const moving = scrollBy(v * dt, x, y);
      // ran into the top or the bottom: a short bounce, like any list on the phone
      if (!moving && s.term.buffer.active.type !== 'alternate') {
        s.renderer.bounce(v);
        inertia = 0;
        return;
      }
      v *= Math.pow(0.95, dt / 16);
      inertia = moving && Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    inertia = requestAnimationFrame(step);
  };

  el.addEventListener('pointerdown', (e) => {
    caughtFling = inertia !== 0; // a tap that only stops the scrolling isn't a tap
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
        // the hint once; after that the gesture speaks for itself
        let seen = false;
        try {
          seen = localStorage.getItem('readerHint') === '1';
          localStorage.setItem('readerHint', '1');
        } catch { /* no storage: show it */ }
        if (!seen) toast('Reader view — select text to copy. Back to return.');
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
    dragScroll(dy, e.clientX, e.clientY);
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
    if (e.type !== 'pointerup') {
      letGo();
      return;
    }
    if (moved) {
      if (letGo()) return; // springs back instead of flinging on
      if (performance.now() - lastT < 80 && Math.abs(vel) > 0.2) startInertia(vel, e.clientX, e.clientY);
      return;
    }
    if (caughtFling) return;
    if (Date.now() - t0 < 600) {
      const url = s.urlAt(e.clientX, e.clientY);
      if (url) {
        bridge.openUrl(url); // the user tapped it
        return;
      }
      const file = s.fileAt(e.clientX, e.clientY);
      if (file) {
        openTappedFile(s, file); // report.pdf, ~/site/index.html …
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
/**
 * Re-measure the terminal once the layout has been still for a moment — never in the middle
 * of a change (the keyboard sliding, a rotation): a passing in-between size would resize the
 * terminal and make the shell redraw (the screen jumps), only to resize it back.
 */
function fitSoon() {
  clearTimeout(fitTimer);
  const t0 = performance.now();
  fitTimer = window.setTimeout(function settle() {
    // (a slide that never reports its end doesn't hold it off for more than a second)
    if (insetsMoving && performance.now() - t0 < 1000) {
      fitTimer = window.setTimeout(settle, 120);
      return;
    }
    active?.fit();
  }, 250);
}

function setFontSize(size: number, persist: boolean, say = false) {
  prefs.fontSize = size;
  for (const s of sessions.values()) s.renderer.setOptions({ fontSize: size });
  active?.fit();
  if (persist) {
    savePrefs();
    if (say) toast(`Text size ${size}`);
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
        // a word still being composed on the smart keyboard goes first, and the keyboard's
        // copy of the line is dropped (^C, ↑, Tab … change the line under it)
        settleComposing();
        if (k.latch) {
          latch[k.latch] = !latch[k.latch];
          b.classList.toggle('on', !!latch[k.latch]);
          return;
        }
        const m = consumeLatch();
        active.input(k.key ? namedKeySeq(k.key, m, active.appCursor) : applyMods(k.text!, m));
      };
      // fingers on this key: it repeats until the last one lifts
      const down = new Set<number>();
      // pointerdown + preventDefault keeps the soft keyboard open
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        haptic();
        b.classList.add('pressed');
        down.add(e.pointerId);
        fire();
        clearTimeout(repeat);
        if (k.repeat) {
          repeat = window.setTimeout(function loop() {
            fire();
            repeat = window.setTimeout(loop, 55);
          }, 380);
        }
      });
      const stop = (e: PointerEvent) => {
        down.delete(e.pointerId);
        if (down.size) return;
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
  const sheet = $('#sheet');
  return !sheet.hidden && !sheet.classList.contains('closing');
}
let sheetHideTimer = 0;
function openSheet(title: string, ...content: Kid[]) {
  const sheet = $('#sheet');
  const backdrop = $('#sheet-backdrop');
  const body = sheet.querySelector('.sheet-body') as HTMLElement;
  // a sheet replacing another (⋮ → Settings): the sheet stays, its height eases to the new
  // content and the content fades in, instead of a jump
  const swap = !sheet.hidden;
  const h0 = swap ? sheet.offsetHeight : 0;
  settleComposing();
  clearTimeout(sheetHideTimer);
  sheet.classList.remove('closing');
  backdrop.classList.remove('closing');
  body.replaceChildren(...([title ? h('h3', {}, title) : null, ...content].filter(Boolean) as Node[]));
  backdrop.hidden = false;
  sheet.hidden = false;
  sheet.scrollTop = 0;
  if (swap && prefs.animations) {
    const h1 = sheet.offsetHeight;
    if (h1 !== h0) {
      sheet.animate([{ transform: `translateY(${h1 - h0}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
    body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
  }
  // the terminal's keyboard would squeeze the sheet into a strip above it (not for a sheet
  // that wants typing: the keyboard moves on to its field)
  if (keyboardShown && screen === 'term' && !body.querySelector('[data-autofocus]')) hideKeyboard();
}
function closeSheet() {
  const sheet = $('#sheet');
  const backdrop = $('#sheet-backdrop');
  if (sheet.hidden) return;
  sheet.classList.add('closing');
  backdrop.classList.add('closing');
  clearTimeout(sheetHideTimer);
  sheetHideTimer = window.setTimeout(() => {
    sheet.hidden = true;
    backdrop.hidden = true;
    sheet.classList.remove('closing');
    backdrop.classList.remove('closing');
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
    action('sparkle', 'Antigravity', 'Launch the Antigravity CLI', () => askFolder('agy')),
    action('claude', 'Claude Code', 'Launch Anthropic’s Claude Code', () => askFolder('claude')),
    action('terminal', 'Ubuntu shell', 'Bash in Ubuntu 24.04', () => askFolder('ubuntu')),
    action('android', 'Android shell', 'The phone’s own /system/bin/sh', () => newSession('android')),
  ));
}

// ================================================================ folder picker
// Antigravity, Claude Code and the shell start in a folder picked here: a recent one with one
// tap, or one found by browsing (home, the phone's storage).
const RECENT_DIRS = 'recentDirs';
const KIND_NAME: Record<string, string> = { agy: 'Antigravity', claude: 'Claude Code', ubuntu: 'Ubuntu shell' };

function recentDirs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_DIRS) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.startsWith('/')).slice(0, 6) : [];
  } catch {
    return [];
  }
}
function saveRecentDirs(list: string[]) {
  try {
    localStorage.setItem(RECENT_DIRS, JSON.stringify(list.slice(0, 6)));
  } catch { /* no storage */ }
}

const homeDir = () => hostState.home || '/root';
/** /root/a/b → ~/a/b */
function tildify(p: string) {
  const home = homeDir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}
function dirName(p: string) {
  return p === homeDir() ? 'Home' : (p.split('/').filter(Boolean).pop() ?? '/');
}
/** A long path keeps its start and its end: ~/storage/…/project/src */
function shortPath(p: string, max = 40) {
  const t = tildify(p);
  if (t.length <= max) return t;
  const parts = t.split('/');
  let tail = parts.pop()!;
  while (parts.length > 1 && `${parts[0]}/…/${parts[parts.length - 1]}/${tail}`.length <= max) tail = `${parts.pop()}/${tail}`;
  return `${parts[0]}/…/${tail}`;
}
const parentDir = (p: string) => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');
const childDir = (p: string, name: string) => (p === '/' ? `/${name}` : `${p}/${name}`);

function folderRow(icon: string, title: string, sub: string, onClick: () => void, cls = '') {
  const b = h('button', { class: `action fp-row ${cls}` },
    h('span', { class: 'a-icon' }, svg(icon)),
    h('span', { class: 'a-main' }, h('span', { class: 'a-title' }, title), sub ? h('span', { class: 'a-sub' }, sub) : null),
    cls.includes('browse') ? svg('chevron', 'chev') : null);
  b.onclick = () => {
    haptic();
    onClick();
  };
  return b;
}

/** Antigravity / Claude Code / a shell: in which folder? */
function askFolder(kind: SessionKind) {
  if (kind === 'android' || hostState.ubuntu !== 'ready') {
    newSession(kind); // (the Android shell has no folders to pick; no Ubuntu: it says so)
    return;
  }
  const recent = recentDirs();
  const start = recent.length ? recent : [homeDir()];
  const places: [string, string, string][] = [['home', 'Home', homeDir()]];
  if (hostState.host === 'android') {
    places.push(
      ['folder', 'Phone storage', `${homeDir()}/storage/shared`],
      ['down', 'Downloads', `${homeDir()}/storage/downloads`],
      ['folder', 'Documents', `${homeDir()}/storage/documents`],
    );
  }
  const needsAccess = hostState.host === 'android' && !hostState.storage;
  openSheet(`Open ${KIND_NAME[kind]} in…`,
    h('div', { class: 'fp-label' }, 'Start in'),
    h('div', { class: 'action-list' },
      ...start.map((p, i) => folderRow(p === homeDir() ? 'home' : 'folder', dirName(p), i === 0 && recent.length ? `${shortPath(p)} · last used` : shortPath(p),
        () => startIn(kind, p), 'recent'))),
    h('div', { class: 'fp-label' }, 'Choose another folder'),
    h('div', { class: 'action-list' },
      ...places.map(([icon, title, p]) => folderRow(icon, title,
        needsAccess && p !== homeDir() ? 'Needs storage access' : tildify(p), () => browseFolder(kind, p), 'browse'))),
  );
}

/**
 * A file name tapped in the terminal (a page or PDF an agent made): it opens — pages, pictures
 * and text in the app, a PDF in the phone's viewer. A bare name is looked for where the shell
 * is, then in the folder the session started in, then at home.
 */
async function openTappedFile(s: TerminalSession, token: string) {
  haptic();
  let p = token;
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/[^/]*/i, '');
    try {
      p = decodeURIComponent(p);
    } catch { /* as it is */ }
  }
  const rel = p.replace(/^\.\//, '');
  const candidates = p.startsWith('/') || p === '~' || p.startsWith('~/')
    ? [p]
    : [...new Set([s.cwd, s.startDir, homeDir()].filter(Boolean).map((d) => `${d.replace(/\/+$/, '')}/${rel}`))];
  const res = await bridge.openFile(candidates);
  if (res === 'notfound') toast(`${p.split('/').pop()} wasn’t found here`);
  else if (res) toast(res);
}

async function startIn(kind: SessionKind, p: string) {
  // a remembered folder that's gone: say so instead of starting somewhere else
  const res = await bridge.listDir(p).catch(() => null);
  if (res?.error === 'notfound') {
    saveRecentDirs(recentDirs().filter((x) => x !== p));
    toast(`${tildify(p)} isn’t there any more`);
    askFolder(kind);
    return;
  }
  saveRecentDirs([p, ...recentDirs().filter((x) => x !== p)]);
  closeSheet();
  newSession(kind, p);
}

let browseSeq = 0;
async function browseFolder(kind: SessionKind, path: string) {
  const seq = ++browseSeq;
  const res = await bridge.listDir(path).catch((): DirListing => ({ path, error: 'notfound' }));
  if (seq !== browseSeq || !sheetOpen()) return; // another tap came first / the sheet was closed
  const p = res.path;
  const up = h('button', { class: 'fp-up', 'aria-label': 'Up' }, svg('chevron'));
  up.onclick = () => {
    haptic();
    if (p === '/') askFolder(kind);
    else browseFolder(kind, parentDir(p));
  };
  const open = h('button', { class: 'btn btn-primary fp-open' }, svg('check'), h('span', {}, `Open here`));
  open.onclick = () => {
    haptic();
    startIn(kind, p);
  };
  if (res.error) open.setAttribute('disabled', '');
  const head = h('div', { class: 'fp-head' },
    h('div', { class: 'fp-pathbar' }, up, h('span', { class: 'fp-where' }, tildify(p))),
    open);

  let body: Kid[];
  if (res.error === 'noaccess') {
    const allow = h('button', { class: 'btn btn-secondary' }, svg('shield'), h('span', {}, 'Allow storage access'));
    allow.onclick = () => {
      haptic();
      bridge.requestStorage();
    };
    body = [h('p', { class: 'fp-empty' }, 'AntiCode can’t see your phone’s files yet.'), allow];
  } else if (res.error) {
    body = [h('p', { class: 'fp-empty' }, 'This folder isn’t there.')];
  } else {
    const dirs = res.dirs ?? [];
    body = [
      h('div', { class: 'action-list' },
        ...dirs.map((d) => folderRow('folder', d, '', () => browseFolder(kind, childDir(p, d)), 'browse sub')),
        newFolderRow(kind, p)),
      dirs.length ? null : h('p', { class: 'fp-empty' }, 'No folders in here — open it, or make one.'),
    ];
  }
  openSheet(`Open ${KIND_NAME[kind]} in…`, head, ...body);
}

/** "New folder": a name field in place of the row; the new folder is opened in the browser. */
function newFolderRow(kind: SessionKind, parent: string) {
  const row = folderRow('plus', 'New folder', '', () => {
    const input = h('input', { class: 'text-input', type: 'text', maxlength: '120', spellcheck: 'false', placeholder: 'Folder name' }) as HTMLInputElement;
    const make = h('button', { class: 'btn btn-primary' }, 'Create');
    const create = async () => {
      const name = input.value.trim();
      if (!name || name === '.' || name === '..' || /[/\x00]/.test(name)) {
        toast('Pick a name without “/”');
        return;
      }
      const err = await bridge.makeDir(childDir(parent, name));
      if (err) toast(err);
      else browseFolder(kind, childDir(parent, name));
    };
    make.onclick = create;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
    });
    row.replaceWith(h('div', { class: 'fp-new' }, input, make));
    input.focus();
  }, 'new');
  return row;
}

function openMoreSheet() {
  const s = active;
  openSheet('', h('div', { class: 'action-list' },
    s && action('book', s.isReaderOpen ? 'Back to terminal' : 'Reader view', '', () => s.toggleReader()),
    s && action('copy', 'Copy all text', '', () => {
      bridge.copyText(s.allText());
      toast('Copied');
    }),
    s && action('paste', 'Paste', '', async () => {
      const t = await bridge.readClipboard();
      if (t) s.paste(t);
    }),
    action('remote', 'Antigravity dashboard', '', () => openDashboard('agy')),
    action('claude', 'Claude Code dashboard', '', () => openDashboard('claude')),
    s && action('eraser', 'Clear screen', '', () => {
      s.term.clear();
      s.scrollToBottom();
    }),
    action('settings', 'Settings', '', openSettingsSheet),
    s && action('power', 'Close session', '', () => confirmClose(s), true),
  ));
}

function copyDebugLog() {
  bridge.copyText(
    [
      `AntiCode debug log — ${new Date().toISOString()}`,
      `host=${bridge.host} ubuntu=${hostState.ubuntu} storage=${hostState.storage} ua=${navigator.userAgent}`,
      `--- JavaScript errors (${jsErrors.length}) ---`,
      ...jsErrors,
      active ? active.debugDump() : '(no session open)',
    ].join('\n'),
  );
  toast('Debug log copied');
}

// ================================================================ settings
let sample: TerminalSession | null = null;
function samplePreview(): HTMLElement {
  sample?.dispose();
  sample = new TerminalSession({ write() {}, resize() {} } as unknown as Bridge, '_sample', 'ubuntu', rendererOpts());
  sample.renderer.el.dataset.cursor = prefs.cursor;
  sample.renderer.floatPan = false;
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

  const accountField = h('input', { class: 'text-input', type: 'email', spellcheck: 'false', placeholder: 'you@gmail.com' }) as HTMLInputElement;
  accountField.value = accounts.agy;
  accountField.onchange = () => {
    const v = accountField.value.trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      toast('That doesn’t look like an email address');
      accountField.value = accounts.agy;
      return;
    }
    accounts.agy = v;
    bridge.setAntigravityAccount(accounts.agy);
  };
  const resetBtn = h('button', { class: 'btn btn-secondary' }, 'Open claude.ai in the app again');
  resetBtn.onclick = () => {
    bridge.resetDashboardChoices();
    toast('Dashboards will open in the app again');
  };
  const urlField = (key: 'remoteUrl' | 'claudeUrl') => {
    const input = h('input', { class: 'text-input', type: 'url', spellcheck: 'false' }) as HTMLInputElement;
    input.value = prefs[key];
    input.onchange = () => {
      let v = input.value.trim();
      if (v && !/^[a-z][\w+.-]*:/i.test(v)) v = `https://${v}`; // "claude.ai/code"
      let ok = !v;
      try {
        ok ||= ['https:', 'http:'].includes(new URL(v).protocol);
      } catch { /* not a URL */ }
      if (!ok) {
        toast('Enter a web address (https://…)');
        input.value = prefs[key];
        return;
      }
      prefs[key] = v || DEFAULT_PREFS[key];
      input.value = prefs[key];
      savePrefs();
    };
    return input;
  };

  openSheet('Settings',
    h('div', { class: 'setting' }, h('div', { class: 's-title' }, 'Theme'), swatches),
    h('div', { class: 'setting' }, h('div', { class: 's-title' }, 'Preview'), preview),
    // while dragging only the preview changes; the terminals once the finger lifts (each
    // change resizes them and makes their programs redraw)
    range('Text size', 9, 28, 1, prefs.fontSize, (v) => `${v}px`, (v) => {
      prefs.fontSize = v;
      sample?.renderer.setOptions({ fontSize: v });
    }, () => setFontSize(prefs.fontSize, true, false)),
    range('Bangla letter size', 0.8, 1.3, 0.05, prefs.bnScale, (v) => `${Math.round(v * 100)}%`, (v) => {
      prefs.bnScale = v;
      for (const s of sessions.values()) s.renderer.setOptions({ bnScale: v });
      sample?.renderer.setOptions({ bnScale: v });
    }, savePrefs),
    h('div', { class: 'setting' }, h('div', { class: 's-title' }, 'Cursor'), cursorSeg),
    toggle('Notify when a task finishes', 'When an agent answers while you’re elsewhere.', notifyWhenDone, (v) => {
      notifyWhenDone = v;
      bridge.setNotifyWhenDone(v);
    }),
    toggle('Animations', 'Fades, glides and slides.', prefs.animations, (v) => {
      prefs.animations = v;
      savePrefs();
      for (const s of sessions.values()) s.renderer.setOptions({ animate: v });
    }),
    toggle('Smart keyboard', 'Suggestions and Bangla typing, like in a chat app. Off: raw keys.', prefs.kbSmart, (v) => {
      prefs.kbSmart = v;
      savePrefs();
      settleComposing();
      bridge.setKeyboardSmart(v);
    }),
    // rarely needed: folded away
    h('details', { class: 'advanced' },
      h('summary', {}, h('span', {}, 'Advanced'), svg('chevron')),
      toggle('Claude Code full-screen view', 'Claude’s own scrolling view. Off: its replies scroll like the rest of the terminal — smoother on a phone. For new Claude sessions.', claudeFullscreen, (v) => {
        claudeFullscreen = v;
        bridge.setClaudeFullscreen(v);
      }),
      toggle('Keyboard compatibility mode', 'Smart keyboard off and keys type nothing or the wrong thing? Turn this on.', prefs.kbCompat, (v) => {
        prefs.kbCompat = v;
        savePrefs();
        bridge.setKeyboardCompat(v);
      }),
      h('div', { class: 'setting' },
        h('div', { class: 's-title' }, 'Antigravity Google account'),
        h('div', { class: 's-sub' }, 'Found automatically when agy starts.'),
        accountField),
      h('div', { class: 'setting' },
        h('div', { class: 's-title' }, 'Antigravity dashboard address'),
        urlField('remoteUrl')),
      h('div', { class: 'setting' },
        h('div', { class: 's-title' }, 'Claude Code dashboard address'),
        urlField('claudeUrl')),
      h('div', { class: 'setting' },
        h('div', { class: 's-title' }, 'claude.ai after a Google sign-in'),
        h('div', { class: 's-sub' }, 'Opens in Chrome for a week (Google sign-in needs it).'),
        resetBtn),
      h('div', { class: 'setting' },
        h('div', { class: 's-title' }, 'Something misbehaving?'),
        h('div', { class: 's-sub' }, 'Copy a log to paste into a chat.'),
        (() => {
          const b = h('button', { class: 'btn btn-secondary' }, svg('bug'), h('span', {}, 'Copy debug log'));
          b.onclick = () => copyDebugLog();
          return b;
        })()),
    ),
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
  $('#bg-btn').onclick = () => bridge.allowBackground();
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
    // text fields only (a switch or a slider in Settings doesn't need the keyboard)
    if (t.matches('textarea:not(#kbd), input:not([type=checkbox]):not([type=range]):not([type=radio])')) {
      settleComposing();
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
      /** close the keyboard like the key bar's keyboard key */
      hideKeys: () => hideKeyboard(),
      /** change the text size like a pinch does */
      zoom: (px: number) => setFontSize(px, true),
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
  bridge.setKeyboardSmart(prefs.kbSmart);
  // Nothing is shown until it's clear which screen comes first (the home screen, or the
  // terminal that was open), so the app doesn't flash one and then slide to the other.
  const listed = bridge.listSessions().catch(() => [] as Awaited<ReturnType<Bridge['listSessions']>>);
  // the home screen's state doesn't need the fonts: ask right away
  const state = bridge.getState().then(
    (st) => st,
    (): HostState => ({ host: bridge.host, ubuntu: 'error', message: 'Could not reach the app' }),
  );
  state.then((st) => {
    if (stateKnown) return; // onState was faster
    hostState = st;
    stateKnown = true;
    renderHome();
  });
  let savedUi = { active: '', screen: 'term' };
  try {
    savedUi = { ...savedUi, ...JSON.parse(localStorage.getItem('ui') ?? '{}') };
  } catch { /* none saved */ }
  // a terminal to come back to: it appears once restored (the home screen if that stalls —
  // or if the app doesn't answer at all)
  window.setTimeout(() => {
    if (document.body.dataset.screen === 'boot') enterHome();
  }, 2500);
  const [, first] = await Promise.all([state, listed]);
  // nothing to restore: the home screen right away (with sessions, after they're listed —
  // so its "Open sessions" don't pop in later and push everything down)
  if (first.length === 0 && document.body.dataset.screen === 'boot') enterHome();

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
  claudeFullscreen = await bridge.getClaudeFullscreen();
  accounts = await bridge.getAccounts();
  renderHome();

  // Re-attach to sessions that kept running while the UI was gone.
  try {
    // (the fonts took a while: the list may have changed — and a session opened from the
    // home screen meanwhile is already here)
    const userOpened = sessions.size > 0;
    const list = (await bridge.listSessions().catch(() => first)).filter((i) => !sessions.has(i.id));
    // forget saved terminal modes of sessions that no longer exist
    try {
      const ids = new Set([...list.map((i) => i.id), ...sessions.keys()]);
      for (const k of Object.keys(localStorage)) {
        const m = /^(modes|meta):(.*)$/.exec(k);
        if (m && !ids.has(m[2])) localStorage.removeItem(k);
      }
    } catch { /* storage unavailable */ }
    for (const info of list) {
      const s = addSession(info.id, info.kind);
      s.title = info.title || s.title;
      s.startDir = info.dir ?? '';
      if (!info.alive) s.alive = false;
      // replay the saved output at the size it was written for (background tabs too)
      if (info.cols && info.rows) s.notePtySize(info.cols, info.rows);
      s.beginReplay();
      bridge.attach(info.id); // its saved output, then onReplayed → restoreModes()
    }
    if (list.length && !userOpened) {
      // a tapped notification first; else the tab (and screen) that was open
      activate((pendingOpen && sessions.get(pendingOpen)) || sessions.get(savedUi.active) || [...sessions.values()].pop()!);
      if (!pendingOpen && savedUi.screen === 'home') enterHome();
    } else if (list.length) {
      // the user is already somewhere: the old sessions join as tabs behind it
      for (const x of sessions.values()) x.el.hidden = x !== active;
      renderTabs();
    }
    pendingOpen = '';
    restored = true;
    if (!sessions.size) await reportLostSessions();
  } catch { /* nothing to restore */ }
  if (document.body.dataset.screen === 'boot') enterHome();

  new ResizeObserver(() => {
    active?.renderer.schedule(); // re-pan right away; resize (if any) once things settle
    fitSoon();
  }).observe($('#sessions'));
  window.addEventListener('resize', fitSoon);
}

boot();
