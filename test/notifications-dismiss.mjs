// Sep 9 2026 (Jeff: "I would like to be able to slide notifications away (slide them to the
// left) to remove them from the list if I don't want to wait the full 7 days for them to be
// removed." -- "no need for the confirmation liek you said - lets build this.").
//
// New DELETE /api/notifications/:id in server.js, right after the existing GET/seen routes:
// looks the notification up, 404s (not 403 -- a guessed id shouldn't confirm whether it exists
// for someone else) unless it belongs to the caller, then deletes it from DB.notifications and
// saves. That's the same object-map-delete-then-save(DB) mechanism pruneOldNotifications()
// already relies on (see db.js's syncTableDiff, which issues a real Postgres DELETE for any key
// missing from the in-memory object on the next save) -- this test proves that end to end
// through Postgres directly, not just through the in-memory read the GET endpoint gives back.
//
// This covers the server half only. The swipe gesture itself (drag-to-reveal, snap open/closed,
// tap-elsewhere-closes) is covered by test/notification-swipe-dismiss.mjs, a real-browser
// Playwright test -- the touch mechanics aren't something a node:vm DOM mock can exercise
// meaningfully without just reimplementing the logic it's supposed to check.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stderr.on('data', d => process.stderr.write(d));
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'notif-dismiss-'));
const testDb = await freshTestDb('notificationsdismiss');
const PORT = 4992, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR, testDb.url);
if (!srv) { console.log('FAIL boot'); process.exit(1); }

const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const reg = n => fetch(B + '/api/register', { method: 'POST', headers: J, body: JSON.stringify({ username: n, pin: 'pass1234', displayName: n }) }).then(r => r.json());
const P = (who, p, body) => fetch(B + p, { method: 'POST', headers: H(who.token), body: JSON.stringify(body || {}) }).then(r => r.json());
const G = (who, p) => fetch(B + p, { headers: H(who.token) }).then(r => r.json());
const D = (who, p) => fetch(B + p, { method: 'DELETE', headers: H(who.token) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

const me = await reg('ndme'), alice = await reg('ndalice'), bob = await reg('ndbob'), carol = await reg('ndcarol');

console.log('deleting a notification you own actually removes it -- from the API and from Postgres');
{
  await P(alice, `/api/follow/${me.user.id}`);  // public follow, completes instantly -- a real history row for `me`
  await P(bob, `/api/follow/${me.user.id}`);
  let data = await G(me, '/api/notifications');
  ok(data.history.length === 2, `me has two history rows to start (got ${data.history.length})`);
  const [first, second] = data.history;
  const startCount = data.count;

  const del = await D(me, `/api/notifications/${first.id}`);
  ok(del.status === 200 && del.body && del.body.ok === true, `DELETE succeeds (got ${del.status} ${JSON.stringify(del.body)})`);

  data = await G(me, '/api/notifications');
  ok(!data.history.some(h => h.id === first.id), 'the deleted row is gone from the API response');
  ok(data.history.some(h => h.id === second.id), 'the other row is untouched');
  ok(data.count === startCount - 1, `the bell badge count drops by exactly one (got ${data.count}, was ${startCount})`);

  const conn = new PgConnection(parseConnString(testDb.url));
  const row = await conn.query('SELECT id FROM notifications WHERE id = $1', [first.id]);
  ok(row.rows.length === 0, 'the row is actually deleted from Postgres, not just filtered out on read (save(DB) is awaited before the response returns)');
  const stillThere = await conn.query('SELECT id FROM notifications WHERE id = $1', [second.id]);
  ok(stillThere.rows.length === 1, "and the row that wasn't deleted is still really in Postgres");
  conn.close();
}

console.log("\nyou cannot delete someone else's notification");
{
  await P(carol, `/api/follow/${alice.user.id}`);   // a real history row that belongs to alice, not bob
  const aliceData = await G(alice, '/api/notifications');
  const aliceNotifId = aliceData.history[0].id;

  const del = await D(bob, `/api/notifications/${aliceNotifId}`);
  ok(del.status === 404, `bob deleting alice's notification 404s rather than succeeding or 403ing -- doesn't confirm it exists for someone else (got ${del.status})`);

  const after = await G(alice, '/api/notifications');
  ok(after.history.some(h => h.id === aliceNotifId), "alice's notification is still there after bob's refused attempt");
}

console.log('\ndeleting a notification id that does not exist at all 404s the same way');
{
  const del = await D(me, '/api/notifications/ntf_does_not_exist');
  ok(del.status === 404, `a nonexistent id 404s (got ${del.status})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
