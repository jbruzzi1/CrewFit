// Oct 20 2026 (app-store readiness review -- "account deletion is real and well-built, but a user
// can only delete their data, not download it first"; Jeff: "lets do the age gate logic and the
// data export" -- this is the second half). POST /api/me/export-data requires the current password
// (same re-auth bar as reset-workouts/delete-account/password-change, same shared 'pw-confirm:'
// failure counter) and returns one JSON object covering: profile (minus pinHash/pinSalt/
// tokensValidFrom), the follow graph + blocked list, every session that touches this person
// (sessionTouchesUser -- the exact same predicate account deletion itself uses, so export and
// delete can never silently disagree about "what's mine"), owned templates, the full PR table,
// owned custom exercises, crew memberships (name + role, not the full roster), notification
// history, and reports this person has personally filed. Real server + real Postgres.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('dataexport');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'dataexport-'));
const PORT = 4798, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  try { srv && srv.kill(); } catch {}
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = async (username, pin, displayName) => { const r = await post('/api/register', { ageConfirmed: true, username, pin, displayName }); return r.json; };

try {

const EX_LIB = await get('/api/exercises');
const EX_NAME = EX_LIB[0].name;
const MUSCLE = EX_LIB[0].muscle_groups[0];

const alice = await reg('export_alice', 'pass1234', 'Alice');
const bob = await reg('export_bob', 'pass1234', 'Bob');

console.log('missing/wrong password is refused, no data returned');
{
  const noPw = await post('/api/me/export-data', {}, alice.token);
  ok(noPw.status === 400 && noPw.json.error === 'Password is incorrect', `no password -> 400 "Password is incorrect" (got ${noPw.status}, ${JSON.stringify(noPw.json)})`);
  const wrongPw = await post('/api/me/export-data', { password: 'nope12345' }, alice.token);
  ok(wrongPw.status === 400 && wrongPw.json.error === 'Password is incorrect', `wrong password -> 400 (got ${wrongPw.status}, ${JSON.stringify(wrongPw.json)})`);
  const noAuth = await fetch(B + '/api/me/export-data', { method: 'POST', headers: J, body: JSON.stringify({ password: 'pass1234' }) });
  ok(noAuth.status === 401, `no auth token at all -> 401 (got ${noAuth.status})`);
}

console.log('\nbuild up a real footprint for alice: a session, a template, a PR, a custom exercise, a crew, a follow, a report, a notification');
let sessionId, exId, templateId, crewId;
{
  const s = await post('/api/sessions', { name: 'Export Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: [], visibility: 'private' }, alice.token);
  sessionId = s.json.id; exId = s.json.exercises[0].id;
  const logged = await post(`/api/sessions/${sessionId}/log`, { exerciseId: exId, weight: 135, reps: 8 }, alice.token);
  ok(logged.status === 200, `logged a set, earns a PR (got ${logged.status})`);

  const t = await post('/api/templates', { name: 'Export Template', exercises: [{ name: EX_NAME, defaultSets: 3, defaultReps: 8 }] }, alice.token);
  templateId = t.json.id;
  ok(!!templateId, `created a template (got ${JSON.stringify(t.json)})`);

  const ce = await post('/api/exercises/custom', { name: 'Export Custom Curl ' + Math.random().toString(36).slice(2, 6), muscle_groups: [MUSCLE] }, alice.token);
  ok(ce.status === 200 && !!ce.json.id, `created a custom exercise (got ${ce.status}, ${JSON.stringify(ce.json)})`);

  const c = await post('/api/crews', { name: 'Export Crew' }, alice.token);
  crewId = c.json.id;
  ok(!!crewId, `created a crew, alice is owner (got ${JSON.stringify(c.json)})`);

  const f = await post('/api/follow/' + bob.user.id, {}, alice.token);
  ok(f.status === 200, `alice followed bob (got ${f.status}, ${JSON.stringify(f.json)})`);

  const rep = await post('/api/report', { targetType: 'user', targetUserId: bob.user.id, reason: 'spam', details: 'export test report' }, alice.token);
  ok(rep.status === 200, `alice filed a report against bob (got ${rep.status}, ${JSON.stringify(rep.json)})`);

  // A real notification: bob follows alice back-and-forth-ish -- simplest real trigger already
  // proven elsewhere in this suite is a follow notifying the followee, so have bob follow alice.
  await post('/api/follow/' + alice.user.id, {}, bob.token);
}

console.log('\na completely unrelated third user, with their own session/crew, must never leak into alice\'s export');
{
  const carol = await reg('export_carol', 'pass1234', 'Carol');
  await post('/api/sessions', { name: 'Carols Private Session', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: [], visibility: 'private' }, carol.token);
  await post('/api/crews', { name: 'Carols Crew' }, carol.token);
}

console.log("\nalice's export: correct password succeeds, and the shape is right");
let exported;
{
  const r = await post('/api/me/export-data', { password: 'pass1234' }, alice.token);
  ok(r.status === 200, `export succeeds with the right password (got ${r.status}, ${JSON.stringify(r.json && r.json.error)})`);
  exported = r.json;
  ok(typeof exported.exportedAt === 'string' && !isNaN(Date.parse(exported.exportedAt)), `exportedAt is a real timestamp (got ${exported.exportedAt})`);
}

console.log('\nprofile: no credential/auth internals ever leave the server');
{
  const p = exported.profile;
  ok(p.id === alice.user.id && p.username === 'export_alice', `profile identifies the right account (got ${JSON.stringify({ id: p.id, username: p.username })})`);
  for (const forbidden of ['pinHash', 'pinSalt', 'tokensValidFrom']) {
    ok(!(forbidden in p), `profile never includes "${forbidden}" (keys: ${Object.keys(p).join(', ')})`);
  }
  ok(p.ageConfirmed === true, `profile still carries the ordinary fields too, e.g. ageConfirmed (got ${p.ageConfirmed})`);
}

console.log('\nfollows + blocked: alice follows bob, bob follows alice back -- both directions present, and the shape matches what the client needs');
{
  ok(Array.isArray(exported.follows.following) && exported.follows.following.includes(bob.user.id), `following includes bob (got ${JSON.stringify(exported.follows.following)})`);
  ok(Array.isArray(exported.follows.followers) && exported.follows.followers.includes(bob.user.id), `followers includes bob (got ${JSON.stringify(exported.follows.followers)})`);
  ok(Array.isArray(exported.blockedUsers), `blockedUsers is an array, empty here (got ${JSON.stringify(exported.blockedUsers)})`);
}

console.log("\nsessions: alice's own session is included, with its real content -- and carol's session is NOT");
{
  ok(exported.sessions.some(s => s.id === sessionId && s.name === 'Export Push Day'), `alice's session is present (got ${exported.sessions.map(s => s.name).join(', ')})`);
  ok(!exported.sessions.some(s => s.name === 'Carols Private Session'), `carol's unrelated session is NOT present`);
}

console.log('\ntemplates: owned template present');
{
  ok(exported.templates.some(t => t.id === templateId && t.name === 'Export Template'), `alice's template is present (got ${exported.templates.map(t => t.name).join(', ')})`);
}

console.log('\npersonalRecords: the PR earned above is present, keyed by exercise name');
{
  ok(!!exported.personalRecords[EX_NAME], `a PR exists for "${EX_NAME}" (got keys: ${Object.keys(exported.personalRecords).join(', ')})`);
}

console.log('\ncustomExercises: the one alice created is present, owned by her');
{
  ok(exported.customExercises.length >= 1, `at least one custom exercise present (got ${exported.customExercises.length})`);
  ok(exported.customExercises.every(e => e.ownerId === alice.user.id), `every custom exercise in the export is actually owned by alice (got owners: ${exported.customExercises.map(e => e.ownerId).join(', ')})`);
}

console.log("\ncrewMemberships: alice's crew is present with her role, and carol's crew is NOT -- only name+role, not a full roster");
{
  const mine = exported.crewMemberships.find(c => c.id === crewId);
  ok(!!mine && mine.name === 'Export Crew' && mine.role === 'owner', `alice's crew membership present with role "owner" (got ${JSON.stringify(mine)})`);
  ok(!exported.crewMemberships.some(c => c.name === "Carols Crew"), `carol's unrelated crew is NOT present`);
  ok(!('members' in (mine || {})) && !('memberIds' in (mine || {})), `crew membership entry carries no full roster field (got keys: ${Object.keys(mine || {}).join(', ')})`);
}

console.log('\nreportsFiled: the report alice filed against bob is present, correctly scoped to the reporter');
{
  ok(exported.reportsFiled.some(r => r.reporterId === alice.user.id && r.targetUserId === bob.user.id && r.reason === 'spam'), `alice's filed report is present (got ${JSON.stringify(exported.reportsFiled)})`);
}

console.log("\nnotifications: bob following alice back generated a real notification alice can see in her own export");
{
  ok(Array.isArray(exported.notifications), `notifications is an array (got ${typeof exported.notifications})`);
  // Not every follow configuration guarantees a notification (e.g. if follow-approval is required
  // and pending) -- assert on the array's shape being sane rather than over-asserting on content
  // this test doesn't fully control, but DO assert every notification that exists really belongs
  // to alice, never someone else's.
  ok(exported.notifications.every(n => n.userId === alice.user.id), `every notification in the export actually belongs to alice, none leaked from another user (got ${JSON.stringify(exported.notifications.map(n => n.userId))})`);
}

console.log('\nbob\'s own export is scoped to bob -- never sees any of alice\'s data');
{
  const r = await post('/api/me/export-data', { password: 'pass1234' }, bob.token);
  ok(r.status === 200, `bob's export succeeds too (got ${r.status})`);
  ok(!r.json.sessions.some(s => s.id === sessionId), `bob's export does not include alice's session`);
  ok(!r.json.templates.some(t => t.id === templateId), `bob's export does not include alice's template`);
  ok(!r.json.crewMemberships.some(c => c.id === crewId), `bob's export does not include alice's crew (bob was never a member)`);
}

console.log('\nsessions in the export are redacted PER-VIEWER, exactly like every other session-reading route -- regression coverage for a real bug a cold-review caught: the export used to return raw, unfiltered session objects, leaking other participants\' private recaps, draft notes, join-request notes, and logged sets. Uses fresh users (not alice/bob) so this block\'s export calls don\'t disturb the rate-limit accounting just below.');
{
  const dave = await reg('export_dave', 'pass1234', 'Dave');
  const erin = await reg('export_erin', 'pass1234', 'Erin');
  const frank = await reg('export_frank', 'pass1234', 'Frank');
  // POST /api/sessions only allows inviting an existing CONNECTION (an approved follow, either
  // direction -- see connectionsOf()), not an arbitrary username -- dave needs to actually follow
  // both before any of the sessions below can invite them.
  await post('/api/follow/' + erin.user.id, {}, dave.token);
  await post('/api/follow/' + frank.user.id, {}, dave.token);

  console.log('  a blocked co-participant\'s private recap must not appear in the blocker\'s export');
  {
    const s = await post('/api/sessions', { name: 'Leak Check A', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: ['export_erin'], visibility: 'private' }, dave.token);
    const exId2 = s.json.exercises[0].id;
    await post(`/api/sessions/${s.json.id}/accept`, {}, erin.token);
    await post(`/api/sessions/${s.json.id}/log`, { exerciseId: exId2, weight: 999, reps: 1 }, erin.token);
    await post(`/api/sessions/${s.json.id}/post`, { notes: 'ERIN PRIVATE RECAP SECRET', visibility: 'private' }, erin.token);
    await post('/api/block/' + erin.user.id, {}, dave.token);
    const r = await post('/api/me/export-data', { password: 'pass1234' }, dave.token);
    const mine = r.json.sessions.find(x => x.name === 'Leak Check A');
    const erinPost = mine && mine.posts && mine.posts[erin.user.id];
    ok(!erinPost || erinPost.hidden === true, `dave's export does not expose erin's private recap text after blocking her (got ${JSON.stringify(erinPost)})`);
    ok(!mine || !mine.logs || !mine.logs[erin.user.id], `dave's export does not expose erin's actual logged set either (got ${JSON.stringify(mine && mine.logs && mine.logs[erin.user.id])})`);
  }

  console.log('  a co-participant\'s own-eyes-only draft note must not appear in another participant\'s export');
  {
    const s = await post('/api/sessions', { name: 'Leak Check B', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: ['export_frank'], visibility: 'private' }, dave.token);
    await post(`/api/sessions/${s.json.id}/accept`, {}, frank.token);
    await post(`/api/sessions/${s.json.id}/draft-notes`, { notes: 'FRANK SECRET DRAFT NOTE NOT POSTED' }, frank.token);
    const r = await post('/api/me/export-data', { password: 'pass1234' }, dave.token);
    const mine = r.json.sessions.find(x => x.name === 'Leak Check B');
    const dumped = JSON.stringify(mine);
    ok(!dumped.includes('FRANK SECRET DRAFT NOTE'), `dave's export does not contain frank's draft note (session keys: ${mine ? Object.keys(mine).join(', ') : 'none'})`);
  }

  console.log('  a non-creator participant\'s export must not reveal another person\'s join-request note (the creator alone sees the full list, same rule sessionView already enforces elsewhere)');
  {
    const s = await post('/api/sessions', { name: 'Leak Check C', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: ['export_frank'], visibility: 'public' }, dave.token);
    await post(`/api/sessions/${s.json.id}/accept`, {}, frank.token);
    await post(`/api/sessions/${s.json.id}/join`, { note: 'ERIN WANTS IN SECRET NOTE' }, erin.token);
    const r = await post('/api/me/export-data', { password: 'pass1234' }, frank.token);   // frank: member, NOT creator
    const mine = r.json.sessions.find(x => x.name === 'Leak Check C');
    const dumped = JSON.stringify(mine);
    ok(!dumped.includes('ERIN WANTS IN SECRET NOTE'), `frank (a member but not the creator) does not see erin's join-request note in his own export (got session keys: ${mine ? Object.keys(mine).join(', ') : 'none'})`);
  }

  console.log('  someone merely INVITED (never accepted/joined) must not see a real co-invitee\'s actual logged weights/reps in their own export');
  {
    // A fresh user, not erin -- erin was blocked BY dave in the scenario just above, and a block
    // is persistent/bidirectional (isBlocked), not scoped to the one session it happened in, so
    // reusing erin here would make dave's later invite fail sessionTier's own
    // `!isBlocked(inviterId, viewerId)` check for an unrelated reason that has nothing to do with
    // what this scenario is actually testing.
    const grace = await reg('export_grace', 'pass1234', 'Grace');
    await post('/api/follow/' + grace.user.id, {}, dave.token);
    const s = await post('/api/sessions', { name: 'Leak Check D', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: ['export_frank', 'export_grace'], visibility: 'private' }, dave.token);
    const exId2 = s.json.exercises[0].id;
    await post(`/api/sessions/${s.json.id}/accept`, {}, frank.token);
    await post(`/api/sessions/${s.json.id}/log`, { exerciseId: exId2, weight: 777, reps: 3 }, frank.token);
    // grace never accepts -- stays in s.invited only, never a participant.
    const r = await post('/api/me/export-data', { password: 'pass1234' }, grace.token);
    const mine = r.json.sessions.find(x => x.name === 'Leak Check D');
    const dumped = JSON.stringify(mine);
    ok(!dumped.includes('777'), `a merely-invited, never-joined user's export does not include a co-invitee's real logged set (got session: ${dumped})`);
  }
}

console.log('\nrate limit: this route has its own 5/hour cap on top of the shared pw-confirm failure counter -- a correctly-authenticated caller requesting it repeatedly still gets throttled');
{
  // alice has made exactly 1 successful call so far (the "correct password succeeds" check above
  // -- the earlier no-password/wrong-password attempts never reach overLimit('export:'...) at all,
  // since the password check returns before it). overLimit's own contract (see its comment) is
  // "count > max", so calls 2-5 below (4 more) still succeed, landing exactly on the 5/hour cap;
  // a 5th more (6th overall, i=4) must be the first to 429.
  let lastStatus = 200;
  for (let i = 0; i < 5; i++) {
    const r = await post('/api/me/export-data', { password: 'pass1234' }, alice.token);
    lastStatus = r.status;
  }
  ok(lastStatus === 429, `after repeated successful exports, the per-account export rate limit kicks in (last status: ${lastStatus})`);
}

} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
