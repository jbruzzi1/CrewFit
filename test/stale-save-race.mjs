// v250 audit finding: editBio() and editDefaultGym() (public/app.js) both fire their real side
// effect -- reopening Settings, or a full navigate back to the profile via profileView() -- from
// an async .then() that resolves an arbitrary, network-latency-bound delay after Save was tapped,
// not the next tick. If the user has already moved on by the time a slow save resolves (opened a
// different sheet, switched tabs), the stale callback barged in anyway: reopening Settings on top
// of whatever they're now looking at, or for editBio, silently yanking them back to their own
// profile mid-task with zero warning -- a real navigation hijack, not just a stray overlay.
//
// The fix (UI_EPOCH, stillOnProfileWithNothingElseOpen) snapshots a sequence number when Save is
// tapped and only proceeds if nothing has opened a new sheet or switched tabs since -- same
// staleness principle openSession's own `silent` refresh already uses (SESSION_SILENT_SEQ /
// logSheetStillOpenFor).
//
// This drives the REAL editBio()/editDefaultGym()/showTab()/openSheetHtml() out of the real
// public/app.js via node:vm, with a controllable-delay fetch so the race can be reproduced
// deterministically instead of guessed at.
//
// v251 audit finding additions: toggleFollow() and the posted-workout action cluster
// (deletePhotoConfirmed/addPostPhoto/editPostNotes/savePostedSet/deletePostedSetConfirmed/
// sendPostComment) had the exact same shape and were fixed the same way, just with the more
// general nothingNavigatedSince() instead of stillOnProfileWithNothingElseOpen() (they don't need
// its extra "and specifically the Profile tab" check). Covered below: toggleFollow (a plain
// re-render after an await), deletePhotoConfirmed (a GET-then-POST merge-write), and savePostedSet
// (closes a sheet AND re-renders -- the closeSheet() call is scoped to "whatever's topmost," not a
// reference to the specific sheet this save came from, so an unguarded stale response could close
// an unrelated sheet the user opened afterward, not just re-render the wrong thing).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag || 'DIV', className: '', style: {}, innerHTML: '',
    parentNode: null, _children: [], _removed: false,
    _classes: new Set(),
    appendChild(child) { child.parentNode = el; el._children.push(child); return child; },
    remove() { el._removed = true; if (el.parentNode) el.parentNode._children = el.parentNode._children.filter(c => c !== el); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._classes.add(x)),
    remove: (...c) => c.forEach(x => el._classes.delete(x)),
    contains: c => el._classes.has(c),
  };
  return el;
}
const body = makeEl('BODY');
// The active nav tab is a real, mutable stub (not a shallow always-truthy Proxy) -- the fix reads
// it via document.querySelector('.nav button.active').dataset.tab, and the test needs to actually
// change it mid-scenario to simulate the user switching tabs.
const navState = { tab: 'me' };
const genericEl = () => new Proxy(function () {}, {
  get: (t, k) => k === 'children' || k === 'childNodes' ? [] : (k === 'innerText' || k === 'value' || k === 'textContent') ? '' : genericEl(),
  set: () => true, apply: () => genericEl(), has: () => true,
});
let profileViewCalls = 0, openSettingsRealCalls = 0;
// v251 cold-review follow-up: saveWorkoutEditConfirmed reads one fake inline-edit row's inputs
// (a stand-in for the real .inex-row markup renderWorkoutEdit produces) so its exercises.length
// check passes and the function reaches its actual writes instead of bailing on "Add at least one
// exercise." inlineEditDomPresent is toggled off by the test to simulate what a real navigation
// away actually does -- $('app').innerHTML gets replaced, so these elements would genuinely stop
// existing, not just become "the wrong screen's data."
let inlineEditDomPresent = true;
const inlineEditRow = { dataset: { ex: 'ex1' } };
const inlineEditFieldValues = { 'inex-name-ex1': 'Squat', 'inex-sets-ex1': '3', 'inex-reps-ex1': '10', 'inex-repsmax-ex1': '', 'saveNotes': 'good session' };
// v252 sweep: plain form-field stand-ins for the simple single-await functions below (sendChat,
// suggest, submitSession) -- genericEl()'s own .value always reads back '', which would make every
// one of these bail out early on its own "nothing typed" guard before ever reaching the network
// call the test is actually about.
const formFieldDefaults = { chatInput: 'hello team', swEx: 'e1', swTo: 'Incline Press', dt: '', vis: 'only_me', loc: 'Gym', len: '', note: '', wname: 'Leg Day' };
const doc = {
  body,
  createElement: (tag) => tag === 'canvas' ? Object.assign(makeEl('CANVAS'), {
    width: 0, height: 0, getContext: () => ({ save() {}, restore() {}, beginPath() {}, arc() {}, clip() {}, drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,stub',
  }) : makeEl('DIV'),
  getElementById: (id) => id === 'teVal' ? { value: 'new value', focus() {} }
    : (inlineEditDomPresent && id in inlineEditFieldValues) ? { value: inlineEditFieldValues[id] }
    : (id in formFieldDefaults) ? { value: formFieldDefaults[id], focus() {} } : genericEl(),
  querySelector: (sel) => sel === '.nav button.active' ? { dataset: { tab: navState.tab } }
    : sel === '.sheet-back' ? (body._children.filter(c => c.className === 'sheet-back').at(-1) || null) : genericEl(),
  querySelectorAll: (sel) => sel === '.sheet-back' ? body._children.filter(c => c.className === 'sheet-back')
    : sel === '.inex-row' ? (inlineEditDomPresent ? [inlineEditRow] : []) : [],
  addEventListener() {}, documentElement: genericEl(), head: genericEl(), cookie: '', readyState: 'complete',
};
// alertLog/requestBodies let the saveWorkoutEditConfirmed tests below assert on what actually got
// shown/sent, not just on whether viewPost fired -- the read-ordering bug they catch produces a
// wrong alert and a dropped save, not a barge-in.
const alertLog = [];
// The mock fetch is delay-controllable per call, keyed by URL, so the test can hold a save
// "in flight" while it simulates the user doing something else, then release it.
// v252: lets one test override the stand-in session the GET-auto-resolve above returns, to drive
// saveWorkoutEdit's friend-set-detach confirm-sheet branch (which needs real exercises/logs to
// compute a non-empty "touched" list) without disturbing every other test's simpler default.
let sessionGetOverride = null;
const pending = new Map(); // url -> {resolve}
const requestBodies = new Map(); // url -> raw body string, captured at call time (not at release time)
function mockFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (method !== 'GET') requestBodies.set(url, opts.body);
  // v251 additions (deletePhotoConfirmed/addPostPhoto/editPostNotes) fetch the current post with a
  // GET to exactly /api/sessions/<id> before their real write -- these tests are about that
  // write's post-await navigation, not about controlling the read's own timing, so THAT specific
  // GET shape resolves immediately with a stand-in post (the Proxy answers s.posts[authorId] for
  // whatever authorId the test uses without hardcoding one). Scoped narrowly (not to every GET) so
  // it doesn't also intercept showTab('home')'s own H.get('/api/sessions') etc. -- those still hang
  // on the unreleased `pending` map exactly as before, which is fine since no test here awaits them.
  if (method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url)) {
    return Promise.resolve({
      json: () => Promise.resolve(sessionGetOverride || {
        id: 'sess1', logs: {},
        posts: new Proxy({}, { get: () => ({ notes: 'old notes', media: [], visibility: 'only_me' }) }),
      }),
      ok: true, status: 200, text: () => Promise.resolve(''),
    });
  }
  return new Promise(resolve => {
    pending.set(url, () => resolve({
      json: () => Promise.resolve(opts.body ? JSON.parse(opts.body) : {}), ok: true, status: 200, text: () => Promise.resolve(''),
    }));
  });
}
const ctx = {
  console: { log() {}, warn() {}, error() {} }, document: doc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: mockFetch,
  location: { href: '/', pathname: '/', search: '', hash: '' }, history: { replaceState() {}, pushState() {} },
  navigator: { userAgent: 'node', serviceWorker: { register: () => Promise.resolve() }, onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval, alert: (msg) => { alertLog.push(msg); }, confirm: () => true, prompt: () => null,
  requestAnimationFrame: f => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  FileReader: function () {}, Image: function () {}, URL, Blob: function () {}, FormData: function () {},
  IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'public/app.js' });
