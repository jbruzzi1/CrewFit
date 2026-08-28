// Jeff's report, Aug 19: workouts he was invited into (not ones he created) had no way to log &
// finish, edit, or delete — all three are creator-only, by design, always have been. But there was
// also no way to make one go away at all: not editable, not deletable, not finishable, so an
// invite the creator never finishes "ultimately... theyre their forever" on his Home screen. The
// server has supported taking yourself out of a shared workout since v-something (POST
// /api/sessions/:id/leave, used until now only as a fallback inside the CREATOR's own delete flow)
// — this just gives a non-creator participant a button that reaches it. This runs the REAL
// server AND the REAL public/app.js (via node:vm, fetch pointed at the live test server) so the
// button, the click, and the actual data change are all exercised for real, not mocked.
//
// Ported to the Postgres-backed test harness (Aug 2026 data-layer migration) — the original
// version predates that migration and read data.json directly off disk for its assertions; those
// reads now go through readDb() (a direct Postgres SELECT) instead. Nothing about the v187
// assertions themselves changed.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('leave');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
// Direct-Postgres equivalent of the old `JSON.parse(readFileSync(join(DIR, 'data.json'), 'utf8'))`
// — returns the same `{ sessions: { id: data } }` shape every assertion below already expects.
async function readDb(url) {
  const pg = new PgConnection(parseConnString(url));
  const r = await pg.query('SELECT id, data FROM sessions');
  pg.close();
  const sessions = {};
  for (const row of r.rows) sessions[row.id] = JSON.parse(row.data);
  return { sessions };
}

const DIR = mkdtempSync(join(tmpdir(), 'leave-'));
const PORT = 4991, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

const creator = await reg('leave_creator', 'pass1234', 'Creator');
const participant = await reg('leave_partner', 'pass1234', 'Partner');

const session = await post('/api/sessions', {
  name: 'Back Day', scheduledAt: new Date().toISOString(), location: 'Golds Gym', lengthMin: 60,
  exercises: [{ name: 'Pull-Up' }, { name: 'Bent-Over Row' }],
  inviteUsernames: [], visibility: 'private',
}, creator.token);
// invite by username requires them to already be friends in this app's model — go through the
// actual friend-request flow rather than poking the DB directly, so this proves the real path.
await post('/api/friends/request', { username: 'leave_partner' }, creator.token);
await post('/api/friends/accept', { from: creator.user.id }, participant.token);
// now invite them into the session by username
const withInvite = await fetch(B + '/api/sessions/' + session.id, {
  method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + creator.token },
  body: JSON.stringify({ inviteUsernames: ['leave_partner'] }),
}).then(r => r.json());
ok(Array.isArray(withInvite.invited) && withInvite.invited.includes(participant.user.id), 'the partner is invited into the session');
await post('/api/sessions/' + session.id + '/accept', {}, participant.token);

// ---- render the REAL client against the REAL running server ----
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sink = { html: '' };
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
    : k === 'innerHTML' ? sink.html
    : k === 'innerText' || k === 'value' || k === 'textContent' ? ''
    : k === 'children' || k === 'childNodes' ? [] : el(),
  set: (t, k, v) => { if (k === 'innerHTML') sink.html += String(v); return true; },
  apply: () => el(), has: () => true,
});
// querySelector deliberately returns null (not the el() proxy): openSession() reads
// `.dataset.tab` off the active nav button to know where "← Back" should return to, and the
// generic proxy has no sane string to give back for that — it would try to stringify a Proxy and
// throw. Returning null makes it fall through to the "home" default, which is what a first paint
// with no nav button marked active would do anyway.
const doc = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
function makeCtx() {
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => fetch(B + url, opts),
    location: { href: '/', pathname: '/', search: '', hash: '' }, history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
    setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  return ctx;
}

console.log('\nv187: the creator gets their OWN Log & Finish too, on top of Edit/Delete');
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('openSession', ctx)(session.id);
  ok(sink.html.includes('Log & Finish'), 'creator sees "Log & Finish"');
  ok(sink.html.includes('Delete session'), 'creator sees "Delete session"');
  ok(!sink.html.includes('Leave workout'), 'creator does NOT see "Leave workout" (Edit/Delete cover that role for them)');
}

