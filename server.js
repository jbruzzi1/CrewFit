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
  if (!fs.existsSync(DATA_FILE)) return { users: {}, sessions: {}, friendships: {}, pushSubs: {}, customExercises: {} };
  try { const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); d.customExercises = d.customExercises || {}; return d; }
  catch (e) { return { users: {}, sessions: {}, friendships: {}, pushSubs: {}, customExercises: {} }; }
}
function save(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
// One-time migration: old posts stored photos as huge base64 blobs in data.json
// (truncated at 3,000,000 chars -> broken images, and re-uploaded on every Save -> very slow).
// Convert stored base64 to real files on the volume; drop unrecoverable (truncated) ones.
function migrateMedia() {
  let sessionsChanged = 0, recovered = 0, dropped = 0;
  for (const s of Object.values(DB.sessions || {})) {
    if (!s.post || !Array.isArray(s.post.media) || !s.post.media.length) continue;
    let touched = false;
    const keep = [];
    for (const m of s.post.media) {
      const src = m && m.src ? String(m.src) : '';
      if (src.startsWith('data:') && src.indexOf('base64,') > -1) {
        // Truncated blobs were sliced at exactly 3,000,000 chars -> unrecoverable.
        if (src.length >= 2_990_000) { dropped++; touched = true; continue; }
        try {
          const comma = src.indexOf(',');
          const mime = (src.slice(5, comma).match(/^(image\/\w+|video\/\w+)/) || [])[1] || 'image/jpeg';
          const b64 = src.slice(comma + 1);
          const ext = ({ 'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov' })[mime] || (mime.startsWith('video') ? 'mp4' : 'jpg');
          const fname = `post_mig_${s.id}_${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
          fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(b64, 'base64'));
          keep.push({ type: m.type === 'video' ? 'video' : 'image', src: `/uploads/${fname}` });
          recovered++; touched = true;
        } catch (e) { dropped++; touched = true; }
      } else {
        keep.push(m);
      }
    }
    if (touched) { s.post.media = keep; sessionsChanged++; }
  }
  if (sessionsChanged) { save(DB); console.log(`MIGRATE media: sessions=${sessionsChanged} recovered=${recovered} dropped=${dropped}`); }
}
let DB = load();
// The boot migrations and the PR rebuild used to run HERE and have been moved to the end of
// module evaluation — see the block above app.listen for why.
const EX_LIB = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')).exercises;

// ---- Auth (simple username + pin, no password hashing for MVP demo) ----
function uid() { return Math.random().toString(36).slice(2, 10); }
const app = express();
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// User-uploaded avatars live in the persistent volume so they survive redeploys.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

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
  DB.users[id] = { id, username, pin, displayName: displayName || username, friends: [], units: 'lb' };
  save(DB);
  const token = uid() + uid();
  SESSIONS_TOKEN[token] = id;
  res.json({ token, user: publicUser(id) });
});
// Live username availability check (used by the register popup as the user types)
app.get('/api/register/check', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username) return res.json({ available: false });
  const exists = Object.values(DB.users).find(u => u.username === username);
  res.json({ available: !exists });
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
  return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio || '', avatar: u.avatar || '', followers: (u.followers || []).length, following: (u.friends || []).length, units: u.units || 'lb' };
}

// ---- Exercise library (136 base + user-created) ----
app.get('/api/exercises', (req, res) => {
  const custom = Object.values(DB.customExercises || {}).flat();
  res.json(EX_LIB.concat(custom));
});
app.post('/api/exercises/custom', auth, (req, res) => {
  const { name, muscle_groups, equipment, level, is_compound, pattern } = req.body || {};
  if (!name || !Array.isArray(muscle_groups) || !muscle_groups.length) return res.status(400).json({ error: 'name + muscle_groups required' });
  const ex = {
    name: String(name).slice(0, 80),
    pattern: pattern || (muscle_groups[0] || 'other'),
    category: muscle_groups[0] || 'other',
    muscle_groups,
    equipment: Array.isArray(equipment) ? equipment : [],
    is_compound: !!is_compound,
    level: level || 'beginner',
    defaultSets: 3, defaultReps: 10,
    custom: true, ownerId: req.userId
  };
  DB.customExercises[req.userId] = DB.customExercises[req.userId] || [];
  DB.customExercises[req.userId].push(ex);
  save(DB);
  res.json(ex);
});

// ---- Profile (per-user, viewable by anyone logged in) ----
function profileOf(id, viewerId) {
  const u = DB.users[id];
  if (!u) return null;
  // workouts completed: distinct sessions with a history entry by this user,
  // OR sessions this user posted (saved) — both count as a completed workout
  const completed = new Set();
  for (const s of Object.values(DB.sessions)) {
    if ((s.history || []).some(h => h.userId === id)) completed.add(s.id);
    else if (s.post && s.post.by === id) completed.add(s.id);
  }
  const prs = (DB.prs && DB.prs[id]) ? Object.values(DB.prs[id]) : [];
  const viewerIsFriend = viewerId && id !== viewerId && (DB.users[viewerId].friends||[]).includes(id);
  const canSeePost = (post) => {
    if (!post) return false;
    if (id === viewerId) return true;                     // own profile: always
    if (post.visibility === 'public') return true;
    if (post.visibility === 'friends' && viewerIsFriend) return true;
    return false;                                          // 'only_me' or non-friend
  };
  const myWorkouts = Object.values(DB.sessions)
    .filter(s => (s.post && s.post.by === id) || (s.history || []).some(h => h.userId === id))
    .sort((a,b)=> new Date(b.scheduledAt||0) - new Date(a.scheduledAt||0))
    .map(s => {
      const post = canSeePost(s.post) ? s.post : null;
      // collaborators = other participants (and invited) who aren't the profile owner
      const others = new Set([...(s.participants||[]), ...(s.invited||[])].filter(x=>x && x!==id));
      const collaborators = [...others].map(uid=>DB.users[uid]).filter(Boolean).map(u=>({username:u.username, name:u.displayName||u.username}));
      return {
        id: s.id,
        name: s.name || 'Workout',
        date: (s.history.find(h=>h.userId===id)||{}).date || (s.scheduledAt ? String(s.scheduledAt).slice(0,10) : ''),
        exerciseCount: (s.exercises||[]).length,
        firstExercises: (s.exercises||[]).slice(0,3).map(e=>e.name),
        at: post ? post.at : (s.scheduledAt||''),
        collaborators,
        post: post ? {
          notes: post.notes || '',
          media: (post.media||[]).slice(0,6),
          mediaCount: (post.media||[]).length,
          visibility: post.visibility,
          at: post.at
        } : null
      };
    });
  return {
    ...publicUser(id),
    units: (DB.users[id] && DB.users[id].units) || 'lb',
    workoutsCompleted: completed.size,
    myWorkouts,
    prCount: prs.length,
    // v148: full PR list (name, best weight×reps, when it was set), most recent first — powers the
    // profile's "Personal Records" section. prCount above still just needs the length.
    prs: prs.slice().sort((a,b)=> new Date(b.at) - new Date(a.at)),
    streak: currentStreak(id),
    recentActivity: buildActivityFor(id)
  };
}
// Recent activity for a single user: PRs, weekly completions, streaks (most recent first)
function buildActivityFor(userId) {
  const items = [];
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const prs = (DB.prs && DB.prs[userId]) ? Object.values(DB.prs[userId]) : [];
  // Only surface PRs actually set in the last week here — DB.prs holds every current best regardless
  // of age, and without this filter "Recent Activity" would list every exercise you've ever maxed out,
  // forever, not just what's new.
  for (const p of prs) if (new Date(p.at).getTime() >= weekAgo) items.push({ type: 'pr', at: p.at, text: `hit a new PR on ${p.exercise} (${p.weight}×${p.reps})` });
  let count = 0;
  for (const s of Object.values(DB.sessions)) {
    for (const h of (s.history || [])) {
      if (h.userId === userId && new Date(h.date).getTime() >= weekAgo) count++;
    }
  }
  if (count > 0) items.push({ type: 'completed', at: new Date().toISOString(), text: `completed ${count} workout${count > 1 ? 's' : ''} this week` });
  const streak = currentStreak(userId);
  if (streak >= 2) items.push({ type: 'streak', at: new Date().toISOString(), text: `hit a ${streak} day workout streak` });
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  return items;
}

app.get('/api/profile/me', auth, (req, res) => res.json(profileOf(req.userId, req.userId)));
app.get('/api/profile/:id', auth, (req, res) => {
  const p = profileOf(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'user not found' });
  res.json(p);
});
app.post('/api/me/avatar', auth, (req, res) => {
  const { data, type } = req.body || {};
  if (!data || !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(data)) return res.status(400).json({ error: 'image data required' });
  const ext = (type === 'image/png' ? 'png' : 'jpg');
  const b64 = data.split(',')[1];
  const fname = `avatar_${req.userId}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(b64, 'base64'));
  const u = DB.users[req.userId];
  u.avatar = `/uploads/${fname}`;
  save(DB);
  res.json({ avatar: u.avatar });
});
app.post('/api/me/bio', auth, (req, res) => {
  const { bio } = req.body || {};
  DB.users[req.userId].bio = String(bio || '').slice(0, 280);
  save(DB);
  res.json({ bio: DB.users[req.userId].bio });
});
app.post('/api/follow/:id', auth, (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (req.params.id === req.userId) return res.status(400).json({ error: 'cannot follow self' });
  if (!target.followers) target.followers = [];
  if (!target.followers.includes(req.userId)) target.followers.push(req.userId);
  save(DB);
  res.json({ followers: target.followers.length });
});
app.post('/api/unfollow/:id', auth, (req, res) => {
  const target = DB.users[req.params.id];
  if (!target || !target.followers) return res.json({ followers: 0 });
  target.followers = target.followers.filter(x => x !== req.userId);
  save(DB);
  res.json({ followers: target.followers.length });
});

// ---- Friends ----
// friendRequests model: each user has incoming[] / outgoing[] of {from|to, status:'pending'}
function ensureFriendArrays(u){ if(!u.incoming) u.incoming=[]; if(!u.outgoing) u.outgoing=[]; if(!u.friends) u.friends=[]; }
app.get('/api/users/search', auth, (req, res) => {
  const q = (req.query.q||'').trim().toLowerCase();
  if(!q) return res.json([]);
  const me = req.userId;
  const hits = Object.values(DB.users).filter(u => u.id!==me && (
    u.username.toLowerCase().includes(q) || (u.displayName||'').toLowerCase().includes(q)
  )).slice(0,20).map(u => ({ ...publicUser(u.id), requestStatus:
    (DB.users[me].outgoing||[]).some(r=>r.to===u.id&&r.status==='pending') ? 'sent' :
    (DB.users[me].friends||[]).includes(u.id) ? 'friends' : 'none'
  }));
  res.json(hits);
});
app.post('/api/friends/request', auth, (req, res) => {
  const { username } = req.body || {};
  const friend = Object.values(DB.users).find(u => u.username === username);
  if (!friend) return res.status(404).json({ error: 'user not found' });
  if (friend.id === req.userId) return res.status(400).json({ error: 'cannot friend self' });
  const me = DB.users[req.userId]; ensureFriendArrays(me); ensureFriendArrays(friend);
  if (me.friends.includes(friend.id)) return res.status(400).json({ error: 'already friends' });
  if (me.outgoing.some(r=>r.to===friend.id && r.status==='pending')) return res.status(400).json({ error: 'request already sent' });
  me.outgoing.push({ to: friend.id, status:'pending' });
  friend.incoming.push({ from: req.userId, status:'pending' });
  notify(friend.id, { title: 'Friend request', body: `${me.displayName||me.username} wants to train with you` });
  save(DB);
  res.json({ ok:true });
});
app.post('/api/friends/accept', auth, (req, res) => {
  const { from } = req.body || {};
  const me = DB.users[req.userId]; ensureFriendArrays(me);
  const req2 = me.incoming.find(r=>r.from===from && r.status==='pending');
  if(!req2) return res.status(404).json({ error: 'no such request' });
  req2.status='accepted';
  me.incoming = me.incoming.filter(r=>!(r.from===from));
  const other = DB.users[from]; ensureFriendArrays(other);
  if(!me.friends.includes(from)) me.friends.push(from);
  if(!other.friends.includes(req.userId)) other.friends.push(req.userId);
  other.outgoing = other.outgoing.filter(r=>!(r.to===req.userId));
  save(DB);
  res.json({ friends: me.friends.map(publicUser) });
});
app.post('/api/friends/reject', auth, (req, res) => {
  const { from } = req.body || {};
  const me = DB.users[req.userId]; ensureFriendArrays(me);
  me.incoming = me.incoming.filter(r=>!(r.from===from));
  const other = DB.users[from]; if(other) { ensureFriendArrays(other); other.outgoing = other.outgoing.filter(r=>!(r.to===req.userId)); }
  save(DB);
  res.json({ ok:true });
});
app.get('/api/friends', auth, (req, res) => {
  const me = DB.users[req.userId]; ensureFriendArrays(me);
  res.json({
    friends: me.friends.map(id => ({ ...publicUser(id), streak: currentStreak(id) })),
    incoming: me.incoming.filter(r=>r.status==='pending').map(r=>({ ...publicUser(r.from), reqId:r.from })),
    outgoing: me.outgoing.filter(r=>r.status==='pending').map(r=>({ ...publicUser(r.to), reqId:r.to }))
  });
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
  const t = { id, ownerId: req.userId, name, exercises: exercises.map(e => ({ name: e.name, defaultSets: e.defaultSets || 3, defaultReps: e.defaultReps || 10, defaultRepsMax: Number(e.defaultRepsMax) || undefined })) };
  if (!DB.templates) DB.templates = {};
  DB.templates[id] = t;
  save(DB);
  res.json(t);
});
app.put('/api/templates/:id', auth, (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.ownerId !== req.userId) return res.status(403).json({ error: 'not yours' });
  const { name, exercises } = req.body || {};
  if (name) t.name = name;
  if (Array.isArray(exercises) && exercises.length) t.exercises = exercises.map(e => ({ name: e.name, defaultSets: e.defaultSets || 3, defaultReps: e.defaultReps || 10, defaultRepsMax: Number(e.defaultRepsMax) || undefined }));
  save(DB);
  res.json(t);
});
app.delete('/api/templates/:id', auth, (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.ownerId !== req.userId) return res.status(403).json({ error: 'not yours' });
  delete DB.templates[req.params.id];
  save(DB);
  res.json({ ok: true });
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
    defaultReps: e.defaultReps || 10,
    defaultRepsMax: Number(e.defaultRepsMax) || undefined
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
    invited: invites,
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

// delete a session (creator only)
app.delete('/api/sessions/:id', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'not yours' });
  delete DB.sessions[req.params.id];
  save(DB);
  res.json({ ok: true });
});

