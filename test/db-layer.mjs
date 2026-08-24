// Tests db.js's load()/save() round-trip against a real, throwaway local Postgres database —
// this is the layer that replaces the old file-backed load()/save() in server.js, so it needs
// to prove: every collection round-trips exactly, deletions actually delete (no ghost rows),
// the singleton field (followApprovalV1) survives, and a save() failure rolls back atomically
// (no half-written state — the exact failure mode the old single-file save() was vulnerable to).
import { freshTestDb } from './_pgtestdb.mjs';

const testDb = await freshTestDb('dblayer');
process.env.DATABASE_URL = testDb.url;
const db = (await import('../db.js')).default;

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// Postgres jsonb does not guarantee preserving object key insertion order on the way back
// out, so a raw JSON.stringify(a) === JSON.stringify(b) comparison is the wrong test here
// (two objects with identical content but different key order would wrongly fail) — this
// does a real structural deep-equal instead.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

try {

console.log('load() on an empty database returns the expected empty shape');
{
  const d = await db.load();
  ok(Object.keys(d.users).length === 0, 'no users');
  ok(Object.keys(d.sessions).length === 0, 'no sessions');
  ok(Object.keys(d.templates).length === 0, 'no templates');
  ok(Object.keys(d.pushSubs).length === 0, 'no pushSubs');
  ok(Object.keys(d.customExercises).length === 0, 'no customExercises');
  ok(Object.keys(d.prs).length === 0, 'no prs');
  ok(d.followApprovalV1 === undefined, 'no followApprovalV1 yet');
}

console.log('\nsave() then load() round-trips every collection exactly');
let seed;
{
  seed = db.EMPTY_DB();
  seed.users['u1'] = { id: 'u1', username: 'JeffB', displayName: 'Jeff', friends: ['u2'], units: 'lb', createdAt: '2026-01-01T00:00:00.000Z', pinSalt: 'salt', pinHash: 'hash', bio: '', avatar: '', followers: [], following: ['u2'], followReqs: [] };
  seed.users['u2'] = { id: 'u2', username: 'brian_k', displayName: 'Brian', friends: ['u1'], units: 'kg', createdAt: '2026-01-02T00:00:00.000Z', pinSalt: 'salt2', pinHash: 'hash2', bio: 'lifting since 2019', avatar: '/uploads/avatar_u2.png', followers: ['u1'], following: [], followReqs: [] };
  seed.sessions['s1'] = { id: 's1', creatorId: 'u1', scheduledAt: '2026-08-20T18:00:00.000Z', status: 'draft', visibility: 'friends', equipment: [], location: "Gold's Gym", lengthMin: 60, creatorNote: '', name: 'Leg Day', exercises: [{ id: 'e1', order: 0, name: 'Squat', defaultSets: 3, defaultReps: 8 }], participants: ['u1'], invited: ['u2'], variations: {}, suggestedEdits: [], joinRequests: [], attendance: { u1: 'in' }, logs: { u1: [{ id: 'log1', exerciseId: 'e1', exerciseName: 'Squat', weight: 225, reps: 5, set: 1, setType: 'normal', isPr: true, at: '2026-08-20T18:30:00.000Z' }] }, comments: [], history: [], posts: {} };
  seed.templates['t1'] = { id: 't1', ownerId: 'u1', name: 'Push Day', exercises: [{ name: 'Bench', defaultSets: 3, defaultReps: 8 }] };
  seed.pushSubs['u1'] = { endpoint: 'https://push.example/abc', expirationTime: null, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } };
  seed.customExercises['u1'] = [{ name: 'Cable Pull-Through', pattern: 'hinge', category: 'glutes', muscle_groups: ['glutes', 'hamstrings'], equipment: ['cable'], is_compound: true, level: 'intermediate', defaultSets: 3, defaultReps: 10, custom: true, ownerId: 'u1' }];
  seed.prs['u1'] = { Squat: { exercise: 'Squat', weight: 225, reps: 5, at: '2026-08-20T18:30:00.000Z', firstLog: false } };
  seed.followApprovalV1 = true;

  await db.save(seed);
  const loaded = await db.load();

  ok(deepEqual(loaded.users['u1'], seed.users['u1']), 'user u1 round-tripped exactly (including followers/following)');
  ok(deepEqual(loaded.users['u2'], seed.users['u2']), 'user u2 round-tripped exactly (different unit, avatar, bio)');
  ok(deepEqual(loaded.sessions['s1'], seed.sessions['s1']), 'deeply nested session (exercises/logs/attendance) round-tripped exactly');
  ok(deepEqual(loaded.templates['t1'], seed.templates['t1']), 'template round-tripped');
  ok(deepEqual(loaded.pushSubs['u1'], seed.pushSubs['u1']), 'push subscription round-tripped');
  ok(deepEqual(loaded.customExercises['u1'], seed.customExercises['u1']), 'custom exercises array round-tripped');
  ok(deepEqual(loaded.prs['u1'], seed.prs['u1']), 'PRs round-tripped');
  ok(loaded.followApprovalV1 === true, 'followApprovalV1 (the boot-migration marker) round-tripped');
}

console.log('\nusername_lower stays in sync for case-insensitive lookup (mirrors normUser())');
{
  const c = db.getConn();
  const r = await c.query('SELECT username_lower FROM users WHERE id = $1', ['u1']);
  ok(r.rows[0].username_lower === 'jeffb', `lowercased at write time (got ${r.rows[0].username_lower})`);
}

console.log('\ndeleting an entity from the in-memory object and saving actually removes the row (no ghosts)');
{
  delete seed.sessions['s1'];
  await db.save(seed);
  const c = db.getConn();
  const r = await c.query('SELECT count(*) as n FROM sessions');
  ok(Number(r.rows[0].n) === 0, `session row actually deleted, not just orphaned (count=${r.rows[0].n})`);
  const loaded = await db.load();
  ok(Object.keys(loaded.sessions).length === 0, 'load() confirms no sessions remain');
}

console.log('\na failed save() rolls back atomically — no half-written state (the old file-based save could not guarantee this)');
{
  const before = await db.load();
  const beforeUserCount = Object.keys(before.users).length;
  const beforeTemplateIds = Object.keys(before.templates).sort();
  const bad = db.EMPTY_DB();
  bad.users['u1'] = before.users['u1'];
  bad.users['u2'] = before.users['u2'];
  // Force a mid-transaction failure partway through the templates upserts, simulating e.g.
  // a dropped connection or a constraint violation mid-save().
  const origQuery = db.getConn().query.bind(db.getConn());
  db.getConn().query = async (sql, params) => {
    if (sql.includes('INSERT INTO templates')) throw new Error('simulated failure mid-save');
    return origQuery(sql, params);
  };
  bad.templates['tbad1'] = { id: 'tbad1', name: 'ok' };
  bad.templates['tbad2'] = { id: 'tbad2', name: 'ok' };
  let threw = false;
  try { await db.save(bad); } catch (e) { threw = true; }
  db.getConn().query = origQuery;
  ok(threw, 'save() propagated the simulated mid-transaction failure');
  const after = await db.load();
  ok(deepEqual(Object.keys(after.templates).sort(), beforeTemplateIds), `templates unchanged from before the failed save — no tbad1/tbad2 leaked in, nothing pre-existing was lost (got ${Object.keys(after.templates).sort()})`);
  ok(Object.keys(after.users).length === beforeUserCount, 'users collection untouched by the failed save (whole transaction rolled back)');
}

} finally {
  db.close();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
