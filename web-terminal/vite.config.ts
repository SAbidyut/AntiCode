import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The build output is copied into the Android app's assets (see android/app/build.gradle.kts).
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      // @xterm/headless 6.0.0 ships a wrong "module" field; point at the real ESM build.
      '@xterm/headless': fileURLToPath(new URL('./node_modules/@xterm/headless/lib-headless/xterm-headless.mjs', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Android System WebView can be old on devices that don't update it (Chrome 80+).
    target: ['es2020', 'chrome80'],
    assetsInlineLimit: 0,
    // Do NOT minify. esbuild's minifier miscompiles xterm's (already minified) DECRQM
    // handler: `let i; (...)(i ||= {})` becomes `(...)(void 0 || (s = {}))`, a write to an
    // undeclared variable → "ReferenceError: s is not defined" as soon as a program asks
    // `CSI ? 2026 $ p` — which the Antigravity CLI does at startup, freezing the screen.
    // The bundle is loaded from the APK, so the extra ~70 KB doesn't matter.
    minify: false,
  },
});
