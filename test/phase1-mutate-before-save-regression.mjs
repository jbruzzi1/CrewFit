// Oct 18 2026 (Phase 1 full-app hazard sweep -- mandatory rearchitecture safeguards process,
// step 3: ground-truth regression test). This is the follow-up to the sessions & logs slice
// (test/sessions-logs-mutate-before-save-regression.mjs): the same mutate-before-maybe-failing-
// save hazard (a route mutates shared in-memory state, then does further awaits -- including
// save(DB) itself -- that can throw, with nothing reverting the mutation on failure), surveyed
// and fixed across the REST of the app -- every DB.users route, session/crew/template creation,
// PUT /api/crews/:id, a brand-new withTemplateLock primitive applied to all 8 DB.templates
// routes, and the single biggest blast-radius fix in this engagement so far:
// anonymizeAndDeleteAccount (account deletion), which used to have NOTHING reverting it on a
// failed save at all.
//
// Same breakTable/fixTable technique as every other regression file in this suite (rig a REAL
// Postgres failure for the exact save() this app's own code depends on, not a mock). This file
// does not re-test every single one of the ~17 DB.users routes individually -- they all share one
// of a small number of patterns, and testing one representative of each pattern plus the two
// genuinely distinct multi-field/create-then-revert routes is enough to prove the pattern itself
// is correct everywhere it's applied:
//   - single scalar field CAS revert (display-name stands in for avatar/bio/default-gym/units/
//     rir-explainer-seen/training-phase/notify-prefs/notifications-seen/trend-picks/top-lift-picks)
//   - multi-field CAS revert with an await in the middle (password, which also bumps
//     tokensValidFrom -- same shape username's own password-confirm uses)
//   - array reassignment CAS revert (favorites/toggle)
//   - object reassignment CAS revert (seeds PUT, and logout's revokedJtis)
//   - create-then-revert for a brand-new entity (register, sessions, crews, templates all share
//     this exact shape -- register stands in for all four)
//
// What this file does NOT attempt: the background reminder timers' reorder (Task #11, streak-loss
// and workout-today pushes). Same documented reasoning as test/streak-reminders.mjs's own header
// comment -- there is deliberately no HTTP route that fires `usersAtRiskOfLosingStreak()`'s or
// `usersWithWorkoutToday()`'s real send pass on demand (a "send everyone their reminder now"
// endpoint would be a push-spam vector not worth building for a test's convenience), and waiting
// for the real UTC-hour window isn't practical here either. That fix is a plain, visually obvious
// reorder (persist first, notify only after save() succeeds -- see its own comment in server.js)
// verified by code review and the two independent review passes this safeguards process requires
// next, not by this file.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5950, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'phase1-mbs-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('phase1mbs');
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const put = (p, b, t) => fetch(B + p, { method: 'PUT', headers: t ? H(t) : J, body: JSON.stringify(b) });
const del = (p, t) => fetch(B + p, { method: 'DELETE', headers: t ? H(t) : J });
const get = (p, t) => fetch(B + p, { headers: t ? H(t) : J });
const j = r => r.json();
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const s = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    s.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res({ srv: s }); });
    s.stderr.on('data', d => process.stderr.write('[server] ' + d));
    s.on('exit', () => res({ srv: null }));
    setTimeout(() => res({ srv: s }), 8000);
  });
}

({ srv } = await boot(PORT, DIR, testDb.url));
ok(!!srv, 'server boots');

