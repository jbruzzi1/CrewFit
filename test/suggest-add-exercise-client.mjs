// v262b (Jeff, Aug 31): "add the ability to add an exercise to a workout, not just suggest a
// swap" -- client-side half. Server behavior is covered by test/suggest-add-exercise.mjs; this
// drives the real openSession/library/exRowHtml/openSuggestAddPicker/suggestAddPick code in
// public/app.js via node:vm, same harness family as test/audit-v253-client.mjs /
// test/audit-v254-nav.mjs.
//
// Covers:
//  - The "Suggest a change" card (renamed from "Suggest a swap") shows the swap sub-section only
//    when there's something to swap, and always offers "Suggest adding an exercise" -- including
//    on an empty ("Workout Now") session, which is exactly where adding is most useful.
//  - A pending add-suggestion renders in the "Suggested changes" section (previously DEAD CODE --
//    built but never appended to `html` at all; fixed as part of this feature) with its own
//    wording, distinct from a swap's "→ NewName" phrasing.
//  - Multiple pending add-suggestions all render (regression check for the editByEx[undefined]
//    bucket bug the fix avoids -- see openSession's own comment).
//  - An approved add-suggestion does NOT leave a residual line in "Suggested changes" (it's a
//    real exercise card now); an approved SWAP still does (unchanged, pre-existing behavior).
//  - openSuggestAddPicker/openSwapPicker/openAddExercises are mutually exclusive: entering any one
//    clears the other two's mode flags.
//  - exRowHtml and library()'s header both branch correctly on SUGGEST_ADD_MODE.
//  - suggestAddPick posts {type:'add', name} and clears state; suggestAddCancel clears without
//    posting; resetTransientModes clears both new module vars.
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
const appEl = makeEl('DIV'); // real, inspectable innerHTML -- every openSession render below is checked through this
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

let SESSION_DB = {};   // id -> session fixture, mutated by the fixture setup below
let FRIENDS = [];      // [{id, username, displayName}] -- drives nameOf()
let lastSuggestPost = null;

function jsonRes(v) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(v) }); }
function mockFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (/^\/api\/sessions\/([^/]+)$/.test(url) && method === 'GET') {
    const id = url.match(/^\/api\/sessions\/([^/]+)$/)[1];
    return jsonRes(SESSION_DB[id] ? JSON.parse(JSON.stringify(SESSION_DB[id])) : { error: 'not found' });
  }
  if (/^\/api\/sessions\/[^/]+\/suggest$/.test(url) && method === 'POST') {
    lastSuggestPost = { url, body: JSON.parse(opts.body) };
    return jsonRes({ ok: true });
  }
  if (url === '/api/friends') return jsonRes({ friends: FRIENDS });
  if (/^\/api\/progress\/recommendations/.test(url)) return jsonRes({ ready: [], holds: [], soon: [] });
  if (url === '/api/exercises') return jsonRes([{ name: 'Lateral Raise', muscle_groups: ['shoulders'] }, { name: 'Face Pull', muscle_groups: ['shoulders'] }]);
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
await new Promise(r => setTimeout(r, 0)); // let the no-token boot IIFE settle harmlessly

const openSession = vm.runInContext('openSession', ctx);
const library = vm.runInContext('library', ctx);
const exRowHtml = vm.runInContext('exRowHtml', ctx);
const openSuggestAddPicker = vm.runInContext('openSuggestAddPicker', ctx);
const openSwapPicker = vm.runInContext('openSwapPicker', ctx);
const openAddExercises = vm.runInContext('openAddExercises', ctx);
const suggestAddCancel = vm.runInContext('suggestAddCancel', ctx);
const suggestAddPick = vm.runInContext('suggestAddPick', ctx);
const resetTransientModes = vm.runInContext('resetTransientModes', ctx);

function getModes() {
  return vm.runInContext('({SWAP_MODE, SWAP_SESSION, SWAP_FROM, SUGGEST_ADD_MODE, SUGGEST_ADD_SESSION, LIB_ADDMODE})', ctx);
}
function setDraft() { vm.runInContext(`DRAFT = { exercises: [] };`, ctx); }

