// Sep 24 2026 (Jeff: "go through the entire app front to back and try to find things like this" --
// a fourth audit round, this time covering everything OUTSIDE the workout lifecycle rounds 1-3
// already swept: auth/accounts, friends/crews, notifications/feed, progress/PR/profile, and
// settings/admin/data lifecycle). Five parallel audits found 10 real bugs; Jeff: "lets work on them
// all from top to bottom." This file covers the fixes with real HTTP requests against a real
// server + real Postgres, same harness family as lifecycle-audit-round3.mjs.
//
// NOT covered here (and deliberately NOT fixed, discovered mid-build): two of the ten findings
// -- crew group chat's read/notify not respecting a block, and four crew-lifecycle notify() calls
// (renamed/left/deleted/challenge started) not respecting a block -- turned out to directly
// contradict an explicit, dated, tested prior decision (see the Sep 14 2026 comment on
// publicCrew() in server.js): Jeff deliberately left crew membership, chat, and crew notifications
// untouched by a block after an earlier attempt at hiding things there made the crew OWNER notice
// a member missing and start asking questions -- exactly the awkwardness blocking exists to avoid.
// Those two findings were reverted back to their original (correct, intentional) behavior rather
// than "fixed" against product intent; nothing new to test for them.
//
// Covered here:
//   1. POST /api/sessions/:id/accept never re-checked block at the moment membership is granted.
//   2. Strength Trend / Top Lifts: est/weight were being sent unconverted, mislabeled under a kg
//      user's current unit (off by ~2.2x).
//   3. Editing a crew (even just a rename) could silently drop an existing member who is no
//      longer a live follow-connection of the owner.
//   4. A crew at/over CREW_MAX_MEMBERS silently truncated instead of returning an error.
//   5. Several session swap/removal-proposal notify() loops didn't check isBlocked, unlike the
//      session data (suggestedEdits/logs) those same proposals already filter.
//   6. Admin-panel auth wasn't constant-time and had no rate limit.
//   7. Avatar re-upload in a different image format orphaned the previous file.
//   8. GET /api/notifications' joinRequests/removals leaked a blocked user's identity/note even
//      though the actual approve action already correctly refuses it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('lifecycleaudit4');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'lifecycleaudit4-'));
const PORT = 4984, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const postRaw = (p, b, tok, extraHeaders) => fetch(B + p, { method: 'POST', headers: { ...(tok ? { ...J, Authorization: 'Bearer ' + tok } : J), ...(extraHeaders || {}) }, body: JSON.stringify(b) });
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = async (username) => { const r = await post('/api/register', { username, pin: 'pass1234', displayName: username }); return { token: r.token, id: r.user.id, user: r.user }; };
const connect = async (a, b) => { await post(`/api/follow/${b.id}`, {}, a.token); };

console.log('\n1. POST /accept re-checks block at the moment membership is granted');
{
  const host = await reg('acc1_host');
  const invitee = await reg('acc1_invitee');
  await connect(host, invitee);
  const s = await post('/api/sessions', { name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], visibility: 'private', inviteUsernames: ['acc1_invitee'] }, host.token);
  await post(`/api/block/${invitee.id}`, {}, host.token);
  const acceptAttempt = await post(`/api/sessions/${s.id}/accept`, {}, invitee.token);
  ok(acceptAttempt.error === 'blocked', `accepting an invite after the host has blocked you is refused (got ${JSON.stringify(acceptAttempt)})`);
  const view = await get(`/api/sessions/${s.id}`, host.token);
  ok(!Array.isArray(view.participants) || !view.participants.includes(invitee.id), 'the blocked invitee never actually became a participant');

  const host2 = await reg('acc1_host2');
  const invitee2 = await reg('acc1_invitee2');
  await connect(host2, invitee2);
  const s2 = await post('/api/sessions', { name: 'Leg Day 2', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], visibility: 'private', inviteUsernames: ['acc1_invitee2'] }, host2.token);
  const acceptOk = await post(`/api/sessions/${s2.id}/accept`, {}, invitee2.token);
  ok(!acceptOk.error && Array.isArray(acceptOk.participants) && acceptOk.participants.includes(invitee2.id), `sanity: an ordinary (unblocked) accept still works (got ${JSON.stringify(acceptOk)})`);
}

