// Sep 27 2026 (Jeff): "Brian declined my workout invite - but later thought he could go so he
// wanted to be able to go back and message in the chat of the workout for a re-invitation... Maybe
// a decline notification within in his notifications where he could click and message the chat for
// a re-invite?" Followed immediately by: "along with this - we should add a 'reason for declining
// message' and the owner will get this message."
//
// Presented to Jeff as options (per CLAUDE.md hard rule #9 -- never lock in a subjective product
// call unilaterally); he picked: (a) a message to the creator, not literal chat access (a private
// decliner has none -- see sessionTier/sessionView's own comments), (b) a one-tap "Invite them
// back" from the creator's own notification, and (c) an optional (not required) reason on decline.
//
// Real server + real Postgres, same pattern as test/audit-v253-server.mjs -- this is server-route
// and notification-shape behavior, no UI to exercise, so no Playwright needed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('reinvite');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}

const DIR = mkdtempSync(join(tmpdir(), 'reinvite-'));
const PORT = 4995, B = `http://localhost:${PORT}`;
const srv = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b || {}) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
const reg = (username, displayName) => post('/api/register', { username, pin: '123456', displayName: displayName || username });
const connect = async (a, b) => { await post(`/api/follow/${b.user.id}`, {}, a.token); await post(`/api/follow/${a.user.id}`, {}, b.token); };

console.log('\ndecline with an optional reason -- reaches the creator, is not required');
{
  const jeff = await reg('rjeff1');
  const brian = await reg('rbrian1');
  await connect(jeff, brian);
  const s = await post('/api/sessions', { name: 'Push Day', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], inviteUsernames: ['rbrian1'] }, jeff.token);
  ok(s.invited.includes(brian.user.id), 'brian is invited');

  const declined = await post(`/api/sessions/${s.id}/decline`, { reason: 'Can\'t make it, sorry!' }, brian.token);
  ok(declined === null, `brian declines with a reason -- his own view of the now-private session is null (got ${JSON.stringify(declined)})`);

  const jeffNotifs = await get('/api/notifications', jeff.token);
  const declineRow = jeffNotifs.history.find(h => h.title === 'Invite declined');
  ok(!!declineRow, `jeff (the creator) gets the "Invite declined" history entry (got ${JSON.stringify(jeffNotifs.history)})`);
  ok(declineRow && declineRow.body.includes('Can\'t make it, sorry!'), `and it includes brian's actual reason text (got ${JSON.stringify(declineRow && declineRow.body)})`);

  const brianNotifs = await get('/api/notifications', brian.token);
  const ownDeclineRow = brianNotifs.history.find(h => h.title === 'You declined');
  ok(!!ownDeclineRow, `brian (the decliner) ALSO gets his own "You declined" notification now -- the tap target Jeff asked for (got ${JSON.stringify(brianNotifs.history)})`);
  ok(!!ownDeclineRow && ownDeclineRow.link && ownDeclineRow.link.type === 'reinvite-ask' && ownDeclineRow.link.sessionId === s.id,
    `and it links to the reinvite-ask compose flow, not the session itself (he has no access to it any more) (got ${JSON.stringify(ownDeclineRow && ownDeclineRow.link)})`);
}

console.log('\ndeclining with NO reason at all still works exactly as before (optional, not required)');
{
  const jeff = await reg('rjeff2');
  const brian = await reg('rbrian2');
  await connect(jeff, brian);
  const s = await post('/api/sessions', { name: 'Leg Day', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], inviteUsernames: ['rbrian2'] }, jeff.token);
  const declined = await post(`/api/sessions/${s.id}/decline`, {}, brian.token);
  ok(declined === null, 'declining with an empty body still succeeds');
  const jeffNotifs = await get('/api/notifications', jeff.token);
  const declineRow = jeffNotifs.history.find(h => h.title === 'Invite declined');
  ok(declineRow && declineRow.body === 'rbrian2 declined your workout', `no reason given -- the notification body is exactly the old, unquoted wording (got ${JSON.stringify(declineRow && declineRow.body)})`);
}