vm.runInContext(`ME = {id:'me1', displayName:'Me'}; TOKEN='t';`, ctx);
FRIENDS = [{ id: 'host1', username: 'host1', displayName: 'Hosty Host' }, { id: 'me1', username: 'me1', displayName: 'Me' }];

console.log('=== mode plumbing: openSuggestAddPicker / openSwapPicker / openAddExercises are mutually exclusive ===');
{
  vm.runInContext(`SWAP_MODE=false; SWAP_SESSION=null; SWAP_FROM=null; SUGGEST_ADD_MODE=false; SUGGEST_ADD_SESSION=null; LIB_ADDMODE=false;`, ctx);
  vm.runInContext(`SWAP_MODE=true; SWAP_SESSION='sess1'; SWAP_FROM='ex1';`, ctx); // pretend swap mode is already active
  openSuggestAddPicker('sess1');
  const m1 = getModes();
  ok(m1.SUGGEST_ADD_MODE === true && m1.SUGGEST_ADD_SESSION === 'sess1', `openSuggestAddPicker enters suggest-add mode (got ${JSON.stringify(m1)})`);
  ok(m1.SWAP_MODE === false && m1.SWAP_SESSION === null && m1.SWAP_FROM === null, `...and clears a leftover SWAP_MODE (got ${JSON.stringify(m1)})`);
  ok(m1.LIB_ADDMODE === false, 'and clears LIB_ADDMODE too');

  openSwapPicker('sess1', 'ex1');
  const m2 = getModes();
  ok(m2.SWAP_MODE === true && m2.SWAP_FROM === 'ex1', `openSwapPicker enters swap mode (got ${JSON.stringify(m2)})`);
  ok(m2.SUGGEST_ADD_MODE === false && m2.SUGGEST_ADD_SESSION === null, `...and clears a leftover SUGGEST_ADD_MODE, the reverse direction (got ${JSON.stringify(m2)})`);

  vm.runInContext(`SUGGEST_ADD_MODE=true; SUGGEST_ADD_SESSION='sess2';`, ctx);
  setDraft();
  openAddExercises();
  const m3 = getModes();
  ok(m3.LIB_ADDMODE === true, 'openAddExercises enters its own mode');
  ok(m3.SUGGEST_ADD_MODE === false && m3.SUGGEST_ADD_SESSION === null, `...and clears a leftover SUGGEST_ADD_MODE too (got ${JSON.stringify(m3)})`);

  vm.runInContext(`SUGGEST_ADD_MODE=true; SUGGEST_ADD_SESSION='sess3';`, ctx);
  resetTransientModes();
  const m4 = getModes();
  ok(m4.SUGGEST_ADD_MODE === false && m4.SUGGEST_ADD_SESSION === null, `resetTransientModes (the bottom-nav escape hatch) clears the new mode too (got ${JSON.stringify(m4)})`);
}

console.log('\n=== library() header and exRowHtml() branch correctly on SUGGEST_ADD_MODE ===');
{
  vm.runInContext(`SWAP_MODE=false; SWAP_SESSION=null; SWAP_FROM=null; LIB_ADDMODE=false; SUGGEST_ADD_MODE=true; SUGGEST_ADD_SESSION='sess1';`, ctx);
  await library({ silent: true });
  ok(/Add which exercise\?/.test(appEl.innerHTML), `library() header reads "Add which exercise?" in suggest-add mode (got: ${appEl.innerHTML.slice(0, 200)})`);
  ok(/suggestAddCancel\(\)/.test(appEl.innerHTML), 'header Cancel button wires to suggestAddCancel()');
  ok(!/libDone\(\)/.test(appEl.innerHTML), 'does not show the LIB_ADDMODE "Done (n)" button');

  const row = exRowHtml({ name: 'Lateral Raise', muscle_groups: ['shoulders'] });
  ok(row.includes(`suggestAddPick('Lateral Raise')`), `exRowHtml wires a row's tap to suggestAddPick (got: ${row})`);
  ok(!row.includes('swapPick('), 'and NOT to swapPick');
  vm.runInContext(`SUGGEST_ADD_MODE=false; SUGGEST_ADD_SESSION=null;`, ctx);
}

