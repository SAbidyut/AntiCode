// Inline SVG icons (24×24, stroke-based, in the style of Lucide). Kept tiny and local so
// the app works offline and the icons inherit `currentColor`.

const PATHS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  remote: '<rect x="2.5" y="4" width="13" height="9" rx="1.5"/><path d="M6 17h6M9 13v4"/><rect x="17" y="9" width="4.5" height="11" rx="1.2"/><path d="M19.25 17.5h0"/>',
  book: '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H11v17H5.5A2.5 2.5 0 0 0 3 22.5z"/><path d="M21 5.5A2.5 2.5 0 0 0 18.5 3H13v17h5.5A2.5 2.5 0 0 1 21 22.5z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M12.5 15H17"/>',
  sparkle: '<path d="M12 2.5c.6 4.9 2.6 6.9 7.5 7.5-4.9.6-6.9 2.6-7.5 7.5-.6-4.9-2.6-6.9-7.5-7.5 4.9-.6 6.9-2.6 7.5-7.5z"/><path d="M19 15.5c.25 1.9 1 2.7 3 3-2 .25-2.75 1.1-3 3-.25-1.9-1-2.75-3-3 2-.25 2.75-1.1 3-3z"/>',
  android: '<path d="M6 10v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7z"/><path d="M6 9a6 6 0 0 1 12 0zM9 6.5 7.5 4M15 6.5 16.5 4"/><path d="M3.5 11v5M20.5 11v5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  file: '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h0M9.5 10h0M13 10h0M16.5 10h0M7 14h10"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  send: '<path d="M4 12 20 4l-4 16-4-6.5z"/><path d="m12 13.5 8-9.5"/>',
  bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8v12M7 13H3M21 13h-4M8 9 5 6M16 9l3-3M7.5 17 4.5 19.5M16.5 17l3 2.5M9.5 8a2.5 2.5 0 0 1 5 0"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  eraser: '<path d="m7 21-4-4L14 6l7 7-8 8z"/><path d="M7 21h13M9.5 10.5l7 7"/>',
  power: '<path d="M12 3v8"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  // (shapes of our own, not the makers' logos)
  codex: '<path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z"/><path d="m8.6 9.6 2.8 2.4-2.8 2.4M12.8 14.6h3"/>',
  opencode: '<path d="M9 4C7 4 6.2 5 6.2 7v2.2c0 1.4-.8 2.4-2.2 2.8 1.4.4 2.2 1.4 2.2 2.8V17c0 2 .8 3 2.8 3M15 4c2 0 2.8 1 2.8 3v2.2c0 1.4.8 2.4 2.2 2.8-1.4.4-2.2 1.4-2.2 2.8V17c0 2-.8 3-2.8 3"/>',
  claude: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><circle cx="12" cy="12" r="2.2"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/>',
};

export function icon(name: keyof typeof PATHS | string, cls = ''): string {
  const p = PATHS[name] ?? '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/** Replace every `<i data-icon="name"></i>` in the document with its SVG. */
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((el) => {
    el.outerHTML = icon(el.dataset.icon!, el.className);
  });
}
