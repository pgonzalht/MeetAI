// Two jobs:
// 1. Adds the headers that make the page "cross-origin isolated" (GitHub Pages can't send
//    custom headers). That lets the CPU engine use several threads: much faster.
// 2. Keeps a copy of the whole app, so after the first visit it opens with no internet at all.
const VERSION = 'meetai-v3';
const SHELL = ['./', 'index.html', 'app.js', 'worker.js', 'voice-worker.js', 'acta.js', 'audio-processor.js', 'demo.wav', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      // one by one: a single missing file must not leave the app without a copy
      await Promise.allSettled([...SHELL, LIB].map((u) => cache.add(u)));
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(keys.filter((k) => k.startsWith('meetai-') && k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })
  );
});

function isolated(res) {
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mine = url.origin === self.location.origin;
  // The library and the ONNX runtime come from a version-pinned CDN; the voice model is
  // cached by Transformers.js itself, so it is left alone.
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!mine && !cdn) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  e.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      if (cdn) {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }
      try {
        // ask the server every time, so an update is picked up straight away
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return isolated(res);
      } catch (err) {
        const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
        if (hit) return isolated(hit);
        throw err;
      }
    })()
  );
});
