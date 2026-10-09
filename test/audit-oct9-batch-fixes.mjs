// Oct 9 2026 -- permanent coverage for the "go through the whole app" design/UX audit Jeff asked
// for, and the batch of fixes he approved from it (5 objective bugs + 5 of his own picks among
// judgment calls the audit surfaced with options). CLAUDE.md hard rule #6: every assertion here
// exists because something was actually broken or because Jeff explicitly picked this behavior.
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT9BATCH || 4981;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct9batch');
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
const DIR = mkdtempSync(join(tmpdir(), 'oct9batch-'));
await boot(DIR);

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(b || {}) }).then(r => r.json());
const put = (p, b, tok) => fetch(B + p, { method: 'PUT', headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(b || {}) }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } }).then(r => r.json());
const reg = async n => { const r = await post('/api/register', { username: n, pin: 'pass1234', displayName: n }); return { id: r.user.id, token: r.token }; };
const follow = (a, b) => post('/api/follow/' + b.id, {}, a.token);

console.log('\n1. Notifications no longer double-lists a pending swap suggestion (actionable card + duplicate history row)');
{
  const host = await reg('b9host'), other = await reg('b9other');
  await follow(host, other); await follow(other, host);
  const s = await post('/api/sessions', { name: 'Pull', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Barbell Row' }], inviteUsernames: ['b9other'] }, host.token);
  await post(`/api/sessions/${s.id}/accept`, {}, other.token);
  const before = await get('/api/notifications', host.token);
  const beforeCount = (before.history || []).length;
  await post(`/api/sessions/${s.id}/suggest`, { type: 'swap', exerciseId: s.exercises[0].id, swapTo: 'Cable Row' }, other.token);
  const after = await get('/api/notifications', host.token);
  ok((after.history || []).length === beforeCount, `the creator's history does not grow -- the pending swap is NOT duplicated there (before=${beforeCount}, after=${(after.history||[]).length})`);
  ok((after.suggestions || []).some(sg => sg.sessionId === s.id && sg.editType === 'swap'), 'it IS visible live as exactly one actionable "Suggested changes" entry');
}

console.log('\n2. "Add weight next time" no longer suggests weight for a bodyweight hold exercise (Plank, Wall Sit, ...)');
{
  const u = await reg('b9hold');
  // Plank/Wall Sit/etc normally get NO rep target at all from the library (defaultTargetFor's own
  // TIMED_HOLD branch, server.js) -- but nothing stops a session from being created with an
  // explicit one anyway (the create-flow doesn't block it, and that's exactly how a real user ends
  // up here: typing "60" into the reps field for a timed hold because the UI still shows that
  // field). This reproduces that real path rather than relying on the library default.
  const mkSession = async (name, reps, weight = 0) => {
    const s = await post('/api/sessions', { name: 'Core', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name, defaultReps: reps, defaultRepsMax: reps }] }, u.token);
    await post(`/api/sessions/${s.id}/start`, {}, u.token);
    await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight, reps }, u.token);
    await post(`/api/sessions/${s.id}/lock`, {}, u.token);
    return s;
  };
  // Two sessions topped out at the same "weight" (0, bodyweight) -- exactly what used to trigger a
  // ready/+weight suggestion for ANY exercise, Plank included.
  await mkSession('Plank', 60);
  await mkSession('Plank', 60);
  const rec = await get('/api/progress/recommendations', u.token);
  ok(!rec.ready.some(r => r.exercise === 'Plank'), `Plank does not appear in the weight-progression "ready" list (got ${JSON.stringify(rec.ready)})`);

  // Sanity: a real rep-based bodyweight exercise (Pull-Up) is UNCHANGED -- "add weight" (a vest) is
  // a genuinely real suggestion there, and this fix must not touch it.
  await mkSession('Pull-Up', 10);
  await mkSession('Pull-Up', 10);
  const rec2 = await get('/api/progress/recommendations', u.token);
  ok(rec2.ready.some(r => r.exercise === 'Pull-Up'), `sanity: a rep-based bodyweight exercise (Pull-Up) still gets a real "add weight" suggestion, unaffected by this fix (got ${JSON.stringify(rec2.ready)})`);

  // Sanity: a genuinely WEIGHTED hold (Weighted Plank) still gets real weight-progression advice --
  // only the true-bodyweight case is skipped.
  await mkSession('Weighted Plank', 60, 25);
  await mkSession('Weighted Plank', 60, 25);
  const rec3 = await get('/api/progress/recommendations', u.token);
  ok(rec3.ready.some(r => r.exercise === 'Weighted Plank'), `sanity: a genuinely loaded hold (Weighted Plank) still gets real weight-progression advice (got ${JSON.stringify(rec3.ready)})`);
}

