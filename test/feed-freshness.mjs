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
const get  = (p, t) => fetch(B + p, { headers: H(t) });
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

await new Promise(res => {
  srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(); });
  setTimeout(res, 8000);
});

const alice = await post('/api/register', { username: 'alice', pin: 'pass1234', displayName: 'Alice' }).then(r => r.json());
const bob   = await post('/api/register', { username: 'bob',   pin: 'pass1234', displayName: 'Bob' }).then(r => r.json());
await post('/api/friends/request', { username: 'bob' }, alice.token);
await post('/api/friends/accept', { from: alice.user.id }, bob.token);

console.log('\na PR older than a week does not haunt the friends feed forever');
{
  // Aug 21: an exercise's first-ever outing is now a baseline, not a celebrated PR (see
  // rebuildAllPrs in server.js), so each lift below needs an earlier session to actually BEAT —
  // otherwise neither would ever reach the feed at all, for a different reason than the one this
  // test is checking (age), and the assertions below would pass for the wrong cause.
  const veryOld = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
  const baselineSess = await post('/api/sessions', { name: 'Baseline Leg Day', visibility: 'friends',
    scheduledAt: veryOld, exercises: [{ name: 'Deadlift' }], inviteUsernames: ['bob'] }, alice.token).then(r => r.json());
  await post(`/api/sessions/${baselineSess.id}/accept`, {}, bob.token);
  await post(`/api/sessions/${baselineSess.id}/log`, { exerciseId: baselineSess.exercises[0].id, weight: 275, reps: 3, set: 1 }, bob.token);

  const oldSess = await post('/api/sessions', { name: 'Old Leg Day', visibility: 'friends',
    scheduledAt: old, exercises: [{ name: 'Deadlift' }], inviteUsernames: ['bob'] }, alice.token).then(r => r.json());
  await post(`/api/sessions/${oldSess.id}/accept`, {}, bob.token);
  await post(`/api/sessions/${oldSess.id}/log`, { exerciseId: oldSess.exercises[0].id, weight: 315, reps: 3, set: 1 }, bob.token);

  const earlier = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const earlierSess = await post('/api/sessions', { name: 'Earlier Back Day', visibility: 'friends',
    scheduledAt: earlier, exercises: [{ name: 'Bent-Over Row' }], inviteUsernames: ['bob'] }, alice.token).then(r => r.json());
  await post(`/api/sessions/${earlierSess.id}/accept`, {}, bob.token);
  await post(`/api/sessions/${earlierSess.id}/log`, { exerciseId: earlierSess.exercises[0].id, weight: 155, reps: 5, set: 1 }, bob.token);

  const recentSess = await post('/api/sessions', { name: 'Back Day', visibility: 'friends',
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
  await post('/api/friends/request', { username: 'carl' }, alice.token);
  await post('/api/friends/accept', { from: alice.user.id }, carl.token);

  const firstSess = await post('/api/sessions', { name: 'First Session Ever', visibility: 'friends',
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

console.log('\nmultiple real PRs from one friend in a week collapse into a single feed line');
{
  // Jeff, Aug 21: "if I have 10 friends and they are all new, that list is going to get quite
  // heavy" — even with firstLog excluded, a genuinely improving lifter can beat several of their
  // own baselines within the same week. This should read as ONE line per friend, the same way
  // "completed N workouts" already collapses instead of listing every workout separately.
  // Reuses Carl from above, whose Back Squat / Bench Press / Pull-Up baselines are now beatable.
  const beatSess = await post('/api/sessions', { name: 'Second Session', visibility: 'friends',
    scheduledAt: new Date().toISOString(),
    exercises: [{ name: 'Back Squat' }, { name: 'Bench Press' }, { name: 'Pull-Up' }],
    inviteUsernames: [] }, carl.token).then(r => r.json());
  await post(`/api/sessions/${beatSess.id}/log`, { exerciseId: beatSess.exercises[0].id, weight: 155, reps: 8, set: 1 }, carl.token);
  await post(`/api/sessions/${beatSess.id}/log`, { exerciseId: beatSess.exercises[1].id, weight: 105, reps: 8, set: 1 }, carl.token);
  await post(`/api/sessions/${beatSess.id}/log`, { exerciseId: beatSess.exercises[2].id, weight: 0, reps: 8, set: 1 }, carl.token);

  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const carlPrItems = feed.filter(f => f.type === 'pr' && f.by === carl.user.id);
  ok(carlPrItems.length === 1, `three real PRs collapse into one feed line, not three (saw ${carlPrItems.length})`);
  ok(carlPrItems[0] && /hit 3 new PRs this week/.test(carlPrItems[0].text),
    `and it names the count (saw: ${carlPrItems[0] && carlPrItems[0].text})`);
  ok(carlPrItems[0] && /Back Squat/.test(carlPrItems[0].text) && /Bench Press/.test(carlPrItems[0].text) && /Pull-Up/.test(carlPrItems[0].text),
    'all three lifts are named, not just the first');

  // and the same collapsing applies to a profile's own Recent Activity
  const carlProfile = await get(`/api/profile/${carl.user.id}`, carl.token).then(r => r.json());
  const ownPrItems = (carlProfile.recentActivity || []).filter(a => a.type === 'pr');
  ok(ownPrItems.length === 1, `and on Carl's own profile too — one line, not three (saw ${ownPrItems.length})`);
}

console.log('\nmore than 3 real PRs in a week truncates the line instead of listing every lift');
{
  // A fourth lift (Deadlift), baseline then beaten, on top of Carl's three above — four real PRs
  // this week total. The line should name the first three and summarize the rest, not run on.
  const baseline2 = await post('/api/sessions', { name: 'Deadlift Baseline', visibility: 'friends',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Conventional Deadlift' }],
    inviteUsernames: [] }, carl.token).then(r => r.json());
  await post(`/api/sessions/${baseline2.id}/log`, { exerciseId: baseline2.exercises[0].id, weight: 185, reps: 5, set: 1 }, carl.token);

  const beat2 = await post('/api/sessions', { name: 'Deadlift Beat', visibility: 'friends',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Conventional Deadlift' }],
    inviteUsernames: [] }, carl.token).then(r => r.json());
  await post(`/api/sessions/${beat2.id}/log`, { exerciseId: beat2.exercises[0].id, weight: 225, reps: 5, set: 1 }, carl.token);

  const feed = await get('/api/feed', alice.token).then(r => r.json());
  const carlPrItems = feed.filter(f => f.type === 'pr' && f.by === carl.user.id);
  ok(carlPrItems.length === 1, `still one line, now with four real PRs (saw ${carlPrItems.length})`);
  ok(carlPrItems[0] && /hit 4 new PRs this week/.test(carlPrItems[0].text),
    `the count updates to 4 (saw: ${carlPrItems[0] && carlPrItems[0].text})`);
  ok(carlPrItems[0] && /\+1 more/.test(carlPrItems[0].text),
    `and the fourth is summarized rather than named, so the line does not run on (saw: ${carlPrItems[0] && carlPrItems[0].text})`);
}

console.log('\nv239 recap rows: a friend\'s posted recap shows in the feed, thumbnail gated to own /uploads/, visibility respected, and fresh recaps sort above the weekly summary');
{
  // Bob posts a recap on this week's Back Day with a photo already on disk (the /uploads/ path
  // shape is what a saved photo becomes; the ingest regex accepts it without re-writing a file).
  const sessions = await get('/api/sessions', bob.token).then(r => r.json());
  const backDay = sessions.find(s => s.name === 'Back Day');
  await post(`/api/sessions/${backDay.id}/post`, { notes: 'good pulls', visibility: 'friends',
    media: [{ type: 'image', src: '/uploads/bobrecap.jpg' }] }, bob.token);
  let feed = await get('/api/feed', alice.token).then(r => r.json());
  const recap = feed.find(f => f.type === 'recap' && f.sessionId === backDay.id);
  ok(!!recap, "Bob's posted recap reaches Alice's feed as a recap row");
  ok(recap && recap.text === 'finished Back Day', `and it names the workout (saw: ${recap && recap.text})`);
  ok(recap && recap.thumb === '/uploads/bobrecap.jpg', 'the photo rides along as the thumbnail');
  ok(recap && recap.by === bob.user.id, 'attributed to Bob');

  // Bob finishes the workout too -> Alice's feed gains a "completed" summary row. The summary is
  // stamped with the workout's date (midnight), the recap with the moment it was posted -- so the
  // fresh recap must sort ABOVE the summary (v239 cold-review catch: summaries stamped "now"
  // permanently outranked every real-timestamped row).
  await post(`/api/sessions/${backDay.id}/lock`, {}, bob.token);
  feed = await get('/api/feed', alice.token).then(r => r.json());
  const iRecap = feed.findIndex(f => f.type === 'recap' && f.sessionId === backDay.id);
  const iDone = feed.findIndex(f => f.type === 'completed' && f.by === bob.user.id);
  ok(iDone !== -1, "Bob's weekly summary row appeared after he finished");
  ok(iRecap !== -1 && iRecap < iDone, `and the fresh recap sorts above it (recap at index ${iRecap}, summary at ${iDone})`);

  // A recap with no photo still gets a row, with no thumbnail to render.
  const earlierBack = sessions.find(s => s.name === 'Earlier Back Day');
  await post(`/api/sessions/${earlierBack.id}/post`, { notes: 'no pics', visibility: 'friends', media: [] }, bob.token);
  feed = await get('/api/feed', alice.token).then(r => r.json());
  const bare = feed.find(f => f.type === 'recap' && f.sessionId === earlierBack.id);
  ok(!!bare && bare.thumb === null, 'a photo-less recap still rows up, thumb explicitly null');

  // An only_me recap must never reach a friend's feed, whatever its timestamp.
  const oldLeg = sessions.find(s => s.name === 'Old Leg Day');
  await post(`/api/sessions/${oldLeg.id}/post`, { notes: 'just for me', visibility: 'only_me', media: [] }, bob.token);
  feed = await get('/api/feed', alice.token).then(r => r.json());
  ok(!feed.some(f => f.type === 'recap' && f.sessionId === oldLeg.id),
    "an only_me recap stays out of Alice's feed even though it was posted seconds ago");
}

console.log("\nv247: a 'streak' summary row used to be stamped new Date().toISOString() (now), same bug v239 already fixed for 'completed' — a fresh recap posted afterward must still sort above it");
{
  // Both brand-new accounts, friended only to each other — /api/feed caps at 8 items (res.json
  // items.slice(0,8)), and Alice's feed is already crowded with everything the earlier blocks in
  // this file built, which would truncate a real ordering result off the end for the wrong reason.
  // A clean pair sidesteps that entirely.
  const faye = await post('/api/register', { username: 'faye', pin: 'pass1234', displayName: 'Faye' }).then(r => r.json());
  const dave = await post('/api/register', { username: 'dave', pin: 'pass1234', displayName: 'Dave' }).then(r => r.json());
  await post('/api/friends/request', { username: 'dave' }, faye.token);
  await post('/api/friends/accept', { from: faye.user.id }, dave.token);

  // Build a real 2-day streak via two real /lock calls with explicit localDate (v247's own new
  // mechanism), matching currentStreak's own UTC-day definition of "today"/"yesterday" rather than
  // reaching into the DB to fake it.
  const utcToday = new Date().toISOString().slice(0, 10);
  const utcYesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const y = await post('/api/sessions', { name: 'Streak Day One', visibility: 'friends',
    scheduledAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), exercises: [{ name: 'Overhead Press' }],
    inviteUsernames: [] }, dave.token).then(r => r.json());
  await post(`/api/sessions/${y.id}/log`, { exerciseId: y.exercises[0].id, weight: 65, reps: 8, set: 1 }, dave.token);
  await post(`/api/sessions/${y.id}/lock`, { localDate: utcYesterday }, dave.token);

  const t = await post('/api/sessions', { name: 'Streak Day Two', visibility: 'friends',
    scheduledAt: new Date().toISOString(), exercises: [{ name: 'Overhead Press' }],
    inviteUsernames: [] }, dave.token).then(r => r.json());
  await post(`/api/sessions/${t.id}/log`, { exerciseId: t.exercises[0].id, weight: 70, reps: 8, set: 1 }, dave.token);
  await post(`/api/sessions/${t.id}/lock`, { localDate: utcToday }, dave.token);

  let feed = await get('/api/feed', faye.token).then(r => r.json());
  const streakItem = feed.find(f => f.type === 'streak' && f.by === dave.user.id);
  ok(!!streakItem, `Dave's streak row reached Faye's feed (saw: ${feed.filter(f=>f.by===dave.user.id).map(f=>f.type).join(', ') || 'nothing from Dave'})`);
  ok(streakItem && /2 day workout streak/.test(streakItem.text), `and names it correctly (saw: ${streakItem && streakItem.text})`);

  // Now Dave posts a recap seconds later — a genuinely fresher, real-timestamped event. If the
  // streak row were still stamped "now" at feed-build time, it would tie or beat this every time
  // the feed is re-requested; with the fix it carries the streak's actual last-trained day, always
  // in the past relative to a recap posted after it.
  await post(`/api/sessions/${t.id}/post`, { notes: 'felt strong', visibility: 'friends', media: [] }, dave.token);
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

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
