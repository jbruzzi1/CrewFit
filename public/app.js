const API = '';
let TOKEN = localStorage.getItem('crewfit_token') || '';
let ME = null;
// v250 (audit finding): bumped by every NEW sheet opened (openSheetHtml) and every tab switch
// (showTab) -- lets a slow-resolving background save (editBio/editDefaultGym) tell "the user is
// still right where they were when I started" from "they've moved on since," without being fooled
// by its OWN sheet's unrelated close-and-fade. See the comment above stillOnProfileWithNothingElseOpen.
let UI_EPOCH = 0;
const H = {
  _req(method,p,b){ return fetch(API+p,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},body:b?JSON.stringify(b):undefined})
    .then(async res=>{
      let json=null; try{ json=await res.json(); }catch(e){}
      if(res.status===401){
        // stale/invalid token: clear it and return to login instead of leaving the user broken
        localStorage.removeItem('crewfit_token'); TOKEN=''; ME=null;
        try{ authScreen(); }catch(e){}
        return { error:'Session expired — please log in again', _expired:true };
      }
      return json;
    })
    .catch(()=>({ error:'Network error' })); },
  get:p=>H._req('GET',p),
  post:(p,b)=>H._req('POST',p,b),
  put:(p,b)=>H._req('PUT',p,b),
  delete:p=>H._req('DELETE',p),
};
const $ = id => document.getElementById(id);
function setToken(t,u){ TOKEN=t; localStorage.setItem('crewfit_token',t); ME=u; $('nav').classList.toggle('hidden', !t); }
// "3 × 8–10" when a range is set, "3 × 10" when it's a single target
function repLabel(e){ const lo=Number(e.defaultReps), hi=Number(e.defaultRepsMax);
  if(!lo) return '';                    // timed exercise: no rep target, so claim none
  return (hi && hi>lo) ? `${lo}–${hi}` : `${lo}`; }
// Escapes for HTML. The QUOTES are the point: this handled & < > only, and almost every value in
// this file lands inside a single-quoted onclick or a double-quoted attribute, so an apostrophe
// ended the attribute early. That is two separate bugs wearing one hat.
//
//   1. Captain's Chair Leg Raise, Jacob's Ladder and Farmer's Carry were inert EVERYWHERE — you
//      could not tap them, add them to a workout, or pick one as a swap. Their apostrophe broke
//      the handler they were sitting in.
//   2. Anything a person types — a username, a custom exercise name, a photo caption — could close
//      the attribute and open an event handler of its own. That runs in every viewer's browser and
//      the first thing worth stealing is the login token, which IS the security model here.
//
// One function, five characters, both closed.
const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ESC_MAP[c]); }

// For a value that lands INSIDE A JS STRING INSIDE AN HTML ATTRIBUTE — onclick="fn('HERE')".
//
// esc() alone is not merely insufficient there, it is actively harmful: the HTML parser decodes
// &#39; back into a real apostrophe BEFORE the JavaScript is parsed, so the quote arrives intact
// and closes the string. A name of  Zed');alert(1);//  becomes a live statement. Escaping harder
// for HTML cannot fix it, because the decode happens first.
//
// The order is what matters. Escape for JavaScript FIRST — backslash, then quote — and only then
// escape for HTML. The parser decodes the entity back to a BACKSLASHED quote, which the JS parser
// then reads as one character of a string. This is also, finally, what makes Captain's Chair Leg
// Raise, Jacob's Ladder and Farmer's Carry tappable: their apostrophe arrives as \' rather than
// as a string terminator.
function jsq(s){ return esc(String(s==null?'':s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")); }
// "I cannot resolve this person" — you only ever see your own friends. It is a REAL WORD on
// purpose: this value flows into a dozen `name || fallback` expressions written long before it
// existed, and every one of them prints it. A sentinel nobody can read (a null byte, say) turns
// those into garbage on screen. Declared above its first use because "used before it is declared"
// is the shape of every boot crash this project has had.
const UNKNOWN_NAME = 'Someone';
const isUnknownName = n => !n || n === UNKNOWN_NAME;
async function nameOf(id){
  if(id===ME.id) return 'You';
  const f = (await H.get('/api/friends'));
  const arr = (f && f.friends) ? f.friends : (Array.isArray(f)?f:[]);
  const hit = arr.find(x=>x.id===id);
  // NOT a name. This is "I could not resolve this person" — you only see your own friends. It used
  // to render straight into the page as "with @friend, @friend", so callers must check for it.
  return hit ? hit.displayName : UNKNOWN_NAME;
}
function fmtDate(s){ const d=new Date(s); return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
// Shared by fmtWhen and isSessionLiveNow, which both need "what calendar day is this, locally".
function startOfDay(x){ const y = new Date(x); y.setHours(0,0,0,0); return y; }
// "Today" in the phone's own timezone, as YYYY-MM-DD — never toISOString().slice(0,10), which is
// UTC-today and can already be tomorrow for a US evening. Sent to /lock (see lock() below) so the
// server credits Finish to the calendar day the person actually experienced it on.
function localDateStr(d){ d=d||new Date(); const pad=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
// Whole calendar days between today and iso — negative means iso is in the past. Used to decide
// whether a friend's joinable workout is still current (see the Friends' Workouts section of
// home() below), separately from fmtWhen's Today/Tomorrow/Yesterday display wording.
function dayDiff(iso){ const d = new Date(iso); if(isNaN(d)) return 0; return Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000); }
// "Aug 19, 5:30 PM" does not answer the question you are actually asking about an invitation,
// which is whether you can make it. Today / Tomorrow / Yesterday do. Anything further out keeps
// the date, because "in 9 days" is not how anyone thinks about next Thursday.
function fmtWhen(iso){
  const d = new Date(iso); if(isNaN(d)) return fmtDate(iso);
  const time = d.toLocaleString(undefined,{hour:'numeric',minute:'2-digit'});
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  if(days === 0)  return `Today, ${time}`;
  if(days === 1)  return `Tomorrow, ${time}`;
  if(days === -1) return `Yesterday, ${time}`;
  return fmtDate(iso);
}
// The heading for a workout, and the line under it. ALL THREE views of a workout use these —
// openSession, viewPost and the edit screen — because a workout you opened as "Push Day" that
// retitles itself to a date the moment you tap Edit reads like you opened the wrong one.
// .trim() matters: a name of "   " is truthy and used to render a completely blank <h1>.
function sessTitle(s){ const n = (s && s.name || '').trim(); return n ? esc(n) : fmtWhen(s.scheduledAt); }
function sessSub(s){ const n = (s && s.name || '').trim(); return n ? fmtWhen(s.scheduledAt) + ' · ' : ''; }
// Has THIS user finished this session — the same signal that hides the "Log & Finish" button
// elsewhere (see the local `hasFinished`/`hasFinishedPost` consts in openSession()/viewPost()) and
// that server.js's own myWorkouts filter uses to decide a workout belongs on the profile. Jeff,
// Aug 27: "When I log and finish a workout it should move off of my sessions and now onto my
// profile" -- Log & Finish credits s.history the moment you tap it (creditFinish, in /lock), which
// is also the moment it starts showing on your profile. Checking s.posts[userId] alone (whether
// you went on to also save notes/a photo on the following screen) left a real gap: finished and on
// your profile, but stuck "Live now" on Home until that separate, easy-to-skip save happened too.
function hasFinishedSession(s, userId){
  return !!(s && ((s.posts && s.posts[userId]) || (s.history||[]).some(h=>h.userId===userId)));
}
// "Live now" for the Home list: today's date (same local-midnight-to-midnight window fmtWhen
// labels "Today") and not yet finished. Deliberately NOT "any unposted session up to now" — an
// old abandoned draft from last week would then read as live forever, which is worse than not
// flagging it at all (see CLAUDE.md: discoverable and wrong beats quiet, but only when it's
// actually true).
// Jeff, Aug 31: "I don't want my workout to show 'live' until 10 minutes before the scheduled
// time." Showing Live all day for an 8pm workout at 7am read as "happening right now," which
// wasn't true yet. Once you're inside the window (or the scheduled time has already passed
// today), it flips to Live and stays Live for the rest of the day, same as before -- only the
// START of the window moved. isSessionUpcoming (below) covers the rest of today, before that.
const LIVE_WINDOW_MIN = 10;
function isSessionLiveNow(s){
  if(!s || hasFinishedSession(s, ME.id)) return false;
  const d = new Date(s.scheduledAt); if(isNaN(d)) return false;
  if(startOfDay(d).getTime() !== startOfDay(new Date()).getTime()) return false;
  return Date.now() >= d.getTime() - LIVE_WINDOW_MIN*60000;
}
// Today's session, not yet finished, but still more than LIVE_WINDOW_MIN minutes out -- "Upcoming"
// rather than "Live now" (see isSessionLiveNow just above for why the split exists). Mutually
// exclusive with isSessionLiveNow by construction (same guards, opposite side of the same instant).
function isSessionUpcoming(s){
  if(!s || hasFinishedSession(s, ME.id)) return false;
  const d = new Date(s.scheduledAt); if(isNaN(d)) return false;
  if(startOfDay(d).getTime() !== startOfDay(new Date()).getTime()) return false;
  return Date.now() < d.getTime() - LIVE_WINDOW_MIN*60000;
}
// A scheduled workout whose day has passed with nothing logged for YOU looks identical to
// tomorrow's plan on Home — flagged "Missed" here, never hidden, deleted, or blocked from late
// logging (CLAUDE.md: discoverability over minimalism). v187 made finishing per-person, so this
// only ever claims something about viewerId's OWN history/logs — a training partner finishing,
// or logging their own sets, says nothing about whether YOU did.
function isSessionMissed(s, viewerId){
  if(!s || !viewerId) return false;
  const d = new Date(s.scheduledAt); if(isNaN(d)) return false;
  if(dayDiff(s.scheduledAt) >= 0) return false;
  if((s.history||[]).some(h=>h.userId===viewerId)) return false;
  if(s.logs && s.logs[viewerId] && s.logs[viewerId].length) return false;
  return true;
}
// Session-level: has ANYONE finished and posted their recap on this workout? Each participant now
// finishes and posts independently (s.posts, keyed by userId — see server.js), so this is used only
// for "has this workout moved past the active/editable phase for at least one person" checks, never
// for "have I personally finished" — that's s.posts[ME.id] (a.k.a. myPost) at each call site.
function sessionHasAnyPost(s){ return !!(s && s.posts && Object.keys(s.posts).length); }

// ---- Auth screens ----
function authScreen(){
  $('app').innerHTML = `<div class="wrap center">
    <h1>CrewFit</h1><div class="muted">Train together. Log your own.</div>
    <div class="card" style="text-align:left;margin-top:24px">
      <h2>Login</h2>
      <input id="lx" placeholder="username">
      <input id="lp" placeholder="password" type="password">
      <button class="blue" onclick="doLogin()">Login</button>
      <div style="text-align:center;margin-top:10px"><button class="linkbtn" onclick="showReg()">Create new user</button></div>
      <div style="text-align:center;margin-top:4px" class="muted sm-text">Forgot your password? Ask Jeff to reset it.</div>
      <div id="regbox" style="display:none;margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
        <h2>New account</h2>
        <input id="rx" placeholder="username" autocomplete="off" oninput="checkUsername()">
        <div id="rxHint" class="muted" style="font-size:12px;margin:4px 0 0;min-height:14px"></div>
        <input id="rp" placeholder="password (6+ characters)" type="password">
        <input id="rn" placeholder="display name (optional)">
        <button id="regBtn" onclick="doReg()">Create account</button>
      </div>
    </div></div>`;
  window.scrollTo(0,0);
}
function showReg(){ const b=document.getElementById('regbox'); if(b) b.style.display = b.style.display==='none'?'block':'none'; }
let _chkTimer;
async function checkUsername(){
  const inp = document.getElementById('rx'); const hint = document.getElementById('rxHint'); const btn = document.getElementById('regBtn');
  const v = (inp.value||'').trim().toLowerCase();
  clearTimeout(_chkTimer);
  if(!v){ hint.textContent=''; hint.style.color=''; btn.disabled=false; return; }
  hint.textContent='Checking availability…'; hint.style.color='';
  _chkTimer = setTimeout(async ()=>{
    try {
      const r = await H.get('/api/register/check?username='+encodeURIComponent(v));
      if(r.available){ hint.textContent='✓ username available'; hint.style.color='var(--green)'; btn.disabled=false; }
      else { hint.textContent='✕ username taken'; hint.style.color='var(--red)'; btn.disabled=true; }
    } catch(e){ hint.textContent=''; hint.style.color=''; btn.disabled=false; }
  }, 350);
}
// forgotFlow() is gone with the endpoints behind it — see the comment above /api/forgot in
// server.js. It let anyone reset anyone's password from the login screen.
async function doLogin(){ try { const r=await H.post('/api/login',{username:$('lx').value,pin:$('lp').value}); if(r.token){ setToken(r.token,r.user); home(); } else alert(r.error||'login failed'); } catch(e){ alert('Network error — is CrewFit reachable? Try reopening the app.'); } }
async function doReg(){ try {
  const btn = document.getElementById('regBtn');
  if(btn && btn.disabled) return;
  const u=($('rx').value||'').trim().toLowerCase();
  if(u){ try { const c=await H.get('/api/register/check?username='+encodeURIComponent(u)); if(c && c.available===false){ alert('username taken'); return; } } catch(e){} }
  if(($('rp').value||'').length < 6){ alert('Password must be at least 6 characters.'); return; }
  const r=await H.post('/api/register',{username:$('rx').value,pin:$('rp').value,displayName:$('rn').value}); if(r.token){ setToken(r.token,r.user); home(); } else alert(r.error||'register failed'); } catch(e){ alert('Network error — is CrewFit reachable? Try reopening the app.'); } }

// ---- Nav / browser Back ----
// v254 (Jeff): "when I press back I want the page I was just on, not Home" -- nothing in this app
// ever touched the History API, so the hardware/gesture Back button had no in-app stack to walk
// and just left/reloaded instead.
//
// `navigated(state)` is called at every GENUINE navigation (never a silent same-screen refresh --
// same !silent rule the scroll-reset below piggybacks on) to push a history entry and scroll to
// the top of the new screen. `landOn(state)` does the same bookkeeping WITHOUT pushing, for the
// one case that must not: popstate's own handler below, since the browser already moved the
// history pointer itself -- pushing again there would insert a duplicate entry and break Forward.
// Functions that support being reached this way take an `opts.fromHistory` flag and call whichever
// of the two applies; see openSession/viewPost/profileView/followList/libOpenMuscle/library.
//
// Deliberately scoped to screens that redraw from a plain id (tabs, a session, a post, a profile,
// a follow list, a library / a muscle group) -- multi-step flows with real in-progress state (the
// create-flow / routine-editor screens, already guarded by TPL_MODE/EDITING_*/resetTransientModes)
// keep their existing explicit Cancel/Back buttons untouched rather than risk reconstructing that
// state wrong from a bare history entry: Back from inside one of those lands you on the last
// screen that WAS tracked, same as tapping Cancel does today -- not a regression, just not (yet)
// its own step in the stack.
let CURRENT_NAV_STATE = {t:'tab', tab:'home'};
function navigated(state){
  CURRENT_NAV_STATE = state;
  window.scrollTo(0,0);
  history.pushState(state, '', location.href);
}
function landOn(state){
  CURRENT_NAV_STATE = state;
  window.scrollTo(0,0);
}
// keepModes is passed ONLY by the two places that deliberately open the library in a mode:
// openAddExercises (adding to a draft) and openSwapPicker (choosing a replacement). Every other
// route here is a person tapping the bottom nav, and that has to be an escape hatch — SWAP_MODE
// was otherwise never cleared by navigating away, so the Workouts tab stayed stuck in "Pick
// replacement" forever and later taps filed swaps against a workout you had long since left.
function showTab(tab, keepModes){
  UI_EPOCH++; // v250: a tab switch also counts as "the user moved on" -- see the comment above it
  if(!keepModes) resetTransientModes();
  document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  if(tab==='home') home(); else if(tab==='progress') progressScreen(); else if(tab==='lib') library({silent:true}); else if(tab==='templates') templates(); else if(tab==='friends') friends(); else if(tab==='me') meScreen();
  navigated({t:'tab', tab});
}
// v254: the popstate target for a {t:'tab',...} entry -- deliberately NOT routed through showTab
// itself, since showTab always pushes a fresh entry (right, for a real tap; wrong here, where the
// browser already moved the pointer for us).
function renderTabState(tab){
  resetTransientModes();
  document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  if(tab==='home') home(); else if(tab==='progress') progressScreen(); else if(tab==='lib') library({silent:true}); else if(tab==='templates') templates(); else if(tab==='friends') friends(); else if(tab==='me') meScreen();
}
function renderNavState(st){
  if(st.t==='tab') renderTabState(st.tab);
  else if(st.t==='session') openSession(st.id, {fromHistory:true});
  else if(st.t==='post') viewPost(st.id, st.authorId, {fromHistory:true});
  else if(st.t==='profile') profileView(st.id, {fromHistory:true});
  else if(st.t==='followList') followList(st.id, st.kind, {fromHistory:true});
  else if(st.t==='muscle') libOpenMuscle(st.m, {fromHistory:true});
  else if(st.t==='library') library({fromHistory:true});
  else if(st.t==='seeds') seedSetupScreen({fromHistory:true});
  else renderTabState('home');   // an old/unrecognized entry (e.g. a stray 'sheet' marker) -- never strand the user on nothing
}
// A tab-state landing needs its own landOn() call (nothing inside home()/library()/etc. does it,
// unlike the id-based screens below, which each call navigated()/landOn() themselves).
function popToNavState(st){
  renderNavState(st);
  if(st.t==='tab') landOn(st);
}
window.addEventListener('popstate', (e)=>{
  // A sheet's own history entry (see openSheetHtml/closeSheet below) means Back should just
  // dismiss it, exactly like tapping its ✕ -- not touch the screen underneath, which is already
  // showing correctly and shouldn't be re-rendered (and re-scrolled) out from under the user.
  if(document.querySelectorAll('.sheet-back').length){ closeSheet(true); return; }
  popToNavState(e.state || {t:'tab', tab:'home'});
});
// Everything here is a half-finished intention. None of it should survive walking away from the
// screen that started it, and each one caused a real bug by doing so.
function resetTransientModes(){
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;   // stuck "Pick replacement" library
  SUGGEST_ADD_MODE = false; SUGGEST_ADD_SESSION = null;       // stuck "suggest adding" library
  SEED_MODE = false;                                          // stuck "Add a lift" library (seed setup)
  LIB_ADDMODE = false;                                        // stuck "Done (n)" library
  QUICK_ADD_MODE = false;                                     // stuck Quick Workout picker
  EDITING_SESSION = null;                                     // next new workout saved over the edited one
  EDITING_ID = null;                                          // stuck inline-edit on a posted workout
  EDITING_TPL = null;                                         // stuck template edit
  if(typeof TPL_MODE === 'object' && TPL_MODE) { TPL_MODE.active = false; TPL_MODE.id = null; TPL_MODE.name = ''; TPL_MODE.copy = false; }
}

// ---- Open empty states (v222 Home, v225 app-wide) ----
// A card ("pill box") is only drawn when there is something in it. An empty section stays OPEN
// on the page: icon, one bold line, one muted line, optional CTA — no container. Section headers
// around them always render (discoverability rule), so nothing becomes hidden.
// STATIC STRINGS ONLY — nothing here is esc()'d. Never pass server- or user-derived text.
const homeEmpty = (icon, title, sub, cta) =>
  `<div class="home-empty">${icon}<div class="he-title">${title}</div><div class="he-sub">${sub}</div>${cta||''}</div>`;
const ICON_CAL = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5" width="17" height="15.5" rx="3" stroke="#9ca3af" stroke-width="1.6"/><path d="M3.5 9.5h17M8.5 3.5v3M15.5 3.5v3" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_PEOPLE = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M8 6a3 3 0 1 1 6 0 3 3 0 0 1-6 0Zm-5 13c0-3 3.5-5 8-5" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round"/><circle cx="17" cy="8" r="2.4" stroke="#9ca3af" stroke-width="1.6"/><path d="M14 19c0-2.2 2-3.6 4.4-3.6" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_FEED = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M4 18V8l8-4 8 4v10" stroke="#9ca3af" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 18v-6h6v6" stroke="#9ca3af" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const ICON_LIST = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><rect x="4" y="3.5" width="16" height="17" rx="3" stroke="#9ca3af" stroke-width="1.6"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.5" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// ---- Home / sessions (Option B: split sections) ----
async function home(opts){
  // v254: opts.silent -- declineInvite is the one caller that refreshes Home IN PLACE (dismissing
  // an invite banner, still looking at Home) rather than genuinely navigating here; every other
  // caller (tab tap, boot, Cancel out of create-flow, leaving/deleting a workout, resetting stats)
  // really is landing on Home from somewhere else, so those stay non-silent. Without this gate the
  // scrollTo(0,0) below would yank a scrolled Home back to the top just from dismissing a banner.
  const silent = !!(opts && opts.silent);
  // weeks=26, not 4: streakWeeks is computed inside the requested window, so a 4-week request
  // silently caps the streak stat at "4 week streak" — false for anyone on a longer run.
  const [sessions, feed, _fr, prog] = await Promise.all([
    H.get('/api/sessions'), H.get('/api/feed'), H.get('/api/friends'), H.get('/api/progress?weeks=26')
  ]);
  const myFriends = (_fr && _fr.friends) ? _fr.friends : (Array.isArray(_fr) ? _fr : []);
  const friendName = async (id)=> myFriends.find(f=>f.id===id)?.displayName || 'A friend';   // reads as a phrase, not as someone's name
  const initial = ((ME&&(ME.displayName||ME.username))||'?')[0]||'?';
  const first = ((ME.displayName||ME.username||'there').split(' ')[0]);
  // v221 header (Jeff, Aug 28: whole-app visual pass). Replaces the random hype lines with a
  // time-of-day greeting plus two things that are only ever TRUE (design constant: never claim
  // history you can't stand behind):
  //   - a "Last workout: Tuesday · Pull-Up Day" line, from my own finished sessions
  //   - a stat row that NEVER renders a zero. It picks the first three stats from a priority
  //     list that have something real to say (streak, this week, PRs this week), falling back to
  //     numbers that only count up (total logged, best lift, with friends). A quiet month never
  //     reads "0 PRs" — the stat simply isn't shown. Brand-new user: no row at all.
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const mine = sessions.filter(s => (s.history||[]).some(h => h.userId === ME.id));
  // "when" for a finished session: prefer my latest LOG timestamp (full ISO, converts to the
  // user's local day correctly) over history.date, which the server stamps as a UTC calendar
  // day — an 8pm ET workout lands on tomorrow's UTC date, and date-only strings can't be
  // un-shifted client-side. Logs are visible to me on my own sessions; history.date is the
  // fallback for sessions finished without logging any sets.
  const whenDone = (s) => {
    const logAts = ((s.logs && s.logs[ME.id]) || []).map(l => l.at).filter(Boolean).sort();
    if(logAts.length) return new Date(logAts[logAts.length - 1]);
    const d = (s.history||[]).filter(h => h.userId === ME.id).map(h => h.date).sort().slice(-1)[0];
    return d ? new Date(d + 'T12:00:00') : null;                 // noon dodges TZ edge-of-day drift
  };
  const lastDone = mine
    .map(s => ({ s, when: whenDone(s) }))
    .filter(x => x.when && !isNaN(x.when))
    .sort((a,b) => b.when - a.when)[0] || null;
  const fmtLastDay = (then) => {
    const t = new Date(then); t.setHours(12,0,0,0);
    const today = new Date(); today.setHours(12,0,0,0);
    const days = Math.round((today - t) / 86400e3);
    if(days <= 0) return 'today';
    if(days === 1) return 'yesterday';
    if(days < 7) return then.toLocaleDateString(undefined, { weekday:'long' });
    return then.toLocaleDateString(undefined, { month:'short', day:'numeric' });
  };
  const weekAgoMs = Date.now() - 7*86400e3;
  const earnedPrs = ((prog && prog.prs) || []).filter(p => p.source === 'earned' && !p.firstLog);
  const prsThisWeek = earnedPrs.filter(p => new Date(p.at).getTime() >= weekAgoMs).length;
  // v249 (audit finding): this comment used to claim records "carry no unit field" and are
  // therefore safe to label with prog.unit, the page's current unit preference — that was true
  // only by accident, because rebuildAllPrs() (server.js) used to silently drop the unit a PR was
  // actually logged in. Now that it's carried through (see the comment there), a record logged in
  // kg reads back as kg here too, same as the Progress tab's prLabel. The raw-number sort just
  // below is comparing different EXERCISES' weights against each other regardless of unit either
  // way — an existing, separate simplification (picking "best" by biggest number, not adjusted
  // per lift) this fix does not touch.
  const best = earnedPrs.filter(p => Number(p.weight) > 0).sort((a,b) => Number(b.weight) - Number(a.weight))[0] || null;
  const withFriends = mine.filter(s => (s.participants||[]).some(x => x && x !== ME.id)).length;
  const statPool = [];
  const streakW = (prog && prog.streakWeeks) || 0;
  const thisWeek = (prog && prog.thisWeek) || 0;
  if(streakW >= 2) statPool.push({ num: streakW, lbl: 'week streak' });
  // "days trained", not "workouts" — thisWeek counts distinct days with working sets (same
  // signal the Progress tab labels days/week), and two sessions in one day would make
  // "workouts" a false claim.
  if(thisWeek >= 1) statPool.push({ num: thisWeek, lbl: thisWeek === 1 ? 'day trained this week' : 'days trained this week' });
  if(prsThisWeek >= 1) statPool.push({ num: prsThisWeek, lbl: prsThisWeek === 1 ? 'PR this week' : 'PRs this week' });
  if(mine.length >= 1) statPool.push({ num: mine.length, lbl: mine.length === 1 ? 'workout logged' : 'workouts logged' });
  if(best) statPool.push({ num: `${best.weight} ${unitOf(best)}`, lbl: 'best ' + best.exercise });
  if(withFriends >= 1) statPool.push({ num: withFriends, lbl: 'with friends' });
  const stats = statPool.slice(0, 3);
  const homeAvatarHtml = ME && ME.avatar
    ? `<img class="home-avatar" src="${esc(ME.avatar)}" alt="" onclick="showTab('me')">`
    : `<div class="home-avatar" onclick="showTab('me')">${esc(initial.toUpperCase())}</div>`;
  let html = `<div class="wrap home-head">
    <div class="home-top">
      <div>
        <div class="home-greet">${greet}, ${esc(first)}</div>
        ${lastDone ? `<div class="home-sub">Last workout: ${esc(fmtLastDay(lastDone.when))} · ${esc((lastDone.s.name || '').trim() || 'Workout')}</div>` : ''}
      </div>
      ${homeAvatarHtml}
    </div>
    ${stats.length ? `<div class="home-stats">${stats.map(st =>
      `<div class="hstat"><div class="num">${esc(String(st.num))}</div><div class="lbl">${esc(st.lbl)}</div></div>`).join('')}</div>` : ''}`;

  // Invites slot: blue banner when pending, else subtle empty-state hint (so new users learn the feature exists)
  const pending = sessions.filter(s=>Array.isArray(s.invited)&&s.invited.includes(ME.id));
  if(pending.length){
    html += `<div class="inv-banner">`;
    for(const s of pending){
      const creatorName = await friendName(s.creatorId);
      // The row is TAPPABLE. It had no handler at all, so a pending invite could only be accepted
      // or declined blind — there was no way to look at the workout first, and tapping it did
      // nothing: no spinner, no error, nothing. That is the bug Jeff reported on Aug 17.
      // stopPropagation sits on the button WRAPPER, not just the buttons, so the 6px gap between
      // Accept and Decline is not a stray "open the workout" tap target.
      html += `<div class="inv-card" onclick="openSession('${s.id}')">
        <div class="inv-info"><b>${esc(creatorName)}</b> invited you<div class="tag">${esc(s.name||'Workout')} · ${plur(s.exercises.length,'exercise')}</div>
          <div class="inv-open">See the workout →</div></div>
        <div class="row inv-actions" onclick="event.stopPropagation()">
          <button class="sm blue" onclick="acceptInvite('${s.id}')">Accept</button>
          <button class="sm gray" onclick="declineInvite('${s.id}')">Decline</button>
        </div>
      </div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="inv-empty">No invites yet — friends you train with will show up here.</div>`;
  }

  // Primary action (compact), plus a zero-friction start for "I'm at the gym right now" — no
  // name, no schedule, no invite step, just a live session you add lifts to as you go. Jeff, Aug
  // 25: "a 'workout now' button or something for quick workouts."
  html += `<div class="home-actions">
    <button class="blue btn-new" onclick="newWorkout()">+ New workout</button>
    <button class="btn-quick" onclick="workoutNow()">+ Quick Workout</button>
  </div>`;

  // Your Sessions (prime spot) — only sessions you've accepted/joined (exclude pending invites),
  // and only ones still open FOR YOU. Once YOU have finished (hasFinishedSession — Log & Finish
  // credits this the moment you tap it, same signal server.js's myWorkouts uses; each participant
  // finishes independently), it's done for you: it belongs in "My Workouts" on your profile, not
  // in this active list — even if a training partner on the same session hasn't finished yet, and
  // even if you never went on to also save notes/a photo on the screen after Log & Finish.
  // Today's not-yet-finished session (if any) is pulled to the top with a "Live now"/"Upcoming"
  // badge — .sort() is stable (every browser this app targets), so this only reorders today's
  // sessions forward and otherwise leaves everything exactly where the API's date order put it.
  // Both Live and Upcoming count as "today" here (unchanged from before the 10-minute-window
  // split above) — only the badge text/timing changed, not which sessions get pulled to the top.
  const yours = sessions.filter(s => s.name && s.participants.includes(ME.id) && !(Array.isArray(s.invited) && s.invited.includes(ME.id)) && !hasFinishedSession(s, ME.id))
    .sort((a,b) => ((isSessionLiveNow(b)||isSessionUpcoming(b))?1:0) - ((isSessionLiveNow(a)||isSessionUpcoming(a))?1:0));
  html += `<h2>Your Sessions</h2>`;
  if(yours.length){
    html += `<div class="card">`;
    for(const s of yours){
      const label = s.name;
      const live = isSessionLiveNow(s);
      const upcoming = !live && isSessionUpcoming(s);
      const missed = !live && !upcoming && isSessionMissed(s, ME.id);
      const badge = live ? '<div class="live-badge">● Live now</div>'
        : upcoming ? '<div class="upcoming-badge">Upcoming</div>'
        : missed ? '<div class="missed-badge">Missed</div>' : '';
      html += `<div class="lib-item${live?' session-live':''}" onclick="openSession('${s.id}')">
        <div>${badge}<b>${esc(label)}${s.exercises.length?` · ${plur(s.exercises.length,'exercise')}`:''}</b><div class="tag">${fmtWhen(s.scheduledAt)}</div></div></div>`;
    }
    html += `</div>`;
  } else {
    html += homeEmpty(ICON_CAL, 'No upcoming sessions', 'Plan one with + New workout, or start a Quick Workout right now.');
  }

  // Friends' Workouts — a friend's own joinable session, discoverable even before you have any
  // invite or join step in it. Jeff, Aug 20: "If i follow someone on the app and they approve ...
  // I want to be able to see all active workouts they have that are public. Even ones they have
  // before I followed them that are still active or awaiting." Past-dated does not mean done: a
  // workout the creator has not finished yet (creatorFinished, from sessionView) stays here past
  // its original date, same as it would still be open for them. Missing creatorFinished (an older
  // session shape) fails OPEN — shown, not silently hidden.
  const friendIds = new Set(myFriends.map(f=>f.id));
  const joinable = sessions.filter(s => s.name
    && s.visibility === 'friends'
    && friendIds.has(s.creatorId)
    && !(s.participants||[]).includes(ME.id)
    && !(Array.isArray(s.invited) && s.invited.includes(ME.id))
    && (dayDiff(s.scheduledAt) >= 0 || !s.creatorFinished));
  html += `<h2 class="light">Friends' Workouts</h2>`;
  if(joinable.length){
    html += `<div class="card">`;
    for(const s of joinable){
      const creatorName = await friendName(s.creatorId);
      html += `<div class="lib-item" onclick="openSession('${s.id}')">
        <div><b>${esc(s.name)}${s.exercises.length?` · ${plur(s.exercises.length,'exercise')}`:''}</b><div class="tag">${esc(creatorName)} · ${fmtWhen(s.scheduledAt)}</div></div></div>`;
    }
    html += `</div>`;
  } else {
    html += homeEmpty(ICON_PEOPLE, 'No joinable workouts right now', `When a friend starts one you can join, it'll show up here.`);
  }

  // Friend's Activity (lighter strip, in an elevated card to match Your Sessions)
  html += `<h2 class="light">Friends' Activity</h2>`;
  if(feed.length){
    html += `<div class="card feed-strip">`;
    for(const f of feed){
      const who = await friendName(f.by);
      if(f.type==='recap' && f.sessionId){
        // a posted recap is a THING to open, not just a fact - tap goes to the workout itself
        const lead = f.thumb ? `<img class="feed-thumb" src="${esc(f.thumb)}" alt="">` : `<span class="act-chip done">✓</span>`;
        // .feed-lead is a fixed 36px column (Jeff, Aug 28 2026): photo thumbs, check pills and PR
        // pills are all different widths, so without it the NAME started at a different x on every
        // row type and mixed feeds looked ragged. Every feed row's lead must sit inside one.
        html += `<div class="feed-item feed-recap" onclick="viewPost('${f.sessionId}','${f.by}')" style="cursor:pointer"><span class="feed-lead">${lead}</span><span><b>${esc(who)}</b> ${esc(f.text)}</span></div>`;
        continue;
      }
      const ic = f.type==='pr' ? `<span class="act-chip act-pr">PR</span>` : `<span class="act-chip done">✓</span>`;
      html += `<div class="feed-item" onclick="profileView('${f.by}')" style="cursor:pointer"><span class="feed-lead">${ic}</span><span><b>${esc(who)}</b> ${esc(f.text)}</span></div>`;
    }
    html += `</div>`;
  } else {
    // CTA label is honest either way: no friends yet -> "Add a friend", some friends -> invite more
    html += homeEmpty(ICON_FEED, 'Nothing from your crew yet', `Friends' finished workouts will show up here.`,
      `<span class="he-cta" onclick="showTab('friends')">${myFriends.length ? 'Invite another friend' : 'Add a friend'} →</span>`);
  }
  html += `</div>`;
  $('app').innerHTML = html;
  if(!silent) window.scrollTo(0,0);
}

// Bumped on every silent refresh kicked off below, so an older, slower response can never
// overwrite what a newer one already applied (e.g. two quick taps on "+ Add" firing two
// out-of-order background refreshes).
let SESSION_SILENT_SEQ = 0;
// The exercise-card recommendation text (below) is deliberately not re-fetched on a silent
// refresh -- but $('app').innerHTML is still fully rewritten on that same silent pass (every
// openSession render replaces the whole card list, silent or not), so without saving what the
// last REAL fetch found, that rewrite would blank out the recommendation on every exercise
// EXCEPT the one just logged -- not just skip re-fetching for it. Keyed by session id so a
// stale cache from a previous session can never leak into a different one's cards.
let REC_BY_NAME_CACHE = { sid: null, data: {} };
// A silent refresh is "for" this exact sheet — the one open when it was kicked off — not just
// "any sheet at all": editLogSet stacks a second .sheet-back on top of the log sheet without
// closing it, so while both are open a generic .sheet-back.show selector here would match
// whichever one is on top, not necessarily this one. Checking the specific element openLogSheet
// stamped onto LOGVIEW avoids that ambiguity regardless of which sheet closeSheet() targets.
function logSheetStillOpenFor(sid){
  return !!(LOGVIEW && LOGVIEW.sid===sid && LOGVIEW.sheetEl
    && document.body.contains(LOGVIEW.sheetEl) && LOGVIEW.sheetEl.classList.contains('show'));
}
// opts.silent: used for a background refresh fired after logging/editing/deleting a set, to
// update the "✓ N sets logged" badge on the page sitting UNDER the still-open log sheet —
// without leaving and re-entering. Must never alert() or steal the screen: if the fetch fails
// (expired session included — authScreen() may already have repainted #app to the login
// screen by the time this resolves), or the user has since closed the sheet or navigated
// elsewhere, it just quietly does nothing.
async function openSession(id, opts){
  const silent = !!(opts && opts.silent);
  const fromHistory = !!(opts && opts.fromHistory);   // v254: reached via popstate -- land, don't push again
  // v254: opts.quiet is DELIBERATELY separate from opts.silent, not another name for the same
  // thing. silent's meaning predates this fix and is narrow and specific -- SESSION_SILENT_SEQ/
  // logSheetStillOpenFor below gate it to exactly one case: a background refresh behind a still-
  // open log sheet, and the whole function returns early (before ever rendering) if that specific
  // sheet isn't open. sendChat/suggest/approve/reject/approveJoin/rejectJoin/requestJoin/
  // enterWorkoutEdit/exitWorkoutEdit/saveWorkoutEditConfirmed all re-render this SAME session
  // screen after an action taken ON it, with no log sheet involved -- passing silent:true for
  // those (an earlier draft of this fix did) made the function bail out at the logSheetStillOpenFor
  // check and never render at all, silently no-op'ing e.g. every Approve/Reject tap. quiet:true
  // renders normally (UI_EPOCH still bumps, exactly as these callers' pre-v254 plain openSession(id)
  // calls always did) and only skips the new navigated()/landOn() scroll+history call below.
  const quiet = !!(opts && opts.quiet);
  // v250 (audit follow-up): same gap as profileView()/followList()/viewPost() -- a real
  // (non-silent) call here is a navigation to a full-screen view without a tab switch or new
  // sheet. A silent background refresh is NOT a navigation (it updates the sheet already on
  // screen), so it must not bump this -- doing so would make a legitimate fast-resolving
  // editBio/editDefaultGym save on the SAME screen look stale for no reason. Bumped up front,
  // before the fetch below, so a slow unrelated save can't resolve in the gap between this tap
  // and the fetch finishing and still think it's on the old screen.
  if(!silent) UI_EPOCH++;
  const mySeq = silent ? ++SESSION_SILENT_SEQ : null;
  const s = await H.get('/api/sessions/'+id);
  if(!s || s.error){ if(!silent && !s._expired) alert(s && s.error ? s.error : 'Session not found'); return; }
  if(silent && (mySeq !== SESSION_SILENT_SEQ || !logSheetStillOpenFor(id))) return;
  // defensive: older/persisted sessions may lack these array fields
  s.participants = s.participants || [];
  s.invited = s.invited || [];
  s.exercises = s.exercises || [];
  s.suggestedEdits = s.suggestedEdits || [];
  s.joinRequests = s.joinRequests || [];
  s.variations = s.variations || {};
  s.posts = s.posts || {};
  // Someone holding an invitation is given COUNTS, not sets — the server will not hand a
  // non-participant another person's logged weights, only how many there were. These read
  // whichever of the two the server sent.
  const setsOn = (pid, exId) => (s.logs && s.logs[pid])
    ? s.logs[pid].filter(l => l.exerciseId === exId).length
    : (((s.logCounts || {})[pid] || {})[exId] || 0);
  const setsTotal = pid => (s.logs && s.logs[pid])
    ? s.logs[pid].length
    : Object.values((s.logCounts || {})[pid] || {}).reduce((a, b) => a + b, 0);
  const whoLogged = () => {
    const ids = new Set([...Object.keys(s.logs || {}), ...Object.keys(s.logCounts || {})]);
    return [...ids].filter(pid => setsTotal(pid) > 0);
  };
  const isCreator = s.creatorId===ME.id;
  // Each participant finishes and posts their own recap independently now (s.posts, keyed by
  // userId — see server.js). "myPost" is MY OWN recap on this session, if I've posted one.
  const myPost = s.posts[ME.id];
  // Inline edit mode for a saved (posted) workout: render the whole page editable. Creator-only --
  // it edits the shared exercise list, which everyone else on this session is counting on. Jeff,
  // Aug 28, first asked for non-creator parity here, then narrowed it to "I don't want to change
  // the exercises - just my logged sets" (+ photos/notes/removing it from his profile) -- see the
  // big comment above viewPost for where those actually live.
  if(EDITING_ID===id && isCreator && myPost){ renderWorkoutEdit(s); return; }
  const isParticipant = s.participants.includes(ME.id);
  // "in the workout" = you are actually part of it, not merely allowed to look at it
  const inTheWorkout = isParticipant || s.creatorId === ME.id || (Array.isArray(s.invited) && s.invited.includes(ME.id));
  const approvedJoin = s.joinRequests.find(j=>j.userId===ME.id&&j.status==='approved');
  const canEdit = myPost ? isCreator : (isParticipant || approvedJoin);
  // Suggesting is for everyone EXCEPT the creator, who does not need to suggest anything — they
  // have Edit. It rendered only for the creator, which is exactly backwards: the person holding
  // an invitation, the one with a reason to say "not Barbell Row", never saw it at all.
  const canSuggest = !isCreator && !sessionHasAnyPost(s) && !canEdit
    && Array.isArray(s.invited) && s.invited.includes(ME.id);
  // suggested edits, keyed by target exercise id (compact one-line inline row, C style)
  const editByEx = {};
  for(const ed of s.suggestedEdits){
    // v262b: an "add a new exercise" suggestion (see /suggest in server.js) has no exerciseId --
    // it isn't a change to any existing card. Grouping it under the shared editByEx[undefined]
    // bucket would make every OTHER add-suggestion's presence there falsely mark THIS one as
    // "already shown inline" in the fallback list below, hiding all of them.
    if(!ed.exerciseId) continue;
    (editByEx[ed.exerciseId] = editByEx[ed.exerciseId] || []).push(ed);
  }
  // pre-resolve proposer display names (await only at top level, not inside .map)
  const nameCache = {};
  const nameOfCached = async (id) => { if(!(id in nameCache)) nameCache[id] = await nameOf(id); return nameCache[id]; };
  for(const ed of s.suggestedEdits){ await nameOfCached(ed.proposedBy); }
  for(const j of s.joinRequests){ await nameOfCached(j.userId); }
  for(const pid of s.participants){ await nameOfCached(pid); }
  // ...and for anyone who logged sets here, who may no longer be a participant (they left)
  for(const pid of Object.keys(s.logs||{})){ if((s.logs[pid]||[]).length) await nameOfCached(pid); }
  // ...and for pending invitees, but only when the server actually handed us the real list (see
  // invitedIds below) — for anyone else it's just our own id or nothing, already covered above.
  if(isCreator || isParticipant){ for(const pid of (s.invited||[])){ await nameOfCached(pid); } }
  // Jeff, Aug 31: "I am completing a set BEFORE I click tap to log a set... which means I am not
  // seeing the notes on the app telling me what weight to do next." Nothing INSIDE the log sheet
  // can ever fix that -- it only opens after the set it would have informed. This screen's
  // exercise cards are the one place guaranteed to be seen before that first tap (the log sheet
  // stays open for every set of an exercise once you're in it, so you only pass back through here
  // between exercises) -- so a compact version of the same advice belongs on the card itself, not
  // just inside the sheet. Fetched once here rather than once per exercise; skipped entirely when
  // canEdit is false (a spectator/pending-invite view never shows a log tap target, so it never
  // needs this either). Deliberately the barebones /api/progress/recommendations, not the full
  // /api/progress (weeksFor/trendFor/recordsFor) -- this screen only needs the same ready/holds/
  // soon lists recommendationsFor() already produces, not the rest of that work.
  // Also skipped on a silent background refresh (see addLogSet/editLogSet/delLogSetConfirmed's
  // openSession(...,{silent:true}) calls, fired behind a still-open log sheet after every set):
  // the card list isn't visible then, and logging one exercise's set can't change what another
  // exercise's recommendation says -- so re-fetching would be a full extra round trip, on the
  // single highest-frequency action in the app, purchasing an update nothing can see yet.
  // NOT skipped, though, is USING what the last real fetch already found: this whole render
  // still rewrites $('app').innerHTML on a silent pass same as any other (see REC_BY_NAME_CACHE's
  // own comment above) -- an empty recByName here would silently erase the recommendation off
  // every OTHER exercise's card the moment any one set gets logged, not just skip refreshing it.
  const recByName = {};
  if(canEdit && !silent){
    const rec = await H.get('/api/progress/recommendations');
    if(rec && !rec.error){
      for(const x of (rec.ready||[])) recByName[x.exercise] = { state:'ready', weight:x.suggested, unit:rec.unit, bodyweight:x.bodyweight, step:x.step };
      // hold and soon both mean "load the same weight again" from where you're standing -- the
      // difference between them is about how the algorithm got there, not something worth a
      // second phrase on a screen this compact. Only set when ready hasn't already claimed this
      // exercise (it never will for the same exercise, but this mirrors recommendationsFor's own
      // ready/hold/soon being mutually exclusive rather than assuming it silently).
      for(const x of (rec.holds||[])) if(!recByName[x.exercise]) recByName[x.exercise] = { state:'hold', weight:x.weight, unit:rec.unit, bodyweight:x.bodyweight };
      for(const x of (rec.soon||[]))  if(!recByName[x.exercise]) recByName[x.exercise] = { state:'hold', weight:x.weight, unit:rec.unit, bodyweight:x.bodyweight };
    }
    REC_BY_NAME_CACHE = { sid: id, data: recByName };
  } else if(canEdit && silent && REC_BY_NAME_CACHE.sid === id){
    Object.assign(recByName, REC_BY_NAME_CACHE.data);
  }
  // my variation view (each exercise = its own card tile; swap suggestion nested inside)
  const myEx = s.exercises.map(e=>{
    const v = s.variations[e.id] && s.variations[e.id][ME.id];
    // find an approved swap for this exercise (option 1: exercise becomes swapTo + muted "swapped by X")
    const approved = (editByEx[e.id]||[]).find(ed=>ed.status==='approved');
    let name;
    if(approved){
      const byName = nameCache[approved.proposedBy] || approved.proposedBy;
      const disp = (byName||'?').split(' ')[0]; // first name only, muted context
      name = `${esc(approved.swapTo)} <span class="swap-note">· swapped by ${esc(disp)}</span>`;
    } else if(v){
      name = `${esc(v.swapTo)} <span class="swap-note">(your swap)</span>`;
    } else {
      name = esc(e.name);
    }
    // What tapping a card means depends on what you can do right now. If you can log, it logs.
    // If you are still holding an invitation you cannot log yet — so the card is the way to say
    // "this one, not that one", which is the thing the app is actually for.
    // Once a swap is on the table for this lift, the card stops inviting another one — a second
    // proposal on the same exercise is noise for whoever has to decide, and the card should be
    // telling you what is already happening instead.
    const pendingSwap = (editByEx[e.id]||[]).find(ed=>ed.status==='pending');
    const offerSwap = canSuggest && !pendingSwap;
    const tap = canEdit ? ` onclick="openLogSheet('${s.id}','${e.id}')"`
              : (offerSwap ? ` onclick="openSwapPicker('${s.id}','${e.id}')"` : '');
    const cls = (canEdit || offerSwap) ? 'ex-card log-row' : 'ex-card';
    const cnt = (s.logs && s.logs[ME.id]) ? s.logs[ME.id].filter(l=>l.exerciseId===e.id).length : 0;
    const swapBy = pendingSwap
      ? (() => { const n = nameCache[pendingSwap.proposedBy];
                 return n === 'You' ? 'you' : (isUnknownName(n) ? 'someone' : String(n).split(' ')[0]); })()
      : '';
    // Recommendation looked up under whatever openLogSheet will ITSELF look it up under once
    // tapped -- its own recName (openLogSheet, above) only ever checks the CURRENT USER's own
    // personal variation, never an approved swap edit (approving one only records the swap under
    // the proposer's variation, per the approve handler in server.js -- it does not rename the
    // exercise for anyone else). Prioritizing `approved` here the way `name` (the display label
    // above) correctly does would key this lookup by a name the log sheet never actually tracks
    // recommendations under for most viewers -- silently hiding the recommendation (or worse,
    // surfacing a real but unrelated one for whatever exercise happens to share that name).
    // A pending swap means this exercise's identity is still up in the air -- showing a weight
    // recommendation for it now would be advice for whichever lift it turns out NOT to be half
    // the time, so it waits for that to resolve like everything else on this line does.
    const recExName = (v && v.swapTo) || e.name;
    const rec = (canEdit && cnt===0 && !pendingSwap) ? recByName[recExName] : null;
    // Trailing arrow kept on both (Jeff, Aug 31, round 3) -- "Tap to log sets" and "Suggest a
    // swap" both end in one, and this line opens the exact same sheet the same way, so dropping
    // the arrow just because the text changed to a recommendation would make it the odd one out
    // rather than signal anything real. Only "✓ N logged" goes without one, since that line
    // reports something already done rather than prompting the tap.
    const recText = !rec ? '' : rec.state==='ready'
      ? (rec.bodyweight ? `Add ${rec.step} ${rec.unit} today →` : `Try ${rec.weight} ${rec.unit} today →`)
      : (rec.bodyweight ? `Repeat bodyweight →` : `Repeat ${rec.weight} ${rec.unit} →`);
    // Jeff, Aug 31, round 2: the side-by-side badge "loses that clean look" -- back to one line in
    // the exact spot "Tap to log sets" already occupies (same as the original v260 shipped design),
    // but no longer flat blue for both states. "Try X today" (time to add weight) gets the same
    // green the log sheet's own box already uses for that exact state (.log-rec.up), so the two
    // surfaces agree instead of inventing a third shade; "Repeat X" (nothing new) stays a quiet
    // neutral gray -- routine information, not something that needs to compete for attention the
    // way a new max does. rec-${rec.state} carries the color; log-hint keeps the base sizing/spacing
    // so this reads as the same kind of line as every other hint on the list, just recolored.
    // A pending swap outranks everything else this line could say. It is the state of the lift.
    const statusTag = pendingSwap ? `<span class="swap-pending">Swap suggested by ${esc(swapBy)}</span>`
                     : canEdit ? (cnt ? `<span class="logged">✓ ${cnt} set${cnt>1?'s':''} logged</span>`
                                : (recText ? `<span class="log-hint rec-${rec.state}">${esc(recText)}</span>` : `<span class="log-hint">Tap to log sets →</span>`))
                     : (offerSwap ? `<span class="log-hint">Suggest a swap →</span>` : '');
    // Who ELSE has worked this lift. Without it a shared workout shows you nothing your partner
    // did — you invite someone, they train, and the screen looks the same as if you were alone.
    // Gated on inTheWorkout: GET /api/sessions/:id hands the FULL logs of every participant to any
    // friend of the creator, so a friend-of-a-friend who never joined would otherwise be shown
    // Brian's sets — sets Brian never agreed to publish to them. Do not widen this without asking.
    const crew = !inTheWorkout ? [] : whoLogged()
      .filter(pid => pid !== ME.id && setsOn(pid, e.id) > 0)
      .map(pid => {
        const n = setsOn(pid, e.id);
        // each entry carries its own "set/sets" — "Brian 2 · Sam 3 sets" would read as though
        // the count applied to the pair of them
        const who = isUnknownName(nameCache[pid]) ? 'Someone' : String(nameCache[pid]).split(' ')[0];
        return `${esc(who)} ${n} set${n===1?'':'s'}`;
      });
    const crewLine = crew.length ? `<div class="ex-crew">${crew.join(' · ')}</div>` : '';
    // No "4 x 6-8" on the list at all — Jeff's call, twice. The workout list answers one question,
    // which is what you are doing; the prescription is an instruction and it now lives in the log
    // sheet, where you read it at the moment you act on it rather than four lifts in advance.
    let head = `<div class="ex-head"${tap}><div class="ex-main"><div class="ex-name">${name}</div>${statusTag}${crewLine}</div></div>`;
    let sub = '';
    for(const ed of (editByEx[e.id]||[])){
      const byName = nameCache[ed.proposedBy] || ed.proposedBy;
      if(ed.status==='pending'){
        // the status line above already named who; this row is for WHAT and what happens next
        sub += `<div class="req"><div class="rc">${esc(e.name)} → <b>${esc(ed.swapTo)}</b></div>`;
        if(isCreator) sub += `<div class="ra"><button class="sm ok" onclick="approve('${s.id}','${ed.id}')">Approve</button><button class="sm no" onclick="reject('${s.id}','${ed.id}')">Reject</button></div>`;
        else sub += `<div class="ra"><span class="tag">waiting on creator</span></div>`;
        sub += `</div>`;
      }
      // approved/rejected swaps: no residual row (approved becomes the exercise name above; rejected leaves original)
    }
    return `<div class="${cls}">${head}${sub}</div>`;
  }).join('');
  // suggested edits: swaps whose target exercise no longer exists, PLUS -- v262b -- every
  // "add a new exercise" suggestion, which never had a target exercise to begin with (editByEx
  // skips them entirely, see its own comment above). This used to be built and then never
  // actually appended to `html` below (a real, silent bug -- the whole section rendered nothing,
  // ever); fixed as part of wiring "add" suggestions in, since without it there'd be nowhere for
  // a pending add-suggestion to show up at all.
  //
  // v262b also fixed a second bug this uncovered the moment it actually started rendering: the
  // skip condition below used to be `editByEx[ed.exerciseId]` -- but editByEx groups EVERY swap
  // edit by its exerciseId regardless of whether that exercise still exists (it doesn't filter
  // against s.exercises at all, see its own loop above), so a swap targeting an exercise the
  // creator later removed was ALWAYS present in its own editByEx bucket and this check skipped
  // it -- exactly backwards from the comment's stated intent ("kept for any edits whose exercise
  // no longer exists"). liveExIds is the actual thing that determines whether the myEx loop above
  // would have rendered this edit inline: only when e.id (a REAL, current exercise) matches it.
  const liveExIds = new Set(s.exercises.map(e => e.id));
  let edits = '';
  for(const ed of s.suggestedEdits){
    if(ed.exerciseId && liveExIds.has(ed.exerciseId)) continue; // already shown inline above (a swap on a still-existing exercise)
    // An approved add is now a real exercise with its own card in the list above -- nothing more
    // to say about it here. An approved swap has no such card of its own (it renamed an existing
    // one), so it still falls through to the muted "swapped by X" line below.
    if(ed.type==='add' && ed.status==='approved') continue;
    const byName = nameCache[ed.proposedBy] || ed.proposedBy;
    if(ed.status==='pending'){
      if(ed.type==='add'){
        edits += `<div class="card"><div class="req"><div class="rc">${byName==='You' ? 'You suggested adding' : esc(byName)+' suggests adding'} ${esc(ed.swapTo)}</div>`;
      } else {
        edits += `<div class="card"><div class="req"><div class="rc">${byName==='You' ? 'You suggested' : esc(byName)+' suggests'} → ${esc(ed.swapTo)}</div>`;
      }
      if(isCreator) edits += `<div class="ra"><button class="sm ok" onclick="approve('${s.id}','${ed.id}')">Approve</button><button class="sm no" onclick="reject('${s.id}','${ed.id}')">Reject</button></div>`;
      else edits += `<div class="ra"><span class="tag">waiting on creator</span></div>`;
      edits += `</div></div>`;
    } else if(ed.status==='approved'){
      // option 1: no residual pill — just show the agreed swap, muted "swapped by X"
      const disp = (byName||'?').split(' ')[0];
      edits += `<div class="card"><div class="req"><div class="rc">${esc(ed.swapTo)} <span class="swap-note">· swapped by ${esc(disp)}</span></div></div></div>`;
    }
    // rejected: nothing shown
  }
  // join requests (creator only)
  let jr = '';
  if(isCreator){
    for(const j of s.joinRequests.filter(x=>x.status==='pending')){
      jr += `<div class="card"><div class="req"><div class="av">${esc((await nameOf(j.userId)||'?')[0]||'?')}</div><div class="rc"><b>${esc(await nameOf(j.userId))}</b> wants to join${j.note?` — <i>"${esc(j.note)}"</i>`:''}</div><div class="ra"><button class="sm ok" onclick="approveJoin('${s.id}','${j.id}')">Approve</button><button class="sm no" onclick="rejectJoin('${s.id}','${j.id}')">Reject</button></div></div></div>`;
    }
  }
  // Back goes BACK. It used to be hardcoded to a fixed target, so arriving from a profile or the
  // feed dumped you somewhere you had never been. v254 fix: this button is real browser-history
  // Back now (history.back()), same as the hardware/gesture Back button -- it returns to whatever
  // screen actually pushed the entry below this one, not a guess about which tab you were on
  // (that guess, kept for a while as an improvement over the hardcoded target, still went to the
  // wrong PLACE within a tab -- e.g. landing on the Friends tab's list instead of the specific
  // friend's profile you actually came from).

  // A pending invitee does not need a head count — "1 person" counts the creator alone and reads
  // like an empty workout. What is actually true is that everyone is waiting on you.
  const pendingMe = !isCreator && !isParticipant && Array.isArray(s.invited) && s.invited.includes(ME.id);
  const vis = s.visibility==='friends' ? (pendingMe ? 'Friends-only' : 'Friends-only · joinable') : 'Private';
  const who = pendingMe ? 'waiting on you'
            : `${s.participants.length} ${s.participants.length===1?'person':'people'}`;
  // one line, no emoji standing in for icons
  const facts = [s.location ? esc(s.location) : '', s.lengthMin ? esc(s.lengthMin)+' min' : ''].filter(Boolean).join(' · ');

  // Has anyone else started? ONLY on an invitation you have not answered yet. It exists to help
  // you decide; once you have accepted you are going to train regardless, and the same sentence
  // stops being information and starts being a nag. Jeff's call, Aug 18.
  const startedBy = pendingMe && !sessionHasAnyPost(s) ? whoLogged().filter(pid => pid !== ME.id) : [];
  const startedSets = startedBy.reduce((n,pid) => n + setsTotal(pid), 0);
  const firstName = pid => { const n = nameCache[pid]; return isUnknownName(n) ? 'Someone' : String(n).split(' ')[0]; };
  const startedLine = !startedBy.length ? '' : (() => {
    const names = startedBy.map(firstName);
    const label = names.length===1 ? `${esc(names[0])}'s already started`
                : names.length===2 ? `${esc(names[0])} and ${esc(names[1])} have already started`
                : `${esc(names[0])} and ${names.length-1} others have already started`;
    return `<div class="sess-started">${label} — ${startedSets} set${startedSets===1?'':'s'} in</div>`;
  })();

  // Log & Finish is offered to ANY participant who hasn't posted their own recap yet — not just
  // the creator. The server (POST /:id/lock, POST /:id/post) has allowed this per-participant since
  // the recap feature was ported to s.posts; this is the client catching up so everyone actually has
  // a way to reach it, not just the person who created the workout.
  // v187: Log & Finish visibility now tracks s.history (have you actually finished), not myPost
  // (have you posted a recap) — the two used to be conflated, but /lock and /post are independent
  // now. Someone who tapped Log & Finish and never got around to a recap kept seeing their own
  // "Log & Finish" button forever, inviting a second, harmless-but-pointless tap.
  const hasFinished = (s.history||[]).some(h=>h.userId===ME.id);
  // Jeff, Aug 28: "not sure how I feel about the Log & Finish/Edit/Delete session visuals" -- the
  // three used to sit as equal-weight pills in a row (see the old .sess-actions block this
  // replaced), which meant a destructive, rarely-tapped action (Delete session) had exactly the
  // same visual prominence as the one action you take on basically every visit (Log & Finish) --
  // worse, once you'd already finished, Delete session became the SECOND thing on the whole page.
  // Creator-only Edit/Delete now live behind a "..." menu next to Back instead, so the only pill
  // left in the flow is the one primary action -- and it matches the "..." pattern this app
  // ALREADY uses one screen over, on the posted-workout view (viewPost, above) for the exact same
  // Edit session/Delete session pair. This was two different treatments of the same two actions;
  // now it's one.
  const sessMenuItems = isCreator
    ? `<button onclick="${myPost?`enterWorkoutEdit('${s.id}')`:`editSession('${s.id}')`}">Edit session</button><button class="danger" onclick="deleteSession('${s.id}', ${hasFinished})">Delete session</button>`
    : '';
  const sessDots = sessMenuItems ? `<button class="pp-dots" onclick="togglePostMenu('${s.id}')" aria-label="More">\u22ef</button><div class="pp-menu" id="ppMenu-${s.id}" style="display:none">${sessMenuItems}</div>` : '';
  let html = `<div class="wrap"><div class="pp-head"><button class="sec sm" onclick="history.back()">← Back</button>${sessDots}</div>
    <h1 class="sess-date">${sessTitle(s)}</h1>
    <div class="muted sess-meta">${sessSub(s)}${vis} · ${who}</div>
    ${facts?`<div class="tag">${facts}</div>`:''}
    ${startedLine}
    ${s.creatorNote?`<div class="sess-note">${esc(s.creatorNote)}</div>`:''}`;
  {
    const actions = [];
    if(!hasFinished && (isParticipant || isCreator)) actions.push(`<button class="blue sm" onclick="confirmLogFinish('${s.id}')">Log & Finish</button>`);
    if(!isCreator && isParticipant){
      // Jeff, Aug 19: workouts you were invited into (not ones you created) had no way to make go
      // away at all — Edit/Delete are creator-only, always have been, so an invite the creator
      // never finishes just sits on Home forever. Leave gives every non-creator participant their
      // own way out, with the same Save/Discard choice Delete's fallback below now uses too. Left
      // as its own pill (not folded into a menu) since it's the only secondary action a
      // participant ever has here -- one pill next to Log & Finish isn't the crowding problem the
      // creator's three-in-a-row was.
      actions.push(`<button class="sec sm" onclick="leaveWorkout('${s.id}', ${hasFinished})">Leave workout</button>`);
    }
    if(actions.length) html += `<div class="sess-actions">${actions.join('')}</div>`;
  }
  html += `<h2>Workout</h2>`;
  if(!s.exercises.length){
    // A blank "Quick Workout" session (or any session with everything removed) — no cards to tap,
    // so say so and give the one action that fixes it, instead of a silent empty header.
    html += `<div class="card"><div class="qs-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11"/><path d="M21 21l-1-1"/><path d="M3 3l1 1"/><path d="M9 9l1 1"/><path d="M15 15l1 1"/><rect x="4" y="4" width="4" height="4" rx="1" transform="rotate(45 6 6)"/><rect x="16" y="16" width="4" height="4" rx="1" transform="rotate(45 18 18)"/></svg>
      <div class="qs-t">No exercises yet</div>
      <div class="qs-s">${isCreator?"Add your first lift — you can add more as you go.":'Nothing logged here yet.'}</div>
      ${isCreator?`<button class="blue qs-add" style="width:auto;padding:11px 20px;" onclick="editSession('${s.id}')">+ Add exercise</button>`:''}
    </div></div>`;
  } else {
    html += myEx;
    if(canEdit) html += `<div class="muted" style="font-size:12px;margin:-4px 2px 10px">Tap an exercise to log your sets.</div>`;
    else if(canSuggest) html += `<div class="muted" style="font-size:12px;margin:-4px 2px 10px">Not feeling one of these? Tap it to propose a replacement — ${esc(isUnknownName(nameCache[s.creatorId])?'the host':String(nameCache[s.creatorId]).split(' ')[0])} approves it.</div>`;
  }
  if(edits) html += `<h2 class="pt">Suggested changes</h2>${edits}`;
  if(jr) html += `<h2 class="pt">Join requests</h2>${jr}`;
  if(myPost){
    // Completed/saved workout: Photos (where swap slot was), then Notes — MY OWN recap, since
    // each participant now finishes and posts independently (s.posts in server.js).
    const postMedia = (Array.isArray(myPost.media)) ? myPost.media : [];
    if(isCreator || postMedia.length){
      html += `<h2>Photos</h2><div class="card center-v">
        <div class="media-line"><div class="add-media" title="Add photos or video" onclick="showSavePage('${s.id}')">
          <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>
          <span class="am-plus"></span></div>
          <span class="ml-text">Add a photo / video</span></div>
        ${postMedia.length?`<div class="thumbs">${postMedia.map(m=>`<div class="thumb">${m.type==='image'?`<img src="${esc(m.src)}">`:`<video src="${esc(m.src)}" muted></video>`}</div>`).join('')}</div>`:''}
      </div>`;
    }
    html += `<h2>Notes</h2><div class="notes-box">${myPost.notes ? esc(myPost.notes) : '<span class="muted">How\'d it go?</span>'}</div>`;
  } else if(!isCreator && canEdit){
    // You have joined and can log, so tapping a card logs — which means the cards are taken and
    // suggesting needs its own door. The creator does NOT get this: they have Edit, and a creator
    // suggesting a change to themselves and then approving it is a loop, not a feature.
    // v262b (Jeff, Aug 31): "add the ability to add an exercise to a workout, not just suggest a
    // swap." Renamed from "Suggest a swap" to "Suggest a change" now that it offers two things --
    // swap copy/behavior below is untouched, just joined by a second option. The swap half only
    // makes sense when there's something to replace, so it's hidden on an empty workout (a fresh
    // "Workout Now" a friend joined before you've added anything); adding a brand-new exercise
    // stays offered either way, since that's exactly the case where it's most useful.
    const hostFirst = esc(isUnknownName(nameCache[s.creatorId])?'the host':String(nameCache[s.creatorId]).split(' ')[0]);
    html += `<h2 class="sep">Suggest a change</h2><div class="card">
      ${s.exercises.length ? `
      <div class="muted" style="font-size:12.5px;margin:2px 2px 8px">Not feeling one of these? Propose a replacement — ${hostFirst} approves it.</div>
      <select id="swEx" style="margin-bottom:10px">${s.exercises.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      <button class="sec sm" style="background:var(--line); margin-bottom:10px" onclick="openSwapPicker('${s.id}')">Pick replacement from Workouts →</button>
      ` : ''}
      <div class="muted" style="font-size:12.5px;margin:2px 2px 8px">Want to add something new? ${hostFirst} approves that too.</div>
      <button class="sec sm" style="background:var(--line)" onclick="openSuggestAddPicker('${s.id}')">Suggest adding an exercise →</button>
    </div>`;
  }
  const isPosted = !!myPost;
  // Accept/Decline is for an actual INVITE — someone was asked. Before Home's Friends' Workouts
  // card existed, that was the only way to ever reach this screen without already being in the
  // workout, so "not creator and not participant" was a safe stand-in for "was invited." It no
  // longer is: a friend-visible session now shows up here for people who were never invited at
  // all, and this used to hand them Accept/Decline anyway — tapping either did nothing useful,
  // since there was no invite on file to answer.
  const respondHere = !isCreator && !sessionHasAnyPost(s) && !isParticipant
    && Array.isArray(s.invited) && s.invited.includes(ME.id);
  // The other door in: a friend-visible workout you can see but were never asked into. "Join in?"
  // instead of Accept/Decline — you're the one asking here, not answering. Uses the same
  // joinRequests the creator's Approve/Reject already runs on (see the "join requests (creator
  // only)" block above); myJoinReq lets this reflect a request already on file instead of
  // offering to file a second one.
  const myJoinReq = s.joinRequests.find(j => j.userId === ME.id);
  // visibility==='friends' matches the server's own /join eligibility rule (server.js) — a
  // private session reached some other way (e.g. a publicly-shared recap on it) is not actually
  // joinable, and should not offer a button promising otherwise.
  const joinable = !isCreator && !isParticipant && !respondHere && s.visibility === 'friends';

  // Chat comes BEFORE the answer for someone deciding. Brian messages from the rack — "at the gym,
  // rack 3" — and that used to sit below the exercises AND below the buttons, so the most
  // time-sensitive thing on the screen was the last thing you saw. Read the plan, hear from him,
  // then answer.
  // Only people in the workout can post, so only they are offered the box. Rendering an input
  // that the server will refuse is a promise the app cannot keep.
  const canChat = isCreator || isParticipant || pendingMe;
  // Once YOU have posted, this box stops being the live workout chat and becomes the Instagram-style
  // comment thread on YOUR OWN recap (myPost, keyed by ME.id) — same split as viewPost(), which is
  // where most people actually land after posting (see the openSession/viewPost redirects at the
  // end of saveWorkoutEdit/exitWorkoutEdit). openSession itself is still reachable with isPosted=true
  // though (Home's own session list, an invite card, re-opening via a link), and this box used to
  // stay wired to the old shared s.comments even then — the exact bug the split was meant to fix,
  // just reachable from a second door.
  const sendAction = isPosted ? `sendPostComment('${s.id}','${ME.id}')` : `sendChat('${s.id}')`;
  const chatBlock = `<h2>${isPosted?'Comments':'Chat'}</h2><div class="card"><div id="chatbox" class="scrolllist"></div>
    ${canChat ? `<div class="row chat-row"><input id="chatInput" class="chat-input" placeholder="${isPosted?'Add a comment…':'Message the crew'}"><button class="sm chat-send" onclick="${sendAction}">Send</button></div>` : ''}</div>`;

  // "Friends joined" was wrong for the creator, who did not join anything. It DOES list everyone
  // else in the workout, which is worth keeping — it was the name that was off.
  const joinedIds = s.participants.filter(p=>p!==ME.id);
  // Who's still invited and hasn't answered — a member-only view. sessionView only ever hands a
  // non-member their OWN invited-status, never anyone else's (an unanswered invite is a fact about
  // the person, not the workout), so this list is only ever non-empty for someone already in it.
  // A stale invite can outlive someone actually joining (e.g. join-request approval doesn't
  // clear s.invited) — exclude anyone already in participants so they never show as both
  // joined AND still-pending at once.
  const invitedIds = (isCreator || isParticipant) ? (Array.isArray(s.invited) ? s.invited.filter(p=>p!==ME.id && !s.participants.includes(p)) : []) : [];
  const favChip = (pid, pending) => {
    const known = !isUnknownName(nameCache[pid]);
    const label = known ? String(nameCache[pid]) : 'A friend';
    const av = `<div class="fav-av" style="background:${avatarColor(label)};color:#fff">${esc(label[0])}</div>`;
    if(!pending) return `<div class="fav">${av}<span>${esc(label)}</span></div>`;
    return `<div class="fav pending"><div class="fav-av-wrap">${av}<div class="fav-pending-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div></div><span>${esc(label)}</span></div>`;
  };
  const invitedBlock = invitedIds.length
    ? `<div class="crew-invited-label">Invited · waiting to respond</div><div class="chips mini">${invitedIds.map(pid=>favChip(pid,true)).join('')}</div>`
    : '';
  const crewBlock = (joinedIds.length || invitedIds.length)
    ? `<h2>Who's in</h2>${joinedIds.length?`<div class="chips mini">${joinedIds.map(pid=>favChip(pid,false)).join('')}</div>`:''}${invitedBlock}`
    : '';

  if(respondHere){
    html += crewBlock + chatBlock;
    // Two answers, weighted, in the flow. NOT a pinned bar: this page is barely longer than one
    // screen and you see it once per invite, so 68px of permanent chrome on top of the 60px nav
    // buys nothing and crowds the reply box. Request Changes and Message Host were the same act —
    // messaging the host — and Save This Routine was never a response at all.
    const host = isUnknownName(nameCache[s.creatorId]) ? 'the host' : String(nameCache[s.creatorId]).split(' ')[0];
    html += `<h2>Respond</h2>
      <button class="btn-answer" onclick="acceptInvite('${s.id}')">Accept</button>
      <button class="btn-answer quiet" onclick="declineInvite('${s.id}')">Decline</button>
      <div class="answer-aside">
        <button class="linkbtn" onclick="openChat('${s.id}')">Message ${esc(host)}</button>
        <span class="aside-dot">·</span>
        <button class="linkbtn" onclick="saveRoutine('${s.id}')">Save this routine</button>
      </div>`;
  } else if(joinable){
    html += crewBlock + chatBlock;
    const host = isUnknownName(nameCache[s.creatorId]) ? 'the host' : String(nameCache[s.creatorId]).split(' ')[0];
    if(myJoinReq && myJoinReq.status==='pending'){
      html += `<div class="muted" style="padding:0 2px 10px">Request sent — waiting on ${esc(host)}.</div>`;
    } else {
      // A rejected request used to permanently trip the server's "already requested" 400 on every
      // future tap, with the button silently re-rendering as if nothing had happened — a dead end
      // with no way back in. requestJoin's server side now re-opens a rejected request instead of
      // refusing it, so the button here stays real and actionable; this line is only about not
      // pretending the earlier answer never happened.
      const declined = myJoinReq && myJoinReq.status==='rejected';
      // v249 (audit finding, cold-review-caught follow-up): this used to unconditionally offer
      // "Message {host}" here too, wired to openChat() = document.getElementById('chatInput').focus()
      // — but #chatInput only renders when canChat is true (isCreator || isParticipant || pendingMe,
      // above chatBlock). The first fix here just deleted the button outright, reasoning that nobody
      // in THIS branch could have canChat true — wrong: respondHere requires !sessionHasAnyPost(s), so
      // a genuinely INVITED person (pendingMe true, #chatInput really rendered) whose session already
      // has a posted recap by the time they look at it lands in this joinable branch too, not
      // respondHere, and could message the host just fine. Gating the button on canChat itself — the
      // actual thing #chatInput's presence depends on — keeps it working for that overlap case while
      // still removing it for the real dead-button case (never invited, never joined, canChat false).
      html += `${declined ? `<div class="muted" style="padding:0 2px 10px">${esc(host)} declined your last request — you can ask again.</div>` : ''}
      <button class="btn-answer" onclick="requestJoin('${s.id}')">Join in?</button>
      ${canChat ? `<div class="answer-aside">
        <button class="linkbtn" onclick="openChat('${s.id}')">Message ${esc(host)}</button>
      </div>` : ''}`;
    }
  } else {
    html += crewBlock + chatBlock;
  }
  html += `</div>`;
  // Re-checked here, not just right after the fetch: the name-lookup awaits above take their
  // own time, and a silent refresh must not land on whatever screen the user has since moved to.
  if(silent && (mySeq !== SESSION_SILENT_SEQ || !logSheetStillOpenFor(id))) return;
  $('app').innerHTML = html;
  // v254 (Jeff): tapping into a screen used to leave the window wherever it happened to be
  // scrolled from the PREVIOUS screen, so a session opened after scrolling halfway down Home
  // could render already scrolled to the middle. A silent background refresh (this same render,
  // fired after logging a set) must NOT do this -- it would yank you away from the exact set row
  // you're mid-workout on. Same !silent gate as everything else in this function.
  if(!silent && !quiet){ const st={t:'session', id}; fromHistory ? landOn(st) : navigated(st); }
  if(isPosted) loadPostComments(s.id, ME.id); else loadChat(s);
  // v262 (cold-review fix): every existing caller of openSession ignores its return value, so this
  // is safe to add -- but the two new deep-link entry points below (tryBoot's ?openLog= branch and
  // the serviceWorker message listener) both used to call openLogSheet() UNCONDITIONALLY right
  // after, even when this function hit the error branch above and returned undefined. That meant a
  // dead/expired link fired openSession's alert, then openLogSheet's own SEPARATE fetch-and-alert
  // right on top of it (openLogSheet has no _expired guard at all, so it would alert even over a
  // freshly-rendered login screen). Returning true only from this, the successful-render path, lets
  // both call sites gate on it and skip openLogSheet entirely when the session didn't open.
  return true;
}
// ===== Dedicated POSTED-WORKOUT view (read-only, like an Instagram/Hevy post) =====
// Opened when tapping a saved workout on a profile. Each participant posts their own recap
// independently now (s.posts, keyed by userId — see server.js), so this needs to know WHOSE
// recap to render: authorId. Falls back to the creator's for any old call site that doesn't
// pass one yet.
//
// Jeff, Aug 28, asked twice, refining as he went. First: "I should be able to edit a workout
// posted on my profile if I wasn't the creator ... just as if i was." Then, narrowing that:
// "delete it off my page, edit my own sets (I don't want to change the exercises - just my logged
// sets), photos, and my own notes." So the shared EXERCISE LIST (renderWorkoutEdit/
// saveWorkoutEdit, "Edit session" in the ⋯ menu below) stays exactly what it always was --
// creator-only, since it's a session-wide change every participant is counting on. Everything he
// actually wanted lives here instead, all scoped to "my own," all reachable regardless of who
// created the session:
//   - photos: addPostPhoto/deletePhoto above, gated on isAuthor.
//   - notes: editPostNotes below, gated on isAuthor.
//   - logged sets: editPostedSet/savePostedSet/deletePostedSet below, in setRows() -- gated on
//     pid===ME.id per set-row (never someone else's sets, even on your own shared workout), using
//     PUT/DELETE /api/sessions/:id/log/:logId, which is already scoped to your own s.logs entry
//     server-side and needs no permission change.
//   - "delete it off my page": removeFromMyProfile below, POST /api/sessions/:id/remove-mine --
//     deliberately its own new endpoint, not a variant of Leave Workout. Leave (v187) exists
//     specifically to KEEP your history/credit when you step away; the comment above it explains
//     an earlier version that erased history on leave was a real bug, fixed on purpose. This is the
//     opposite, explicit ask, so it's a separate action with its own confirmation, never a side
//     effect of leaving.
async function viewPost(id, authorId, opts){
  // v250 (audit follow-up): same gap as profileView()/followList() -- tapping a workout card from
  // the Profile tab lands here without a tab switch or new sheet.
  // v254: opts.silent is the same shape as openSession's -- editing a comment/photo/note/set FROM
  // this exact screen quietly re-renders it afterward (see sendPostComment/deletePhoto/
  // addPostPhoto/editPostNotes/savePostedSet/deletePostedSetConfirmed below), and that must not
  // bump the epoch, push a history entry, or reset scroll -- you're still reading the same recap,
  // possibly scrolled down to the exact set you just edited. opts.fromHistory is popstate's own
  // "land, don't push again" signal (see openSession).
  const silent = !!(opts && opts.silent);
  const fromHistory = !!(opts && opts.fromHistory);
  if(!silent) UI_EPOCH++;
  const s = await H.get('/api/sessions/'+id);
  if(!s || (s.error && !s._expired)){ alert(s && s.error ? s.error : 'Session not found'); return; }
  s.participants = s.participants || [];
  s.exercises = s.exercises || [];
  s.posts = s.posts || {};
  authorId = authorId || s.creatorId;
  const isCreator = s.creatorId===ME.id;
  const isAuthor = authorId===ME.id;
  const post = s.posts[authorId] || {};
  const media = (post.media && post.media.length) ? post.media : [];
  // resolve collaborator display names (participants excluding creator)
  const nm = {};
  for(const pid of s.participants){ if(pid!==s.creatorId) nm[pid]= await nameOf(pid); }
  // names for EVERYONE who logged here — including the creator, and including anyone who has
  // since left the workout. Their sets are still part of what happened that day.
  const logNames = {};
  for(const pid of Object.keys(s.logs||{})){ if((s.logs[pid]||[]).length) logNames[pid] = nm[pid] || await nameOf(pid); }
  // "with @friend, @friend" is what this printed for anyone who could not see those people's
  // names. Name the ones you know, count the ones you do not.
  const allCollab = Object.values(nm);
  const known = allCollab.filter(n => !isUnknownName(n));
  const unknown = allCollab.length - known.length;
  const parts = known.map(n => '@' + esc(String(n).split(' ')[0]));
  if(unknown) parts.push(`${unknown} other${unknown>1?'s':''}`);
  const collab = parts.length ? `<div class="pp-collab">with ${parts.join(', ')}</div>` : '';
  // THE SHARED RESULT. This used to read s.logs[s.creatorId] and nothing else, so a training
  // partner's sets were stored, counted toward their own PRs, and displayed to precisely nobody.
  //
  // Who sees whose: if you were IN the workout you see everyone in it; if you are an outside
  // viewer you see the creator's sets, plus (v242) any author whose RECAP is visible to you —
  // the server only sends an outside viewer a person's logs when that person's own recap
  // visibility admits them (sessionView), so a visible post here is precisely "they published
  // this to me". That per-author publish gate is what made widening beyond the creator safe;
  // it used to be creator-only because the old server handed every participant's logs to any
  // friend of the creator. Departed members' sets are stored but not sent unless posted.
  const inTheWorkout = (s.participants||[]).includes(ME.id) || s.creatorId === ME.id;
  const logged = Object.keys(s.logs||{})
    .filter(pid => (s.logs[pid]||[]).length && (inTheWorkout || pid === s.creatorId
      || pid === ME.id || (s.posts && s.posts[pid] && !s.posts[pid].hidden)))
    .sort((x,y) => (x===s.creatorId ? -1 : y===s.creatorId ? 1 : String(logNames[x]||'').localeCompare(String(logNames[y]||''))));
  // v249 (audit finding): "No sets logged" below used to fire whenever nobody's VISIBLE sets
  // landed on this exercise — but a departed participant's recap can be hidden from this viewer
  // by their own privacy setting (Only me / Friends) while their sets are still real, still
  // stored, still logged. The server never sends this viewer their sets at all in that case (see
  // sessionView), so there is no way to know which exercises that person logged — only that a
  // hidden recap exists at all (view.posts still carries a {hidden:true} placeholder for it,
  // unlike a person with no recap and nothing to hide). So this can't be exercise-precise; it
  // hedges every otherwise-empty card once ANY hidden recap is in the mix, trading a little
  // over-caution for never flatly claiming "nobody logged this" when someone plausibly did.
  const hasHiddenPost = Object.values(s.posts || {}).some(p => p && p.hidden);
  // Jeff, Aug 28: "edit my own sets (I don't want to change the exercises - just my logged
  // sets)" -- `mine` gates a tap-to-edit affordance per set-ROW, never per-exercise or
  // per-workout, so a shared workout's OTHER participant's sets stay exactly as read-only as
  // they always were even when yours right above them are editable. editPostedSet below uses
  // the same PUT/DELETE /api/sessions/:id/log/:logId already used by the live in-workout
  // "Edit set" sheet (editLogSet et al above) -- that route is keyed off req.userId's own
  // s.logs entry server-side, so this needed no server change, just this entry point.
  const setRows = (ls, mine) => `<div class="pp-sets">${ls.map(l=>`<div class="pp-set${mine?' pp-set-mine':''}"${mine?` onclick="editPostedSet('${id}','${authorId}','${l.id}')"`:''}>${ (()=>{ const b = l.setType==='warmup'?{t:'W',c:'warm'}:l.setType==='drop'?{t:'D',c:'drop'}:l.setType==='failure'?{t:'F',c:'fail'}:{t:(l.set||'·'),c:''}; return `<span class="pp-set-n ${b.c}">${b.t}</span>`; })() }<span class="pp-set-val">${Number(l.weight)||0} ${unitOf(l)} × ${Number(l.reps)||0} reps</span>${l.isPr?'<span class="pp-pr">PR</span>':''}${mine?'<span class="pp-set-edit muted" style="font-size:11px">Edit</span>':''}</div>`).join('')}</div>`;
  // An approved swap replaces the exercise for the session, and openSession already titles the
  // card with the swapped-in name. This screen said the original, so the two disagreed about what
  // the lift even was. Same resolution here, so they agree.
  const approvedFor = {};
  // FIRST wins, not last — openSession uses .find(), and the two screens naming the same lift
  // differently is exactly the bug this block was added to fix.
  for(const ed of (s.suggestedEdits||[]))
    if(ed.status==='approved' && !(ed.exerciseId in approvedFor)) approvedFor[ed.exerciseId] = ed.swapTo;
  const exList = s.exercises.map(e=>{
    const heading = approvedFor[e.id] || e.name;
    const blocks = logged.map(pid => {
      const ls = (s.logs[pid]||[]).filter(l=>l.exerciseId===e.id).sort((a,b)=>(Number(a.set)||0)-(Number(b.set)||0));
      if(!ls.length) return '';
      // Each set carries the lift's name AS IT WAS when it was logged. If someone's sets predate a
      // swap, say so next to their name rather than filing them under a lift they never did.
      // ONLY when a swap actually happened. Editing a workout keeps exercise ids and can change
      // names, so without this guard fixing a typo permanently annotated your own sets with the
      // misspelling — on solo workouts too.
      const theirs = approvedFor[e.id] ? ls.find(l => l.exerciseName && l.exerciseName !== heading) : null;
      const note = theirs ? `<span class="pp-who-note">logged as ${esc(theirs.exerciseName)}</span>` : '';
      // Label when it is not obvious whose these are: more than one person logged THIS lift, or
      // the one person who did is not you. A lone "YOU" over your own sets is noise.
      const needLabel = logged.length > 1 && (pid !== ME.id || logged.some(o => o !== pid && (s.logs[o]||[]).some(l => l.exerciseId===e.id)));
      const nmRaw = pid===ME.id ? 'You' : logNames[pid];
      const label = needLabel ? esc(isUnknownName(nmRaw) ? 'Someone' : String(nmRaw).split(' ')[0]) : '';
      const who = (label || note) ? `<div class="pp-who">${[label, note].filter(Boolean).join(' ')}</div>` : '';
      return who + setRows(ls, pid===ME.id);
    }).filter(Boolean).join('');
    const setsHtml = blocks || (hasHiddenPost
      ? `<div class="pp-sets muted" style="font-size:12px;padding-top:2px">Sets not shared</div>`
      : `<div class="pp-sets muted" style="font-size:12px;padding-top:2px">No sets logged</div>`);
    return `<div class="pp-ex"><div class="pp-ex-name">${esc(heading)}</div></div>${setsHtml}`;
  }).join('');
  // Jeff, Aug 28: "I want to be able to add or change the picture i added later once its on my
  // profile and already logged." Delete-a-photo already existed (below); this adds the other half
  // -- reuses the exact same .add-media button the save/edit-session pages already use, and the
  // exact same fetch-current-post -> mutate media -> re-POST /post pattern deletePhoto() uses, so
  // an already-posted recap's photos work the same whether you're adding or removing. Shown even
  // with zero photos yet (not just alongside existing ones) so it's discoverable, not just a repair
  // path -- "add or change ... later" covers a recap you saved with no photo at all.
  const addPhotoRow = (isAuthor && media.length<4) ? `<div class="media-line" style="margin-top:${media.length?'10px':'0'}">
    <label class="add-media" title="Add photo or video">
      <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>
      <span class="am-plus"></span>
      <input type="file" accept="image/*,video/*" multiple style="display:none" onchange="addPostPhoto('${id}','${authorId}',this)">
    </label>
    <span class="ml-text">${media.length?'Add another':'Add a photo / video'}</span>
  </div>` : '';
  const photoStrip = media.length ? `<div class="pp-photos">${media.map((m,i)=>`<div class="pp-photo">${m.type==='image'?`<img src="${esc(m.src)}" alt="">`:`<video src="${esc(m.src)}" muted></video>`}${isAuthor?`<button class="pp-photo-x" onclick="deletePhoto('${id}','${authorId}',${i})" aria-label="Delete photo">✕</button>`:''}</div>`).join('')}</div>${media.length>1?`<div class="pp-photo-dots" id="ppDots-${id}">${media.map((_,i)=>`<span class="pp-dot${i===0?' on':''}"></span>`).join('')}</div>`:''}` : '';
  const photos = (media.length || addPhotoRow) ? `<h2>Photos</h2>${photoStrip}${addPhotoRow}` : '';
  const notes = post.notes ? esc(post.notes) : '<span class="muted">How\'d it go?</span>';
  // Jeff, Aug 28: "...my own notes on the workout" -- edit your own notes right here, same
  // idempotent fetch-post-mutate-repost pattern as addPostPhoto/deletePhoto above, so this can
  // never be reached for anyone else's recap.
  const notesHeader = isAuthor ? `<h2 style="display:flex;align-items:center;justify-content:space-between">Notes<button class="sec sm" onclick="editPostNotes('${id}','${authorId}')">Edit</button></h2>` : `<h2>Notes</h2>`;
  // Jeff, Aug 28: "I made my most recent posted workout on my profile public and it still says
  // 'friends only'." The badge just below was showing s.visibility -- whether the SESSION itself is
  // joinable by friends or invite-only, set back on the create form -- which is a different setting
  // from post.visibility, the one actually controlling who can see THIS RECAP on your profile (the
  // "Only me / Friends / Public" segmented control on the Save/Edit screen, exactly what Jeff had
  // just changed to Public). s.visibility only ever has two values, so this badge could never even
  // read "Public" no matter what you set. Show the recap's own visibility instead -- same field,
  // same wording, as the segmented control that sets it.
  const postVis = post.visibility || 'only_me';
  const postVisLabel = postVis==='public' ? 'Public' : postVis==='friends' ? 'Friends' : 'Only me';
  const hasFinishedPost = (s.history||[]).some(h=>h.userId===ME.id);
  // Creator: "Edit session" (the shared exercise list) + "Delete session" (removes it for every
  // participant) -- unchanged, exactly as it always was. Non-creator author: "Remove from my
  // profile" instead (removeFromMyProfile below) -- erases YOUR OWN post/logs/history for this
  // session so it's gone from your profile, without touching anyone else's. See the big comment
  // above viewPost for the full reasoning.
  // Jeff, Aug 30: "open re-activate a closed logged workout if needed" -- your own finish-credit,
  // undoable regardless of whether you're the creator (finishing is per-person, unlike the shared
  // exercise list Edit session governs), so this is gated on isAuthor/hasFinishedPost alone and
  // folded into whichever branch below actually applies. See reactivateWorkout's own comment.
  const reactivateBtn = (isAuthor && hasFinishedPost) ? `<button onclick="reactivateWorkout('${id}','${authorId}')">Reactivate workout</button>` : '';
  const menuItems = isCreator
    ? `<button onclick="enterWorkoutEdit('${id}')">Edit session</button>${reactivateBtn}<button class="danger" onclick="deleteSession('${id}', ${hasFinishedPost})">Delete session</button>`
    : (isAuthor ? `${reactivateBtn}<button class="danger" onclick="removeFromMyProfile('${id}')">Remove from my profile</button>` : '');
  const dots = menuItems ? `<button class="pp-dots" onclick="togglePostMenu('${id}')" aria-label="More">\u22ef</button><div class="pp-menu" id="ppMenu-${id}" style="display:none">${menuItems}</div>` : '';
  // v254 fix (Jeff, Aug 30): this in-page Back button was hardcoded to showTab('home') -- reached
  // from a profile's "My Workouts" tile (or the feed), it always dumped you on Home instead of
  // wherever you actually tapped in from. history.back() replays the same real browser-history
  // pop the hardware/gesture Back button already uses, landing on whatever screen pushed the
  // entry below this one (see viewPost's own navigated()/landOn() call just below this template).
  const html = `<div class="wrap">\n    <div class="pp-head"><button class="sec sm" onclick="history.back()">← Back</button>${dots}</div>\n    <h1 class="sess-date">${sessTitle(s)}</h1>\n    <div class="muted sess-meta">${sessSub(s)}${postVisLabel}${collab}</div>\n    ${photos}\n    <h2>Workout</h2>${exList}\n    ${notesHeader}<div class="notes-box">${notes}</div>\n    <h2>Comments</h2><div class="card"><div id="chatbox" class="scrolllist"></div>\n      <div class="row chat-row"><input id="chatInput" class="chat-input" placeholder="Add a comment…"><button class="sm chat-send" onclick="sendPostComment('${id}','${authorId}')">Send</button></div></div>`;
  $('app').innerHTML = html;
  if(!silent){ const st={t:'post', id, authorId}; fromHistory ? landOn(st) : navigated(st); }
  if(media.length>1){
    const strip=document.querySelector('.pp-photos');
    const dots=document.querySelectorAll('#ppDots-'+id+' .pp-dot');
    if(strip) strip.addEventListener('scroll',()=>{
      const i=Math.round(strip.scrollLeft/Math.max(1,strip.clientWidth));
      dots.forEach((d,k)=>d.classList.toggle('on',k===i));
    }, {passive:true});
  }
  loadPostComments(id, authorId);
}
// ===== Recovered post-view + chat helpers =====
// v231 (Jeff): the menus used to be fiddly - the dots were the only way to close, several
// could be open at once, and a stray tap did nothing. Now: opening one closes the rest, the
// dots still toggle, and ANY tap outside a menu or its dots closes whatever is open (document
// listener below; bubble phase, so menu-item clicks still run their action first).
function togglePostMenu(id){
  const m = document.getElementById('ppMenu-'+id);
  if(!m) return;
  const wasOpen = m.style.display !== 'none';
  document.querySelectorAll('.pp-menu').forEach(x => { x.style.display = 'none'; });
  if(!wasOpen) m.style.display = 'block';
}
// Guarded: test/client-hostile.mjs executes this file in a vm whose mock document may lack
// addEventListener. Element.closest covers taps on the dots glyph/svg inside the button.
if(typeof document !== 'undefined' && typeof document.addEventListener === 'function'){
  document.addEventListener('click', (e) => {
    const t = e.target;
    // Only the dots themselves keep the menu open (their own onclick handles the toggle).
    // EVERYTHING else closes it - including choosing a menu option: this listener runs at
    // bubble phase, AFTER the option's inline onclick, so the action fires and then the menu
    // closes. v234 (Jeff): options that open a confirm sheet were leaving the menu hanging
    // behind it, because unlike navigation they never repaint the page.
    if(t && t.closest && t.closest('.pp-dots')) return;
    document.querySelectorAll('.pp-menu').forEach(x => { x.style.display = 'none'; });
  });
}
// Comments on a POSTED recap — a separate thread from the live-workout Chat (see loadChat /
// sendChat below), stored on the post itself (server.js: s.posts[authorId].comments) rather than
// the session's shared chat, so an old "at the gym, rack 3" message never shows up here.
// v251 (audit finding): sendPostComment here and deletePhotoConfirmed/addPostPhoto/editPostNotes's
// onConfirm/savePostedSet/deletePostedSetConfirmed below all end an await chain by unconditionally
// re-rendering (or, for the set-edit pair, closing the edit sheet and re-rendering) the posted-
// workout view -- same stale-response-barges-in shape editBio/editDefaultGym were fixed for in
// v250 (see the comment above stillOnProfileWithNothingElseOpen), just never applied here: leave a
// comment, delete/add a photo, edit your notes, or edit/delete one of your own logged sets, then
// navigate away before it resolves, and the response used to pull the screen back to this recap
// regardless of where the user had moved on to. Guarded the same way, with the more general
// nothingNavigatedSince() (these don't need stillOnProfileWithNothingElseOpen's extra "and it's
// specifically the Profile tab" check -- any navigation away at all means don't barge back in).
async function sendPostComment(id, authorId){
  const t=$('chatInput').value; if(!t.trim()) return;
  const epoch=UI_EPOCH;
  await H.post(`/api/sessions/${id}/posts/${authorId}/comments`,{text:t});
  if(!nothingNavigatedSince(epoch)) return;
  const inp=$('chatInput'); if(inp) inp.value='';
  viewPost(id, authorId, {silent:true});
}
async function loadPostComments(id, authorId){
  const box=$('chatbox'); if(!box) return;
  const cs=await H.get(`/api/sessions/${id}/posts/${authorId}/comments`);
  if(!Array.isArray(cs)){ box.innerHTML='<div class="muted">Comments aren\'t visible here.</div>'; return; }
  if(!cs.length){ box.innerHTML='<div class="muted">No comments yet. Be the first to comment.</div>'; return; }
  const nm={};
  for(const c of cs){ if(!(c.userId in nm)) nm[c.userId]= await nameOf(c.userId); }
  box.innerHTML = cs.map(c=>{
    const name = c.userId===ME.id?'You':(nm[c.userId]||'User');
    const ini = c.userId===ME.id?'Y':((nm[c.userId]||'?')[0]||'?');
    // "You" used to get an off-palette orange found nowhere else in the app, while everyone else
    // got the old rainbow hash -- two more one-off treatments on top of Home's own green avatar.
    // avatarColor() is now one consistent accent for everyone (see its definition), including you;
    // the bold "You"/name label right next to it is what actually says whose comment this is.
    const col = avatarColor(nm[c.userId]||c.userId);
    const t = new Date(c.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    return '<div class="cmt"><div class="fav-av" style="background:'+col+';color:#fff">'+esc(ini)+'</div><div class="cmt-body"><div class="cmt-head"><b>'+esc(name)+'</b> <span class="muted" style="font-size:11px">'+t+'</span></div><div class="cmt-text">'+esc(c.text)+'</div></div></div>';
  }).join('');
}
async function deletePhoto(id, authorId, idx){
  confirmSheet('Delete photo?', 'The photo comes off your recap — the workout and your sets stay.', 'Delete photo', () => deletePhotoConfirmed(id, authorId, idx));
}
async function deletePhotoConfirmed(id, authorId, idx){
  const epoch=UI_EPOCH;
  const s = await H.get('/api/sessions/'+id);
  const post = s && s.posts && s.posts[authorId];
  if(!post) return;
  const media = (post.media||[]).filter((_,i)=>i!==idx);
  const r = await H.post(`/api/sessions/${id}/post`, { notes: post.notes||'', media, visibility: post.visibility||'only_me' });
  if(r && r.error){ alert(r.error); return; }
  if(nothingNavigatedSince(epoch)) viewPost(id, authorId, {silent:true});
}
// Add (or, paired with deletePhoto above, effectively replace) a photo/video on an already-posted
// recap. Same MAX-4 / one-video-max rules as the save page's addWorkoutMedia -- re-fetches the
// current post so this can't stomp on notes/visibility saved by a stale in-memory copy.
async function addPostPhoto(id, authorId, input){
  const files = Array.from(input.files || []);
  input.value = '';
  if(!files.length) return;
  const epoch=UI_EPOCH;
  const s = await H.get('/api/sessions/'+id);
  const post = (s && s.posts && s.posts[authorId]) || {};
  const media = Array.isArray(post.media) ? post.media.slice() : [];
  const MAX = 4;
  for(const file of files){
    if(media.length>=MAX){ alert('You can add up to 4 photos or videos.'); break; }
    const isImg = file.type.startsWith('image/');
    const type = isImg ? 'image' : 'video';
    if(type==='video' && media.some(m=>m.type==='video')){ alert('Only one video is allowed.'); continue; }
    const src = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    media.push({ type, src });
  }
  const r = await H.post(`/api/sessions/${id}/post`, { notes: post.notes||'', media, visibility: post.visibility||'only_me' });
  if(r && r.error){ alert(r.error); return; }
  if(nothingNavigatedSince(epoch)) viewPost(id, authorId, {silent:true});
}
// Jeff, Aug 28: "...and my own notes on the workout." Same fetch-current-post -> mutate ->
// re-POST /post pattern as addPostPhoto/deletePhoto just above, so media/visibility already on
// the recap are preserved untouched -- this only ever changes the notes field.
function editPostNotes(id, authorId){
  H.get('/api/sessions/'+id).then(s => {
    const post = (s && s.posts && s.posts[authorId]) || {};
    textEntrySheet({
      title:'Edit notes', label:'Notes', value: post.notes||'', placeholder:"How'd it go?", multiline:true, confirmLabel:'Save',
      onConfirm: async v => {
        const epoch=UI_EPOCH;
        const r = await H.post(`/api/sessions/${id}/post`, { notes: v||'', media: post.media||[], visibility: post.visibility||'only_me' });
        if(r && r.error){ alert(r.error); return; }
        if(nothingNavigatedSince(epoch)) viewPost(id, authorId, {silent:true});
      }
    });
  });
}
// Jeff, Aug 28: "edit my own sets (I don't want to change the exercises - just my logged sets)."
// Same sheet shape as the live in-workout "Edit set" (editLogSet/saveLogSet/delLogSet above),
// just re-rendering viewPost() instead of the live log sheet when done, and reached only via
// setRows()'s mine-gated onclick, so a tap here can only ever be on your own logged set.
async function editPostedSet(id, authorId, logId){
  const s = await H.get('/api/sessions/'+id);
  const mine = (s.logs && s.logs[ME.id]) || [];
  const l = mine.find(x => x.id === logId);
  if(!l) return;
  openSheetHtml(`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Edit set</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="ex-sub">Set ${l.set||''}</div>
      <label class="muted" style="font-size:12px">Weight (${unitOf(l)})</label>
      <input id="ppEdW" type="number" inputmode="decimal" step="any" value="${l.weight}">
      <label class="muted" style="font-size:12px">Reps</label>
      <input id="ppEdR" type="number" inputmode="tel" pattern="[0-9]*" value="${l.reps}">
      <button class="blue" onclick="savePostedSet('${id}','${authorId}','${logId}')">Save</button>
      <button class="red" style="margin-top:8px" onclick="deletePostedSet('${id}','${authorId}','${logId}')">Delete set</button>
    </div>`);
}
async function savePostedSet(id, authorId, logId){
  const epoch=UI_EPOCH;
  const w = document.getElementById('ppEdW').value, r = document.getElementById('ppEdR').value;
  const s = await H.put(`/api/sessions/${id}/log/${logId}`, { weight:w, reps:r });
  if(s && s.error){ alert(s.error); return; }
  // closeSheet() closes whatever .sheet-back is currently topmost -- correct when the user is
  // still looking at the Edit-set sheet this save came from, wrong if they've since closed it and
  // opened something else entirely (that unrelated sheet would get closed instead).
  if(nothingNavigatedSince(epoch)){ closeSheet(); viewPost(id, authorId, {silent:true}); }
}
async function deletePostedSet(id, authorId, logId){
  confirmSheet('Delete set?', "The set comes off your logged workout — there's no undo.", 'Delete set', () => deletePostedSetConfirmed(id, authorId, logId));
}
async function deletePostedSetConfirmed(id, authorId, logId){
  const epoch=UI_EPOCH;
  const s = await H.delete(`/api/sessions/${id}/log/${logId}`);
  if(s && s.error){ alert(s.error); return; }
  if(nothingNavigatedSince(epoch)){ closeSheet(); viewPost(id, authorId, {silent:true}); }
}
// v252 (audit finding): acceptInvite/declineInvite/requestJoin/requestChanges below all fired
// their navigation unconditionally after an await, the same barge-in shape v250/v251 already
// fixed elsewhere (toggleFollow, the posted-workout cluster, etc.) -- tap Accept, then switch tabs
// before the request resolves, and the stale response used to yank the screen back to the session
// regardless of where the user had moved on to. Guarded the same way with nothingNavigatedSince().
async function acceptInvite(id){ const epoch=UI_EPOCH; await H.post(`/api/sessions/${id}/accept`,{}); if(nothingNavigatedSince(epoch)) openSession(id); }
async function declineInvite(id){
  confirmSheet('Decline invite?', 'The workout comes off your Home.', 'Decline invite',
    async () => { const epoch=UI_EPOCH; await H.post(`/api/sessions/${id}/decline`,{}); if(nothingNavigatedSince(epoch)) home({silent:true}); }, false);
}
// The requester's half of the join-request flow — approveJoin/rejectJoin (below) are the
// creator's half, and already existed; this side never had a button to actually fire the request
// from, even though the server route has been there all along.
async function requestJoin(id){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/join`,{});
  if(r && r.error){ alert(r.error); return; }
  if(nothingNavigatedSince(epoch)) openSession(id, {quiet:true});
}
function requestChanges(id){
  textEntrySheet({
    title:'Request changes', label:'What changes do you want?', placeholder:'e.g. swap Bench for Incline Bench', multiline:true, confirmLabel:'Send',
    onConfirm: async v => { if(!v.trim()) return; const epoch=UI_EPOCH; await H.post(`/api/sessions/${id}/comments`,{text:'Request changes: '+v}); if(nothingNavigatedSince(epoch)) openSession(id, {quiet:true}); }
  });
}
async function saveRoutine(id){
  const s=await H.get('/api/sessions/'+id);
  if(!s.exercises.length){ alert('This workout has no exercises yet — nothing to save.'); return; }
  textEntrySheet({
    title:'Save as routine', label:'Routine name', value:'Saved routine', placeholder:'e.g. Push Day',
    onConfirm: async v => {
      const r = await H.post('/api/templates',{name:(v||'').trim()||'Saved routine',exercises:s.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax}))});
      if(r && r.error){ alert(r.error); return; }
      alert('Saved as routine: '+r.name);
    }
  });
}
// v249 (audit finding): a null guard, belt-and-suspenders alongside removing the one dead call
// site that reached this with no #chatInput on the page (see the joinable-friend-tier comment
// above) — so a future caller added the same way fails quietly instead of throwing.
async function openChat(id){ const el=document.getElementById('chatInput'); if(el) el.focus(); }
async function sendChat(id){
  const t=$('chatInput').value; if(!t.trim()) return;
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/comments`,{text:t});
  // this used to throw the response away, so a refused message simply disappeared and the box
  // cleared as though it had sent
  if(!r || r.error){ alert((r && r.error) === 'forbidden' ? 'Only people in this workout can post here.' : ((r && r.error) || 'That did not send. Try again.')); return; }
  // v252 (audit finding): both the clear and the re-open used to fire unconditionally -- if the
  // user had already navigated away, $('chatInput') could be gone entirely (a wrong-screen crash,
  // not just a barge-in) on top of yanking them back to a session they'd left.
  if(nothingNavigatedSince(epoch)){ $('chatInput').value=''; openSession(id, {quiet:true}); }
}
async function loadChat(s){
  const box=$('chatbox'); if(!box) return;
  const cs=await H.get(`/api/sessions/${s.id}/comments`);
  // A refusal is not an empty thread. This reported "No comments yet" on a 403, which is a claim
  // about the workout that happens to be false.
  if(!Array.isArray(cs)){ box.innerHTML='<div class="muted">Only people in this workout can see the chat.</div>'; return; }
  if(!cs.length){ box.innerHTML='<div class="muted">No comments yet. Be the first to comment.</div>'; return; }
  const nm={};
  for(const c of cs){ if(!(c.userId in nm)) nm[c.userId]= await nameOf(c.userId); }
  box.innerHTML = cs.map(c=>{
    const name = c.userId===ME.id?'You':(nm[c.userId]||'User');
    const ini = c.userId===ME.id?'Y':((nm[c.userId]||'?')[0]||'?');
    // "You" used to get an off-palette orange found nowhere else in the app, while everyone else
    // got the old rainbow hash -- two more one-off treatments on top of Home's own green avatar.
    // avatarColor() is now one consistent accent for everyone (see its definition), including you;
    // the bold "You"/name label right next to it is what actually says whose comment this is.
    const col = avatarColor(nm[c.userId]||c.userId);
    const t = new Date(c.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    return '<div class="cmt"><div class="fav-av" style="background:'+col+';color:#fff">'+esc(ini)+'</div><div class="cmt-body"><div class="cmt-head"><b>'+esc(name)+'</b> <span class="muted" style="font-size:11px">'+t+'</span></div><div class="cmt-text">'+esc(c.text)+'</div></div></div>';
  }).join('');
}

// v254: openSwapPicker() reaches the library via showTab('lib', true), which pushes its own
// {t:'tab',tab:'lib'} entry (a real tab switch, complete with nav-highlight change) on top of the
// session's own entry. Cancelling/picking undoes that excursion by popping back to where the
// session was, via history.go() -- letting the popstate handler quietly re-render the session
// from the entry that was already sitting underneath, rather than performing a fresh navigation
// of its own.
//
// An earlier version instead did history.replaceState({t:'session',id}, ...) on top of the
// picker's entry, then rendered the session directly. That looked right but left two CONSECUTIVE,
// identical {t:'session',id} entries on the stack: the one pushed when the session was first
// opened, plus the replaced one where the library entry used to be. A single Back press then only
// walked from the duplicate back to the original -- still landing on the session -- so it took a
// SECOND press to actually leave (live-verified broken via Playwright: one Back after
// swapCancel() left the user stranded on the session instead of returning to where they opened it
// from).
//
// A next attempt just did a bare history.back() -- correct for the picker's ROOT screen (exactly
// one entry pushed by showTab), but the picker's root only shows muscle-group tiles, not a flat
// exercise list: drilling into a category (the normal way to find something to swap, via
// libOpenMuscle -- see renderLibGroups) pushes a SECOND {t:'muscle',m} entry on top of the
// picker's own, since that tap is indistinguishable from a genuine library navigation. A single
// history.back() from there only pops the muscle entry, landing back on the picker's root (cold
// review caught this, confirmed by reading libOpenMuscle/renderLibGroups) -- the exact "needs a
// second Back press" bug this function exists to eliminate, just one level deeper. So instead of
// assuming exactly one entry, pop however many were actually pushed since the picker opened:
// SWAP_ENTRY_HISTORY_LEN captures history.length at that moment (see openSwapPicker), and the
// difference from the current length is exactly the picker's own excursion, at whatever depth.
function backToSessionAfterSwapPicker(){
  const delta = history.length - SWAP_ENTRY_HISTORY_LEN;
  history.go(delta > 0 ? -delta : -1);
}
function swapCancel(){
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;
  backToSessionAfterSwapPicker();
}
async function swapPick(name){
  const id = SWAP_SESSION;
  if(!id) return;
  const fromId = SWAP_FROM;
  SWAP_MODE = false;
  SWAP_SESSION = null; SWAP_FROM = null;
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/suggest`,{exerciseId:fromId, swapTo:name});
  if(r.error) alert(r.error); else if(nothingNavigatedSince(epoch)) backToSessionAfterSwapPicker();
}
async function suggest(id){ const epoch=UI_EPOCH; const r=await H.post(`/api/sessions/${id}/suggest`,{exerciseId:$('swEx').value,swapTo:$('swTo').value}); if(r.error)alert(r.error); else if(nothingNavigatedSince(epoch)) openSession(id, {quiet:true}); }

// ---- The collaborate half: five buttons that called functions nobody ever wrote ----
// Approve/Reject on a suggested swap, Approve/Reject on a join request, and the door into the
// swap picker. Every server endpoint below already existed, worked and was tested; the other half
// of the swap flow (swapPick/swapCancel, just above) was already written too. Only these five
// wrappers were missing — so the buttons rendered, looked exactly like live ones, and did nothing.
// A dead button is indistinguishable from a working one until you press it.
// v252 (audit finding): all four below re-opened the session unconditionally after their await,
// same barge-in shape as swapPick/suggest just above -- guarded the same way.
async function approve(id, editId){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/suggest/${editId}/approve`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else if(nothingNavigatedSince(epoch)) openSession(id, {quiet:true});
}
async function reject(id, editId){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/suggest/${editId}/reject`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else if(nothingNavigatedSince(epoch)) openSession(id, {quiet:true});
}
async function approveJoin(id, reqId){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/join/${reqId}/approve`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else if(nothingNavigatedSince(epoch)) openSession(id, {quiet:true});
}
async function rejectJoin(id, reqId){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/join/${reqId}/reject`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else if(nothingNavigatedSince(epoch)) openSession(id, {quiet:true});
}
// Opens the Workouts library in "pick a replacement" mode. library() already renders a
// "Pick replacement" header when SWAP_MODE is set, and tapping an exercise there already calls
// swapPick. This is the entry point that was never fitted.
function openSwapPicker(id, exerciseId){
  // exerciseId is passed when you tap the exercise itself; otherwise fall back to the picker's
  // dropdown. Tapping the lift you want changed is the natural gesture — you do not want to swap
  // "a workout", you want to swap Barbell Row.
  if(!exerciseId){ const sel = $('swEx'); exerciseId = sel ? sel.value : ''; }
  if(!exerciseId) return alert('Add an exercise first, then pick which one to swap.');
  SWAP_MODE = true; SWAP_SESSION = id; SWAP_FROM = exerciseId;
  LIB_ADDMODE = false;   // exRowHtml tests SWAP_MODE first, so leaving this set makes "+ Add
                         // exercise" silently file swap suggestions against the old workout
  SUGGEST_ADD_MODE = false; SUGGEST_ADD_SESSION = null;   // never more than one picker mode at once
  SWAP_ENTRY_HISTORY_LEN = history.length;   // see backToSessionAfterSwapPicker's comment
  showTab('lib', true);
}
// v262b: the other half of "add the ability to add an exercise to a workout, not just suggest a
// swap" (Jeff, Aug 31). Same shape as openSwapPicker just above -- open the Workouts library,
// picking a row files a suggestion instead of acting immediately -- but there is no FROM exercise
// here: this proposes a brand-new addition, not a replacement, so SWAP_FROM has nothing to hold.
// Server-side this is the exact same /suggest + approve/reject pipeline a swap already goes
// through (see server.js), just a different edit `type`.
function openSuggestAddPicker(id){
  SUGGEST_ADD_MODE = true; SUGGEST_ADD_SESSION = id;
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;   // never more than one picker mode at once
  LIB_ADDMODE = false;
  SWAP_ENTRY_HISTORY_LEN = history.length;   // backToSessionAfterSwapPicker only ever does history
                                              // math off this -- it never reads SWAP_SESSION/SWAP_FROM,
                                              // so it's safe to reuse verbatim for this mode too
  showTab('lib', true);
}
function suggestAddCancel(){
  SUGGEST_ADD_MODE = false; SUGGEST_ADD_SESSION = null;
  backToSessionAfterSwapPicker();
}
async function suggestAddPick(name){
  const id = SUGGEST_ADD_SESSION;
  if(!id) return;
  SUGGEST_ADD_MODE = false; SUGGEST_ADD_SESSION = null;
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/suggest`,{type:'add', name});
  if(r.error) alert(r.error); else if(nothingNavigatedSince(epoch)) backToSessionAfterSwapPicker();
}
// Opens the Library restricted to base-library exercises only (renderLibGroups/renderLibExercises
// filter out e.custom when SEED_MODE -- see their comments) since PUT /api/me/seeds 400s on
// anything not in EX_LIB (server.js). Same shape as openSwapPicker/openSuggestAddPicker above.
function openSeedPicker(){
  SEED_MODE = true;
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;         // never more than one picker mode at once
  SUGGEST_ADD_MODE = false; SUGGEST_ADD_SESSION = null;
  LIB_ADDMODE = false;
  SWAP_ENTRY_HISTORY_LEN = history.length;   // reused verbatim -- see SUGGEST_ADD_MODE's own comment above
  showTab('lib', true);
}
function seedPickerCancel(){
  SEED_MODE = false;
  backToSessionAfterSwapPicker();
}
function seedPickerPick(name){
  SEED_MODE = false;
  if(!SEED_DRAFT.some(r=>r.exercise===name)) SEED_DRAFT.push({ exercise:name, weight:'', reps:'', goal:'' });
  backToSessionAfterSwapPicker();
}
// ---- Seed your lifts: Settings screen for PUT/GET/DELETE /api/me/seeds -------------------------
// Jeff, Sep 1 ("what is this app missing" -> "lets build the worth doing next", built first): the
// server side of this has existed since before this feature with zero client UI (see the "Lifts
// you already do" block in server.js). A user arriving with years of training has bests and working
// weights the app can't know -- this lets them tell it, so Progress is useful sooner instead of
// showing every logged set as a "PR" for the first few weeks.
//
// v1 of this also auto-prompted every new registration with this screen before Home. Jeff, seeing
// it rendered: "do people actually need or want to set this up... now that I'm thinking about it
// and seeing it more, I'm not sure" -- right call. The underlying problem is real but minor
// (cosmetic, self-correcting within a week of real logging), and the fix asked for six lifts' worth
// of data entry before a brand-new user had done anything else with the app -- a bad trade for
// value only a narrow slice of users (an experienced lifter migrating their history) would ever
// want. Settings-only now: reachable via a permanent "Starting weights" row (openSettings) for
// whoever actually wants it, nobody else is ever interrupted by it.
//
// SEED_DEFAULTS is a curated 6-lift set spanning squat / hinge / horizontal-push / overhead-push /
// vertical-pull / horizontal-pull -- exact names verified 1:1 against exercise-library.json so they
// pass PUT /api/me/seeds's EX_LIB.some(...) check. Shown as blank rows even when nothing is seeded
// yet, so it's obvious what to fill in rather than an empty page; anything already seeded that
// ISN'T one of these six (e.g. added via "+ Add another lift" on a prior visit) is appended after.
const SEED_DEFAULTS = ['Barbell Back Squat','Conventional Deadlift','Flat Barbell Bench Press','Overhead Barbell Press','Pull-Up','Barbell Row'];
// In-memory working copy of what's on screen -- stashed/restored the same way DRAFT is for the
// create-flow (see openAddExercises's comment above), so a value typed but not yet saved, and a
// lift just picked from openSeedPicker, both survive the round trip through the library picker.
let SEED_DRAFT = [];
async function seedSetupScreen(opts){
  const fromHistory = !!(opts && opts.fromHistory);
  if(!fromHistory){
    // A fresh entry (tapped from Settings) rebuilds SEED_DRAFT from the server's real seeds -- a
    // fromHistory landing (Back from the picker, or a genuine browser Back onto this screen) reuses
    // SEED_DRAFT exactly as it stands instead, so nothing just picked or typed is lost or silently
    // refetched away.
    const r = await H.get('/api/me/seeds');
    const seeds = (r && r.seeds) || {};
    const rowFor = name => ({ exercise:name, weight: seeds[name]!=null?String(seeds[name].weight ?? ''):'', reps: seeds[name]!=null?String(seeds[name].reps ?? ''):'', goal: seeds[name]!=null?String(seeds[name].goal ?? ''):'' });
    SEED_DRAFT = SEED_DEFAULTS.map(rowFor);
    Object.keys(seeds).forEach(name=>{ if(!SEED_DRAFT.some(r=>r.exercise===name)) SEED_DRAFT.push(rowFor(name)); });
  }
  renderSeedSetup();
  const st = { t:'seeds' };
  fromHistory ? landOn(st) : navigated(st);
}
// Reads whatever's currently typed on screen back into SEED_DRAFT before navigating away (to the
// picker, or Save) -- same stash-before-leaving pattern as openAddExercises/templatesPage above.
function seedStashInputs(){
  SEED_DRAFT.forEach((r,i)=>{
    const w=$('seedW'+i), rp=$('seedR'+i), g=$('seedG'+i);
    if(w) r.weight = w.value;
    if(rp) r.reps = rp.value;
    if(g) r.goal = g.value;
  });
}
function seedOpenGoal(i){ seedStashInputs(); SEED_DRAFT[i]._goalOpen = true; renderSeedSetup(); setTimeout(()=>{ const g=$('seedG'+i); if(g) g.focus(); }, 30); }
function seedRemoveRow(i){
  seedStashInputs();
  const removed = SEED_DRAFT[i];
  SEED_DRAFT.splice(i,1);
  // Fire-and-forget: idempotent no-op if this row was never actually saved server-side (a blank
  // default row someone doesn't lift, say), a real delete if it was -- either way there's nothing
  // useful to do with the response, and nothing here should block the row from disappearing.
  if(removed) H.delete('/api/me/seeds/'+encodeURIComponent(removed.exercise)).catch(()=>{});
  renderSeedSetup();
}
function seedAddAnother(){ seedStashInputs(); openSeedPicker(); }
async function seedSaveAll(){
  seedStashInputs();
  const btn = $('seedSaveBtn');
  if(btn && btn.disabled) return;
  if(btn) btn.disabled = true;
  try{
    const results = await Promise.all(SEED_DRAFT.map(r =>
      H.put('/api/me/seeds', { exercise:r.exercise, weight:r.weight, reps:r.reps, goal:r.goal })
    ));
    const err = results.find(r => r && r.error);
    if(err){ alert(err.error); return; }
  } finally { if(btn) btn.disabled = false; }
  // seedSetupScreen pushed a real navigated() entry to get here (always via Settings now), so Back
  // returns to wherever that actually was -- normally the profile page Settings was opened from.
  history.back();
}
function renderSeedSetup(){
  const unit = myUnit();
  const rows = SEED_DRAFT.map((r,i)=>`
    <div class="card seed-row">
      <div class="seed-row-head">
        <div class="ex-name">${esc(r.exercise)}</div>
        <button class="icon-btn" title="Remove" aria-label="Remove ${esc(r.exercise)}" onclick="seedRemoveRow(${i})">✕</button>
      </div>
      <div class="seed-row-fields">
        <div><label class="muted">Weight (${esc(unit)})</label><input id="seedW${i}" type="number" inputmode="decimal" step="any" placeholder="e.g. 185" value="${esc(r.weight)}"></div>
        <div><label class="muted">Reps</label><input id="seedR${i}" type="number" inputmode="tel" pattern="[0-9]*" placeholder="1" value="${esc(r.reps)}"></div>
      </div>
      ${r._goalOpen || r.goal ? `<div class="seed-goal"><label class="muted">Goal (${esc(unit)})</label><input id="seedG${i}" type="number" inputmode="decimal" step="any" placeholder="optional" value="${esc(r.goal)}"></div>`
        : `<button class="txt-btn" style="padding:6px 0" onclick="seedOpenGoal(${i})">+ Set a goal</button>`}
    </div>`).join('');
  $('app').innerHTML = `<div class="wrap">
    <div class="pick-head lib-head">
      <h1 style="flex:1">Starting weights</h1>
    </div>
    <div class="muted" style="font-size:13px;margin:2px 2px 14px">Already lifting these? Enter what you're working with now so Progress starts from where you actually are, not from zero.</div>
    ${rows}
    <button class="sec" style="width:100%;margin:2px 0 18px" onclick="seedAddAnother()">+ Add another lift</button>
    <button class="blue" id="seedSaveBtn" style="width:100%" onclick="seedSaveAll()">Save</button>
  </div>`;
  window.scrollTo(0,0);
}
// ---------- Per-exercise set logger (Hevy/Strong style) ----------
const SET_TYPES = [
  { key:'normal', label:'Normal' },
  { key:'warmup', label:'Warm up' },
  { key:'drop', label:'Drop' },
  { key:'failure', label:'Failure' }
];
const TYPE_CLASS = { normal:'t-normal', warmup:'t-warm', drop:'t-drop', failure:'t-fail' };
const TYPE_LABEL = { normal:'Normal', warmup:'Warm up', drop:'Drop', failure:'Failure' };
let LOGVIEW = { sid:null, exId:null };

// ---- Load type: what the number in the weight box actually means ----
// The library tags exercises whose entered weight is ambiguous (see exercise-library.json):
//   pair   two implements, the number is PER HAND  (70 → 70 each, 140 total)
//   single one implement, the number is the whole load (goblet squat, Turkish get-up)
//   added  bodyweight movement, the number is ADDED weight only (weighted pull-up)
// Untagged exercises are unambiguous (barbell, cable, machine) and show no note.
// Sessions store only the exercise NAME, so look the tag up in the library by name.
let _LIBBYNAME = null;
async function libByName(){
  if(_LIBBYNAME) return _LIBBYNAME;
  const lib = window._LIB2 || await H.get('/api/exercises');
  if(!window._LIB2 && Array.isArray(lib)) window._LIB2 = lib;
  _LIBBYNAME = {};
  if(Array.isArray(lib)) for(const e of lib) _LIBBYNAME[e.name] = e;
  return _LIBBYNAME;
}
// Units. ME.units is set at login/boot from the server. Each logged set also carries the
// unit it was typed in, so a set logged in kg keeps reading in kg after switching preference.
function myUnit(){ return (ME && ME.units) || 'lb'; }
function unitOf(entry){ return (entry && entry.unit) || 'lb'; }
// Plate maths differs per unit: lb bars move in 5s, kg bars in 2.5s.
const INCREMENTS = { lb:{upper:5, lower:10, machine:20}, kg:{upper:2.5, lower:5, machine:10} };

const LOAD_LABEL = {
  pair:   'per dumbbell',
  single: 'total',
  added:  'added weight',
};
// The live readout beside the weight box — this is what actually removes the ambiguity,
// because the user never has to reason about which convention the app assumed.
function loadHintText(loadType, w){
  const n = Number(w)||0;
  const U = myUnit();
  if(loadType==='pair')   return n ? `= ${n*2} ${U} total, both hands` : 'weight in each hand';
  if(loadType==='single') return 'one dumbbell, total weight';
  if(loadType==='added')  return n ? `${n} ${U} on top of bodyweight` : 'weight added, not bodyweight';
  return '';
}
function updateLoadHint(){
  const el=document.getElementById('logLoadHint'); if(!el) return;
  const w=document.getElementById('logW'); if(!w) return;
  el.textContent = loadHintText(el.dataset.load, w.value);
}
async function openLogSheet(sid, exId){
  const s = await H.get('/api/sessions/'+sid);
  if(!s || s.error){ alert(s && s.error ? s.error : 'Session not found'); return; }
  const e = s.exercises.find(x=>x.id===exId); if(!e) return;
  // A swapped exercise logs under the swap, so the advice has to be looked up under the swap too.
  // Asking about the template's name on a swapped lift returned "first time logging this" for
  // someone with months of history on it.
  const myVar = s.variations && s.variations[exId] && s.variations[exId][ME.id];
  const recName = (myVar && myVar.swapTo) || e.name;
  const libEntry = (await libByName())[e.name];
  const loadType = libEntry && libEntry.loadType ? libEntry.loadType : '';
  LOGVIEW = { sid, exId, loadType, recName };
  const mine = (s.logs && s.logs[ME.id]) || [];
  const exLogs = mine.filter(l=>l.exerciseId===exId);
  const bestLog = exLogs.slice().sort((a,b)=>((Number(b.weight)||0)*(Number(b.reps)||0))-((Number(a.weight)||0)*(Number(a.reps)||0)))[0];
  const last = bestLog ? `${bestLog.weight} × ${bestLog.reps}` : '—';
  history.pushState({t:'sheet'}, '', location.href); // v254: Back dismisses this sheet -- see openSheetHtml's comment
  const sheet = document.createElement('div'); sheet.className='sheet-back';
  sheet.innerHTML = `
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Log · ${esc(e.name)}</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="ex-sub">${repLabel(e) ? `Target: <b>${e.defaultSets} × ${repLabel(e)}</b> · ` : ''}Last time: <b>${esc(last)}</b></div>
      <div id="logRec"></div>
      <div id="logSetList"></div>
      <div class="type-picker">
        <button type="button" class="type-pill t-normal" id="logTypePill" onclick="toggleTypeSeg()" aria-label="Set type: Normal. Tap to change.">${TYPE_LABEL.normal} <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="seg hidden" id="logTypeSeg">
          ${SET_TYPES.map((t,i)=>`<div class="chip${i===0?' on':''}" data-t="${t.key}" onclick="logSetType('${t.key}')">${t.label}</div>`).join('')}
        </div>
      </div>
      <div class="add-row">
        <button type="button" class="icon-btn ql-mic-icon" aria-label="Hold to speak a set" onpointerdown="qlMicDown(event)" onpointerup="qlMicUp()" onpointercancel="qlMicUp()"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        <input id="logW" placeholder="${loadType==='pair'? myUnit()+' each' : myUnit()}" type="number" inputmode="decimal" step="any" oninput="updateLoadHint()">
        <input id="logR" placeholder="reps" type="number" inputmode="tel" pattern="[0-9]*">
        <button type="button" class="rir-toggle" id="logRirToggle" onclick="toggleRirInput()" aria-label="Add reps in reserve" title="Reps in reserve (optional)">RIR</button>
        <input id="logRir" class="hidden" placeholder="RIR" type="number" inputmode="tel" pattern="[0-9]*" style="flex:0 0 60px; padding-left:8px; padding-right:6px" title="Reps in reserve (optional)">
        <button class="add-btn" onclick="addLogSet()">+ Add</button>
      </div>
      ${loadType?`<div class="load-note">
        <span class="load-chip">${LOAD_LABEL[loadType]}</span>
        <span class="load-hint" id="logLoadHint" data-load="${loadType}">${loadHintText(loadType,'')}</span>
      </div>`:''}
      <div id="logRest"></div>
      <div class="note">${qlExample()} · tap a set to edit or delete it. Set # auto-fills.</div>
    </div>`;
  sheet.onclick=(ev)=>{ if(ev.target===sheet) closeSheet(); };
  document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
  // Stamped onto LOGVIEW so a background silent refresh (see openSession's opts.silent) can
  // check THIS exact sheet's presence/visibility, not just "some .sheet-back.show exists
  // somewhere" — editLogSet stacks a second .sheet-back on top of this one without closing it,
  // so while both are open a generic selector here could match either one.
  LOGVIEW.sheetEl = sheet;
  renderLogSets(s);
  // The advice belongs HERE, at the moment the weight is chosen — not only on a tab the user
  // has to remember to open before leaving for the gym. Loaded after the sheet is on screen
  // so it never delays opening.
  refreshLogRec();
}
// Jeff, Aug 30: "the 'when to add weight next' shows when you tap to log a set. I feel most
// people ... I do a set and THEN tap log a set. so I would see the added weight after my set."
// This box used to fetch/render exactly once, the moment the sheet opened -- fine for the very
// FIRST set of an exercise (there is nothing else to base it on yet but past sessions), but it
// then sat frozen for the rest of the exercise even as more sets got logged. recommendationsFor
// (server.js) already looks at whatever is in s.logs for TODAY's session, not just finished ones
// -- it was only ever the CLIENT that never asked again. Calling this again after every addLogSet
// (below) turns it from a one-time pre-set prediction into live, running feedback: log your first
// set and the box updates using what you actually just did, same as looking at it again after
// setting the bar down instead of before picking it up.
// Reads recName AND the sheet element itself at call time, into the closure below, rather than
// re-reading LOGVIEW once the fetch resolves — LOGVIEW is one shared global reused for whichever
// log sheet is currently open (editLogSet/saveLogSet reassign it to a freshly reopened sheet), so
// a slow response landing after the user closed this sheet and opened a DIFFERENT exercise's would
// otherwise render THIS exercise's stale advice into the NEW sheet's #logRec (cold-review catch).
// A second, same-sheet race is also possible: log two sets back-to-back (nothing blocks the
// "+ Add" button while the previous refresh is still in flight) and the two GETs can resolve out
// of order, painting set 1's now-stale advice over set 2's correct one with no error and nothing
// visibly wrong. Guarded with a per-sheet counter stashed directly on the element (sheetEl
// already uniquely identifies "this open sheet" — no separate map to keep in sync) — each call
// stamps the next number and only the response matching the CURRENT stamp is allowed to render.
function refreshLogRec(){
  const recName = LOGVIEW && LOGVIEW.recName;
  const sheetEl = LOGVIEW && LOGVIEW.sheetEl;
  if(!recName || !sheetEl) return;
  const mySeq = (sheetEl._recSeq = (sheetEl._recSeq||0) + 1);
  H.get('/api/progress/exercise/'+encodeURIComponent(recName)).then(r=>{
    if(sheetEl._recSeq !== mySeq) return;   // superseded by a newer refresh on this same sheet
    const box=sheetEl.querySelector('#logRec'); if(!box||!r||r.error) return;
    const U=r.unit||'lb';
    // A pull-up or dip stores weight 0 — "at 0 lb" reads as a bug, "at bodyweight" reads as English.
    const W=w=>(Number(w)>0? `${w} ${U}` : 'bodyweight');
    if(r.ready) box.innerHTML=`<div class="log-rec up" role="button" tabindex="0"
        onclick="useSuggested(${r.ready.suggested})"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();useSuggested(${r.ready.suggested});}">
        <span class="lr-ic" aria-hidden="true">↑</span>
        <span class="lr-t">${r.ready.bodyweight
          ? `Add <b>${r.ready.step} ${U}</b> today`
          : `Try <b>${r.ready.suggested} ${U}</b> today`}</span>
        <span class="lr-why">hit ${r.ready.targetRepsMax} reps at ${W(r.ready.weight)}, last 2 sessions</span>
      </div>`;
    else if(r.hold) box.innerHTML=`<div class="log-rec hold">
        <span class="lr-ic" aria-hidden="true">–</span>
        <span class="lr-t">Repeat <b>${W(r.hold.weight)}</b></span>
        <span class="lr-why">${r.hold.reps} of ${r.hold.targetRepsMax} reps last time</span>
      </div>`;
    // One clean session away. Dashed green, not solid: the same family as the real suggestion,
    // visibly not yet the real suggestion, and — unlike the green box — not tappable.
    else if(r.soon) box.innerHTML=`<div class="log-rec almost">
        <span class="lr-ic" aria-hidden="true">⋯</span>
        <span class="lr-t">One more like that</span>
        <span class="lr-why">hit ${r.soon.targetRepsMax} reps at ${W(r.soon.weight)} again and the weight goes up</span>
      </div>`;
    // Nothing to advise yet. Say what is coming anyway — otherwise the one feature that tells you
    // what to do next is only ever explained on a tab a new user has no reason to open. This is a
    // catch-all on purpose: the box must never render empty, whatever shape the history is in.
    else box.innerHTML=`<div class="log-rec soon">
        <span class="lr-ic" aria-hidden="true">⋯</span>
        <span class="lr-t">When to add weight</span>
        <span class="lr-why">${r.seed
          ? `Your working weight is ${r.seed.weight} ${U}. Hit the top of your rep range at that weight and this box gives you your next working weight.`
          : `Hit the top of your rep range two sessions in a row at the same weight. Then this box gives you your next working weight.`}</span>
      </div>`;
  }).catch(()=>{});
}
// NOTE: this state deliberately says the SAME thing no matter how much history you have.
// It used to report a status — "First time logging this" / "One session logged" / "Keep
// logging" — driven by a session count, and the count included the workout you were standing
// in, so it announced a session you had not finished. A count also cannot know whether those
// sessions topped out or at what weight, so no status built on it can be reliably true. The
// box has one job; it now states that job and nothing else, until it has real advice.
// One tap fills the weight box, so the advice is one action rather than something to memorise.
function useSuggested(w){
  const el=document.getElementById('logW'); if(!el) return;
  el.value=w; updateLoadHint();
  const box=document.getElementById('logRec'); if(box) box.classList.add('used');
}
// Jeff, Aug 31: "do we think this is the best way for us to log? ... a simpler way, a cleaner
// way?" -- the 4-chip Normal/Warm up/Drop/Failure row used to sit permanently expanded above the
// add-row, full width, on every single set even though the overwhelming majority are Normal. It's
// now a small collapsed pill (below) that shows the current type and expands into the same 4
// chips only on tap; picking one (here) collapses it straight back. The pill's color is loud on
// purpose when NOT Normal -- reusing the same t-warm/t-drop/t-fail language already used for
// logged-set badges in the list below -- so a leftover Warm up/Drop/Failure selection from a
// previous set stays visibly obvious even collapsed. It must never be possible to silently log a
// real working set as a warm-up because the picker quietly stayed open (or closed) on an old
// choice from a few sets ago.
function logSetType(key){
  const seg=document.getElementById('logTypeSeg'); if(!seg) return;
  seg.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on', c.getAttribute('data-t')===key));
  const pill=document.getElementById('logTypePill');
  if(pill){
    pill.className = `type-pill ${TYPE_CLASS[key]||'t-normal'}`;
    pill.setAttribute('aria-label', `Set type: ${TYPE_LABEL[key]||'Normal'}. Tap to change.`);
    pill.innerHTML = `${TYPE_LABEL[key]||'Normal'} <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  seg.classList.add('hidden');
}
// Tapping the pill reveals the same 4 chips it always had; tapping ANY chip (including the one
// already selected) re-collapses via logSetType above -- so tapping the current type is a
// no-op "never mind" close, with no separate cancel button needed.
function toggleTypeSeg(){
  const seg=document.getElementById('logTypeSeg'); const pill=document.getElementById('logTypePill');
  if(!seg||!pill) return;
  seg.classList.remove('hidden'); pill.classList.add('hidden');
}
// RIR (task #62) stays hidden by default, same reasoning as it resetting every set (see
// addLogSet below): it's an occasional, deliberate read on effort, not something that should
// occupy a permanent slot in the row for the 1 in 10 sets it actually applies to. Revealed by
// this button, replacing it in the same slot so the row's width doesn't jump.
function toggleRirInput(){
  const btn=document.getElementById('logRirToggle'); const inp=document.getElementById('logRir');
  if(!btn||!inp) return;
  btn.classList.add('hidden'); inp.classList.remove('hidden'); inp.focus();
}
// ---- Quick log (v243) ----
// One box on the log sheet that understands a whole set said (via the keyboard's mic) or typed
// in one line: "45 lbs at 8 reps", "185 for 5", "225 x 3", "8 reps at 45", "warm up 135 for 10",
// "normal set, 45 at 8, 2 RIR". Jeff, Aug 29: "I want to be able to voice text 'I did 45lbs at
// 8 reps' and it will log that set... say 'normal set, 45lbs at 8 reps, 2 RIR' and it fills
// everything in for me."
//
// Design rules, in order of importance:
// - NEVER log something the person didn't say. The parser is deterministic; anything it isn't
//   sure about it simply doesn't fill in. The parse result lands in the REAL weight/reps/RIR
//   fields and the type chips - visible before anything saves - and the checkmark goes through
//   addLogSet(), the exact same code path (same validation, PR detection, celebration) as +Add.
// - Only ever ADD to the form: a partial phrase fills the parts it names and leaves whatever
//   was already typed in the other boxes alone. Garbage fills nothing.
// - A unit that CONFLICTS with the account's unit ("100 kg" said by an lb-configured account)
//   fills nothing at all: silently logging 100 lb would be false data, and converting silently
//   would surprise. The person just types that one normally.
// SPOKEN numbers -> digits (v245, Jeff live on his phone: "I said 8 and it wrote it out as
// eight and wouldn't let me log"). In-app speech recognition writes small numbers as WORDS
// where the keyboard writes digits, so the parser has to read both. Handles plain words
// ("eight", "forty five"), hundreds ("one hundred and thirty five"), gym-speak shorthand
// ("one thirty five" = 135, "two twenty five" = 225, "two oh five" = 205), and half-steps
// ("point five", "and a half"). Deliberately NO homophone guessing: "for"/"to"/"won" are never
// treated as 4/2/1 - "for" is a separator and "to failure" is a set type, and a wrong number
// is the one thing this parser must never produce.
const QL_ONES = { zero:0, oh:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8,
  nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19 };
const QL_TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
function qlWordsToDigits(t){
  const words = t.split(' ');
  const out = [];
  let i = 0;
  const isNum = w => (w in QL_ONES) || (w in QL_TENS) || w === 'hundred';
  while(i < words.length){
    if(!isNum(words[i]) || (words[i] === 'hundred' && !out.length && i === 0)){ out.push(words[i]); i++; continue; }
    // collect one spoken-number run
    const run = [];
    let j = i;
    while(j < words.length){
      const w = words[j];
      if(isNum(w)) { run.push(w); j++; continue; }
      if(w === 'and' && j+1 < words.length && (isNum(words[j+1]) || words[j+1] === 'a')
         && run[run.length-1] === 'hundred'){ j++; continue; }        // "one hundred and five"
      break;
    }
    // evaluate the run left to right
    let total = 0, cur = 0, k = 0, bad = false;
    while(k < run.length && !bad){
      const w = run[k];
      if(w === 'hundred'){ cur = (cur || 1) * 100; total += cur; cur = 0; k++; continue; }
      const v = (w in QL_TENS) ? QL_TENS[w] : QL_ONES[w];
      if(cur === 0){ cur = v; k++; continue; }
      if(cur >= 1 && cur <= 9 && k === 1 && (w in QL_TENS || (v >= 10 && v <= 19) || w === 'oh' || w === 'zero')){
        // gym shorthand: "one thirty five"=135, "two fifteen"=215, "two oh five"=205
        cur = cur * 100 + v; k++;
        if((w === 'oh' || w === 'zero') && k < run.length && run[k] in QL_ONES && QL_ONES[run[k]] <= 9){ cur += QL_ONES[run[k]]; k++; }
        continue;
      }
      if(cur % 10 === 0 && cur % 100 !== 0 && v <= 9){ cur += v; k++; continue; }   // "forty" + "five"
      if(cur >= 100 && v <= 99 && cur % 100 === 0){ cur += v; k++; continue; }      // "one thirty" + ... (already merged) / "200" + "twenty five"
      bad = true;                                        // a shape we don't understand - leave the words alone
    }
    if(bad){ for(const w of run) out.push(w); i = j; continue; }
    total += cur;
    // decimals said out loud: "point five" / "and a half"
    let dec = '';
    if(words[j] === 'point' && j+1 < words.length && words[j+1] in QL_ONES && QL_ONES[words[j+1]] <= 9){ dec = '.' + QL_ONES[words[j+1]]; j += 2; }
    else if(words[j] === 'and' && words[j+1] === 'a' && words[j+2] === 'half'){ dec = '.5'; j += 3; }
    out.push(String(total) + dec);
    i = j;
  }
  return out.join(' ');
}
// Pure function so test/quicklog-parse.mjs can hammer phrasings without a DOM.
function parseQuickLog(raw){
  if(raw === undefined || raw === null) return null;
  // NO regex lookbehind anywhere in this file: iOS Safari before 16.4 throws a SyntaxError at
  // PARSE time for it, which would brick the entire app for anyone on an older iPhone.
  let t = String(raw).toLowerCase().replace(/[,;:!?"'“”-]+/g,' ')
    .replace(/\.(?!\d)/g,' ')                               // strip periods EXCEPT decimal points
    .replace(/(\d)([a-z])/g,'$1 $2').replace(/([a-z])(\d)/g,'$1 $2')   // "45lbs" -> "45 lbs", "rir2" -> "rir 2"
    .replace(/\s+/g,' ').trim();
  if(!t) return null;
  t = qlWordsToDigits(t);
  // MIXED digit/word decimals (Jeff, Aug 29: "what if I say 2 POINT 5?"): speech can emit the
  // digits but leave "point"/"and a half" as words - "132 point 5", "222 and a half". Without
  // this, "132 point 5 for 5" fell through to the "5 for 5" pattern and produced a WRONG weight.
  // Runs after word conversion, so fully spoken forms land here too.
  t = t.replace(/(\d+)\s+point\s+(\d)\b/g, '$1.$2').replace(/(\d+)\s+and\s+a\s+half\b/g, '$1.5');
  const out = { setType:null, weight:null, reps:null, rir:null, unit:null };
  // "3 sets of 8" - the sets COUNT is stripped with its word, number and all, BEFORE anything
  // numeric is read. We log one set at a time, and without this the no-separator weight capture
  // below would happily read "3 sets of 8 reps" as 3 lb x 8 (a wrong number, which this parser
  // must never produce).
  t = t.replace(/\b\d+\s*sets?\b(\s*of\b)?/g,' ');
  // set type words (checked before stripping; "normal set" is an explicit normal)
  if(/\bwarm\s*-?\s*ups?\b/.test(t)) out.setType='warmup';
  else if(/\bdrop(\s*sets?)?\b/.test(t)) out.setType='drop';
  else if(/\b(to\s+)?failure\b/.test(t)) out.setType='failure';
  else if(/\bnormal(\s*sets?)?\b/.test(t)) out.setType='normal';
  t = t.replace(/\b(warm\s*-?\s*ups?|drop\s*sets?|drop|to\s+failure|failure|normal\s*sets?|normal|sets?)\b/g,' ');
  // units: note which was said, then strip the word
  if(/\b(lbs?|pounds?)\b/.test(t)) out.unit='lb';
  else if(/\b(kgs?|kilos?|kilograms?)\b/.test(t)) out.unit='kg';
  t = t.replace(/\b(lbs?|pounds?|kgs?|kilos?|kilograms?)\b/g,' ');
  // filler words that dictation loves
  t = t.replace(/\b(i|did|just|do|doing|done|logged|log|a|an|the|of|and|left|then|each)\b/g,' ').replace(/\s+/g,' ').trim();
  // Weight/reps come FIRST, and are STRIPPED before RIR is looked for (cold-review catch):
  // dictation can drop the pause in "185 for 5, 2 in reserve" and produce "185 for 52 in
  // reserve" - with RIR matched first that read as rir 52 and NOTHING else, discarding the
  // weight and reps that were plainly said. Weight-first keeps 185x52 (visibly wrong in the
  // form, easy to fix) instead of silently swallowing the whole line into an RIR.
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:at|@|for|x|by|times|\*)\s*(\d+(?:\.\d+)?)(?:\s*reps?)?\b/);
  if(m){ out.weight = Number(m[1]); out.reps = Number(m[2]); t = t.replace(m[0],' '); }
  else {
    // no separator word at all: "85 8 reps" (said as "85 lbs, 8 reps" - the unit word and comma
    // are already stripped by here). Weight first, then the reps-keyworded number.
    m = t.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*reps?\b/);
    if(m){ out.weight = Number(m[1]); out.reps = Number(m[2]); t = t.replace(m[0],' '); }
    else {
      // reps-first: "8 reps at 45", or reps alone: "8 reps" (bodyweight)
      m = t.match(/(\d+(?:\.\d+)?)\s*reps?\b(?:\s*(?:at|@|with|on)\s*(\d+(?:\.\d+)?))?/);
      if(m){ out.reps = Number(m[1]); if(m[2] !== undefined) out.weight = Number(m[2]); t = t.replace(m[0],' '); }
      else {
        // a lone number next to a said unit is a weight ("245 pounds")
        m = out.unit ? t.match(/^(\d+(?:\.\d+)?)$/) : null;
        if(m){ out.weight = Number(m[1]); t = t.replace(m[0],' '); }
      }
    }
  }
  // reps found but no weight, and exactly ONE bare number is left over ("8 reps 85", "8 reps,
  // 85 lbs") - weight is the only slot it can be (RIR and a sets count both require their
  // keyword and were already taken above). Anything more than one lone number stays unread.
  if(out.reps !== null && out.weight === null){
    m = t.replace(/\s+/g,' ').trim().match(/^(\d+(?:\.\d+)?)$/);
    if(m){ out.weight = Number(m[1]); t = ''; }
  }
  // RIR, from whatever is left: "rir 2", "2 rir", "2 in reserve", "2 in the tank"
  m = t.match(/\brir\s*(?:of\s*)?(\d+(?:\.\d+)?)\b/) || t.match(/\b(\d+(?:\.\d+)?)\s*(?:rir|in\s+(?:the\s+)?(?:reserve|tank))\b/);
  if(m) out.rir = Number(m[1]);
  if(out.setType===null && out.weight===null && out.reps===null && out.rir===null && out.unit===null) return null;
  return out;
}
// v257 (Jeff, Aug 30): "the spot where you can voice text is taking over... I sometimes find
// myself typing in there. Can we remove the text box and simply add a small microphone button
// by the spot we type in the info and it grabs my microphone and the inputs it?" -- the v243/
// v244/v245 quick-log box (a separate blue-bordered input+"Log" button living ABOVE the real
// weight/reps/RIR row) is gone; a small icon-only mic button now sits IN that real row (see
// openLogSheet above). Nothing about the parsing changes -- parseQuickLog below is untouched,
// and a spoken/dictated phrase still only ever fills the real weight/reps/RIR/type fields, never
// logs anything on its own -- so this is purely: same brain, smaller, less competitive body. The
// separate "Log" checkmark button is gone too; it only ever called addLogSet() after a parse, and
// the real "+ Add" button right there already does exactly that once the fields are filled.
function qlApplyParse(raw){
  const p = parseQuickLog(raw);
  // conflicting unit -> fill NOTHING (see the block comment above); everything else fills only
  // the parts actually said, leaving already-typed boxes alone
  if(p && !(p.unit && p.unit !== myUnit())){
    if(p.weight!==null){ const w=document.getElementById('logW'); if(w){ w.value=p.weight; if(typeof updateLoadHint==='function') updateLoadHint(); } }
    if(p.reps!==null){ const el=document.getElementById('logR'); if(el) el.value=p.reps; }
    // RIR now starts hidden behind the "RIR" toggle (v259) -- filling the field without also
    // revealing it would silently set an RIR value the user can never see or verify on screen.
    if(p.rir!==null){ const el=document.getElementById('logRir'); if(el){ el.value=p.rir; el.classList.remove('hidden'); const btn=document.getElementById('logRirToggle'); if(btn) btn.classList.add('hidden'); } }
    if(p.setType!==null) logSetType(p.setType);
  }
}
// The worked example now lives in the small note line under the row instead of inside a fake
// input's placeholder (Jeff, Aug 29: "the section with the mic should give an example of how to
// say the logging") -- still a different one each time the sheet opens, same passive teaching,
// just no longer pretending to be a text box. v246 (Jeff): every example NAMES its set type, so
// saying the type out loud is taught the same passive way as everything else. Each quoted phrase
// must actually parse -- the test suite extracts this list and runs every one through
// parseQuickLog.
const QL_EXAMPLES = [
  'Say &ldquo;Normal, 135 for 8, 2 RIR&rdquo;',
  'Say &ldquo;Normal, 45 lbs at 8 reps&rdquo;',
  'Say &ldquo;Warm up, 95 for 12&rdquo;',
  'Say &ldquo;Drop set, 90 for 12&rdquo;',
  'Say &ldquo;Failure, 185 for 9&rdquo;',
];
function qlExample(){ return QL_EXAMPLES[Math.floor(Math.random()*QL_EXAMPLES.length)]; }
// v244: press-and-hold the mic to record IN the app (Jeff: "click and hold the microphone and
// it automatically begins recording"). Walkie-talkie shape: hold = listening, release = done.
// Uses the browser's own speech recognition where it exists (iOS Safari 14.5+); where it
// doesn't (v257: with the standalone text box gone, there is no dictation box to fall back to
// focusing anymore), the press instead focuses the real weight field -- still never a dead
// button, and a lone number is exactly what a device without SpeechRecognition can still dictate
// through its own keyboard's mic into a plain number field. The transcript re-parses as it
// grows, so the fields fill while still talking. Recording state shows in the LIVE gold (that's
// what gold means in this app), never red.
let QL_REC = null;
function qlRecUi(on){
  // the LAST .ql-mic-icon, same reasoning as the old .ql-field lookup this replaces: for ~200ms
  // after closeSheet a dismissed sheet is still in the DOM animating out, and a plain
  // querySelector would style THAT stale one instead of the live one (cold-review catch, v244).
  const btns = document.querySelectorAll('.ql-mic-icon');
  const b = btns.length ? btns[btns.length-1] : null;
  if(b) b.classList.toggle('ql-rec', on);
}
function qlMicDown(ev){
  if(ev && ev.preventDefault) ev.preventDefault();               // no text-select / scroll on hold
  if(QL_REC) return;   // a second finger while already listening must not orphan the first recognition (cold-review catch)
  try{ if(ev && ev.target && ev.target.setPointerCapture && ev.pointerId !== undefined) ev.target.setPointerCapture(ev.pointerId); }catch(e){}
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const w = document.getElementById('logW');
  if(!SR){ if(w) w.focus(); return; }
  try{
    QL_REC = new SR();
    QL_REC.continuous = true;
    QL_REC.interimResults = true;
    QL_REC.onresult = (e)=>{
      let txt = '';
      for(let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      qlApplyParse(txt);
    };
    QL_REC.onend = ()=>{ QL_REC = null; qlRecUi(false); };
    QL_REC.onerror = ()=>{ QL_REC = null; qlRecUi(false); if(w) w.focus(); };  // mic denied/unavailable -> keyboard path
    QL_REC.start();
    qlRecUi(true);
  }catch(err){ QL_REC = null; qlRecUi(false); if(w) w.focus(); }
}
function qlMicUp(){
  if(QL_REC){ try{ QL_REC.stop(); }catch(e){} }
  qlRecUi(false);
}
function renderLogSets(s, justLoggedId){
  // Jeff, Sep 1: "when I edit a set...it goes back to just the log page without showing the
  // other sets." Root cause: saveLogSet/delLogSetConfirmed call closeAllSheets() then immediately
  // openLogSheet() -- but closeAllSheets() only strips the .show class synchronously; the actual
  // DOM removal of the old sheet(s) is deferred 200ms (for the close transition, see its own
  // comment). openLogSheet's freshly-appended sheet has its OWN #logSetList, so for that 200ms
  // window TWO elements share id="logSetList" -- the dying old one (still first in document
  // order, still holding the pre-edit rows) and the new visible one (empty). A plain
  // document.getElementById('logSetList') always resolves to the OLD one, so this function wrote
  // the freshly-fetched sets into an element that was about to be deleted -- the sheet on screen
  // never got populated. Scoping the lookup to LOGVIEW.sheetEl (the exact sheet this call is
  // meant to fill, always stamped right before every renderLogSets call site) sidesteps the id
  // collision instead of touching closeAllSheets' close-transition timing.
  const list=(LOGVIEW&&LOGVIEW.sheetEl)?LOGVIEW.sheetEl.querySelector('#logSetList'):document.getElementById('logSetList');
  if(!list) return;
  const mine=(s.logs&&s.logs[ME.id])||[];
  const exLogs=mine.filter(l=>l.exerciseId===LOGVIEW.exId).sort((a,b)=>(a.set||0)-(b.set||0));
  if(!exLogs.length){ list.innerHTML='<div class="muted" style="padding:10px 2px">No sets logged yet.</div>'; return; }
  // Prefer the loadType stamped on the set when it was logged; fall back to the exercise's
  // current tag only for sets predating the stamp. Re-tagging an exercise must not change
  // how sets already logged under the old meaning are displayed.
  const fallback = (LOGVIEW && LOGVIEW.loadType) || '';
  const suffixFor = l => { const t = l.loadType || fallback;
    return t==='pair' ? ' each' : t==='added' ? ' added' : ''; };
  // RIR (task #62) is optional per set - only shown when actually tracked, never a fabricated
  // "RIR 0" for sets logged before this existed or where it was just left blank.
  const rirFor = l => (l.rir!==undefined && l.rir!==null) ? ` · RIR ${l.rir}` : '';
  list.innerHTML = exLogs.map(l=>`<div class="set-row" onclick="editLogSet('${l.id}')">
      <div class="set-n">${l.set||'·'}</div>
      <div class="set-vals"><b>${Number(l.weight)||0} ${unitOf(l)}${suffixFor(l)}</b> · <span class="sub">${Number(l.reps)||0} reps${rirFor(l)}</span></div>
      <span class="type-tag ${TYPE_CLASS[l.setType]||'t-normal'}">${TYPE_LABEL[l.setType]||'Normal'}</span>
      ${l.isPr?`<span class="type-tag type-tag-pr${l.id===justLoggedId?' pr-pop':''}">PR</span>`:''}
    </div>`).join('');
}
// v253 (audit finding): the single most-tapped action in the whole app — logging a set — had no
// double-tap guard at all, unlike everywhere else this exact class of bug has already been found
// and fixed (confirmSheet's stacking guard, applyCrop's _crop.done, the approve/reject status
// guards). A fast double-tap (easy mid-workout, especially chasing a PR) fired two overlapping
// POSTs and logged the same set twice. Same shape as applyCrop's guard: block re-entry for the
// duration of the network round-trip, release it whether the save succeeded or failed.
let ADDLOG_BUSY = false;
async function addLogSet(){
  if(ADDLOG_BUSY) return;
  const w=document.getElementById('logW').value, r=document.getElementById('logR').value;
  const rirEl=document.getElementById('logRir'), rir=rirEl?rirEl.value:'';
  // reps are required — a set with a weight and no reps used to save as reps:0, which then
  // read as a failed set. Weight may legitimately be blank/0 for bodyweight movements. RIR is
  // optional (task #62) - blank just means it was not tracked for this set.
  if(!(Number(r) > 0)){ alert('How many reps did you do?'); return; }
  const seg=document.getElementById('logTypeSeg');
  const type=(seg&&seg.querySelector('.chip.on'))?seg.querySelector('.chip.on').getAttribute('data-t'):'normal';
  ADDLOG_BUSY = true;
  try {
    const s=await H.post(`/api/sessions/${LOGVIEW.sid}/log`,{exerciseId:LOGVIEW.exId,weight:w,reps:r,setType:type,rir});
    // Leave what was typed in the boxes if it did not save. They were cleared unconditionally, so
    // a failed request threw the set away and you had to remember it and type it again.
    if(s.error){ alert(s.error); return; }
    // v235: the PR chip pops in ONLY on the set that was just logged - a re-render must not
    // replay the animation on every old PR in the list. Newest `at` among my sets = this one.
    const justMine = ((s.logs&&s.logs[ME.id])||[]).filter(l=>l.exerciseId===LOGVIEW.exId);
    const newest = justMine.slice().sort((a,b)=>String(b.at).localeCompare(String(a.at)))[0];
    LOGVIEW.sid && renderLogSets(s, newest && newest.isPr ? newest.id : null);
    // Jeff, Aug 30: "how do we think we can make this more convenient" -- weight and reps used to
    // clear to blank after every set, so three straight sets of the same weight meant retyping
    // the same numbers three times. Straight sets (same weight, same reps) are the overwhelmingly
    // common case, so the boxes now carry the just-logged weight/reps forward instead -- still one
    // tap to change if the next set is different, but nothing to retype if it isn't. RIR is
    // deliberately NOT carried over: it is a per-set read on how much was left in the tank, and a
    // stale leftover number here would misrecord effort on a set it was never actually true for
    // (e.g. 2 RIR on set 1, all-out on set 3) — silently wrong is worse than asking again.
    document.getElementById('logW').value=w; document.getElementById('logR').value=r;
    // RIR collapses back behind its toggle too, not just blanks -- same "ask again" reasoning as
    // clearing the value itself: leaving it open and empty after a set that didn't have one typed
    // still invites a leftover glance/assumption it applies to the next set. Both jobs, one line.
    if(rirEl){ rirEl.value=''; rirEl.classList.add('hidden'); const rirBtn=document.getElementById('logRirToggle'); if(rirBtn) rirBtn.classList.remove('hidden'); }
    // Live feedback instead of a one-time prediction — see refreshLogRec's own comment. Fire-and-
    // forget: the sets list above has already updated and must not wait on this.
    refreshLogRec();
    startRest();
    // Update the "✓ N sets logged" badge on the workout page behind this sheet right now, instead
    // of only the next time it's opened. Fire-and-forget on purpose — the sheet above has already
    // been updated and must not wait on this.
    if(LOGVIEW.sid) openSession(LOGVIEW.sid, {silent:true});
  } finally {
    ADDLOG_BUSY = false;
  }
}
async function editLogSet(logId){
  const s=await H.get('/api/sessions/'+LOGVIEW.sid);
  const mine=(s.logs&&s.logs[ME.id])||[];
  const l=mine.find(x=>x.id===logId); if(!l) return;
  history.pushState({t:'sheet'}, '', location.href); // v254: Back dismisses this sheet -- see openSheetHtml's comment
  const sheet=document.createElement('div'); sheet.className='sheet-back';
  sheet.innerHTML=`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Edit set</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="ex-sub">Set ${l.set||''}</div>
      <label class="muted" style="font-size:12px">Weight (${unitOf(l)}${(LOGVIEW&&LOGVIEW.loadType==='pair')?', each hand':(LOGVIEW&&LOGVIEW.loadType==='added')?' added':''})</label>
      <input id="edW" type="number" inputmode="decimal" step="any" value="${l.weight}">
      <label class="muted" style="font-size:12px">Reps</label>
      <input id="edR" type="number" inputmode="tel" pattern="[0-9]*" value="${l.reps}">
      <label class="muted" style="font-size:12px">RIR (optional)</label>
      <input id="edRir" type="number" inputmode="tel" pattern="[0-9]*" value="${(l.rir!==undefined&&l.rir!==null)?l.rir:''}">
      <label class="muted" style="font-size:12px">Type</label>
      <select id="edT">${SET_TYPES.map(t=>`<option value="${t.key}"${t.key===l.setType?' selected':''}>${t.label}</option>`).join('')}</select>
      <button class="blue" onclick="saveLogSet('${logId}')">Save</button>
      <button class="red" style="margin-top:8px" onclick="delLogSet('${logId}')">Delete set</button>
    </div>`;
  sheet.onclick=(ev)=>{ if(ev.target===sheet) closeSheet(); };
  document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
}
async function saveLogSet(logId){
  const w=document.getElementById('edW').value, r=document.getElementById('edR').value, t=document.getElementById('edT').value;
  const rirEl=document.getElementById('edRir'), rir=rirEl?rirEl.value:'';
  const s=await H.put(`/api/sessions/${LOGVIEW.sid}/log/${logId}`,{weight:w,reps:r,setType:t,rir});
  if(s.error){ alert(s.error); return; }
  const sid = LOGVIEW.sid;
  // closeAllSheets, not closeSheet — this can be stacked on top of the log sheet it opened from
  // (editLogSet), and both are about to be replaced by the fresh one below.
  closeAllSheets(); openLogSheet(LOGVIEW.sid, LOGVIEW.exId);
  if(sid) openSession(sid, {silent:true});
}
async function delLogSet(logId){
  confirmSheet('Delete set?', "The set comes off this workout — there's no undo.", 'Delete set', () => delLogSetConfirmed(logId));
}
async function delLogSetConfirmed(logId){
  const s=await H.delete(`/api/sessions/${LOGVIEW.sid}/log/${logId}`);
  if(s.error){ alert(s.error); return; }
  const sid = LOGVIEW.sid;
  // closeAllSheets, not closeSheet — same reasoning as saveLogSet above.
  closeAllSheets(); openLogSheet(LOGVIEW.sid, LOGVIEW.exId);
  if(sid) openSession(sid, {silent:true});
}
let REST_TIMER=null;
function startRest(){
  const box=document.getElementById('logRest'); if(!box) return;
  let sec=60; box.innerHTML=`<div class="rest"><span>Rest</span><b id="restN">1:00</b><span>· tap to dismiss</span></div>`;
  box.querySelector('.rest').onclick=()=>{ clearInterval(REST_TIMER); box.innerHTML=''; };
  clearInterval(REST_TIMER);
  REST_TIMER=setInterval(()=>{ sec--; const el=document.getElementById('restN'); if(el) el.textContent=`${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; if(sec<=0){ clearInterval(REST_TIMER); box.innerHTML=''; } },1000);
}
// Jeff, Aug 30: "I accidentally logged my work[out]... should we put an 'are you sure' style
// button when logging instead of reactivating." Log & Finish used to fire lock() on a single tap
// with no way back short of reactivateWorkout() (viewPost's ⋯ menu, added the same day) -- this is
// the preventive fix at the source, so the mistake mostly stops happening in the first place;
// Reactivate stays as the safety net for a tap that already happened (or for wanting to add one
// more set after finishing). danger:false -- this isn't a destructive action like Delete/Discard,
// just the one that was too easy to trigger by accident.
function confirmLogFinish(id){
  confirmSheet('Log & finish this workout?', "This locks in today's credit toward your streak and weekly volume. You can Reactivate it afterward from the ⋯ menu if you tapped by mistake or want to add more.", 'Log & Finish', () => lock(id), false);
}
async function lock(id){ await H.post(`/api/sessions/${id}/lock`,{localDate:localDateStr()}); showSavePage(id); }

// The LAST screen of finishing a workout: Log & Finish -> save page (notes, photo, visibility)
// -> here. Seen once, then gone. Jeff's call: this is a moment, not a record — the permanent copy
// is already saved to the profile by the time this renders, so this screen is purely terminal and
// nothing on it is the only place anything exists. It therefore also carries what is only true
// RIGHT NOW ("Next time"), which must never appear on the saved copy.
// fmtDate() carries a time, which reads as nonsense on a recap ("Aug 15, 12:00 AM"). The day is
// the only part that means anything here.
function rcDay(v){
  const raw = String(v||'').slice(0,10);
  const d = new Date(raw + 'T12:00:00');            // midday, so a timezone cannot shift the date
  return isNaN(d) ? raw : d.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
}
async function showRecap(id){
  const s = await H.get('/api/sessions/'+id);
  if(!s || s.error){ showSavePage(id); return; }          // never strand someone on an error
  const lib = await libByName();
  const mine = (s.logs && s.logs[ME.id]) || [];
  const U = myUnit();
  const nameFor = e => {
    const v = s.variations && s.variations[e.id] && s.variations[e.id][ME.id];
    return (v && v.swapTo) || e.name;
  };
  const isWorking = l => !l.setType || l.setType==='normal' || l.setType==='failure';

  const LB_PER_KG = 2.2046226218;
  const toUser = (w,from) => { const lb = (Number(w)||0) * (from==='kg' ? LB_PER_KG : 1);
                               return U==='kg' ? lb/LB_PER_KG : lb; };
  let sets=0, vol=0, anyBW=false, anyPair=false, anyAdded=false, anySingle=false;
  const prs=[];
  const rows=(s.exercises||[]).map(e=>{
    const nm = nameFor(e);
    const logged = mine.filter(l=>l.exerciseId===e.id)
                       .sort((a,b)=>(Number(a.set)||0)-(Number(b.set)||0));
    const lo0 = Number(e.defaultReps)||0, hi0 = Number(e.defaultRepsMax)||0;
    const ceiling = (hi0 && hi0>=lo0) ? hi0 : lo0;      // same lo/hi clamp the server applies
    const lt = lib[nm] && lib[nm].loadType;
    const pair = lt==='pair';
    // The heaviest working set is the one the progression rule judges, so it is the only one
    // that can be green. Greening every set at or above the range would light up back-off sets
    // and contradict the "Next time" block two cards below.
    let top=null;
    for(const l of logged){
      if(!isWorking(l)) continue;
      sets++;
      const w=toUser(l.weight, unitOf(l)), r=Number(l.reps)||0;
      if(w>0){ vol += w*r*(pair?2:1); if(pair) anyPair=true; if(lt==='added') anyAdded=true; if(lt==='single') anySingle=true; }
      else anyBW=true;
      if(!top || w>toUser(top.weight,unitOf(top)) || (w===toUser(top.weight,unitOf(top)) && r>(Number(top.reps)||0))) top=l;
      if(l.isPr) prs.push(`${esc(nm)} — ${Number(l.weight)>0?Number(l.weight)+' '+unitOf(l):'bodyweight'} × ${r}`);
    }
    return {nm, logged, ceiling, top, range:repLabel(e), work:logged.filter(isWorking).length};
  }).filter(r=>r.work);

  // "Next time" is about where you are NOW, which is exactly why it belongs here and NOT on the
  // saved copy — on a workout from three months ago it would name a weight you passed long ago.
  let next=[], streakW=0;
  try{
    // weeks=26, not 4: streakWeeks is computed inside the requested window and would cap at 4
    // (same lesson as the Home header). `ready` is window-independent.
    const p = await H.get('/api/progress?weeks=26');
    const names = new Set(rows.map(r=>r.nm));
    next = ((p && p.ready) || []).filter(x=>names.has(x.exercise));
    streakW = (p && p.streakWeeks) || 0;
  }catch(e){}

  // Finishing a workout you did not personally log is a real case (logged on paper, or only the
  // other participant logged). "Nice work" over three zeros and an empty card is a lie.
  if(!rows.length || !sets){ showTab('home'); return; }
  const fmt = n => Math.round(n).toLocaleString('en-US');
  // v235 celebration: the recap OPENS like a win - a check that draws itself, then each block
  // rises in sequence (pure CSS, one-shot, disabled under prefers-reduced-motion). The streak
  // line only appears when a real streak exists - never a claim we can't stand behind.
  let h = `<div class="wrap rc-wrap">
    <svg class="rc-check" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="26"/><path d="M17 29.5l7.5 7.5L39 21"/></svg>
    <div class="rc-h1">Nice work</div>
    <div class="rc-sub">${esc(s.name||'Workout')} · ${rcDay(s.scheduledAt)}${
      (s.participants||[]).length>1?` · with ${s.participants.length-1} other${s.participants.length>2?'s':''}`:''}</div>
    ${streakW>=2?`<div class="rc-streakline">${flameSvg()}${streakW}-week streak — still going</div>`:''}
    <div class="rc-stats">
      <div class="rc-tile"><div class="rc-n">${rows.length}</div><div class="rc-l">Exercises</div></div>
      <div class="rc-tile"><div class="rc-n">${sets}</div><div class="rc-l">Working sets</div></div>
      <div class="rc-tile"><div class="rc-n">${fmt(vol)}<small>${U}</small></div><div class="rc-l">Volume</div></div>
    </div>`;
  if(prs.length) h += `<div class="rc-pr"><div class="rc-pr-ic">★</div><div>
      <div class="rc-pr-t">${prs.length} personal record${prs.length>1?'s':''}</div>
      <div class="rc-pr-s">${prs.join('<br>')}</div></div></div>`;

  h += `<h2>What you did</h2><div class="card">`;
  for(const r of rows){
    h += `<div class="rc-ex"><div class="rc-ex-top">
        <div class="rc-ex-n">${esc(r.nm)}</div>
        <div class="rc-ex-best">${r.range} rep target</div></div>
      <div class="rc-chips">${r.logged.map(l=>{
        const w=Number(l.weight)||0, rp=Number(l.reps)||0;
        const warm = l.setType==='warmup', drop = l.setType==='drop';
        // Green means HIT THE TOP OF THE RANGE — the thing that earns more weight. It must not
        // mean "heaviest": a heavy set that fell short of its reps is not a set to celebrate.
        // the target as it was AT LOG TIME; the session's current range is only a fallback
        const cap = Number(l.targetRepsMax) || Number(l.targetReps) || r.ceiling;
        const hit = l===r.top && cap && rp >= cap;
        // v236 (Jeff): the PR set's chip is FILLED green - it outranks 'top' (a PR that hit
        // the range would otherwise show only the tint) and never applies to warm-ups/drops,
        // which cannot be PRs anyway.
        const cls = l.isPr ? ' prfill' : (warm||drop ? ' warm' : (hit ? ' top' : ''));
        const tag = warm ? 'warm-up · ' : drop ? 'drop · ' : '';
        return `<span class="rc-chip${cls}">${tag}${w>0?`${w} ${unitOf(l)} × ${rp}`:`${rp} reps`}${l.isPr?'<span class="star">★</span>':''}</span>`;
      }).join('')}</div></div>`;
  }
  if(anyBW || anyPair || anyAdded || anySingle) h += `<div class="rc-note">${[
      anyBW?"Bodyweight sets aren't counted in volume.":'',
      anyPair?'Two-dumbbell sets count both hands.':'',
      anySingle?'Single-implement lifts count the one weight.':'',
      anyAdded?'Weighted bodyweight lifts count the added weight only.':''].filter(Boolean).join(' ')}</div>`;
  h += `</div>`;

  if(next.length){
    h += `<h2>Next time</h2><div class="card">`;
    for(const n of next){
      h += `<div class="rc-next"><div class="rc-next-ic">↑</div>
        <div class="rc-next-m"><div class="rc-next-n">${esc(n.exercise)}</div>
          <div class="rc-next-w">${n.targetRepsMax} reps at ${n.weight>0?n.weight+' '+n.unit:'bodyweight'}, two sessions running</div></div>
        <div class="rc-next-to">${n.bodyweight?`+${n.step} ${n.unit}`:`${n.suggested} ${n.unit}`}</div></div>`;
    }
    h += `</div>`;
  }
  h += `<div class="rc-cta"><button class="rc-prim" onclick="showTab('home')">Done</button></div></div>`;
  $('app').innerHTML = h;
  window.scrollTo(0,0);
}
async function showSavePage(id){
  const s = await H.get('/api/sessions/'+id);
  if(!s || s.error){ alert(s&&s.error?s.error:'Session not found'); return; }
  const exNames = (s.exercises||[]).map(e=>(s.variations&&s.variations[e.id]&&s.variations[e.id][ME.id]?s.variations[e.id][ME.id].swapTo:e.name));
  // v247: this used to slice scheduledAt down to its date-only substring ("2026-08-28") and
  // re-parse THAT, which Date() reads as UTC midnight — then fmtDate rendered it in local time.
  // For anyone west of UTC that is a different calendar day with a fabricated clock time (an
  // evening workout showed as the PREVIOUS day, ~8pm). scheduledAt already carries the real
  // time, exactly like every other screen that shows it (sessTitle/sessSub/fmtWhen never slice
  // it) — passing it straight to fmtDate is both simpler and correct. new Date() never throws on
  // a malformed value (unlike .slice on a bare number, the v138 crash this used to guard), so
  // nothing here needs the String()/slice defense anymore.
  const when = s.scheduledAt ? fmtDate(s.scheduledAt) : '';
  // MY OWN recap-in-progress — each participant posts independently (s.posts, keyed by userId).
  const post = (s.posts && s.posts[ME.id]) || {};
  const vis = post.visibility || 'only_me';
  const visHint = vis==='only_me'?'Only you can see this on your profile.' : vis==='friends'?'Friends can see this on your profile.' : 'Anyone can see this on your profile.';
  const media = Array.isArray(post.media) ? post.media : [];
  $('app').innerHTML = `<div class="wrap save-page">
    <h1>Save workout</h1>
    <p class="sub">${esc(s.name||'Workout')} · ${when} · ${plur((s.exercises||[]).length,'exercise')}</p>
    <div class="sess-card">
      <b>${esc(s.name||'Workout')}</b>
      <div class="tag">${esc(exNames.join(' · '))}</div>
    </div>
    <h2>Notes</h2>
    <div class="card"><textarea id="saveNotes" placeholder="How'd it go?">${esc(post.notes||'')}</textarea></div>
    <h2>Photo / video</h2>
    <div class="card center-v">
      <div class="media-line">
        <label class="add-media" title="Add photos or video">
          <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>
          <span class="am-plus"></span>
          <input id="mediaInput" type="file" accept="image/*,video/*" multiple style="display:none" onchange="addWorkoutMedia(this)">
        </label>
        <span class="ml-text">Add a photo / video</span>
      </div>
      <div class="thumbs" id="thumbs"></div>
      <div class="tab-note" id="tabNote" style="display:${media.length?'block':'none'}">Shown in your workout tab</div>
    </div>
    <h2>Visibility</h2>
    <div class="card">
      <div class="seg" id="vis">
        <button class="${vis==='only_me'?'on':''}" onclick="setSaveVis(this,'only_me')">Only me</button>
        <button class="${vis==='friends'?'on':''}" onclick="setSaveVis(this,'friends')">Friends</button>
        <button class="${vis==='public'?'on':''}" onclick="setSaveVis(this,'public')">Public</button>
      </div>
      <div class="fineprint" id="visHint">${visHint}</div>
    </div>
    <button class="btn-primary" onclick="saveWorkout('${id}')">Save</button>
    <a class="linkbtn" style="display:block;text-align:center;margin-top:10px" onclick="editSession('${id}')">Edit workout details</a>
  </div>`;
  window.scrollTo(0,0);
  window.__saveMedia = media.map(m=>({ type:m.type, src:m.src }));
  window.__saveVis = vis;
  // render existing media as thumbnails
  const t=document.getElementById('thumbs');
  window.__saveMedia.forEach(m=>{
    const d=document.createElement('div'); d.className='thumb';
    if(m.type==='image'){ const el=document.createElement('img'); el.src=m.src; d.appendChild(el); }
    else { const el=document.createElement('video'); el.src=m.src; el.muted=true; d.appendChild(el); }
    const x=document.createElement('span'); x.className='x'; x.textContent='✕'; x.onclick=()=>{ d.remove(); const i=window.__saveMedia.indexOf(m); if(i>-1) window.__saveMedia.splice(i,1); if(!t.children.length) document.getElementById('tabNote').style.display='none'; }; d.appendChild(x);
    t.appendChild(d);
  });
}
function setSaveVis(btn,v){ window.__saveVis=v; document.querySelectorAll('#vis button').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
  document.getElementById('visHint').textContent = v==='only_me'?'Only you can see this on your profile.' : v==='friends'?'Friends can see this on your profile.' : 'Anyone can see this on your profile.'; }
function addWorkoutMedia(input){
  const t=document.getElementById('thumbs'); if(!t) return;
  const MAX=4;
  for(const file of input.files){
    if(window.__saveMedia.length>=MAX){ alert('You can add up to 4 photos or videos.'); break; }
    const isImg=file.type.startsWith('image/');
    const type=isImg?'image':'video';
    if(type==='video' && window.__saveMedia.some(m=>m.type==='video')){ alert('Only one video is allowed.'); continue; }
    const d=document.createElement('div'); d.className='thumb';
    const reader=new FileReader();
    reader.onload=()=>{ const dataUrl=reader.result;
      const el=document.createElement(type==='image'?'img':'video');
      if(type==='video') el.muted=true; el.src=dataUrl; d.appendChild(el);
      const media={ type, src:dataUrl };
      window.__saveMedia.push(media);
      const x=document.createElement('span'); x.className='x'; x.textContent='✕';
      x.onclick=()=>{ const i=window.__saveMedia.indexOf(media); if(i>-1) window.__saveMedia.splice(i,1); d.remove(); markDirty(); refreshAddBtn(); };
      d.appendChild(x);
      refreshAddBtn();
      const tn=document.getElementById('tabNote'); if(tn && t.children.length) tn.style.display='block';
    };
    reader.readAsDataURL(file);
    t.appendChild(d);
  }
  input.value='';
}
function refreshAddBtn(){
  const btn=document.getElementById('addMediaBtn');
  if(btn) btn.style.display = (window.__saveMedia.length>=4)?'none':'flex';
}
async function saveWorkout(id){
  const notes=document.getElementById('saveNotes').value;
  const epoch=UI_EPOCH;
  const r=await H.post(`/api/sessions/${id}/post`,{ notes, media: window.__saveMedia||[], visibility: window.__saveVis||'only_me' });
  if(r && r.error){ alert(r.error); return; }
  // v252 (audit finding): showRecap used to fire unconditionally after the await, same barge-in
  // shape as the rest of this cluster.
  if(nothingNavigatedSince(epoch)) showRecap(id);          // the recap is the LAST thing, after saving — notes and photos are done
}
async function deleteSession(id, alreadyFinished){
  confirmSheet('Delete workout?', "This removes the workout for everyone in it — not just you. There's no undo.", 'Delete workout', () => deleteSessionConfirmed(id, alreadyFinished));
}
async function deleteSessionConfirmed(id, alreadyFinished){
  const epoch=UI_EPOCH;
  const r = await H.delete(`/api/sessions/${id}`);
  // Someone else has real credit tied to this workout (current or a departed partner's history),
  // so deleting would erase their training record too. Offer to take yourself out instead — the
  // same shape as declining an invite, which removes only you.
  // v187 (Jeff, Aug 20, cold-review catch): this used to post an empty {} body straight to
  // /leave, which — now that /leave has a real keep/discard choice — would silently default to
  // NOT keeping your own credit, even if you'd already logged real sets today you never meant to
  // throw away. Routes through the exact same Save/Discard sheet the Leave button uses instead of
  // guessing on your behalf.
  // v252 (audit finding): both branches used to act unconditionally after the delete resolved --
  // navigating away mid-delete could pop the Leave-workout choice sheet on top of whatever the
  // user had moved on to, or send them home from a screen they weren't on. The delete itself
  // already happened either way; only what happens next is gated.
  if(r && r.canLeave){ if(nothingNavigatedSince(epoch)) return leaveWorkout(id, alreadyFinished); return; }
  else if(r && r.error){ alert(r.error); return; }
  else if(nothingNavigatedSince(epoch)) home();
}
// v187 (Leave Workout redesign), Jeff Aug 19-20. Two doors lead here: the Leave button (any
// non-creator participant) and Delete's canLeave fallback above (creator, when someone else's
// credit blocks a real delete). If you've already finished your own portion, there is nothing left
// to choose — your credit is already locked in either way (creditFinish is idempotent) — so this
// skips straight to leaving instead of asking a question with only one real answer.
function leaveWorkout(id, alreadyFinished){
  if(alreadyFinished){ return leaveWorkoutConfirmed(id, true); }
  const inner = `<div class="sheet"><div class="sheet-head"><h2>Leave workout</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
    <div class="muted" style="padding:0 2px 14px">You have sets logged here today that you haven't finished yet.</div>
    <div class="sheet-list">
      <button class="sheet-row" onclick="leaveWorkoutConfirmed('${id}', true)">Save today's sets</button>
      <button class="sheet-row red" onclick="leaveWorkoutConfirmed('${id}', false)">Discard today's sets</button>
    </div>
  </div>`;
  openSheetHtml(inner);
}
async function leaveWorkoutConfirmed(id, keep){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/leave`, {keep, localDate:localDateStr()});
  if(r && r.error){ alert(r.error); return; }
  // v252 (audit finding): closeSheet()/home() used to fire unconditionally -- closeSheet() acts on
  // whatever sheet is topmost right now, not a reference to the one this leave came from, so a
  // stale response could close an unrelated sheet the user had opened since, on top of yanking
  // them home.
  if(nothingNavigatedSince(epoch)){ closeSheet(); home(); }
}
// Jeff, Aug 28: "Once its posted on my page - I want to be able to delete it off my page."
// Deliberately NOT Leave Workout above -- Leave (v187) exists specifically to KEEP your
// history/credit when you step away (see its comment). This is the opposite, explicit ask: erase
// your own post, logged sets, and history credit for this session so it's genuinely gone from your
// profile. Never touches the creator's or any other participant's data. A real confirm() because,
// unlike Leave, there is no "keep credit" option here -- this is meant to actually remove it.
async function removeFromMyProfile(id){
  confirmSheet('Remove from my profile?', 'Your notes, photos, logged sets, and workout credit for this workout will be gone. This cannot be undone.', 'Remove from my profile', () => removeFromMyProfileConfirmed(id));
}
async function removeFromMyProfileConfirmed(id){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/remove-mine`, {});
  if(r && r.error){ alert(r.error); return; }
  // v252 (audit finding): same unconditional-navigation shape as the rest of this cluster.
  if(nothingNavigatedSince(epoch)) showTab('me');
}
// Jeff, Aug 30: "open re-activate a closed logged workout if needed" -- Log & Finish credits
// s.history the instant it's tapped (creditFinish, in /lock), and that credit is otherwise
// permanent by design (see the othersWithCredit comment in server.js -- leaving a workout
// deliberately never clears it). This is the one deliberate exception: you can undo YOUR OWN
// finish-credit -- for an accidental tap (confirmLogFinish above is the preventive fix at the
// source; this is the safety net for a tap that already happened) or just to add more sets before
// really finishing. Scoped narrowly on purpose, via /unlock: it only ever removes your own
// history-credit row, never your logged sets, never your posted recap, never anyone else's
// credit. Once undone, the workout drops off "My Workouts" and reappears in your live Sessions
// with Log & Finish offered again, exactly as if you'd never tapped it.
async function reactivateWorkout(id, authorId){
  confirmSheet('Reactivate this workout?', "This undoes Log & Finish so it moves back to your active Sessions — it won't count toward your streak or weekly volume again until you finish it. Your logged sets and posted recap are untouched.", 'Reactivate workout', () => reactivateWorkoutConfirmed(id, authorId), false);
}
async function reactivateWorkoutConfirmed(id, authorId){
  const epoch=UI_EPOCH;
  const r = await H.post(`/api/sessions/${id}/unlock`, {});
  if(r && r.error){ alert(r.error); return; }
  if(nothingNavigatedSince(epoch)) viewPost(id, authorId, {silent:true});
}

// ===== Inline edit mode for saved (posted) workouts =====
let INLINE_DIRTY = false;
function markDirty(){ INLINE_DIRTY = true; }
// v254: silent -- renderWorkoutEdit is one of the flows deliberately excluded from history
// tracking (see the comment above CURRENT_NAV_STATE), so entering/exiting it must not push its
// own entry or reset scroll; Back from inside it lands wherever was last tracked, same as Cancel.
function enterWorkoutEdit(id){ EDITING_ID = id; openSession(id, {quiet:true}); }
// v251 (cold-review follow-up on the audit's posted-workout-cluster fix): same unguarded
// await-then-navigate shape as sendPostComment/deletePhotoConfirmed/etc. above -- tap Cancel or
// Save changes on an inline workout edit, then navigate away before the request(s) resolve, and
// the stale response used to yank the user back to the recap regardless of where they'd moved on
// to. Guarded the same way with nothingNavigatedSince(). The writes themselves stay unconditional
// in saveWorkoutEditConfirmed below (only the final navigation is gated) -- the user explicitly
// tapped Save, so the edit should still go through even if they've since moved on; only barging
// back onto the old recap afterward is the part that needs to not happen.
async function exitWorkoutEdit(id){
  if(INLINE_DIRTY){ confirmSheet('Discard changes?', 'Your edits to this workout will be lost.', 'Discard changes', () => { INLINE_DIRTY = false; exitWorkoutEdit(id); }); return; }
  EDITING_ID = null;
  const epoch=UI_EPOCH;
  const s = await H.get('/api/sessions/'+id);
  if(!nothingNavigatedSince(epoch)) return;
  // v254: quiet/silent, same reasoning as enterWorkoutEdit() above -- edit mode was never pushed to
  // history, so landing back on the session/post must not push a duplicate entry either. viewPost's
  // opts.silent has no logSheetStillOpenFor-style gate (unlike openSession's), so it's safe as-is;
  // openSession needs opts.quiet specifically -- see openSession's own comment for why.
  if(s && s.posts && s.posts[ME.id]) viewPost(id, ME.id, {silent:true}); else openSession(id, {quiet:true});
}
function renderInlineThumbs(){
  const t = document.getElementById('thumbs'); if(!t) return; t.innerHTML='';
  (window.__saveMedia||[]).forEach(m=>{
    const d=document.createElement('div'); d.className='thumb';
    if(m.type==='image'){ const el=document.createElement('img'); el.src=m.src; d.appendChild(el); }
    else { const el=document.createElement('video'); el.src=m.src; el.muted=true; d.appendChild(el); }
    const x=document.createElement('span'); x.className='x'; x.textContent='✕';
    x.onclick=()=>{ const i=window.__saveMedia.indexOf(m); if(i>-1) window.__saveMedia.splice(i,1); d.remove(); markDirty(); refreshAddBtn(); };
    d.appendChild(x); t.appendChild(d);
  });
  refreshAddBtn();
}
// Jeff, Aug 30: "I also want to be able to edit the name of the workouts after logged also" --
// PUT /api/sessions/:id already accepted a `name` field (saveWorkoutEditConfirmed's payload just
// echoed the unchanged fetched name back), so this only needed a client-side field: an editable
// #editWName input in place of the previous static title, threaded through saveWorkoutEdit/
// saveWorkoutEditConfirmed below the same way exercises/notes already were.
function renderWorkoutEdit(s){
  INLINE_DIRTY=false;
  // Reached only by the creator editing their OWN already-posted recap (see openSession's
  // EDITING_ID gate above) — each participant posts independently now (s.posts, keyed by userId).
  const myPost = s.posts && s.posts[ME.id];
  const vis = (myPost && myPost.visibility) || 'only_me';
  window.__saveVis = vis;
  const media = (myPost && Array.isArray(myPost.media)) ? myPost.media : [];
  window.__saveMedia = media.map(m=>({ type:m.type, src:m.src }));
  const exRows = s.exercises.map(e=>`
    <div class="card inex-row" data-ex="${e.id}">
      <div class="inex-top"><input class="inex-name" id="inex-name-${e.id}" value="${esc(e.name)}" oninput="markDirty()">
        <button class="sec sm red" onclick="removeInex('${e.id}')">Remove</button></div>
      <div class="inex-meta"><label class="muted">Sets</label><input class="inex-num" id="inex-sets-${e.id}" type="number" min="1" value="${e.defaultSets}" oninput="markDirty()">
        <label class="muted">Reps</label><input class="inex-num" id="inex-reps-${e.id}" type="number" min="1" value="${e.defaultReps}" oninput="markDirty()">
        <span class="muted">to</span><input class="inex-num" id="inex-repsmax-${e.id}" type="number" min="1" placeholder="—" value="${e.defaultRepsMax||''}" oninput="markDirty()"></div>
    </div>`).join('');
  $('app').innerHTML = `<div class="wrap edit-mode">
    <!-- Jeff, Sep 1: "add a save button on the top right when editing a workout. Scrolling to
         the bottom is annoying and everyone is use to having a save button on the top right of
         things." This banner was already position:sticky (top:0) -- it rides along at the top of
         the screen the whole time you're editing, so putting Save here means it's reachable with
         zero scrolling no matter how far down the exercise list you are. class="sm blue": the
         plain button.blue + button.sm rules (a solid filled pill, themed in both light/dark --
         see their own rules in the stylesheet) -- the same "this is THE action, not a suggestion"
         treatment .sess-actions .sm.blue uses elsewhere (see that rule's own comment) for the
         identical reason, just without that class's own .sess-actions-scoped selector, which
         doesn't apply to a button sitting inside .edit-banner. Reused styling, not a new button
         look. The bottom sticky-bar's own Cancel/Save changes pair is untouched -- this adds a
         second way to reach Save, it doesn't replace the first. -->
    <div class="edit-banner"><span>✎ Editing</span><button class="sm blue" onclick="saveWorkoutEdit('${s.id}')">Save</button></div>
    <label class="muted">Workout name</label><input id="editWName" placeholder="e.g. Chest & Back" value="${esc(s.name||'')}" oninput="markDirty()">
    <div class="muted sess-meta">${fmtWhen(s.scheduledAt)}</div>
    <h2>Workout</h2>
    <div id="inexList">${exRows}</div>
    <button class="sec" onclick="addInex()">+ Add exercise</button>
    <h2>Photos</h2>
    <div class="card center-v">
      <div class="media-line">
        <label class="add-media" id="addMediaBtn" title="Add photos or video">
          <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>
          <span class="am-plus"></span>
          <input id="mediaInput" type="file" accept="image/*,video/*" multiple style="display:none" onchange="addWorkoutMedia(this)">
        </label>
        <div class="thumbs" id="thumbs"></div>
      </div>
    </div>
    <h2>Notes</h2>
    <textarea id="saveNotes" placeholder="How'd it go?">${esc((myPost&&myPost.notes)||'')}</textarea>
    <h2>Visibility</h2>
    <div class="card">
      <div class="seg" id="vis">
        <button class="${vis==='only_me'?'on':''}" onclick="setSaveVis(this,'only_me')">Only me</button>
        <button class="${vis==='friends'?'on':''}" onclick="setSaveVis(this,'friends')">Friends</button>
        <button class="${vis==='public'?'on':''}" onclick="setSaveVis(this,'public')">Public</button>
      </div>
      <div class="fineprint" id="visHint">${vis==='only_me'?'Only you can see this on your profile.':vis==='friends'?'Friends can see this on your profile.':'Anyone can see this on your profile.'}</div>
    </div>
    <div class="edit-spacer"></div>
  </div>
  <div class="sticky-bar">
    <button class="sec" onclick="exitWorkoutEdit('${s.id}')">Cancel</button>
    <button class="btn-primary" onclick="saveWorkoutEdit('${s.id}')">Save changes</button>
  </div>`;
  window.scrollTo(0,0);
  renderInlineThumbs();
}
function addInex(){
  const id='ex_'+Date.now()+Math.floor(Math.random()*1000);
  const div=document.createElement('div'); div.className='card inex-row'; div.dataset.ex=id;
  div.innerHTML=`<div class="inex-top"><input class="inex-name" id="inex-name-${id}" placeholder="Exercise name" oninput="markDirty()"><button class="sec sm red" onclick="removeInex('${id}')">Remove</button></div>
    <div class="inex-meta"><label class="muted">Sets</label><input class="inex-num" id="inex-sets-${id}" type="number" min="1" value="3" oninput="markDirty()"><label class="muted">Reps</label><input class="inex-num" id="inex-reps-${id}" type="number" min="1" value="10" oninput="markDirty()"></div>`;
  document.getElementById('inexList').appendChild(div); markDirty();
}
function removeInex(id){ const el=document.querySelector('.inex-row[data-ex="'+id+'"]'); if(el) el.remove(); markDirty(); }
// v252 (audit finding, twice fixed once more): this is the function actually wired to the visible
// "Save changes" button, and had the IDENTICAL bug saveWorkoutEditConfirmed's own H.get already
// got fixed for in v251 -- reading .inex-row/saveNotes AFTER awaiting H.get, so navigating away
// while that fetch was in flight tore down $('app').innerHTML before the read ever happened,
// turning the tap into a wrong "Add at least one exercise" alert on the wrong screen and silently
// dropping the save. Fixed the same way here (read first, await second) -- but reordering this
// function's own read/await isn't sufficient by itself: it then hands off to
// saveWorkoutEditConfirmed, and if that function re-read the DOM itself a second time, the SAME
// race would just reopen one level down, after THIS function's own await. So the exercises/notes
// read here are now passed straight through instead, and saveWorkoutEditConfirmed only falls back
// to reading the DOM itself when called with nothing supplied (which no longer happens from here).
async function saveWorkoutEdit(id){
  const rows=[...document.querySelectorAll('.inex-row')];
  const exercises=rows.map(r=>{ const eid=r.dataset.ex;
    return { id:eid, name:(document.getElementById('inex-name-'+eid)||{}).value||'Exercise',
      defaultSets:Number((document.getElementById('inex-sets-'+eid)||{}).value||3),
      defaultReps:Number((document.getElementById('inex-reps-'+eid)||{}).value||10),
      defaultRepsMax:Number((document.getElementById('inex-repsmax-'+eid)||{}).value)||undefined };
  });
  if(!exercises.length){ alert('Add at least one exercise'); return; }
  const notes=(document.getElementById('saveNotes')||{}).value;
  const name=((document.getElementById('editWName')||{}).value||'').trim();
  const epoch=UI_EPOCH;
  const s = await H.get('/api/sessions/'+id);
  if(!s||s.error){ alert(s&&s.error?s.error:'Session not found'); return; }
  // Friend-set warning: exercises removed (or id changed) that ANY other user logged sets against
  const origIds=(s.exercises||[]).map(e=>e.id);
  const newIds=exercises.map(e=>e.id);
  const removed=origIds.filter(x=>!newIds.includes(x));
  const touched=[];
  for(const rid of removed){
    const ex=(s.exercises||[]).find(e=>e.id===rid);
    const who=Object.keys(s.logs||{}).filter(pid=>pid!==ME.id && (s.logs[pid]||[]).some(l=>l.exerciseId===rid));
    if(who.length) touched.push((ex&&ex.name)||'exercise');
  }
  if(touched.length){
    // The confirm sheet itself is a UI action, not the write -- if the user has already moved on
    // while this fetch was in flight, popping "Save changes?" over whatever they're doing now
    // would be a barge-in with no context, so it's gated the same as any other stale navigation.
    // The write it would lead to hasn't happened yet and still needs the user's explicit tap.
    // v252 cold-review catch: epoch is deliberately NOT passed through into the confirm callback
    // here -- openSheetHtml (which confirmSheet calls) bumps UI_EPOCH itself the instant the sheet
    // opens, same as any other navigation, so reusing this function's own pre-sheet epoch would
    // make saveWorkoutEditConfirmed's final nothingNavigatedSince check compare against a value
    // that's already one behind by the time the sheet even exists -- permanently false, not a race,
    // so "Save anyway" would never reopen the recap even on an instant tap with no real navigation.
    // Every other *Confirmed function fed by a confirmSheet (deleteSessionConfirmed,
    // deletePhotoConfirmed, etc.) captures its own fresh epoch at the moment its confirm button
    // actually fires, for the same reason -- this now matches that.
    if(nothingNavigatedSince(epoch)) confirmSheet('Save changes?', esc(plur(touched.length,'friend')) + ' logged sets on: ' + esc(touched.join(', ')) + '. Saving detaches those sets.', 'Save anyway', () => saveWorkoutEditConfirmed(id, exercises, notes, name));
    return;
  }
  // No conflict to confirm -- this IS the explicit write the user asked for, so it goes through
  // with what was read at the top of this function regardless of anything that's happened since.
  // Returned (not just fired) so this function's own promise reflects the write actually finishing.
  // The ORIGINAL epoch is passed through here too -- see the comment above saveWorkoutEditConfirmed
  // for why letting it capture its own, fresh epoch here would miss navigation that happened during
  // THIS function's own await, above.
  return saveWorkoutEditConfirmed(id, exercises, notes, name, epoch);
}
// the part of saveWorkoutEdit that runs once the detach warning (if any) is accepted.
// exercises/notes/epoch are passed down from saveWorkoutEdit's own synchronous read and epoch
// snapshot, taken the instant Save was tapped (see the comments above saveWorkoutEdit) -- both
// re-reading the DOM and re-capturing UI_EPOCH here independently would miss navigation that
// happened during saveWorkoutEdit's OWN await, before this function was ever called: capturing a
// "fresh" epoch here would already reflect that navigation, making nothingNavigatedSince below
// compare the epoch to itself and always pass, even though the actual Save tap is now stale. Falls
// back to reading the DOM and capturing its own epoch only if called with nothing supplied, so
// nothing else that might call this directly is broken by the change.
async function saveWorkoutEditConfirmed(id, exercisesIn, notesIn, nameIn, epochIn){
  const epoch = (typeof epochIn === 'number') ? epochIn : UI_EPOCH;
  let exercises = exercisesIn, notes = notesIn, name = nameIn;
  if(!exercises){
    const rows=[...document.querySelectorAll('.inex-row')];
    exercises=rows.map(r=>{ const eid=r.dataset.ex;
      return { id:eid, name:(document.getElementById('inex-name-'+eid)||{}).value||'Exercise',
        defaultSets:Number((document.getElementById('inex-sets-'+eid)||{}).value||3),
        defaultReps:Number((document.getElementById('inex-reps-'+eid)||{}).value||10),
        defaultRepsMax:Number((document.getElementById('inex-repsmax-'+eid)||{}).value)||undefined };
    });
    notes=(document.getElementById('saveNotes')||{}).value;
    name=((document.getElementById('editWName')||{}).value||'').trim();
  }
  if(!exercises.length){ alert('Add at least one exercise'); return; }
  const s = await H.get('/api/sessions/'+id);
  if(!s||s.error){ alert(s&&s.error?s.error:'Session not found'); return; }
  // The workout's name, editable here since Aug 30 -- falls back to whatever was already saved
  // (s.name) only when name itself is missing entirely (the untouched-DOM fallback above, or a
  // stray direct call with nothing supplied), never just because it was typed blank -- an
  // intentionally cleared name is a real choice (sessTitle() already falls back to the date when
  // blank) and must actually save as blank, not silently snap back to the old name.
  const r1=await H.put('/api/sessions/'+id,{ name:(typeof name==='string' ? name : s.name), scheduledAt:s.scheduledAt, visibility:s.visibility, exercises, invited:(s.invited||[]), location:s.location, lengthMin:s.lengthMin, creatorNote:s.creatorNote });
  if(r1&&r1.error){ alert(r1.error); return; }
  const r2=await H.post(`/api/sessions/${id}/post`,{ notes, media: window.__saveMedia||[], visibility: window.__saveVis||'only_me' });
  if(r2&&r2.error){ alert(r2.error); return; }
  INLINE_DIRTY=false; EDITING_ID=null;
  // v254: quiet/silent, same reasoning as exitWorkoutEdit() -- edit mode was never pushed to history.
  if(nothingNavigatedSince(epoch)){ if(s.posts && s.posts[ME.id]) viewPost(id, ME.id, {silent:true}); else openSession(id, {quiet:true}); }
}

// ---- Create flow ----
let DRAFT = { exercises:[], inviteUsernames:[] } ;
let EDITING_TPL = null;
let EDITING_ID = null;          // set when a saved workout is in inline edit mode
async function createFlow(){
  DRAFT = DRAFT || { exercises:[], inviteUsernames:[] };
  if(!DRAFT.exercises) DRAFT.exercises=[];
  if(!DRAFT.inviteUsernames) DRAFT.inviteUsernames=[];
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  const friends = await H.get('/api/friends');
  const friendList = (friends && friends.friends) ? friends.friends : (Array.isArray(friends)?friends:[]);
  const invRows = friendList.length ? friendList.map(f=>{
    const ini = (f.displayName||f.username||'?')[0]||'?';
    const av = f.avatar ? `<img class="inv-av" src="${esc(f.avatar)}" alt="">` : `<div class="inv-av" style="background:${avatarColor(f.username)};color:#fff">${esc(ini)}</div>`;
    const on = DRAFT.inviteUsernames.includes(f.username) ? 'checked' : '';
    return `<label class="inv-row"><div class="inv-meta"><div class="inv-av-wrap">${av}</div><div class="inv-text"><div class="name">${esc(f.displayName||f.username)}</div><div class="handle">@${esc(f.username)}</div></div></div><span class="check"><input type="checkbox" value="${esc(f.username)}" ${on} onchange="toggleInvite(this)"><span class="box"><svg class="tick" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8.5l3 3 6-7" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span></label>`;
  }).join('') : '<div class="muted">No friends yet — add some in Friends tab.</div>';
  $('app').innerHTML = `<div class="wrap create-flow"><button class="sec sm" onclick="cancelCreate()">← ${EDITING_SESSION?'Cancel':'Cancel'}</button>
    <h1>${EDITING_SESSION?'Edit workout':'New workout'}</h1>
    <label class="muted">Workout name</label><input id="wname" placeholder="e.g. Chest & Back" value="${esc(DRAFT.name||'')}">
    <label class="muted">When</label><input id="dt" type="datetime-local" value="${esc(DRAFT._dt||'')}">
    <label class="muted">Location</label><input id="loc" placeholder="e.g. Gold's Gym" value="${esc(DRAFT.location||'')}">
    <div class="row"><div><label class="muted">Length (min)</label><input id="len" type="number" inputmode="tel" pattern="[0-9]*" placeholder="60" value="${DRAFT.lengthMin||''}"></div></div>
    <label class="muted">Note to friends</label><input id="note" placeholder="let's hit legs hard" value="${esc(DRAFT.creatorNote||'')}">
    <label class="muted">Visibility</label>
    <!-- selected= matters: without it this box always opened on Private, so saving an edit
         silently made a Friends-only workout private and dropped it out of your friends' reach -->
    <select id="vis">
      <option value="private"${(DRAFT.visibility||'private')==='private'?' selected':''}>Private (invite only)</option>
      <option value="friends"${DRAFT.visibility==='friends'?' selected':''}>Friends-only (joinable)</option>
    </select>
    <h2>Exercises</h2><div id="draftList" class="card"></div>
    <button class="sec" onclick="openAddExercises()">+ Add exercise</button>
    <div class="tpl-actions">
    <button class="sec sm" onclick="templatesPage()">Routines</button>
    <button class="sec sm" onclick="tplQuickSaveSheet()">Save as routine</button>
    </div>
    <h2>Invite friends</h2><div id="invList" class="card">${invRows}</div>
    ${EDITING_SESSION ? '<button class="blue" onclick="submitSession()">Save changes</button>' : '<button class="blue" onclick="submitSession()">Create workout</button>'}</div>`;
  window.scrollTo(0,0);
  renderDraft();
}
// This function was written TWICE, at two places in this file. The second one silently replaced
// the first — and the second could only ever create, so "Save changes" on an edited workout made
// a duplicate and threw the edit away. The two were not identical, so this is a deliberate merge
// rather than "keep the first": the edit branch comes from one, the template offer from the other.
async function submitSession(){
  const dt=$('dt').value; const vis=$('vis').value;
  const location=$('loc').value; const lengthMin=$('len').value; const creatorNote=$('note').value; const name=$('wname').value;
  if(!DRAFT.exercises.length) return alert('Add at least one exercise');
  const scheduledAt = dt? new Date(dt).toISOString() : new Date().toISOString();
  const payload={scheduledAt,visibility:vis,name,exercises:DRAFT.exercises,inviteUsernames:DRAFT.inviteUsernames,location,lengthMin:lengthMin?Number(lengthMin):null,creatorNote};
  const editing = EDITING_SESSION;                 // captured: it is cleared before we navigate
  const epoch=UI_EPOCH;
  const r = editing
    ? await H.put('/api/sessions/'+editing, payload)
    : await H.post('/api/sessions', payload);
  if(r.error) return alert(r.error);
  // MUST be cleared. Nothing cleared it on success before, so the next "+ New workout" would have
  // saved itself over the workout you had just edited.
  EDITING_SESSION = null;
  // Jeff, Aug 27: "do we think we should have a button that pops up every time we create a
  // workout asking us to save as a routine?" -- this used to interrupt every single workout
  // creation with a sheet asking exactly that. Removed: it's a second, naggier path to
  // something already reachable without a popup -- "Save as routine" on this same create form,
  // "Save this routine" on every session's detail page, and now "Routine" in Quick Workout too.
  // An interruption on every save just trains you to reflex-tap past it.
  // v252 (audit finding): home() used to fire unconditionally -- the session was still
  // created/edited either way (that write is above, unconditional), only the navigation is gated.
  if(nothingNavigatedSince(epoch)) home();
}
let EDITING_SESSION = null;
// A NEW workout starts empty. createFlow() cannot do this itself — it is also where you land
// coming back from the exercise picker, and clearing there would throw away what you just added.
// Without this, "+ New workout" opened pre-filled with the last workout you edited.
// v253 (audit finding): TPL_MODE.active/id left true here (leaked in from a template edit backed
// out of, or a routine used mid-create — see tplBack's comment) meant libDone(), reached later via
// this exact flow's own "+ Add exercise", would route back into the ROUTINE editor instead of this
// create-flow, and "Save changes" would silently overwrite that unrelated routine. Belt-and-braces
// alongside the tplBack fix: a brand new workout always starts with TPL_MODE genuinely off.
function newWorkout(){
  // Prefilled from Settings > Default gym, if set — edited or cleared here the same as any other
  // draft field, this is just where its value starts.
  DRAFT = { exercises:[], inviteUsernames:[], location: (ME && ME.defaultGym) || '' };
  EDITING_SESSION = null; EDITING_TPL = null; EDITING_ID = null;
  if(typeof TPL_MODE === 'object' && TPL_MODE) { TPL_MODE.active = false; TPL_MODE.id = null; TPL_MODE.name = ''; TPL_MODE.copy = false; }
  createFlow();
}
function cancelCreate(){ EDITING_SESSION=null; EDITING_TPL=null; home(); }
// Skips the whole create-flow wizard — no name, no schedule picker, no invite step, and (Jeff,
// Aug 25: a tap of the button shouldn't immediately create it) no session on the server either,
// not until you've actually picked something. Tapping "Quick Workout" drops you straight into the
// exercise picker; libDone() below creates the session the moment you tap Done, with whatever you
// picked, and opens it — one tap to start, one tap when you're done, nothing created if you back
// out having picked nothing.
function workoutNow(){
  DRAFT = { exercises:[], inviteUsernames:[], location: (ME && ME.defaultGym) || '' };
  EDITING_SESSION = null; EDITING_TPL = null; EDITING_ID = null;
  // v253: QUICK_ADD_MODE (set below) is checked before TPL_MODE.active in libDone(), so this
  // flow's own "Done" is not actually reachable through the leak newWorkout() above guards
  // against — cleared here anyway so a Quick Workout never starts with stale routine-editor state
  // sitting around, same "walking away clears it" principle as resetTransientModes().
  if(typeof TPL_MODE === 'object' && TPL_MODE) { TPL_MODE.active = false; TPL_MODE.id = null; TPL_MODE.name = ''; TPL_MODE.copy = false; }
  QUICK_ADD_MODE = true;
  openAddExercises();
}
async function createQuickWorkout(name){
  const n = (name||'').trim();
  const r = await H.post('/api/sessions', {
    name: n || 'Quick Workout',
    scheduledAt: new Date().toISOString(),
    visibility: 'private',
    exercises: DRAFT.exercises,
    location: DRAFT.location || '',
  });
  if(r && r.error){ alert(r.error); showTab('home'); return; }
  openSession(r.id);
}
// Jeff, Aug 27: "add the ability to quick select a routine within quick workout" -- Quick Workout
// used to only offer picking exercises one at a time from the library. This lets you skip that
// entirely: pick a saved routine and it starts the workout immediately with that routine's
// exercises, same one-tap-to-start philosophy as workoutNow() itself (see its comment above).
async function quickPickRoutine(){
  const { mine, shared } = await H.get('/api/templates');
  window._TPL = { mine, shared };
  const all = [...mine, ...shared];
  const qRoutineRow = (t)=>`<div class="lib-item"><div style="flex:1;min-width:0"><div style="font-weight:600">${esc(t.name)}</div><div class="muted" style="font-size:12px">${plur(t.exercises.length,'exercise')}</div></div>
    <button class="sec sm" onclick="quickUseRoutine('${t.id}')">Use</button></div>`;
  openSheetHtml(`<div class="sheet"><div class="sheet-head"><h2>Routines</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
    <div class="card" style="margin-top:4px">${all.length ? all.map(qRoutineRow).join('') : '<div class="muted" style="padding:16px 6px">No routines saved yet. Build one from the Workouts tab, then it will show up here.</div>'}</div>
  </div>`);
}
function quickUseRoutine(id){
  const { mine, shared } = window._TPL || { mine:[], shared:[] };
  const t = [...mine, ...shared].find(x=>x.id===id); if(!t) return;
  closeSheet();
  DRAFT.exercises = t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax}));
  QUICK_ADD_MODE = false; LIB_ADDMODE = false;
  // Jeff, Aug 30: "I want to be able to name quick workouts" -- default the naming prompt to the
  // routine's own name (it's usually exactly what you'd type anyway) but still let it be changed
  // or cleared, same as the picked-exercises path in libDone() below.
  promptQuickWorkoutName(t.name);
}
async function editSession(id){
  const s = await H.get('/api/sessions/'+id);
  if(!s || s.error){ alert(s && s.error ? s.error : 'Session not found'); return; }
  if(s.creatorId!==ME.id){ alert('Only the creator can edit.'); return; }
  const friends = await H.get('/api/friends');
  const friendList = (friends && friends.friends) ? friends.friends : (Array.isArray(friends)?friends:[]);
  const invitedUsernames = (s.invited||[]).map(fid=>{ const f=friendList.find(x=>x.id===fid); return f?f.username:''; }).filter(Boolean);
  DRAFT = { exercises: s.exercises.map(e=>({ id:e.id, name:e.name, defaultSets:e.defaultSets, defaultReps:e.defaultReps, defaultRepsMax:e.defaultRepsMax })),
            inviteUsernames: invitedUsernames,
            visibility: s.visibility || 'private',
            name: s.name||'', location: s.location||'', lengthMin: s.lengthMin||'', creatorNote: s.creatorNote||'' };
  DRAFT._dt = s.scheduledAt ? toLocalInput(s.scheduledAt) : '';
  EDITING_SESSION = id; EDITING_TPL=null;
  createFlow();
}
function toLocalInput(iso){ const d=new Date(iso); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
// ---- Templates: page-based flow (list -> name -> pick exercises -> save) ----
const TPL_MODE = { active:false, id:null, name:'', copy:false };   // active while building a template; copy = forking a friend's shared routine
async function templatesPage(){
  // Same gap as openAddExercises() had: "Browse templates" is also reachable mid-create (from
  // createFlow()'s form), and tplUse() returns via createFlow() too — so without stashing here,
  // browsing templates mid-create silently reverted name/visibility/date/location/length/note.
  // Guarded by element existence: these inputs only exist when this was reached from the
  // create-flow form; every other entry point (the Workouts tab's "Templates" button, the
  // template-builder's own "Back") leaves DRAFT untouched, same as before.
  if(DRAFT){
    if($('loc')) DRAFT.location = $('loc').value;
    if($('len')) DRAFT.lengthMin = $('len').value;
    if($('note')) DRAFT.creatorNote = $('note').value;
    if($('wname')) DRAFT.name = $('wname').value;
    if($('vis')) DRAFT.visibility = $('vis').value;
    if($('dt')) DRAFT._dt = $('dt').value;
  }
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  const { mine, shared } = await H.get('/api/templates');
  window._TPL = { mine, shared };
  // Jeff, Aug 28: "I want to be able to delete friend shared routines having that option also."
  // Your own routines keep Edit + a real Delete (erases the row for everyone -- server-owner-
  // gated). A friend's shared routine gets Remove instead of Delete -- same word Jeff would use,
  // but it can only ever take the routine out of YOUR OWN list (POST .../hide, see the comment
  // above GET /api/templates in server.js), never touch your friend's copy of it.
  // v226 (audit item 1): Use is the one visible action — it's what people tap most. Edit /
  // Delete / Remove live in the same ⋯ overflow menu viewPost and openSession already use
  // (pp-dots/pp-menu/togglePostMenu), so all three screens handle secondary actions one way and
  // no solid-red button sits in the main list. Row is position:relative so the absolutely
  // positioned .pp-menu anchors to its own row.
  const row = (t)=>`<div class="lib-item" style="position:relative"><div style="flex:1;min-width:0"><div style="font-weight:600">${esc(t.name)}</div><div class="muted" style="font-size:12px">${plur(t.exercises.length,'exercise')}${t.ownerName?` · from ${esc(t.ownerName)}`:''}</div></div>
    <button class="sec sm" onclick="tplUse('${t.id}')">Use</button>
    <button class="pp-dots" onclick="togglePostMenu('${t.id}')" aria-label="More">\u22ef</button>
    <div class="pp-menu" id="ppMenu-${t.id}" style="display:none">${t.ownerId===ME.id
      ?`<button onclick="tplEdit('${t.id}')">Edit</button><button class="danger" onclick="tplDelete('${t.id}')">Delete</button>`
      :`<button onclick="tplEditCopy('${t.id}')">Edit a copy</button><button class="danger" onclick="tplHide('${t.id}')">Remove</button>`}</div></div>`;
  $('app').innerHTML = `<div class="wrap tpl-page">
    <div class="pick-head lib-head"><h1 style="flex:1">Routines</h1>
      <button class="icon-btn" onclick="tplNew()" title="New routine">＋</button></div>
    <div class="muted" style="font-size:13px;margin:4px 2px 12px">Reusable workouts. Build one, then use it to start a new session in a tap.</div>
    ${mine.length?mine.map(row).join(''):homeEmpty(ICON_LIST, 'No routines yet', 'Tap + to create one, or save a finished workout as a routine.')}
    ${shared.length?`<div class="lib-cat" style="margin-top:12px">Shared by friends</div>`+shared.map(row).join(''):''}</div>`;
  window.scrollTo(0,0);
}
function tplNew(){
  TPL_MODE.active=true; TPL_MODE.id=null; TPL_MODE.name=''; TPL_MODE.copy=false;
  DRAFT={ exercises:[] }; EDITING_TPL=null;
  openSheetHtml(`<div class="sheet"><div class="sheet-head"><h2>Name routine</h2></div>
    <label class="muted">Routine name</label>
    <input id="tplName" placeholder="e.g. Push Day" autocomplete="off">
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="sec" style="flex:1" onclick="closeSheet()">Cancel</button>
      <button class="blue" style="flex:1" onclick="tplConfirmName()">✓ Create</button>
    </div></div>`);
  setTimeout(()=>{ const i=$('tplName'); if(i) i.focus(); }, 60);
}
function tplConfirmName(){
  const n=$('tplName').value.trim();
  if(!n){ alert('Name your routine first.'); return; }
  TPL_MODE.name=n; closeSheet(); templateExercises();
}
async function tplEdit(id){
  const { mine } = await H.get('/api/templates');
  const t = mine.find(x=>x.id===id); if(!t) return;
  TPL_MODE.active=true; TPL_MODE.id=id; TPL_MODE.name=t.name; TPL_MODE.copy=false;
  DRAFT={ exercises:t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax})) };
  EDITING_TPL=id;
  templateExercises();
}
// Jeff, Aug 28 (evening): "I want to edit routines shared by friends." Same principle as
// /remove-mine and /hide - NEVER touch the owner's object. Editing a friend's routine opens the
// full editor pre-filled and SAVING CREATES YOUR OWN COPY (plain POST /api/templates - no server
// change); the friend's original is untouched and stays in your Shared list until you Remove it.
// The menu item says "Edit a copy" and the save button "Save as my routine" so nobody expects
// their edit to reach the friend.
async function tplEditCopy(id){
  const { shared } = await H.get('/api/templates');
  const t = shared.find(x=>x.id===id); if(!t) return;
  TPL_MODE.active=true; TPL_MODE.id=null; TPL_MODE.name=t.name; TPL_MODE.copy=true;
  DRAFT={ exercises:t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax})) };
  EDITING_TPL=null;
  templateExercises();
}
// ---- In-app confirmation sheet (replaces browser confirm(), which speaks no design language
// and cannot be styled for dark mode). Same anatomy as the Reset workouts sheet: title, one
// plain-language explanation, the action in red, Cancel. Callers esc() anything user-derived
// they put in title/body.
// The sheet closes ITSELF via its own tracked element (not via closeSheet) so dismissing the
// confirm can never be confused with dismissing whatever sheet it may be stacked on top of, e.g.
// deleting a set from the edit sheet.
let CONFIRM_CB = null, CONFIRM_EL = null;
// v254: this closes CONFIRM_EL directly rather than via closeSheet() (see the comment above), so
// it needs its own copy of closeSheet()'s history.replaceState fixup -- the confirm sheet always
// pushed its own {t:'sheet'} entry (via openSheetHtml), and that entry has to be collapsed away
// when it was the ONLY sheet open, exactly like closeSheet()'s l.length===1 case, or a later Back
// press lands on a stale 'sheet' marker instead of the real underlying screen.
function dismissConfirm(){ const el = CONFIRM_EL; CONFIRM_CB = null; CONFIRM_EL = null;
  if(el){
    const wasOnlySheet = document.querySelectorAll('.sheet-back').length===1;
    el.classList.remove('show'); setTimeout(()=>el.remove(),200);
    if(wasOnlySheet) history.replaceState(CURRENT_NAV_STATE, '', location.href);
  } }
function runConfirmCb(){ const cb = CONFIRM_CB; dismissConfirm(); if(cb) cb(); }
// danger=false renders the action without red — for confirms that are choices, not destruction
// (declining an invite is not framed as destructive, same as the invite banner's Decline).
function confirmSheet(title, body, label, cb, danger=true){
  // v250 (audit finding): a double-tap on whatever opens this -- very easy on a touchscreen,
  // especially a scary destructive button -- used to call confirmSheet() twice before the first
  // sheet's own onclick was even relevant, stacking two confirm sheets and overwriting
  // CONFIRM_CB/CONFIRM_EL to point only at the newer one. dismissConfirm()/runConfirmCb() (wired to
  // every button on every confirm sheet) read those globals, not a reference to whichever physical
  // sheet a tap actually landed on -- so once the topmost sheet was dismissed, the first one's
  // Cancel/Delete buttons called dismissConfirm()/runConfirmCb() against already-null globals and
  // did nothing. Not a brief fade-race like closeSheet()'s: nothing was ever closing the first
  // sheet, so it sat there fully visible and fully tappable-looking, permanently dead, with no way
  // out but reloading. If one is already open, remove it immediately (no fade -- there's nothing to
  // animate away FROM, the new one is about to cover the same spot) so at most one confirm sheet's
  // buttons are ever wired to the live globals.
  if(CONFIRM_EL){
    // same fixup as dismissConfirm() -- the OLD confirm's pushed entry must be collapsed before
    // the new one (below) pushes its own, or the two stack up into one extra phantom 'sheet' entry.
    const wasOnlySheet = document.querySelectorAll('.sheet-back').length===1;
    CONFIRM_EL.remove(); CONFIRM_CB = null; CONFIRM_EL = null;
    if(wasOnlySheet) history.replaceState(CURRENT_NAV_STATE, '', location.href);
  }
  CONFIRM_CB = cb;
  CONFIRM_EL = openSheetHtml(`<div class="sheet"><div class="sheet-head"><h2>${title}</h2><button class="sec sm" onclick="dismissConfirm()">✕</button></div>
    ${body ? `<div class="muted" style="padding:0 2px 14px; font-size:13px; line-height:1.5">${body}</div>` : ''}
    <div class="sheet-list">
      <button class="sheet-row${danger?' red':''}" onclick="runConfirmCb()">${label}</button>
      <button class="sheet-row" onclick="dismissConfirm()">Cancel</button>
    </div></div>`);
  // the confirm's OWN backdrop dismisses the confirm, not whatever it's stacked on — overriding
  // openSheetHtml's generic backdrop handler (which would call closeSheet() and remove a
  // different sheet) with one scoped to this exact element (cold-review catch)
  CONFIRM_EL.onclick = (e)=>{ if(e.target===CONFIRM_EL) dismissConfirm(); };
}
// "1 exercises" was on half the screens in the app (Jeff, Aug 28)
function plur(n, word){ return `${n} ${word}${n===1?'':'s'}`; }
async function tplDelete(id){
  const { mine } = await H.get('/api/templates');
  const t = mine.find(x=>x.id===id); if(!t) return;
  confirmSheet('Delete routine?',
    `"${esc(t.name)}" will be gone from your Routines — there's no undo. Workouts you already logged with it are not affected.`,
    'Delete routine',
    async ()=>{ const r = await H.delete('/api/templates/'+id); if(r.error) alert(r.error); else templatesPage(); });
}
// Jeff, Aug 28: the non-owner half of "delete a routine" -- takes a friend's shared routine out
// of YOUR list only. v240: removal now gets an undo moment (toast below) instead of being
// instantly permanent, so the confirm copy no longer claims "there's no undo".
async function tplHide(id){
  const { shared } = await H.get('/api/templates');
  const t = shared.find(x=>x.id===id); if(!t) return;
  confirmSheet('Remove routine?', `"${esc(t.name)}" comes off your own list only — your friend's routine is untouched.`, 'Remove routine', () => tplHideConfirmed(id, t.name));
}
async function tplHideConfirmed(id, name){
  const r = await H.post('/api/templates/'+id+'/hide', {});
  if(r && r.error){ alert(r.error); return; }
  templatesPage();
  showUndoToast(`Removed "${esc(name)}"`, () => tplUnhide(id));
}
async function tplUnhide(id){
  const r = await H.post('/api/templates/'+id+'/unhide', {});
  if(r && r.error){ alert(r.error); return; }
  // only re-render if the user is still ON the routines page — the toast outlives navigation,
  // and yanking someone back to Routines from another tab because they tapped Undo is worse
  // than letting the restored routine simply be there next time they look
  if(document.querySelector('.tpl-page')) templatesPage();
}
// ---- Undo toast (v240) ----
// A single transient bar above the nav offering to take back the action just taken. Same slot
// and anatomy as #updateBar (which is rare enough that a brief overlap is acceptable — the toast
// sits one z-index above and is gone in seconds). One at a time: showing a new one replaces the
// old, and the old one's Undo is forfeited — by then its 6 seconds were nearly spent anyway.
// Contract mirrors confirmSheet: callers esc() anything user-derived in msg; cb is undo action.
let UNDO_CB = null, UNDO_TIMER = null;
function dismissUndoToast(){
  UNDO_CB = null;
  if(UNDO_TIMER){ clearTimeout(UNDO_TIMER); UNDO_TIMER = null; }
  const el = document.getElementById('undoToast');
  if(el){ el.classList.remove('show'); setTimeout(()=>el.remove(), 250); }
}
function runUndoCb(){ const cb = UNDO_CB; dismissUndoToast(); if(cb) cb(); }
function showUndoToast(msg, cb){
  dismissUndoToast();
  UNDO_CB = cb;
  const el = document.createElement('div');
  el.id = 'undoToast';
  el.innerHTML = `<span class="ut-msg">${msg}</span><button onclick="runUndoCb()">Undo</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  UNDO_TIMER = setTimeout(dismissUndoToast, 6000);
}
async function templateExercises(){
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  const nameField = (TPL_MODE.id || TPL_MODE.copy)
    ? `<input id="tplNameEdit" class="tpl-name-edit" value="${esc(TPL_MODE.name||'')}" placeholder="Routine name" autocomplete="off">`
    : `<h1>${esc(TPL_MODE.name||'Routine')}</h1>`;
  $('app').innerHTML = `<div class="wrap create-flow">
    <button class="sec sm" onclick="tplBack()">← Back</button>
    ${nameField}
    <h2>Exercises</h2><div id="draftList" class="card"></div>
    <button class="sec" onclick="tplOpenPicker()">+ Add exercise</button>
    <button class="blue" onclick="finishTemplate()">✓ ${TPL_MODE.id?'Save changes':(TPL_MODE.copy?'Save as my routine':'Create routine')}</button></div>`;
  window.scrollTo(0,0);
  renderDraft();
}
// v253 (audit finding): this was `closeSheet();templatesPage()` inline -- every OTHER way out of
// TPL_MODE (finishTemplate on success, resetTransientModes via showTab) clears TPL_MODE.active/
// id/name/copy; this was the one exit that didn't. The leak survives templatesPage() (a direct
// call, not through showTab, by design -- see its own comment) and survives tplUse() too, so the
// very next ordinary "+ New workout" -> "Browse templates" -> "Use a routine" -> "+ Add exercise"
// -> "Done" could land back in libDone() with TPL_MODE.active still true from a routine you
// merely LOOKED at and backed out of minutes earlier. libDone() then routes to templateExercises()
// instead of the create-flow the user actually started, and "Save changes" silently overwrites
// that unrelated routine with whatever was just picked -- while the new workout the user thought
// they were creating never gets created at all. No error, no confirmation. Traced and confirmed
// end to end (not just the reviewer's report) before fixing.
function tplBack(){ closeSheet(); resetTransientModes(); templatesPage(); }
function tplOpenPicker(){ openAddExercises(); }
async function finishTemplate(){
  if(!DRAFT.exercises.length){ alert('Add at least one exercise'); return; }
  const liveName = ((TPL_MODE.id || TPL_MODE.copy) && $('tplNameEdit')) ? $('tplNameEdit').value.trim() : TPL_MODE.name.trim();
  if(!liveName){ alert('Name your routine first.'); return; }
  const payload = { name:liveName, exercises:DRAFT.exercises };
  const r = TPL_MODE.id
    ? await H.put('/api/templates/'+TPL_MODE.id, payload)
    : await H.post('/api/templates', payload);
  if(r.error) return alert(r.error);
  TPL_MODE.active=false; TPL_MODE.id=null; TPL_MODE.copy=false; templatesPage();
}
async function tplUse(id){
  const { mine, shared } = await H.get('/api/templates');
  const t = [...mine,...shared].find(x=>x.id===id); if(!t) return;
  DRAFT = DRAFT || { exercises:[], inviteUsernames:[] };
  DRAFT.exercises = t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax}));
  EDITING_TPL = null;
  // v253 (audit finding): this is the exact step that turned a leaked TPL_MODE (from backing out
  // of an unrelated routine edit — see tplBack's comment) into a corrupted routine. Use loads this
  // routine's exercises into DRAFT and returns to createFlow()'s "New workout" screen — but without
  // this line, TPL_MODE was still pointing at whatever OTHER routine was last opened/edited, and
  // the next "+ Add exercise" -> "Done" (libDone) silently routed to the routine editor instead,
  // saving over it. This screen really is a new workout, not a routine, so TPL_MODE must be off.
  if(typeof TPL_MODE === 'object' && TPL_MODE) { TPL_MODE.active = false; TPL_MODE.id = null; TPL_MODE.name = ''; TPL_MODE.copy = false; }
  createFlow();
}
function tplQuickSaveSheet(){
  if(!DRAFT.exercises.length){ alert('Add exercises first, then save as a routine.'); return; }
  openSheetHtml(`<div class="sheet"><div class="sheet-head"><h2>Save as routine</h2></div>
    <label class="muted">Routine name</label>
    <input id="tplName" placeholder="${esc(DRAFT.name||'My workout')}" autocomplete="off">
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="sec" style="flex:1" onclick="closeSheet()">Cancel</button>
      <button class="blue" style="flex:1" onclick="tplQuickSaveConfirm()">✓ Save</button>
    </div></div>`);
  setTimeout(()=>{ const i=$('tplName'); if(i) i.focus(); }, 60);
}
async function tplQuickSaveConfirm(){
  const n=$('tplName').value.trim(); if(!n){ alert('Name your routine first.'); return; }
  closeSheet();
  if(!DRAFT.exercises.length){ return alert('Add exercises first.'); }
  const r = EDITING_TPL
    ? await H.put('/api/templates/'+EDITING_TPL,{name:n,exercises:DRAFT.exercises})
    : await H.post('/api/templates',{name:n,exercises:DRAFT.exercises});
  if(r.error) return alert(r.error);
  alert('Routine saved: '+n);
}
function toggleInvite(cb){ const u=cb.value; if(cb.checked){ if(!DRAFT.inviteUsernames.includes(u)) DRAFT.inviteUsernames.push(u);} else { DRAFT.inviteUsernames=DRAFT.inviteUsernames.filter(x=>x!==u);} }
function renderDraft(){ $('draftList').innerHTML = DRAFT.exercises.length? DRAFT.exercises.map((e,i)=>`<div class="lib-item draft-ex" data-idx="${i}"><div class="drag-handle" title="Drag to reorder"></div><div class="draft-main" onclick="editDraftEx(${i})"><span class="draft-name">${esc(e.name)}</span><span class="draft-chip">${e.defaultSets} × ${repLabel(e)}</span></div><button class="draft-rm" onclick="rmEx(${i})">Remove</button></div>`).join('') : '<div class="muted">None added.</div>';  const list=$('draftList'); if(list) dragReorder(list, DRAFT.exercises, ()=>renderDraft()); }
// Pointer-based drag reorder - works on mouse AND touch (iPhone). Reorders arr in place.
function dragReorder(container, arr, onChange){
  let dragEl=null, ph=null, grabY=0, startY=0, startX=0, started=false, h=0;
  const onDown=(e)=>{
    const item=e.target.closest('.draft-ex'); if(!item) return;
    // Only the grip handle starts a drag, so scrolling/tapping the row body works normally.
    if(!e.target.closest('.drag-handle')) return;
    if(e.target.closest('.draft-rm')) return;
    dragEl=item; started=false;
    startY=(e.touches?e.touches[0].clientY:e.clientY); startX=(e.touches?e.touches[0].clientX:e.clientX);
    window.addEventListener('mousemove',onMove); window.addEventListener('mouseup',onUp);
    window.addEventListener('touchmove',onMove,{passive:false}); window.addEventListener('touchend',onUp);
  };
  const onMove=(e)=>{
    const y=(e.touches?e.touches[0].clientY:e.clientY), x=(e.touches?e.touches[0].clientX:e.clientX);
    if(!started){
      if(Math.abs(y-startY)<6 && Math.abs(x-startX)<6) return;
      started=true; h=dragEl.offsetHeight;
      ph=document.createElement('div'); ph.className='drag-placeholder'; ph.style.height=h+'px';
      dragEl.parentNode.insertBefore(ph, dragEl.nextSibling);
      const r=dragEl.getBoundingClientRect(); grabY=startY-r.top;
      dragEl.style.width=r.width+'px'; dragEl.style.left=r.left+'px';
      dragEl.classList.add('dragging');
    }
    if(e.cancelable) e.preventDefault();
    dragEl.style.top=(y-grabY)+'px';
    const others=[...container.querySelectorAll('.draft-ex')].filter(r=>r!==dragEl);
    let target=null;
    for(const r of others){ const rb=r.getBoundingClientRect(); if(y < rb.top+rb.height/2){ target=r; break; } }
    if(target) container.insertBefore(ph, target); else container.appendChild(ph);
  };
  const onUp=()=>{
    window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp);
    window.removeEventListener('touchmove',onMove); window.removeEventListener('touchend',onUp);
    if(!started||!dragEl) return;
    if(ph) ph.parentNode.replaceChild(dragEl, ph);
    dragEl.classList.remove('dragging');
    dragEl.style.position=''; dragEl.style.top=''; dragEl.style.left=''; dragEl.style.width=''; dragEl.style.zIndex='';
    const domOrder=[...container.querySelectorAll('.draft-ex')];
    const reordered=domOrder.map(el=>arr[Number(el.getAttribute('data-idx'))]);
    for(let k=0;k<arr.length;k++) arr[k]=reordered[k];
    dragEl=null; ph=null; onChange();
  };
  container.querySelectorAll('.draft-ex').forEach(el=>{ el.addEventListener('mousedown',onDown); el.addEventListener('touchstart',onDown,{passive:true}); });
}
function rmEx(i){ DRAFT.exercises.splice(i,1); renderDraft(); }
function editDraftEx(i){
  const e = DRAFT.exercises[i]; if(!e) return;
  history.pushState({t:'sheet'}, '', location.href); // v254: Back dismisses this sheet -- see openSheetHtml's comment
  const sheet = document.createElement('div'); sheet.className='sheet-back';
  sheet.innerHTML=`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Edit exercise</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="sheet-thumb-cap" style="font-size:16px;font-weight:700;color:var(--fg);text-transform:none;margin-bottom:10px">${esc(e.name)}</div>
      <div class="sheet-row"><span>Sets</span><div class="stepper">
        <button class="stp" onclick="stepDraft(${i},'sets',-1)">−</button>
        <b id="dSets">${e.defaultSets}</b>
        <button class="stp" onclick="stepDraft(${i},'sets',1)">+</button>
      </div></div>
      <div class="sheet-row"><span>Reps (min)</span><div class="stepper">
        <button class="stp" onclick="stepDraft(${i},'reps',-1)">−</button>
        <b id="dReps">${e.defaultReps}</b>
        <button class="stp" onclick="stepDraft(${i},'reps',1)">+</button>
      </div></div>
      <div class="sheet-row"><span>Reps (max)</span><div class="stepper">
        <button class="stp" onclick="stepDraft(${i},'repsmax',-1)">−</button>
        <b id="dRepsMax">${e.defaultRepsMax||e.defaultReps}</b>
        <button class="stp" onclick="stepDraft(${i},'repsmax',1)">+</button>
      </div></div>
      <div class="note">Hit the max on your top set two sessions running and you'll be told to add weight.</div>
      <button class="red" style="margin-top:14px;width:100%" onclick="rmEx(${i}); closeSheet();">Remove exercise</button>
    </div>`;
  sheet.onclick=(e)=>{ if(e.target===sheet) closeSheet(); }; document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
}
function stepDraft(i, field, delta){
  const e = DRAFT.exercises[i]; if(!e) return;
  const key = field==='sets' ? 'defaultSets' : field==='repsmax' ? 'defaultRepsMax' : 'defaultReps';
  const base = key==='defaultRepsMax' ? (e.defaultRepsMax || e.defaultReps || 0) : (e[key] || 0);
  let v = base + delta; if(v<1) v=1; if(v>99) v=99;
  e[key] = v;
  // keep the range coherent: the ceiling can never sit below the floor
  if(key==='defaultReps' && e.defaultRepsMax && e.defaultRepsMax < v) e.defaultRepsMax = v;
  if(key==='defaultRepsMax' && v < (e.defaultReps||1)) { e.defaultRepsMax = e.defaultReps; v = e.defaultReps; }
  const lbl = field==='sets' ? 'dSets' : field==='repsmax' ? 'dRepsMax' : 'dReps';
  const el = document.getElementById(lbl); if(el) el.textContent = v;
  const mx = document.getElementById('dRepsMax');
  if(mx && key!=='defaultRepsMax') mx.textContent = e.defaultRepsMax || e.defaultReps;
  renderDraft();
}
// ---- Shared exercise helpers (picker + library) ----
const EQ_FAMILY = [
  { key:'bodyweight', label:'Bodyweight', match:['bodyweight','band','weighted vest','box','ab wheel','battle ropes','jump rope','parallel bars','pull-up bar'] },
  { key:'dumbbell', label:'Dumbbell', match:['dumbbell','dumbbells'] },
  { key:'barbell', label:'Barbell', match:['barbell','bar','ez bar','trap bar','plate','landmine','squat rack','smith machine'] },
  { key:'kettlebell', label:'Kettlebell', match:['kettlebell'] },
  { key:'cable', label:'Cable', match:['cable'] },
  { key:'machine', label:'Machine', match:['machine','bench','incline bench','decline bench','preacher bench','leg press','hack squat','pec deck','leg curl','leg extension','calf raise','ghr','sissy squat','chest press','incline press','shoulder press','rear delt','triceps extension','t-bar','chest-supported','row machine','lat pulldown','dip station'] },
  { key:'cardio', label:'Cardio', match:['treadmill','bike','rower','assault bike','stair climber','elliptical','skierg','jacobs ladder','sled'] },
];
// A custom exercise is authored by ANOTHER USER and renders in your library, so its fields are
// their input arriving in your browser.
//
// eqList is the one that matters: without it, a single non-string entry threw inside .map() and
// took the whole muscle group down for everyone. The server drops those on write now, but only for
// rows written since — it cannot clean what is already stored, and one guard is not a guard.
// Note the two ends are NOT identical: the server's read path coerces (String(x).toLowerCase() in
// defaultTargetFor), while this drops. Coercing here would let ["barbell"] silently become the
// barbell family, so dropping is the stricter half; a row that disagrees just gets no family.
//
// exName is honest belt-and-braces, not a live fix: the custom-exercise route has always stored
// String(name), so no stored exercise can have a non-string name today. It is here so that a future
// write path cannot make .toLowerCase() and .localeCompare() throw in a list render.
function eqList(e){ const q = e && e.equipment; return (Array.isArray(q)?q:[]).filter(x=>typeof x==='string'); }
function exName(e){ return String((e && e.name) || ''); }
function eqFamilies(e){
  const eq=eqList(e).map(x=>x.toLowerCase());
  const fams=new Set();
  for(const f of EQ_FAMILY){ if(eq.some(x=>f.match.some(m=>x.includes(m)))) fams.add(f.key); }
  return [...fams];
}
function eqLabel(key){ const f=EQ_FAMILY.find(x=>x.key===key); return f?f.label:key; }
function exBadges(e){
  const b=[];
  if(e.level) b.push(`<span class="ex-badge lv-${esc(e.level)}"><span class="dot"></span>${esc(e.level)}</span>`);
  b.push(`<span class="ex-badge ex-type">${e.is_compound?'Compound':'Isolation'}</span>`);
  return b.join('');
}
// Solid blue when favorited, outline/muted when not -- reuses --blue (the app's existing
// "selected/active" color, e.g. .cat-pill.on) rather than a gold/amber star. CLAUDE.md reserves
// gold for "Live now" specifically ("no amber/orange anywhere else") and green for earned/PR
// moments, so a star icon staying inside the blue lane keeps this to the app's existing 3-color
// vocabulary instead of adding a 4th.
function favIcon(active){
  const star = 'M12 3.4l2.62 5.63 6.02.72-4.48 4.28 1.2 6.02L12 16.98l-5.36 3.07 1.2-6.02L3.36 9.75l6.02-.72z';
  return active
    ? `<svg width="17" height="17" viewBox="0 0 24 24" fill="var(--blue)" stroke="var(--blue)" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="${star}"/></svg>`
    : `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="${star}"/></svg>`;
}
// event.stopPropagation() -- same guard every other tappable control nested inside a row's own
// onclick already uses in this file (e.g. the invite row's Accept/Decline) -- without it, tapping
// the star would ALSO fire the row's own action underneath it (open the exercise detail sheet, or
// toggle it into/out of the workout being built).
function favBtnHtml(e){
  const on = FAVORITES.has(e.name);
  return `<button type="button" class="ex-fav-btn" aria-label="${on?'Remove from favorites':'Add to favorites'}" onclick="event.stopPropagation(); toggleFavorite('${jsq(e.name)}', this)">${favIcon(on)}</button>`;
}
// Jeff, Sep 1: "add a filter in the exercise library for favorites... allowing you to favorite
// when building a workout or in the library also." One toggle endpoint on the server (POST
// /api/favorites/toggle) mirrors this one function client-side -- flip it, tell the star its new
// state, and keep FAVORITES in sync locally instead of re-fetching the whole list for one flip.
// FAV_BUSY (cold-review catch): same shape as addLogSet's ADDLOG_BUSY guard -- a fast double-tap
// on the same star fired two overlapping POSTs, and since each one's response unconditionally
// overwrote FAVORITES/the button icon with ITS OWN r.favorited, whichever response happened to
// ARRIVE last (not whichever request was sent last) decided the final visible state -- easy to
// land on a star showing the opposite of what actually got stored. Keyed by name rather than one
// global flag, so favoriting exercise A never blocks a tap on exercise B's own star right after.
let FAV_BUSY = new Set();
async function toggleFavorite(name, btnEl){
  if(FAV_BUSY.has(name)) return;
  FAV_BUSY.add(name);
  try {
    const r = await H.post('/api/favorites/toggle', { name });
    if(!r || r.error){ if(r && r.error) alert(r.error); return; }
    if(r.favorited) FAVORITES.add(name); else FAVORITES.delete(name);
    if(btnEl){ btnEl.setAttribute('aria-label', r.favorited?'Remove from favorites':'Add to favorites'); btnEl.innerHTML = favIcon(r.favorited); }
    // Re-render whatever list is actually on screen -- the same dispatch libSearch() uses, reused
    // here rather than duplicated, since "re-render the current lib view" is exactly what's needed
    // whether the star was tapped from a search result, a muscle-group list, or (see exDetail) the
    // detail sheet sitting on top of one. Applying it unconditionally is harmless even from exDetail
    // (SWAP_MODE/SUGGEST_ADD_MODE rows have no star to begin with, so LIB_ADDMODE's own list is the
    // only one that can actually change shape here — the ★ Favorites filter, if active, may need to
    // drop or regain this exact row).
    applyLibSearch();
  } finally {
    FAV_BUSY.delete(name);
  }
}
// ---- Muscle-group icons (mannequin crops w/ red highlight) ----
// Map muscle-group key -> png in public/muscle-icons/.
const MG_IMG = {
  // No prototype: MG_IMG is the whole vocabulary of icons that exist, and a plain object also
  // answers to 'constructor', 'toString' and '__proto__' — which would have put a native function's
  // source into the image URL. A closed vocabulary has to actually be closed.
  __proto__: null,
  chest:'chest', lats:'lats', traps:'traps', biceps:'biceps', triceps:'triceps',
  core:'core', quads:'quads', hamstrings:'hamstrings', calves:'calves',
  shoulders:'shoulders', forearms:'forearms', glutes:'glutes', cardio:'cardio',
  abdominals:'core'
};
function mgIcon(mg){
  // MG_IMG is the whole vocabulary of icons that exist. Falling back to the raw group used to build
  // the src from it UNESCAPED — and a custom exercise's muscle group is another user's text, so a
  // group of  x" onerror="..."  ended the attribute and ran their code in your browser when you
  // opened the exercise. v177 stopped new ones being stored; it could not clean the ones already
  // there, and the sink stayed open. An unknown group has no icon by definition, so there is
  // nothing to interpolate: show the neutral one.
  const key = MG_IMG[mg];
  return `<img class="mg-img" src="muscle-icons/${key || 'core'}.png" alt="${esc(mg)}" loading="lazy">`;
}
function exThumb(e){
  const mg = (e.muscle_groups&&e.muscle_groups[0]) || 'abdominals';
  return mgIcon(mg);
}
function addEx(name, el){
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  const exists = DRAFT.exercises.find(e=>e.name===name);
  if(exists){ DRAFT.exercises = DRAFT.exercises.filter(e=>e.name!==name); }
  else {
    // the library entry now carries a target derived from what the exercise IS, so stop
    // hard-coding one shape for all 203 of them
    const lib = (window._LIB2 || []).find(x => x.name === name) || {};
    DRAFT.exercises.push({ name, defaultSets: lib.defaultSets || 3,
                           defaultReps: lib.defaultReps, defaultRepsMax: lib.defaultRepsMax });
  }
  if(el){ const on=DRAFT.exercises.find(e=>e.name===name); el.classList.toggle('ex-on', !!on); el.querySelector('.ex-add').textContent = on?'✓':'+'; }
}
function closePick(){ createFlow(); }


// ---- Progress tab ------------------------------------------------------------------------
// Design + rationale: _design/progress/README.md. "Add weight next time" is computed server
// side (/api/progress) from the last two sessions per lift, NOT from the week range — a
// recommendation is about what to do next, so it must not change when the range is scrubbed.
let PROG_WEEKS = 13;
// Labelled the way people think about time, not in the raw week counts the API takes.
const PROG_RANGES = [ {weeks:4, label:'Month'}, {weeks:13, label:'3 months'}, {weeks:26, label:'6 months'} ];
// Weekly volume meter: collapsed to the N muscle groups furthest from target by default (same
// "6 chips, tap in for the rest" idea as Strength trend below), full 12-row list on demand.
const VOL_SHOW_N = 5;
let VOL_EXPANDED = false;
function toggleVolExpanded(){ VOL_EXPANDED = !VOL_EXPANDED; progressScreen({silent:true}); }
// "This week" vs a longer trailing average -- Jeff, Aug 31: does weekly volume need a monthly view
// too? A strict Monday-reset snapshot looks artificially empty early in the week or after one
// lighter week, even when the trailing month is right on target. Full separate monthly section
// would re-add the very bulk this card was just cut down from (see the collapse/expand note above)
// for a question that's really "what has this looked like LATELY," not a whole new time dimension
// to browse. A range toggle reusing Consistency's own range-picker pattern below answers that in
// place: same rows, same targets, same card -- just a different lens on the same numbers.
//
// Sep 1, round 5 (Jeff, on the per-muscle SVG trend chart: "I don't like the bar graph we have
// where the whole report is blank and shows one bar when selected... I have repeatedly sent you a
// screenshot of the report I liked" -- this same bar-row card): widened from a 2-way This-week/
// 4-wk-avg toggle to a range picker below, and retired the SVG chart entirely.
//
// Sep 1, round 6: dropped "6 months" -- unlike Consistency's Month/3 months/6 months (a genuinely
// slow-moving adherence trend worth a half-year view), weekly SET VOLUME per muscle group is a
// "what has this looked like LATELY" question, per the original toggle's own rationale above. A
// 6-month average barely moves once you're in a steady routine, and for anyone without 6 months of
// history yet it's a diluted, confusing number (weeks before they'd even started training that
// muscle dragging the average down) rather than anything actionable. This week/Month/3 months stays
// -- three ranges, one visual language, no chart. Each longer range is a true per-week average over
// its trailing window (server-side volumeFor(weeks), same math the original 4-wk avg already used)
// -- a muscle you've trained consistently reads the SAME whether you're on This week or 3 months,
// never 4x/13x bigger just because the window got longer.
const VOL_RANGES = [
  { key:'week',  label:'This week', field:'volume',
    note:'working sets logged this week (Monday–Sunday), counted for every muscle group each exercise targets.', suffix:'' },
  { key:'month', label:'Month',     field:'volumeAvg',
    note:'average working sets per week over the trailing month (this week included), counted for every muscle group each exercise targets.', suffix:'/wk' },
  { key:'3mo',   label:'3 months',  field:'volume3mo',
    note:'average working sets per week over the trailing 3 months (this week included), counted for every muscle group each exercise targets.', suffix:'/wk' },
];
// Persists across re-renders same as VOL_EXPANDED/PROG_WEEKS.
let VOL_MODE = 'week';
function setVolMode(m){ VOL_MODE = m; progressScreen({silent:true}); }
const GROUP_LABEL = { legs:'Legs', push:'Push', pull:'Pull', core:'Core', cardio:'Cardio', other:'Other' };
// Mirrors server.js's PLATEAU_MIN_SESSIONS -- copy text only, the server is the actual gate.
const PLATEAU_MIN_SESSIONS = 3;
// Display labels for the weekly-volume meter rows (server sends raw EX_LIB muscle_groups keys).
const MUSCLE_LABEL = { chest:'Chest', lats:'Back', shoulders:'Shoulders', traps:'Traps',
  biceps:'Biceps', triceps:'Triceps', forearms:'Forearms', quads:'Quads', hamstrings:'Hamstrings',
  glutes:'Glutes', calves:'Calves', abdominals:'Abs' };
// Last-fetched /api/progress payload — stashed so openBodyweightSheet (opened from a button on
// this page, not passed any data of its own) can read the current unit and today's existing
// entry without a second round trip.
let PROG_LAST = null;

// A bodyweight best has no weight — "0 × 10" reads as broken. Show the reps, which is what
// you actually compare bodyweight sets on.
// "2026-05-01" -> "May 1"
function shortDate(iso){
  const d=new Date(iso+'T00:00:00Z'); if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'});
}
// v249 (audit finding): this used to label every PR's weight with U, the page's CURRENT unit
// preference, no matter what unit the record itself was actually logged in — the same "each
// logged set... keeps reading in the unit it was typed in" rule myUnit()/unitOf() already follow
// everywhere else (see the comment above unitOf). A kg lifter's record now correctly carries its
// own p.unit (server fix in rebuildAllPrs), so this reads that instead of assuming it matches
// whatever unit the viewer happens to be on right now — the only case this changes anything is a
// PR set in one unit that's still on record after the user later switched preference, which used
// to silently relabel it as the wrong unit's number.
function prLabel(p){
  const w=Number(p.weight)||0;
  if(w===0) return `${p.reps} reps`;
  return `${w} ${unitOf(p)} × ${p.reps}`;
}

// Strength trend chart. Single series, so no legend — the chip above names it. Selective
// labels only (never a number on every point). Values are reachable by tap, not hover only.
let TREND_PICK = '__overall';
function setTrendPick(k){ TREND_PICK=k; progressScreen({silent:true}); }
function trendChart(d, U){
  const t = d.trend || {lifts:[], overall:[], allNames:[], picks:[]};
  // Stashed here (not just read inside openTrendPicker) so the picker sheet always reflects
  // whatever was actually rendered, not a stale/refetched copy.
  window._TREND_ALL = t.allNames || [];
  window._TREND_PICKS_SAVED = t.picks || [];
  if(!t.lifts.length) return `<h2>Strength trend</h2><div class="card"><div class="empty">
    <div class="empty-t">Not enough history yet</div>
    <div class="empty-b">Log the same lift <b>twice</b> and its strength line starts here.
      Bodyweight moves are tracked in records instead.</div></div></div>`;

  const isOverall = TREND_PICK==='__overall';
  const lift = t.lifts.find(l=>l.name===TREND_PICK) || t.lifts[0];
  const pts = isOverall ? t.overall.map(p=>({at:p.at, v:p.pct}))
                        : lift.points.map(p=>({at:p.at, v:p.est, w:p.weight, r:p.reps}));
  const chips = `<div class="chips">
    <span class="chip ${isOverall?'on':''}" onclick="setTrendPick('__overall')">Overall</span>
    ${t.lifts.slice(0,6).map(l=>`<span class="chip ${(!isOverall&&l.name===lift.name)?'on':''}"
      onclick="setTrendPick('${jsq(l.name)}')">${esc(l.name.split(' ').slice(-2).join(' '))}</span>`).join('')}
  </div>`;

  if(pts.length<2) return `<h2>Strength trend</h2>${chips}<div class="card">
    <div class="muted" style="padding:20px 4px;text-align:center">Only one session for this lift so far.</div></div>`;

  const W=326,H=150,PL=36,PRr=12,PT=20,PB=24;
  const vals=pts.map(p=>p.v);
  let lo=Math.min(...vals), hi=Math.max(...vals);
  if(isOverall){ lo=Math.min(0,lo)-1; hi=Math.max(hi,1)+2; }
  else { const pad=Math.max(5,(hi-lo)*0.15); lo=Math.floor((lo-pad)/5)*5; hi=Math.ceil((hi+pad)/5)*5; }
  if(hi===lo) hi=lo+1;
  const xs=i=>PL+i*(W-PL-PRr)/(pts.length-1);
  const ys=v=>PT+(hi-v)*(H-PT-PB)/(hi-lo);
  const step=Math.max(1,Math.round((hi-lo)/4));
  let grid='',lbl='';
  for(let g=Math.ceil(lo/step)*step; g<=hi; g+=step){
    const zero=isOverall&&g===0;
    grid+=`<line x1="${PL}" y1="${ys(g)}" x2="${W-PRr}" y2="${ys(g)}" style="stroke:${zero?'var(--fg)':'var(--line)'};${zero?'opacity:.18':''}" stroke-width="1"/>`;
    lbl+=`<text x="${PL-7}" y="${ys(g)+3.5}" text-anchor="end" font-size="9.5" style="fill:var(--muted)">${isOverall?((g>0?'+':'')+g+'%'):g}</text>`;
  }
  const poly=pts.map((p,i)=>`${xs(i)},${ys(p.v)}`).join(' ');
  let dots='',hits='';
  pts.forEach((p,i)=>{ const last=i===pts.length-1;
    dots+=`<circle cx="${xs(i)}" cy="${ys(p.v)}" r="${last?5.5:4.2}" style="fill:${last?'var(--blue)':'var(--card)'};stroke:var(--blue)" stroke-width="2"/>`;
    hits+=`<circle cx="${xs(i)}" cy="${ys(p.v)}" r="15" fill="transparent"><title>${shortDate(p.at)}: ${isOverall?((p.v>=0?'+':'')+p.v+'% vs start'):`${p.w} ${U} × ${p.r} — est. max ${p.v} ${U}`}</title></circle>`;});
  let xl='';
  [[0,'start'],[pts.length-1,'end']].forEach(([i,a])=>{
    xl+=`<text x="${xs(i)}" y="${H-7}" text-anchor="${a}" font-size="9.5" style="fill:var(--muted)">${shortDate(pts[i].at)}</text>`;});
  const lastV=pts[pts.length-1].v;
  const head = isOverall
    ? `<div><span class="ch-val">${lastV>=0?'+':''}${Math.round(lastV)}%</span> <span class="ch-unit">overall strength</span></div>`
    : `<div><span class="ch-val">${Math.round(lastV)}</span> <span class="ch-unit">${U} estimated max</span></div>`;
  const drivers = isOverall ? `<div class="drv-head">What's driving it</div>${
    t.lifts.slice().sort((a,b)=>b.changePct-a.changePct).map(l=>`<div class="drv">
      <div class="drv-n">${esc(l.name)}</div>
      <div class="drv-w">${l.points[0].weight} → ${l.points[l.points.length-1].weight} ${U}</div>
      <div class="drv-p ${l.changePct>0.5?'up':'flat'}">${l.changePct>0.5?'▲ '+Math.round(l.changePct)+'%':'—'}</div>
    </div>`).join('')}` : '';

  return `<div class="sec-head"><h2>Strength trend</h2><button class="txt-btn" style="margin-left:auto"
    onclick="openTrendPicker()" title="Pick which lifts to show">Pick lifts</button></div>${chips}<div class="card">
    <div class="ch-head">${head}</div>
    <div class="ch-note">${isOverall
      ? `Each lift compared with where it started, weighted by how heavy it is`
      : `${esc(lift.name)} · best working set per session`}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
      ${grid}<polyline points="${poly}" fill="none" style="stroke:var(--blue)" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/>${dots}${lbl}${xl}${hits}</svg>
    ${drivers}
    <div class="tblnote">${isOverall
      ? 'Lifts you have trained at least twice. Tap a point for the exact figure.'
      : `Estimated max is what your best set predicts for one all-out rep (weight × [1 + reps ÷ 30]),
         so a heavy triple and a light set of ten compare fairly.`}</div>
  </div>`;
}

// Volume trend (Aug 31) -- shows what you've been training, per muscle group, against a weekly
// target, as a plain bar-row list (name / N of target sets / progress bar). Driven by the same kind
// of range picker (VOL_RANGES above: This week/Month/3 months) as Consistency's own Month/3
// months/6 months control right below it -- same visual language, a narrower range concept (see the
// round 6 note on VOL_RANGES above for why this one stops at 3 months instead of 4 ranges).
//
// Sep 1, round 4 (Jeff, on the old "Overall" tab: "all of these blocks don't tell you anything but a
// percentage. You don't know what it is for... I was thinking of having the bars like you did as
// the report [the Weekly Volume card, which used to be its OWN section directly above this one]
// ... I liked the original design and then you can expand it"). Folded the ENTIRE Weekly Volume card
// into this section instead of a week-by-week average-%-of-target line: same worst-first collapsed
// bar-row list, range toggle, and "Show all 12" expand.
//
// Sep 1, round 5 (Jeff: "I don't like the bar graph we have where the whole report is blank and
// shows one bar when selected"): picking a muscle used to switch to a per-week SVG trend chart --
// retired in favor of narrowing this same card to just the picked muscle's row.
//
// Sep 1, round 6 (Jeff: "I dont feel like we need the separate SVG report, overall pill box, and
// muscle picker if we show the volume trend in the main bar graph"): retired the Overall/"Pick a
// muscle" chip toggle AND the picker sheet entirely. There is no more "picked"/"narrowed" state --
// every muscle just always shows as its own row here, all the time. The range picker (This
// week/Month/3 months, see VOL_RANGES above) is now the ONLY control this section has.
function volTrendChart(d){
  const rangeInfo = VOL_RANGES.find(r=>r.key===VOL_MODE) || VOL_RANGES[0];
  const volGroups = (d[rangeInfo.field] && d[rangeInfo.field].groups) || [];
  const volByGroup = {}; for (const g of volGroups) volByGroup[g.group] = g;
  // Cold-review catch (Aug 31, carried forward): the range toggle must NOT be gated on the CURRENT
  // range's data -- a fresh page load always starts on "This week," so a week with nothing logged
  // yet (common early in the week) would hide the other ranges entirely even when a longer window
  // had real data. That's exactly backwards: the toggle exists FOR that moment. Gate it on ANY
  // range having something to show, across all 3 -- only the row list itself stays scoped to
  // whichever range is actually active.
  const volAnyEver = VOL_RANGES.some(r => ((d[r.field] && d[r.field].groups) || []).some(g=>g.sets>0));
  const volModeSeg = volAnyEver ? `<div class="seg wk-seg" style="margin:12px 0 2px">
      ${VOL_RANGES.map(r=>`<button class="${VOL_MODE===r.key?'on':''}" onclick="setVolMode('${r.key}')">${r.label}</button>`).join('')}
    </div>` : '';
  // Named volRowHtml, not the more obvious `row` -- test/wiring.mjs's duplicate-function-definition
  // check scans public/app.js as one flat namespace regardless of lexical scope, and an unrelated
  // `const row = (t)=>...` already exists in the routines-list rendering elsewhere in this file.
  const volRowHtml = g => {
    const pct = Math.min(100, Math.round(100*g.sets/g.target));
    const met = g.sets >= g.target;
    return `<div class="mv-row">
      <div class="mv-top"><span class="mv-name">${MUSCLE_LABEL[g.group]||g.group}</span>
        <span class="mv-n">${g.sets}<span class="mv-of"> / ${g.target} sets${rangeInfo.suffix}</span></span></div>
      <div class="mv-track"><div class="mv-fill${met?' mv-met':''}" style="width:${pct}%"></div></div>
    </div>`;
  };

  // Jeff, Aug 31: 12 rows made this the single longest section on the page, burying Strength trend
  // and Personal records below the fold. Same fix as Strength trend's own "6 chips, tap in for the
  // rest" -- collapsed by default to VOL_SHOW_N, sorted worst-first (lowest % of target) so the
  // collapsed view actually surfaces what's useful: the muscle groups most worth attention, not just
  // the first N alphabetically/anatomically. Expanded, it switches back to the natural anatomical
  // order (server's MUSCLE_ORDER) since a full scan is easier to read grouped, not ranked.
  // VOL_EXPANDED persists across re-renders same as PROG_WEEKS above.
  //
  // Jeff, Aug 31 (round 2): which 5 muscles show when collapsed is ranked by THIS WEEK's ratios
  // ALWAYS, never by whichever range is currently displayed. Originally this re-ranked per mode, so
  // switching ranges could swap out which rows even appeared (a muscle skipped this week but trained
  // solidly over a longer window would drop off the list entirely, replaced by something else) --
  // confusing, since the whole point of the toggle is "same rows, different lens," not a second
  // independent ranking. Pinning to This week keeps a neglected-today muscle flagged regardless of
  // how its longer-range number looks; only the displayed numbers change.
  const weekGroups = (d.volume && d.volume.groups) || [];
  const volAny = volGroups.some(g=>g.sets>0);
  const volHasMore = volGroups.length > VOL_SHOW_N;
  const worstKeysThisWeek = weekGroups.slice().sort((a,b)=>(a.sets/a.target)-(b.sets/b.target)).map(g=>g.group);
  const volShown = VOL_EXPANDED ? volGroups : worstKeysThisWeek.slice(0, VOL_SHOW_N).map(k=>volByGroup[k]).filter(Boolean);
  const volHtml = !volAny
    ? `<div class="muted" style="padding:14px 2px 6px;line-height:1.5">Log some working sets this
         week and each muscle group's volume fills in here.</div>`
    : volShown.map(volRowHtml).join('');
  // Round 4: no header-button next to the h2 (same reasoning as round 2's "Pick a muscle" fix above)
  // -- "Show all" lives inside the card body, below the rows, instead.
  const volShowAllLink = (volAny && volHasMore)
    ? `<div style="text-align:right;margin-top:8px"><button class="txt-btn" onclick="toggleVolExpanded()">${VOL_EXPANDED?'Show fewer':'Show all '+volGroups.length}</button></div>`
    : '';
  return `<h2>Volume trend</h2><div class="card">${volHtml}${volShowAllLink}${volModeSeg}
    ${volAny?`<div class="rulenote"><b>How it works:</b> ${rangeInfo.note} General guideline,
      not a personal prescription.</div>`:''}
  </div>`;
}

// Body weight chart — same SVG-line-chart shape as trendChart above (viewBox, xs/ys scale
// functions, polyline + dots, tap-for-exact-figure titles), just a single always-present series
// with no lift picker. "Log weight" opens openBodyweightSheet(); see the section header below.
function bodyweightChart(d, U){
  const bw = (d.bodyweight && d.bodyweight.entries) || [];
  const logBtn = `<button class="txt-btn" style="margin-left:auto" onclick="openBodyweightSheet()">+ Log weight</button>`;
  if(!bw.length) return `<div class="sec-head"><h2>Body weight</h2></div><div class="card"><div class="empty">
    <div class="empty-t">Not tracked yet</div>
    <div class="empty-b">Log your weight and it starts charting here.</div>
    <button class="blue" style="margin-top:10px" onclick="openBodyweightSheet()">+ Log weight</button>
  </div></div>`;
  if(bw.length<2){
    const only = bw[0];
    return `<div class="sec-head"><h2>Body weight</h2>${logBtn}</div><div class="card">
      <div class="ch-head"><div><span class="ch-val">${only.weight}</span> <span class="ch-unit">${U}</span></div></div>
      <div class="muted" style="padding:6px 4px 2px">Logged ${shortDate(only.date)}. One more entry starts the chart.</div>
    </div>`;
  }
  const W=326,H=120,PL=34,PRr=12,PT=18,PB=22;
  const vals=bw.map(p=>p.weight);
  let lo=Math.min(...vals), hi=Math.max(...vals);
  const pad=Math.max(2,(hi-lo)*0.2);
  lo=Math.floor(lo-pad); hi=Math.ceil(hi+pad);
  if(hi===lo) hi=lo+2;
  const bwXs=i=>PL+i*(W-PL-PRr)/(bw.length-1);
  const bwYs=v=>PT+(hi-v)*(H-PT-PB)/(hi-lo);
  const step=Math.max(1,Math.round((hi-lo)/4));
  let grid='',lbl='';
  for(let g=Math.ceil(lo/step)*step; g<=hi; g+=step){
    grid+=`<line x1="${PL}" y1="${bwYs(g)}" x2="${W-PRr}" y2="${bwYs(g)}" style="stroke:var(--line)" stroke-width="1"/>`;
    lbl+=`<text x="${PL-7}" y="${bwYs(g)+3.5}" text-anchor="end" font-size="9.5" style="fill:var(--muted)">${g}</text>`;
  }
  const poly=bw.map((p,i)=>`${bwXs(i)},${bwYs(p.weight)}`).join(' ');
  let dots='',hits='';
  bw.forEach((p,i)=>{ const last=i===bw.length-1;
    dots+=`<circle cx="${bwXs(i)}" cy="${bwYs(p.weight)}" r="${last?5.5:4.2}" style="fill:${last?'var(--blue)':'var(--card)'};stroke:var(--blue)" stroke-width="2"/>`;
    hits+=`<circle cx="${bwXs(i)}" cy="${bwYs(p.weight)}" r="15" fill="transparent"><title>${shortDate(p.date)}: ${p.weight} ${U}</title></circle>`;});
  let xl='';
  [[0,'start'],[bw.length-1,'end']].forEach(([i,a])=>{
    xl+=`<text x="${bwXs(i)}" y="${H-6}" text-anchor="${a}" font-size="9.5" style="fill:var(--muted)">${shortDate(bw[i].date)}</text>`;});
  const lastV=bw[bw.length-1].weight, firstV=bw[0].weight, delta=Math.round((lastV-firstV)*10)/10;
  // No color judgment on the delta -- unlike a strength trend, more or less bodyweight isn't
  // inherently "up" (green is reserved for earned things elsewhere in this app), so this stays
  // plain muted text regardless of direction.
  return `<div class="sec-head"><h2>Body weight</h2>${logBtn}</div><div class="card">
    <div class="ch-head"><div><span class="ch-val">${lastV}</span> <span class="ch-unit">${U}</span></div>
      ${delta!==0?`<div class="ch-unit">${delta>0?'+':''}${delta} ${U} since ${shortDate(bw[0].date)}</div>`:''}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
      ${grid}<polyline points="${poly}" fill="none" style="stroke:var(--blue)" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/>${dots}${lbl}${xl}${hits}</svg>
  </div>`;
}
function openBodyweightSheet(){
  const bw = PROG_LAST && PROG_LAST.bodyweight;
  const U = (bw && bw.unit) || 'lb';
  const today = localDateStr();
  const existing = bw && bw.entries.find(e=>e.date===today);
  textEntrySheet({
    title:'Log body weight', label:`Weight (${U})`,
    value: existing ? String(existing.weight) : '', placeholder:'185',
    confirmLabel:'Save',
    onConfirm: async (v)=>{
      const w = Number(v);
      if(!(w>0)){ alert('Enter your weight'); return; }
      const r = await H.post('/api/me/bodyweight', { weight:w, unit:U, date:today });
      if(r && r.error){ alert(r.error); return; }
      progressScreen({silent:true});
    }
  });
}

// Jeff, Aug 19: "only select 5 workouts at a time... let the user pick which workouts they want
// to select rather than it using most recent exercises... a tab under it that allows us to
// select." TRENDPICK_SEL tracks selection ORDER (push on check, filter on uncheck) because the
// server preserves and displays picks in the order chosen, not alphabetically or by history —
// see POST /api/me/trend-picks and trendFor() in server.js.
let TRENDPICK_SEL = [];
function openTrendPicker(){
  TRENDPICK_SEL = (window._TREND_PICKS_SAVED || []).slice();
  openSheetHtml(renderTrendPicker());
}
function renderTrendPicker(){
  const all = window._TREND_ALL || [];
  const rows = all.length ? all.map(name => {
    const checked = TRENDPICK_SEL.includes(name);
    return `<label class="inv-row"><div class="inv-text"><div class="name">${esc(name)}</div></div>
      <span class="check"><input type="checkbox" value="${esc(name)}" ${checked?'checked':''} onchange="toggleTrendPick(this)">
      <span class="box"><svg class="tick" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8.5l3 3 6-7" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span></label>`;
  }).join('') : '<div class="muted">Log the same lift twice to see it here.</div>';
  return `<div class="sheet"><div class="sheet-head"><h2>Pick lifts to show</h2></div>
    <div class="muted" style="font-size:12.5px;padding:0 2px 10px">Choose up to 5. Leave none picked
      and your most-trained lifts show automatically.</div>
    <div class="card">${rows}</div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="sec" style="flex:1" onclick="closeSheet()">Cancel</button>
      <button class="blue" style="flex:1" onclick="saveTrendPicks()">✓ Save</button>
    </div></div>`;
}
function toggleTrendPick(input){
  const name = input.value;
  if(input.checked){
    if(TRENDPICK_SEL.length>=5){ input.checked=false; alert('You can pick up to 5.'); return; }
    TRENDPICK_SEL.push(name);
  } else {
    TRENDPICK_SEL = TRENDPICK_SEL.filter(n=>n!==name);
  }
}
async function saveTrendPicks(){
  const r = await H.post('/api/me/trend-picks', { picks: TRENDPICK_SEL });
  if(r && r.error){ alert(r.error); return; }
  closeSheet();
  progressScreen({silent:true});
}

async function progressScreen(opts){
  // v254: opts.silent -- setProgWeeks/setTrendPick both re-invoke this to refresh the SAME screen
  // in place after tapping a range/trend pill roughly mid-page; without silent gating the plain
  // scrollTo(0,0) below would yank the screen back to the top on every pill tap, same class of
  // regression openSession's opts.silent already guards against.
  const silent = !!(opts && opts.silent);
  const d = await H.get('/api/progress?weeks='+PROG_WEEKS);
  if(!d || d.error){ $('app').innerHTML = `<div class="wrap"><h1>Progress</h1><div class="muted">Couldn\'t load progress.</div></div>`; if(!silent) window.scrollTo(0,0); return; }
  PROG_LAST = d;
  const U = d.unit || 'lb';
  // Bodyweight lifts store weight 0; "at 0 lb" reads as a bug on every one of these rows.
  const WL = w => (Number(w)>0 ? `${w} ${U}` : 'bodyweight');

  // --- add weight next time, grouped by training split ---
  let readyHtml = '';
  if(d.ready.length){
    const byGroup = {};
    d.ready.forEach(r => (byGroup[r.group] = byGroup[r.group] || []).push(r));
    readyHtml = Object.keys(byGroup).map(g => `<div class="grp">
        <div class="grp-h">${GROUP_LABEL[g]||g}</div>
        ${byGroup[g].map(r=>`<div class="rp">
          <div class="rp-ic" aria-hidden="true">↑</div>
          <div class="rp-main"><div class="rp-name">${esc(r.exercise)}</div>
            <div class="rp-why">Hit ${r.targetRepsMax} reps at ${WL(r.weight)} · last 2 sessions</div></div>
          <div class="rp-to"><div class="rp-new">${r.bodyweight?`+${r.step} ${U}`:`${r.suggested} ${U}`}</div>
            <div class="rp-tag">▲ +${r.step}</div></div>
        </div>`).join('')}
      </div>`).join('');
  } else if(!(d.soon||[]).length && !d.holds.length){
    // Only when the card would otherwise be blank. Printing "Nothing to add yet" above a
    // populated "Almost" list — the single most likely state for a new user — had the card
    // contradicting itself, with a faded example row sitting among real ones.
    readyHtml = `<div class="empty">
      <div class="empty-t">Nothing to add yet</div>
      <div class="empty-b">Reach the top of your rep range on a lift <b>two sessions in a row at the
        same weight</b> and it appears here, with the weight to try next.</div>
      <div class="eg-wrap">
        <div class="eg-cap">Example</div>
        <div class="rp eg-row">
          <div class="rp-ic" aria-hidden="true">↑</div>
          <div class="rp-main"><div class="rp-name">Bench Press</div>
            <div class="rp-why">Hit 10 reps at 135 ${U} · last 2 sessions</div></div>
          <div class="rp-to"><div class="rp-new">140 ${U}</div><div class="rp-tag">▲ +5</div></div>
        </div>
      </div></div>`;
  }
  // The log sheet shows this state on the exercise row; without it here the two screens
  // contradicted each other — "one more like that" in the sheet, "nothing to add yet" on Progress.
  let soonHtml = '';
  if((d.soon||[]).length){
    soonHtml = `<div class="hold-sec"><div class="hold-head">Almost — one more good session</div>
      ${d.soon.map(h=>`<div class="hold">
        <div class="hold-ic almost-ic" aria-hidden="true">⋯</div>
        <div class="rp-main"><div class="rp-name">${esc(h.exercise)}</div>
          <div class="rp-why">Hit ${h.targetRepsMax} reps at ${WL(h.weight)} again and the weight goes up</div></div>
      </div>`).join('')}</div>`;
  }
  let holdHtml = '';
  if(d.holds.length){
    holdHtml = `<div class="hold-sec"><div class="hold-head">Hold for now</div>
      ${d.holds.map(h=>`<div class="hold">
        <div class="hold-ic" aria-hidden="true">–</div>
        <div class="rp-main"><div class="rp-name">${esc(h.exercise)}</div>
          <div class="rp-why">${h.reps} of ${h.targetRepsMax} reps at ${WL(h.weight)} — repeat it before adding</div></div>
      </div>`).join('')}</div>`;
  }

  // --- plateau watch --- lifts trained regularly with no real strength gain in the trailing
  // window (server-side plateausFor). Never rendered when empty -- CLAUDE.md: a card renders
  // only when it has content, and there's no congratulatory "no plateaus!" empty state to match
  // Ready/Hold/Almost, which also simply don't render when empty.
  let plateauHtml = '';
  if((d.plateaus||[]).length){
    const pw = d.plateaus[0].weeks;
    plateauHtml = `<h2>Plateau watch</h2>
    <div class="card"><div class="hold-sec"><div class="hold-head">No change in estimated strength</div>
      ${d.plateaus.map(p=>`<div class="hold">
        <div class="hold-ic" aria-hidden="true">=</div>
        <div class="rp-main"><div class="rp-name">${esc(p.exercise)}</div>
          <div class="rp-why">${p.sessions} sessions over ${pw} weeks, most recently ${p.reps} reps at ${WL(p.weight)} — no increase in estimated strength</div></div>
      </div>`).join('')}</div>
      <div class="rulenote"><b>How it works:</b> trained ${PLATEAU_MIN_SESSIONS}+ times in the last
        ${pw} weeks with no real gain in weight, reps, or estimated one-rep max — worth trying a rep-range
        change, a deload, or a different exercise for the same muscles.</div>
    </div>`;
  }

  // --- consistency ---
  const maxd = Math.max(6, ...d.weeks.map(w=>w.days));
  const BW=326, BH=96, BB=20, BT=6, gap=5;
  const cw = Math.min(30,(BW-gap*(d.weeks.length-1))/d.weeks.length);
  let bars='', xlab='', hits='';
  d.weeks.forEach((w,i)=>{
    const x=i*(cw+gap), h=Math.max(3,(BH-BB-BT)*w.days/maxd), y=BH-BB-h;
    const cur=i===d.weeks.length-1;
    // v227 (audit item 3): an empty week is a faint unlabeled stub, not a bar with a printed
    // "0" — the eye already reads a short bar as "nothing happened"; ten zeros in a row was
    // the loudest thing on the chart. Zero weeks also get their own fill so 0 and 1 differ.
    const shade = w.days===0?'var(--line)': w.days<=1?'var(--s1)': w.days<=2?'var(--s2)': w.days<=3?'var(--s3)':'var(--s4)';
    bars+=`<rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="4" fill="${shade}" ${cur?'style="stroke:var(--blue)" stroke-width="2"':''}/>`;
    // Per-bar counts earn their place at 4 and 13 bars. At 26 they become a wall of digits
    // above a chart whose job at that zoom is shape, not exact counts — the bar height and
    // shade already carry it, and the value is still available on tap. Zero is never printed.
    if(d.weeks.length <= 13 && w.days > 0)
      bars+=`<text x="${x+cw/2}" y="${y-3.5}" text-anchor="middle" font-size="9.5" font-weight="700" style="fill:${cur?'var(--fg)':'var(--muted)'}">${w.days}</text>`;
    hits+=`<rect x="${x-gap/2}" y="0" width="${cw+gap}" height="${BH-BB}" fill="transparent"><title>Week of ${w.weekOf}: ${w.days} day${w.days===1?'':'s'}</title></rect>`;
    if(i===0||cur) xlab+=`<text x="${cur?BW:0}" y="${BH-6}" text-anchor="${cur?'end':'start'}" font-size="9.5" style="fill:var(--muted)">${cur?'this week':shortDate(w.weekOf)}</text>`;
  });

  const nothingYet = !d.ready.length && !d.holds.length && !d.prs.length && !d.weeks.some(w=>w.days);
  const prHtml = d.prs.length
    ? d.prs.slice(0,10).map(p=>{
        // Three states, deliberately distinct: what you typed in, what you earned, and the
        // one-off moment real work passes a number you typed. Without the separation an
        // imported history silently swallows the first-real-record moment.
        if(p.source==='entered') return `<div class="pr pr-self">
          <div><div class="pr-n">${esc(p.exercise)} <span class="self-tag">you entered</span></div>
            <div class="pr-d">Starting best · beat it to set a record</div></div>
          <div class="pr-r"><div class="pr-w">${prLabel(p)}</div>
            ${p.goal?`<div class="pr-goal">goal ${p.goal} ${U}</div>`:''}</div></div>`;
        if(p.beatSeed) return `<div class="pr pr-beat">
          <div><div class="pr-n">${esc(p.exercise)}</div>
            <div class="pr-beat-was">Beat the <b>${p.seedWeight} × ${p.seedReps}</b> you entered</div></div>
          <div class="pr-r"><div class="pr-w">${prLabel(p)}</div>
            <div class="beat-chip">▲ Record beaten</div></div></div>`;
        return `<div class="pr">
          <div><div class="pr-n">${esc(p.exercise)}</div><div class="pr-d">${fmtDate(p.at)}</div></div>
          <div class="pr-r"><div class="pr-w">${prLabel(p)}</div>
            ${p.goal?`<div class="pr-goal">goal ${p.goal} ${U}</div>`:''}</div></div>`;
      }).join('')
    : `<div class="muted" style="padding:8px 2px">Log a workout — your first set of any exercise is a record.</div>`;

  $('app').innerHTML = `<div class="wrap">
    <h1>Progress</h1>
    <p class="sub">${nothingYet ? 'Log a workout and this fills in' : `${d.thisWeek} day${d.thisWeek===1?'':'s'} trained this week`}</p>
    ${nothingYet?`<button class="blue btn-new" onclick="createFlow()">+ New workout</button>`:''}

    <h2>Add weight next time</h2>
    <div class="card">${readyHtml}${soonHtml}${holdHtml}
      ${(d.ready.length||(d.soon||[]).length||d.holds.length)?`<div class="rulenote"><b>How it works:</b>
        reach the top of your rep range two sessions in a row <b>at the same weight</b> and the weight
        goes up. Warm-ups and drop sets don\'t count.</div>`:''}
    </div>

    ${plateauHtml}

    ${volTrendChart(d)}

    <h2>Consistency</h2>
    <div class="card">
      <!-- Sep 2 (Jeff, on the original average-led/blue-badge-streak version): "not the biggest
           fan" of this report. Researched what comparable apps (Hevy's own "gym consistency"
           feature) lead with -- streak length, not a raw average -- and a rejected/approved
           iteration cycle with Jeff landed here:
           - streak now leads the card (was a small badge off to the side; the average was the
             hero). Rejected direction along the way: a calendar/heatmap grid replacing the bar
             chart entirely ("Don't like the grid/squares look") -- the bar chart below is
             UNTOUCHED.
           - streak also rejected in green ("do you like that green idk i dont think so on this
             report") -- green is reserved for earned/celebratory moments elsewhere (PR pills, the
             recap's streak line) and a permanent hero number in that color diluted it. Plain text
             color instead.
           - the hero digit itself rejected bold ("don't bolden the number like that") -- see
             .streak-hero in the stylesheet for the lighter treatment that replaced it.
           - "this report just shows bars - will people know what they mean?" -- every other card
             on this page (Add weight, Volume trend) already has a "How it works" line; this one
             never did. Added below, matching that exact pattern. -->
      <div class="kpi"><div>
        ${(()=>{
          // v227: the headline average starts at your FIRST ACTIVE WEEK in the window, not the
          // window's start — someone 3 weeks into the app was seeing "0.4 days/week average"
          // because ten pre-signup weeks divided their honest effort. The caption dates the
          // window ("since Aug 10") so the number stays a true claim either way; when the
          // whole window is active it keeps the range label ("over 3 months").
          if(!d.weeks.some(w=>w.days)) return `<div class="hero" style="font-size:17px">No workouts logged yet</div>`;
          const firstIdx = d.weeks.findIndex(w=>w.days>0);
          const active = d.weeks.slice(firstIdx);
          const avg = (active.reduce((a,w)=>a+w.days,0)/active.length).toFixed(1);
          const cap = firstIdx===0
            ? `over ${(PROG_RANGES.find(r=>r.weeks===d.weeks.length)||{label:d.weeks.length+' weeks'}).label.toLowerCase()}`
            : `since ${shortDate(active[0].weekOf)}`;
          // No active streak (0 weeks) falls back to the plain average as the hero, same as
          // before this change — nothing to lead with otherwise.
          if(d.streakWeeks>0) return `<div class="streak-hero">${d.streakWeeks}<span class="hero-u"> week streak</span></div>
             <div class="hero-cap">${avg} days/week average, ${cap}</div>`;
          return `<div class="hero">${avg}<span class="hero-u"> days/week average</span></div>
             <div class="hero-cap">${cap}</div>`;
        })()}
      </div></div>
      ${d.weeks.some(w=>w.days)
        ? `<svg viewBox="0 0 ${BW} ${BH}" width="100%" style="display:block" role="img"
             aria-label="Days trained per week over ${d.weeks.length} weeks. Most recent: ${d.thisWeek} days.">${bars}${xlab}${hits}</svg>`
        : `<div class="muted" style="padding:14px 2px 6px;line-height:1.5">Your training weeks will
             chart here. Two or three a week is plenty to see a pattern.</div>`}
      <div class="seg wk-seg">
        ${PROG_RANGES.map(r=>`<button class="${PROG_WEEKS===r.weeks?'on':''}" onclick="setProgWeeks(${r.weeks})">${r.label}</button>`).join('')}
      </div>
      ${d.weeks.some(w=>w.days)?`<div class="rulenote"><b>How it works:</b> each bar is one week —
        its height (and the number on top) is how many days you trained that week. The current
        week is outlined.</div>`:''}
    </div>

    ${trendChart(d,U)}

    ${bodyweightChart(d,U)}

    <h2>Personal records</h2>
    <div class="card">${prHtml}</div>
  </div>`;
  if(!silent) window.scrollTo(0,0);
}
function setProgWeeks(w){ PROG_WEEKS=w; progressScreen({silent:true}); }

// ---- Library (two views: muscle groups -> exercises) ----
const LIB_MUSCLES = ['chest','lats','traps','biceps','triceps','forearms','shoulders','abdominals','quads','hamstrings','glutes','calves','cardio'];
const LIB_CATS = [
  { name:'Upper Body', muscles:['chest','lats','traps','biceps','triceps','forearms','shoulders'] },
  { name:'Lower Body', muscles:['quads','hamstrings','glutes','calves'] },
  { name:'Other', muscles:['abdominals','cardio'] },
];
// fav: whether the "★ Favorites" pill is active within the current muscle group's exercise list
// (libOpenMuscle) -- see FAVORITES/toggleFavorite below. Mutually exclusive with eq, same
// single-select behavior the existing equipment pills already have (picking one clears the other).
let LIB_STATE = { view:'groups', muscle:'', eq:'', q:'', fav:false };
// The current user's favorited exercise names (Jeff, Sep 1: "add a filter in the exercise library
// for favorites"). Exercises key off name everywhere in this file (DRAFT.exercises.find(x=>x.name
// ===e.name), libToggle, swapPick, ...) — there is no id to favorite by, so this is a Set of names,
// loaded once per library() visit (same lifetime as window._LIB2, which it's always checked
// alongside) and kept in sync locally by toggleFavorite() rather than re-fetched on every toggle.
let FAVORITES = new Set();
// ---- Add-exercise mode: open the Library so the user picks from there ----
let LIB_ADDMODE = false;
// ---- Quick Workout mode: LIB_ADDMODE picks exercises for a session that does not exist on the
// server yet. libDone() creates it (only if at least one exercise was picked) instead of routing
// back to the create-flow wizard's own Save button — see workoutNow() below. Must be reset in
// resetTransientModes() same as every other mode here, or walking away via the bottom nav mid-pick
// leaves it stuck true and the next ordinary "+ Add exercise" silently tries to create a session
// instead of returning to whatever it was actually editing.
let QUICK_ADD_MODE = false;
// ---- Swap mode: open the Library so the user picks a real exercise as the swap-to target ----
let SWAP_MODE = false;
let SWAP_SESSION = null;
let SWAP_FROM = null;
// v254 Finding-4 fix: history.length at the moment the picker opened, so cancel/pick can pop
// back exactly as many entries as browsing inside the picker actually pushed -- see
// backToSessionAfterSwapPicker's comment just above openSwapPicker.
let SWAP_ENTRY_HISTORY_LEN = 0;
// v262b: Suggest-add mode -- same idea as swap mode above, open the Library so the user picks a
// real exercise, but this proposes adding it fresh rather than replacing SWAP_FROM (there is no
// FROM here). Reuses SWAP_ENTRY_HISTORY_LEN itself (see openSuggestAddPicker's comment).
let SUGGEST_ADD_MODE = false;
let SUGGEST_ADD_SESSION = null;
// Seed-your-lifts mode (Jeff, Sep 1, "worth doing next" #1) -- same idea again, open the Library
// so the user picks a real exercise for the "+ Add another lift" row on the seed-setup screen (see
// seedSetupScreen below). Unlike Swap/Suggest-add there's no session id to route the pick through --
// picking just pushes a blank row onto SEED_DRAFT and returns -- so no companion *_SESSION variable.
let SEED_MODE = false;
function openAddExercises(){
  // stash details typed so far on the workout form
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  if($('wname')) DRAFT.name = $('wname').value;
  // visibility and the scheduled date/time were missing here — createFlow() re-renders the
  // <select id="vis"> and <input id="dt"> from these DRAFT fields on return, so leaving them
  // unstashed silently reverted Friends-only back to Private (and the date/time to blank) the
  // moment you tapped "+ Add exercise". See test/create-flow-draft-persist.mjs.
  if($('vis')) DRAFT.visibility = $('vis').value;
  if($('dt')) DRAFT._dt = $('dt').value;
  LIB_ADDMODE = true;
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;   // never both at once
  SUGGEST_ADD_MODE = false; SUGGEST_ADD_SESSION = null;       // never both at once
  showTab('lib', true);   // identical to tapping the bottom Workouts tab
}
function libDone(){
  LIB_ADDMODE = false;
  if(QUICK_ADD_MODE){
    QUICK_ADD_MODE = false;
    // Nothing picked, nothing created — same as never having tapped "Quick Workout" at all.
    // showTab(), not home() directly: entering the picker went through showTab('lib', true), which
    // highlighted the Workouts nav tab, and only showTab() un-highlights it again.
    if(!DRAFT.exercises.length){ showTab('home'); return; }
    promptQuickWorkoutName();
    return;
  }
  TPL_MODE.active ? templateExercises() : createFlow();
}
// Jeff, Aug 30: "I want to be able to name quick workouts" -- Quick Workout always hardcoded the
// name to the literal string "Quick Workout" (see createQuickWorkout above). This is the one place
// both quick-workout entry points (picking exercises one at a time in libDone() above, and picking
// a saved routine in quickUseRoutine above) funnel through on their way to actually creating the
// session, so the prompt lives here once rather than twice. defaultName is the routine's own name
// when coming from quickUseRoutine, or blank when coming from the picked-exercises path -- either
// way Skip/blank falls back to the same "Quick Workout" createQuickWorkout() always used, so doing
// nothing still behaves exactly like it did before this feature existed.
function promptQuickWorkoutName(defaultName){
  textEntrySheet({
    title:'Name this workout', label:'Workout name', value: defaultName||'', placeholder:'Quick Workout', confirmLabel:'Start', cancelLabel:'Skip',
    onConfirm: name => createQuickWorkout(name),
    onCancel: () => createQuickWorkout(defaultName||''),
  });
  // Tapping the backdrop must behave exactly like Skip (create with the default name), not
  // textEntrySheet's normal backdrop behavior of just closing with nothing done -- unlike every
  // other textEntrySheet caller (editBio, editPostNotes, ...), the thing being named here doesn't
  // exist yet. Dismissing without creating it would strand the already-picked exercises with
  // QUICK_ADD_MODE already cleared and no session ever created, so the very next tap of the
  // picker's own "Done" button (still QUICK_ADD_MODE:false at that point) would fall through into
  // the wrong flow entirely (createFlow()'s full wizard) instead of trying to create the quick
  // workout again. Reuses window._teCancel — the exact same double-tap-guarded path Skip itself
  // runs — rather than duplicating it here.
  if(TE_EL) TE_EL.onclick = (e)=>{ if(e.target===TE_EL) window._teCancel(); };
}
async function library(opts){
  // v254: library() is BOTH the 'lib' tab root (via showTab/renderTabState, which pass
  // opts.silent -- they already own the nav push/scroll for the tab switch, same reasoning as
  // friends()/home()) AND a real drill-BACK target from libOpenMuscle's "‹ All muscles" button
  // (no opts -- a genuine in-app nav, pushes its own {t:'library'} entry) and from popstate
  // restoring that entry (opts.fromHistory -- land, don't push again). submitCreateEx's
  // same-screen refresh after adding a custom exercise also passes opts.silent.
  const silent = !!(opts && opts.silent);
  const fromHistory = !!(opts && opts.fromHistory);
  LIB_STATE = { view:'groups', muscle:'', eq:'', q:'', fav:false };
  // Fetched together — favorites are read alongside the library every time library() runs (same
  // "computed per request" spirit as /api/exercises itself, see its own comment), not cached
  // across visits, so a favorite toggled from one screen (or a different device) is never stale
  // the next time the library opens.
  const [lib, favs] = await Promise.all([H.get('/api/exercises'), H.get('/api/favorites')]);
  window._LIB2 = lib;
  FAVORITES = new Set((favs && favs.exercises) || []);
  const head = LIB_ADDMODE
    ? `<div class="pick-head lib-head">
         <h1 style="flex:1">${QUICK_ADD_MODE?'Quick Workout':'Workouts'}</h1>
         <button class="icon-btn" onclick="openCreateEx()" title="Create exercise">＋</button>
         <button class="blue sm" onclick="libDone()">Done (<span id="libDoneCount">${DRAFT.exercises.length}</span>)</button>
       </div>`
    : SWAP_MODE
    ? `<div class="pick-head lib-head">
         <button class="sec sm" onclick="swapCancel()">‹ Cancel</button>
         <h1 style="flex:1;font-size:18px">Pick replacement</h1>
       </div>`
    : SUGGEST_ADD_MODE
    ? `<div class="pick-head lib-head">
         <button class="sec sm" onclick="suggestAddCancel()">‹ Cancel</button>
         <h1 style="flex:1;font-size:18px">Add which exercise?</h1>
       </div>`
    : SEED_MODE
    ? `<div class="pick-head lib-head">
         <button class="sec sm" onclick="seedPickerCancel()">‹ Cancel</button>
         <h1 style="flex:1;font-size:18px">Add a lift</h1>
       </div>`
    : `<div class="pick-head lib-head">
         <h1 style="flex:1">Workouts</h1>
         <button class="txt-btn" onclick="templatesPage()" title="Routines">Routines</button>
         <button class="icon-btn" onclick="openCreateEx()" title="Create exercise">＋</button>
       </div>`;
  $('app').innerHTML = `<div class="pick">${head}
    ${QUICK_ADD_MODE?`<div style="display:flex;justify-content:flex-end;padding:0 2px 10px">
      <button class="sec sm" onclick="quickPickRoutine()">Routine</button>
    </div>`:''}
    <div class="pick-search"><input id="ls" placeholder="Search exercises" oninput="libSearch(this.value)"></div>
    <div class="pick-list" id="lib2"></div>
  </div>`;
  renderLibGroups();
  if(!silent){ const st={t:'library'}; fromHistory ? landOn(st) : navigated(st); }
}
function renderLibGroups(){
  const lib = window._LIB2;
  const q = LIB_STATE.q;
  if(q){
    const matches = lib.filter(e =>
      (!SEED_MODE || !e.custom) &&
      (exName(e).toLowerCase().includes(q) ||
      (e.muscle_groups||[]).join(' ').toLowerCase().includes(q) ||
      eqList(e).join(' ').toLowerCase().includes(q))
    ).sort((a,b)=>exName(a).localeCompare(exName(b)));
    $('lib2').innerHTML = matches.length ? `<div class="card">${matches.map(exRowHtml).join('')}</div>`
      : '<div class="muted" style="padding:20px;text-align:center">No exercises found.</div>';
    return;
  }
  // SEED_MODE (seed-setup's "+ Add another lift" picker) only ever offers base-library exercises --
  // PUT /api/me/seeds rejects anything else (server.js) -- so custom rows are excluded from both the
  // per-muscle counts here and the filtered list in renderLibExercises below.
  const counts = {}; LIB_CATS.forEach(c=>c.muscles.forEach(m=>counts[m]=0));
  lib.forEach(e=>{ if(SEED_MODE && e.custom) return; (e.muscle_groups||[]).forEach(m=>{ if(m in counts) counts[m]++; }); });
  const blocks = LIB_CATS.map(cat=>{
    const rows = cat.muscles.map(m=>`
      <div class="mg-card" onclick="libOpenMuscle('${m}')">
        <div class="mg-ico">${mgIcon(m)}</div>
        <div class="mg-card-body"><div class="mg-card-name">${esc(m)}</div><div class="mg-card-count">${counts[m]} exercises</div></div>
        <div class="mg-chev">›</div>
      </div>`).join('');
    return `<div class="lib-cat">${esc(cat.name)}</div><div class="card">${rows}</div>`;
  }).join('');
  $('lib2').innerHTML = blocks;
}
function libOpenMuscle(m, opts){
  // v254: same silent/fromHistory shape as library() -- see its comment just above. The only
  // silent caller is submitCreateEx's same-screen refresh; the only fromHistory caller is popstate.
  const silent = !!(opts && opts.silent);
  const fromHistory = !!(opts && opts.fromHistory);
  LIB_STATE.view='muscle'; LIB_STATE.muscle=m; LIB_STATE.eq=''; LIB_STATE.q=''; LIB_STATE.fav=false;
  const eqs = [...new Set(window._LIB2.filter(e=>(e.muscle_groups||[]).includes(m)).flatMap(eqFamilies))];
  const head = LIB_ADDMODE
    ? `<div class="pick-head lib-head">
         <button class="sec sm" onclick="library()">‹ All muscles</button>
         <h1 style="flex:1;font-size:18px;text-transform:capitalize">${esc(m)}</h1>
         <button class="icon-btn" onclick="openCreateEx('${m}')" title="Create exercise">＋</button>
         <button class="blue sm" onclick="libDone()">Done (<span id="libDoneCount">${DRAFT.exercises.length}</span>)</button>
       </div>`
    // Cold-review catch: SWAP_MODE/SUGGEST_ADD_MODE fall through to the plain default header just
    // below (an existing, unrelated quirk -- out of scope here), but SEED_MODE can't: it's the one
    // picker mode that's actually RESTRICTED to base-library exercises (PUT /api/me/seeds 400s on
    // anything else), so leaving "Routines" (silently abandons SEED_MODE/SEED_DRAFT -- templatesPage
    // doesn't call resetTransientModes) and "Create exercise" (creates something the filter above
    // immediately hides, a confusing dead end) reachable here would contradict the screen's own
    // restriction the moment someone drills into a muscle group instead of using the top-level search.
    : SEED_MODE
    ? `<div class="pick-head lib-head">
         <button class="sec sm" onclick="library()">‹ All muscles</button>
         <h1 style="flex:1;font-size:18px;text-transform:capitalize">${esc(m)}</h1>
       </div>`
    : `<div class="pick-head lib-head">
         <button class="sec sm" onclick="library()">‹ All muscles</button>
         <h1 style="flex:1;font-size:18px;text-transform:capitalize">${esc(m)}</h1>
         <button class="txt-btn" onclick="templatesPage()" title="Routines">Routines</button>
         <button class="icon-btn" onclick="openCreateEx('${m}')" title="Create exercise">＋</button>
       </div>`;
  $('app').innerHTML = `<div class="pick">${head}
    <div class="pick-search"><input id="ls" placeholder="Search ${esc(m)}" oninput="libSearch(this.value)"></div>
    <div class="cat-pills eq-pills" id="eqPills2">
      <span class="cat-pill on" data-eq="" onclick="pickEq2(this)">Any</span>
      <!-- Jeff, Sep 1: "when adding exercises to a workout you can click the favorite tab for
           each individual muscle group to make things more convenient when creating workouts."
           One pill per muscle group's own filter row, same single-select behavior as the
           equipment pills beside it (picking this clears eq, picking an eq pill clears this --
           see pickFav2/pickEq2) rather than a combinable second filter, so there's exactly one
           interaction model to learn here, not two. -->
      <span class="cat-pill fav-pill" data-fav="1" onclick="pickFav2(this)">★ Favorites</span>
      ${eqs.map(k=>`<span class="cat-pill" data-eq="${k}" onclick="pickEq2(this)">${eqLabel(k)}</span>`).join('')}
    </div>
    <div class="pick-list" id="lib2"></div>
  </div>`;
  renderLibExercises();
  if(!silent){ const st={t:'muscle', m}; fromHistory ? landOn(st) : navigated(st); }
}
function pickEq2(el){
  LIB_STATE.eq = el.dataset.eq; LIB_STATE.fav = false;
  document.querySelectorAll('#eqPills2 .cat-pill').forEach(p=>p.classList.toggle('on', p===el));
  renderLibExercises();
}
function pickFav2(el){
  LIB_STATE.eq = ''; LIB_STATE.fav = true;
  document.querySelectorAll('#eqPills2 .cat-pill').forEach(p=>p.classList.toggle('on', p===el));
  renderLibExercises();
}
function libSearch(v){ LIB_STATE.q=(v||'').toLowerCase(); applyLibSearch(); }
function applyLibSearch(){
  if(LIB_STATE.view==='muscle') renderLibExercises();
  else renderLibGroups();
}
function exRowHtml(e){
  if(SWAP_MODE){
    return `<div class="ex-row" onclick="swapPick('${jsq(e.name)}')">
        <div class="ex-main">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-mg">${esc((e.muscle_groups||[]).slice(0,2).join(' · '))}${e.custom?' · your exercise':''}</div>
        </div>
        <div class="ex-badges">${exBadges(e)}</div>
        <div class="mg-chev">›</div>
      </div>`;
  }
  if(SUGGEST_ADD_MODE){
    return `<div class="ex-row" onclick="suggestAddPick('${jsq(e.name)}')">
        <div class="ex-main">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-mg">${esc((e.muscle_groups||[]).slice(0,2).join(' · '))}${e.custom?' · your exercise':''}</div>
        </div>
        <div class="ex-badges">${exBadges(e)}</div>
        <div class="mg-chev">›</div>
      </div>`;
  }
  if(SEED_MODE){
    // No "· your exercise" suffix here -- custom rows never reach this branch (renderLibGroups/
    // renderLibExercises already filter them out, see their comments), so it would never fire.
    return `<div class="ex-row" onclick="seedPickerPick('${jsq(e.name)}')">
        <div class="ex-main">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-mg">${esc((e.muscle_groups||[]).slice(0,2).join(' · '))}</div>
        </div>
        <div class="ex-badges">${exBadges(e)}</div>
        <div class="mg-chev">›</div>
      </div>`;
  }
  const added = DRAFT.exercises.find(x=>x.name===e.name);
  if(LIB_ADDMODE){
    // Jeff, Sep 1: "allowing you to favorite when building a workout" -- the star lives here too,
    // not just the plain-browsing row below, so favoriting doesn't require leaving the picker.
    return `<div class="ex-row ${added?'ex-on':''}" onclick="libToggle('${jsq(e.name)}', this)">
        <div class="ex-main">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-mg">${esc((e.muscle_groups||[]).slice(0,2).join(' · '))}${e.custom?' · your exercise':''}</div>
        </div>
        <div class="ex-badges">${exBadges(e)}</div>
        ${favBtnHtml(e)}
        <div class="ex-add">${added?'✓':'+'}</div>
      </div>`;
  }
  return `<div class="ex-row" onclick="exDetail('${jsq(e.name)}')">
      <div class="ex-main">
        <div class="ex-name">${esc(e.name)}</div>
        <div class="ex-mg">${esc((e.muscle_groups||[]).slice(0,2).join(' · '))}${e.custom?' · your exercise':''}</div>
      </div>
      <div class="ex-badges">${exBadges(e)}</div>
      ${favBtnHtml(e)}
      <div class="mg-chev">›</div>
    </div>`;
}
function libToggle(name, el){
  addEx(name, el);
  const n=$('libDoneCount'); if(n) n.textContent=DRAFT.exercises.length;
}
function renderLibExercises(){
  const {muscle,eq,q,fav}=LIB_STATE;
  const list = window._LIB2.filter(e=>
    (e.muscle_groups||[]).includes(muscle) &&
    (!SEED_MODE || !e.custom) &&
    (!eq || eqFamilies(e).includes(eq)) &&
    (!fav || FAVORITES.has(e.name)) &&
    (!q || exName(e).toLowerCase().includes(q) || (e.muscle_groups||[]).join(' ').includes(q))
  ).sort((a,b)=>exName(a).localeCompare(exName(b)));
  $('lib2').innerHTML = list.length ? `<div class="card">${list.map(exRowHtml).join('')}</div>`
    // Distinct copy for the empty-Favorites case -- "No exercises here" reads like this muscle
    // group has nothing at all, which would be actively wrong (and confusing) when the real
    // reason is just that nothing here is starred yet.
    : fav ? '<div class="muted" style="padding:20px;text-align:center">No favorites here yet — tap the star on an exercise to add one.</div>'
    : SEED_MODE ? '<div class="muted" style="padding:20px;text-align:center">No library exercises here -- starting weights can only be set on built-in exercises.</div>'
    : '<div class="muted" style="padding:20px;text-align:center">No exercises here.</div>';
}
function openCreateEx(presetMuscle){
  const msel = LIB_MUSCLES.map(m=>`<option value="${m}" ${presetMuscle===m?'selected':''}>${m}</option>`).join('');
  const eqOpts = EQ_FAMILY.map(f=>`<option value="${f.key}">${f.label}</option>`).join('');
  history.pushState({t:'sheet'}, '', location.href); // v254: Back dismisses this sheet -- see openSheetHtml's comment
  const sheet = document.createElement('div'); sheet.className='sheet-back';
  sheet.innerHTML=`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Create exercise</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <label class="muted">Name</label><input id="ceName" placeholder="e.g. Cable Crossover">
      <label class="muted">Primary muscle</label><select id="ceMg">${msel}</select>
      <label class="muted">Equipment</label><select id="ceEq">${eqOpts}</select>
      <label class="muted">Level</label><select id="ceLv"><option>beginner</option><option>intermediate</option><option>advanced</option></select>
      <label class="muted">Type</label><select id="ceType"><option value="0">Isolation</option><option value="1">Compound</option></select>
      <button class="blue" style="margin-top:14px;width:100%" onclick="submitCreateEx()">Save exercise</button>
    </div>`;
  sheet.onclick=(e)=>{ if(e.target===sheet) closeSheet(); }; document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
  const ceBtn=document.getElementById('ceName'); if(ceBtn) setTimeout(()=>ceBtn.focus(),60);
}
async function submitCreateEx(){
  const name=($('ceName').value||'').trim(); if(!name) return alert('Enter a name');
  const muscle=$('ceMg').value;
  const payload={ name, muscle_groups:[muscle], equipment:[eqLabel($('ceEq').value).toLowerCase()], level:$('ceLv').value, is_compound:$('ceType').value==='1' };
  const r = await H.post('/api/exercises/custom', payload);
  if(r.error) alert(r.error); else { closeSheet(); if(LIB_STATE.view==='muscle') libOpenMuscle(LIB_STATE.muscle, {silent:true}); else library({silent:true}); }
}
function exDetail(name){
  const e = window._LIB2.find(x=>x.name===name); if(!e) return;
  const sets = e.defaultSets||3, reps=e.defaultReps||10;
  const eqs = eqList(e).map(x=>esc(x)).join(', ')||'—';
  history.pushState({t:'sheet'}, '', location.href); // v254: Back dismisses this sheet -- see openSheetHtml's comment
  const sheet = document.createElement('div'); sheet.className='sheet-back'; sheet.innerHTML=`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>${esc(e.name)}</h2>${favBtnHtml(e)}<button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="sheet-thumb">${exThumb(e)}<span class="sheet-thumb-cap">${esc((e.muscle_groups||[])[0]||'abdominals')}</span></div>
      <div class="sheet-mg">${esc((e.muscle_groups||[]).join(' · '))}</div>
      <div class="ex-badges" style="margin:8px 0">${exBadges(e)}</div>
      <div class="sheet-row"><span>Equipment</span><b>${eqs}</b></div>
      <div class="sheet-row"><span>Pattern</span><b>${esc(e.pattern||'—')}</b></div>
      <div class="sheet-row"><span>Suggested</span><b>${sets} × ${reps}</b></div>
    </div>`;
  sheet.onclick=(e)=>{ if(e.target===sheet) closeSheet(); }; document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
}
// v247: used to be document.querySelector('.sheet-back') — the FIRST .sheet-back in document
// order, i.e. the OLDEST open sheet. Almost every call site only ever has one sheet open, so this
// went unnoticed, but editLogSet stacks a second .sheet-back on top of the still-open log sheet
// (tapping a set row while the log sheet is up), and the first-in-order one is the log sheet
// underneath, not the edit-set sheet on top. Cancel/✕ on the edit-set sheet was closing the log
// sheet behind it instead of itself, and Save's closeSheet() call was doing the same — leaving
// the actual edit-set sheet node behind as a zombie that ate an extra tap to clear. Closing the
// LAST .sheet-back instead closes whichever sheet is topmost/frontmost, which is always the one
// whose own ✕/backdrop/Cancel the person just tapped.
// v254: `fromPopstate` is passed ONLY by the popstate handler above (Back while a sheet is open),
// which has already moved the history pointer itself -- this must not touch history in that case.
// Closing via the sheet's own UI (✕, backdrop tap, a confirm action) is the normal case: that
// sheet's own pushed entry (see openSheetHtml below) is still sitting on top of the stack, so it's
// replaced with CURRENT_NAV_STATE -- otherwise it'd leave a stale 'sheet' marker for a later Back
// to land on, and Back right after closing would need an extra press to get past it. Only done when
// this was the LAST sheet in the stack (l.length===1): a sheet closing out of a still-stacked group
// leaves its own entry alone, since the sheet beneath it is still open and still needs its own
// Back press.
function closeSheet(fromPopstate){
  const l=document.querySelectorAll('.sheet-back'); const s=l[l.length-1];
  if(s){ s.classList.remove('show'); setTimeout(()=>s.remove(),200); }
  if(s && !fromPopstate && l.length===1) history.replaceState(CURRENT_NAV_STATE, '', location.href);
}
// For the couple of call sites (saveLogSet, delLogSetConfirmed) that are about to replace
// EVERYTHING currently open with one freshly-reloaded sheet — closeSheet() alone would only take
// down the topmost one, leaving whatever is stacked underneath (stale pre-edit data) to resurface
// later as a zombie once the fresh sheet closes (cold-review catch, v247).
// v254: closeAllSheets() closes EVERY open sheet at once (saveLogSet/delLogSetConfirmed use it
// because editLogSet stacks a second sheet on top of the log sheet it opened from -- see their own
// comments). However many {t:'sheet'} entries were pushed while those sheets were open, none of
// them are live afterward, so they're all collapsed back to CURRENT_NAV_STATE here -- otherwise a
// later Back press pops through stale 'sheet' markers with no sheet left to dismiss, and the
// popstate handler's own fallback for an unrecognized state strands the user on the Home tab
// rather than wherever they actually were. Both callers immediately reopen a fresh sheet right
// after this (openLogSheet), which pushes its own new entry on top -- net one entry per one
// actually-open sheet, same invariant closeSheet()/dismissConfirm() keep for the single-sheet case.
function closeAllSheets(){
  const hadSheets = document.querySelectorAll('.sheet-back').length > 0;
  document.querySelectorAll('.sheet-back').forEach(s=>{ s.classList.remove('show'); setTimeout(()=>s.remove(),200); });
  if(hadSheets) history.replaceState(CURRENT_NAV_STATE, '', location.href);
}
// v254: pushes its own {t:'sheet'} history entry so the hardware/gesture Back button dismisses
// the sheet (via the popstate handler above) instead of leaving the app entirely or landing on
// whatever screen was last tracked underneath. See closeSheet()'s comment for the matching half.
function openSheetHtml(inner){ UI_EPOCH++; history.pushState({t:'sheet'}, '', location.href); const s=document.createElement('div'); s.className='sheet-back'; s.onclick=(e)=>{ if(e.target===s) closeSheet(); }; s.innerHTML=inner; document.body.appendChild(s); requestAnimationFrame(()=>s.classList.add('show')); return s; }
// A single in-app bottom sheet for free-text entry. Jeff, Aug 27: "when I go to add a bio or
// notes etc I don't want a separate iPhone style pop up to happen to input... I want it to stay
// within the app." The browser's own prompt() is a native OS dialog entirely outside the app's
// own design, and it forces every field into one cramped, unresizable line no matter how long
// the text is meant to be. tplNew()/tplQuickSaveSheet() already used exactly this sheet shape
// for template naming -- this generalizes that pattern (label + input/textarea + Cancel/Save)
// so every other prompt()-based text entry in the app (bio, default gym, a workout-changes
// note, template naming) gets the same in-app sheet, and multi-line fields get a real,
// multi-row textarea instead of one line.
// v251 (audit finding): same double-tap shape confirmSheet() was fixed for in v250, but worse --
// a double-tap on whatever opens this (edit bio, default gym, workout notes, template naming...)
// used to stack two sheets, each with its own id="teVal" field. window._teConfirm/_teCancel got
// overwritten to the SECOND call's closure, but $('teVal') = getElementById('teVal') resolves to
// the FIRST matching id in document order -- the first (hidden, stale) sheet -- so tapping Save on
// the sheet you can actually see read and submitted the OTHER sheet's old value, then closeSheet()
// only removed the topmost sheet, leaving the first one behind as a visible zombie. Not just a
// stuck popup like the confirmSheet bug -- silently wrong data saved. Tracked the same way:
// removing any already-open text-entry sheet immediately before opening a new one, so at most one
// ever exists and $('teVal') can only ever resolve to it.
let TE_EL = null;
function textEntrySheet({title, label, value, placeholder, multiline, confirmLabel, cancelLabel, onConfirm, onCancel}){
  if(TE_EL){ TE_EL.remove(); TE_EL = null; }
  const cur = value||'';
  const field = multiline
    ? `<textarea id="teVal" placeholder="${esc(placeholder||'')}" style="min-height:110px">${esc(cur)}</textarea>`
    : `<input id="teVal" placeholder="${esc(placeholder||'')}" value="${esc(cur)}" autocomplete="off">`;
  TE_EL = openSheetHtml(`<div class="sheet"><div class="sheet-head"><h2>${esc(title)}</h2></div>
    ${label?`<label class="muted">${esc(label)}</label>`:''}
    ${field}
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="sec" style="flex:1" onclick="_teCancel()">${esc(cancelLabel||'Cancel')}</button>
      <button class="blue" style="flex:1" onclick="_teConfirm()">✓ ${esc(confirmLabel||'Save')}</button>
    </div></div>`);
  // Stashed on window (not a closure the buttons' inline onclick can reach) and reassigned per
  // open -- only one text-entry sheet is ever open at a time (now actually enforced above, not
  // just assumed), same as closeSheet()'s single .sheet-back assumption elsewhere in this file.
  // Also guards the narrower double-submit variant of the same bug: closeSheet()'s own 200ms
  // fade leaves the sheet (and its buttons) present-but-fading, so a second rapid tap on Save/
  // Cancel itself -- not just on whatever opened the sheet -- could otherwise still hit a live
  // handler and fire onConfirm/onCancel a second time. Rebinding both to a no-op the instant
  // either fires makes any further tap on that same fading sheet inert.
  window._teConfirm = ()=>{ const v=$('teVal').value; TE_EL=null; window._teConfirm=window._teCancel=()=>{}; closeSheet(); onConfirm(v); };
  window._teCancel = ()=>{ TE_EL=null; window._teConfirm=window._teCancel=()=>{}; closeSheet(); if(onCancel) onCancel(); };
  setTimeout(()=>{ const i=$('teVal'); if(i) i.focus(); }, 60);
}

// ---- Templates ----
async function templates(){
  const { mine, shared } = await H.get('/api/templates');
  let html = `<div class="wrap"><h1>Routines</h1><div class="muted">Saved routines — reuse on your next workout</div>`;
  if(mine.length){
    html += `<h2>Yours</h2>`;
    for(const t of mine) html += `<div class="lib-item"><div><b>${esc(t.name)}</b><div class="tag">${plur(t.exercises.length,'exercise')}</div></div><button class="sm" onclick="useTpl('${t.id}')">Use</button></div>`;
  }
  if(shared.length){
    html += `<h2>From friends</h2>`;
    for(const t of shared) html += `<div class="lib-item"><div><b>${esc(t.name)}</b><div class="tag">${plur(t.exercises.length,'exercise')}</div></div><button class="sm" onclick="useTpl('${t.id}')">Use</button></div>`;
  }
  if(!mine.length && !shared.length) html += `<div class="card muted">No routines created. Create a workout and choose "Save as routine".</div>`;
  html += `</div>`;
  $('app').innerHTML = html;
  window.scrollTo(0,0);
}
async function useTpl(id){
  const { mine, shared } = await H.get('/api/templates');
  const t = [...mine, ...shared].find(x=>x.id===id);
  if(!t) return;
  DRAFT.exercises = t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax}));
  createFlow();
}

// Real photo when the user has one (same field ME.avatar already uses on Home), initials
// circle otherwise — one place so every avatar spot on the Friends page (list, requests,
// search) stays consistent instead of some showing photos and others showing letters.
function avatarHtml(x, cls){
  const initial = esc((x.displayName||x.username||'?')[0]||'?');
  return x.avatar
    ? `<img class="${cls}" src="${esc(x.avatar)}" alt="">`
    : `<div class="${cls}" style="background:${avatarColor(x.username)};color:#fff">${initial}</div>`;
}
async function friends(opts){
  // v254: friends() is a pure tab root (only reached via showTab, which already resets scroll/
  // history for the tab switch) -- EXCEPT it's also re-invoked by acceptRequest/rejectRequest/
  // acceptFollow/rejectFollow to quietly refresh the same list in place after an approve/reject
  // tap. opts.silent (set by those 4) keeps the scroll-to-top below from firing on that quiet
  // refresh -- without it, approving a request halfway down a long list would yank the screen
  // back to the top, same class of bug openSession's opts.silent already guards against.
  const silent = !!(opts && opts.silent);
  const data = await H.get('/api/friends');
  const f = data.friends||[]; const inc = data.incoming||[]; const out = data.outgoing||[]; const freq = data.followRequests||[];
  const flame = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 3-1 4-2 6-1 2 0 4 2 4 1.5 0 2-1 2-2 2 1 3 3 3 5 0 3-3 5-6 5-4 0-7-3-7-7 0-4 4-8 8-11z"/></svg>';
  const friendRows = f.length ? f.map(x=>`
    <div class="friend-row" onclick="profileView('${x.id}')" style="cursor:pointer">
      ${avatarHtml(x,'avatar')}
      <div class="meta">
        <div class="name">${esc(x.displayName||x.username)}</div>
        <div class="handle">@${esc(x.username)}</div>
        ${x.streak>1?`<div class="streak-pill">${flame}${x.streak} day streak</div>`:''}
      </div>
    </div>`).join('')
    : homeEmpty(ICON_PEOPLE, 'No friends yet', 'Search above to find people to train with.');
  const reqRows = inc.length ? inc.map(x=>`
    <div class="req">
      ${avatarHtml(x,'av')}
      <div class="rc"><b>${esc(x.displayName||x.username)}</b> wants to train with you</div>
      <div class="ra">
        <button class="sm ok" onclick="acceptRequest('${x.reqId}')">Approve</button>
        <button class="sm no" onclick="rejectRequest('${x.reqId}')">Reject</button>
      </div>
    </div>`).join('')
    : '<div class="muted" style="padding:4px 0">No pending requests.</div>';
  const followReqRows = freq.length ? freq.map(x=>`
    <div class="req">
      ${avatarHtml(x,'av')}
      <div class="rc"><b>${esc(x.displayName||x.username)}</b> wants to follow you</div>
      <div class="ra">
        <button class="sm ok" onclick="acceptFollow('${x.id}')">Approve</button>
        <button class="sm no" onclick="rejectFollow('${x.id}')">Reject</button>
      </div>
    </div>`).join('') : '';
  const pending = inc.length + freq.length;
  const badge = pending ? `<span class="badge">${pending}</span>` : '';
  $('app').innerHTML = `<div class="wrap">
    <div class="h1-row"><h1>Friends</h1>${badge}</div>
    <div class="card">
      <!-- Jeff, Aug 27: "search bar text does not fit properly" -- the placeholder was getting
           clipped because a "Search" button sat next to the input eating its width, even though
           the input already searches live on every keystroke (oninput below) -- the button never
           did anything a keystroke hadn't already done. Dropping it gives the placeholder the
           full row and removes a genuinely redundant control at the same time. -->
      <div class="add-row">
        <input id="fu" placeholder="Search people by name or @username" autocomplete="off" oninput="friendSearch()">
      </div>
      <div id="fresults"></div>
    </div>
    ${freq.length?`<h2>Follow requests</h2><div class="card" style="padding:6px 12px">${followReqRows}</div>`:''}
    ${inc.length?`<h2>Friend requests</h2><div class="card" style="padding:6px 12px">${reqRows}</div>`:''}
    <h2>Friends</h2>
    ${f.length ? `<div class="card" style="padding:6px 12px">${friendRows}</div>` : friendRows}
  </div>`;
  if(!silent) window.scrollTo(0,0);
}
async function friendSearch(){
  const q = ($('fu').value||'').trim();
  const box = document.getElementById('fresults');
  if(!q){ if(box) box.innerHTML=''; return; }
  try {
    const hits = await H.get('/api/users/search?q='+encodeURIComponent(q));
    if(!box) return;
    if(!hits.length){ box.innerHTML='<div class="muted" style="padding:8px 2px">No people found.</div>'; return; }
    box.innerHTML = hits.map(x=>{
      const btn = x.requestStatus==='friends' ? `<button class="sm" disabled style="background:var(--line);border-color:transparent;color:var(--muted)">Friends</button>`
        : x.requestStatus==='sent' ? `<button class="sm" disabled style="background:var(--line);border-color:transparent;color:var(--muted)">Requested</button>`
        : `<button class="sm sec" onclick="sendRequest('${jsq(x.username)}', this)">Add</button>`;
      // Jeff, Aug 27: "the add button or showing if your friends or not is directly under the
      // name" -- this row used a "user-row" class that had no CSS rule anywhere, so the avatar,
      // name/handle, and button just stacked as plain block boxes instead of sitting in a row.
      // .friend-row (used two lines down for the real Friends list) is exactly this same
      // avatar + growing name/handle + trailing control layout, already correct -- reusing it
      // here instead of inventing new CSS.
      return `<div class="friend-row">${avatarHtml(x,'avatar')}<div class="meta"><div class="name">${esc(x.displayName||x.username)}</div><div class="handle">@${esc(x.username)}</div></div>${btn}</div>`;
    }).join('');
  } catch(e){ if(box) box.innerHTML=''; }
}
async function sendRequest(username, btn){
  const r = await H.post('/api/friends/request',{username});
  if(r.error){ alert(r.error); return; }
  if(btn){ btn.textContent='Requested'; btn.className='sm'; btn.disabled=true; btn.style.background='var(--line)'; btn.style.borderColor='transparent'; btn.style.color='var(--muted)'; }
}
// v252 (audit finding): all four below re-rendered the Friends tab unconditionally after their
// await, same barge-in shape as the rest of this round -- tap Accept, switch to Home before it
// resolves, and the stale response used to snap the screen back to Friends anyway.
async function acceptRequest(id){
  const epoch=UI_EPOCH;
  const r = await H.post('/api/friends/accept',{from:id});
  if(r.error) alert(r.error); else if(nothingNavigatedSince(epoch)) friends({silent:true});
}
async function rejectRequest(id){
  const epoch=UI_EPOCH;
  const r = await H.post('/api/friends/reject',{from:id});
  if(r.error) alert(r.error); else if(nothingNavigatedSince(epoch)) friends({silent:true});
}
async function acceptFollow(id){
  const epoch=UI_EPOCH;
  const r = await H.post('/api/follow-requests/'+id+'/accept',{});
  if(r && r.error) alert(r.error); else if(nothingNavigatedSince(epoch)) friends({silent:true});
}
async function rejectFollow(id){
  const epoch=UI_EPOCH;
  const r = await H.post('/api/follow-requests/'+id+'/reject',{});
  if(r && r.error) alert(r.error); else if(nothingNavigatedSince(epoch)) friends({silent:true});
}
// Design cleanup, Aug 27: this used to hash the seed into one of 8 colors, so friends, requests,
// search results and chat all showed a scatter of random reds/purples/oranges -- and since it's a
// hash, two different people could (and did) land on the identical color anyway, so it was never
// actually a reliable way to tell people apart. The initial letter plus the name already shown
// right next to every avatar does that job. Every initials-avatar (no photo yet) now uses one
// consistent accent everywhere -- a first pass reused --green (this repo's old, now-stale "avatar
// accent" constant), but Jeff, Aug 27: green isn't really part of the app anymore, and repeating
// it on every avatar also competed with the ONE thing green is still used for elsewhere (streaks,
// PRs, "done") -- diluting the very achievement moments it's meant to highlight. Settled on
// graphite (--avatar, this repo's own near-black ink color) instead: it doesn't compete with any
// accent in the app, reads as a considered choice rather than a placeholder, and gets out of the
// way the moment someone adds a real photo. `seed` is kept as a parameter (unused) rather than
// removing it from every call site, in case per-person variation is wanted again.
function avatarColor(seed){
  return 'var(--avatar)';
}

// ---- Profile (me + any friend) ----
function flameSvg(){ return '<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;vertical-align:-1px"><path d="M12 2c1 3-1 4-2 6-1 2 0 4 2 4 1.5 0 2-1 2-2 2 1 3 3 3 5 0 3-3 5-6 5-4 0-7-3-7-7 0-4 4-8 8-11z"/></svg>'; }
function gearSvg(){ return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; }
// v230: dark is the app's DEFAULT look; this device-local switch is the only way to go light
// (the app deliberately does not follow the phone's setting - Jeff's call, Aug 28). The <head>
// inline script stamps html.theme-dark from the same localStorage key before first paint.
function currentTheme(){ try { return localStorage.getItem('crewfit_theme') || 'dark'; } catch(e){ return 'dark'; } }
function toggleTheme(){
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('crewfit_theme', next); } catch(e){}
  document.documentElement.classList.toggle('theme-dark', next === 'dark');
  const m = document.querySelector('meta[name=theme-color]');
  if(m) m.content = next === 'dark' ? '#131417' : '#f7f8fa';
  // update the row in place - close-and-reopen left two .sheet-back elements racing for 200ms
  // (closeSheet's fade closure) and made the sheet re-slide on every tap
  const v = document.getElementById('themeVal');
  if(v) v.textContent = next === 'dark' ? 'Dark' : 'Light';
}
function openSettings(){
  // v249, Jeff Aug 29 (video): tapping "Default gym" used to skip the closeSheet() every other
  // row here does before opening its sub-flow -- it went straight to editDefaultGym() with the
  // Settings sheet still open underneath. That let a SECOND full-viewport .sheet-back (Default
  // Gym, from openSheetHtml in textEntrySheet()) stack directly on top of the first, which is
  // exactly the state the rest of this file assumes never happens: the comment above _teConfirm
  // in textEntrySheet() already says "only one text-entry sheet is ever open at a time, same as
  // closeSheet()'s single .sheet-back assumption elsewhere in this file." Two consequences, both
  // visible in Jeff's recording: (1) every tap while Default Gym was open dimmed the profile page
  // through TWO stacked rgba(0,0,0,.35) backdrops instead of one, which reads as the page itself
  // darkening from an unrelated tap ("affecting things behind it"); (2) closeSheet() only ever
  // removes the LAST-appended .sheet-back, and it captures that specific element in a closure
  // before its 200ms fade-out timer runs -- so a closeSheet() aimed at the (still fully live,
  // still tappable) Settings sheet while Default Gym sat on top of it removed the ORIGINAL
  // Settings sheet on its own independent timer regardless of what had since stacked above it,
  // leaving Default Gym's sheet orphaned over a fully bright, fully interactive profile page once
  // Settings' timer fired -- exactly what frames 010-011 of the video show. Adding closeSheet()
  // here, matching every sibling row, means Settings is always gone before Default Gym ever
  // opens: at most one sheet-back ever exists, so neither failure mode is reachable.
  const inner = `<div class="sheet"><div class="sheet-head"><h2>Settings</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
    <div class="sheet-list">
      <button class="sheet-row" onclick="toggleTheme()">Appearance <span class="row-val" id="themeVal">${currentTheme()==='dark'?'Dark':'Light'}</span></button>
      <button class="sheet-row" onclick="closeSheet(); document.getElementById('av').click()">Edit photo</button>
      <button class="sheet-row" onclick="closeSheet(); editBio()">Edit bio</button>
      <button class="sheet-row" onclick="closeSheet(); editDefaultGym()">Default gym <span class="row-val">${esc(ME.defaultGym || 'Not set')}</span></button>
      <button class="sheet-row" onclick="closeSheet(); pickUnits()">Weight units <span class="row-val">${esc(myUnit())}</span></button>
      <button class="sheet-row" onclick="closeSheet(); seedSetupScreen()">Starting weights</button>
      <button class="sheet-row" onclick="toggleStreakReminders()">Streak reminders <span class="row-val" id="streakRemVal">${ME.notifyStreakReminders!==false?'On':'Off'}</span></button>
      <button class="sheet-row" onclick="toggleWorkoutReminders()">Workout reminders <span class="row-val" id="workoutRemVal">${ME.notifyWorkoutReminders!==false?'On':'Off'}</span></button>
      <button class="sheet-row red" onclick="closeSheet(); confirmResetWorkouts()">Reset workouts</button>
    </div>
    <!-- v249, Jeff Aug 29 (video): "the log out button is the same size and very close to the
    reset workout button" -- they shared .sheet-row.red (Reset workouts' own destructive-red
    styling) with only a hairline divider between them, so a genuinely harmless, fully reversible
    action (Log out) read as being exactly as risky as an irreversible one (Reset workouts
    permanently deletes every workout, log, and PR -- see confirmResetWorkouts() above) and sat a
    thin border away from it. Log out now drops the red styling -- red is reserved for actually
    destructive actions app-wide -- and moves into its own grouped section with a real gap above
    it, the same grouped-list pattern iOS Settings uses to keep a sign-out action visually apart
    from destructive ones. -->
    <div class="sheet-list" style="margin-top:14px">
      <button class="sheet-row" onclick="closeSheet(); logout()">Log out</button>
    </div>
  </div>`;
  openSheetHtml(inner);
}
// Task #64, Jeff Aug 21: "Can you delete all of my workouts and history to let me start over?"
// Irreversible and account-wide, so this gets its own explaining sheet rather than a bare
// browser confirm() — the same severity Delete/Leave get, just spelled out further since this
// touches every workout at once instead of one.
function confirmResetWorkouts(){
  const inner = `<div class="sheet"><div class="sheet-head"><h2>Reset workouts</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
    <div class="muted" style="padding:0 2px 14px">This permanently deletes every workout, log, and personal record you've saved — there's no undo. Workouts you share with a friend who still has their own credit in them stay theirs; you're just taken off. Your account, username, and friends are not affected.</div>
    <div class="sheet-list">
      <button class="sheet-row red" onclick="doResetWorkouts()">Reset everything</button>
      <button class="sheet-row" onclick="closeSheet()">Cancel</button>
    </div>
  </div>`;
  openSheetHtml(inner);
}
async function doResetWorkouts(){
  const r = await H.post('/api/me/reset-workouts', {confirm:true});
  if(r && r.error){ alert(r.error); return; }
  ME.workoutsCompleted = 0;
  closeSheet();
  home();
}
function pickUnits(){
  const cur = myUnit();
  const inner = `<div class="sheet"><div class="sheet-head"><h2>Weight units</h2>
      <button class="sec sm" onclick="closeSheet()">✕</button></div>
    <div class="sheet-list">
      <button class="sheet-row" onclick="setUnits('lb')">Pounds (lb)${cur==='lb'?' <span class="row-val">✓</span>':''}</button>
      <button class="sheet-row" onclick="setUnits('kg')">Kilograms (kg)${cur==='kg'?' <span class="row-val">✓</span>':''}</button>
    </div>
    <div class="note">Only changes what new sets are recorded in. Sets you've already logged
      keep the units you logged them in.</div>
  </div>`;
  openSheetHtml(inner);
}
async function setUnits(u){
  const r = await H.post('/api/me/units',{units:u});
  if(r.error){ alert(r.error); return; }
  ME.units = r.units;
  closeSheet();
}
async function profileView(id, opts){
  // v250 (audit follow-up): this is a real navigation to a full-screen view -- possibly someone
  // ELSE's profile, reached from followList() below without ever touching showTab() or the nav
  // tab. Must bump UI_EPOCH so a slow editBio/editDefaultGym save started before this navigation
  // can tell it's no longer looking at the screen it was launched from. See the comment above
  // stillOnProfileWithNothingElseOpen.
  // v254: `opts.silent` covers two different callers, both wanting the same thing (don't bump
  // UI_EPOCH, don't touch scroll/history): toggleFollow / editBio / avatar-upload / setWorkoutView
  // re-rendering the SAME profile already on screen (possibly someone else's), AND meScreen()
  // (the 'me' TAB's render target) -- showTab() already pushes {t:'tab',tab:'me'} and bumps
  // UI_EPOCH itself, so profileView pushing its own {t:'profile',id} on top would double-push one
  // history entry per tap on the Me tab. `opts.fromHistory` means this came from popstate (see
  // renderNavState) -- land, don't push again.
  // NOT gated on id===ME.id -- that used to be the check here, but it's wrong: plenty of genuine
  // navigations here can legitimately resolve to id===ME.id (a feed item about your own activity,
  // a friend-row tap that happens to be you, viewing your own followers/following) without going
  // through meScreen() at all. Gating on isMe silently skipped the scroll reset and left a stale
  // entry on top of history in exactly that case -- a real instance of the "starts in the middle"
  // bug this fix exists to close, caught in cold review. meScreen() (the 'me' TAB's render target)
  // is the ONE deliberate exception, and it opts in explicitly with {silent:true} rather than this
  // function guessing from id alone -- see meScreen() below.
  const silent = !!(opts && opts.silent);
  const fromHistory = !!(opts && opts.fromHistory);
  if(!silent) UI_EPOCH++;
  const p = await H.get('/api/profile/'+id);
  const isMe = id===ME.id;
  const avatar = p.avatar
    ? `<img class="pavatar" src="${esc(p.avatar)}" alt="">`
    : `<div class="pavatar" style="background:${avatarColor(p.username)};color:#fff">${esc((p.displayName||p.username||'?')[0]||'?')}</div>`;
  const stats = `
    <div class="pstats">
      <div class="pstat"><b>${p.workoutsCompleted}</b><span>Workouts</span></div>
      <div class="pstat" style="cursor:pointer" onclick="followList('${p.id}','following')"><b>${p.following}</b><span>Following</span></div>
      <div class="pstat" style="cursor:pointer" onclick="followList('${p.id}','followers')"><b>${p.followers}</b><span>Followers</span></div>
    </div>`;
  const bioBlock = isMe
    ? `<div class="pbio" onclick="editBio()">${p.bio?esc(p.bio):'<span class="muted">Tap to add a bio</span>'}</div>`
    : (p.bio?`<div class="pbio">${esc(p.bio)}</div>`:'');
  const avatarBlock = isMe
    ? `<label class="pavatar-wrap" title="Change photo">
         ${avatar}
         <input id="av" type="file" accept="image/*" style="display:none" onchange="uploadAvatar(this)">
       </label>`
    : avatar;
  const settingsBtn = isMe ? `<button class="profile-set" title="Settings" onclick="openSettings()">${gearSvg()}</button>` : '';
  const FOLLOW_LABEL = { none: ['Follow','blue'], requested: ['Requested','sec'], following: ['Following','sec'] };
  const [flabel, fcls] = FOLLOW_LABEL[p.youFollow] || FOLLOW_LABEL.none;
  const action = (isMe || p.youFollow === 'self') ? ''
    : `<button class="sm ${fcls}" id="followBtn" onclick="toggleFollow('${p.id}','${p.youFollow || 'none'}')">${flabel}</button>`
      + (p.followsYou ? `<span class="muted" style="margin-left:8px;font-size:12px">Follows you</span>` : '');
  const actHtml = action?`<div style="margin:10px 0">${action}</div>`:'';
  // v147: surface recentActivity (PRs / weekly completions / streaks) — server already computes
  // this (buildActivityFor in server.js) but the profile page never rendered it. Same markup as
  // Home's "Friends' Activity" strip; since v225 all cards float borderless, and (same rule as
  // Home) the card only renders when there is activity in it — an empty section stays open.
  const activity = p.recentActivity||[];
  const activityRows = activity.map(a=>{
        const chip = a.type==='pr' ? `<span class="act-chip act-pr">PR</span>` : `<span class="act-chip done">✓</span>`;
        // same .feed-lead fixed column as Home's feed - text start must line up across PR/check rows
        return `<div class="feed-item"><span class="feed-lead">${chip}</span><span>${esc(a.text)}</span></div>`;
      }).join('');
  const activityBlock = activity.length
    ? `<h2 class="light">Recent Activity</h2><div class="card feed-strip">${activityRows}</div>`
    : (isMe ? `<h2 class="light">Recent Activity</h2>${homeEmpty(ICON_FEED, 'No activity yet', 'Log a workout to see it here.')}` : '');
  const workouts = p.myWorkouts||[];
  function woCard(w){
    // Jeff, Aug 26: no picture shouldn't mean a gray placeholder box - just skip the image area
    // entirely and let the card show title/exercises only.
    const img = (w.post&&w.post.media&&w.post.media[0]) ? `<img class="wthumb" src="${esc(w.post.media[0].src)}" alt="">` : '';
    const title = (w.name && w.name!=='Workout') ? w.name : ((w.firstExercises&&w.firstExercises[0])||'Workout');
    const exs = (w.firstExercises||[]).slice(0,3);
    const more = (w.exerciseCount||0) - exs.length;
    const exList = exs.length ? `<div class="wex-h">Exercises</div><ol class="wexb">${exs.map(e=>`<li>${esc(e)}</li>`).join('')}</ol>${more>0?`<div class="wexb-more">+${more} more</div>`:''}` : '<div class="wexnone">No exercises</div>';
    const collab = (w.collaborators&&w.collaborators.length) ? `with @${esc(w.collaborators[0].username)}${w.collaborators.length>1?` +${w.collaborators.length-1}`:''}` : '';
    const when = w.at ? fmtDate(w.at) : (w.date||'');
    return `<div class="wtile" onclick="viewPost('${w.id}','${id}')">
      <div class="wdate">${esc(when)}</div>
      <div class="wtitle">${esc(title)}</div>
      ${img}
      <div class="wex">${exList}</div>
      ${collab?`<div class="wcollab">${collab}</div>`:''}
    </div>`;
  }
  // isPrivate FIRST: a private profile returns myWorkouts:[] even when the person has plenty,
  // and "No workouts logged yet" would be a false claim about their history (v163 rule). The
  // privateBlock below already explains why the section is empty.
  const isPrivate = p.limited && !isMe;
  const emptyWorkouts = isPrivate ? '' : homeEmpty(ICON_CAL, 'No workouts logged yet', 'Finished workouts show up here.');
  const gridHtml = workouts.length
    ? `<div class="wgrid">` + workouts.map(w=>woCard(w)).join('') + `</div>`
    : emptyWorkouts;
  const listHtml = workouts.length
    ? `<div class="wgrid wlist">` + workouts.map(w=>woCard(w)).join('') + `</div>`
    : emptyWorkouts;
  const privateBlock = `<div class="card" style="text-align:center;padding:26px 16px;margin-top:10px">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" style="color:var(--muted)"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      <div style="font-weight:700;margin-top:8px">This profile is private</div>
      <div class="muted" style="margin-top:4px;font-size:13px">Follow ${esc(p.displayName||p.username)} to see ${workouts.length?'the rest of their':'their'} workouts, PRs and activity.</div>
    </div>`;
  // Jeff, Aug 31: default to List, and swap the two buttons' on-screen positions to match --
  // List first (left, where Grid used to sit), Grid second. Same ids/handlers either way, just
  // reordered in the markup below and the fallback flipped.
  const wview = (window.__wview||'list');
  $('app').innerHTML = `<div class="wrap">
    <div class="profile-head">
      ${avatarBlock}
      <div class="pinfo">
        <div class="pname">${esc(p.displayName||p.username)}</div>
        <div class="muted">@${esc(p.username)}</div>
        ${p.streak>=2?`<div class="streak-pill" style="margin-top:6px">${flameSvg()}${p.streak} day streak</div>`:''}
      </div>
      ${settingsBtn}
    </div>
    ${stats}
    ${actHtml}
    ${bioBlock}
    ${activityBlock}
    <div class="sec-head"><h2>My Workouts</h2><div class="view-toggle"><button class="${wview==='list'?'on':''}" id="vtList" onclick="setWorkoutView('list','${id}')">☰ List</button><button class="${wview==='grid'?'on':''}" id="vtGrid" onclick="setWorkoutView('grid','${id}')">▦ Grid</button></div></div>
    <div style="margin:8px 0 14px" id="workoutView">${wview==='grid'?gridHtml:listHtml}</div>
    ${isPrivate ? privateBlock : ''}
    ${isMe?`<button class="sec" style="margin-top:18px" onclick="logout()">Log out</button>`:''}
  </div>`;
  if(!silent){ const st={t:'profile', id}; fromHistory ? landOn(st) : navigated(st); }
}
// Jeff, Aug 26: "click on the number of followers or following and it show me who." The counts
// were already public (publicUser, server.js) but the lists themselves are the same private detail
// as workouts/PRs — gated server-side on the same isApproved rule as the rest of the profile, so a
// private account's lists stay private to non-approved viewers.
async function followList(id, kind, opts){
  // v250 (audit follow-up): same reasoning as profileView() above -- a real navigation away from
  // whatever was on screen, reachable from the profile's Followers/Following stat without a tab
  // switch or new sheet.
  // v254: no silent-refresh caller exists for this screen (nothing re-renders it in place), so
  // only opts.fromHistory applies -- popstate landing here, don't push a duplicate entry.
  const fromHistory = !!(opts && opts.fromHistory);
  UI_EPOCH++;
  const list = await H.get(`/api/profile/${id}/${kind}`);
  const title = kind==='followers' ? 'Followers' : 'Following';
  // v254 fix: this used to call profileView(id) directly, which PUSHES A NEW {t:'profile',id}
  // entry on top of the one already sitting right below this screen's own -- so tapping this
  // button "back to profile" looked right, but left a stale duplicate profile entry in history:
  // a hardware/gesture Back press right after landed you back on THIS followers/following list
  // instead of actually leaving the profile. history.back() pops instead of pushing, so it can't
  // create that duplicate (same fix shape as backToSessionAfterSwapPicker).
  const backBtn = `<div class="pp-head"><button class="sec sm" onclick="history.back()">← Back</button></div>`;
  if(!Array.isArray(list)){
    $('app').innerHTML = `<div class="wrap">${backBtn}<h1>${title}</h1>
      <div class="card muted" style="text-align:center;padding:20px">This list is private.</div>
    </div>`;
    const st={t:'followList', id, kind}; fromHistory ? landOn(st) : navigated(st);
    return;
  }
  const rows = list.length ? list.map(x=>`
    <div class="friend-row" onclick="profileView('${x.id}')" style="cursor:pointer">
      ${avatarHtml(x,'avatar')}
      <div class="meta">
        <div class="name">${esc(x.displayName||x.username)}</div>
        <div class="handle">@${esc(x.username)}</div>
      </div>
    </div>`).join('')
    : `<div class="muted" style="padding:14px 2px;text-align:center">${kind==='followers'?'No followers yet.':'Not following anyone yet.'}</div>`;
  $('app').innerHTML = `<div class="wrap">${backBtn}<h1>${title}</h1>
    <div class="card" style="padding:6px 12px">${rows}</div>
  </div>`;
  const st={t:'followList', id, kind}; fromHistory ? landOn(st) : navigated(st);
}
// Jeff, Sep 2: "when I click to change grid or list view on a different person profile - it
// brings me to my profile." This always re-rendered ME.id no matter whose profile was on screen
// -- the view-toggle buttons never told it. profileView(id) already has the on-screen profile's
// id right there in its own closure (the same id every other button in that render uses, e.g.
// viewPost/followList above), so the fix is just threading it through the onclick the same way.
// Falls back to ME.id only for safety if this is ever called without one.
function setWorkoutView(v, id){
  window.__wview = v;
  const g=document.getElementById('vtGrid'), l=document.getElementById('vtList');
  if(g){ g.className = v==='grid'?'on':''; l.className = v==='list'?'on':''; }
  const pid = id || (ME&&ME.id);
  if(pid) profileView(pid, {silent:true});
}
async function toggleFollow(id, state){
  // v251 (audit finding): this await can take a while on a slow connection, and until now the
  // profileView(id) below fired unconditionally once it resolved -- if the user had since tapped
  // away to a different tab or a different profile, the stale response barged them right back to
  // this one. Same staleness shape as editBio/editDefaultGym's stillOnProfileWithNothingElseOpen
  // (see the comment above it), just without that helper's extra "and specifically the Profile
  // tab" requirement -- this only needs to know nothing navigated away at all since the tap.
  const epoch = UI_EPOCH;
  // none -> request to follow; requested -> cancel the request; following -> unfollow
  const r = (state === 'none' || !state)
    ? await H.post('/api/follow/'+id,{})
    : await H.post('/api/unfollow/'+id,{});
  if(r && r.error){ alert(r.error); return; }
  if(nothingNavigatedSince(epoch)) profileView(id, {silent:true});   // re-render from the server's fresh youFollow so the button is always right
}
// v250 (audit finding): editBio/editDefaultGym below both fire their real side effect (a full
// navigate back to the profile, or reopening Settings) from an async .then() -- an arbitrary,
// network-latency-bound delay after Save was tapped, not the next tick. By the time a slow save
// resolves the user may already be looking at something else entirely: another sheet they opened,
// or a different tab. Barging in at that point with a stale reopen/navigate is not just visually
// jarring -- for editBio it silently yanks the user off whatever they moved on to and back to
// their own profile with zero warning. Same principle openSession's own `silent` refresh already
// applies (see SESSION_SILENT_SEQ/logSheetStillOpenFor above): a background response is only
// allowed to act on the screen if that screen is still actually the one in front of the user.
// v251: factored out of stillOnProfileWithNothingElseOpen below so callers that don't specifically
// need "and it's the Profile tab" (toggleFollow, the posted-workout action cluster -- see their own
// comments) can use the same UI_EPOCH staleness check on its own.
function nothingNavigatedSince(epochAtStart){ return UI_EPOCH === epochAtStart; }
function stillOnProfileWithNothingElseOpen(epochAtStart){
  if(!nothingNavigatedSince(epochAtStart)) return false;
  // dataset.tab is 'me' (the nav button's own key) even though its visible label is "Profile" --
  // see index.html's nav markup.
  const activeTab = document.querySelector('.nav button.active');
  return !!activeTab && activeTab.dataset.tab === 'me';
}
function editBio(){
  textEntrySheet({
    title:'Your bio', label:'Bio', value:ME.bio||'', placeholder:'Tell people about yourself', multiline:true,
    // epoch captured synchronously, right as Save is tapped (before the network round trip) --
    // the moment right after this sheet's own close, before anything else has had a chance to open
    onConfirm: v => { const epoch=UI_EPOCH; H.post('/api/me/bio',{bio:v}).then(r=>{ if(r.bio!==undefined){ ME.bio=r.bio; if(stillOnProfileWithNothingElseOpen(epoch)) profileView(ME.id, {silent:true}); } }); }
  });
}
// Prefills the Location field on every new workout you create (and Quick Workout) so you're not
// retyping the same gym every time. Left blank on purpose by default — nothing to prefill until
// you set one.
function editDefaultGym(){
  textEntrySheet({
    title:'Default gym', label:'Prefills new workouts', value:ME.defaultGym||'', placeholder:'e.g. Equinox Downtown',
    onConfirm: v => { const epoch=UI_EPOCH; H.post('/api/me/default-gym',{defaultGym:v}).then(r=>{ if(r.defaultGym!==undefined){ ME.defaultGym=r.defaultGym; if(stillOnProfileWithNothingElseOpen(epoch)) openSettings(); } }); }
  });
}
// Task #63: "you're about to lose your streak" push reminder, opt-out toggle. Only matters if
// push permission is separately granted (setupPush()) - this just controls whether the server
// will ever send THIS particular kind of notification once it can send any at all.
async function toggleStreakReminders(){
  const next = !(ME.notifyStreakReminders!==false);
  const r = await H.post('/api/me/notify-prefs',{streakReminders:next});
  // v249 (cold-review catch on the Default-gym stacking fix): this used to call openSettings()
  // again on success, same as Default gym did before its own fix -- reopening a sheet that's
  // already open appends a SECOND full-viewport .sheet-back on top of the still-live original
  // (this row has no closeSheet() before it either, so the overlap wasn't even a brief fade-race:
  // the first sheet stayed fully live and fully shown, permanently, until manually dismissed one
  // tap at a time). Fixed the same way toggleTheme() already was, per the comment above it -
  // update the row's own text in place instead of closing-and-reopening the whole sheet.
  if(r.streakReminders!==undefined){
    ME.notifyStreakReminders=r.streakReminders;
    const v = document.getElementById('streakRemVal');
    if(v) v.textContent = ME.notifyStreakReminders!==false ? 'On' : 'Off';
  }
}
// Aug 31: "you have a workout scheduled today" push reminder, opt-out toggle -- same shape as
// toggleStreakReminders() above (same server route, its own field), same in-place row update
// instead of closing/reopening the sheet.
async function toggleWorkoutReminders(){
  const next = !(ME.notifyWorkoutReminders!==false);
  const r = await H.post('/api/me/notify-prefs',{workoutReminders:next});
  if(r.workoutReminders!==undefined){
    ME.notifyWorkoutReminders=r.workoutReminders;
    const v = document.getElementById('workoutRemVal');
    if(v) v.textContent = ME.notifyWorkoutReminders!==false ? 'On' : 'Off';
  }
}
async function uploadAvatar(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=> openCropper(reader.result, file.type);
  reader.readAsDataURL(file);
}
// ---- Avatar cropper ----
let _crop = null;
function openCropper(dataUrl, type){
  const ov = document.createElement('div');
  ov.className = 'crop-overlay';
  ov.id = 'cropper';
  ov.innerHTML = `
    <div class="crop-topbar">
      <button class="crop-x" onclick="closeCropper()">✕</button>
      <div class="crop-title">Move & scale</div>
      <button class="crop-done" onclick="applyCrop('${type}')">Save</button>
    </div>
    <div class="crop-stage" id="cropStage"><img class="crop-img" id="cropImg" src="${dataUrl}"><div class="crop-ring"></div></div>
    <div class="crop-hint">Pinch to zoom · drag to move</div>`;
  document.body.appendChild(ov);
  const img = document.getElementById('cropImg');
  const stage = document.getElementById('cropStage');
  _crop = { scale:1, x:0, y:0, img, stage, type };
  // v253 (audit finding): this was Math.min, which is a CONTAIN fit — it scales the image so the
  // SMALLER stage/image ratio touches (the image's shorter side fits exactly, its longer side
  // falls short of the stage). clampCrop's own comment says the image "must always fully cover
  // the circle" — that's a COVER fit, which needs the LARGER ratio (Math.max) instead, so the
  // image's shorter side overflows the stage and the longer side is what gets cropped/pannable.
  // Almost no phone photo is square, so this left a visible gap (background showing through)
  // along one axis of the circle for the vast majority of real uploads — confirmed by hand: a
  // 1600x900 photo into a 300x300 stage previously based at 0.1875 (300/1600), leaving the image
  // only 168.75px tall against a 300px-tall stage, even after the 1.2x start zoom below.
  const fit = ()=>{
    const s = Math.max(stage.clientWidth/img.naturalWidth, stage.clientHeight/img.naturalHeight);
    _crop.base = s;
    _crop.scale = 1.2; // start a touch zoomed-in so both axes are pannable right away
    centerImage();
  };
  if(img.complete) fit(); else img.onload = fit;
  // one-finger drag to pan
  let dragging=false, sx=0, sy=0, ox=0, oy=0;
  const down = e=>{ if(e.touches && e.touches.length>1) return; dragging=true; const p=e.touches?e.touches[0]:e; sx=p.clientX; sy=p.clientY; ox=_crop.x; oy=_crop.y; };
  const move = e=>{ if(!dragging) return; e.preventDefault(); const p=e.touches?e.touches[0]:e; _crop.x=ox+(p.clientX-sx); _crop.y=oy+(p.clientY-sy); renderCrop(); };
  const up = ()=> dragging=false;
  stage.addEventListener('mousedown',down); stage.addEventListener('mousemove',move); window.addEventListener('mouseup',up);
  ov.addEventListener('touchstart',down,{passive:false}); ov.addEventListener('touchmove',move,{passive:false}); ov.addEventListener('touchend',up);
  // pinch-to-zoom (two fingers) anywhere on screen
  let pinch0=0, scale0=1;
  const pinchDist = t=>{ const dx=t[0].clientX-t[1].clientX, dy=t[0].clientY-t[1].clientY; return Math.hypot(dx,dy); };
  const tstart = e=>{ if(e.touches.length===2){ pinch0=pinchDist(e.touches); scale0=_crop.scale; e.preventDefault(); } };
  const tmove = e=>{ if(e.touches.length===2){ e.preventDefault(); const d=pinchDist(e.touches); _crop.scale=Math.max(0.5,Math.min(6, scale0*(1+(d/pinch0-1)*0.6))); renderCrop(); } };
  ov.addEventListener('touchstart',tstart,{passive:false}); ov.addEventListener('touchmove',tmove,{passive:false});
  // mouse wheel / trackpad zoom anywhere (desktop testing) — damped
  ov.addEventListener('wheel', e=>{ e.preventDefault(); _crop.scale=Math.max(0.5,Math.min(6, _crop.scale*(e.deltaY<0?1.04:0.96))); renderCrop(); }, {passive:false});
}
function centerImage(){
  const {img, stage, base, scale} = {..._crop, scale:_crop.scale||1};
  const w = img.naturalWidth*base*scale, h = img.naturalHeight*base*scale;
  // center, but clamp so the image always covers the whole circle
  const sw = stage.clientWidth, sh = stage.clientHeight;
  _crop.x = (sw - w)/2;
  _crop.y = (sh - h)/2;
  renderCrop();
}
function clampCrop(){
  const {img, stage, base, scale, x, y} = {..._crop, scale:_crop.scale||1};
  const w = img.naturalWidth*base*scale, h = img.naturalHeight*base*scale;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  // image must always fully cover the circle: x in [sw-w, 0], y in [sh-h, 0]
  _crop.x = Math.min(0, Math.max(sw - w, x));
  _crop.y = Math.min(0, Math.max(sh - h, y));
}
function renderCrop(){
  const {img, base, scale, x, y} = _crop;
  const s = base*(scale||1);
  const w = img.naturalWidth*s, h = img.naturalHeight*s;
  clampCrop();
  img.style.width = w+'px';
  img.style.height = h+'px';
  img.style.transform = `translate(${_crop.x}px, ${_crop.y}px)`;
}
function closeCropper(){ const c=document.getElementById('cropper'); if(c) c.remove(); _crop=null; }
async function applyCrop(type){
  if(!_crop || _crop.done) return;
  _crop.done = true;
  const {img, stage, base, scale} = {..._crop, scale:_crop.scale||1};
  const s = base*(scale||1);
  const w = stage.clientWidth, h = stage.clientHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  // draw the (possibly panned) image, clipped to circle
  ctx.save();
  ctx.beginPath(); ctx.arc(w/2,h/2,w/2,0,Math.PI*2); ctx.clip();
  ctx.drawImage(img, _crop.x, _crop.y, img.naturalWidth*s, img.naturalHeight*s);
  ctx.restore();
  const out = canvas.toDataURL(type && type.indexOf('png')>=0 ? 'image/png' : 'image/jpeg', 0.9);
  closeCropper();
  // v252 (audit finding): _crop.done above only guards against double-tapping applyCrop itself --
  // it says nothing about whether the user has since navigated away, so the profileView() below
  // used to barge back onto whatever screen they'd moved on to. ME.avatar is still updated
  // unconditionally so the new avatar is correct whenever they do land back on a profile.
  const epoch=UI_EPOCH;
  const r = await H.post('/api/me/avatar',{ data: out, type: type||'image/jpeg' });
  if(r.avatar){ ME.avatar = r.avatar; if(nothingNavigatedSince(epoch)) profileView(ME.id, {silent:true}); }
  else alert(r.error||'upload failed');
}
// v254: silent -- this is the 'me' tab's render target (via showTab/renderTabState), which already
// owns the nav push/scroll/UI_EPOCH bump for the tab switch. See profileView's own comment.
function meScreen(){ profileView(ME.id, {silent:true}); }
function logout(){ localStorage.removeItem('crewfit_token'); TOKEN=''; ME=null; $('nav').classList.add('hidden'); authScreen(); }

// ---- Push ----
async function setupPush(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if(!('Notification' in window)) return;
  try{
    if(Notification.permission === 'default'){ try{ await Notification.requestPermission(); }catch(e){} }
    if(Notification.permission !== 'granted') return; // user declined; push stays optional
    const reg = await navigator.serviceWorker.register('/sw.js');
    const key = await vapidKey();
    let sub;
    try {
      sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey: key});
    } catch(e) {
      // The browser already holds a subscription signed with an OLD server key (task #61 - this
      // happened to every subscriber once, the time the server's VAPID key changed out from under
      // them) and refuses to subscribe again with a different key until the old one is dropped.
      // Drop it and get a fresh subscription under the current key.
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();
      sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey: key});
    }
    await H.post('/api/push/subscribe',{subscription:sub});
  }catch(e){ /* push optional for demo */ }
}
async function vapidKey(){ const r=await (await fetch('/api/vapid')).json(); return r.publicKey; }

// ---- Keyboard-aware bottom sheets ----
// Jeff, Aug 28 (screenshot from logging a set on Lat Pulldown): "When I go to log a set the
// keyboard sometimes covers everything." .sheet-back is `position:fixed; inset:0` and every
// sheet inside it is bottom-aligned (align-items:flex-end) to fill that. iOS Safari does NOT
// shrink the LAYOUT viewport when the on-screen keyboard opens -- only the VISUAL viewport (the
// part actually still visible above the keyboard) shrinks -- so a fixed element anchored to
// "the bottom" stays anchored to the bottom of the space the keyboard now covers. The weight/
// reps inputs and the Add button, near the bottom of the sheet, ended up rendered behind the
// keyboard instead of merely scrolled off-screen where scrolling could still reach them.
// window.visualViewport is the one API that actually reports the visible-above-the-keyboard
// area, so this keeps every open .sheet-back sized to exactly that, and caps each .sheet's
// height to fit inside it (on top of the plain CSS max-height/overflow-y in index.html, which
// covers browsers with no visualViewport support at all).
function syncSheetsToViewport(){
  if(!window.visualViewport) return;
  const vv = window.visualViewport;
  document.querySelectorAll('.sheet-back').forEach(back=>{
    back.style.height = vv.height + 'px';
    back.style.top = vv.offsetTop + 'px';
    const sheet = back.querySelector('.sheet');
    // min() against the CSS's own 86vh so this only ever SHRINKS a sheet to fit above the
    // keyboard -- it must never grow one taller than its normal, no-keyboard design height.
    if(sheet) sheet.style.maxHeight = Math.max(160, Math.min(vv.height - 16, window.innerHeight*0.86)) + 'px';
  });
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize', syncSheetsToViewport);
  window.visualViewport.addEventListener('scroll', syncSheetsToViewport);
}
// Also sync the instant a sheet is opened (not just on the next viewport change after) -- covers
// a sheet opened while a keyboard is already up, e.g. editLogSet() stacking a second .sheet-back
// on top of the still-open log sheet to edit a set you already logged. Guarded like the
// visualViewport check above -- this
// whole file also gets loaded and run for real (not just scanned as text) by
// test/client-hostile.mjs in a plain Node vm with no MutationObserver global at all.
if(typeof MutationObserver !== 'undefined'){
  new MutationObserver(muts=>{
    // v232 (Jeff): while any sheet is open, lock the page behind it - scrolling the Quick
    // Workout routine picker was scrolling the screen underneath. One central body class
    // (works for every sheet, however it was opened) plus overscroll-behavior in the CSS;
    // recomputed on every add/remove so closeSheet's delayed .remove() unlocks it.
    document.documentElement.classList.toggle('sheet-open', !!document.querySelector('.sheet-back'));  // on <html>: iOS scrolls html, not body
    for(const m of muts) for(const n of m.addedNodes)
      if(n.nodeType===1 && n.classList && n.classList.contains('sheet-back')){ syncSheetsToViewport(); return; }
  }).observe(document.body, {childList:true});
}

// ---- Update watcher (v238) ----
// Every deploy used to require force-quitting the app to escape the cached page. The app now
// reads its own ?v= off its script tag, asks the server for the deployed one when you come
// back to the app (and every 10 minutes), and offers a one-tap refresh when they differ.
// Never a forced reload - a mid-workout page reload would eat an open log sheet.
// The listener block is typeof-guarded for test/client-hostile.mjs's vm; the mock DOM does
// provide document.addEventListener, but setInterval/fetch may be absent there.
function myAppVersion(){
  try { const s = document.querySelector('script[src*="app.js"]');
    const m = /[?&]v=(\d+)/.exec((s && s.src) || ''); return m ? m[1] : null; } catch(e){ return null; }
}
function showUpdateBar(){
  if(document.getElementById('updateBar')) return;
  const b = document.createElement('div');
  b.id = 'updateBar';
  b.innerHTML = 'A new version is ready <button onclick="location.reload()">Refresh</button>';
  document.body.appendChild(b);
}
async function checkAppVersion(){
  const mine = myAppVersion(); if(!mine) return;
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    const j = await r.json();
    if(j && j.v && j.v !== mine) showUpdateBar();
  } catch(e){}
}
if(typeof document !== 'undefined' && typeof document.addEventListener === 'function'
   && typeof setInterval === 'function' && typeof fetch === 'function'){
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible') checkAppVersion();
  });
  setInterval(checkAppVersion, 10 * 60 * 1000);
}

// ---- Boot ----
// v253 (audit finding): this used to wipe the token and drop straight to the login screen the
// instant /api/profile/me failed for ANY reason -- not just a real 401. A genuinely invalid/
// expired token already clears itself and shows the login screen from INSIDE H._req the moment
// the server actually says 401 (see its own `_expired` comment) -- tryBoot below never has to
// duplicate that. What it guards against is everything else: a network blip on a shaky
// connection, a brief server hiccup, a cold start on Fly -- cases where the token is probably
// still perfectly good, and logging someone out of a real session because the app couldn't reach
// the server for one second is worse than just letting them retry without losing their login.
async function tryBoot(){
  if(TOKEN){
    // v247: localToday lets the server's streak/"trained today" logic agree with how it now
    // stores YOUR OWN history (see localDateStr's own comment) instead of drifting apart for a
    // few hours every evening.
    try{ ME = await H.get('/api/profile/me?localToday='+localDateStr()); }catch(e){ ME=null; }
  }
  if(TOKEN && ME && ME.id){
    $('nav').classList.remove('hidden');
    // v254: establishes a sane baseline history entry on boot -- without this the very first
    // real navigation's navigated() call pushes ON TOP OF whatever entry the browser created for
    // the bare page load (no state object at all), so a single Back press from one screen in
    // landed nowhere recognizable. replaceState (not pushState) since this isn't a navigation,
    // just labeling the entry that's already here.
    CURRENT_NAV_STATE = {t:'tab', tab:'home'};
    // Jeff, Aug 31: a "starting a workout" push notification (server.js's
    // firstExerciseStartNotification) deep-links here via ?openLog=sid:exId when there was no
    // already-open tab for sw.js's notificationclick to postMessage into instead (see that file's
    // comment). Stripped from the URL immediately either way, success or failure -- a stale query
    // string sitting in the address bar must not re-open the same log sheet on every later reload.
    // Parsed by hand rather than via URLSearchParams -- several of this app's own test harnesses
    // run app.js in a minimal mock global (same reasoning as the serviceWorker check above), and
    // URLSearchParams isn't one of the globals any of them provide.
    const openLogMatch = /(?:^|[?&])openLog=([^&]*)/.exec(location.search || '');
    const openLog = openLogMatch ? decodeURIComponent(openLogMatch[1]) : null;
    history.replaceState(CURRENT_NAV_STATE, '', location.pathname);
    if(openLog && openLog.includes(':')){
      const [sid, exId] = openLog.split(':');
      // v262 (cold-review fix): gate openLogSheet on openSession actually succeeding -- see the
      // comment at openSession's `return true;` for why calling both unconditionally double-alerted.
      if(sid && exId){ const opened = await openSession(sid); if(opened) await openLogSheet(sid, exId); return; }
    }
    home();
    return;
  }
  if(TOKEN && !(ME && ME._expired)){
    // Not a CONFIRMED-invalid session (H._req would already have cleared TOKEN and shown the
    // login screen itself if it were) -- just an inconclusive failure. Offer a retry instead of
    // discarding a token that may be completely fine the moment the connection recovers.
    bootRetryScreen();
    return;
  }
  TOKEN=''; localStorage.removeItem('crewfit_token'); authScreen();
}
function bootRetryScreen(){
  $('app').innerHTML = `<div class="wrap center">
    <h1>CrewFit</h1>
    <div class="muted">Couldn't reach the server. Check your connection and try again.</div>
    <button class="blue" style="margin-top:20px" onclick="tryBoot()">Retry</button>
  </div>`;
  window.scrollTo(0,0);
}
// Jeff, Aug 31: the other half of the "starting a workout" notification's deep link -- when the
// app is ALREADY open (in this tab or another), sw.js's notificationclick handler focuses it and
// hands the exercise off here instead of forcing a reload (see that file's comment for why). The
// ?openLog=sid:exId query-string path in tryBoot() above covers the no-open-tab case; this covers
// the open-tab case. Registered unconditionally -- it only ever receives anything once setupPush()
// below has actually registered/activated a service worker, but there's no harm listening early.
// The addEventListener check (not just 'serviceWorker' in navigator) matters beyond real browsers
// too: several of this app's own test harnesses stub navigator.serviceWorker as just
// { register: () => Promise.resolve() } to load app.js outside a real browser -- without this
// check, app.js itself would fail to load in every one of them.
// v262 (cold-review fix): this listener is registered synchronously, at script-parse time -- before
// BOOT_DONE below has resolved ME. TOKEN itself is read synchronously from localStorage, so it can
// already be valid while ME is still null; a postMessage arriving in that window (plausible on iOS,
// where backgrounding/foregrounding the PWA can re-run this script while a queued push's tap is
// still landing) used to call openSession(d.sid) immediately, which passes server auth on TOKEN
// alone and then dereferences ME.id deep inside its own render path -- an unhandled rejection, and
// the log sheet silently never opens. Awaiting BOOT_DONE first, then checking ME is actually
// populated, closes that race.
if('serviceWorker' in navigator && typeof navigator.serviceWorker.addEventListener==='function'){
  navigator.serviceWorker.addEventListener('message', async (event)=>{
    const d = event.data;
    if(d && d.type==='openLog' && d.sid && d.exId){
      await BOOT_DONE;
      if(!ME || !ME.id) return;
      // same success-gating as tryBoot's ?openLog= branch above -- see openSession's `return true;` comment.
      const opened = await openSession(d.sid);
      if(opened) await openLogSheet(d.sid, d.exId);
    }
  });
}
const BOOT_DONE = (async ()=>{
  await tryBoot();
  if('serviceWorker' in navigator) setupPush();
  document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
})();
