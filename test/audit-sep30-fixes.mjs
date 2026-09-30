// Sep 30 2026 -- permanent coverage for the objective (non-wording) fixes built this round, per
// Jeff's "do all of the above fixes" go-ahead on the full 24-item audit. CLAUDE.md hard rule #6:
// every assertion here exists because something was actually broken, or because a brand-new route
// had zero coverage. Wording/label-only changes (unified "account" copy, the friendlier login
// error, "Edit session" everywhere, the username-change note, the visibility-toggle confirm, the
// de-duped Log out) are UI-only and covered by the screenshot verification pass instead -- nothing
// server-testable changed for those.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_SEP30 || 4979;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('sep30fixes');
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot(dir) {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${err}`)));
    setTimeout(() => rej(new Error('server never started:\n' + err)), 15000);
  });
}
const DIR = mkdtempSync(join(tmpdir(), 'sep30fixes-'));
await boot(DIR);

async function api(path, method, token, body) {
  const r = await fetch(B + path, { method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const post = (p, b, tok) => api(p, 'POST', tok, b).then(r => r.body);
const reg = (u) => post('/api/register', { username: u, pin: 'pass1234', displayName: u });

console.log('Tier 2 #1 (Jeff: "if they are blocked they shouldn\'t show at all -- similar to how instagram is"): GET /api/users/search excludes blocked accounts, both directions');
{
  const alice = await reg('sep30alice');
  const bob = await reg('sep30bobblocked');
  const found = await api('/api/users/search?q=sep30bobblocked', 'GET', alice.token).then(r => r.body);
  ok(found.some(u => u.id === bob.user.id), 'setup: bob is findable before any block exists');

  await post('/api/block/' + bob.user.id, {}, alice.token);
  const afterAliceBlocks = await api('/api/users/search?q=sep30bobblocked', 'GET', alice.token).then(r => r.body);
  ok(!afterAliceBlocks.some(u => u.id === bob.user.id), 'alice blocking bob: bob no longer turns up in ALICE\'s own search');
  const fromBobsSide = await api('/api/users/search?q=sep30alice', 'GET', bob.token).then(r => r.body);
  ok(!fromBobsSide.some(u => u.id === alice.user.id), 'and the block is bidirectional -- alice does not turn up in BOB\'s search either, same as Instagram');

  const carol = await reg('sep30carol');
  const stillThere = await api('/api/users/search?q=sep30carol', 'GET', alice.token).then(r => r.body);
  ok(stillThere.some(u => u.id === carol.user.id), 'an unrelated third account is completely unaffected by the block');
}

console.log('\nTier 2 #4 (Jeff: friendlier reason instead of a bare available:false): GET /api/register/check returns a specific reason per failure, not just "taken"');
{
  const taken = await reg('sep30taken');
  const r1 = await api('/api/register/check?username=sep30taken', 'GET', null).then(r => r.body);
  ok(r1.available === false && r1.reason === 'That username is already taken', `an already-registered name says so specifically (got ${JSON.stringify(r1)})`);
  const r2 = await api('/api/register/check?username=a', 'GET', null).then(r => r.body);
  ok(r2.available === false && /3-20 characters/.test(r2.reason || ''), `an invalid username gets the real validation reason, not "taken" (got ${JSON.stringify(r2)})`);
  const r3 = await api('/api/register/check?username=admin', 'GET', null).then(r => r.body);
  ok(r3.available === false && /reserved/i.test(r3.reason || ''), `a reserved word says "reserved," not "taken" (got ${JSON.stringify(r3)})`);
  const r4 = await api('/api/register/check?username=sep30freshname', 'GET', null).then(r => r.body);
  ok(r4.available === true && !r4.reason, `a genuinely free name is just available:true (got ${JSON.stringify(r4)})`);
}

console.log('\nTier 3 #7 (Jeff: "Build now") + #9 (leo-profanity gate) + #8 (real Pattern field): POST /api/exercises/custom');
{
  const dana = await reg('sep30dana');
  const bad = await api('/api/exercises/custom', 'POST', dana.token, { name: 'fuck this exercise', muscle_groups: ['chest'] });
  ok(bad.status === 400 && /allowed/i.test(bad.body.error || ''), `a profane name is rejected with a real message, not created (got ${bad.status} ${JSON.stringify(bad.body)})`);

  const good = await api('/api/exercises/custom', 'POST', dana.token, { name: 'Dana Curl', muscle_groups: ['biceps'], pattern: 'pull' });
  ok(good.status === 200 && typeof good.body.id === 'string' && good.body.id.length > 0, `a clean name succeeds and gets a stable id (got ${JSON.stringify(good.body)})`);
  ok(good.body.pattern === 'pull', 'a real, recognized pattern (pull) is stored as given -- no more defaulting to the muscle group name');

  const badPattern = await api('/api/exercises/custom', 'POST', dana.token, { name: 'Dana Row', muscle_groups: ['lats'], pattern: 'biceps' });
  ok(badPattern.body.pattern === 'other', `an unrecognized pattern value (here, a muscle group name -- the exact old bug) falls back to "other," not "biceps" (got ${JSON.stringify(badPattern.body.pattern)})`);

  const noPattern = await api('/api/exercises/custom', 'POST', dana.token, { name: 'Dana Press', muscle_groups: ['chest'] });
  ok(noPattern.body.pattern === 'other', 'no pattern given at all also falls back to "other," same safe default');
}

console.log('\nTier 3 #7: PUT /api/exercises/custom/:id edits an exercise you own; name stays fixed; you cannot touch someone else\'s');
{
  const erin = await reg('sep30erin');
  const frank = await reg('sep30frank');
  const created = await post('/api/exercises/custom', { name: 'Erin Squat', muscle_groups: ['quads'], pattern: 'legs' }, erin.token);

  const edited = await api('/api/exercises/custom/' + created.id, 'PUT', erin.token,
    { muscle_groups: ['quads', 'glutes'], equipment: ['barbell'], is_compound: true, level: 'advanced', pattern: 'legs' });
  ok(edited.status === 200, `the owner can edit their own exercise (got ${edited.status})`);
  ok(JSON.stringify(edited.body.muscle_groups) === JSON.stringify(['quads', 'glutes']), 'muscle_groups actually updated');
  ok(edited.body.level === 'advanced' && edited.body.is_compound === true, 'level and is_compound actually updated');
  ok(edited.body.name === 'Erin Squat', 'the name is untouched -- PUT never accepts a rename (see the route\'s own comment on why)');

  const stolen = await api('/api/exercises/custom/' + created.id, 'PUT', frank.token, { muscle_groups: ['chest'] });
  ok(stolen.status === 404, `a DIFFERENT user cannot edit erin's exercise -- it simply does not exist from frank's side (got ${stolen.status})`);

  const badMg = await api('/api/exercises/custom/' + created.id, 'PUT', erin.token, { muscle_groups: ['not-a-real-muscle'] });
  ok(badMg.status === 400, `an edit with no real muscle group is rejected (got ${badMg.status})`);
}

console.log('\nTier 3 #7: DELETE /api/exercises/custom/:id -- refused once logged (never silently corrupts history), otherwise a real delete');
{
  const gabe = await reg('sep30gabe');
  const neverLogged = await post('/api/exercises/custom', { name: 'Gabe Fly', muscle_groups: ['chest'] }, gabe.token);
  const wasLogged = await post('/api/exercises/custom', { name: 'Gabe Curl', muscle_groups: ['biceps'] }, gabe.token);

  const s = await post('/api/sessions', { name: 'Gabe Day', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Gabe Curl' }] }, gabe.token);
  await post('/api/sessions/' + s.id + '/log', { exerciseId: s.exercises[0].id, weight: 30, reps: 10 }, gabe.token);

  const delNever = await api('/api/exercises/custom/' + neverLogged.id, 'DELETE', gabe.token);
  ok(delNever.status === 200 && delNever.body.ok === true, `an exercise nobody ever logged deletes cleanly (got ${delNever.status})`);
  const listAfter = await api('/api/exercises', 'GET', gabe.token).then(r => r.body);
  const stillCustom = (listAfter.custom || listAfter).filter ? (listAfter.custom || listAfter) : [];
  ok(!stillCustom.some(e => e.id === neverLogged.id), 'and it is genuinely gone from the library, not just hidden');

  const delLogged = await api('/api/exercises/custom/' + wasLogged.id, 'DELETE', gabe.token);
  ok(delLogged.status === 409 && /sets logged/i.test(delLogged.body.error || ''), `an exercise with a real logged set is refused with a clear reason, not silently deleted (got ${delLogged.status} ${JSON.stringify(delLogged.body)})`);

  const bogus = await api('/api/exercises/custom/not-a-real-id', 'DELETE', gabe.token);
  ok(bogus.status === 404, `deleting a nonexistent id 404s cleanly (got ${bogus.status})`);
}

console.log('\nTier 3 #9 (Jeff: duplicate custom-exercise names are explicitly allowed -- "anyone should be able to use whatever name they like"): findExLibEntry\'s session-creator disambiguation resolves a same-named collision to whoever actually built the workout');
{
  // zed's own definition is inserted into DB.customExercises FIRST -- under the OLD, fully blind
  // "first match across everyone's custom list" fallback this collision would have wrongly
  // resolved to zed's muscle group (biceps) purely because zed's row exists first, regardless of
  // who actually built the workout the set was logged against.
  const zed = await reg('sep30zedcollide');
  await post('/api/exercises/custom', { name: 'Ambiguous Curl', muscle_groups: ['biceps'] }, zed.token);

  const hostCreator = await reg('sep30hostcreator');
  await post('/api/exercises/custom', { name: 'Ambiguous Curl', muscle_groups: ['triceps'] }, hostCreator.token);

  const guest = await reg('sep30guestlogger');
  // guest has NO custom exercise of their own named "Ambiguous Curl" -- the session-creator check
  // only ever matters once the logger's own list has no match (see the route's own comment).
  // inviteUsernames only resolves against an existing connection (resolveInvites/connectionsOf) --
  // a one-directional follow is enough.
  await post('/api/follow/' + hostCreator.user.id, {}, guest.token);
  const shared = await post('/api/sessions', { name: 'Host\'s Session', scheduledAt: new Date().toISOString(),
    visibility: 'private', exercises: [{ name: 'Ambiguous Curl' }], inviteUsernames: ['sep30guestlogger'] }, hostCreator.token);
  ok(Array.isArray(shared.invited) && shared.invited.includes(guest.user.id), 'setup: guest was actually invited into the session');
  const acceptRes = await api('/api/sessions/' + shared.id + '/accept', 'POST', guest.token, {});
  ok(acceptRes.status === 200, `setup: guest accepted cleanly (got ${acceptRes.status})`);
  const logRes = await api('/api/sessions/' + shared.id + '/log', 'POST', guest.token, { exerciseId: shared.exercises[0].id, weight: 30, reps: 10 });
  ok(logRes.status === 200, `setup: guest's log call succeeded (got ${logRes.status}${logRes.status !== 200 ? ' ' + JSON.stringify(logRes.body) : ''})`);

  const prog = await api('/api/progress', 'GET', guest.token).then(r => r.body);
  const volSets = g => { const row = prog.volume && (prog.volume.groups || []).find(x => x.group === g); return row ? row.sets : undefined; };
  ok(volSets('triceps') === 1, `the set is attributed to the SESSION CREATOR's own definition (triceps), not zed's unrelated one, just because zed's row happened to be inserted first (got triceps=${volSets('triceps')}, biceps=${volSets('biceps')})`);
  ok(volSets('biceps') === 0, 'and specifically NOT credited to zed\'s biceps definition -- the exact ambiguity this fix narrows');
}

