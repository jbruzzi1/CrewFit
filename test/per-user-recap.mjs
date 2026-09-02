// v187: photos, notes and visibility are PER PARTICIPANT now, not one shared recap authored by
// the creator. Jeff, Aug 19: "I want photos and notes to stay separate for each user. Just like
// the log and finish and leave button." This proves, against a REAL running server (and the REAL
// client for the render checks): two participants can each post their own independent recap on
// the SAME session, one person's "only me" notes never leak to the other even though both trained
// together, each person's own profile shows their own recap (not a partner's), and a session
// created under the OLD single-post schema is migrated cleanly at boot into the new per-user shape
// with no data lost.
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

function boot(port, dir, databaseUrl) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: databaseUrl, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 8000);
  });
}
const post = (B, p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (B, p, tok) => fetch(B + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then(r => r.json());
async function sessionRow(dbUrl, id) {
  const pg = new PgConnection(parseConnString(dbUrl));
  const r = await pg.query('SELECT data FROM sessions WHERE id = $1', [id]);
  pg.close();
  return r.rows.length ? JSON.parse(r.rows[0].data) : null;
}

console.log('two participants each post their own recap on the SAME session — independently');
{
  const DIR = mkdtempSync(join(tmpdir(), 'perpost-'));
  const testDb = await freshTestDb('perpost1');
  const PORT = 4993, B = `http://localhost:${PORT}`;
  const { srv } = await boot(PORT, DIR, testDb.url);
  ok(!!srv, 'server boots');

  const alice = await post(B, '/api/register', { username: 'recap_alice', pin: 'pass1234', displayName: 'Alice' });
  const bob = await post(B, '/api/register', { username: 'recap_bob', pin: 'pass1234', displayName: 'Bob' });
  const carol = await post(B, '/api/register', { username: 'recap_carol', pin: 'pass1234', displayName: 'Carol' });
  await post(B, '/api/follow/' + bob.user.id, {}, alice.token);
  await post(B, '/api/follow-requests/' + alice.user.id + '/accept', {}, bob.token);
  await post(B, '/api/follow/' + alice.user.id, {}, bob.token);
  await post(B, '/api/follow-requests/' + bob.user.id + '/accept', {}, alice.token);

  const session = await post(B, '/api/sessions', {
    name: 'Leg Day', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Back Squat' }],
    inviteUsernames: ['recap_bob'], visibility: 'private',
  }, alice.token);
  await post(B, `/api/sessions/${session.id}/accept`, {}, bob.token);
  const exId = session.exercises[0].id;
  await post(B, `/api/sessions/${session.id}/log`, { exerciseId: exId, weight: 225, reps: 5 }, alice.token);
  await post(B, `/api/sessions/${session.id}/log`, { exerciseId: exId, weight: 135, reps: 8 }, bob.token);

  // both finish independently — neither's Log & Finish should touch the other's history
  await post(B, `/api/sessions/${session.id}/lock`, {}, alice.token);
  await post(B, `/api/sessions/${session.id}/lock`, {}, bob.token);

  // each posts their OWN recap, deliberately different visibility
  const aPost = await post(B, `/api/sessions/${session.id}/post`,
    { notes: 'quads are toast, keeping this to myself', visibility: 'private', media: [] }, alice.token);
  ok(!aPost.error, `alice can post her own recap (${aPost.error || 'ok'})`);
  const bPost = await post(B, `/api/sessions/${session.id}/post`,
    { notes: 'great session, felt strong', visibility: 'public', media: [] }, bob.token);
  ok(!bPost.error, `bob can post his own recap independently (${bPost.error || 'ok'})`);

  const s0 = await sessionRow(testDb.url, session.id);
  ok(s0.posts && s0.posts[alice.user.id] && s0.posts[alice.user.id].notes.includes('quads'),
     "alice's recap is stored under her own id");
  ok(s0.posts && s0.posts[bob.user.id] && s0.posts[bob.user.id].notes.includes('great session'),
     "bob's recap is stored under his own id, not overwriting alice's");
  ok(s0.post === undefined, 'the old singular s.post field is gone — posts is the only shape now');

  // v190 (Sep 2026): 'private' WIDENED from the old 'only_me' (author-only) to admit the creator
  // and every participant of THAT session (Jeff: "private... only the creator or who was part of
  // it") — bob trained this exact workout with alice, so he now reads her recap too, private or
  // not. (A stranger to the workout entirely still gets nothing — see carol below.)
  const bobView = await get(B, `/api/sessions/${session.id}`, bob.token);
  ok(bobView.posts[alice.user.id] && bobView.posts[alice.user.id].notes === 'quads are toast, keeping this to myself',
     "bob (a fellow participant) CAN read alice's private recap — private now means hidden from the internet at large, not from your own training partners");
  ok(bobView.posts[bob.user.id] && bobView.posts[bob.user.id].notes === 'great session, felt strong',
     "and bob still reads his own in full");

  // Carol is a stranger to both — she should see neither
  const carolView = await fetch(B + `/api/sessions/${session.id}`, { headers: { Authorization: 'Bearer ' + carol.token } });
  ok(carolView.status === 403, `a stranger to both cannot open the session at all (got ${carolView.status})`);

  console.log('\nLog & Finish and posting a recap are still gated on being IN the workout');
  {
    const lockR = await fetch(B + `/api/sessions/${session.id}/lock`, { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + carol.token } });
    ok(lockR.status === 403, `a non-participant cannot Log & Finish someone else's session (got ${lockR.status})`);
    const postR = await fetch(B + `/api/sessions/${session.id}/post`, { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + carol.token }, body: JSON.stringify({ notes: 'not mine to write', visibility: 'public', media: [] }) });
    ok(postR.status === 403, `nor post a recap into it (got ${postR.status})`);
    const afterCarol = await sessionRow(testDb.url, session.id);
    ok(!afterCarol.posts[carol.user.id], "and nothing was written under carol's id");
  }

  console.log('\neach person\'s OWN profile shows their OWN recap, not a partner\'s');
  {
    const aliceProfile = await get(B, '/api/profile/' + alice.user.id, alice.token);
    const row = (aliceProfile.myWorkouts || []).find(w => w.id === session.id);
    ok(row && row.post && row.post.notes.includes('quads'), "alice's own profile shows HER notes");

    const bobProfile = await get(B, '/api/profile/' + bob.user.id, bob.token);
    const brow = (bobProfile.myWorkouts || []).find(w => w.id === session.id);
    ok(brow && brow.post && brow.post.notes.includes('great session'), "bob's own profile shows HIS notes, not alice's");
  }

  console.log('\nviewPost(id, authorId) renders the RIGHT person\'s recap for each');
  {
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
    const ctx = { console: { log() {}, warn() {}, error() {} }, document: doc,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: (url, opts) => fetch(B + url, opts),
      location: { href: '/', pathname: '/', search: '', hash: '' },
  // v254: app.js now registers a top-level window.addEventListener('popstate', ...) (the Back-
  // button fix) and calls history.pushState/replaceState from openSheetHtml/closeSheet/navigated/
  // landOn -- these need to be real enough not to throw, even in tests that don't care about nav.
  history: { replaceState() {}, pushState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {},
      navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
      setTimeout, clearTimeout, setInterval, clearInterval, alert() {}, confirm: () => true, prompt: () => null,
      requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
      FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
      IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
      ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; } };
    ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
    vm.runInContext(`TOKEN = ${JSON.stringify(bob.token)}; ME = ${JSON.stringify(bob.user)};`, ctx);

    sink.html = '';
    await vm.runInContext('viewPost', ctx)(session.id, bob.user.id);
    ok(sink.html.includes('great session'), "bob viewing his OWN recap sees his own notes");
    ok(!sink.html.includes('quads'), "and not alice's — the two recaps are rendered independently");
  }

  try { srv && srv.kill(); } catch {}
  rmSync(DIR, { recursive: true, force: true });
  await testDb.drop();
}