console.log('\nbrian changes his mind: sends a reinvite-request; jeff sees it live and can one-tap invite him back');
{
  const jeff = await reg('rjeff3');
  const brian = await reg('rbrian3');
  await connect(jeff, brian);
  const s = await post('/api/sessions', { name: 'Pull Day', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }], inviteUsernames: ['rbrian3'] }, jeff.token);
  await post(`/api/sessions/${s.id}/decline`, {}, brian.token);

  const askRes = await post(`/api/sessions/${s.id}/reinvite-request`, { message: 'I can make it after all!' }, brian.token);
  ok(askRes && askRes.ok === true, `brian's reinvite-request goes through (got ${JSON.stringify(askRes)})`);

  const jeffNotifs = await get('/api/notifications', jeff.token);
  const ask = jeffNotifs.reinviteAsks.find(a => a.sessionId === s.id);
  ok(!!ask, `jeff sees the live "wants back in" ask (got ${JSON.stringify(jeffNotifs.reinviteAsks)})`);
  ok(ask && ask.message === 'I can make it after all!', 'and it carries brian\'s actual message');
  ok(ask && ask.from.username === 'rbrian3', 'and identifies brian as the asker');
  ok(jeffNotifs.count >= 1, 'the reinvite ask also counts toward the notifications badge');

  const approveRes = await post(`/api/sessions/${s.id}/reinvite-request/${ask.reqId}/approve`, {}, jeff.token);
  ok(!approveRes.error, `jeff one-taps "Invite them back" (got ${JSON.stringify(approveRes.error || 'ok')})`);
  ok((approveRes.invited || []).includes(brian.user.id), `brian is back on the invite list (got ${JSON.stringify(approveRes.invited)})`);

  const jeffNotifsAfter = await get('/api/notifications', jeff.token);
  ok(!jeffNotifsAfter.reinviteAsks.some(a => a.sessionId === s.id), 'the ask is cleared from jeff\'s list once acted on');

  const brianNotifs = await get('/api/notifications', brian.token);
  ok(brianNotifs.invites.some(iv => iv.sessionId === s.id), 'brian sees a fresh, real workout invite -- same as any other invite');
}

