// ORBIT phone app: keeps the app's own files on the phone so it opens instantly.
// Everything personal (API, live connection) always comes fresh from your PC and is never cached.
const CACHE = 'orbit-shell-v1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'core.js', 'voice.js', 'pcm-worklet.js', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  // Network first (always the latest version from your PC), falling back to the saved copy.
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
