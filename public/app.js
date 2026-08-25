const API = '';
let TOKEN = localStorage.getItem('crewfit_token') || '';
let ME = null;
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
// "Live now" for the Home list: today's date (same local-midnight-to-midnight window fmtWhen
// labels "Today") and not yet finished. Deliberately NOT "any unposted session up to now" — an
// old abandoned draft from last week would then read as live forever, which is worse than not
// flagging it at all (see CLAUDE.md: discoverable and wrong beats quiet, but only when it's
// actually true). A session scheduled later today is still live now — you may not have logged
// anything yet, but it's today's workout, not next week's.
function isSessionLiveNow(s){
  if(!s || s.post) return false;
  const d = new Date(s.scheduledAt); if(isNaN(d)) return false;
  return startOfDay(d).getTime() === startOfDay(new Date()).getTime();
}

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

// ---- Nav ----
// keepModes is passed ONLY by the two places that deliberately open the library in a mode:
// openAddExercises (adding to a draft) and openSwapPicker (choosing a replacement). Every other
// route here is a person tapping the bottom nav, and that has to be an escape hatch — SWAP_MODE
// was otherwise never cleared by navigating away, so the Workouts tab stayed stuck in "Pick
// replacement" forever and later taps filed swaps against a workout you had long since left.
function showTab(tab, keepModes){
  if(!keepModes) resetTransientModes();
  document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  if(tab==='home') home(); else if(tab==='progress') progressScreen(); else if(tab==='lib') library(); else if(tab==='templates') templates(); else if(tab==='friends') friends(); else if(tab==='me') meScreen();
}
// Everything here is a half-finished intention. None of it should survive walking away from the
// screen that started it, and each one caused a real bug by doing so.
function resetTransientModes(){
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;   // stuck "Pick replacement" library
  LIB_ADDMODE = false;                                        // stuck "Done (n)" library
  EDITING_SESSION = null;                                     // next new workout saved over the edited one
  EDITING_ID = null;                                          // stuck inline-edit on a posted workout
  EDITING_TPL = null;                                         // stuck template edit
  if(typeof TPL_MODE === 'object' && TPL_MODE) { TPL_MODE.active = false; TPL_MODE.id = null; TPL_MODE.name = ''; }
}

// ---- Home / sessions (Option B: split sections) ----
async function home(){
  const sessions = await H.get('/api/sessions');
  const feed = await H.get('/api/feed');
  const _fr = await H.get('/api/friends');
  const myFriends = (_fr && _fr.friends) ? _fr.friends : (Array.isArray(_fr) ? _fr : []);
  const friendName = async (id)=> myFriends.find(f=>f.id===id)?.displayName || 'A friend';   // reads as a phrase, not as someone's name
  const initial = ((ME&&(ME.displayName||ME.username))||'?')[0]||'?';
  const first = ((ME.displayName||ME.username||'there').split(' ')[0]);
  const HYPE = ['Time to crush it','Let\'s get after it','Show up. Lift heavy'];
  const hypeLine = HYPE[Math.floor(Math.random()*HYPE.length)];
  const homeAvatarHtml = ME && ME.avatar
    ? `<img class="home-avatar" src="${esc(ME.avatar)}" alt="" onclick="showTab('me')">`
    : `<div class="home-avatar" onclick="showTab('me')">${esc(initial.toUpperCase())}</div>`;
  let html = `<div class="wrap home-head">
    <div class="home-top">
      <div class="home-greet">${esc(hypeLine)}, ${esc(first)}</div>
      ${homeAvatarHtml}
    </div>`;

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
        <div class="inv-info"><b>${esc(creatorName)}</b> invited you<div class="tag">${esc(s.name||'Workout')} · ${s.exercises.length} exercises</div>
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

  // Primary action (compact)
  html += `<button class="blue btn-new" onclick="newWorkout()">+ New workout</button>`;

  // Your Sessions (prime spot) — only sessions you've accepted/joined (exclude pending invites),
  // and only ones still open. Once a session has been finished and saved (s.post is set — see
  // POST /sessions/:id/post in server.js), it's done: it belongs in "My Workouts" on the profile,
  // not in this active list, so it doesn't sit here forever after everyone's already wrapped up.
  // Today's not-yet-finished session (if any) is pulled to the top with a "Live now" badge —
  // .sort() is stable (every browser this app targets), so this only reorders the live ones
  // forward and otherwise leaves everything exactly where the API's date order put it.
  const yours = sessions.filter(s => s.name && s.participants.includes(ME.id) && !(Array.isArray(s.invited) && s.invited.includes(ME.id)) && !s.post)
    .sort((a,b) => (isSessionLiveNow(b)?1:0) - (isSessionLiveNow(a)?1:0));
  html += `<h2>Your Sessions</h2><div class="card">`;
  if(yours.length){
    for(const s of yours){
      const label = s.name;
      const live = isSessionLiveNow(s);
      html += `<div class="lib-item${live?' session-live':''}" onclick="openSession('${s.id}')">
        <div>${live?'<div class="live-badge">● Live now</div>':''}<b>${esc(label)} · ${s.exercises.length} exercises</b><div class="tag">${fmtWhen(s.scheduledAt)}</div></div></div>`;
    }
  } else html += `<div class="muted">No sessions yet.</div>`;
  html += `</div>`;

  // Friend's Activity (lighter strip, in an elevated card to match Your Sessions)
  html += `<h2 class="light">Friends' Activity</h2><div class="card feed-strip">`;
  if(feed.length){
    for(const f of feed){
      const who = await friendName(f.by);
      const ic = f.type==='pr' ? `<span class="act-chip pr">PR</span>` : `<span class="act-chip done">✓</span>`;
      html += `<div class="feed-item" onclick="profileView('${f.by}')" style="cursor:pointer">${ic} <b>${esc(who)}</b> ${esc(f.text)}</div>`;
    }
  } else html += `<div class="muted">No recent activity from friends.</div>`;
  html += `</div></div>`;
  $('app').innerHTML = html;
}