// update a session (creator only): name/time/location/note/visibility/exercises/invites
app.put('/api/sessions/:id', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'not yours' });
  const b = req.body || {};
  if (typeof b.name === 'string') s.name = b.name;
  if (b.scheduledAt) s.scheduledAt = b.scheduledAt;
  if (typeof b.location === 'string') s.location = b.location;
  if ('lengthMin' in b) s.lengthMin = b.lengthMin || null;
  if (typeof b.creatorNote === 'string') s.creatorNote = b.creatorNote;
  if (b.visibility) s.visibility = b.visibility === 'friends' ? 'friends' : 'private';
  if (Array.isArray(b.exercises)) {
    s.exercises = b.exercises.map((e, i) => ({
      id: (e.id && s.exercises.find(x => x.id === e.id)) ? e.id : 'e_' + uid(),
      name: e.name, order: i,
      defaultSets: e.defaultSets || 3, defaultReps: e.defaultReps || 10,
      defaultRepsMax: Number(e.defaultRepsMax) || undefined
    }));
  }
  if (Array.isArray(b.inviteUsernames)) {
  const invites = [];
  for (const un of b.inviteUsernames) {
    const f = DB.users[req.userId].friends.find(fid => DB.users[fid].username === un);
    if (f) invites.push(f);
  }
  s.invited = invites;
  }
  s.updatedAt = new Date().toISOString();
  save(DB);
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