console.log('\n2. Strength Trend / Top Lifts convert into the viewer\'s CURRENT unit instead of mislabeling a raw lb number');
{
  const u = await reg('trend1_user');
  await post('/api/me/units', { units: 'kg' }, u.token);
  // Two sessions on the same exercise so liftHistoryFor() has >=2 points (a trend/top-lift requires it).
  for (let i = 0; i < 2; i++) {
    const s = await post('/api/sessions', { name: 'Squat Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Back Squat' }], visibility: 'private' }, u.token);
    await post(`/api/sessions/${s.id}/start`, {}, u.token);
    await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 110, reps: 5, set: 1 }, u.token);
  }
  const prog = await get('/api/progress', u.token);
  const lift = (prog.trend.lifts || []).find(l => l.name === 'Back Squat');
  ok(!!lift, 'Back Squat shows up in the trend');
  if (lift) {
    // Bug value was 283 (the raw lb-scored Epley estimate, mislabeled "kg"); the correct kg-native
    // estimate for 110kg x5 is roughly 128kg. Assert it's nowhere near the bug value and lands in a
    // sane kg range, rather than pinning an exact rounded figure to a duplicated formula.
    const est = lift.points[lift.points.length - 1].est;
    ok(est > 100 && est < 160, `Strength Trend's kg estimated max is a real kg number, not the raw lb score mislabeled kg (got ${est}, bug value would be ~283)`);
    ok(lift.points[lift.points.length - 1].weight > 90 && lift.points[lift.points.length - 1].weight < 130, `the point's own weight is displayed in kg too (got ${lift.points[lift.points.length - 1].weight})`);
    ok(lift.currentWeight > 90 && lift.currentWeight < 130, `the "what's driving it" currentWeight is in kg too (got ${lift.currentWeight})`);
  }
  const tile = (prog.topLifts.lifts || []).find(l => l.name === 'Back Squat');
  ok(!!tile, 'Back Squat shows up in Top lifts');
  if (tile) ok(tile.weight > 90 && tile.weight < 130, `Top lifts tile weight is in kg too (got ${tile.weight})`);

  // Sanity: an lb-preference user logging in lb the whole time was never affected by the bug --
  // confirm the fix didn't break the ordinary case.
  const u2 = await reg('trend2_user');
  for (let i = 0; i < 2; i++) {
    const s = await post('/api/sessions', { name: 'Squat Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Back Squat' }], visibility: 'private' }, u2.token);
    await post(`/api/sessions/${s.id}/start`, {}, u2.token);
    await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 225, reps: 5, set: 1 }, u2.token);
  }
  const prog2 = await get('/api/progress', u2.token);
  const tile2 = (prog2.topLifts.lifts || []).find(l => l.name === 'Back Squat');
  ok(!!tile2 && tile2.weight === 225, `sanity: an lb user still sees their real lb weight unchanged (got ${tile2 && tile2.weight})`);
}

console.log('\n3. Editing a crew cannot silently drop a member who is no longer a live connection of the owner');
{
  const owner = await reg('crew1_owner');
  const member = await reg('crew1_member');
  await connect(owner, member);
  const c = await post('/api/crews', { name: 'Iron Crew', memberIds: [member.id] }, owner.token);
  ok(c.members.some(m => m.id === member.id), 'sanity: member really is in the crew after creation');
  // Owner unfollows member -- an everyday, unrelated action, no block involved.
  await post(`/api/unfollow/${member.id}`, {}, owner.token);
  // Client always resubmits every current member's id alongside a rename -- simulate exactly that.
  const renamed = await put(`/api/crews/${c.id}`, { name: 'Iron Crew 2', memberIds: [member.id] }, owner.token);
  ok(renamed.name === 'Iron Crew 2', 'the rename itself went through');
  ok(renamed.members.some(m => m.id === member.id), `the member survives an unrelated rename even though the owner unfollowed them (got members=${JSON.stringify((renamed.members||[]).map(m=>m.id))})`);
}