console.log('\nv187: an invited participant gets their OWN Log & Finish AND their OWN Leave — Jeff, Aug 19');
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(participant.token)}; ME = ${JSON.stringify(participant.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('openSession', ctx)(session.id);
  ok(sink.html.includes('Leave workout'), 'the participant sees a "Leave workout" button');
  ok(sink.html.includes('Log & Finish'), 'AND their own "Log & Finish" — not creator-only anymore');
  ok(!sink.html.includes('Delete session'), 'and NOT "Delete session" (still creator-only)');
  ok(!sink.html.includes('>Edit<'), 'and NOT the plan "Edit" button (still creator-only)');

  console.log('\nJeff, Aug 20: tapping Leave before finishing now ASKS first — it does not silently assume Keep');
  sink.html = '';
  await vm.runInContext('leaveWorkout', ctx)(session.id, false);
  ok(sink.html.includes('Save today\'s sets') && sink.html.includes('Discard today\'s sets'),
     'the sheet offers both a Save and a Discard option');
  const dbBeforeChoice = await readDb(testDb.url);
  ok(dbBeforeChoice.sessions[session.id].participants.includes(participant.user.id),
     'and nothing has happened yet — just opening the sheet does not remove them');

  console.log('\nchoosing "Save today\'s sets" credits whatever they had (here: nothing), same as the old unconditional behavior');
  sink.html = '';
  await vm.runInContext('leaveWorkoutConfirmed', ctx)(session.id, true);
  const db = await readDb(testDb.url);
  const s = db.sessions[session.id];
  ok(!s.participants.includes(participant.user.id), 'the partner is no longer a participant on disk');
  ok(s.participants.includes(creator.user.id), 'the creator is untouched');
  ok(!(s.logs && s.logs[participant.user.id]), 'the partner\'s own logs (none, in this case) are gone with them');
  ok((s.history || []).some(h => h.userId === participant.user.id),
     'Jeff, Aug 19: "the leave button... simply just logs the current sets you have" — Keep credits them, exactly like Log & Finish would have');

  const list = await fetch(B + '/api/sessions', { headers: { Authorization: 'Bearer ' + participant.token } }).then(r => r.json());
  ok(!list.some(x => x.id === session.id && (x.participants || []).includes(participant.user.id)),
     'and it drops out of their own "Your Sessions" — it does not sit there forever anymore');
}

console.log('\nJeff, Aug 20: "what if I just want to leave a workout and not keep those sets? Maybe off day..." — Leave without saving should leave NO credit at all');
{
  const offDay = await post('/api/sessions', {
    name: 'Shoulder Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Overhead Press' }],
    inviteUsernames: [], visibility: 'private',
  }, creator.token);
  await fetch(B + '/api/sessions/' + offDay.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + creator.token },
    body: JSON.stringify({ inviteUsernames: ['leave_partner'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + offDay.id + '/accept', {}, participant.token);
  const exId = offDay.exercises[0].id;
  // a couple sets logged, but NOT finished — exactly the "off day, want out entirely" case
  await post('/api/sessions/' + offDay.id + '/log', { exerciseId: exId, weight: 95, reps: 8 }, participant.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(participant.token)}; ME = ${JSON.stringify(participant.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('leaveWorkout', ctx)(offDay.id, false);
  ok(sink.html.includes('Discard today\'s sets'), 'the discard option is offered here too');

  sink.html = '';
  await vm.runInContext('leaveWorkoutConfirmed', ctx)(offDay.id, false);
  const db = await readDb(testDb.url);
  const s = db.sessions[offDay.id];
  ok(!s.participants.includes(participant.user.id), 'the partner is removed as a participant');
  ok(!(s.logs && s.logs[participant.user.id]), 'their logged sets are gone');
  ok(!(s.history || []).some(h => h.userId === participant.user.id),
     'and — the actual point of this feature — NO history row was added; the off day does not count');
}

console.log('\nv187: finishing is PER PERSON — one participant\'s Log & Finish never touches anyone else\'s');
{
  const finished = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private',
  }, creator.token);
  await fetch(B + '/api/sessions/' + finished.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + creator.token },
    body: JSON.stringify({ inviteUsernames: ['leave_partner'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + finished.id + '/accept', {}, participant.token);
  const exId = finished.exercises[0].id;
  await post('/api/sessions/' + finished.id + '/log', { exerciseId: exId, weight: 135, reps: 5 }, participant.token);
  // the PARTICIPANT finishes, not the creator — this used to be impossible (creator-only /lock)
  const locked = await post('/api/sessions/' + finished.id + '/lock', {}, participant.token);
  const db1 = await readDb(testDb.url);
  ok((db1.sessions[finished.id].history || []).some(h => h.userId === participant.user.id),
     'the participant finished the workout on their own — no creator action required');
  ok(!(db1.sessions[finished.id].history || []).some(h => h.userId === creator.user.id),
     "and the creator was NOT credited — one person's finish is not everyone's finish");

  const creatorCtx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, creatorCtx);
  sink.html = '';
  await vm.runInContext('openSession', creatorCtx)(finished.id);
  ok(sink.html.includes('Log & Finish'), "the creator still sees their OWN Log & Finish — the partner finishing did not close it out for them");

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(participant.token)}; ME = ${JSON.stringify(participant.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('openSession', ctx)(finished.id);
  ok(!sink.html.includes('Log & Finish'), 'the participant, having already finished, no longer sees their own Log & Finish');
  ok(sink.html.includes('Leave workout'), 'but Leave is still offered — it no longer takes credit back, so there is nothing to protect it from');

  console.log('\nleaving AFTER finishing does not touch the credit already earned');
  sink.html = '';
  await vm.runInContext('leaveWorkout', ctx)(finished.id, true);
  const db2 = await readDb(testDb.url);
  const hist = (db2.sessions[finished.id].history || []).filter(h => h.userId === participant.user.id);
  ok(hist.length === 1, `their history credit is still intact, and was not duplicated (${hist.length} row(s))`);
  ok(!db2.sessions[finished.id].participants.includes(participant.user.id), 'and they are still removed as a participant');

  console.log('\na departed participant\'s credit blocks delete just like a CURRENT participant\'s would');
  // the partner above already left `finished` and still holds a history row there — this is
  // exactly the shape a plain "who has logged" check misses, since their s.logs entry is gone.
  const deleteAttempt = await fetch(B + '/api/sessions/' + finished.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + creator.token } });
  const deleteBody = await deleteAttempt.json();
  ok(deleteAttempt.status === 409, `deleting it is refused — a departed partner's credit is still tied to it (got ${deleteAttempt.status})`);
  ok(deleteBody.canLeave === true, 'and the fallback offers Leave, same as for a still-present participant');
  const dbUntouched = await readDb(testDb.url);
  ok(!!dbUntouched.sessions[finished.id], 'the session was NOT deleted');
  ok((dbUntouched.sessions[finished.id].history || []).some(h => h.userId === participant.user.id),
     "and the departed partner's history row survived the attempt");

  console.log('\nthe sole remaining (creator) participant can still Leave rather than being stuck');
  // Nobody CURRENT has logged in `finished` (only the departed partner, via history) — the old
  // "nobody else has logged, delete instead" guard would dead-end here, since delete is refused
  // above. Leaving must still work, with nobody left to inherit ownership.
  const soloLeave = await post(`/api/sessions/${finished.id}/leave`, {}, creator.token) ?? {};
  ok(soloLeave.ok === true, `the creator can leave even with nobody current to hand ownership to (${JSON.stringify(soloLeave)})`);
  const dbFinal = await readDb(testDb.url);
  const finalSession = dbFinal.sessions[finished.id];
  ok(!!finalSession, 'the session still exists — leaving never deletes it');
  ok((finalSession.participants || []).length === 0, 'and now has no current participants at all');
  ok((finalSession.history || []).some(h => h.userId === participant.user.id)
     && (finalSession.history || []).some(h => h.userId === creator.user.id),
     "both the earlier partner's AND the creator's own history credit are intact");
  ok(finalSession.creatorId === null,
     'creatorId is cleared to null, not left pointing at the person who just walked away');

  console.log('\n...and the departed (ex-)creator does NOT keep quiet ownership of it');
  const editAttempt = await fetch(B + '/api/sessions/' + finished.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + creator.token },
    body: JSON.stringify({ name: 'Renamed by someone who already left' }),
  });
  ok(editAttempt.status === 403, `they can no longer PUT/edit it (got ${editAttempt.status})`);
  const stillNamed = (await readDb(testDb.url)).sessions[finished.id].name;
  ok(stillNamed === 'Push Day', `and the name on disk is untouched (${stillNamed})`);
  const deleteAfterOrphan = await fetch(B + '/api/sessions/' + finished.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + creator.token } });
  ok(deleteAfterOrphan.status === 403, `nor DELETE it (got ${deleteAfterOrphan.status})`);
  const list = await fetch(B + '/api/sessions', { headers: { Authorization: 'Bearer ' + creator.token } }).then(r => r.json());
  ok(!list.some(x => x.id === finished.id && (x.participants || []).includes(creator.user.id)),
     'and it does not sit in their own "Your Sessions" forever either — the exact problem this redesign exists to fix');
}

