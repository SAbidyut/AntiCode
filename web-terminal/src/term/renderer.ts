// A small DOM renderer for a headless xterm.js terminal that keeps Bangla correctly shaped.
//
// Why not xterm's own renderers? Canvas/WebGL renderers draw every cell as an
// independent glyph, so Bangla conjuncts (ক্ষ, স্ত্র, ন্ত) and vowel signs (ি ে ৌ)
// fall apart. Here each contiguous run of Bangla text in a row is emitted as ONE
// text node, so the browser's shaper (HarfBuzz) can form conjuncts with the
// Kalpurush font. The run is then fitted to exactly `cells × cellWidth` pixels,
// so everything after it (box borders, columns, the cursor) stays on the grid.
//
// Smoothness: rows are absolutely positioned by their buffer line number inside one
// "viewport" layer, and scrolling only moves that layer (a GPU transform) — rows that
// stay visible are reused, so scrolling one line costs one new row, not a full redraw.
//
// Box drawing (─│╭╮…), block elements (▀▄█…) and powerline separators () are
// drawn with CSS/SVG instead of font glyphs, so they fill the cell exactly and join
// seamlessly at any zoom level.

import type { Terminal, IBufferCell, IBufferLine } from '@xterm/headless';

export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  /** 16 ANSI colours: black red green yellow blue magenta cyan white, then bright variants. */
  ansi: string[];
}

