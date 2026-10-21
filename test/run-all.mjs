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
  'test/ex-accordion-collapse.mjs',
  'test/quick-workout-routine-page.mjs', 'test/assisted-exercise.mjs', 'test/recap-local-date.mjs',
  'test/scheduled-at-validation.mjs', 'test/crew-sheet-empty-state.mjs',
  'test/block-crew-streak-privacy.mjs', 'test/progress-additions.mjs',
  'test/training-phase.mjs', 'test/hide-joinable.mjs', 'test/swipe-delete-home.mjs',
  'test/profile-back-button.mjs', 'test/starter-routines.mjs',
  'test/exercise-removal-approval.mjs', 'test/viewpost-swap-attribution.mjs',
  'test/recap-shows-own-sets-only.mjs', 'test/suggestion-stack.mjs',
  'test/participant-departure-cleanup.mjs', 'test/recap-trained-with-and-invite-banner.mjs',
  'test/lifecycle-audit-round3.mjs', 'test/lifecycle-audit-round4.mjs',
  'test/ownerless-workout-flow.mjs', 'test/ownerless-workout-flow-client.mjs',
  'test/reinvite-request.mjs', 'test/exercise-sheet-cta.mjs', 'test/volume-local-date.mjs',
  'test/audit9-progress-fixes.mjs', 'test/audit9-client-fixes.mjs', 'test/audit9-pr-visibility.mjs',
  'test/audit10-feed-hero-fixes.mjs', 'test/audit10-avatar-photo-everywhere.mjs',
  'test/posted-workout-add-set.mjs', 'test/account-settings.mjs',
  'test/audit-sep30-fixes.mjs', 'test/custom-exercise-library-refresh.mjs',
  'test/audit-oct1-tier1-fixes.mjs', 'test/password-confirm-sheet-double-tap.mjs',
  'test/audit-oct1-tier2-invite-block.mjs', 'test/audit-oct1-block-list-visibility.mjs',
  'test/audit-oct2-routine-share.mjs', 'test/audit-oct2-custom-ex-lock.mjs',
  'test/audit-oct2-full-editor-removal-check.mjs', 'test/audit-oct2-blocked-profile.mjs',
  'test/audit-oct2-privacy-toggle-wording.mjs', 'test/audit-oct2-challenge-blocked-contradiction.mjs',
  'test/posted-workout-set-reorder.mjs',
  'test/home-live-session-activity-line.mjs',
  'test/whos-in-chip-opens-profile.mjs',
  'test/audit-oct9-batch-fixes.mjs',
  'test/audit-oct10-batch2-fixes.mjs',
  // Oct 10 2026 (found while verifying an unrelated icon-sizing fix): this file already existed,
  // already covered real behavior (the Sep 1 favorites feature), and was never added here -- the
  // exact "sat broken and undetected" failure mode this runner's own comment above warns about.
  // Its one stale assertion (a close-button markup regex left over from before that button became
  // an .icon-btn) was fixed alongside adding it, not before -- see that file's own comment.
  'test/favorite-exercises.mjs',
  // Oct 10 2026 (deep-dive audit, Jeff: "let's correct everything"): two more real, git-tracked,
  // currently-passing test files found never wired in here -- same exact gap as
  // favorite-exercises.mjs above, the third and fourth time this has happened. db-diff-writes.mjs
  // in particular is the regression test for the Sep 8 2026 "diffed writes" rewrite of save() --
  // it's the thing proving that rewrite doesn't silently corrupt or drop data, and it was running
  // in nobody's CI. Neither file needed any fix to pass; both were just missing from this list.
  'test/cancel-suggestion.mjs',
  'test/db-diff-writes.mjs',
  // Oct 11 2026 (deep-dive audit, Jeff: "for #1 lets do what is best for long term overall"):
  // proves scripts/backup-db.sh (the off-platform nightly backup's dump+encrypt+restore logic)
  // actually round-trips real data, including the disaster-recovery shape of restoring OVER an
  // already-populated, wrong database. See .github/workflows/backup.yml for the scheduled job
  // that runs the real thing in production.
  'test/backup-roundtrip.mjs',
  // Oct 12 2026 (Jeff: "I want the ability to delete any account I see fit" -- cleaning up fake/
  // test accounts before launch): the new admin-initiated account deletion (built on the existing
  // self-delete teardown, reused rather than duplicated) and the /healthz user-count fix that was
  // the actual point of the ask. Added to this list the same run it was written, specifically
  // because this exact "written but never wired into npm test" gap has now bitten this project
  // four separate times (favorite-exercises.mjs, cancel-suggestion.mjs, db-diff-writes.mjs,
  // backup-roundtrip.mjs, all just above) -- see this file's own header comment.
  'test/admin-user-management.mjs',
  // Oct 12 2026 (scaling fix, Jeff: "it seems we should fix this now"): rebuildAllPrs() used to
  // replay the WHOLE app's history on nearly every workout action; this scopes the 6 highest-
  // frequency routes to a new rebuildPrsFor(userIds) that only touches the affected user(s).
  // Added to this list the same run it was written -- same discipline as admin-user-management.mjs
  // just above, after this project's own repeated "written but never wired in" gap.
  'test/pr-rebuild-scoping.mjs',
  // Oct 12 2026 (scaling fix round 2): sessionsForUser/weeksFor/volumeFor/volumeTrendFor/
  // liftHistoryFor/plateausFor used to scan EVERY session in the app to find one user's own
  // history; this adds DB.sessionsByUser, an incrementally-maintained index, scoped the same
  // read-side way the PR rebuild was scoped on the write side above. Added to this list the same
  // run it was written, same discipline as the two entries just above.
  'test/sessions-by-user-index.mjs',
  // Oct 12 2026 (scaling fix #1, visibility): GET /api/admin/scaling -- memory/counts/latency,
  // admin-token-gated. Added to this list the same run it was written, same discipline as above.
  'test/admin-scaling-visibility.mjs',
  // Oct 13 2026 (rearchitecture, notifications+feed-events slice, task #245's ground-truth
  // differential test -- see CLAUDE.md "Rearchitecture status"/"Rearchitecture safeguards"):
  // drives the real HTTP routes and checks the new direct-Postgres path agrees with the old
  // in-memory one, including the two real concurrency races the slice's pre-mortem flagged. This
  // is also the test that caught a real bug (the generic save(DB) diff-sync and the new
  // functions fighting over the same rows -- see db.js's own comment on that fix) the same run it
  // was written, same discipline as every entry above.
  'test/notifications-feed-migration-differential.mjs',
  // Oct 14 2026 (rearchitecture, push subs/custom exercises/reports slice, task #258+'s
  // ground-truth differential test -- see CLAUDE.md "Rearchitecture status"/"Rearchitecture
  // safeguards"): same technique as the entry just above, for this slice. Also the test that
  // proves the custom-exercises shadow-compare safety net actually fires on a real divergence,
  // not just "it didn't throw." Added to this list the same run it was written, same discipline
  // as every entry above.
  'test/pushsubs-customex-reports-migration-differential.mjs',
  // Oct 14 2026 (Jeff: "resolve the issue you flagged but are not fixing" -- the pre-existing
  // mutate-before-maybe-failing-save hazard disclosed, but deliberately not fixed, in the
  // previous slice's report). Proves live, for all four affected routes (custom-exercise create/
  // edit/delete, and POST /api/report's optional alsoBlock), that a rigged save(DB) failure no
  // longer leaves its in-memory mutation stranded unpersisted -- each is reverted to match
  // whatever Postgres actually ended up holding. Added to this list the same run it was written,
  // same discipline as every entry above.
  'test/mutate-before-save-ordering-regression.mjs',
  // Oct 16 2026 (disaster-recovery wipe bug -- found while writing a regression test for the
  // customExerciseRows orphan-deletion fix in the differential test above, reported to Jeff
  // immediately per hard rule #11, fixed same day on his go-ahead -- see CLAUDE.md
  // "Rearchitecture status"). Proves live that the documented recovery script
  // (scripts/migrate-to-postgres.mjs) no longer wipes push_subs/notifications/feed_events/
  // reports/custom_exercise_rows when run against a backup taken by the current app (every
  // backup from now on), while still correctly restoring -- including orphan deletion -- from a
  // genuine old-style backup that predates these collections' cutovers. Added to this list the
  // same run it was written, same discipline as every entry above.
  'test/migrate-recovery-no-wipe-regression.mjs',
  // Oct 16 2026 (crews deep-dive, decision #1 -- messages/challenges moved to their own tables,
  // Jeff: "good to go ahead" -- ground-truth differential test, see CLAUDE.md "Rearchitecture
  // status"/"Rearchitecture safeguards"). Proves migrateCrewMessagesAndChallengesIntoPostgres is
  // lossless (every legacy embedded message/challenge actually lands in the new tables with its
  // content intact, and the old embedded fields are actually removed from the crew's row),
  // idempotent (a second boot against an already-migrated database is a true no-op, not a
  // duplication), and crash-safe (a crew already migrated on an earlier boot coexists correctly
  // with one that still has embedded fields, each handled independently). Added to this list the
  // same run it was written, same discipline as every entry above.
  'test/crew-messages-challenges-migration-differential.mjs',
  // Oct 16 2026 (crews deep-dive, decision #2 -- crew-row normalization): ground-truth
  // differential test for migrateCrewRowColumnsIntoPostgres, same discipline as decision #1's own
  // entry just above but for name/owner_id/created_at + the crew_members join table instead of
  // messages/challenges -- lossless, ORDER-preserving (a real regression risk this migration's own
  // design surfaced, not hypothetical), idempotent, and crash-safe.
  'test/crew-row-column-migration-differential.mjs',
  // Oct 16 2026 (users slice, decision #1 -- follow-graph redesign). Ground-truth differential
  // test for migrateUserFollowsIntoPostgres/user_follows, same discipline as the two crew entries
  // just above -- written specifically because it catches a CRITICAL bug (both independent
  // review passes found it, this test reproduces it live and proves it fixed) that
  // test/follow.mjs's own migration test could not: seeding REALISTIC post-followApprovalV1
  // legacy data (non-empty following/followReqs already embedded, matching any real deploy)
  // rather than the trivial friends-only shape, which is what exposes the save-wipes-the-
  // migration hazard. Added to this list the same run it was written.
  'test/user-follows-migration-differential.mjs',
  // Oct 16 2026 (users slice, decision #2 -- scalar profile/settings column normalization).
  // Ground-truth differential check for migrateUserScalarColumnsIntoPostgres/the new
  // users.username/display_name/bio/... columns -- lossless backfill (including explicit
  // false/true booleans, not just missing-vs-present), the raw-Postgres-boolean-is-text-'t'/'f'
  // gotcha proven both at the SQL layer and through real login/self-view behavior, idempotency,
  // a real post-migration edit surviving a restart, and a brand-new user needing no backfill at
  // all. Added to this list the same run it was written.
  'test/user-scalar-columns-migration-differential.mjs',
  // Oct 17 2026: proves the NUL-byte/lone-surrogate save-jamming fix (pgmini.js's
  // sanitizePgText(), the universal bound-parameter backstop + capStr()'s own use of it) --
  // a poisoned text field no longer 500s a save and, critically, no longer jams a COMPLETELY
  // DIFFERENT user's very next save the way the pre-fix code did. Added the same run it was
  // written.
  'test/nul-byte-save-sanitization-regression.mjs',
  // Oct 17 2026: proves the sessions & logs rearchitecture slice (decision #1) -- the 46-route
  // mutate-before-maybe-failing-save sweep, the cross-route lock-overlap retrofit it uncovered
  // mid-build, and POST /api/sessions/:id/variation's brand-new save-failure protection. See the
  // file's own header comment for exactly what each assertion proves and what it deliberately
  // does not attempt.
  'test/sessions-logs-mutate-before-save-regression.mjs',
  // Oct 18 2026: proves the Phase 1 full-app hazard sweep -- every DB.users route, session/crew/
  // template creation, PUT /api/crews/:id, the brand-new withTemplateLock primitive across all 8
  // DB.templates routes, and anonymizeAndDeleteAccount (account deletion), the single biggest
  // blast-radius fix in this engagement. See the file's own header comment for exactly what it
  // covers (representative patterns, not every route individually) and the one documented thing
  // it deliberately does not attempt (the background reminder timers' reorder).
  'test/phase1-mutate-before-save-regression.mjs',
  // Oct 18 2026: Phase 2 (Sentry activation + structuring the scattered console.error calls).
  // Proves booting with a real SENTRY_DSN still boots clean and behaves identically to every
  // other test file's SENTRY_DSN-less boot (same status codes, same revert behavior, server
  // stays responsive) now that every non-fatal catch site also calls reportNonFatal(), and
  // separately proves the one real bug this slice found and fixed: a boot-time crash used to
  // bypass fatalCrash() (and therefore Sentry) entirely.
  'test/phase2-sentry-nonfatal-reporting.mjs',
  // Phase 3 Slice 1a (off-single-machine prep): proves AUTH_SECRET env var support on
  // loadOrCreateSecret() -- unchanged behavior when unset, the file genuinely untouched when
  // set, and the actual payoff: two independent "machines" (separate DATA_DIRs, no shared disk)
  // booted with the same AUTH_SECRET trust each other's tokens.
  'test/phase3-auth-secret-env.mjs',
  // Phase 3 Slice 1b (off-single-machine prep): proves storage.js's local-disk fallback is
  // byte-identical to the old fs.* calls for all five call sites (avatar upload/replace, recap
  // photo upload+serving via a media token, account-deletion cleanup) and the new hand-rolled
  // /uploads/:fname route's path-traversal rejection -- plus, against a real (unreachable)
  // network endpoint, that the actual @supabase/supabase-js client is really wired in and drives
  // the documented write/read/delete asymmetry once Jeff sets the three env vars.
  'test/phase3-photo-storage-slice1b.mjs',
  // Phase 3 Slice 1c (off-single-machine prep): backupOnBoot() now goes through storage.js too.
  // test/data-safety.mjs already covers the unconfigured path unmodified (one backup per boot,
  // pruned to 10, documented restore works) -- this file covers what's new: a Storage-configured
  // boot survives a failed backup instead of crashing, a failed write never silently falls back
  // to the local disk it was configured to stop using, and storage.listObjects()'s prune-across-
  // both-locations union degrades gracefully to local-only when the Storage side errors.
  'test/phase3-backup-storage-slice1c.mjs',
  // Phase 3 Slice 2 (disposable machine): fatalCrash() (server.js -- the one function
  // uncaughtException/unhandledRejection/the boot IIFE's rejection all funnel through) used to
  // call Sentry.captureException(err) then process.exit(1) immediately, with zero grace period for
  // the actual async HTTP POST to Sentry's ingestion endpoint -- meaning every crash alert since
  // Phase 2 shipped had silently never actually been delivered. Proves, against the real
  // @sentry/node client and a real local HTTP receiver, that the event now genuinely arrives
  // before the process exits, and that an unreachable Sentry endpoint still lets the process exit
  // within a bounded window rather than hanging.
  'test/phase3-sentry-flush-before-exit-slice2.mjs',
  // Oct 20 2026 (app-store readiness review, "13+ self-attestation" age gate): the one file that
  // actually exercises POST /api/register's new ageConfirmed requirement itself -- missing/falsy
  // is refused with the real error and no account created, truthy succeeds and the attestation
  // (not a birthdate) is what lands in the row. Every other file that registers a user was just
  // updated to pass ageConfirmed as fixture setup; none of them test the gate.
  'test/age-gate.mjs',
  // Oct 20 2026 (same readiness review, second half: "lets do the age gate logic and the data
  // export"). POST /api/me/export-data -- password-confirmed, rate-limited, scoped via the shared
  // sessionTouchesUser predicate so export and account-deletion can never silently disagree about
  // "what's mine." Covers denylist correctness (no pinHash/pinSalt/tokensValidFrom ever leaves the
  // server), per-user scoping (another user's sessions/crews never leak in), and the route's own
  // 5/hour rate limit.
  'test/data-export.mjs',
  // Oct 20 2026: app-store readiness, bot-defense item. Unconfigured no-op (today's real deploy),
  // the configured path against a real local server standing in for Cloudflare's siteverify
  // (request shape, success, genuine failure, missing-token short-circuit, and the disclosed
  // fail-OPEN behavior on a transport error), and /api/config's turnstileSiteKey exposure.
  'test/turnstile-bot-defense.mjs',
  // Oct 20 2026: rate-limiting re-evaluation. Proves the new app-wide registration circuit breaker
  // (server.js, POST /api/register) counts only real created accounts (never rejected attempts),
  // and -- the actual point -- blocks sign-ups from a brand-new IP that has never registered before
  // once the budget's spent, proving it's a true global ceiling a rotating-IP adversary can't
  // sidestep the way the pre-existing per-IP cap alone could be.
  'test/global-signup-circuit-breaker.mjs',
  // Oct 20 2026: content-filter expansion (readiness-review item: "Expand content filtering beyond
  // custom exercise names to display names, captions, crew/session names, and other free text").
  // Covers every free-text field across the app plus the two deliberate exclusions (draftNotes,
  // report "details"), and the leo-profanity _/- separator gap found and fixed while building this.
  'test/content-filter-expansion.mjs',
  // Oct 21 2026: moderation tooling (readiness-review item "moderation tooling"). Slice A --
  // GET /api/admin/reports/grouped groups reports about the same target for admin.html's new
  // triage view. Slice B -- comments auto-hide (reversible) after 3 distinct reporters.
  'test/moderation-triage-queue.mjs',
  'test/moderation-auto-hide-comments.mjs',
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