console.log('\nTier 2 #14-adjacent (Jeff, Sep 29, private-routine toggle): GET /api/templates -- a Private routine no longer shows up in a friend\'s shared list; Public still does');
{
  const holly = await reg('sep30holly');
  const ivan = await reg('sep30ivan');
  await post('/api/follow/' + holly.user.id, {}, ivan.token);   // connectionsOf is one-directional-OK -- a real connection either way

  const priv = await post('/api/templates', { name: 'Holly Private Routine', visibility: 'private', exercises: [{ name: 'Squat' }] }, holly.token);
  const pub = await post('/api/templates', { name: 'Holly Public Routine', visibility: 'public', exercises: [{ name: 'Bench Press' }] }, holly.token);
  ok(!!priv.id && !!pub.id, 'setup: both routines created');

  const ivansView = await api('/api/templates', 'GET', ivan.token).then(r => r.body);
  ok(!ivansView.shared.some(t => t.id === priv.id), 'the PRIVATE routine does not appear in the friend\'s shared list');
  ok(ivansView.shared.some(t => t.id === pub.id), 'the PUBLIC routine still does');
}

console.log('\nTier 2 #2-adjacent (kick route, Sep 29 audit finding): the removal notification\'s link is a real, usable one only when the kicked person keeps SOME access, never a guaranteed dead tap');
{
  const owner = await reg('sep30kickowner');
  const kickedCold = await reg('sep30kickcold');    // never logs a single set
  const kickedWarm = await reg('sep30kickwarm');    // logs a set before being kicked
  await post('/api/follow/' + owner.user.id, {}, kickedCold.token);
  await post('/api/follow/' + owner.user.id, {}, kickedWarm.token);

  const s2 = await post('/api/sessions', { name: 'Kick Test', scheduledAt: new Date().toISOString(), visibility: 'private',
    exercises: [{ name: 'Overhead Press' }], inviteUsernames: ['sep30kickcold', 'sep30kickwarm'] }, owner.token);
  ok((s2.invited || []).includes(kickedCold.user.id) && (s2.invited || []).includes(kickedWarm.user.id), 'setup: both were actually invited');
  const acc1 = await api('/api/sessions/' + s2.id + '/accept', 'POST', kickedCold.token, {});
  const acc2 = await api('/api/sessions/' + s2.id + '/accept', 'POST', kickedWarm.token, {});
  ok(acc1.status === 200 && acc2.status === 200, `setup: both accepted cleanly (got ${acc1.status}, ${acc2.status})`);
  const logRes2 = await api('/api/sessions/' + s2.id + '/log', 'POST', kickedWarm.token, { exerciseId: s2.exercises[0].id, weight: 45, reps: 8 });
  ok(logRes2.status === 200, `setup: kickedWarm's log call succeeded (got ${logRes2.status}${logRes2.status !== 200 ? ' ' + JSON.stringify(logRes2.body) : ''})`);

  const rm1 = await api('/api/sessions/' + s2.id + '/participants/' + kickedCold.user.id + '/remove', 'POST', owner.token, {});
  const rm2 = await api('/api/sessions/' + s2.id + '/participants/' + kickedWarm.user.id + '/remove', 'POST', owner.token, {});
  ok(rm1.status === 200 && rm2.status === 200, `setup: both kicks succeeded (got ${rm1.status}, ${rm2.status})`);

  const coldNotifs = await api('/api/notifications', 'GET', kickedCold.token).then(r => r.body);
  const coldOne = (coldNotifs.history || []).find(n => /removed/i.test(n.title || ''));
  ok(!!coldOne && coldOne.link === null, `a kicked person with NOTHING logged gets a null link -- would have been a guaranteed 403 dead tap otherwise (got ${JSON.stringify(coldOne && coldOne.link)})`);

  const warmNotifs = await api('/api/notifications', 'GET', kickedWarm.token).then(r => r.body);
  const warmOne = (warmNotifs.history || []).find(n => /removed/i.test(n.title || ''));
  ok(!!warmOne && warmOne.link && warmOne.link.sessionId === s2.id, `a kicked person who DID log something keeps a real, working link (got ${JSON.stringify(warmOne && warmOne.link)})`);
}