console.log('\n3. A session finished without anyone ever tapping Start/Join now backdates to when it really happened, not the stale scheduled time');
{
  const creator = await reg('b9creator'), joiner = await reg('b9joiner');
  await follow(creator, joiner); await follow(joiner, creator);
  const staleScheduled = new Date(Date.now() + 2 * 86400000).toISOString(); // "in 2 days"
  const s = await post('/api/sessions', { name: 'Pull Day', visibility: 'private', scheduledAt: staleScheduled, exercises: [{ name: 'Barbell Row' }], inviteUsernames: ['b9joiner'] }, creator.token);
  // Exactly the real repro: accept an invite, log right away, finish, post -- never tap Start/Join now.
  await post(`/api/sessions/${s.id}/accept`, {}, joiner.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 95, reps: 8 }, joiner.token);
  const beforeLock = await get(`/api/sessions/${s.id}`, joiner.token);
  ok(beforeLock.startedAt === null && beforeLock.scheduledAt === staleScheduled, 'sanity: still carrying the original stale future time right up until Finish -- logging alone must not touch it (see the Next-Up-card regression this fix had to avoid, test/home-live-session-activity-line.mjs)');
  await post(`/api/sessions/${s.id}/lock`, {}, joiner.token);
  await post(`/api/sessions/${s.id}/post`, { notes: 'Felt good', media: [], visibility: 'private' }, joiner.token);
  const after = await get(`/api/sessions/${s.id}`, joiner.token);
  ok(after.startedAt !== null, 'finishing with no Start ever tapped backdates startedAt instead of leaving it null forever');
  ok(after.scheduledAt !== staleScheduled, `the stale "2 days from now" time is gone from the recap (got ${after.scheduledAt})`);
  ok(Math.abs(new Date(after.scheduledAt) - Date.now()) < 60000, `the corrected time is close to when it actually happened, not an arbitrary value (got ${after.scheduledAt})`);

  // Sanity: a session that genuinely WAS started via Start/Join now keeps that real moment --
  // this fix must never override an already-real startedAt.
  const s2 = await post('/api/sessions', { name: 'Push Day', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }] }, creator.token);
  await post(`/api/sessions/${s2.id}/start`, {}, creator.token);
  const realStart = (await get(`/api/sessions/${s2.id}`, creator.token)).startedAt;
  await post(`/api/sessions/${s2.id}/log`, { exerciseId: s2.exercises[0].id, weight: 135, reps: 8 }, creator.token);
  await post(`/api/sessions/${s2.id}/lock`, {}, creator.token);
  const after2 = await get(`/api/sessions/${s2.id}`, creator.token);
  ok(after2.startedAt === realStart, `an already-real startedAt (from the Start button) is left exactly as it was, not re-stamped at Finish (before=${realStart}, after=${after2.startedAt})`);
}

