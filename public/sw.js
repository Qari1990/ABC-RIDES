// Service worker: shows push notifications and opens the app when one is tapped.
// It caches nothing, so app updates always reach users straight away.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'ABC Rides', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'ABC Rides', {
    body: data.body || '',
    icon: 'icon.svg',
    badge: 'icon.svg',
    data: { link: data.link || '/' },
    tag: data.link || undefined,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(`/#${event.notification.data.link || '/'}`, self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) { await tab.focus(); return tab.navigate(url); }
    return clients.openWindow(url);
  })());
});
