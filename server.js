const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const LIB_FILE = path.join(__dirname, 'exercise-library.json');
const VAPID_FILE = path.join(__dirname, 'vapid.json');
const PORT = process.env.PORT || 3000;

// ---- VAPID (reuse Daily Routine pattern) ----
let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (fs.existsSync(VAPID_FILE)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2));
}
webpush.setVapidDetails('mailto:jeff@example.com', vapid.publicKey, vapid.privateKey);

// ---- Store ----
function load() {
  if (!fs.existsSync(DATA_FILE)) return { users: {}, sessions: {}, friendships: {}, pushSubs: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { users: {}, sessions: {}, friendships: {}, pushSubs: {} }; }
}
function save(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
let DB = load();
const EX_LIB = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')).exercises;

// ---- Auth (simple username + pin, no password hashing for MVP demo) ----
function uid() { return Math.random().toString(36).slice(2, 10); }
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// token -> userId  (in-memory for MVP; good enough for demo, survives while server runs)
const SESSIONS_TOKEN = {}; // token -> userId

function auth(req, res, next) {
  const t = req.headers['authorization'] || '';
  const token = t.replace(/^Bearer\s/, '');
  const userId = SESSIONS_TOKEN[token];
  if (!userId || !DB.users[userId]) return res.status(401).json({ error: 'unauthorized' });
  req.userId = userId;
  next();
}

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/vapid', (req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/register', (req, res) => {
  const { username, pin, displayName } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'username + pin required' });
  const exists = Object.values(DB.users).find(u => u.username === username);
  if (exists) return res.status(409).json({ error: 'username taken' });
  const id = uid();
  DB.users[id] = { id, username, pin, displayName: displayName || username, friends: [] };
  save(DB);
  const token = uid() + uid();
  SESSIONS_TOKEN[token] = id;
  res.json({ token, user: publicUser(id) });
});

app.post('/api/login', (req, res) => {
  const { username, pin } = req.body || {};
  const u = Object.values(DB.users).find(x => x.username === username);
  if (!u || u.pin !== pin) return res.status(401).json({ error: 'bad credentials' });
  const token = uid() + uid();
  SESSIONS_TOKEN[token] = u.id;
  res.json({ token, user: publicUser(u.id) });
});

// ---- Forgot username / password (v1: in-app reset, no email yet) ----
app.post('/api/forgot', (req, res) => {
  const { username } = req.body || {};
  const u = Object.values(DB.users).find(x => x.username === username);
  // Don't reveal whether the username exists (avoid account enumeration), but for v1 demo we return found:true to drive the UI.
  if (!u) return res.status(404).json({ error: 'No account with that username' });
  res.json({ found: true, displayName: u.displayName });
});
app.post('/api/reset', (req, res) => {
  const { username, newPin } = req.body || {};
  if (!newPin || String(newPin).length < 1) return res.status(400).json({ error: 'new password required' });
  const u = Object.values(DB.users).find(x => x.username === username);
  if (!u) return res.status(404).json({ error: 'No account with that username' });
  u.pin = String(newPin);
  save(DB);
  res.json({ ok: true });
});

function publicUser(id) {
  const u = DB.users[id];
  return { id: u.id, username: u.username, displayName: u.displayName };
}

// ---- Exercise library ----
app.get('/api/exercises', (req, res) => res.json(EX_LIB));

// ---- Friends ----
app.post('/api/friends/add', auth, (req, res) => {
  const { username } = req.body || {};
  const friend = Object.values(DB.users).find(u => u.username === username);
  if (!friend) return res.status(404).json({ error: 'user not found' });
  if (friend.id === req.userId) return res.status(400).json({ error: 'cannot friend self' });
  const me = DB.users[req.userId];
  if (!me.friends.includes(friend.id)) me.friends.push(friend.id);
  if (!friend.friends.includes(req.userId)) friend.friends.push(req.userId);
  save(DB);
  res.json({ friends: me.friends.map(publicUser) });
});
app.get('/api/friends', auth, (req, res) => {
  res.json(DB.users[req.userId].friends.map(id => ({ ...publicUser(id), streak: currentStreak(id) })));
});