console.log('\nJeff, Aug 20 (cold-review catch): the "remove it from your profile instead" Delete-fallback must not bypass Keep/Discard either');
{
  // A creator whose Delete gets refused because a partner holds credit here (othersWithCredit) —
  // this is the OTHER door into "leave", separate from the Leave button, and it used to post an
  // empty {} body straight to /leave, which defaults keep to true and force-credited the creator
  // exactly like the pre-Aug-20 bug, even though they never chose to keep anything.
  const bugSession = await post('/api/sessions', {
    name: 'Arm Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Curl' }],
    inviteUsernames: [], visibility: 'private',
  }, creator.token);
  await fetch(B + '/api/sessions/' + bugSession.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + creator.token },
    body: JSON.stringify({ inviteUsernames: ['leave_partner'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + bugSession.id + '/accept', {}, participant.token);
  const exId = bugSession.exercises[0].id;
  // the PARTNER finishes, so deleting the session would erase their credit (this is what makes
  // DELETE return canLeave:true below)
  await post('/api/sessions/' + bugSession.id + '/log', { exerciseId: exId, weight: 40, reps: 10 }, participant.token);
  await post('/api/sessions/' + bugSession.id + '/lock', {}, participant.token);
  // the CREATOR has logged a couple sets here too, but has NOT finished — the exact "off day, want
  // out entirely" shape this whole feature exists for
  await post('/api/sessions/' + bugSession.id + '/log', { exerciseId: exId, weight: 45, reps: 8 }, creator.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, ctx);
  sink.html = '';
  // v233: deleteSession now shows an in-app confirm sheet first (browser confirm() is gone);
  // the actual DELETE lives in deleteSessionConfirmed, which the sheet's red button calls.
  await vm.runInContext('deleteSession', ctx)(bugSession.id, false);
  ok(sink.html.includes('Delete workout?'), 'deleteSession opens the in-app confirm sheet first (v233)');
  sink.html = '';
  await vm.runInContext('deleteSessionConfirmed', ctx)(bugSession.id, false);
  ok(sink.html.includes('Save today\'s sets') && sink.html.includes('Discard today\'s sets'),
     'the delete-fallback opens the same Keep/Discard sheet Leave uses, instead of posting an empty {} leave body');
  const dbMid = await readDb(testDb.url);
  ok(!(dbMid.sessions[bugSession.id].history || []).some(h => h.userId === creator.user.id),
     'and the creator has NOT already been force-credited just by the fallback triggering');

  sink.html = '';
  await vm.runInContext('leaveWorkoutConfirmed', ctx)(bugSession.id, false);
  const dbAfter = await readDb(testDb.url);
  ok(!(dbAfter.sessions[bugSession.id].history || []).some(h => h.userId === creator.user.id),
     'choosing discard from the delete-fallback leaves zero history for the creator, same as the Leave button');
  ok(!dbAfter.sessions[bugSession.id].participants.includes(creator.user.id),
     'and the creator is removed as a participant, same as any other Leave');
  ok((dbAfter.sessions[bugSession.id].history || []).some(h => h.userId === participant.user.id),
     "the partner's own credit — the reason Delete was refused in the first place — is untouched");
}

console.log('\nand the delete-fallback for an ALREADY-finished creator still just leaves cleanly, no duplicate credit');
{
  const finSession = await post('/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Leg Press' }],
    inviteUsernames: [], visibility: 'private',
  }, creator.token);
  await fetch(B + '/api/sessions/' + finSession.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + creator.token },
    body: JSON.stringify({ inviteUsernames: ['leave_partner'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + finSession.id + '/accept', {}, participant.token);
  const exId = finSession.exercises[0].id;
  await post('/api/sessions/' + finSession.id + '/log', { exerciseId: exId, weight: 200, reps: 5 }, participant.token);
  await post('/api/sessions/' + finSession.id + '/lock', {}, participant.token);
  // the creator ALSO finishes this time, before attempting to delete
  await post('/api/sessions/' + finSession.id + '/log', { exerciseId: exId, weight: 225, reps: 3 }, creator.token);
  await post('/api/sessions/' + finSession.id + '/lock', {}, creator.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, ctx);
  sink.html = '';
  await vm.runInContext('deleteSession', ctx)(finSession.id, true);
  ok(sink.html.includes('Delete workout?'), 'confirm sheet shown for the already-finished case too (v233)');
  await vm.runInContext('deleteSessionConfirmed', ctx)(finSession.id, true);
  const db = await readDb(testDb.url);
  const hist = (db.sessions[finSession.id].history || []).filter(h => h.userId === creator.user.id);
  ok(hist.length === 1, `already-finished delete-fallback does not duplicate the creator's credit (${hist.length} row(s))`);
  ok(!db.sessions[finSession.id].participants.includes(creator.user.id), 'and the creator is removed as a participant');
}

console.log("\nJeff, Aug 21: \"I have exercises in my profile that when I click on show as forbidden. I cannot delete them or move them?\" — a workout you left (with credit kept) still lists on your profile via its history row, but until now sessionTier had no path back to it once you were off `participants`: a PRIVATE session (the default) has no friend-tier route either, and most people never post a recap before leaving. That left it permanently 'stranger' — clicking your own completed workout 403'd forever.");
{
  const orphSession = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: [], visibility: 'private',
  }, creator.token);
  await fetch(B + '/api/sessions/' + orphSession.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + creator.token },
    body: JSON.stringify({ inviteUsernames: ['leave_partner'] }),
  }).then(r => r.json());
  await post('/api/sessions/' + orphSession.id + '/accept', {}, participant.token);
  const exId = orphSession.exercises[0].id;
  await post('/api/sessions/' + orphSession.id + '/log', { exerciseId: exId, weight: 135, reps: 8 }, participant.token);
  // partner writes a recap before leaving — this is the one thing that should still be theirs to see
  await post('/api/sessions/' + orphSession.id + '/post', { notes: 'Felt strong today', media: [], visibility: 'only_me' }, participant.token);
  await post('/api/sessions/' + orphSession.id + '/leave', { keep: true }, participant.token);

  const dbNow = await readDb(testDb.url);
  ok((dbNow.sessions[orphSession.id].history || []).some(h => h.userId === participant.user.id),
     'the partner kept their credit — this session still counts as "completed" on their profile');
  ok(!dbNow.sessions[orphSession.id].participants.includes(participant.user.id),
     'and is genuinely gone from participants, same as any Leave');

  const afterLeave = await fetch(B + '/api/sessions/' + orphSession.id, { headers: { Authorization: 'Bearer ' + participant.token } });
  ok(afterLeave.status === 200, `clicking that same workout on their own profile no longer 403s (got ${afterLeave.status})`);
  const view = await afterLeave.json();
  ok(!view.error, 'and the response is the session, not an error body');
  ok(!(view.participants || []).includes(participant.user.id), "the view is honest that they're not a current participant");
  ok(Array.isArray(view.exercises) && view.exercises.some(e => e.name === 'Bench Press'), 'the plan (what the workout was) still comes through');
  ok(view.posts && view.posts[participant.user.id] && view.posts[participant.user.id].notes === 'Felt strong today',
     'their OWN recap, written before they left, is still theirs to read back');
  ok(!view.logs || !view.logs[participant.user.id], "but their live SETS are not resurrected (Leave already deleted those — history is the permanent record now, weights/reps aren't)");
  ok(!view.logs || !view.logs[creator.user.id], "and they do not get handed the CREATOR's sets either — one visible recap of their own does not widen into everyone else's data");

  const editAttempt = await fetch(B + '/api/sessions/' + orphSession.id, {
    method: 'PUT', headers: { ...J, Authorization: 'Bearer ' + participant.token },
    body: JSON.stringify({ name: 'Renamed' }),
  });
  ok(editAttempt.status === 403, 'they still cannot edit it — leaving does not un-leave you back into ownership');
  const deleteAttempt2 = await fetch(B + '/api/sessions/' + orphSession.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + participant.token } });
  ok(deleteAttempt2.status === 403, "nor delete it — that's still creator-only, correctly, since someone else may still be training off this workout");

  // The new 'alumni' tier is earned ONLY by a real history row — confirm someone with none of that
  // (never in the session, not friends, no visible post) still gets exactly what a stranger always got.
  const stranger = await reg('leave_stranger', 'pass1234', 'Stranger');
  const strangerLook = await fetch(B + '/api/sessions/' + orphSession.id, { headers: { Authorization: 'Bearer ' + stranger.token } });
  ok(strangerLook.status === 403, `a genuine stranger to this session is still 403'd, not accidentally upgraded (got ${strangerLook.status})`);
}