console.log('\nTier 2 #11-adjacent (Jeff: "I like weekly streak," confirmed pick): GET /api/progress\'s streakWeeks is always measured over a real 26-week window, never silently truncated by a shorter weeks= range picker');
{
  const kim = await reg('sep30kim');
  // 5 straight trained weeks INCLUDING the current one (a streak is consecutive weeks counted
  // backward from now -- see the loop in GET /api/progress -- so it breaks immediately if the
  // current week itself has nothing trained yet), well inside 26 weeks but outside a 4-week window.
  for (let i = 4; i >= 0; i--) {
    const d = new Date(Date.now() - i * 7 * 86400000).toISOString();
    const s3 = await post('/api/sessions', { name: 'Streak Week ' + i, scheduledAt: d, visibility: 'private', exercises: [{ name: 'Deadlift' }] }, kim.token);
    await post('/api/sessions/' + s3.id + '/log', { exerciseId: s3.exercises[0].id, weight: 100, reps: 5 }, kim.token);
    await post('/api/sessions/' + s3.id + '/lock', { localDate: d.slice(0, 10) }, kim.token);
  }
  const shortRange = await api('/api/progress?weeks=4', 'GET', kim.token).then(r => r.body);
  ok(shortRange.streakWeeks >= 5, `a real 5-week streak still reports as 5+ even when the display range asked for is only 4 weeks (got ${shortRange.streakWeeks})`);
  const longRange = await api('/api/progress?weeks=13', 'GET', kim.token).then(r => r.body);
  ok(longRange.streakWeeks === shortRange.streakWeeks, `the streak number does not change just because a different weeks= range was requested (got ${longRange.streakWeeks} vs ${shortRange.streakWeeks})`);
}

