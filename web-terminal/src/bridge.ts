// Bridge between the web UI and the host that owns the real PTYs.
//  - On the phone: the Android app injects `window.AndroidBridge` (Kotlin @JavascriptInterface)
//    and calls back into `window.__native.*`.
//  - In a desktop browser (development / tests): a WebSocket to dev/bridge-server.mjs.

export type SessionKind = 'ubuntu' | 'agy' | 'claude' | 'android';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  title: string;
  alive: boolean;
  /** The PTY's current size (Android host). */
  cols?: number;
  rows?: number;
  /** The account (profile) an agent session signs in with; '' the usual one. */
  profile?: string;
  /** The folder it was started in. */
  dir?: string;
}

export interface HostState {
  host: 'android' | 'dev';
  /** none = Ubuntu not installed yet, installing, ready, error */
  ubuntu: 'none' | 'installing' | 'ready' | 'error';
  progress?: number; // 0..1
  message?: string;
  /** Access to the phone's shared storage (/sdcard) has been granted. */
  storage?: boolean;
  /** Allowed to run in the background without battery restrictions. */
  background?: boolean;
  /** The home folder inside Ubuntu (shown as ~). */
  home?: string;
}

/** A folder's sub-folders (the folder picker). */
export interface DirListing {
  /** the folder, as a full path */
  path: string;
  dirs?: string[];
  /** notfound, or noaccess (e.g. the phone's storage before access is allowed) */
  error?: 'notfound' | 'noaccess';
}

export interface BridgeEvents {
  onOutput(id: string, data: Uint8Array): void;
  onExit(id: string, code: number): void;
  /** A re-attached session's saved output has all been delivered. */
  onReplayed(id: string): void;
  onState(state: HostState): void;
  /** Raw text from the native "terminal keyboard" (Android InputConnection). */
  onImeText(text: string): void;
  /** Smart keyboard: the word being composed, not sent yet ("" = none). */
  onImeComposing(text: string): void;
  /** Raw key from the native terminal keyboard: Android KeyEvent keyCode + modifiers. */
  onImeKey(keyCode: number, ctrl: boolean, alt: boolean, shift: boolean, ch?: string): void;
  onBack(): boolean;
  /** System bar / keyboard insets in CSS px; called every frame while the keyboard slides. */
  /** [floating]: a floating keyboard is open (it takes no room, its place is unknown). */
  onInsets(top: number, bottom: number, keyboard: boolean, settled: boolean, left?: number, right?: number, floating?: boolean): void;
  /** The app went to the background and dropped the terminal keyboard. */
  onKeyboardReleased(): void;
  /** Show this session (e.g. its "task finished" notification was tapped). */
  onOpenSession(id: string): void;
}