console.log("\nthe new alumni check must not steal ground from a stronger tier — a still-mutual friend who left a FRIENDS-visible session should keep getting 'friend' (and everything that comes with it, like creatorFinished), not get quietly downgraded to the narrower 'alumni' shape");
{
  const friendlySession = await post('/api/sessions', {
    name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Lat Pulldown' }],
    inviteUsernames: ['leave_partner'], visibility: 'friends',
  }, creator.token);
  await post('/api/sessions/' + friendlySession.id + '/accept', {}, participant.token);
  const exId2 = friendlySession.exercises[0].id;
  await post('/api/sessions/' + friendlySession.id + '/log', { exerciseId: exId2, weight: 120, reps: 10 }, participant.token);
  await post('/api/sessions/' + friendlySession.id + '/leave', { keep: true }, participant.token);
  // creator finishes too, so creatorFinished has something real to report
  await post('/api/sessions/' + friendlySession.id + '/log', { exerciseId: exId2, weight: 150, reps: 8 }, creator.token);
  await post('/api/sessions/' + friendlySession.id + '/lock', {}, creator.token);

  const friendView = await fetch(B + '/api/sessions/' + friendlySession.id, { headers: { Authorization: 'Bearer ' + participant.token } }).then(r => r.json());
  ok(friendView.creatorFinished === true,
     "creatorFinished (friend-tier only) still comes through — leaving a still-friends session did not demote them to the narrower alumni view");
}