// ---- Activity feed (Friend's Activity) ----
// Shows friends' COMPLETED activity: PRs they hit + workouts they finished this week + current streak.
// Invites live in their own "Invites Awaiting" section on Home, not here.
function currentStreak(userId){
  // collect distinct completion dates from session history
  const days = new Set();
  for (const s of Object.values(DB.sessions)) {
    for (const h of (s.history || [])) {
      if (h.userId === userId) days.add(h.date);
    }
  }
  if (!days.size) return 0;
  const has = d => days.has(d);
  const key = d => d.toISOString().slice(0,10);
  let streak = 0;
  let cur = new Date();
  // allow streak to count if last workout was today or yesterday
  if (!has(key(cur))) { cur.setDate(cur.getDate()-1); if (!has(key(cur))) return 0; }
  while (has(key(cur))) { streak++; cur.setDate(cur.getDate()-1); }
  return streak;
}
app.get('/api/feed', auth, (req, res) => {
  const myFriends = DB.users[req.userId].friends;
  const items = [];
  const weekAgo = Date.now() - 7*24*3600*1000;
  // PRs from friends
  for (const fid of myFriends) {
    const prs = (DB.prs && DB.prs[fid]) ? Object.values(DB.prs[fid]) : [];
    for (const p of prs) items.push({ type: 'pr', by: fid, at: p.at, text: `hit a new PR on ${p.exercise} (${p.weight}×${p.reps})` });
  }
  // Workouts completed this week (from session history)
  for (const fid of myFriends) {
    let count = 0;
    for (const s of Object.values(DB.sessions)) {
      for (const h of (s.history || [])) {
        if (h.userId === fid && new Date(h.date).getTime() >= weekAgo) count++;
      }
    }
    if (count > 0) items.push({ type: 'completed', by: fid, at: new Date().toISOString(), text: `completed ${count} workout${count>1?'s':''} this week` });
    // Current streak
    const streak = currentStreak(fid);
    if (streak >= 2) items.push({ type: 'streak', by: fid, at: new Date().toISOString(), text: `hit a ${streak} day workout streak` });
  }
  items.sort((a,b)=> new Date(b.at) - new Date(a.at));
  res.json(items);
});


// ---- Templates (saved routines) ----
app.get('/api/templates', auth, (req, res) => {
  const all = Object.values(DB.templates || {});
  const mine = all.filter(t => t.ownerId === req.userId);
  // also templates shared by friends
  const friendT = all.filter(t => DB.users[req.userId].friends.includes(t.ownerId));
  res.json({ mine, shared: friendT });
});
app.post('/api/templates', auth, (req, res) => {
  const { name, exercises } = req.body || {};
  if (!name || !Array.isArray(exercises) || !exercises.length) return res.status(400).json({ error: 'name + exercises required' });
  const id = 't_' + uid();
  const t = { id, ownerId: req.userId, name, exercises: exercises.map(e => ({ name: e.name, defaultSets: e.defaultSets || 3, defaultReps: e.defaultReps || 10 })) };
  if (!DB.templates) DB.templates = {};
  DB.templates[id] = t;
  save(DB);
  res.json(t);
});

// ---- Session comments (Message Host / chat) ----
app.get('/api/sessions/:id/comments', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s.comments || []);
});
app.post('/api/sessions/:id/comments', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!s.participants.includes(req.userId) && !(s.visibility==='friends' && DB.users[req.userId].friends.includes(s.creatorId)))
    return res.status(403).json({ error: 'forbidden' });
  const text = (req.body || {}).text || '';
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  const c = { id: 'c_' + uid(), userId: req.userId, text, at: new Date().toISOString() };
  if (!s.comments) s.comments = [];
  s.comments.push(c);
  save(DB);
  for (const pid of s.participants) if (pid !== req.userId) notify(pid, { title: 'New message', body: `${DB.users[req.userId].displayName}: ${text.slice(0,40)}` });
  res.json(s);
});

// ---- Push subscribe ----
app.post('/api/push/subscribe', auth, (req, res) => {
  DB.pushSubs[req.userId] = req.body && req.body.subscription;
  save(DB);
  res.json({ ok: true });
});
function notify(userId, payload) {
  const sub = DB.pushSubs[userId];
  if (!sub) return;
  webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {});
}

// ---- Sessions ----
// A session: { id, creatorId, scheduledAt, status, visibility, equipment[],
//   location, lengthMin, creatorNote,
//   exercises: [{ id, name, order, defaultSets, defaultReps }],
//   participants: [userId],
//   variations: { [exerciseId]: { [userId]: { swapTo, reason } } },
//   suggestedEdits: [ { id, exerciseId, proposedBy, swapTo, status } ],
//   joinRequests: [ { id, userId, note, status } ],
//   attendance: { [userId]: 'in'|'maybe'|'out' },
//   logs: { [userId]: [ { exerciseId, weight, reps, set, isPr } ] },
//   comments: [ { id, userId, text, at } ],
//   history: [ { userId, date, muscleGroups[], exercises[] } ]  // per completed session
// }
function newSessionId() { return 's_' + uid(); }

