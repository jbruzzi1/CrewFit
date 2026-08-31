'use strict';
// Small, dependency-free logic pulled out of server.js so it can be unit-tested directly without
// spawning the server or a real push subscription -- this codebase deliberately never push-tests
// notify() itself (see test/streak-reminders.mjs's own comment: "actual push delivery [is not]
// push-tested in this suite... same as how no other route's notify() call is push-tested"). The
// only testable surface for any notify()-triggering decision is the PURE logic that decides
// whether to call it and with what payload -- this file is that surface for the "starting a
// workout" lock-screen notification.

// Jeff, Aug 31: "I want to see the exercise I'm currently working on my lock screen... tap to log
// a set." A true always-live lock-screen card (Apple's Live Activity, like Hevy's) needs a real
// native iOS app -- out of scope for this web app (confirmed with Jeff in chat, who wants that as
// a separate native-app project down the road). What an ordinary web push notification CAN do:
// fire once, right when a workout actually STARTS, naming the first exercise -- tapping it
// best-effort opens straight to that exercise's log sheet (see public/sw.js's notificationclick
// handler and public/app.js's openLog handling in tryBoot() / the serviceWorker message listener).
// iOS does not support real action buttons on web push (confirmed via research, Aug 31) and does
// not reliably deep-link when the app isn't already running -- Jeff was told this plainly before
// asking to ship the smaller version anyway.
//
// "Starts" is deliberately narrower than "was created": POST /api/sessions also handles scheduling
// a workout for next Tuesday, and lighting up someone's lock screen the moment they PLAN something
// a week out -- not about to open the app and lift -- would be a wrong, unearned interruption, not
// the feature Jeff asked for. The app's own existing flows always stamp scheduledAt to right now
// when nothing else is specified (createQuickWorkout in app.js; the normal create-flow's own
// `dt ? new Date(dt) : new Date()` fallback in finishCreate) -- so "scheduledAt is within a few
// minutes of now" is what actually distinguishes "starting now" from "planning ahead," without
// needing a new field on the session or a new user-facing toggle.
const START_WINDOW_MS = 5 * 60 * 1000;

// nowMs is injectable so tests can pin "now" instead of racing the real clock.
function firstExerciseStartNotification(session, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!session || !Array.isArray(session.exercises) || !session.exercises.length) return null; // nothing to name yet
  const first = session.exercises[0];
  if (!first || !first.id || !first.name) return null;
  const when = new Date(session.scheduledAt);
  if (isNaN(when.getTime())) return null;
  if (Math.abs(when.getTime() - now) > START_WINDOW_MS) return null; // planned ahead, not starting now
  return {
    title: 'CrewFit',
    body: `${first.name} — tap to log a set`,
    sid: session.id,
    exId: first.id,
  };
}

module.exports = { firstExerciseStartNotification, START_WINDOW_MS };