console.log('\n=== suggestAddPick posts {type:"add", name} and clears state; suggestAddCancel does not post ===');
{
  vm.runInContext(`SUGGEST_ADD_MODE=true; SUGGEST_ADD_SESSION='sess9';`, ctx);
  lastSuggestPost = null;
  await suggestAddPick('Face Pull');
  ok(!!lastSuggestPost, 'suggestAddPick actually posted');
  ok(lastSuggestPost && lastSuggestPost.url === '/api/sessions/sess9/suggest', `posted to the right session's /suggest (got ${lastSuggestPost && lastSuggestPost.url})`);
  ok(lastSuggestPost && lastSuggestPost.body.type === 'add' && lastSuggestPost.body.name === 'Face Pull', `body is {type:'add', name} (got ${JSON.stringify(lastSuggestPost && lastSuggestPost.body)})`);
  const mAfter = getModes();
  ok(mAfter.SUGGEST_ADD_MODE === false && mAfter.SUGGEST_ADD_SESSION === null, 'state cleared after a successful pick');

  vm.runInContext(`SUGGEST_ADD_MODE=true; SUGGEST_ADD_SESSION='sess9';`, ctx);
  lastSuggestPost = null;
  suggestAddCancel();
  ok(!lastSuggestPost, 'suggestAddCancel does NOT post anything');
  const mCancel = getModes();
  ok(mCancel.SUGGEST_ADD_MODE === false && mCancel.SUGGEST_ADD_SESSION === null, 'and still clears state');
}

function baseSession(overrides) {
  return Object.assign({
    id: 'sess1', creatorId: 'host1', name: 'Push Day', scheduledAt: new Date().toISOString(),
    visibility: 'private', participants: ['host1', 'me1'], invited: [], exercises: [], suggestedEdits: [],
    joinRequests: [], variations: {}, posts: {}, logs: {}, logCounts: {}, comments: [], history: [],
  }, overrides || {});
}

console.log('\n=== "Suggest a change" card: swap sub-section only when there\'s something to swap, add button always shown ===');
{
  SESSION_DB.sess1 = baseSession({ exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }] });
  await openSession('sess1');
  ok(/Suggest a change/.test(appEl.innerHTML), `card is headed "Suggest a change" (got: ${/Suggest[^<]*/.exec(appEl.innerHTML)})`);
  ok(/Pick replacement from Workouts/.test(appEl.innerHTML), 'swap sub-section shows when there IS an exercise to swap');
  ok(/Suggest adding an exercise/.test(appEl.innerHTML), 'and the add button is there too');
  ok(/openSuggestAddPicker\('sess1'\)/.test(appEl.innerHTML), 'add button wired to openSuggestAddPicker for this session');

  SESSION_DB.sess1 = baseSession({ exercises: [] }); // empty "Workout Now" a friend joined
  await openSession('sess1');
  ok(!/Pick replacement from Workouts/.test(appEl.innerHTML), 'swap sub-section is HIDDEN on an empty workout -- nothing to replace');
  ok(/Suggest adding an exercise/.test(appEl.innerHTML), 'but the add button still shows -- exactly where it is most useful');

  vm.runInContext(`ME = {id:'host1', displayName:'Host'};`, ctx);
  SESSION_DB.sess1 = baseSession({ exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }] });
  await openSession('sess1');
  ok(!/Suggest a change/.test(appEl.innerHTML), 'the creator never sees this card at all (they have Edit instead)');
  vm.runInContext(`ME = {id:'me1', displayName:'Me'};`, ctx);
}

console.log('\n=== "Suggested changes" section (previously dead code) now actually renders add-suggestions ===');
{
  SESSION_DB.sess1 = baseSession({
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [
      { id: 'se1', type: 'add', exerciseId: null, proposedBy: 'me1', swapTo: 'Lateral Raise', status: 'pending' },
    ],
  });
  await openSession('sess1');
  ok(/Suggested changes/.test(appEl.innerHTML), `the "Suggested changes" heading actually renders now (got: ${/Suggested[^<]*/.exec(appEl.innerHTML)})`);
  ok(/suggested adding/.test(appEl.innerHTML) && /Lateral Raise/.test(appEl.innerHTML), 'pending add-suggestion shows "...suggested adding Lateral Raise" wording, not swap\'s "→"');
}

