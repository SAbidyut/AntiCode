// One terminal tab: headless xterm (VT parser + buffer) + BanglaRenderer + reader view + input.

import { Terminal } from '@xterm/headless';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import type { Bridge, SessionKind } from '../bridge';
import { BanglaRenderer, type RendererOptions, type TermTheme } from './renderer';

const RAW_KEEP = 64 * 1024;

/** '#14161f' → 'rgb:1414/1616/1f1f' (the format xterm uses in colour reports). */
function xtermRgb(hex: string): string {
  const h = hex.replace('#', '');
  const part = (i: number) => h.slice(i, i + 2).repeat(2);
  return `rgb:${part(0)}/${part(2)}/${part(4)}`;
}

const URL_RE = /https?:\/\/[^\s'"<>`]+[^\s'"<>`.,;:)\]}]/g;

export class TerminalSession {
  readonly term: Terminal;
  readonly renderer: BanglaRenderer;
  readonly el: HTMLDivElement;
  readonly readerEl: HTMLDivElement;
  title: string;
  alive = true;
  private readerOpen = false;
  private readerFrame = 0;
  private resizeTimer = 0;
  private ptyCols = 0;
  private ptyRows = 0;
  private raw: Uint8Array[] = [];
  private rawSize = 0;
  onTitle?: () => void;
  onActivity?: () => void;

  constructor(
    private bridge: Bridge,
    readonly id: string,
    readonly kind: SessionKind,
    opts: RendererOptions,
  ) {
    this.title = kind === 'agy' ? 'Antigravity' : kind === 'ubuntu' ? 'Ubuntu' : 'Android shell';
    this.term = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    this.term.loadAddon(new UnicodeGraphemesAddon() as never);
    this.renderer = new BanglaRenderer(this.term, opts);

    this.el = document.createElement('div');
    this.el.className = 'session';
    this.readerEl = document.createElement('div');
    this.readerEl.className = 'reader';
    this.readerEl.hidden = true;
    // "jump to the bottom" button, shown while scrolled back in history
    const fab = document.createElement('button');
    fab.className = 'fab-bottom hidden';
    fab.setAttribute('aria-label', 'Scroll to bottom');
    fab.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
    fab.addEventListener('click', () => this.scrollToBottom());
    this.renderer.onScrolled = (up) => fab.classList.toggle('hidden', !up);
    this.el.append(this.renderer.el, this.readerEl, fab);

    // Replies the terminal generates itself (cursor position reports, device attributes…)
    this.term.onData((d) => this.bridge.write(this.id, d));
    this.term.onBinary((d) => this.bridge.write(this.id, d));
    this.term.onWriteParsed(() => {
      this.renderer.schedule();
      if (this.readerOpen) this.scheduleReader();
      this.onActivity?.();
    });
    this.term.onTitleChange((t) => {
      if (t.trim()) {
        this.title = t.trim().slice(0, 40);
        this.onTitle?.();
      }
    });
    // Track cursor visibility (DECTCEM, CSI ? 25 h/l); headless xterm doesn't expose it.
    const track = (show: boolean) => (params: (number | number[])[]) => {
      if (params.some((p) => p === 25)) {
        this.renderer.cursorVisible = show;
        this.renderer.schedule();
      }
      return false; // let xterm handle it too
    };
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));
    // OSC 7770 ; open ; <url>  — emitted by our xdg-open shim inside Ubuntu.
    this.term.parser.registerOscHandler(7770, (data) => {
      const [cmd, ...rest] = data.split(';');
      if (cmd === 'open' && rest.length) this.bridge.openUrl(rest.join(';'));
      else if (cmd === 'storage') this.bridge.requestStorage(); // `setup-storage` inside Ubuntu
      return true;
    });
    // Colour queries (OSC 10/11/12 ; ?) — TUIs like the Antigravity CLI ask for the
    // background colour to pick a light or dark palette.
    for (const [osc, pick] of [
      [10, (t: TermTheme) => t.foreground],
      [11, (t: TermTheme) => t.background],
      [12, (t: TermTheme) => t.cursor],
    ] as const) {
      this.term.parser.registerOscHandler(osc, (data) => {
        if (data !== '?') return false;
        this.bridge.write(this.id, `\x1b]${osc};${xtermRgb(pick(this.renderer.options.theme))}\x1b\\`);
        return true;
      });
    }
    // XTVERSION (CSI > q): name the terminal.
    this.term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => {
      this.bridge.write(this.id, '\x1bP>|AgyTerminal 0.2\x1b\\');
      return true;
    });
    // OSC 52 clipboard copy (used by many TUIs).
    this.term.parser.registerOscHandler(52, (data) => {
      const b64 = data.split(';')[1];
      if (b64 && b64 !== '?') {
        try {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          this.bridge.copyText(new TextDecoder().decode(bytes));
        } catch { /* ignore */ }
      }
      return true;
    });
  }

  write(data: Uint8Array) {
    this.raw.push(data);
    this.rawSize += data.length;
    while (this.rawSize > RAW_KEEP && this.raw.length > 1) this.rawSize -= this.raw.shift()!.length;
    this.term.write(data);
  }

  /** Diagnostics for bug reports: terminal state + the last output with escapes made visible. */
  debugDump(): string {
    const m = this.term.modes;
    const buf = this.term.buffer.active;
    const all = new Uint8Array(this.rawSize);
    let off = 0;
    for (const c of this.raw) {
      all.set(c, off);
      off += c.length;
    }
    const text = new TextDecoder().decode(all).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) =>
      c === '\x1b' ? '⎋' : `<${c.charCodeAt(0).toString(16).padStart(2, '0')}>`,
    );
    return [
      `session ${this.id} kind=${this.kind} alive=${this.alive} size=${this.term.cols}x${this.term.rows}`,
      `buffer=${buf.type} cursor=${buf.cursorX},${buf.cursorY} baseY=${buf.baseY}`,
      `modes: appCursor=${m.applicationCursorKeysMode} bracketedPaste=${m.bracketedPasteMode} mouse=${m.mouseTrackingMode} sync=${m.synchronizedOutputMode}`,
      `--- last ${this.rawSize} bytes of output ---`,
      text.slice(-RAW_KEEP),
    ].join('\n');
  }

  /** User input → PTY. Jumps back to the live view. */
  input(data: string) {
    if (!this.alive) return;
    if (this.renderer.scrollOffset) {
      this.renderer.scrollOffset = 0;
      this.renderer.schedule();
    }
    this.bridge.write(this.id, data);
  }

  /** Text from the compose box: bracketed paste for multi-line text, then Enter. */
  sendLine(text: string, enter = true) {
    let payload = text.replace(/\r?\n/g, '\r');
    if (text.includes('\n') && this.term.modes.bracketedPasteMode) {
      payload = `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`;
    }
    this.input(payload + (enter ? '\r' : ''));
  }

  paste(text: string) {
    const t = text.replace(/\r?\n/g, '\r');
    this.input(this.term.modes.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t);
  }

  get appCursor() {
    return this.term.modes.applicationCursorKeysMode;
  }

  get mouseTracking() {
    return this.term.modes.mouseTrackingMode !== 'none';
  }

  /** The PTY was created with this size (0 = unknown, e.g. a session restored after a reload). */
  notePtySize(cols: number, rows: number) {
    this.ptyCols = cols;
    this.ptyRows = rows;
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  /** Fit the terminal into the element's current size and tell the PTY if it changed. */
  fit() {
    const box = this.el.getBoundingClientRect();
    if (box.width < 50 || box.height < 50) return;
    const { cols, rows } = this.renderer.fit(box.width, box.height);
    if (cols !== this.term.cols || rows !== this.term.rows) {
      this.term.resize(cols, rows);
      this.renderer.schedule();
    }
    // Compare with what the PTY has, not with xterm: they can differ (restored sessions,
    // a session created before layout was final).
    if (cols === this.ptyCols && rows === this.ptyRows) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.ptyCols = cols;
      this.ptyRows = rows;
      this.bridge.resize(this.id, cols, rows);
    }, 60);
  }

  setFocused(f: boolean) {
    this.renderer.focused = f;
    this.renderer.schedule();
  }

  /** Scroll by n lines (positive = back in history). In TUIs with mouse mode, send wheel events instead. */
  scrollLines(n: number, clientX?: number, clientY?: number) {
    if (n === 0) return;
    if (this.term.buffer.active.type === 'alternate') {
      if (this.mouseTracking && clientX !== undefined && clientY !== undefined) {
        const { x, y } = this.renderer.cellAt(clientX, clientY);
        const btn = n > 0 ? 64 : 65;
        this.bridge.write(this.id, `\x1b[<${btn};${x + 1};${y + 1}M`.repeat(Math.min(Math.abs(n), 10)));
      } else {
        // no scrollback in full-screen apps: arrow keys are the usual fallback
        const seq = n > 0 ? (this.appCursor ? '\x1bOA' : '\x1b[A') : this.appCursor ? '\x1bOB' : '\x1b[B';
        this.bridge.write(this.id, seq.repeat(Math.min(Math.abs(n), 10)));
      }
      return;
    }
    const max = this.term.buffer.active.baseY;
    this.renderer.scrollOffset = Math.max(0, Math.min(max, this.renderer.scrollOffset + n));
    this.renderer.schedule();
  }

  scrollToBottom() {
    this.renderer.scrollOffset = 0;
    this.renderer.schedule();
  }

  /** Send a mouse click (only when the program enabled mouse tracking). */
  click(clientX: number, clientY: number): boolean {
    if (!this.mouseTracking) return false;
    const { x, y } = this.renderer.cellAt(clientX, clientY);
    this.bridge.write(this.id, `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    return true;
  }

  /** If a URL is under the point, return it. */
  urlAt(clientX: number, clientY: number): string | null {
    const { x, y } = this.renderer.cellAt(clientX, clientY);
    const buf = this.term.buffer.active;
    let start = this.renderer.bufferLineAt(y);
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let text = '';
    let offset = -1;
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line || (i > start && !line.isWrapped)) break;
      if (i === this.renderer.bufferLineAt(y)) offset = text.length + x;
      text += line.translateToString(false);
    }
    for (const m of text.matchAll(URL_RE)) {
      if (offset >= m.index! && offset <= m.index! + m[0].length) return m[0];
    }
    return null;
  }

  // ---------------- Reader view ----------------

  get isReaderOpen() {
    return this.readerOpen;
  }

  toggleReader(open = !this.readerOpen) {
    this.readerOpen = open;
    this.readerEl.hidden = !open;
    this.renderer.el.hidden = open;
    if (open) this.renderReader(true);
  }

  private scheduleReader() {
    if (this.readerFrame) return;
    this.readerFrame = window.setTimeout(() => {
      this.readerFrame = 0;
      this.renderReader(false);
    }, 120);
  }

  /** All logical lines (wrapped lines joined) of the active buffer, as plain text. */
  logicalLines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const s = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += s;
      else out.push(s);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  private renderReader(forceBottom: boolean) {
    const el = this.readerEl;
    const atBottom = forceBottom || el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    const lines = this.logicalLines();
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const div = document.createElement('div');
      div.className = 'rl';
      if (!l.trim()) {
        div.innerHTML = '&nbsp;';
      } else {
        let last = 0;
        for (const m of l.matchAll(URL_RE)) {
          div.append(l.slice(last, m.index));
          const a = document.createElement('a');
          a.textContent = m[0];
          a.href = m[0];
          a.onclick = (e) => {
            e.preventDefault();
            this.bridge.openUrl(m[0]);
          };
          div.append(a);
          last = m.index! + m[0].length;
        }
        div.append(l.slice(last));
      }
      frag.append(div);
    }
    el.replaceChildren(frag);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  /** Plain text of the whole buffer (for "copy all"). */
  allText(): string {
    return this.logicalLines().join('\n');
  }

  markExited(code: number) {
    this.alive = false;
    this.term.write(`\r\n\x1b[2m[process exited with code ${code} — close the tab with ×]\x1b[0m\r\n`);
  }

  dispose() {
    this.term.dispose();
    this.el.remove();
  }
}
