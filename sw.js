// Minimal service worker — exists only so the browser considers the site
// installable (Chrome's "Install app" prompt requires a fetch handler).
// No offline caching; every request just goes straight to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
