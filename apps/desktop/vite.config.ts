import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export const DEV_SERVER_PORT = 1420;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: DEV_SERVER_PORT, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
