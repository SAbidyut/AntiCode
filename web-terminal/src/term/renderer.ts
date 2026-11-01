// A small DOM renderer for a headless xterm.js terminal that keeps Bangla correctly shaped.
//
// Why not xterm's own renderers? Canvas/WebGL renderers draw every cell as an
// independent glyph, so Bangla conjuncts (ক্ষ, স্ত্র, ন্ত) and vowel signs (ি ে ৌ)
// fall apart. Here each contiguous run of Bangla text in a row is emitted as ONE
// text node, so the browser's shaper (HarfBuzz) can form conjuncts with the
// Kalpurush font. The run is then fitted to exactly `cells × cellWidth` pixels,
// so everything after it (box borders, columns, the cursor) stays on the grid.

import type { Terminal, IBufferCell, IBufferLine } from '@xterm/headless';

export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  /** 16 ANSI colours: black red green yellow blue magenta cyan white, then bright variants. */
  ansi: string[];
}

export const THEMES: Record<string, TermTheme> = {
  // Tokyo-Night-ish dark theme (default)
  night: {
    background: '#14161f',
    foreground: '#d5d9f0',
    cursor: '#ffb86c',
    ansi: [
      '#1d202f', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
      '#414868', '#ff8fa4', '#b9f27c', '#ffc777', '#8db0ff', '#c7a9ff', '#a4daff', '#ffffff',
    ],
  },
  light: {
    background: '#fbf8f1',
    foreground: '#2b2b33',
    cursor: '#d9480f',
    ansi: [
      '#2b2b33', '#c92a2a', '#2b8a3e', '#b7791f', '#1c64d1', '#9c36b5', '#0c8599', '#6c6f7d',
      '#5c5f6e', '#e03131', '#37b24d', '#d9a400', '#3b82f6', '#be4bdb', '#15aabf', '#2b2b33',
    ],
  },
};

const BN_START = 0x0980;
const BN_END = 0x09ff;

function cpClass(chars: string): 'space' | 'bn' | 'mono' | 'box' {
  if (chars === '' || chars === ' ') return 'space';
  const cp = chars.codePointAt(0)!;
  if (cp >= BN_START && cp <= BN_END) return 'bn';
  // Bangla punctuation commonly mixed into sentences: danda, double danda, ZWJ/ZWNJ.
  if (cp === 0x0964 || cp === 0x0965 || cp === 0x200c || cp === 0x200d) return 'bn';
  // Glyphs JetBrains Mono has with exact cell width: Latin/Greek/Cyrillic, general
  // punctuation, arrows, box drawing, block elements, geometric shapes.
  if (
    cp < 0x0530 ||
    (cp >= 0x2000 && cp <= 0x206f) ||
    (cp >= 0x2190 && cp <= 0x21ff) ||
    (cp >= 0x2500 && cp <= 0x25ff)
  ) {
    return chars.length > 2 ? 'box' : 'mono';
  }
  return 'box'; // emoji, CJK, braille spinners, … → fixed-size box so the grid never drifts
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

function build256(theme: TermTheme): string[] {
  const p = theme.ansi.slice(0, 16);
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) p.push(`rgb(${steps[r]},${steps[g]},${steps[b]})`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(`rgb(${v},${v},${v})`);
  }
  return p;
}