vm.runInContext(`ME = { id:'u1', bio:'', defaultGym:'', units:'lb' };`, ctx);
// Stub out the real profileView/openSettings so this test only has to prove WHETHER they get
// called, not re-render their (unrelated) HTML -- exactly what the bug is about.
// The stub still bumps UI_EPOCH, mirroring the real profileView()'s own first statement (the
// v250 audit follow-up fix) -- this test is about whether the STALE-SAVE GUARD correctly reacts
// to that navigation, not about re-rendering profileView's real HTML.
// v251: viewPost stubbed the same way, also bumping UI_EPOCH to mirror the real fix (viewPost()'s
// own first statement).
// closeSheet is stubbed too (savePostedSet/deletePostedSetConfirmed call it) -- counting calls is a
// robust way to prove whether the stale save touched ANY sheet at all, without depending on the
// real 200ms fade/removal timing.
// v252 sweep: openSession/home/friends/showRecap stubbed the same way, for the ~20-function
// stale-navigation batch below -- openSession mirrors the real one's own UI_EPOCH++ (its first
// statement, guarded by !silent); home()/friends()/showRecap() don't bump UI_EPOCH themselves in
// the real code (only showTab() does), so these don't either.
vm.runInContext(`
  window._realOpenSettings = openSettings;
  window._realCloseSheet = closeSheet;
  window.profileView = (id) => { UI_EPOCH++; window.__profileViewCalls = (window.__profileViewCalls||0) + 1; };
  window.openSettings = (...a) => { window.__openSettingsCalls = (window.__openSettingsCalls||0) + 1; return window._realOpenSettings(...a); };
  window.viewPost = (id, authorId) => { UI_EPOCH++; window.__viewPostCalls = (window.__viewPostCalls||0) + 1; };
  window.closeSheet = (...a) => { window.__closeSheetCalls = (window.__closeSheetCalls||0) + 1; return window._realCloseSheet(...a); };
  window.openSession = (id, opts) => { if(!(opts&&opts.silent)) UI_EPOCH++; window.__openSessionCalls = (window.__openSessionCalls||0) + 1; };
  window.home = () => { window.__homeCalls = (window.__homeCalls||0) + 1; };
  window.friends = () => { window.__friendsCalls = (window.__friendsCalls||0) + 1; };
  window.showRecap = (id) => { window.__showRecapCalls = (window.__showRecapCalls||0) + 1; };
`, ctx);
const editBio = vm.runInContext('editBio', ctx);
const editDefaultGym = vm.runInContext('editDefaultGym', ctx);
const showTab = vm.runInContext('showTab', ctx);
const openSheetHtml = vm.runInContext('openSheetHtml', ctx);
const profileView = vm.runInContext('profileView', ctx);
const toggleFollow = vm.runInContext('toggleFollow', ctx);
const deletePhotoConfirmed = vm.runInContext('deletePhotoConfirmed', ctx);
const savePostedSet = vm.runInContext('savePostedSet', ctx);
const exitWorkoutEdit = vm.runInContext('exitWorkoutEdit', ctx);
const saveWorkoutEditConfirmed = vm.runInContext('saveWorkoutEditConfirmed', ctx);
const saveWorkoutEdit = vm.runInContext('saveWorkoutEdit', ctx);
const acceptInvite = vm.runInContext('acceptInvite', ctx);
const declineInvite = vm.runInContext('declineInvite', ctx);
const requestJoin = vm.runInContext('requestJoin', ctx);
const sendChat = vm.runInContext('sendChat', ctx);
const swapPick = vm.runInContext('swapPick', ctx);
const suggest = vm.runInContext('suggest', ctx);
const approve = vm.runInContext('approve', ctx);
const reject = vm.runInContext('reject', ctx);
const approveJoin = vm.runInContext('approveJoin', ctx);
const rejectJoin = vm.runInContext('rejectJoin', ctx);
const leaveWorkoutConfirmed = vm.runInContext('leaveWorkoutConfirmed', ctx);
const removeFromMyProfileConfirmed = vm.runInContext('removeFromMyProfileConfirmed', ctx);
const saveWorkout = vm.runInContext('saveWorkout', ctx);
const acceptRequest = vm.runInContext('acceptRequest', ctx);
const rejectRequest = vm.runInContext('rejectRequest', ctx);
const acceptFollow = vm.runInContext('acceptFollow', ctx);
const rejectFollow = vm.runInContext('rejectFollow', ctx);
const submitSession = vm.runInContext('submitSession', ctx);
const calls = () => ({
  profileView: vm.runInContext('window.__profileViewCalls || 0', ctx),
  openSettings: vm.runInContext('window.__openSettingsCalls || 0', ctx),
  viewPost: vm.runInContext('window.__viewPostCalls || 0', ctx),
  closeSheet: vm.runInContext('window.__closeSheetCalls || 0', ctx),
  openSession: vm.runInContext('window.__openSessionCalls || 0', ctx),
  home: vm.runInContext('window.__homeCalls || 0', ctx),
  friends: vm.runInContext('window.__friendsCalls || 0', ctx),
  showRecap: vm.runInContext('window.__showRecapCalls || 0', ctx),
});
// Shared runner for the simple single-await, unconditional-nav-after-await shape (v252 sweep):
// starts the call, simulates the user navigating away SYNCHRONOUSLY (before the mocked request
// resolves -- the real race, however fast the network actually is), then releases the held
// request and checks the nav function named by navKey did NOT fire.
async function checkNavGuard(label, run, url, navKey) {
  pending.clear();
  const before = calls()[navKey];
  const p = run();
  vm.runInContext('UI_EPOCH++', ctx); // the user taps a nav tab (or anything else that bumps UI_EPOCH) before the request resolves
  pending.get(url)();
  await p;
  const after = calls()[navKey];
  ok(after === before, `${label}: ${navKey} is NOT re-fired after navigating away (before ${before}, after ${after})`);
}
// Companion regression check: the ordinary case (nothing interrupts the request) must still work.
async function checkFastPath(label, run, url, navKey) {
  pending.clear();
  const before = calls()[navKey];
  const p = run();
  pending.get(url)();
  await p;
  const after = calls()[navKey];
  ok(after === before + 1, `${label}: ${navKey} still fires normally on a fast round trip (before ${before}, after ${after})`);
}

