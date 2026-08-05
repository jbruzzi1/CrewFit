self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'CrewFit', body: '' };
  event.waitUntil(self.registration.showNotification(data.title || 'CrewFit', { body: data.body || '', icon: '/icon-192.png' }));
});
self.addEventListener('notificationclick', () => { self.clients.openWindow('/'); });
