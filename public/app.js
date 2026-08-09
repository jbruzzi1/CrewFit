const API = '';
let TOKEN = localStorage.getItem('crewfit_token') || '';
let ME = null;
const H = {
  get:p=>(fetch(API+p,{headers:{Authorization:'Bearer '+TOKEN}}).then(r=>r.json())),
  post:(p,b)=>(fetch(API+p,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},body:JSON.stringify(b||{})}).then(r=>r.json())),
  put:(p,b)=>(fetch(API+p,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},body:JSON.stringify(b||{})}).then(r=>r.json())),
  delete:p=>(fetch(API+p,{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN}}).then(r=>r.json())),
};
const $ = id => document.getElementById(id);
function setToken(t,u){ TOKEN=t; localStorage.setItem('crewfit_token',t); ME=u; $('nav').classList.toggle('hidden', !t); }
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function fmtDate(s){ const d=new Date(s); return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }

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
      <div style="text-align:center;margin-top:4px"><button class="linkbtn" onclick="forgotFlow()">Forgot username or password?</button></div>
      <div id="regbox" style="display:none;margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
        <h2>New account</h2>
        <input id="rx" placeholder="username">
        <input id="rp" placeholder="password" type="password">
        <input id="rn" placeholder="display name (optional)">
        <button onclick="doReg()">Create account</button>
      </div>
    </div></div>`;
}
function showReg(){ const b=document.getElementById('regbox'); if(b) b.style.display = b.style.display==='none'?'block':'none'; }
async function forgotFlow(){
  const uname = prompt('Enter your username to reset your password:');
  if(!uname) return;
  const r = await H.post('/api/forgot',{username:uname});
  if(r.error){ alert(r.error); return; }
  const np = prompt('Reset password for '+r.displayName+'. Enter a new password:');
  if(!np) return;
  const res = await H.post('/api/reset',{username:uname,newPin:np});
  if(res.ok){ alert('Password reset. You can now log in with your new password.'); }
  else alert(res.error||'reset failed');
}
async function doLogin(){ try { const r=await H.post('/api/login',{username:$('lx').value,pin:$('lp').value}); if(r.token){ setToken(r.token,r.user); home(); } else alert(r.error||'login failed'); } catch(e){ alert('Network error — is CrewFit reachable? Try reopening the app.'); } }
async function doReg(){ try { const r=await H.post('/api/register',{username:$('rx').value,pin:$('rp').value,displayName:$('rn').value}); if(r.token){ setToken(r.token,r.user); home(); } else alert(r.error||'register failed'); } catch(e){ alert('Network error — is CrewFit reachable? Try reopening the app.'); } }

// ---- Nav ----
function showTab(tab){
  document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  if(tab==='home') home(); else if(tab==='lib') library(); else if(tab==='templates') templates(); else if(tab==='friends') friends(); else if(tab==='me') meScreen();
}

// ---- Home / sessions (Option B: split sections) ----
async function home(){
  const sessions = await H.get('/api/sessions');
  const feed = await H.get('/api/feed');
  const friendName = async (id)=> (await H.get('/api/friends')).find(f=>f.id===id)?.displayName || 'friend';
  const initial = ((ME&&(ME.displayName||ME.username))||'?')[0]||'?';
  const first = ((ME.displayName||ME.username||'there').split(' ')[0]);
  const HYPE = ['Time to crush it','Let\'s get after it','Show up. Lift heavy'];
  const hypeLine = HYPE[Math.floor(Math.random()*HYPE.length)];
  const homeAvatarHtml = ME && ME.avatar
    ? `<img class="home-avatar" src="${esc(ME.avatar)}" alt="" onclick="showTab('me')">`
    : `<div class="home-avatar" onclick="showTab('me')">${esc(initial.toUpperCase())}</div>`;
  let html = `<div class="wrap home-head">
    <div class="home-top">
      <div><div class="home-brand">CrewFit</div><div class="home-greet">${esc(hypeLine)}, ${esc(first)}</div></div>
      ${homeAvatarHtml}
    </div>
    <button class="blue btn-hero" onclick="createFlow()">+ New workout</button>`;

  // Section 1: Friend's Activity (completed activity, not invites)
  html += `<h2>Friend's Activity</h2><div class="card">`;
  if(feed.length){
    for(const f of feed){
      const who = await friendName(f.by);
      const ic = f.type==='pr' ? `<span class="act-chip pr">PR</span>` : `<span class="act-chip done">✓</span>`;
      html += `<div class="lib-item"><div>${ic} <b>${esc(who)}</b> ${esc(f.text)}</div></div>`;
    }
  } else html += `<div class="muted">No recent activity from friends.</div>`;
  html += `</div>`;

  // Section 2: Your Sessions (only labeled routines)
  const yours = sessions.filter(s=>s.participants.includes(ME.id) && s.name);
  html += `<h2>Your Sessions</h2><div class="card">`;
  if(yours.length){
    for(const s of yours){
      const label = s.name;
      html += `<div class="lib-item" onclick="openSession('${s.id}')">
        <div><b>${esc(label)} - ${s.exercises.length} exercises</b><div class="tag">${fmtDate(s.scheduledAt)}</div></div></div>`;
    }
  } else html += `<div class="muted">No sessions yet.</div>`;
  html += `</div>`;

  // Section 3: Invites Awaiting (pending invites, with who invited you)
  const pending = sessions.filter(s=>Array.isArray(s.invited)&&s.invited.includes(ME.id));
  html += `<h2>Invites Awaiting</h2><div class="card">`;
  if(pending.length){
    for(const s of pending){
      const creatorName = await friendName(s.creatorId);
      html += `<div class="lib-item" onclick="openSession('${s.id}')">
        <div><b>${esc(creatorName)}</b> invited you<div class="tag">${esc(s.name||'Workout')} - ${s.exercises.length} exercises</div><div class="tag">${fmtDate(s.scheduledAt)}${s.location?` · ${esc(s.location)}`:''}</div></div>
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:6px;">
          <button class="sm blue" onclick="event.stopPropagation();acceptInvite('${s.id}')">Accept</button>
          <button class="sm gray" onclick="event.stopPropagation();declineInvite('${s.id}')">Decline</button>
        </div></div>`;
    }
  } else html += `<div class="muted">No invites right now.</div>`;
  html += `</div></div>`;
  $('app').innerHTML = html;
}