console.log('editDefaultGym: a slow save must NOT reopen Settings if the user already opened something else');
{
  navState.tab = 'me';
  editDefaultGym(); // opens the Default Gym text-entry sheet
  vm.runInContext(`_teConfirm()`, ctx); // taps Save -- closes the sheet, fires H.post, in flight now

  // user gets impatient and opens Weight units before the slow save resolves
  openSheetHtml('<div>Weight units</div>');

  const before = calls();
  pending.get('/api/me/default-gym')(); // the stale save finally resolves
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.openSettings === before.openSettings, `Settings does NOT reopen on top of Weight units (before ${before.openSettings}, after ${after.openSettings})`);
}

console.log('\neditBio: a slow save must NOT navigate the user back to their profile if they switched tabs');
{
  pending.clear();
  navState.tab = 'me';
  editBio();
  vm.runInContext(`_teConfirm()`, ctx); // taps Save, in flight

  navState.tab = 'home';
  showTab('home'); // user moves on to the Home tab while the save is still in flight

  const before = calls();
  pending.get('/api/me/bio')();
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.profileView === before.profileView, `the user is NOT yanked back to their profile mid-task (before ${before.profileView}, after ${after.profileView})`);
}

console.log('\neditBio: a slow save must NOT yank the user back from a FRIEND\'S profile (cold-review follow-up)');
{
  // The gap the first cold-review pass found: navigating from your own profile to someone else's
  // (e.g. tap Followers -> tap a friend's row -> profileView(friendId)) is a real navigation away,
  // but it neither switches the nav tab nor opens a new sheet -- the tab stays 'me' throughout.
  // Before this fix, the guard only checked the tab, so it couldn't tell this had happened and
  // would let the stale save barge in on top of the friend's profile.
  pending.clear();
  navState.tab = 'me';
  editBio();
  vm.runInContext(`_teConfirm()`, ctx); // taps Save, in flight

  profileView('friend-123'); // user taps a friend's row from their Followers list

  const before = calls();
  pending.get('/api/me/bio')(); // the stale save finally resolves, now looking at the friend's profile
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.profileView === before.profileView, `the user is NOT yanked off the friend's profile back to their own (before ${before.profileView}, after ${after.profileView})`);
}