app.post('/api/sessions/:id/join/:reqId/reject', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  const jr = s.joinRequests.find(j => j.id === req.params.reqId);
  if (!jr || s.creatorId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  jr.status = 'rejected';
  save(DB);
  notify(jr.userId, { title: 'Join declined', body: `${DB.users[s.creatorId].displayName} declined your join request` });
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
// Weight units are per user. Sets store the number AS TYPED plus the unit it was typed in
// (see the log endpoint), so switching preference never rewrites history — a set logged in kg
// keeps reading in kg. Comparisons convert to a canonical lb.
const LB_PER_KG = 2.2046226218;
function toLb(weight, unit) { return (Number(weight) || 0) * (unit === 'kg' ? LB_PER_KG : 1); }
// A set is stored in the unit it was TYPED in. Everything shown back to the user has to be
// converted into whatever unit they are on now, or switching to kg reprints 185 lb as "185 kg"
// — a 408 lb bench — and one tap writes it into their history.
function inUnit(weight, from, to) {
  const lb = toLb(weight, from);
  return Math.round((to === 'kg' ? lb / LB_PER_KG : lb) * 2) / 2;   // nearest half unit
}
// "the same weight" has to tolerate a unit round-trip: 100 kg is 220.462 lb, and the user who
// typed 220.5 lb last week did not change the weight on the bar.
function sameLoad(a, b) { return Math.abs(toLb(a.weight, a.unit) - toLb(b.weight, b.unit)) < 0.6; }

app.post('/api/me/units', auth, (req, res) => {
  const u = (req.body || {}).units;
  if (u !== 'lb' && u !== 'kg') return res.status(400).json({ error: 'units must be lb or kg' });
  DB.users[req.userId].units = u;
  save(DB);
  res.json({ units: u });
});


// ---- Progression: "add weight next time" -------------------------------------------------
// Rule (Jeff, Aug 17): look at WORKING sets only. Find the heaviest set of the session. If it
// reached the TOP of the prescribed rep range, that session counts as topped out. Two topped-out
// sessions in a row => suggest more weight. If the most recent session did not, it's a hold.
//
// Judged on the heaviest set rather than "all sets at one weight" so it works for straight sets,
// ascending pyramids and single-top-set training alike. Targets come from the set itself
// (snapshotted at log time, v154), never from the session's current plan.

// How much to add. Falls back to body-part defaults; exercises whose real-world step differs
// (machine stacks, fixed dumbbells) can override via `increment` in exercise-library.json.
const INCREMENT_LB = { upper: 5, lower: 10, machine: 20, other: 5 };
const INCREMENT_KG = { upper: 2.5, lower: 5, machine: 10, other: 2.5 };
function incrementFor(name, unit) {
  const lib = EX_LIB.find(x => x.name === name);
  const table = unit === 'kg' ? INCREMENT_KG : INCREMENT_LB;
  if (lib && lib.increment && lib.increment[unit === 'kg' ? 'kg' : 'lb']) {
    return lib.increment[unit === 'kg' ? 'kg' : 'lb'];
  }
  if (!lib) return table.other;
  const eq = (lib.equipment || []).join(' ').toLowerCase();
  if (/machine|leg press|hack squat|smith|pulldown|pec deck|sled/.test(eq) && !/bench press/.test(eq)) return table.machine;
  return lib.pattern === 'legs' ? table.lower : table.upper;
}

// Every session in which this user logged working sets for this exercise, newest first.
function sessionsForUser(userId) {
  const out = [];
  for (const s of Object.values(DB.sessions)) {
    if (!s.logs || !s.logs[userId] || !s.logs[userId].length) continue;
    const byName = {};
    for (const l of s.logs[userId]) {
      if (!isWorkingSet(l)) continue;               // warm-ups and drop sets are not working sets
      const name = exerciseNameFor(s, l.exerciseId, userId);
      (byName[name] = byName[name] || []).push(l);
    }
    for (const name of Object.keys(byName)) {
      const sets = byName[name];
      // the heaviest set of the session decides it; ties broken by reps
      const top = sets.reduce((a, b) =>
        (toLb(b.weight, b.unit) > toLb(a.weight, a.unit) ||
         (toLb(b.weight, b.unit) === toLb(a.weight, a.unit) && (b.reps||0) > (a.reps||0))) ? b : a);
      out.push({ name, when: perfDate(s.scheduledAt), top, sets });
    }
  }
  return out.sort((a, b) => new Date(b.when) - new Date(a.when));
}

function toppedOut(entry) {
  const ceiling = Number(entry.top.targetRepsMax) || Number(entry.top.targetReps);
  if (!ceiling) return false;                        // no target recorded => nothing to judge
  return (Number(entry.top.reps) || 0) >= ceiling;
}

function recommendationsFor(userId) {
  const unit = (DB.users[userId] && DB.users[userId].units) || 'lb';
  const byName = {};
  for (const e of sessionsForUser(userId)) (byName[e.name] = byName[e.name] || []).push(e);
  // A seeded working weight counts as the session BEFORE their first logged one, so someone
  // who told us what they lift gets advice after one real session instead of two. It is only
  // ever the older half of the pair — a seed alone can never trigger a recommendation.
  const seeds = seedsOf(userId);
  // Counted BEFORE the seed goes in, so "how many sessions have I logged" stays a count of real
  // sessions. The log sheet reads this to say what is coming; a seed is not a session.
  const counts = {};
  for (const name of Object.keys(byName)) counts[name] = byName[name].length;
  for (const name of Object.keys(seeds)) {
    const sd = seeds[name];
    if (!byName[name] || !byName[name].length) continue;      // never seed-only
    if (byName[name].length >= 2) continue;                   // real history wins
    byName[name].push({ name, when: '1970-01-01', seeded: true,
      top: { weight: sd.weight, reps: sd.reps, unit: sd.unit,
             targetReps: sd.reps, targetRepsMax: sd.reps } });
  }

  const ready = [], holds = [], soon = [];
  for (const name of Object.keys(byName)) {
    const hist = byName[name];                       // newest first
    if (hist.length < 2) continue;                   // need a previous session to compare against
    const [latest, prev] = hist;
    const lib = EX_LIB.find(x => x.name === name);
    const group = lib && ['push','pull','legs','core','cardio'].includes(lib.pattern) ? lib.pattern : 'other';
    const base = { exercise: name, group, weight: inUnit(latest.top.weight, latest.top.unit, unit), unit,
                   bodyweight: !(Number(latest.top.weight) > 0),
                   reps: Number(latest.top.reps) || 0,
                   targetRepsMax: Number(latest.top.targetRepsMax) || Number(latest.top.targetReps) || null,
                   at: latest.when };
    // Logged before rep targets were stamped (pre-v154): there is nothing to judge the set
    // against, so say nothing rather than render "8 of null reps last time".
    if (!base.targetRepsMax) continue;
    // Double progression is "top of the range TWICE AT THE SAME WEIGHT". Without this check a
    // deload triggered it: miss 225x7, drop to 135x10, and the next 135x10 read as two clean
    // sessions and told someone whose squat is 225 to try 140. Compared in lb so a user who
    // switched units mid-cycle is not told their own weight changed.
    if (toppedOut(latest) && toppedOut(prev) && sameLoad(latest.top, prev.top)) {
      const step = incrementFor(name, unit);
      ready.push(Object.assign({}, base, { suggested: base.weight + step, step }));
    } else if (!toppedOut(latest)) {
      holds.push(base);
    } else {
      // Topped out this session, but the one before either fell short or was a different weight.
      // One more session like this one and it becomes a real suggestion — which is exactly what
      // the log sheet promises, so the promise is now one the rule above actually keeps.
      soon.push(base);
    }
  }
  const order = { legs: 0, push: 1, pull: 2, core: 3, cardio: 4, other: 5 };
  const bySplit = (a, b) => (order[a.group] - order[b.group]) || a.exercise.localeCompare(b.exercise);
  ready.sort(bySplit); holds.sort(bySplit); soon.sort(bySplit);
  return { unit, ready, holds, soon, counts, seeded: seeds };
}

// Weeks of training, most recent last. Counts DISTINCT days with at least one working set,
// not sessions — two workouts in a day is one training day.
function weeksFor(userId, count) {
  const days = new Set();
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine || !mine.some(isWorkingSet)) continue;
    days.add(perfDate(s.scheduledAt).slice(0, 10));
  }
  const today = new Date();
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));   // start of this week
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(monday); start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 7);
    const a = start.toISOString().slice(0, 10), b = end.toISOString().slice(0, 10);
    out.push({ weekOf: a, days: [...days].filter(d => d >= a && d < b).length });
  }
  return out;
}


