const base = 'http://localhost:4700';
const uname = 'prtest' + Date.now();
const reg = await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:uname,pin:'1234',displayName:'PR Tester'})}).then(r=>r.json());
const token = reg.token, uid = reg.user.id;
const H = {'Content-Type':'application/json',Authorization:'Bearer '+token};

// Session A: log Bench Press 185x8
const sA = await fetch(base+'/api/sessions',{method:'POST',headers:H,body:JSON.stringify({exercises:[{name:'Bench Press',defaultSets:3,defaultReps:8}],visibility:'private',name:'Session A'})}).then(r=>r.json());
const exA = sA.exercises[0].id;
const logA = await fetch(base+`/api/sessions/${sA.id}/log`,{method:'POST',headers:H,body:JSON.stringify({exerciseId:exA,weight:185,reps:8})}).then(r=>r.json());
const entryA = logA.logs[uid][logA.logs[uid].length-1];
console.log('Session A: logged 185x8, isPr =', entryA.isPr, '(expect true — first ever set)');
await fetch(base+`/api/sessions/${sA.id}/lock`,{method:'POST',headers:H});

// Session B (different session, DIFFERENT random exerciseId for "Bench Press"): log a WEAKER set
const sB = await fetch(base+'/api/sessions',{method:'POST',headers:H,body:JSON.stringify({exercises:[{name:'Bench Press',defaultSets:3,defaultReps:8}],visibility:'private',name:'Session B'})}).then(r=>r.json());
const exB = sB.exercises[0].id;
console.log('exerciseId differs across sessions:', exA, 'vs', exB, '(', exA!==exB ? 'CONFIRMED different' : 'SAME - unexpected', ')');
const logB1 = await fetch(base+`/api/sessions/${sB.id}/log`,{method:'POST',headers:H,body:JSON.stringify({exerciseId:exB,weight:135,reps:8})}).then(r=>r.json());
const entryB1 = logB1.logs[uid][logB1.logs[uid].length-1];
console.log('Session B: logged 135x8 (weaker than 185x8 all-time best), isPr =', entryB1.isPr, '(expect FALSE — this is the bug fix)');

// Session B: now log something that IS a genuine new best
const logB2 = await fetch(base+`/api/sessions/${sB.id}/log`,{method:'POST',headers:H,body:JSON.stringify({exerciseId:exB,weight:205,reps:8})}).then(r=>r.json());
const entryB2 = logB2.logs[uid][logB2.logs[uid].length-1];
console.log('Session B: logged 205x8 (heavier than 185x8 all-time best), isPr =', entryB2.isPr, '(expect true)');
await fetch(base+`/api/sessions/${sB.id}/lock`,{method:'POST',headers:H});

const profile = await fetch(base+'/api/profile/'+uid,{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
console.log('\nFinal prCount:', profile.prCount, '(expect 1 — one distinct exercise, not one per session)');
console.log('Final prs list:', JSON.stringify(profile.prs));
console.log('(expect a single Bench Press entry at 205x8, NOT 185x8 and NOT two separate entries)');
