// Input caps: a single write must not be able to stuff an unbounded blob into data.json (the whole
// file is re-serialised on every save, on a 256 MB box — so an uncapped field is how a handful of
// requests wedge every write for everyone), and a logged number must stay finite and sane (Infinity
// serialises to null and became a permanent all-time PR). Everything is asserted against what
// actually LANDS IN data.json, since that file is the resource being protected.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4998, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'limits-'));
const DATA = join(DIR, 'data.json');
const J = { 'Content-Type': 'application/json' };
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const put  = (p, b, t) => fetch(B + p, { method: 'PUT', headers: H(t), body: JSON.stringify(b) });
const db = () => JSON.parse(readFileSync(DATA, 'utf8'));
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

await new Promise(res => {
  srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, PORT: String(PORT) }, cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
  setTimeout(res, 8000);
});

const alice = await post('/api/register', { username: 'alice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());
const bob   = await post('/api/register', { username: 'bob',   pin: 'pass1234', displayName: 'Bob' }).then(r => r.json());
await post('/api/friends/request', { username: 'bob' }, alice.token);
await post('/api/friends/accept', { from: alice.user.id }, bob.token);
const sess = await post('/api/sessions', { name: 'Legs', visibility: 'friends', scheduledAt: '2026-08-20T18:00:00Z', exercises: [{ name: 'Barbell Back Squat' }] }, alice.token).then(r => r.json());
const exId = sess.exercises[0].id;

console.log('\npush/subscribe cannot store an unbounded blob');
{
  const blob = 'x'.repeat(900 * 1024);                 // ~0.9 MB: under the 1mb body cap, so it reaches the route
  const r = await post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/1', junk: blob } }, alice.token);
  // endpoint is valid, but the junk field must not ride along into storage (route-level strip)
  const stored = db().pushSubs[alice.user.id];
  ok(JSON.stringify(stored).length < 4096, `a large junk field is stripped by the route (stored ${JSON.stringify(stored).length} bytes)`);
  ok(stored && stored.endpoint === 'https://push.example/1' && !('junk' in stored), 'only endpoint/keys/expirationTime are kept');

  const r2 = await post('/api/push/subscribe', { subscription: 'not-an-object' }, bob.token);
  ok(r2.status === 400, `a non-object subscription is refused (got ${r2.status})`);
  ok(!(bob.user.id in db().pushSubs), 'and nothing is stored for it');

  const r3 = await post('/api/push/subscribe', { subscription: { endpoint: 'x'.repeat(5000), keys: {} } }, bob.token);
  ok(r3.status === 400, `an over-long endpoint is refused (got ${r3.status})`);

  const good = await post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/bob', expirationTime: null, keys: { p256dh: 'abc', auth: 'def' } } }, bob.token);
  ok(good.status === 200 && db().pushSubs[bob.user.id].endpoint === 'https://push.example/bob', 'a real subscription is accepted and stored');
}

console.log('\nstored strings are length-capped');
{
  const huge = 'z'.repeat(100000);
  await post(`/api/sessions/${sess.id}/comments`, { text: huge }, alice.token);
  const c = db().sessions[sess.id].comments.slice(-1)[0];
  ok(c && c.text.length === 2000, `a 100k-char comment is capped at 2000 (stored ${c && c.text.length})`);

  const n = await post(`/api/sessions/${sess.id}/comments`, { text: 12345 }, alice.token);
  ok(n.status !== 500, `a non-string comment does not 500 (got ${n.status})`);
  ok(db().sessions[sess.id].comments.slice(-1)[0].text === '12345', 'it is coerced to a string');

  await post(`/api/sessions/${sess.id}/suggest`, { exerciseId: 'x'.repeat(100000), swapTo: 'z'.repeat(100000) }, alice.token);
  const e = db().sessions[sess.id].suggestedEdits.slice(-1)[0];
  ok(e && e.swapTo.length === 80, `a 100k-char swapTo is capped at 80 (stored ${e && e.swapTo.length})`);
  ok(e && e.exerciseId.length === 64, `a 100k-char exerciseId is capped at 64 (stored ${e && e.exerciseId.length})`);

  await post(`/api/sessions/${sess.id}/join`, { note: 'y'.repeat(100000) }, bob.token);
  const jr = db().sessions[sess.id].joinRequests.slice(-1)[0];
  ok(jr && jr.note.length === 500, `a 100k-char join note is capped at 500 (stored ${jr && jr.note.length})`);
}

console.log('\nlogged numbers stay finite and non-negative');
{
  // The real Infinity path: a client sending the RAW JSON text {"weight":1e400} (not JSON.stringify,
  // which emits null) makes JSON.parse produce Infinity, which then serialises back to null — a null
  // all-time PR. Send the raw body to exercise it. JSON.stringify's numbers can only test the floor
  // and the magnitude cap, so cover those with -500 and 1e300 (both survive the wire intact).
  const rawPost = (p, body, t) => fetch(B + p, { method: 'POST', headers: H(t), body });
  const rawPut  = (p, body, t) => fetch(B + p, { method: 'PUT',  headers: H(t), body });

  await rawPost(`/api/sessions/${sess.id}/log`, `{"exerciseId":"${exId}","weight":1e400,"reps":5}`, alice.token);
  let sets = db().sessions[sess.id].logs[alice.user.id];
  ok(Number.isFinite(sets.slice(-1)[0].weight), `weight 1e400 sent over the wire is stored finite, not null (${sets.slice(-1)[0].weight})`);

  await post(`/api/sessions/${sess.id}/log`, { exerciseId: exId, weight: -500, reps: 5 }, alice.token);
  sets = db().sessions[sess.id].logs[alice.user.id];
  ok(sets.slice(-1)[0].weight >= 0, `negative weight is clamped to >= 0 (${sets.slice(-1)[0].weight})`);

  await post(`/api/sessions/${sess.id}/log`, { exerciseId: exId, weight: 1e300, reps: 5 }, alice.token);
  sets = db().sessions[sess.id].logs[alice.user.id];
  ok(sets.slice(-1)[0].weight <= 1e6, `an absurd finite weight is capped at 1e6 (${sets.slice(-1)[0].weight})`);

  // the edit route (PUT) carries the same clamp — both the floor and the Infinity path
  const logId = sets.slice(-1)[0].id;
  await put(`/api/sessions/${sess.id}/log/${logId}`, { weight: -999 }, alice.token);
  let edited = db().sessions[sess.id].logs[alice.user.id].find(l => l.id === logId);
  ok(edited.weight >= 0, `editing a set to a negative weight clamps to >= 0 (${edited.weight})`);
  await rawPut(`/api/sessions/${sess.id}/log/${logId}`, `{"weight":1e400}`, alice.token);
  edited = db().sessions[sess.id].logs[alice.user.id].find(l => l.id === logId);
  ok(Number.isFinite(edited.weight), `editing a set to Infinity over the wire stays finite (${edited.weight})`);
}

console.log('\nevery other user-controlled field is bounded too (not just the routes the audit named)');
{
  const huge = 'q'.repeat(100000);

  const dave = await post('/api/register', { username: 'dave', pin: 'pass1234', displayName: huge }).then(r => r.json());
  ok(db().users[dave.user.id].displayName.length <= 80, `register displayName is capped (stored ${db().users[dave.user.id].displayName.length})`);

  const big = await post('/api/sessions', { name: huge, location: huge, creatorNote: huge, scheduledAt: huge,
    visibility: 'private', exercises: [{ name: huge }] }, alice.token).then(r => r.json());
  const bs = db().sessions[big.id];
  ok(bs.name.length <= 80, `session name capped (${bs.name.length})`);
  ok(bs.location.length <= 120, `session location capped (${bs.location.length})`);
  ok(bs.creatorNote.length <= 2000, `session creatorNote capped (${bs.creatorNote.length})`);
  ok(bs.scheduledAt.length <= 40, `session scheduledAt capped (${bs.scheduledAt.length})`);
  ok(bs.exercises[0].name.length <= 80, `session exercise name capped (${bs.exercises[0].name.length})`);

  // creatorNote sent as an OBJECT must not persist a raw nested blob — bounded string only
  const obj = await post('/api/sessions', { name: 'x', creatorNote: { nested: huge }, scheduledAt: '2026-08-20T18:00:00Z',
    visibility: 'private', exercises: [{ name: 'Squat' }] }, alice.token).then(r => r.json());
  ok(typeof db().sessions[obj.id].creatorNote === 'string' && db().sessions[obj.id].creatorNote.length <= 2000,
     'an object creatorNote is coerced to a bounded string, not stored raw');

  const tpl = await post('/api/templates', { name: huge, exercises: [{ name: 'Squat' }] }, alice.token).then(r => r.json());
  ok(db().templates[tpl.id].name.length <= 80, `template create name capped (${db().templates[tpl.id].name.length})`);
  await put(`/api/templates/${tpl.id}`, { name: huge }, alice.token);
  ok(db().templates[tpl.id].name.length <= 80, `template edit (PUT) name capped too (${db().templates[tpl.id].name.length})`);

  // the POST log `set` number has the same Infinity->null path as weight, sent over the wire
  await fetch(B + `/api/sessions/${sess.id}/log`, { method: 'POST', headers: H(alice.token),
    body: `{"exerciseId":"${exId}","weight":100,"reps":5,"set":1e400}` });
  const last = db().sessions[sess.id].logs[alice.user.id].slice(-1)[0];
  ok(Number.isFinite(last.set), `a set number of 1e400 stays finite, not null (${last.set})`);
}

console.log('\nthe three vectors a second review caught are closed too');
{
  const huge = 'q'.repeat(100000);

  // attendance status
  await post(`/api/sessions/${sess.id}/attendance`, { status: huge }, alice.token);
  ok(db().sessions[sess.id].attendance[alice.user.id].length <= 20, `attendance status is capped (${db().sessions[sess.id].attendance[alice.user.id].length})`);

  // custom exercise pattern/level fields (stored raw before), and category from a validated group
  await post('/api/exercises/custom', { name: 'Capped', muscle_groups: ['chest'], pattern: huge, level: huge, category: huge }, alice.token);
  const cx = Object.values(db().customExercises).flat().find(e => e.name === 'Capped');
  ok(cx && cx.pattern.length <= 40, `custom exercise pattern capped (${cx && cx.pattern.length})`);
  ok(cx && cx.level.length <= 20, `custom exercise level capped (${cx && cx.level.length})`);
  ok(cx && cx.category === 'chest', `category comes from the validated group, not raw input (${cx && cx.category})`);

  // media src: only disk paths and allowed image/video data URLs — no raw blobs, no off-site URLs
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
        octet = 'data:application/octet-stream;base64,' + 'A'.repeat(4 * 1024 * 1024),
        offsite = 'https://evil.example/track.gif';
  const okImg = await post(`/api/sessions/${sess.id}/post`, { visibility: 'friends', media: [{ type: 'image', src: png }] }, alice.token);
  ok(okImg.status === 200 && /^\/uploads\//.test(db().sessions[sess.id].post.media[0].src), 'a real image is accepted and written to disk (src becomes /uploads/…)');
  const badMime = await post(`/api/sessions/${sess.id}/post`, { visibility: 'friends', media: [{ type: 'image', src: octet }] }, alice.token);
  ok(badMime.status === 415, `an application/octet-stream blob is refused, not stored raw (got ${badMime.status})`);
  const offRes = await post(`/api/sessions/${sess.id}/post`, { visibility: 'friends', media: [{ type: 'image', src: offsite }] }, alice.token);
  ok(offRes.status === 415, `an off-site media URL is refused (got ${offRes.status})`);

  // custom-exercise per-user COUNT cap (the accumulating wedge)
  const cap = await post('/api/register', { username: 'ecap', pin: 'pass1234', displayName: 'E' }).then(r => r.json());
  let last;
  for (let i = 0; i < 501; i++) last = await post('/api/exercises/custom', { name: 'X' + i, muscle_groups: ['chest'] }, cap.token);
  ok(last.status === 400, `the 501st custom exercise from one account is refused (got ${last.status})`);
}

console.log('\nthe request-body size cap is small everywhere except the media routes');
{
  const twoMB = 'z'.repeat(2 * 1024 * 1024);
  // a 2 MB body to a normal route is refused by the 1mb global parser (413), before any handler
  const reg = await fetch(B + '/api/register', { method: 'POST', headers: J, body: JSON.stringify({ username: 'x', pin: 'pass1234', displayName: twoMB }) });
  ok(reg.status === 413, `a 2 MB body to /api/register is rejected by the body cap (got ${reg.status})`);
  // the same size to the avatar route (which legitimately carries images) is NOT rejected by the parser
  const av = await fetch(B + '/api/me/avatar', { method: 'POST', headers: H(alice.token), body: JSON.stringify({ data: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024), type: 'image/png' }) });
  ok(av.status !== 413 && av.status !== 400, `a 2 MB image to /api/me/avatar is accepted by the large parser (got ${av.status})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
