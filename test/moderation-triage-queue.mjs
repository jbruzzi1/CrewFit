// Oct 21 2026 (moderation tooling, Slice A -- app-store readiness review item "moderation
// tooling"). GET /api/admin/reports/grouped (new) groups reports about the same target into one
// row with a distinct-reporter count, instead of admin.html's pre-existing flat list showing N
// indistinguishable rows for N reports about the same thing. Jeff picked grouped-by-target over
// flat-list+filters when asked how admin.html should present this.
//
// Covers exactly what the plan asked for: file 3 reports against one comment and 1 against
// another -> confirm the grouped endpoint returns 2 groups with correct distinct-reporter counts,
// not 4 flat rows -- plus that the pre-existing flat GET /api/admin/reports is completely
// unaffected (still 4 raw rows), and that resolving a group's reports (via the existing per-report
// resolve route, one call per still-open report in the group) correctly flips hasOpen only once
// every report in that group is actually resolved, not after the first one.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

// Cold-review finding #3 (Oct 21 2026): the grouped query used to GROUP BY the raw
// (targetType, targetUserId, sessionId, authorId, commentId) tuple, which could split ONE real
// comment into multiple admin triage groups if two reports for the same commentId carried
// differing sessionId/authorId (legacy/malformed data). Fixed by grouping comment reports on
// commentId alone (see REPORTS_GROUPED_SQL's group_key CASE in db.js). POST /api/report's own
// new validation (that a comment report must resolve to one real, visible comment) makes this
// exact mismatched-field scenario unreachable through the live HTTP API going forward -- so this
// regression test bypasses the API and writes raw report rows directly to Postgres, the same
// "prove the db.js layer alone is still correct against malformed data" pattern
// test/exposure.mjs's own putSessionRaw/putCustomExerciseRows use for their own legacy-data cases.
async function putReportRaw(row) {
  const pg = new PgConnection(parseConnString(testDb.url));
  await pg.query('INSERT INTO reports (id, data) VALUES ($1, $2::jsonb)', [row.id, JSON.stringify(row)]);
  pg.close();
}

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('modtriage');
const rand = () => Math.random().toString(36).slice(2, 8);

