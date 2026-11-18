import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';

const directory = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve(directory, 'src/main/index.ts'),
          'host-entry': resolve(directory, 'src/main/host-entry.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(directory, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(directory, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(directory, 'src/renderer/src'),
        ...(process.env.NESVO_PROFILE_RENDERER === '1'
          ? { 'react-dom/client': 'react-dom/profiling' }
          : {}),
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'renderer-dev-csp',
        apply: 'serve',
        transformIndexHtml: html =>
          html.replace(
            "connect-src 'self';",
            "connect-src 'self' ws://localhost:* ws://127.0.0.1:*;",
          ),
      },
    ],
    build: { outDir: resolve(directory, 'dist/renderer') },
  },
});
