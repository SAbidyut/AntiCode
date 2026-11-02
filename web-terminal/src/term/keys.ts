// Translate key presses into the byte sequences a terminal program expects.

export type NamedKey =
  | 'Enter' | 'Backspace' | 'Tab' | 'Escape' | 'Delete' | 'Insert'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown'
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';

export interface Mods {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

const ESC = '\x1b';

function modParam(m: Mods): number {
  return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
}

export function namedKeySeq(key: NamedKey, m: Mods, appCursor: boolean): string {
  const mp = modParam(m);
  const csi = (final: string, num = '1') => (mp > 1 ? `${ESC}[${num};${mp}${final}` : `${ESC}[${num === '1' ? '' : num}${final}`);
  const arrow = (final: string) => (mp > 1 ? `${ESC}[1;${mp}${final}` : appCursor ? `${ESC}O${final}` : `${ESC}[${final}`);
  const tilde = (n: number) => (mp > 1 ? `${ESC}[${n};${mp}~` : `${ESC}[${n}~`);
  switch (key) {
    case 'Enter': return m.alt ? ESC + '\r' : '\r';
    case 'Backspace': return m.ctrl ? '\x08' : m.alt ? ESC + '\x7f' : '\x7f';
    case 'Tab': return m.shift ? `${ESC}[Z` : '\t';
    case 'Escape': return ESC;
    case 'ArrowUp': return arrow('A');
    case 'ArrowDown': return arrow('B');
    case 'ArrowRight': return arrow('C');
    case 'ArrowLeft': return arrow('D');
    case 'Home': return mp > 1 ? csi('H') : appCursor ? `${ESC}OH` : `${ESC}[H`;
    case 'End': return mp > 1 ? csi('F') : appCursor ? `${ESC}OF` : `${ESC}[F`;
    case 'Insert': return tilde(2);
    case 'Delete': return tilde(3);
    case 'PageUp': return tilde(5);
    case 'PageDown': return tilde(6);
    case 'F1': return mp > 1 ? `${ESC}[1;${mp}P` : `${ESC}OP`;
    case 'F2': return mp > 1 ? `${ESC}[1;${mp}Q` : `${ESC}OQ`;
    case 'F3': return mp > 1 ? `${ESC}[1;${mp}R` : `${ESC}OR`;
    case 'F4': return mp > 1 ? `${ESC}[1;${mp}S` : `${ESC}OS`;
    case 'F5': return tilde(15);
    case 'F6': return tilde(17);
    case 'F7': return tilde(18);
    case 'F8': return tilde(19);
    case 'F9': return tilde(20);
    case 'F10': return tilde(21);
    case 'F11': return tilde(23);
    case 'F12': return tilde(24);
  }
}

/** Apply Ctrl/Alt to a printable string (ctrl+a → \x01, alt+x → ESC x). */
export function applyMods(text: string, m: Mods): string {
  let out = text;
  if (m.ctrl && text.length === 1) {
    const c = text.toLowerCase();
    const code = c.charCodeAt(0);
    if (code >= 97 && code <= 122) out = String.fromCharCode(code - 96);
    else if (c === ' ' || c === '2' || c === '@') out = '\x00';
    else if (c === '[' || c === '3') out = ESC;
    else if (c === '\\' || c === '4') out = '\x1c';
    else if (c === ']' || c === '5') out = '\x1d';
    else if (c === '^' || c === '6') out = '\x1e';
    else if (c === '_' || c === '-' || c === '/' || c === '7') out = '\x1f';
    else if (c === '?' || c === '8') out = '\x7f';
  }
  if (m.alt) out = ESC + out;
  return out;
}

/** Android KeyEvent keycodes → named keys (from the native terminal keyboard). */
const ANDROID_KEYS: Record<number, NamedKey> = {
  66: 'Enter', 160: 'Enter', 67: 'Backspace', 112: 'Delete', 61: 'Tab', 111: 'Escape',
  19: 'ArrowUp', 20: 'ArrowDown', 21: 'ArrowLeft', 22: 'ArrowRight',
  122: 'Home', 123: 'End', 92: 'PageUp', 93: 'PageDown', 124: 'Insert',
  131: 'F1', 132: 'F2', 133: 'F3', 134: 'F4', 135: 'F5', 136: 'F6', 137: 'F7', 138: 'F8',
  139: 'F9', 140: 'F10', 141: 'F11', 142: 'F12',
};

/** [ch]: what the key types on the phone's keyboard layout (Ctrl/Alt + punctuation). */
export function androidKeySeq(keyCode: number, m: Mods, appCursor: boolean, ch = ''): string | null {
  const named = ANDROID_KEYS[keyCode];
  if (named) return namedKeySeq(named, m, appCursor);
  if (ch) return applyMods(ch, m);
  // KEYCODE_A..Z = 29..54, 0..9 = 7..16, SPACE = 62
  if (keyCode >= 29 && keyCode <= 54) return applyMods(String.fromCharCode(97 + keyCode - 29), m);
  if (keyCode >= 7 && keyCode <= 16) return applyMods(String(keyCode - 7), m);
  if (keyCode === 62) return applyMods(' ', m);
  return null;
}

/** DOM keydown → sequence (desktop browsers / hardware keyboards). null = let the input event handle it. */
export function domKeySeq(e: KeyboardEvent, appCursor: boolean, extra: Mods): string | null {
  const m: Mods = { ctrl: e.ctrlKey || extra.ctrl, alt: e.altKey || extra.alt, shift: e.shiftKey };
  if ((e.key as NamedKey) in NAMED_SET) return namedKeySeq(e.key as NamedKey, m, appCursor);
  if (e.key.length === 1 && (m.ctrl || m.alt) && !e.metaKey) return applyMods(e.key, m);
  return null;
}

const NAMED_SET: Record<string, true> = Object.fromEntries(
  ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Insert', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']
    .map((k) => [k, true]),
);