export interface Bridge {
  readonly host: 'android' | 'dev';
  /** [cwd]: the folder to start in (empty: home) */
  createSession(kind: SessionKind, cols: number, rows: number, cwd?: string, profile?: string): Promise<string>;
  /** The folders in a folder (full path or ~/…). */
  listDir(path: string): Promise<DirListing>;
  /** Makes a folder; "" when done, else why not. */
  makeDir(path: string): Promise<string>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  /** Ask the host to re-send the buffered output of a session (after the UI reloads). */
  attach(id: string): void;
  listSessions(): Promise<SessionInfo[]>;
  getState(): Promise<HostState>;
  installUbuntu(): void;
  openUrl(url: string): void;
  /**
   * The secret our xdg-open / setup-storage put in their escape sequences ('' = none, then
   * every request is trusted: the development bridge).
   */
  linkToken(): string;
  /** A remote dashboard in the app's own panel (title shown in its header). */
  openRemote(url: string, title: string): void;
  /** A file name tapped in the terminal: opens the first of these paths that exists ("" = done). */
  openFile(candidates: string[]): Promise<string>;
  copyText(text: string): void;
  readClipboard(): Promise<string>;
  /** The session on screen ('' = none): no "task finished" notification for it. */
  setActiveSession(id: string): void;
  /** What the UI calls a session (used in its notifications). */
  setSessionLabel(id: string, label: string): void;
  setNotifyWhenDone(on: boolean): void;
  getNotifyWhenDone(): Promise<boolean>;
  /** Claude Code's own full-screen view for new sessions. */
  setClaudeFullscreen(on: boolean): void;
  /** Antigravity approves every tool without asking (its --dangerously-skip-permissions). */
  setAgyApproveAll(on: boolean): void;
  getAgyApproveAll(): Promise<boolean>;
  getClaudeFullscreen(): Promise<boolean>;
  /** The shell prompt's look (written inside Ubuntu; the next prompt shows it). */
  setPromptStyle(style: string): void;
  getPromptStyle(): Promise<string>;
  /** The account (email) an agent is signed in with; "" if unknown. */
  accountEmail(kind: string, profile?: string): string;
  /** An agent's extra accounts ("profiles"): each keeps its own sign-in. */
  listProfiles(kind: string): Promise<{ name: string; email: string }[]>;
  /** '' when made, else why not. */
  createProfile(kind: string, name: string): Promise<string>;
  deleteProfile(kind: string, name: string): Promise<boolean>;
  /** The Google account the Antigravity CLI is signed in with (dashboards open with it). */
  setAntigravityAccount(email: string, profile?: string): void;
  getAccounts(): Promise<{ agy: string; claude: string }>;
  /** Dashboards that went to Chrome for a Google sign-in open in the app again. */
  resetDashboardChoices(): void;
  /** The app's colours, for native parts (remote panel, status bar icons). */
  setThemeColors(bg: string, text: string, muted: string, accent: string): void;
  /** true: soft keyboard sends raw keys to the terminal (no suggestions). false: normal IME (for the compose box). */
  setTerminalKeyboard(on: boolean): void;
  showKeyboard(): void;
  hideKeyboard(): void;
  /** Keyboard compatibility mode (for keyboards that misbehave with raw key input). */
  setKeyboardCompat(on: boolean): void;
  /** Smart keyboard: suggestions and Bangla transliteration (words are sent when committed). */
  setKeyboardSmart(on: boolean): void;
  /** The page sent the composing word itself: the keyboard should forget it. */
  discardComposing(): void;
  /** Ask for access to the phone's storage (like termux-setup-storage). */
  requestStorage(): void;
  /** Ask to run without battery restrictions (so Android doesn't stop the sessions). */
  allowBackground(): void;
  /** Sessions Android stopped while the app was gone; forget them once shown. */
  getLostSessions(): Promise<{ kind: SessionKind; label: string; dir?: string; profile?: string }[]>;
  forgetLostSessions(): void;
  exitApp(): void;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface AndroidBridgeApi {
  createSession(kind: string, cols: number, rows: number, cwd: string, profile: string): string;
  listDir(path: string): string;
  makeDir(path: string): string;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  closeSession(id: string): void;
  attach(id: string): void;
  listSessions(): string;
  getState(): string;
  installUbuntu(): void;
  openUrl(url: string): void;
  linkToken?(): string;
  openRemote(url: string, title?: string): void;
  openFile?(candidates: string): string;
  copyText(text: string): void;
  readClipboard(): string;
  setActiveSession?(id: string): void;
  setSessionLabel?(id: string, label: string): void;
  setNotifyWhenDone?(on: boolean): void;
  getNotifyWhenDone?(): boolean;
  setClaudeFullscreen?(on: boolean): void;
  setAgyApproveAll?(on: boolean): void;
  getAgyApproveAll?(): boolean;
  getClaudeFullscreen?(): boolean;
  setPromptStyle?(style: string): void;
  getPromptStyle?(): string;
  accountEmail?(kind: string, profile: string): string;
  listProfiles?(kind: string): string;
  createProfile?(kind: string, name: string): string;
  deleteProfile?(kind: string, name: string): boolean;
  setThemeColors?(bg: string, text: string, muted: string, accent: string): void;
  setAntigravityAccount?(email: string, profile: string): void;
  getAccounts?(): string;
  resetDashboardChoices?(): void;
  setTerminalKeyboard(on: boolean): void;
  showKeyboard(): void;
  hideKeyboard(): void;
  setKeyboardCompat(on: boolean): void;
  setKeyboardSmart?(on: boolean): void;
  discardComposing?(): void;
  requestStorage(): void;
  allowBackground?(): void;
  getLostSessions?(): string;
  forgetLostSessions?(): void;
  exitApp(): void;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidBridgeApi;
    __native?: Record<string, unknown>;
  }
}

