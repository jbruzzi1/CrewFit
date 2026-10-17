// Oct 16 2026 (users slice, decision #2 -- scalar profile/settings column normalization, after
// decision #1 moved followers/following/followReqs off this blob). Ground-truth differential
// check for migrateUserScalarColumnsIntoPostgres (server.js), the boot migration that backfills
// the NEW users.username/display_name/bio/avatar/default_gym/profile_visibility/units/
// created_at/created_at_estimated/pin_hash/pin_salt/deleted/deleted_at/tokens_valid_from/
// seen_rir_explainer/training_phase/notify_streak_reminders/notify_workout_reminders/
// last_streak_reminder_at/last_workout_reminder_at columns (db.js) from the OLD users.data jsonb
// blob -- same technique as test/crew-row-column-migration-differential.mjs: drive the real
// server through its real HTTP routes, patch real rows directly in Postgres to simulate the OLD
// pre-migration shape (a brand-new user already lands in the new-columns shape -- /api/register
// marks it migrated before its very first save), then reboot and check both the HTTP-visible
// result AND the raw Postgres rows.
//
// The one thing this test exists specifically to catch, found at pre-mortem time before any code
// shipped (not a hypothetical): pgmini's client always requests TEXT result format, so a Postgres
// `boolean` column comes back from ANY raw SELECT as the literal string 't' or 'f', never a JS
// true/false -- and 'f' is a non-empty, TRUTHY string. db.js's pgBool() helper exists only to fix
// this before these columns ever land back on an in-memory user object. Skipping it would have
// silently flipped every false/not-yet-set flag (deleted, createdAtEstimated, seenRirExplainer,
// notifyStreakReminders, notifyWorkoutReminders) to "on" the moment this shipped -- for `deleted`
// specifically, that means a real, never-deleted account would fail to log in right after this
// migration ran. Proven below two ways: raw Postgres reads in this test assert the literal 't'/
// 'f' text (what's actually in the column), and separate app-level assertions (login, the self-
// view profile endpoint) prove the SERVER reads those same columns back as real booleans, not
// truthy strings.
//
// Four more things proven here, each live rather than just trusted:
//   - lossless: every one of the ~20 scalar fields, including explicit `false` values (not just
//     "missing" vs "present"), survives the move from embedded blob fields to real columns.
//   - safe defaults for malformed/empty legacy data: a user whose `data` blob is just `{}` (no
//     username, no id, nothing) still backfills (falling back to the row's own id for the
//     migration-complete signal column, same defense-in-depth crews' crewRowParams already uses
//     for `name`) and does not crash boot.
//   - idempotent: running it again (a second boot against the same, already-migrated database) is
//     a true no-op -- no column changes.
//   - a real post-migration profile edit lands on the new column, and a brand-new user created
//     AFTER this migration shipped already has its columns populated AND its blob already
//     excludes these fields from creation, no backfill needed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5906, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'user-scalar-cols-migrate-diff-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('userscalarcolsmigratediff');
const J = { 'Content-Type': 'application/json' };
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