const raw = new PgConnection(parseConnString(testDb.url));
async function breakTable(name) { await raw.query(`ALTER TABLE ${name} RENAME TO ${name}_broken_for_test`); }
async function fixTable(name) { await raw.query(`ALTER TABLE ${name}_broken_for_test RENAME TO ${name}`); }
// Direct-Postgres read of a template's own stored jsonb, bypassing stripHidden (which strips
// hiddenBy from every API response, even to the owner) -- same technique account-settings.mjs's
// readCrew/readNotificationsFor use. The only ground truth for "did hiddenBy actually revert",
// since no route exposes it to anyone, owner included.
async function readTemplateHiddenBy(templateId) {
  const r = await raw.query('SELECT data FROM templates WHERE id = $1', [templateId]);
  if (!r.rows[0]) return null;
  return JSON.parse(r.rows[0].data).hiddenBy || [];
}

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const alice = await post('/api/register', { username: 'p1_alice', pin: 'pass1234', displayName: 'Alice' }).then(j);
const bob = await post('/api/register', { username: 'p1_bob', pin: 'pass1234', displayName: 'Bob' }).then(j);
// mutual follow -> connected (needed for template sharing below)
await post(`/api/follow/${bob.user.id}`, {}, alice.token);
await post(`/api/follow-requests/${alice.user.id}/accept`, {}, bob.token);
await post(`/api/follow/${alice.user.id}`, {}, bob.token);
await post(`/api/follow-requests/${bob.user.id}/accept`, {}, alice.token);

console.log('\nTask #7: DB.users mutate-before-save fixes');