class AndroidHostBridge implements Bridge {
  readonly host = 'android' as const;
  constructor(private api: AndroidBridgeApi) {}
  async createSession(kind: SessionKind, cols: number, rows: number, cwd = '', profile = '') {
    return this.api.createSession(kind, cols, rows, cwd, profile);
  }
  async listDir(path: string) { return JSON.parse(this.api.listDir(path)) as DirListing; }
  async makeDir(path: string) { return this.api.makeDir(path); }
  write(id: string, data: string) { this.api.write(id, data); }
  resize(id: string, cols: number, rows: number) { this.api.resize(id, cols, rows); }
  close(id: string) { this.api.closeSession(id); }
  attach(id: string) { this.api.attach(id); }
  async listSessions() { return JSON.parse(this.api.listSessions()) as SessionInfo[]; }
  async getState() { return JSON.parse(this.api.getState()) as HostState; }
  installUbuntu() { this.api.installUbuntu(); }
  openUrl(url: string) { this.api.openUrl(url); }
  private token?: string;
  linkToken() { return (this.token ??= this.api.linkToken?.() ?? ''); }
  openRemote(url: string, title: string) { this.api.openRemote(url, title); }
  async openFile(candidates: string[]) { return this.api.openFile?.(JSON.stringify(candidates)) ?? 'notfound'; }
  copyText(text: string) { this.api.copyText(text); }
  async readClipboard() { return this.api.readClipboard(); }
  setActiveSession(id: string) { this.api.setActiveSession?.(id); }
  setSessionLabel(id: string, label: string) { this.api.setSessionLabel?.(id, label); }
  setNotifyWhenDone(on: boolean) { this.api.setNotifyWhenDone?.(on); }
  async getNotifyWhenDone() { return this.api.getNotifyWhenDone?.() ?? true; }
  setClaudeFullscreen(on: boolean) { this.api.setClaudeFullscreen?.(on); }
  setAgyApproveAll(on: boolean) { this.api.setAgyApproveAll?.(on); }
  async getAgyApproveAll() { return this.api.getAgyApproveAll?.() ?? false; }
  async getClaudeFullscreen() { return this.api.getClaudeFullscreen?.() ?? false; }
  setPromptStyle(style: string) { this.api.setPromptStyle?.(style); }
  async getPromptStyle() { return this.api.getPromptStyle?.() ?? 'powerline'; }
  accountEmail(kind: string, profile = '') {
    try {
      return this.api.accountEmail?.(kind, profile) ?? '';
    } catch {
      return '';
    }
  }
  setThemeColors(bg: string, text: string, muted: string, accent: string) { this.api.setThemeColors?.(bg, text, muted, accent); }
  setAntigravityAccount(email: string, profile = '') { this.api.setAntigravityAccount?.(email, profile); }
  async listProfiles(kind: string) {
    try {
      return JSON.parse(this.api.listProfiles?.(kind) ?? '[]') as { name: string; email: string }[];
    } catch {
      return [];
    }
  }
  async createProfile(kind: string, name: string) { return this.api.createProfile?.(kind, name) ?? 'Not available'; }
  async deleteProfile(kind: string, name: string) { return this.api.deleteProfile?.(kind, name) ?? false; }
  async getAccounts() {
    try {
      return JSON.parse(this.api.getAccounts?.() ?? '{}') as { agy: string; claude: string };
    } catch {
      return { agy: '', claude: '' };
    }
  }
  resetDashboardChoices() { this.api.resetDashboardChoices?.(); }
  setTerminalKeyboard(on: boolean) { this.api.setTerminalKeyboard(on); }
  showKeyboard() { this.api.showKeyboard(); }
  hideKeyboard() { this.api.hideKeyboard(); }
  setKeyboardCompat(on: boolean) { this.api.setKeyboardCompat(on); }
  setKeyboardSmart(on: boolean) { this.api.setKeyboardSmart?.(on); }
  discardComposing() { this.api.discardComposing?.(); }
  requestStorage() { this.api.requestStorage(); }
  allowBackground() { this.api.allowBackground?.(); }
  async getLostSessions() {
    try {
      return JSON.parse(this.api.getLostSessions?.() ?? '[]') as { kind: SessionKind; label: string; dir?: string; profile?: string }[];
    } catch {
      return [];
    }
  }
  forgetLostSessions() { this.api.forgetLostSessions?.(); }
  exitApp() { this.api.exitApp(); }
}