function boot() {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    srv.stdout.on('data', d => { buf += d; if (String(d).includes('CrewFit on')) res(buf); });
    srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${buf}`)));
    setTimeout(() => rej(new Error('server never started:\n' + buf)), 15000);
  });
}
const stop = () => new Promise(r => { if (!srv) return r(); srv.on('exit', r); srv.kill(); });
async function reboot() { await stop(); return boot(); }

async function reg(n) {
  const r = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username: n, pin: 'pass1234', displayName: n }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { id: r.user.id, token: r.token, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
const get = (who, p) => fetch(B + p, { headers: who.H }).then(r => r.json());
const post = (who, p, body) => fetch(B + p, { method: 'POST', headers: who.H, body: JSON.stringify(body || {}) }).then(r => r.json());
async function login(username, pin) {
  return fetch(B + '/api/login', { method: 'POST', headers: J, body: JSON.stringify({ username, pin }) }).then(r => r.json());
}

// Resets a user row to the OLD pre-migration shape: null out every new column and write the
// given legacy object straight into `data` -- the exact state a production row would be in if it
// had never gone through this migration at all. The server must be stopped first, same
// stop/patch/reboot shape the decision-#1/crew-row differential tests already use. `data` keeps
// its NOT NULL constraint (unlike crews) so legacyData must be a real object, never null itself.
async function resetUserToLegacyShape(userId, legacyData) {
  const pg = new PgConnection(parseConnString(testDb.url));
  await pg.query(`UPDATE users SET
    username = NULL, display_name = NULL, bio = NULL, avatar = NULL, default_gym = NULL,
    profile_visibility = NULL, units = NULL, created_at = NULL, created_at_estimated = NULL,
    pin_hash = NULL, pin_salt = NULL, deleted = NULL, deleted_at = NULL, tokens_valid_from = NULL,
    seen_rir_explainer = NULL, training_phase = NULL, notify_streak_reminders = NULL,
    notify_workout_reminders = NULL, last_streak_reminder_at = NULL, last_workout_reminder_at = NULL,
    data = $2::jsonb
    WHERE id = $1`, [userId, JSON.stringify(legacyData)]);
  pg.close();
}
async function rawQuery(sql, params) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query(sql, params);
  pg.close();
  return r.rows;
}
async function rawUserRow(id) {
  const rows = await rawQuery(
    `SELECT username, display_name, bio, avatar, default_gym, profile_visibility, units,
            created_at, created_at_estimated, pin_hash, pin_salt, deleted, deleted_at,
            tokens_valid_from, seen_rir_explainer, training_phase, notify_streak_reminders,
            notify_workout_reminders, last_streak_reminder_at, last_workout_reminder_at, data
     FROM users WHERE id = $1`, [id]);
  return rows[0];
}

await boot();
try {

console.log('setup: two real accounts, through the real API, so their pin_hash/pin_salt are genuine -- captured BEFORE resetting to the legacy shape so the reset can reuse them and login keeps working post-migration');
const alice = await reg('scalcolalice1'), bob = await reg('scalcolbob1');
const aliceRealCols = await rawUserRow(alice.id);
const bobRealCols = await rawUserRow(bob.id);
ok(!!aliceRealCols.pin_hash && !!aliceRealCols.pin_salt, 'alice already has real pin_hash/pin_salt columns from registration (brand-new accounts need no backfill)');

await stop();
const now = new Date().toISOString();
// alice: EVERY field set to a real, non-default value -- including explicit `false` booleans
// (notifyStreakReminders, deleted) and explicit `true` booleans (createdAtEstimated,
// seenRirExplainer) -- so this test can tell "explicitly false" apart from "never set" (null),
// not just "truthy vs falsy".
const legacyAlice = {
  id: alice.id, username: 'scalcolalice1', displayName: 'Legacy Alice', bio: 'Powerlifting since 2019',
  avatar: '/uploads/alice_avatar.jpg', defaultGym: "Gold's Gym Downtown", profileVisibility: 'public',
  units: 'kg', createdAt: now, createdAtEstimated: true,
  pinHash: aliceRealCols.pin_hash, pinSalt: aliceRealCols.pin_salt,
  deleted: false, deletedAt: null, tokensValidFrom: now,
  seenRirExplainer: true, trainingPhase: 'hypertrophy',
  notifyStreakReminders: false, notifyWorkoutReminders: true,
  lastStreakReminderAt: now, lastWorkoutReminderAt: now,
};
// bob: a realistic OLD account that never touched most settings -- only the fields every account
// has always had since registration (username, displayName, units, profileVisibility, createdAt,
// pinHash, pinSalt) are present; everything added later (bio, avatar, defaultGym, trainingPhase,
// both notify flags, both reminder timestamps, seenRirExplainer, createdAtEstimated, deleted,
// deletedAt, tokensValidFrom) is simply absent, exactly as a real pre-migration row would be.
const legacyBob = {
  id: bob.id, username: 'scalcolbob1', displayName: 'Legacy Bob', units: 'lb', profileVisibility: 'public',
  createdAt: now, pinHash: bobRealCols.pin_hash, pinSalt: bobRealCols.pin_salt,
};
await resetUserToLegacyShape(alice.id, legacyAlice);
await resetUserToLegacyShape(bob.id, legacyBob);
// carol: registered fresh AFTER the reset above so her row is created directly against Postgres
// with a malformed, empty legacy blob -- no id, no username, nothing -- simulating the worst-case
// "something hand-edited or corrupted this row" scenario, not reachable through the real API.
const carolPg = new PgConnection(parseConnString(testDb.url));
await carolPg.query("INSERT INTO users (id, username_lower, data) VALUES ('scalcolcarol1id', 'scalcolcarol1-placeholder', '{}'::jsonb)");
carolPg.close();

console.log('\nfirst boot after resetting: the migration backfills all three losslessly, including explicit false/true booleans, and does not crash on the empty-object row');
await boot();
{
  const a = await rawUserRow(alice.id);
  ok(a.username === 'scalcolalice1' && a.display_name === 'Legacy Alice' && a.bio === 'Powerlifting since 2019' &&
     a.avatar === '/uploads/alice_avatar.jpg' && a.default_gym === "Gold's Gym Downtown" && a.profile_visibility === 'public' &&
     a.units === 'kg' && a.created_at === now && a.pin_hash === aliceRealCols.pin_hash && a.pin_salt === aliceRealCols.pin_salt &&
     a.tokens_valid_from === now && a.training_phase === 'hypertrophy' && a.last_streak_reminder_at === now && a.last_workout_reminder_at === now,
     `alice's string/text columns backfilled intact, got ${JSON.stringify(a)}`);
  // The critical pgBool check: raw Postgres text for a boolean column is 't'/'f', literally --
  // not the JS true/false this test would get from a normal API response.
  ok(a.created_at_estimated === 't', `alice's createdAtEstimated=true backfilled as the raw text 't', got ${JSON.stringify(a.created_at_estimated)}`);
  ok(a.seen_rir_explainer === 't', `alice's seenRirExplainer=true backfilled as the raw text 't', got ${JSON.stringify(a.seen_rir_explainer)}`);
  ok(a.notify_workout_reminders === 't', `alice's notifyWorkoutReminders=true backfilled as the raw text 't', got ${JSON.stringify(a.notify_workout_reminders)}`);
  ok(a.deleted === 'f', `alice's deleted=false backfilled as the raw text 'f' (not null, not missing) -- she explicitly had deleted:false, got ${JSON.stringify(a.deleted)}`);
  ok(a.notify_streak_reminders === 'f', `alice's notifyStreakReminders=false backfilled as the raw text 'f', distinguishing "explicitly off" from "never set", got ${JSON.stringify(a.notify_streak_reminders)}`);
  ok(a.deleted_at === null, 'alice\'s deletedAt (explicitly null in her legacy blob) stayed null, not coerced to a string');

  const b = await rawUserRow(bob.id);
  ok(b.username === 'scalcolbob1' && b.display_name === 'Legacy Bob' && b.units === 'lb' && b.pin_hash === bobRealCols.pin_hash,
    `bob's present fields backfilled intact, got ${JSON.stringify(b)}`);
  ok(b.bio === null && b.avatar === null && b.default_gym === null && b.training_phase === null &&
     b.notify_streak_reminders === null && b.notify_workout_reminders === null && b.seen_rir_explainer === null &&
     b.created_at_estimated === null && b.deleted === null && b.deleted_at === null && b.tokens_valid_from === null &&
     b.last_streak_reminder_at === null && b.last_workout_reminder_at === null,
     `bob's never-set fields backfilled to real NULL, not a fabricated default, got ${JSON.stringify(b)}`);

  const c = await rawUserRow('scalcolcarol1id');
  ok(c.username === 'scalcolcarol1id', `carol's empty-object legacy blob falls back to her row id for the signal column (defense-in-depth, mirrors crews' "Crew" fallback for name), got ${JSON.stringify(c.username)}`);
  ok(c.display_name === null && c.pin_hash === null, 'and every other column is simply null for her, not a crash');

  const health = await get(alice, '/healthz');
  ok(health.ok === true, 'server is healthy after backfilling a real row, a sparse row, and an empty-object row in the same boot');
}