console.log('\nPOST /api/me/display-name: single scalar field CAS revert');
{
  await breakTable('users');
  const r = await post('/api/me/display-name', { displayName: 'New Alice' }, alice.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('users');
  const prof = await get('/api/profile/me', alice.token).then(j);
  ok(prof.displayName === 'Alice', `displayName reverted, still the original, got ${prof.displayName}`);
  const rReal = await post('/api/me/display-name', { displayName: 'New Alice' }, alice.token);
  ok(rReal.status === 200, `with the table fixed, the SAME call now succeeds, got ${rReal.status}`);
  const profReal = await get('/api/profile/me', alice.token).then(j);
  ok(profReal.displayName === 'New Alice', 'and this time it really did change');
}

console.log('\nPOST /api/me/password: multi-field CAS revert with an await (hashPin) in the middle, including tokensValidFrom');
{
  await breakTable('users');
  const r = await post('/api/me/password', { currentPassword: 'pass1234', newPassword: 'newpass5678' }, alice.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('users');
  // the pre-change token must still work -- tokensValidFrom was reverted too, not left bumped
  const stillWorks = await get('/api/profile/me', alice.token);
  ok(stillWorks.status === 200, `the old token still works -- tokensValidFrom was reverted, not left bumped (got ${stillWorks.status})`);
  const oldPwLogin = await post('/api/login', { username: 'p1_alice', pin: 'pass1234' });
  ok(oldPwLogin.status === 200, 'the OLD password still logs in -- pinHash/pinSalt were reverted');
  const rReal = await post('/api/me/password', { currentPassword: 'pass1234', newPassword: 'newpass5678' }, alice.token).then(j);
  ok(!!rReal.ok, 'with the table fixed, the SAME password change now succeeds');
  const newPwLogin = await post('/api/login', { username: 'p1_alice', pin: 'newpass5678' });
  ok(newPwLogin.status === 200, 'and now the NEW password really does log in');
  // the password change bumped tokensValidFrom (account-wide), so THIS device's own pre-change
  // token is dead too -- the route hands back a fresh one specifically so this doesn't surprise-
  // logout the device that made the change (see the route's own comment). Pick it up for the
  // rest of this file's alice-token calls below.
  alice.token = rReal.token;
}

console.log('\nPOST /api/favorites/toggle: array REASSIGNMENT CAS revert (push/filter, not in-place)');
{
  const before = await get('/api/favorites', alice.token).then(j);
  ok(!before.exercises.includes('Barbell Bench Press'), 'sanity: not already favorited');
  await breakTable('users');
  const r = await post('/api/favorites/toggle', { name: 'Barbell Bench Press' }, alice.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('users');
  const afterFail = await get('/api/favorites', alice.token).then(j);
  ok(!afterFail.exercises.includes('Barbell Bench Press'), 'the "failed" favorite never shows up');
  const rReal = await post('/api/favorites/toggle', { name: 'Barbell Bench Press' }, alice.token).then(j);
  ok(rReal.favorited === true, 'with the table fixed, the SAME toggle now succeeds');
  const afterReal = await get('/api/favorites', alice.token).then(j);
  ok(afterReal.exercises.includes('Barbell Bench Press'), 'and it really is favorited this time');
}

console.log('\nPUT /api/me/seeds: object REASSIGNMENT CAS revert (keyed map, not an in-place key set/delete)');
{
  await breakTable('users');
  const r = await put('/api/me/seeds', { exercise: 'Barbell Back Squat', weight: 185, reps: 5 }, alice.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('users');
  const afterFail = await get('/api/me/seeds', alice.token).then(j);
  ok(!afterFail.seeds || !afterFail.seeds['Barbell Back Squat'], 'the "failed" seed never shows up');
  const rReal = await put('/api/me/seeds', { exercise: 'Barbell Back Squat', weight: 185, reps: 5 }, alice.token);
  ok(rReal.status === 200, `with the table fixed, the SAME seed now saves, got ${rReal.status}`);
  const afterReal = await get('/api/me/seeds', alice.token).then(j);
  ok(!!afterReal.seeds['Barbell Back Squat'], 'and it really is saved this time');
}

console.log('\nPOST /api/logout: revokedJtis object REASSIGNMENT CAS revert');
{
  const dev2 = await post('/api/login', { username: 'p1_alice', pin: 'newpass5678' }).then(j);
  await breakTable('users');
  const r = await post('/api/logout', {}, dev2.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('users');
  const stillWorks = await get('/api/profile/me', dev2.token);
  ok(stillWorks.status === 200, 'the "logged out" token still works -- the revoke never actually persisted');
  const rReal = await post('/api/logout', {}, dev2.token);
  ok(rReal.status === 200, `with the table fixed, the SAME logout now succeeds, got ${rReal.status}`);
  const nowDead = await get('/api/profile/me', dev2.token);
  ok(nowDead.status === 401, 'and the token really is revoked this time');
}

console.log('\nPOST /api/register: create-then-revert for a brand-new entity (stands in for the same shape on sessions/crews/templates below)');
{
  await breakTable('users');
  const r = await post('/api/register', { username: 'p1_ghost', pin: 'pass1234', displayName: 'Ghost' });
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('users');
  const checkTaken = await post('/api/register', { username: 'p1_ghost', pin: 'pass1234', displayName: 'Ghost' }).then(j);
  ok(!!checkTaken.token, 'the SAME username is available again -- the phantom row never stuck around after the failed save');
}

console.log('\nTask #8: entity-creation hazards');

console.log('\nPOST /api/sessions: a failed save deletes the phantom row outright, not left dangling in memory');
{
  await breakTable('sessions');
  const r = await post('/api/sessions', { name: 'Ghost Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private' }, alice.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('sessions');
  const health = await get('/healthz');
  ok(health.status === 200, 'server still up after the rigged create failure');
  const rReal = await post('/api/sessions', { name: 'Real Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private' }, alice.token).then(j);
  ok(!!rReal.id, 'with the table fixed, a real session creates fine right after');
}

console.log('\nPOST /api/crews: a failed save deletes the phantom row outright, not left dangling in memory');
{
  await breakTable('crews');
  const r = await post('/api/crews', { name: 'Ghost Crew' }, alice.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('crews');
  const mine = await get('/api/crews', alice.token);
  ok(mine.status === 200, 'server still up after the rigged create failure');
  const rReal = await post('/api/crews', { name: 'Real Crew' }, alice.token).then(j);
  ok(!!rReal.id, 'with the table fixed, a real crew creates fine right after');
}

console.log('\nTask #9: PUT /api/crews/:id reverts both name and memberIds together on a failed save');
{
  const crew = await post('/api/crews', { name: 'Leg Day Crew', memberIds: [bob.user.id] }, alice.token).then(j);
  await breakTable('crews');
  const r = await put(`/api/crews/${crew.id}`, { name: 'Renamed Crew', memberIds: [] }, alice.token);
  ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
  await fixTable('crews');
  const afterFail = await get(`/api/crews/${crew.id}`, alice.token).then(j);
  ok(afterFail.name === 'Leg Day Crew', `name reverted, got ${afterFail.name}`);
  ok(afterFail.members.some(m => m.id === bob.user.id), 'bob is still a member -- memberIds reverted too');
  const rReal = await put(`/api/crews/${crew.id}`, { name: 'Renamed Crew', memberIds: [] }, alice.token);
  ok(rReal.status === 200, `with the table fixed, the SAME edit now succeeds, got ${rReal.status}`);
  const afterReal = await get(`/api/crews/${crew.id}`, alice.token).then(j);
  ok(afterReal.name === 'Renamed Crew' && !afterReal.members.some(m => m.id === bob.user.id), 'and this time both the rename and the membership change really took');
}

console.log('\nTask #10: withTemplateLock + revert across all 8 DB.templates routes (brand-new lock, zero protection before this sweep)');
{
  const tpl = await post('/api/templates', { name: 'Push Routine', exercises: [{ name: 'Bench Press' }] }, alice.token).then(j);

  console.log('  create: a failed save deletes the phantom row outright');
  {
    await breakTable('templates');
    const r = await post('/api/templates', { name: 'Ghost Routine', exercises: [{ name: 'Squat' }] }, alice.token);
    ok(r.status === 500, `returns a real error, got ${r.status}`);
    await fixTable('templates');
    const mine = await get('/api/templates', alice.token).then(j);
    ok(!mine.mine.some(t => t.name === 'Ghost Routine'), 'the phantom routine never shows up');
  }

  console.log('  edit: reverts both name and exercises together, and rejects invalid exercises BEFORE touching either field');
  {
    const before = await get('/api/templates', alice.token).then(j);
    const beforeTpl = before.mine.find(t => t.id === tpl.id);
    const rInvalid = await put(`/api/templates/${tpl.id}`, { name: 'Should Not Stick', exercises: [null] }, alice.token);
    ok(rInvalid.status === 400, `an invalid exercises array is refused before any mutation, got ${rInvalid.status}`);
    const afterInvalid = await get('/api/templates', alice.token).then(j);
    ok(afterInvalid.mine.find(t => t.id === tpl.id).name === beforeTpl.name, 'and the name genuinely never changed -- validated before either field was touched');

    await breakTable('templates');
    const r = await put(`/api/templates/${tpl.id}`, { name: 'Pull Routine', exercises: [{ name: 'Deadlift' }] }, alice.token);
    ok(r.status === 500, `returns a real error while the table is broken, got ${r.status}`);
    await fixTable('templates');
    const afterFail = await get('/api/templates', alice.token).then(j).then(x => x.mine.find(t => t.id === tpl.id));
    ok(afterFail.name === 'Push Routine', `name reverted, got ${afterFail.name}`);
    ok(afterFail.exercises[0].name === 'Bench Press', `exercises reverted too, got ${afterFail.exercises[0].name}`);

    const rReal = await put(`/api/templates/${tpl.id}`, { name: 'Pull Routine', exercises: [{ name: 'Deadlift' }] }, alice.token);
    ok(rReal.status === 200, `with the table fixed, the SAME edit now succeeds, got ${rReal.status}`);
  }

  console.log('  hide/unhide: reverts the hiddenBy entry on a failed save (checked via a direct Postgres read -- no route exposes hiddenBy to anyone, owner included, so a weaker idempotent-retry check can\'t actually distinguish a real revert from a no-op)');
  {
    const before = await readTemplateHiddenBy(tpl.id);
    ok(Array.isArray(before) && !before.includes(bob.user.id), `sanity: bob isn't in hiddenBy yet, got ${JSON.stringify(before)}`);

    await breakTable('templates');
    const r = await post(`/api/templates/${tpl.id}/hide`, {}, bob.token);
    ok(r.status === 500, `hide returns a real error, got ${r.status}`);
    await fixTable('templates');
    const afterFail = await readTemplateHiddenBy(tpl.id);
    ok(!afterFail.includes(bob.user.id), `the "failed" hide never actually landed in storage, got ${JSON.stringify(afterFail)}`);

    const rHide = await post(`/api/templates/${tpl.id}/hide`, {}, bob.token);
    ok(rHide.status === 200, 'the SAME hide now succeeds with the table fixed');
    const afterReal = await readTemplateHiddenBy(tpl.id);
    ok(afterReal.includes(bob.user.id), `and bob really is in hiddenBy this time, got ${JSON.stringify(afterReal)}`);

    await breakTable('templates');
    const rUn = await post(`/api/templates/${tpl.id}/unhide`, {}, bob.token);
    ok(rUn.status === 500, `unhide returns a real error, got ${rUn.status}`);
    await fixTable('templates');
    const afterUnhideFail = await readTemplateHiddenBy(tpl.id);
    ok(afterUnhideFail.includes(bob.user.id), `the "failed" unhide never actually removed bob from storage, got ${JSON.stringify(afterUnhideFail)}`);

    const rUnReal = await post(`/api/templates/${tpl.id}/unhide`, {}, bob.token);
    ok(rUnReal.status === 200, 'and the SAME unhide now succeeds with the table fixed');
    const afterUnhideReal = await readTemplateHiddenBy(tpl.id);
    ok(!afterUnhideReal.includes(bob.user.id), `and bob really is removed from storage this time, got ${JSON.stringify(afterUnhideReal)}`);
  }

  console.log('  share/accept-share/decline-share: revert the sharedTo/sharedAt entry, and accept-share also reverts the newly-created copy');
  {
    await breakTable('templates');
    const rShare = await post(`/api/templates/${tpl.id}/share`, { usernames: ['p1_bob'] }, alice.token);
    ok(rShare.status === 500, `share returns a real error, got ${rShare.status}`);
    await fixTable('templates');
    const bobShared1 = await get('/api/templates', bob.token).then(j);
    ok(!bobShared1.shared.some(t => t.id === tpl.id), 'the "failed" share never shows up in bob\'s pending list');

    const rShareReal = await post(`/api/templates/${tpl.id}/share`, { usernames: ['p1_bob'] }, alice.token);
    ok(rShareReal.status === 200, 'with the table fixed, the SAME share now succeeds');
    const bobShared2 = await get('/api/templates', bob.token).then(j);
    ok(bobShared2.shared.some(t => t.id === tpl.id), 'and now it really is pending for bob');

    await breakTable('templates');
    const rAccept = await post(`/api/templates/${tpl.id}/accept-share`, {}, bob.token);
    ok(rAccept.status === 500, `accept-share returns a real error, got ${rAccept.status}`);
    await fixTable('templates');
    const bobMineAfterFail = await get('/api/templates', bob.token).then(j);
    ok(!bobMineAfterFail.mine.some(t => t.name === 'Pull Routine'), 'the phantom accepted COPY never shows up in bob\'s own routines');
    const bobSharedAfterFail = await get('/api/templates', bob.token).then(j);
    ok(bobSharedAfterFail.shared.some(t => t.id === tpl.id), 'and bob is still pending too -- the sharedTo removal was reverted along with the copy');

    const rAcceptReal = await post(`/api/templates/${tpl.id}/accept-share`, {}, bob.token).then(j);
    ok(!!rAcceptReal.id, 'with the table fixed, the SAME accept now succeeds and returns a real copy id');
    const bobMineReal = await get('/api/templates', bob.token).then(j);
    ok(bobMineReal.mine.some(t => t.id === rAcceptReal.id), 'and bob really does own the copy this time');

    // decline-share, on a second share
    await post(`/api/templates/${tpl.id}/share`, { usernames: ['p1_bob'] }, alice.token);
    await breakTable('templates');
    const rDecline = await post(`/api/templates/${tpl.id}/decline-share`, {}, bob.token);
    ok(rDecline.status === 500, `decline-share returns a real error, got ${rDecline.status}`);
    await fixTable('templates');
    const stillPending = await get('/api/templates', bob.token).then(j);
    ok(stillPending.shared.some(t => t.id === tpl.id), 'the "failed" decline never actually removed bob from the pending list');
    const rDeclineReal = await post(`/api/templates/${tpl.id}/decline-share`, {}, bob.token);
    ok(rDeclineReal.status === 200, 'with the table fixed, the SAME decline now succeeds');
    const goneNow = await get('/api/templates', bob.token).then(j);
    ok(!goneNow.shared.some(t => t.id === tpl.id), 'and bob really is off the pending list this time');
  }

  console.log('  accept-share: two genuinely concurrent accept calls from the same recipient create only ONE copy, not two (independent-review finding -- the "still pending" check used to run before the lock, so a double-tap could pass it twice)');
  {
    // bob already owns one real accepted copy of this same template from the share/accept-share
    // test just above -- count copies BEFORE this block runs and assert the increase, rather than
    // asserting an absolute total, so this doesn't depend on nothing else having ever accepted a
    // copy of this template before.
    const currentTplNameBefore = (await get('/api/templates', alice.token).then(j)).mine.find(t => t.id === tpl.id).name;
    const copiesBefore = (await get('/api/templates', bob.token).then(j)).mine.filter(t => t.name === currentTplNameBefore).length;
    await post(`/api/templates/${tpl.id}/share`, { usernames: ['p1_bob'] }, alice.token);
    const [r1, r2] = await Promise.all([
      post(`/api/templates/${tpl.id}/accept-share`, {}, bob.token),
      post(`/api/templates/${tpl.id}/accept-share`, {}, bob.token),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // Confirmed by direct repro with debug timestamps (not assumed): for two requests that arrive
    // with an empty withTemplateLock queue, Node drains the lock's synchronous critical section --
    // including the sharedTo mutation, which happens BEFORE this route's own `await save(DB)` --
    // as a microtask before the event loop ever invokes the second request's handler. So the
    // *loser* here is always caught by the OUTER pre-lock "still shared with you" guard (403), not
    // the inner re-check this fix added (409) -- that inner check is still correct, real
    // defense-in-depth for a non-empty queue (e.g. a third overlapping call, or two calls that
    // arrive far enough apart that one is already mid-save when the other's outer check runs), it
    // just structurally can't be the one that fires for this exact two-at-once race. Either status
    // proves the real thing this test cares about: no duplicate copy got created.
    ok(statuses[0] === 200 && (statuses[1] === 409 || statuses[1] === 403), `exactly one call wins (200) and the other is refused as already-decided (409 or 403), got ${JSON.stringify(statuses)}`);
    const bobMine = await get('/api/templates', bob.token).then(j);
    // NOT tpl.name -- that's a stale local snapshot from this template's creation, taken before
    // the earlier Task #10 "edit" subsection above renamed this SAME template server-side to
    // "Pull Routine". Re-read the template's own CURRENT name instead of trusting the stale local
    // variable, so this assertion checks the real thing (how many NEW copies this block created)
    // rather than accidentally comparing against a name that no longer exists.
    const currentTplName = (await get('/api/templates', alice.token).then(j)).mine.find(t => t.id === tpl.id).name;
    const copiesAfter = bobMine.mine.filter(t => t.name === currentTplName).length;
    ok(copiesAfter === copiesBefore + 1, `bob ends up owning exactly ONE new copy of the routine from this block, not two, got ${copiesAfter - copiesBefore}`);
  }

  console.log('  delete: a failed save puts the SAME template back under its own id');
  {
    const tpl2 = await post('/api/templates', { name: 'Core Routine', exercises: [{ name: 'Plank' }] }, alice.token).then(j);
    await breakTable('templates');
    const r = await del(`/api/templates/${tpl2.id}`, alice.token);
    ok(r.status === 500, `delete returns a real error, got ${r.status}`);
    await fixTable('templates');
    const stillThere = await get('/api/templates', alice.token).then(j);
    ok(stillThere.mine.some(t => t.id === tpl2.id), 'the routine is still there -- the delete was reverted');
    const rReal = await del(`/api/templates/${tpl2.id}`, alice.token);
    ok(rReal.status === 200, 'with the table fixed, the SAME delete now succeeds');
    const goneReal = await get('/api/templates', alice.token).then(j);
    ok(!goneReal.mine.some(t => t.id === tpl2.id), 'and it really is gone this time');
  }
}

console.log('\nTask #12 (independent-review finding): pgDeletePushSub is genuinely best-effort inside anonymizeAndDeleteAccount now -- a broken push_subs table does not abort the whole delete-account call, and the real anonymization still goes through');
{
  const pushVictim = await post('/api/register', { username: 'p1_pushvictim', pin: 'pass1234', displayName: 'PushVictim' }).then(j);
  await breakTable('push_subs');
  const r = await post('/api/me/delete-account', { password: 'pass1234' }, pushVictim.token);
  await fixTable('push_subs');
  ok(r.status === 200, `delete-account still succeeds even though push_subs itself is broken, got ${r.status}`);
  const nowDead = await get('/api/profile/me', pushVictim.token);
  ok(nowDead.status === 401, 'and the account really is anonymized/signed-out, not left half-done because of the unrelated push_subs failure');
}

console.log('\nTask #12: anonymizeAndDeleteAccount -- the biggest blast radius in this sweep. A single rigged failure during the follow-severance + template + crew + anonymization phase reverts EVERY batch together: another user\'s follow/block arrays, a shared template\'s sharedTo, an owned template\'s hard delete, an owned crew\'s ownerId, a solo crew\'s hard delete, the target\'s own fields, AND the avatar file is not unlinked until save() actually succeeds.');
{
  const owner = await post('/api/register', { username: 'p1_owner', pin: 'pass1234', displayName: 'Owner' }).then(j);
  const friend = await post('/api/register', { username: 'p1_friend', pin: 'pass1234', displayName: 'Friend' }).then(j);
  await post(`/api/follow/${friend.user.id}`, {}, owner.token);
  await post(`/api/follow-requests/${owner.user.id}/accept`, {}, friend.token);
  await post(`/api/follow/${owner.user.id}`, {}, friend.token);
  await post(`/api/follow-requests/${friend.user.id}/accept`, {}, owner.token);

  const avatarUp = await post('/api/me/avatar', { data: 'data:image/png;base64,' + TINY_PNG, type: 'image/png' }, owner.token).then(j);
  const avatarPath = join(DIR, 'uploads', avatarUp.avatar.replace('/uploads/', ''));
  ok(existsSync(avatarPath), 'sanity: the owner\'s real avatar file exists on disk');

  const sharedTpl = await post('/api/templates', { name: 'Owner Shared Routine', exercises: [{ name: 'Row' }] }, owner.token).then(j);
  await post(`/api/templates/${sharedTpl.id}/share`, { usernames: ['p1_friend'] }, owner.token);
  const soloOwnedTpl = await post('/api/templates', { name: 'Owner Only Routine', exercises: [{ name: 'Curl' }] }, owner.token).then(j);

  const sharedCrew = await post('/api/crews', { name: 'Owner Crew', memberIds: [friend.user.id] }, owner.token).then(j);
  const soloCrew = await post('/api/crews', { name: 'Solo Crew' }, owner.token).then(j);

  await breakTable('crews');   // same single transaction as users/sessions/templates/prs -- breaking any one fails the whole save
  const rDel = await post('/api/me/delete-account', { password: 'pass1234' }, owner.token);
  ok(rDel.status === 500, `delete-account returns a real error while the table is broken, got ${rDel.status}`);
  await fixTable('crews');

  const health = await get('/healthz');
  ok(health.status === 200, 'server still up after the rigged delete-account failure');

  const stillLoggedIn = await get('/api/profile/me', owner.token);
  ok(stillLoggedIn.status === 200, 'the owner\'s own token still works -- tokensValidFrom was reverted, not left bumped');
  const stillLoggedInBody = await stillLoggedIn.json();
  ok(stillLoggedInBody.displayName === 'Owner' && stillLoggedInBody.username === 'p1_owner',
    `the owner's own username/displayName were reverted, not left anonymized, got ${JSON.stringify({ u: stillLoggedInBody.username, d: stillLoggedInBody.displayName })}`);

  const friendsFollowing = await get(`/api/profile/${friend.user.id}/following`, friend.token).then(j);
  ok(friendsFollowing.some(x => x.id === owner.user.id), 'the friend still follows the owner -- the cross-user follow severance was reverted');

  const friendShared = await get('/api/templates', friend.token).then(j);
  ok(friendShared.shared.some(t => t.id === sharedTpl.id), 'the friend is still pending on the shared routine -- sharedTo was reverted');

  const ownerMine = await get('/api/templates', owner.token).then(j);
  ok(ownerMine.mine.some(t => t.id === soloOwnedTpl.id), 'the owner-only routine still exists -- its hard delete was reverted');

  const sharedCrewAfter = await get(`/api/crews/${sharedCrew.id}`, owner.token).then(j);
  ok(sharedCrewAfter.ownerId === owner.user.id, `the shared crew's ownerId was reverted, still the real owner, got ${sharedCrewAfter.ownerId}`);

  const soloCrewAfter = await get(`/api/crews/${soloCrew.id}`, owner.token);
  ok(soloCrewAfter.status === 200, 'the solo crew still exists -- its hard delete was reverted');

  ok(existsSync(avatarPath), 'the avatar file was NOT unlinked -- the unlink only runs after save() actually succeeds');

  // Now let it actually succeed, and prove every one of those same things really did happen for real.
  const rDelReal = await post('/api/me/delete-account', { password: 'pass1234' }, owner.token);
  ok(rDelReal.status === 200, `with the table fixed, the SAME delete-account now succeeds, got ${rDelReal.status}`);

  const nowDead = await get('/api/profile/me', owner.token);
  ok(nowDead.status === 401, 'the owner\'s token is dead now -- tokensValidFrom really was bumped this time');

  const friendsFollowingReal = await get(`/api/profile/${friend.user.id}/following`, friend.token).then(j);
  ok(!friendsFollowingReal.some(x => x.id === owner.user.id), 'the friend no longer follows the (now deleted) owner');

  const friendSharedReal = await get('/api/templates', friend.token).then(j);
  ok(!friendSharedReal.shared.some(t => t.id === sharedTpl.id), 'the friend is no longer pending on the shared routine');

  ok(!existsSync(avatarPath), 'and the avatar file really is unlinked from disk this time');

  const sharedCrewReal = await get(`/api/crews/${sharedCrew.id}`, friend.token).then(j);
  ok(sharedCrewReal.ownerId === null, 'the shared crew is genuinely ownerless now');
}

console.log('\na completely different, healthy user\'s own save right after a poisoned one still succeeds -- every rigged failure above was scoped to its own window, not a global jam');
{
  const r = await post('/api/register', { username: 'p1_fresh', pin: 'pass1234', displayName: 'Fresh' });
  ok(r.status === 200, `a brand-new, unrelated registration succeeds cleanly right after everything above, got ${r.status}`);
}

raw.close();
if (srv) srv.kill();
await testDb.drop();
rmSync(DIR, { recursive: true, force: true });

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
