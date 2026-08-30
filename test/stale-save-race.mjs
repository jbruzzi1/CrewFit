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
const doc = {
  body,
  createElement: () => makeEl('DIV'),
  getElementById: (id) => id === 'teVal' ? { value: 'new value', focus() {} }
    : (inlineEditDomPresent && id in inlineEditFieldValues) ? { value: inlineEditFieldValues[id] } : genericEl(),
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
      json: () => Promise.resolve({
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
vm.runInContext(`
  window._realOpenSettings = openSettings;
  window._realCloseSheet = closeSheet;
  window.profileView = (id) => { UI_EPOCH++; window.__profileViewCalls = (window.__profileViewCalls||0) + 1; };
  window.openSettings = (...a) => { window.__openSettingsCalls = (window.__openSettingsCalls||0) + 1; return window._realOpenSettings(...a); };
  window.viewPost = (id, authorId) => { UI_EPOCH++; window.__viewPostCalls = (window.__viewPostCalls||0) + 1; };
  window.closeSheet = (...a) => { window.__closeSheetCalls = (window.__closeSheetCalls||0) + 1; return window._realCloseSheet(...a); };
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
const calls = () => ({
  profileView: vm.runInContext('window.__profileViewCalls || 0', ctx),
  openSettings: vm.runInContext('window.__openSettingsCalls || 0', ctx),
  viewPost: vm.runInContext('window.__viewPostCalls || 0', ctx),
  closeSheet: vm.runInContext('window.__closeSheetCalls || 0', ctx),
});

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

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
