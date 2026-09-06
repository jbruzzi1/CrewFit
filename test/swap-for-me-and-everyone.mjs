// Sep 6, 2026 (Jeff: "if brian suggests a swap and I approve it - that swaps the exercise for us
// both, correct?" -- it didn't: the screen said so, the data only swapped it for Brian, and the
// host's own sets on that card were filed under the old lift). Two flows now:
//   - POST /variation: "swap for just me" -- instant, no approval, only my card (s.variations[ex][me])
//   - POST /suggest + approve: "propose for everyone" -- the host approves, the exercise itself is
//     renamed for the whole workout, everyone in it is notified at proposal and at decision
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = 4997, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'swapme-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('swapme');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const srv = await new Promise((res, rej) => {
  const p = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(p); });
  setTimeout(() => rej(new Error('no boot')), 15000);
});
const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + tok }, body: JSON.stringify(b || {}) });
const get = (p, tok) => fetch(B + p, { headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());
const reg = async n => { const r = await post('/api/register', { username: n, pin: 'pass1234', displayName: n }).then(x => x.json()); return { id: r.user.id, token: r.token }; };
const follow = (a, b) => post('/api/follow/' + b.id, {}, a.token);
const notifs = async u => (await get('/api/notifications', u.token));
const bodies = n => JSON.stringify((n.history || []).map(x => x.body));

try {
  const host = await reg('swaphost'), brian = await reg('swapbrian'), sam = await reg('swapsam');
  await follow(host, brian); await follow(host, sam);
  const s = await post('/api/sessions', { name: 'Pull', visibility: 'private', scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Barbell Row', defaultReps: 8 }], inviteUsernames: ['swapbrian', 'swapsam'] }, host.token).then(x => x.json());
  await post(`/api/sessions/${s.id}/accept`, {}, brian.token);
  await post(`/api/sessions/${s.id}/accept`, {}, sam.token);
  const exId = s.exercises[0].id;

  console.log('"swap for just me": instant, only my card, my sets follow it');
  {
    await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 100, reps: 8 }, sam.token);   // logged BEFORE the swap
    const r = await post(`/api/sessions/${s.id}/variation`, { exerciseId: exId, swapTo: 'Seated Cable Row' }, sam.token).then(x => x.json());
    ok(!r.error, `a participant can swap for themselves without approval (got ${r.error})`);
    ok(r.exercises[0].name === 'Barbell Row', `the shared exercise is untouched for everyone else (got ${r.exercises[0].name})`);
    ok(r.variations[exId] && r.variations[exId][sam.id] && r.variations[exId][sam.id].swapTo === 'Seated Cable Row', 'sam\'s own card is now Seated Cable Row');
    ok(r.logs[sam.id][0].exerciseName === 'Seated Cable Row', `sam's already-logged set is refiled under the lift he actually did (got ${r.logs[sam.id][0].exerciseName})`);
    const hostView = await get(`/api/sessions/${s.id}`, host.token);
    ok(hostView.exercises[0].name === 'Barbell Row' && !(hostView.variations[exId] || {})[host.id], 'the host still sees Barbell Row on their own card');
    const nHost = await notifs(host);
    ok(!bodies(nHost).includes('Seated Cable Row'), 'a personal swap does not notify anyone -- it changes nothing for them');
    const undo = await post(`/api/sessions/${s.id}/variation`, { exerciseId: exId, swapTo: '' }, sam.token).then(x => x.json());
    ok(!(undo.variations[exId] || {})[sam.id], 'blank swapTo undoes the personal swap');
    ok(undo.logs[sam.id][0].exerciseName === 'Barbell Row', `...and his set goes back with it (got ${undo.logs[sam.id][0].exerciseName})`);
  }

  console.log('\n"swap for just me" is for people in the workout, not onlookers');
  {
    const stranger = await reg('swapstranger');
    const r = await post(`/api/sessions/${s.id}/variation`, { exerciseId: exId, swapTo: 'Cable Fly' }, stranger.token);
    ok(r.status === 403, `a non-participant is refused (got ${r.status})`);
    const bad = await post(`/api/sessions/${s.id}/variation`, { exerciseId: 'nope', swapTo: 'Cable Fly' }, sam.token);
    ok(bad.status === 404, `an unknown exercise id is refused (got ${bad.status})`);
  }

  console.log('\n"propose for everyone": everyone in the workout is told, the host decides, the exercise changes for all');
  {
    await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 135, reps: 8 }, host.token);    // host did Barbell Row for real
    const r = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: exId, swapTo: 'Seated Cable Row' }, brian.token).then(x => x.json());
    const edit = r.suggestedEdits.find(e => e.proposedBy === brian.id && e.status === 'pending');
    ok(!!edit, 'the proposal is filed as pending');
    ok(r.exercises[0].name === 'Barbell Row', 'nothing changes until the host decides');
    const nHost = await notifs(host), nSam = await notifs(sam), nBrian = await notifs(brian);
    ok(bodies(nHost).includes('Your call'), `the host is told and asked to decide (got ${bodies(nHost)})`);
    ok(/decides/.test(bodies(nSam)) && bodies(nSam).includes('Barbell Row → Seated Cable Row'), `every other participant is told who decides (got ${bodies(nSam)})`);
    ok(!bodies(nBrian).includes('wants to swap'), 'the proposer is not notified about their own proposal');

    const denied = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, sam.token);
    ok(denied.status === 403, `only the host can approve (got ${denied.status})`);

    const approved = await post(`/api/sessions/${s.id}/suggest/${edit.id}/approve`, {}, host.token).then(x => x.json());
    ok(approved.exercises[0].name === 'Seated Cable Row', `approving renames the exercise itself, for everyone (got ${approved.exercises[0].name})`);
    ok(approved.exercises[0].id === exId, 'same exercise id -- cards, logs and history keep pointing at it');
    ok(!(approved.variations[exId] || {})[brian.id], 'no leftover personal variation for the proposer (the shared change covers it)');
    ok(approved.logs[host.id][0].exerciseName === 'Barbell Row', `the host's sets logged BEFORE approving stay filed as what they actually did (got ${approved.logs[host.id][0].exerciseName})`);
    const samView = await get(`/api/sessions/${s.id}`, sam.token);
    ok(samView.exercises[0].name === 'Seated Cable Row', 'sam sees the new exercise too');
    // from here on, everyone's sets file under the new name
    const hostAfter = await post(`/api/sessions/${s.id}/log`, { exerciseId: exId, weight: 140, reps: 8 }, host.token).then(x => x.json());
    ok(hostAfter.logs[host.id][1].exerciseName === 'Seated Cable Row', `a set the host logs AFTER approving files under the new lift (got ${hostAfter.logs[host.id][1].exerciseName})`);
    const nSam2 = await notifs(sam), nBrian2 = await notifs(brian);
    ok(bodies(nSam2).includes("approved swapbrian's swap"), `the rest of the workout hears the decision (got ${bodies(nSam2)})`);
    ok(bodies(nBrian2).includes('approved your swap'), 'the proposer hears it was approved');
  }

  console.log('\ncold-review catches: a blank proposal is refused (it would blank the exercise for everyone); an invitee who proposed is told of the approval');
  {
    const blank = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: exId, swapTo: '   ' }, brian.token);
    ok(blank.status === 400, `a blank swap proposal is refused up front (got ${blank.status})`);
    const badEx = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: 'nope', swapTo: 'Cable Fly' }, brian.token);
    ok(badEx.status === 404, `a proposal against an unknown exercise is refused (got ${badEx.status})`);
    const dee = await reg('swapdee'); await follow(host, dee);
    const s2 = await post('/api/sessions', { name: 'Push', visibility: 'private', scheduledAt: new Date().toISOString(),
      exercises: [{ name: 'Bench Press', defaultReps: 8 }], inviteUsernames: ['swapdee'] }, host.token).then(x => x.json());
    // dee has NOT accepted -- still just invited -- and proposes from there
    const prop = await post(`/api/sessions/${s2.id}/suggest`, { exerciseId: s2.exercises[0].id, swapTo: 'Dumbbell Bench Press' }, dee.token).then(x => x.json());
    ok(!prop.error, `a still-invited person can propose (got ${prop.error})`);
    const ed = prop.suggestedEdits[0];
    await post(`/api/sessions/${s2.id}/suggest/${ed.id}/approve`, {}, host.token);
    const nDee = await notifs(dee);
    ok(bodies(nDee).includes('approved your swap'), `the invitee who proposed hears it was approved, even though they are not a participant yet (got ${bodies(nDee)})`);
  }

  console.log('\nrejecting tells the proposer, and points them at "just me"');
  {
    const r = await post(`/api/sessions/${s.id}/suggest`, { exerciseId: exId, swapTo: 'Chest-Supported Row' }, brian.token).then(x => x.json());
    const edit = r.suggestedEdits.find(e => e.swapTo === 'Chest-Supported Row');
    await post(`/api/sessions/${s.id}/suggest/${edit.id}/reject`, {}, host.token);
    const after = await get(`/api/sessions/${s.id}`, host.token);
    ok(after.exercises[0].name === 'Seated Cable Row', 'a rejected proposal changes nothing');
    const nBrian = await notifs(brian);
    ok(bodies(nBrian).includes('kept Seated Cable Row') && bodies(nBrian).includes('just you'), `the proposer is told, with the "just me" door mentioned (got ${bodies(nBrian)})`);
  }
} finally {
  try { srv.kill(); } catch {}
  rmSync(DIR, { recursive: true, force: true });
  await testDb.drop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
