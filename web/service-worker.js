/**
 * NIC — Service Worker (PWA).
 * Precarga el app shell para funcionamiento offline. La telemetria viaja por
 * WebSocket (no se cachea); aqui solo gestionamos los recursos estaticos.
 */

// v8: purga la v7, en la que el SW anterior pudo guardar archivos de /mimata/.
const CACHE = 'nic-shell-v8';
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
  './js/weather.js',
  './js/simulator.js',
  './js/irrigation.js',
  './js/plant.js',
  './js/icons.js',
  './js/ui.js',
  './js/screens/dashboard.js',
  './js/screens/monitoreo.js',
  './js/screens/control.js',
  './js/screens/alertas.js',
  './js/screens/ajustes.js',
  './js/screens/planta.js',
];

self.addEventListener('install', (event) => {
  // Sin .catch: si el precache falla, la instalación se aborta y se conserva el
  // SW y la caché anteriores (en vez de activar uno con la caché vacía).
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Solo cachés propias ("nic-*"): el origen se comparte con MiMata (/mimata/).
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nic-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Solo GET y mismo origen; ignorar WebSocket y peticiones cruzadas.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // MiMata (/mimata/) es otra app con su propio service worker: no la tocamos.
  if (url.pathname.startsWith('/mimata/') || url.pathname === '/mimata') return;

  // Estrategia: cache-first con actualizacion en segundo plano. Se busca SOLO en
  // la caché propia: caches.match() global podría devolver copias de otra app.
  event.respondWith(
    caches.match(req, { cacheName: CACHE }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached || caches.match('./index.html', { cacheName: CACHE }));
      return cached || network;
    })
  );
});
