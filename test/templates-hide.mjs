// Removing a friend's shared routine (hide) and taking it back (unhide, v240).
// hide/unhide only ever touch YOUR OWN entry in hiddenBy — the owner's routine must be
// unaffected by both. hiddenBy itself must never leave the server (an owner should not learn
// which friends quietly removed their routine).
//
// Oct 2 2026 (routine-sharing redesign): this used to also assert hide/unhide's effect on GET
// /api/templates' `shared` list -- back when any connection's non-private routine passively
// showed up there for everyone, with hiddenBy as the one way to take it back out of YOUR OWN
// view. That passive model is retired (see GET /api/templates' own comment in server.js); `shared`
// now means "routines explicitly, still-pending shared with me" via the new t.sharedTo, which
// hide/unhide never touches. The /hide and /unhide routes themselves are left running, unused by
// any current client code, purely as a harmless no-op surface (server.js's own comment on
// /hide explains why deleting them outright wasn't worth the risk) -- so what's left worth
// testing here is their own direct mechanics (hiddenBy set/cleared, stripped from every
// response, ownership/idempotency/404 rules), not any effect on what shows up as "shared."
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const PORT = 4994, B = `http://localhost:${PORT}`;

let srv, srvDead = false;
function boot(dir, databaseUrl) {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore','pipe','pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(true); });
    srv.on('exit', () => { srvDead = true; res(false); });
    setTimeout(() => res(false), 12000);
  });
}
const stop = () => new Promise(r => { if (!srv || srvDead) return r(); srv.on('exit', r); srv.kill(); });

async function user(name) {
  const username = name + Math.floor(Math.random()*1e6);
  const r = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username, pin: 'pass1234', displayName: name }) }).then(x => x.json());
  return { id: r.user.id, username, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
async function befriend(a, b) {
  // v190 (Sep 2026): "friends" retired in favor of mutual follow -- see server.js.
  await fetch(B + '/api/follow/' + b.id, { method: 'POST', headers: a.H });
  await fetch(B + '/api/follow-requests/' + a.id + '/accept', { method: 'POST', headers: b.H });
  await fetch(B + '/api/follow/' + a.id, { method: 'POST', headers: b.H });
  await fetch(B + '/api/follow-requests/' + b.id + '/accept', { method: 'POST', headers: a.H });
}
const get = (u, p) => fetch(B + p, { headers: u.H }).then(x => x.json());
const post = (u, p, body={}) => fetch(B + p, { method: 'POST', headers: u.H, body: JSON.stringify(body) });

const DIR = mkdtempSync(join(tmpdir(), 'tplhide-'));
const testDb = await freshTestDb('tplhide1');
if (!await boot(DIR, testDb.url)) { console.log('  FAIL server did not boot'); process.exit(1); }
try {

console.log('remove (hide) takes a shared routine out of my list only, and undo (unhide) brings it back');
{
  const casey = await user('Casey'), jeff = await user('Jeff'), brian = await user('Brian');
  await befriend(casey, jeff);
  await befriend(casey, brian);
  const t = await fetch(B + '/api/templates', { method: 'POST', headers: casey.H,
    body: JSON.stringify({ name: 'Arm Day', exercises: [{ name: 'Curl' }] }) }).then(x => x.json());
  ok(t.id && t.hiddenBy === undefined, 'creating a routine never echoes hiddenBy');

  let r = await post(jeff, `/api/templates/${t.id}/hide`);
  ok(r.status === 200, 'a friend can hide a shared routine');
  let owners = await get(casey, '/api/templates');
  const ownRow = owners.mine.find(x => x.id === t.id);
  ok(ownRow && ownRow.hiddenBy === undefined, "owner still has the routine, and can't see who hid it");
  // brian never hid anything -- hide is per-caller state (t.hiddenBy keyed by whoever called it),
  // so this just confirms jeff's /hide call didn't somehow write brian's id in too.
  let brianHide = await post(brian, `/api/templates/${t.id}/hide`);
  ok(brianHide.status === 200, "a second, different friend can independently hide the same routine (per-caller state, not a shared flag)");

  r = await post(jeff, `/api/templates/${t.id}/unhide`);
  ok(r.status === 200, 'undo: unhide accepted');
  owners = await get(casey, '/api/templates');
  const afterUnhide = owners.mine.find(x => x.id === t.id);
  ok(afterUnhide && afterUnhide.hiddenBy === undefined, 'the owner still never sees hiddenBy, before or after an unhide');

  r = await post(jeff, `/api/templates/${t.id}/unhide`);
  ok(r.status === 200, 'unhide is idempotent — a double-tapped Undo is not an error');

  r = await post(jeff, '/api/templates/t_nope/unhide');
  ok(r.status === 404, 'unhide of a routine that does not exist is a 404');

  // hiding is per-person state; owner "hiding" their own is already rejected by /hide (400) —
  // and owner calling unhide on their own routine is a harmless no-op, not a new power
  r = await post(casey, `/api/templates/${t.id}/hide`);
  ok(r.status === 400, 'owner cannot hide their own routine (delete is their tool)');
}

} finally {
  await stop();
  await testDb.drop();
}
process.exit(fails ? 1 : 0);
