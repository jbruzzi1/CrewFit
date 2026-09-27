// Sep 27 2026 -- client-side half of the "Ownerless Workout Flow" redesign (server behavior is
// covered by test/ownerless-workout-flow.mjs). Drives the real openSession() render in
// public/app.js via node:vm, same harness family as test/suggest-add-exercise-client.mjs.
//
// Covers:
//  - A pending suggestion on an ownerless session shows real Approve/Reject controls to every
//    current participant (not just the creator, who no longer exists) -- both the per-exercise
//    inline swap row and the "Suggested changes" stack.
//  - The viewer's OWN vote state renders ("you said yes"/"you said no") and the matching button
//    reflects it (Approved/Declined), reading per-viewer votes off ed.votes[ME.id], not a single
//    global ed.status the way owned mode's creator-only decision does.
//  - An ownerless "add" suggestion -- unlike an owned one -- carries a real, already-live
//    exerciseId (see suggestOwnerless in server.js) and is hidden from a non-voter's own card via
//    myHiddenExerciseIds; it must still surface in "Suggested changes" so there is some way to find
//    and vote on it, not disappear entirely the way the pre-existing liveExIds skip would otherwise
//    make it.
//  - Once ownerless, the "..." menu (Edit/Delete) and "Join requests" section are both gone (they
//    were already isCreator-gated, and isCreator is never true once creatorId is null) -- a
//    regression check that this redesign didn't need, and didn't get, any special-casing there.
//  - openSwapChoice's "Propose for everyone" sheet copy branches on isOwnerless.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag || 'DIV', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false, _classes: new Set(),
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  };
  el.classList = { add() {}, remove() {}, contains: () => false };
  return el;
}
const body = makeEl('BODY');
const appEl = makeEl('DIV');
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
const byId = { app: appEl };
const doc = {
  body, createElement: () => makeEl('DIV'), getElementById: (id) => (id in byId) ? byId[id] : genericEl(),
  querySelector: () => genericEl(), querySelectorAll: () => [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};

let SESSION_DB = {};
let FRIENDS = [];
function jsonRes(v) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(v) }); }
function mockFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (/^\/api\/sessions\/([^/]+)$/.test(url) && method === 'GET') {
    const id = url.match(/^\/api\/sessions\/([^/]+)$/)[1];
    return jsonRes(SESSION_DB[id] ? JSON.parse(JSON.stringify(SESSION_DB[id])) : { error: 'not found' });
  }
  if (url === '/api/friends') return jsonRes({ friends: FRIENDS });
  if (/^\/api\/progress\/recommendations/.test(url)) return jsonRes({ ready: [], holds: [], soon: [] });
  return jsonRes({});
}

const historyStub = { pushState() {}, replaceState() {}, go() {}, length: 1 };
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: mockFetch,
  location: { href: '/', pathname: '/', search: '', hash: '' },
  history: historyStub, addEventListener() {}, removeEventListener() {}, scrollTo() {},
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval,
  alert(msg) { ctx._lastAlert = msg; }, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
await new Promise(r => setTimeout(r, 0));

const openSession = vm.runInContext('openSession', ctx);
vm.runInContext(`ME = {id:'me1', displayName:'Me'}; TOKEN='t';`, ctx);
FRIENDS = [
  { id: 'other1', username: 'other1', displayName: 'Other Person' },
  { id: 'me1', username: 'me1', displayName: 'Me' },
];

function baseSession(overrides) {
  return Object.assign({
    id: 'sess1', creatorId: null, name: 'Push Day', scheduledAt: new Date().toISOString(),
    visibility: 'private', participants: ['other1', 'me1'], invited: [], exercises: [], suggestedEdits: [],
    joinRequests: [], variations: {}, posts: {}, logs: {}, logCounts: {}, comments: [], history: [],
    myHiddenExerciseIds: [], myDraftNotes: '',
  }, overrides || {});
}

console.log('=== an ownerless pending SWAP: every current participant gets real Approve/Reject, not "waiting on creator" ===');
{
  SESSION_DB.sess1 = baseSession({
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [{ id: 'se1', type: 'swap', exerciseId: 'ex1', proposedBy: 'other1', swapTo: 'Dumbbell Press', fromName: 'Bench Press', status: 'pending', votes: { other1: 'approved' } }],
  });
  await openSession('sess1');
  ok(!/waiting on creator/.test(appEl.innerHTML), `an ownerless session never shows "waiting on creator" (got: ${/waiting on creator/.test(appEl.innerHTML)})`);
  ok(/onclick="approve\('sess1','se1'\)"/.test(appEl.innerHTML), 'a real, wired Approve button is offered to me1 (a current participant who has not voted yet)');
  ok(/onclick="reject\('sess1','se1'\)"/.test(appEl.innerHTML), 'and a real, wired Reject button too');
  ok(!/you said yes/.test(appEl.innerHTML) && !/you said no/.test(appEl.innerHTML), "me1 hasn't voted yet, so no vote-state tag shows for them");
}

