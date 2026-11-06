import type { IBufferLine, Terminal } from '@xterm/headless';

/**
 * The line being typed, like a text field: tap to put the cursor there, select a word or all
 * of it, copy, cut.
 *
 * The text belongs to the program (bash, Claude Code, the Antigravity CLI), which has no idea
 * of taps or selections, so the cursor is moved the way a person would: arrow keys, checked
 * against where the program's cursor really went (a Bangla conjunct is one step for one
 * program and two for another) — a few keys at a time, never past the spot; a cut is ⌫ from
 * the end of the selection back to its start.
 *
 * Where: an agent's input box (from the rule line above the cursor down to the one below it),
 * or at the shell's prompt the command line (all its wrapped rows). Programs that take mouse
 * clicks themselves (and full-screen ones) are left alone.
 */

/** A spot between two cells: buffer line + cell column. */
export interface Pos {
  line: number;
  x: number;
}

export interface Area {
  top: number;
  bottom: number;
  /** An agent's box (its rows are separate lines) rather than the shell's wrapped line. */
  box: boolean;
  /** Per row (line - top): where its text starts and ends (cells). */
  start: number[];
  end: number[];
}

export interface Selection {
  a: Pos;
  b: Pos;
  /** The area's top when made: the box moving (a reply came in) drops the selection. */
  top: number;
  /**
   * In the line being typed (it can be cut, pasted over) or anywhere on the screen (output:
   * copy only).
   */
  kind: 'input' | 'screen';
}

export const cmp = (p: Pos, q: Pos) => (p.line - q.line) || (p.x - q.x);

const isVirama = (cp: number) => cp === 0x09cd || cp === 0x094d;
const isConsonant = (cp: number) =>
  (cp >= 0x0995 && cp <= 0x09b9) || cp === 0x09dc || cp === 0x09dd || cp === 0x09df || cp === 0x09f0 || cp === 0x09f1 ||
  (cp >= 0x0915 && cp <= 0x0939) || (cp >= 0x0958 && cp <= 0x095f);

/** A horizontal rule drawn with box characters (the border of a TUI's input box). */
export function isRule(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  let n = 0;
  for (const ch of t) if ('─━╌╍┄┅═'.includes(ch)) n++;
  return n / t.length >= 0.8;
}

