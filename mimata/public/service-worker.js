/**
 * MiMata — Service Worker (PWA).
 * Alcance: el de este archivo ("/" en su propio proyecto de Vercel). Por si
 * algún día vuelve a compartir origen con otra app:
 *   - solo atiende peticiones dentro de su alcance;
 *   - solo lee y escribe en SU caché (cache.match, no caches.match global);
 *   - al activarse solo borra cachés propias ("mimata-*").
 *
 * Estrategia: RED PRIMERO para todo (HTML, JS, CSS, íconos). Así cada visita
 * con conexión trae la versión publicada, sin mezclar HTML nuevo con JS viejo.
 * La caché es el respaldo sin conexión; si la red tarda más de NETWORK_TIMEOUT_MS
 * y hay copia guardada, se sirve la copia (y la red la actualiza al llegar).
 */

const CACHE = 'mimata-shell-v1';
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './assets/logo.svg',
  './assets/icon-192.png',
  './assets/apple-touch-icon.png',
  './js/app.js',
  './js/route.js',
  './js/views.js',
  './js/store.js',
  './js/identify.js',
  './js/icons.js',
  './js/ui.js',
];

const SCOPE_PATH = new URL(self.registration.scope).pathname; // '/'

self.addEventListener('install', (event) => {
  // Sin .catch: si el precache falla se aborta la instalación y se conserva la
  // versión anterior (en vez de activar un SW con la caché vacía).
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('mimata-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((res) => {
    if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
    return res;
  });

  const cached = (await cache.match(req))
    || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);

  // Sin copia guardada: esperamos a la red lo que tarde.
  if (!cached) return network.catch(() => Response.error());

  // Con copia: la red gana si responde a tiempo; si falla o tarda, va la copia.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  event.respondWith(networkFirst(req));
});
