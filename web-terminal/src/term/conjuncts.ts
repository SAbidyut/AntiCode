import type { Terminal } from '@xterm/headless';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';

/**
 * How many cells a Bangla (or Devanagari) conjunct takes: the program drawing decides.
 *
 * - The shell (bash, ble.sh) counts a conjunct by its letters: "ক্ষ" = ক্ + ষ = 2 cells.
 * - Newer programs (the Antigravity CLI, Claude Code) follow Unicode 15.1, where a conjunct is
 *   one character (GB9c: consonant + virama + consonant): "ক্ষ" = 1 cell. Counted the shell's
 *   way, their tables came apart — every conjunct pushed the column lines one cell further.
 *
 * So the terminal counts the shell's way at the prompt and the newer way while a program
 * runs (the shell says when one starts and when its prompt is back).
 */

type Provider = {
  version: string;
  charProperties(codepoint: number, preceding: number): number;
  wcwidth(codepoint: number): 0 | 1 | 2;
};

/**
 * A spare bit of the packed value — above the provider's 24 state bits (state << 3), which it
 * uses all of: "the cluster so far ends with a virama (+ ZWJ)".
 */
const LINK = 1 << 28;

const isVirama = (cp: number) => cp === 0x09cd || cp === 0x094d;
const isConsonant = (cp: number) =>
  (cp >= 0x0995 && cp <= 0x09b9) || cp === 0x09dc || cp === 0x09dd || cp === 0x09df || cp === 0x09f0 || cp === 0x09f1 ||
  (cp >= 0x0915 && cp <= 0x0939) || (cp >= 0x0958 && cp <= 0x095f) || (cp >= 0x0978 && cp <= 0x097f);

/** The grapheme provider, with conjuncts kept whole (GB9c). */
class ConjunctProvider implements Provider {
  readonly version = '15-graphemes-conjuncts';
  constructor(private inner: Provider) {}

  charProperties(codepoint: number, preceding: number): number {
    const linked = (preceding & LINK) !== 0;
    const pre = preceding & ~LINK;
    if (linked && isConsonant(codepoint)) {
      // joins the cluster before it, which keeps its width; the state is the consonant's own
      // (its vowel signs and the next virama join as usual)
      const own = this.inner.charProperties(codepoint, 0);
      const width = (pre >> 1) & 3;
      return ((own >> 3) << 3) | (width << 1) | 1;
    }
    let v = this.inner.charProperties(codepoint, pre);
    if (isVirama(codepoint) || (linked && codepoint === 0x200d)) v |= LINK;
    return v;
  }

  wcwidth(codepoint: number) {
    return this.inner.wcwidth(codepoint);
  }
}

/** Loads grapheme handling into [term]; the returned function switches conjunct counting. */
export function installWidths(term: Terminal): (programRunning: boolean) => void {
  const addon = new UnicodeGraphemesAddon();
  term.loadAddon(addon as never);
  // the add-on's grapheme provider, taken from a stand-in (it isn't exported)
  const found: Provider[] = [];
  addon.activate({ unicode: { register: (p: Provider) => found.push(p), activeVersion: '' } } as never);
  const graphemes = found.find((p) => p.version === '15-graphemes');
  if (!graphemes) return () => {};
  const conjuncts = new ConjunctProvider(graphemes);
  term.unicode.register(conjuncts as never);
  return (programRunning) => {
    const v = programRunning ? conjuncts.version : '15-graphemes';
    if (term.unicode.activeVersion !== v) term.unicode.activeVersion = v;
  };
}
