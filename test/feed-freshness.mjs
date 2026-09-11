// Home's Friends' Activity ("/api/feed") pulls PRs straight out of DB.prs[fid] — each friend's
// all-time best PER EXERCISE, which by design never expires (that's what a Personal Record IS;
// it stays on the Progress page forever). Without a recency filter on the FEED specifically, an
// exercise a friend maxed out months ago sits at the top of "what's going on" forever, right next
// to this week's real news. buildActivityFor() (a profile's own "Recent Activity") already scoped
// its PRs to the last week — this test locks in that /api/feed now agrees with it, instead of the
// two silently drifting apart. "completed" and "streak" are not tested here: neither accumulates
// (one is a rolling weekly count, the other is a live current-streak value), so there was nothing
// to age out.
//
// Jeff, Aug 19: "Should we put a date limit on the friend's activity... these items don't leave
// this list and it will just grow and grow over time. The PRs get held in the progress page."
//
// Ported to the Postgres-backed test harness (Aug 2026 data-layer migration) — the original
// version predates that migration and booted the server on DATA_DIR alone; server.js now
// requires DATABASE_URL unconditionally. No assertions changed, just how the server boots.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = 4997, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'feed-fresh-'));
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('feedfresh');
let srv, fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const H = t => ({ ...J, Authorization: 'Bearer ' + t });
const post = (p, b, t) => fetch(B + p, { method: 'POST', headers: t ? H(t) : J, body: JSON.stringify(b) });
const put  = (p, b, t) => fetch(B + p, { method: 'PUT', headers: t ? H(t) : J, body: JSON.stringify(b) });
const get  = (p, t) => fetch(B + p, { headers: H(t) });
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

await new Promise(res => {
  srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
  setTimeout(res, 8000);
});