/** Development bridge: talks JSON over a WebSocket to dev/bridge-server.mjs (real bash via node-pty). */
class DevBridge implements Bridge {
  readonly host = 'dev' as const;
  private ws: WebSocket;
  private ready: Promise<void>;
  private seq = 0;
  private pending = new Map<number, (v: unknown) => void>();

  constructor(url: string, private events: BridgeEvents) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('dev bridge unavailable')), { once: true });
    });
    this.ready.catch(() => console.warn('dev bridge unavailable'));
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.reply !== undefined) {
        this.pending.get(msg.reply)?.(msg.value);
        this.pending.delete(msg.reply);
      } else if (msg.type === 'output') {
        this.events.onOutput(msg.id, b64ToBytes(msg.data));
      } else if (msg.type === 'exit') {
        this.events.onExit(msg.id, msg.code);
      } else if (msg.type === 'replayed') {
        this.events.onReplayed(msg.id);
      } else if (msg.type === 'state') {
        this.events.onState(msg.state);
      }
    });
  }
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    const id = ++this.seq;
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void);
      this.ws.send(JSON.stringify({ call: id, method, args }));
    });
  }
  private send(method: string, ...args: unknown[]) {
    this.ready.then(() => this.ws.send(JSON.stringify({ method, args }))).catch(() => {});
  }
  createSession(kind: SessionKind, cols: number, rows: number, cwd = '') { return this.call<string>('createSession', kind, cols, rows, cwd); }
  // (accounts in the browser: names only, kept in the page's storage — for trying the UI)
  private profiles(kind: string): string[] {
    try { return JSON.parse(localStorage.getItem(`profiles:${kind}`) ?? '[]') as string[]; } catch { return []; }
  }
  async listProfiles(kind: string) { return this.profiles(kind).map((name) => ({ name, email: '' })); }
  async createProfile(kind: string, name: string) {
    const list = this.profiles(kind);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(name)) return 'Use letters, digits and - (up to 20)';
    if (list.includes(name)) return `There's already an account called ${name}`;
    try { localStorage.setItem(`profiles:${kind}`, JSON.stringify([...list, name])); } catch { /* storage unavailable */ }
    return '';
  }
  async deleteProfile(kind: string, name: string) {
    try { localStorage.setItem(`profiles:${kind}`, JSON.stringify(this.profiles(kind).filter((n) => n !== name))); } catch { /* storage unavailable */ }
    return true;
  }
  listDir(path: string) { return this.call<DirListing>('listDir', path); }
  makeDir(path: string) { return this.call<string>('makeDir', path); }
  write(id: string, data: string) { this.send('write', id, data); }
  resize(id: string, cols: number, rows: number) { this.send('resize', id, cols, rows); }
  close(id: string) { this.send('close', id); }
  attach(id: string) { this.send('attach', id); }
  listSessions() { return this.call<SessionInfo[]>('listSessions'); }
  getState() { return this.call<HostState>('getState'); }
  installUbuntu() { this.send('installUbuntu'); }
  openUrl(url: string) { window.open(url, '_blank'); }
  /** tests can set one with ?linktoken= */
  linkToken() { return new URLSearchParams(location.search).get('linktoken') ?? ''; }
  openRemote(url: string) { window.open(url, '_blank'); }
  /** (the browser can't show it: the path found is kept for tests) */
  async openFile(candidates: string[]) {
    const r = await this.call<string>('openFile', candidates);
    if (r.startsWith('/')) {
      (window as unknown as { __lastOpened: string }).__lastOpened = r;
      return '';
    }
    return r;
  }
  copyText(text: string) { navigator.clipboard?.writeText(text).catch(() => {}); }
  async readClipboard() { try { return await navigator.clipboard.readText(); } catch { return ''; } }
  setActiveSession() {}
  setSessionLabel() {}
  setNotifyWhenDone() {}
  async getNotifyWhenDone() { return true; }
  setClaudeFullscreen() {}
  setAgyApproveAll() {}
  async getAgyApproveAll() { return false; }
  async getClaudeFullscreen() { return false; }
  setPromptStyle(style: string) {
    try { localStorage.setItem('promptStyle', style); } catch { /* storage unavailable */ }
  }
  async getPromptStyle() {
    try { return localStorage.getItem('promptStyle') ?? 'powerline'; } catch { return 'powerline'; }
  }
  accountEmail() {
    return ''; // (no agent accounts in the browser)
  }

  setThemeColors() {}
  setAntigravityAccount() {}
  async getAccounts() { return { agy: '', claude: '' }; }
  resetDashboardChoices() {}
  setTerminalKeyboard() {}
  showKeyboard() {}
  hideKeyboard() {}
  setKeyboardCompat() {}
  setKeyboardSmart() {}
  discardComposing() {}
  requestStorage() {}
  allowBackground() {}
  /** tests: ?lost=ubuntu,claude */
  async getLostSessions() {
    const q = new URLSearchParams(location.search).get('lost');
    return q ? q.split(',').map((kind) => ({ kind: kind as SessionKind, label: '' })) : [];
  }
  forgetLostSessions() {}
  exitApp() {}
}