// ---- Strength trend -----------------------------------------------------------------------
// Estimated max (Epley: w * (1 + reps/30)) converts every set to one comparable number, so a
// heavy triple and a light set of ten sit on the same line. One point per session, taken from
// that session's best working set.
//
// Bodyweight movements are excluded: they store weight 0, so Epley is 0 and the ratio maths
// below would be 0/0. They still appear in Personal Records, ranked by reps (v151).
function estMax(l) {
  const w = toLb(l.weight, l.unit), r = Number(l.reps) || 0;
  return (w > 0 && r > 0) ? w * (1 + r / 30) : 0;
}

function trendFor(userId) {
  const byName = {};
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine) continue;
    const perEx = {};
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const e = estMax(l);
      if (!e) continue;                                  // bodyweight / incomplete
      const name = exerciseNameFor(s, l.exerciseId, userId);
      if (!perEx[name] || e > perEx[name].e) perEx[name] = { e, l };
    }
    for (const name of Object.keys(perEx)) {
      (byName[name] = byName[name] || []).push({
        at: perfDate(s.scheduledAt).slice(0, 10),
        est: Math.round(perEx[name].e),
        weight: Number(perEx[name].l.weight) || 0,
        reps: Number(perEx[name].l.reps) || 0
      });
    }
  }
  const lifts = Object.keys(byName)
    .map(name => ({ name, points: byName[name].sort((a, b) => a.at.localeCompare(b.at)) }))
    .filter(x => x.points.length >= 2)                   // one point is not a trend
    .sort((a, b) => b.points.length - a.points.length);

  // Overall: each lift indexed to ITS OWN starting value, then averaged weighted by how heavy
  // it is. Weighting stops a 15->20 lb lateral raise (+33%) outvoting a 45 lb squat gain, and
  // requiring 2+ points stops a lift trained once diluting the average toward zero.
  const dates = [...new Set(lifts.flatMap(l => l.points.map(p => p.at)))].sort();
  const wsum = lifts.reduce((a, l) => a + l.points[0].est, 0);
  const overall = !lifts.length ? [] : dates.map(d => {
    let acc = 0;
    for (const l of lifts) {
      const upTo = l.points.filter(p => p.at <= d);
      const cur = upTo.length ? upTo[upTo.length - 1].est : l.points[0].est;
      acc += (cur / l.points[0].est) * (l.points[0].est / wsum);
    }
    return { at: d, pct: Number(((acc - 1) * 100).toFixed(1)) };
  });
  return {
    lifts: lifts.map(l => ({
      name: l.name, points: l.points,
      changePct: Number(((l.points[l.points.length-1].est / l.points[0].est - 1) * 100).toFixed(1))
    })),
    overall
  };
}