console.log('\ntoggleFollow: a slow follow/unfollow must NOT snap the user back to a profile they navigated away from (v251 audit finding)');
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  const followDone = toggleFollow('friend-99', 'none'); // tap Follow -- POST /api/follow/friend-99, in flight

  navState.tab = 'home';
  showTab('home'); // user moves on before the request resolves

  pending.get('/api/follow/friend-99')();
  await followDone;
  const after = calls();
  ok(after.profileView === before.profileView, `profileView is NOT re-fired after navigating away (before ${before.profileView}, after ${after.profileView})`);
}

console.log('\ndeletePhotoConfirmed: a slow delete must NOT snap the user back to a recap they left (v251 audit finding, posted-workout cluster)');
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  const delDone = deletePhotoConfirmed('sess1', 'author1', 0); // GET resolves immediately (mocked)...
  await new Promise(r => setTimeout(r, 0)); // ...let that microtask land so the POST /post is actually issued and held

  navState.tab = 'home';
  showTab('home'); // user moves on before the write resolves

  pending.get('/api/sessions/sess1/post')();
  await delDone;
  const after = calls();
  ok(after.viewPost === before.viewPost, `viewPost is NOT re-fired after navigating away (before ${before.viewPost}, after ${after.viewPost})`);
}

console.log('\nsavePostedSet: a slow set-edit save must NOT close an unrelated sheet the user has since opened, or barge back onto the old recap (v251 audit finding)');
{
  // closeSheet() always operates on whatever .sheet-back is topmost, not on a reference to the
  // specific Edit-set sheet this save came from -- so an unguarded stale response here wouldn't
  // just re-render the old recap, it could close a completely unrelated sheet the user opened
  // afterwards. Stubbing closeSheet (see above) proves whether it fires at all, without depending
  // on the real 200ms fade/removal timing.
  pending.clear();
  navState.tab = 'me';
  openSheetHtml('<div>Edit set</div>'); // the Edit-set sheet this save came from
  const before = calls();
  const saveDone = savePostedSet('sess1', 'author1', 'log1'); // PUT /api/sessions/sess1/log/log1, in flight

  // user dismisses the Edit-set sheet and opens something unrelated before the save resolves
  openSheetHtml('<div>Something unrelated</div>');

  pending.get('/api/sessions/sess1/log/log1')();
  await saveDone;
  const after = calls();
  ok(after.viewPost === before.viewPost, `viewPost is NOT re-fired after navigating away (before ${before.viewPost}, after ${after.viewPost})`);
  ok(after.closeSheet === before.closeSheet, `closeSheet is NOT called either -- the unrelated sheet is left alone (before ${before.closeSheet}, after ${after.closeSheet})`);
}

console.log('\nexitWorkoutEdit: a slow Cancel must NOT snap the user back to the recap they left (v251 cold-review follow-up)');
{
  // exitWorkoutEdit's only async step is the mocked GET, which resolves on a microtask -- so
  // unlike the two-await functions above, there's no "hold it open" window to wait into. Instead
  // this navigates away SYNCHRONOUSLY, in the same tick right after kicking the call off: showTab
  // bumps UI_EPOCH before the JS engine ever gets around to running the GET's .then() microtask,
  // which is exactly the real race (tap Cancel, then immediately tap a nav tab before the network
  // round trip -- however fast -- has actually completed).
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  const exitDone = exitWorkoutEdit('sess1'); // starts, suspends at its one await
  navState.tab = 'home';
  showTab('home'); // runs synchronously, before exitWorkoutEdit's GET microtask ever fires

  await exitDone;
  const after = calls();
  ok(after.viewPost === before.viewPost, `viewPost is NOT re-fired after navigating away (before ${before.viewPost}, after ${after.viewPost})`);
}

