// Oct 2 2026 -- permanent coverage for Tier 3 audit item #4 (task #150/#156): the full-form
// create/edit wizard (editSession/submitSession, reached via the ⋯ menu's plain "Edit" on a
// not-yet-posted session) had NO check for a contested exercise removal before calling PUT, unlike
// the OTHER editor (renderWorkoutEdit/saveWorkoutEdit, reached via "Edit session" on an
// already-posted recap), which has always asked "Ask them to confirm" vs "Just for me" first.
//
// The server's PUT /api/sessions/:id route (see its own long comment) never actually DELETES a
// contested exercise either way -- it keeps it in place and opens a pendingRemovals approval
// request instead, returning a plain 200 regardless. Without the client-side check, Save on the
// full-form editor silently "succeeded" while the removed exercise was invisibly still there the
// whole time, nothing telling the user a request had opened instead of a real removal.
//
// Fix: submitSession now runs the exact same contested-removal detection saveWorkoutEdit already
// does, and reuses the SAME confirm sheet (openRemovalChoiceSheet), generalized with pluggable
// onAsk/onJustMe completions so each editor's own, very different save pipeline still runs
// afterward. This drives the REAL server AND the REAL public/app.js (via node:vm, fetch pointed at
// the live test server), same harness shape as test/leave-workout.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('fulleditorrm');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
async function readDb(url) {
  const pg = new PgConnection(parseConnString(url));
  const r = await pg.query('SELECT id, data FROM sessions');
  pg.close();
  const sessions = {};
  for (const row of r.rows) sessions[row.id] = JSON.parse(row.data);
  return { sessions };
}

const DIR = mkdtempSync(join(tmpdir(), 'fulleditorrm-'));
const PORT = 4993, B = `http://localhost:${PORT}`;
const { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });

const creator = await reg('fer_creator', 'pass1234', 'Creator');
const partner = await reg('fer_partner', 'pass1234', 'Partner');
await post('/api/follow/' + partner.user.id, {}, creator.token);
await post('/api/follow-requests/' + creator.user.id + '/accept', {}, partner.token);

// ---- render the REAL client against the REAL running server ----
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sink = { html: '' };
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? el()
    : k === 'innerHTML' ? sink.html
    : k === 'innerText' || k === 'value' || k === 'textContent' ? ''
    : k === 'children' || k === 'childNodes' ? [] : el(),
  set: (t, k, v) => { if (k === 'innerHTML') sink.html += String(v); return true; },
  apply: () => el(), has: () => true,
});
const doc = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(), documentElement: el(), head: el(),
  cookie: '', readyState: 'complete' };
const alertLog = [];
function makeCtx() {
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, opts) => fetch(B + url, opts),
    location: { href: '/', pathname: '/', search: '', hash: '' },
    history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
    navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
    setTimeout, clearTimeout, setInterval, clearInterval, alert: (m) => alertLog.push(m), confirm: () => true, prompt: () => null,
    requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
  return ctx;
}

