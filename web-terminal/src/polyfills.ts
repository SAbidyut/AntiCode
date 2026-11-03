// Small polyfills so the UI also works in older Android System WebViews
// (e.g. Chrome 83 on Android 11 images that never got a WebView update).

for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
  if (!('replaceChildren' in proto)) {
    Object.defineProperty(proto, 'replaceChildren', {
      configurable: true,
      writable: true,
      value: function replaceChildren(this: ParentNode & Node, ...nodes: (Node | string)[]) {
        while (this.lastChild) this.removeChild(this.lastChild);
        this.append(...nodes);
      },
    });
  }
}

export {};