console.log('\nsaveWorkoutEditConfirmed: a slow Save changes must NOT snap the user back to the recap they left, though the edit itself still saves (v251 cold-review follow-up, twice over)');
{
  // Round one of review found the missing epoch guard on the final navigation. Round two found a
  // SECOND bug in the same function: it used to read its own form inputs (.inex-row etc.) AFTER
  // await H.get -- so navigating away while that GET was in flight would tear down $('app').innerHTML
  // (removing those inputs) before the read ever happened, turning an explicit Save tap into a
  // wrong "Add at least one exercise" alert popping up on the wrong screen AND silently dropping
  // the save. Fixed by reading the inputs synchronously, before the first await (same as
  // savePostedSet already does for its own inputs). This test proves both fixes at once: it tears
  // down the fake inline-edit DOM (inlineEditDomPresent=false) while the request is in flight, and
  // checks (a) no bogus alert, (b) the PUT body still carries the exercise data read before
  // navigation, (c) viewPost doesn't barge back in.
  pending.clear(); alertLog.length = 0;
  navState.tab = 'me'; inlineEditDomPresent = true;
  const before = calls();
  const saveDone = saveWorkoutEditConfirmed('sess1'); // reads .inex-row etc SYNCHRONOUSLY first, then awaits GET

  navState.tab = 'home'; inlineEditDomPresent = false; // DOM torn down, as a real navigation would do
  showTab('home');
  await new Promise(r => setTimeout(r, 0)); // let the mocked GET resolve, so the PUT is issued and held

  pending.get('/api/sessions/sess1')(); // release the PUT
  await new Promise(r => setTimeout(r, 0));
  pending.get('/api/sessions/sess1/post')(); // release the POST
  await saveDone;
  const after = calls();
  ok(after.viewPost === before.viewPost, `viewPost is NOT re-fired after navigating away, even though the save itself completed (before ${before.viewPost}, after ${after.viewPost})`);
  ok(!alertLog.includes('Add at least one exercise'), `no bogus empty-exercises alert fires even though the DOM was torn down mid-save (alerts seen: ${JSON.stringify(alertLog)})`);
  const putBody = JSON.parse(requestBodies.get('/api/sessions/sess1') || '{}');
  ok(Array.isArray(putBody.exercises) && putBody.exercises.length === 1 && putBody.exercises[0].name === 'Squat',
    `the save still goes through with the exercise data read BEFORE navigation, not an empty/lost list (got ${JSON.stringify(putBody.exercises)})`);
}

console.log('\nsaveWorkoutEdit: the REAL Save-changes-button function had the identical read-after-await bug, one level up (v252 audit finding)');
{
  // saveWorkoutEditConfirmed's own H.get is no longer the first await in the chain -- saveWorkoutEdit
  // (the function actually bound to the visible button) does its OWN H.get first, to compute the
  // friend-set-detach warning, and used to read .inex-row/saveNotes AFTER that. Fixed by reading them
  // synchronously at the very top of saveWorkoutEdit, then passing the result straight through to
  // saveWorkoutEditConfirmed instead of letting it re-derive from a DOM that may already be gone by
  // the time saveWorkoutEdit's own await resolves. This proves the whole chain survives navigation
  // mid-flight: no bogus alert, the PUT still carries what was typed before Save was tapped, and the
  // final viewPost doesn't barge back onto whatever the user moved on to.
  pending.clear(); alertLog.length = 0;
  navState.tab = 'me'; inlineEditDomPresent = true;
  const before = calls();
  const saveDone = saveWorkoutEdit('sess1'); // reads .inex-row etc SYNCHRONOUSLY first, then awaits its own GET

  navState.tab = 'home'; inlineEditDomPresent = false; // DOM torn down, as a real navigation would do
  showTab('home');
  await new Promise(r => setTimeout(r, 0)); // let saveWorkoutEdit's own GET resolve and fall through
  await new Promise(r => setTimeout(r, 0)); // ...into saveWorkoutEditConfirmed's GET, so the PUT is issued and held

  pending.get('/api/sessions/sess1')(); // release the PUT
  await new Promise(r => setTimeout(r, 0));
  pending.get('/api/sessions/sess1/post')(); // release the POST
  await saveDone;
  const after = calls();
  ok(after.viewPost === before.viewPost, `viewPost is NOT re-fired after navigating away, even though the save itself completed (before ${before.viewPost}, after ${after.viewPost})`);
  ok(!alertLog.includes('Add at least one exercise'), `no bogus empty-exercises alert fires even though the DOM was torn down mid-save (alerts seen: ${JSON.stringify(alertLog)})`);
  const putBody = JSON.parse(requestBodies.get('/api/sessions/sess1') || '{}');
  ok(Array.isArray(putBody.exercises) && putBody.exercises.length === 1 && putBody.exercises[0].name === 'Squat',
    `the save still goes through with the exercise data read BEFORE navigation, not an empty/lost list (got ${JSON.stringify(putBody.exercises)})`);
}