console.log('\n=== approve/reject controls: creator sees them, a non-creator participant sees "waiting on creator" ===');
{
  // Now me1 is a PARTICIPANT, not the creator (host1 is), proposing the add-suggestion.
  SESSION_DB.sess1 = baseSession({
    creatorId: 'host1', participants: ['host1', 'me1'],
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [{ id: 'se1', type: 'add', exerciseId: null, proposedBy: 'me1', swapTo: 'Lateral Raise', status: 'pending' }],
  });
  await openSession('sess1');
  ok(/waiting on creator/.test(appEl.innerHTML), `a non-creator sees "waiting on creator", not Approve/Reject buttons (got: ${appEl.innerHTML.includes('waiting on creator')})`);
  ok(!/onclick="approve\(/.test(appEl.innerHTML), 'and specifically no approve() button for a non-creator');

  vm.runInContext(`ME = {id:'host1', displayName:'Host'};`, ctx);
  await openSession('sess1');
  ok(/onclick="approve\('sess1','se1'\)"/.test(appEl.innerHTML), 'the creator DOES see a real Approve button, wired to this exact edit id');
  ok(/onclick="reject\('sess1','se1'\)"/.test(appEl.innerHTML), 'and a real Reject button too');
  vm.runInContext(`ME = {id:'me1', displayName:'Me'};`, ctx);
}

console.log('\n=== multiple pending add-suggestions all render (editByEx[undefined]-bucket regression check) ===');
{
  SESSION_DB.sess1 = baseSession({
    creatorId: 'host1', participants: ['host1', 'me1'],
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [
      { id: 'se1', type: 'add', exerciseId: null, proposedBy: 'me1', swapTo: 'Lateral Raise', status: 'pending' },
      { id: 'se2', type: 'add', exerciseId: null, proposedBy: 'me1', swapTo: 'Face Pull', status: 'pending' },
    ],
  });
  vm.runInContext(`ME = {id:'host1', displayName:'Host'};`, ctx);
  await openSession('sess1');
  ok(/Lateral Raise/.test(appEl.innerHTML) && /Face Pull/.test(appEl.innerHTML),
    `BOTH pending add-suggestions render, not just one (a shared editByEx[undefined] bucket would hide all but treat the array as truthy and skip every one -- got: ${appEl.innerHTML.includes('Lateral Raise')}/${appEl.innerHTML.includes('Face Pull')})`);
  vm.runInContext(`ME = {id:'me1', displayName:'Me'};`, ctx);
}

console.log('\n=== an approved add-suggestion leaves no residual line; an approved SWAP still does (unchanged) ===');
{
  SESSION_DB.sess1 = baseSession({
    creatorId: 'host1', participants: ['host1', 'me1'],
    exercises: [
      { id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 },
      { id: 'ex2', name: 'Face Pull', defaultSets: 3, defaultReps: 12 }, // the now-added exercise, as approval would leave it
    ],
    suggestedEdits: [
      { id: 'se1', type: 'add', exerciseId: null, proposedBy: 'me1', swapTo: 'Face Pull', status: 'approved' },
    ],
  });
  await openSession('sess1');
  ok(!/Suggested changes/.test(appEl.innerHTML), 'an approved add-suggestion is skipped entirely in "Suggested changes" -- the exercise card above already shows it');
  ok(/Face Pull/.test(appEl.innerHTML), 'Face Pull is visible as its own real exercise card instead');

  // Regression check: an approved SWAP (pre-existing behavior) still shows its muted residual
  // line, since editByEx would only suppress it if the ORIGINAL exercise id still existed there --
  // here it's deliberately gone (creator removed it in a later edit), the exact case the fallback
  // section's own comment says it exists for.
  SESSION_DB.sess1 = baseSession({
    creatorId: 'host1', participants: ['host1', 'me1'],
    exercises: [{ id: 'ex1', name: 'Bench Press', defaultSets: 3, defaultReps: 8 }],
    suggestedEdits: [{ id: 'se2', type: 'swap', exerciseId: 'ex_gone', proposedBy: 'me1', swapTo: 'Incline Press', status: 'approved' }],
  });
  await openSession('sess1');
  ok(/swapped by/.test(appEl.innerHTML) && /Incline Press/.test(appEl.innerHTML), `an approved swap whose target exercise is gone still shows its muted "swapped by" line, unchanged (got: ${appEl.innerHTML.includes('swapped by')})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