export const THEMES: Record<string, TermTheme> = {
  // Default: deep blue-black, Catppuccin-inspired accents
  midnight: {
    background: '#0b0d12',
    foreground: '#dde3f3',
    cursor: '#f5c2a0',
    ansi: [
      '#1c1f2b', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#cba6f7', '#89dceb', '#bac2de',
      '#45495e', '#f6a0b8', '#b8ebb4', '#fbe9bf', '#a0c3fb', '#d6baf9', '#a3e4f0', '#ffffff',
    ],
  },
  dracula: {
    background: '#1e1f29',
    foreground: '#f8f8f2',
    cursor: '#ff79c6',
    ansi: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
    ],
  },
  solarized: {
    background: '#002b36',
    foreground: '#cfd8d3',
    cursor: '#b58900',
    ansi: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#3f5f68', '#cb4b16', '#93a86a', '#c9a227', '#6c9fd8', '#9b8fe0', '#5fb3ab', '#fdf6e3',
    ],
  },
  paper: {
    background: '#fbfaf7',
    foreground: '#2a2c33',
    cursor: '#e8590c',
    ansi: [
      '#2a2c33', '#d6336c', '#2b8a3e', '#b7791f', '#1c64d1', '#9c36b5', '#0c8599', '#6c6f7d',
      '#5c5f6e', '#e64980', '#37b24d', '#d9a400', '#3b82f6', '#be4bdb', '#15aabf', '#2a2c33',
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
  // emoji, CJK, Nerd Font icons (private use area), braille spinners, … → a fixed-size
  // box so the grid never drifts
  return 'box';
}

// ------------------------------------------------------------------ drawn glyphs
// Arms of box-drawing characters: [up, right, down, left], 0 none, 1 light, 2 heavy.
const BOX_ARMS: Record<number, [number, number, number, number]> = {
  0x2500: [0, 1, 0, 1], 0x2501: [0, 2, 0, 2], 0x2502: [1, 0, 1, 0], 0x2503: [2, 0, 2, 0],
  0x250c: [0, 1, 1, 0], 0x250f: [0, 2, 2, 0], 0x2510: [0, 0, 1, 1], 0x2513: [0, 0, 2, 2],
  0x2514: [1, 1, 0, 0], 0x2517: [2, 2, 0, 0], 0x2518: [1, 0, 0, 1], 0x251b: [2, 0, 0, 2],
  0x251c: [1, 1, 1, 0], 0x2523: [2, 2, 2, 0], 0x2524: [1, 0, 1, 1], 0x252b: [2, 0, 2, 2],
  0x252c: [0, 1, 1, 1], 0x2533: [0, 2, 2, 2], 0x2534: [1, 1, 0, 1], 0x253b: [2, 2, 0, 2],
  0x253c: [1, 1, 1, 1], 0x254b: [2, 2, 2, 2],
  0x2574: [0, 0, 0, 1], 0x2575: [1, 0, 0, 0], 0x2576: [0, 1, 0, 0], 0x2577: [0, 0, 1, 0],
};
// Rounded corners ╭ ╮ ╯ ╰ → CSS class
const ROUND: Record<number, string> = { 0x256d: 'r-dr', 0x256e: 'r-dl', 0x256f: 'r-ul', 0x2570: 'r-ur' };

// Block elements: fill rectangles [x, y, w, h] in eighths of the cell.
const BLOCKS: Record<number, [number, number, number, number][]> = {
  0x2580: [[0, 0, 8, 4]],
  0x2581: [[0, 7, 8, 1]], 0x2582: [[0, 6, 8, 2]], 0x2583: [[0, 5, 8, 3]], 0x2584: [[0, 4, 8, 4]],
  0x2585: [[0, 3, 8, 5]], 0x2586: [[0, 2, 8, 6]], 0x2587: [[0, 1, 8, 7]], 0x2588: [[0, 0, 8, 8]],
  0x2589: [[0, 0, 7, 8]], 0x258a: [[0, 0, 6, 8]], 0x258b: [[0, 0, 5, 8]], 0x258c: [[0, 0, 4, 8]],
  0x258d: [[0, 0, 3, 8]], 0x258e: [[0, 0, 2, 8]], 0x258f: [[0, 0, 1, 8]], 0x2590: [[4, 0, 4, 8]],
  0x2594: [[0, 0, 8, 1]], 0x2595: [[7, 0, 1, 8]],
  0x2596: [[0, 4, 4, 4]], 0x2597: [[4, 4, 4, 4]], 0x2598: [[0, 0, 4, 4]],
  0x2599: [[0, 0, 4, 8], [4, 4, 4, 4]], 0x259a: [[0, 0, 4, 4], [4, 4, 4, 4]],
  0x259b: [[0, 0, 8, 4], [0, 4, 4, 4]], 0x259c: [[0, 0, 8, 4], [4, 4, 4, 4]],
  0x259d: [[4, 0, 4, 4]], 0x259e: [[4, 0, 4, 4], [0, 4, 4, 4]], 0x259f: [[4, 0, 4, 8], [0, 4, 4, 4]],
};

// Powerline separators as SVG paths in a 10×20 box (stretched to the cell).
const POWERLINE: Record<number, { d: string; fill: boolean }> = {
  0xe0b0: { d: 'M0 0L10 10L0 20Z', fill: true },
  0xe0b1: { d: 'M0 0L10 10L0 20', fill: false },
  0xe0b2: { d: 'M10 0L0 10L10 20Z', fill: true },
  0xe0b3: { d: 'M10 0L0 10L10 20', fill: false },
  0xe0b4: { d: 'M0 0A10 10 0 0 1 0 20Z', fill: true },
  0xe0b5: { d: 'M0 0A10 10 0 0 1 0 20', fill: false },
  0xe0b6: { d: 'M10 0A10 10 0 0 0 10 20Z', fill: true },
  0xe0b7: { d: 'M10 0A10 10 0 0 0 10 20', fill: false },
  0xe0b8: { d: 'M0 0L10 20L0 20Z', fill: true },
  0xe0ba: { d: 'M10 0L10 20L0 20Z', fill: true },
  0xe0bc: { d: 'M0 0L10 0L0 20Z', fill: true },
  0xe0be: { d: 'M0 0L10 0L10 20Z', fill: true },
};

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

interface Row {
  el: HTMLDivElement;
  html: string;
}

const OVERSCAN = 3;

export class BanglaRenderer {
  readonly el: HTMLDivElement;
  /** Moves as a whole when scrolling; rows sit at `line × lineHeight` inside it. */
  private viewport: HTMLDivElement;
  /** Scaled while pinch-zooming. */
  private zoomLayer: HTMLDivElement;
  private cursorEl: HTMLDivElement;
  private rows = new Map<number, Row>();
  private spare: HTMLDivElement[] = [];
  private palette: string[];
  private measureCtx = document.createElement('canvas').getContext('2d')!;
  private widthCache = new Map<string, number>();
  private cell!: IBufferCell;
  private frame = 0;
  private bufferKey = '';
  private lastBaseY = 0;
  private zoom = 1;

  cellWidth = 8;
  lineHeight = 18;
  /** Pixels scrolled up from the bottom (0 = following output). */
  scrollPx = 0;
  cursorVisible = true;
  focused = false;
  /** Called when the view leaves / returns to the bottom of the output. */
  onScrolled?: (scrolledUp: boolean) => void;
  private wasScrolled = false;

  constructor(private term: Terminal, private opts: RendererOptions) {
    this.el = document.createElement('div');
    this.el.className = 'term-screen';
    this.viewport = document.createElement('div');
    this.viewport.className = 'term-viewport';
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'term-cursor';
    this.el.dataset.cursor = 'block';
    this.zoomLayer = document.createElement('div');
    this.zoomLayer.className = 'term-zoom';
    this.viewport.append(this.cursorEl);
    this.zoomLayer.append(this.viewport);
    this.el.append(this.zoomLayer);
    this.palette = build256(opts.theme);
    this.applyMetrics();
  }

  /** Whole lines scrolled up from the bottom. */
  get scrollOffset(): number {
    return Math.floor(this.scrollPx / this.lineHeight + 1e-6);
  }
  set scrollOffset(lines: number) {
    this.scrollPx = Math.max(0, lines) * this.lineHeight;
  }

  /** Scroll by pixels (positive = back in history). Returns false at an edge. */
  scrollByPixels(px: number): boolean {
    const max = this.term.buffer.active.baseY * this.lineHeight;
    const next = Math.max(0, Math.min(max, this.scrollPx + px));
    const moved = next !== this.scrollPx;
    this.scrollPx = next;
    if (moved) this.schedule();
    return moved;
  }

  setOptions(opts: Partial<RendererOptions>) {
    const lines = this.scrollOffset;
    Object.assign(this.opts, opts);
    this.palette = build256(this.opts.theme);
    this.widthCache.clear();
    this.applyMetrics();
    this.scrollOffset = lines;
    this.invalidate();
  }

  get options(): Readonly<RendererOptions> {
    return this.opts;
  }

  /** Forget every rendered row (font/theme/size changed). */
  invalidate() {
    for (const r of this.rows.values()) this.recycle(r.el);
    this.rows.clear();
    this.schedule();
  }

  /** Visual-only zoom while pinching (cheap); the real font size is set when it ends. */
  previewZoom(scale: number | null) {
    this.zoom = scale ?? 1;
    this.el.style.setProperty('--zoom', String(this.zoom));
    this.el.classList.toggle('zooming', scale !== null);
  }

  private applyMetrics() {
    const { fontSize, theme } = this.opts;
    this.measureCtx.font = `${fontSize}px "JetBrains Mono", monospace`;
    this.cellWidth = this.measureCtx.measureText('MMMMMMMMMM').width / 10;
    this.lineHeight = Math.round(fontSize * 1.45);
    const s = this.el.style;
    s.setProperty('--cw', `${this.cellWidth}px`);
    s.setProperty('--lh', `${this.lineHeight}px`);
    s.setProperty('--fs', `${fontSize}px`);
    s.setProperty('--bn-fs', `${fontSize * this.opts.bnScale}px`);
    s.setProperty('--bw', `${Math.max(1, Math.round(fontSize / 13))}px`);
    s.background = theme.background;
    s.color = theme.foreground;
    this.cursorEl.style.setProperty('--cursor', theme.cursor);
  }

  /** How many columns/rows fit into the given pixel box. */
  fit(width: number, height: number): { cols: number; rows: number } {
    return {
      // minus the screen's padding (8px left/right, 6px top/bottom)
      cols: Math.max(10, Math.floor((width - 16) / this.cellWidth)),
      rows: Math.max(4, Math.floor((height - 12) / this.lineHeight)),
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
    // background-color (not the shorthand) so drawn glyphs keep their background-image
    if (bg) css += `background-color:${bg};`;
    if (bold) css += 'font-weight:700;';
    if (c.isItalic()) css += 'font-style:italic;';
    if (c.isDim()) css += 'opacity:.6;';
    if (c.isInvisible()) css += 'visibility:hidden;';
    const deco = (c.isUnderline() ? ' underline' : '') + (c.isStrikethrough() ? ' line-through' : '') + (c.isOverline() ? ' overline' : '');
    if (deco) css += `text-decoration:${deco};`;
    return { css, bold };
  }

  /** HTML for a character drawn with CSS/SVG, or null if it's an ordinary glyph. */
  private drawn(cp: number, w: number, style: string): string | null {
    const width = `width:${(w * this.cellWidth).toFixed(2)}px;`;
    const arms = BOX_ARMS[cp];
    if (arms) {
      const t = ['', 'var(--bw)', 'calc(var(--bw) * 2)'];
      const img: string[] = [];
      const [u, r, d, l] = arms;
      const g = 'linear-gradient(currentColor,currentColor)';
      if (u) img.push(`${g} 50% 0/${t[u]} calc(50% + ${t[u]} / 2) no-repeat`);
      if (d) img.push(`${g} 50% 100%/${t[d]} calc(50% + ${t[d]} / 2) no-repeat`);
      if (l) img.push(`${g} 0 50%/calc(50% + ${t[l]} / 2) ${t[l]} no-repeat`);
      if (r) img.push(`${g} 100% 50%/calc(50% + ${t[r]} / 2) ${t[r]} no-repeat`);
      return `<span class="dg" style="${width}${style}background:${img.join(',')};${bgOf(style)}"></span>`;
    }
    const round = ROUND[cp];
    if (round) return `<span class="dg" style="${width}${style}"><i class="${round}"></i></span>`;
    const blocks = BLOCKS[cp];
    if (blocks) {
      const g = 'linear-gradient(currentColor,currentColor)';
      const img = blocks.map(([x, y, bw, bh]) =>
        `${g} ${x === 0 ? '0' : `${(x / (8 - bw)) * 100}%`} ${y === 0 ? '0' : `${(y / (8 - bh)) * 100}%`}/${(bw / 8) * 100}% ${(bh / 8) * 100}% no-repeat`);
      return `<span class="dg" style="${width}${style}background:${img.join(',')};${bgOf(style)}"></span>`;
    }
    const pl = POWERLINE[cp];
    if (pl) {
      const paint = pl.fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.2" vector-effect="non-scaling-stroke"';
      return `<span class="dg" style="${width}${style}"><svg viewBox="0 0 10 20" preserveAspectRatio="none"><path d="${pl.d}" ${paint}/></svg></span>`;
    }
    return null;
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
      const st = this.styleOf(c);
      const cp = chars.length ? chars.codePointAt(0)! : 32;
      if ((cp >= 0x2500 && cp <= 0x259f) || (cp >= 0xe0b0 && cp <= 0xe0bf)) {
        const d = this.drawn(cp, w, st.css);
        if (d) {
          flush();
          html += d;
          continue;
        }
      }
      const cls = cpClass(chars);
      if (cls === 'box' || (cls === 'mono' && w > 1)) {
        flush();
        // Nerd Font icons (private use area) are wider than a cell: let them spill into the
        // next cell (usually a space) instead of being clipped, like other terminals do.
        const pua = cp >= 0xe000 && cp <= 0xf8ff;
        html += `<span class="bx${pua ? ' pua' : ''}" style="width:${(w * cw).toFixed(2)}px;${st.css}">${esc(chars)}</span>`;
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

  private recycle(el: HTMLDivElement) {
    el.remove();
    if (this.spare.length < 64) this.spare.push(el);
  }

  render() {
    const term = this.term;
    const buf = term.buffer.active;
    const rows = term.rows;
    const cols = term.cols;
    const lh = this.lineHeight;

    // A different buffer (alt screen), a resize, or old lines dropped off the top of
    // the scrollback all invalidate the line-number → row mapping.
    const key = `${buf.type}|${cols}|${buf.getLine(0)?.translateToString(true).slice(0, 80) ?? ''}`;
    if (key !== this.bufferKey) {
      this.bufferKey = key;
      for (const r of this.rows.values()) this.recycle(r.el);
      this.rows.clear();
    }

    // While scrolled back, keep looking at the same lines when new output arrives.
    if (buf.baseY !== this.lastBaseY) {
      if (this.scrollPx > 0 && buf.baseY > this.lastBaseY) this.scrollPx += (buf.baseY - this.lastBaseY) * lh;
      this.lastBaseY = buf.baseY;
    }
    this.scrollPx = Math.max(0, Math.min(buf.baseY * lh, this.scrollPx));

    const topPx = buf.baseY * lh - this.scrollPx; // y of the first visible pixel row
    const first = Math.max(0, Math.floor(topPx / lh) - OVERSCAN);
    const last = Math.min(buf.length - 1, Math.floor(topPx / lh) + rows + OVERSCAN);

    for (const [i, r] of this.rows) {
      if (i < first || i > last) {
        this.recycle(r.el);
        this.rows.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      let r = this.rows.get(i);
      const live = i >= buf.baseY; // the live screen can still change; scrollback can't
      if (r && !live) continue;
      const html = this.rowToHtml(buf.getLine(i), cols);
      if (!r) {
        const el = this.spare.pop() ?? document.createElement('div');
        el.className = 'term-row';
        el.style.transform = `translateY(${i * lh}px)`;
        el.innerHTML = html;
        this.viewport.append(el);
        this.rows.set(i, { el, html });
      } else if (r.html !== html) {
        r.html = html;
        r.el.innerHTML = html;
      }
    }

    this.viewport.style.transform = `translateY(${(-topPx).toFixed(2)}px)`;
    // Anchored to the bottom: while the keyboard slides in (before the terminal is
    // resized) the prompt stays visible and the top lines are the ones clipped.
    const h = `${rows * lh}px`;
    if (this.zoomLayer.style.height !== h) this.zoomLayer.style.height = h;

    const cursorLine = buf.baseY + buf.cursorY;
    const showCursor = this.cursorVisible && this.scrollPx < lh;
    this.cursorEl.style.display = showCursor ? 'block' : 'none';
    if (showCursor) {
      this.cursorEl.style.transform = `translate(${(buf.cursorX * this.cellWidth).toFixed(2)}px, ${cursorLine * lh}px)`;
      this.cursorEl.classList.toggle('focused', this.focused);
    }
    const scrolled = this.scrollPx >= lh;
    if (scrolled !== this.wasScrolled) {
      this.wasScrolled = scrolled;
      this.onScrolled?.(scrolled);
    }
  }

  /** The cell under a client point: x/y relative to the visible screen, plus the buffer line. */
  cellAt(clientX: number, clientY: number): { x: number; y: number; line: number } {
    const rect = this.viewport.getBoundingClientRect(); // includes the scroll transform
    const buf = this.term.buffer.active;
    const z = this.zoom;
    const line = Math.max(0, Math.min(buf.length - 1, Math.floor((clientY - rect.top) / (this.lineHeight * z))));
    const x = Math.max(0, Math.min(this.term.cols - 1, Math.floor((clientX - rect.left) / (this.cellWidth * z))));
    const y = Math.max(0, Math.min(this.term.rows - 1, line - buf.baseY + this.scrollOffset));
    return { x, y, line };
  }
}

/** The background-color part of a style string (kept when a drawn glyph sets `background`). */
function bgOf(style: string): string {
  const m = /background-color:([^;]+);/.exec(style);
  return m ? `background-color:${m[1]};` : '';
}