/** The prompt's marker at the start of an input box's first row ("❯ ", "> "). */
const MARK = /^[\s│┃]*(?:[❯›>»$#%!][  ])?/;

export class LineEditor {
  /** The shell's prompt is up (between its "done" and the next command's "exec"). */
  atPrompt = false;
  sel: Selection | null = null;
  /** The selection changed (draw it). */
  onSelection?: (sel: Selection | null, area: Area | null) => void;
  /** …and for the app (its Copy / Paste bar). */
  onChanged?: (sel: Selection | null) => void;
  private gen = 0;
  private cell: ReturnType<IBufferLine['getCell']>;

  constructor(
    private term: Terminal,
    /** Keys to the program (not the user's typing: doesn't drop the selection). */
    private send: (data: string) => void,
    private lastOutput: () => number,
    /** An agent runs (Claude Code, Antigravity): its input box between two rules counts. */
    private agentRuns: () => boolean = () => true,
  ) {
    this.cell = undefined;
  }

  private get buf() {
    return this.term.buffer.active;
  }

  private text(line: number) {
    return this.buf.getLine(line)?.translateToString(true) ?? '';
  }

  /** Where the text being typed is right now, or null (no line editor there). */
  area(): Area | null {
    const buf = this.buf;
    if (buf.type !== 'normal' || this.term.modes.mouseTrackingMode !== 'none') return null;
    const cur = buf.baseY + buf.cursorY;
    let top = -1;
    let bottom = cur;
    // (at the shell's prompt a rule line above is what an agent left on the screen; and only
    // an agent's box: a script that printed a rule and asks something would get arrow keys
    // typed into its answer, less would scroll sideways)
    if (!this.atPrompt && this.agentRuns()) {
      for (let y = cur - 1; y >= Math.max(0, cur - 8); y--) {
        if (isRule(this.text(y))) {
          top = y + 1;
          break;
        }
      }
    }
    // OpenCode's input box: no rules, a bar down its left side (┃) — its rows are the box
    const barred = (y: number) => /^\s*┃/.test(this.text(y));
    let barBox = false;
    if (top < 0 && !this.atPrompt && this.agentRuns() && barred(cur)) {
      top = cur;
      while (top > 0 && cur - top < 20 && barred(top - 1)) top--;
      while (bottom + 1 < buf.length && bottom - cur < 20 && barred(bottom + 1)) bottom++;
      barBox = true;
    }
    const box = top >= 0;
    if (box && !barBox) {
      // its rows down to the rule under it (none found: just up to the cursor)
      for (let y = cur + 1; y < Math.min(buf.length, cur + 12); y++) {
        if (isRule(this.text(y))) {
          bottom = y - 1;
          break;
        }
      }
    } else if (!box) {
      if (!this.atPrompt) return null;
      // The command's rows: up to the prompt's row, down while a row runs on into the next.
      // (The terminal's "wrapped" mark alone isn't enough: bash redraws a long line with
      // its own line feeds as the cursor moves across it, which clears the mark.)
      const prompt = (y: number) => /❯ /.test(this.text(y));
      const runsOn = (y: number) => !!buf.getLine(y + 1)?.isWrapped || (this.full(y) && this.text(y + 1) !== '');
      top = cur;
      while (top > 0 && cur - top < 40 && !prompt(top) && runsOn(top - 1)) top--;
      while (bottom + 1 < buf.length && bottom - cur < 40 && runsOn(bottom) && !prompt(bottom + 1)) bottom++;
    }
    const start: number[] = [];
    const end: number[] = [];
    let indent = 0;
    for (let y = top; y <= bottom; y++) {
      const t = this.buf.getLine(y)?.translateToString(false) ?? '';
      let s = 0;
      if (box) {
        // (these characters are one cell each: string index = cell)
        if (y === top) indent = s = MARK.exec(t)?.[0].length ?? 0;
        else {
          while (s < indent && /[\s│┃]/.test(t[s] ?? '')) s++;
        }
      } else if (y === top) {
        // after our prompt's ❯ (or a classic "$ " / "# ")
        const m = /❯ |[$#%] /.exec(t);
        s = m ? this.cellOf(y, m.index + m[0].length) : 0;
      }
      start.push(s);
      end.push(Math.max(s, this.textEnd(y)));
    }
    return { top, bottom, box, start, end };
  }

  /** Text reaches the row's right edge (a wide letter that didn't fit leaves one cell). */
  private full(y: number): boolean {
    const line = this.buf.getLine(y);
    if (!line) return false;
    for (const x of [this.term.cols - 1, this.term.cols - 2]) {
      const c = line.getCell(x, this.cell);
      if (c && (c.getWidth() === 0 || (c.getChars() !== '' && c.getChars() !== ' '))) return true;
    }
    return false;
  }

  /** After the row's last character that's typed text (not a border, a grey suggestion …). */
  private textEnd(y: number): number {
    const line = this.buf.getLine(y);
    if (!line) return 0;
    for (let x = Math.min(this.term.cols, line.length) - 1; x >= 0; x--) {
      const c = (this.cell = line.getCell(x, this.cell));
      if (!c) continue;
      if (c.getWidth() === 0) continue;
      const ch = c.getChars();
      if (!ch || ch === ' ' || ch === '│' || ch === '┃') continue;
      if (c.isDim() || (c.isFgRGB() && c.getFgColor() === 0x6c7086)) continue; // a suggestion / placeholder
      return x + c.getWidth();
    }
    return 0;
  }

  caret(): Pos {
    const buf = this.buf;
    return { line: buf.baseY + buf.cursorY, x: Math.min(buf.cursorX, this.term.cols) };
  }

  /** The spot for a cell column (fractional) on a line, kept inside the area; null if outside. */
  clamp(line: number, col: number, area = this.area()): Pos | null {
    if (!area || line < area.top || line > area.bottom) return null;
    const i = line - area.top;
    let x = Math.round(col);
    // not between the halves of a wide character
    const l = this.buf.getLine(line);
    if (l && x > 0 && x < this.term.cols && l.getCell(x, this.cell)?.getWidth() === 0) x = col - Math.floor(col) < 0.5 ? x - 1 : x + 1;
    return { line, x: Math.max(area.start[i], Math.min(area.end[i], x)) };
  }

  /**
   * Cursor moves from [p] to [q], counted so as never to go past it: a conjunct (ক্ষ) counts
   * once (one step for Claude Code, two in the shell — the next round makes up the rest).
   */
  private steps(p: Pos, q: Pos, area: Area): number {
    const fwd = cmp(p, q) < 0;
    const [a, b] = fwd ? [p, q] : [q, p];
    let n = 0;
    for (let line = Math.max(a.line, area.top); line <= Math.min(b.line, area.bottom); line++) {
      const i = line - area.top;
      const s = line === a.line ? a.x : area.start[i];
      const e = line === b.line ? Math.min(b.x, Math.max(area.end[i], a.line === line ? a.x : 0)) : area.end[i];
      n += this.units(line, s, e);
      // to the next row: a line break or the space the program wrapped at is a step; a row
      // that simply goes on (the shell's long lines, a long word cut at the box's edge) isn't
      if (line < b.line && this.rowBreak(line, area)) n++;
    }
    return fwd ? n : -n;
  }

  /**
   * What lies between a row of the area and the next one: '' — the row simply goes on (the
   * shell's long command lines; in a box, a long word or link cut at its right edge), ' ' — the
   * box wrapped at a space (a long row), '\n' — a new line (a short row).
   */
  private rowBreak(line: number, area: Area): '' | ' ' | '\n' {
    if (!area.box || this.buf.getLine(line + 1)?.isWrapped) return '';
    const i = line - area.top;
    const end = area.end[i];
    if (end >= this.term.cols - 2 && i + 1 < area.start.length) {
      // a letter in the box's last column (Claude Code's text runs to cols − 2; a row wrapped
      // at a space ends sooner) and one at the start of the next row: a word cut in two
      const last = this.charAt(line, end - 1);
      const first = this.charAt(line + 1, area.start[i + 1]);
      if (last.trim() && first.trim()) return '';
    }
    return end >= this.term.cols - 16 ? ' ' : '\n';
  }

  /** The character drawn in a cell (the start of a wide one), '' for none. */
  private charAt(y: number, x: number): string {
    const line = this.buf.getLine(y);
    if (!line || x < 0) return '';
    let c = line.getCell(x, this.cell);
    if (c && c.getWidth() === 0 && x > 0) c = line.getCell(x - 1, this.cell);
    return c?.getChars() ?? '';
  }

  /** Letters (clusters) starting in cells [s, e) of a line. */
  private units(y: number, s: number, e: number): number {
    const line = this.buf.getLine(y);
    if (!line) return 0;
    let n = 0;
    // (the cell before [s] isn't looked at: the cursor being at [s] — after ক্ in the shell,
    // which steps through a conjunct letter by letter — the letter there is a step of its own;
    // counted as part of the conjunct, the walk stopped one letter short)
    let prevLinks = false;
    for (let x = s; x < e && x < this.term.cols; x++) {
      const c = (this.cell = line.getCell(x, this.cell));
      if (!c || c.getWidth() === 0) continue;
      const ch = c.getChars();
      const first = ch.codePointAt(0) ?? 32;
      if (!(prevLinks && isConsonant(first))) n++;
      const lastCp = [...ch].pop()?.codePointAt(0) ?? 0;
      prevLinks = isVirama(lastCp) || (lastCp === 0x200d && ch.length > 1);
    }
    return n;
  }

  /** Move the program's cursor to [target] (a spot in the area). */
  async moveCaret(target: Pos): Promise<boolean> {
    const gen = ++this.gen;
    const keys = (right: boolean) => {
      const app = this.term.modes.applicationCursorKeysMode;
      return right ? (app ? '\x1bOC' : '\x1b[C') : app ? '\x1bOD' : '\x1b[D';
    };
    for (let round = 0; round < 12; round++) {
      const area = this.area();
      if (!area) return false;
      const c = this.caret();
      const n = this.steps(c, target, area);
      if (n === 0) return true;
      this.send(keys(n > 0).repeat(Math.min(Math.abs(n), 300)));
      const moved = await this.settled(c);
      if (gen !== this.gen) return false; // another tap took over
      if (!moved) return false; // the start or the end of the text
    }
    return false;
  }

  /** Wait until the program has redrawn the cursor (or nothing happens). True if it moved. */
  private settled(from: Pos): Promise<boolean> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const now = performance.now();
        const c = this.caret();
        const moved = cmp(c, from) !== 0;
        if ((moved && now - this.lastOutput() > 50) || now - t0 > 700) resolve(moved);
        else window.setTimeout(check, 16);
      };
      window.setTimeout(check, 25);
    });
  }

  // ---------------- selection ----------------

  setSelection(a: Pos, b: Pos, area = this.area()) {
    if (!area) return this.clearSelection();
    if (cmp(a, b) > 0) [a, b] = [b, a];
    this.sel = { a, b, top: area.top, kind: 'input' };
    this.onSelection?.(this.sel, area);
  }

  /**
   * The cell column where character [index] of a row's text is (a folder name in Bangla or
   * Chinese before the ❯ has more — or fewer — characters than cells).
   */
  private cellOf(y: number, index: number): number {
    const line = this.buf.getLine(y);
    if (!line) return index;
    let chars = 0;
    let col = 0;
    for (; col < this.term.cols && chars < index; col++) {
      const c = line.getCell(col);
      // (as the row's text counts them: an empty cell is a space, a wide letter's second half nothing)
      chars += (c?.getChars() || (c?.getWidth() === 0 ? '' : ' ')).length;
    }
    return col;
  }

  /** Text selected anywhere on the screen (the output): from [a] to [b]. */
  setScreenSelection(a: Pos, b: Pos) {
    if (cmp(a, b) > 0) [a, b] = [b, a];
    this.sel = { a, b, top: this.buf.type === 'alternate' ? -2 : -1, kind: 'screen' };
    this.onSelection?.(this.sel, null);
  }

  /** A spot anywhere on the screen (between two cells). */
  screenSpot(line: number, col: number): Pos {
    const buf = this.buf;
    const l = Math.max(0, Math.min(buf.length - 1, line));
    return { line: l, x: Math.max(0, Math.min(this.term.cols, Math.round(col))) };
  }

  /** After a row's last character (anything not blank). */
  rowEnd(y: number): number {
    const line = this.buf.getLine(y);
    if (!line) return 0;
    for (let x = Math.min(this.term.cols, line.length) - 1; x >= 0; x--) {
      const c = (this.cell = line.getCell(x, this.cell));
      if (!c || c.getWidth() === 0) continue;
      const ch = c.getChars();
      if (ch && ch !== ' ') return x + c.getWidth();
    }
    return 0;
  }

  /** Select the word (the run of non-spaces) at a spot on the screen. False on a blank. */
  selectScreenWord(p: Pos): boolean {
    const line = this.buf.getLine(p.line);
    if (!line) return false;
    const end = this.rowEnd(p.line);
    const blank = (x: number) => {
      const c = line.getCell(x, this.cell);
      const ch = c?.getChars() ?? '';
      return c?.getWidth() !== 0 && (!ch || ch === ' ');
    };
    let x = Math.min(p.x, end - 1);
    if (x < 0 || blank(x)) x = p.x - 1;
    if (x < 0 || x >= end || blank(x)) return false;
    let a = x;
    let b = x + 1;
    while (a > 0 && !blank(a - 1)) a--;
    while (b < end && !blank(b)) b++;
    this.setScreenSelection({ line: p.line, x: a }, { line: p.line, x: b });
    return true;
  }

  /** All of the screen's text (the whole history in a shell). */
  selectAllScreen(): boolean {
    const buf = this.buf;
    let last = buf.length - 1;
    while (last > 0 && this.rowEnd(last) === 0) last--;
    let first = 0;
    while (first < last && this.rowEnd(first) === 0) first++;
    if (this.rowEnd(last) === 0) return false;
    this.setScreenSelection({ line: first, x: 0 }, { line: last, x: this.rowEnd(last) });
    return true;
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this.onSelection?.(null, null);
  }

  /** The program redrew: a selection whose text moved away (Enter, the box moving) goes. */
  check() {
    if (!this.sel) return;
    if (this.sel.kind === 'screen') {
      // (another screen now — a full-screen program started or ended: it's gone)
      if (this.sel.top !== (this.buf.type === 'alternate' ? -2 : -1)) this.clearSelection();
      return;
    }
    const area = this.area();
    if (!area || area.top !== this.sel.top || this.sel.b.line > area.bottom) this.clearSelection();
    else this.onSelection?.(this.sel, area);
  }

  /** Select the word at a spot. False if there's none (a space, empty input). */
  selectWord(p: Pos): boolean {
    const area = this.area();
    const line = this.buf.getLine(p.line);
    if (!area || !line) return false;
    const i = p.line - area.top;
    const blank = (x: number) => {
      const c = line.getCell(x, this.cell);
      const ch = c?.getChars() ?? '';
      return c?.getWidth() !== 0 && (!ch || ch === ' ');
    };
    // the cell under the finger (the spot is between cells: try the one after, then before)
    let x = Math.min(p.x, area.end[i] - 1);
    if (x < area.start[i] || blank(x)) x = p.x - 1;
    if (x < area.start[i] || x >= area.end[i] || blank(x)) return false;
    let s = x;
    let e = x + 1;
    while (s > area.start[i] && !blank(s - 1)) s--;
    while (e < area.end[i] && !blank(e)) e++;
    this.setSelection({ line: p.line, x: s }, { line: p.line, x: e }, area);
    return true;
  }

  /** Everything typed. False if nothing is. */
  selectAll(): boolean {
    const area = this.area();
    if (!area) return false;
    let last = -1;
    for (let i = area.end.length - 1; i >= 0; i--) {
      if (area.end[i] > area.start[i]) {
        last = i;
        break;
      }
    }
    if (last < 0) return false;
    let first = 0;
    while (area.end[first] <= area.start[first]) first++;
    this.setSelection(
      { line: area.top + first, x: area.start[first] },
      { line: area.top + last, x: area.end[last] },
      area,
    );
    return true;
  }

  /** Is there any typed text? */
  hasText(area = this.area()): boolean {
    return !!area && area.end.some((e, i) => e > area.start[i]);
  }

  selectedText(): string {
    const sel = this.sel;
    if (sel?.kind === 'screen') {
      // rows as they were printed: a wrapped row continues the one before it
      let out = '';
      for (let line = sel.a.line; line <= sel.b.line; line++) {
        const s = line === sel.a.line ? sel.a.x : 0;
        const e = line === sel.b.line ? sel.b.x : this.term.cols;
        out += this.buf.getLine(line)?.translateToString(true, s, Math.max(s, e)) ?? '';
        if (line < sel.b.line && !this.buf.getLine(line + 1)?.isWrapped) out += '\n';
      }
      return out;
    }
    const area = this.area();
    if (!sel || !area) return '';
    let out = '';
    for (let line = sel.a.line; line <= sel.b.line; line++) {
      const i = line - area.top;
      const s = line === sel.a.line ? sel.a.x : area.start[i];
      const e = line === sel.b.line ? sel.b.x : area.end[i];
      out += this.buf.getLine(line)?.translateToString(true, s, Math.max(s, e)) ?? '';
      if (line < sel.b.line) out += this.rowBreak(line, area);
    }
    return out;
  }

  /** Remove the selected text from the program's line (cursor to its end, ⌫ back to its start). */
  async deleteSelection(): Promise<void> {
    const sel = this.sel;
    if (!sel || sel.kind !== 'input') return;
    this.clearSelection();
    // (the cursor didn't get to the selection's end — the program didn't answer in time, a tap
    // took over: deleting from wherever it is would take the wrong letters)
    if (!(await this.moveCaret(sel.b))) return;
    const gen = ++this.gen;
    for (let round = 0; round < 12; round++) {
      const area = this.area();
      if (!area) return;
      const c = this.caret();
      if (cmp(c, sel.a) <= 0) return;
      const n = -this.steps(c, sel.a, area);
      if (n <= 0) return;
      this.send('\x7f'.repeat(Math.min(n, 300)));
      const moved = await this.settled(c);
      if (gen !== this.gen || !moved) return;
    }
  }

  /** A tap or typing elsewhere: any cursor walk in progress stops. */
  cancel() {
    this.gen++;
  }
}
