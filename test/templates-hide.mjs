// Removing a friend's shared routine (hide) and taking it back (unhide, v240).
// hide/unhide only ever touch YOUR OWN entry in hiddenBy — the owner's routine, and every other
// friend's view of it, must be unaffected by both. hiddenBy itself must never leave the server
// (an owner should not learn which friends quietly removed their routine).
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
  await fetch(B + '/api/friends/request', { method: 'POST', headers: a.H, body: JSON.stringify({ username: b.username }) });
  await fetch(B + '/api/friends/accept', { method: 'POST', headers: b.H, body: JSON.stringify({ from: a.id }) });
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
  let mine = await get(jeff, '/api/templates');
  ok(!mine.shared.some(x => x.id === t.id), 'hidden routine is out of MY shared list');
  let theirs = await get(brian, '/api/templates');
  ok(theirs.shared.some(x => x.id === t.id), "another friend's shared list is untouched");
  let owners = await get(casey, '/api/templates');
  const ownRow = owners.mine.find(x => x.id === t.id);
  ok(ownRow && ownRow.hiddenBy === undefined, "owner still has the routine, and can't see who hid it");

  r = await post(jeff, `/api/templates/${t.id}/unhide`);
  ok(r.status === 200, 'undo: unhide accepted');
  mine = await get(jeff, '/api/templates');
  const back = mine.shared.find(x => x.id === t.id);
  ok(!!back, 'the routine is back in my shared list after undo');
  ok(back && back.hiddenBy === undefined, 'and the restored row does not echo hiddenBy');

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