// ---- Lifts you already do (first-run seeding) ----------------------------------------------
// A user arriving with years of training has bests and goals the app cannot know. Seeding them
// makes Progress useful from workout one instead of week three.
//
// Stored SEPARATELY from earned PRs, never merged into DB.prs. Two reasons:
//  1. A self-reported best that is never beaten would otherwise sit in the record list forever
//     looking like an achievement, and would suppress the first REAL record — killing the
//     moment the feature exists to create.
//  2. A typo (1850 instead of 185) would be unbeatable and permanently poison the list.
// Names must match the exercise library exactly, or a seeded "Bench Press" could never be
// beaten by a logged "Flat Barbell Bench Press" (they group by name — see rebuildAllPrs).
function seedsOf(userId) { return (DB.users[userId] && DB.users[userId].seeded) || {}; }

app.get('/api/me/seeds', auth, (req, res) => res.json({ seeds: seedsOf(req.userId) }));

app.put('/api/me/seeds', auth, (req, res) => {
  // `weight`/`reps` are the user's CURRENT working set, not an all-time best. Jeff's call:
  // a working weight is self-correcting (real logs replace it within a week) whereas a
  // self-reported all-time best is permanent, may be unbeatable, and would block the first
  // real record forever.
  const { exercise, weight, reps, goal } = req.body || {};
  if (!EX_LIB.some(e => e.name === exercise))
    return res.status(400).json({ error: 'Pick an exercise from the library' });
  const u = DB.users[req.userId];
  u.seeded = u.seeded || {};
  const w = Number(weight) || 0, r = Number(reps) || 0, g = Number(goal) || 0;
  if (!w && !g) { delete u.seeded[exercise]; save(DB); return res.json({ seeds: u.seeded }); }
  u.seeded[exercise] = {
    exercise,
    weight: w, reps: r || 1,
    goal: g || null,
    unit: u.units || 'lb',
    at: new Date().toISOString()
  };
  save(DB);
  res.json({ seeds: u.seeded });
});

