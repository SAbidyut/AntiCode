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
}

export interface HostState {
  host: 'android' | 'dev';
  /** none = Ubuntu not installed yet, installing, ready, error */
  ubuntu: 'none' | 'installing' | 'ready' | 'error';
  progress?: number; // 0..1
  message?: string;
  /** Access to the phone's shared storage (/sdcard) has been granted. */
  storage?: boolean;
}

export interface BridgeEvents {
  onOutput(id: string, data: Uint8Array): void;
  onExit(id: string, code: number): void;
  onState(state: HostState): void;
  /** Raw text from the native "terminal keyboard" (Android InputConnection). */
  onImeText(text: string): void;
  /** Raw key from the native terminal keyboard: Android KeyEvent keyCode + modifiers. */
  onImeKey(keyCode: number, ctrl: boolean, alt: boolean, shift: boolean): void;
  onBack(): boolean;
  /** System bar / keyboard insets in CSS px; called every frame while the keyboard slides. */
  onInsets(top: number, bottom: number, keyboard: boolean, settled: boolean): void;
}

export interface Bridge {
  readonly host: 'android' | 'dev';
  createSession(kind: SessionKind, cols: number, rows: number): Promise<string>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  /** Ask the host to re-send the buffered output of a session (after the UI reloads). */
  attach(id: string): void;
  listSessions(): Promise<SessionInfo[]>;
  getState(): Promise<HostState>;
  installUbuntu(): void;
  openUrl(url: string): void;
  openRemote(url: string): void;
  copyText(text: string): void;
  readClipboard(): Promise<string>;
  /** true: soft keyboard sends raw keys to the terminal (no suggestions). false: normal IME (for the compose box). */
  setTerminalKeyboard(on: boolean): void;
  showKeyboard(): void;
  hideKeyboard(): void;
  /** Keyboard compatibility mode (for keyboards that misbehave with raw key input). */
  setKeyboardCompat(on: boolean): void;
  /** Ask for access to the phone's storage (like termux-setup-storage). */
  requestStorage(): void;
  exitApp(): void;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface AndroidBridgeApi {
  createSession(kind: string, cols: number, rows: number): string;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  closeSession(id: string): void;
  attach(id: string): void;
  listSessions(): string;
  getState(): string;
  installUbuntu(): void;
  openUrl(url: string): void;
  openRemote(url: string): void;
  copyText(text: string): void;
  readClipboard(): string;
  setTerminalKeyboard(on: boolean): void;
  showKeyboard(): void;
  hideKeyboard(): void;
  setKeyboardCompat(on: boolean): void;
  requestStorage(): void;
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
  async createSession(kind: SessionKind, cols: number, rows: number) {
    return this.api.createSession(kind, cols, rows);
  }
  write(id: string, data: string) { this.api.write(id, data); }
  resize(id: string, cols: number, rows: number) { this.api.resize(id, cols, rows); }
  close(id: string) { this.api.closeSession(id); }
  attach(id: string) { this.api.attach(id); }
  async listSessions() { return JSON.parse(this.api.listSessions()) as SessionInfo[]; }
  async getState() { return JSON.parse(this.api.getState()) as HostState; }
  installUbuntu() { this.api.installUbuntu(); }
  openUrl(url: string) { this.api.openUrl(url); }
  openRemote(url: string) { this.api.openRemote(url); }
  copyText(text: string) { this.api.copyText(text); }
  async readClipboard() { return this.api.readClipboard(); }
  setTerminalKeyboard(on: boolean) { this.api.setTerminalKeyboard(on); }
  showKeyboard() { this.api.showKeyboard(); }
  hideKeyboard() { this.api.hideKeyboard(); }
  setKeyboardCompat(on: boolean) { this.api.setKeyboardCompat(on); }
  requestStorage() { this.api.requestStorage(); }
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
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.reply !== undefined) {
        this.pending.get(msg.reply)?.(msg.value);
        this.pending.delete(msg.reply);
      } else if (msg.type === 'output') {
        this.events.onOutput(msg.id, b64ToBytes(msg.data));
      } else if (msg.type === 'exit') {
        this.events.onExit(msg.id, msg.code);
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
    this.ready.then(() => this.ws.send(JSON.stringify({ method, args })));
  }
  createSession(kind: SessionKind, cols: number, rows: number) { return this.call<string>('createSession', kind, cols, rows); }
  write(id: string, data: string) { this.send('write', id, data); }
  resize(id: string, cols: number, rows: number) { this.send('resize', id, cols, rows); }
  close(id: string) { this.send('close', id); }
  attach(id: string) { this.send('attach', id); }
  listSessions() { return this.call<SessionInfo[]>('listSessions'); }
  getState() { return this.call<HostState>('getState'); }
  installUbuntu() { this.send('installUbuntu'); }
  openUrl(url: string) { window.open(url, '_blank'); }
  openRemote(url: string) { window.open(url, '_blank'); }
  copyText(text: string) { navigator.clipboard?.writeText(text).catch(() => {}); }
  async readClipboard() { try { return await navigator.clipboard.readText(); } catch { return ''; } }
  setTerminalKeyboard() {}
  showKeyboard() {}
  hideKeyboard() {}
  setKeyboardCompat() {}
  requestStorage() {}
  exitApp() {}
}

export function createBridge(events: BridgeEvents): Bridge {
  // Native → JS entry points. Kotlin calls e.g. __native.onOutput("id", "<base64>").
  window.__native = {
    onOutput: (id: string, b64: string) => events.onOutput(id, b64ToBytes(b64)),
    onExit: (id: string, code: number) => events.onExit(id, code),
    onState: (json: string) => events.onState(JSON.parse(json)),
    onImeText: (text: string) => events.onImeText(text),
    onImeKey: (k: number, c: boolean, a: boolean, s: boolean) => events.onImeKey(k, c, a, s),
    onBack: () => events.onBack(),
    onInsets: (t: number, b: number, k: boolean, s: boolean) => events.onInsets(t, b, k, s),
  };
  if (window.AndroidBridge) return new AndroidHostBridge(window.AndroidBridge);
  const port = new URLSearchParams(location.search).get('bridge') ?? '7681';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new DevBridge(`${proto}://${location.hostname || '127.0.0.1'}:${port}/bridge`, events);
}
