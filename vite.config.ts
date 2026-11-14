import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'extension',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        popup: resolve('extension/popup.html'),
        scanner: resolve('extension/scan.html'),
        background: resolve('extension/src/background.ts'),
      },
      output: {
        entryFileNames: chunk => chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