console.log('\nchoosing "Ask them to confirm" on the FULL-FORM editor: the sheet must show first, and the exercise must survive as a pending request, not vanish');
{
  const session = await post('/api/sessions', {
    name: 'Full Editor Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Incline Press' }, { name: 'Cable Fly' }],
    inviteUsernames: ['fer_partner'], visibility: 'private',
  }, creator.token);
  await post('/api/sessions/' + session.id + '/accept', {}, partner.token);
  const flyId = session.exercises.find(e => e.name === 'Cable Fly').id;
  const inclineId = session.exercises.find(e => e.name === 'Incline Press').id;
  // the partner logs a set on Cable Fly -- this is what makes removing it a contested removal
  await post('/api/sessions/' + session.id + '/log', { exerciseId: flyId, weight: 30, reps: 12 }, partner.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, ctx);
  // Simulate having opened editSession() and then deleted the Cable Fly row in the picker, leaving
  // only Incline Press -- this is exactly DRAFT.exercises right before Save is tapped.
  vm.runInContext(`EDITING_SESSION = ${JSON.stringify(session.id)}; DRAFT = { exercises: [{ id: ${JSON.stringify(inclineId)}, name: 'Incline Press', defaultSets: 3, defaultReps: 10 }], inviteUsernames: [] };`, ctx);
  sink.html = '';
  await vm.runInContext('submitSession', ctx)();
  ok(sink.html.includes('Remove this exercise?') || sink.html.includes('Remove these exercises?'),
     `a confirm sheet opened instead of silently saving (got: ${JSON.stringify(sink.html.slice(0, 300))})`);
  ok(sink.html.includes('Ask') && sink.html.includes('confirm') && sink.html.includes('Just for me'),
     'offers the same two choices the other editor already offers');

  const dbBeforeChoice = await readDb(testDb.url);
  ok((dbBeforeChoice.sessions[session.id].exercises || []).some(e => e.id === flyId),
     'and nothing has happened yet -- Cable Fly is still genuinely in the exercise list, PUT has not fired');

  // tap "Ask them to confirm"
  sink.html = '';
  vm.runInContext('removalChoiceAsk', ctx)();
  await new Promise(r => setTimeout(r, 300));

  const dbAfter = await readDb(testDb.url);
  const s2 = dbAfter.sessions[session.id];
  ok((s2.exercises || []).some(e => e.id === flyId), 'Cable Fly is STILL in the exercise list -- the server never actually deletes a contested exercise');
  const pr = (s2.pendingRemovals || []).find(p => p.exerciseId === flyId && p.status === 'pending');
  ok(!!pr, `a real pendingRemovals request opened for it (got ${JSON.stringify(s2.pendingRemovals)})`);
  ok(pr && pr.requiredApprovals.includes(partner.user.id), 'the partner (who logged sets on it) is a required approver');
  ok((s2.exercises || []).some(e => e.id === inclineId), 'Incline Press (the uncontested, genuinely-kept exercise) is untouched');
}

console.log('\nchoosing "Just for me" on the FULL-FORM editor: the exercise stays for everyone, hidden only from my own view -- no approval request opens at all');
{
  const session2 = await post('/api/sessions', {
    name: 'Full Editor Day 2', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Lateral Raise' }, { name: 'Tricep Pushdown' }],
    inviteUsernames: ['fer_partner'], visibility: 'private',
  }, creator.token);
  ok(!session2.error, `session2 created (${JSON.stringify(session2.error || 'ok')})`);
  await post('/api/sessions/' + session2.id + '/accept', {}, partner.token);
  const pushdownId = session2.exercises.find(e => e.name === 'Tricep Pushdown').id;
  const raiseId = session2.exercises.find(e => e.name !== 'Tricep Pushdown').id;
  await post('/api/sessions/' + session2.id + '/log', { exerciseId: pushdownId, weight: 25, reps: 15 }, partner.token);

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, ctx);
  vm.runInContext(`EDITING_SESSION = ${JSON.stringify(session2.id)}; DRAFT = { exercises: [{ id: ${JSON.stringify(raiseId)}, name: 'Lateral Raise', defaultSets: 3, defaultReps: 10 }], inviteUsernames: [] };`, ctx);
  sink.html = '';
  await vm.runInContext('submitSession', ctx)();
  ok(sink.html.includes('Just for me'), 'the choice sheet opened here too');

  sink.html = '';
  vm.runInContext('removalChoiceJustMe', ctx)();
  await new Promise(r => setTimeout(r, 400));

  const dbAfter2 = await readDb(testDb.url);
  const s3 = dbAfter2.sessions[session2.id];
  ok((s3.exercises || []).some(e => e.id === pushdownId), 'Tricep Pushdown is STILL in the real exercise list -- "Just for me" never actually removes it for the group');
  ok(!(s3.pendingRemovals || []).some(p => p.exerciseId === pushdownId && p.status === 'pending'),
     'and NO approval request was opened -- restoring it into the PUT payload kept the server from ever treating it as a removal');
  ok((s3.hiddenFor && s3.hiddenFor[pushdownId] || []).includes(creator.user.id),
     `it IS hidden from just the creator's own view (got ${JSON.stringify(s3.hiddenFor)})`);
  ok(!((s3.hiddenFor && s3.hiddenFor[pushdownId]) || []).includes(partner.user.id),
     'but NOT hidden from the partner -- this is a personal hide, not a group-wide change');

  const partnerView = await fetch(B + '/api/sessions/' + session2.id, { headers: { Authorization: 'Bearer ' + partner.token } }).then(r => r.json());
  ok((partnerView.exercises || []).some(e => e.id === pushdownId), "the partner's own view still shows Tricep Pushdown, completely unaffected");
}