// Bumped on every silent refresh kicked off below, so an older, slower response can never
// overwrite what a newer one already applied (e.g. two quick taps on "+ Add" firing two
// out-of-order background refreshes).
let SESSION_SILENT_SEQ = 0;
// A silent refresh is "for" this exact sheet — the one open when it was kicked off — not just
// "any sheet at all": editLogSet stacks a second .sheet-back on top of the log sheet without
// closing it, and closeSheet() only ever targets the first .sheet-back in document order, so a
// generic .sheet-back.show selector here would false-positive against a leaked, never-removed
// sheet from an earlier edit/delete. Checking the specific element openLogSheet stamped onto
// LOGVIEW avoids that.
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
  // Inline edit mode for a saved (posted) workout: render the whole page editable.
  if(EDITING_ID===id && isCreator && s.post){ renderWorkoutEdit(s); return; }
  const isParticipant = s.participants.includes(ME.id);
  // "in the workout" = you are actually part of it, not merely allowed to look at it
  const inTheWorkout = isParticipant || s.creatorId === ME.id || (Array.isArray(s.invited) && s.invited.includes(ME.id));
  const approvedJoin = s.joinRequests.find(j=>j.userId===ME.id&&j.status==='approved');
  const canEdit = s.post ? isCreator : (isParticipant || approvedJoin);
  // Suggesting is for everyone EXCEPT the creator, who does not need to suggest anything — they
  // have Edit. It rendered only for the creator, which is exactly backwards: the person holding
  // an invitation, the one with a reason to say "not Barbell Row", never saw it at all.
  const canSuggest = !isCreator && !s.post && !canEdit
    && Array.isArray(s.invited) && s.invited.includes(ME.id);
  // suggested edits, keyed by target exercise id (compact one-line inline row, C style)
  const editByEx = {};
  for(const ed of s.suggestedEdits){
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
    // A pending swap outranks everything else this line could say. It is the state of the lift.
    const statusTag = pendingSwap ? `<span class="swap-pending">Swap suggested by ${esc(swapBy)}</span>`
                     : canEdit ? (cnt ? `<span class="logged">✓ ${cnt} set${cnt>1?'s':''} logged</span>` : `<span class="log-hint">Tap to log sets →</span>`)
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
  // suggested edits (kept for any edits whose exercise no longer exists)
  let edits = '';
  for(const ed of s.suggestedEdits){
    if(editByEx[ed.exerciseId]) continue; // already shown inline above
    const byName = nameCache[ed.proposedBy] || ed.proposedBy;
    if(ed.status==='pending'){
      edits += `<div class="card"><div class="req"><div class="rc">${byName==='You' ? 'You suggested' : esc(byName)+' suggests'} → ${esc(ed.swapTo)}</div>`;
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
  // Back goes BACK. It was wired to Home, so arriving from a profile or the feed dumped you
  // somewhere you had never been. There is no router here, so the tab you were on IS the answer.
  const backTab = (document.querySelector('.nav button.active') || {}).dataset
    ? document.querySelector('.nav button.active').dataset.tab : 'home';

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
  const startedBy = pendingMe && !s.post ? whoLogged().filter(pid => pid !== ME.id) : [];
  const startedSets = startedBy.reduce((n,pid) => n + setsTotal(pid), 0);
  const firstName = pid => { const n = nameCache[pid]; return isUnknownName(n) ? 'Someone' : String(n).split(' ')[0]; };
  const startedLine = !startedBy.length ? '' : (() => {
    const names = startedBy.map(firstName);
    const label = names.length===1 ? `${esc(names[0])}'s already started`
                : names.length===2 ? `${esc(names[0])} and ${esc(names[1])} have already started`
                : `${esc(names[0])} and ${names.length-1} others have already started`;
    return `<div class="sess-started">${label} — ${startedSets} set${startedSets===1?'':'s'} in</div>`;
  })();

  let html = `<div class="wrap"><button class="sec sm" onclick="showTab('${backTab}')">← Back</button>
    <h1 class="sess-date">${sessTitle(s)}</h1>
    <div class="muted sess-meta">${sessSub(s)}${vis} · ${who}</div>
    ${facts?`<div class="tag">${facts}</div>`:''}
    ${startedLine}
    ${s.creatorNote?`<div class="sess-note">${esc(s.creatorNote)}</div>`:''}`;
  if(isCreator){
    html += `<div class="sess-actions">`;
    if(s.post){
      html += `<button class="sec sm" onclick="enterWorkoutEdit('${s.id}')">Edit</button>`;
    } else {
      html += `<button class="blue sm" onclick="lock('${s.id}')">Log & Finish</button>`;
      html += `<button class="sec sm" onclick="editSession('${s.id}')">Edit</button>`;
    }
    html += `<button class="red sm" onclick="deleteSession('${s.id}')">Delete session</button></div>`;
  }
  html += `<h2>Workout</h2>${myEx}`;
  if(canEdit) html += `<div class="muted" style="font-size:12px;margin:-4px 2px 10px">Tap an exercise to log your sets.</div>`;
  else if(canSuggest) html += `<div class="muted" style="font-size:12px;margin:-4px 2px 10px">Not feeling one of these? Tap it to propose a replacement — ${esc(isUnknownName(nameCache[s.creatorId])?'the host':String(nameCache[s.creatorId]).split(' ')[0])} approves it.</div>`;
  if(jr) html += `<h2 class="pt">Join requests</h2>${jr}`;
  if(s.post){
    // Completed/saved workout: Photos (where swap slot was), then Notes
    const postMedia = (Array.isArray(s.post.media)) ? s.post.media : [];
    if(isCreator || postMedia.length){
      html += `<h2>Photos</h2><div class="card center-v">
        <div class="media-line"><div class="add-media" title="Add photos or video" onclick="showSavePage('${s.id}')">
          <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>
          <span class="am-plus"></span></div>
          <span class="ml-text">Add a photo / video</span></div>
        ${postMedia.length?`<div class="thumbs">${postMedia.map(m=>`<div class="thumb">${m.type==='image'?`<img src="${esc(m.src)}">`:`<video src="${esc(m.src)}" muted></video>`}</div>`).join('')}</div>`:''}
      </div>`;
    }
    html += `<h2>Notes</h2><div class="notes-box">${s.post.notes ? esc(s.post.notes) : '<span class="muted">How\'d it go?</span>'}</div>`;
  } else if(!isCreator && canEdit){
    // You have joined and can log, so tapping a card logs — which means the cards are taken and
    // suggesting needs its own door. The creator does NOT get this: they have Edit, and a creator
    // suggesting a swap to themselves and then approving it is a loop, not a feature.
    html += `<h2 class="sep">Suggest a swap</h2><div class="card">
      <div class="muted" style="font-size:12.5px;margin:2px 2px 8px">Not feeling one of these? Propose a replacement — ${esc(isUnknownName(nameCache[s.creatorId])?'the host':String(nameCache[s.creatorId]).split(' ')[0])} approves it.</div>
      <select id="swEx" style="margin-bottom:10px">${s.exercises.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      <button class="sec sm" style="background:#f0f1f3; margin-bottom:5px" onclick="openSwapPicker('${s.id}')">Pick replacement from Workouts →</button>
    </div>`;
  }
  const isPosted = !!s.post;
  const respondHere = !isCreator && !s.post && !isParticipant;

  // Chat comes BEFORE the answer for someone deciding. Brian messages from the rack — "at the gym,
  // rack 3" — and that used to sit below the exercises AND below the buttons, so the most
  // time-sensitive thing on the screen was the last thing you saw. Read the plan, hear from him,
  // then answer.
  // Only people in the workout can post, so only they are offered the box. Rendering an input
  // that the server will refuse is a promise the app cannot keep.
  const canChat = isCreator || isParticipant || pendingMe;
  const chatBlock = `<h2>${isPosted?'Comments':'Chat'}</h2><div class="card"><div id="chatbox" class="scrolllist"></div>
    ${canChat ? `<div class="row chat-row"><input id="chatInput" class="chat-input" placeholder="${isPosted?'Add a comment…':'Message the crew'}"><button class="sm chat-send" onclick="sendChat('${s.id}')">Send</button></div>` : ''}</div>`;

  // "Friends joined" was wrong for the creator, who did not join anything. It DOES list everyone
  // else in the workout, which is worth keeping — it was the name that was off.
  const crewBlock = (s.participants.filter(p=>p!==ME.id).length)
    ? `<h2>Who's in</h2><div class="chips mini">${s.participants.filter(p=>p!==ME.id).map(pid=>{
        const known = !isUnknownName(nameCache[pid]);
        const label = known ? String(nameCache[pid]) : 'A friend';
        return `<div class="fav"><div class="fav-av" style="background:${avatarColor(label)};color:#fff">${esc(label[0])}</div><span>${esc(label)}</span></div>`;
      }).join('')}</div>`
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
  } else {
    html += crewBlock + chatBlock;
  }
  html += `</div>`;
  // Re-checked here, not just right after the fetch: the name-lookup awaits above take their
  // own time, and a silent refresh must not land on whatever screen the user has since moved to.
  if(silent && (mySeq !== SESSION_SILENT_SEQ || !logSheetStillOpenFor(id))) return;
  $('app').innerHTML = html;
  loadChat(s);
}
// ===== Dedicated POSTED-WORKOUT view (read-only, like an Instagram/Hevy post) =====
// Opened when tapping a saved workout on a profile. Creator-only ⋯ menu (edit/delete).
async function viewPost(id){
  const s = await H.get('/api/sessions/'+id);
  if(!s || (s.error && !s._expired)){ alert(s && s.error ? s.error : 'Session not found'); return; }
  s.participants = s.participants || [];
  s.exercises = s.exercises || [];
  const isCreator = s.creatorId===ME.id;
  const post = s.post || {};
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
  // Who sees whose: if you were IN the workout you see everyone in it; if you are just a friend
  // scrolling someone's profile you see the creator's sets, exactly as before. GET
  // /api/sessions/:id hands every participant's logs to any friend of the creator, so without
  // this gate a friend-of-a-friend would be shown a partner's sets that partner never agreed to
  // publish to them. Do not widen this without asking Jeff.
  const inTheWorkout = (s.participants||[]).includes(ME.id) || s.creatorId === ME.id;
  const logged = Object.keys(s.logs||{})
    .filter(pid => (s.logs[pid]||[]).length && (inTheWorkout || pid === s.creatorId))
    .sort((x,y) => (x===s.creatorId ? -1 : y===s.creatorId ? 1 : String(logNames[x]||'').localeCompare(String(logNames[y]||''))));
  const setRows = ls => `<div class="pp-sets">${ls.map(l=>`<div class="pp-set">${ (()=>{ const b = l.setType==='warmup'?{t:'W',c:'warm'}:l.setType==='drop'?{t:'D',c:'drop'}:l.setType==='failure'?{t:'F',c:'fail'}:{t:(l.set||'·'),c:''}; return `<span class="pp-set-n ${b.c}">${b.t}</span>`; })() }<span class="pp-set-val">${Number(l.weight)||0} ${unitOf(l)} × ${Number(l.reps)||0} reps</span>${l.isPr?'<span class="pp-pr">PR</span>':''}</div>`).join('')}</div>`;
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
      return who + setRows(ls);
    }).filter(Boolean).join('');
    const setsHtml = blocks || `<div class="pp-sets muted" style="font-size:12px;padding-top:2px">No sets logged</div>`;
    return `<div class="pp-ex"><div class="pp-ex-name">${esc(heading)}</div></div>${setsHtml}`;
  }).join('');
  const photos = media.length ? `<h2>Photos</h2><div class="pp-photos">${media.map((m,i)=>`<div class="pp-photo">${m.type==='image'?`<img src="${esc(m.src)}" alt="">`:`<video src="${esc(m.src)}" muted></video>`}${isCreator?`<button class="pp-photo-x" onclick="deletePhoto('${id}',${i})" aria-label="Delete photo">✕</button>`:''}</div>`).join('')}</div>${media.length>1?`<div class="pp-photo-dots" id="ppDots-${id}">${media.map((_,i)=>`<span class="pp-dot${i===0?' on':''}"></span>`).join('')}</div>`:''}` : '';
  const notes = post.notes ? esc(post.notes) : '<span class="muted">How\'d it go?</span>';
  const dots = isCreator ? `<button class="pp-dots" onclick="togglePostMenu('${id}')" aria-label="More">\u22ef</button><div class="pp-menu" id="ppMenu-${id}" style="display:none"><button onclick="enterWorkoutEdit('${id}')">Edit session</button><button class="danger" onclick="deleteSession('${id}')">Delete session</button></div>` : '';
  const html = `<div class="wrap">\n    <div class="pp-head"><button class="sec sm" onclick="showTab('home')">← Back</button>${dots}</div>\n    <h1 class="sess-date">${sessTitle(s)}</h1>\n    <div class="muted sess-meta">${sessSub(s)}${s.visibility==='friends'?'Friends-only':'Private'}${collab}</div>\n    ${photos}\n    <h2>Workout</h2>${exList}\n    <h2>Notes</h2><div class="notes-box">${notes}</div>\n    <h2>Comments</h2><div class="card"><div id="chatbox" class="scrolllist"></div>\n      <div class="row chat-row"><input id="chatInput" class="chat-input" placeholder="Add a comment…"><button class="sm chat-send" onclick="sendPostComment('${id}')">Send</button></div></div>`;
  $('app').innerHTML = html;
  if(media.length>1){
    const strip=document.querySelector('.pp-photos');
    const dots=document.querySelectorAll('#ppDots-'+id+' .pp-dot');
    if(strip) strip.addEventListener('scroll',()=>{
      const i=Math.round(strip.scrollLeft/Math.max(1,strip.clientWidth));
      dots.forEach((d,k)=>d.classList.toggle('on',k===i));
    }, {passive:true});
  }
  loadChat(s);
}
// ===== Recovered post-view + chat helpers =====
function togglePostMenu(id){ const m=document.getElementById('ppMenu-'+id); if(m) m.style.display = m.style.display==='none'?'block':'none'; }
async function sendPostComment(id){ const t=$('chatInput').value; if(!t.trim()) return; await H.post(`/api/sessions/${id}/comments`,{text:t}); $('chatInput').value=''; viewPost(id); }
async function deletePhoto(id, idx){
  if(!confirm('Delete this photo?')) return;
  const s = await H.get('/api/sessions/'+id);
  if(!s || !s.post) return;
  const media = (s.post.media||[]).filter((_,i)=>i!==idx);
  const r = await H.post(`/api/sessions/${id}/post`, { notes: s.post.notes||'', media, visibility: s.post.visibility||'only_me' });
  if(r && r.error){ alert(r.error); return; }
  viewPost(id);
}
async function acceptInvite(id){ await H.post(`/api/sessions/${id}/accept`,{}); openSession(id); }
async function declineInvite(id){ if(!confirm('Decline this invite?')) return; await H.post(`/api/sessions/${id}/decline`,{}); home(); }
async function requestChanges(id){ const t=prompt('What changes do you want?'); if(t) { await H.post(`/api/sessions/${id}/comments`,{text:'Request changes: '+t}); openSession(id); } }
async function saveRoutine(id){ const s=await H.get('/api/sessions/'+id); const r=await H.post('/api/templates',{name:prompt('Template name:','Saved routine')||'Saved routine',exercises:s.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax}))}); alert('Saved as template: '+r.name); }
async function openChat(id){ document.getElementById('chatInput').focus(); }
async function sendChat(id){
  const t=$('chatInput').value; if(!t.trim()) return;
  const r = await H.post(`/api/sessions/${id}/comments`,{text:t});
  // this used to throw the response away, so a refused message simply disappeared and the box
  // cleared as though it had sent
  if(!r || r.error){ alert((r && r.error) === 'forbidden' ? 'Only people in this workout can post here.' : ((r && r.error) || 'That did not send. Try again.')); return; }
  $('chatInput').value=''; openSession(id);
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
    const col = c.userId===ME.id?'#f0a23c':avatarColor(nm[c.userId]||c.userId);
    const t = new Date(c.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    return '<div class="cmt"><div class="fav-av" style="background:'+col+';color:#fff">'+esc(ini)+'</div><div class="cmt-body"><div class="cmt-head"><b>'+esc(name)+'</b> <span class="muted" style="font-size:11px">'+t+'</span></div><div class="cmt-text">'+esc(c.text)+'</div></div></div>';
  }).join('');
}