console.log('\nsaveWorkoutEdit: the friend-set-detach confirm sheet must still navigate on an ordinary, instant "Save anyway" tap (v252 cold-review catch)');
{
  // The bug the first cold-review pass caught: openSheetHtml (which confirmSheet goes through)
  // bumps UI_EPOCH itself the moment the "Save changes? N friends logged sets..." sheet opens --
  // same as any other navigation. The first version of this fix threaded saveWorkoutEdit's
  // PRE-sheet epoch through to saveWorkoutEditConfirmed, so nothingNavigatedSince compared it
  // against a UI_EPOCH that had already moved past it by the time the sheet even existed --
  // permanently false, not a race, so "Save anyway" would never reopen the recap even here, with
  // no navigation at all beyond the sheet itself. This needs a session with a real removed exercise
  // and another user's log against it, so the "touched" list is non-empty and this branch actually
  // runs (the default stand-in session has neither).
  pending.clear(); alertLog.length = 0;
  sessionGetOverride = {
    id: 'sess1',
    exercises: [{ id: 'ex1', name: 'Squat' }, { id: 'ex2', name: 'Bench Press' }],
    logs: { friend1: [{ exerciseId: 'ex2' }] },
    posts: new Proxy({}, { get: () => ({ notes: 'old notes', media: [], visibility: 'only_me' }) }),
  };
  navState.tab = 'me'; inlineEditDomPresent = true;
  const before = calls();
  const saveDone = saveWorkoutEdit('sess1'); // reads .inex-row (only ex1) SYNCHRONOUSLY, then awaits its own GET
  await new Promise(r => setTimeout(r, 0)); // let that GET resolve -- ex2 is "touched", so the confirm sheet opens

  // saveWorkoutEdit's OWN returned promise (saveDone) resolves right here, the instant the confirm
  // sheet opens -- unlike the no-conflict path, this branch does a bare `return;` after calling
  // confirmSheet(), it does NOT wait for the eventual saveWorkoutEditConfirmed() the sheet's own
  // callback will trigger later. So `await saveDone` below proves nothing about the write actually
  // finishing; the ticks after releasing the PUT/POST are what the test actually depends on to let
  // that later, separate chain run to completion before checking viewPost.
  await saveDone;

  vm.runInContext('runConfirmCb()', ctx); // taps "Save anyway" IMMEDIATELY, no navigation at all
  await new Promise(r => setTimeout(r, 0)); // let saveWorkoutEditConfirmed's own GET resolve, issuing the PUT
  pending.get('/api/sessions/sess1')();
  await new Promise(r => setTimeout(r, 0));
  pending.get('/api/sessions/sess1/post')();
  await new Promise(r => setTimeout(r, 0)); // let the POST's own resolution chain reach the final viewPost() call

  const after = calls();
  ok(after.viewPost === before.viewPost + 1, `viewPost DOES fire after an instant "Save anyway" with no real navigation (before ${before.viewPost}, after ${after.viewPost})`);
  sessionGetOverride = null;
}

