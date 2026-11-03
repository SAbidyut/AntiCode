// One terminal tab: headless xterm (VT parser + buffer) + BanglaRenderer + reader view + input.

import { Terminal } from '@xterm/headless';
import { installWidths } from './conjuncts';
import type { Bridge, SessionKind } from '../bridge';
import { BanglaRenderer, type RendererOptions, type TermTheme } from './renderer';
import { LineEditor, type Pos } from './lineedit';

const RAW_KEEP = 64 * 1024;

/** '#14161f' → 'rgb:1414/1616/1f1f' (the format xterm uses in colour reports). */
function xtermRgb(hex: string): string {
  const h = hex.replace('#', '');
  const part = (i: number) => h.slice(i, i + 2).repeat(2);
  return `rgb:${part(0)}/${part(2)}/${part(4)}`;
}

const URL_RE = /https?:\/\/[^\s'"<>`]+[^\s'"<>`.,;:)\]}]/g;
/** A file name or path with a type worth opening (a page or PDF an agent made, a picture …). */
const FILE_EXT = 'html?|xhtml|pdf|svg|png|jpe?g|gif|webp|bmp|txt|md|markdown|csv|json|log|xml|ya?ml|docx?|xlsx?|pptx?|odt|ods|odp|epub|mp4|webm|mkv|mov|mp3|wav|ogg|m4a|flac|zip';
const FILE_RE = new RegExp(
  String.raw`(?:file:\/\/)?[^\s'"<>\x60|*?()\[\]{}:,;]*[^\s'"<>\x60|*?()\[\]{}:,;/.]\.(?:${FILE_EXT})(?![\p{L}\p{N}_-])`,
  'giu',
);

export class TerminalSession {
  /** Height (CSS px) currently covered by the on-screen keyboard; set by the app. */
  static keyboardInset = 0;

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
  /** A restored session's saved output is being replayed (see beginReplay). */
  private replaying = false;
  /** Mouse reports in SGR form (CSI ? 1006 h); otherwise the classic CSI M bytes. */
  private sgrMouse = false;
  /** A program asked to open a link; untrusted = not from our xdg-open (ask first). */
  onLink?: (url: string, trusted: boolean) => void;
  /** Count conjuncts the way a running program does (true) or the shell does (false). */
  private setProgramWidths: (joined: boolean) => void;
  /** Where the shell is (OSC 7 from its prompt): a tapped file name is looked for there. */
  cwd = '';
  /** The folder the session was started in. */
  startDir = '';
  /** The line being typed as a text field: tap to move the cursor, select, copy, cut. */
  readonly edit: LineEditor;

  constructor(
    private bridge: Bridge,
    readonly id: string,
    readonly kind: SessionKind,
    opts: RendererOptions,
  ) {
    this.title = { agy: 'Antigravity', claude: 'Claude Code', ubuntu: 'Ubuntu', android: 'Android shell' }[kind] ?? 'Terminal';
    this.term = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    // conjuncts: the shell (and Claude Code) count them by letters, the Antigravity CLI as one
    // character (see conjuncts.ts); its session starts with it running
    this.setProgramWidths = installWidths(this.term);
    this.setProgramWidths(kind === 'agy');
    this.renderer = new BanglaRenderer(this.term, opts);
    this.renderer.anchorBottom = kind === 'agy' || kind === 'claude';
    this.edit = new LineEditor(this.term, (d) => this.sendKeys(d), () => this.renderer.lastOutput);
    this.edit.onSelection = (sel, area) => {
      this.edit.onChanged?.(sel);
      if (!sel || !area) return this.renderer.setSelection(null);
      const ranges = [];
      for (let line = sel.a.line; line <= sel.b.line; line++) {
        const i = line - area.top;
        ranges.push({ line, x0: line === sel.a.line ? sel.a.x : area.start[i], x1: line === sel.b.line ? sel.b.x : area.end[i] });
      }
      this.renderer.setSelection({ ranges, a: sel.a, b: sel.b });
    };
    this.loadMeta();

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
    this.term.onData((d) => this.reply(d));
    this.term.onBinary((d) => this.reply(d));
    this.term.onWriteParsed(() => {
      this.saveModes();
      this.renderer.lastOutput = performance.now();
      this.renderer.scheduleEager();
      this.edit.check();
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
      if (params.some((p) => p === 1006)) this.sgrMouse = show; // how mouse reports look
      return false; // let xterm handle it too
    };
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));
    // `reset` (RIS, ESC c) and soft reset (DECSTR, CSI ! p) show the cursor again; only
    // the full reset clears the screen (and with it the prompt clocks)
    const showAgain = (full: boolean) => () => {
      if (full) {
        this.renderer.clearLabels();
        this.sgrMouse = false;
      }
      this.renderer.cursorVisible = true;
      this.renderer.schedule();
      return false;
    };
    this.term.parser.registerEscHandler({ final: 'c' }, showAgain(true));
    this.term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, showAgain(false));
    // OSC 7 ; file://host/path — the shell's folder (our prompt sends it)
    this.term.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (m) {
        try {
          this.cwd = decodeURIComponent(m[1]);
        } catch {
          this.cwd = m[1];
        }
      }
      return true;
    });
    // OSC 7770 ; <cmd> ; …  — from our scripts inside Ubuntu.
    this.term.parser.registerOscHandler(7770, (data) => {
      const [cmd, ...rest] = data.split(';');
      // xdg-open and setup-storage sign their requests: open;<token>;<url>. The same text
      // printed by anything else (`cat` of a downloaded file, curl output …) is not trusted.
      const token = this.bridge.linkToken();
      const signed = rest.length > 0 && rest[0] === token;
      const args = signed ? rest.slice(1) : rest;
      const trusted = signed || !token;
      // (not again while a restored session's old output is replayed)
      if (cmd === 'open' && args.length && !this.replaying) this.onLink?.(args.join(';'), trusted);
      else if (cmd === 'rprompt') this.renderer.setRightLabel(rest.join(';')); // the prompt's clock
      // a shell prompt: no agent is on screen any more → ordinary terminal layout
      else if (cmd === 'done') {
        this.renderer.anchorBottom = false;
        this.setProgramWidths(false); // the shell's prompt: its way of counting
        this.edit.atPrompt = true;
      } else if (cmd === 'exec') {
        this.setProgramWidths(false); // a command starts (by letters…)
        this.edit.atPrompt = false;
      }
      else if (cmd === 'widths') this.setProgramWidths(rest[0] === 'joined'); // …unless it's agy
      else if (cmd === 'storage' && trusted && !this.replaying) this.bridge.requestStorage(); // `setup-storage`
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
        this.reply(`\x1b]${osc};${xtermRgb(pick(this.renderer.options.theme))}\x1b\\`);
        return true;
      });
    }
    // DECRQM for mode 2027 (grapheme clustering): this terminal always joins a letter and
    // its vowel signs into one cell (Unicode graphemes). Say so — "permanently set" — so
    // TUIs like the Antigravity CLI measure Bangla the same way; otherwise they count every
    // vowel sign as a cell of its own and the text falls apart (◌া ◌ি, broken lines).
    this.term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
      if (params[0] !== 2027) return false; // other modes: xterm answers
      this.reply('\x1b[?2027;3$y');
      return true;
    });
    // XTVERSION (CSI > q): name the terminal.
    this.term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => {
      this.reply('\x1bP>|AgyTerminal 0.2\x1b\\');
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

  /** The Antigravity CLI shows its account in the header: "you@gmail.com (Google AI Pro)". */
  onAccount?: (email: string) => void;
  private accountSeen = false;
  private accountDecoder = new TextDecoder();
  private accountTail = '';
  private accountScanned = 0;
  private spotAccount(data: Uint8Array) {
    // only the CLI's startup screen (the header), not whatever the agent prints later
    this.accountScanned += data.length;
    if (this.accountScanned > 64 * 1024) {
      this.accountSeen = true;
      return;
    }
    const joined = this.accountTail + this.accountDecoder.decode(data, { stream: true });
    const text = joined.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const m = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*\(Google/.exec(text);
    if (m) {
      this.accountSeen = true;
      this.onAccount?.(m[1]);
    }
    this.accountTail = joined.slice(-200); // raw: an escape split across chunks still strips
  }

  write(data: Uint8Array) {
    if (this.kind === 'agy' && !this.accountSeen) this.spotAccount(data);
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

  // ---- what is this session about? (shown in tabs and the home list) ----
  /** The first prompt typed in an agent session, or the last command in a shell. */
  task = '';
  /** A name the user gave it (long-press → Rename). */
  customName = '';
  onMeta?: () => void;
  private lineBuf = '';

  get kindLabel() {
    return { agy: 'Antigravity', claude: 'Claude Code', ubuntu: 'Ubuntu', android: 'Android shell' }[this.kind] ?? 'Terminal';
  }
  /** The program's own window title when it describes the work (Claude Code: "✳ Fix login"). */
  get topic(): string {
    const t = this.title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (!t || t === this.kindLabel || /^(claude|agy|antigravity|ubuntu|bash)$/i.test(t)) return '';
    if (/^[~/]/.test(t) || /^[\w.-]+@[\w.-]+:/.test(t)) return ''; // a path or user@host
    return t;
  }
  /** What to call the session in tabs. */
  get label(): string {
    return this.customName || this.topic || this.task || this.title;
  }
  /** One line saying what it's doing (home list). */
  get about(): string {
    return this.topic || this.task;
  }
  rename(name: string) {
    this.customName = name.trim().slice(0, 60);
    this.saveMeta();
    this.onMeta?.();
  }
  private loadMeta() {
    try {
      const m = JSON.parse(localStorage.getItem(`meta:${this.id}`) ?? '{}');
      this.task = typeof m.task === 'string' ? m.task : '';
      this.customName = typeof m.name === 'string' ? m.name : '';
    } catch { /* storage unavailable */ }
  }
  private saveMeta() {
    try {
      localStorage.setItem(`meta:${this.id}`, JSON.stringify({ task: this.task, name: this.customName }));
    } catch { /* storage unavailable */ }
  }
  /** Follow what's typed (roughly — history recall and cursor moves aren't seen). */
  private trackInput(data: string) {
    let rest = data;
    if (rest.startsWith('\x1b[200~')) {
      const end = rest.indexOf('\x1b[201~');
      this.lineBuf += (end < 0 ? rest.slice(6) : rest.slice(6, end)).replace(/[\r\n]+/g, ' ');
      rest = end < 0 ? '' : rest.slice(end + 6);
    }
    if (rest.length > 1 && rest[0] === '\x1b') return; // arrow keys and other sequences
    for (const ch of rest) {
      if (ch === '\r' && /^(agy|claude)(\s|$)/.test(this.lineBuf.trim())) this.renderer.anchorBottom = true;
      if (ch === '\r') this.commitLine();
      else if (ch === '\x7f' || ch === '\b') this.lineBuf = Array.from(this.lineBuf).slice(0, -1).join('');
      else if (ch === '\x03' || ch === '\x15' || ch === '\x1b') this.lineBuf = '';
      else if (ch >= ' ') this.lineBuf += ch;
    }
    if (this.lineBuf.length > 300) this.lineBuf = this.lineBuf.slice(-300);
  }
  private commitLine() {
    const line = this.lineBuf.trim().replace(/\s+/g, ' ');
    this.lineBuf = '';
    if (line.length < 3 || line.startsWith('/')) return;
    // Only what was echoed on screen: a password typed at a prompt that doesn't show it
    // (sudo, ssh, read -s) must never become a label or a notification.
    const buf = this.term.buffer.active;
    const row = (y: number) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '';
    const shown = (row(buf.cursorY - 1) + row(buf.cursorY)).replace(/\s+/g, ' ');
    if (!shown.includes(line.slice(-Math.min(line.length, 24)))) return;
    // …nor a pasted token / login code
    if (!line.includes(' ') && line.length > 20 && /^[\w#.+/=-]+$/.test(line)) return;
    const agent = this.kind === 'agy' || this.kind === 'claude';
    if (agent && this.task) return; // the first real prompt names the work
    if (!agent && /^(ls|ll|la|cd|clear|pwd|exit|history)( |$)/.test(line)) return;
    this.task = line.slice(0, 80);
    this.saveMeta();
    this.onMeta?.();
  }

  /** User input → PTY. Jumps back to the live view. */
  input(data: string) {
    if (!this.alive) return;
    // typing: a cursor walk stops, a selection goes (the line changes under it)
    this.edit.cancel();
    this.edit.clearSelection();
    this.onTyped?.();
    this.trackInput(data);
    if (this.renderer.scrollPx) {
      this.renderer.scrollPx = 0;
      this.renderer.schedule();
    }
    this.bridge.write(this.id, data);
  }

  /** The user typed (or pasted) something. */
  onTyped?: () => void;

  /** Keys the app sends for the user (moving the cursor to a tap, a cut). */
  private sendKeys(data: string) {
    if (!this.alive) return;
    if (this.renderer.scrollPx) {
      this.renderer.scrollPx = 0;
      this.renderer.schedule();
    }
    this.bridge.write(this.id, data);
  }

  /**
   * The spot in the line being typed under a client point (null: not there; [loose]: the
   * nearest row of it — a selection handle dragged past its first or last row).
   */
  editSpot(clientX: number, clientY: number, loose = false): Pos | null {
    const { line } = this.renderer.cellAt(clientX, clientY);
    const area = this.edit.area();
    if (!area) return null;
    const l = loose ? Math.max(area.top, Math.min(area.bottom, line)) : line;
    return this.edit.clamp(l, this.renderer.colAt(clientX), area);
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
    // (the paste markers themselves are taken out: a clip containing "ESC[201~" would end
    // the paste early and the rest would run as if typed)
    const t = text.replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r');
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
    // The on-screen keyboard doesn't count: size the terminal as if it were closed.
    const { cols, rows } = this.renderer.fit(box.width, box.height + TerminalSession.keyboardInset);
    if (cols !== this.term.cols || rows !== this.term.rows) {
      this.renderer.holdForRedraw();
      this.term.resize(cols, rows);
      this.renderer.schedule();
    }
    // Compare with what the PTY has, not with xterm: they can differ (restored sessions,
    // a session created before layout was final).
    // (cancel a pending resize first: 14→15→14 px quickly must leave the PTY at 14)
    clearTimeout(this.resizeTimer);
    if (cols === this.ptyCols && rows === this.ptyRows) return;
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
        this.bridge.write(this.id, this.mouseReport(btn, x, y, true).repeat(Math.min(Math.abs(n), 10)));
      } else {
        // no scrollback in full-screen apps: arrow keys are the usual fallback
        const seq = n > 0 ? (this.appCursor ? '\x1bOA' : '\x1b[A') : this.appCursor ? '\x1bOB' : '\x1b[B';
        this.bridge.write(this.id, seq.repeat(Math.min(Math.abs(n), 10)));
      }
      return;
    }
    this.renderer.scrollByPixels(n * this.renderer.lineHeight);
  }

  scrollToBottom() {
    this.renderer.scrollPx = 0;
    this.renderer.schedule();
  }

  /** Send a mouse click (only when the program enabled mouse tracking). */
  click(clientX: number, clientY: number): boolean {
    if (!this.mouseTracking) return false;
    const { x, y } = this.renderer.cellAt(clientX, clientY);
    this.bridge.write(this.id, this.mouseReport(0, x, y, true) + this.mouseReport(0, x, y, false));
    return true;
  }

  /** One mouse event at cell x/y (0-based), in the encoding the program asked for. */
  private mouseReport(btn: number, x: number, y: number, press: boolean): string {
    if (this.sgrMouse) return `\x1b[<${btn};${x + 1};${y + 1}${press ? 'M' : 'm'}`;
    // classic X10/normal encoding: bytes 32 + value (release = button 3), max 223
    const b = press ? btn : 3;
    const ch = (v: number) => String.fromCharCode(Math.min(255, 32 + v));
    return `\x1b[M${ch(b)}${ch(x + 1)}${ch(y + 1)}`;
  }

  /** If a URL is under the point, return it. */
  urlAt(clientX: number, clientY: number): string | null {
    return this.matchAt(clientX, clientY, URL_RE);
  }

  /** If a file name (report.pdf, ~/site/index.html …) is under the point, return it. */
  fileAt(clientX: number, clientY: number): string | null {
    return this.matchAt(clientX, clientY, FILE_RE);
  }

  /** The match of [re] in the (unwrapped) line under the point. */
  private matchAt(clientX: number, clientY: number, re: RegExp): string | null {
    const { x, line: at } = this.renderer.cellAt(clientX, clientY);
    const buf = this.term.buffer.active;
    let start = at;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let text = '';
    let offset = -1;
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line || (i > start && !line.isWrapped)) break;
      // x is a cell; the text has one char per letter cluster or wide character
      if (i === at) offset = text.length + line.translateToString(false, 0, x).length;
      text += line.translateToString(false);
    }
    for (const m of text.matchAll(re)) {
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
    // after everything it printed: a program that died mid-screen (alternate screen, mouse
    // mode) can't clean up — back to the normal screen with its history, mouse off, no
    // blinking cursor
    this.term.write('', () => {
      const leave = this.term.buffer.active.type === 'alternate' ? '\x1b[?1049l' : '';
      this.term.write(
        `${leave}\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25l` +
          `\r\n\x1b[0;2m[exited${code ? ` with code ${code}` : ''} — close the tab with ×]\x1b[0m\r\n`,
      );
    });
  }

  // ---- terminal modes survive a reload of the UI ----
  // The service keeps only the last 512 KB of output; the escape sequences that turned on
  // bracketed paste, application cursor keys, the alternate screen … may be older than
  // that. Remember the current modes and replay them before the saved output.
  private modesSaved = '';
  private modesKey() {
    const m = this.term.modes;
    return [
      m.bracketedPasteMode ? 1 : 0,
      m.applicationCursorKeysMode ? 1 : 0,
      this.term.buffer.active.type === 'alternate' ? 1 : 0,
      this.renderer.cursorVisible ? 1 : 0,
      m.mouseTrackingMode,
    ].join(',');
  }
  private saveModes() {
    if (this.replaying) return; // keep what was saved before: restoreModes compares with it
    const k = this.modesKey();
    if (k === this.modesSaved) return;
    this.modesSaved = k;
    try {
      localStorage.setItem(`modes:${this.id}`, k);
    } catch { /* storage unavailable */ }
  }
  /**
   * An answer to a program's question (cursor position, colours, device attributes …).
   * Not for questions in replayed old output: they were answered back then, and a second
   * answer would arrive at the shell or agent as typed text.
   */
  private reply(data: string) {
    if (!this.replaying) this.bridge.write(this.id, data);
  }

  /** A restored session: its saved output comes next (requests in it were answered then). */
  beginReplay() {
    this.replaying = true;
    // draw it once, when it's all in — not flickering through the old screens
    this.renderer.paused = true;
    window.setTimeout(() => this.endReplayPause(), 4000); // in case the end never comes
  }

  private endReplayPause() {
    if (!this.renderer.paused) return;
    this.renderer.paused = false;
    this.renderer.suppressReveal = true; // old output: no fade-in
    this.renderer.schedule();
  }

  /**
   * After a restored session's saved output has been replayed (the service keeps only its
   * last 512 KB, which may have lost the escapes that turned these modes on): turn on what
   * the replay didn't. Not before it — a replay that starts on the shell and then enters
   * vim would otherwise draw the shell's history into vim's alternate screen.
   */
  restoreModes() {
    this.term.write('', () => {
      this.replaying = false; // everything up to here was the replay
      this.endReplayPause();
    });
    let k: string | null = null;
    try {
      k = localStorage.getItem(`modes:${this.id}`);
    } catch { /* storage unavailable */ }
    if (!k || !this.alive) return; // a finished session has no modes to restore
    const [bp, ac, alt, cur, mouse] = k.split(',');
    this.term.write('', () => {
      const m = this.term.modes;
      const mouseMode: Record<string, number> = { x10: 9, vt200: 1000, drag: 1002, any: 1003 };
      let seq = '';
      const lostAlt = alt === '1' && this.term.buffer.active.type !== 'alternate';
      if (lostAlt) seq += '\x1b[?1049h';
      if (bp === '1' && !m.bracketedPasteMode) seq += '\x1b[?2004h';
      if (ac === '1' && !m.applicationCursorKeysMode) seq += '\x1b[?1h';
      if (cur === '0' && this.renderer.cursorVisible) seq += '\x1b[?25l';
      if (mouseMode[mouse] && m.mouseTrackingMode === 'none') seq += `\x1b[?${mouseMode[mouse]}h\x1b[?1006h`;
      if (seq) this.term.write(seq);
      if (lostAlt && this.alive) {
        // its screen wasn't in the replay: a size change makes the program draw it again
        const { cols, rows } = this.term;
        this.bridge.resize(this.id, cols, Math.max(4, rows - 1));
        window.setTimeout(() => this.bridge.resize(this.id, this.term.cols, this.term.rows), 150);
      }
    });
  }

  dispose() {
    clearTimeout(this.resizeTimer);
    clearTimeout(this.readerFrame);
    this.renderer.dispose();
    try {
      localStorage.removeItem(`modes:${this.id}`);
      localStorage.removeItem(`meta:${this.id}`);
    } catch { /* storage unavailable */ }
    this.term.dispose();
    this.el.remove();
  }
}