app.delete('/api/me/seeds/:exercise', auth, (req, res) => {
  const u = DB.users[req.userId];
  if (u.seeded) delete u.seeded[decodeURIComponent(req.params.exercise)];
  save(DB);
  res.json({ seeds: u.seeded || {} });
});

// The record list the UI renders: earned records, plus seeded entries for lifts with none yet.
// An earned record that has passed its seed is flagged so the UI can celebrate it once.
function recordsFor(userId) {
  const earned = (DB.prs && DB.prs[userId]) ? DB.prs[userId] : {};
  const seeds = seedsOf(userId);
  const out = [];
  for (const name of Object.keys(earned)) {
    const e = earned[name], seed = seeds[name];
    out.push(Object.assign({}, e, {
      source: 'earned',
      beatSeed: !!(seed && toLb(e.weight, e.unit) > toLb(seed.weight, seed.unit)),
      seedWeight: seed ? seed.weight : null, seedReps: seed ? seed.reps : null,
      goal: seed && seed.goal ? seed.goal : null
    }));
  }
  for (const name of Object.keys(seeds)) {
    if (earned[name]) continue;                       // a real record supersedes the entry
    out.push(Object.assign({}, seeds[name], { source: 'entered' }));
  }
  return out.sort((a, b) => new Date(b.at) - new Date(a.at));
}


// The recommendation for ONE exercise, for the log sheet. /api/progress computes trends,
// weeks and records too; opening a log sheet should not pay for any of that.
app.get('/api/progress/exercise/:name', auth, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const r = recommendationsFor(req.userId);
  // `sessions` and `seeded` exist so the sheet can say what is COMING when there is nothing to
  // advise yet — otherwise the one feature that tells you what to do next is only ever explained
  // on a tab a new user has no reason to open. Both come out of the pass already done above
  // rather than a second scan of every session in the database.
  res.json({
    unit: r.unit,
    sessions: r.counts[name] || 0,
    // The working weight they entered at setup, in whatever unit they are on now. The sheet
    // names it back to them, because it is the weight the rule is about to be judged against.
    seed: r.seeded[name]
      ? { weight: inUnit(r.seeded[name].weight, r.seeded[name].unit, r.unit), unit: r.unit }
      : null,
    ready: r.ready.find(x => x.exercise === name) || null,
    hold:  r.holds.find(x => x.exercise === name) || null,
    soon:  r.soon.find(x => x.exercise === name) || null
  });
});

app.get('/api/progress', auth, (req, res) => {
  const weeks = Math.min(52, Math.max(4, Number(req.query.weeks) || 13));
  const rec = recommendationsFor(req.userId);
  const w = weeksFor(req.userId, weeks);
  const trained = w.reduce((a, x) => a + x.days, 0);
  let streak = 0;
  for (let i = w.length - 1; i >= 0; i--) { if (w[i].days > 0) streak++; else break; }
  res.json({
    unit: rec.unit,
    ready: rec.ready,
    holds: rec.holds,
    soon: rec.soon,     // one clean session away — the log sheet shows this, so Progress must too
    weeks: w,
    thisWeek: w.length ? w[w.length - 1].days : 0,
    avgPerWeek: w.length ? Number((trained / w.length).toFixed(1)) : 0,
    streakWeeks: streak,
    trend: trendFor(req.userId),
    prs: recordsFor(req.userId)
  });
});

app.post('/api/sessions/:id/log', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s.participants.includes(req.userId) && !s.joinRequests.find(j=>j.userId===req.userId&&j.status==='approved'))
    return res.status(403).json({ error: 'forbidden' });
  const { exerciseId, weight, reps, set, setType } = req.body || {};
  if (!s.logs[req.userId]) s.logs[req.userId] = [];
  const w = Number(weight) || 0, r = Number(reps) || 0;
  // reps are what make a set a set. Storing reps:0 silently turned "225, forgot to type reps"
  // into a zero-rep set, which reads downstream as a failed set.
  if (!(r > 0)) return res.status(400).json({ error: 'Enter the number of reps for this set' });
  const myExLogs = s.logs[req.userId].filter(l => l.exerciseId === exerciseId);
  const setNum = (set && Number(set)) || myExLogs.length + 1;
  const lt = loadTypeForName(exerciseNameFor(s, exerciseId, req.userId));
  const unit = (DB.users[req.userId] && DB.users[req.userId].units) || 'lb';
  // Snapshot the rep target AT LOG TIME. defaultReps/defaultRepsMax live on the session and
  // PUT /api/sessions/:id rewrites them in place, so without this, editing a finished workout
  // would retroactively change whether a set hit its target.
  const exDef = s.exercises.find(x => x.id === exerciseId);
  const rr = exDef ? repRange(exDef) : null;
  const entry = { id: 'log_'+uid(), exerciseId, weight: w, reps: r, set: setNum, setType: setType || 'normal', isPr: false, at: new Date().toISOString() };
  if (lt) entry.loadType = lt;   // omitted entirely for unambiguous lifts (barbell, cable, machine)
  if (unit !== 'lb') entry.unit = unit;   // omitted when lb, so existing data stays byte-identical
  if (rr) { entry.targetReps = rr.lo; if (rr.hi !== rr.lo) entry.targetRepsMax = rr.hi; }
  s.logs[req.userId].push(entry);
  rebuildAllPrs();
  save(DB);
  res.json(s);
});