console.log('\nthe ordinary fast-save case (the overwhelming common one) must still work -- the fix must not break the everyday flow');
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  editDefaultGym();
  vm.runInContext(`_teConfirm()`, ctx);
  // nothing else happens -- resolve immediately, same as a normal fast network round trip
  pending.get('/api/me/default-gym')();
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.openSettings === before.openSettings + 1, `Settings still reopens normally when nothing else interrupted the save (before ${before.openSettings}, after ${after.openSettings})`);
}
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  editBio();
  vm.runInContext(`_teConfirm()`, ctx);
  pending.get('/api/me/bio')();
  await new Promise(r => setTimeout(r, 5));
  const after = calls();
  ok(after.profileView === before.profileView + 1, `and profileView still fires normally for a fast bio save (before ${before.profileView}, after ${after.profileView})`);
}
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  const followDone = toggleFollow('friend-99', 'none');
  pending.get('/api/follow/friend-99')();
  await followDone;
  const after = calls();
  ok(after.profileView === before.profileView + 1, `and toggleFollow's profileView still fires normally for a fast follow (before ${before.profileView}, after ${after.profileView})`);
}
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  const delDone = deletePhotoConfirmed('sess1', 'author1', 0);
  await new Promise(r => setTimeout(r, 0)); // let the mocked GET's microtask land before the POST is issued
  pending.get('/api/sessions/sess1/post')();
  await delDone;
  const after = calls();
  ok(after.viewPost === before.viewPost + 1, `and deletePhotoConfirmed's viewPost still fires normally for a fast delete (before ${before.viewPost}, after ${after.viewPost})`);
}
{
  pending.clear();
  navState.tab = 'me';
  openSheetHtml('<div>Edit set</div>');
  const before = calls();
  const saveDone = savePostedSet('sess1', 'author1', 'log1');
  pending.get('/api/sessions/sess1/log/log1')();
  await saveDone;
  const after = calls();
  ok(after.viewPost === before.viewPost + 1 && after.closeSheet === before.closeSheet + 1,
    `and savePostedSet still closes the sheet and reopens the recap normally for a fast save (viewPost before ${before.viewPost} after ${after.viewPost}, closeSheet before ${before.closeSheet} after ${after.closeSheet})`);
}
{
  pending.clear();
  navState.tab = 'me';
  const before = calls();
  const exitDone = exitWorkoutEdit('sess1');
  await new Promise(r => setTimeout(r, 0));
  await exitDone;
  const after = calls();
  ok(after.viewPost === before.viewPost + 1, `and exitWorkoutEdit's viewPost still fires normally for a fast Cancel (before ${before.viewPost}, after ${after.viewPost})`);
}
{
  pending.clear();
  navState.tab = 'me'; inlineEditDomPresent = true;
  const before = calls();
  const saveDone = saveWorkoutEditConfirmed('sess1');
  await new Promise(r => setTimeout(r, 0));
  pending.get('/api/sessions/sess1')();
  await new Promise(r => setTimeout(r, 0));
  pending.get('/api/sessions/sess1/post')();
  await saveDone;
  const after = calls();
  ok(after.viewPost === before.viewPost + 1, `and saveWorkoutEditConfirmed's viewPost still fires normally for a fast Save changes (before ${before.viewPost}, after ${after.viewPost})`);
}
{
  pending.clear();
  navState.tab = 'me'; inlineEditDomPresent = true;
  const before = calls();
  const saveDone = saveWorkoutEdit('sess1');
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  pending.get('/api/sessions/sess1')();
  await new Promise(r => setTimeout(r, 0));
  pending.get('/api/sessions/sess1/post')();
  await saveDone;
  const after = calls();
  ok(after.viewPost === before.viewPost + 1, `and saveWorkoutEdit's viewPost still fires normally for a fast Save changes, via the pass-through to saveWorkoutEditConfirmed (before ${before.viewPost}, after ${after.viewPost})`);
}

console.log('\nv252 audit finding sweep: ~20 more functions had the same unconditional-navigation-after-await shape as the rest of this file, just not yet guarded. Each is checked both ways: navigating away mid-request must not fire its navigation, and the ordinary fast round trip must still fire it exactly once.');

console.log('\nacceptInvite');
await checkNavGuard('acceptInvite', () => acceptInvite('sess1'), '/api/sessions/sess1/accept', 'openSession');
await checkFastPath('acceptInvite', () => acceptInvite('sess1'), '/api/sessions/sess1/accept', 'openSession');

console.log('\ndeclineInvite (confirmSheet-wrapped)');
{
  pending.clear();
  const before = calls();
  declineInvite('sess1'); // opens the confirm sheet, wires CONFIRM_CB
  vm.runInContext('runConfirmCb()', ctx); // taps "Decline invite" -- fires the POST, in flight
  vm.runInContext('UI_EPOCH++', ctx); // user navigates away before it resolves
  pending.get('/api/sessions/sess1/decline')();
  await new Promise(r => setTimeout(r, 0));
  const after = calls();
  ok(after.home === before.home, `declineInvite: home is NOT re-fired after navigating away (before ${before.home}, after ${after.home})`);
}
{
  pending.clear();
  const before = calls();
  declineInvite('sess1');
  vm.runInContext('runConfirmCb()', ctx);
  pending.get('/api/sessions/sess1/decline')();
  await new Promise(r => setTimeout(r, 0));
  const after = calls();
  ok(after.home === before.home + 1, `declineInvite: home still fires normally on a fast decline (before ${before.home}, after ${after.home})`);
}

console.log('\nrequestJoin');
await checkNavGuard('requestJoin', () => requestJoin('sess1'), '/api/sessions/sess1/join', 'openSession');
await checkFastPath('requestJoin', () => requestJoin('sess1'), '/api/sessions/sess1/join', 'openSession');

console.log('\nsendChat');
await checkNavGuard('sendChat', () => sendChat('sess1'), '/api/sessions/sess1/comments', 'openSession');
await checkFastPath('sendChat', () => sendChat('sess1'), '/api/sessions/sess1/comments', 'openSession');

console.log('\nswapPick');
vm.runInContext(`SWAP_SESSION='sess1'; SWAP_FROM='ex1'; SWAP_MODE=true;`, ctx);
await checkNavGuard('swapPick', () => { vm.runInContext(`SWAP_SESSION='sess1'; SWAP_FROM='ex1'; SWAP_MODE=true;`, ctx); return swapPick('Incline Press'); }, '/api/sessions/sess1/suggest', 'openSession');
await checkFastPath('swapPick', () => { vm.runInContext(`SWAP_SESSION='sess1'; SWAP_FROM='ex1'; SWAP_MODE=true;`, ctx); return swapPick('Incline Press'); }, '/api/sessions/sess1/suggest', 'openSession');