const alice = await post('/api/register', { username: 'alice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());
const bob   = await post('/api/register', { username: 'bob',   pin: 'pass1234', displayName: 'Bob' }).then(r => r.json());
await post('/api/follow/' + bob.user.id, {}, alice.token);
await post('/api/follow-requests/' + alice.user.id + '/accept', {}, bob.token);
await post('/api/follow/' + alice.user.id, {}, bob.token);
await post('/api/follow-requests/' + bob.user.id + '/accept', {}, alice.token);

console.log('\na PR older than a week does not haunt the friends feed forever');
{
  // Aug 21: an exercise's first-ever outing is now a baseline, not a celebrated PR (see
  // rebuildAllPrs in server.js), so each lift below needs an earlier session to actually BEAT —
  // otherwise neither would ever reach the feed at all, for a different reason than the one this
  // test is checking (age), and the assertions below would pass for the wrong cause.
  const veryOld = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
  const baselineSess = await post('/api/sessions', { name: 'Baseline Leg Day', visibility: 'private',
    scheduledAt: veryOld, exercises: [{ name: 'Deadlift' }], inviteUsernames: ['bob'] }, alice.token).then(r => r.json());
  await post(`/api/sessions/${baselineSess.id}/accept`, {}, bob.token);
  await post(`/api/sessions/${baselineSess.id}/log`, { exerciseId: baselineSess.exercises[0].id, weight: 275, reps: 3, set: 1 }, bob.token);

  const oldSess = await post('/api/sessions', { name: 'Old Leg Day', visibility: 'private',
    scheduledAt: old, exercises: [{ name: 'Deadlift' }], inviteUsernames: ['bob'] }, alice.token).then(r => r.json());
  await post(`/api/sessions/${oldSess.id}/accept`, {}, bob.token);
  await post(`/api/sessions/${oldSess.id}/log`, { exerciseId: oldSess.exercises[0].id, weight: 315, reps: 3, set: 1 }, bob.token);

  const earlier = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const earlierSess = await post('/api/sessions', { name: 'Earlier Back Day', visibility: 'private',
    scheduledAt: earlier, exercises: [{ name: 'Bent-Over Row' }], inviteUsernames: ['bob'] }, alice.token).then(r => r.json());
  await post(`/api/sessions/${earlierSess.id}/accept`, {}, bob.token);
  await post(`/api/sessions/${earlierSess.id}/log`, { exerciseId: earlierSess.exercises[0].id, weight: 155, reps: 5, set: 1 }, bob.token);

  const recentSess = await post('/api/sessions', { name: 'Back Day', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bent-Over Row' }], inviteUsernames: ['bob'] }, alice.token).then(r => r.json());
  await post(`/api/sessions/${recentSess.id}/accept`, {}, bob.token);
  await post(`/api/sessions/${recentSess.id}/log`, { exerciseId: recentSess.exercises[0].id, weight: 185, reps: 5, set: 1 }, bob.token);

  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const prItems = feed.filter(f => f.type === 'pr');
  ok(!prItems.some(f => /Deadlift/.test(f.text)), `the 20-day-old Deadlift PR is gone from the feed (saw: ${prItems.map(f=>f.text).join(' | ')})`);
  ok(prItems.some(f => /Bent-Over Row/.test(f.text)), 'this week\'s Bent-Over Row PR still shows');

  const profile = await get(`/api/profile/${bob.user.id}`, bob.token).then(r => r.json());
  const prNames = (profile.prs || []).map(p => p.exercise);
  ok(prNames.includes('Deadlift') && prNames.includes('Bent-Over Row'),
    `both PRs still live on Bob's Progress page permanently — the feed filter never touched DB.prs (saw: ${prNames.join(', ')})`);
}

console.log('\na brand-new user\'s first workout does not flood a friend\'s feed with "PRs"');
// declared outside the block — Carl is reused by the two collapsing tests further down, which
// need his baseline lifts already in place to have something real left to beat.
let carl;
{
  // Jeff, Aug 21: "every new first rep will be considered a PR" — a new user's very first session,
  // trying several exercises for the first time each, used to post one "hit a new PR" item per
  // exercise. None of them has beaten anything yet, so none of them should reach the feed.
  carl = await post('/api/register', { username: 'carl', pin: 'pass1234', displayName: 'Carl' }).then(r => r.json());
  await post('/api/follow/' + carl.user.id, {}, alice.token);
  await post('/api/follow-requests/' + alice.user.id + '/accept', {}, carl.token);
  await post('/api/follow/' + alice.user.id, {}, carl.token);
  await post('/api/follow-requests/' + carl.user.id + '/accept', {}, alice.token);

  const firstSess = await post('/api/sessions', { name: 'First Session Ever', visibility: 'private',
    scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Back Squat' }, { name: 'Bench Press' }, { name: 'Pull-Up' }],
    inviteUsernames: [] }, carl.token).then(r => r.json());
  await post(`/api/sessions/${firstSess.id}/log`, { exerciseId: firstSess.exercises[0].id, weight: 135, reps: 8, set: 1 }, carl.token);
  await post(`/api/sessions/${firstSess.id}/log`, { exerciseId: firstSess.exercises[1].id, weight: 95, reps: 8, set: 1 }, carl.token);
  await post(`/api/sessions/${firstSess.id}/log`, { exerciseId: firstSess.exercises[2].id, weight: 0, reps: 6, set: 1 }, carl.token);

  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const carlPrs = feed.filter(f => f.type === 'pr' && f.by === carl.user.id);
  ok(carlPrs.length === 0, `zero "PR" feed items from Carl's first-ever session (saw: ${carlPrs.map(f=>f.text).join(' | ') || 'none'})`);

  // and Carl's own profile still lists all three as his current best, just not as "beaten" records
  const carlProfile = await get(`/api/profile/${carl.user.id}`, carl.token).then(r => r.json());
  const carlPrNames = (carlProfile.prs || []).map(p => p.exercise);
  ok(['Back Squat', 'Bench Press', 'Pull-Up'].every(n => carlPrNames.includes(n)),
    `but all three still show as his current bests on his own profile (saw: ${carlPrNames.join(', ')})`);
  ok((carlProfile.prs || []).every(p => p.firstLog === true), 'each flagged firstLog, not an earned record');
}

console.log('\nSep 11 2026 (Activity page redesign): multiple real PRs from one friend in a week are now SEPARATE, individually-likeable feed items, not one collapsed line');
{
  // Pre-redesign this collapsed into one grouped line (see git history) -- the whole point of the
  // Activity page rebuild is per-item likes, so each PR needs its OWN feed event/id to react to.
  // Reuses Carl from above, whose Back Squat / Bench Press / Pull-Up baselines are now beatable.
  const beatSess = await post('/api/sessions', { name: 'Second Session', visibility: 'private',
    scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Back Squat' }, { name: 'Bench Press' }, { name: 'Pull-Up' }],
    inviteUsernames: [] }, carl.token).then(r => r.json());
  await post(`/api/sessions/${beatSess.id}/log`, { exerciseId: beatSess.exercises[0].id, weight: 155, reps: 8, set: 1 }, carl.token);
  await post(`/api/sessions/${beatSess.id}/log`, { exerciseId: beatSess.exercises[1].id, weight: 105, reps: 8, set: 1 }, carl.token);
  await post(`/api/sessions/${beatSess.id}/log`, { exerciseId: beatSess.exercises[2].id, weight: 0, reps: 8, set: 1 }, carl.token);

  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const carlPrItems = feed.filter(f => f.type === 'pr' && f.by === carl.user.id);
  ok(carlPrItems.length === 3, `three real PRs are three separate feed items, not collapsed (saw ${carlPrItems.length})`);
  ok(carlPrItems.every(f => f.id), 'every PR item carries its own id, so each can be liked independently');
  const names = carlPrItems.map(f => f.exerciseName).sort();
  ok(JSON.stringify(names) === JSON.stringify(['Back Squat', 'Bench Press', 'Pull-Up']),
    `each item is attributed to the right exercise (saw: ${names.join(', ')})`);
  ok(carlPrItems.every(f => Array.isArray(f.reactions) && f.reactCount === 0 && f.reacted === false),
    'each starts with zero reactions, ready to be liked');

  // Unchanged: buildActivityFor (a profile's own Recent Activity) is a DIFFERENT code path from
  // GET /api/feed and was not touched by this redesign -- it still collapses multiple PRs into
  // one grouped line there, same as before.
  const carlProfile = await get(`/api/profile/${carl.user.id}`, carl.token).then(r => r.json());
  const ownPrItems = (carlProfile.recentActivity || []).filter(a => a.type === 'pr');
  ok(ownPrItems.length === 1, `but Carl's own profile Recent Activity still collapses these — unchanged, different code path (saw ${ownPrItems.length})`);
}

console.log('\nreacting to one PR feed item does not affect a sibling PR item from the same workout');
{
  // Continues directly from the block above -- Carl's three fresh PR items are still in Alice's
  // feed. A real POST to the new generic feed-event reaction endpoint, toggled by Alice.
  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const carlPrItems = feed.filter(f => f.type === 'pr' && f.by === carl.user.id);
  const [first, second] = carlPrItems;
  const reactRes = await post(`/api/feed-events/${first.id}/react`, {}, alice.token).then(r => r.json());
  ok(reactRes.reacted === true && reactRes.count === 1, `liking the first PR item toggles it on (saw: ${JSON.stringify(reactRes)})`);

  const feed2 = await get('/api/feed', alice.token).then(r => r.json());
  const firstAfter = feed2.find(f => f.id === first.id);
  const secondAfter = feed2.find(f => f.id === second.id);
  ok(firstAfter && firstAfter.reacted === true && firstAfter.reactCount === 1, 'the liked item now shows reacted + count 1');
  ok(secondAfter && secondAfter.reacted === false && secondAfter.reactCount === 0, "the sibling PR item from the same workout is untouched");

  // Toggling again removes it.
  const unreactRes = await post(`/api/feed-events/${first.id}/react`, {}, alice.token).then(r => r.json());
  ok(unreactRes.reacted === false && unreactRes.count === 0, 'reacting again toggles it back off');
}

console.log('\nv239 recap rows: a friend\'s posted recap shows in the feed, thumbnail gated to own /uploads/, and visibility is respected');
{
  // Bob posts a recap on this week's Back Day with a photo already on disk (the /uploads/ path
  // shape is what a saved photo becomes; the ingest regex accepts it without re-writing a file).
  const sessions = await get('/api/sessions', bob.token).then(r => r.json());
  const backDay = sessions.find(s => s.name === 'Back Day');
  await post(`/api/sessions/${backDay.id}/post`, { notes: 'good pulls', visibility: 'public',
    media: [{ type: 'image', src: '/uploads/bobrecap.jpg' }] }, bob.token);
  let feed = await get('/api/feed', alice.token).then(r => r.json());
  const recap = feed.find(f => f.type === 'recap' && f.sessionId === backDay.id);
  ok(!!recap, "Bob's posted recap reaches Alice's feed as a recap row");
  ok(recap && recap.text === 'finished Back Day', `and it names the workout (saw: ${recap && recap.text})`);
  ok(recap && recap.thumb === '/uploads/bobrecap.jpg', 'the photo rides along as the thumbnail');
  ok(recap && recap.by === bob.user.id, 'attributed to Bob');
  ok(recap && recap.reactCount === 0 && recap.reacted === false, 'the recap carries its existing (unchanged) like count, starting at zero');

  // Sep 11 2026 (Activity page redesign): Bob finishing the SAME session he already posted a
  // recap for must NOT also produce a separate "completed a workout" row -- the real recap above
  // already covers it. This replaces the old aggregate "completed N workouts this week" summary
  // entirely (see emitFinishFeedEvents' completed_no_recap suppression in GET /api/feed).
  await post(`/api/sessions/${backDay.id}/lock`, {}, bob.token);
  feed = await get('/api/feed', alice.token).then(r => r.json());
  const supersededDone = feed.find(f => f.type === 'completed_no_recap' && f.sessionId === backDay.id);
  ok(!supersededDone, "finishing a session that already has a posted recap does not ALSO add a redundant 'completed' row");
  ok(feed.some(f => f.type === 'recap' && f.sessionId === backDay.id), 'the real recap row is still there');

  // A recap with no photo still gets a row, with no thumbnail to render.
  const earlierBack = sessions.find(s => s.name === 'Earlier Back Day');
  await post(`/api/sessions/${earlierBack.id}/post`, { notes: 'no pics', visibility: 'public', media: [] }, bob.token);
  feed = await get('/api/feed', alice.token).then(r => r.json());
  const bare = feed.find(f => f.type === 'recap' && f.sessionId === earlierBack.id);
  ok(!!bare && bare.thumb === null, 'a photo-less recap still rows up, thumb explicitly null');

  // v190 (Sep 2026): 'private' WIDENED from the old 'only_me' (strictly author-only) to admit the
  // creator and every participant of THAT session (see canSeePostAuthor in server.js) — the earlier
  // sessions in this file all have Alice as their CREATOR (she invited Bob into them), so posting
  // 'private' on one of THOSE would now correctly reach her, which is not what this block means to
  // test. A session Bob creates entirely on his own, with nobody else in it, is the case that still
  // proves a private recap never reaches an outside connection.
  const bobSolo = await post('/api/sessions', { name: 'Bob Solo Day', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Row' }], inviteUsernames: [] }, bob.token).then(r => r.json());
  await post(`/api/sessions/${bobSolo.id}/log`, { exerciseId: bobSolo.exercises[0].id, weight: 95, reps: 10, set: 1 }, bob.token);
  await post(`/api/sessions/${bobSolo.id}/post`, { notes: 'just for me', visibility: 'private', media: [] }, bob.token);
  feed = await get('/api/feed', alice.token).then(r => r.json());
  ok(!feed.some(f => f.type === 'recap' && f.sessionId === bobSolo.id),
    "a private recap on a workout Alice was never part of stays out of her feed even though it was posted seconds ago");
}

console.log("\nSep 11 2026: finishing a workout with NO recap shows a real 'completed a workout' row, which then disappears (superseded) once a recap is posted for that same session");
{
  // A fresh pair, isolated from everything the earlier blocks in this file already built.
  const gia = await post('/api/register', { username: 'gia9', pin: 'pass1234', displayName: 'Gia' }).then(r => r.json());
  const hank = await post('/api/register', { username: 'hank9', pin: 'pass1234', displayName: 'Hank' }).then(r => r.json());
  await post('/api/follow/' + hank.user.id, {}, gia.token);
  await post('/api/follow-requests/' + gia.user.id + '/accept', {}, hank.token);

  const sess = await post('/api/sessions', { name: 'No Recap Day', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Lat Pulldown' }], inviteUsernames: [] }, hank.token).then(r => r.json());
  await post(`/api/sessions/${sess.id}/log`, { exerciseId: sess.exercises[0].id, weight: 120, reps: 10, set: 1 }, hank.token);
  await post(`/api/sessions/${sess.id}/lock`, {}, hank.token);

  let feed = await get('/api/feed', gia.token).then(r => r.json());
  const doneRow = feed.find(f => f.type === 'completed_no_recap' && f.sessionId === sess.id);
  ok(!!doneRow, `a real 'completed' row shows for a finished workout with no recap yet (saw types from Hank: ${feed.filter(f=>f.by===hank.user.id).map(f=>f.type).join(', ') || 'none'})`);
  // Sep 11 2026 (Jeff, "worth changing"): names the actual session now -- several of these next to
  // each other used to be indistinguishable, all reading as the exact same "completed a workout".
  ok(doneRow && doneRow.text === 'completed No Recap Day', `and it names the real session (saw: ${doneRow && doneRow.text})`);
  ok(doneRow && !doneRow.hasOwnProperty('headline'), 'no hero-card fields on a plain completion -- that treatment is PR-only');

  // Hank posts a recap for that SAME session afterward -- the completed_no_recap row must vanish
  // (superseded), replaced by the real recap row, not shown alongside it as a duplicate.
  await post(`/api/sessions/${sess.id}/post`, { notes: 'good session', visibility: 'public', media: [] }, hank.token);
  feed = await get('/api/feed', gia.token).then(r => r.json());
  ok(!feed.some(f => f.type === 'completed_no_recap' && f.sessionId === sess.id),
    'once a recap is posted for it, the plain completion row is gone');
  ok(feed.some(f => f.type === 'recap' && f.sessionId === sess.id), 'replaced by the real recap row');
}

console.log("\nv247: a 'streak' row used to be stamped new Date().toISOString() (now), same bug v239 already fixed for 'completed' — a fresh recap posted afterward must still sort above it");
{
  // Both brand-new accounts, friended only to each other — /api/feed now caps at 40 items, and
  // Alice's feed is already crowded with everything the earlier blocks in this file built, which
  // would make ordering harder to read even without truncation risk. A clean pair sidesteps that.
  const faye = await post('/api/register', { username: 'faye', pin: 'pass1234', displayName: 'Faye' }).then(r => r.json());
  const dave = await post('/api/register', { username: 'dave', pin: 'pass1234', displayName: 'Dave' }).then(r => r.json());
  await post('/api/follow/' + dave.user.id, {}, faye.token);
  await post('/api/follow-requests/' + faye.user.id + '/accept', {}, dave.token);
  await post('/api/follow/' + faye.user.id, {}, dave.token);
  await post('/api/follow-requests/' + dave.user.id + '/accept', {}, faye.token);

  // Build a real 2-day streak via two real /lock calls with explicit localDate (v247's own new
  // mechanism), matching currentStreak's own UTC-day definition of "today"/"yesterday" rather than
  // reaching into the DB to fake it.
  const utcToday = new Date().toISOString().slice(0, 10);
  const utcYesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const y = await post('/api/sessions', { name: 'Streak Day One', visibility: 'private',
    scheduledAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), exercises: [{ name: 'Overhead Press' }],
    inviteUsernames: [] }, dave.token).then(r => r.json());
  await post(`/api/sessions/${y.id}/log`, { exerciseId: y.exercises[0].id, weight: 65, reps: 8, set: 1 }, dave.token);
  await post(`/api/sessions/${y.id}/lock`, { localDate: utcYesterday }, dave.token);

  const t = await post('/api/sessions', { name: 'Streak Day Two', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Overhead Press' }],
    inviteUsernames: [] }, dave.token).then(r => r.json());
  await post(`/api/sessions/${t.id}/log`, { exerciseId: t.exercises[0].id, weight: 70, reps: 8, set: 1 }, dave.token);
  await post(`/api/sessions/${t.id}/lock`, { localDate: utcToday }, dave.token);

  let feed = await get('/api/feed', faye.token).then(r => r.json());
  const streakItem = feed.find(f => f.type === 'streak' && f.by === dave.user.id);
  ok(!!streakItem, `Dave's streak row reached Faye's feed (saw: ${feed.filter(f=>f.by===dave.user.id).map(f=>f.type).join(', ') || 'nothing from Dave'})`);
  ok(streakItem && /hit a 2-day streak/.test(streakItem.text), `and names it correctly (saw: ${streakItem && streakItem.text})`);

  // Now Dave posts a recap seconds later — a genuinely fresher, real-timestamped event. If the
  // streak row were still stamped "now" at feed-build time, it would tie or beat this every time
  // the feed is re-requested; with the fix it carries the streak's actual last-trained day, always
  // in the past relative to a recap posted after it.
  await post(`/api/sessions/${t.id}/post`, { notes: 'felt strong', visibility: 'public', media: [] }, dave.token);
  feed = await get('/api/feed', faye.token).then(r => r.json());
  const iStreak = feed.findIndex(f => f.type === 'streak' && f.by === dave.user.id);
  const iRecap = feed.findIndex(f => f.type === 'recap' && f.sessionId === t.id);
  ok(iRecap !== -1 && iStreak !== -1 && iRecap < iStreak,
    `the fresh recap sorts above the streak row (recap at ${iRecap}, streak at ${iStreak})`);

  // And the profile's own Recent Activity gets the identical fix (buildActivityFor, not just the
  // friends feed) — same assertion, on Dave's own profile.
  const daveProfile = await get(`/api/profile/${dave.user.id}`, dave.token).then(r => r.json());
  const own = daveProfile.recentActivity || [];
  const iOwnStreak = own.findIndex(a => a.type === 'streak');
  ok(iOwnStreak !== -1, "Dave's own profile also shows the streak");
  // recentActivity has no recap rows (those are a feed-only, other-people-viewing concept), so
  // instead assert directly: the streak's own timestamp is not within the last few seconds.
  const streakAgeMs = Date.now() - new Date(own[iOwnStreak].at).getTime();
  ok(streakAgeMs > 5000, `the streak's own timestamp is the real training day, not "just now" (age ${streakAgeMs}ms)`);
}

console.log('\nSep 11 2026 cold-review fix: rank/challenge_started/joined_crew are CREW-scoped -- being connected to the actor is not enough, the viewer must actually be in that crew too (otherwise a dead crewView link, and an incidental leak of the crew\'s roster/challenge changes)');
{
  const ivy = await post('/api/register', { username: 'ivy11', pin: 'pass1234', displayName: 'Ivy' }).then(r => r.json());
  const jax = await post('/api/register', { username: 'jax11', pin: 'pass1234', displayName: 'Jax' }).then(r => r.json());
  const kim = await post('/api/register', { username: 'kim11', pin: 'pass1234', displayName: 'Kim' }).then(r => r.json());
  // Ivy follows Jax (connected), but is never put in Jax's crew with Kim.
  await post('/api/follow/' + jax.user.id, {}, ivy.token);
  await post('/api/follow-requests/' + ivy.user.id + '/accept', {}, jax.token);
  // Kim must already be a connection of Jax's to be added to his crew at all (validCrewMemberIds) --
  // that connection is what makes her the correct "positive" case below, not an extra setup step.
  await post('/api/follow/' + jax.user.id, {}, kim.token);
  await post('/api/follow-requests/' + kim.user.id + '/accept', {}, jax.token);

  const crew = await post('/api/crews', { name: 'Private Circle' }, jax.token).then(r => r.json());
  await put(`/api/crews/${crew.id}`, { memberIds: [kim.user.id] }, jax.token);
  await post(`/api/crews/${crew.id}/challenge`, { type: 'workouts', target: 10 }, jax.token);

  const ivyFeed = await get('/api/feed', ivy.token).then(r => r.json());
  ok(!ivyFeed.some(f => f.type === 'joined_crew' && f.crewId === crew.id),
    `Ivy (connected to Jax, but not in the crew) does not see Kim's joined_crew row (saw: ${ivyFeed.filter(f=>f.crewId===crew.id).map(f=>f.type).join(', ') || 'none'})`);
  ok(!ivyFeed.some(f => f.type === 'challenge_started' && f.crewId === crew.id), "...nor Jax's challenge_started row");

  // Kim, the actual fellow crew member, DOES see them -- nothing over-restricted by the fix.
  const kimFeed = await get('/api/feed', kim.token).then(r => r.json());
  ok(kimFeed.some(f => f.type === 'joined_crew' && f.crewId === crew.id && f.by === kim.user.id), "but Kim (an actual crew member) sees her own joined_crew row");
  ok(kimFeed.some(f => f.type === 'challenge_started' && f.crewId === crew.id), "...and the challenge_started row");
}

console.log('\nSep 11 2026 cold-review fix: joined_crew fires for FOUNDING members picked at crew CREATION, not only members added later via edit');
{
  const nia = await post('/api/register', { username: 'nia11', pin: 'pass1234', displayName: 'Nia' }).then(r => r.json());
  const omar = await post('/api/register', { username: 'omar11', pin: 'pass1234', displayName: 'Omar' }).then(r => r.json());
  await post('/api/follow/' + omar.user.id, {}, nia.token);
  await post('/api/follow-requests/' + nia.user.id + '/accept', {}, omar.token);

  const crew = await post('/api/crews', { name: 'Founding Crew', memberIds: [omar.user.id] }, nia.token).then(r => r.json());
  const feed = await get('/api/feed', omar.token).then(r => r.json());
  ok(feed.some(f => f.type === 'joined_crew' && f.crewId === crew.id && f.by === omar.user.id),
    `Omar, added as a FOUNDING member at creation (not via a later edit), still gets a real joined_crew row (saw his types: ${feed.filter(f=>f.by===omar.user.id).map(f=>f.type).join(', ') || 'none'})`);
}

console.log("\nSep 11 2026 cold-review fix: the streak feed event uses the CLIENT's local date, not server UTC (creditFinish/currentStreak already had it on hand -- emitFinishFeedEvents was the one call site not threading it through)");
{
  const liv = await post('/api/register', { username: 'liv11', pin: 'pass1234', displayName: 'Liv' }).then(r => r.json());
  const moe = await post('/api/register', { username: 'moe11', pin: 'pass1234', displayName: 'Moe' }).then(r => r.json());
  await post('/api/follow/' + moe.user.id, {}, liv.token);
  await post('/api/follow-requests/' + liv.user.id + '/accept', {}, moe.token);

  // Deliberately far-future, obviously CLIENT-supplied dates -- if this were still keying off
  // server "now" (a bug that only shows up for roughly half the globe at any given moment, so
  // easy to miss without forcing it), these two calendar days would never line up as consecutive
  // and the streak would never even reach 2.
  const dayOne = '2099-01-01', dayTwo = '2099-01-02';
  const s1 = await post('/api/sessions', { name: 'Client Date Day One', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Farmer Carry' }], inviteUsernames: [] }, moe.token).then(r => r.json());
  await post(`/api/sessions/${s1.id}/log`, { exerciseId: s1.exercises[0].id, weight: 40, reps: 10, set: 1 }, moe.token);
  await post(`/api/sessions/${s1.id}/lock`, { localDate: dayOne }, moe.token);

  const s2 = await post('/api/sessions', { name: 'Client Date Day Two', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Farmer Carry' }], inviteUsernames: [] }, moe.token).then(r => r.json());
  await post(`/api/sessions/${s2.id}/log`, { exerciseId: s2.exercises[0].id, weight: 40, reps: 10, set: 1 }, moe.token);
  await post(`/api/sessions/${s2.id}/lock`, { localDate: dayTwo }, moe.token);

  const feed = await get('/api/feed', liv.token).then(r => r.json());
  const streak = feed.find(f => f.type === 'streak' && f.by === moe.user.id);
  ok(!!streak, `a real streak fired off two client-local-dated finishes (saw Moe's types: ${feed.filter(f=>f.by===moe.user.id).map(f=>f.type).join(', ') || 'none'})`);
  ok(streak && streak.localDate === dayTwo, `the streak event's own localDate is the CLIENT's date (${dayTwo}), not server UTC "today" (saw: ${streak && streak.localDate})`);
}

console.log("\nSep 11 2026 cold-review fix: a completed_no_recap row is only superseded for a viewer who can actually SEE the recap that superseded it -- not for every viewer the moment ANY recap exists");
{
  const pia = await post('/api/register', { username: 'pia11', pin: 'pass1234', displayName: 'Pia' }).then(r => r.json());
  const quin = await post('/api/register', { username: 'quin11', pin: 'pass1234', displayName: 'Quin' }).then(r => r.json());
  await post('/api/follow/' + quin.user.id, {}, pia.token);
  await post('/api/follow-requests/' + pia.user.id + '/accept', {}, quin.token);

  const sess = await post('/api/sessions', { name: 'Solo Cardio', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Bike' }], inviteUsernames: [] }, quin.token).then(r => r.json());
  await post(`/api/sessions/${sess.id}/log`, { exerciseId: sess.exercises[0].id, weight: 0, reps: 20, set: 1 }, quin.token);
  await post(`/api/sessions/${sess.id}/lock`, {}, quin.token);

  let feed = await get('/api/feed', pia.token).then(r => r.json());
  ok(feed.some(f => f.type === 'completed_no_recap' && f.sessionId === sess.id), "Pia (a follower, not a participant) sees the plain completion before any recap exists");

  // Quin posts a PRIVATE recap on a session nobody else was in -- 'private' + solo means
  // author-only (canSeePostAuthor), so Pia still can't see it even though it now exists.
  await post(`/api/sessions/${sess.id}/post`, { notes: 'just for me', visibility: 'private', media: [] }, quin.token);
  feed = await get('/api/feed', pia.token).then(r => r.json());
  ok(feed.some(f => f.type === 'completed_no_recap' && f.sessionId === sess.id),
    "the fallback row must NOT disappear for Pia just because a recap now exists -- she still can't see it, so the workout must not vanish from her feed entirely");

  // Quin's own feed (her own activity) DOES get replaced by the real recap, unchanged from before.
  const quinFeed = await get('/api/feed', quin.token).then(r => r.json());
  ok(!quinFeed.some(f => f.type === 'completed_no_recap' && f.sessionId === sess.id), "but for Quin herself, the real recap she can see correctly supersedes it");
  ok(quinFeed.some(f => f.type === 'recap' && f.sessionId === sess.id), "...and her own recap row is there instead");
}

console.log("\nSep 11 2026 (Jeff, \"worth changing\"): a session that earns a real PR but never gets a posted recap shows only ONCE -- the PR's own hero card -- not also a separate, redundant 'completed a workout' row for the same workout");
{
  const rex = await post('/api/register', { username: 'rex11', pin: 'pass1234', displayName: 'Rex' }).then(r => r.json());
  const stu = await post('/api/register', { username: 'stu11', pin: 'pass1234', displayName: 'Stu' }).then(r => r.json());
  await post('/api/follow/' + stu.user.id, {}, rex.token);
  await post('/api/follow-requests/' + rex.user.id + '/accept', {}, stu.token);

  const base = await post('/api/sessions', { name: 'Baseline Row Day', visibility: 'private',
    scheduledAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(), exercises: [{ name: 'Cable Row' }], inviteUsernames: [] }, stu.token).then(r => r.json());
  await post(`/api/sessions/${base.id}/log`, { exerciseId: base.exercises[0].id, weight: 100, reps: 8, set: 1 }, stu.token);
  await post(`/api/sessions/${base.id}/lock`, {}, stu.token);

  const prSess = await post('/api/sessions', { name: 'Row Day', visibility: 'private',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Cable Row' }], inviteUsernames: [] }, stu.token).then(r => r.json());
  await post(`/api/sessions/${prSess.id}/log`, { exerciseId: prSess.exercises[0].id, weight: 120, reps: 8, set: 1 }, stu.token);
  await post(`/api/sessions/${prSess.id}/lock`, {}, stu.token);   // no recap posted -- PR only

  const feed = await get('/api/feed', rex.token).then(r => r.json());
  const stuItems = feed.filter(f => f.by === stu.user.id && f.sessionId === prSess.id);
  ok(stuItems.some(f => f.type === 'pr'), `the real PR row is there (saw Stu's types for this session: ${stuItems.map(f=>f.type).join(', ') || 'none'})`);
  ok(!stuItems.some(f => f.type === 'completed_no_recap'), "and the redundant 'completed a workout' row for that SAME session is suppressed by the PR, not shown alongside it");

  // On Stu's own profile too (his own Activity view of himself works the same way).
  const ownFeed = await get('/api/feed', stu.token).then(r => r.json());
  const ownItems = ownFeed.filter(f => f.by === stu.user.id && f.sessionId === prSess.id);
  ok(ownItems.some(f => f.type === 'pr') && !ownItems.some(f => f.type === 'completed_no_recap'), 'same on Stu\'s own view of his own feed');
}

console.log("\nSep 11 2026 (Jeff, \"worth changing\"): a completed_no_recap row's own timestamp is the workout's real scheduled date, not the literal moment /lock was called -- a backdated workout must not read as having JUST happened");
{
  const uma = await post('/api/register', { username: 'uma11', pin: 'pass1234', displayName: 'Uma' }).then(r => r.json());
  const finishesRealDate = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const backSess = await post('/api/sessions', { name: '', visibility: 'private',
    scheduledAt: finishesRealDate, exercises: [{ name: 'Face Pull' }], inviteUsernames: [] }, uma.token).then(r => r.json());
  await post(`/api/sessions/${backSess.id}/log`, { exerciseId: backSess.exercises[0].id, weight: 30, reps: 15, set: 1 }, uma.token);
  await post(`/api/sessions/${backSess.id}/lock`, {}, uma.token);   // real "now" -- 5 days after the workout's own scheduledAt

  const feed = await get('/api/feed', uma.token).then(r => r.json());
  const row = feed.find(f => f.type === 'completed_no_recap' && f.sessionId === backSess.id);
  ok(!!row, 'the backdated session still produces a real completed_no_recap row');
  ok(row && row.at === finishesRealDate, `and its 'at' is the workout's REAL scheduled date, not the moment /lock was called just now (saw: ${row && row.at}, expected: ${finishesRealDate})`);
  // A blank name is server-normalized to 'New workout' at creation (see capStr(...).trim() ||
  // 'New workout' in POST /api/sessions) -- so a session literally has no name to fall back FROM
  // in practice; the `s.name || 'a workout'` fallback in the emission just mirrors the recap row's
  // own defensive pattern for the same (currently unreachable) case, kept for consistency.
  ok(row && row.text === 'completed New workout', `a blank session name is server-normalized first (saw: ${row && row.text})`);
}

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