console.log('\nTier 2 #5 (Jeff: "I like B" -- "That username or password isn\'t right." on a failed login) + a real regression caught while screenshotting it: H._req\'s own blanket 401 handler was swallowing EVERY 401, including /api/login\'s, into a generic "Session expired" before doLogin() ever saw "bad credentials"');
{
  // Real app.js, real server, node:vm -- same technique test/leave-workout.mjs uses -- so this
  // exercises the actual H._req interceptor and doLogin(), not a re-implementation of either.
  const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const alerts = [];
  const el = () => new Proxy(function () {}, {
    get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
      : k === 'value' ? '' : k === 'children' || k === 'childNodes' ? [] : el(),
    set: () => true, apply: () => el(), has: () => true,
  });
  const doc = { getElementById: (id) => (id === 'lx' ? { value: 'sep30nouser000' } : id === 'lp' ? { value: 'wrongpassword1' } : el()),
    querySelector: () => null, querySelectorAll: () => [], createElement: () => el(),
    addEventListener() {}, body: el(), documentElement: el(), head: el(), cookie: '', readyState: 'complete' };
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => fetch(B + url, opts),
    location: { href: '/', pathname: '/', search: '', hash: '' },
    history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
    navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
    setTimeout, clearTimeout, setInterval, clearInterval, alert: (m) => alerts.push(m), confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  await vm.runInContext('doLogin', ctx)();
  await new Promise(r => setTimeout(r, 50));
  ok(alerts.length === 1 && alerts[0] === "That username or password isn't right.",
    `a wrong-password login shows the real friendly message, not "Session expired" (got ${JSON.stringify(alerts)})`);

  // Sanity: a genuinely expired/invalid TOKEN (a normal authenticated call, not login) still
  // gets the real "Session expired" redirect -- the narrowed check must not have broken that.
  vm.runInContext(`TOKEN = 'not-a-real-token-at-all';`, ctx);
  const r = await vm.runInContext('H', ctx).get('/api/progress');
  ok(r && r.error === 'Session expired — please log in again' && r._expired === true,
    `a real invalid token on an authenticated route still triggers the session-expired flow (got ${JSON.stringify(r)})`);
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
