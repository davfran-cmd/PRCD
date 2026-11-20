import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Relative base so the bundle also works when loaded from the Capacitor WebView (capacitor://localhost).
  base: './',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20000,
  },
});