console.log('\nsuggest');
await checkNavGuard('suggest', () => suggest('sess1'), '/api/sessions/sess1/suggest', 'openSession');
await checkFastPath('suggest', () => suggest('sess1'), '/api/sessions/sess1/suggest', 'openSession');

console.log('\napprove / reject (suggested-edit) / approveJoin / rejectJoin');
await checkNavGuard('approve', () => approve('sess1', 'e1'), '/api/sessions/sess1/suggest/e1/approve', 'openSession');
await checkFastPath('approve', () => approve('sess1', 'e1'), '/api/sessions/sess1/suggest/e1/approve', 'openSession');
await checkNavGuard('reject', () => reject('sess1', 'e1'), '/api/sessions/sess1/suggest/e1/reject', 'openSession');
await checkFastPath('reject', () => reject('sess1', 'e1'), '/api/sessions/sess1/suggest/e1/reject', 'openSession');
await checkNavGuard('approveJoin', () => approveJoin('sess1', 'r1'), '/api/sessions/sess1/join/r1/approve', 'openSession');
await checkFastPath('approveJoin', () => approveJoin('sess1', 'r1'), '/api/sessions/sess1/join/r1/approve', 'openSession');
await checkNavGuard('rejectJoin', () => rejectJoin('sess1', 'r1'), '/api/sessions/sess1/join/r1/reject', 'openSession');
await checkFastPath('rejectJoin', () => rejectJoin('sess1', 'r1'), '/api/sessions/sess1/join/r1/reject', 'openSession');

console.log('\nleaveWorkoutConfirmed (also closeSheet -- see savePostedSet above for why that matters)');
await checkNavGuard('leaveWorkoutConfirmed', () => leaveWorkoutConfirmed('sess1', true), '/api/sessions/sess1/leave', 'home');
{
  // same scenario, checking closeSheet too
  pending.clear();
  const before = calls();
  const p = leaveWorkoutConfirmed('sess1', true);
  vm.runInContext('UI_EPOCH++', ctx);
  pending.get('/api/sessions/sess1/leave')();
  await p;
  const after = calls();
  ok(after.closeSheet === before.closeSheet, `leaveWorkoutConfirmed: closeSheet is NOT called either after navigating away (before ${before.closeSheet}, after ${after.closeSheet})`);
}
await checkFastPath('leaveWorkoutConfirmed', () => leaveWorkoutConfirmed('sess1', true), '/api/sessions/sess1/leave', 'home');

console.log('\nremoveFromMyProfileConfirmed (navigates via the real showTab(\'me\') -> meScreen() -> profileView(), stubbed above)');
await checkNavGuard('removeFromMyProfileConfirmed', () => removeFromMyProfileConfirmed('sess1'), '/api/sessions/sess1/remove-mine', 'profileView');
await checkFastPath('removeFromMyProfileConfirmed', () => removeFromMyProfileConfirmed('sess1'), '/api/sessions/sess1/remove-mine', 'profileView');

console.log('\nsaveWorkout (the initial finish-and-post flow, distinct from saveWorkoutEdit/Confirmed above)');
inlineEditDomPresent = true;
await checkNavGuard('saveWorkout', () => saveWorkout('sess1'), '/api/sessions/sess1/post', 'showRecap');
await checkFastPath('saveWorkout', () => saveWorkout('sess1'), '/api/sessions/sess1/post', 'showRecap');

console.log('\nacceptRequest / rejectRequest / acceptFollow / rejectFollow (Friends tab)');
await checkNavGuard('acceptRequest', () => acceptRequest('u2'), '/api/friends/accept', 'friends');
await checkFastPath('acceptRequest', () => acceptRequest('u2'), '/api/friends/accept', 'friends');
await checkNavGuard('rejectRequest', () => rejectRequest('u2'), '/api/friends/reject', 'friends');
await checkFastPath('rejectRequest', () => rejectRequest('u2'), '/api/friends/reject', 'friends');
await checkNavGuard('acceptFollow', () => acceptFollow('u2'), '/api/follow-requests/u2/accept', 'friends');
await checkFastPath('acceptFollow', () => acceptFollow('u2'), '/api/follow-requests/u2/accept', 'friends');
await checkNavGuard('rejectFollow', () => rejectFollow('u2'), '/api/follow-requests/u2/reject', 'friends');
await checkFastPath('rejectFollow', () => rejectFollow('u2'), '/api/follow-requests/u2/reject', 'friends');

console.log('\nsubmitSession (create flow)');
vm.runInContext(`DRAFT = { exercises:[{name:'Squat'}], inviteUsernames:[] }; EDITING_SESSION = null;`, ctx);
await checkNavGuard('submitSession', () => { vm.runInContext(`DRAFT = { exercises:[{name:'Squat'}], inviteUsernames:[] }; EDITING_SESSION = null;`, ctx); return submitSession(); }, '/api/sessions', 'home');
await checkFastPath('submitSession', () => { vm.runInContext(`DRAFT = { exercises:[{name:'Squat'}], inviteUsernames:[] }; EDITING_SESSION = null;`, ctx); return submitSession(); }, '/api/sessions', 'home');

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
