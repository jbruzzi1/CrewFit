// Oct 10 2026 -- permanent coverage for the second "go through the whole app" audit batch (Jeff:
// "yes work through them all except the email at login", then "I like this - lets add this in
// every spot in the app where it NEEDS to be or MAKES sense to be" for the Enter-to-submit sweep,
// which already has its own coverage elsewhere). CLAUDE.md hard rule #6: every assertion here
// exists because something in this batch was actually broken.
//
// Mixed strategy, same as audit-oct9-batch-fixes.mjs: real HTTP against a real booted server for
// anything server-side, source-regex assertions against the real public/app.js for client-only
// logic that has no server round-trip to hang an HTTP test off of (same approach test/seed-your-
// lifts.mjs and audit-oct9-batch-fixes.mjs's own "10b" section already use).
//
// Run:  npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const PORT = process.env.TEST_PORT_OCT10BATCH2 || 4982;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('oct10batch2');
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
const DIR = mkdtempSync(join(tmpdir(), 'oct10batch2-'));
await boot(DIR);

const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(b || {}) }).then(r => r.json());
const del = (p, tok) => fetch(B + p, { method: 'DELETE', headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } }).then(r => r.json());
const get = (p, tok) => fetch(B + p, { headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } }).then(r => r.json());
const reg = async (n, displayName) => { const r = await post('/api/register', { username: n, pin: 'pass1234', displayName: displayName || n }); return { id: r.user.id, token: r.token }; };
const follow = (a, b) => post('/api/follow/' + b.id, {}, a.token);

console.log('\n1. Crew challenges: the owner can cancel a running challenge (finding #211)');
{
  const owner = await reg('b2chowner'), member = await reg('b2chmember');
  await follow(owner, member); await follow(member, owner);
  const crew = await post('/api/crews', { name: 'Cancel Test Crew', memberIds: [member.id] }, owner.token);
  const started = await post(`/api/crews/${crew.id}/challenge`, { type: 'workouts', target: 5 }, owner.token);
  ok(!!started.challenge, `challenge started (got ${JSON.stringify(started.challenge)})`);
  const chId = started.challenge.id;

  const forbidden = await del(`/api/crews/${crew.id}/challenge/${chId}`, member.token);
  ok(forbidden.error === 'only the owner can cancel a challenge', `a non-owner member cannot cancel it (got ${JSON.stringify(forbidden)})`);

  const cancelled = await del(`/api/crews/${crew.id}/challenge/${chId}`, owner.token);
  ok(!cancelled.error, `the owner can cancel it (got ${JSON.stringify(cancelled)})`);
  const afterView = await get(`/api/crews/${crew.id}`, owner.token);
  ok(afterView.challenge === null, 'no running challenge remains after cancelling');

  const again = await post(`/api/crews/${crew.id}/challenge`, { type: 'workouts', target: 3 }, owner.token);
  ok(!!again.challenge, 'a fresh challenge can be started immediately after cancelling -- cancel really freed the slot, not just hid it');

  const stale = await del(`/api/crews/${crew.id}/challenge/${chId}`, owner.token);
  ok(stale.error === 'no running challenge to cancel', 'cancelling the SAME (already-cancelled) challenge id again is refused, not a no-op success');
}

console.log('\n2. GET /api/friends sorts alphabetically, same convention followListFor() already uses (finding #214)');
{
  const me = await reg('b2friendme');
  const names = ['Zoe Martinez', 'Amy Chen', 'Marcus Lee'];
  for (const n of names) {
    const them = await reg('b2f_' + n.split(' ')[0].toLowerCase(), n);
    await follow(me, them); await follow(them, me);
  }
  const r = await get('/api/friends', me.token);
  const got = (r.friends || []).map(f => f.displayName || f.username);
  const sorted = [...got].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  ok(JSON.stringify(got) === JSON.stringify(sorted), `/api/friends comes back alphabetically, not registration order (got ${JSON.stringify(got)})`);
}

