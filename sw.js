// GitHub Pages can't send custom headers. This service worker adds the two headers that
// make the page "cross-origin isolated", which lets the CPU engine use several threads
// (several times faster). Only same-origin files pass through here; models and libraries
// are fetched directly.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(
    // no-cache = always ask the server if there is a newer version (cheap when nothing changed)
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    })
  );
});
