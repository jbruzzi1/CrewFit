// Oct 12 2026 (Jeff: "I want the ability to delete any account I see fit" -- cleaning up fake/test
// accounts before launch, plus ongoing moderation afterward). Covers the new admin-initiated
// account deletion built on top of the EXISTING self-delete teardown (anonymizeAndDeleteAccount,
// extracted out of POST /api/me/delete-account -- see its own comment in server.js), plus the
// /healthz user-count fix that was the actual point: Jeff's real goal was "accurately track new
// users," and a deleted-but-not-actually-removed account (anonymize-in-place, never a hard
// delete -- see anonymizeAndDeleteAccount's comment for why) would keep inflating that count
// forever unless it's filtered out.
//
// The one assertion block that matters most isn't about the admin route's auth at all -- it's
// proving the exact scenario Jeff asked about before approving this ("what happens to MY workout
// if the person I logged it with deletes their account?"): his own shared history stays fully
// intact, only the deleted person's own name/photo disappear.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    let adminToken = null, out = '';
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => {
      out += d;
      const m = String(d).match(/Generated ADMIN_TOKEN.*?:\s*(\S+)/);
      if (m) adminToken = m[1];
      if (String(d).includes('CrewFit on')) res({ srv, out, adminToken });
    });
    srv.on('exit', () => res({ srv: null, out, adminToken }));
    setTimeout(() => res({ srv, out, adminToken }), 8000);
  });
}
async function readUsers(url) {
  const pg = new PgConnection(parseConnString(url));
  const r = await pg.query('SELECT id, data FROM users');
  pg.close();
  const users = {};
  for (const row of r.rows) users[row.id] = JSON.parse(row.data);
  return users;
}
async function readSessions(url) {
  const pg = new PgConnection(parseConnString(url));
  const r = await pg.query('SELECT id, data FROM sessions');
  pg.close();
  const sessions = {};
  for (const row of r.rows) sessions[row.id] = JSON.parse(row.data);
  return sessions;
}

const DIR = mkdtempSync(join(tmpdir(), 'admin-users-'));
const testDb = await freshTestDb('adminusers');
const PORT = 4994, B = `http://localhost:${PORT}`;
const { srv, adminToken } = await boot(PORT, DIR, testDb.url);
if (!srv) { console.log('FAIL: server did not boot'); process.exit(1); }
if (!adminToken) { console.log('FAIL: no ADMIN_TOKEN captured from boot log'); process.exit(1); }

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const postRaw = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) });
const adminGet = (p, token) => fetch(B + p, { headers: { 'x-admin-token': token } });
const adminPost = (p, token) => fetch(B + p, { method: 'POST', headers: { 'x-admin-token': token } });
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