console.log('\n3. profileOf() exposes requestedToFollowYou so a private profile can show "X wants to follow you" (finding #216)');
{
  const priv = await reg('b2privprofile'), requester = await reg('b2requester'), stranger = await reg('b2strangernop');
  await post('/api/me/profile-visibility', { visibility: 'private' }, priv.token);
  await post(`/api/follow/${priv.id}`, {}, requester.token);
  const seenByOwner = await get(`/api/profile/${requester.id}`, priv.token);
  ok(seenByOwner.requestedToFollowYou === true, `the private account sees the pending requester flagged (got ${JSON.stringify(seenByOwner.requestedToFollowYou)})`);
  const seenByStranger = await get(`/api/profile/${requester.id}`, stranger.token);
  ok(seenByStranger.requestedToFollowYou === false, `a third party looking at the SAME requester's profile sees nothing (got ${JSON.stringify(seenByStranger.requestedToFollowYou)})`);
  const selfView = await get(`/api/profile/${priv.id}`, priv.token);
  ok(selfView.requestedToFollowYou === false, `viewing your OWN profile reads false, same as followsYou's own self-view convention right above it (got ${JSON.stringify(selfView.requestedToFollowYou)})`);
}

console.log('\n4. Crew challenge leaderboard breaks ties alphabetically, not by arbitrary join order (finding #229)');
{
  // Owner is added to the crew LAST in memberIds (order: zoe, amy, owner) so a pass that merely
  // sorted by count and left ties in memberIds/array order would NOT coincidentally come out
  // alphabetical already -- a real regression here has to actually fail without the fix.
  const owner = await reg('b2tieowner'), zoe = await reg('b2tiezoe'), amy = await reg('b2tieamy');
  await follow(owner, zoe); await follow(zoe, owner);
  await follow(owner, amy); await follow(amy, owner);
  const crew = await post('/api/crews', { name: 'Tie Test Crew', memberIds: [zoe.id, amy.id] }, owner.token);
  await post(`/api/crews/${crew.id}/challenge`, { type: 'workouts', target: 10 }, owner.token);
  // Everyone logs and locks exactly one workout -- a genuine three-way tie at count=1 each (same
  // create -> log -> lock shape test/crews.mjs's own logWorkout() uses).
  for (const u of [owner, zoe, amy]) {
    const s = await post('/api/sessions', { name: 'Tie', exercises: [{ name: 'Flat Barbell Bench Press' }], inviteUsernames: [], visibility: 'private' }, u.token);
    await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 100, reps: 8 }, u.token);
    await post(`/api/sessions/${s.id}/lock`, {}, u.token);
  }
  const view = await get(`/api/crews/${crew.id}`, owner.token);
  const board = view.challenge.leaderboard;
  ok(board.every(m => m.count === 1), `sanity: a genuine three-way tie at count 1 (got ${JSON.stringify(board.map(m => m.count))})`);
  const names = board.map(m => m.displayName || m.username);
  const alpha = [...names].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));
  ok(JSON.stringify(names) === JSON.stringify(alpha), `tied members land in alphabetical order, not crew-join order (got ${JSON.stringify(names)})`);
}

console.log('\n4b. crewChallengeRank() -- the Activity feed\'s own "moved to #N" rank -- uses the SAME alphabetical tiebreak as the leaderboard, not the old array-order sort (cold-review catch on finding #229)');
{
  // memberIds deliberately ordered [owner, zoe, amy] (not alphabetical) so a sort that only
  // broke ties by array order would put amy LAST among ties, not first -- the exact mismatch the
  // cold-review caught between publicChallenge()'s leaderboard sort (fixed) and this separate rank
  // calculation (missed the first time). owner and zoe each log+lock one workout (count 1 each);
  // amy starts at 0, then logs+locks her own to join them in a genuine 3-way tie at count 1.
  const owner = await reg('b2rankowner'), zoe = await reg('b2rankzoe'), amy = await reg('b2rankamy');
  await follow(owner, zoe); await follow(zoe, owner);
  await follow(owner, amy); await follow(amy, owner);
  const crew = await post('/api/crews', { name: 'Rank Test Crew', memberIds: [zoe.id, amy.id] }, owner.token);
  await post(`/api/crews/${crew.id}/challenge`, { type: 'workouts', target: 10 }, owner.token);
  for (const u of [owner, zoe]) {
    const s = await post('/api/sessions', { name: 'Rank', exercises: [{ name: 'Flat Barbell Bench Press' }], inviteUsernames: [], visibility: 'private' }, u.token);
    await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 100, reps: 8 }, u.token);
    await post(`/api/sessions/${s.id}/lock`, {}, u.token);
  }
  // Before amy's own workout: owner=1, zoe=1 (tied, alpha: owner < zoe), amy=0 -> amy's rank is 3.
  // After it: owner=1, zoe=1, amy=1 (3-way tie, alpha: amy < owner < zoe) -> amy's rank is 1.
  // 1 < 3 is a real improvement, so the 'rank' feed event fires -- under the OLD array-order sort
  // amy would still land LAST in the after-state tie (array order owner,zoe,amy unchanged), so
  // after(3) would not be < before(3) and the event would never fire at all.
  const s = await post('/api/sessions', { name: 'Rank', exercises: [{ name: 'Flat Barbell Bench Press' }], inviteUsernames: [], visibility: 'private' }, amy.token);
  await post(`/api/sessions/${s.id}/log`, { exerciseId: s.exercises[0].id, weight: 100, reps: 8 }, amy.token);
  await post(`/api/sessions/${s.id}/lock`, {}, amy.token);

  const feed = await get('/api/feed', owner.token);
  const rankEv = (feed || []).find(ev => ev.type === 'rank' && ev.by === amy.id && ev.crewId === crew.id);
  ok(!!rankEv, `a 'rank' feed event fired for amy at all (got ${JSON.stringify((feed || []).filter(ev => ev.type === 'rank'))})`);
  ok(!!rankEv && rankEv.rank === 1, `and it reports her real alphabetical-tiebreak rank (#1), matching what the leaderboard itself would show, not the old array-order rank (got ${rankEv && rankEv.rank})`);
}

