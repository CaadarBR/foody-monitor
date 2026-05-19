self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      // Se tem aba do monitor aberta e visível, não duplica notificação
      if (cs.some(c => c.visibilityState === 'visible')) return;
      return self.registration.showNotification(data.title || '🍕 Foody Monitor', {
        body: data.body || '',
        tag: data.tag || 'alert',
        requireInteraction: data.type === 'missing',
        vibrate: [200, 100, 200],
        data: { url: self.registration.scope },
      });
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.startsWith(self.registration.scope));
      return existing ? existing.focus() : self.clients.openWindow(self.registration.scope);
    })
  );
});