console.log('\njeff can also just dismiss the ask without re-inviting');
{
  const jeff = await reg('rjeff4');
  const brian = await reg('rbrian4');
  await connect(jeff, brian);
  const s = await post('/api/sessions', { name: 'Arms Day', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Curl' }], inviteUsernames: ['rbrian4'] }, jeff.token);
  await post(`/api/sessions/${s.id}/decline`, {}, brian.token);
  await post(`/api/sessions/${s.id}/reinvite-request`, { message: 'still hoping' }, brian.token);
  const jeffNotifs = await get('/api/notifications', jeff.token);
  const ask = jeffNotifs.reinviteAsks.find(a => a.sessionId === s.id);
  const dismissRes = await post(`/api/sessions/${s.id}/reinvite-request/${ask.reqId}/dismiss`, {}, jeff.token);
  ok(dismissRes && dismissRes.ok === true, 'dismiss succeeds');
  const jeffNotifsAfter = await get('/api/notifications', jeff.token);
  ok(!jeffNotifsAfter.reinviteAsks.some(a => a.sessionId === s.id), 'the ask is gone from the list');
  const brianNotifs = await get('/api/notifications', brian.token);
  ok(!brianNotifs.invites.some(iv => iv.sessionId === s.id), 'brian was NOT re-invited -- dismiss really means not now');
}

console.log('\nguards: cannot ask twice while already invited/participating, non-creator cannot approve/dismiss someone else\'s ask, and an approve against a since-unconnected user is refused without silently re-inviting');
{
  const jeff = await reg('rjeff5');
  const brian = await reg('rbrian5');
  const rando = await reg('rrando5');
  await connect(jeff, brian);
  const s = await post('/api/sessions', { name: 'Cardio', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }], inviteUsernames: ['rbrian5'] }, jeff.token);

  const stillInvitedAsk = await post(`/api/sessions/${s.id}/reinvite-request`, {}, brian.token);
  ok(stillInvitedAsk.error === 'already part of this workout', `a still-invited (not yet declined) person can't file this (got ${JSON.stringify(stillInvitedAsk)})`);

  await post(`/api/sessions/${s.id}/decline`, {}, brian.token);
  await post(`/api/sessions/${s.id}/reinvite-request`, { message: 'let me back in' }, brian.token);
  const jeffNotifs = await get('/api/notifications', jeff.token);
  const ask = jeffNotifs.reinviteAsks.find(a => a.sessionId === s.id);

  const forbiddenApprove = await post(`/api/sessions/${s.id}/reinvite-request/${ask.reqId}/approve`, {}, rando.token);
  ok(forbiddenApprove.error === 'not your workout', `a random user cannot approve someone else's ask (got ${JSON.stringify(forbiddenApprove)})`);
  const forbiddenDismiss = await post(`/api/sessions/${s.id}/reinvite-request/${ask.reqId}/dismiss`, {}, rando.token);
  ok(forbiddenDismiss.error === 'not your workout', `and cannot dismiss it either (got ${JSON.stringify(forbiddenDismiss)})`);

  // Jeff and brian unfollow each other (connectionsOf unions followers+following in both
  // directions, so breaking the connection for real means undoing both sides).
  await post(`/api/unfollow/${brian.user.id}`, {}, jeff.token);
  await post(`/api/unfollow/${jeff.user.id}`, {}, brian.token);
  const staleApprove = await post(`/api/sessions/${s.id}/reinvite-request/${ask.reqId}/approve`, {}, jeff.token);
  ok(staleApprove.error === 'no longer connected', `approving a since-unconnected asker is refused, not silently allowed (got ${JSON.stringify(staleApprove)})`);
  const jeffNotifsAfter = await get('/api/notifications', jeff.token);
  ok(!jeffNotifsAfter.reinviteAsks.some(a => a.sessionId === s.id), 'the stale ask is still cleared from the list either way, not left stuck forever');
  const brianInvitedAfter = await get('/api/notifications', brian.token);
  ok(!brianInvitedAfter.invites.some(iv => iv.sessionId === s.id), 'and brian was genuinely NOT re-invited');
}

console.log('\na creator cannot be asked to re-invite the creator themselves, and a blocked pair cannot reach each other this way');
{
  const jeff = await reg('rjeff6');
  const brian = await reg('rbrian6');
  await connect(jeff, brian);
  const s = await post('/api/sessions', { name: 'Mobility', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Stretch' }] }, jeff.token);
  const selfAsk = await post(`/api/sessions/${s.id}/reinvite-request`, {}, jeff.token);
  ok(selfAsk.error === 'cannot re-invite yourself', `the creator asking about their own workout is rejected (got ${JSON.stringify(selfAsk)})`);

  const jeff2 = await reg('rjeff7');
  const brian2 = await reg('rbrian7');
  await connect(jeff2, brian2);
  const s2 = await post('/api/sessions', { name: 'Yoga', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Flow' }], inviteUsernames: ['rbrian7'] }, jeff2.token);
  await post(`/api/sessions/${s2.id}/decline`, {}, brian2.token);
  await post(`/api/block/${brian2.user.id}`, {}, jeff2.token);
  const blockedAsk = await post(`/api/sessions/${s2.id}/reinvite-request`, {}, brian2.token);
  ok(blockedAsk.error === 'not found', `a blocked decliner can't reach the creator this way either (got ${JSON.stringify(blockedAsk)})`);
}

ok(fails === 0, 'no unexpected errors along the way');
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
try { srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();
process.exit(fails ? 1 : 0);