try {

const jeff = await reg('adminu_jeff', 'pass1234', 'Jeff');
const brian = await reg('adminu_brian', 'pass1234', 'Brian');
const fake = await reg('adminu_faketest', 'pass1234', 'Fake Test Account');

console.log('\nGET /api/admin/users guard rails');
{
  const noToken = await fetch(B + '/api/admin/users');
  ok(noToken.status === 401, `no admin token is rejected (got ${noToken.status})`);
  const wrongToken = await adminGet('/api/admin/users', 'definitely-wrong');
  ok(wrongToken.status === 401, `the wrong admin token is rejected (got ${wrongToken.status})`);
  const good = await adminGet('/api/admin/users', adminToken);
  ok(good.status === 200, `the real admin token works (got ${good.status})`);
  const list = await good.json();
  ok(Array.isArray(list), 'returns a list');
  const fakeRow = list.find(u => u.id === fake.user.id);
  ok(!!fakeRow, 'the test account shows up in the list');
  ok(fakeRow.deleted === false, 'not marked deleted yet');
  ok(!!fakeRow.createdAt, 'has a createdAt timestamp to help tell test accounts apart from real ones');
}

console.log('\nPOST /api/admin/users/:id/delete guard rails');
{
  const noToken = await postRaw('/api/admin/users/' + fake.user.id + '/delete', {});
  ok(noToken.status === 401, `no admin token is rejected (got ${noToken.status})`);
  const wrongToken = await adminPost('/api/admin/users/' + fake.user.id + '/delete', 'definitely-wrong');
  ok(wrongToken.status === 401, `the wrong admin token is rejected (got ${wrongToken.status})`);
  const missingUser = await adminPost('/api/admin/users/not-a-real-id/delete', adminToken);
  ok(missingUser.status === 404, `deleting a nonexistent id 404s (got ${missingUser.status})`);
}

console.log('\ncold-review catch: a prototype-pollution id must 404, not corrupt every account on the server');
{
  // A plain `DB.users[id]` lookup is not safe against id === "__proto__" -- in JS,
  // `({})['__proto__']` returns Object.prototype itself, not undefined. Before this was fixed,
  // that skipped the `!u` 404 check and let anonymizeAndDeleteAccount write deleted:true and
  // scrambled credentials onto Object.prototype -- which every OTHER plain object in the process,
  // including every real user, then inherited. Verified by hand against a real running server
  // before the fix (login broke for an untouched account, /healthz undercounted) -- this proves
  // the fix actually closes it, not just that the obviously-malicious string gets rejected.
  for (const evilId of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = await adminPost('/api/admin/users/' + evilId + '/delete', adminToken);
    ok(r.status === 404, `"${evilId}" as the id is rejected with 404, not treated as a real user (got ${r.status})`);
  }
  // The real proof: a completely unrelated, never-touched account must still be able to log in
  // and /healthz must still count correctly -- if Object.prototype got poisoned, these would both
  // silently break for every account on the server, not just the one named in the URL.
  const bystander = await reg('adminu_bystander', 'pass1234', 'Bystander');
  const loginStillWorks = await post('/api/login', { username: 'adminu_bystander', pin: 'pass1234' });
  ok(!!loginStillWorks.token, "an untouched account can still log in (would silently fail if Object.prototype got poisoned)");
  const h = await fetch(B + '/healthz').then(r => r.json());
  ok(h.users >= 4, `/healthz still counts real accounts correctly, not corrupted to 0 (got ${h.users})`);
}

console.log("\nthe core scenario Jeff asked about before approving this: Jeff and Brian share a workout, Brian's fake test-account version gets admin-deleted -- Jeff's own data must stay completely intact");
{
  const shared = await post('/api/sessions', {
    name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }],
    inviteUsernames: ['adminu_faketest'], visibility: 'private',
  }, jeff.token);
  await post('/api/sessions/' + shared.id + '/accept', {}, fake.token);
  const exId = shared.exercises[0].id;
  await post('/api/sessions/' + shared.id + '/log', { exerciseId: exId, weight: 185, reps: 6 }, jeff.token);
  await post('/api/sessions/' + shared.id + '/log', { exerciseId: exId, weight: 95, reps: 10 }, fake.token);
  await post('/api/sessions/' + shared.id + '/lock', {}, jeff.token);
  await post('/api/sessions/' + shared.id + '/lock', {}, fake.token);
  // Public profiles (the default) land a follow immediately, no accept step needed -- this is
  // specifically here to exercise the follow-graph severance loop inside
  // anonymizeAndDeleteAccount, not to test the follow flow itself.
  await post('/api/follow/' + fake.user.id, {}, jeff.token);

  const del = await adminPost('/api/admin/users/' + fake.user.id + '/delete', adminToken);
  ok(del.status === 200, `admin delete succeeds (got ${del.status})`);

  const sessions = await readSessions(testDb.url);
  const s = sessions[shared.id];
  ok(!!s, "Jeff's shared workout still exists, not deleted");
  ok(s.creatorId === jeff.user.id, 'Jeff is still the creator -- he never lost ownership, this was never his account that got deleted');
  ok((s.history || []).some(h => h.userId === jeff.user.id), "Jeff's own credit (185x6) is fully intact");
  ok((s.logs && s.logs[jeff.user.id] && s.logs[jeff.user.id].length) > 0, "Jeff's actual logged set is untouched");
  // The deleted account's own footprint is handled exactly like a self-service delete would --
  // same wipeUserFromAllSessions() this reuses already proves (see reset-workouts.mjs/data-
  // safety.mjs) the deleted person's own credit/logs come out, not that the shared session dies.

  const users = await readUsers(testDb.url);
  const fakeRow = users[fake.user.id];
  ok(fakeRow.deleted === true, 'the deleted account is marked deleted');
  ok(fakeRow.displayName === 'Deleted user', 'display name anonymized, same as self-delete');
  ok(fakeRow.username.startsWith('deleted_'), 'username scrambled, same as self-delete (frees it for reuse)');
  ok(!fakeRow.followers.includes(jeff.user.id) && !fakeRow.following.length, "the deleted account's follow graph is severed");
  const jeffRow = users[jeff.user.id];
  ok(!(jeffRow.following || []).includes(fake.user.id), "Jeff's own following list no longer references the deleted account");
  ok(jeffRow.displayName === 'Jeff', "Jeff's own account is completely untouched -- only the OTHER account's identity changed");
}

console.log('\nan already-deleted account cannot be deleted again');
{
  const again = await adminPost('/api/admin/users/' + fake.user.id + '/delete', adminToken);
  ok(again.status === 400, `re-deleting an already-deleted account is rejected, not silently re-processed (got ${again.status})`);
}

console.log('\nthe admin list reflects the deletion');
{
  const list = await adminGet('/api/admin/users', adminToken).then(r => r.json());
  const fakeRow = list.find(u => u.id === fake.user.id);
  ok(fakeRow.deleted === true, 'shows deleted:true for the account that was just removed');
  ok(!!fakeRow.deletedAt, 'has a deletedAt timestamp');
}

console.log("\n/healthz's user count excludes deleted accounts -- the whole point of this (Jeff: 'accurately track new users')");
{
  const h = await fetch(B + '/healthz').then(r => r.json());
  // jeff + brian + the earlier exploit-test bystander account are live; `fake` was just
  // admin-deleted above and must not count.
  ok(h.users === 3, `healthz counts only the 3 live accounts, not the deleted one (got ${h.users})`);
}

console.log('\nself-service delete-account still works unchanged after the refactor (regression check)');
{
  const brian2 = await reg('adminu_brian2', 'pass1234', 'Brian Two');
  const r = await post('/api/me/delete-account', { password: 'pass1234' }, brian2.token);
  ok(r.ok === true, 'self-delete still succeeds');
  const users = await readUsers(testDb.url);
  ok(users[brian2.user.id].deleted === true, 'self-deleted account is marked deleted, same shape as admin-deleted ones');
  const h = await fetch(B + '/healthz').then(r => r.json());
  ok(h.users === 3, `self-deleted accounts are excluded from the count too (got ${h.users})`);
}

} finally {
  if (srv) srv.kill();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
