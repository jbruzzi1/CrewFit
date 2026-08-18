// What a person who should not be looking can actually get.
//
// Run:  npm test
//
// Every assertion here was, at one point, a 200. An independent audit of all 38 routes found the
// same root cause behind most of them: the app answered one question — "may you touch this
// workout at all?" — and then handed back the raw object with res.json(s), at eighteen separate
// places. There was no concept of WHICH FIELDS a given person may see.
//
// The cast:
//   alice   creates the workout
//   bob     trains in it, and his sets are the thing that must not leak
//   carol   a friend of alice's, in no workout — the "friend" tier
//   mallory a logged-in account related to nobody — the "stranger" tier
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.TEST_PORT6 || 4961;
const B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-exposure-'));
let fails = 0, srv = null, srvDead = true;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot() {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, PORT: String(PORT) },
      cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
    srvDead = false;
    let err = '', done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) finish({ started: true }); });
    srv.on('exit', () => { srvDead = true; finish({ started: false, err }); });
    setTimeout(() => finish({ started: false, err: err || 'timeout' }), 12000);
  });
}
const stop = () => new Promise(r => { if (!srv || srvDead) return r(); srv.on('exit', r); srv.kill(); });

async function user(name) {
  const username = name + Math.floor(Math.random() * 1e6);
  const r = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username, pin: 'pass1234', displayName: name }) }).then(x => x.json());
  return { id: r.user.id, username, name, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
const befriend = async (a, b) => {
  await fetch(B + '/api/friends/request', { method: 'POST', headers: a.H, body: JSON.stringify({ username: b.username }) });
  await fetch(B + '/api/friends/accept', { method: 'POST', headers: b.H, body: JSON.stringify({ from: a.id }) });
};
const get = (u, p) => fetch(B + p, { headers: u.H });
const post = (u, p, b) => fetch(B + p, { method: 'POST', headers: u.H, body: JSON.stringify(b || {}) });

// The four things that must never reach the wrong person, hunted anywhere in a response body.
const SECRET = {
  'Bob\'s logged weight': /\b487\b/,
  'the private chat': /rack three, meet me there/,
  'the "only me" post notes': /felt awful, do not tell anyone/,
  'the private photo URL': /post_[a-z0-9_]+\.(png|jpg)/,
};
function leaks(body) {
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return Object.entries(SECRET).filter(([, re]) => re.test(txt)).map(([k]) => k);
}

await boot();
try {

const alice = await user('Alice'), bob = await user('Bob'),
      carol = await user('Carol'), mallory = await user('Mallory');
await befriend(alice, bob);
await befriend(alice, carol);       // Carol is Alice's friend and nothing else

const s = await fetch(B + '/api/sessions', { method: 'POST', headers: alice.H,
  body: JSON.stringify({ name: 'Heavy Day', visibility: 'friends', scheduledAt: '2026-08-20T18:00:00Z',
    inviteUsernames: [bob.username],
    exercises: [{ name: 'Conventional Deadlift' }] }) }).then(x => x.json());
await post(bob, `/api/sessions/${s.id}/accept`);
await post(bob, `/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 487, reps: 3, set: 1 });
await post(alice, `/api/sessions/${s.id}/comments`, { text: 'rack three, meet me there' });
await post(alice, `/api/sessions/${s.id}/lock`);
await post(alice, `/api/sessions/${s.id}/post`, { notes: 'felt awful, do not tell anyone',
  visibility: 'only_me',
  media: [{ type: 'image', src: 'data:image/png;base64,' + 'A'.repeat(400) }] });

console.log('a logged-in stranger, related to nobody');
for (const [label, path] of [
  ['the workout itself',        `/api/sessions/${s.id}`],
  ['the chat',                  `/api/sessions/${s.id}/comments`],
  ['the home-screen list',      `/api/sessions`],
]) {
  const r = await get(mallory, path);
  const body = await r.text();
  const bad = leaks(body);
  ok(r.status === 403 || r.status === 404 || !bad.length,
     `${label}: ${r.status}${bad.length ? ' — LEAKS ' + bad.join(', ') : ' — nothing'}`);
}
{
  // the worst one: asking to join used to hand back the entire session
  const r = await post(mallory, `/api/sessions/${s.id}/join`, { note: 'let me in' });
  const body = await r.text();
  ok(r.status === 403, `asking to join is refused outright (got ${r.status})`);
  ok(!leaks(body).length, `and the reply carries nothing — ${leaks(body).join(', ') || 'clean'}`);
  const after = await get(mallory, `/api/sessions/${s.id}/comments`);
  ok(after.status === 403, `and the chat is still shut afterwards (got ${after.status})`);
}

console.log('\na friend of the creator, who is not in the workout');
{
  const r = await get(carol, `/api/sessions/${s.id}`);
  const body = await r.json();
  ok(r.status === 200, 'can see that the workout exists — it is friends-visible');
  ok(body.name === 'Heavy Day' && (body.exercises || []).length === 1, 'and what is in it');
  const bad = leaks(JSON.stringify(body));
  ok(!bad.length, `but nothing private — ${bad.length ? 'LEAKS ' + bad.join(', ') : 'clean'}`);
  ok(!Object.keys(body.logs || {}).length, "specifically not Bob's sets");
  ok(!(body.comments || []).length, 'and not the chat');

  const list = await get(carol, '/api/sessions').then(x => x.text());
  const lbad = leaks(list);
  ok(!lbad.length, `the home screen she loads on every open is clean — ${lbad.join(', ') || 'nothing'}`);

  const chat = await get(carol, `/api/sessions/${s.id}/comments`);
  ok(chat.status === 403, `and the chat refuses her (got ${chat.status})`);
}

console.log('\nsomeone holding an invitation they have not answered');
{
  const dave = await user('Dave');
  await befriend(alice, dave);
  const s2 = await fetch(B + '/api/sessions', { method: 'POST', headers: alice.H,
    body: JSON.stringify({ name: 'Push', visibility: 'friends', scheduledAt: '2026-08-21T18:00:00Z',
      inviteUsernames: [bob.username, dave.username],
      exercises: [{ name: 'Flat Barbell Bench Press' }] }) }).then(x => x.json());
  await post(bob, `/api/sessions/${s2.id}/accept`);
  await post(bob, `/api/sessions/${s2.id}/log`, { exerciseId: s2.exercises[0].id, weight: 487, reps: 3, set: 1 });
  await post(alice, `/api/sessions/${s2.id}/comments`, { text: 'rack three, meet me there' });

  const v = await get(dave, `/api/sessions/${s2.id}`).then(x => x.json());
  ok(!Object.keys(v.logs || {}).length, "he cannot read Bob's sets");
  ok(!/487/.test(JSON.stringify(v.logs || {})), 'nor the weight anywhere in them');
  // ...but the feature that decides the invitation still works, on counts alone
  const counts = v.logCounts || {};
  const total = Object.values(counts).reduce((n, per) => n + Object.values(per).reduce((a, b) => a + b, 0), 0);
  ok(total === 1, `he CAN see that someone has started — ${total} set(s), no weights (${JSON.stringify(counts)})`);
  ok((v.comments || []).length > 0, 'and he can read the chat, because deciding means being able to ask');
}

console.log('\nan "only me" post belongs to whoever wrote it');
{
  // Bob was IN the workout and still must not read Alice's private notes
  const v = await get(bob, `/api/sessions/${s.id}`).then(x => x.json());
  const bad = leaks(JSON.stringify(v.post || {}));
  ok(!bad.length, `even a participant does not get them — ${bad.length ? 'LEAKS ' + bad.join(', ') : 'hidden'}`);
  ok(v.post && v.post.hidden === true, 'he is told a post exists, not what it says');
  const mine = await get(alice, `/api/sessions/${s.id}`).then(x => x.json());
  ok(/do not tell anyone/.test(JSON.stringify(mine.post || {})), 'and Alice still reads her own');
}

console.log('\nthings that used to answer with a 500');
for (const [label, path] of [
  ['attendance', `/api/sessions/nope_1234/attendance`],
  ['log',        `/api/sessions/nope_1234/log`],
  ['lock',       `/api/sessions/nope_1234/lock`],
  ['leave',      `/api/sessions/nope_1234/leave`],
]) {
  const r = await post(mallory, path, {});
  ok(r.status === 404, `${label} on an id that does not exist: ${r.status}`);
}
{
  const r = await post(mallory, `/api/sessions/${s.id}/leave`);
  ok(r.status === 403, `and leaving a workout you were never in is refused (got ${r.status})`);
}

console.log('\nthe exercise library stops naming who owns what');
{
  await fetch(B + '/api/exercises/custom', { method: 'POST', headers: alice.H,
    body: JSON.stringify({ name: 'Alice Special Curl', muscle_groups: ['biceps'] }) });
  const lib = await fetch(B + '/api/exercises').then(x => x.text());
  ok(/Alice Special Curl/.test(lib), 'the exercise is still listed');
  ok(!new RegExp(alice.id).test(lib), "but not the id of the person who made it");
  ok(!/ownerId/.test(lib), 'and no ownerId field at all');
}

console.log('\na published workout reaches the people it was published for');
{
  // Session visibility defaults to 'private' and a post carries its OWN. Gating the published
  // record behind the session's meant a post shared publicly could not be opened by anyone, and
  // the one case that did open rendered as though no sets had been logged.
  const pub = await user('Pubby'), far = await user('Far');
  const ps = await fetch(B + '/api/sessions', { method: 'POST', headers: pub.H,
    body: JSON.stringify({ name: 'Shared Day', visibility: 'private', scheduledAt: '2026-08-22T18:00:00Z',
      exercises: [{ name: 'Front Squat' }] }) }).then(x => x.json());
  await post(pub, `/api/sessions/${ps.id}/log`, { exerciseId: ps.exercises[0].id, weight: 225, reps: 5, set: 1 });
  await post(pub, `/api/sessions/${ps.id}/lock`);
  await post(pub, `/api/sessions/${ps.id}/post`, { notes: 'good one', visibility: 'public', media: [] });

  const r = await get(far, `/api/sessions/${ps.id}`);
  ok(r.status === 200, `a stranger CAN open a public post (got ${r.status})`);
  const v = await r.json();
  ok(/good one/.test(JSON.stringify(v.post || {})), 'and read it');
  const shown = Object.values(v.logs || {}).flat();
  ok(shown.length === 1 && shown[0].weight === 225, `and see the sets that were published (${shown.length})`);
  ok(Object.keys(v.logs || {}).length === 1, 'the author\'s, and only the author\'s');

  // ...but an only_me post is still nobody else's business
  const priv = await fetch(B + '/api/sessions', { method: 'POST', headers: pub.H,
    body: JSON.stringify({ name: 'Quiet Day', visibility: 'private', scheduledAt: '2026-08-23T18:00:00Z',
      exercises: [{ name: 'Front Squat' }] }) }).then(x => x.json());
  await post(pub, `/api/sessions/${priv.id}/lock`);
  await post(pub, `/api/sessions/${priv.id}/post`, { notes: 'felt awful, do not tell anyone', visibility: 'only_me', media: [] });
  const denied = await get(far, `/api/sessions/${priv.id}`);
  ok(denied.status === 403, `and an "only me" post is still refused (got ${denied.status})`);
}

console.log('\na profile does not leak what the session route refuses');
{
  // profileOf kept its OWN copy of the post check, keyed on whose profile you were looking at
  // rather than who wrote the post — so a friend of a PARTICIPANT was handed the creator's
  // friends-only notes on a profile while the session route correctly refused them.
  const host = await user('Host'), guest = await user('Guest'), vic = await user('Vic');
  await befriend(host, guest);
  await befriend(guest, vic);                       // Vic knows the guest, not the host
  const hs = await fetch(B + '/api/sessions', { method: 'POST', headers: host.H,
    body: JSON.stringify({ name: 'Host Day', visibility: 'friends', scheduledAt: '2026-08-24T18:00:00Z',
      inviteUsernames: [guest.username], exercises: [{ name: 'Front Squat' }] }) }).then(x => x.json());
  await post(guest, `/api/sessions/${hs.id}/accept`);
  await post(guest, `/api/sessions/${hs.id}/log`, { exerciseId: hs.exercises[0].id, weight: 487, reps: 3, set: 1 });
  await post(host, `/api/sessions/${hs.id}/lock`);
  await post(host, `/api/sessions/${hs.id}/post`, { notes: 'felt awful, do not tell anyone', visibility: 'friends', media: [] });

  const direct = await get(vic, `/api/sessions/${hs.id}`);
  ok(direct.status === 403, `the session route refuses Vic (got ${direct.status})`);
  const prof = await get(vic, `/api/profile/${guest.id}`).then(x => x.text());
  ok(!/felt awful, do not tell anyone/.test(prof), "and the host's private write-up does not travel via the guest's profile");
  ok(!/post_[a-z0-9_]+\.(png|jpg)/.test(prof), 'nor any photo URL from it');
  // the guest's OWN best lift is the guest's to show their own friend — that is what a profile is
  ok(/487/.test(prof), "while the guest's own PR still shows to the guest's friend");

  const stranger = await user('Nobody');
  const thin = await get(stranger, `/api/profile/${guest.id}`).then(x => x.json());
  ok(thin.limited === true && !(thin.prs || []).length && !(thin.recentActivity || []).length,
     'and a logged-in stranger gets the headline counts, not the whole training record');
}

console.log('\none bad custom exercise cannot break the library for everyone');
{
  const r = await fetch(B + '/api/exercises/custom', { method: 'POST', headers: mallory.H,
    body: JSON.stringify({ name: 'Odd Lift', muscle_groups: ['biceps'], equipment: [{ nope: 1 }, 'barbell', 42] }) });
  ok(r.status < 400, `it is accepted (got ${r.status})`);
  const lib = await fetch(B + '/api/exercises').then(x => x.json());
  const mine = lib.find(e => e.name === 'Odd Lift');
  ok(mine && mine.equipment.every(x => typeof x === 'string'),
     `but every equipment entry is a string — the client lowercases these (${JSON.stringify(mine && mine.equipment)})`);

  // The reading half of this rule is asserted in test/client-hostile.mjs, which loads the real
  // public/app.js and calls the real render functions against this kind of row. Source-text checks
  // were tried here first and reviews defeated every version of them, so the client half is tested
  // by execution instead. (The jsq checks further down this file are the remaining source checks;
  // they assert which escaper a handler uses, which is a fact about the text.)
}

console.log('\nthe library is a shared surface, so it is treated as hostile input');
{
  // A custom exercise renders in EVERY user's Workouts tab, so its fields are attacker-controlled
  // input to everyone else's browser. Both halves are asserted: refused on the way in, escaped on
  // the way out.
  const r = await fetch(B + '/api/exercises/custom', { method: 'POST', headers: mallory.H,
    body: JSON.stringify({ name: 'Evil Curl', muscle_groups: ['biceps', '<img src=x onerror=alert(1)>'] }) });
  ok(r.status < 400, `an exercise with a junk muscle group is still accepted (got ${r.status})`);
  const lib = await fetch(B + '/api/exercises').then(x => x.text());
  ok(!/<img src=x/.test(lib), 'but the junk group is dropped, not stored');

  const bad = await fetch(B + '/api/exercises/custom', { method: 'POST', headers: mallory.H,
    body: JSON.stringify({ name: 'Nope', muscle_groups: ['<script>alert(1)</script>'] }) });
  ok(bad.status === 400, `an exercise with ONLY junk groups is refused outright (got ${bad.status})`);
}

console.log('\na name with an apostrophe survives a handler, and a payload does not');
{
  // The same function guards both: escape for JavaScript first, then for HTML, so the parser
  // hands the JS engine a backslashed quote instead of a string terminator.
  const app = (await import('node:fs')).readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  ok(/function jsq\(/.test(app), 'there is a dedicated escaper for JS-inside-an-attribute');
  for (const sink of ['swapPick', 'libToggle', 'exDetail', 'setTrendPick']) {
    const re = new RegExp(`onclick="${sink}\\('\\$\\{jsq\\(`);
    ok(re.test(app), `${sink} uses it`);
  }
  ok(!/\$\{esc\(e\.name\)\}'\)/.test(app), 'and no handler still passes a name through esc() alone');
}

console.log('\nids are not guessable');
{
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const x = await fetch(B + '/api/sessions', { method: 'POST', headers: alice.H,
      body: JSON.stringify({ name: 'x', visibility: 'private', scheduledAt: '2026-08-20T18:00:00Z',
        exercises: [{ name: 'Cable Fly' }] }) }).then(r => r.json());
    ids.push(x.id.replace(/^s_/, ''));
  }
  ok(new Set(ids).size === ids.length, `${ids.length} ids, all distinct`);
  ok(ids.every(i => i.length === 8), 'all the same length');
  // Math.random() ids came out of a PRNG whose state is recoverable from observed output. This is
  // a smoke test, not a proof: what it can catch is a sequence or a shared prefix.
  ok(new Set(ids.map(i => i.slice(0, 3))).size > ids.length / 2, `and not clustered (${ids.slice(0,4).join(', ')})`);
}

console.log('\nrows stored before the write checks existed are cleaned on the way out');
{
  // The POST route validates new rows, but nothing migrates old ones — so the read path is the only
  // place that can protect against what is already in the database. These write straight into the
  // store, which is exactly what a pre-v177 POST left behind.
  const DATA = join(DIR, 'data.json');
  await stop();                      // the row has to be in the file before the server reads it
  const raw = JSON.parse(readFileSync(DATA, 'utf8'));
  const owner = Object.keys(raw.users)[0];
  raw.customExercises[owner] = [
    { name: 'Legacy Junk', muscle_groups: ['x" onerror="alert(1)" z="', 'biceps'], equipment: 42,
      level: { a: 1 }, pattern: [], is_compound: 'yes' },
    { name: 99, muscle_groups: 'biceps', equipment: [{}, 'cable', 7] },
  ];
  writeFileSync(DATA, JSON.stringify(raw));
  const up = await boot();
  ok(up.started, `the server boots with those rows in the database${up.started ? '' : ' — ' + String(up.err).slice(0, 160)}`);

  const r = await fetch(B + '/api/exercises');
  ok(r.status === 200, `the library still loads at all (got ${r.status}) — a non-array equipment used to 500 this route for everyone`);
  const lib = r.status === 200 ? await r.json() : [];
  const a = lib.find(e => e.name === 'Legacy Junk'), b = lib.find(e => e.name === '99');
  ok(!!a && !!b, 'both legacy rows are still returned, not silently dropped');
  ok(a && !a.muscle_groups.some(m => /onerror/.test(m)),
     `the payload group is gone at the source, not just at the sink (${JSON.stringify(a && a.muscle_groups)})`);
  ok(a && Array.isArray(a.equipment) && !a.equipment.length, `a non-array equipment becomes an empty list (${JSON.stringify(a && a.equipment)})`);
  ok(b && Array.isArray(b.muscle_groups), `a string muscle_groups becomes an array — the client .forEach's this (${JSON.stringify(b && b.muscle_groups)})`);
  ok(b && typeof b.name === 'string', `a numeric name becomes a string (${JSON.stringify(b && b.name)})`);
  ok(a && typeof a.level === 'string' && typeof a.pattern === 'string',
     `level and pattern are strings (${JSON.stringify([a && a.level, a && a.pattern])})`);
  ok(b && b.equipment.every(x => typeof x === 'string') && b.equipment.length === 1,
     `and the one real equipment entry in a poisoned list survives (${JSON.stringify(b && b.equipment)})`);
}

console.log('\na session row missing its containers cannot 500 a whole workout for everyone in it');
{
  // This app has a documented history of hand-editing data.json to fix real accounts
  // (migrateMergeDuplicateBrian, the PIN-reset instructions in DEPLOY.md), and nothing checks that
  // a hand-edited or pre-schema row still has every key a modern session assumes (logs, exercises,
  // attendance, comments, suggestedEdits, variations, joinRequests, history). Write it straight
  // into the store, which is what such a row looks like, then hit every write route against it.
  //
  // Two shapes, not one: a MISSING key (the obvious mistake) and a WRONG-TYPED one (the plausible
  // one — every other container in this schema really is [], so logs/attendance/variations as []
  // instead of {} is an easy hand-edit slip). A review caught that the missing-key guard alone
  // let the wrong-typed case through: logs as [] doesn't throw, it silently drops the set instead
  // — `s.logs[userId]=[...]` sets a non-index property on an array, which JSON.stringify never
  // serializes. That is worse than the crash it replaced, so it is asserted here explicitly.
  const DATA = join(DIR, 'data.json');
  await stop();
  const raw = JSON.parse(readFileSync(DATA, 'utf8'));
  raw.sessions['s_legacy2'] = { id: 's_legacy2', creatorId: alice.id, scheduledAt: new Date().toISOString(),
    status: 'draft', visibility: 'private', name: 'Legacy Row', participants: [alice.id, bob.id], invited: [] };
  raw.sessions['s_legacy3'] = { id: 's_legacy3', creatorId: alice.id, scheduledAt: new Date().toISOString(),
    status: 'draft', visibility: 'private', name: 'Wrong-Typed Row', participants: [alice.id, bob.id],
    invited: [], logs: [], attendance: [], variations: [] };
  // participants is present and well-formed on both rows above, which never exercises that half of
  // the guard — a review caught that gap. This third row omits it entirely: the comments route's
  // notify loop (`for (const pid of s.participants)`) is the one place that would throw on it, AFTER
  // the comment is already saved, so the failure mode is a 500 the caller sees despite the write
  // having actually succeeded — worth its own row rather than folding into the others.
  raw.sessions['s_legacy4'] = { id: 's_legacy4', creatorId: alice.id, scheduledAt: new Date().toISOString(),
    status: 'draft', visibility: 'private', name: 'No Participants Row', invited: [] };
  writeFileSync(DATA, JSON.stringify(raw));
  const up = await boot();
  ok(up.started, `the server boots with a legacy row missing logs/exercises/etc${up.started ? '' : ' — ' + String(up.err).slice(0, 160)}`);

  const checks = [
    ['attendance', () => fetch(B + '/api/sessions/s_legacy2/attendance', { method: 'POST', headers: bob.H, body: JSON.stringify({ status: 'in' }) })],
    ['a suggested swap', () => fetch(B + '/api/sessions/s_legacy2/suggest', { method: 'POST', headers: bob.H, body: JSON.stringify({ exerciseId: 'e1', swapTo: 'Cable Fly' }) })],
    ['a logged set', () => fetch(B + '/api/sessions/s_legacy2/log', { method: 'POST', headers: bob.H, body: JSON.stringify({ exerciseId: 'e1', weight: 100, reps: 8 }) })],
    ['locking (creator)', () => fetch(B + '/api/sessions/s_legacy2/lock', { method: 'POST', headers: alice.H, body: '{}' })],
  ];
  for (const [label, fn] of checks) {
    const r = await fn();
    ok(r.status !== 500, `${label} does not 500 (got ${r.status})`);
  }

  // The comments route has always had its own inline `if (!s.comments) s.comments = [];` guard, so
  // asserting "does not 500" here would pass with or without ensureSessionShape — not a real check
  // of this fix. What ensureSessionShape adds on top is participants, needed two lines later by the
  // notify loop (`for (const pid of s.participants)`) — assert THAT specifically.
  const cr = await fetch(B + '/api/sessions/s_legacy2/comments', { method: 'POST', headers: bob.H, body: JSON.stringify({ text: 'hey' }) });
  ok(cr.status !== 500, `a comment does not 500 (got ${cr.status})`);

  // s_legacy4 has no participants at all. Its creator is the only account allowed to comment on it
  // (sessionTier requires membership), so post as alice.
  const cr2 = await fetch(B + '/api/sessions/s_legacy4/comments', { method: 'POST', headers: alice.H, body: JSON.stringify({ text: 'hey' }) });
  ok(cr2.status !== 500, `a comment on a row with NO participants key does not 500 (got ${cr2.status})`);

  // The array-mistyped row: does not merely avoid a 500, the set has to actually be THERE after.
  const lg = await fetch(B + '/api/sessions/s_legacy3/log', { method: 'POST', headers: bob.H, body: JSON.stringify({ exerciseId: 'e1', weight: 100, reps: 8 }) });
  ok(lg.status !== 500, `logging against a row with logs:[] (wrong-typed, not missing) does not 500 (got ${lg.status})`);
  const after = JSON.parse(readFileSync(DATA, 'utf8'));
  const stored = after.sessions['s_legacy3'];
  ok(!Array.isArray(stored.logs) && stored.logs[bob.id] && stored.logs[bob.id].length === 1,
     `and the set actually survives on disk, not silently dropped by an array standing in for {} (${JSON.stringify(stored.logs)})`);
}

} finally { await stop(); rmSync(DIR, { recursive: true, force: true }); }

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
