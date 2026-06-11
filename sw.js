// ============================================================
// UWR Diary — Service Worker
// ============================================================
const CACHE_NAME = 'uwr-diary-v186';

// Pre-cache only the HTML shell.
// All other assets (CSS, JS, images) are cached on first request.
const PRECACHE = ['/index.html', '/'];

// ── Install ──────────────────────────────────────────────────
// HUOM: EI skipWaiting() täällä. Uusi SW jää "waiting"-tilaan kunnes käyttäjä
// painaa sovelluksen "Päivitä"-palkkia (→ SKIP_WAITING-viesti). Näin vältetään
// yllättävä uudelleenlataus ja tuplasplash, ja PWA saa selkeän päivityskehotteen.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
});

// ── Viesti sivulta: ota uusi versio heti käyttöön ────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Activate: delete old caches & take control ───────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // External requests (Firebase, Chart.js CDN etc.) — never intercept
  if (url.origin !== self.location.origin) return;

  // Navigation (HTML): network-first → fallback to cached shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets (CSS, JS, images): cache-first, update in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response?.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => null);
      return cached ?? networkFetch;
    })
  );
});
