// Oct 1 2026 -- permanent coverage for the two Tier 1 (security / data-loss) findings from the
// "CrewFit Full-App Audit -- Sep 30 2026 (Round 2)" doc, built on Jeff's "lets do tier 1" go-ahead.
// CLAUDE.md hard rule #6: every assertion here exists because something was actually broken.
//   Tier 1 #1: POST /api/me/username required no password confirmation -- a stolen/leaked
//     session token alone could rename someone out of their own account, with no self-service
//     recovery since password reset is permanently disabled. The route's own fix (and its shared
//     'pw-confirm:' rate-limit budget) is covered in test/account-settings.mjs's "username" and
//     "rate limiting on the password-confirmation routes" blocks -- NOT duplicated here.
//   Tier 1 #2: a custom exercise created with the same name as a built-in library exercise used
//     to save successfully and then vanish from every response forever (GET /api/exercises's own
//     collision filter), permanently burning one of the user's 500 custom-exercise slots with no
//     way to see, edit, or delete it. That's what this file actually covers.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT1T1 || 4982;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct1tier1');
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
const DIR = mkdtempSync(join(tmpdir(), 'oct1tier1-'));
await boot(DIR);

async function api(path, method, token, body) {
  const r = await fetch(B + path, { method, headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const post = (p, b, tok) => api(p, 'POST', tok, b).then(r => r.body);
const postFull = (p, b, tok) => api(p, 'POST', tok, b);
const reg = (u) => post('/api/register', { username: u, pin: 'pass1234', displayName: u });

console.log('Tier 1 #2 (round-2 audit): creating a custom exercise named exactly like a built-in one is rejected up front, not silently accepted and then filtered out forever');
{
  const dana = await reg('oct1dana');

  // "Push-Up" is a real, unmodified entry in exercise-library.json (EX_LIB) -- confirmed via the
  // library itself, not assumed.
  const lib = await api('/api/exercises', 'GET', null).then(r => r.body);
  const builtIn = lib.find(e => e.name === 'Push-Up' && !e.custom);
  ok(!!builtIn, 'sanity: "Push-Up" is a real built-in library exercise to collide with');

  const collide = await postFull('/api/exercises/custom',
    { name: 'Push-Up', muscle_groups: ['chest'], equipment: ['bodyweight'], level: 'beginner', is_compound: true, pattern: 'push' },
    dana.token);
  ok(collide.status === 400 && !!collide.body.error,
     `creating a custom exercise named exactly "Push-Up" is refused up front (got ${collide.status}, ${JSON.stringify(collide.body)})`);

  // The whole point of the fix: it must not have been saved at all -- not saved-then-hidden, which
  // is the exact silent-data-loss bug this closes. Checked through the only place a custom
  // exercise shows at all (GET /api/exercises's 'mine' flag), the same route whose own collision
  // filter used to hide it.
  const afterReject = await api('/api/exercises', 'GET', dana.token).then(r => r.body);
  const minePushUps = afterReject.filter(e => e.mine && e.name === 'Push-Up');
  ok(minePushUps.length === 0, `no "mine" custom exercise named "Push-Up" exists after the rejected attempt (found ${minePushUps.length})`);

  // A second built-in name, to rule out "Push-Up" being special-cased rather than this being a
  // real check against the whole library.
  const collide2 = await postFull('/api/exercises/custom',
    { name: 'Plank', muscle_groups: ['core'], equipment: ['bodyweight'], level: 'beginner', is_compound: false, pattern: 'core' },
    dana.token);
  ok(collide2.status === 400 && !!collide2.body.error, `a second, different built-in name ("Plank") is refused the same way (got ${collide2.status}, ${JSON.stringify(collide2.body)})`);
}

console.log('\nthe new check is the SAME exact, case-sensitive comparison GET /api/exercises\' own collision filter and findExLibEntry already use -- nothing stricter, nothing looser');
{
  const erin = await reg('oct1erin');
  // Different case from the real library entry "Push-Up" -- the collision filter and
  // findExLibEntry both use a plain === comparison, so this does NOT collide and must be allowed
  // to save normally, exactly like before this fix.
  const differentCase = await postFull('/api/exercises/custom',
    { name: 'push-up (my variant)', muscle_groups: ['chest'], equipment: ['bodyweight'], level: 'beginner', is_compound: true, pattern: 'push' },
    erin.token);
  ok(differentCase.status === 200 && !differentCase.body.error,
     `a name that does NOT exactly match a library entry saves normally, unaffected by this fix (got ${differentCase.status}, ${JSON.stringify(differentCase.body)})`);
  const afterSave = await api('/api/exercises', 'GET', erin.token).then(r => r.body);
  ok(afterSave.some(e => e.mine && e.name === 'push-up (my variant)'),
     'and it genuinely shows up afterward -- this fix never touches names that do not collide');
}

console.log('\nthe pre-existing, deliberate "no uniqueness between custom exercises" rule (Jeff: "anyone should be able to use whatever name they like") is untouched by this fix');
{
  const frank = await reg('oct1frank');
  const gwen = await reg('oct1gwen');
  const name = 'Totally Custom Move Oct1';
  const first = await postFull('/api/exercises/custom',
    { name, muscle_groups: ['chest'], equipment: [], level: 'beginner', is_compound: false, pattern: 'push' }, frank.token);
  ok(first.status === 200 && !first.body.error, `a brand-new, non-colliding custom name saves (got ${first.status}, ${JSON.stringify(first.body)})`);
  // A second, DIFFERENT user creating a custom exercise with the exact same name -- this is the
  // rule Jeff deliberately kept: no uniqueness enforcement between custom exercises, only against
  // the built-in library (which this block's name never touches).
  const second = await postFull('/api/exercises/custom',
    { name, muscle_groups: ['chest'], equipment: [], level: 'beginner', is_compound: false, pattern: 'push' }, gwen.token);
  ok(second.status === 200 && !second.body.error,
     `a second, unrelated user can still create a custom exercise with that exact same name -- this fix does not add uniqueness between customs (got ${second.status}, ${JSON.stringify(second.body)})`);
}

srv.kill();
await testDb.drop();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