function rgb(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

export interface RendererOptions {
  fontSize: number;
  theme: TermTheme;
  /** Scale applied to Bangla runs relative to the Latin font size. */
  bnScale: number;
}

export class BanglaRenderer {
  readonly el: HTMLDivElement;
  private rowsEl: HTMLDivElement;
  private cursorEl: HTMLDivElement;
  private rowEls: HTMLDivElement[] = [];
  private rowHtml: string[] = [];
  private palette: string[];
  private measureCtx = document.createElement('canvas').getContext('2d')!;
  private widthCache = new Map<string, number>();
  private cell!: IBufferCell;
  private frame = 0;

  cellWidth = 8;
  lineHeight = 18;
  /** Lines scrolled up from the bottom (0 = following output). */
  scrollOffset = 0;
  cursorVisible = true;
  focused = false;

  constructor(private term: Terminal, private opts: RendererOptions) {
    this.el = document.createElement('div');
    this.el.className = 'term-screen';
    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'term-rows';
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'term-cursor';
    this.el.append(this.rowsEl, this.cursorEl);
    this.palette = build256(opts.theme);
    this.applyMetrics();
  }

  setOptions(opts: Partial<RendererOptions>) {
    Object.assign(this.opts, opts);
    this.palette = build256(this.opts.theme);
    this.widthCache.clear();
    this.applyMetrics();
    this.rowHtml = [];
    this.schedule();
  }

  get options(): Readonly<RendererOptions> {
    return this.opts;
  }

  private applyMetrics() {
    const { fontSize, theme } = this.opts;
    this.measureCtx.font = `${fontSize}px "JetBrains Mono", monospace`;
    this.cellWidth = this.measureCtx.measureText('MMMMMMMMMM').width / 10;
    this.lineHeight = Math.round(fontSize * 1.5);
    const s = this.el.style;
    s.setProperty('--cw', `${this.cellWidth}px`);
    s.setProperty('--lh', `${this.lineHeight}px`);
    s.setProperty('--fs', `${fontSize}px`);
    s.setProperty('--bn-fs', `${fontSize * this.opts.bnScale}px`);
    s.background = theme.background;
    s.color = theme.foreground;
    this.cursorEl.style.setProperty('--cursor', theme.cursor);
  }

  /** How many columns/rows fit into the given pixel box. */
  fit(width: number, height: number): { cols: number; rows: number } {
    return {
      cols: Math.max(10, Math.floor((width - 4) / this.cellWidth)),
      rows: Math.max(4, Math.floor(height / this.lineHeight)),
    };
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private bnWidth(text: string, bold: boolean): number {
    const key = (bold ? 'b' : 'r') + text;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      this.measureCtx.font = `${bold ? 'bold ' : ''}${this.opts.fontSize * this.opts.bnScale}px Kalpurush`;
      w = this.measureCtx.measureText(text).width;
      if (this.widthCache.size > 4000) this.widthCache.clear();
      this.widthCache.set(key, w);
    }
    return w;
  }

  private colorOf(isDefault: boolean, isPalette: boolean, isRGB: boolean, value: number, fallback: string): string {
    if (isDefault) return fallback;
    if (isPalette) return this.palette[value] ?? fallback;
    if (isRGB) return rgb(value);
    return fallback;
  }

  /** CSS for a cell's attributes ('' for default attributes). */
  private styleOf(c: IBufferCell): { css: string; bold: boolean } {
    if (c.isAttributeDefault()) return { css: '', bold: false };
    const { theme } = this.opts;
    let fg = this.colorOf(c.isFgDefault(), c.isFgPalette(), c.isFgRGB(), c.getFgColor(), '');
    let bg = this.colorOf(c.isBgDefault(), c.isBgPalette(), c.isBgRGB(), c.getBgColor(), '');
    const bold = !!c.isBold();
    // Bold + basic colour → bright variant, like most terminals.
    if (bold && c.isFgPalette() && c.getFgColor() < 8) fg = this.palette[c.getFgColor() + 8];
    if (c.isInverse()) {
      const f = fg || theme.foreground;
      fg = bg || theme.background;
      bg = f;
    }
    let css = '';
    if (fg) css += `color:${fg};`;
    if (bg) css += `background:${bg};`;
    if (bold) css += 'font-weight:700;';
    if (c.isItalic()) css += 'font-style:italic;';
    if (c.isDim()) css += 'opacity:.6;';
    if (c.isInvisible()) css += 'visibility:hidden;';
    const deco = (c.isUnderline() ? ' underline' : '') + (c.isStrikethrough() ? ' line-through' : '') + (c.isOverline() ? ' overline' : '');
    if (deco) css += `text-decoration:${deco};`;
    return { css, bold };
  }

  /** Build the HTML for one buffer line. */
  rowToHtml(line: IBufferLine | undefined, cols: number): string {
    if (!line) return '';
    const cw = this.cellWidth;
    const cell = (this.cell = line.getCell(0, this.cell) ?? this.cell);
    let html = '';
    // current run
    let kind: 'mono' | 'bn' | '' = '';
    let style = '';
    let bold = false;
    let text = '';
    let cells = 0;

    const flush = () => {
      if (!kind) return;
      if (kind === 'mono') {
        html += style ? `<span style="${style}">${esc(text)}</span>` : esc(text);
      } else {
        // Keep trailing spaces out of the Bangla run (they belong to the grid).
        const trimmed = text.replace(/ +$/, '');
        const trailing = text.length - trimmed.length;
        const runCells = cells - trailing;
        const target = runCells * cw;
        const natural = this.bnWidth(trimmed, bold);
        // Programs count Bangla width differently from how wide it really looks, so fit
        // the shaped run to its cells: squeeze it if too wide, or spread the extra space
        // between words (never inside a word — that would break conjuncts).
        let inner = '';
        if (natural > target + 0.5) {
          const r = Math.max(0.5, target / natural);
          inner = ` style="transform:scaleX(${r.toFixed(4)})"`;
        } else if (natural < target - 1) {
          const spaces = (trimmed.match(/ /g) ?? []).length;
          if (spaces) {
            const ws = Math.min((target - natural) / spaces, cw * 1.5);
            inner = ` style="word-spacing:${ws.toFixed(2)}px"`;
          }
        }
        html += `<span class="bn" style="width:${target.toFixed(2)}px;${style}"><span class="bi"${inner}>${esc(trimmed)}</span></span>`;
        if (trailing) html += style ? `<span style="${style}">${' '.repeat(trailing)}</span>` : ' '.repeat(trailing);
      }
      kind = '';
      text = '';
      cells = 0;
    };

    for (let x = 0; x < cols; x++) {
      const c = line.getCell(x, cell);
      if (!c) break;
      const w = c.getWidth();
      if (w === 0) continue; // second half of a wide character
      const chars = c.getChars();
      const cls = cpClass(chars);
      const st = this.styleOf(c);

      if (cls === 'box' || (cls === 'mono' && w > 1)) {
        flush();
        html += `<span class="bx" style="width:${(w * cw).toFixed(2)}px;${st.css}">${esc(chars)}</span>`;
        continue;
      }
      if (cls === 'space') {
        // spaces extend whatever run is open (Bangla words stay one shaped run)
        if (kind && style === st.css) {
          text += ' ';
          cells += 1;
          continue;
        }
        flush();
        kind = 'mono';
        style = st.css;
        bold = st.bold;
        text = ' ';
        cells = 1;
        continue;
      }
      const k = cls === 'bn' ? 'bn' : 'mono';
      if (kind === k && style === st.css) {
        text += chars;
        cells += w;
        continue;
      }
      flush();
      kind = k;
      style = st.css;
      bold = st.bold;
      text = chars;
      cells = w;
    }
    flush();
    return html;
  }

  render() {
    const term = this.term;
    const buf = term.buffer.active;
    const rows = term.rows;
    const cols = term.cols;

    // Make sure we have exactly `rows` row elements.
    while (this.rowEls.length < rows) {
      const r = document.createElement('div');
      r.className = 'term-row';
      this.rowsEl.appendChild(r);
      this.rowEls.push(r);
      this.rowHtml.push('\u0000');
    }
    while (this.rowEls.length > rows) {
      this.rowEls.pop()!.remove();
      this.rowHtml.pop();
    }

    this.scrollOffset = Math.min(this.scrollOffset, buf.baseY);
    const top = buf.baseY - this.scrollOffset;
    for (let y = 0; y < rows; y++) {
      const html = this.rowToHtml(buf.getLine(top + y), cols);
      if (html !== this.rowHtml[y]) {
        this.rowHtml[y] = html;
        this.rowEls[y].innerHTML = html;
      }
    }

    const cursorRow = buf.cursorY + buf.baseY - top;
    const showCursor = this.cursorVisible && cursorRow >= 0 && cursorRow < rows;
    this.cursorEl.style.display = showCursor ? 'block' : 'none';
    if (showCursor) {
      this.cursorEl.style.transform = `translate(${(buf.cursorX * this.cellWidth).toFixed(2)}px, ${cursorRow * this.lineHeight}px)`;
      this.cursorEl.classList.toggle('focused', this.focused);
    }
    this.el.classList.toggle('scrolled', this.scrollOffset > 0);
  }

  /** Map a client point to a terminal cell (in viewport coordinates). */
  cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.rowsEl.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.term.cols - 1, Math.floor((clientX - rect.left) / this.cellWidth))),
      y: Math.max(0, Math.min(this.term.rows - 1, Math.floor((clientY - rect.top) / this.lineHeight))),
    };
  }

  /** Buffer line index shown at viewport row y. */
  bufferLineAt(y: number): number {
    const buf = this.term.buffer.active;
    return buf.baseY - Math.min(this.scrollOffset, buf.baseY) + y;
  }
}
