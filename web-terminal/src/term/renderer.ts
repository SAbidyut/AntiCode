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

import type { Terminal, IBuffer, IBufferCell, IBufferLine, IMarker } from '@xterm/headless';
import { isRule } from './lineedit';

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

/** Rows drawn beyond each edge of the screen: a fast fling never shows a row not yet drawn. */
const OVERSCAN = 10;
/** The keyboard pan goes where the cursor was for most (60 %) of this long (ms). */
const PAN_WINDOW_MS = 500;
/** How long a moment's miss of an agent's input box is bridged (no layout flip-flop). */
const BOX_MEMORY_MS = 400;

export class BanglaRenderer {
  /**
   * A floating keyboard is open: Android doesn't say where it is (it takes no room at the
   * bottom), so in a portrait shell the line being typed is kept in the upper half, where it
   * usually isn't. (Not an agent's input box, which stays at the bottom, nor in landscape,
   * where the keyboard floats over a part of a wide screen: it can be moved off the line.)
   */
  static floatingKeyboard = false;
  readonly el: HTMLDivElement;
  /** Moves as a whole when scrolling; rows sit at `line × lineHeight` inside it. */
  private viewport: HTMLDivElement;
  /** Slides up as a whole to keep the cursor above the keyboard (see pan). */
  private zoomLayer: HTMLDivElement;
  private cursorEl: HTMLDivElement;
  private rows = new Map<number, Row>();
  private spare: HTMLDivElement[] = [];
  private palette: string[];
  /** One 1×1 canvas measures text for every terminal (each used to keep a canvas of its own). */
  private static measureCtx: CanvasRenderingContext2D | null = null;
  private static measurer(): CanvasRenderingContext2D {
    if (!BanglaRenderer.measureCtx) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      BanglaRenderer.measureCtx = canvas.getContext('2d')!;
    }
    return BanglaRenderer.measureCtx;
  }
  /** A cell's width and a row's height at a text size. */
  static metrics(fontSize: number): { cellWidth: number; lineHeight: number } {
    const ctx = BanglaRenderer.measurer();
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
    return { cellWidth: ctx.measureText('MMMMMMMMMM').width / 10, lineHeight: Math.round(fontSize * 1.45) };
  }
  /** How many columns/rows of [fontSize] text fit into a pixel box. */
  static gridFor(fontSize: number, width: number, height: number): { cols: number; rows: number } {
    const { cellWidth, lineHeight } = BanglaRenderer.metrics(fontSize);
    return {
      // minus the screen's padding (8px left/right, 6px top/bottom)
      cols: Math.max(10, Math.floor((width - 16) / cellWidth)),
      rows: Math.max(4, Math.floor((height - 12) / lineHeight)),
    };
  }
  private widthCache = new Map<string, number>();
  private cell!: IBufferCell;
  private probe: IBufferCell | undefined;
  private frame = 0;
  private bufferKey = '';
  private lastBaseY = 0;
  // ---- motion ----
  /** Highest buffer line that has been shown with content (new lines past it fade in). */
  private revealedUpTo = -1;
  /** Whatever is on screen at the next frame is not "new output" (no fade-in). */
  suppressReveal = true;
  private lastCursorT = '';
  private lastCursorLine = -1;
  private cursorOnTop = false;
  private typingTimer = 0;
  // ---- the cursor's blink ----
  // Two style changes a second, from a timer. As an endless CSS animation it had the
  // compositor wake for every frame — the whole view drawn again 60+ times a second — for
  // as long as the keyboard was up, on a screen where nothing moves.
  private blinkTimer = 0;
  private blinking = false;
  private setBlink(on: boolean) {
    if (on === this.blinking) return;
    this.blinking = on;
    clearInterval(this.blinkTimer);
    this.blinkTimer = 0;
    const marks = (dim: boolean) => {
      for (const c of [this.cursorEl, this.dockCursor]) {
        c?.classList.toggle('blink', on);
        c?.classList.toggle('dim', dim);
      }
    };
    marks(false);
    if (!on) return;
    let dim = false;
    this.blinkTimer = window.setInterval(() => marks((dim = !dim)), 550);
  }
  /** Blinks while it rests in a focused terminal that's being drawn. */
  private updateBlink() {
    this.setBlink(this.focused && !this.typingTimer && !this.offscreen && !this.disposed &&
      this.cursorEl.style.display !== 'none');
  }
  private animBaseY = 0;
  // ---- right-aligned labels (the prompt's clock): drawn by us at the right edge of a
  // line, not text in the terminal, so they stay at the edge through zoom and resize ----
  // `sig` is the line's text once the prompt was drawn on it: when the line no longer
  // reads the same (cleared, redrawn elsewhere after a zoom, overwritten) the label goes.
  private rightLabels: { marker: IMarker; text: string; sig: string; born: number; note: boolean }[] = [];

  /** Show [text] at the right edge of the cursor's line (OSC 7770;rprompt;text). */
  /** ([note]: plain grey text — a prompt's "5s" — not the clock's pill) */
  setRightLabel(text: string, note = false) {
    if (this.term.buffer.active.type !== 'normal') return;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    // a redraw of the same prompt replaces its label
    this.rightLabels = this.rightLabels.filter((l) => {
      const same = l.marker.isDisposed || l.marker.line === marker.line;
      if (same) l.marker.dispose();
      return !same;
    });
    this.rightLabels.push({ marker, text: text.slice(0, 24), sig: '', born: performance.now(), note });
    while (this.rightLabels.length > 300) this.rightLabels.shift()!.marker.dispose();
    this.schedule();
  }

  // ---- the prompt's bar lines (OSC 7770;bar): their text drawn smaller, as in Settings'
  // pictures of the prompt styles (11.5 px text in a 21 px row) — the cells stay as they are
  private barLines: { marker: IMarker; sig: string; born: number }[] = [];

  /** The cursor's line is a prompt's bar line (OSC 7770;bar). */
  markBarLine() {
    if (this.term.buffer.active.type !== 'normal') return;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    this.barLines = this.barLines.filter((b) => {
      const same = b.marker.isDisposed || b.marker.line === marker.line;
      if (same) b.marker.dispose();
      return !same;
    });
    this.barLines.push({ marker, sig: '', born: performance.now() });
    while (this.barLines.length > 300) this.barLines.shift()!.marker.dispose();
    this.schedule();
  }

  /** After a terminal reset the old buffers (and their markers) are gone. */
  clearLabels() {
    for (const l of this.rightLabels) l.marker.dispose();
    this.rightLabels = [];
    for (const b of this.barLines) b.marker.dispose();
    this.barLines = [];
    this.schedule();
  }

  /**
   * Whether a mark on a line still belongs to its prompt: the line's text once the prompt
   * was drawn on it is remembered; when the line no longer starts with it (cleared,
   * overwritten, the prompt redrawn elsewhere) the mark goes. Typing after a one-line
   * prompt keeps it. A line that stayed empty: the prompt went elsewhere.
   */
  private stillPrompt(m: { marker: IMarker; sig: string; born: number }, text: string, now: number): boolean | null {
    if (!m.sig) {
      if (text.trim()) m.sig = text;
      else if (now - m.born > 1500) return false;
      else return null; // not drawn yet
    } else if (!text.startsWith(m.sig)) return false;
    return true;
  }

  /** Bar lines among first..last. */
  private barsByLine(first: number, last: number): Set<number> {
    const set = new Set<number>();
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal' || !this.barLines.length) return set;
    const now = performance.now();
    this.barLines = this.barLines.filter((b) => {
      if (b.marker.isDisposed) return false;
      const line = b.marker.line;
      if (line < first || line > last) return true;
      const ok = this.stillPrompt(b, buf.getLine(line)?.translateToString(true) ?? '', now);
      if (ok === false) {
        b.marker.dispose();
        return false;
      }
      if (ok) set.add(line);
      return true;
    });
    return set;
  }

  /** Labels of the lines first..last that still belong to their prompt. */
  private labelsByLine(first: number, last: number): Map<number, { text: string; note: boolean }> {
    const m = new Map<number, { text: string; note: boolean }>();
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return m;
    const now = performance.now();
    this.rightLabels = this.rightLabels.filter((l) => {
      if (l.marker.isDisposed) return false;
      const line = l.marker.line;
      if (line < first || line > last) return true; // checked when it's on screen
      const ok = this.stillPrompt(l, buf.getLine(line)?.translateToString(true) ?? '', now);
      if (ok === false) {
        l.marker.dispose();
        return false;
      }
      if (!ok) return true; // not drawn yet
      m.set(line, { text: l.text, note: l.note });
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
  /** The scrollback lost lines at its top (a full scrollback, a clear): line numbers moved. */
  onLinesRenumbered?: (shift: number) => void;
  /** Chat layout: rows from this line down are moved down by splitGap px (-1 = off). */
  private splitLine = -1;
  private splitGap = 0;
  /**
   * Chat layout with a scrollback: how far the view shows earlier lines at the top so the
   * input box sits at the bottom, not above empty rows (px).
   */
  private lift = 0;
  /** True while the keyboard slides: follow it exactly, no easing. */
  insetsMoving = false;
  /** Lift the input line above a floating keyboard (not for the Settings preview). */
  floatPan = true;
  /**
   * Smart keyboard: the word being composed (not in the terminal yet), drawn at the cursor
   * like the keyboard's own underlined text in a chat app.
   */
  /** A password is being asked for: the keyboard's text isn't drawn (the program shows none). */
  private hiddenInput = false;
  setHiddenInput(on: boolean) {
    if (on === this.hiddenInput) return;
    this.hiddenInput = on;
    this.schedule();
  }

  preedit = '';
  private preeditEl: HTMLSpanElement;
  private preeditHtml = '';
  setPreedit(text: string) {
    if (text === this.preedit) return;
    this.preedit = text;
    this.schedule();
  }
  /**
   * Text the keyboard just sent, drawn (plainly) where it goes until the program echoes it
   * — otherwise a finished word vanished for a moment on every space or suggestion tap.
   */
  private ghost = '';
  /** Where the cursor was when the ghost / the hold began: either ends when it moves. */
  private waitAt: { line: number; x: number; until: number } | null = null;
  /** The keyboard took letters back (⌫ sent): the word being composed waits for them to go. */
  private holdPreedit = false;
  /** (call before setPreedit) */
  awaitEcho(kind: 'text' | 'deletes', text = '') {
    const buf = this.term.buffer.active;
    this.ghost = kind === 'text' ? text : '';
    this.holdPreedit = kind === 'deletes';
    this.waitAt = { line: buf.baseY + buf.cursorY, x: buf.cursorX, until: performance.now() + 280 };
    window.setTimeout(() => this.schedule(), 300);
    this.schedule();
  }
  /**
   * Text selected in the line being typed: a highlight per row, and a handle at each end to
   * drag (see LineEditor).
   */
  private selection: { ranges: { line: number; x0: number; x1: number }[]; a: { line: number; x: number }; b: { line: number; x: number } } | null = null;
  private selEl: HTMLDivElement | null = null;
  private selBoxes: HTMLDivElement | null = null;
  private selHandles: HTMLDivElement[] = [];
  private selKey = '';
  /** A selection handle is dragged (a = start, b = end). */
  onHandle?: (end: 'a' | 'b', phase: 'down' | 'move' | 'up', clientX: number, clientY: number) => void;
  /** Drawn (or moved with the screen): the app keeps its Copy / Paste bar next to it. */
  onSelectionDrawn?: () => void;
  setSelection(sel: BanglaRenderer['selection']) {
    this.selection = sel;
    this.schedule();
  }
  /** Where the selection is on the screen (client px), or null. */
  selectionRect(): { left: number; top: number; right: number; bottom: number } | null {
    if (!this.selection || !this.selBoxes || this.selEl?.hidden) return null;
    let r: { left: number; top: number; right: number; bottom: number } | null = null;
    for (const el of [...this.selBoxes.children, ...this.selHandles]) {
      const b = el.getBoundingClientRect();
      r = r ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) } : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    return r;
  }
  /** Fractional cell column under a client x (a tap between two letters picks the nearer gap). */
  colAt(clientX: number): number {
    const rect = this.viewport.getBoundingClientRect();
    return Math.max(0, Math.min(this.term.cols, (clientX - rect.left) / this.cellWidth));
  }

  private drawSelection(rowY: (i: number) => number, first: number, last: number) {
    const sel = this.selection;
    if (!sel) {
      if (this.selEl && !this.selEl.hidden) {
        this.selEl.hidden = true;
        this.selKey = '';
      }
      return;
    }
    if (!this.selEl) {
      const el = (this.selEl = document.createElement('div'));
      el.className = 'term-sel';
      this.selBoxes = document.createElement('div');
      el.append(this.selBoxes);
      for (const end of ['a', 'b'] as const) {
        const h = document.createElement('div');
        h.className = `sel-h ${end}`;
        const report = (phase: 'down' | 'move' | 'up') => (e: PointerEvent) => {
          // the screen's own gestures (scroll, tap) must not see a handle being dragged
          e.stopPropagation();
          if (phase === 'down') {
            e.preventDefault();
            h.setPointerCapture(e.pointerId);
          } else if (!h.hasPointerCapture(e.pointerId)) return;
          if (phase === 'up') h.releasePointerCapture(e.pointerId);
          this.onHandle?.(end, phase, e.clientX, e.clientY);
        };
        h.addEventListener('pointerdown', report('down'));
        h.addEventListener('pointermove', report('move'));
        h.addEventListener('pointerup', report('up'));
        h.addEventListener('pointercancel', report('up'));
        this.selHandles.push(h);
        el.append(h);
      }
      this.viewport.append(el);
    }
    this.selEl.hidden = false;
    const cw = this.cellWidth;
    const lh = this.lineHeight;
    // (only the rows being drawn: a selection of a whole long history has thousands)
    const key = `${sel.ranges.length > 60 ? sel.ranges.length : JSON.stringify(sel.ranges)}|${JSON.stringify(sel.a)}|${JSON.stringify(sel.b)}|${first}|${last}|${cw}|${lh}|${rowY(sel.a.line)}|${rowY(sel.b.line)}`;
    if (key !== this.selKey) {
      this.selKey = key;
      this.selBoxes!.innerHTML = sel.ranges
        .filter((r) => r.x1 > r.x0 && r.line >= first && r.line <= last)
        .map((r) => `<i style="transform:translate(${(r.x0 * cw).toFixed(2)}px,${rowY(r.line)}px);width:${((r.x1 - r.x0) * cw).toFixed(2)}px"></i>`)
        .join('');
      const [ha, hb] = this.selHandles;
      ha.style.transform = `translate(${(sel.a.x * cw).toFixed(2)}px, ${rowY(sel.a.line) + lh}px)`;
      hb.style.transform = `translate(${(sel.b.x * cw).toFixed(2)}px, ${rowY(sel.b.line) + lh}px)`;
    }
    this.onSelectionDrawn?.();
  }

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
    this.preeditEl = document.createElement('span');
    this.preeditEl.className = 'term-preedit';
    this.preeditEl.style.display = 'none';
    this.viewport.append(this.cursorEl, this.preeditEl);
    // a row's fade-in plays once: without the class it doesn't replay when the session is
    // shown again (display:none → visible restarts animations)
    this.viewport.addEventListener('animationend', (e) => {
      const t = e.target as HTMLElement;
      if (!t.classList.contains('row-in')) return;
      t.classList.remove('row-in');
      t.style.animationDelay = '';
    });
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
    if (!Number.isFinite(px)) return false;
    const next = Math.max(0, Math.min(this.maxScroll(), this.scrollPx + px));
    const moved = next !== this.scrollPx;
    this.scrollPx = next;
    if (moved) this.schedule();
    return moved;
  }

  // ---- pulled past an end (the rubber band) ----
  private overscroll = 0;
  private overscrollAnim: Animation | null = null;
  /** (older WebViews have no `translate` property: no stretch there, nothing breaks) */
  private static canStretch = typeof CSS !== 'undefined' && !!CSS.supports?.('translate', '0 1px');
  /** The most the content follows a pull past an end. */
  get maxOverscroll() {
    return Math.max(40, this.el.clientHeight * 0.12);
  }
  /** Scrolled into the top or bottom and still pulling: the content follows a little. */
  setOverscroll(px: number) {
    if (!BanglaRenderer.canStretch) return;
    this.overscroll = px;
    this.overscrollAnim?.cancel();
    this.overscrollAnim = null;
    this.zoomLayer.style.translate = px ? `0 ${px.toFixed(1)}px` : '';
  }
  /** Let go: it springs back. */
  releaseOverscroll() {
    const from = this.overscroll;
    if (!from) return;
    this.setOverscroll(0);
    if (!this.opts.animate) return;
    this.overscrollAnim = this.zoomLayer.animate([{ translate: `0 ${from.toFixed(1)}px` }, { translate: '0 0' }], {
      duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
    this.overscrollAnim.id = 'overscroll';
  }
  /** A fling ran into an end at [v] px/ms: a short bounce. */
  bounce(v: number) {
    if (!this.opts.animate || !BanglaRenderer.canStretch) return;
    // gentle: a hint that the end is here, not a jump
    const lim = this.maxOverscroll * 0.45;
    const amp = Math.max(-lim, Math.min(lim, v * 14));
    if (Math.abs(amp) < 4) return;
    this.setOverscroll(0);
    this.overscrollAnim = this.zoomLayer.animate(
      [{ translate: '0 0' }, { translate: `0 ${amp.toFixed(1)}px`, offset: 0.28 }, { translate: '0 0' }],
      { duration: 460, easing: 'cubic-bezier(0.25, 0.8, 0.35, 1)' },
    );
    this.overscrollAnim.id = 'overscroll';
  }

  /**
   * How far back the view can go: the whole scrollback, plus what the keyboard pan hides
   * at the top (with the keyboard up, the first lines would be out of reach otherwise).
   */
  private maxScroll(): number {
    return Math.max(0, this.term.buffer.active.baseY * this.lineHeight + this.pan - this.lift);
  }

  /** The session closed: no more frames, timers or markers. */
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.frame);
    this.frame = 0;
    clearTimeout(this.typingTimer);
    this.typingTimer = 0;
    clearTimeout(this.panTimer);
    clearTimeout(this.boxTimer);
    this.setBlink(false);
    this.overscrollAnim?.cancel();
    this.overscrollAnim = null;
    this.dropGhost();
    this.trimMarker?.dispose();
    this.trimMarker = null;
    this.viewMarker?.dispose();
    this.viewMarker = null;
    for (const l of this.rightLabels) l.marker.dispose();
    this.rightLabels = [];
    for (const b of this.barLines) b.marker.dispose();
    this.barLines = [];
    // (the rows and their cached HTML go with the session, not when the page does)
    this.rows.clear();
    this.spare.length = 0;
    this.widthCache.clear();
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

  // ---- a new text size, shown without the jumps ----
  // A text size change resizes the terminal: the text re-wraps, the program redraws (agents
  // in several goes — half-drawn frames, a logo in pieces). Meanwhile a still copy of the
  // picture as it was stays on top; once the program is done, it fades into the new one.
  private still: HTMLElement | null = null;
  /** Keep the picture as it is now on screen while the real one changes underneath. */
  freezePicture() {
    this.dropGhost();
    const g = this.zoomLayer.cloneNode(true) as HTMLElement;
    g.classList.add('term-ghost');
    g.setAttribute('aria-hidden', 'true');
    // its sizes stay the old ones when the screen's change — the line height too (it's
    // inherited as a number: without it the text sat half a line below its colours)
    for (const v of ['--cw', '--lh', '--fs', '--bn-fs', '--bw']) g.style.setProperty(v, this.el.style.getPropertyValue(v));
    g.style.fontSize = `${this.opts.fontSize}px`;
    g.style.lineHeight = `${this.lineHeight}px`;
    this.el.append(g);
    this.still = g;
    this.zoomLayer.style.opacity = '0';
  }
  /** The new picture is ready: the still copy fades into it. */
  revealPicture(ms = 300) {
    const g = this.still;
    this.still = null;
    this.zoomLayer.style.opacity = '';
    if (!g) return;
    if (!this.opts.animate || ms <= 0) {
      g.remove();
      return;
    }
    const ease = 'cubic-bezier(0.33, 0, 0.2, 1)';
    const out = g.animate([{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(1.5px)' }], { duration: ms, easing: ease, fill: 'forwards' });
    out.onfinish = () => g.remove();
    this.zoomLayer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: ease });
  }
  /** (another size change while the last one is still fading: finish that at once) */
  dropGhost() {
    this.still?.remove();
    this.still = null;
    this.zoomLayer.style.opacity = '';
  }

  /** Vertical pan of the whole screen (keeps the cursor above the keyboard). */
  private pan = 0;
  /**
   * A pan the screen would move to, waiting to be sure: while an agent writes its reply it
   * moves the cursor around its screen (the status line, the panel under the prompt, back),
   * and following each of those stops made the whole screen — the input box with it — jump
   * up and down. The screen goes where the cursor stays most of the time instead (at once
   * for the keyboard, a zoom).
   */
  private panHist: { t: number; v: number }[] = [];
  private panTimer = 0;
  /** (the last picture was scrolled back: no pan was worked out for it) */
  private panScrolled = false;
  /** Time of the user's last keystroke (set by the session). */
  lastInput = 0;
  private applyLayerTransform() {
    const t = `translateY(${(-this.pan).toFixed(1)}px)`;
    if (this.zoomLayer.style.transform !== t) this.zoomLayer.style.transform = t;
  }

  // ---- don't show half-drawn frames ----
  /** Time of the last output (set by the session). */
  lastOutput = 0;
  private holdUntil = 0;
  private holdQuiet = 60;
  private syncSince = 0;
  /**
   * After a resize, programs clear and redraw: keep the old picture until they're done
   * (output quiet for [quiet] ms, at most [ms]).
   */
  private panKey = '';
  private holdFrom = 0;
  /** When output first came after the hold began (0: not yet). */
  private holdStarted = 0;
  holdForRedraw(ms = 300, quiet = 60) {
    this.holdFrom = performance.now();
    this.holdStarted = 0;
    this.holdUntil = this.holdFrom + ms;
    this.holdQuiet = quiet;
  }
  /** The pan to show now, given the one wanted (see panHist). */
  private settlePan(want: number, backDown: boolean, screenH: number): number {
    const now = performance.now();
    // the screen itself changed (keyboard settled without sliding, rotation, text size, a
    // full-screen program started or ended): the new pan at once, not after a moment's jump
    const buf = this.term.buffer.active;
    const key = `${screenH}|${this.term.rows}|${this.lineHeight}|${buf.type}`;
    const relaid = key !== this.panKey;
    this.panKey = key;
    const same = (x: number, y: number) => Math.abs(x - y) < 0.5;
    // at once: the keyboard sliding, back from reading history, the first picture, and in a
    // shell the user's own keys (Enter takes the prompt to a new line)
    const prompt = this.insetsMoving || relaid || backDown || !this.rows.size ||
      // (a shell's output growing down past the keyboard is followed at once — it ran on
      // hidden under the keyboard, then the screen jumped)
      (!this.anchorBottom && (now - this.lastInput < 400 || want > this.pan + 0.5));
    const h = this.panHist;
    if (prompt) {
      h.length = 0;
      h.push({ t: now, v: want });
      return want;
    }
    if (!h.length || !same(h[h.length - 1].v, want)) h.push({ t: now, v: want });
    // where the cursor kept the screen for most of the last moment
    const from = now - PAN_WINDOW_MS;
    while (h.length > 1 && h[1].t <= from) h.shift();
    const dwell = new Map<number, number>();
    let best = this.pan;
    let bestMs = -1;
    for (let i = 0; i < h.length; i++) {
      const ms = (i + 1 < h.length ? h[i + 1].t : now) - Math.max(from, h[i].t);
      const v = Math.round(h[i].v);
      const total = (dwell.get(v) ?? 0) + ms;
      dwell.set(v, total);
      if (total > bestMs) {
        bestMs = total;
        best = h[i].v;
      }
    }
    if (!same(best, this.pan) && bestMs >= PAN_WINDOW_MS * 0.6) return best;
    // not decided yet: look again in a moment, even if no more output comes
    if (!same(want, this.pan)) {
      clearTimeout(this.panTimer);
      this.panTimer = window.setTimeout(() => this.schedule(), 60);
    }
    return this.pan;
  }

  private shouldWait(): boolean {
    const now = performance.now();
    // DEC 2026 synchronized output: the program says "frame in progress"
    if (this.term.modes.synchronizedOutputMode) {
      if (!this.syncSince) this.syncSince = now;
      if (now - this.syncSince < 250) return true;
    } else this.syncSince = 0;
    // after a resize: wait until output has been quiet for a moment (at most holdForRedraw ms)
    if (now >= this.holdUntil) return false;
    if (this.lastOutput >= this.holdFrom && !this.holdStarted) this.holdStarted = now;
    // (a program that never goes quiet — a spinner, a busy agent — isn't held for the whole
    // time: a moment after its redraw began)
    if (this.holdStarted && now - this.holdStarted > 300) return false;
    if (now - this.lastOutput < this.holdQuiet) return true;
    // …and a program that redraws itself on a resize (a full-screen one, an agent): until its
    // redraw has begun — the first frame was otherwise the old screen re-wrapped, boxes broken
    // (the program hears of the new size a moment after the resize)
    const redraws = this.term.buffer.active.type === 'alternate' || this.anchorBottom;
    return redraws && this.lastOutput < this.holdFrom;
  }

  private applyMetrics() {
    const { fontSize, theme } = this.opts;
    ({ cellWidth: this.cellWidth, lineHeight: this.lineHeight } = BanglaRenderer.metrics(fontSize));
    const s = this.el.style;
    s.setProperty('--cw', `${this.cellWidth}px`);
    s.setProperty('--lh', `${this.lineHeight}px`);
    s.setProperty('--fs', `${fontSize}px`);
    s.setProperty('--bn-fs', `${fontSize * this.opts.bnScale}px`);
    s.setProperty('--bw', `${Math.max(1, Math.round(fontSize / 13))}px`);
    s.background = theme.background;
    s.color = theme.foreground;
    s.setProperty('--tbg', theme.background);
    // (on the screen, not just the cursor: the pinned input box draws a cursor too)
    s.setProperty('--cursor', theme.cursor);
    this.cursorEl.style.setProperty('--cursor', theme.cursor);
  }

  /** How many columns/rows fit into the given pixel box. */
  fit(width: number, height: number): { cols: number; rows: number } {
    return BanglaRenderer.gridFor(this.opts.fontSize, width, height);
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
      const ctx = BanglaRenderer.measurer();
      ctx.font = `${bold ? 'bold ' : ''}${this.opts.fontSize * this.opts.bnScale}px Kalpurush`;
      w = ctx.measureText(text).width;
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
    // Powerline separators and rounded ends as the font draws them (as in Settings' pictures
    // of the prompt styles): a band through the middle of the row — rounded nubs and small
    // arrows on the bar, not ends as tall as the row. Sized to the row as the pictures are
    // (11.5 px glyphs in a 21 px row), against the side of the bar they belong to.
    if (cp >= 0xe0b0 && cp <= 0xe0bf) {
      const side = (cp - 0xe0b0) % 4 < 2 ? 'l' : 'r';
      return `<span class="dg" style="${width}${style}"><i class="pf ${side}"><b>${String.fromCodePoint(cp)}</b></i></span>`;
    }
    const pl = POWERLINE[cp];
    if (pl) {
      const paint = pl.fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.2" vector-effect="non-scaling-stroke"';
      return `<span class="dg" style="${width}${style}"><svg viewBox="0 0 10 20" preserveAspectRatio="none"><path d="${pl.d}" ${paint}/></svg></span>`;
    }
    return null;
  }

  /** Build the HTML for one buffer line (from cell [from] on). */
  rowToHtml(line: IBufferLine | undefined, cols: number, from = 0, bar = false): string {
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

    let monoCells = 0;
    const flushMono = () => {
      if (monoStyle === null) return;
      if (bar) {
        // a prompt bar's text, smaller, centred in the cells it takes (the grid stays)
        html += `<span class="cmp" style="${monoStyle}width:${(monoCells * cw).toFixed(2)}px">${esc(monoText)}</span>`;
      } else html += monoStyle ? `<span style="${monoStyle}">${esc(monoText)}</span>` : esc(monoText);
      monoStyle = null;
      monoText = '';
      monoCells = 0;
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

    for (let x = from; x < cols; x++) {
      const c = line.getCell(x, cell);
      if (!c) break;
      const w = c.getWidth();
      if (w === 0) continue; // second half of a wide character
      const chars = c.getChars();
      const st = this.styleOf(c);
      const cp = chars.length ? chars.codePointAt(0)! : 32;
      if ((cp === 0x2500 || cp === 0x2501) && w === 1) {
        // A run of ─ (a rule line) as one span: cell-sized pieces at fractional x
        // leave hairline gaps where the browser rounds their edges.
        let n = 1;
        for (; x + n < cols; n++) {
          const nx = (this.probe = line.getCell(x + n, this.probe));
          if (!nx || nx.getWidth() !== 1 || nx.getChars().codePointAt(0) !== cp || this.styleOf(nx).css !== st.css) break;
        }
        flushMono();
        flushBn();
        const t = cp === 0x2500 ? 'var(--bw)' : 'calc(var(--bw) * 2)';
        html += `<span class="dg" style="width:${(n * cw).toFixed(2)}px;${st.css}background:linear-gradient(currentColor,currentColor) 0 50%/100% ${t} no-repeat;${bgOf(st.css)}"></span>`;
        x += n - 1;
        continue;
      }
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
      // (on a prompt's bar line icons stay in the text's run: the piece — icon and text —
      // is centred in its cells as one, with no gap opening between them)
      if ((cls === 'box' || (cls === 'mono' && w > 1)) && !bar) {
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
        monoCells += w;
        continue;
      }
      flushMono();
      monoStyle = st.css;
      monoText = text;
      monoCells = w;
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

  /** A suggestion's or placeholder's look: dim, or the shell's suggestion grey. */
  private isDimCell(line: IBufferLine, x: number): boolean {
    const c = (this.cell = line.getCell(x, this.cell) ?? this.cell);
    if (!c) return false;
    if (c.getChars() === '' || c.getChars() === ' ') return true; // (spaces go with it)
    return !!c.isDim() || (c.isFgRGB() && c.getFgColor() === 0x6c7086);
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

  /** A restored session's old output is being replayed: draw once it's all in. */
  paused = false;

  /**
   * Not on screen (another tab, home, Reader view): drawing waits until it shows again — a
   * busy tab in the background used to be drawn every frame, measuring a hidden layout.
   */
  private offscreen = false;
  setOffscreen(off: boolean) {
    if (off === this.offscreen) return;
    this.offscreen = off;
    if (off) {
      this.setBlink(false);
      // (a fade cut short by hiding would replay from nothing when shown again)
      for (const r of this.rows.values()) {
        r.el.classList.remove('row-in');
        r.el.style.animationDelay = '';
      }
      return;
    }
    // back on screen: the keyboard may have come or gone meanwhile — the pan follows at once
    // (not after the usual dwell: the screen sat cut off for a moment, then jumped), and the
    // cursor is placed, not glided from where it was
    this.panScrolled = true;
    this.lastCursorLine = -1;
    // (what was printed meanwhile is simply there: no screenful fading in at once)
    this.suppressReveal = true;
    this.schedule();
  }

  /** The agent's input box: the screen row of the rule above it, or of the line before
   * OpenCode's barred (┃) rows; -1 if none near the cursor. */
  private findBox(buf: IBuffer): number {
    const text = (y: number) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '';
    // (the bar first: a reply ending in a table's border or a rule just above OpenCode's box
    // would otherwise be taken for the box's top)
    const barred = (y: number) => /^\s*┃/.test(text(y));
    if (barred(buf.cursorY)) {
      let top = buf.cursorY;
      while (top > 0 && buf.cursorY - top < 12 && barred(top - 1)) top--;
      return top > 0 ? top - 1 : -1;
    }
    for (let y = buf.cursorY - 1; y >= Math.max(0, buf.cursorY - 8); y--) if (isRule(text(y))) return y;
    return -1;
  }
  private boxSeenAt = -Infinity;
  private boxFromEnd = -1;
  private boxTimer = 0;

  render() {
    if (this.disposed || this.paused || this.offscreen) return;
    this.lastRenderAt = performance.now();
    // (nothing on screen — e.g. right after a text-size change — then don't wait: holding an
    // empty picture is worse than a half-drawn one)
    if (this.rows.size && this.shouldWait()) {
      if (!this.frame) this.frame = window.setTimeout(() => { this.frame = 0; this.render(); }, 20) as unknown as number;
      return;
    }
    const term = this.term;
    const buf = term.buffer.active;
    const rows = term.rows;
    const cols = term.cols;
    const lh = this.lineHeight;
    // The screen's size, read once, before anything is written: asked again after the rows
    // changed, the browser laid the whole screen out on the spot — twice a frame.
    const screenH = this.el.clientHeight;
    const screenW = BanglaRenderer.floatingKeyboard ? this.el.clientWidth : 0;

    // Lines dropped off the top of a full scrollback (or cleared with it) shift every
    // line number down: move the rendered rows along instead of rebuilding them.
    const reflowed = this.lastCols !== 0 && cols !== this.lastCols;
    this.lastCols = cols;
    const gen0 = this.trimGen;
    const trimmed = this.checkTrim(buf.type === 'normal', reflowed);
    if (trimmed > 0) this.shiftRows(trimmed);
    // (lines numbered anew: a selection of the output moves along — or, not knowing by how
    // much (re-wrapped, cleared), goes)
    if (this.trimGen !== gen0 || reflowed) this.onLinesRenumbered?.(-1);
    else if (trimmed > 0) this.onLinesRenumbered?.(trimmed);

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
      this.scrollPx = (buf.baseY - vm.line - this.viewFrac) * lh - this.lift; // (topPx counts the lift)
      this.lastBaseY = buf.baseY;
    } else if (buf.baseY !== this.lastBaseY) {
      if (this.scrollPx > 0 && buf.baseY > this.lastBaseY) this.scrollPx += (buf.baseY - this.lastBaseY) * lh;
      this.lastBaseY = buf.baseY;
    }
    // The last line drawn: the cursor's (plus one), or anything below it (a completion
    // menu, a TUI's footer).
    const visible = screenH - 12;
    let lastY = buf.cursorY + 1;
    for (let y = rows - 1; y > lastY; y--) {
      if (buf.getLine(buf.baseY + y)?.translateToString(true)) {
        lastY = y;
        break;
      }
    }
    // Chat layout for agent sessions (Antigravity, Claude Code): the input box — from the
    // rule line above the prompt down to the footer — sits at the bottom, like a chat app.
    // While the conversation is shorter than the screen its header stays at the top and a
    // gap opens above the box. With earlier lines in the scrollback (a tall dialog that went
    // away, a screen that grew) those fill the top instead: no empty rows under the box.
    let splitLine = -1;
    let splitGap = 0;
    let lift = 0;
    // (a floating keyboard too: the box stays at the bottom — the keyboard can be moved off it)
    // the box's screen row (see findBox), -1 none
    let box = -1;
    if (this.anchorBottom && buf.type === 'normal') {
      box = this.findBox(buf);
      const now = performance.now();
      if (box >= 0) {
        this.boxSeenAt = now;
        this.boxFromEnd = lastY - box;
      } else if (now - this.boxSeenAt < BOX_MEMORY_MS && this.boxFromEnd >= 0) {
        // missed for a moment (the agent's redraw came in two pieces, its cursor elsewhere
        // mid-write): where it was — the layout used to flip off and on, everything jumping
        box = Math.max(0, lastY - this.boxFromEnd);
        clearTimeout(this.boxTimer);
        this.boxTimer = window.setTimeout(() => this.schedule(), BOX_MEMORY_MS);
      }
    }
    if (box >= 0 && visible > 0) {
      const free = visible - (lastY + 1) * lh;
      // (any room at all: the box follows the keyboard pixel by pixel, no one-line step)
      if (free > 0) {
        lift = Math.min(free, buf.baseY * lh);
        if (this.scrollPx === 0 && free - lift > 0.5) {
          splitLine = buf.baseY + box;
          splitGap = free - lift;
        }
      }
    }
    if (lift !== this.lift) {
      // reading back: the lines looked at stay where they are
      if (this.scrollPx > 0) this.scrollPx -= lift - this.lift;
      this.lift = lift;
    }
    this.scrollPx = Math.max(0, Math.min(this.maxScroll(), this.scrollPx));

    const topPx = buf.baseY * lh - this.lift - this.scrollPx; // y of the first visible pixel row
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
    // Every line the screen can show: more than the terminal's rows when the picture is taller
    // than they are — a pinch-zoom preview (scaled down), the keyboard pan, a screen that grew
    // before the terminal was resized. Drawing only `rows` lines left those parts black.
    const shown = Math.ceil((screenH + this.pan) / lh) + 1;
    const first = Math.max(0, Math.floor(topPx / lh) - OVERSCAN);
    const last = Math.min(buf.length - 1, Math.floor(topPx / lh) + Math.max(rows, shown) + OVERSCAN);

    for (const [i, r] of this.rows) {
      if (i < first || i > last) {
        this.recycle(r.el);
        this.rows.delete(i);
      }
    }
    const cursorLine = buf.baseY + buf.cursorY;
    const motion = !!this.opts.animate && buf.type === 'normal';

    const rowY = (i: number) => i * lh + (splitLine >= 0 && i >= splitLine ? splitGap : 0);
    const splitMoved = splitLine !== this.splitLine || splitGap !== this.splitGap;
    if (splitMoved) {
      this.splitLine = splitLine;
      this.splitGap = splitGap;
      for (const [i, r] of this.rows) r.el.style.transform = `translateY(${rowY(i)}px)`;
    }
    const canReveal = motion && !this.suppressReveal && this.scrollPx === 0;
    // An agent's input box (the rule line above the prompt, the prompt, its footer) is
    // erased and drawn again below each new piece of a reply — always on fresh lines. It is
    // not new output: it must not fade in (it flickered), and its lines stay "unrevealed" so
    // the reply that takes their place still fades in.
    let boxTop = box >= 0 ? buf.baseY + box : -1;
    if (!this.anchorBottom) {
      for (let y = cursorLine - 1; y >= Math.max(buf.baseY, cursorLine - 8); y--) {
        if (isRule(buf.getLine(y)?.translateToString(true) ?? '')) {
          boxTop = y;
          break;
        }
      }
    }
    // No box (a shell, a command's output): the line being typed — all of it, when it wraps
    // — is seen as it's written; it never fades in (not even its first row, once the cursor
    // wraps below it, nor "Done" finishing "Reading package lists... ").
    let inputTop = cursorLine;
    if (boxTop < 0) while (inputTop > buf.baseY && buf.getLine(inputTop)?.isWrapped) inputTop--;
    const revealed: HTMLDivElement[] = [];
    const labels = this.labelsByLine(first, last);
    const bars = this.barsByLine(first, last);
    for (let i = first; i <= last; i++) {
      let r = this.rows.get(i);
      const live = i >= buf.baseY; // the live screen can still change; scrollback can't
      if (r && !live && !r.live) continue;
      if (r) r.live = live;
      const line = buf.getLine(i);
      let label = labels.get(i);
      // never cover text: only when the row leaves room at its right end (zoomed in,
      // re-wrapped, or a wide prompt bar → no clock on that row)
      // (the account's text is small: about 0.8 of a cell a letter)
      if (label && line && this.usedCells(line, cols) > cols - (label.note ? label.text.length + 3 : 13)) label = undefined;
      const html = this.rowToHtml(line, cols, 0, bars.has(i)) + (!label ? '' : label.note
        ? `<span class="rlabel note">${esc(label.text)}</span>`
        : `<span class="rlabel"><b>\uf017</b>${esc(label.text)}</span>`);
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
      if (el && i > this.revealedUpTo && (boxTop < 0 || i < boxTop) && live && line?.translateToString(true)) {
        this.revealedUpTo = i;
        if (canReveal && i < inputTop) revealed.push(el);
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
    // (not under an agent's input box: the box, drawn at once on its new lines, dipped a line
    // and glided back up on every new line of a reply)
    const slide = motion && this.scrollPx === 0 && grew > 0 && grew <= 4 && !(this.anchorBottom && boxTop >= 0);
    const dur = slide ? '140ms' : '0s';
    if (this.viewport.style.transitionDuration !== dur) this.viewport.style.transitionDuration = dur;
    this.viewport.style.transform = `translateY(${(-topPx).toFixed(2)}px)`;
    const h = `${rows * lh}px`;
    if (this.zoomLayer.style.height !== h) this.zoomLayer.style.height = h;
    // When the keyboard covers part of the screen the terminal is NOT resized (that makes
    // programs redraw and flicker); instead the screen slides up just enough to keep the
    // cursor — and a line of context under it — visible. A prompt at the top never moves.
    let panEased = false;
    const backDown = this.panScrolled;
    this.panScrolled = this.scrollPx !== 0;
    if (this.scrollPx === 0) {
      const overflow = rows * lh - visible;
      const below = (lastY + 1) * lh - visible;
      let pan = 0;
      if (splitLine >= 0 || lift > 0) {
        pan = 0; // the chat layout already fits the screen
      } else if (buf.type === 'alternate') {
        // a full-screen program is sized to the room above the keyboard once it settles (see
        // TerminalSession.fit) and draws itself in it: sliding its screen up meanwhile only
        // made it jump twice. (Still too tall once settled — a big text size sideways: what
        // the cursor needs is shown.)
        pan = !this.insetsMoving && overflow > 0 ? Math.max(0, Math.min(overflow, below, buf.cursorY * lh)) : 0;
      } else if (BanglaRenderer.floatingKeyboard && this.floatPan && buf.type === 'normal' &&
        !this.anchorBottom && screenH > screenW) {
        // the input line (and what's drawn under it) in the upper half of the screen (not in
        // full-screen programs — vim, less: their top half couldn't be scrolled back to)
        pan = Math.max(0, Math.min((lastY + 1) * lh - visible * 0.5, buf.cursorY * lh));
      } else if (overflow > 0) {
        // keep the cursor visible, and what's drawn under it while the cursor still fits
        pan = Math.max(0, Math.min(overflow, below, buf.cursorY * lh));
        // an agent at work hides its cursor and leaves it wherever it last wrote: nothing
        // to follow then — stay put (only less, when what's drawn got shorter)
        if (this.anchorBottom && !this.cursorVisible) pan = Math.max(0, Math.min(this.pan, overflow, below));
      }
      pan = this.settlePan(pan, backDown, screenH);
      // ease small moves that come from new content; follow the keyboard exactly
      const d = Math.abs(pan - this.pan);
      const ease = motion && !this.insetsMoving && d > 0 && d <= 4 * lh;
      const dur = ease ? '160ms' : '0s';
      if (this.zoomLayer.style.transitionDuration !== dur) this.zoomLayer.style.transitionDuration = dur;
      panEased = ease && pan !== this.pan;
      this.pan = pan;
    }
    this.applyLayerTransform();

    const showCursor = this.cursorVisible && this.scrollPx < lh;
    const wasShown = this.cursorEl.style.display !== 'none';
    // the keyboard's text that the program hasn't echoed yet: shown until the cursor moves
    let pre = this.preedit;
    const w = this.waitAt;
    if (w) {
      const still = w.line === cursorLine && w.x === buf.cursorX && performance.now() < w.until;
      if (!still) {
        this.waitAt = null;
        this.ghost = '';
        this.holdPreedit = false;
      } else if (this.holdPreedit) pre = ''; // ⌫ first: the word would show twice
    }
    const ghost = this.ghost;
    const composing = !this.hiddenInput && !!(pre || ghost) && this.scrollPx < lh;
    this.cursorEl.style.display = showCursor && !composing ? 'block' : 'none';
    this.preeditEl.style.display = composing ? 'block' : 'none';
    if (composing) {
      const cw = this.cellWidth;
      const cx = Math.min(buf.cursorX, cols);
      const line = buf.getLine(cursorLine);
      // What follows the cursor on its row moves aside, as the word is inserted there (else
      // the word covered only part of it: "e" + "ami" over "echo hello" read "eami hello").
      // A dim tail — a suggestion or placeholder that typing replaces — is just hidden.
      const used = line ? this.usedCells(line, cols) : 0;
      let end = used;
      while (end > cx && line && this.isDimCell(line, end - 1)) end--;
      const tail = end > cx ? this.rowToHtml(line, end, cx) : '';
      const word = `<span class="pw">${esc(ghost)}${pre ? `<u>${esc(pre)}</u>` : ''}</span>`;
      const set = (html: string) => {
        if (html === this.preeditHtml) return;
        this.preeditHtml = html;
        this.preeditEl.innerHTML = html;
      };
      set(word + tail);
      // (covers the row's own text after the cursor)
      this.preeditEl.style.minWidth = `${(Math.max(0, used - cx) * cw).toFixed(2)}px`;
      // a word that doesn't fit on the row goes to the start of the next one, as it will
      // when typed (moving it left covered what was typed before it)
      const wordPx = (this.preeditEl.firstElementChild as HTMLElement).offsetWidth;
      const wraps = cx * cw + wordPx > cols * cw + 0.5 && cx > 0;
      if (wraps) {
        set(word);
        this.preeditEl.style.minWidth = '';
      }
      const x = wraps ? 0 : cx * cw;
      const y = rowY(wraps ? cursorLine + 1 : cursorLine);
      this.preeditEl.style.transform = `translate(${x.toFixed(2)}px, ${y}px)`;
    }
    if (showCursor) {
      // Over a cell the program painted (OpenCode's, Codex's input box) the cursor goes on top
      // — under the row it was hidden; elsewhere under the text, the letter showing through
      const under = buf.getLine(cursorLine)?.getCell(Math.min(buf.cursorX, cols - 1), this.probe);
      if (under) this.probe = under;
      const painted = !!under && !under.isBgDefault();
      if (painted !== this.cursorOnTop) {
        this.cursorOnTop = painted;
        this.cursorEl.classList.toggle('on-top', painted);
      }
      // cursorX == cols while a line wrap is pending: keep it on the grid
      const t = `translate(${(Math.min(buf.cursorX, cols - 1) * this.cellWidth).toFixed(2)}px, ${rowY(cursorLine)}px)`;
      if (t !== this.lastCursorT) {
        // glide to the next cell / line; jump when it reappears or moves far (TUIs)
        // jump when it reappears, moves far (TUIs), or the layout itself moved
        // Typing moves it along its line: there it jumps at once (a glide trails behind the
        // letters and makes typing feel slow). It glides only to another line (after Enter).
        const sameLine = cursorLine === this.lastCursorLine;
        // typing on past the end of the row (or ⌫ back over it): the line wraps — no slide
        // diagonally across the text
        const lower = Math.max(cursorLine, this.lastCursorLine);
        const wrapped = Math.abs(cursorLine - this.lastCursorLine) === 1 && !!buf.getLine(lower)?.isWrapped;
        // … and when the screen itself slides (new line at the bottom, keyboard pan): the
        // cursor rides along inside it instead of a second, out-of-step glide (it dipped)
        const far = !wasShown || sameLine || wrapped || Math.abs(cursorLine - this.lastCursorLine) > 2 || splitMoved ||
          this.insetsMoving || slide || panEased;
        this.cursorEl.style.transitionDuration = motion && !far ? '' : '0s';
        this.cursorEl.style.transform = t;
        this.lastCursorT = t;
        this.lastCursorLine = cursorLine;
        // keep it solid while it moves (typing); blink again when it rests
        clearTimeout(this.typingTimer);
        this.typingTimer = window.setTimeout(() => {
          this.typingTimer = 0;
          this.updateBlink();
        }, 600);
      }
      this.cursorEl.classList.toggle('focused', this.focused);
    }
    this.updateBlink();
    this.drawSelection(rowY, first, last);
    this.drawDock(boxTop, buf.baseY + lastY, cursorLine, screenH);
    const scrolled = this.scrollPx >= lh;
    if (scrolled !== this.wasScrolled) {
      this.wasScrolled = scrolled;
      this.onScrolled?.(scrolled);
    }
  }

  // ---- an agent's input box stays put while the conversation scrolls ----
  // Like a chat app: reading back through a reply, the box (the rule line above the prompt
  // down to its footer) stays at the bottom, where it is when not scrolled; the conversation
  // scrolls behind it. (It's a copy, drawn while scrolled back; the box itself is still in
  // the terminal, where the program keeps drawing it.)
  private dockEl: HTMLDivElement | null = null;
  private dockRows: HTMLDivElement[] = [];
  private dockHtml: string[] = [];
  private dockCursor: HTMLDivElement | null = null;
  private drawDock(boxTop: number, end: number, cursorLine: number, screenH: number) {
    const buf = this.term.buffer.active;
    const on = this.anchorBottom && buf.type === 'normal' && boxTop >= 0 && end >= boxTop && this.scrollPx > 0.5;
    const host = this.el.parentElement;
    if (!on) {
      if (this.dockEl && !this.dockEl.hidden) {
        this.dockEl.hidden = true;
        host?.style.setProperty('--dock-h', '0px');
      }
      return;
    }
    if (!this.dockEl) {
      this.dockEl = document.createElement('div');
      this.dockEl.className = 'term-dock';
      this.dockCursor = document.createElement('div');
      this.dockCursor.className = 'term-cursor';
      this.dockEl.append(this.dockCursor);
      this.el.append(this.dockEl);
    }
    const lh = this.lineHeight;
    const cols = this.term.cols;
    const n = Math.min(12, end - boxTop + 1);
    // where the box is when not scrolled (the zoom layer starts 6 px down)
    this.dockEl.style.top = `${(6 + (boxTop - buf.baseY) * lh - this.pan + this.lift).toFixed(1)}px`;
    for (let k = 0; k < n; k++) {
      let r = this.dockRows[k];
      if (!r) {
        r = document.createElement('div');
        r.className = 'term-row';
        r.style.transform = `translateY(${k * lh}px)`;
        this.dockEl.append(r);
        this.dockRows[k] = r;
      }
      r.style.transform = `translateY(${k * lh}px)`;
      const html = this.rowToHtml(buf.getLine(boxTop + k), cols);
      if (this.dockHtml[k] !== html) {
        this.dockHtml[k] = html;
        r.innerHTML = html;
      }
    }
    while (this.dockRows.length > n) {
      this.dockRows.pop()!.remove();
      this.dockHtml.pop();
    }
    const c = this.dockCursor!;
    const inBox = this.cursorVisible && cursorLine >= boxTop && cursorLine < boxTop + n;
    c.style.display = inBox ? 'block' : 'none';
    if (inBox) {
      c.style.transform = `translate(${(Math.min(buf.cursorX, cols - 1) * this.cellWidth).toFixed(2)}px, ${(cursorLine - boxTop) * lh}px)`;
      c.classList.toggle('focused', this.focused);
    }
    this.dockEl.hidden = false;
    // (the "back to the bottom" button sits above it)
    const top = 6 + (boxTop - buf.baseY) * lh - this.pan + this.lift;
    host?.style.setProperty('--dock-h', `${Math.max(0, screenH - top).toFixed(0)}px`);
  }
  /** The pinned input box on screen, if shown (a tap on it goes back to the bottom). */
  dockRect(): DOMRect | null {
    return this.dockEl && !this.dockEl.hidden ? this.dockEl.getBoundingClientRect() : null;
  }

  /** The cell under a client point: x/y relative to the visible screen, plus the buffer line. */
  cellAt(clientX: number, clientY: number): { x: number; y: number; line: number; onScreen: boolean } {
    const rect = this.viewport.getBoundingClientRect(); // includes the scroll transform
    const buf = this.term.buffer.active;
    const lh = this.lineHeight;
    let py = clientY - rect.top;
    if (this.splitLine >= 0 && py >= this.splitLine * lh) {
      // below the chat layout's gap: undo the shift (inside the gap: the line above it)
      py = py >= this.splitLine * lh + this.splitGap ? py - this.splitGap : this.splitLine * lh - 1;
    }
    const line = Math.max(0, Math.min(buf.length - 1, Math.floor(py / lh)));
    const x = Math.max(0, Math.min(this.term.cols - 1, Math.floor((clientX - rect.left) / this.cellWidth)));
    // (line is already where the finger is, scrolled back or not: the program's row is
    // counted from the top of its screen; history above it is no row of the program's)
    const y = Math.max(0, Math.min(this.term.rows - 1, line - buf.baseY));
    return { x, y, line, onScreen: line >= buf.baseY };
  }
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