// v148: PRs are tracked per exercise NAME across a user's entire history, not per exercise-instance-id
// within one workout. (Each workout used to mint a fresh random id for "Bench Press" every time it was
// added, so the old logic could only ever compare a set against sets logged in that same session.)
// This does a full, cheap replay of every log across every session — fine at this app's scale, and it
// means edits/deletes to old sets always leave isPr flags and DB.prs in a provably correct state rather
// than patching a single session in place and hoping nothing upstream drifted.
// What the number in a logged set's `weight` field means for this exercise.
// Stamped onto each set at log time so the meaning of a historical set can never be
// changed retroactively by re-tagging the library (see exercise-library.json loadType).
let _loadByName = null;
function loadTypeForName(name) {
  if (!_loadByName) {                       // built on first use, not at module load, so this
    _loadByName = {};                       // cannot depend on where EX_LIB sits in the file
    for (const e of EX_LIB) if (e.loadType) _loadByName[e.name] = e.loadType;
  }
  return _loadByName[name] || null;
}

// scheduledAt is not consistently typed: some sessions store an ISO string, others an epoch
// number (in seconds OR milliseconds). v138 already had to guard `.slice` on it. Normalise to
// an ISO date string so ordering and displayed dates are correct for every shape.
// Rep targets are a RANGE, not a single number. Programs are written "3 x 8-10", and reps
// naturally drop across sets from fatigue even at a fixed weight — grading against one number
// marks a textbook 10/9/8 session as two misses. defaultReps is the floor (every working set
// should reach it); defaultRepsMax is the ceiling that triggers adding weight. When max is
// absent or equal it behaves exactly as the old single target did.
// A working set is what progression is judged on. Warm-ups are deliberately lighter and drop
// sets are finishers taken past failure at reduced weight — counting either would read as a
// failed set on a session the user actually completed. Confirmed with Jeff, Aug 17.
const WORKING_SET_TYPES = new Set(['normal', 'failure']);
function isWorkingSet(l) { return WORKING_SET_TYPES.has(l.setType || 'normal'); }

function repRange(e) {
  const lo = Number(e && e.defaultReps) || 10;
  const hiRaw = Number(e && e.defaultRepsMax);
  const hi = hiRaw && hiRaw >= lo ? hiRaw : lo;
  return { lo, hi };
}

function perfDate(scheduledAt, fallback) {
  if (scheduledAt == null || scheduledAt === '') return fallback || '1970-01-01T00:00:00.000Z';
  const raw = String(scheduledAt);
  if (/^\d+$/.test(raw)) {                      // pure digits => epoch
    const n = Number(raw);
    const ms = n < 1e12 ? n * 1000 : n;        // < 1e12 means seconds, not milliseconds
    const d = new Date(ms);
    return isNaN(d) ? (fallback || '1970-01-01T00:00:00.000Z') : d.toISOString();
  }
  const d = new Date(raw);
  return isNaN(d) ? (fallback || '1970-01-01T00:00:00.000Z') : d.toISOString();
}

function exerciseNameFor(session, exerciseId, userId) {
  const e = session.exercises.find(x => x.id === exerciseId);
  if (!e) return exerciseId;
  // A swap means the user did a DIFFERENT lift. Logs still carry the original exerciseId,
  // so without this a Barbell Row swapped to Seated Cable Row was filed as a Barbell Row —
  // producing PRs and recommendations for a lift that was never performed, and a cliff in
  // the original lift's trend. /api/sessions/:id/lock already resolves swaps this way when
  // building history, which is why history and PRs disagreed.
  if (userId && session.variations && session.variations[exerciseId]) {
    const v = session.variations[exerciseId][userId];
    if (v && v.swapTo) return v.swapTo;
  }
  return e.name;
}
function migrateLoadTypes() {
  let stamped = 0;
  for (const sess of Object.values(DB.sessions)) {
    if (!sess.logs) continue;
    for (const userId of Object.keys(sess.logs)) {
      for (const l of sess.logs[userId]) {
        if (l.loadType) continue;                       // already stamped — never overwrite
        const lt = loadTypeForName(exerciseNameFor(sess, l.exerciseId, userId));
        if (lt) { l.loadType = lt; stamped++; }
      }
    }
  }
  if (stamped) console.log('migrateLoadTypes: stamped ' + stamped + ' historical sets');
  return stamped;
}

