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
  const initial = ((ME&&(ME.displayName||ME.username))||'?')[0]||'?';
  const homeAvatarHtml = ME && ME.avatar
    ? `<img class="home-avatar" src="${esc(ME.avatar)}" alt="" onclick="showTab('me')">`
    : `<div class="home-avatar" onclick="showTab('me')">${esc(initial.toUpperCase())}</div>`;
  let html = `<div class="wrap home-head">
    <div class="home-top">
      <div class="home-brand">CrewFit</div>
      ${homeAvatarHtml}
    </div>
    <button class="blue btn-hero" onclick="createFlow()">+ New workout</button>`;

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
// ---- Exercise thumbnail (SVG, shown in detail sheet only) ----
// ---- Muscle-group icons (real mannequin crops w/ red highlight, from user reference images) ----
// Map muscle-group key -> png in public/muscle-icons/. Old SVG glyphs replaced.
function mgIcon(mg){
  const key = MG_IMG[mg] || mg;
  return `<img class="mg-img" src="muscle-icons/${key}.png" alt="${esc(mg)}" loading="lazy">`;
}
// keys that have a dedicated icon png; legacy data tags mapped to closest available icon
const MG_IMG = {
  chest:'chest', lats:'lats', traps:'traps', biceps:'biceps', triceps:'triceps',
  core:'core', quads:'quads', hamstrings:'hamstrings', calves:'calves',
  shoulders:'shoulders', forearms:'forearms', glutes:'glutes', cardio:'cardio',
  abdominals:'core'
};
function exThumb(e){
  const mg = (e.muscle_groups&&e.muscle_groups[0]) || 'abdominals';
  return mgIcon(mg);
}
async function pickExercise(){
  // stash any details typed so far
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  if($('wname')) DRAFT.name = $('wname').value;
  const lib = await H.get('/api/exercises');
  window._LIB = lib;
  const cats = [...new Set(lib.flatMap(e=>(e.muscle_groups||[])))];
  const eqs = [...new Set(lib.flatMap(eqFamilies))];
  window._PFILTER = { cat:'', eq:'', q:'' };
  $('app').innerHTML = `<div class="pick">
    <div class="pick-head">
      <button class="sec sm" onclick="createFlow()">Done</button>
      <h1>Add exercises</h1>
      <span class="pick-count" id="pickCount">${DRAFT.exercises.length} added</span>
    </div>
    <div class="pick-search"><input id="search" placeholder="Search exercises" oninput="filterLib()"></div>
    <div class="cat-pills" id="catPills">
      <span class="cat-pill on" data-cat="" onclick="pickCat(this)">All</span>
      ${cats.map(c=>`<span class="cat-pill" data-cat="${esc(c)}" onclick="pickCat(this)">${esc(c)}</span>`).join('')}
    </div>
    <div class="cat-pills eq-pills" id="eqPills">
      <span class="cat-pill on" data-eq="" onclick="pickEq(this)">Any</span>
      ${eqs.map(k=>`<span class="cat-pill" data-eq="${k}" onclick="pickEq(this)">${eqLabel(k)}</span>`).join('')}
    </div>
    <div class="pick-list" id="libList"></div>
  </div>`;
  filterLib();
}
function pickCat(el){
  window._PFILTER.cat = el.dataset.cat;
  document.querySelectorAll('#catPills .cat-pill').forEach(p=>p.classList.toggle('on', p===el));
  filterLib();
}
function pickEq(el){
  window._PFILTER.eq = el.dataset.eq;
  document.querySelectorAll('#eqPills .cat-pill').forEach(p=>p.classList.toggle('on', p===el));
  filterLib();
}
function filterLib(){
  const q=(window._PFILTER.q=($('search').value||'').toLowerCase());
  const {cat,eq}=window._PFILTER;
  const list = window._LIB.filter(e=>
    (!cat || (e.muscle_groups||[]).includes(cat)) &&
    (!eq || eqFamilies(e).includes(eq)) &&
    (!q || e.name.toLowerCase().includes(q) || (e.muscle_groups||[]).join(' ').includes(q))
  );
  // group by first muscle group for clean sections
  const groups={};
  list.forEach(e=>{ const g=(e.muscle_groups&&e.muscle_groups[0])||'Other'; (groups[g]=groups[g]||[]).push(e); });
  const added=Object.fromEntries(DRAFT.exercises.map(e=>[e.name,true]));
  const html = Object.keys(groups).sort().map(g=>`
    <div class="pick-group">${esc(g)}</div>
    ${groups[g].sort((a,b)=>a.name.localeCompare(b.name)).map(e=>`
      <div class="ex-row ${added[e.name]?'ex-on':''}" onclick="addEx('${esc(e.name)}', this)">
        <div class="ex-main">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-mg">${(e.muscle_groups||[]).slice(0,2).join(' · ')}</div>
        </div>
        <div class="ex-badges">${exBadges(e)}</div>
        <div class="ex-add">${added[e.name]?'✓':'+'}</div>
      </div>`).join('')}
  `).join('');
  $('libList').innerHTML = list.length ? html : '<div class="muted" style="padding:20px;text-align:center">No matches.</div>';
}
function addEx(name, el){
  if($('loc')) DRAFT.location = $('loc').value;
  if($('len')) DRAFT.lengthMin = $('len').value;
  if($('note')) DRAFT.creatorNote = $('note').value;
  const exists = DRAFT.exercises.find(e=>e.name===name);
  if(exists){ DRAFT.exercises = DRAFT.exercises.filter(e=>e.name!==name); }
  else DRAFT.exercises.push({name,defaultSets:3,defaultReps:10});
  const pc=$('pickCount'); if(pc) pc.textContent=DRAFT.exercises.length+' added';
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
async function library(){
  LIB_STATE = { view:'groups', muscle:'', eq:'', q:'' };
  const lib = await H.get('/api/exercises');
  window._LIB2 = lib;
  $('app').innerHTML = `<div class="pick">
    <div class="pick-head lib-head">
      <h1 style="flex:1">Exercises</h1>
      <button class="icon-btn" onclick="openCreateEx()" title="Create exercise">＋</button>
    </div>
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
  $('app').innerHTML = `<div class="pick">
    <div class="pick-head lib-head">
      <button class="sec sm" onclick="library()">‹ All muscles</button>
      <h1 style="flex:1;font-size:18px;text-transform:capitalize">${esc(m)}</h1>
      <button class="icon-btn" onclick="openCreateEx('${m}')" title="Create exercise">＋</button>
    </div>
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
  return `<div class="ex-row" onclick="exDetail('${esc(e.name)}')">
      <div class="ex-main">
        <div class="ex-name">${esc(e.name)}</div>
        <div class="ex-mg">${(e.muscle_groups||[]).slice(0,2).join(' · ')}${e.custom?' · your exercise':''}</div>
      </div>
      <div class="ex-badges">${exBadges(e)}</div>
      <div class="mg-chev">›</div>
    </div>`;
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
  sheet.onclick=closeSheet; document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
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
  sheet.onclick=closeSheet; document.body.appendChild(sheet);
  requestAnimationFrame(()=>sheet.classList.add('show'));
}
function closeSheet(){ const s=document.querySelector('.sheet-back'); if(s){ s.classList.remove('show'); setTimeout(()=>s.remove(),200); } }

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
  const tmove = e=>{ if(e.touches.length===2){ e.preventDefault(); const d=pinchDist(e.touches); _crop.scale=Math.max(1,Math.min(6, scale0*(d/pinch0))); renderCrop(); } };
  ov.addEventListener('touchstart',tstart,{passive:false}); ov.addEventListener('touchmove',tmove,{passive:false});
  // mouse wheel / trackpad zoom anywhere (desktop testing)
  ov.addEventListener('wheel', e=>{ e.preventDefault(); _crop.scale=Math.max(1,Math.min(6, _crop.scale*(e.deltaY<0?1.08:0.92))); renderCrop(); }, {passive:false});
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
