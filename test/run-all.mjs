// Sep 12 2026 (real bug found while auditing test coverage, Jeff: "let's handle all of the
// above"): package.json's "test" script used to be one long `node a.mjs && node b.mjs && ...`
// chain. Shell `&&` stops at the FIRST non-zero exit -- so the instant any one test failed
// (including a false alarm caused by leftover sandbox state, not a real regression), every test
// after it in the list silently never ran at all, with no "N tests skipped" message anywhere.
// That's exactly how a stale assertion in notification-swipe-dismiss.mjs (checking for the page
// heading's old "Friends" text, three-plus tests down from vapid-persistence.mjs) sat broken and
// undetected, and how a real bug in focusConnectionsSearch() (crew-sheet-empty-state.mjs, dead
// last in the list) went unexercised.
//
// This runner replaces the chain: it runs every file in the SAME order (a few tests are written
// against shared assumptions from being run after others, even though each spins its own
// server+DB, so order is kept rather than parallelized), lets each one finish regardless of its
// exit code, and prints one clear summary of every file that failed at the very end -- so a
// failure can never again hide the tests behind it.
import { spawnSync } from 'node:child_process';

const CWD = new URL('..', import.meta.url).pathname;
// The full, ordered list this repo's test suite has accumulated file-by-file since the project
// started -- ported verbatim from the old `&&`-chained package.json "test" script (same order,
// same files, nothing added or dropped). Keep this list, not package.json's "test" field, as the
// source of truth for which files run: package.json's "test" is now just `node test/run-all.mjs`.
const files = [
  'test/wiring.mjs', 'test/client-hostile.mjs', 'test/pgmini.mjs', 'test/db-layer.mjs',
  'test/progression.mjs', 'test/data-safety.mjs', 'test/accounts.mjs', 'test/sharing.mjs',
  'test/targets.mjs', 'test/exercise-library-integrity.mjs', 'test/exercise-renames.mjs',
  'test/library-primary-muscle.mjs', 'test/exposure.mjs', 'test/boot-shape.mjs', 'test/limits.mjs',
  'test/ratelimit.mjs', 'test/follow.mjs', 'test/crews.mjs', 'test/per-user-recap.mjs',
  'test/vapid-persistence.mjs', 'test/streak-reminders.mjs', 'test/leave-workout.mjs',
  'test/reset-workouts.mjs', 'test/friends-workouts.mjs', 'test/session-missed.mjs',
  'test/create-flow-draft-persist.mjs', 'test/trend-picks.mjs', 'test/trend-smoothing.mjs',
  'test/feed-freshness.mjs', 'test/rir.mjs', 'test/templates-hide.mjs', 'test/quicklog-parse.mjs',
  'test/sheet-stacking.mjs', 'test/local-finish-date.mjs', 'test/local-streak.mjs',
  'test/streak-weeks.mjs', 'test/hidden-recap-sets.mjs', 'test/message-button-removed.mjs',
  'test/pr-units.mjs', 'test/progress-exercise-pr.mjs', 'test/settings-menu-stack.mjs',
  'test/session-reader-privacy.mjs', 'test/pr-feed-units.mjs', 'test/suggested-edits-cleanup.mjs',
  'test/swap-for-me-and-everyone.mjs', 'test/confirm-sheet-stack.mjs', 'test/stale-save-race.mjs',
  'test/text-entry-double-tap.mjs', 'test/approve-reject-status-guard.mjs',
  'test/audit-v253-server.mjs', 'test/audit-v253-client.mjs', 'test/audit-v254-nav.mjs',
  'test/inline-log-cards.mjs', 'test/first-exercise-notify.mjs', 'test/lockscreen-deeplink-guard.mjs',
  'test/suggest-add-exercise.mjs', 'test/suggest-add-exercise-client.mjs',
  'test/progress-volume-bodyweight.mjs', 'test/progress-volume-bodyweight-client.mjs',
  'test/home-live-window-and-workouts-view.mjs', 'test/seed-your-lifts.mjs',
  'test/plateau-flagging.mjs', 'test/workout-reminders.mjs', 'test/recap-reactions.mjs',
  'test/notifications.mjs', 'test/nav-keyboard-hide.mjs', 'test/deeplink-dispatch.mjs',
  'test/notification-history-grouping.mjs', 'test/moderation.mjs', 'test/session-start.mjs',
  'test/pr-set-record.mjs', 'test/last-set-chip-tap-to-add.mjs', 'test/notifications-dismiss.mjs',
  'test/notification-swipe-dismiss.mjs', 'test/blank-workout-name.mjs', 'test/back-after-start-now.mjs',
  'test/log-rec-not-yet-logged-today.mjs', 'test/rest-timer-edit.mjs', 'test/type-pill-collapse.mjs',
  'test/quick-workout-routine-page.mjs', 'test/assisted-exercise.mjs', 'test/recap-local-date.mjs',
  'test/scheduled-at-validation.mjs', 'test/crew-sheet-empty-state.mjs',
];