await testDb.drop();
try { srv.kill(); } catch {}

console.log('\n5-14. Client-only fixes (app.js), verified against the real source -- same approach as audit-oct9-batch-fixes.mjs\'s "10b" section and test/seed-your-lifts.mjs');
{
  // These assertions search the WHOLE real public/app.js for a unique, specific literal/regex
  // rather than slicing a fixed-size window after each function's declaration -- several of
  // these functions carry long dated comment blocks before the actual code (the exact thing that
  // makes a fixed-offset window fragile), and viewPost()/crewView() in particular are thousands of
  // characters long. Each pattern below was checked for uniqueness in the file before being relied
  // on here, same spirit as test/seed-your-lifts.mjs's own regex-extraction approach, just without
  // the brittleness of assuming a fixed byte offset.
  const src = readFileSync(join(CWD, 'public/app.js'), 'utf8');

  // #213: tplQuickSaveConfirm's payload is just {name, exercises} -- the stale location/
  // creatorNote/visibility/inviteUsernames fields (dead since routines were reduced to name+
  // exercises) are gone.
  ok(/const payload = \{ name:n, exercises:DRAFT\.exercises \};/.test(src), 'tplQuickSaveConfirm posts only {name, exercises}, matching finishTemplate\'s real shape (finding #213)');

  // #215: the notifications follow-request row is tappable to the requester's profile, with the
  // Accept/Decline buttons stopping their own click from also firing it.
  ok(/class="req" style="cursor:pointer" onclick="profileView\('\$\{jsq\(fr\.from\.id\)\}'\)"/.test(src), 'the follow-request row in Notifications opens the requester\'s profile on tap (finding #215)');
  ok(/class="ra" onclick="event\.stopPropagation\(\)"/.test(src), 'and the Accept/Decline buttons stop that click from also firing it');

  // #217: showRecap no longer dead-ends silently when the finisher logged zero sets themselves --
  // it tells them the workout still saved.
  ok(/showToast\('Workout saved'\); showTab\('home'\); return;/.test(src), 'showRecap() tells the user their workout saved instead of silently landing on Home (finding #217)');

  // #219: openSession's canSuggest no longer wrongly loses the Suggest action for a still-invited
  // person the moment ANY other participant posts a recap.
  ok(/const canSuggest = !isCreator && !canEdit\s*\n\s*&& Array\.isArray\(s\.invited\) && s\.invited\.includes\(ME\.id\);/.test(src), 'canSuggest no longer gates on sessionHasAnyPost (finding #219)');

  // #220: a creator CAN report a teammate's own posted recap -- the gate is "not the author", not
  // "not the creator and not the author" -- and it's wired into both menu branches.
  ok(/const reportBtn = !isAuthor \?/.test(src), 'reportBtn\'s own gate is narrowed to !isAuthor alone (finding #220)');
  ok(/Delete session<\/button>\$\{reportBtn\}`/.test(src), 'reportBtn is appended to the CREATOR\'s own menu branch');
  ok(/: \(isAuthor \? `\$\{reactivateBtn\}<button class="danger" onclick="removeFromMyProfile\('\$\{id\}'\)">Remove from my profile<\/button>` : reportBtn\);/.test(src), 'and is the plain-viewer branch\'s own menu, not missing from either path');

  // #221: a custom exercise's own detail sheet carries direct Edit/Delete icon buttons, not just
  // a buried "Manage your exercises" link elsewhere.
  ok(/const mineActions = e\.mine \? `<button class="icon-btn" onclick="closeSheet\(\); openEditEx\(/.test(src), 'exDetail() renders a direct Edit action for your own exercise (finding #221)');
  ok(/closeSheet\(\); confirmDeleteCustomEx\('\$\{jsq\(e\.id\)\}','\$\{jsq\(e\.name\)\}'\)/.test(src), 'and a direct Delete action too');

  // #223: a crew whose owner account was deleted explains itself on-page, rather than silently
  // locking features with no indication why.
  ok(/const ownerlessNoteHtml = \(c\.ownerId===null\) \?/.test(src), 'crewView() explains an ownerless crew\'s state on-page (finding #223)');
  ok(/\$\{ownerlessNoteHtml\}/.test(src), 'and actually renders it into the page');

  // #224: editing/deleting a crew chat message patches just the message list in place, not a full
  // crewView() re-render that would reset scroll.
  ok(/function refreshCrewMessages\(/.test(src), 'refreshCrewMessages() exists (finding #224)');
  const editMsgFn = src.slice(src.indexOf('function editCrewMsgPrompt('), src.indexOf('function editCrewMsgPrompt(') + 1200);
  const delMsgFn = src.slice(src.indexOf('function deleteCrewMsgPrompt('), src.indexOf('function deleteCrewMsgPrompt(') + 1200);
  ok(/refreshCrewMessages\(/.test(editMsgFn), 'editCrewMsgPrompt() refreshes only the message list, not the whole crew page');
  ok(/refreshCrewMessages\(/.test(delMsgFn), 'deleteCrewMsgPrompt() does the same');

  // #226: the quick-save name field is a real pre-filled value, not a placeholder hint that
  // silently vanishes without ever actually being submitted.
  ok(/const typedName = \(\$\('wname'\) \? \$\('wname'\)\.value : \(DRAFT\.name\|\|''\)\)\.trim\(\);/.test(src), 'tplQuickSaveSheet() reads the live typed name (finding #226)');
  ok(/value="\$\{esc\(typedName\)\}"/.test(src), 'and pre-fills it as a real value, not just a placeholder');

  // #227: the Routines page's "Shared by friends" section renders a real empty state instead of
  // vanishing entirely when the list is empty -- same treatment "mine" already gets right above it.
  ok(/No shared routines yet/.test(src), '"Shared by friends" shows a discoverable empty state, not nothing at all, when empty (finding #227)');

  // #228: a submitted report shows a toast, not a blocking alert(), for the success path -- the
  // failure path still alerts, same as every other error in this app.
  ok(/showToast\('Report submitted'\)/.test(src), 'submitReport() success uses showToast, not a blocking alert (finding #228)');

  // #230: another participant's message in the live workout chat gets a real action (Report), not
  // nothing at all.
  ok(/cmt-report-btn/.test(src) && /aria-label="Report message"/.test(src), 'a teammate\'s message in the live workout chat gets a direct Report action (finding #230)');

  // #231: the "Add weight next time" empty-state worked example uses real kg numbers/increment
  // when the viewer is on kg, not just the lb math with a kg label swapped in.
  ok(/const egW = U==='kg' \? 60 : 135, egStep = U==='kg' \? 2\.5 : 5, egNew = U==='kg' \? 62\.5 : 140;/.test(src), 'the worked example picks real kg-appropriate numbers and increment, not just the lb example with the unit label swapped (finding #231)');

  // #232: the crew quick-invite picker in createFlow/templateExercises does not render a chip for
  // a crew with no one else in it -- there is nothing that chip could actually do.
  ok(/const invitable = CREW_PICKER\.filter\(c => \(c\.members\|\|\[\]\)\.some\(m=>m\.username && m\.username!==ME\.username\)\);/.test(src), 'crewQuickInviteHtml() filters out crews with no other members before rendering a chip (finding #232)');
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
