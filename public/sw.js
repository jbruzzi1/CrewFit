self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'CrewFit', body: '' };
  // `data` (below) carries sid/exId through to notificationclick for the "starting a workout"
  // notification (server.js's firstExerciseStartNotification) -- harmless passthrough for every
  // other notification type (invites, streak reminders), which just won't have those fields.
  event.waitUntil(self.registration.showNotification(data.title || 'CrewFit', { body: data.body || '', icon: '/icon-192.png', data }));
});
// Jeff, Aug 31: deep-link into the log sheet for the exercise a "starting a workout" notification
// named, best-effort. iOS Safari does not support the Notification API's own action buttons (no
// browser honors event.action there — confirmed via research, Aug 31), so the whole notification
// body is the tap target and this is the only interactivity available.
// Two paths, in order:
//  1. The app is already open in some tab/window (common case -- someone starts a workout, then
//     locks their phone without leaving the app): focus that window and hand off the deep link via
//     postMessage, rather than a hard navigate that would blow away whatever else was on screen.
//  2. No open window: fall back to opening one at a URL app.js's boot sequence (tryBoot) reads an
//     `openLog` query param from, since there is nothing running yet to postMessage to.
// iOS is known to be inconsistent about routing a fresh launch to a specific URL versus just
// foregrounding the app (see notify-helpers.js's comment) -- this is the best available, not a
// guarantee; worst case it opens to the home screen, which was disclosed up front.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = (data.sid && data.exId) ? `/?openLog=${encodeURIComponent(data.sid)}:${encodeURIComponent(data.exId)}` : '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        if (data.sid && data.exId) client.postMessage({ type: 'openLog', sid: data.sid, exId: data.exId });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
