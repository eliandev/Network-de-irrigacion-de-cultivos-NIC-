/**
 * NIC — Service Worker (PWA).
 * Precarga el app shell para funcionamiento offline. La telemetria viaja por
 * WebSocket (no se cachea); aqui solo gestionamos los recursos estaticos.
 */

const CACHE = 'nic-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './assets/logo.svg',
  './assets/icon.svg',
  './js/app.js',
  './js/store.js',
  './js/protocol.js',
  './js/ws-client.js',
  './js/settings.js',
  './js/history.js',
  './js/alerts.js',
  './js/ui.js',
  './js/screens/dashboard.js',
  './js/screens/monitoreo.js',
  './js/screens/control.js',
  './js/screens/alertas.js',
  './js/screens/ajustes.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[sw] precache parcial', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Solo GET y mismo origen; ignorar WebSocket y peticiones cruzadas.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Estrategia: cache-first con actualizacion en segundo plano.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached || caches.match('./index.html'));
      return cached || network;
    })
  );
});
