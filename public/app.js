const API = '';
let TOKEN = localStorage.getItem('crewfit_token') || '';
let ME = null;
const H = {
  get:p=>(fetch(API+p,{headers:{Authorization:'Bearer '+TOKEN}}).then(r=>r.json())),
  post:(p,b)=>(fetch(API+p,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},body:JSON.stringify(b||{})}).then(r=>r.json())),
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
  let html = `<div class="wrap"><h1>Home</h1>
    <button class="blue" onclick="createFlow()">+ New workout</button>`;

  // Section 1: Friend's Activity (completed activity, not invites)
  html += `<h2>Friend's Activity</h2><div class="card">`;
  if(feed.length){
    for(const f of feed){
      const who = await friendName(f.by);
      const ic = f.type==='pr' ? '🏆' : '✅';
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
  // my variation view
  const myEx = s.exercises.map(e=>{
    const v = s.variations[e.id] && s.variations[e.id][ME.id];
    return `<div class="lib-item"><div>${v?`<b>${esc(v.swapTo)}</b> <span class="tag">(your swap)</span>`:esc(e.name)}</div><div class="tag">${e.defaultSets}×${e.defaultReps}</div></div>`;
  }).join('');
  // suggested edits
  let edits = '';
  for(const ed of s.suggestedEdits){
    const by = await nameOf(ed.proposedBy);
    if(ed.status==='pending'){
      edits += `<div class="edits"><div>${esc(by)} suggested → <b>${esc(ed.swapTo)}</b></div>`;
      if(isCreator) edits += `<div class="row"><button class="sm" onclick="approve('${s.id}','${ed.id}')">Approve</button><button class="sm red" onclick="reject('${s.id}','${ed.id}')">Reject</button></div>`;
      else edits += `<div class="tag">waiting on creator</div>`;
      edits += `</div>`;
    } else {
      edits += `<div class="me"><div>${esc(by)} → ${esc(ed.swapTo)} <span class="tag">(${ed.status})</span></div></div>`;
    }
  }
  // join requests (creator only)
  let jr = '';
  if(isCreator){
    for(const j of s.joinRequests.filter(x=>x.status==='pending')){
      jr += `<div class="edits"><div>${esc(await nameOf(j.userId))} wants to join ${j.note?`— "${esc(j.note)}"`:''}</div>
        <div class="row"><button class="sm" onclick="approveJoin('${s.id}','${j.id}')">Approve</button></div></div>`;
    }
  }
  let html = `<div class="wrap"><button class="sec sm" onclick="showTab('home')">← Back</button>
    <h1>${fmtDate(s.scheduledAt)}</h1>
    <div class="muted">${s.visibility==='friends'?'Friends-only · joinable':'Private'} · ${s.participants.length} people</div>
    ${s.location?`<div class="tag">📍 ${esc(s.location)}</div>`:''}
    ${s.lengthMin?`<div class="tag">⏱ ${esc(s.lengthMin)} min</div>`:''}
    ${s.creatorNote?`<div class="card muted">"${esc(s.creatorNote)}" — ${isCreator?'you':esc(s.creatorId)}</div>`:''}`;
  if(isCreator && s.status!=='locked') html += `<button class="blue sm" onclick="lock('${s.id}')">Lock & finish</button>`;
  html += `<h2>Workout (your view)</h2>${myEx}`;
  if(edits) html += `<h2>Suggested swaps</h2>${edits}`;
  if(jr) html += `<h2>Join requests</h2>${jr}`;
  if(canEdit){
    html += `<h2>Suggest a swap</h2><div class="card">
      <select id="swEx">${s.exercises.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      <input id="swTo" placeholder="swap to (exercise name)">
      <button onclick="suggest('${s.id}')">Suggest swap</button></div>`;
    html += `<h2>Log your sets</h2><div class="card" id="logbox">
      <select id="lgEx">${s.exercises.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      <div class="row"><input id="lgW" placeholder="weight" type="number"><input id="lgR" placeholder="reps" type="number"></div>
      <button class="sm" onclick="logSet('${s.id}')">Add set</button>
      <div id="logview" class="muted"></div></div>`;
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
  renderLogs(s);
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
async function suggest(id){ const r=await H.post(`/api/sessions/${id}/suggest`,{exerciseId:$('swEx').value,swapTo:$('swTo').value}); if(r.error)alert(r.error); else openSession(id); }
async function logSet(id){ await H.post(`/api/sessions/${id}/log`,{exerciseId:$('lgEx').value,weight:$('lgW').value,reps:$('lgR').value}); const s=await H.get('/api/sessions/'+id); renderLogs(s); }
function renderLogs(s){ const mine=(s.logs&&s.logs[ME.id])||[]; $('logview').innerHTML = mine.length?`Logged ${mine.length} set(s).`:'No sets yet.'; }
async function lock(id){ await H.post(`/api/sessions/${id}/lock`); openSession(id); }

// ---- Create flow ----
let DRAFT = { exercises:[], inviteUsernames:[] };
async function createFlow(){
  DRAFT = DRAFT || { exercises:[], inviteUsernames:[] };
  if(!DRAFT.exercises) DRAFT.exercises=[];
  if(!DRAFT.inviteUsernames) DRAFT.inviteUsernames=[];
  const friends = await H.get('/api/friends');
  $('app').innerHTML = `<div class="wrap"><button class="sec sm" onclick="showTab('home')">← Cancel</button>
    <h1>New workout</h1>
    <label class="muted">Workout name</label><input id="wname" placeholder="e.g. Chest & Back" value="${esc(DRAFT.name||'')}">
    <label class="muted">When</label><input id="dt" type="datetime-local">
    <label class="muted">Location</label><input id="loc" placeholder="e.g. Gold's Gym" value="${esc(DRAFT.location||'')}">
    <div class="row"><div><label class="muted">Length (min)</label><input id="len" type="number" placeholder="60" value="${DRAFT.lengthMin||''}"></div></div>
    <label class="muted">Note to friends</label><input id="note" placeholder="let's hit legs hard" value="${esc(DRAFT.creatorNote||'')}">
    <label class="muted">Visibility</label>
    <select id="vis"><option value="private">Private (invite only)</option><option value="friends">Friends-only (joinable)</option></select>
    <h2>Exercises</h2><div id="draftList" class="card"></div>
    <button class="sec" onclick="pickExercise()">+ Add exercise</button>
    <button class="sec sm" onclick="useTemplate()">⚡ Use a template</button>
    <h2>Invite friends</h2><div id="invList">${friends.map(f=>`<label class="lib-item"><input type="checkbox" value="${esc(f.username)}" onchange="toggleInvite(this)"> ${esc(f.displayName)}</label>`).join('')||'<div class="muted">No friends yet — add some in Friends tab.</div>'}</div>
    <button class="blue" onclick="submitSession()">Create workout</button></div>`;
  renderDraft();
}
async function useTemplate(){
  const { mine, shared } = await H.get('/api/templates');
  const all = [...mine, ...shared];
  if(!all.length){ alert('No templates yet. Build a workout, then "Save as template".'); return; }
  const pick = prompt('Pick a template:\n' + all.map((t,i)=>`${i+1}. ${t.name} (${t.exercises.length} ex)`).join('\n'));
  const idx = parseInt(pick,10)-1;
  if(isNaN(idx)||!all[idx]) return;
  DRAFT.exercises = all[idx].exercises.map(e=>({name:e.name,defaultSets:e.defaultSets,defaultReps:e.defaultReps}));
  renderDraft();
}
function toggleInvite(cb){ const u=cb.value; if(cb.checked){ if(!DRAFT.inviteUsernames.includes(u)) DRAFT.inviteUsernames.push(u);} else { DRAFT.inviteUsernames=DRAFT.inviteUsernames.filter(x=>x!==u);} }
function renderDraft(){ $('draftList').innerHTML = DRAFT.exercises.length? DRAFT.exercises.map((e,i)=>`<div class="lib-item"><div>${esc(e.name)} <span class="tag">${e.defaultSets}×${e.defaultReps}</span></div><button class="sm red" onclick="rmEx(${i})">✕</button></div>`).join('') : '<div class="muted">None added.</div>'; }
function rmEx(i){ DRAFT.exercises.splice(i,1); renderDraft(); }
async function pickExercise(){
  // stash any details typed so far (the create form is about to be replaced)
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  if($('wname')) DRAFT.name = $('wname').value;
  window._PFILTER = { pat: '', mg: '', q: '' };
  const lib = await H.get('/api/exercises');
  window._LIB = lib;
  const pats = ['push','pull','legs','core','cardio'];
  const mgs = ['chest','back','shoulders','biceps','triceps','quads','hamstrings','glutes','calves','abs','core','traps','forearms'];
  $('app').innerHTML = `<div class="wrap"><button class="sec sm" onclick="createFlow()">← Done</button><h1>Add exercise</h1>
    <input id="search" placeholder="search" oninput="filterLib()">
    <div class="chips"><span class="lbl">Pattern</span>${pats.map(p=>`<span class="chip" data-k="pat" data-v="${p}" onclick="chip(this)">${p}</span>`).join('')}</div>
    <div class="chips"><span class="lbl">Muscle</span>${mgs.map(m=>`<span class="chip" data-k="mg" data-v="${m}" onclick="chip(this)">${m}</span>`).join('')}</div>
    <div class="scrolllist" id="libList"></div></div>`;
  filterLib();
}
function chip(el){ const k=el.dataset.k, v=el.dataset.v; const cur=window._PFILTER[k]; if(cur===v){ window._PFILTER[k]=''; el.classList.remove('on'); } else { window._PFILTER[k]=v; document.querySelectorAll(`.chip[data-k="${k}"]`).forEach(c=>c.classList.remove('on')); el.classList.add('on'); } filterLib(); }
function filterLib(){
  const q=(window._PFILTER.q=($('search').value||'').toLowerCase());
  const {pat,mg}=window._PFILTER;
  const list = window._LIB.filter(e=>
    (!pat || e.pattern===pat) &&
    (!mg || (e.muscle_groups||[]).includes(mg)) &&
    (!q || e.name.toLowerCase().includes(q) || (e.muscle_groups||[]).join(',').includes(q))
  );
  $('libList').innerHTML = list.length ? list.map(e=>`<div class="lib-item" onclick="addEx('${esc(e.name)}')"><div>${esc(e.name)}</div><span class="badge">${esc(e.pattern)}</span><span class="tag">${(e.muscle_groups||[]).join(', ')}</span></div>`).join('') : '<div class="muted">No matches.</div>';
}
function addEx(name){
  // preserve any draft details the user already typed
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  DRAFT.exercises.push({name,defaultSets:3,defaultReps:10});
  createFlow();
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

// ---- Library ----
async function library(){
  window._PFILTER2 = { pat:'', mg:'', q:'' };
  const lib = await H.get('/api/exercises');
  window._LIB2 = lib;
  const pats = ['push','pull','legs','core','cardio'];
  const mgs = ['chest','back','shoulders','biceps','triceps','quads','hamstrings','glutes','calves','abs','core','traps','forearms'];
  const cats = {}; lib.forEach(e=>{cats[e.pattern]=(cats[e.pattern]||0)+1;});
  $('app').innerHTML = `<div class="wrap"><h1>Exercises</h1>
    <div>${Object.keys(cats).map(c=>`<span class="pill">${esc(c)} ${cats[c]}</span>`).join('')}</div>
    <input id="ls" placeholder="search" oninput="filterLib2()">
    <div class="chips"><span class="lbl">Pattern</span>${pats.map(p=>`<span class="chip" data-k="pat" data-v="${p}" onclick="chip2(this)">${p}</span>`).join('')}</div>
    <div class="chips"><span class="lbl">Muscle</span>${mgs.map(m=>`<span class="chip" data-k="mg" data-v="${m}" onclick="chip2(this)">${m}</span>`).join('')}</div>
    <div class="scrolllist" id="lib2"></div></div>`;
  filterLib2();
}
function chip2(el){ const k=el.dataset.k, v=el.dataset.v; const cur=window._PFILTER2[k]; if(cur===v){ window._PFILTER2[k]=''; el.classList.remove('on'); } else { window._PFILTER2[k]=v; document.querySelectorAll(`.chip[data-k="${k}"]`).forEach(c=>c.classList.remove('on')); el.classList.add('on'); } filterLib2(); }
function filterLib2(){
  const q=(window._PFILTER2.q=($('ls').value||'').toLowerCase());
  const {pat,mg}=window._PFILTER2;
  $('lib2').innerHTML = window._LIB2.filter(e=>
    (!pat || e.pattern===pat) &&
    (!mg || (e.muscle_groups||[]).includes(mg)) &&
    (!q || e.name.toLowerCase().includes(q) || (e.muscle_groups||[]).join(',').includes(q))
  ).map(e=>`<div class="lib-item"><div>${esc(e.name)}</div><span class="tag">${e.pattern} · ${(e.muscle_groups||[]).join(', ')}</span><span class="badge">${e.level||''}</span></div>`).join('');
}

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
  if(!mine.length && !shared.length) html += `<div class="card muted">No templates yet. Create a workout and choose "Save as template".</div>`;
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
  $('app').innerHTML = `<div class="wrap"><h1>Friends</h1>
    <div class="card"><input id="fu" placeholder="friend username">
    <button class="sm" onclick="addFriend()">Add friend</button></div>
    ${f.map(x=>`<div class="lib-item"><div class="row"><div class="avatar">${esc(x.displayName[0]||'?')}</div><div>${esc(x.displayName)}<div class="tag">@${esc(x.username)}</div></div></div></div>`).join('')||'<div class="muted">No friends yet.</div>'}
    </div>`;
}
async function addFriend(){ const r=await H.post('/api/friends/add',{username:$('fu').value}); if(r.error)alert(r.error); else friends(); }

// ---- Me ----
function meScreen(){
  $('app').innerHTML = `<div class="wrap"><h1>${esc(ME.displayName)}</h1>
    <div class="muted">@${esc(ME.username)}</div>
    <div class="card"><div class="muted">How to use with Brian:</div>
      <ol style="margin:6px 0; padding-left:18px"><li>Both create accounts</li><li>Add each other as friends</li><li>One creates a workout & invites the other</li><li>Both open it, swap exercises, approve</li><li>Log your own sets</li></ol></div>
    <button class="sec" onclick="logout()">Log out</button></div>`;
}
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
  if(TOKEN){ try{ const me = await H.get('/api/friends'); ME = JSON.parse(localStorage.getItem('crewfit_me')||'null'); }catch(e){} }
  if(TOKEN && ME){ $('nav').classList.remove('hidden'); home(); }
  else authScreen();
  if('serviceWorker' in navigator) setupPush();
  document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
})();
