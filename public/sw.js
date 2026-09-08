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
//
// Sep 8 2026 (Jeff, lock-screen screenshot: "when I click on a push notification it should open
// to where the notification happened... currently it just opens to where I was last"). Every
// OTHER notify() call in server.js (a comment, a swap request, someone joining, a reaction, a new
// follower...) used to carry no destination at all, so this handler had nothing to act on for any
// of them and just focused/opened the app wherever it happened to be. server.js's notify() now
// tags most of its payloads with `link: {type, ...ids}` (see the long comment above notify() in
// server.js for the full list of types and what each one means) -- this generalizes the SAME
// two-path shape the original sid/exId case already used below, rather than replacing it: sid/exId
// stays exactly as it was (its own postMessage type, its own query param) since it predates `link`
// and nothing about it needed to change; `link` is handled as a second, independent case.
//
// Two paths, in order, same as before:
//  1. The app is already open in some tab/window (common case -- someone gets a notification, then
//     taps it without ever having left the app): focus that window and hand off the deep link via
//     postMessage, rather than a hard navigate that would blow away whatever else was on screen.
//  2. No open window: fall back to opening one at a URL app.js's boot sequence (tryBoot) reads an
//     `openLog`/`dl` query param from, since there is nothing running yet to postMessage to.
// iOS is known to be inconsistent about routing a fresh launch to a specific URL versus just
// foregrounding the app (see notify-helpers.js's comment) -- this is the best available, not a
// guarantee; worst case it opens to the home screen, which was disclosed up front.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const hasSessionLog = !!(data.sid && data.exId);
  const hasLink = !hasSessionLog && data.link && typeof data.link === 'object' && typeof data.link.type === 'string';
  let url = '/';
  if (hasSessionLog) url = `/?openLog=${encodeURIComponent(data.sid)}:${encodeURIComponent(data.exId)}`;
  else if (hasLink) url = `/?dl=${encodeURIComponent(JSON.stringify(data.link))}`;
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        if (hasSessionLog) client.postMessage({ type: 'openLog', sid: data.sid, exId: data.exId });
        else if (hasLink) client.postMessage({ type: 'deepLink', link: data.link });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