console.log('\na creator who leaves their OWN workout (creatorId goes null once nobody CURRENT is left to inherit it — see the comment above the reassignment in server.js) can still open it back up from their own profile, same as anyone else who kept credit');
{
  const soloSession = await post('/api/sessions', {
    name: 'Arm Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bicep Curl' }],
    inviteUsernames: ['leave_partner'], visibility: 'private',
  }, creator.token);
  await post('/api/sessions/' + soloSession.id + '/accept', {}, participant.token);
  const exId3 = soloSession.exercises[0].id;
  // partner logs and leaves FIRST, so the creator isn't leaving a workout nobody else ever touched
  // (the server refuses THAT as "delete it instead" — see othersWithCredit, a guard this test
  // deliberately does not try to bypass).
  await post('/api/sessions/' + soloSession.id + '/log', { exerciseId: exId3, weight: 25, reps: 10 }, participant.token);
  await post('/api/sessions/' + soloSession.id + '/leave', { keep: true }, participant.token);
  // now the creator, last one CURRENT, logs their own set and leaves too
  await post('/api/sessions/' + soloSession.id + '/log', { exerciseId: exId3, weight: 30, reps: 12 }, creator.token);
  await post('/api/sessions/' + soloSession.id + '/leave', { keep: true }, creator.token);

  const dbSolo = await readDb(testDb.url);
  ok(dbSolo.sessions[soloSession.id].creatorId === null, 'nobody CURRENT to hand ownership to, so creatorId goes null, as designed');
  const creatorLook = await fetch(B + '/api/sessions/' + soloSession.id, { headers: { Authorization: 'Bearer ' + creator.token } });
  ok(creatorLook.status === 200, `the departed creator can still open their own former workout (got ${creatorLook.status})`);
  const creatorView = await creatorLook.json();
  ok(!creatorView.error, 'not an error body');
  ok((creatorView.exercises || []).some(e => e.name === 'Bicep Curl'), 'the plan they built is still visible to them');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