async function openSession(id){
  const s = await H.get('/api/sessions/'+id);
  if(!s || s.error){ alert(s && s.error ? s.error : 'Session not found'); return; }
  const isCreator = s.creatorId===ME.id;
  const isParticipant = s.participants.includes(ME.id);
  const approvedJoin = s.joinRequests.find(j=>j.userId===ME.id&&j.status==='approved');
  const canEdit = isParticipant || approvedJoin;
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
    const tap = canEdit ? ` onclick="openLogSheet('${s.id}','${e.id}')"` : '';
    const cls = canEdit ? 'ex-card log-row' : 'ex-card';
    const cnt = (s.logs && s.logs[ME.id]) ? s.logs[ME.id].filter(l=>l.exerciseId===e.id).length : 0;
    const statusTag = canEdit ? (cnt ? `<span class="logged">✓ ${cnt} set${cnt>1?'s':''} logged</span>` : `<span class="log-hint">Tap to log sets →</span>`) : '';
    let head = `<div class="ex-head"${tap}><div class="ex-main"><div class="ex-name">${name}</div>${statusTag}</div><div class="ex-meta"><span class="tag">${e.defaultSets} × ${e.defaultReps}</span></div></div>`;
    let sub = '';
    for(const ed of (editByEx[e.id]||[])){
      const byName = nameCache[ed.proposedBy] || ed.proposedBy;
      if(ed.status==='pending'){
        sub += `<div class="req"><div class="rc">${esc(byName)} suggests ${esc(e.name)} → ${esc(ed.swapTo)}</div>`;
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
      edits += `<div class="card"><div class="req"><div class="rc">${esc(byName)} suggests → ${esc(ed.swapTo)}</div>`;
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
  let html = `<div class="wrap"><button class="sec sm" onclick="showTab('home')">← Back</button>
    <h1 class="sess-date">${fmtDate(s.scheduledAt)}</h1>
    <div class="muted sess-meta">${s.visibility==='friends'?'Friends-only · joinable':'Private'} · ${s.participants.length} people</div>
    ${s.location?`<div class="tag">📍 ${esc(s.location)}</div>`:''}
    ${s.lengthMin?`<div class="tag">⏱ ${esc(s.lengthMin)} min</div>`:''}
    ${s.creatorNote?`<div class="card muted">"${esc(s.creatorNote)}" — ${isCreator?'you':esc(s.creatorId)}</div>`:''}`;
  if(isCreator){
    html += `<div class="sess-actions">`;
    if(s.status!=='locked') html += `<button class="blue sm" onclick="lock('${s.id}')">Lock & finish</button>`;
    html += `<button class="sec sm" onclick="editSession('${s.id}')">Edit</button>`;
    html += `<button class="red sm" onclick="deleteSession('${s.id}')">Delete session</button></div>`;
  }
  html += `<h2>Workout (your view)</h2>${myEx}`;
  if(canEdit) html += `<div class="muted" style="font-size:12px;margin:-4px 2px 10px">Tap an exercise to log your sets.</div>`;
  if(edits) html += `<h2>Suggested swaps</h2>${edits}`;
  if(jr) html += `<h2>Join requests</h2>${jr}`;
  if(canEdit){
    html += `<h2 class="sep">Suggest a swap</h2><div class="card">
      <select id="swEx">${s.exercises.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      <input id="swTo" placeholder="swap to (exercise name)">
      <button onclick="suggest('${s.id}')">Suggest swap</button></div>`;
  }
  // Invitee action menu (non-creator view)
  if(!isCreator){
    html += `<h2>Respond</h2><div class="card">
      <button class="blue" onclick="acceptInvite('${s.id}')">Accept</button>
      <button class="sec" onclick="requestChanges('${s.id}')">Request Changes</button>
      <button class="sec" onclick="saveRoutine('${s.id}')">Save This Routine</button>
      <button class="sec" onclick="openChat('${s.id}')">💬 Message Host</button>
      <button class="sec red" onclick="declineInvite('${s.id}')">Decline</button>
    </div>`;
  }
  // Chat panel
  html += `<h2>💬 Chat</h2><div class="card"><div id="chatbox" class="scrolllist"></div>
    <div class="row"><input id="chatInput" placeholder="message host + crew"><button class="sm" onclick="sendChat('${s.id}')">Send</button></div></div>`;
  html += `</div>`;
  $('app').innerHTML = html;
  loadChat(s);
}
async function acceptInvite(id){ await H.post(`/api/sessions/${id}/accept`,{}); openSession(id); }
async function declineInvite(id){ if(!confirm('Decline this invite?')) return; await H.post(`/api/sessions/${id}/decline`,{}); home(); }
async function requestChanges(id){ const t=prompt('What changes do you want?'); if(t) { await H.post(`/api/sessions/${id}/comments`,{text:'Request changes: '+t}); openSession(id); } }
async function saveRoutine(id){ const s=await H.get('/api/sessions/'+id); const r=await H.post('/api/templates',{name:prompt('Template name:','Saved routine')||'Saved routine',exercises:s.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps}))}); alert('Saved as template: '+r.name); }
async function openChat(id){ document.getElementById('chatInput').focus(); }
async function sendChat(id){ const t=$('chatInput').value; if(!t.trim()) return; await H.post(`/api/sessions/${id}/comments`,{text:t}); $('chatInput').value=''; openSession(id); }
async function loadChat(s){ const box=$('chatbox'); if(!box) return; const cs=await H.get(`/api/sessions/${s.id}/comments`); box.innerHTML = cs.length? cs.map(c=>`<div class="lib-item"><div><b>${esc(c.userId===ME.id?'You':(s.participants.includes(c.userId)?'':'?'))}</b> ${esc(c.text)}</div><div class="tag">${new Date(c.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></div>`).join('') : '<div class="muted">No messages yet.</div>'; }
async function nameOf(id){ if(id===ME.id) return 'You'; const f = (await H.get('/api/friends')).find(x=>x.id===id); return f?f.displayName:'friend'; }
async function approve(id,eid){ const s=await H.post(`/api/sessions/${id}/suggest/${eid}/approve`); openSession(id); }
async function reject(id,eid){ await H.post(`/api/sessions/${id}/suggest/${eid}/reject`); openSession(id); }
async function approveJoin(id,jid){ await H.post(`/api/sessions/${id}/join/${jid}/approve`); openSession(id); }
async function rejectJoin(id,jid){ await H.post(`/api/sessions/${id}/join/${jid}/reject`); openSession(id); }
async function suggest(id){ const r=await H.post(`/api/sessions/${id}/suggest`,{exerciseId:$('swEx').value,swapTo:$('swTo').value}); if(r.error)alert(r.error); else openSession(id); }
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