function boot(port, dir) {
  return new Promise(res => {
    let adminToken = null;
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => {
      const m = String(d).match(/Generated ADMIN_TOKEN.*?:\s*(\S+)/);
      if (m) adminToken = m[1];
      if (String(d).includes('CrewFit on')) res({ srv, adminToken: () => adminToken });
    });
    srv.on('exit', () => res({ srv: null, adminToken: () => adminToken }));
    setTimeout(() => res({ srv, adminToken: () => adminToken }), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'modtriage-'));
const PORT = 4993, B = `http://localhost:${PORT}`;
const { srv, adminToken } = await boot(PORT, DIR);
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
const get  = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const adminGet = (p) => fetch(B + p, { headers: { 'x-admin-token': adminToken() } }).then(r => r.json());
const adminPost = (p, b) => fetch(B + p, { method: 'POST', headers: { ...J, 'x-admin-token': adminToken() }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const reg = async (username) => { const r = await post('/api/register', { ageConfirmed: true, username, pin: 'pass1234', displayName: username }); return r.json; };
const report = (reporterTok, body) => post('/api/report', { targetType: 'comment', reason: 'spam', ...body }, reporterTok);

try {

const EX_LIB = await get('/api/exercises');
const EX_NAME = EX_LIB[0].name;

const alice = await reg('tq_alice_' + rand());
const bob = await reg('tq_bob_' + rand());
const carol = await reg('tq_carol_' + rand());
const dave = await reg('tq_dave_' + rand());
const erin = await reg('tq_erin_' + rand());

// POST /api/sessions only allows inviting an existing CONNECTION (an approved follow, either
// direction -- see connectionsOf()), not an arbitrary username -- same prerequisite
// test/data-export.mjs's own session-setup comment documents.
for (const u of [bob, carol, dave, erin]) await post('/api/follow/' + u.user.id, {}, alice.token);
const s = await post('/api/sessions', { name: 'Push Day', scheduledAt: new Date().toISOString(), exercises: [{ name: EX_NAME }], inviteUsernames: [bob.user.username, carol.user.username, dave.user.username, erin.user.username], visibility: 'public' }, alice.token);
for (const u of [bob, carol, dave, erin]) await post(`/api/sessions/${s.json.id}/accept`, {}, u.token);

const c1 = await post(`/api/sessions/${s.json.id}/comments`, { text: 'comment that gets reported 3 times' }, bob.token);
const c2 = await post(`/api/sessions/${s.json.id}/comments`, { text: 'comment that gets reported once' }, bob.token);
const list = await get(`/api/sessions/${s.json.id}/comments`, alice.token);
const target1 = list.find(x => x.text === 'comment that gets reported 3 times');
const target2 = list.find(x => x.text === 'comment that gets reported once');
ok(!!target1 && !!target2, 'both comments exist to report against');

await report(carol.token, { sessionId: s.json.id, commentId: target1.id });
await report(dave.token, { sessionId: s.json.id, commentId: target1.id });
await report(erin.token, { sessionId: s.json.id, commentId: target1.id });
await report(carol.token, { sessionId: s.json.id, commentId: target2.id, reason: 'inappropriate' });

console.log('\n-- the flat list is completely unaffected: still 4 raw rows --');
{
  const flat = await adminGet('/api/admin/reports');
  const mine = flat.filter(r => r.commentId === target1.id || r.commentId === target2.id);
  ok(mine.length === 4, `flat GET /api/admin/reports still returns all 4 individual reports (got ${mine.length})`);
}

console.log('\n-- grouped view: 2 groups, not 4 flat rows, with correct per-group counts --');
let groupsAtStart;
{
  const grouped = await adminGet('/api/admin/reports/grouped');
  const g1 = grouped.find(x => x.commentId === target1.id);
  const g2 = grouped.find(x => x.commentId === target2.id);
  groupsAtStart = { g1, g2 };
  ok(!!g1 && !!g2, 'both groups are present');
  ok(g1 && g1.reportCount === 3 && g1.distinctReporters === 3, `group 1: 3 reports, 3 distinct reporters (got ${g1 && g1.reportCount}/${g1 && g1.distinctReporters})`);
  ok(g1 && g1.reports.length === 3, `group 1 nests all 3 individual reports (got ${g1 && g1.reports.length})`);
  ok(g2 && g2.reportCount === 1 && g2.distinctReporters === 1, `group 2: 1 report, 1 distinct reporter (got ${g2 && g2.reportCount}/${g2 && g2.distinctReporters})`);
  ok(g1 && g1.hasOpen === true && g2 && g2.hasOpen === true, 'both groups correctly show as having open reports');
  // target1 crossed the 3-distinct-reporter auto-hide threshold -- confirms Slice A's grouped
  // view and Slice B's auto-hide agree on the same underlying report data, not two separate counts.
  ok(g1 && g1.hidden === true, `group 1 (3 distinct reporters) is marked auto-hidden (got ${g1 && g1.hidden})`);
  ok(g2 && g2.hidden === false, `group 2 (1 reporter) is NOT auto-hidden (got ${g2 && g2.hidden})`);
}

console.log('\n-- resolving a group only flips hasOpen once EVERY report in it is resolved --');
{
  const r1 = groupsAtStart.g1.reports[0];
  const resolve1 = await adminPost(`/api/admin/reports/${encodeURIComponent(r1.id)}/resolve`, {});
  ok(resolve1.status === 200, `resolving one of group 1's 3 reports succeeds (got ${resolve1.status})`);
  const afterOne = await adminGet('/api/admin/reports/grouped');
  const g1AfterOne = afterOne.find(x => x.commentId === target1.id);
  ok(g1AfterOne && g1AfterOne.hasOpen === true, 'group 1 still shows hasOpen -- 2 of 3 reports are still open');

  const r2 = groupsAtStart.g1.reports[1], r3 = groupsAtStart.g1.reports[2];
  await adminPost(`/api/admin/reports/${encodeURIComponent(r2.id)}/resolve`, {});
  await adminPost(`/api/admin/reports/${encodeURIComponent(r3.id)}/resolve`, {});
  const afterAll = await adminGet('/api/admin/reports/grouped');
  const g1AfterAll = afterAll.find(x => x.commentId === target1.id);
  ok(g1AfterAll && g1AfterAll.hasOpen === false, `group 1 now shows hasOpen:false once all 3 reports are resolved (got ${g1AfterAll && g1AfterAll.hasOpen})`);
  const g2Unaffected = afterAll.find(x => x.commentId === target2.id);
  ok(g2Unaffected && g2Unaffected.hasOpen === true, "group 2 (unrelated, untouched) still shows hasOpen -- resolving group 1 didn't leak into it");
}

console.log('\n-- cold-review fix: mismatched sessionId/authorId for the same commentId still groups as ONE target, not split (finding #3) --');
{
  const commentId = 'c_mismatch_' + rand();
  const base = { targetType: 'comment', commentId, reason: 'spam', at: new Date().toISOString(), status: 'open' };
  // Three reports for the SAME comment, each deliberately carrying a DIFFERENT sessionId/authorId
  // -- the exact shape the old GROUP BY 1,2,3,4,5 would have split into up to 3 separate groups.
  await putReportRaw({ ...base, id: 'r_mm1_' + rand(), reporterId: carol.user.id, sessionId: s.json.id, authorId: '' });
  await putReportRaw({ ...base, id: 'r_mm2_' + rand(), reporterId: dave.user.id, sessionId: 'some-other-session-id', authorId: '' });
  await putReportRaw({ ...base, id: 'r_mm3_' + rand(), reporterId: erin.user.id, sessionId: s.json.id, authorId: 'some-bogus-author-id' });

  const grouped = await adminGet('/api/admin/reports/grouped');
  const matches = grouped.filter(x => x.commentId === commentId);
  ok(matches.length === 1, `mismatched sessionId/authorId for one commentId still produces exactly 1 group (got ${matches.length})`);
  ok(matches[0] && matches[0].reportCount === 3 && matches[0].distinctReporters === 3, `that one group correctly counts all 3 reports / 3 distinct reporters (got ${matches[0] && matches[0].reportCount}/${matches[0] && matches[0].distinctReporters})`);
}

console.log('\n-- an unrecognized admin token is refused on the grouped route too --');
{
  const wrong = await fetch(B + '/api/admin/reports/grouped', { headers: { 'x-admin-token': 'definitely-wrong' } });
  ok(wrong.status === 401, `wrong admin token -> 401 (got ${wrong.status})`);
  const none = await fetch(B + '/api/admin/reports/grouped');
  ok(none.status === 401, `no admin token -> 401 (got ${none.status})`);
}

} finally {
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll moderation triage-queue tests passed.');
  await cleanup();
  process.exit(fails ? 1 : 0);
}
