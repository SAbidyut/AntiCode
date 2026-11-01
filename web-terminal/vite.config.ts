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
    target: 'es2020',
    assetsInlineLimit: 0,
  },
});