// Sep 12 2026, cold-review catch: two real gaps in the first version of this runner.
// (1) No timeout -- a genuinely hung test file (not something this suite has done before, but
// nothing ruled it out either) would block the whole run forever with no summary ever printed --
// exactly the outcome this file exists to prevent. PER_FILE_TIMEOUT_MS bounds every file.
// (2) Each test file spawns its OWN `node server.js` child. Under the old `&&` chain, a hard crash
// in one file always stopped the whole run right there, so a server left running on some test's
// hardcoded port (several files reuse the same port, e.g. 4993) never got a chance to collide with
// a LATER file. This runner deliberately keeps going after a failure, so that protection is gone --
// a crashed or timed-out file's orphaned server.js could make some unrelated later file fail with
// EADDRINUSE, which would misreport as a regression in code the later file never touched. `detached:
// true` makes each test file the leader of its own process group; on a timeout-kill (or any kill by
// signal) this also group-kills whatever child process (its server.js) is still alive, closing that
// gap for the case this runner itself can detect. A test file that already registers its own
// uncaughtException/unhandledRejection cleanup (most of them do, e.g. vapid-persistence.mjs) was
// never at risk here; this is the safety net for one that hangs instead of crashing.
const PER_FILE_TIMEOUT_MS = 90_000;

const results = [];
const startAll = Date.now();
for (const file of files) {
  console.log(`\n\x1b[2m--- ${file} ---\x1b[0m`);
  const start = Date.now();
  const r = spawnSync('node', [file], {
    cwd: CWD, stdio: 'inherit', detached: true,
    timeout: PER_FILE_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  const ms = Date.now() - start;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  if ((timedOut || r.signal) && r.pid && process.platform !== 'win32') {
    // Best-effort group-kill: -pid targets the whole process group spawnSync just made this
    // child the leader of, catching its server.js child too. Already-dead processes just ENOSRCH.
    try { process.kill(-r.pid, 'SIGKILL'); } catch {}
  }
  const ok = r.status === 0 && !r.error;
  results.push({ file, ok, status: r.status, signal: r.signal, ms, timedOut });
  if (!ok) {
    const why = timedOut ? `TIMED OUT after ${PER_FILE_TIMEOUT_MS}ms` : `exit ${r.status ?? 'null'}${r.signal ? ', signal ' + r.signal : ''}`;
    console.log(`\x1b[31m--- ${file} FAILED (${why}, ${ms}ms) ---\x1b[0m`);
  }
}

const failed = results.filter(r => !r.ok);
const totalMs = Date.now() - startAll;
console.log(`\n${'='.repeat(60)}`);
console.log(`${results.length - failed.length}/${results.length} test files passed (${(totalMs / 1000).toFixed(1)}s total)`);
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`);
  for (const f of failed) {
    const why = f.timedOut ? `TIMED OUT after ${PER_FILE_TIMEOUT_MS}ms` : `exit ${f.status ?? 'null'}${f.signal ? ', signal ' + f.signal : ''}`;
    console.log(`  - ${f.file} (${why})`);
  }
} else {
  console.log('\nall test files passed');
}
process.exit(failed.length ? 1 : 0);
