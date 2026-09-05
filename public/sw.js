const CACHE_NAME = 'torneo-colores-v12';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/admin.html',
  '/manifest.json',
  '/css/styles.css',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/js/app.js',
  '/js/admin.js',
  '/js/firebase.js',
  '/js/firebasePublic.js',
  '/js/config.js',
  '/js/tournamentRefs.js',
  '/js/tournament.js',
  '/js/standings.js',
  '/js/roundRobin.js',
  '/js/categorias.js',
  '/js/matchStatus.js',
  '/js/permissions.js',
  '/js/email.js',
  '/js/utils.js'
];

const FIREBASE_API_HOSTS = [
  'firestore.googleapis.com',
  'firebaseio.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

function isFirebaseApi(url) {
  return FIREBASE_API_HOSTS.some((h) => url.includes(h));
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      return caches.match('/index.html');
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  if (isFirebaseApi(request.url)) return;

  const url = new URL(request.url);

  // SDK de Firebase en gstatic es inmutable → cache-first
  if (url.hostname === 'www.gstatic.com') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Google Fonts → stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Navegación → network-first con fallback a cache
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Estáticos propios (HTML, CSS, JS, imágenes, manifest) → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});