console.log('\n4. A joinable (not-yet-joined) public session now tells a deciding viewer someone already started');
{
  const host = await reg('b9jhost'), inProgress = await reg('b9jactive'), decider = await reg('b9jdecider');
  // decider is a friend of the host (so the session is visible/joinable to them) but was never
  // invited and has not joined -- exactly the "still deciding whether to tap Join in?" viewer.
  await follow(decider, host); await follow(host, decider);
  const s = await post('/api/sessions', { name: 'Open Mat', visibility: 'public', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }] }, host.token);
  await post(`/api/sessions/${s.id}/join`, {}, inProgress.token);
  const reqId = (await get(`/api/sessions/${s.id}`, host.token)).joinRequests.find(j => j.status === 'pending').id;
  await post(`/api/sessions/${s.id}/join/${reqId}/approve`, {}, host.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 225, reps: 5 }, inProgress.token);

  const view = await get(`/api/sessions/${s.id}`, decider.token);
  ok(!Object.keys(view.logs || {}).length, 'sanity: the deciding viewer still gets no actual sets/weights -- only a joined invitee ever did');
  const total = Object.values(view.logCounts || {}).reduce((n, per) => n + Object.values(per).reduce((a, b) => a + b, 0), 0);
  ok(total === 1, `the deciding viewer CAN now see that someone already started -- one set counted, no weight (got logCounts=${JSON.stringify(view.logCounts)})`);
  ok(!/\b225\b/.test(JSON.stringify(view)), 'and the actual weight (225) is nowhere in the response -- counts only, same privacy posture as a direct invite');
}

console.log('\n5. Settings -> Starting weights: the Reps placeholder no longer looks like a filled-in value');
{
  // Client-side-only fix (public/app.js, renderSeedSetup) -- no server route involved, so this
  // checks the shipped markup/source directly rather than through the API. A bare "1" placeholder
  // on an EMPTY field renders visually identical to an actually-typed 1 rep; Weight's own
  // placeholder right next to it ("e.g. 185") never had this problem because "e.g." unambiguously
  // reads as a hint. Reps now matches that same convention instead of swapping in a different bare
  // number that would have the identical flaw.
  const src = readFileSync(join(CWD, 'public/app.js'), 'utf8');
  ok(!/id="seedR\$\{i\}"[^>]*placeholder="1"/.test(src), 'the Reps field no longer uses a bare "1" placeholder');
  ok(/id="seedR\$\{i\}"[^>]*placeholder="e\.g\. \d+"/.test(src), 'it now uses an "e.g. N" hint, matching the Weight field\'s own convention right beside it');
}