function swapCancel(){
  const id = SWAP_SESSION;
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;
  openSession(id || '');
}
async function swapPick(name){
  const id = SWAP_SESSION;
  if(!id) return;
  const fromId = SWAP_FROM;
  SWAP_MODE = false;
  SWAP_SESSION = null; SWAP_FROM = null;
  const r = await H.post(`/api/sessions/${id}/suggest`,{exerciseId:fromId, swapTo:name});
  if(r.error) alert(r.error); else openSession(id || '');
}
async function suggest(id){ const r=await H.post(`/api/sessions/${id}/suggest`,{exerciseId:$('swEx').value,swapTo:$('swTo').value}); if(r.error)alert(r.error); else openSession(id); }

// ---- The collaborate half: five buttons that called functions nobody ever wrote ----
// Approve/Reject on a suggested swap, Approve/Reject on a join request, and the door into the
// swap picker. Every server endpoint below already existed, worked and was tested; the other half
// of the swap flow (swapPick/swapCancel, just above) was already written too. Only these five
// wrappers were missing — so the buttons rendered, looked exactly like live ones, and did nothing.
// A dead button is indistinguishable from a working one until you press it.
async function approve(id, editId){
  const r = await H.post(`/api/sessions/${id}/suggest/${editId}/approve`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else openSession(id);
}
async function reject(id, editId){
  const r = await H.post(`/api/sessions/${id}/suggest/${editId}/reject`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else openSession(id);
}
async function approveJoin(id, reqId){
  const r = await H.post(`/api/sessions/${id}/join/${reqId}/approve`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else openSession(id);
}
async function rejectJoin(id, reqId){
  const r = await H.post(`/api/sessions/${id}/join/${reqId}/reject`, {});
  if(!r || r.error) alert((r && r.error) || 'That did not go through. Try again.'); else openSession(id);
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
  showTab('lib', true);
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
  LOGVIEW = { sid, exId, loadType };
  const mine = (s.logs && s.logs[ME.id]) || [];
  const exLogs = mine.filter(l=>l.exerciseId===exId);
  const bestLog = exLogs.slice().sort((a,b)=>((Number(b.weight)||0)*(Number(b.reps)||0))-((Number(a.weight)||0)*(Number(a.reps)||0)))[0];
  const last = bestLog ? `${bestLog.weight} × ${bestLog.reps}` : '—';
  const sheet = document.createElement('div'); sheet.className='sheet-back';
  sheet.innerHTML = `
    <div class="sheet log-sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Log · ${esc(e.name)}</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="ex-sub">${repLabel(e) ? `Target: <b>${e.defaultSets} × ${repLabel(e)}</b> · ` : ''}Last time: <b>${esc(last)}</b></div>
      <div id="logRec"></div>
      <div id="logSetList"></div>
      <div class="seg" id="logTypeSeg">
        ${SET_TYPES.map((t,i)=>`<div class="chip${i===0?' on':''}" data-t="${t.key}" onclick="logSetType('${t.key}')">${t.label}</div>`).join('')}
      </div>
      <div class="add-row">
        <input id="logW" placeholder="${loadType==='pair'? myUnit()+' each' : myUnit()}" type="number" inputmode="tel" pattern="[0-9]*" oninput="updateLoadHint()">
        <input id="logR" placeholder="reps" type="number" inputmode="tel" pattern="[0-9]*">
        <button class="add-btn" onclick="addLogSet()">+ Add</button>
      </div>
      ${loadType?`<div class="load-note">
        <span class="load-chip">${LOAD_LABEL[loadType]}</span>
        <span class="load-hint" id="logLoadHint" data-load="${loadType}">${loadHintText(loadType,'')}</span>
      </div>`:''}
      <div id="logRest"></div>
      <div class="note">Tap a set to edit or delete it. Set # auto-fills.</div>
    </div>`;
  sheet.onclick=(ev)=>{ if(ev.target===sheet) closeSheet(); };
  document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
  // Stamped onto LOGVIEW so a background silent refresh (see openSession's opts.silent) can
  // check THIS exact sheet's presence/visibility, not just "some .sheet-back.show exists
  // somewhere" — editLogSet stacks a second .sheet-back on top of this one without closing it,
  // and closeSheet() only ever targets the first .sheet-back in document order, so a generic
  // selector here would false-positive (or worse, false-negative) once that's happened.
  LOGVIEW.sheetEl = sheet;
  renderLogSets(s);
  // The advice belongs HERE, at the moment the weight is chosen — not only on a tab the user
  // has to remember to open before leaving for the gym. Loaded after the sheet is on screen
  // so it never delays opening.
  H.get('/api/progress/exercise/'+encodeURIComponent(recName)).then(r=>{
    const box=document.getElementById('logRec'); if(!box||!r||r.error) return;
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
function logSetType(key){
  const seg=document.getElementById('logTypeSeg'); if(!seg) return;
  seg.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on', c.getAttribute('data-t')===key));
}
function renderLogSets(s){
  const list=document.getElementById('logSetList'); if(!list) return;
  const mine=(s.logs&&s.logs[ME.id])||[];
  const exLogs=mine.filter(l=>l.exerciseId===LOGVIEW.exId).sort((a,b)=>(a.set||0)-(b.set||0));
  if(!exLogs.length){ list.innerHTML='<div class="muted" style="padding:10px 2px">No sets logged yet.</div>'; return; }
  // Prefer the loadType stamped on the set when it was logged; fall back to the exercise's
  // current tag only for sets predating the stamp. Re-tagging an exercise must not change
  // how sets already logged under the old meaning are displayed.
  const fallback = (LOGVIEW && LOGVIEW.loadType) || '';
  const suffixFor = l => { const t = l.loadType || fallback;
    return t==='pair' ? ' each' : t==='added' ? ' added' : ''; };
  list.innerHTML = exLogs.map(l=>`<div class="set-row" onclick="editLogSet('${l.id}')">
      <div class="set-n">${l.set||'·'}</div>
      <div class="set-vals"><b>${Number(l.weight)||0} ${unitOf(l)}${suffixFor(l)}</b> · <span class="sub">${Number(l.reps)||0} reps</span></div>
      <span class="type-tag ${TYPE_CLASS[l.setType]||'t-normal'}">${TYPE_LABEL[l.setType]||'Normal'}</span>
      ${l.isPr?'<span class="type-tag pr">PR</span>':''}
    </div>`).join('');
}
async function addLogSet(){
  const w=document.getElementById('logW').value, r=document.getElementById('logR').value;
  // reps are required — a set with a weight and no reps used to save as reps:0, which then
  // read as a failed set. Weight may legitimately be blank/0 for bodyweight movements.
  if(!(Number(r) > 0)){ alert('How many reps did you do?'); return; }
  const seg=document.getElementById('logTypeSeg');
  const type=(seg&&seg.querySelector('.chip.on'))?seg.querySelector('.chip.on').getAttribute('data-t'):'normal';
  const s=await H.post(`/api/sessions/${LOGVIEW.sid}/log`,{exerciseId:LOGVIEW.exId,weight:w,reps:r,setType:type});
  // Leave what was typed in the boxes if it did not save. They were cleared unconditionally, so
  // a failed request threw the set away and you had to remember it and type it again.
  if(s.error){ alert(s.error); return; }
  LOGVIEW.sid && renderLogSets(s);
  document.getElementById('logW').value=''; document.getElementById('logR').value='';
  startRest();
  // Update the "✓ N sets logged" badge on the workout page behind this sheet right now, instead
  // of only the next time it's opened. Fire-and-forget on purpose — the sheet above has already
  // been updated and must not wait on this.
  if(LOGVIEW.sid) openSession(LOGVIEW.sid, {silent:true});
}
async function editLogSet(logId){
  const s=await H.get('/api/sessions/'+LOGVIEW.sid);
  const mine=(s.logs&&s.logs[ME.id])||[];
  const l=mine.find(x=>x.id===logId); if(!l) return;
  const sheet=document.createElement('div'); sheet.className='sheet-back';
  sheet.innerHTML=`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Edit set</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="ex-sub">Set ${l.set||''}</div>
      <label class="muted" style="font-size:12px">Weight (${unitOf(l)}${(LOGVIEW&&LOGVIEW.loadType==='pair')?', each hand':(LOGVIEW&&LOGVIEW.loadType==='added')?' added':''})</label>
      <input id="edW" type="number" inputmode="tel" pattern="[0-9]*" value="${l.weight}">
      <label class="muted" style="font-size:12px">Reps</label>
      <input id="edR" type="number" inputmode="tel" pattern="[0-9]*" value="${l.reps}">
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
  const s=await H.put(`/api/sessions/${LOGVIEW.sid}/log/${logId}`,{weight:w,reps:r,setType:t});
  if(s.error){ alert(s.error); return; }
  const sid = LOGVIEW.sid;
  closeSheet(); openLogSheet(LOGVIEW.sid, LOGVIEW.exId);
  if(sid) openSession(sid, {silent:true});
}
async function delLogSet(logId){
  if(!confirm('Delete this set?')) return;
  const s=await H.delete(`/api/sessions/${LOGVIEW.sid}/log/${logId}`);
  if(s.error){ alert(s.error); return; }
  const sid = LOGVIEW.sid;
  closeSheet(); openLogSheet(LOGVIEW.sid, LOGVIEW.exId);
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
async function lock(id){ await H.post(`/api/sessions/${id}/lock`); showSavePage(id); }

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
  let next=[];
  try{
    const p = await H.get('/api/progress?weeks=4');
    const names = new Set(rows.map(r=>r.nm));
    next = ((p && p.ready) || []).filter(x=>names.has(x.exercise));
  }catch(e){}

  // Finishing a workout you did not personally log is a real case (logged on paper, or only the
  // other participant logged). "Nice work" over three zeros and an empty card is a lie.
  if(!rows.length || !sets){ showTab('home'); return; }
  const fmt = n => Math.round(n).toLocaleString('en-US');
  let h = `<div class="wrap rc-wrap">
    <div class="rc-h1">Nice work</div>
    <div class="rc-sub">${esc(s.name||'Workout')} · ${rcDay(s.scheduledAt)}${
      (s.participants||[]).length>1?` · with ${s.participants.length-1} other${s.participants.length>2?'s':''}`:''}</div>
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
        const cls = warm||drop ? ' warm' : (hit ? ' top' : '');
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
  // rcDay already does String(v||'').slice — this was the one place that did not, and scheduledAt
  // is stored exactly as sent. A creator who posts a number here killed the Save screen for every
  // participant who opens it, not just their own. This stops the crash; it does not make the date
  // right — a value that is not an ISO string still reads "Invalid Date" in the line below. Making
  // it read correctly means changing what this screen shows, so it is not smuggled in here.
  const when = s.scheduledAt ? fmtDate(String(s.scheduledAt).slice(0,10)) : '';
  const post = s.post || {};
  const vis = post.visibility || 'only_me';
  const visHint = vis==='only_me'?'Only you can see this on your profile.' : vis==='friends'?'Friends can see this on your profile.' : 'Anyone can see this on your profile.';
  const media = Array.isArray(post.media) ? post.media : [];
  $('app').innerHTML = `<div class="wrap save-page">
    <h1>Save workout</h1>
    <p class="sub">${esc(s.name||'Workout')} · ${when} · ${(s.exercises||[]).length} exercises</p>
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
  const r=await H.post(`/api/sessions/${id}/post`,{ notes, media: window.__saveMedia||[], visibility: window.__saveVis||'only_me' });
  if(r && r.error){ alert(r.error); return; }
  showRecap(id);          // the recap is the LAST thing, after saving — notes and photos are done
}
async function deleteSession(id){
  if(!confirm('Delete this workout?')) return;
  const r = await H.delete(`/api/sessions/${id}`);
  // Someone else logged sets in it, so deleting would erase their training history too. Offer
  // to take yourself out instead — the same shape as declining an invite, which removes only you.
  if(r && r.canLeave){
    if(!confirm(r.error + '\n\nRemove it from your profile instead? Your sets go with you; theirs stay.')) return;
    const l = await H.post(`/api/sessions/${id}/leave`, {});
    if(l && l.error){ alert(l.error); return; }
    home(); return;
  }
  if(r && r.error){ alert(r.error); return; }
  home();
}

// ===== Inline edit mode for saved (posted) workouts =====
let INLINE_DIRTY = false;
function markDirty(){ INLINE_DIRTY = true; }
function enterWorkoutEdit(id){ EDITING_ID = id; openSession(id); }
async function exitWorkoutEdit(id){
  if(INLINE_DIRTY && !confirm('Discard your changes?')) return;
  INLINE_DIRTY = false; EDITING_ID = null;
  const s = await H.get('/api/sessions/'+id);
  if(s && s.post) viewPost(id); else openSession(id);
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
function renderWorkoutEdit(s){
  INLINE_DIRTY=false;
  const vis = (s.post && s.post.visibility) || 'only_me';
  window.__saveVis = vis;
  const media = (s.post && Array.isArray(s.post.media)) ? s.post.media : [];
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
    <div class="edit-banner">✎ Editing — tap Save when done</div>
    <h1 class="sess-date">${sessTitle(s)}</h1>
    ${sessSub(s) ? `<div class="muted sess-meta">${fmtWhen(s.scheduledAt)}</div>` : ''}
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
    <textarea id="saveNotes" placeholder="How'd it go?">${esc((s.post&&s.post.notes)||'')}</textarea>
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
async function saveWorkoutEdit(id){
  const s = await H.get('/api/sessions/'+id);
  if(!s||s.error){ alert(s&&s.error?s.error:'Session not found'); return; }
  const rows=[...document.querySelectorAll('.inex-row')];
  const exercises=rows.map(r=>{ const eid=r.dataset.ex;
    return { id:eid, name:(document.getElementById('inex-name-'+eid)||{}).value||'Exercise',
      defaultSets:Number((document.getElementById('inex-sets-'+eid)||{}).value||3),
      defaultReps:Number((document.getElementById('inex-reps-'+eid)||{}).value||10),
      defaultRepsMax:Number((document.getElementById('inex-repsmax-'+eid)||{}).value)||undefined };
  });
  if(!exercises.length){ alert('Add at least one exercise'); return; }
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
  if(touched.length && !confirm(touched.length+' friend(s) logged sets on: '+touched.join(', ')+'. Saving will detach those sets. Continue?')) return;
  const notes=document.getElementById('saveNotes').value;
  const r1=await H.put('/api/sessions/'+id,{ name:s.name, scheduledAt:s.scheduledAt, visibility:s.visibility, exercises, invited:(s.invited||[]), location:s.location, lengthMin:s.lengthMin, creatorNote:s.creatorNote });
  if(r1&&r1.error){ alert(r1.error); return; }
  const r2=await H.post(`/api/sessions/${id}/post`,{ notes, media: window.__saveMedia||[], visibility: window.__saveVis||'only_me' });
  if(r2&&r2.error){ alert(r2.error); return; }
  INLINE_DIRTY=false; EDITING_ID=null;
  if(s.post) viewPost(id); else openSession(id);
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
    <button class="sec sm" onclick="templatesPage()">Browse templates</button>
    <button class="sec sm" onclick="tplQuickSaveSheet()">Save as template</button>
    </div>
    <h2>Invite friends</h2><div id="invList" class="card">${invRows}</div>
    ${EDITING_SESSION ? '<button class="blue" onclick="submitSession()">Save changes</button>' : '<button class="blue" onclick="submitSession()">Create workout</button>'}</div>`;
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
  const r = editing
    ? await H.put('/api/sessions/'+editing, payload)
    : await H.post('/api/sessions', payload);
  if(r.error) return alert(r.error);
  // MUST be cleared. Nothing cleared it on success before, so the next "+ New workout" would have
  // saved itself over the workout you had just edited.
  EDITING_SESSION = null;
  // only offered when creating — you do not re-save a template every time you fix a typo
  if(!editing && confirm('Save this as a template for next time?')){
    await H.post('/api/templates',{name:prompt('Template name:',name||'My workout')||'My workout',exercises:DRAFT.exercises});
  }
  home();
}
let EDITING_SESSION = null;
// A NEW workout starts empty. createFlow() cannot do this itself — it is also where you land
// coming back from the exercise picker, and clearing there would throw away what you just added.
// Without this, "+ New workout" opened pre-filled with the last workout you edited.
function newWorkout(){
  DRAFT = { exercises:[], inviteUsernames:[] };
  EDITING_SESSION = null; EDITING_TPL = null; EDITING_ID = null;
  createFlow();
}
function cancelCreate(){ EDITING_SESSION=null; EDITING_TPL=null; home(); }
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
const TPL_MODE = { active:false, id:null, name:'' };   // active while building a template
async function templatesPage(){
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  const { mine, shared } = await H.get('/api/templates');
  window._TPL = { mine, shared };
  const row = (t)=>`<div class="lib-item"><div style="flex:1;min-width:0"><div style="font-weight:600">${esc(t.name)}</div><div class="muted" style="font-size:12px">${t.exercises.length} exercises</div></div>
    <button class="sec sm" onclick="tplUse('${t.id}')">Use</button>
    ${t.ownerId===ME.id?`<button class="sec sm" onclick="tplEdit('${t.id}')">Edit</button><button class="sec sm red" onclick="tplDelete('${t.id}')">Delete</button>`:''}</div>`;
  $('app').innerHTML = `<div class="wrap tpl-page">
    <div class="pick-head lib-head"><h1 style="flex:1">Templates</h1>
      <button class="icon-btn" onclick="tplNew()" title="New template">＋</button></div>
    <div class="muted" style="font-size:13px;margin:4px 2px 12px">Reusable workouts. Build one, then use it to start a new session in a tap.</div>
    ${mine.length?mine.map(row).join(''):'<div class="card muted" style="padding:16px;text-align:center">No templates created. Tap ＋ to create one.</div>'}
    ${shared.length?`<div class="lib-cat" style="margin-top:12px">Shared by friends</div>`+shared.map(row).join(''):''}</div>`;
}
function tplNew(){
  TPL_MODE.active=true; TPL_MODE.id=null; TPL_MODE.name='';
  DRAFT={ exercises:[] }; EDITING_TPL=null;
  openSheetHtml(`<div class="sheet"><div class="sheet-head"><h2>Name template</h2></div>
    <label class="muted">Template name</label>
    <input id="tplName" placeholder="e.g. Push Day" autocomplete="off">
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="sec" style="flex:1" onclick="closeSheet()">Cancel</button>
      <button class="blue" style="flex:1" onclick="tplConfirmName()">✓ Create</button>
    </div></div>`);
  setTimeout(()=>{ const i=$('tplName'); if(i) i.focus(); }, 60);
}
function tplConfirmName(){
  const n=$('tplName').value.trim();
  if(!n){ alert('Name your template first.'); return; }
  TPL_MODE.name=n; closeSheet(); templateExercises();
}
async function tplEdit(id){
  const { mine } = await H.get('/api/templates');
  const t = mine.find(x=>x.id===id); if(!t) return;
  TPL_MODE.active=true; TPL_MODE.id=id; TPL_MODE.name=t.name;
  DRAFT={ exercises:t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax})) };
  EDITING_TPL=id;
  templateExercises();
}
async function tplDelete(id){
  const { mine } = await H.get('/api/templates');
  const t = mine.find(x=>x.id===id); if(!t) return;
  const r = await H.delete('/api/templates/'+id);
  if(r.error) alert(r.error); else templatesPage();
}
async function templateExercises(){
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  const nameField = TPL_MODE.id
    ? `<input id="tplNameEdit" class="tpl-name-edit" value="${esc(TPL_MODE.name||'')}" placeholder="Template name" autocomplete="off">`
    : `<h1>${esc(TPL_MODE.name||'Template')}</h1>`;
  $('app').innerHTML = `<div class="wrap create-flow">
    <button class="sec sm" onclick="closeSheet();templatesPage()">← Back</button>
    ${nameField}
    <h2>Exercises</h2><div id="draftList" class="card"></div>
    <button class="sec" onclick="tplOpenPicker()">+ Add exercise</button>
    <button class="blue" onclick="finishTemplate()">✓ ${TPL_MODE.id?'Save changes':'Create template'}</button></div>`;
  renderDraft();
}
function tplOpenPicker(){ openAddExercises(); }
async function finishTemplate(){
  if(!DRAFT.exercises.length){ alert('Add at least one exercise'); return; }
  const liveName = (TPL_MODE.id && $('tplNameEdit')) ? $('tplNameEdit').value.trim() : TPL_MODE.name.trim();
  if(!liveName){ alert('Name your template first.'); return; }
  const payload = { name:liveName, exercises:DRAFT.exercises };
  const r = TPL_MODE.id
    ? await H.put('/api/templates/'+TPL_MODE.id, payload)
    : await H.post('/api/templates', payload);
  if(r.error) return alert(r.error);
  TPL_MODE.active=false; TPL_MODE.id=null; templatesPage();
}
async function tplUse(id){
  const { mine, shared } = await H.get('/api/templates');
  const t = [...mine,...shared].find(x=>x.id===id); if(!t) return;
  DRAFT = DRAFT || { exercises:[], inviteUsernames:[] };
  DRAFT.exercises = t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps,defaultRepsMax:e.defaultRepsMax}));
  EDITING_TPL = null;
  createFlow();
}
function tplQuickSaveSheet(){
  if(!DRAFT.exercises.length){ alert('Add exercises first, then save as a template.'); return; }
  openSheetHtml(`<div class="sheet"><div class="sheet-head"><h2>Save as template</h2></div>
    <label class="muted">Template name</label>
    <input id="tplName" placeholder="${esc(DRAFT.name||'My workout')}" autocomplete="off">
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="sec" style="flex:1" onclick="closeSheet()">Cancel</button>
      <button class="blue" style="flex:1" onclick="tplQuickSaveConfirm()">✓ Save</button>
    </div></div>`);
  setTimeout(()=>{ const i=$('tplName'); if(i) i.focus(); }, 60);
}
async function tplQuickSaveConfirm(){
  const n=$('tplName').value.trim(); if(!n){ alert('Name your template first.'); return; }
  closeSheet();
  if(!DRAFT.exercises.length){ return alert('Add exercises first.'); }
  const r = EDITING_TPL
    ? await H.put('/api/templates/'+EDITING_TPL,{name:n,exercises:DRAFT.exercises})
    : await H.post('/api/templates',{name:n,exercises:DRAFT.exercises});
  if(r.error) return alert(r.error);
  alert('Template saved: '+n);
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
const GROUP_LABEL = { legs:'Legs', push:'Push', pull:'Pull', core:'Core', cardio:'Cardio', other:'Other' };

// A bodyweight best has no weight — "0 × 10" reads as broken. Show the reps, which is what
// you actually compare bodyweight sets on.
// "2026-05-01" -> "May 1"
function shortDate(iso){
  const d=new Date(iso+'T00:00:00Z'); if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'});
}
function prLabel(p,U){
  const w=Number(p.weight)||0;
  if(w===0) return `${p.reps} reps`;
  return `${w} ${U} × ${p.reps}`;
}

// Strength trend chart. Single series, so no legend — the chip above names it. Selective
// labels only (never a number on every point). Values are reachable by tap, not hover only.
let TREND_PICK = '__overall';
function setTrendPick(k){ TREND_PICK=k; progressScreen(); }
function trendChart(d, U){
  const t = d.trend || {lifts:[], overall:[]};
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
    grid+=`<line x1="${PL}" y1="${ys(g)}" x2="${W-PRr}" y2="${ys(g)}" stroke="${zero?'#d8dde4':'#eef1f5'}" stroke-width="1"/>`;
    lbl+=`<text x="${PL-7}" y="${ys(g)+3.5}" text-anchor="end" font-size="9.5" fill="#5c6470">${isOverall?((g>0?'+':'')+g+'%'):g}</text>`;
  }
  const poly=pts.map((p,i)=>`${xs(i)},${ys(p.v)}`).join(' ');
  let dots='',hits='';
  pts.forEach((p,i)=>{ const last=i===pts.length-1;
    dots+=`<circle cx="${xs(i)}" cy="${ys(p.v)}" r="${last?5.5:4.2}" fill="${last?'#2563eb':'#fff'}" stroke="#2563eb" stroke-width="2"/>`;
    hits+=`<circle cx="${xs(i)}" cy="${ys(p.v)}" r="15" fill="transparent"><title>${shortDate(p.at)}: ${isOverall?((p.v>=0?'+':'')+p.v+'% vs start'):`${p.w} ${U} × ${p.r} — est. max ${p.v} ${U}`}</title></circle>`;});
  let xl='';
  [[0,'start'],[pts.length-1,'end']].forEach(([i,a])=>{
    xl+=`<text x="${xs(i)}" y="${H-7}" text-anchor="${a}" font-size="9.5" fill="#5c6470">${shortDate(pts[i].at)}</text>`;});
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

  return `<h2>Strength trend</h2>${chips}<div class="card">
    <div class="ch-head">${head}</div>
    <div class="ch-note">${isOverall
      ? `Each lift compared with where it started, weighted by how heavy it is`
      : `${esc(lift.name)} · best working set per session`}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
      ${grid}<polyline points="${poly}" fill="none" stroke="#2563eb" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/>${dots}${lbl}${xl}${hits}</svg>
    ${drivers}
    <div class="tblnote">${isOverall
      ? 'Lifts you have trained at least twice. Tap a point for the exact figure.'
      : `Estimated max is what your best set predicts for one all-out rep (weight × [1 + reps ÷ 30]),
         so a heavy triple and a light set of ten compare fairly.`}</div>
  </div>`;
}