async function openLogSheet(sid, exId){
  const s = await H.get('/api/sessions/'+sid);
  if(!s || s.error){ alert(s && s.error ? s.error : 'Session not found'); return; }
  const e = s.exercises.find(x=>x.id===exId); if(!e) return;
  LOGVIEW = { sid, exId };
  const mine = (s.logs && s.logs[ME.id]) || [];
  const exLogs = mine.filter(l=>l.exerciseId===exId);
  const bestLog = exLogs.slice().sort((a,b)=>((Number(b.weight)||0)*(Number(b.reps)||0))-((Number(a.weight)||0)*(Number(a.reps)||0)))[0];
  const last = bestLog ? `${bestLog.weight} × ${bestLog.reps}` : '—';
  const sheet = document.createElement('div'); sheet.className='sheet-back';
  sheet.innerHTML = `
    <div class="sheet log-sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>Log · ${esc(e.name)}</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="ex-sub">Last time: <b>${esc(last)}</b></div>
      <div id="logSetList"></div>
      <div class="seg" id="logTypeSeg">
        ${SET_TYPES.map((t,i)=>`<div class="chip${i===0?' on':''}" data-t="${t.key}" onclick="logSetType('${t.key}')">${t.label}</div>`).join('')}
      </div>
      <div class="add-row">
        <input id="logW" placeholder="lbs" type="number" inputmode="tel" pattern="[0-9]*">
        <input id="logR" placeholder="reps" type="number" inputmode="tel" pattern="[0-9]*">
        <button class="add-btn" onclick="addLogSet()">+ Add</button>
      </div>
      <div id="logRest"></div>
      <div class="note">Tap a set to edit or delete it. Set # auto-fills.</div>
    </div>`;
  sheet.onclick=(ev)=>{ if(ev.target===sheet) closeSheet(); };
  document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
  renderLogSets(s);
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
  list.innerHTML = exLogs.map(l=>`<div class="set-row" onclick="editLogSet('${l.id}')">
      <div class="set-n">${l.set||'·'}</div>
      <div class="set-vals"><b>${Number(l.weight)||0} lbs</b> · <span class="sub">${Number(l.reps)||0} reps</span></div>
      <span class="type-tag ${TYPE_CLASS[l.setType]||'t-normal'}">${TYPE_LABEL[l.setType]||'Normal'}</span>
      ${l.isPr?'<span class="type-tag pr">PR</span>':''}
    </div>`).join('');
}
async function addLogSet(){
  const w=document.getElementById('logW').value, r=document.getElementById('logR').value;
  if(w==='' && r===''){ alert('Enter weight and/or reps'); return; }
  const seg=document.getElementById('logTypeSeg');
  const type=(seg&&seg.querySelector('.chip.on'))?seg.querySelector('.chip.on').getAttribute('data-t'):'normal';
  const s=await H.post(`/api/sessions/${LOGVIEW.sid}/log`,{exerciseId:LOGVIEW.exId,weight:w,reps:r,setType:type});
  if(s.error){ alert(s.error); return; }
  LOGVIEW.sid && renderLogSets(s);
  document.getElementById('logW').value=''; document.getElementById('logR').value='';
  startRest();
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
      <label class="muted" style="font-size:12px">Weight (lbs)</label>
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
  closeSheet(); openLogSheet(LOGVIEW.sid, LOGVIEW.exId);
}
async function delLogSet(logId){
  if(!confirm('Delete this set?')) return;
  const s=await H.delete(`/api/sessions/${LOGVIEW.sid}/log/${logId}`);
  if(s.error){ alert(s.error); return; }
  closeSheet(); openLogSheet(LOGVIEW.sid, LOGVIEW.exId);
}
let REST_TIMER=null;
function startRest(){
  const box=document.getElementById('logRest'); if(!box) return;
  let sec=60; box.innerHTML=`<div class="rest"><span>Rest</span><b id="restN">1:00</b><span>· tap to dismiss</span></div>`;
  box.querySelector('.rest').onclick=()=>{ clearInterval(REST_TIMER); box.innerHTML=''; };
  clearInterval(REST_TIMER);
  REST_TIMER=setInterval(()=>{ sec--; const el=document.getElementById('restN'); if(el) el.textContent=`${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; if(sec<=0){ clearInterval(REST_TIMER); box.innerHTML=''; } },1000);
}
async function lock(id){ await H.post(`/api/sessions/${id}/lock`); openSession(id); }
async function deleteSession(id){
  if(!confirm('Delete this session? This removes it for everyone.')) return;
  const r = await H.delete(`/api/sessions/${id}`);
  if(r && r.error){ alert(r.error); return; }
  home();
}

// ---- Create flow ----
let DRAFT = { exercises:[], inviteUsernames:[] };
let EDITING_TPL = null;
async function createFlow(){
  DRAFT = DRAFT || { exercises:[], inviteUsernames:[] };
  if(!DRAFT.exercises) DRAFT.exercises=[];
  if(!DRAFT.inviteUsernames) DRAFT.inviteUsernames=[];
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  const friends = await H.get('/api/friends');
  const invRows = friends.length ? friends.map(f=>{
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
    <select id="vis"><option value="private">Private (invite only)</option><option value="friends">Friends-only (joinable)</option></select>
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
async function submitSession(){
  const dt=$('dt').value; const vis=$('vis').value;
  const location=$('loc').value; const lengthMin=$('len').value; const creatorNote=$('note').value; const name=$('wname').value;
  if(!DRAFT.exercises.length) return alert('Add at least one exercise');
  const scheduledAt = dt? new Date(dt).toISOString() : new Date().toISOString();
  const payload={scheduledAt,visibility:vis,name,exercises:DRAFT.exercises,inviteUsernames:DRAFT.inviteUsernames,location,lengthMin:lengthMin?Number(lengthMin):null,creatorNote};
  const r = EDITING_SESSION
    ? await H.put('/api/sessions/'+EDITING_SESSION, payload)
    : await H.post('/api/sessions', payload);
  if(r.error) alert(r.error); else home();
}
let EDITING_SESSION = null;
function cancelCreate(){ EDITING_SESSION=null; EDITING_TPL=null; home(); }
async function editSession(id){
  const s = await H.get('/api/sessions/'+id);
  if(!s || s.error){ alert(s && s.error ? s.error : 'Session not found'); return; }
  if(s.creatorId!==ME.id){ alert('Only the creator can edit.'); return; }
  const friends = await H.get('/api/friends');
  const invitedUsernames = (s.invited||[]).map(fid=>{ const f=friends.find(x=>x.id===fid); return f?f.username:''; }).filter(Boolean);
  DRAFT = { exercises: s.exercises.map(e=>({ id:e.id, name:e.name, defaultSets:e.defaultSets, defaultReps:e.defaultReps })),
            inviteUsernames: invitedUsernames,
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
  DRAFT={ exercises:t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps})) };
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
  DRAFT.exercises = t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps}));
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
function renderDraft(){ $('draftList').innerHTML = DRAFT.exercises.length? DRAFT.exercises.map((e,i)=>`<div class="lib-item draft-ex" data-idx="${i}"><div class="drag-handle" title="Drag to reorder"></div><div class="draft-main" onclick="editDraftEx(${i})"><span class="draft-name">${esc(e.name)}</span><span class="draft-chip">${e.defaultSets} x ${e.defaultReps}</span></div><button class="draft-rm" onclick="rmEx(${i})">Remove</button></div>`).join('') : '<div class="muted">None added.</div>';  const list=$('draftList'); if(list) dragReorder(list, DRAFT.exercises, ()=>renderDraft()); }
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
      <div class="sheet-row"><span>Reps</span><div class="stepper">
        <button class="stp" onclick="stepDraft(${i},'reps',-1)">−</button>
        <b id="dReps">${e.defaultReps}</b>
        <button class="stp" onclick="stepDraft(${i},'reps',1)">+</button>
      </div></div>
      <button class="red" style="margin-top:14px;width:100%" onclick="rmEx(${i}); closeSheet();">Remove exercise</button>
    </div>`;
  sheet.onclick=(e)=>{ if(e.target===sheet) closeSheet(); }; document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
}
function stepDraft(i, field, delta){
  const e = DRAFT.exercises[i]; if(!e) return;
  const key = field==='sets' ? 'defaultSets' : 'defaultReps';
  let v = (e[key]||0) + delta; if(v<1) v=1; if(v>99) v=99;
  e[key] = v;
  const lbl = field==='sets' ? 'dSets' : 'dReps';
  const el = document.getElementById(lbl); if(el) el.textContent = v;
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
function eqFamilies(e){
  const eq=(e.equipment||[]).map(x=>x.toLowerCase());
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
  chest:'chest', lats:'lats', traps:'traps', biceps:'biceps', triceps:'triceps',
  core:'core', quads:'quads', hamstrings:'hamstrings', calves:'calves',
  shoulders:'shoulders', forearms:'forearms', glutes:'glutes', cardio:'cardio',
  abdominals:'core'
};
function mgIcon(mg){
  const key = MG_IMG[mg] || mg;
  return `<img class="mg-img" src="muscle-icons/${key}.png" alt="${esc(mg)}" loading="lazy">`;
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
  else DRAFT.exercises.push({name,defaultSets:3,defaultReps:10});
  if(el){ const on=DRAFT.exercises.find(e=>e.name===name); el.classList.toggle('ex-on', !!on); el.querySelector('.ex-add').textContent = on?'✓':'+'; }
}
function closePick(){ createFlow(); }
async function submitSession(){
  const dt=$('dt').value; const vis=$('vis').value;
  const location=$('loc').value; const lengthMin=$('len').value; const creatorNote=$('note').value; const name=$('wname').value;
  if(!DRAFT.exercises.length) return alert('Add at least one exercise');
  const scheduledAt = dt? new Date(dt).toISOString() : new Date().toISOString();
  const r = await H.post('/api/sessions',{scheduledAt,visibility:vis,name,exercises:DRAFT.exercises,inviteUsernames:DRAFT.inviteUsernames,location,lengthMin:lengthMin?Number(lengthMin):null,creatorNote});
  if(r.error) alert(r.error); else {
    if(confirm('Save this as a template for next time?')){
      await H.post('/api/templates',{name:prompt('Template name:',name||'My workout')||'My workout',exercises:DRAFT.exercises});
    }
    home();
  }
}

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
function openAddExercises(){
  // stash details typed so far on the workout form
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  if($('wname')) DRAFT.name = $('wname').value;
  LIB_ADDMODE = true;
  showTab('lib');   // identical to tapping the bottom Workouts tab
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
      e.name.toLowerCase().includes(q) ||
      (e.muscle_groups||[]).join(' ').toLowerCase().includes(q) ||
      (e.equipment||[]).join(' ').toLowerCase().includes(q)
    ).sort((a,b)=>a.name.localeCompare(b.name));
    $('lib2').innerHTML = matches.length ? matches.map(exRowHtml).join('')
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
    return `<div class="lib-cat">${esc(cat.name)}</div>${rows}`;
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
  const added = DRAFT.exercises.find(x=>x.name===e.name);
  if(LIB_ADDMODE){
    return `<div class="ex-row ${added?'ex-on':''}" onclick="libToggle('${esc(e.name)}', this)">
        <div class="ex-main">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-mg">${(e.muscle_groups||[]).slice(0,2).join(' · ')}${e.custom?' · your exercise':''}</div>
        </div>
        <div class="ex-badges">${exBadges(e)}</div>
        <div class="ex-add">${added?'✓':'+'}</div>
      </div>`;
  }
  return `<div class="ex-row" onclick="exDetail('${esc(e.name)}')">
      <div class="ex-main">
        <div class="ex-name">${esc(e.name)}</div>
        <div class="ex-mg">${(e.muscle_groups||[]).slice(0,2).join(' · ')}${e.custom?' · your exercise':''}</div>
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
    (!q || e.name.toLowerCase().includes(q) || (e.muscle_groups||[]).join(' ').includes(q))
  ).sort((a,b)=>a.name.localeCompare(b.name));
  $('lib2').innerHTML = list.length ? list.map(exRowHtml).join('')
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
  const eqs = (e.equipment||[]).map(x=>esc(x)).join(', ')||'—';
  const sheet = document.createElement('div'); sheet.className='sheet-back'; sheet.innerHTML=`
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="sheet-head"><h2>${esc(e.name)}</h2><button class="sec sm" onclick="closeSheet()">✕</button></div>
      <div class="sheet-thumb">${exThumb(e)}<span class="sheet-thumb-cap">${(e.muscle_groups||[])[0]||'abdominals'}</span></div>
      <div class="sheet-mg">${(e.muscle_groups||[]).join(' · ')}</div>
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
  DRAFT.exercises = t.exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps}));
  createFlow();
}