console.log('\n6. Followers/Following: the list comes back alphabetical, and the client ships a search box to filter it');
{
  const host = await reg('b9fhost');
  // Deliberately out of both insertion order AND alphabetical order -- "Zed" followed first, "amy"
  // (lowercase, to also prove the sort is case-insensitive) followed last -- so a passing sort can
  // only be explained by an actual sort, never by accidentally matching insertion order.
  const zed = await reg('b9fZed'), mike = await reg('b9fMike'), amy = await reg('b9famy');
  for (const u of [zed, mike, amy]) await post('/api/follow/' + host.id, {}, u.token);

  const followers = await get(`/api/profile/${host.id}/followers`, host.token);
  const names = followers.map(u => u.displayName || u.username);
  const sortedNames = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  ok(JSON.stringify(names) === JSON.stringify(sortedNames), `followers come back alphabetically (case-insensitive), not in follow order (got ${JSON.stringify(names)})`);

  // The search box itself is a client-side filter over the already-fetched list (public/app.js) --
  // no server route backs it, so this checks the shipped source for the pieces that make it work:
  // the input wired to a filter function, and that filter function actually narrowing by name/
  // username against the cached list rather than, say, being dead code.
  const src = readFileSync(join(CWD, 'public/app.js'), 'utf8');
  ok(/id="flSearch"[^>]*oninput="followListFilter\(\)"/.test(src), 'followList() renders a search input wired to followListFilter()');
  ok(/function followListFilter\(\)\{[\s\S]{0,400}FOLLOW_LIST_CACHE\.filter/.test(src), 'followListFilter() actually filters the cached list (not a no-op)');
  ok(/x\.displayName[\s\S]{0,40}\.includes\(q\)[\s\S]{0,40}x\.username[\s\S]{0,40}\.includes\(q\)/.test(src), 'the filter matches on both display name and @username, same as every other person-search box in the app');

  // Cold-review catch: followList() now caches its fetched list in FOLLOW_LIST_CACHE for the
  // search box above to filter -- without a staleness guard, opening profile A's list then
  // quickly navigating to profile B's list before A's slower fetch resolves let A's response land
  // last and silently overwrite both the DOM and FOLLOW_LIST_CACHE out from under whatever B's
  // screen was showing. Same "capture the epoch before the await, bail if something else happened
  // since" pattern every other async-render function in this file uses (nothingNavigatedSince).
  const fnIdx = src.indexOf('async function followList(id, kind, opts){');
  ok(fnIdx !== -1, 'followList() found in shipped source');
  const fnBody = src.slice(fnIdx, fnIdx + 1800);
  ok(/const epoch = UI_EPOCH;[\s\S]{0,200}await H\.get/.test(fnBody), 'followList() captures its own epoch before the fetch');
  ok(/await H\.get\(`\/api\/profile\/\$\{id\}\/\$\{kind\}`\);[\s\S]{0,900}if\(!nothingNavigatedSince\(epoch\)\) return;/.test(fnBody), 'and bails out before rendering (or touching FOLLOW_LIST_CACHE) if something else was navigated to in the meantime');
}

console.log('\n7. Activity feed: several same-day "started following" events now group into one line instead of one per follow');
{
  // Pure client-side logic (friends(), public/app.js) with no server route behind it -- evaluates
  // the REAL shipped functions extracted from source (not a reimplementation of the grouping rule),
  // same "extract + new Function" approach as seedRemoveRow's removeFn in test/seed-your-lifts.mjs,
  // just with balanced-brace extraction since these two function bodies are much larger.
  const src = readFileSync(join(CWD, 'public/app.js'), 'utf8');
  const extractBalanced = (s, openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(openIdx, i + 1); }
    }
    throw new Error('unbalanced braces');
  };
  const startOfDayMatch = src.match(/function startOfDay\(x\)\{[^}]*\}/);
  ok(!!startOfDayMatch, 'startOfDay() found in shipped source');
  const groupMarker = 'const groupFollowItems = list => ';
  const gIdx = src.indexOf(groupMarker);
  ok(gIdx !== -1, 'groupFollowItems() found in shipped source (public/app.js, friends())');
  const groupBody = extractBalanced(src, gIdx + groupMarker.length);
  const groupFollowItems = new Function(startOfDayMatch[0] + `; return (list => ${groupBody})(arguments[0]);`);

  const day1 = '2026-10-09T10:00:00.000Z', day1Later = '2026-10-09T18:00:00.000Z', day2 = '2026-10-08T10:00:00.000Z';
  const feed = [
    { type: 'started_following', by: 'u1', targetId: 't1', targetName: 'Alice', text: 'started following Alice', at: day1 },
    { type: 'started_following', by: 'u1', targetId: 't2', targetName: 'Bob', text: 'started following Bob', at: day1Later },
    { type: 'started_following', by: 'u1', targetId: 't3', targetName: 'Carol', text: 'started following Carol', at: day1 },
    { type: 'started_following', by: 'u2', targetId: 't4', targetName: 'Dee', text: 'started following Dee', at: day1 }, // different actor, same day -- own group
    { type: 'started_following', by: 'u1', targetId: 't5', targetName: 'Eve', text: 'started following Eve', at: day2 }, // same actor, different day -- own group
    { type: 'recap', sessionId: 's1', by: 'u1', at: day1, text: 'posted a workout' }, // not this type at all -- must pass straight through
  ];
  const grouped = groupFollowItems(feed);
  ok(grouped.length === 4, `6 raw events collapse to 4 rows -- 3 real groups (u1/day1, u2/day1, u1/day2) plus the untouched recap (got ${grouped.length})`);
  const u1day1 = grouped.find(g => g.type === 'started_following' && g.by === 'u1' && g._followGroup && g._followGroup.length === 3);
  ok(!!u1day1, `u1's three same-day follows (Alice, Bob, Carol) landed in one group of 3 (got ${JSON.stringify(grouped.filter(g=>g.type==='started_following').map(g=>({by:g.by, n:g._followGroup?g._followGroup.length:1})))})`);
  ok(!!u1day1 && u1day1._followGroup[0].targetName === 'Alice' && u1day1._followGroup[2].targetName === 'Bob', `the group is chronologically ordered, earliest first (Bob, logged latest at 6pm, sorts last) (got ${JSON.stringify((u1day1&&u1day1._followGroup||[]).map(g=>g.targetName))})`);
  const u2 = grouped.find(g => g.type === 'started_following' && g.by === 'u2');
  ok(!!u2 && (!u2._followGroup || u2._followGroup.length === 1), 'a different actor on the same day gets their own, ungrouped row -- grouping is per-actor, not global to the day');
  const u1day2 = grouped.find(g => g.type === 'started_following' && g.by === 'u1' && g.targetName === 'Eve');
  ok(!!u1day2 && (!u1day2._followGroup || u1day2._followGroup.length === 1), "the same actor following someone on a DIFFERENT day is not folded into the other day's group");
  ok(grouped.some(g => g.type === 'recap'), 'a non-started_following item (recap) passes through completely untouched');

  // The label itself (the text actually shown once grouped) -- same extraction approach, against
  // the real ternary from compactRowHtml's started_following branch.
  const labelMatch = src.match(/const label = names\.length <= 2[\s\S]*?others`;/);
  ok(!!labelMatch, 'the grouped-row label-building logic is found in shipped source (compactRowHtml)');
  const buildLabel = new Function('names', labelMatch[0] + ' return label;');
  ok(buildLabel(['Alice']) === 'Alice', 'a lone name (should never actually reach here grouped, but) renders plainly');
  ok(buildLabel(['Alice','Bob']) === 'Alice and Bob', 'two names: "Alice and Bob"');
  ok(buildLabel(['Alice','Bob','Carol']) === 'Alice, Bob and Carol', 'three names: "Alice, Bob and Carol" -- no trailing Oxford comma, no "others"');
  ok(buildLabel(['Alice','Bob','Carol','Dee','Eve']) === 'Alice, Bob and 3 others', 'five names collapse to "Alice, Bob and 3 others" instead of listing every name');
}

console.log('\n8. Progress: a muscle group abandoned MORE than 3 months ago no longer flags "Behind target" forever');
{
  // Same lift used for both the long-ago touch and the recent under-target weeks so no OTHER
  // muscle gets dragged in by accident (chest primary, triceps/shoulders secondary -- same note
  // test/progress-additions.mjs's own "never trained" block makes). mkSession below mirrors that
  // file's logSession/dateInWeek helpers exactly (same UTC-Monday bucket math as volumeTrendFor),
  // rebuilt locally since this file boots its own separate server+DB.
  const mondayUTC = d => { const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7)); return m; };
  const THIS_MONDAY = mondayUTC(new Date());
  const dateInWeek = (weeksAgo, dayOffset = 1) => { const d = new Date(THIS_MONDAY); d.setUTCDate(d.getUTCDate() - weeksAgo * 7 + dayOffset); d.setUTCHours(15, 0, 0, 0); return d.toISOString(); };
  const mkSession = async (u, scheduledAt) => {
    const s = await post('/api/sessions', { name: 'Chest', visibility: 'private', scheduledAt, exercises: [{ name: 'Flat Barbell Bench Press' }] }, u.token);
    await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 135, reps: 8, setType: 'normal' }, u.token);
    return s;
  };

  const u = await reg('b9abandon');
  // The ONLY chest touch this account has, ever: old enough to satisfy the account-age gate
  // (firstLogDateFor) but, the actual point of this test, more than 13 weeks (3 months) before
  // "now" -- outside recentlyTrainedMusclesFor's own window. Nothing at all is logged for chest in
  // the last 2 completed weeks (byGroup2/byGroup1 both default to 0), the exact "under target both
  // weeks" shape that flags -- for a muscle that's actually recentlyTrained.
  await mkSession(u, dateInWeek(20, 1));
  const prog = await get('/api/progress', u.token);
  const flaggedNames = (prog.muscleBalance.groups || []).map(g => g.group);
  ok(!flaggedNames.includes('chest'), `chest is NOT flagged -- its only touch ever (20 weeks ago) is outside the 3-month recency window, so 0 recent sets now reads the same as never having trained it at all, even though the old all-time check would have flagged it (got ${JSON.stringify(flaggedNames)})`);

  // Sanity, same account: a muscle touched INSIDE the 3-month window (here, within the last 2
  // completed weeks themselves) still flags normally -- this fix narrows the window, it doesn't
  // break the flag itself.
  const u2 = await reg('b9recent');
  await mkSession(u2, dateInWeek(6, 1)); // old enough for the account-age gate, well within 3 months
  for (let i = 0; i < 2; i++) await mkSession(u2, dateInWeek(2, i));
  for (let i = 0; i < 2; i++) await mkSession(u2, dateInWeek(1, i));
  const prog2 = await get('/api/progress', u2.token);
  const flagged2 = (prog2.muscleBalance.groups || []).map(g => g.group);
  ok(flagged2.includes('chest'), `sanity: chest genuinely under target in the last 2 weeks, and recently trained (6 weeks ago, inside the 3-month window) -- still flags exactly as before this fix (got ${JSON.stringify(flagged2)})`);

  // Cold-review catch: recentlyTrainedMusclesFor needs an UPPER bound too, not just a lower one --
  // matching volumeFor's own `at < a || at >= b`. Without it, a session SCHEDULED IN THE FUTURE
  // that already has a real logged set (reachable: accept an invite and log immediately, well
  // before its own scheduledAt -- see fix #3's own comment on markSessionStarted for exactly this
  // shape) counted as "recently trained" with no cutoff, flagging a muscle "Behind target" even
  // though this same screen's own volume3mo number correctly shows 0 sets for it -- a direct
  // on-screen contradiction.
  const u3 = await reg('b9future');
  // Old-enough padding log on a DIFFERENT muscle (quads/glutes via squat), purely to satisfy the
  // account-age gate -- chest's only touch on this account is the future-dated one below.
  const pad = await post('/api/sessions', { name: 'Legs', visibility: 'private', scheduledAt: dateInWeek(6, 1), exercises: [{ name: 'Barbell Back Squat' }] }, u3.token);
  await post(`/api/sessions/${pad.id}/log`, { exerciseId: pad.exercises[0].id, weight: 185, reps: 5, setType: 'normal' }, u3.token);
  const future = await post('/api/sessions', { name: 'Not Yet', visibility: 'private', scheduledAt: new Date(Date.now() + 11 * 86400000).toISOString(), exercises: [{ name: 'Flat Barbell Bench Press' }] }, u3.token);
  await post(`/api/sessions/${future.id}/log`, { exerciseId: future.exercises[0].id, weight: 135, reps: 8, setType: 'normal' }, u3.token);
  const prog3 = await get('/api/progress', u3.token);
  const chestVol3mo = (prog3.volume3mo.groups || []).find(g => g.group === 'chest');
  ok(chestVol3mo && chestVol3mo.sets === 0, `sanity: volume3mo correctly excludes the future-dated set -- 0 chest sets (got ${JSON.stringify(chestVol3mo)})`);
  const flagged3 = (prog3.muscleBalance.groups || []).map(g => g.group);
  ok(!flagged3.includes('chest'), `chest is NOT flagged -- its only logged set is on a session scheduled 11 days from now, which recentlyTrainedMusclesFor must exclude the same way volume3mo already does (got ${JSON.stringify(flagged3)})`);
}

console.log('\n9. Notifications: every pending-action section comes back newest-first, not in whatever order the underlying sessions/templates happen to be stored');
{
  const host = await reg('b9nhost');
  // Three separate sessions, created in this exact order (so Object.values(DB.sessions) iterates
  // them oldest-session-first) -- but invited/requested/proposed on in the OPPOSITE order, so a
  // passing "newest-first" result can only be explained by a real timestamp sort, never by
  // accidentally matching session-creation order.
  const alice = await reg('b9nAlice'), bob = await reg('b9nBob'), carol = await reg('b9nCarol');
  await follow(host, alice); await follow(alice, host);
  await follow(host, bob); await follow(bob, host);
  await follow(host, carol); await follow(carol, host);

  const sOld = await post('/api/sessions', { name: 'Old', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }] }, host.token);
  const sMid = await post('/api/sessions', { name: 'Mid', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }] }, host.token);
  const sNew = await post('/api/sessions', { name: 'New', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }] }, host.token);
  // Invite carol (on the OLDEST session) LAST, bob (mid) second, alice (newest session) first --
  // the exact reverse of session-creation order.
  await put(`/api/sessions/${sNew.id}`, { name: 'New', exercises: sNew.exercises, inviteUsernames: ['b9nAlice'] }, host.token);
  await put(`/api/sessions/${sMid.id}`, { name: 'Mid', exercises: sMid.exercises, inviteUsernames: ['b9nBob'] }, host.token);
  await put(`/api/sessions/${sOld.id}`, { name: 'Old', exercises: sOld.exercises, inviteUsernames: ['b9nCarol'] }, host.token);

  const viewAlice = (await get(`/api/notifications`, alice.token)).invites;
  const viewBob = (await get(`/api/notifications`, bob.token)).invites;
  const viewCarol = (await get(`/api/notifications`, carol.token)).invites;
  ok(viewAlice.length === 1 && viewAlice[0].sessionName === 'New', `alice's invite (session created first, but invited LAST) still shows (got ${JSON.stringify(viewAlice)})`);
  ok(viewBob.length === 1 && viewBob[0].sessionName === 'Mid', 'sanity: bob sees his own invite too');
  ok(viewCarol.length === 1 && viewCarol[0].sessionName === 'Old', 'sanity: carol (session created first, invited first) sees her own invite too');

  // The real test: host invites all three to a FOURTH session in one shot (so there's a single
  // viewer -- host -- whose own invites array can't help since it only ever has what others sent
  // THEM); to actually see cross-session ordering from one viewer, check the JOIN REQUESTS section
  // instead, which every one of alice/bob/carol can file against the SAME session in a controlled
  // order.
  const s2 = await post('/api/sessions', { name: 'Open Gym', visibility: 'public', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Deadlift' }] }, host.token);
  await post(`/api/sessions/${s2.id}/join`, {}, carol.token);  // requests, oldest
  await post(`/api/sessions/${s2.id}/join`, {}, bob.token);    // mid
  await post(`/api/sessions/${s2.id}/join`, {}, alice.token);  // newest
  const hostJoinReqs = (await get('/api/notifications', host.token)).joinRequests;
  const names = hostJoinReqs.map(j => j.from.username);
  ok(JSON.stringify(names) === JSON.stringify(['b9nAlice', 'b9nBob', 'b9nCarol']), `join requests come back newest-first (alice last to request, shows first) (got ${JSON.stringify(names)})`);
  ok(hostJoinReqs.every(j => !('_at' in j)), `the internal sort-scaffolding field (_at) never leaks into the response (got keys: ${JSON.stringify(hostJoinReqs.map(j => Object.keys(j)))})`);

  // And the inverse: approve carol's (oldest) request so it drops out, confirming the remaining
  // two keep their own relative recency order rather than the sort being a one-time fluke.
  const carolReqId = hostJoinReqs.find(j => j.from.username === 'b9nCarol').reqId;
  await post(`/api/sessions/${s2.id}/join/${carolReqId}/approve`, {}, host.token);
  const after = (await get('/api/notifications', host.token)).joinRequests.map(j => j.from.username);
  ok(JSON.stringify(after) === JSON.stringify(['b9nAlice', 'b9nBob']), `after carol's request is resolved, the remaining two still read newest-first (got ${JSON.stringify(after)})`);

  // Cold-review catch: declining an invite deletes s.invitedBy[userId] (Sep 24 2026 fix) but, until
  // this correction, left the NEW invitedAt entry behind -- so re-inviting the same person to the
  // SAME session later kept the ORIGINAL (now-stale) timestamp forever, sorting a genuinely-just-
  // now re-invite as if it were old. Decline, wait, get invited to something else, THEN get
  // re-invited to the original session -- the re-invite (chronologically last) must sort first.
  const dee = await reg('b9ndee');
  await follow(host, dee); await follow(dee, host);
  const sFirst = await post('/api/sessions', { name: 'First', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Squat' }], inviteUsernames: ['b9ndee'] }, host.token);
  await post(`/api/sessions/${sFirst.id}/decline`, {}, dee.token);
  await new Promise(r => setTimeout(r, 15));
  const sSecond = await post('/api/sessions', { name: 'Second', visibility: 'private', scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bench Press' }], inviteUsernames: ['b9ndee'] }, host.token);
  await new Promise(r => setTimeout(r, 15));
  await put(`/api/sessions/${sFirst.id}`, { name: 'First', exercises: sFirst.exercises, inviteUsernames: ['b9ndee'] }, host.token); // re-invite, genuinely last
  const deeInvites = (await get('/api/notifications', dee.token)).invites;
  const deeNames = deeInvites.map(i => i.sessionName);
  ok(JSON.stringify(deeNames) === JSON.stringify(['First', 'Second']), `the re-invite to "First" (chronologically the LAST real invite action, after declining and a fresh invite to "Second" in between) sorts first, not stuck at its stale original invitedAt (got ${JSON.stringify(deeNames)})`);
}

console.log('\n10. RIR: a one-time explainer the first time this account ever taps the RIR toggle, never again');
{
  const u = await reg('b9rir');
  const before = await get('/api/profile/me', u.token);
  ok(before.seenRirExplainer === false, `brand-new account starts unseen (got ${JSON.stringify(before.seenRirExplainer)})`);

  const marked = await post('/api/me/rir-explainer-seen', {}, u.token);
  ok(marked.seenRirExplainer === true, `the mark-seen route echoes true (got ${JSON.stringify(marked)})`);
  const after = await get('/api/profile/me', u.token);
  ok(after.seenRirExplainer === true, `GET /api/profile/me now reports it seen, account-wide (got ${after.seenRirExplainer})`);

  // One-way: calling it again (e.g. a second device/session hitting the same race) is a harmless
  // no-op, same "idempotent, never flips back to false" shape as every other seen-flag in this app.
  const again = await post('/api/me/rir-explainer-seen', {}, u.token);
  ok(again.seenRirExplainer === true, 'calling it again is a harmless no-op, not an error');

  // Self-only, same privacy posture as trainingPhase/defaultGym/notify prefs right next to it in
  // profileOf -- a viewer looking at someone ELSE's profile never gets this field at all.
  const other = await reg('b9rirviewer');
  const otherView = await get(`/api/profile/${u.id}`, other.token);
  ok(otherView.seenRirExplainer === undefined, `another viewer's look at this profile carries no seenRirExplainer at all (got ${JSON.stringify(otherView.seenRirExplainer)})`);
}

console.log('\n10b. RIR explainer: the client only shows it before the FIRST reveal, and reuses the real toggle/sheet machinery (not a reimplementation)');
{
  const src = readFileSync(join(CWD, 'public/app.js'), 'utf8');
  ok(/if\(ME && !ME\.seenRirExplainer\)\{ showRirExplainer\(reveal\); return; \}/.test(src), 'toggleRirInput() gates on the real account flag before ever calling showRirExplainer');
  ok(/function showRirExplainer\(onDone\)\{/.test(src), 'showRirExplainer() exists');
  const sIdx = src.indexOf('function showRirExplainer(onDone){');
  const showBody = src.slice(sIdx, sIdx + 700);
  ok(/H\.post\('\/api\/me\/rir-explainer-seen'/.test(showBody), 'showRirExplainer() actually calls the real mark-seen route, not a stub');
  ok(/ME\.seenRirExplainer = true/.test(showBody), 'showRirExplainer() updates the in-memory ME immediately (optimistic), so a second tap in the same session never re-shows it even before the network call resolves');
  ok(/SHEET_CANCEL_CB = onDone/.test(showBody), 'the reveal callback is wired through SHEET_CANCEL_CB, the same shared mechanism confirmSheet uses -- so dismissing via backdrop or Back still reveals the input, not just the "Got it" tap');
}

await testDb.drop();
try { srv.kill(); } catch {}
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
