// Jeff, Aug 31: "I want to see the exercise I'm currently working on my lock screen... tap to log
// a set." Ships as a one-time push notification, fired from POST /api/sessions when a workout is
// actually STARTING (not merely scheduled ahead) -- see notify-helpers.js's own long comment for
// the full reasoning, including why a real always-live lock-screen card (Apple's Live Activity) is
// out of scope for this web app.
//
// This codebase deliberately never push-tests notify() itself (see test/streak-reminders.mjs's own
// comment: no test user has a real push subscription, so notify() silently no-ops for all of them,
// same as every other route's notify() call). The only testable surface for this feature is the
// PURE decision logic -- does a given session produce a notification, and with the right payload --
// which is why it was pulled out into notify-helpers.js as a plain function instead of living
// inline in the route handler. No server spawn needed here at all.
import { firstExerciseStartNotification, START_WINDOW_MS } from '../notify-helpers.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const NOW = Date.parse('2026-08-31T18:00:00Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const session = (overrides) => Object.assign({
  id: 'sess_1',
  scheduledAt: iso(0),
  exercises: [{ id: 'e_bench', name: 'Bench Press' }, { id: 'e_squat', name: 'Squat' }],
}, overrides);

console.log('starting right now, with exercises -> fires, correct payload');
{
  const r = firstExerciseStartNotification(session(), NOW);
  ok(!!r, 'returned a notification');
  ok(r && r.sid === 'sess_1', `sid is the session id (got ${r && r.sid})`);
  ok(r && r.exId === 'e_bench', `exId is the FIRST exercise's id, not any other (got ${r && r.exId})`);
  ok(r && r.body === 'Bench Press — tap to log a set', `body names the exercise (got ${r && r.body})`);
  ok(r && r.title === 'CrewFit', `title is CrewFit (got ${r && r.title})`);
}

console.log('\nno exercises yet (empty "Quick Workout") -> does not fire');
{
  const r = firstExerciseStartNotification(session({ exercises: [] }), NOW);
  ok(r === null, `nothing to name yet -> null (got ${JSON.stringify(r)})`);
}

console.log('\nscheduled well into the future (planning ahead, not starting) -> does not fire');
{
  const r = firstExerciseStartNotification(session({ scheduledAt: iso(60 * 60 * 1000) }), NOW); // 1hr ahead
  ok(r === null, `an hour ahead reads as "planned," not "starting" (got ${JSON.stringify(r)})`);
}

console.log('\nscheduled well in the past (a backdated/edited session) -> does not fire');
{
  const r = firstExerciseStartNotification(session({ scheduledAt: iso(-60 * 60 * 1000) }), NOW);
  ok(r === null, `an hour in the past is not "starting now" either (got ${JSON.stringify(r)})`);
}

console.log('\nright at the edge of the "starting now" window');
{
  const justInside = firstExerciseStartNotification(session({ scheduledAt: iso(START_WINDOW_MS - 1000) }), NOW);
  ok(!!justInside, `just inside the window still fires (${START_WINDOW_MS - 1000}ms off)`);
  const justOutside = firstExerciseStartNotification(session({ scheduledAt: iso(START_WINDOW_MS + 60000) }), NOW);
  ok(justOutside === null, `just outside the window does not (${START_WINDOW_MS + 60000}ms off)`);
}

console.log('\nmalformed input never throws, just declines to notify');
{
  ok(firstExerciseStartNotification(null, NOW) === null, 'null session -> null, no throw');
  ok(firstExerciseStartNotification({}, NOW) === null, 'empty object -> null, no throw');
  ok(firstExerciseStartNotification(session({ scheduledAt: 'not a date' }), NOW) === null, 'garbage scheduledAt -> null, no throw');
  ok(firstExerciseStartNotification(session({ exercises: [null] }), NOW) === null, 'a null exercise entry -> null, no throw');
  ok(firstExerciseStartNotification(session({ exercises: [{ id: 'e1' }] }), NOW) === null, 'an exercise missing a name -> null, no throw');
  ok(firstExerciseStartNotification(session({ exercises: [{ name: 'Row' }] }), NOW) === null, 'an exercise missing an id -> null, no throw (nothing to deep-link to)');
}

console.log('\nreal-world defaults: workoutNow()/finishCreate\'s own "now" fallback both stamp scheduledAt to Date.now() at the moment of creation');
{
  // Simulates the actual client behavior this whole feature leans on (see notify-helpers.js's
  // comment): scheduledAt computed independently, microseconds after NOW, exactly like a real
  // request would produce it -- not hand-set to precisely NOW as every other case above does.
  const realisticNow = Date.now();
  const s = session({ scheduledAt: new Date().toISOString() });
  const r = firstExerciseStartNotification(s, realisticNow);
  ok(!!r, 'a session created via the real "now" pattern fires');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