console.log('\napp-level proof the server reads these columns back as REAL booleans, not the raw "f"/"t" text: alice can still log in (deleted correctly read as false, not truthy "f"), and her self-view profile shows the exact explicit values she had, not flipped or defaulted ones');
{
  const loginAlice = await login('scalcolalice1', 'pass1234');
  ok(!!loginAlice.token, `alice logs in successfully after migration -- if pgBool() were missing, her deleted='f' column would read back as the TRUTHY string 'f' and the login route's own \`if (u.deleted)\` check would reject her, got ${JSON.stringify(loginAlice)}`);
  const aliceToken = { id: alice.id, token: loginAlice.token, H: { ...J, Authorization: 'Bearer ' + loginAlice.token } };
  const profile = await get(aliceToken, '/api/profile/me');
  ok(profile.seenRirExplainer === true, `alice's self-view shows seenRirExplainer true, got ${JSON.stringify(profile.seenRirExplainer)}`);
  ok(profile.notifyStreakReminders === false, `alice's self-view shows notifyStreakReminders FALSE -- if pgBool() were missing this would read back as true ('f' !== false is true for the raw string), got ${JSON.stringify(profile.notifyStreakReminders)}`);
  ok(profile.notifyWorkoutReminders === true, `alice's self-view shows notifyWorkoutReminders true, got ${JSON.stringify(profile.notifyWorkoutReminders)}`);
  ok(profile.trainingPhase === 'hypertrophy', `alice's self-view shows her saved training phase, got ${JSON.stringify(profile.trainingPhase)}`);
  ok(profile.bio === 'Powerlifting since 2019' && profile.avatar === '/uploads/alice_avatar.jpg', `alice's public-facing fields also survived, got bio=${JSON.stringify(profile.bio)} avatar=${JSON.stringify(profile.avatar)}`);

  const loginBob = await login('scalcolbob1', 'pass1234');
  ok(!!loginBob.token, 'bob (minimal legacy row) also logs in fine after migration');
}

