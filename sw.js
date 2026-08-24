/* App-shell cache so the app opens instantly and works with no signal.
   Only same-origin GET requests are cached; Google APIs always go to network.

   The shell is fetched network-first, with the cached copy used only when the
   network does not answer within a moment. Cache-first would be faster by a
   few hundred milliseconds, but it also means that a broken build, once
   stored, is served forever — the phone would keep opening the copy that does
   not work, which is the opposite of what a cache is for. Correctness wins;
   offline still works, because a failed or slow fetch falls straight back to
   the stored copy.                                                          */

/* Keep in step with APP_VERSION in app.js. Changing it retires every older
   cache on activate. */
const CACHE = 'receipts-2026-08-24.5';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon-180.png', './icon-512.png'];
const NET_TIMEOUT = 3500;

/* The files that make up the running app. Icons are excluded on purpose —
   they never go stale in a way that breaks anything, so they stay cache-first. */
function isShell(url) {
  return url.pathname.endsWith('/') ||
         /\.(html|js|css|webmanifest)$/i.test(url.pathname);
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      /* One bad entry must not fail the whole install and leave the app with
         no offline copy at all, so each file is added on its own. */
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Lets the page ask for an immediate takeover instead of waiting for a cold
   start — used by Repair app. */
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

/* Resolves only with a response worth showing. A 503 from a half-finished
   deploy, or the login page a hotel wifi substitutes, must not be served in
   place of the stored app — and must certainly not overwrite it. Anything
   else rejects, which sends the caller to the cache. */
function usable(res) {
  return res && res.ok && res.type !== 'opaqueredirect' && !res.redirected;
}

function fromNetwork(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((res) => {
      clearTimeout(timer);
      if (!usable(res)) return reject(new Error('unusable'));
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      resolve(res);
    }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isShell(url)) {
    /* Network first: whatever is deployed wins over whatever is stored. */
    e.respondWith(
      fromNetwork(req, NET_TIMEOUT).catch(() =>
        caches.match(req)
          .then((hit) => hit || caches.match('./index.html'))
          .then((hit) => hit || caches.match('./'))
          /* Install adds each shell file separately and tolerates a failure,
             so the cache can genuinely be missing this one. Resolving with
             undefined would turn an offline launch into a browser error
             page; an honest 503 at least says what happened. */
          .then((hit) => hit || new Response(
            'Offline, and this app is not stored on the phone yet.',
            { status: 503, headers: { 'Content-Type': 'text/plain' } }))
      )
    );
    return;
  }

  /* Everything else — icons and the like. Serve the stored copy at once and
     refresh it quietly for next time. */
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (usable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