console.log('\n=== my own vote state renders once I HAVE voted, and the matching button label reflects it ===');
{
  SESSION_DB.sess1 = baseSession({
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [{ id: 'se1', type: 'swap', exerciseId: 'ex1', proposedBy: 'other1', swapTo: 'Dumbbell Press', fromName: 'Bench Press', status: 'pending', votes: { other1: 'approved', me1: 'approved' } }],
  });
  await openSession('sess1');
  ok(/you said yes/.test(appEl.innerHTML), `me1's own "yes" vote is reflected back to them (got: ${/you said[^<]*/.exec(appEl.innerHTML)})`);
  ok(/>Approved</.test(appEl.innerHTML), 'the Approve button itself reads "Approved" once that is genuinely my current vote');
  ok(/onclick="reject\('sess1','se1'\)"/.test(appEl.innerHTML), 'the Reject button stays live -- an ownerless vote is changeable anytime, never locked in');
}

console.log('\n=== an ownerless "add" suggestion: hidden from my own card until I vote, but still surfaces in "Suggested changes" so there is a way to find and vote on it ===');
{
  SESSION_DB.sess1 = baseSession({
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }, { id: 'ex2', name: 'Lat Pulldown', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [{ id: 'se2', type: 'add', exerciseId: 'ex2', proposedBy: 'other1', swapTo: 'Lat Pulldown', status: 'pending', votes: { other1: 'approved' } }],
    myHiddenExerciseIds: ['ex2'],
  });
  await openSession('sess1');
  ok(!/Lat Pulldown<\/div>/.test(appEl.innerHTML.split('Suggested changes')[0]), 'the hidden-for-me exercise does not render as a normal card above "Suggested changes"');
  ok(/Suggested changes/.test(appEl.innerHTML), 'the "Suggested changes" heading is present');
  ok(/suggests adding.*Lat Pulldown/.test(appEl.innerHTML) || /Lat Pulldown/.test(appEl.innerHTML.split('Suggested changes')[1] || ''), 'and the add-suggestion itself is findable there, with a real Approve/Reject door -- it is not lost just because the exercise is hidden');
  ok(/onclick="approve\('sess1','se2'\)"/.test(appEl.innerHTML), 'voting on it is wired to the real edit id');
}

console.log('\n=== an ownerless "add" suggestion that everyone has voted yes on (status: \'approved\', server-side -- see maybeResolveOwnerlessAdd in server.js) disappears from "Suggested changes" entirely, not just from the hidden-exercise state -- Jeff, cold-review follow-up: "it should disappear/collapse once everyone\'s on board" ===');
{
  SESSION_DB.sess1 = baseSession({
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }, { id: 'ex2', name: 'Leg Curl', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [{ id: 'se3', type: 'add', exerciseId: 'ex2', proposedBy: 'other1', swapTo: 'Leg Curl', status: 'approved', votes: { other1: 'approved', me1: 'approved' } }],
    myHiddenExerciseIds: [], // already unhidden for me too, same as any settled add
  });
  await openSession('sess1');
  ok(!/Suggested changes/.test(appEl.innerHTML), 'no "Suggested changes" section at all -- a settled add is not lingering there with nothing left to decide');
  ok(!/onclick="approve\('sess1','se3'\)"/.test(appEl.innerHTML), 'no stray Approve/Reject control for it anywhere on the page');
  ok(/Leg Curl/.test(appEl.innerHTML), "the exercise itself renders as an entirely normal card -- it's just a real exercise now, nothing marks it as having been a suggestion");
}

console.log('\n=== once ownerless, the "..." session menu (Edit/Delete) and "Join requests" are both gone -- already isCreator-gated, no special-casing needed ===');
{
  SESSION_DB.sess1 = baseSession({
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }],
    joinRequests: [{ id: 'jr1', userId: 'stranger1', status: 'pending', note: 'let me in' }],
  });
  await openSession('sess1');
  ok(!/Edit session/.test(appEl.innerHTML), 'no Edit session control once ownerless');
  ok(!/Delete session/.test(appEl.innerHTML), 'no Delete session control once ownerless');
  ok(!/Join requests/.test(appEl.innerHTML), 'no Join requests section once ownerless, even with one genuinely still sitting open server-side');
}

console.log('\n=== openSwapChoice: "Propose for everyone" copy branches on isOwnerless ===');
{
  const openSwapChoice = vm.runInContext('openSwapChoice', ctx);
  let sheetHtml = '';
  vm.runInContext(`openSheetHtml = (html) => { globalThis.__lastSheet = html; };`, ctx);
  openSwapChoice('sess1', 'ex1', true, false);
  sheetHtml = vm.runInContext('globalThis.__lastSheet', ctx);
  ok(/The host approves it/.test(sheetHtml), `owned-mode copy still says the host approves it (got: ${/Propose for everyone[\s\S]{0,140}/.exec(sheetHtml)})`);
  openSwapChoice('sess1', 'ex1', true, true);
  sheetHtml = vm.runInContext('globalThis.__lastSheet', ctx);
  ok(!/The host approves it/.test(sheetHtml), 'ownerless-mode copy does not claim a host approves anything');
  ok(/vote/i.test(sheetHtml), `and instead frames it as a vote, matching how the rest of ownerless mode works (got: ${/Propose for everyone[\s\S]{0,140}/.exec(sheetHtml)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