export function createBridge(events: BridgeEvents): Bridge {
  // Native → JS entry points. Kotlin calls e.g. __native.onOutput("id", "<base64>").
  window.__native = {
    onOutput: (id: string, b64: string) => events.onOutput(id, b64ToBytes(b64)),
    onExit: (id: string, code: number) => events.onExit(id, code),
    onReplayed: (id: string) => events.onReplayed(id),
    onState: (json: string) => events.onState(JSON.parse(json)),
    onImeText: (text: string) => events.onImeText(text),
    onImeComposing: (text: string) => events.onImeComposing(text),
    onImeKey: (k: number, c: boolean, a: boolean, s: boolean, ch?: string) => events.onImeKey(k, c, a, s, ch),
    onBack: () => events.onBack(),
    onInsets: (t: number, b: number, k: boolean, s: boolean, l?: number, r?: number, f?: boolean) => events.onInsets(t, b, k, s, l, r, f),
    onKeyboardReleased: () => events.onKeyboardReleased(),
    onOpenSession: (id: string) => events.onOpenSession(id),
  };
  if (window.AndroidBridge) return new AndroidHostBridge(window.AndroidBridge);
  const port = new URLSearchParams(location.search).get('bridge') ?? '7681';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new DevBridge(`${proto}://${location.hostname || '127.0.0.1'}:${port}/bridge`, events);
}