// ---- Templates (saved routines, reusable) ----
// templates: { [templateId]: { id, ownerId, name, exercises:[{name,defaultSets,defaultReps}] } }

app.post('/api/sessions', auth, (req, res) => {
  const { scheduledAt, visibility, equipment, exercises, inviteUsernames, location, lengthMin, creatorNote, name } = req.body || {};
  if (!Array.isArray(exercises) || !exercises.length) return res.status(400).json({ error: 'needs exercises' });
  const id = newSessionId();
  const ex = exercises.map((e, i) => ({
    id: 'e_' + uid(),
    name: e.name,
    order: i,
    defaultSets: e.defaultSets || 3,
    defaultReps: e.defaultReps || 10
  }));
  const invites = [];
  if (Array.isArray(inviteUsernames)) {
    for (const un of inviteUsernames) {
      const f = DB.users[req.userId].friends.find(fid => DB.users[fid].username === un);
      if (f) invites.push(f);
    }
  }
  const session = {
    id, creatorId: req.userId,
    scheduledAt: scheduledAt || new Date().toISOString(),
    status: 'draft',
    visibility: visibility === 'friends' ? 'friends' : 'private',
    equipment: equipment || [],
    location: location || '',
    lengthMin: lengthMin || null,
    creatorNote: creatorNote || '',
    name: name || '',
    exercises: ex,
    participants: [req.userId],
    invited: invites.map(f => f.id),
    variations: {},
    suggestedEdits: [],
    joinRequests: [],
    attendance: {},
    logs: {},
    comments: [],
    history: []
  };
  DB.sessions[id] = session;
  save(DB);
  // notify invited friends
  for (const fid of invites) notify(fid, { title: 'Workout invite', body: `${DB.users[req.userId].displayName} invited you to a workout` });
  res.json(session);
});

// list sessions visible to me: mine, invited to, or friends-visibility from friends
app.get('/api/sessions', auth, (req, res) => {
  const myFriends = DB.users[req.userId].friends;
  const out = Object.values(DB.sessions).filter(s => {
    if (s.participants.includes(req.userId)) return true;
    if (Array.isArray(s.invited) && s.invited.includes(req.userId)) return true;
    if (s.visibility === 'friends' && myFriends.includes(s.creatorId)) return true;
    return false;
  }).sort((a,b)=> new Date(a.scheduledAt) - new Date(b.scheduledAt));
  res.json(out);
});

app.get('/api/sessions/:id', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!s.participants.includes(req.userId) && !(Array.isArray(s.invited) && s.invited.includes(req.userId)) && !(s.visibility==='friends' && DB.users[req.userId].friends.includes(s.creatorId)))
    return res.status(403).json({ error: 'forbidden' });
  res.json(s);
});

// accept an invite (move from invited[] to participants[])
app.post('/api/sessions/:id/accept', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  s.invited = s.invited.filter(x => x !== req.userId);
  if (!s.participants.includes(req.userId)) s.participants.push(req.userId);
  save(DB);
  notify(s.creatorId, { title: 'Invite accepted', body: `${DB.users[req.userId].displayName} joined your workout` });
  res.json(s);
});

// decline an invite (remove from invited[], do not join)
app.post('/api/sessions/:id/decline', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  s.invited = s.invited.filter(x => x !== req.userId);
  save(DB);
  notify(s.creatorId, { title: 'Invite declined', body: `${DB.users[req.userId].displayName} declined your workout` });
  res.json(s);
});

// suggest a swap (any participant; also join-requester after approval)
app.post('/api/sessions/:id/suggest', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  // must be participant OR approved join-requester
  const isParticipant = s.participants.includes(req.userId);
  const approvedJoin = s.joinRequests.find(j => j.userId === req.userId && j.status === 'approved');
  if (!isParticipant && !approvedJoin) return res.status(403).json({ error: 'not a participant' });
  const { exerciseId, swapTo } = req.body || {};
  const edit = { id: 'se_' + uid(), exerciseId, proposedBy: req.userId, swapTo, status: 'pending' };
  s.suggestedEdits.push(edit);
  save(DB);
  // notify creator
  notify(s.creatorId, { title: 'Swap suggested', body: `${DB.users[req.userId].displayName} suggested swapping to ${swapTo}` });
  res.json(s);
});