console.log('\na session created under the OLD single-post schema migrates cleanly at boot');
{
  const DIR = mkdtempSync(join(tmpdir(), 'migrate-posts-'));
  const testDb = await freshTestDb('migrateposts');

  const users = {
    u1: { id: 'u1', username: 'legacyhost', displayName: 'Host', friends: ['u2'], units: 'lb',
      createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y' },
    u2: { id: 'u2', username: 'legacyguest', displayName: 'Guest', friends: ['u1'], units: 'lb',
      createdAt: '2026-01-01T00:00:00.000Z', pinHash: 'x', pinSalt: 'y' },
  };
  const sessions = {
    s1: {
      id: 's1', creatorId: 'u1', scheduledAt: '2026-01-01T00:00:00.000Z', status: 'draft',
      visibility: 'friends', name: 'Old Recap', participants: ['u1', 'u2'], invited: [],
      exercises: [{ id: 'e1', name: 'Bench Press' }], variations: {}, suggestedEdits: [],
      joinRequests: [], attendance: {}, logs: {}, comments: [],
      history: [{ userId: 'u1', date: '2026-01-01', muscleGroups: [], exercises: ['Bench Press'] }],
      // the LEGACY shape: one post, authored by the creator, no `posts` field at all
      post: { by: 'u1', at: '2026-01-01T12:00:00.000Z', notes: 'legacy notes survive',
        media: [{ type: 'image', src: '/uploads/already_on_disk.jpg' }], visibility: 'friends' },
    },
    // an even older row from before `post.by` existed at all — the migration must fall back to
    // s.creatorId rather than dropping (or mis-attributing) the recap.
    s2: {
      id: 's2', creatorId: 'u1', scheduledAt: '2026-01-02T00:00:00.000Z', status: 'draft',
      visibility: 'private', name: 'No By Field', participants: ['u1'], invited: [],
      exercises: [{ id: 'e2', name: 'Squat' }], variations: {}, suggestedEdits: [],
      joinRequests: [], attendance: {}, logs: {}, comments: [],
      history: [{ userId: 'u1', date: '2026-01-02', muscleGroups: [], exercises: ['Squat'] }],
      post: { at: '2026-01-02T12:00:00.000Z', notes: 'pre-by-field notes', media: [], visibility: 'only_me' },
    },
  };

  // Seed rows directly via Postgres, bypassing the app/db.js entirely — the same way a real
  // pre-migration row would already be sitting in the database before this deploy.
  const dbmod = (await import('../db.js')).default;
  process.env.DATABASE_URL = testDb.url;
  await dbmod.ensureSchema();
  dbmod.close();
  const pg = new PgConnection(parseConnString(testDb.url));
  for (const u of Object.values(users)) {
    await pg.query('INSERT INTO users (id, username_lower, data) VALUES ($1, $2, $3::jsonb)', [u.id, u.username, JSON.stringify(u)]);
  }
  for (const [id, s] of Object.entries(sessions)) {
    await pg.query('INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb)', [id, JSON.stringify(s)]);
  }
  pg.close();

  const PORT = 4994, B = `http://localhost:${PORT}`;
  const { srv, out } = await boot(PORT, DIR, testDb.url);
  ok(!!srv, 'server boots on a legacy single-post session');
  ok(/MIGRATE posts: sessions=2/.test(out), 'and the boot log reports both sessions migrated');

  const after = await sessionRow(testDb.url, 's1');
  ok(after.post === undefined, 'the legacy s.post field is gone after migration');
  ok(after.posts && after.posts.u1 && after.posts.u1.notes === 'legacy notes survive',
     "the notes survived, now keyed under the author's id");
  ok(after.posts.u1.media && after.posts.u1.media[0].src === '/uploads/already_on_disk.jpg',
     'the photo path survived untouched');
  // v190 (Sep 2026): migratePosts() runs BEFORE migratePostAndSessionVisibilityBinary() in the
  // boot sequence (see the migrations block above app.listen), so the legacy 3-way 'friends' value
  // this seed row carries gets created here, then immediately normalized to the new binary 'public'
  // by the very next migration in the same boot — not left as a stale value neither migration owns.
  ok(after.posts.u1.visibility === 'public', 'visibility survived, then normalized to the new binary scheme (friends -> public)');
  ok(!after.posts.u2, 'the guest, who never posted, has no entry — nothing was invented for them');

  const after2 = await sessionRow(testDb.url, 's2');
  ok(after2.posts && after2.posts.u1 && after2.posts.u1.notes === 'pre-by-field notes',
     'a post with no .by at all falls back to s.creatorId, not dropped or orphaned');

  try { srv && srv.kill(); } catch {}

  // and the migration is idempotent — booting again does not re-report or duplicate anything
  const { srv: srv2, out: out2 } = await boot(4995, DIR, testDb.url);
  ok(!/MIGRATE posts:/.test(out2), 'a second boot on already-migrated data does nothing — idempotent');
  try { srv2 && srv2.kill(); } catch {}

  rmSync(DIR, { recursive: true, force: true });
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