console.log('\n4. A crew at the member cap returns a real error instead of silently truncating');
{
  const owner = await reg('crew2_owner');
  const CAP = 20; // CREW_MAX_MEMBERS
  const memberIds = [];
  for (let i = 0; i < CAP; i++) {
    const m = await reg(`crew2_m${i}`);
    await connect(owner, m);
    memberIds.push(m.id);
  }
  const overCap = await post('/api/crews', { name: 'Too Big', memberIds }, owner.token);
  ok(overCap.error && /limit/i.test(overCap.error), `creating a crew with owner + ${CAP} members (one over the ${CAP}-member cap) is refused with a real error (got ${JSON.stringify(overCap)})`);
  const atCap = await post('/api/crews', { name: 'Just Right', memberIds: memberIds.slice(0, CAP - 1) }, owner.token);
  ok(!atCap.error && atCap.members.length === CAP, `sanity: exactly at the cap (owner + ${CAP - 1} members = ${CAP}) still works (got ${atCap.members && atCap.members.length} members)`);
}

console.log('\n5. Session swap/removal-proposal notify() loops now respect block, like the session data they touch already does');
{
  const host = await reg('swp1_host');
  const other = await reg('swp1_other');
  await connect(host, other);
  const s = await post('/api/sessions', { name: 'Pull Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Lat Pulldown' }], visibility: 'private', inviteUsernames: ['swp1_other'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  await post(`/api/block/${other.id}`, {}, host.token);
  // Other proposes a swap on the host's session while blocked by the host -- the proposal itself
  // isn't gated on block (suggest just requires participancy), but the host should get no
  // notification history entry about it.
  const beforeHistory = await get('/api/notifications', host.token);
  const beforeCount = (beforeHistory.history || []).length;
  await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: s.exercises[0].id, swapTo: 'Cable Row' }, other.token);
  const afterHistory = await get('/api/notifications', host.token);
  ok((afterHistory.history || []).length === beforeCount, `a blocked co-participant's swap proposal does not add a notification-history entry for the person who blocked them (before=${beforeCount}, after=${(afterHistory.history||[]).length})`);

  // Sanity: an UNBLOCKED proposer's swap still notifies normally.
  const host2 = await reg('swp2_host');
  const other2 = await reg('swp2_other');
  await connect(host2, other2);
  const s2 = await post('/api/sessions', { name: 'Pull Day 2', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Lat Pulldown' }], visibility: 'private', inviteUsernames: ['swp2_other'] }, host2.token);
  await post(`/api/sessions/${s2.id}/accept`, {}, other2.token);
  const beforeHistory2 = await get('/api/notifications', host2.token);
  const beforeCount2 = (beforeHistory2.history || []).length;
  await post(`/api/sessions/${s2.id}/suggest`, { type: 'swap', exerciseId: s2.exercises[0].id, swapTo: 'Cable Row' }, other2.token);
  const afterHistory2 = await get('/api/notifications', host2.token);
  ok((afterHistory2.history || []).length === beforeCount2 + 1, `sanity: an ordinary (unblocked) swap proposal still adds a notification (before=${beforeCount2}, after=${(afterHistory2.history||[]).length})`);
}

console.log('\n6. Admin-panel auth: constant-time compare + rate limited, same behavior for legit/wrong tokens');
{
  const wrong = await fetch(`${B}/api/admin/reports`, { headers: { 'x-admin-token': 'definitely-not-it', 'fly-client-ip': '203.0.113.9' } });
  ok(wrong.status === 401, `a wrong admin token still 401s (got ${wrong.status})`);
  // overLimit() only counts requests that carry a real client IP (fly-client-ip / x-forwarded-for)
  // -- a bare local request with neither (like the plain `wrong` request above) is deliberately
  // never rate-limited (see the comment on clientIp() in server.js: "a loopback health check or a
  // local test"), so this has to supply one to actually exercise the limiter, same as
  // test/ratelimit.mjs does for /api/login.
  let sawRateLimit = false;
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`${B}/api/admin/reports`, { headers: { 'x-admin-token': 'guess-' + i, 'fly-client-ip': '203.0.113.9' } });
    if (r.status === 429) { sawRateLimit = true; break; }
  }
  ok(sawRateLimit, 'repeated rapid wrong admin-token attempts from one client eventually hit a rate limit (429)');
}