app.post('/api/sessions/:id/suggest/:editId/approve', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  edit.status = 'approved';
  s.variations[edit.exerciseId] = Object.assign({}, s.variations[edit.exerciseId], { [edit.proposedBy]: { swapTo: edit.swapTo, reason: 'swap' } });
  save(DB);
  notify(edit.proposedBy, { title: 'Swap approved', body: `${DB.users[s.creatorId].displayName} approved your swap to ${edit.swapTo}` });
  res.json(s);
});

app.post('/api/sessions/:id/suggest/:editId/reject', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  edit.status = 'rejected';
  save(DB);
  res.json(s);
});

// join request (friends-visibility sessions)
app.post('/api/sessions/:id/join', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s || s.visibility !== 'friends') return res.status(400).json({ error: 'not joinable' });
  if (s.joinRequests.find(j => j.userId === req.userId)) return res.status(400).json({ error: 'already requested' });
  s.joinRequests.push({ id: 'jr_' + uid(), userId: req.userId, note: (req.body||{}).note || '', status: 'pending' });
  save(DB);
  notify(s.creatorId, { title: 'Join request', body: `${DB.users[req.userId].displayName} wants to join your workout` });
  res.json(s);
});

app.post('/api/sessions/:id/join/:reqId/approve', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  const jr = s.joinRequests.find(j => j.id === req.params.reqId);
  if (!jr || s.creatorId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  jr.status = 'approved';
  if (!s.participants.includes(jr.userId)) s.participants.push(jr.userId);
  save(DB);
  notify(jr.userId, { title: 'Join approved', body: `${DB.users[s.creatorId].displayName} approved your join request` });
  res.json(s);
});

// attendance
app.post('/api/sessions/:id/attendance', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s.participants.includes(req.userId)) return res.status(403).json({ error: 'forbidden' });
  s.attendance[req.userId] = (req.body||{}).status || 'in';
  save(DB);
  res.json(s);
});

// log an individual set
app.post('/api/sessions/:id/log', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s.participants.includes(req.userId) && !s.joinRequests.find(j=>j.userId===req.userId&&j.status==='approved'))
    return res.status(403).json({ error: 'forbidden' });
  const { exerciseId, weight, reps, set } = req.body || {};
  if (!s.logs[req.userId]) s.logs[req.userId] = [];
  const w = Number(weight) || 0, r = Number(reps) || 0;
  // PR detection: best volume (weight*reps) for this exercise by this user, across all their logs
  const prevBest = s.logs[req.userId].filter(l => l.exerciseId === exerciseId).reduce((m,l)=> Math.max(m, (Number(l.weight)||0)*(Number(l.reps)||0)), 0);
  const isPr = (w*r) > 0 && (w*r) > prevBest;
  const entry = { exerciseId, weight: w, reps: r, set: set || s.logs[req.userId].length+1, isPr };
  s.logs[req.userId].push(entry);
  if (isPr) {
    if (!DB.prs) DB.prs = {};
    if (!DB.prs[req.userId]) DB.prs[req.userId] = {};
    const exName = (s.exercises.find(e=>e.id===exerciseId)||{}).name || exerciseId;
    DB.prs[req.userId][exerciseId] = { exercise: exName, weight: w, reps: r, at: new Date().toISOString() };
  }
  save(DB);
  res.json(s);
});

// lock session (mark done) -> record history for conflict detection
app.post('/api/sessions/:id/lock', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator' });
  s.status = 'locked';
  // record each participant's history
  for (const pid of s.participants) {
    const exNames = s.exercises.map(e => {
      const v = s.variations[e.id] && s.variations[e.id][pid];
      return v ? v.swapTo : e.name;
    });
    const mgs = new Set();
    for (const n of exNames) {
      const lib = EX_LIB.find(x => x.name === n);
      if (lib) lib.muscle_groups.forEach(m => mgs.add(m));
    }
    if (!s.history) s.history = [];
    s.history.push({ userId: pid, date: new Date().toISOString().slice(0,10), muscleGroups: [...mgs], exercises: exNames });
  }
  save(DB);
  res.json(s);
});

const server = app.listen(PORT, () => console.log('CrewFit on', PORT));
module.exports = { app, server };