async function progressScreen(){
  const d = await H.get('/api/progress?weeks='+PROG_WEEKS);
  if(!d || d.error){ $('app').innerHTML = `<div class="wrap"><h1>Progress</h1><div class="muted">Couldn\'t load progress.</div></div>`; return; }
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

  // --- consistency ---
  const maxd = Math.max(6, ...d.weeks.map(w=>w.days));
  const BW=326, BH=96, BB=20, BT=6, gap=5;
  const cw = Math.min(30,(BW-gap*(d.weeks.length-1))/d.weeks.length);
  let bars='', xlab='', hits='';
  d.weeks.forEach((w,i)=>{
    const x=i*(cw+gap), h=Math.max(3,(BH-BB-BT)*w.days/maxd), y=BH-BB-h;
    const cur=i===d.weeks.length-1;
    const shade = w.days<=1?'var(--s1)': w.days<=2?'var(--s2)': w.days<=3?'var(--s3)':'var(--s4)';
    bars+=`<rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="4" fill="${shade}" ${cur?'stroke="#2563eb" stroke-width="2"':''}/>`;
    // Per-bar counts earn their place at 4 and 13 bars. At 26 they become a wall of digits
    // above a chart whose job at that zoom is shape, not exact counts — the bar height and
    // shade already carry it, and the value is still available on tap.
    if(d.weeks.length <= 13)
      bars+=`<text x="${x+cw/2}" y="${y-3.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${cur?'#15181f':'#5c6470'}">${w.days}</text>`;
    hits+=`<rect x="${x-gap/2}" y="0" width="${cw+gap}" height="${BH-BB}" fill="transparent"><title>Week of ${w.weekOf}: ${w.days} day${w.days===1?'':'s'}</title></rect>`;
    if(i===0||cur) xlab+=`<text x="${cur?BW:0}" y="${BH-6}" text-anchor="${cur?'end':'start'}" font-size="9.5" fill="#5c6470">${cur?'this week':shortDate(w.weekOf)}</text>`;
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
          <div class="pr-r"><div class="pr-w">${prLabel(p,U)}</div>
            ${p.goal?`<div class="pr-goal">goal ${p.goal} ${U}</div>`:''}</div></div>`;
        if(p.beatSeed) return `<div class="pr pr-beat">
          <div><div class="pr-n">${esc(p.exercise)}</div>
            <div class="pr-beat-was">Beat the <b>${p.seedWeight} × ${p.seedReps}</b> you entered</div></div>
          <div class="pr-r"><div class="pr-w">${prLabel(p,U)}</div>
            <div class="beat-chip">▲ Record beaten</div></div></div>`;
        return `<div class="pr">
          <div><div class="pr-n">${esc(p.exercise)}</div><div class="pr-d">${fmtDate(p.at)}</div></div>
          <div class="pr-r"><div class="pr-w">${prLabel(p,U)}</div>
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

    <h2>Consistency</h2>
    <div class="card">
      <div class="kpi"><div>
        ${d.weeks.some(w=>w.days)
          ? `<div class="hero">${d.avgPerWeek}<span class="hero-u"> days/week average</span></div>
             <div class="hero-cap">over ${(PROG_RANGES.find(r=>r.weeks===d.weeks.length)||{label:d.weeks.length+' weeks'}).label.toLowerCase()}</div>`
          : `<div class="hero" style="font-size:17px">No workouts logged yet</div>`}
      </div>${d.streakWeeks>0?`<span class="streak">${d.streakWeeks}-week streak</span>`:''}</div>
      ${d.weeks.some(w=>w.days)
        ? `<svg viewBox="0 0 ${BW} ${BH}" width="100%" style="display:block" role="img"
             aria-label="Days trained per week over ${d.weeks.length} weeks. Most recent: ${d.thisWeek} days.">${bars}${xlab}${hits}</svg>`
        : `<div class="muted" style="padding:14px 2px 6px;line-height:1.5">Your training weeks will
             chart here. Two or three a week is plenty to see a pattern.</div>`}
      <div class="seg wk-seg">
        ${PROG_RANGES.map(r=>`<button class="${PROG_WEEKS===r.weeks?'on':''}" onclick="setProgWeeks(${r.weeks})">${r.label}</button>`).join('')}
      </div>
    </div>

    ${trendChart(d,U)}

    <h2>Personal records</h2>
    <div class="card">${prHtml}</div>
  </div>`;
}
function setProgWeeks(w){ PROG_WEEKS=w; progressScreen(); }

// ---- Library (two views: muscle groups -> exercises) ----
const LIB_MUSCLES = ['chest','lats','traps','biceps','triceps','forearms','shoulders','abdominals','quads','hamstrings','glutes','calves','cardio'];
const LIB_CATS = [
  { name:'Upper Body', muscles:['chest','lats','traps','biceps','triceps','forearms','shoulders'] },
  { name:'Lower Body', muscles:['quads','hamstrings','glutes','calves'] },
  { name:'Other', muscles:['abdominals','cardio'] },
];
let LIB_STATE = { view:'groups', muscle:'', eq:'', q:'' };
// ---- Add-exercise mode: open the Library so the user picks from there ----
let LIB_ADDMODE = false;
// ---- Swap mode: open the Library so the user picks a real exercise as the swap-to target ----
let SWAP_MODE = false;
let SWAP_SESSION = null;
let SWAP_FROM = null;
function openAddExercises(){
  // stash details typed so far on the workout form
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  if($('wname')) DRAFT.name = $('wname').value;
  LIB_ADDMODE = true;
  SWAP_MODE = false; SWAP_SESSION = null; SWAP_FROM = null;   // never both at once
  showTab('lib', true);   // identical to tapping the bottom Workouts tab
}
function libDone(){ LIB_ADDMODE = false; TPL_MODE.active ? templateExercises() : createFlow(); }
async function library(){
  LIB_STATE = { view:'groups', muscle:'', eq:'', q:'' };
  const lib = await H.get('/api/exercises');
  window._LIB2 = lib;
  const head = LIB_ADDMODE
    ? `<div class="pick-head lib-head">
         <h1 style="flex:1">Workouts</h1>
         <button class="icon-btn" onclick="openCreateEx()" title="Create exercise">＋</button>
         <button class="blue sm" onclick="libDone()">Done (<span id="libDoneCount">${DRAFT.exercises.length}</span>)</button>
       </div>`
    : SWAP_MODE
    ? `<div class="pick-head lib-head">
         <button class="sec sm" onclick="swapCancel()">‹ Cancel</button>
         <h1 style="flex:1;font-size:18px">Pick replacement</h1>
       </div>`
    : `<div class="pick-head lib-head">
         <h1 style="flex:1">Workouts</h1>
         <button class="txt-btn" onclick="templatesPage()" title="Templates">Templates</button>
         <button class="icon-btn" onclick="openCreateEx()" title="Create exercise">＋</button>
       </div>`;
  $('app').innerHTML = `<div class="pick">${head}
    <div class="pick-search"><input id="ls" placeholder="Search exercises" oninput="libSearch(this.value)"></div>
    <div class="pick-list" id="lib2"></div>
  </div>`;
  renderLibGroups();
}
function renderLibGroups(){
  const lib = window._LIB2;
  const q = LIB_STATE.q;
  if(q){
    const matches = lib.filter(e =>
      exName(e).toLowerCase().includes(q) ||
      (e.muscle_groups||[]).join(' ').toLowerCase().includes(q) ||
      eqList(e).join(' ').toLowerCase().includes(q)
    ).sort((a,b)=>exName(a).localeCompare(exName(b)));
    $('lib2').innerHTML = matches.length ? `<div class="card">${matches.map(exRowHtml).join('')}</div>`
      : '<div class="muted" style="padding:20px;text-align:center">No exercises found.</div>';
    return;
  }
  const counts = {}; LIB_CATS.forEach(c=>c.muscles.forEach(m=>counts[m]=0));
  lib.forEach(e=>{ (e.muscle_groups||[]).forEach(m=>{ if(m in counts) counts[m]++; }); });
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
function libOpenMuscle(m){
  LIB_STATE.view='muscle'; LIB_STATE.muscle=m; LIB_STATE.eq=''; LIB_STATE.q='';
  const eqs = [...new Set(window._LIB2.filter(e=>(e.muscle_groups||[]).includes(m)).flatMap(eqFamilies))];
  const head = LIB_ADDMODE
    ? `<div class="pick-head lib-head">
         <button class="sec sm" onclick="library()">‹ All muscles</button>
         <h1 style="flex:1;font-size:18px;text-transform:capitalize">${esc(m)}</h1>
         <button class="icon-btn" onclick="openCreateEx('${m}')" title="Create exercise">＋</button>
         <button class="blue sm" onclick="libDone()">Done (<span id="libDoneCount">${DRAFT.exercises.length}</span>)</button>
       </div>`
    : `<div class="pick-head lib-head">
         <button class="sec sm" onclick="library()">‹ All muscles</button>
         <h1 style="flex:1;font-size:18px;text-transform:capitalize">${esc(m)}</h1>
         <button class="txt-btn" onclick="templatesPage()" title="Templates">Templates</button>
         <button class="icon-btn" onclick="openCreateEx('${m}')" title="Create exercise">＋</button>
       </div>`;
  $('app').innerHTML = `<div class="pick">${head}
    <div class="pick-search"><input id="ls" placeholder="Search ${esc(m)}" oninput="libSearch(this.value)"></div>
    <div class="cat-pills eq-pills" id="eqPills2">
      <span class="cat-pill on" data-eq="" onclick="pickEq2(this)">Any</span>
      ${eqs.map(k=>`<span class="cat-pill" data-eq="${k}" onclick="pickEq2(this)">${eqLabel(k)}</span>`).join('')}
    </div>
    <div class="pick-list" id="lib2"></div>
  </div>`;
  renderLibExercises();
}
function pickEq2(el){
  LIB_STATE.eq = el.dataset.eq;
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
  const added = DRAFT.exercises.find(x=>x.name===e.name);
  if(LIB_ADDMODE){
    return `<div class="ex-row ${added?'ex-on':''}" onclick="libToggle('${jsq(e.name)}', this)">
        <div class="ex-main">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-mg">${esc((e.muscle_groups||[]).slice(0,2).join(' · '))}${e.custom?' · your exercise':''}</div>
        </div>
        <div class="ex-badges">${exBadges(e)}</div>
        <div class="ex-add">${added?'✓':'+'}</div>
      </div>`;
  }
  return `<div class="ex-row" onclick="exDetail('${jsq(e.name)}')">
      <div class="ex-main">
        <div class="ex-name">${esc(e.name)}</div>
        <div class="ex-mg">${esc((e.muscle_groups||[]).slice(0,2).join(' · '))}${e.custom?' · your exercise':''}</div>
      </div>
      <div class="ex-badges">${exBadges(e)}</div>
      <div class="mg-chev">›</div>
    </div>`;
}
function libToggle(name, el){
  addEx(name, el);
  const n=$('libDoneCount'); if(n) n.textContent=DRAFT.exercises.length;
}
function renderLibExercises(){
  const {muscle,eq,q}=LIB_STATE;
  const list = window._LIB2.filter(e=>
    (e.muscle_groups||[]).includes(muscle) &&
    (!eq || eqFamilies(e).includes(eq)) &&
    (!q || exName(e).toLowerCase().includes(q) || (e.muscle_groups||[]).join(' ').includes(q))
  ).sort((a,b)=>exName(a).localeCompare(exName(b)));
  $('lib2').innerHTML = list.length ? `<div class="card">${list.map(exRowHtml).join('')}</div>`
    : '<div class="muted" style="padding:20px;text-align:center">No exercises here.</div>';
}
function openCreateEx(presetMuscle){
  const msel = LIB_MUSCLES.map(m=>`<option value="${m}" ${presetMuscle===m?'selected':''}>${m}</option>`).join('');
  const eqOpts = EQ_FAMILY.map(f=>`<option value="${f.key}">${f.label}</option>`).join('');
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
  if(r.error) alert(r.error); else { closeSheet(); if(LIB_STATE.view==='muscle') libOpenMuscle(LIB_STATE.muscle); else library(); }
}
function exDetail(name){
  const e = window._LIB2.find(x=>x.name===name); if(!e) return;
  const sets = e.defaultSets||3, reps=e.defaultReps||10;
  const eqs = eqList(e).map(x=>esc(x)).join(', ')||'—';
  const sheet = document.createElement('div'); sheet.className='sheet-back'; sheet.innerHTML=`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>${esc(e.name)}</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
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
function closeSheet(){ const s=document.querySelector('.sheet-back'); if(s){ s.classList.remove('show'); setTimeout(()=>s.remove(),200); } }
function openSheetHtml(inner){ const s=document.createElement('div'); s.className='sheet-back'; s.onclick=(e)=>{ if(e.target===s) closeSheet(); }; s.innerHTML=inner; document.body.appendChild(s); requestAnimationFrame(()=>s.classList.add('show')); }

// ---- Templates ----
async function templates(){
  const { mine, shared } = await H.get('/api/templates');
  let html = `<div class="wrap"><h1>Templates</h1><div class="muted">Saved routines — reuse on your next workout</div>`;
  if(mine.length){
    html += `<h2>Yours</h2>`;
    for(const t of mine) html += `<div class="lib-item"><div><b>${esc(t.name)}</b><div class="tag">${t.exercises.length} exercises</div></div><button class="sm" onclick="useTpl('${t.id}')">Use</button></div>`;
  }
  if(shared.length){
    html += `<h2>From friends</h2>`;
    for(const t of shared) html += `<div class="lib-item"><div><b>${esc(t.name)}</b><div class="tag">${t.exercises.length} ex</div></div><button class="sm" onclick="useTpl('${t.id}')">Use</button></div>`;
  }
  if(!mine.length && !shared.length) html += `<div class="card muted">No templates created. Create a workout and choose "Save as template".</div>`;
  html += `</div>`;
  $('app').innerHTML = html;
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
async function friends(){
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
    : '<div class="card muted" style="text-align:center">No friends yet.<br>Search above to find people to train with.</div>';
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
      <div class="add-row">
        <input id="fu" placeholder="Search people by name or @username" autocomplete="off" oninput="friendSearch()">
        <button class="add-btn" onclick="friendSearch()">Search</button>
      </div>
      <div id="fresults"></div>
    </div>
    ${freq.length?`<h2>Follow requests</h2><div class="card" style="padding:6px 12px">${followReqRows}</div>`:''}
    ${inc.length?`<h2>Friend requests</h2><div class="card" style="padding:6px 12px">${reqRows}</div>`:''}
    <h2>Friends</h2>
    <div class="card" style="padding:6px 12px">${friendRows}</div>
  </div>`;
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
      const btn = x.requestStatus==='friends' ? `<button class="sm" disabled style="background:#f0f1f3;border-color:transparent;color:var(--muted)">Friends</button>`
        : x.requestStatus==='sent' ? `<button class="sm" disabled style="background:#f0f1f3;border-color:transparent;color:var(--muted)">Requested</button>`
        : `<button class="sm sec" onclick="sendRequest('${jsq(x.username)}', this)">Add</button>`;
      return `<div class="user-row">${avatarHtml(x,'avatar')}<div class="meta"><div class="name">${esc(x.displayName||x.username)}</div><div class="handle">@${esc(x.username)}</div></div>${btn}</div>`;
    }).join('');
  } catch(e){ if(box) box.innerHTML=''; }
}
async function sendRequest(username, btn){
  const r = await H.post('/api/friends/request',{username});
  if(r.error){ alert(r.error); return; }
  if(btn){ btn.textContent='Requested'; btn.className='sm'; btn.disabled=true; btn.style.background='#f0f1f3'; btn.style.borderColor='transparent'; btn.style.color='var(--muted)'; }
}
async function acceptRequest(id){
  const r = await H.post('/api/friends/accept',{from:id});
  if(r.error) alert(r.error); else friends();
}
async function rejectRequest(id){
  const r = await H.post('/api/friends/reject',{from:id});
  if(r.error) alert(r.error); else friends();
}
async function acceptFollow(id){
  const r = await H.post('/api/follow-requests/'+id+'/accept',{});
  if(r && r.error) alert(r.error); else friends();
}
async function rejectFollow(id){
  const r = await H.post('/api/follow-requests/'+id+'/reject',{});
  if(r && r.error) alert(r.error); else friends();
}
function avatarColor(seed){
  const colors=['#16a34a','#2563eb','#dc2626','#9333ea','#ea580c','#0891b2','#db2777','#65a30d'];
  let h=0; for(const c of seed) h=(h*31+c.charCodeAt(0))>>>0; return colors[h%colors.length];
}

// ---- Profile (me + any friend) ----
function flameSvg(){ return '<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;vertical-align:-1px"><path d="M12 2c1 3-1 4-2 6-1 2 0 4 2 4 1.5 0 2-1 2-2 2 1 3 3 3 5 0 3-3 5-6 5-4 0-7-3-7-7 0-4 4-8 8-11z"/></svg>'; }
function gearSvg(){ return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; }
function openSettings(){
  const inner = `<div class="sheet"><div class="sheet-head"><h2>Settings</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
    <div class="sheet-list">
      <button class="sheet-row" onclick="closeSheet(); document.getElementById('av').click()">Edit photo</button>
      <button class="sheet-row" onclick="closeSheet(); editBio()">Edit bio</button>
      <button class="sheet-row" onclick="closeSheet(); pickUnits()">Weight units <span class="row-val">${esc(myUnit())}</span></button>
      <button class="sheet-row red" onclick="closeSheet(); logout()">Log out</button>
    </div>
  </div>`;
  openSheetHtml(inner);
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
async function profileView(id){
  const p = await H.get('/api/profile/'+id);
  const isMe = id===ME.id;
  const avatar = p.avatar
    ? `<img class="pavatar" src="${esc(p.avatar)}" alt="">`
    : `<div class="pavatar" style="background:${avatarColor(p.username)};color:#fff">${esc((p.displayName||p.username||'?')[0]||'?')}</div>`;
  const stats = `
    <div class="pstats">
      <div class="pstat"><b>${p.workoutsCompleted}</b><span>Workouts</span></div>
      <div class="pstat"><b>${p.following}</b><span>Following</span></div>
      <div class="pstat"><b>${p.followers}</b><span>Followers</span></div>
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
  // this (buildActivityFor in server.js) but the profile page never rendered it. Reuses the same
  // .card.feed-strip / .feed-item / .act-chip styling as Home's "Friend's Activity" for consistency.
  const activity = p.recentActivity||[];
  const activityRows = activity.length
    ? activity.map(a=>{
        const chip = a.type==='pr' ? `<span class="act-chip pr">PR</span>` : `<span class="act-chip done">✓</span>`;
        return `<div class="feed-item">${chip} ${esc(a.text)}</div>`;
      }).join('')
    : (isMe ? `<div class="muted">No activity yet — log a workout to see it here.</div>` : '');
  const activityBlock = (activity.length || isMe)
    ? `<h2 class="light">Recent Activity</h2><div class="card feed-strip">${activityRows}</div>`
    : '';
  const workouts = p.myWorkouts||[];
  function woCard(w){
    const img = (w.post&&w.post.media&&w.post.media[0]) ? `<img class="wthumb" src="${esc(w.post.media[0].src)}" alt="">` : `<div class="wthumb wthumb-empty"></div>`;
    const title = (w.name && w.name!=='Workout') ? w.name : ((w.firstExercises&&w.firstExercises[0])||'Workout');
    const exs = (w.firstExercises||[]).slice(0,3);
    const more = (w.exerciseCount||0) - exs.length;
    const exList = exs.length ? `<div class="wex-h">Exercises</div><ol class="wexb">${exs.map(e=>`<li>${esc(e)}</li>`).join('')}</ol>${more>0?`<div class="wexb-more">+${more} more</div>`:''}` : '<div class="wexnone">No exercises</div>';
    const collab = (w.collaborators&&w.collaborators.length) ? `with @${esc(w.collaborators[0].username)}${w.collaborators.length>1?` +${w.collaborators.length-1}`:''}` : '';
    const when = w.at ? fmtDate(w.at) : (w.date||'');
    return `<div class="wtile" onclick="viewPost('${w.id}')">
      <div class="wdate">${esc(when)}</div>
      <div class="wtitle">${esc(title)}</div>
      ${img}
      <div class="wex">${exList}</div>
      ${collab?`<div class="wcollab">${collab}</div>`:''}
    </div>`;
  }
  const gridHtml = workouts.length
    ? `<div class="wgrid">` + workouts.map(w=>woCard(w)).join('') + `</div>`
    : '<div class="muted" style="padding:14px 0;text-align:center">No workouts logged yet.</div>';
  const listHtml = workouts.length
    ? `<div class="wgrid wlist">` + workouts.map(w=>woCard(w)).join('') + `</div>`
    : '<div class="muted" style="padding:14px 0;text-align:center">No workouts logged yet.</div>';
  const isPrivate = p.limited && !isMe;
  const privateBlock = `<div class="card" style="text-align:center;padding:26px 16px;margin-top:10px">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" style="color:var(--muted)"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      <div style="font-weight:700;margin-top:8px">This profile is private</div>
      <div class="muted" style="margin-top:4px;font-size:13px">Follow ${esc(p.displayName||p.username)} to see ${workouts.length?'the rest of their':'their'} workouts, PRs and activity.</div>
    </div>`;
  const wview = (window.__wview||'grid');
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
    <div class="sec-head"><h2>My Workouts</h2><div class="view-toggle"><button class="${wview==='grid'?'on':''}" id="vtGrid" onclick="setWorkoutView('grid')">▦ Grid</button><button class="${wview==='list'?'on':''}" id="vtList" onclick="setWorkoutView('list')">☰ List</button></div></div>
    <div style="margin:8px 0 14px" id="workoutView">${wview==='grid'?gridHtml:listHtml}</div>
    ${isPrivate ? privateBlock : ''}
    ${isMe?`<button class="sec" style="margin-top:18px" onclick="logout()">Log out</button>`:''}
  </div>`;
}
function setWorkoutView(v){
  window.__wview = v;
  const g=document.getElementById('vtGrid'), l=document.getElementById('vtList');
  if(g){ g.className = v==='grid'?'on':''; l.className = v==='list'?'on':''; }
  if(ME&&ME.id) profileView(ME.id);
}
async function toggleFollow(id, state){
  // none -> request to follow; requested -> cancel the request; following -> unfollow
  const r = (state === 'none' || !state)
    ? await H.post('/api/follow/'+id,{})
    : await H.post('/api/unfollow/'+id,{});
  if(r && r.error){ alert(r.error); return; }
  profileView(id);   // re-render from the server's fresh youFollow so the button is always right
}
function editBio(){
  const cur = (ME.bio)||'';
  const v = prompt('Your bio:', cur);
  if(v===null) return;
  H.post('/api/me/bio',{bio:v}).then(r=>{ if(r.bio!==undefined){ ME.bio=r.bio; profileView(ME.id); } });
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
  const fit = ()=>{
    const s = Math.min(stage.clientWidth/img.naturalWidth, stage.clientHeight/img.naturalHeight);
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
  const r = await H.post('/api/me/avatar',{ data: out, type: type||'image/jpeg' });
  if(r.avatar){ ME.avatar = r.avatar; profileView(ME.id); }
  else alert(r.error||'upload failed');
}
function meScreen(){ profileView(ME.id); }
function logout(){ localStorage.removeItem('crewfit_token'); TOKEN=''; ME=null; $('nav').classList.add('hidden'); authScreen(); }

// ---- Push ----
async function setupPush(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if(!('Notification' in window)) return;
  try{
    if(Notification.permission === 'default'){ try{ await Notification.requestPermission(); }catch(e){} }
    if(Notification.permission !== 'granted') return; // user declined; push stays optional
    const reg = await navigator.serviceWorker.register('/sw.js');
    const sub = await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey: await vapidKey()});
    await H.post('/api/push/subscribe',{subscription:sub});
  }catch(e){ /* push optional for demo */ }
}
async function vapidKey(){ const r=await (await fetch('/api/vapid')).json(); return r.publicKey; }

// ---- Boot ----
(async ()=>{
  if(TOKEN){
    try{ ME = await H.get('/api/profile/me'); }catch(e){ ME=null; }
  }
  if(TOKEN && ME && ME.id){ $('nav').classList.remove('hidden'); home(); }
  else { TOKEN=''; localStorage.removeItem('crewfit_token'); authScreen(); }
  if('serviceWorker' in navigator) setupPush();
  document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
})();