async function friends(){
  const f = await H.get('/api/friends');
  const flame = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 3-1 4-2 6-1 2 0 4 2 4 1.5 0 2-1 2-2 2 1 3 3 3 5 0 3-3 5-6 5-4 0-7-3-7-7 0-4 4-8 8-11z"/></svg>';
  const rows = f.length ? f.map(x=>`
    <div class="friend-row" onclick="profileView('${x.id}')" style="cursor:pointer">
      <div class="avatar" style="background:${avatarColor(x.username)};color:#fff">${esc((x.displayName||x.username||'?')[0]||'?')}</div>
      <div class="meta">
        <div class="name">${esc(x.displayName||x.username)}</div>
        <div class="handle">@${esc(x.username)}</div>
        ${x.streak>1?`<div class="streak-pill">${flame}${x.streak} day streak</div>`:''}
      </div>
    </div>`).join('')
    : '<div class="card muted" style="text-align:center">No friends yet.<br>Add a friend below to start training together.</div>';
  $('app').innerHTML = `<div class="wrap">
    <h1>Friends</h1>
    ${f.length?`<div class="muted" style="margin:-2px 0 8px">${f.length} ${f.length===1?'friend':'friends'}</div>`:''}
    <div class="card">
      <div class="add-row">
        <input id="fu" placeholder="friend username">
        <button class="sm" onclick="addFriend()">Add</button>
      </div>
    </div>
    <div class="card" style="padding:6px 12px">${rows}</div>
  </div>`;
}
function avatarColor(seed){
  const colors=['#16a34a','#2563eb','#dc2626','#9333ea','#ea580c','#0891b2','#db2777','#65a30d'];
  let h=0; for(const c of seed) h=(h*31+c.charCodeAt(0))>>>0; return colors[h%colors.length];
}
async function addFriend(){ const v=$('fu').value.trim(); if(!v)return; const r=await H.post('/api/friends/add',{username:v}); if(r.error)alert(r.error); else friends(); }

