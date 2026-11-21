import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * Emits `sw.js`, an offline service worker that pre-caches EVERY file of the build (JS, CSS, fonts, KaTeX,
 * the PDF worker, the SQLite WASM, icons). After the first visit the web app works in airplane mode.
 * No third-party plugin: the list of files comes straight from Rollup's bundle.
 */
function offlineServiceWorker(): Plugin {
  return {
    name: 'prcd-offline-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const extra = ['./', 'index.html', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
      const precache = [...new Set([...extra, ...files])];
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      const source = `/* PRCD. offline service worker — generated at build time (vite.config.ts). */
const CACHE = 'prcd-${version}';
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener('install', (event) => {
  // Every file must be cached, or the install fails and the previous version stays active.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('prcd-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Pages: network first (picks up a new version when online), cached app shell when offline.
    event.respondWith(fetch(req).catch(() => caches.match('index.html', { ignoreSearch: true })));
    return;
  }
  // Static assets have hashed names: cache first.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineServiceWorker()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Relative base: works under a GitHub Pages sub-path (/<repo>/) and in the Capacitor WebView.
  base: './',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2500 },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20000,
  },
});