console.log('\nsanity: removing an exercise NOBODY ELSE logged anything on still saves immediately, no sheet, same as before this fix');
{
  const session3 = await post('/api/sessions', {
    name: 'Full Editor Day 3', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Face Pull' }, { name: 'Hammer Curl' }],
    inviteUsernames: ['fer_partner'], visibility: 'private',
  }, creator.token);
  // found by position, not exact name -- POST /api/sessions can normalize a submitted name against
  // the real library (e.g. "Lateral Raise" -> "Dumbbell Lateral Raise"), so matching the literal
  // string back is fragile; the session was created with Face Pull first, Hammer Curl second.
  const faceId = session3.exercises[0].id;
  const curlId = session3.exercises[1].id;

  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, ctx);
  vm.runInContext(`EDITING_SESSION = ${JSON.stringify(session3.id)}; DRAFT = { exercises: [{ id: ${JSON.stringify(curlId)}, name: 'Hammer Curl', defaultSets: 3, defaultReps: 10 }], inviteUsernames: [] };`, ctx);
  sink.html = '';
  await vm.runInContext('submitSession', ctx)();
  await new Promise(r => setTimeout(r, 300));
  ok(!sink.html.includes('Remove this exercise?'), 'no confirm sheet -- nobody else had anything at stake');

  const dbAfter3 = await readDb(testDb.url);
  const s4 = dbAfter3.sessions[session3.id];
  ok(!(s4.exercises || []).some(e => e.id === faceId), 'Face Pull is genuinely gone -- an uncontested removal still applies immediately, exactly as before');
  ok((s4.exercises || []).some(e => e.id === curlId), 'Hammer Curl, the kept exercise, is still there');
}

console.log('\ncold-review catch: if the safety-check GET itself fails (session gone/unreachable), submitSession must fail CLOSED -- alert and abort -- never silently fall through to a write with the contested-removal check simply skipped');
{
  const ctx = makeCtx();
  vm.runInContext(`TOKEN = ${JSON.stringify(creator.token)}; ME = ${JSON.stringify(creator.user)};`, ctx);
  // A session id that was never created -- GET /api/sessions/:id 404s, matching exactly what a
  // deleted-out-from-under-you or otherwise-unreachable session looks like to this code.
  vm.runInContext(`EDITING_SESSION = 'not_a_real_session_id'; DRAFT = { exercises: [{ id: 'e_whatever', name: 'Anything', defaultSets: 3, defaultReps: 10 }], inviteUsernames: [] };`, ctx);
  alertLog.length = 0;
  await vm.runInContext('submitSession', ctx)();
  ok(alertLog.length > 0, `an alert fired instead of silently proceeding (got ${JSON.stringify(alertLog)})`);

  const dbCheck = await readDb(testDb.url);
  ok(!dbCheck.sessions['not_a_real_session_id'], 'and, as expected, nothing was written for a session id that never existed -- this is really about the alert firing, confirming the abort path ran rather than the write path');
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
