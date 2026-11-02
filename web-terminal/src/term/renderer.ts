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

import type { Terminal, IBufferCell, IBufferLine, IMarker } from '@xterm/headless';

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
  // Pure black (OLED): true #000 background, the same soft accents
  black: {
    background: '#000000',
    foreground: '#e4e6ee',
    cursor: '#f5c2a0',
    ansi: [
      '#16181f', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#cba6f7', '#89dceb', '#bac2de',
      '#3d4152', '#f6a0b8', '#b8ebb4', '#fbe9bf', '#a0c3fb', '#d6baf9', '#a3e4f0', '#ffffff',
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
  // filled shapes reach 0.6 units into the neighbouring cell to hide sub-pixel seams
  0xe0b0: { d: 'M-0.6 0L0 0L10 10L0 20L-0.6 20Z', fill: true },
  0xe0b1: { d: 'M0 0L10 10L0 20', fill: false },
  0xe0b2: { d: 'M10.6 0L10 0L0 10L10 20L10.6 20Z', fill: true },
  0xe0b3: { d: 'M10 0L0 10L10 20', fill: false },
  0xe0b4: { d: 'M-0.6 0L0 0A10 10 0 0 1 0 20L-0.6 20Z', fill: true },
  0xe0b5: { d: 'M0 0A10 10 0 0 1 0 20', fill: false },
  0xe0b6: { d: 'M10.6 0L10 0A10 10 0 0 0 10 20L10.6 20Z', fill: true },
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
  /** Gentle motion: new output lines fade in, the cursor glides, the view slides. */
  animate?: boolean;
}

interface Row {
  el: HTMLDivElement;
  html: string;
  /** Rendered while still on the live screen: refresh once after it scrolls into history. */
  live: boolean;
}

const OVERSCAN = 3;

export class BanglaRenderer {
  /**
   * A floating keyboard is open: Android doesn't say where it is (it takes no room at the
   * bottom), so the line being typed is kept in the upper half, where it usually isn't.
   */
  static floatingKeyboard = false;
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
  // ---- motion ----
  /** Highest buffer line that has been shown with content (new lines past it fade in). */
  private revealedUpTo = -1;
  private suppressReveal = true;
  private lastCursorT = '';
  private lastCursorLine = -1;
  private typingTimer = 0;
  private animBaseY = 0;
  // ---- right-aligned labels (the prompt's clock): drawn by us at the right edge of a
  // line, not text in the terminal, so they stay at the edge through zoom and resize ----
  // `sig` is the line's text once the prompt was drawn on it: when the line no longer
  // reads the same (cleared, redrawn elsewhere after a zoom, overwritten) the label goes.
  private rightLabels: { marker: IMarker; text: string; sig: string; born: number }[] = [];

  /** Show [text] at the right edge of the cursor's line (OSC 7770;rprompt;text). */
  setRightLabel(text: string) {
    if (this.term.buffer.active.type !== 'normal') return;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    // a redraw of the same prompt replaces its label
    this.rightLabels = this.rightLabels.filter((l) => {
      const same = l.marker.isDisposed || l.marker.line === marker.line;
      if (same) l.marker.dispose();
      return !same;
    });
    this.rightLabels.push({ marker, text: text.slice(0, 24), sig: '', born: performance.now() });
    while (this.rightLabels.length > 300) this.rightLabels.shift()!.marker.dispose();
    this.schedule();
  }

  /** After a terminal reset the old buffers (and their markers) are gone. */
  clearLabels() {
    for (const l of this.rightLabels) l.marker.dispose();
    this.rightLabels = [];
    this.schedule();
  }

  /** Labels of the lines first..last that still belong to their prompt. */
  private labelsByLine(first: number, last: number): Map<number, string> {
    const m = new Map<number, string>();
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return m;
    const now = performance.now();
    this.rightLabels = this.rightLabels.filter((l) => {
      if (l.marker.isDisposed) return false;
      const line = l.marker.line;
      if (line < first || line > last) return true; // checked when it's on screen
      const text = buf.getLine(line)?.translateToString(true) ?? '';
      if (!l.sig) {
        if (text.trim()) l.sig = text; // the prompt has been drawn: remember it
        else if (now - l.born > 1500) {
          l.marker.dispose(); // its line stayed empty: the prompt went elsewhere
          return false;
        } else return true;
      } else if (text !== l.sig) {
        l.marker.dispose(); // cleared, overwritten, or the prompt was redrawn elsewhere
        return false;
      }
      m.set(line, l.text);
      return true;
    });
    return m;
  }

  // ---- scrollback trimming (a full scrollback drops its oldest lines) ----
  private trimMarker: IMarker | null = null;
  private trimLine = 0;
  private trimGen = 0;
  // ---- reading history: the line at the top of the view, so a re-wrap (zoom, rotation)
  // keeps showing it (viewFrac: how far into that line the view starts) ----
  private viewMarker: IMarker | null = null;
  private viewFrac = 0;
  private lastCols = 0;
  private disposed = false;

  cellWidth = 8;
  lineHeight = 18;
  /** Pixels scrolled up from the bottom (0 = following output). */
  scrollPx = 0;
  cursorVisible = true;
  focused = false;
  /**
   * Chat-style layout for agent sessions: while what's drawn is shorter than the screen,
   * it sits at the bottom (the prompt box right above the keys), like Claude Code.
   */
  anchorBottom = false;
  /** Chat layout: rows from this line down are moved down by splitGap px (-1 = off). */
  private splitLine = -1;
  private splitGap = 0;
  /** True while the keyboard slides: follow it exactly, no easing. */
  insetsMoving = false;
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
    this.el.classList.toggle('anim', !!opts.animate);
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
    const next = Math.max(0, Math.min(this.maxScroll(), this.scrollPx + px));
    const moved = next !== this.scrollPx;
    this.scrollPx = next;
    if (moved) this.schedule();
    return moved;
  }

  /**
   * How far back the view can go: the whole scrollback, plus what the keyboard pan hides
   * at the top (with the keyboard up, the first lines would be out of reach otherwise).
   */
  private maxScroll(): number {
    return this.term.buffer.active.baseY * this.lineHeight + this.pan;
  }

  /** The session closed: no more frames, timers or markers. */
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.frame);
    this.frame = 0;
    clearTimeout(this.typingTimer);
    this.trimMarker?.dispose();
    this.trimMarker = null;
    this.viewMarker?.dispose();
    this.viewMarker = null;
    for (const l of this.rightLabels) l.marker.dispose();
    this.rightLabels = [];
  }

  setOptions(opts: Partial<RendererOptions>) {
    const lines = this.scrollOffset;
    Object.assign(this.opts, opts);
    this.palette = build256(this.opts.theme);
    this.widthCache.clear();
    this.applyMetrics();
    this.el.classList.toggle('anim', !!this.opts.animate);
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
    this.zoomLayer.style.transitionDuration = '0s';
    this.applyLayerTransform();
  }

  /** Vertical pan of the whole screen (keeps the cursor above the keyboard) + pinch zoom. */
  private pan = 0;
  private applyLayerTransform() {
    const t = `translateY(${(-this.pan).toFixed(1)}px)` + (this.zoom !== 1 ? ` scale(${this.zoom})` : '');
    if (this.zoomLayer.style.transform !== t) this.zoomLayer.style.transform = t;
  }

  // ---- don't show half-drawn frames ----
  /** Time of the last output (set by the session). */
  lastOutput = 0;
  private holdUntil = 0;
  private syncSince = 0;
  /** After a resize, programs clear and redraw: keep the old picture until they're done. */
  holdForRedraw(ms = 300) {
    this.holdUntil = performance.now() + ms;
  }
  private shouldWait(): boolean {
    const now = performance.now();
    // DEC 2026 synchronized output: the program says "frame in progress"
    if (this.term.modes.synchronizedOutputMode) {
      if (!this.syncSince) this.syncSince = now;
      if (now - this.syncSince < 250) return true;
    } else this.syncSince = 0;
    // after a resize: wait until output has been quiet for 60 ms (at most holdForRedraw ms)
    return now < this.holdUntil && now - this.lastOutput < 60;
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

  private lastRenderAt = 0;
  /**
   * New output. After a quiet moment (the echo of a typed key) draw it now, in this frame,
   * instead of waiting for the next one; a stream of output is still drawn once per frame.
   */
  scheduleEager() {
    if (this.frame) return;
    if (performance.now() - this.lastRenderAt > 40) this.render();
    else this.schedule();
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
  private styleOf(c: IBufferCell): { css: string; bold: boolean; italic: boolean } {
    if (c.isAttributeDefault()) return { css: '', bold: false, italic: false };
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
    // the 1px shadow covers sub-pixel seams between neighbouring cells of the same colour
    if (bg) css += `background-color:${bg};box-shadow:1px 0 0 ${bg};`;
    if (bold) css += 'font-weight:700;';
    const italic = !!c.isItalic();
    if (italic) css += 'font-style:italic;';
    if (c.isDim()) css += 'opacity:.6;';
    if (c.isInvisible()) css += 'visibility:hidden;';
    const deco = (c.isUnderline() ? ' underline' : '') + (c.isStrikethrough() ? ' line-through' : '') + (c.isOverline() ? ' overline' : '');
    if (deco) css += `text-decoration:${deco};`;
    return { css, bold, italic };
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
    // Shades ░ ▒ ▓ as a flat translucent fill: a dithered pattern looks like a screen
    // door on a phone (Claude Code's welcome art is made of them).
    const shade = cp === 0x2591 ? 0.25 : cp === 0x2592 ? 0.5 : cp === 0x2593 ? 0.75 : 0;
    if (shade) return `<span class="dg" style="${width}${style}"><i class="sh" style="opacity:${shade}"></i></span>`;
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

    // Latin/symbol run: one style.
    let monoStyle: string | null = null;
    let monoText = '';
    // Bangla run: one *font* (bold/italic) but colours may change from letter to letter —
    // streaming TUIs (like the Antigravity CLI) fade text in with per-letter colours. Each
    // word stays one text node so conjuncts and vowel signs never come apart; pieces carry
    // the colours.
    let bnFont: string | null = null;
    let bnBold = false;
    let bnPieces: { css: string; text: string }[] = [];
    let bnCells = 0;

    const flushMono = () => {
      if (monoStyle === null) return;
      html += monoStyle ? `<span style="${monoStyle}">${esc(monoText)}</span>` : esc(monoText);
      monoStyle = null;
      monoText = '';
    };
    const flushBn = () => {
      if (bnFont === null) return;
      // Keep trailing spaces out of the Bangla run (they belong to the grid), with their
      // colours (a highlighted bar must not get a gap).
      let trailing = 0;
      let trailHtml = '';
      while (bnPieces.length) {
        const last = bnPieces[bnPieces.length - 1];
        const trimmed = last.text.replace(/ +$/, '');
        const n = last.text.length - trimmed.length;
        trailing += n;
        if (n) trailHtml = (last.css ? `<span style="${last.css}">${' '.repeat(n)}</span>` : ' '.repeat(n)) + trailHtml;
        if (trimmed) {
          last.text = trimmed;
          break;
        }
        bnPieces.pop();
      }
      const text = bnPieces.map((p) => p.text).join('');
      const target = (bnCells - trailing) * cw;
      const natural = this.bnWidth(text, bnBold);
      // Programs count Bangla width differently from how wide it really looks, so fit
      // the shaped run to its cells: squeeze it if too wide, or spread the extra space
      // between words (never inside a word — that would break conjuncts).
      let inner = '';
      if (natural > target + 0.5) {
        const r = Math.max(0.5, target / natural);
        inner = ` style="transform:scaleX(${r.toFixed(4)})"`;
      } else if (natural < target - 1) {
        const spaces = (text.match(/ /g) ?? []).length;
        if (spaces) {
          const ws = Math.min((target - natural) / spaces, cw * 1.5);
          inner = ` style="word-spacing:${ws.toFixed(2)}px"`;
        }
      }
      const font = (bnBold ? 'font-weight:700;' : '') + (bnFont.includes('i') ? 'font-style:italic;' : '');
      const body = bnPieces.map((p) => (p.css ? `<span style="${p.css}">${esc(p.text)}</span>` : esc(p.text))).join('');
      html += `<span class="bn" style="width:${target.toFixed(2)}px;${font}"><span class="bi"${inner}>${body}</span></span>`;
      html += trailHtml;
      bnFont = null;
      bnPieces = [];
      bnCells = 0;
    };
    const addBn = (css: string, chars: string, w: number) => {
      const last = bnPieces[bnPieces.length - 1];
      // Chrome won't shape a Bangla word across differently coloured spans, so a word
      // keeps the colour of its first letter; colours may change between words.
      const midWord = last && chars !== ' ' && !last.text.endsWith(' ');
      if (last && (last.css === css || midWord)) last.text += chars;
      else bnPieces.push({ css, text: chars });
      bnCells += w;
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
          flushMono();
          flushBn();
          html += d;
          continue;
        }
      }
      const cls = cpClass(chars);
      if (cls === 'bn') {
        const font = (st.bold ? 'b' : '') + (st.italic ? 'i' : '');
        // a vowel sign / virama always stays with the letter before it
        if (bnFont !== null && (bnFont === font || isBnMark(cp))) {
          addBn(st.css, chars, w);
          continue;
        }
        flushMono();
        flushBn();
        bnFont = font;
        bnBold = st.bold;
        addBn(st.css, chars, w);
        continue;
      }
      if (cls === 'space' && bnFont !== null) {
        // spaces inside a Bangla sentence stay in the shaped run
        addBn(st.css, ' ', 1);
        continue;
      }
      flushBn();
      if (cls === 'box' || (cls === 'mono' && w > 1)) {
        flushMono();
        // Nerd Font icons (private use area) are wider than a cell: let them spill into the
        // next cell (usually a space) instead of being clipped, like other terminals do.
        const pua = cp >= 0xe000 && cp <= 0xf8ff;
        const sym = !pua && cp >= 0x2100 && cp <= 0x2bff;
        html += `<span class="bx${pua ? ' pua' : sym ? ' sym' : ''}" style="width:${(w * cw).toFixed(2)}px;${st.css}">${esc(chars)}</span>`;
        continue;
      }
      const text = cls === 'space' ? ' ' : chars;
      if (monoStyle === st.css) {
        monoText += text;
        continue;
      }
      flushMono();
      monoStyle = st.css;
      monoText = text;
    }
    flushMono();
    flushBn();
    return html;
  }

  private recycle(el: HTMLDivElement) {
    el.remove();
    el.classList.remove('row-in');
    el.style.animationDelay = '';
    if (this.spare.length < 64) this.spare.push(el);
  }

  /**
   * How many lines were trimmed off the top of the buffer since the last call: 0 if none
   * (or after a re-wrap, which rebuilds the rows anyway); unknown → the rows are rebuilt.
   * Uses a marker on the newest scrollback line: xterm moves it up as lines are trimmed
   * and disposes it when its line goes — while lines inserted or deleted on the screen
   * (TUIs, ble.sh) don't move it, unlike a marker on any line of the screen.
   */
  private checkTrim(normal: boolean, reflowed: boolean): number {
    const m = this.trimMarker;
    if (!normal) {
      // alternate screen: no scrollback (switching buffers rebuilds the rows anyway)
      m?.dispose();
      this.trimMarker = null;
      return 0;
    }
    let trimmed = 0;
    if (m) {
      trimmed = m.isDisposed || m.line < 0 ? -1 : this.trimLine - m.line;
      m.dispose();
    }
    if (reflowed) trimmed = 0;
    if (trimmed < 0) {
      this.trimGen++; // lost track: rebuild
      trimmed = 0;
    }
    const buf = this.term.buffer.active;
    // (no scrollback yet: every row is still live and gets redrawn anyway)
    this.trimMarker = buf.baseY > 0 ? this.term.registerMarker(-(buf.cursorY + 1)) ?? null : null;
    this.trimLine = this.trimMarker?.line ?? 0;
    return trimmed;
  }

  /** Cells up to the last one with text (wide characters count as two). */
  private usedCells(line: IBufferLine, cols: number): number {
    for (let x = Math.min(cols, line.length) - 1; x >= 0; x--) {
      const c = (this.cell = line.getCell(x, this.cell) ?? this.cell);
      if (c && (c.getWidth() === 0 || c.getChars() !== '')) return x + 1;
    }
    return 0;
  }

  private shiftRows(n: number) {
    const lh = this.lineHeight;
    const moved = new Map<number, Row>();
    for (const [i, r] of this.rows) {
      if (i - n < 0) this.recycle(r.el);
      else {
        r.el.style.transform = `translateY(${(i - n) * lh}px)`;
        moved.set(i - n, r);
      }
    }
    this.rows = moved;
    this.revealedUpTo -= n;
    // reading history: keep the same lines in view
    if (this.scrollPx > 0) this.scrollPx += n * lh;
  }

  render() {
    if (this.disposed) return;
    this.lastRenderAt = performance.now();
    if (this.shouldWait()) {
      if (!this.frame) this.frame = window.setTimeout(() => { this.frame = 0; this.render(); }, 20) as unknown as number;
      return;
    }
    const term = this.term;
    const buf = term.buffer.active;
    const rows = term.rows;
    const cols = term.cols;
    const lh = this.lineHeight;

    // Lines dropped off the top of a full scrollback (or cleared with it) shift every
    // line number down: move the rendered rows along instead of rebuilding them.
    const reflowed = this.lastCols !== 0 && cols !== this.lastCols;
    this.lastCols = cols;
    const trimmed = this.checkTrim(buf.type === 'normal', reflowed);
    if (trimmed > 0) this.shiftRows(trimmed);

    // A different buffer (alt screen), a resize (reflow), or a trim we couldn't measure
    // invalidate the line → row mapping.
    const key = `${buf.type}|${cols}|${this.trimGen}`;
    if (key !== this.bufferKey) {
      this.bufferKey = key;
      for (const r of this.rows.values()) this.recycle(r.el);
      this.rows.clear();
      // whatever is on screen now is not "new output"
      this.suppressReveal = true;
      this.revealedUpTo = -1;
      for (let i = buf.length - 1; i >= buf.baseY; i--) {
        if (buf.getLine(i)?.translateToString(true)) { this.revealedUpTo = i; break; }
      }
    }

    // While scrolled back, keep looking at the same lines: when new output arrives, and
    // when the lines were re-wrapped to a new width (zoom, rotation).
    const vm = this.viewMarker;
    if (reflowed && this.scrollPx > 0 && buf.type === 'normal' && vm && !vm.isDisposed && vm.line >= 0) {
      this.scrollPx = (buf.baseY - vm.line - this.viewFrac) * lh;
      this.lastBaseY = buf.baseY;
    } else if (buf.baseY !== this.lastBaseY) {
      if (this.scrollPx > 0 && buf.baseY > this.lastBaseY) this.scrollPx += (buf.baseY - this.lastBaseY) * lh;
      this.lastBaseY = buf.baseY;
    }
    this.scrollPx = Math.max(0, Math.min(this.maxScroll(), this.scrollPx));

    const topPx = buf.baseY * lh - this.scrollPx; // y of the first visible pixel row
    if (this.scrollPx > 0 && buf.type === 'normal') {
      const topLine = Math.max(0, Math.floor(topPx / lh));
      if (!vm || vm.isDisposed || vm.line !== topLine) {
        vm?.dispose();
        this.viewMarker = this.term.registerMarker(topLine - (buf.baseY + buf.cursorY)) ?? null;
      }
      this.viewFrac = Math.max(0, topPx / lh - topLine);
    } else if (vm) {
      vm.dispose();
      this.viewMarker = null;
    }
    const first = Math.max(0, Math.floor(topPx / lh) - OVERSCAN);
    const last = Math.min(buf.length - 1, Math.floor(topPx / lh) + rows + OVERSCAN);

    for (const [i, r] of this.rows) {
      if (i < first || i > last) {
        this.recycle(r.el);
        this.rows.delete(i);
      }
    }
    const cursorLine = buf.baseY + buf.cursorY;
    const motion = !!this.opts.animate && buf.type === 'normal';

    // The last line drawn: the cursor's (plus one), or anything below it (a completion
    // menu, a TUI's footer).
    const visible = this.el.clientHeight - 12;
    let lastY = buf.cursorY + 1;
    for (let y = rows - 1; y > lastY; y--) {
      if (buf.getLine(buf.baseY + y)?.translateToString(true)) {
        lastY = y;
        break;
      }
    }
    // Chat layout for agent sessions (Antigravity, Claude Code): while the conversation is
    // shorter than the screen, its header stays at the top and the input box — from the
    // rule line above the prompt down to the footer — sits at the bottom, like a chat app.
    let splitLine = -1;
    let splitGap = 0;
    if (this.anchorBottom && !BanglaRenderer.floatingKeyboard && buf.type === 'normal' && buf.baseY === 0 && this.scrollPx === 0 && visible > 0) {
      const free = visible - (lastY + 1) * lh;
      if (free >= lh) {
        for (let y = buf.cursorY - 1; y >= Math.max(0, buf.cursorY - 8); y--) {
          if (isRule(buf.getLine(y)?.translateToString(true) ?? '')) {
            splitLine = y;
            break;
          }
        }
        if (splitLine >= 0) splitGap = free;
      }
    }
    const rowY = (i: number) => i * lh + (splitLine >= 0 && i >= splitLine ? splitGap : 0);
    const splitMoved = splitLine !== this.splitLine || splitGap !== this.splitGap;
    if (splitMoved) {
      this.splitLine = splitLine;
      this.splitGap = splitGap;
      for (const [i, r] of this.rows) r.el.style.transform = `translateY(${rowY(i)}px)`;
    }
    const canReveal = motion && !this.suppressReveal && this.scrollPx === 0;
    const revealed: HTMLDivElement[] = [];
    const labels = this.labelsByLine(first, last);
    for (let i = first; i <= last; i++) {
      let r = this.rows.get(i);
      const live = i >= buf.baseY; // the live screen can still change; scrollback can't
      if (r && !live && !r.live) continue;
      if (r) r.live = live;
      const line = buf.getLine(i);
      let label = labels.get(i);
      // never cover text: only when the row leaves room at its right end (zoomed in,
      // re-wrapped, or a wide prompt bar → no clock on that row)
      if (label && line && this.usedCells(line, cols) > cols - 13) label = undefined;
      const html = this.rowToHtml(line, cols) + (label ? `<span class="rlabel"><b>\uf017</b>${esc(label)}</span>` : '');
      let el: HTMLDivElement | null = null;
      if (!r) {
        el = this.spare.pop() ?? document.createElement('div');
        el.className = 'term-row';
        el.style.transform = `translateY(${rowY(i)}px)`;
        el.innerHTML = html;
        this.viewport.append(el);
        this.rows.set(i, { el, html, live });
      } else if (r.html !== html) {
        r.html = html;
        r.el.innerHTML = html;
        el = r.el;
      }
      // A line getting content for the first time is new output: let it fade in. Not the
      // line being typed on (that would make typing feel slow).
      if (el && i > this.revealedUpTo && live && line?.translateToString(true)) {
        this.revealedUpTo = i;
        if (canReveal && i !== cursorLine) revealed.push(el);
      }
    }
    this.suppressReveal = false;
    // Too much at once (cat of a big file) — just show it.
    if (revealed.length && revealed.length <= rows) {
      revealed.forEach((el, k) => {
        el.style.animationDelay = k ? `${Math.min(k, 8) * 18}ms` : '';
        el.classList.add('row-in');
      });
    }

    // New output scrolling the screen: slide instead of jumping (only while following
    // the output, and only for a few lines — a flood just jumps).
    const grew = buf.baseY - this.animBaseY;
    this.animBaseY = buf.baseY;
    const slide = motion && this.scrollPx === 0 && grew > 0 && grew <= 4;
    const dur = slide ? '140ms' : '0s';
    if (this.viewport.style.transitionDuration !== dur) this.viewport.style.transitionDuration = dur;
    this.viewport.style.transform = `translateY(${(-topPx).toFixed(2)}px)`;
    const h = `${rows * lh}px`;
    if (this.zoomLayer.style.height !== h) this.zoomLayer.style.height = h;
    // When the keyboard covers part of the screen the terminal is NOT resized (that makes
    // programs redraw and flicker); instead the screen slides up just enough to keep the
    // cursor — and a line of context under it — visible. A prompt at the top never moves.
    if (this.scrollPx === 0) {
      const overflow = rows * lh - visible;
      const below = (lastY + 1) * lh - visible;
      let pan = 0;
      if (splitLine >= 0) {
        pan = 0; // the chat layout already fits the screen
      } else if (BanglaRenderer.floatingKeyboard) {
        // the input line (and what's drawn under it) in the upper half of the screen
        pan = Math.max(0, Math.min((lastY + 1) * lh - visible * 0.5, buf.cursorY * lh));
      } else if (overflow > 0) {
        // keep the cursor visible, and what's drawn under it while the cursor still fits
        pan = Math.max(0, Math.min(overflow, below, buf.cursorY * lh));
      }
      // ease small moves that come from new content; follow the keyboard exactly
      const d = Math.abs(pan - this.pan);
      const ease = motion && !this.insetsMoving && this.zoom === 1 && d > 0 && d <= 4 * lh;
      const dur = ease ? '160ms' : '0s';
      if (this.zoomLayer.style.transitionDuration !== dur) this.zoomLayer.style.transitionDuration = dur;
      this.pan = pan;
    }
    this.applyLayerTransform();

    const showCursor = this.cursorVisible && this.scrollPx < lh;
    const wasShown = this.cursorEl.style.display !== 'none';
    this.cursorEl.style.display = showCursor ? 'block' : 'none';
    if (showCursor) {
      // cursorX == cols while a line wrap is pending: keep it on the grid
      const t = `translate(${(Math.min(buf.cursorX, cols - 1) * this.cellWidth).toFixed(2)}px, ${rowY(cursorLine)}px)`;
      if (t !== this.lastCursorT) {
        // glide to the next cell / line; jump when it reappears or moves far (TUIs)
        // jump when it reappears, moves far (TUIs), or the layout itself moved
        // Typing moves it along its line: there it jumps at once (a glide trails behind the
        // letters and makes typing feel slow). It glides only to another line (after Enter).
        const sameLine = cursorLine === this.lastCursorLine;
        const far = !wasShown || sameLine || Math.abs(cursorLine - this.lastCursorLine) > 2 || splitMoved || this.insetsMoving;
        this.cursorEl.style.transitionDuration = motion && !far ? '' : '0s';
        this.cursorEl.style.transform = t;
        this.lastCursorT = t;
        this.lastCursorLine = cursorLine;
        // keep it solid while it moves (typing); blink again when it rests
        this.cursorEl.classList.add('moving');
        clearTimeout(this.typingTimer);
        this.typingTimer = window.setTimeout(() => this.cursorEl.classList.remove('moving'), 600);
      }
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
    const lh = this.lineHeight;
    let py = (clientY - rect.top) / z;
    if (this.splitLine >= 0 && py >= this.splitLine * lh) {
      // below the chat layout's gap: undo the shift (inside the gap: the line above it)
      py = py >= this.splitLine * lh + this.splitGap ? py - this.splitGap : this.splitLine * lh - 1;
    }
    const line = Math.max(0, Math.min(buf.length - 1, Math.floor(py / lh)));
    const x = Math.max(0, Math.min(this.term.cols - 1, Math.floor((clientX - rect.left) / (this.cellWidth * z))));
    const y = Math.max(0, Math.min(this.term.rows - 1, line - buf.baseY + this.scrollOffset));
    return { x, y, line };
  }
}

/** A horizontal rule drawn with box characters (the border of a TUI's input box). */
function isRule(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  let n = 0;
  for (const ch of t) if ('─━╌╍┄┅═'.includes(ch)) n++;
  return n / t.length >= 0.8;
}

/** Bengali vowel signs, virama, candrabindu/anusvara/visarga, nukta, au length mark. */
function isBnMark(cp: number): boolean {
  return (cp >= 0x0981 && cp <= 0x0983) || cp === 0x09bc || (cp >= 0x09be && cp <= 0x09cd) || cp === 0x09d7;
}

/** The background-color part of a style string (kept when a drawn glyph sets `background`). */
function bgOf(style: string): string {
  const m = /background-color:([^;]+);/.exec(style);
  return m ? `background-color:${m[1]};` : '';
}