console.log('\nsecond boot (nothing left to migrate): running it again is a true no-op, not a corruption');
await reboot();
{
  const a = await rawUserRow(alice.id);
  ok(a.deleted === 'f' && a.notify_streak_reminders === 'f' && a.bio === 'Powerlifting since 2019',
    `alice's columns are unchanged after a second boot, got ${JSON.stringify(a)}`);
  const health = await get(alice, '/healthz');
  ok(health.ok === true, 'server is healthy after a second boot with nothing left to backfill');
}

console.log('\na real post-migration profile edit lands on the real column, through the normal save() path, and does not get silently reverted by anything else in that boot');
{
  const loginAlice = await login('scalcolalice1', 'pass1234');
  const aliceToken = { id: alice.id, token: loginAlice.token, H: { ...J, Authorization: 'Bearer ' + loginAlice.token } };
  const edited = await post(aliceToken, '/api/me/bio', { bio: 'Now powerlifting AND running' });
  ok(edited.bio === 'Now powerlifting AND running', `the edit itself succeeds, got ${JSON.stringify(edited)}`);
  const row = await rawUserRow(alice.id);
  ok(row.bio === 'Now powerlifting AND running', `the edit landed on the real bio column, not the dead data blob, got ${JSON.stringify(row.bio)}`);

  await reboot();
  const profile = await get(aliceToken, '/api/profile/me');
  ok(profile.bio === 'Now powerlifting AND running', `the edit survives a restart too, got ${JSON.stringify(profile.bio)}`);
}

console.log('\na brand-new user created AFTER this migration shipped goes straight to the new columns, with its blob already excluding these fields from creation -- no backfill needed, ever');
{
  const dave = await reg('scalcoldave1');
  const row = await rawUserRow(dave.id);
  ok(row.username === 'scalcoldave1' && row.display_name === 'scalcoldave1' && row.units === 'lb' && row.profile_visibility === 'public' && !!row.pin_hash,
    `dave's real columns are populated immediately on registration, got ${JSON.stringify(row)}`);
  const blob = JSON.parse(row.data);
  ok(blob.username === undefined && blob.pinHash === undefined && blob.displayName === undefined,
    `dave's data blob already excludes the scalar fields from his very first save (registration marks new accounts migrated before the first save), got ${JSON.stringify(blob)}`);
}

console.log('\ncoexistence: bob (migrated on an earlier boot) is left untouched while nothing new needs backfilling');
{
  const pending = await rawQuery("SELECT id FROM users WHERE username IS NULL");
  ok(pending.length === 0, `no rows are left needing backfill after all of the above, got ${JSON.stringify(pending)}`);
  const b = await rawUserRow(bob.id);
  ok(b.username === 'scalcolbob1', 'bob is still exactly as he was, not re-touched');
}

} finally {
  await stop();
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