console.log('\n7. Avatar re-upload in a different image format cleans up the previous file');
{
  const u = await reg('avatar1_user');
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const tinyJpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
  await postRaw('/api/me/avatar', { data: tinyPng, type: 'image/png' }, u.token).then(r => r.json());
  const filesAfterPng = readdirSync(join(DIR, 'uploads')).filter(f => f.startsWith(`avatar_${u.id}`));
  ok(filesAfterPng.length === 1 && filesAfterPng[0].endsWith('.png'), `first upload (png) leaves exactly one file (got ${JSON.stringify(filesAfterPng)})`);
  await postRaw('/api/me/avatar', { data: tinyJpg, type: 'image/jpeg' }, u.token).then(r => r.json());
  const filesAfterJpg = readdirSync(join(DIR, 'uploads')).filter(f => f.startsWith(`avatar_${u.id}`));
  ok(filesAfterJpg.length === 1 && filesAfterJpg[0].endsWith('.jpg'), `re-uploading under a DIFFERENT format leaves exactly one file, not two (got ${JSON.stringify(filesAfterJpg)})`);
}

console.log('\n8. GET /api/notifications no longer leaks a blocked user\'s identity via joinRequests/removals');
{
  // joinRequests: a public session, requester later blocked by the creator before it's answered.
  const creator = await reg('inbox1_creator');
  const requester = await reg('inbox1_requester');
  await connect(creator, requester); // canSeeProfile needs some visibility path to file the request
  const s = await post('/api/sessions', { name: 'Open Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }], visibility: 'public' }, creator.token);
  await post(`/api/sessions/${s.id}/join`, {}, requester.token);
  const beforeBlock = await get('/api/notifications', creator.token);
  ok((beforeBlock.joinRequests || []).some(j => j.from.id === requester.id), 'sanity: the join request shows up before any block');
  await post(`/api/block/${requester.id}`, {}, creator.token);
  const afterBlock = await get('/api/notifications', creator.token);
  ok(!(afterBlock.joinRequests || []).some(j => j.from.id === requester.id), `a since-blocked requester's join request no longer appears in the creator's inbox (got ${JSON.stringify(afterBlock.joinRequests)})`);

  // removals: a required approver (has logged sets) proposes removing an exercise, then gets blocked
  // by the creator before deciding -- the creator (not the approver) is who filed... wait, the
  // PROPOSER here is the creator (removal requests are always proposed by the session creator via
  // PUT /api/sessions/:id); the recipient of the listing entry is the required APPROVER. Block the
  // approver from the creator's side and confirm the creator's own removals listing isn't relevant
  // here (removals are listed for the APPROVER, not the creator) -- so block from the approver's
  // side instead and confirm the entry disappears from the approver's own inbox.
  const rcreator = await reg('inbox2_creator');
  const rapprover = await reg('inbox2_approver');
  await connect(rcreator, rapprover);
  const rs = await post('/api/sessions', { name: 'Removal Session', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], visibility: 'private', inviteUsernames: ['inbox2_approver'] }, rcreator.token);
  await post(`/api/sessions/${rs.id}/accept`, {}, rapprover.token);
  await post(`/api/sessions/${rs.id}/start`, {}, rcreator.token);
  await post(`/api/sessions/${rs.id}/log`, { exerciseId: rs.exercises[0].id, weight: 100, reps: 5, set: 1 }, rapprover.token);
  await put(`/api/sessions/${rs.id}`, { exercises: [] }, rcreator.token); // drop the exercise -> opens a pending removal requiring rapprover's sign-off
  const beforeBlock2 = await get('/api/notifications', rapprover.token);
  ok((beforeBlock2.removals || []).some(r => r.from.id === rcreator.id), 'sanity: the removal request shows up in the approver\'s inbox before any block');
  await post(`/api/block/${rcreator.id}`, {}, rapprover.token);
  const afterBlock2 = await get('/api/notifications', rapprover.token);
  ok(!(afterBlock2.removals || []).some(r => r.from.id === rcreator.id), `a since-blocked proposer's removal request no longer appears in the approver's inbox (got ${JSON.stringify(afterBlock2.removals)})`);
}

console.log(`\n${fails === 0 ? 'all assertions passed' : fails + ' assertion(s) FAILED'}`);
try { srv && srv.kill('SIGKILL'); } catch {}
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
try { await testDb.drop(); } catch {}
process.exit(fails === 0 ? 0 : 1);