// ---- Profile (me + any friend) ----
function flameSvg(){ return '<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;vertical-align:-1px"><path d="M12 2c1 3-1 4-2 6-1 2 0 4 2 4 1.5 0 2-1 2-2 2 1 3 3 3 5 0 3-3 5-6 5-4 0-7-3-7-7 0-4 4-8 8-11z"/></svg>'; }
async function profileView(id){
  const p = await H.get('/api/profile/'+id);
  const isMe = id===ME.id;
  const avatar = p.avatar
    ? `<img class="pavatar" src="${esc(p.avatar)}" alt="">`
    : `<div class="pavatar" style="background:${avatarColor(p.username)};color:#fff">${esc((p.displayName||p.username||'?')[0]||'?')}</div>`;
  const stats = `
    <div class="pstats">
      <div class="pstat"><b>${p.workoutsCompleted}</b><span>Workouts</span></div>
      <div class="pstat"><b>${p.following}</b><span>Friends</span></div>
      <div class="pstat"><b>${p.followers}</b><span>Followers</span></div>
    </div>`;
  const bioBlock = isMe
    ? `<div class="pbio" onclick="editBio()">${p.bio?esc(p.bio):'<span class="muted">Tap to add a bio</span>'}</div>`
    : (p.bio?`<div class="pbio">${esc(p.bio)}</div>`:'');
  const avatarBlock = isMe
    ? `<label class="pavatar-wrap" title="Change photo">
         ${avatar}
         <span class="pcam">📷</span>
         <input id="av" type="file" accept="image/*" style="display:none" onchange="uploadAvatar(this)">
       </label>`
    : avatar;
  const action = isMe ? '' : `<button class="sm ${p.followers>0&&false?'':'blue'}" id="followBtn" onclick="toggleFollow('${p.id}')">Follow</button>`;
  const actHtml = action?`<div style="margin:10px 0">${action}</div>`:'';
  const feed = (p.recentActivity&&p.recentActivity.length)
    ? p.recentActivity.map(a=>`<div class="feed-item"><span class="fi-ic">${a.type==='pr'?'🏆':a.type==='streak'?flameSvg():'✅'}</span><div>${esc(a.text)}</div></div>`).join('')
    : '<div class="muted" style="padding:14px 0;text-align:center">No recent activity yet.</div>';
  $('app').innerHTML = `<div class="wrap">
    <div class="profile-head">
      ${avatarBlock}
      <div class="pinfo">
        <div class="pname">${esc(p.displayName||p.username)}</div>
        <div class="muted">@${esc(p.username)}</div>
        ${p.streak>=2?`<div class="streak-pill" style="margin-top:6px">${flameSvg()}${p.streak} day streak</div>`:''}
      </div>
    </div>
    ${stats}
    ${actHtml}
    ${bioBlock}
    <h2>Recent activity</h2>
    <div class="card" style="padding:4px 12px">${feed}</div>
    ${isMe?`<button class="sec" style="margin-top:18px" onclick="logout()">Log out</button>`:''}
  </div>`;
  // reflect follow state
  if(!isMe) reflectFollow(p);
}
async function reflectFollow(p){
  const me = await H.get('/api/profile/me');
  const btn = document.getElementById('followBtn');
  if(!btn) return;
  const following = (me.followers!==undefined); // placeholder; server drives count
  btn.textContent = 'Follow';
  btn.onclick = ()=>toggleFollow(p.id);
}
async function toggleFollow(id){
  const r = await H.post('/api/follow/'+id,{});
  if(r.error){ alert(r.error); return; }
  const btn = document.getElementById('followBtn');
  if(btn){ btn.textContent = 'Following'; btn.classList.remove('blue'); }
  profileView(id);
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
  try{
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