function rebuildAllPrs() {
  const groups = {}; // groups[userId][exerciseName] = [logEntry, ...]
  for (const s of Object.values(DB.sessions)) {
    if (!s.logs) continue;
    for (const userId of Object.keys(s.logs)) {
      for (const l of s.logs[userId]) {
        // legacy entries with no `at`: fall back to the session date. NOT the session id —
        // new Date('s_ab12cd34') is Invalid Date, which made the comparator return NaN and
        // left the sort unstable.
        if (!l.at) l.at = perfDate(s.scheduledAt);
        // non-persisted: the training date, used for ordering only
        Object.defineProperty(l, '_performedAt', {
          value: perfDate(s.scheduledAt, l.at), enumerable: false, configurable: true });
        const name = exerciseNameFor(s, l.exerciseId, userId);
        groups[userId] = groups[userId] || {};
        groups[userId][name] = groups[userId][name] || [];
        groups[userId][name].push(l);
      }
    }
  }
  DB.prs = {};
  for (const userId of Object.keys(groups)) {
    for (const name of Object.keys(groups[userId])) {
      // Order by when the set was PERFORMED. `at` is stamped at log time — enter Monday's
      // workout on Tuesday and it sorted after Tuesday's, so "your most recent" was wrong and
      // PR dates showed the typing day. `performedAt` (the session's scheduledAt, attached in
      // the grouping loop) is the training date; `at` only breaks ties within one session.
      const chronological = groups[userId][name].slice().sort((a, b) => {
        const d = new Date(a._performedAt) - new Date(b._performedAt);
        return d || (new Date(a.at) - new Date(b.at));
      });
      // "Best" = HEAVIEST, with reps only as a tiebreak at equal weight.
      // Was weight*reps (volume), which meant 225x8 (1800) outranked 315x3 (945) — not what
      // a lifter means by a PR, and not what the profile's PR card implies. It also made
      // bodyweight work impossible to rank: a pull-up stores weight 0, so volume was always
      // 0 and never cleared the `val > 0` gate. Comparing (weight, reps) lexicographically
      // ranks bodyweight sets by reps, which is exactly how people compare them.
      let bestW = -1, bestR = -1, bestLog = null;
      for (const l of chronological) {
        // compare in lb regardless of what each set was typed in
        const w = toLb(l.weight, l.unit), r = Number(l.reps) || 0;
        const better = r > 0 && (w > bestW || (w === bestW && r > bestR));
        if (better) { bestW = w; bestR = r; bestLog = l; l.isPr = true; }
        else { l.isPr = false; }
      }
      if (bestLog) {
        DB.prs[userId] = DB.prs[userId] || {};
        DB.prs[userId][name] = { exercise: name, weight: Number(bestLog.weight) || 0,
          reps: Number(bestLog.reps) || 0, at: bestLog._performedAt || bestLog.at };
      }
    }
  }
}

app.put('/api/sessions/:id/log/:logId', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error:'not found' });
  const arr = s.logs[req.userId] || [];
  const log = arr.find(l => l.id === req.params.logId);
  if (!log) return res.status(404).json({ error:'log not found' });
  const { weight, reps, setType, set } = req.body || {};
  if (weight!==undefined) log.weight = Number(weight)||0;
  if (reps!==undefined) log.reps = Number(reps)||0;
  if (setType!==undefined) log.setType = setType || 'normal';
  if (set!==undefined) log.set = Number(set)||log.set;
  rebuildAllPrs();
  save(DB);
  res.json(s);
});

app.delete('/api/sessions/:id/log/:logId', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error:'not found' });
  const arr = s.logs[req.userId] || [];
  const idx = arr.findIndex(l => l.id === req.params.logId);
  if (idx<0) return res.status(404).json({ error:'log not found' });
  arr.splice(idx,1);
  rebuildAllPrs();
  save(DB);
  res.json(s);
});

// lock session (mark done) -> record history for conflict detection
app.post('/api/sessions/:id/lock', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator' });
  // Idempotent: tapping "Log & Finish" twice used to push a SECOND history row for every
  // participant, inflating workout counts, streaks and the weekly activity line.
  if (s.completed) return res.json(s);
  s.completed = true;
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

// Save a post for a locked session (notes + media + visibility)
app.post('/api/sessions/:id/post', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator' });
  const { notes, media, visibility } = req.body || {};
  const vis = ['only_me','friends','public'].includes(visibility) ? visibility : 'only_me';
  // Persist media to disk on the volume (avoids huge/truncated base64 blobs in data.json).
  const cleanMedia = Array.isArray(media) ? media.slice(0, 12).map(m => {
    const type = m.type === 'video' ? 'video' : 'image';
    let src = String(m.src || '');
    const dm = src.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif)|video\/(?:mp4|webm|quicktime));base64,(.+)$/);
    if (dm) {
      try {
        const sub = dm[1];
        const ext = sub.includes('png') ? 'png' : sub.includes('webp') ? 'webp' : sub.includes('gif') ? 'gif'
                  : sub.includes('mp4') ? 'mp4' : sub.includes('webm') ? 'webm' : sub.includes('quicktime') ? 'mov' : 'jpg';
        const fname = `post_${req.params.id}_${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(dm[2], 'base64'));
        src = `/uploads/${fname}`;
      } catch (e) { console.error('MEDIA_WRITE_ERR', e && e.message); src = ''; }
    }
    return { type, src };
  }).filter(m => m.src) : [];
  s.post = {
    by: req.userId,
    at: new Date().toISOString(),
    notes: String(notes || '').slice(0, 2000),
    media: cleanMedia,
    visibility: vis
  };
  save(DB);
  res.json(s);
});

// ---- Boot migrations ----
// These ALL run here, at the end of module evaluation, never at the top of the file. Every one
// of them reads a const declared further down — UPLOAD_DIR, LB_PER_KG, EX_LIB, the loadType
// lookup map — so from the old call site near `load()` they executed inside the temporal dead
// zone and threw before app.listen. The failures were invisible in testing because each is
// conditional: migrateMedia only touches LEGACY base64 photos, and toLb only reads LB_PER_KG
// when a set was typed in KILOGRAMS. One kg set in data.json was enough to stop the server
// booting, permanently, until the file was hand-edited. Add new boot work to this block.
//
// v148: rebuild PR tracking — repairs PRs recorded under the old per-session logic, so
// existing data self-heals on deploy with no manual migration.
// v150: stamp loadType onto sets logged before the field existed, freezing the meaning of a
// historical set at log time so a later library re-tag cannot rewrite it.
// migrateMedia and migrateLoadTypes no-op once the data is in the new shape; rebuildAllPrs is a
// full replay every boot by design, so PRs self-heal whenever the rule behind them changes.
migrateMedia();
rebuildAllPrs();
migrateLoadTypes();
save(DB);

const server = app.listen(PORT, () => console.log('CrewFit on', PORT));
module.exports = { app, server };
