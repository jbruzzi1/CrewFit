const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const LIB_FILE = path.join(__dirname, 'exercise-library.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const PORT = process.env.PORT || 3000;

// ---- VAPID (reuse Daily Routine pattern) ----
// Task #61: this used to live at path.join(__dirname, 'vapid.json') - __dirname is the app
// source directory baked into each deploy's container image, not the persistent /data volume
// (see SECRET_FILE above for the same fix applied to the auth secret). Every `fly deploy` wiped
// it, so a fresh key pair got generated on every deploy, silently invalidating every existing
// push subscription (the mismatched-key send just fails and is swallowed, see notify() below).
// Now on DATA_DIR, it survives deploys like auth-secret.json and data.json already do.
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
// Aug 2026: moved off a single data.json file onto Postgres (see db.js for the full design
// rationale — this is a lift-and-shift: DB keeps the exact same in-memory shape, every route
// handler below is unchanged except for `await`). load()/save() are now thin wrappers around
// db.js, which owns "REFUSING TO START IS THE FEATURE": db.js's connFromEnv() throws loudly if
// DATABASE_URL is unset, and a genuinely unreachable Postgres throws from the first query rather
// than silently substituting an empty database. That's what protects against the exact incident
// this comment used to describe by hand (Aug 17, 2026: a copy of production went from 377 users
// to 0 on one boot, silently, with the server reporting healthy) — a transaction either fully
// commits or fully rolls back, and a SELECT can't return "corrupted," only real rows or a loud
// connection/query error.
const db = require('./db');
const { firstExerciseStartNotification } = require('./notify-helpers');
async function load() { return db.load(); }
async function save(d) { return db.save(d); }

// A snapshot of the database as it was BEFORE this boot's migrations touch it — the same safety
// net data.json's file-copy backup used to provide, now a JSON dump of what load() just returned
// (there is no single file to copy anymore). Restore path: scripts/migrate-to-postgres.mjs
// against the newest one of these, documented in DEPLOY.md.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUPS_KEPT = 10;
async function backupOnBoot() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `data-${stamp}.json`);
    fs.writeFileSync(dest, JSON.stringify(DB, null, 2));
    const kept = fs.readdirSync(BACKUP_DIR).filter(f => /^data-.*\.json$/.test(f)).sort();
    for (const f of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) {}
    }
    console.log(`BACKUP ${dest} (${fs.statSync(dest).size} bytes, keeping ${BACKUPS_KEPT})`);
    return dest;
  } catch (e) {
    // Deliberately not fatal: a failed backup should not take the app down, but it must be loud.
    console.error('BACKUP FAILED — starting anyway:', e.message);
    return null;
  }
}
// One-time migration: old posts stored photos as huge base64 blobs in data.json
// (truncated at 3,000,000 chars -> broken images, and re-uploaded on every Save -> very slow).
// Convert stored base64 to real files on the volume; drop unrecoverable (truncated) ones.
async function migrateMedia() {
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
          const fname = `post_mig_${s.id}_${Date.now()}_${uid()}.${ext}`;
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
  if (sessionsChanged) { await save(DB); console.log(`MIGRATE media: sessions=${sessionsChanged} recovered=${recovered} dropped=${dropped}`); }
}
// Recaps go from ONE per session (s.post, creator-authored) to ONE PER PARTICIPANT (s.posts, keyed
// by userId). Jeff, Aug 19: "I want photos and notes to stay separate for each user" — a training
// partner no longer inherits (or is shut out of) the creator's notes/photos. Must run AFTER
// migrateMedia(), which still expects the legacy s.post.media shape — this converts the (by-then
// on-disk-media) s.post into posts[s.post.by] and retires s.post entirely. Idempotent: a session
// with no s.post, or one already converted, is left alone.
async function migratePosts() {
  let migrated = 0;
  for (const s of Object.values(DB.sessions || {})) {
    if (!s || typeof s !== 'object') continue;
    if (!s.posts || typeof s.posts !== 'object' || Array.isArray(s.posts)) s.posts = {};
    if (s.post && typeof s.post === 'object') {
      const author = s.post.by || s.creatorId;
      if (author && !s.posts[author]) {
        s.posts[author] = {
          at: s.post.at || new Date().toISOString(),
          notes: typeof s.post.notes === 'string' ? s.post.notes : '',
          media: Array.isArray(s.post.media) ? s.post.media : [],
          visibility: ['only_me', 'friends', 'public'].includes(s.post.visibility) ? s.post.visibility : 'only_me',
        };
      }
      delete s.post;
      migrated++;
    }
  }
  if (migrated) { await save(DB); console.log(`MIGRATE posts: sessions=${migrated}`); }
}
// Populated inside the async boot IIFE near the bottom of this file, before app.listen — every
// route handler below only reads DB from inside a closure that runs on a later request, long
// after that IIFE has resolved, so this is safe despite being null here at require-time.
let DB = null;
let server;
// The boot migrations and the PR rebuild used to run HERE and have been moved to the end of
// module evaluation — see the block above app.listen for why.
const EX_LIB = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')).exercises;

// ---- What to aim for on an exercise nobody has configured -----------------------------------
// Every one of the 203 library exercises used to get the same target: 3 sets of 8-10 when added
// from the library, 3 x 10 anywhere else. So the app prescribed ten-rep deadlifts, and it
// prescribed a REP COUNT for planks and treadmill runs, where reps are not the unit at all.
//
// These rules are DERIVED from fields the library already carries — pattern, is_compound,
// equipment, category — so an exercise added next month inherits a sensible target with no list
// to maintain. That constraint is Jeff's and it is the right one: a hand-curated table of 203
// rows goes stale the first time someone edits the library.
//
// The numbers follow ACSM's 2026 position stand on resistance training (Med Sci Sports Exerc,
// April 2026 — 137 studies, 30,000+ participants):
//   strength      >=80% 1RM, 2-3 sets, ~3-6 reps
//   hypertrophy   anywhere from ~8 to 30 reps provided effort is near failure; volume is a
//                 WEEKLY target (>=10 sets per muscle) rather than a per-exercise one
// Hence three sets everywhere — volume comes from how many exercises you pick — and the reps vary
// only where being wrong actually costs something.
//
// They are a starting point, not a prescription: the user edits them, and Progress is built from
// what they actually lifted, never from these.
const TIMED_HOLD = /^(plank|side plank|wall sit|hollow body hold|dead hang|plate pinch|copenhagen plank|weighted plank)$/i;
const CARRY_LIKE = /(carry|sled (push|pull))/i;
const CARDIO_MACHINE = /(treadmill|bike|erg|elliptical|stair|ski|ladder|rope|sled|step mill|rowing machine|shadow boxing)/i;

function defaultTargetFor(nameOrEx) {
  const e = typeof nameOrEx === 'string'
    ? EX_LIB.find(x => String(x.name).toLowerCase() === String(nameOrEx).toLowerCase())
    : nameOrEx;
  if (!e) return { sets: 3, reps: 8, repsMax: 10 };          // custom exercise, no library entry
  const name = String(e.name || '');
  const p = e.pattern, cat = String(e.category || '').toLowerCase(), comp = !!e.is_compound;
  const equip = (e.equipment || []).map(x => String(x).toLowerCase());

  // Reps are the WRONG UNIT for these, not merely a bad number. Until the app can hold a time,
  // it says nothing rather than something false — "Plank 3 x 10" is the kind of wrong that costs
  // you the reader. sets survives so the shape of the workout still reads.
  if (p === 'cardio' && (CARDIO_MACHINE.test(name) || equip.some(x => CARDIO_MACHINE.test(x))))
    return { sets: 3, timed: true };
  if (TIMED_HOLD.test(name) || CARRY_LIKE.test(name)) return { sets: 3, timed: true };

  // a burpee or a kettlebell swing is counted, even though the library files it under cardio
  if (p === 'cardio') return { sets: 3, reps: 12, repsMax: 20 };

  if (comp && equip.some(x => x.includes('barbell'))) {
    // Loaded hinge and squat sit in ACSM's strength band. A set of ten near-maximal deadlifts is
    // where form goes — and that is exactly what the old blanket default prescribed.
    return p === 'legs' ? { sets: 3, reps: 5 } : { sets: 3, reps: 6, repsMax: 8 };
  }
  if (comp) return { sets: 3, reps: 8, repsMax: 12 };
  // small muscles take more reps before they are worth anything, and cheat less for it
  if (p === 'core' || cat === 'shoulders' || cat === 'calves' || cat === 'forearms'
      || /raise|face pull|reverse fly|rear delt/i.test(name))
    return { sets: 3, reps: 12, repsMax: 20 };
  return { sets: 3, reps: 10, repsMax: 15 };
}

// One exercise as it should be stored: whatever the user actually chose wins, and anything they
// left alone is derived. `|| 10` used to sit here, which is how a plank ended up with ten reps.
// v253 (audit finding): assumes `e` is already a plain object -- e.defaultReps etc. throw the
// instant it isn't (null, a string, a number, an array...). Every one of this function's four
// call sites is an `async` route handler; the global app.get/post/put/... wrapper near the top of
// this file already forwards that throw to the error middleware instead of crashing the process
// (confirmed directly: a real POST with exercises:[null] returns a plain 500 and the server keeps
// serving every other request afterward) -- so the actual bug is a confusing, unhandled-looking
// "Something went wrong" 500 for ordinary bad input, not a whole-app outage. Every other malformed-
// input case in this file returns a clean 400; this one didn't, purely because nothing here checked
// the shape before handing it to withDefaults. See isPlainExercise below -- every call site now
// rejects a malformed element with a normal 400 before it ever reaches here.
function withDefaults(e) {
  const name = capStr(e && e.name, 80);             // another user's exercise name renders in your app
  const d = defaultTargetFor(name);
  const reps = numIn(e.defaultReps, 10000) || d.reps;
  const max  = numIn(e.defaultRepsMax, 10000) || d.repsMax;
  return {
    name,
    defaultSets: numIn(e.defaultSets, 100) || d.sets,
    defaultReps: reps || undefined,                 // undefined on a timed exercise, not 10
    defaultRepsMax: (max && max !== reps) ? max : undefined,
  };
}
// Guards withDefaults' assumption above. Deliberately permissive about WHAT the object contains
// (withDefaults already coerces every field inside it) -- this only rejects the shape that throws:
// not an object, null, or an array standing in for one.
function isPlainExercise(e) { return !!e && typeof e === 'object' && !Array.isArray(e); }

// Attach the derived target to a library entry for the client, without mutating EX_LIB.
function withTarget(e) {
  const d = defaultTargetFor(e);
  return Object.assign({}, e, {
    defaultSets: d.sets,
    defaultReps: d.reps,
    defaultRepsMax: d.repsMax,
    timed: !!d.timed,
  });
}

// ---- Accounts ----
// crypto, not Math.random(). Photo URLs and session ids are only private because they are hard to
// guess, and V8's PRNG state is recoverable from a handful of observed outputs — which this app
// hands out freely. Same length and alphabet, so nothing that stores or matches an id notices.
function uid() { return crypto.randomBytes(12).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8); }

// Passwords are stored as a scrypt hash with a per-user salt, never in the clear. They used to
// be kept verbatim, so anyone holding data.json — or one of its backups, or a copy pulled to a
// laptop — held every password in the app. scrypt is deliberately slow, so a stolen file is not
// a password list. Node's own crypto; no dependency.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { pinSalt: salt, pinHash: crypto.scryptSync(String(pin), salt, 64).toString('hex') };
}
function verifyPin(u, pin) {
  if (!u || !u.pinHash || !u.pinSalt) return false;
  const got = crypto.scryptSync(String(pin), u.pinSalt, 64);
  const want = Buffer.from(u.pinHash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);   // constant time
}

// Usernames are matched case-insensitively everywhere. They were compared exactly, so "Brian"
// and "brian" were two different accounts — which actually happened — and logging in with the
// wrong capitalisation just said "bad credentials". The original casing is kept for display.
const normUser = v => String(v == null ? '' : v).trim().toLowerCase();
function findUserByName(username) {
  const k = normUser(username);
  if (!k) return null;
  return Object.values(DB.users).find(u => normUser(u.username) === k) || null;
}
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,20}$/;
const RESERVED_USERNAMES = new Set(['admin','administrator','root','me','you','all','none','null',
  'undefined','crewfit','spotme','support','help','system','api','settings','profile']);
function usernameProblem(username) {
  const raw = String(username == null ? '' : username).trim();
  if (!USERNAME_RE.test(raw)) return 'Username must be 3-20 characters, letters, numbers, . _ or - only';
  if (RESERVED_USERNAMES.has(normUser(raw))) return 'That username is reserved';
  return null;
}
function pinProblem(pin) {
  const p = String(pin == null ? '' : pin);
  if (p.length < 6) return 'Password must be at least 6 characters';
  if (p.length > 64) return 'Password must be 64 characters or fewer';
  return null;
}

// Failed logins are counted per username, in memory. A 4-character password is guessable in
// minutes if nothing slows the guessing down, and nothing did. Cleared on success.
const LOGIN_FAILS = {};
const LOGIN_MAX = 8, LOGIN_LOCK_MS = 10 * 60 * 1000;
function loginLockedFor(key) {
  const f = LOGIN_FAILS[key];
  if (!f || f.count < LOGIN_MAX) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { delete LOGIN_FAILS[key]; return 0; }
  return Math.ceil(left / 1000);
}
function noteLoginFail(key) {
  const f = LOGIN_FAILS[key] || (LOGIN_FAILS[key] = { count: 0, until: 0 });
  f.count++;
  if (f.count >= LOGIN_MAX) f.until = Date.now() + LOGIN_LOCK_MS;
  const ks = Object.keys(LOGIN_FAILS);        // bound the map: sweep expired locks, then evict oldest
  if (ks.length > 10000) {
    const now = Date.now();
    for (const k of ks) { const e = LOGIN_FAILS[k]; if (e.until && now >= e.until) delete LOGIN_FAILS[k]; }
    let over = Object.keys(LOGIN_FAILS).length - 10000;
    if (over > 0) for (const k of Object.keys(LOGIN_FAILS)) { delete LOGIN_FAILS[k]; if (--over <= 0) break; }
  }
}
// Real client IP, as set by Fly's proxy (Fly OVERWRITES any client-supplied value, so it cannot be
// spoofed). null when there is no proxy header — a loopback health check or a local test — which we
// do not rate-limit. Fly is the only ingress in production, so a null IP never reaches here from a
// real external client, and the caps below apply to everyone who is actually on the internet.
const clientIp = req => {
  const h = req.headers['fly-client-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return h ? h.slice(0, 64) : null;
};
// A tiny in-memory fixed-window limiter (single machine — fine at this scale). BOUNDED on purpose:
// the per-username LOGIN_FAILS map grew one entry per distinct name tried, so a flood of made-up
// names was itself a memory-exhaustion vector. Here expired entries are swept and the map is hard-
// capped, evicting the oldest, so a flood of spoofed keys can never grow it without limit.
const RL = new Map();
const RL_MAX = 50000;
function overLimit(key, max, windowMs) {
  const now = Date.now();
  let e = RL.get(key);
  if (!e || now >= e.reset) { RL.delete(key); e = { count: 0, reset: now + windowMs }; RL.set(key, e); }
  e.count++;
  if (RL.size > RL_MAX) {
    for (const [k, v] of RL) if (now >= v.reset) RL.delete(k);
    while (RL.size > RL_MAX) RL.delete(RL.keys().next().value);
  }
  return e.count > max;
}
// Read/'increment'/clear a counter in the same bounded RL map, for a rolling per-window count where
// we act on the count ourselves (the per-account failed-login ceiling) rather than a fixed cap.
function failCount(key) { const e = RL.get(key); return (e && Date.now() < e.reset) ? e.count : 0; }
function bumpFail(key, windowMs) { overLimit(key, Infinity, windowMs); }   // increment within window; bounded; never self-trips
function clearFail(key) { RL.delete(key); }

const app = express();
module.exports = { app, server: undefined };  // .server is filled in once the async boot IIFE below resolves
// Aug 2026: persistence moved onto Postgres (see db.js), so every route handler that calls
// save(DB) is now async. Express 4 does not catch a rejected promise returned from a route
// handler on its own — an unhandled rejection there would leave the request hanging forever
// (no response ever sent) and, on modern Node, can terminate the whole process on an unrelated
// request's failure. Wrapping app.get/post/put/delete/patch ONCE here, rather than touching
// every individual route registration, means every handler (sync or async) automatically
// forwards a thrown/rejected error to Express's error-handling middleware below — no per-route
// boilerplate, and no route can be added later that accidentally skips this safety net.
for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
  const orig = app[method].bind(app);
  app[method] = (routePath, ...handlers) => orig(routePath, ...handlers.map(h =>
    (typeof h === 'function' && h.length <= 3)
      ? (req, res, next) => { try { Promise.resolve(h(req, res, next)).catch(next); } catch (e) { next(e); } }
      : h
  ));
}
// 60mb let one request carry more than a phone ever sends, on a 1 GB volume shared by the
// database, its ten backups and every photo. 30 leaves headroom over the 25 MB we accept.
// Only the two routes carrying a base64 image/video need a large body; everything else is small
// JSON. A 30 mb limit applied to EVERY route on a 256 mb box was a needless OOM surface — a few
// concurrent large posts to any endpoint could exhaust RAM. Route the big parser only where media
// legitimately flows; cap everything else at 1 mb (far above any real non-media payload).
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '30mb' });
const BIG_BODY = [/^\/api\/sessions\/[^/]+\/post$/, /^\/api\/me\/avatar$/];
app.use((req, res, next) =>
  (req.method === 'POST' && BIG_BODY.some(re => re.test(req.path)) ? jsonLarge : jsonSmall)(req, res, next));
// The app offered 4 photos; the server took 12, at any size, with no check at all.
const MEDIA_MAX_ITEMS = 4;
const MEDIA_MAX_PHOTO = 8 * 1024 * 1024;    // a normal iPhone photo is 2-5 MB
const MEDIA_MAX_VIDEO = 25 * 1024 * 1024;   // roughly 15-20 seconds at iPhone quality
const MEDIA_MAX_TOTAL = 25 * 1024 * 1024;
const ALLOWED_MEDIA = /^data:(image\/(?:png|jpeg|jpg|webp|gif)|video\/(?:mp4|webm|quicktime));base64,(.+)$/;

// Input caps. Every write below persists into ONE data.json that save() rewrites whole on every
// request, so an uncapped field is a way to bloat that file past the box's RAM and wedge all writes
// permanently. capStr also coerces — a non-string reaching .trim()/.slice() would 500 the route.
// numIn blocks NaN and Infinity (Infinity serialises to null and became a permanent all-time PR)
// and clamps to a sane, non-negative magnitude.
const capStr = (v, max) => String(v == null ? '' : v).slice(0, max);
const numIn = (v, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(0, n), max) : 0; };
const b64Bytes = b64 => Math.floor(String(b64 || '').length * 3 / 4);
const mb = n => (n / 1048576).toFixed(1) + ' MB';
app.use(express.static(path.join(__dirname, 'public')));
// User-uploaded avatars live in the persistent volume so they survive redeploys.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// Logins are SIGNED, not remembered. They used to be a random string held in a plain object in
// memory, so every restart forgot every login — and this app deploys several times a day, which
// meant being thrown to the login screen mid-workout, losing the set being typed. A signed token
// carries who you are and when it was issued, checked against a secret; nothing is stored, so
// there is nothing to forget, nothing to grow, and nothing to corrupt.
const TOKEN_TTL_DAYS = 90;
const SECRET_FILE = path.join(DATA_DIR, 'auth-secret.json');
let AUTH_SECRET = null;
// Kept on the volume beside the data, never in the repo. Losing it logs everyone out once and
// costs nothing else; rotating it deliberately is how you sign everybody out on purpose.
function loadOrCreateSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const v = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
      if (v && typeof v.secret === 'string' && v.secret.length >= 32) return (AUTH_SECRET = v.secret);
    }
  } catch (e) { console.error('auth secret unreadable, generating a new one:', e.message); }
  AUTH_SECRET = crypto.randomBytes(48).toString('hex');
  const tmp = SECRET_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ secret: AUTH_SECRET, at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, SECRET_FILE);
  console.log('auth: generated a new signing secret — everyone signs in once more');
  return AUTH_SECRET;
}
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function signToken(userId) {
  const body = b64u(JSON.stringify({ u: userId, t: Date.now() }));
  const sig = b64u(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
  return body + '.' + sig;
}
function userIdFromToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = b64u(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;   // constant time
  let payload;
  try { payload = JSON.parse(Buffer.from(body.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || !payload.u || !payload.t) return null;
  if (Date.now() - payload.t > TOKEN_TTL_DAYS * 864e5) return null;          // expired
  const u = DB.users[payload.u];
  if (!u) return null;
  // lets a single account be signed out everywhere, e.g. after a password change
  if (u.tokensValidFrom && payload.t < Date.parse(u.tokensValidFrom)) return null;
  return payload.u;
}

function auth(req, res, next) {
  const t = req.headers['authorization'] || '';
  const userId = userIdFromToken(t.replace(/^Bearer\s/, ''));
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  req.userId = userId;
  next();
}

// The deploy pipeline gates on this, so it has to assert something. A constant `{ok:true}` would
// have passed over a wiped database. Counts are aggregate only — no names, no PINs.
app.get('/healthz', async (req, res) => {
  if (!DB || typeof DB.users !== 'object' || typeof DB.sessions !== 'object')
    return res.status(503).json({ ok: false, error: 'database not loaded' });
  res.json({ ok: true, users: Object.keys(DB.users).length, sessions: Object.keys(DB.sessions).length });
});
app.get('/api/vapid', (req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/register', async (req, res) => {
  const ip = clientIp(req);
  if (ip && overLimit('reg:' + ip, 20, 60 * 60 * 1000))
    return res.status(429).json({ error: 'Too many sign-ups from here. Please try again later.' });
  const { username, pin, displayName } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'username + pin required' });
  const uProblem = usernameProblem(username); if (uProblem) return res.status(400).json({ error: uProblem });
  const pProblem = pinProblem(pin);           if (pProblem) return res.status(400).json({ error: pProblem });
  if (findUserByName(username)) return res.status(409).json({ error: 'username taken' });
  const id = uid();
  DB.users[id] = Object.assign({ id, username: String(username).trim(),
    displayName: capStr(displayName || username, 80).trim(), units: 'lb',
    // Jeff, Sep 2026: profiles default Public -- discoverable out of the box, same as the app's
    // general "discoverability beats minimalism" stance. Private is an opt-in you reach through
    // Settings. followers/following/followReqs are created lazily by ensureFollowArrays on first
    // use, same as ever; there is no separate "friends" concept to seed any more (see canSeeProfile).
    profileVisibility: 'public',
    createdAt: new Date().toISOString() }, hashPin(pin));
  await save(DB);
  res.json({ token: signToken(id), user: { ...publicUser(id), defaultGym: '', profileVisibility: 'public' } });
});
// Live username availability check (used by the register popup as the user types)
app.get('/api/register/check', async (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username) return res.json({ available: false });
  if (usernameProblem(username)) return res.json({ available: false });
  res.json({ available: !findUserByName(username) });
});

app.post('/api/login', async (req, res) => {
  const { username, pin } = req.body || {};
  const ip = clientIp(req);
  if (ip && overLimit('login:' + ip, 60, 60 * 1000))
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' });
  const uname = normUser(username);
  // Two ceilings, because neither alone is enough for a 4-char PIN:
  //   per (IP, account) 8 / 10 min — stops one IP brute-forcing an account, and being per-IP it
  //     CANNOT lock the real user out. The old lock was per username alone: 8 wrong guesses from
  //     anywhere froze the real user for 10 minutes (a trivial griefing vector).
  //   per account across ALL IPs 40 / hour — the per-IP lock gives no aggregate cap, so a proxy pool
  //     could still grind a PIN; this bounds that. It counts failures only (a normal login never
  //     trips it), and reaching it costs ~5 IPs since each is capped at 8 — far dearer to grief than
  //     the old single-IP lock, while restoring a real distributed-brute-force ceiling.
  const ipKey = (ip || 'local') + '|' + uname;
  const ipLock = loginLockedFor(ipKey);
  if (ipLock) return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(ipLock/60)} minute(s).` });
  if (failCount('acct:' + uname) >= 40)
    return res.status(429).json({ error: 'This account is temporarily locked after too many failed attempts. Try again later.' });
  const u = findUserByName(username);
  if (!u || !verifyPin(u, pin)) {
    noteLoginFail(ipKey);
    bumpFail('acct:' + uname, 60 * 60 * 1000);
    return res.status(401).json({ error: 'bad credentials' });
  }
  delete LOGIN_FAILS[ipKey];
  clearFail('acct:' + uname);
  // publicUser() deliberately omits defaultGym and profileVisibility — both are used everywhere
  // ELSE to describe someone else (friends list, follow requests), and both are private. This
  // response describes the account that just authenticated, so it's the one safe place to add
  // them directly: without it, an in-app login (no full page reload, so tryBoot()'s own
  // /api/profile/me fetch never runs) would leave ME.profileVisibility stale/undefined and the
  // Settings toggle could show the wrong state for an account whose real value differs.
  // Public is the default (unset counts as public, same rule as canSeeProfile) -- only an
  // explicit 'private' narrows it.
  res.json({ token: signToken(u.id), user: { ...publicUser(u.id), defaultGym: u.defaultGym || '', profileVisibility: u.profileVisibility === 'private' ? 'private' : 'public' } });
});

// ---- Password reset: DISABLED, deliberately ----
// These two shipped as a v1 placeholder and were a full account takeover for anyone on the
// internet. /api/reset took a username and a new password and set it — no token, no login, no
// proof of anything. /api/forgot then confirmed whether a username existed AND returned the
// person's real name, so accounts could be discovered rather than guessed, and usernames are on
// display in the app ("with @Brian +2").
//
// There is no email or phone in this system, so there is nothing to send a reset link to and no
// honest way to prove identity. A reset flow that cannot verify who is asking is worse than no
// reset flow, so both are off until there is a channel to verify through. Recovery today is
// manual: Jeff edits the account.
//
// DO NOT re-enable these by restoring the old bodies. Whatever replaces them must prove the
// requester controls the account before it changes a password.
const RESET_DISABLED = {
  error: 'Password reset is unavailable. Ask Jeff to reset it for you.'
};
app.post('/api/forgot', (req, res) => res.status(503).json(RESET_DISABLED));
app.post('/api/reset',  (req, res) => res.status(503).json(RESET_DISABLED));

function publicUser(id) {
  const u = DB.users[id];
  return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio || '', avatar: u.avatar || '', followers: (u.followers || []).length, following: (u.following || []).length, units: u.units || 'lb' };
}

// ---- Exercise library (136 base + user-created) ----
app.get('/api/exercises', async (req, res) => {
  // ownerId is stripped: this route needs no login, and it was handing out a real user id beside
  // every custom exercise name to anyone who asked.
  const custom = Object.values(DB.customExercises || {}).flat().map(({ ownerId, ...rest }) => sanitizeExercise(rest));
  // computed per request, never at boot — 203 entries is nothing, and startup work in this file
  // has crashed the server three times
  res.json(EX_LIB.concat(custom).map(withTarget));
});
// Custom exercises written before the POST route validated anything are still in the database, and
// nothing migrates them — so the write-side checks protect new rows only. This is the read side:
// every row is normalised on the way OUT, which is the one place that covers rows already stored.
//
// It is not defence in depth for its own sake. Two live faults, both verified:
//   - a non-array `equipment` threw inside defaultTargetFor's .map, so this whole route 500'd and
//     NOBODY could load the exercise library until the row was removed by hand;
//   - a non-array `muscle_groups` threw inside the client's .forEach, killing the Workouts tab.
// And filtering groups to the known vocabulary here retires the stored-XSS risk at its source
// rather than only at the sink that renders it.
function sanitizeExercise(e) {
  const strs = (v, cap, max) => (Array.isArray(v) ? v : [])
    .filter(x => typeof x === 'string').map(x => x.slice(0, cap)).slice(0, max);
  const KNOWN_MG = sanitizeExercise._mg || (sanitizeExercise._mg =
    new Set(EX_LIB.flatMap(x => x.muscle_groups || [])));
  const mg = strs(e.muscle_groups, 40, 8).filter(m => KNOWN_MG.has(m));
  return Object.assign({}, e, {
    name: String(e.name == null ? '' : e.name).slice(0, 80),
    // No fake bucket for a row whose groups were ALL junk: 'other' is not a muscle the app has a
    // list for, so parking it there would look like a fix while changing nothing. It named no real
    // muscle, so it appears under no muscle — which is the truth about it.
    muscle_groups: mg,
    equipment: strs(e.equipment, 40, 8),
    level: typeof e.level === 'string' ? e.level.slice(0, 20) : 'beginner',
    pattern: typeof e.pattern === 'string' ? e.pattern.slice(0, 40) : 'other',
    category: typeof e.category === 'string' ? e.category.slice(0, 40) : (mg[0] || 'other'),  // category is a label, not a list
    is_compound: !!e.is_compound,
  });
}
app.post('/api/exercises/custom', auth, async (req, res) => {
  const { name, muscle_groups, equipment, level, is_compound, pattern } = req.body || {};
  if (!name || !Array.isArray(muscle_groups) || !muscle_groups.length) return res.status(400).json({ error: 'name + muscle_groups required' });
  // A custom exercise is shown to every other user, so treat these as hostile. Muscle groups are
  // a closed vocabulary — there is no reason to accept anything outside it.
  const KNOWN_MG = new Set(EX_LIB.flatMap(x => x.muscle_groups || []));
  const mg = muscle_groups.filter(m => typeof m === 'string' && KNOWN_MG.has(m));
  if (!mg.length) return res.status(400).json({ error: 'muscle_groups must be from the library' });
  // Equipment is read back with .toLowerCase() on the client, so a single non-string here threw on
  // every render of that muscle group — for every user, permanently, from one bad POST.
  const equip = (Array.isArray(equipment) ? equipment : [])
    .filter(x => typeof x === 'string').map(x => x.slice(0, 40)).slice(0, 8);
  const ex = {
    name: capStr(name, 80),
    pattern: capStr(pattern, 40) || (mg[0] || 'other'),
    category: mg[0] || 'other',                         // a validated group, never raw req.body
    muscle_groups: mg,
    equipment: equip,
    is_compound: !!is_compound,
    level: capStr(level, 20) || 'beginner',
    defaultSets: 3, defaultReps: 10,
    custom: true, ownerId: req.userId
  };
  DB.customExercises[req.userId] = DB.customExercises[req.userId] || [];
  // Every custom exercise persists into the one data.json AND is served to every user, so an
  // unbounded push is a slow wedge. 500 is far past any real athlete's own library (the built-in
  // one is 203).
  if (DB.customExercises[req.userId].length >= 500)
    return res.status(400).json({ error: 'You have reached the limit of custom exercises.' });
  DB.customExercises[req.userId].push(ex);
  await save(DB);
  res.json(ex);
});

// ---- Favorite exercises (per-user) ----
// Jeff, Sep 1: "add a filter in the exercise library for favorites... allowing you to favorite
// when building a workout or in the library also." Exercises have no id (see sanitizeExercise
// above -- everything, custom exercises included, keys off name), so favorites are a list of
// exercise NAMES, the same identity the client already uses everywhere (DRAFT.exercises.find
// (x=>x.name===e.name), libToggle, swapPick, ...).
// No cap here, unlike POST /api/exercises/custom just above: that route creates new rows shared
// with every other user, so an unbounded push there is a slow wedge on everyone. Favoriting only
// ever references an exercise that already exists and is private to the one user who set it, so
// the list is naturally bounded by the total exercise count (203 built-in + that user's own
// custom rows, themselves already capped at 500) -- there's nothing here worth defending against.
app.get('/api/favorites', auth, async (req, res) => {
  const u = DB.users[req.userId];
  res.json({ exercises: (u && u.favoriteExercises) || [] });
});
// One toggle endpoint, not separate add/remove routes -- the one caller (toggleFavorite() in
// app.js) always wants "flip it and tell me the new state," same shape as the star it's driving.
app.post('/api/favorites/toggle', auth, async (req, res) => {
  const name = capStr((req.body || {}).name, 80);
  if (!name) return res.status(400).json({ error: 'name required' });
  const u = DB.users[req.userId];
  u.favoriteExercises = u.favoriteExercises || [];
  const i = u.favoriteExercises.indexOf(name);
  const favorited = i === -1;
  if (favorited) u.favoriteExercises.push(name);
  else u.favoriteExercises.splice(i, 1);
  await save(DB);
  res.json({ favorited });
});

// v190 (profile-privacy unification, Sep 2026): the ONE rule for "can this viewer see {id}'s
// gated stuff" -- profile detail (PRs/streak/activity), a 'public' post, and session joinability
// all resolve through this now, instead of independently-written copies that drift apart (see the
// history below: a second copy of this exact check, keyed on the wrong person, once leaked a
// friends-only recap through a profile page while the session route correctly refused it).
// Public (default, unset counts as public) = anyone. Private is opt-in via Settings = only
// approved followers, and you.
function canSeeProfile(id, viewerId) {
  if (id === viewerId) return true;
  const u = DB.users[id];
  if (!u) return false;
  if (u.profileVisibility !== 'private') return true;
  return (u.followers || []).includes(viewerId);
}
// ---- Profile (per-user, viewable by anyone logged in) ----
// localToday: the CALLER's own local day (see the comment above currentStreak) — only honored
// below when id === viewerId, i.e. this is genuinely a self-view. Whoever is viewing someone
// ELSE's profile has no way to know that person's timezone, so a friend's streak still falls back
// to the server's UTC approximation, same as it always has.
function profileOf(id, viewerId, localToday) {
  const u = DB.users[id];
  if (!u) return null;
  const selfToday = id === viewerId ? localToday : undefined;
  // workouts completed: distinct sessions with a history entry by this user,
  // OR sessions this user posted (saved) — both count as a completed workout
  const completed = new Set();
  for (const s of Object.values(DB.sessions)) {
    if ((s.history || []).some(h => h.userId === id)) completed.add(s.id);
    else if (s.posts && s.posts[id]) completed.add(s.id);
  }
  const prs = (DB.prs && DB.prs[id]) ? Object.values(DB.prs[id]) : [];
  // v190: gated on canSeeProfile now -- a Public profile admits anyone; a Private one, only you and
  // approved followers, same as before.
  const isApproved = canSeeProfile(id, viewerId);
  // Delegates to the one shared rule instead of keeping its own copy — a second, independently
  // written copy of this check used to be keyed on whose profile you are looking at instead of who
  // WROTE the post, so a friend of a participant was handed the creator's friends-only notes and
  // photo URLs on a profile, while the session route correctly refused them. `id` is the profile
  // owner, so this is always specifically THEIR own recap on session `s` — never a partner's.
  const canSeeMyPost = (s) => canSeePostAuthor(s.posts && s.posts[id], id, viewerId, s);
  // A profile listed EVERY workout the person had done, including private ones, to any logged-in
  // stranger: the name, the date, the first three exercises, and the usernames of everyone
  // participating OR still holding an unanswered invitation. sessionView goes to the trouble of
  // withholding the invite list from non-invitees; this route handed the same names to anybody.
  //
  // A workout appears on a profile only if the viewer could legitimately reach it: their own, a
  // post whose own visibility admits them, or a workout they were actually part of. `isApproved`
  // is deliberately NOT a shortcut here — it only unlocks the prs/streak/recentActivity block
  // below. A session posted 'private' means "only the creator or who was part of it" (Jeff's own
  // words) regardless of whether its owner's PROFILE happens to be approved/Public for this
  // viewer; profile approval is a different question from session-level privacy, and conflating
  // them used to mean a session marked Private still broadcast its name/date/exercise list to
  // anyone who could see the owner's profile at all — trivially everyone, once profiles default
  // to Public (Sep 2026 audit finding).
  const viewerCanSee = s => {
    if (id === viewerId) return true;
    if (canSeeMyPost(s)) return true;
    const t = sessionTier(s, viewerId);
    return t === 'member' || t === 'invited';
  };
  const myWorkouts = Object.values(DB.sessions)
    .filter(s => (s.posts && s.posts[id]) || (s.history || []).some(h => h.userId === id))
    .filter(viewerCanSee)
    .sort((a,b)=> new Date(b.scheduledAt||0) - new Date(a.scheduledAt||0))
    .map(s => {
      const post = canSeeMyPost(s) ? s.posts[id] : null;
      // collaborators = other participants (and invited) who aren't the profile owner
      // who ELSE was there — participants only. Someone still holding an unanswered invitation has
      // not agreed to be listed anywhere, and "invited" is not a fact about the workout, it is a
      // fact about them.
      const inIt = (id === viewerId) || ['member', 'invited'].includes(sessionTier(s, viewerId));
      const others = inIt ? new Set((s.participants||[]).filter(x=>x && x!==id)) : new Set();
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
          at: post.at,
          // Jeff, Sep 1: "how do we show comments/likes BEFORE clicking into the workout" -- these
          // two counts are the whole answer. reactions/comments already sit on `post` server-side by
          // the time we're here; we're only exposing their lengths, never the arrays themselves (the
          // full comment text/authors stay behind the existing per-comment endpoint + its own
          // canSeePostAuthor visibility check -- a count is not the content).
          reactionCount: Array.isArray(post.reactions) ? post.reactions.length : 0,
          commentCount: Array.isArray(post.comments) ? post.comments.length : 0
        } : null
      };
    });
  // Your training is for you and the people you train with. A logged-in stranger who happens to
  // know your id got the whole record: every lift, every best, and what you did last week. The
  // headline counts stay — a profile has to be worth opening — but the detail is for people
  // you've approved as a follower (or yourself).
  return {
    ...publicUser(id),
    units: (DB.users[id] && DB.users[id].units) || 'lb',
    // Self only — where you train is not a public fact about your account, and nobody else's
    // profile view needs it (it only ever prefills YOUR OWN new-workout form).
    defaultGym: id === viewerId ? (u.defaultGym || '') : undefined,
    // Self only, same reasoning as defaultGym above. Unset reads as true — see the notify-prefs
    // route comment for why "on by default" is safe here.
    notifyStreakReminders: id === viewerId ? (u.notifyStreakReminders !== false) : undefined,
    notifyWorkoutReminders: id === viewerId ? (u.notifyWorkoutReminders !== false) : undefined,
    // Self only — the OTHER profile's own visibility isn't a thing a viewer needs (canSeeProfile
    // already decided whether they can see the gated stuff below); the Settings screen's own
    // Private/Public toggle is the only reader of this. Public unless explicitly set to
    // 'private', same rule as canSeeProfile.
    profileVisibility: id === viewerId ? (u.profileVisibility === 'private' ? 'private' : 'public') : undefined,
    workoutsCompleted: completed.size,
    // the follow button's state, and whether they follow you back
    youFollow: id === viewerId ? 'self'
      : ((u.followers || []).includes(viewerId) ? 'following'
      : ((u.followReqs || []).includes(viewerId) ? 'requested' : 'none')),
    followsYou: !!(viewerId && id !== viewerId && (DB.users[viewerId].followers || []).includes(id)),
    myWorkouts,
    // Below the line — approved followers (and you) only. The workout count and follower/following
    // counts from publicUser above stay public.
    prCount: isApproved ? prs.length : null,
    prs: isApproved ? prs.slice().sort((a,b)=> new Date(b.at) - new Date(a.at)) : [],
    streak: isApproved ? currentStreak(id, selfToday) : null,
    recentActivity: isApproved ? buildActivityFor(id, selfToday) : [],
    limited: !isApproved        // so the profile can say why it is thin rather than look empty
  };
}
// One line per PR is right most days — but a single big workout can set five PRs at once, and
// that used to mean five separate rows in both "Recent Activity" (profile) and "Friend's
// Activity" (home) for one session. Jeff, Aug 21: "if I have 10 friends and they are all new,
// that list is going to get quite heavy" — even with firstLog baselines excluded (see
// rebuildAllPrs), a genuinely improving lifter can beat several of their own bests within the
// same week, not just the same day. This groups ALL of a person's REAL PRs (never a firstLog —
// there is nothing to "beat" the first time) from the last 7 days into ONE line, naming up to 3
// lifts and summarizing the rest ("hit 4 new PRs this week (Squat, Bench, Deadlift and +1
// more)"), the same way "completed N workouts" already collapses instead of listing every
// workout separately. Also enforces the last-7-days window here in one place — a PR from three
// weeks ago showing up forever was the other half of "growing longer than I hoped for".
function groupPrsForFeed(prs, weekAgo) {
  const recent = prs.filter(p => !p.firstLog && new Date(p.at).getTime() >= weekAgo);
  if (!recent.length) return [];
  if (recent.length === 1) {
    const p = recent[0];
    // v250 (audit finding): this printed the raw weight number with no unit -- the same ambiguity
    // v248 fixed for the profile PR list (prLabel/unitOf in app.js), just never ported to this
    // feed text. A kg PR read as an unlabeled number here, genuinely ambiguous with lb and, if
    // misread, off by more than 2x. Matches prLabel's own formatting, including the bodyweight
    // case (weight 0 -- a pull-up-style PR -- has no meaningful unit, so it reads as plain reps).
    const w = Number(p.weight) || 0;
    const weightPart = w === 0 ? `${p.reps} reps` : `${w} ${p.unit || 'lb'} × ${p.reps}`;
    return [{ type: 'pr', at: p.at, text: `hit a new PR on ${p.exercise} (${weightPart})` }];
  }
  const at = recent.map(p => p.at).sort().slice(-1)[0];   // latest timestamp in the group, for feed ordering
  const names = recent.map(p => p.exercise);
  const shown = names.slice(0, 3);
  const label = names.length > 3
    ? `${shown.join(', ')} and +${names.length - 3} more`
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return [{ type: 'pr', at, text: `hit ${recent.length} new PRs this week (${label})` }];
}
// Recent activity for a single user: PRs, weekly completions, streaks (most recent first)
// localToday: only ever pass this when userId is the caller themselves (see the comment above
// currentStreak) — profileOf only forwards it on a self-view, never a friend's.
function buildActivityFor(userId, localToday) {
  const items = [];
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const prs = (DB.prs && DB.prs[userId]) ? Object.values(DB.prs[userId]) : [];
  items.push(...groupPrsForFeed(prs, weekAgo));
  let count = 0, latest = 0;
  for (const s of Object.values(DB.sessions)) {
    for (const h of (s.history || [])) {
      if (h.userId === userId) { const t = new Date(h.date).getTime(); if (t >= weekAgo) { count++; if (t > latest) latest = t; } }
    }
  }
  // v247: both rows below used to stamp new Date().toISOString() — "right now", the moment the
  // feed happens to be requested — instead of a real timestamp, so they permanently sorted above
  // every actually-timestamped recap/PR row every time the feed was opened (same bug class v239
  // already fixed for the friends-feed 'completed' row below). `latest` is the real date of the
  // most recent contributing workout; a streak of 2+ always requires a session dated today or
  // yesterday (see currentStreak), which is always inside this 7-day window, so `latest` already
  // reflects it correctly without a second history scan.
  if (count > 0) items.push({ type: 'completed', at: new Date(latest).toISOString(), text: `completed ${count} workout${count > 1 ? 's' : ''} this week` });
  const streak = currentStreak(userId, localToday);
  if (streak >= 2) items.push({ type: 'streak', at: new Date(latest).toISOString(), text: `hit a ${streak} day workout streak` });
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  return items;
}

app.get('/api/profile/me', auth, (req, res) => res.json(profileOf(req.userId, req.userId, req.query.localToday)));
// A friend's profile also accepts localToday for forward-compatibility, but profileOf only ever
// actually uses it when id===viewerId — passing your own local day while looking at someone
// else's profile does nothing, on purpose (see the comment above profileOf).
app.get('/api/profile/:id', auth, async (req, res) => {
  const p = profileOf(req.params.id, req.userId, req.query.localToday);
  if (!p) return res.status(404).json({ error: 'user not found' });
  res.json(p);
});
// The counts on a profile (Following/Followers) have always been public — see publicUser above —
// but who is actually IN those lists is the same private detail as their workouts/PRs/streak, so it
// gates on the identical rule (profileOf's isApproved: you, or someone this account has approved to
// follow them). Jeff, Aug 26: "click on the number of followers or following and it show me who."
function followListFor(id, viewerId, kind) {
  const u = DB.users[id];
  if (!u) return null;
  ensureFollowArrays(u);
  if (!canSeeProfile(id, viewerId)) return { error: 'forbidden' };
  return (u[kind] || []).filter(fid => DB.users[fid]).map(fid => publicUser(fid));
}
app.get('/api/profile/:id/followers', auth, async (req, res) => {
  const list = followListFor(req.params.id, req.userId, 'followers');
  if (!list) return res.status(404).json({ error: 'user not found' });
  if (list.error) return res.status(403).json(list);
  res.json(list);
});
app.get('/api/profile/:id/following', auth, async (req, res) => {
  const list = followListFor(req.params.id, req.userId, 'following');
  if (!list) return res.status(404).json({ error: 'user not found' });
  if (list.error) return res.status(403).json(list);
  res.json(list);
});
app.post('/api/me/avatar', auth, async (req, res) => {
  const { data, type } = req.body || {};
  if (!data || !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(data)) return res.status(400).json({ error: 'image data required' });
  const ext = (type === 'image/png' ? 'png' : 'jpg');
  const b64 = data.split(',')[1];
  if (b64Bytes(b64) > MEDIA_MAX_PHOTO) return res.status(413).json({ error: `That image is too large (limit ${mb(MEDIA_MAX_PHOTO)}).` });
  const fname = `avatar_${req.userId}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(b64, 'base64'));
  const u = DB.users[req.userId];
  u.avatar = `/uploads/${fname}`;
  await save(DB);
  res.json({ avatar: u.avatar });
});
app.post('/api/me/bio', auth, async (req, res) => {
  const { bio } = req.body || {};
  DB.users[req.userId].bio = String(bio || '').slice(0, 280);
  await save(DB);
  res.json({ bio: DB.users[req.userId].bio });
});
// Jeff, Sep 2026: "make profiles private or public in settings" -- then "let's do public as
// default, and private if toggled." Public (default) = anyone sees profile detail, workouts
// posted Public, and can request to join a Public-visibility workout, no approval needed.
// Private is opt-in = only approved followers (and you) -- canSeeProfile() is the one rule this
// drives everywhere (profile detail, post visibility, session joinability).
app.post('/api/me/profile-visibility', auth, async (req, res) => {
  const { visibility } = req.body || {};
  const v = visibility === 'public' ? 'public' : 'private';
  const me = DB.users[req.userId];
  me.profileVisibility = v;
  // Flipping to Public doesn't reject anyone waiting on approval -- it makes the wait moot, since
  // everyone (them included) can already see the profile. Approve them all outright rather than
  // leaving a pending-requests queue nobody has a reason to check any more.
  if (v === 'public' && Array.isArray(me.followReqs) && me.followReqs.length) {
    ensureFollowArrays(me);
    for (const fromId of me.followReqs.slice()) {
      if (!me.followers.includes(fromId)) me.followers.push(fromId);
      const from = DB.users[fromId];
      if (from) { ensureFollowArrays(from); if (!from.following.includes(req.userId)) from.following.push(req.userId); }
    }
    me.followReqs = [];
  }
  await save(DB);
  res.json({ profileVisibility: v });
});
// Same cap as a session's own location field (see POST/PUT /api/sessions) — a saved default gets
// prefilled into that same field, so the two limits have to agree.
app.post('/api/me/default-gym', auth, async (req, res) => {
  const { defaultGym } = req.body || {};
  DB.users[req.userId].defaultGym = capStr(defaultGym, 120).trim();
  await save(DB);
  res.json({ defaultGym: DB.users[req.userId].defaultGym });
});
// Following is a REQUEST now, not an instant grant. It stays pending until the target accepts.
app.post('/api/follow/:id', auth, async (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (req.params.id === req.userId) return res.status(400).json({ error: 'cannot follow self' });
  ensureFollowArrays(target); ensureFollowArrays(DB.users[req.userId]);
  if (target.followers.includes(req.userId)) return res.json({ status: 'following' });
  // Sep 2026: a Public profile has nothing to approve -- everyone can already see it -- so a
  // follow there lands immediately instead of sitting in target.followReqs. A Private profile
  // keeps the existing approval step. Public is the default (unset counts as public), same rule
  // as canSeeProfile.
  if (target.profileVisibility !== 'private') {
    target.followers.push(req.userId);
    const me = DB.users[req.userId];
    if (!me.following.includes(target.id)) me.following.push(target.id);
    await save(DB);
    notify(target.id, { title: 'New follower', body: `${DB.users[req.userId].displayName} started following you` });
    return res.json({ status: 'following' });
  }
  if (!target.followReqs.includes(req.userId)) {
    target.followReqs.push(req.userId);
    await save(DB);
    notify(target.id, { title: 'New follow request', body: `${DB.users[req.userId].displayName} wants to follow you` });
  }
  res.json({ status: 'requested' });
});
app.post('/api/unfollow/:id', auth, async (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.json({ status: 'none' });
  ensureFollowArrays(target); const me = DB.users[req.userId]; ensureFollowArrays(me);
  target.followers = target.followers.filter(x => x !== req.userId);   // stop being an approved follower
  target.followReqs = target.followReqs.filter(x => x !== req.userId); // or cancel a pending request
  me.following = me.following.filter(x => x !== req.params.id);
  await save(DB);
  res.json({ status: 'none', followers: target.followers.length });
});
// The target approves or rejects a pending follow request. :id is the requester.
app.post('/api/follow-requests/:id/accept', auth, async (req, res) => {
  const me = DB.users[req.userId]; ensureFollowArrays(me);
  const fromId = req.params.id;
  if (!me.followReqs.includes(fromId)) return res.status(404).json({ error: 'no such request' });
  me.followReqs = me.followReqs.filter(x => x !== fromId);
  if (!me.followers.includes(fromId)) me.followers.push(fromId);
  const from = DB.users[fromId];
  if (from) { ensureFollowArrays(from); if (!from.following.includes(req.userId)) from.following.push(req.userId); }
  await save(DB);
  if (from) notify(fromId, { title: 'Follow request accepted', body: `${me.displayName} accepted your follow request` });
  res.json({ ok: true });
});
app.post('/api/follow-requests/:id/reject', auth, async (req, res) => {
  const me = DB.users[req.userId]; ensureFollowArrays(me);
  me.followReqs = me.followReqs.filter(x => x !== req.params.id);
  await save(DB);
  res.json({ ok: true });
});

// ---- Connections ----
// v190 (Sep 2026): "Friends" retired as its own system -- followers alone decide who's connected
// to whom now (see canSeeProfile). followers[] = people approved to see my private profile;
// following[] = accounts I follow that approved me; followReqs[] = incoming pending requests.
function ensureFollowArrays(u){ if(!Array.isArray(u.followers)) u.followers=[]; if(!Array.isArray(u.following)) u.following=[]; if(!Array.isArray(u.followReqs)) u.followReqs=[]; }
// "Connected" = an approved follow in EITHER direction -- Jeff, Sep 2026: "you can invite anyone
// that follows you to workouts, or vice versa." Used for invite eligibility (does NOT gate who can
// see whose stuff -- that's canSeeProfile, which is deliberately one-directional: the profile
// OWNER decides who sees THEM, invite eligibility is symmetric because either side already vouched
// for the other by following them).
function connectionsOf(userId) {
  const u = DB.users[userId];
  if (!u) return [];
  const set = new Set([...(u.followers || []), ...(u.following || [])]);
  set.delete(userId);
  return [...set];
}
// One-time: friends already saw each other's detail, so they become mutual APPROVED followers (no
// visibility changes for anyone). Old one-directional follows granted nothing, so under the new
// approval rule they become pending requests the target can accept or ignore — nobody silently
// gains access they were never granted. Idempotent via the DB flag; runs before app.listen.
function migrateFollowApproval() {
  if (DB.followApprovalV1) return 0;
  for (const u of Object.values(DB.users)) ensureFollowArrays(u);
  let pending = 0;
  for (const u of Object.values(DB.users)) {
    const old = u.followers.slice();
    const friends = new Set((Array.isArray(u.friends) ? u.friends : []).filter(f => DB.users[f] && f !== u.id));
    u.followers = [...friends];
    for (const f of old) if (DB.users[f] && f !== u.id && !friends.has(f) && !u.followReqs.includes(f)) { u.followReqs.push(f); pending++; }
  }
  for (const u of Object.values(DB.users)) u.following = [];
  for (const u of Object.values(DB.users)) for (const f of u.followers) if (DB.users[f]) DB.users[f].following.push(u.id);
  for (const u of Object.values(DB.users)) u.following = [...new Set(u.following)];
  DB.followApprovalV1 = true;
  console.log('migrateFollowApproval: friends became approved followers; ' + pending + ' old follows became pending requests');
  return pending;
}
// v190 (Sep 2026): retiring the separate "friends" system now that followers alone decide who
// sees what. Every existing mutual friendship becomes a mutual approved-follow in BOTH directions
// -- nobody loses a connection, it just becomes the same kind of connection everyone else has.
// Runs AFTER migrateFollowApproval, so followers[]/following[] are already normalized -- this
// merges a friend INTO whatever's already there rather than overwriting it (unlike
// migrateFollowApproval's own friends pass, which predates followers existing at all). One-time,
// idempotent via the DB flag.
function migrateFriendsIntoFollowers() {
  if (DB.friendsRetiredV1) return 0;
  for (const u of Object.values(DB.users)) ensureFollowArrays(u);
  let merged = 0;
  for (const u of Object.values(DB.users)) {
    const friends = Array.isArray(u.friends) ? u.friends : [];
    for (const fid of friends) {
      const f = DB.users[fid];
      if (!f || fid === u.id) continue;
      if (!u.followers.includes(fid)) { u.followers.push(fid); merged++; }
      if (!u.following.includes(fid)) u.following.push(fid);
      if (!f.followers.includes(u.id)) f.followers.push(u.id);
      if (!f.following.includes(u.id)) f.following.push(u.id);
      // A friend was, by definition, already mutually approved -- clear any pending follow
      // request that happened to exist between them too, so it doesn't linger as a phantom ask.
      u.followReqs = (u.followReqs || []).filter(x => x !== fid);
      f.followReqs = (f.followReqs || []).filter(x => x !== u.id);
    }
  }
  DB.friendsRetiredV1 = true;
  console.log('migrateFriendsIntoFollowers: merged ' + merged + ' friendship(s) into mutual followers');
  return merged;
}
// v190 (Sep 2026): post/session visibility becomes binary (private/public) app-wide, replacing
// the old 3-way post enum (only_me/friends/public) and 2-way session enum (private/friends).
// 'public' now means "visible to whoever can see this person's profile" (canSeeProfile) --
// followers-only if their profile is private, everyone if it's public -- so an existing
// 'friends'-visibility post/session (which meant exactly "my friends can see this") becomes
// 'public': its real audience narrows to followers for anyone defaulting Private, never widening
// past what existed before. 'only_me' becomes 'private', which under the new rule also admits the
// session's other participants -- Jeff, Sep 2026: "private... only the creator or who was part of
// it" -- a deliberate widening from the old strictly-solo-author 'only_me', applied consistently
// to existing recaps too, not just new ones. One-time, idempotent via the DB flag.
function migratePostAndSessionVisibilityBinary() {
  if (DB.binaryVisibilityV1) return 0;
  let touched = 0;
  for (const s of Object.values(DB.sessions || {})) {
    if (!s || typeof s !== 'object') continue;
    if (s.visibility === 'friends') { s.visibility = 'public'; touched++; }
    for (const p of Object.values(s.posts || {})) {
      if (!p || typeof p !== 'object') continue;
      const next = (p.visibility === 'friends' || p.visibility === 'public') ? 'public' : 'private';
      if (p.visibility !== next) touched++;
      p.visibility = next;
    }
  }
  DB.binaryVisibilityV1 = true;
  console.log('migratePostAndSessionVisibilityBinary: touched ' + touched + ' visibility value(s)');
  return touched;
}
app.get('/api/users/search', auth, async (req, res) => {
  const q = normUser(req.query.q);
  // One letter returned twenty arbitrary strangers. Two is the shortest query that means anything.
  if (q.length < 2) return res.json([]);
  const me = req.userId;
  const score = u => {
    const un = normUser(u.username), dn = normUser(u.displayName);
    if (un === q || dn === q) return 0;                       // exact match first
    if (un.startsWith(q) || dn.startsWith(q)) return 1;       // then "starts with"
    return 2;                                                 // then anywhere in the name
  };
  const hits = Object.values(DB.users).filter(u => u.id!==me && (
    normUser(u.username).includes(q) || normUser(u.displayName).includes(q)
  )).sort((a,b) => score(a)-score(b) || normUser(a.username).localeCompare(normUser(b.username)))
    .slice(0,20).map(u => ({ ...publicUser(u.id), requestStatus:
    (u.followers||[]).includes(me) ? 'following' :
    (u.followReqs||[]).includes(me) ? 'requested' : 'none'
  }));
  res.json(hits);
});
// v190 (Sep 2026): kept at the same path/response shape the client already calls everywhere
// (nameOf/personOf, Home, the create-flow invite picker, the Friends tab) -- only what it's built
// from changed. `friends` now means "connected" (an approved follow in either direction), not a
// separate relationship; `followRequests` is unchanged, still the pending-approval queue.
app.get('/api/friends', auth, async (req, res) => {
  const me = DB.users[req.userId]; ensureFollowArrays(me);
  res.json({
    friends: connectionsOf(req.userId).map(id => ({ ...publicUser(id), streak: currentStreak(id) })),
    followRequests: (me.followReqs || []).map(id => DB.users[id] ? publicUser(id) : null).filter(Boolean)
  });
});

// ---- Activity feed (Friend's Activity) ----
// Shows friends' COMPLETED activity: PRs they hit + workouts they finished this week + current streak.
// Invites live in their own "Invites Awaiting" section on Home, not here.
//
// v247, cold-review catch: session history is now stamped with the PERSON'S OWN local calendar day
// (see creditFinish above), but this function used to always define "today"/"yesterday" as the
// SERVER's UTC day. Those two were fine while both sides used UTC, but once storage moved to local
// dates they could disagree for several hours every evening — exactly the window
// STREAK_REMINDER_HOUR_UTC fires in for US users, so the streak-loss reminder itself could
// misjudge someone as having broken a streak they were still on. Every one of these functions now
// takes an optional localToday (validated YYYY-MM-DD) and prefers it when given. It is only ever
// safe to pass when the caller IS the subject — their own live request is the only place a
// "local today" can be trusted to belong to userId — so it is threaded through /streak-status and
// /profile/me (self-view) but deliberately NOT through anyone viewing a FRIEND's profile/feed, nor
// through the background reminder timer (no request to ask); those keep the original UTC
// approximation, unchanged from before this file.
function isValidLocalDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // catches out-of-range month/day too (Date.UTC rolls Feb 30 into March, so it round-trips wrong)
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
// Calendar-day arithmetic on the YYYY-MM-DD string itself, anchored through Date.UTC so it never
// depends on what timezone THIS SERVER PROCESS happens to run in (a `new Date(str+'T12:00')` trick
// like rcDay's in app.js only works in the browser, where "local" reliably means the user's zone).
function shiftDateStr(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}
function currentStreak(userId, localToday){
  // collect distinct completion dates from session history
  const days = new Set();
  for (const s of Object.values(DB.sessions)) {
    for (const h of (s.history || [])) {
      if (h.userId === userId) days.add(h.date);
    }
  }
  if (!days.size) return 0;
  const today = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  let streak = 0;
  let cur = today;
  // allow streak to count if last workout was today or yesterday
  if (!days.has(cur)) { cur = shiftDateStr(cur, -1); if (!days.has(cur)) return 0; }
  while (days.has(cur)) { streak++; cur = shiftDateStr(cur, -1); }
  return streak;
}
// Task #63 (streak-loss reminders). Whether userId has a completed session dated TODAY —
// pulled out of currentStreak() as its own check because streakStatusFor() below needs it
// independently of the streak count (a streak of 0 with trainedToday true is still "safe today").
function trainedToday(userId, localToday) {
  const today = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  for (const s of Object.values(DB.sessions))
    for (const h of (s.history || []))
      if (h.userId === userId && h.date === today) return true;
  return false;
}
// The whole claim this feature makes, boiled down to one testable question per user: does this
// person still need to train today to keep their streak? atRisk requires BOTH a real streak (>=2
// days — a single day is not a streak worth protecting, and nagging a brand-new user about their
// first session would be discoverable and wrong, the exact thing CLAUDE.md warns against) AND not
// having trained yet today. See test/streak-reminders.mjs for the full worked-example spec this
// was built against.
function streakStatusFor(userId, localToday) {
  const streak = currentStreak(userId, localToday);
  const today = trainedToday(userId, localToday);
  return { streak, trainedToday: today, atRisk: streak >= 2 && !today };
}
app.get('/api/me/streak-status', auth, async (req, res) => {
  res.json(streakStatusFor(req.userId, req.query.localToday));
});
// Not exposed via HTTP on purpose — a "send everyone their reminder now" endpoint would be a way
// to spam every user's push notifications on demand. Called only by the background timer below.
function usersAtRiskOfLosingStreak() {
  return Object.keys(DB.users).filter(uid => streakStatusFor(uid).atRisk);
}
// Aug 31: "workout scheduled today" push reminder — Jeff floated this alongside the Live/Upcoming
// work ("maybe scheduled notifications letting you know you have a workout upcoming today"),
// deliberately deferred at the time, now built. Same two-layer shape as streakStatusFor/
// usersAtRiskOfLosingStreak above: a per-user question exposed via HTTP (so it's directly
// testable) plus a batch version the background timer alone calls.
//
// hasSessionToday: this user is a participant in a session scheduled for TODAY (server's own UTC
// calendar day — see the STREAK_REMINDER_HOUR_UTC comment on the boot timer below for why there's
// no per-user timezone to do better than that) that they have NOT yet finished (s.history, same
// "did THIS person actually finish it" check creditFinish/currentStreak use — a co-participant who
// already logged their half shouldn't still get nagged). sessionName is the earliest such
// session's name, so the reminder can name it; null for an unnamed ("Workout Now"-style) session.
function workoutReminderStatusFor(userId) {
  const today = new Date().toISOString().slice(0, 10);
  let session = null, sessionAt = null;
  for (const s of Object.values(DB.sessions)) {
    // scheduledAt is not consistently typed across sessions (ISO string, or epoch seconds/ms —
    // see perfDate's own comment below), so the "earliest" tie-break has to compare perfDate's
    // normalized ISO output, not the raw stored value — cold-review catch (Aug 31): comparing raw
    // String(s.scheduledAt) values worked for the common ISO-string case but silently picked the
    // wrong "earliest" session for a user with two sessions today stored in different formats.
    const at = perfDate(s.scheduledAt);
    if (at.slice(0, 10) !== today) continue;
    if (!(s.participants || []).includes(userId)) continue;
    if (s.history.some(h => h.userId === userId)) continue;
    if (!session || at < sessionAt) { session = s; sessionAt = at; }
  }
  const name = session && (session.name || '').trim();
  return { hasSessionToday: !!session, sessionName: name || null };
}
app.get('/api/me/workout-reminder-status', auth, async (req, res) => {
  res.json(workoutReminderStatusFor(req.userId));
});
// Not exposed via HTTP in batch form on purpose — same spam-risk reasoning as
// usersAtRiskOfLosingStreak above. Called only by the background timer below.
function usersWithWorkoutToday() {
  const result = new Map();   // userId -> sessionName|null
  for (const uid of Object.keys(DB.users)) {
    const st = workoutReminderStatusFor(uid);
    if (st.hasSessionToday) result.set(uid, st.sessionName);
  }
  return result;
}
// v238: the deployed version, read from index.html's cache-bust (?v=NNN) - the one number
// that already changes on every frontend ship. Lazily read + cached on first request, NOT at
// startup (CLAUDE.md rule 7). No auth: it leaks nothing but a build number, and the client
// asks before anyone logs in.
let _appVersion = null;
app.get('/api/version', (req, res) => {
  if (_appVersion === null) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      const m = /app\.js\?v=(\d+)/.exec(html);
      _appVersion = (m && m[1]) || '';
    } catch (e) { _appVersion = ''; }
  }
  res.json({ v: _appVersion });
});

app.get('/api/feed', auth, async (req, res) => {
  const myConnections = connectionsOf(req.userId);
  const items = [];
  const weekAgo = Date.now() - 7*24*3600*1000;
  // PRs from friends — grouped per friend per week (see groupPrsForFeed) so one big improving
  // week is one row, not one row per exercise, firstLog baselines never masquerade as earned
  // PRs, and nothing older than a week lingers.
  for (const fid of myConnections) {
    const prs = (DB.prs && DB.prs[fid]) ? Object.values(DB.prs[fid]) : [];
    for (const g of groupPrsForFeed(prs, weekAgo)) items.push({ ...g, by: fid });
  }
  // Workouts completed this week (from session history)
  for (const fid of myConnections) {
    let count = 0, latest = 0;
    for (const s of Object.values(DB.sessions)) {
      for (const h of (s.history || [])) {
        const t = new Date(h.date).getTime();
        if (h.userId === fid && t >= weekAgo) { count++; if (t > latest) latest = t; }
      }
    }
    // v239: stamped with the latest contributing workout, not now() - a summary stamped "now"
    // permanently outranked every recap/PR row with a real timestamp (cold-review catch)
    if (count > 0) items.push({ type: 'completed', by: fid, at: new Date(latest).toISOString(), text: `completed ${count} workout${count>1?'s':''} this week` });
    // Current streak
    const streak = currentStreak(fid);
    // v247: same fix as 'completed' just above, applied here too (it was missed the first time
    // around) — a streak of 2+ always has a session dated today or yesterday, which is always
    // inside this same 7-day window, so `latest` (computed just above) is already the real date
    // of that most recent training day rather than "whenever the feed happens to be requested".
    if (streak >= 2) items.push({ type: 'streak', by: fid, at: new Date(latest).toISOString(), text: `hit a ${streak} day workout streak` });
  }
  // v239: friends' posted recaps from the week - the feed's first VISUAL rows. Same
  // visibility gate as everywhere else (canSeePostAuthor); the thumbnail is only sent when the
  // photo has been migrated to an /uploads/ URL - a still-inline data URI would bloat the feed
  // payload, so those rows just go without a thumb until the next boot migrates them.
  for (const fid of myConnections) {
    for (const s of Object.values(DB.sessions)) {
      const p = s.posts && s.posts[fid];
      if (!p || !p.at || !(new Date(p.at).getTime() >= weekAgo)) continue;   // NaN fails CLOSED, same as the PR path
      if (!canSeePostAuthor(p, fid, req.userId, s)) continue;
      const img = (p.media || []).find(m => m && m.type === 'image' && typeof m.src === 'string' && m.src.startsWith('/uploads/'));
      items.push({ type: 'recap', by: fid, at: p.at, text: `finished ${s.name || 'a workout'}`,
        sessionId: s.id, thumb: img ? img.src : null });
    }
  }
  items.sort((a,b)=> new Date(b.at) - new Date(a.at));
  // Home shows this as a quick-glance strip, not a full history — cap it so a house full of
  // active friends doesn't turn it into a scroll. Nothing is lost: every friend's complete
  // recent activity is still on their own profile page (tap their name here to get there).
  res.json(items.slice(0, 8));
});


// ---- Templates (saved routines) ----
// hiddenBy (added below, Aug 28) is a list of OTHER PEOPLE's user ids -- whoever removed this
// routine from their own list, see the comment on GET below for why it exists at all. Nothing
// client-side ever reads it, and there's no reason a routine's owner, or anyone else it's shared
// with, should be able to see WHICH of their friends quietly removed it. Same instinct as
// viewPost's "who sees whose" gating elsewhere in this file: every response that echoes a
// template object -- GET's mine/shared, POST's create response, PUT's update response -- strips
// it before the object leaves the server. (DELETE only ever returns {ok:true}, nothing to strip.)
const stripHidden = t => { const { hiddenBy, ...rest } = t; return rest; };
app.get('/api/templates', auth, async (req, res) => {
  const all = Object.values(DB.templates || {});
  const mine = all.filter(t => t.ownerId === req.userId);
  // also templates shared by friends
  //
  // Jeff, Aug 28: "I want to be able to delete friend shared routines having that option also."
  // A shared routine is ONE object owned by your friend -- the "Delete" button on your OWN
  // routines below (owner-only, and a real DELETE that erases the row for everyone) can't just
  // be reused here: you deleting it would delete your friend's routine out from under them too.
  // So "delete" a friend's routine means take it out of MY OWN Routines list only -- t.hiddenBy
  // below, exactly the same "remove it for me, leave everyone else's copy alone" shape as
  // POST /api/sessions/:id/remove-mine (Aug 28, above the session routes). Never surfaced to the
  // owner or any other friend. Since v240 removal is undoable for a moment (POST /unhide below,
  // driven by the client's undo toast); once that moment passes it stays out of your list even
  // if you unfriend and re-friend them later.
  const myConnections = connectionsOf(req.userId);
  const friendT = all.filter(t => myConnections.includes(t.ownerId)
    && !(t.hiddenBy && t.hiddenBy.includes(req.userId)));
  // v239: shared rows carry WHO shared them - two friends' "Legs - Random" were otherwise
  // indistinguishable (Jeff's real list, Aug 28). Display name only; never the id-to-name map.
  res.json({ mine: mine.map(stripHidden),
    shared: friendT.map(t => ({ ...stripHidden(t), ownerName: (DB.users[t.ownerId] && (DB.users[t.ownerId].displayName || DB.users[t.ownerId].username)) || '' })) });
});
// The non-owner half of "delete a routine": hides it from MY list, never touches the owner's
// row. See the comment above GET /api/templates for why this can't just be DELETE /:id.
app.post('/api/templates/:id/hide', auth, async (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.ownerId === req.userId) return res.status(400).json({ error: 'this is your own routine — delete it instead' });
  t.hiddenBy = t.hiddenBy || [];
  if (!t.hiddenBy.includes(req.userId)) t.hiddenBy.push(req.userId);
  await save(DB);
  res.json({ ok: true });
});
// v240: the undo half of Remove (Jeff asked for an undo moment after removing a shared routine —
// hide used to be permanent). Only ever removes YOUR OWN id from hiddenBy, so, like hide, it can
// never touch the owner's row or any other friend's view of it. Idempotent on purpose: un-hiding
// something that isn't hidden is {ok:true}, because the client's Undo button can race a
// double-tap and neither tap should surface an error.
app.post('/api/templates/:id/unhide', auth, async (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.hiddenBy) t.hiddenBy = t.hiddenBy.filter(id => id !== req.userId);
  await save(DB);
  res.json({ ok: true });
});
app.post('/api/templates', auth, async (req, res) => {
  const { name, exercises } = req.body || {};
  if (!name || !Array.isArray(exercises) || !exercises.length) return res.status(400).json({ error: 'name + exercises required' });
  // v253 (audit finding, see isPlainExercise above) -- a non-object element would have thrown
  // inside withDefaults below, returning a generic 500 instead of a clean 400.
  if (!exercises.every(isPlainExercise)) return res.status(400).json({ error: 'invalid exercise' });
  const id = 't_' + uid();
  const t = { id, ownerId: req.userId, name: capStr(name, 80), exercises: exercises.map(withDefaults) };
  if (!DB.templates) DB.templates = {};
  DB.templates[id] = t;
  await save(DB);
  res.json(stripHidden(t));
});
app.put('/api/templates/:id', auth, async (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.ownerId !== req.userId) return res.status(403).json({ error: 'not yours' });
  const { name, exercises } = req.body || {};
  if (name) t.name = capStr(name, 80);
  if (Array.isArray(exercises) && exercises.length) {
    // v253 (audit finding, see isPlainExercise above) -- same generic-500 risk as POST /api/templates.
    if (!exercises.every(isPlainExercise)) return res.status(400).json({ error: 'invalid exercise' });
    t.exercises = exercises.map(withDefaults);
  }
  await save(DB);
  // stripHidden matters here specifically: once a friend has hidden this routine, t.hiddenBy is
  // populated, and this is the response an owner gets back on every completely ordinary edit
  // (finishTemplate/tplQuickSaveConfirm in app.js) -- without stripping it, editing your own
  // routine would silently hand you the exact list of friends who quietly removed it.
  res.json(stripHidden(t));
});
app.delete('/api/templates/:id', auth, async (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.ownerId !== req.userId) return res.status(403).json({ error: 'not yours' });
  delete DB.templates[req.params.id];
  await save(DB);
  res.json({ ok: true });
});

// ---- Session comments (Message Host / chat) ----
app.get('/api/sessions/:id/comments', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  // There was no check here at all. Any logged-in account could read any workout's entire chat by
  // id — including after their join request was rejected, and after declining an invitation. The
  // WRITE path five lines below has always been guarded; the read path simply never was.
  const tier = sessionTier(s, req.userId);
  if (tier !== 'member' && tier !== 'invited') return res.status(403).json({ error: 'forbidden' });
  res.json(s.comments || []);
});
app.post('/api/sessions/:id/comments', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  // Same gate as the read path directly above. These disagreed: you could post into a thread you
  // were not allowed to read, and notify everyone in it.
  const tier = sessionTier(s, req.userId);
  if (tier !== 'member' && tier !== 'invited') return res.status(403).json({ error: 'forbidden' });
  const text = capStr((req.body || {}).text, 2000);   // coerce + cap: an object here used to 500 on .trim()
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  const c = { id: 'c_' + uid(), userId: req.userId, text, at: new Date().toISOString() };
  if (!s.comments) s.comments = [];
  s.comments.push(c);
  await save(DB);
  for (const pid of s.participants) if (pid !== req.userId) notify(pid, { title: 'New message', body: `${DB.users[req.userId].displayName}: ${text.slice(0,40)}` });
  res.json(sessionView(s, req.userId));
});

// ---- Comments on a POSTED recap (Instagram-style: comment on the finished workout) ----
// Deliberately separate storage from s.comments above. That thread is crew chat WHILE the workout
// is still open ("at the gym, rack 3") and has nothing to do with the workout once it's posted; it
// used to be the exact same array relabeled "Comments" after posting, which meant leftover chat
// showed up under someone's finished recap. Jeff, Aug 26: "the comments in the workout are just for
// the workout... that section is for people to comment on the workout after it's saved and posted."
// Each participant's recap (s.posts[authorId]) is its own post, so its comments live on it, gated by
// the exact same canSeePostAuthor() rule as reading the post itself — if you can see it, you can
// comment on it, same as Instagram.
app.get('/api/sessions/:id/posts/:authorId/comments', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const p = s.posts && s.posts[req.params.authorId];
  if (!canSeePostAuthor(p, req.params.authorId, req.userId, s)) return res.status(403).json({ error: 'forbidden' });
  res.json(objArray(p.comments));
});
app.post('/api/sessions/:id/posts/:authorId/comments', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const p = s.posts && s.posts[req.params.authorId];
  if (!canSeePostAuthor(p, req.params.authorId, req.userId, s)) return res.status(403).json({ error: 'forbidden' });
  const text = capStr((req.body || {}).text, 2000);
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  const c = { id: 'c_' + uid(), userId: req.userId, text, at: new Date().toISOString() };
  p.comments = objArray(p.comments);
  p.comments.push(c);
  await save(DB);
  if (req.params.authorId !== req.userId)
    notify(req.params.authorId, { title: 'New comment', body: `${DB.users[req.userId].displayName}: ${text.slice(0,40)}` });
  res.json(sessionView(s, req.userId));
});

// ---- Push subscribe ----
app.post('/api/push/subscribe', auth, async (req, res) => {
  // Was stored verbatim and uncapped — a single POST with a 10 MB `subscription` ballooned
  // data.json, and a dozen free accounts doing it wedged every write on the box. A real Web Push
  // subscription is a small fixed shape; store only the fields web-push needs, bounded, and refuse
  // anything else.
  const sub = (req.body || {}).subscription;
  if (!isObj(sub) || typeof sub.endpoint !== 'string' || !sub.endpoint || sub.endpoint.length > 1024)
    return res.status(400).json({ error: 'invalid subscription' });
  const keys = isObj(sub.keys) ? sub.keys : {};
  DB.pushSubs[req.userId] = {
    endpoint: sub.endpoint,
    expirationTime: (typeof sub.expirationTime === 'number') ? sub.expirationTime : null,
    keys: { p256dh: capStr(keys.p256dh, 256), auth: capStr(keys.auth, 256) },
  };
  await save(DB);
  res.json({ ok: true });
});
function notify(userId, payload) {
  const sub = DB.pushSubs[userId];
  if (!sub) return;
  webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
    // 404/410 = the push service says this subscription is dead (expired, unsubscribed on the
    // device, or - the #61 case - signed with a VAPID key that no longer matches). Drop it rather
    // than retrying it forever; the client re-subscribes on its next app open (see setupPush()
    // in app.js), which will overwrite this with a fresh, valid subscription.
    // Only delete if it's still the SAME subscription that failed - sendNotification is async, and
    // by the time this rejects the user may have already resubscribed (POST /api/push/subscribe
    // overwrites DB.pushSubs[userId] synchronously); deleting unconditionally would wipe out that
    // brand-new, working subscription instead of the stale one that actually failed.
    if (err && (err.statusCode === 404 || err.statusCode === 410) && DB.pushSubs[userId] === sub) {
      delete DB.pushSubs[userId];
      save(DB).catch(e => console.error('notify: failed to persist dead-subscription cleanup:', e.message));
    }
  });
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

app.post('/api/sessions', auth, async (req, res) => {
  const { scheduledAt, visibility, equipment, exercises, inviteUsernames, location, lengthMin, creatorNote, name } = req.body || {};
  // Empty is allowed now — "Workout Now" creates a live session with nothing in it yet, so you can
  // add lifts as you go instead of planning them first. Every other creation path (the normal
  // create-flow) still enforces at least one exercise on its own side before it ever calls this.
  if (!Array.isArray(exercises)) return res.status(400).json({ error: 'needs exercises' });
  // v253 (audit finding, see isPlainExercise above) -- a non-object element would have thrown
  // inside withDefaults below, returning a generic 500 instead of a clean 400.
  if (!exercises.every(isPlainExercise)) return res.status(400).json({ error: 'invalid exercise' });
  const id = newSessionId();
  const ex = exercises.map((e, i) => Object.assign({ id: 'e_' + uid(), order: i }, withDefaults(e)));
  const invites = [];
  if (Array.isArray(inviteUsernames)) {
    // v190 (Sep 2026): invite eligibility is now "connected" (an approved follow either
    // direction), not "friend" -- see connectionsOf().
    const myConnections = connectionsOf(req.userId);
    for (const un of inviteUsernames) {
      const f = myConnections.find(fid => normUser(DB.users[fid] && DB.users[fid].username) === normUser(un));
      if (f) invites.push(f);
    }
  }
  const session = {
    id, creatorId: req.userId,
    scheduledAt: capStr(scheduledAt, 40) || new Date().toISOString(),
    status: 'draft',
    // v190 (Sep 2026): binary, matching the posted-recap model -- 'public' = joinable by
    // whoever can see the creator's profile (canSeeProfile), 'private' = invite-only.
    visibility: visibility === 'public' ? 'public' : 'private',
    equipment: Array.isArray(equipment) ? equipment.filter(x => typeof x === 'string').slice(0, 20).map(x => capStr(x, 40)) : [],
    location: capStr(location, 120),
    lengthMin: numIn(lengthMin, 1440) || null,
    creatorNote: capStr(creatorNote, 2000),
    // trimmed: a name of "   " is truthy, so it would title the workout with a blank heading
    name: capStr(name, 80).trim(),
    exercises: ex,
    participants: [req.userId],
    invited: invites,
    variations: {},
    suggestedEdits: [],
    joinRequests: [],
    attendance: {},
    logs: {},
    comments: [],
    history: [],
    posts: {}
  };
  DB.sessions[id] = session;
  await save(DB);
  // notify invited friends
  for (const fid of invites) notify(fid, { title: 'Workout invite', body: `${DB.users[req.userId].displayName} invited you to a workout` });
  // Jeff, Aug 31: lock-screen nudge naming the exercise you're about to walk up to -- see
  // notify-helpers.js for the full reasoning and why this is scoped to "starting now," not every
  // session creation. Self-notifying the creator (not an invited friend) is a new pattern here;
  // notify() itself doesn't care whose id it's called with.
  const startNotif = firstExerciseStartNotification(session);
  if (startNotif) notify(req.userId, startNotif);
  res.json(session);
});

// list sessions visible to me: mine, invited to, or friends-visibility from friends
// THE HOME SCREEN. This runs on every single app open, and it used to return raw sessions — so
// merely being a friend of the creator delivered every participant's sets, the whole chat, and
// the notes and photo URLs of an "only me" post, to your phone, unasked, several times a day.
app.get('/api/sessions', auth, async (req, res) => {
  const out = Object.values(DB.sessions)
    .map(s => sessionView(s, req.userId))     // tier decides the fields; stranger yields null
    .filter(Boolean)
    .sort((a,b)=> new Date(a.scheduledAt) - new Date(b.scheduledAt));
  res.json(out);
});

app.get('/api/sessions/:id', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const view = sessionView(s, req.userId);      // one rule for who, and for which fields
  if (!view) return res.status(403).json({ error: 'forbidden' });
  res.json(view);
});

// ---- WHO SEES WHAT ---------------------------------------------------------------------------
// Every route in this file used to answer one question — "may you touch this workout at all?" —
// and then hand back the raw object with `res.json(s)`. It did that at eighteen separate places.
// So a friend of the creator opening the home screen received every participant's logged sets,
// the entire chat thread, and the notes and photo URLs of a post marked "only me". The permission
// model had no concept of WHICH FIELDS a given person may see, only of whether the door opened.
//
// This is that concept. One function, one place to reason about, and every route returns through
// it. Adding a field to a session now means deciding, here, who it belongs to.
//
// The tiers, narrowest first:
//   stranger      not related to this workout at all -> nothing. Routes refuse before reaching here.
//   friend        a friend of the creator, on a friends-visibility workout, who is not in it.
//                 Gets the PLAN — what the workout is — and EACH participant's recap only if that
//                 participant's own post visibility allows it (each person posts independently
//                 now, s.posts keyed by userId — see canSeePostAuthor/anyVisiblePost below). Never
//                 anyone's sets. Never the chat.
//   invited       has an invitation they have not answered. Gets the plan, plus the chat, because
//                 deciding whether to come means being able to ask. Still nobody's sets.
//   member        a participant or the creator. Gets everything.
// A session has always been CREATED with the full modern shape (participants:[], exercises:[],
// logs:{}, attendance:{}, comments:[], suggestedEdits:[], variations:{}, joinRequests:[],
// history:[]) — but this file has a documented history of accounts fixed by hand-editing
// data.json (migrateMergeDuplicateBrian, the PIN-reset note in DEPLOY.md), and nothing checks
// that a hand-edited or pre-schema row still has every key. The READ paths (sessionView and
// friends) were already hardened with ||[]/||{} fallbacks; this is the same guarantee for every
// route that WRITES to a session, called once right after the 404 check and before anything
// touches a container. Without it, a session missing e.g. `logs` 500s on the very next set
// logged in it — for every participant, permanently, until someone edits data.json by hand
// again. It mutates the object in place, so the very next save() heals the row for good.
// typeof [] === 'object' and [] is truthy, so `typeof x !== 'object'` alone does NOT catch an
// array standing in for a plain object here — and it is a plausible mistake, since every OTHER
// container in this same schema genuinely is []. That gap is not academic: `s.logs[userId] = [...]`
// on an array silently sets a non-index property that JSON.stringify then drops on save — a loud
// 500 replaced by a quiet 200 that erases the set forever. isObj() rejects arrays explicitly.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// Coerce to an array of objects: a non-array becomes [], and any null/primitive slot is dropped.
// A null LOG entry crashes a boot migration (`l.exerciseName` on null); a null HISTORY or COMMENT
// row crashes a read path (`h.userId` in profileOf). A null slot holds no data, so dropping it
// loses nothing. Returns the SAME array reference when the input is already clean, so this stays a
// true no-op on well-formed data.
const objArray = a => !Array.isArray(a) ? []
  : (a.some(x => !x || typeof x !== 'object') ? a.filter(x => x && typeof x === 'object') : a);
function ensureSessionShape(s) {
  if (!Array.isArray(s.participants)) s.participants = [];   // participants and invited are id STRINGS,
  if (!Array.isArray(s.invited)) s.invited = [];             // not objects — array-checked, never element-cleaned
  s.exercises = objArray(s.exercises);
  if (!isObj(s.logs)) s.logs = {};
  else for (const uid of Object.keys(s.logs)) s.logs[uid] = objArray(s.logs[uid]);  // each user's set list
  if (!isObj(s.attendance)) s.attendance = {};
  s.comments = objArray(s.comments);
  s.suggestedEdits = objArray(s.suggestedEdits);
  if (!isObj(s.variations)) s.variations = {};
  s.joinRequests = objArray(s.joinRequests);
  s.history = objArray(s.history);
  if (!isObj(s.posts)) s.posts = {};
  return s;
}

// Run ONCE at boot, before any migration or read path that walks a session's containers. Heals a
// hand-edited or pre-schema row in memory, closing two distinct failure modes:
//   - BOOT CRASH: a non-array logs[uid], a null set slot, or a non-array `invited` throws inside a
//     boot migration (migrateExerciseNames/LoadTypes/rebuildAllPrs walk logs; migrateMergeDuplicate-
//     Brian reads invited). Those run before app.listen with no try/catch, so one bad row stops the
//     server starting AT ALL, for everyone, until the file is hand-fixed.
//   - READ 500: a non-array `history` (or a null history row) throws in profileOf/currentStreak,
//     taking the Profile and feed tabs down for everyone who loads them.
// Healing every row here, and re-healing on each write via ensureSessionShape, closes both. It is
// itself defensive: a session that will not read as an object is dropped (backupOnBoot has already
// snapshotted the pre-migration file), and any unexpected throw is caught so no single row can
// block boot. save() at the end of the boot block persists the healed rows.
function shapeFingerprint(s) {
  const t = v => Array.isArray(v) ? 'a' + v.length
    : (v && typeof v === 'object' ? 'o' + Object.keys(v).length : String(typeof v));
  let f = [s.participants, s.invited, s.exercises, s.logs, s.attendance, s.comments,
           s.suggestedEdits, s.variations, s.joinRequests, s.history].map(t).join('|');
  if (isObj(s.logs)) for (const uid of Object.keys(s.logs)) f += ':' + t(s.logs[uid]);
  return f;
}
function migrateSessionShapes() {
  if (!isObj(DB.sessions)) { DB.sessions = {}; return 0; }
  let healed = 0, dropped = 0;
  for (const id of Object.keys(DB.sessions)) {
    const s = DB.sessions[id];
    if (!isObj(s)) { delete DB.sessions[id]; dropped++; continue; }
    try {
      const before = shapeFingerprint(s);
      ensureSessionShape(s);
      if (shapeFingerprint(s) !== before) healed++;
    } catch (e) {
      console.error('migrateSessionShapes: could not heal session ' + id + ' — ' + (e && e.message));
    }
  }
  if (healed || dropped) console.log('migrateSessionShapes: healed ' + healed + ' malformed session(s)'
    + (dropped ? ', dropped ' + dropped + ' unreadable' : ''));
  return healed;
}

function sessionTier(s, viewerId) {
  if (!s || !viewerId) return 'stranger';
  if (s.creatorId === viewerId) return 'member';
  if ((s.participants || []).includes(viewerId)) return 'member';
  if (Array.isArray(s.invited) && s.invited.includes(viewerId)) return 'invited';
  // v190 (Sep 2026): a "joinable" session used to mean "the creator's friends"; now it means
  // "whoever can see the creator's profile" (canSeeProfile) -- followers-only if they're Private,
  // anyone if they're Public. Tier kept named 'friend' internally (it's never shown to a user,
  // and renaming it would have touched every call site below for no behavior change) -- what it
  // takes to reach it is what changed.
  if (s.visibility === 'public' && canSeeProfile(s.creatorId, viewerId)) return 'friend';
  // A PUBLISHED recap is its own thing. Sharing is the point of posting, and session visibility
  // defaults to 'private' — so gating a published recap behind it meant a recap shared publicly
  // could not be opened by the people it was shared with. Each recap's own visibility decides.
  if (anyVisiblePost(s, viewerId)) return 'reader';
  // v187 (Leave Workout redesign): a real history row here means you actually trained this
  // workout at some point, even though Leave has since taken you off the live roster — Jeff, Aug
  // 21: "I have exercises in my profile that when I click on show as forbidden." A private
  // session has no friend-tier route back, and most people never post a recap before leaving, so
  // without this a workout you genuinely completed 403'd forever the moment you left it, even
  // with credit kept. Checked LAST, after every stronger tier — a still-mutual friend viewing a
  // friends-visible session they left should keep getting 'friend' (and everything that comes
  // with it), never get quietly downgraded to this narrower shape.
  if ((s.history || []).some(h => h.userId === viewerId)) return 'alumni';
  return 'stranger';
}

// v248: whether userId may still finish (/lock) or write/edit their own recap (/post) on this
// session — a CURRENT participant/creator, or someone who left with `keep` (their history row
// survives a keep-leave; see the comment above /leave). A plain s.participants.includes(userId)
// check alone 403'd a keep-leaver out of editing the recap they had already posted BEFORE leaving,
// and out of ever posting one for the first time AFTER leaving to make their kept sets visible —
// exactly the credit `keep` exists to protect, quietly undone the moment they stepped away. Same
// 'alumni' fact sessionTier already grants VIEW access on; this is the matching WRITE-side check.
function canFinishOrPost(s, userId) {
  return s.creatorId === userId || (s.participants || []).includes(userId)
    || (s.history || []).some(h => h.userId === userId);
}

// A recap carries its OWN visibility, chosen by whoever wrote it — and now every participant has
// their own, independent of everyone else's. p is one entry of s.posts, authorId is the key it
// lives under; s is the session it belongs to (needed for the 'private' participant check below).
// v190 (Sep 2026): binary visibility. 'public' = canSeeProfile(authorId, viewerId) -- the exact
// same audience rule as the rest of the profile (followers-only if Private, everyone if Public).
// 'private' (or any legacy/unrecognized value) = the creator and every participant of THIS
// session, not just the post's own author -- Jeff, Sep 2026: "private... only the creator or who
// was part of it." This is a deliberate reversal of the old rule ("only me" used to mean only the
// author, even to someone who trained the very same workout) -- private now means hidden from the
// internet at large, not hidden from your own training partners.
function canSeePostAuthor(p, authorId, viewerId, s) {
  if (!p) return false;
  if (authorId === viewerId) return true;
  // Membership checked BEFORE the public-visibility branch, not after: 'public' is meant to be a
  // WIDER audience than 'private' (private already admits every current member), never a narrower
  // one. Checking canSeeProfile first would let a 'public' post be hidden from a fellow participant
  // who simply isn't an approved follower of the author -- exactly backwards, and a contradiction
  // of sessionView's member-tier comment ("a fellow member now sees every recap here, private or
  // public"). This ordering is what actually makes that true.
  if (s && (s.creatorId === viewerId || (s.participants || []).includes(viewerId))) return true;
  if (p.visibility === 'public') return canSeeProfile(authorId, viewerId);
  return false;
}
// Is there ANY recap in this session the viewer is allowed to open — used only to decide whether
// a non-member gets 'reader' access to the session at all.
function anyVisiblePost(s, viewerId) {
  for (const [authorId, p] of Object.entries((s && s.posts) || {})) {
    if (canSeePostAuthor(p, authorId, viewerId, s)) return true;
  }
  return false;
}

// Only the viewer's own entry survives from a per-user map.
function pickMine(map, viewerId) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (v && typeof v === 'object' && v[viewerId] !== undefined) out[k] = { [viewerId]: v[viewerId] };
  }
  return out;
}

function sessionView(s, viewerId) {
  if (!s) return null;
  const tier = sessionTier(s, viewerId);
  if (tier === 'member') {
    // v190 (Sep 2026): a member of this session IS "who was part of it" — canSeePostAuthor's
    // 'private' branch already admits the creator and every participant, so a fellow member now
    // sees every recap here, private or public (this used to be the opposite: "only me" meant
    // only me, even to someone who trained the very same workout — Jeff explicitly asked for
    // that reversed). Kept as an explicit per-post check rather than assuming "member sees all"
    // so a still-hidden/legacy post shape fails closed instead of open.
    const posts = {};
    for (const [authorId, p] of Object.entries(s.posts || {}))
      posts[authorId] = canSeePostAuthor(p, authorId, viewerId, s) ? p : { hidden: true, visibility: p.visibility };
    // v242: logs survive a keep-leave now, so a member view must decide which entries are
    // shown. Your own always; a CURRENT member's always (that's the shared log sheet); a
    // departed person's only when their published recap admits this viewer — a recap IS its
    // author's sets (same principle as the reader tier below), but someone who left without
    // posting shows as simply departed, sets stored but not on display.
    const logs = {};
    for (const [uid, arr] of Object.entries(s.logs || {})) {
      const current = (s.participants || []).includes(uid) || s.creatorId === uid;
      const viaPost = s.posts && s.posts[uid] && canSeePostAuthor(s.posts[uid], uid, viewerId, s);
      if (uid === viewerId || current || viaPost) logs[uid] = arr;
    }
    // v253 (audit finding): this Object.assign spreads the raw session, so joinRequests — every
    // pending/approved/rejected request to join, INCLUDING each requester's free-text note — went
    // out unfiltered to every current participant, not just the creator. Approving/rejecting is
    // already creator-only in the client (app.js gates that UI on isCreator), but the data itself
    // was never gated the same way, so anyone in the workout could read who'd asked to join and
    // what they wrote by inspecting the response. Only the creator needs the full list to decide
    // on it; everyone else gets the same "yourself and nobody else" treatment as invited/logs
    // above (in the rare case they've also filed their own request).
    const joinRequests = (s.creatorId === viewerId) ? (s.joinRequests || [])
      : (s.joinRequests || []).filter(j => j.userId === viewerId);
    return Object.assign({}, s, { posts, logs, joinRequests });
  }
  if (tier === 'stranger') return null;

  // v250 (privacy audit finding): 'reader' exists ONLY so a published recap isn't blocked by
  // session privacy (see the comment above anyVisiblePost) — a stranger who can see just ONE
  // participant's public recap was never meant to get the rest of the session along with it. Every
  // other tier reaching this object actually has (or is being offered) a real place in the workout
  // — friend/invited are deciding whether to join, alumni actually trained it — so they keep seeing
  // the organizer's note and the location; reader does not. `suggestedEdits` (the swap-proposal
  // conversation) is unaffected by this flag — it was already, and remains, gated separately below
  // on tier === 'invited' only; friend and alumni never saw it, before or after this fix. Left
  // `participants`/`exercises` as they were for every tier including reader: exercises are needed
  // to label the one recap a reader is actually allowed to see (viewPost), and raw participant ids
  // without resolvable names (nameOf only resolves an ACTUAL friend, see its own comment) are a much
  // smaller exposure than free-text personal content — and blanking the array risks a new dishonest
  // "0 people" claim on any screen that also renders a headcount from it.
  const seesFullPlan = tier === 'friend' || tier === 'invited' || tier === 'alumni';
  // The plan, and nothing that belongs to the people doing it.
  const view = {
    id: s.id, creatorId: s.creatorId, scheduledAt: s.scheduledAt, status: s.status,
    visibility: s.visibility, name: s.name, location: seesFullPlan ? s.location : undefined,
    lengthMin: s.lengthMin,
    creatorNote: seesFullPlan ? s.creatorNote : undefined, equipment: s.equipment || [],
    exercises: s.exercises || [], participants: s.participants || [],
    // Whether the creator has finished their own portion — not privacy-sensitive (just a
    // boolean, no one's actual data), so available to every non-member tier alike rather than
    // gated per-tier. Uses the real s.history, same source `history` below now draws its own
    // (viewer-only) slice from.
    creatorFinished: (s.history || []).some(h => h.userId === s.creatorId),
    // You are told about YOURSELF and nobody else. Emptying this entirely also erased the fact
    // that the viewer is invited, which is what the whole invitation screen keys on — "waiting on
    // you", the Respond block, and being able to suggest a swap before accepting all vanished.
    // Everyone else who was asked and has not answered is a fact about them, not about you.
    invited: (Array.isArray(s.invited) && s.invited.includes(viewerId)) ? [viewerId] : [],
    // who proposed swapping what is a conversation between the people in the workout — a stranger
    // reading a public recap was never one of them (v250: this used to include 'reader' too).
    suggestedEdits: tier === 'invited' ? (s.suggestedEdits || []) : [],
    // your OWN swap comes back; nobody else's
    variations: pickMine(s.variations, viewerId),
    attendance: {},
    // v253 (audit finding): this was unconditionally `[]` for every non-member tier, breaking the
    // same "yourself and nobody else" rule every sibling field here follows. It mattered most for
    // 'alumni' — someone who left a workout with Leave's "keep my credit" option (see the /leave
    // comment) genuinely has a history row for it, and GET /api/sessions runs every session
    // through this same function, so home()'s own `mine` filter (public/app.js) — which is what
    // decides the "Last workout: Tuesday · Pull Day" line Jeff specifically wanted kept accurate —
    // silently dropped any workout you'd kept credit for but were no longer a current participant
    // in. The credit itself was never lost server-side, it just never reached the screen that's
    // supposed to show it.
    history: (s.history || []).filter(h => h.userId === viewerId),
    // Same "yourself and nobody else" rule as `invited` above. Was unconditionally empty for
    // every non-member tier, which erased the viewer's OWN join request along with everyone
    // else's — the client had no way to tell "never asked" from "already asked, waiting on the
    // creator," so the Join in? screen could only ever offer to file a second request.
    joinRequests: (s.joinRequests || []).filter(j => j.userId === viewerId),
    logs: {},                            // NOBODY else's sets — see the reader case below
    comments: tier === 'invited' ? (s.comments || []) : [],
    posts: {},
  };
  // A published recap IS its author's sets — that is what was shared, and stripping them rendered
  // an empty record to exactly the people it was published for. Every author who has one now, not
  // just a single "the" author: a viewer sees whichever recaps their own visibility admits, and a
  // hidden placeholder (existence + visibility, no content) for the rest — same shape either tier,
  // so the client never has to special-case which one it got.
  for (const [authorId, p] of Object.entries(s.posts || {})) {
    if (canSeePostAuthor(p, authorId, viewerId, s)) {
      view.posts[authorId] = p;
      // v242: every tier this loop reaches, not just 'reader'. A friend-tier viewer admitted by
      // the very same recap visibility was still handed logs:{} and rendered "No sets logged" —
      // a false claim about someone who logged plenty. The recap's own visibility is the gate;
      // which tier the viewer happened to arrive through is not.
      if (s.logs && s.logs[authorId]) view.logs[authorId] = s.logs[authorId];
    } else {
      view.posts[authorId] = { hidden: true, visibility: p.visibility };
    }
  }
  // v242: your OWN sets come back to you on every tier — a departed viewer (alumni, or a
  // still-mutual friend who left) kept their logs stored now, and "yourself and nobody else"
  // has always been this view's rule for invited/joinRequests.
  if (s.logs && Array.isArray(s.logs[viewerId]) && s.logs[viewerId].length) view.logs[viewerId] = s.logs[viewerId];
  // "Brian's already started - 2 sets in" is the fact that decides an invitation, and it survives
  // this change. It does not need Brian's SETS to say so, only how many there were: no weights,
  // no reps, nothing that belongs on his record. Counts only, and only for someone deciding.
  if (tier === 'invited') {
    const counts = {};
    for (const [pid, arr] of Object.entries(s.logs || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;
      // v242: only CURRENT people are "already started" — a departed person's surviving sets
      // are history, not someone at the gym right now deciding your invitation for you.
      if (!((s.participants || []).includes(pid) || s.creatorId === pid)) continue;
      const per = {};
      for (const l of arr) per[l.exerciseId] = (per[l.exerciseId] || 0) + 1;
      counts[pid] = per;
    }
    view.logCounts = counts;
  }
  return view;
}

// delete a session (creator only)
// Who OTHER than me has logged sets in this workout. Only ever true for someone CURRENT: this is
// specifically "who could inherit ownership right now", and ownership can only pass to someone
// still actually here. v242: a keep-leave no longer clears your s.logs entry (sets survive so
// PRs/trends do — see /leave), so "has a logs entry" stopped implying "is still here"; current
// now means being on the live roster — a participant, or the creator.
function othersWhoLogged(s, meId) {
  return Object.keys(s.logs || {}).filter(uid => uid !== meId
    && ((s.participants || []).includes(uid) || s.creatorId === uid)
    && (s.logs[uid] || []).length);
}
// v187 (Leave Workout redesign): the broader "does anyone ELSE have a real stake in this workout"
// check — CURRENT logged credit (othersWhoLogged) OR a permanent history row left behind by
// someone who already departed. othersWhoLogged alone missed a departed participant's credit
// entirely (leaving clears s.logs but, since this redesign, no longer clears s.history), which
// let DELETE erase a training partner's earned record just because they weren't around anymore
// to be counted, and let /leave's own "nobody else, delete instead" guard dead-end a creator whose
// only remaining connection to their own workout was someone who had already left.
function othersWithCredit(s, meId) {
  const ids = new Set(othersWhoLogged(s, meId));
  for (const h of (s.history || [])) if (h.userId !== meId) ids.add(h.userId);
  return [...ids];
}

// Record ONE user's own completion of this workout — a history row scoped to them alone. Used by
// /lock (Log & Finish), which is now per-person rather than a group lock. Idempotent per user:
// never pushes a second row for someone who already has one, so tapping Finish twice cannot
// inflate their own workout count, streak or weekly volume. Mutates s.history in place; callers
// are responsible for save(DB).
// v247: `date` used to always be new Date().toISOString().slice(0,10) — the server's UTC calendar
// day, not the user's. There's no stored per-user timezone (see the streak-reminder note above
// STREAK_REMINDER_HOUR_UTC), but the browser tapping Finish already knows its own local day, so
// the client sends it and the server trusts it when it looks like a real date — falling back to
// the old UTC-today behavior for anything missing or malformed, which is exactly what every
// pre-v247 client still sends. Without this, anyone west of UTC finishing an evening workout (US
// evening is already "tomorrow" in UTC) got it credited to the wrong calendar day — corrupting
// their streak and weekly volume, not just a cosmetic label.
// isValidLocalDateStr (not just LOCAL_DATE_RE, see currentStreak above) also rejects a
// regex-shaped but impossible date (2026-13-45, 2026-02-30) and an absurd year — a value like that
// would otherwise permanently corrupt this one row's sort position (a future date sorts above
// everything, forever) rather than just falling back like a merely-missing one does.
function creditFinish(s, userId, localDate) {
  if (s.history.some(h => h.userId === userId)) return false;
  const exNames = s.exercises.map(e => {
    const v = s.variations[e.id] && s.variations[e.id][userId];
    return v ? v.swapTo : e.name;
  });
  const mgs = new Set();
  for (const n of exNames) {
    const lib = EX_LIB.find(x => x.name === n);
    if (lib) lib.muscle_groups.forEach(m => mgs.add(m));
  }
  const date = isValidLocalDateStr(localDate) ? localDate : new Date().toISOString().slice(0, 10);
  s.history.push({ userId, date, muscleGroups: [...mgs], exercises: exNames });
  return true;
}

app.delete('/api/sessions/:id', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'not yours' });
  // Delete is creator-only, which sounds safe — but a workout holds EVERYONE's sets, so deleting
  // it took a training partner's history with it, silently and with no undo. Declining an invite
  // already removes only you; delete now behaves the same way once anyone else is involved.
  // othersWithCredit, not othersWhoLogged — a partner who already left with credit kept is not
  // around to lose "logged sets" today, but the permanent record of them training here is still
  // real, and delete would erase it just as surely as if they were still a current participant.
  const others = othersWithCredit(s, req.userId);
  if (others.length) {
    const names = others.map(id => (DB.users[id] && (DB.users[id].displayName || DB.users[id].username)) || 'someone');
    return res.status(409).json({
      error: `${names.join(' and ')} logged sets in this workout. Deleting it would erase their training history too.`,
      othersLogged: others.length, canLeave: true });
  }
  delete DB.sessions[req.params.id];
  rebuildAllPrs();     // the records were built from sets that no longer exist
  await save(DB);
  res.json({ ok: true });
});

// Take yourself out of a shared workout without destroying it for the people still in it.
// Removes your live participation and your in-progress sets always. Whether your PERMANENT
// credit (history row) survives is your own choice via `keep` — see the v187 redesign note below.
app.post('/api/sessions/:id/leave', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  // You can only leave something you are in. Without this, any account could name any session id
  // and trigger a full PR rebuild and a whole-database write.
  if (!(s.participants || []).includes(req.userId) && s.creatorId !== req.userId)
    return res.status(403).json({ error: 'not in this workout' });
  const me = req.userId;
  // v187: broader than the old othersWhoLogged-only check — a departed partner's history-only
  // credit is still a real reason this workout needs to survive, even though they are not around
  // to be counted as someone who "has logged" today. Without this, a creator whose only remaining
  // connection to their own workout was someone who had already left got dead-ended: DELETE
  // refuses (that partner's credit blocks it), and the old narrower check here ALSO refused,
  // with no path forward at all.
  const others = othersWithCredit(s, me);
  if (!others.length && s.creatorId === me)
    return res.status(400).json({ error: 'Nobody else has logged in this workout — delete it instead.' });

  // v187 (Leave Workout redesign), Jeff Aug 19-20: "the leave button... simply just logs the
  // current sets you have" — keep credits you exactly like tapping Log & Finish would have,
  // right before you go. creditFinish is idempotent, so this is always safe to call even if you
  // already finished earlier — it will never push a second row or touch anyone else's credit.
  // Only an EXPLICIT keep:false (the "off day, I want out entirely" case) skips it — keep
  // defaults to true (favoring not silently losing data) for any caller that doesn't say
  // otherwise, e.g. a bare {} body hitting this endpoint directly. The client never relies on
  // that default though: Jeff Aug 20's cold-review catch was the client silently posting {} and
  // getting this default applied without ever asking, so both leaveWorkout call sites (the Leave
  // button and Delete's canLeave fallback) always route through the Save/Discard sheet and send
  // an explicit true or false — the default here only fires for a direct API caller.
  const discard = !!(req.body && req.body.keep === false);
  if (!discard) creditFinish(s, me, req.body && req.body.localDate);

  // v242 (Jeff's list): your logged sets now SURVIVE a keep-leave. They used to be deleted
  // unconditionally here, and since PRs, the strength trend, progression recommendations and
  // (until v241) days-trained are ALL rebuilt from session logs, choosing "Keep my credit" and
  // leaving still silently erased every PR you set in that workout. Keep means keep: the sets
  // stay stored (sessionView decides who may still SEE them — for everyone else you simply show
  // as departed), your swaps stay too (rebuildAllPrs attributes a set through s.variations, so
  // deleting your swap would re-file those sets under the wrong exercise). Discard is still a
  // real discard: "off day, I want out entirely" deletes the sets, and with them the PRs/trend
  // points they fed — no credit means no credit.
  if (discard) {
    if (s.logs) delete s.logs[me];
    for (const exId of Object.keys(s.variations || {})) {
      if (s.variations[exId]) delete s.variations[exId][me];
    }
  }
  s.participants = (s.participants || []).filter(x => x !== me);
  s.invited      = (s.invited || []).filter(x => x !== me);
  // v242 (cold-review catch): leaving withdraws your still-PENDING swap suggestions. Sets now
  // survive a keep-leave, and the approve route deliberately renames the proposer's already-
  // logged sets for that exercise (a swap approval is a statement of what was performed) — so a
  // creator approving a stale pending swap months later would silently rewrite a departed
  // person's kept sets and PRs with no involvement from them. An APPROVED swap stays: it was
  // settled while they were here, and the kept s.variations entry is what attributes their
  // surviving sets to the lift they actually did.
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === me && e.status === 'pending'));
  // v248 (audit finding): joinRequests was never touched by leaving. POST /log and POST /suggest
  // both treat "an APPROVED join request exists for this user" as authorization on its own,
  // independent of s.participants — that's the door someone who joined via request came in
  // through. Leaving removed them from s.participants but left that request sitting at
  // status:'approved' forever, so it kept working as a standing key: a departed join-requester
  // could still log sets into (and suggest swaps on) a workout they had just left. It also meant
  // tapping "Join in?" again afterwards (see /join above: any existing row, approved or not, just
  // flips to 'pending' and re-notifies the creator) silently reopened a stale approved request
  // instead of filing an honest new one. Leaving now clears the request itself — same "only your
  // own stuff" scope as everything else here — so nothing is left behind to authorize against,
  // and asking back in starts a clean request like anyone else's first ask.
  s.joinRequests = (s.joinRequests || []).filter(j => j.userId !== me);
  // history is deliberately NOT touched here anymore. The old code unconditionally stripped your
  // own history row on leave, which meant choosing to Keep your credit and then leaving erased
  // that same credit in the very same request — and any ALREADY-earned credit from finishing
  // earlier vanished the moment you left too, even though you never asked for that. Whatever
  // history you have — old, or just added by `keep` above — is permanent now, same as anyone
  // else's, and is exactly what lets you still find this workout later (see the new 'alumni'
  // sessionTier below).
  if (s.attendance) delete s.attendance[me];
  // If the creator walks away, the workout needs a new owner or nobody can ever finish or edit
  // it. Ownership can only pass to someone CURRENT, never a departed alumni — a departed person
  // is not here to own anything. If nobody current is left either, creatorId goes explicitly null
  // rather than pointing at nobody: it still displays and can still be reopened by anyone with a
  // real connection to it (an alumni history row, a friend, and so on), it just has no one who can
  // edit or delete it until someone new takes it over — which nothing in this codebase currently
  // does, so today that means never; an orphaned workout stays exactly as it was left.
  if (s.creatorId === me) {
    // v253 (audit finding): this used to be othersWhoLogged(s, me) alone with nothing to fall
    // back to — which only counts a CURRENT participant who has already logged at least one set.
    // A participant who accepted an invite but hasn't logged anything yet (the workout hasn't
    // started, or they simply haven't gotten to their exercise) is every bit as CURRENT as one who
    // has, but was invisible to this check — so the creator leaving handed the workout to nobody
    // (creatorId: null, permanently unowned per the comment above) even though a real person was
    // still sitting right there in s.participants. Prefer someone who's actually logged something
    // (more likely to still be actively training it right now); fall back to any other current
    // participant rather than orphaning the workout for no reason.
    const currentOthers = othersWhoLogged(s, me);
    // s.participants was already filtered to exclude `me` above, so this is every OTHER current
    // participant, logged or not.
    s.creatorId = currentOthers.length ? currentOthers[0] : (s.participants.length ? s.participants[0] : null);
    if (s.creatorId && !s.participants.includes(s.creatorId)) s.participants.push(s.creatorId);
  }
  rebuildAllPrs();
  await save(DB);
  res.json({ ok: true, left: true });
});

// Jeff, Aug 28: "Once its posted on my page - I want to be able to delete it off my page." This
// is deliberately NOT built on top of /leave above: /leave (v187) exists specifically to KEEP your
// history/credit when you step away -- the comment above it explains that an earlier version which
// erased history on leave was a real bug, fixed on purpose. This route is the opposite of that by
// design: erase MY OWN post, logged sets, and history credit for this session entirely, so it's
// genuinely gone from my profile. It never touches the creator's or any other participant's data --
// same "only your own stuff" guarantee /leave already gives, just going one step further for anyone
// who explicitly wants their own trace of this workout gone, not just archived. Ownership hand-off
// on creatorId, if the caller happens to be the creator, mirrors /leave exactly.
app.post('/api/sessions/:id/remove-mine', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const me = req.userId;
  const hasConnection = (s.participants || []).includes(me) || s.creatorId === me
    || (s.posts && s.posts[me]) || (s.history || []).some(h => h.userId === me) || (s.logs && s.logs[me]);
  if (!hasConnection) return res.status(403).json({ error: 'not yours' });
  if (s.posts) delete s.posts[me];
  if (s.logs) delete s.logs[me];
  s.participants = (s.participants || []).filter(x => x !== me);
  s.invited = (s.invited || []).filter(x => x !== me);
  s.history = (s.history || []).filter(h => h.userId !== me);
  if (s.attendance) delete s.attendance[me];
  for (const exId of Object.keys(s.variations || {})) {
    if (s.variations[exId]) delete s.variations[exId][me];
  }
  // v248: same joinRequests cleanup as /leave (see the comment above it) — this route is meant to
  // erase every trace of me on this session, so a leftover approved join request quietly granting
  // /log or /suggest access afterwards is the one thing that would be even more wrong here than there.
  s.joinRequests = (s.joinRequests || []).filter(j => j.userId !== me);
  // v250 (audit finding): /leave withdraws a still-pending swap suggestion when you go (see the
  // comment above its own suggestedEdits filter) but this route — meant to erase EVERY trace of me,
  // stronger than /leave — never did. A pending suggestion left behind here could still be approved
  // later, which rewrites the proposer's logged sets for that exercise; with everything else about
  // me already gone from this session, that's a swap credited to someone with no footprint left to
  // have actually proposed it. An approved one stays, same reasoning as /leave: it was settled while
  // I was still here.
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === me && e.status === 'pending'));
  if (s.creatorId === me) {
    const currentOthers = othersWhoLogged(s, me);
    s.creatorId = currentOthers.length ? currentOthers[0] : null;
    if (s.creatorId && !s.participants.includes(s.creatorId)) s.participants.push(s.creatorId);
  }
  rebuildAllPrs();
  await save(DB);
  res.json({ ok: true, removed: true });
});

// update a session (creator only): name/time/location/note/visibility/exercises/invites
//
// Jeff, Aug 28, first asked to edit a workout posted on his profile even when he wasn't the
// creator, "just as if i was." His very next message narrowed that: "I don't want to change the
// exercises - just my logged sets" plus photos/notes/deleting it off his own page. So this stays
// creator-only exactly as it always was -- editing the shared exercise list/session details is a
// session-wide change everyone else is counting on, and Jeff's own follow-up confirmed he didn't
// actually want that. What he DID want lives elsewhere: editing your own logged sets is already
// self-scoped and needs no permission change (PUT /api/sessions/:id/log/:logId, keyed off
// s.logs[req.userId]); notes/photos go through POST /api/sessions/:id/post, keyed off your own
// post; and removing a workout from your own profile entirely is the new
// POST /api/sessions/:id/remove-mine below. None of those touch this route.
app.put('/api/sessions/:id', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'not yours' });
  const b = req.body || {};
  if (typeof b.name === 'string') s.name = capStr(b.name, 80).trim();
  if (b.scheduledAt) s.scheduledAt = capStr(b.scheduledAt, 40);
  if (typeof b.location === 'string') s.location = capStr(b.location, 120);
  if ('lengthMin' in b) s.lengthMin = numIn(b.lengthMin, 1440) || null;
  if (typeof b.creatorNote === 'string') s.creatorNote = capStr(b.creatorNote, 2000);
  if (b.visibility) s.visibility = b.visibility === 'public' ? 'public' : 'private';
  if (Array.isArray(b.exercises)) {
    // v253 (audit finding, see isPlainExercise above) -- a non-object element would have
    // thrown, both at `e.id` right below and inside withDefaults, returning a generic 500.
    if (!b.exercises.every(isPlainExercise)) return res.status(400).json({ error: 'invalid exercise' });
    s.exercises = b.exercises.map((e, i) => Object.assign({
      id: (e.id && s.exercises.find(x => x.id === e.id)) ? e.id : 'e_' + uid(),
      order: i,
    }, withDefaults(e)));
  }
  if (Array.isArray(b.inviteUsernames)) {
  const invites = [];
  const myConnections = connectionsOf(req.userId);
  for (const un of b.inviteUsernames) {
    const f = myConnections.find(fid => normUser(DB.users[fid] && DB.users[fid].username) === normUser(un));
    if (f) invites.push(f);
  }
  // v251 (audit finding): same gap as /decline just above -- the creator re-editing the invite
  // list can silently drop someone who has a pending swap suggestion in, same as them declining
  // outright. Whoever falls out of the invite list this way loses that pending suggestion too.
  const dropped = (s.invited || []).filter(uid => !invites.includes(uid));
  if (dropped.length) {
    s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(dropped.includes(e.proposedBy) && e.status === 'pending'));
  }
  s.invited = invites;
  }
  s.updatedAt = new Date().toISOString();
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// accept an invite (move from invited[] to participants[])
app.post('/api/sessions/:id/accept', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  s.invited = s.invited.filter(x => x !== req.userId);
  if (!s.participants.includes(req.userId)) s.participants.push(req.userId);
  await save(DB);
  notify(s.creatorId, { title: 'Invite accepted', body: `${DB.users[req.userId].displayName} joined your workout` });
  res.json(sessionView(s, req.userId));
});

// decline an invite (remove from invited[], do not join)
app.post('/api/sessions/:id/decline', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  s.invited = s.invited.filter(x => x !== req.userId);
  // v251 (audit finding): /suggest allows a still-invited (not yet accepted) person to propose a
  // swap before deciding -- that's the whole point of letting an invite hold a suggestion (see the
  // comment there). Declining used to leave that pending suggestion behind, same root cause as
  // /leave, remove-mine and stripUserFromSession all already guard against: a pending swap outranks
  // everything else on an exercise card (app.js's pendingSwap/offerSwap), so it silently blocked
  // every OTHER invitee from proposing their own swap on that exercise for someone no longer even
  // connected to the session -- and if the creator approved it anyway, notified the decliner about
  // a workout they said no to. An approved one stays, same reasoning as those three: it was settled
  // while they were still deciding.
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === req.userId && e.status === 'pending'));
  // v253 (audit finding): same root cause as the suggestedEdits fix just above, and the same gap
  // /leave's own comment already documents fixing for itself (v248) — /join lets a friend request
  // to join a session independently of any invitation, so someone can be BOTH invited AND holding
  // a join request at once. Declining the invite never touched that request, so a still-PENDING
  // one sat there as a standing "approve me" button the creator could tap later and silently add
  // back someone who had explicitly said no. An already-APPROVED request stays, same reasoning as
  // /leave: it was settled while they were still around, not left dangling.
  s.joinRequests = (s.joinRequests || []).filter(j => !(j.userId === req.userId && j.status === 'pending'));
  await save(DB);
  notify(s.creatorId, { title: 'Invite declined', body: `${DB.users[req.userId].displayName} declined your workout` });
  res.json(sessionView(s, req.userId));
});

// suggest a swap (any participant; also join-requester after approval)
app.post('/api/sessions/:id/suggest', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  // Participant, approved join-requester, OR someone still holding an invitation. That last one
  // is the whole point: "I'll come if we swap Barbell Row" is a thing you say BEFORE you accept,
  // and until now the server refused it, so the answer was accept-blind-then-ask.
  const isParticipant = s.participants.includes(req.userId);
  const approvedJoin = s.joinRequests.find(j => j.userId === req.userId && j.status === 'approved');
  const invited = Array.isArray(s.invited) && s.invited.includes(req.userId);
  if (!isParticipant && !approvedJoin && !invited) return res.status(403).json({ error: 'not a participant' });
  // Jeff, Aug 31: "add the ability to add an exercise to a workout, not just suggest a swap."
  // Same approval-gated shape a swap suggestion already has (creator still decides) -- just
  // proposing a brand-new exercise instead of replacing an existing one, so there's no exerciseId
  // here the way a swap always has one. type defaults to 'swap' so every pre-existing client call
  // (which never sent a type at all) and every already-stored suggestedEdits row keep working
  // exactly as before -- the approve handler below treats a missing/non-'add' type as a swap.
  const type = (req.body || {}).type === 'add' ? 'add' : 'swap';
  // Deliberately narrower than the swap check just above: Jeff, same thread, clarifying the scope
  // -- "anyone that is already accepted and part of the workout ... can suggest to add an
  // exercise." A swap targets something already on the plan, which is exactly the case someone
  // still deciding whether to come needs to raise before accepting; proposing a brand-new
  // exercise isn't that -- it's shaping a workout you're not confirmed into yet, so this stays
  // restricted to isParticipant/approvedJoin. Still-invited (not yet accepted) is refused here.
  if (type === 'add' && !isParticipant && !approvedJoin) return res.status(403).json({ error: 'accept the invite first' });
  let edit;
  if (type === 'add') {
    const name = capStr((req.body || {}).name, 80).trim();
    if (!name) return res.status(400).json({ error: 'needs a name' });
    edit = { id: 'se_' + uid(), type: 'add', exerciseId: null, proposedBy: req.userId, swapTo: name, status: 'pending' };
  } else {
    const exerciseId = capStr((req.body || {}).exerciseId, 64);
    const swapTo = capStr((req.body || {}).swapTo, 80);
    edit = { id: 'se_' + uid(), type: 'swap', exerciseId, proposedBy: req.userId, swapTo, status: 'pending' };
  }
  s.suggestedEdits.push(edit);
  await save(DB);
  // notify creator
  notify(s.creatorId, type === 'add'
    ? { title: 'Exercise suggested', body: `${DB.users[req.userId].displayName} suggested adding ${edit.swapTo}` }
    : { title: 'Swap suggested', body: `${DB.users[req.userId].displayName} suggested swapping to ${edit.swapTo}` });
  res.json(sessionView(s, req.userId));
});

app.post('/api/sessions/:id/suggest/:editId/approve', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  // v252 (audit finding): without this, a double-tap or a stale second tab could approve AND
  // reject the same suggestion -- approve already renames logged sets and rebuilds PRs below, none
  // of which reject undoes, so the edit would end up marked 'rejected' while its effects were still
  // live and the proposer had already been told (wrongly) it was approved. Once it's no longer
  // pending, neither route touches it again.
  if (edit.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  edit.status = 'approved';
  if (edit.type === 'add') {
    // A brand-new exercise, not a rename of an existing one -- there's no s.variations entry or
    // anyone's already-logged sets to touch the way a swap approval below does; it's simply
    // appended to the shared list, same id/order shape POST /api/sessions and PUT /api/sessions/:id
    // already give a new exercise.
    const newEx = Object.assign({ id: 'e_' + uid(), order: s.exercises.length }, withDefaults({ name: edit.swapTo }));
    s.exercises.push(newEx);
    await save(DB);
    notify(edit.proposedBy, { title: 'Exercise added', body: `${DB.users[s.creatorId].displayName} added ${edit.swapTo} to the workout` });
    return res.json(sessionView(s, req.userId));
  }
  s.variations[edit.exerciseId] = Object.assign({}, s.variations[edit.exerciseId], { [edit.proposedBy]: { swapTo: edit.swapTo, reason: 'swap' } });
  // Sets now carry the exercise name frozen at log time, which is what stops an unrelated edit
  // rewriting history. Approving a swap is not unrelated — it is a deliberate statement of what
  // was actually performed — so it corrects the name on that person's already-logged sets for
  // this exercise. Without this, logging first and approving the swap afterwards left the sets
  // filed under the lift they did not do. Nobody else's sets are touched.
  const already = (s.logs && s.logs[edit.proposedBy]) || [];
  let renamed = 0;
  for (const l of already) {
    if (l.exerciseId !== edit.exerciseId) continue;
    if (l.exerciseName === edit.swapTo) continue;
    l.exerciseName = edit.swapTo; renamed++;
  }
  if (renamed) rebuildAllPrs();            // the records are grouped by that name
  await save(DB);
  notify(edit.proposedBy, { title: 'Swap approved', body: `${DB.users[s.creatorId].displayName} approved your swap to ${edit.swapTo}` });
  res.json(sessionView(s, req.userId));
});

app.post('/api/sessions/:id/suggest/:editId/reject', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  // v252: same guard as approve above -- a stale reject after it's already been approved (or
  // already rejected) must not silently flip a decided edit back and forth.
  if (edit.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  edit.status = 'rejected';
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// join request (public-visibility sessions)
app.post('/api/sessions/:id/join', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  // "not joinable" tested a property of the WORKOUT and never asked anything about the caller, so
  // any logged-in account could ask to join any public-visibility workout and the reply handed
  // back the entire thing — everyone's sets, the whole chat, the post, the invite list, and other
  // people's join requests with their notes. Rejecting them afterwards changed nothing; they
  // already had it. Asking to join is now something only people who can see the creator's profile
  // can do (canSeeProfile — same rule as everything else, Sep 2026), and the reply says nothing
  // except that the request was filed.
  if (!s || s.visibility !== 'public') return res.status(400).json({ error: 'not joinable' });
  if (s.creatorId !== req.userId && !canSeeProfile(s.creatorId, req.userId))
    return res.status(403).json({ error: 'forbidden' });
  // Already in it (an approved request, or invited-and-accepted separately) — nothing to request.
  // Without this, a stale "Join in?" screen (a second tab, or approval that landed while this one
  // was still open) could re-fire, flip an already-approved request back to 'pending', and spam
  // the creator with a "wants to join" notification for someone already training with them.
  if ((s.participants || []).includes(req.userId)) return res.status(400).json({ error: 'already in this workout' });
  // Reuse one request per (session, user) rather than piling up a new row every time — a
  // rejected request used to permanently block asking again (the dedupe check below matched ANY
  // status, pending or not), which silently locked someone out of a workout forever the moment
  // the creator declined once, with no way back in and no indication that was even what happened.
  // Flipping the existing row back to 'pending' also means the client only ever needs to look at
  // ONE entry per user, never guess which of several rows for the same person is the current one.
  let jr = s.joinRequests.find(j => j.userId === req.userId);
  if (jr && jr.status === 'pending') return res.status(400).json({ error: 'already requested' });
  const note = capStr((req.body||{}).note, 500);
  if (jr) { jr.status = 'pending'; jr.note = note; }
  else { jr = { id: 'jr_' + uid(), userId: req.userId, note, status: 'pending' }; s.joinRequests.push(jr); }
  await save(DB);
  notify(s.creatorId, { title: 'Join request', body: `${DB.users[req.userId].displayName} wants to join your workout` });
  res.json({ ok: true, requested: true });     // the answer to "may I join" is not the workout
});

app.post('/api/sessions/:id/join/:reqId/approve', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const jr = s.joinRequests.find(j => j.id === req.params.reqId);
  if (!jr || s.creatorId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  // v252 (audit finding): same missing-status-guard shape as suggest/approve+reject above -- a
  // double-tap or stale second tab could approve AND reject the same join request, leaving the
  // requester added to participants while the request itself reads 'rejected' (or vice versa).
  if (jr.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  jr.status = 'approved';
  if (!s.participants.includes(jr.userId)) s.participants.push(jr.userId);
  await save(DB);
  notify(jr.userId, { title: 'Join approved', body: `${DB.users[s.creatorId].displayName} approved your join request` });
  res.json(sessionView(s, req.userId));
});

app.post('/api/sessions/:id/join/:reqId/reject', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const jr = s.joinRequests.find(j => j.id === req.params.reqId);
  if (!jr || s.creatorId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  // v252: same guard as approve above.
  if (jr.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  jr.status = 'rejected';
  await save(DB);
  notify(jr.userId, { title: 'Join declined', body: `${DB.users[s.creatorId].displayName} declined your join request` });
  res.json(sessionView(s, req.userId));
});

// attendance
app.post('/api/sessions/:id/attendance', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!s.participants.includes(req.userId)) return res.status(403).json({ error: 'forbidden' });
  s.attendance[req.userId] = capStr((req.body||{}).status, 20) || 'in';
  await save(DB);
  res.json(sessionView(s, req.userId));
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

app.post('/api/me/units', auth, async (req, res) => {
  const u = (req.body || {}).units;
  if (u !== 'lb' && u !== 'kg') return res.status(400).json({ error: 'units must be lb or kg' });
  DB.users[req.userId].units = u;
  await save(DB);
  res.json({ units: u });
});

// Task #63: in-app toggle for the streak-loss push reminder. Unset (never touched) reads as ON —
// new and existing accounts alike get the reminder by default, same call CLAUDE.md's "Lead, don't
// just execute" made for defaulting this feature on: it is inert with no cost unless the user has
// already separately granted push permission (setupPush() in app.js), so defaulting on only ever
// matters for someone who would actually receive it.
//
// Aug 31: generalized to also carry `workoutReminders` (the "you have a workout scheduled today"
// push, see usersWithWorkoutToday()/the boot-time interval below) — same on-by-default reasoning,
// same shape. Each field is independently optional so an old client sending only `streakReminders`
// keeps working exactly as before; at least one of the two must be present.
app.post('/api/me/notify-prefs', auth, async (req, res) => {
  const body = req.body || {};
  const hasStreak = 'streakReminders' in body, hasWorkout = 'workoutReminders' in body;
  if (!hasStreak && !hasWorkout) return res.status(400).json({ error: 'streakReminders or workoutReminders required' });
  if (hasStreak && typeof body.streakReminders !== 'boolean') return res.status(400).json({ error: 'streakReminders must be true or false' });
  if (hasWorkout && typeof body.workoutReminders !== 'boolean') return res.status(400).json({ error: 'workoutReminders must be true or false' });
  const out = {};
  if (hasStreak) { DB.users[req.userId].notifyStreakReminders = body.streakReminders; out.streakReminders = body.streakReminders; }
  if (hasWorkout) { DB.users[req.userId].notifyWorkoutReminders = body.workoutReminders; out.workoutReminders = body.workoutReminders; }
  await save(DB);
  res.json(out);
});

// Task #64, Jeff Aug 21: "Can you delete all of my workouts and history to let me start over?"
// Strips every trace of one user's OWN training from a session — logs, participation, history
// credit, their own recap — without touching anyone else's. Unlike /leave, this always removes
// history too: reset means "nothing I logged happened," not "keep my credit around."
function stripUserFromSession(s, userId) {
  if (s.logs) delete s.logs[userId];
  s.participants = (s.participants || []).filter(x => x !== userId);
  s.invited      = (s.invited || []).filter(x => x !== userId);
  s.history      = (s.history || []).filter(h => h.userId !== userId);
  if (s.attendance) delete s.attendance[userId];
  if (s.posts) delete s.posts[userId];
  for (const exId of Object.keys(s.variations || {})) {
    if (s.variations[exId]) delete s.variations[exId][userId];
  }
  // v249 (audit finding, same root cause as /leave's joinRequests fix above): an approved join
  // request is a standing authorization on its own for POST /log and POST /suggest (see
  // canFinishOrPost's sibling check there), independent of s.participants — "strips every trace"
  // was not true while that row could still be sitting there afterward, letting a reset user keep
  // writing into a session /me/reset-workouts was supposed to have erased them from entirely.
  s.joinRequests = (s.joinRequests || []).filter(j => j.userId !== userId);
  // v250 (audit finding, same root cause again): a still-pending swap suggestion is the other
  // standing reference "strips every trace" missed — /leave withdraws it (see the comment above its
  // own suggestedEdits filter) but this shared helper never did, even though reset's own comment
  // above this function says history is ALWAYS cleared here, stronger than /leave. Left behind, it
  // could still be approved later and rewrite logged sets attributed to a user this function just
  // erased every other trace of. An approved one stays — it was settled before the reset.
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === userId && e.status === 'pending'));
}

// Scoped to req.userId ONLY — never a body param, so this can never be pointed at anyone else,
// spoofed userId in the body or not. Account identity (username, login, friends) is untouched;
// that was Jeff's own explicit choice when asked what "start over" should mean — only what he
// actually LOGGED disappears. Requires an explicit confirm:true so a bare/misfired POST can never
// silently wipe someone's training history.
//
// For every session this user has any real footprint in (current participant, creator, or a
// history-only alumni row): if they're the creator and nobody else has real credit
// (othersWithCredit — same rule DELETE and /leave already use), the whole session is theirs alone
// and gets hard-deleted. If they're the creator and someone else DOES have credit, ownership hands
// off to a current credit-holder (same deterministic rule /leave uses — never Jeff, never a coin
// flip), creatorId going explicitly null if nobody current remains, and their own trace is
// stripped from the now-handed-off session. If they're not the creator, the session and its actual
// owner are left completely alone — only their own trace is stripped out of it.
app.post('/api/me/reset-workouts', auth, async (req, res) => {
  if (!(req.body && req.body.confirm === true))
    return res.status(400).json({ error: 'confirm:true is required to reset your workouts' });
  const me = req.userId;
  let sessionsDeleted = 0, sessionsHandedOff = 0, sessionsCleared = 0;
  for (const s of Object.values(DB.sessions)) {
    ensureSessionShape(s);
    const isCreator = s.creatorId === me;
    // v249 (audit finding): this used to miss s.posts[me]/s.logs[me] — unlike remove-mine's own
    // hasConnection check just above, which already covers both. A discard-leave (keep:false)
    // deletes s.logs[me] and removes participants/invited, but a recap posted BEFORE that leave
    // (s.posts[me]) is untouched by it (see the comment above /leave: discard only ever erases
    // logs/variations, never a recap), and discard skips creditFinish so no history row exists
    // either. That combination — no participants, no invited, no history, but a real recap still
    // sitting on the session — read as "not touched" and reset-workouts skipped it entirely,
    // leaving that stale recap fully visible after a user asked to erase everything they'd logged.
    const isTouched = isCreator
      || (s.participants || []).includes(me)
      || (s.invited || []).includes(me)
      || (s.history || []).some(h => h.userId === me)
      || (s.posts && s.posts[me])
      || (s.logs && s.logs[me]);
    if (!isTouched) continue;
    if (isCreator) {
      const others = othersWithCredit(s, me);
      if (!others.length) {
        delete DB.sessions[s.id];
        sessionsDeleted++;
        continue;
      }
      const currentOthers = othersWhoLogged(s, me);
      stripUserFromSession(s, me);
      s.creatorId = currentOthers.length ? currentOthers[0] : null;
      if (s.creatorId && !s.participants.includes(s.creatorId)) s.participants.push(s.creatorId);
      sessionsHandedOff++;
    } else {
      stripUserFromSession(s, me);
      sessionsCleared++;
    }
  }
  rebuildAllPrs();     // every record was built from logs that may no longer be theirs
  await save(DB);
  res.json({ ok: true, sessionsDeleted, sessionsHandedOff, sessionsCleared });
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
// Only consumer: recommendationsFor() below -- safe to shape this purely for that purpose.
function sessionsForUser(userId) {
  const out = [];
  for (const s of Object.values(DB.sessions)) {
    if (!s.logs || !s.logs[userId] || !s.logs[userId].length) continue;
    const byName = {};
    for (const l of s.logs[userId]) {
      if (!isWorkingSet(l)) continue;               // warm-ups and drop sets are not working sets
      // Jeff, Aug 22: "the weight to add next should focus only on full sets, not any with an
      // RIR." An RIR-tagged set is excluded entirely, not just deprioritized -- if every set for
      // an exercise this session carried RIR, this session contributes no evidence either way for
      // that exercise, same as if it had never been logged.
      if ('rir' in l) continue;
      const name = logExerciseName(s, l, userId);
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
// Jeff, Sep 2: "It says I have a 3 week streak - yet I haven't worked out for 3 weeks straight."
// Root cause, confirmed by reproducing his exact scenario: this function predates v247 (see the
// comment above isValidLocalDateStr) and was never included in that fix. v247 stamped every
// session-history row with the PERSON'S OWN local calendar day at the moment they hit Finish
// (creditFinish's `date`, below) specifically so an evening workout for anyone west of UTC
// doesn't roll into "tomorrow" against the server's clock -- currentStreak/trainedToday/profileOf
// all read h.date for exactly that reason. This function still derived the trained day from
// s.scheduledAt/perfDate (the ORIGINAL pre-v247 approach) AND still measured "today"/the start of
// this week from the server's bare UTC clock instead of an optional localToday -- so a workout
// whose scheduled timestamp crossed a UTC day/week boundary differently than the user's own local
// day could land in the wrong weekly bucket, silently inflating (or shrinking) the Consistency
// streak. Fixed the same way currentStreak was: prefer h.date when a history row exists (a
// logged-but-not-yet-finished session has no h.date yet, so it still falls back to scheduledAt --
// there is no better source for that case), and accept an optional localToday for the week
// boundary itself.
function weeksFor(userId, count, localToday) {
  const days = new Set();
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    const worked = !!(mine && mine.some(isWorkingSet));
    // v241 (Jeff's list): finish credit counts as a trained day too. /leave deletes your own
    // s.logs entry but deliberately keeps your history row, so a workout you logged, finished
    // and then left silently vanished from days trained, this week and the streak. A history row
    // is this codebase's permanent record that you trained here -- it is what blocks DELETE from
    // erasing you (othersWithCredit) and what the alumni tier is built on -- so it is exactly as
    // countable as a working set.
    const hist = (s.history || []).find(h => h.userId === userId);
    if (!worked && !hist) continue;
    days.add(hist ? hist.date : perfDate(s.scheduledAt).slice(0, 10));
  }
  const today = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  const [ty, tm, td] = today.split('-').map(Number);
  const monday = new Date(Date.UTC(ty, tm - 1, td));
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

// ---- Weekly volume per muscle group --------------------------------------------------------
// Jeff, Aug 31: the Progress page tracks WHEN you trained and single-lift trend, but never WHAT
// muscle groups you've actually been training — imbalance is invisible. Meter/progress-bar rows
// against a target, one per muscle group, using the same "sensible default, adjustable later"
// call as everywhere else that has to pick a number nobody's told us yet. These are a general
// hypertrophy guideline (working sets/week land roughly 10-20 across the literature; these sit
// in that range, weighted a little higher for the muscles most programs bias toward) — not a
// personal prescription, and the Progress page says so. Cardio is excluded: it isn't a
// sets-against-a-target thing the way resistance work is.
const MUSCLE_TARGETS = {
  chest: 12, lats: 12, shoulders: 12, traps: 8, biceps: 10, triceps: 10, forearms: 6,
  quads: 12, hamstrings: 10, glutes: 10, calves: 10, abdominals: 10
};
const MUSCLE_ORDER = Object.keys(MUSCLE_TARGETS);

// Custom exercises (POST /api/exercises/custom) live in DB.customExercises, never merged into
// EX_LIB itself — GET /api/exercises already concats the two for display (see the `custom` const
// above). Volume needs the same reach: a set logged against someone's own custom exercise still
// targets real muscle groups and should count, not silently vanish from the meter just because
// it isn't a library stock lift.
// Cold-review catch (Aug 31): name is NOT unique, not even per-user — POST /api/exercises/custom
// enforces no uniqueness at all, and every custom exercise is visible/loggable by every OTHER user
// too (see that route's own comment). An earlier version of this scanned every user's custom list
// and returned the first name match, so two users independently naming a custom exercise the same
// common thing ("Cable Row") with different muscle_groups silently misattributed one user's
// volume to the other's target muscles. Checking the ACTING user's own list first is authoritative
// whenever they logged something they themselves created; the global fallback below only still
// matters for a custom exercise someone ELSE created that ended up on a shared session (there is
// no owner link carried onto a session's exercise list to fully disambiguate that rarer case).
function findExLibEntry(name, userId) {
  const hit = EX_LIB.find(x => x.name === name);
  if (hit) return hit;
  const mine = ((DB.customExercises || {})[userId] || []).find(x => x.name === name);
  if (mine) return mine;
  for (const arr of Object.values(DB.customExercises || {})) {
    const c = (arr || []).find(x => x.name === name);
    if (c) return c;
  }
  return null;
}

// Working sets logged THIS calendar week (Monday–Sunday UTC, same boundary weeksFor uses above),
// attributed to every muscle group the exercise targets — full credit to each, same "touch it,
// it counts" rule creditFinish already uses for history.muscleGroups, just counted in sets
// instead of "did I touch this at all."
//
// `weeks` widens the window to a trailing N-Monday-anchored span (including the current partial
// week, same "count the week you're mid-way through" precedent weeksFor already sets) and returns
// the PER-WEEK AVERAGE instead of a raw count, so it's directly comparable to the same target —
// e.g. weeks=4 answers "what has this looked like lately" without one light or one heavy week
// swinging the number. weeks=1 (the default) is untouched — same math as before this existed.
function volumeFor(userId, weeks = 1) {
  const today = new Date();
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const windowStart = new Date(monday); windowStart.setUTCDate(windowStart.getUTCDate() - 7 * (weeks - 1));
  const a = windowStart.toISOString().slice(0, 10);
  const nextWeek = new Date(monday); nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  const b = nextWeek.toISOString().slice(0, 10);
  const sets = {};
  for (const g of MUSCLE_ORDER) sets[g] = 0;
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine || !mine.length) continue;
    if (perfDate(s.scheduledAt).slice(0, 10) < a || perfDate(s.scheduledAt).slice(0, 10) >= b) continue;
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const lib = findExLibEntry(logExerciseName(s, l, userId), userId);
      if (!lib) continue;
      for (const m of (lib.muscle_groups || [])) if (sets.hasOwnProperty(m)) sets[m]++;
    }
  }
  const div = Math.max(1, weeks);
  return {
    weekOf: a, weeks,
    groups: MUSCLE_ORDER.map(g => ({
      group: g,
      sets: weeks === 1 ? sets[g] : Number((sets[g] / div).toFixed(1)),
      target: MUSCLE_TARGETS[g]
    }))
  };
}

// Aug 31: volume trend over time. volumeFor (above) is a snapshot — this week, or a rolling
// average — but Jeff asked whether Weekly volume should also show change over a longer window,
// the same question that produced the This-week/4-wk-avg toggle. This is the OTHER half of that
// answer: not a smoothed snapshot, but an actual per-week history, same shape as weeksFor's
// Consistency chart (non-overlapping Monday-anchored buckets, oldest first) instead of volumeFor's
// trailing-average window — a trend chart needs real week-by-week bars, not one blended number.
// Every muscle group gets a bucketed set count for every week in range, same "full credit to
// every muscle group the exercise targets" rule volumeFor already uses.
function volumeTrendFor(userId, weeks) {
  const today = new Date();
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(monday); start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 7);
    const sets = {}; for (const g of MUSCLE_ORDER) sets[g] = 0;
    buckets.push({ weekOf: start.toISOString().slice(0, 10), a: start.toISOString().slice(0, 10), b: end.toISOString().slice(0, 10), sets });
  }
  const a0 = buckets[0].a, bN = buckets[buckets.length - 1].b;
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine || !mine.length) continue;
    const at = perfDate(s.scheduledAt).slice(0, 10);
    if (at < a0 || at >= bN) continue;         // outside the whole range — skip the bucket scan
    const bucket = buckets.find(w => at >= w.a && at < w.b);
    if (!bucket) continue;
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const lib = findExLibEntry(logExerciseName(s, l, userId), userId);
      if (!lib) continue;
      for (const m of (lib.muscle_groups || [])) if (bucket.sets.hasOwnProperty(m)) bucket.sets[m]++;
    }
  }
  return {
    weeks: buckets.map(w => ({
      weekOf: w.weekOf,
      groups: MUSCLE_ORDER.map(g => ({ group: g, sets: w.sets[g], target: MUSCLE_TARGETS[g] }))
    }))
  };
}

// ---- Body weight tracking --------------------------------------------------------------------
// One entry per calendar day (see POST /api/me/bodyweight below — same day re-logs upsert rather
// than pile up), stored in whatever unit it was typed in exactly like a logged set, converted to
// the user's current preference on the way OUT so switching units never rewrites history.
function bodyweightFor(userId) {
  const u = DB.users[userId];
  const unit = (u && u.units) || 'lb';
  const raw = (u && Array.isArray(u.bodyweight)) ? u.bodyweight : [];
  const entries = raw.slice().sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
    .map(e => ({ date: e.date, weight: inUnit(e.weight, e.unit, unit) }));
  return { unit, entries };
}

// ---- Strength trend -----------------------------------------------------------------------
// Estimated max (Epley: w * (1 + reps/30)) converts every set to one comparable number, so a
// heavy triple and a light set of ten sit on the same line. One point per session, taken from
// that session's best working set.
//
// Bodyweight movements are excluded: they store weight 0, so Epley is 0 and the ratio maths
// below would be 0/0. They still appear in Personal Records, ranked by reps (v151).
function estMax(l) {
  const w = toLb(l.weight, l.unit);
  // Jeff, Aug 22: "I may have more in the tank on that set and stopped early. I don't want that
  // to negatively affect my strength trend." Reps actually performed plus reps held back in
  // reserve is the true capacity that set represents -- an honest 210x2 with 6 RIR scores the
  // same as a genuine 210x8, not as a false dip. Only the SCORE is adjusted; the point still
  // records the real reps performed (see trendFor) -- this function alone decides trend strength.
  const r = (Number(l.reps) || 0) + (Number(l.rir) || 0);
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
      const name = logExerciseName(s, l, userId);
      if (!perEx[name] || e > perEx[name].e) perEx[name] = { e, l };
    }
    for (const name of Object.keys(perEx)) {
      const point = {
        at: perfDate(s.scheduledAt).slice(0, 10),
        est: Math.round(perEx[name].e),
        weight: Number(perEx[name].l.weight) || 0,
        // The REAL reps performed, never the rir-adjusted count -- estMax() alone applies the
        // rir bump to the score. Client and this point both need what actually happened.
        reps: Number(perEx[name].l.reps) || 0
      };
      if (perEx[name].l.rir !== undefined) point.rir = perEx[name].l.rir;
      (byName[name] = byName[name] || []).push(point);
    }
  }
  const lifts = Object.keys(byName)
    .map(name => ({ name, points: byName[name].sort((a, b) => a.at.localeCompare(b.at)) }))
    .filter(x => x.points.length >= 2)                   // one point is not a trend
    .sort((a, b) => b.points.length - a.points.length);  // most logged first = the default 5

  // Overall stays computed from EVERY eligible lift, never just the picked/displayed subset --
  // it is a holistic "how is your training going" number, and shrinking it to whatever chips
  // happen to be picked would make it lie by omission the moment someone picks fewer than 5.
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

  const toChip = l => ({
    name: l.name, points: l.points,
    changePct: Number(((l.points[l.points.length-1].est / l.points[0].est - 1) * 100).toFixed(1))
  });
  const allNames = lifts.map(l => l.name);

  // Picks are validated HERE, not at save time (see POST /api/me/trend-picks) -- a name that no
  // longer has an eligible trend (renamed, deleted, or just not logged in a while) is silently
  // dropped rather than leaving a dead chip or, worse, an empty chart. Everything below has to be
  // safe against anything already sitting in this field regardless of how it got there -- the
  // save route always writes a well-formed deduped array, but that is not the only way a value
  // could land here (a hand-edited row, a future write path that skips the route, ...). That
  // includes the field's TYPE, not just its contents: Array.isArray, not a truthiness check --
  // a non-array truthy value (e.g. {}) would throw out of the for..of below and 500 the whole
  // Progress tab for that user instead of just falling back to the default.
  const u = DB.users[userId];
  const rawPicks = Array.isArray(u && u.trendPicks) ? u.trendPicks : [];
  const seen = new Set();
  const picks = [];
  for (const name of rawPicks) {
    if (seen.has(name) || !allNames.includes(name)) continue;
    seen.add(name);
    picks.push(name);
    if (picks.length >= 5) break;
  }
  const shown = picks.length
    ? picks.map(name => lifts.find(l => l.name === name))
    : lifts.slice(0, 5);

  return { lifts: shown.map(toChip), overall, allNames, picks };
}

// A lift counts as "plateaued" only when trained enough times WITHIN the trailing window
// (an abandoned lift is never flagged -- CLAUDE.md: never state something about the user you
// can't stand behind) AND its best estimated max during that window never beats its best
// estimated max from before the window by more than the threshold. Comparing bests (not
// first-vs-last point) means one rough or one lucky session near either edge doesn't flip the
// flag. Uses estMax's own Epley scoring so a plateau is judged the same way the Strength trend
// chart already judges progress -- an increase in reps at the same weight is real progress.
const PLATEAU_WEEKS = 6;
const PLATEAU_MIN_SESSIONS = 3;
const PLATEAU_THRESHOLD = 0.02; // must beat the prior best by >2% to count as real progress

function plateausFor(userId) {
  const unit = (DB.users[userId] && DB.users[userId].units) || 'lb';
  const byName = {};
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine) continue;
    const perEx = {};
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const e = estMax(l);
      if (!e) continue;                                  // bodyweight / incomplete -- see estMax
      const name = logExerciseName(s, l, userId);
      if (!perEx[name] || e > perEx[name].e) perEx[name] = { e, l };
    }
    for (const name of Object.keys(perEx)) {
      const at = perfDate(s.scheduledAt).slice(0, 10);
      const l = perEx[name].l;
      (byName[name] = byName[name] || []).push({
        at, est: perEx[name].e,
        weight: Number(l.weight) || 0, unit: l.unit || 'lb', reps: Number(l.reps) || 0
      });
    }
  }

  const windowStart = new Date(); windowStart.setUTCDate(windowStart.getUTCDate() - PLATEAU_WEEKS * 7);
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  const out = [];
  for (const name of Object.keys(byName)) {
    const points = byName[name].sort((a, b) => a.at.localeCompare(b.at));
    const windowPoints = points.filter(p => p.at >= windowStartStr);
    if (windowPoints.length < PLATEAU_MIN_SESSIONS) continue;    // not trained enough lately
    const priorPoints = points.filter(p => p.at < windowStartStr);
    if (!priorPoints.length) continue;                           // no baseline before the window
    const bestBefore = Math.max(...priorPoints.map(p => p.est));
    const bestDuring = Math.max(...windowPoints.map(p => p.est));
    if (bestDuring > bestBefore * (1 + PLATEAU_THRESHOLD)) continue;   // real progress -- not stuck

    const latest = windowPoints[windowPoints.length - 1];
    const lib = EX_LIB.find(x => x.name === name);
    const group = lib && ['push', 'pull', 'legs', 'core', 'cardio'].includes(lib.pattern) ? lib.pattern : 'other';
    out.push({
      exercise: name, group,
      weight: inUnit(latest.weight, latest.unit, unit), unit,
      bodyweight: !(Number(latest.weight) > 0),
      reps: latest.reps,
      weeks: PLATEAU_WEEKS, sessions: windowPoints.length
    });
  }
  const order = { legs: 0, push: 1, pull: 2, core: 3, cardio: 4, other: 5 };
  return out.sort((a, b) => (order[a.group] - order[b.group]) || b.sessions - a.sessions || a.exercise.localeCompare(b.exercise));
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

app.put('/api/me/seeds', auth, async (req, res) => {
  // `weight`/`reps` are the user's CURRENT working set, not an all-time best. Jeff's call:
  // a working weight is self-correcting (real logs replace it within a week) whereas a
  // self-reported all-time best is permanent, may be unbeatable, and would block the first
  // real record forever.
  const { exercise, weight, reps, goal } = req.body || {};
  if (!EX_LIB.some(e => e.name === exercise))
    return res.status(400).json({ error: 'Pick an exercise from the library' });
  const u = DB.users[req.userId];
  u.seeded = u.seeded || {};
  const w = numIn(weight, 1e6), r = numIn(reps, 1e6), g = numIn(goal, 1e6);
  if (!w && !g) { delete u.seeded[exercise]; await save(DB); return res.json({ seeds: u.seeded }); }
  u.seeded[exercise] = {
    exercise,
    weight: w, reps: r || 1,
    goal: g || null,
    unit: u.units || 'lb',
    at: new Date().toISOString()
  };
  await save(DB);
  res.json({ seeds: u.seeded });
});

app.delete('/api/me/seeds/:exercise', auth, async (req, res) => {
  const u = DB.users[req.userId];
  if (u.seeded) delete u.seeded[decodeURIComponent(req.params.exercise)];
  await save(DB);
  res.json({ seeds: u.seeded || {} });
});

// Jeff, Aug 19: "only select 5 workouts at a time... let the user pick which workouts they want
// to select rather than it using most recent exercises... a tab under it that allows us to
// select." Strength trend used to auto-pick whichever lift had the most logged history,
// unbounded. Names are NOT validated against what the user has actually logged here -- that
// would make an exercise you temporarily stop logging vanish from your saved picks entirely.
// Validity (does this name still have an eligible trend?) is checked lazily, every time, in
// trendFor() -- see the comment there. This route only guarantees the STORED list is well-formed:
// an array, deduped, capped at 5, regardless of what the client sends.
app.post('/api/me/trend-picks', auth, async (req, res) => {
  const { picks } = req.body || {};
  if (!Array.isArray(picks)) return res.status(400).json({ error: 'picks must be an array' });
  const seen = new Set();
  const clean = [];
  for (const p of picks) {
    const name = capStr(p, 80);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push(name);
    if (clean.length >= 5) break;
  }
  DB.users[req.userId].trendPicks = clean;
  await save(DB);
  res.json({ picks: clean });
});

// Body weight tracking (Progress page, Aug 31 addition). One entry per calendar day — a same-day
// re-log UPSERTS in place rather than piling up duplicates, same "correcting a mistake, not
// logging a second real event" call as the once-per-day rule on creditFinish. `date` is trusted
// the same way /leave and /lock already trust the client's local day (see isValidLocalDateStr's
// own comment above) since a weigh-in has no meaningful server-side day of its own to fall back to.
app.post('/api/me/bodyweight', auth, async (req, res) => {
  const { weight, unit, date } = req.body || {};
  const w = numIn(weight, 2000);
  if (!(w > 0)) return res.status(400).json({ error: 'Enter your weight' });
  const u = (DB.users[req.userId] && DB.users[req.userId].units) || 'lb';
  const wu = (unit === 'kg' || unit === 'lb') ? unit : u;
  const d = isValidLocalDateStr(date) ? date : new Date().toISOString().slice(0, 10);
  const user = DB.users[req.userId];
  user.bodyweight = user.bodyweight || [];
  const existing = user.bodyweight.find(e => e.date === d);
  if (existing) { existing.weight = w; existing.unit = wu; existing.at = new Date().toISOString(); }
  else {
    // Defensive cap, same spirit as the 500-row cap on custom exercises — one entry a day means
    // this takes ~10 years to matter, but an unbounded per-user array is still worth bounding.
    if (user.bodyweight.length >= 3660) user.bodyweight.shift();
    user.bodyweight.push({ date: d, weight: w, unit: wu, at: new Date().toISOString() });
  }
  await save(DB);
  res.json(bodyweightFor(req.userId));
});
app.delete('/api/me/bodyweight/:date', auth, async (req, res) => {
  const user = DB.users[req.userId];
  user.bodyweight = (user.bodyweight || []).filter(e => e.date !== req.params.date);
  await save(DB);
  res.json(bodyweightFor(req.userId));
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
app.get('/api/progress/exercise/:name', auth, async (req, res) => {
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

// Jeff, Aug 31: "I am completing a set BEFORE I click tap to log a set... which means I am not
// seeing the notes on the app telling me what weight to do next." The log sheet's own live advice
// (above) can never fix this by itself — it only opens AFTER the set it would have informed. The
// one place that's guaranteed to be seen before that first tap is the workout screen's exercise
// list, so it needs this same ready/hold/soon data for EVERY exercise in one shot, not one
// GET per exercise. /api/progress (below) already computes this, but bundled with weeksFor/
// trendFor/recordsFor — real work that screen doesn't need and that opening a workout shouldn't
// pay for on every render. This is the bare ready/holds/soon lists alone, same recommendationsFor()
// call already done by both the endpoints around it, nothing extra computed.
app.get('/api/progress/recommendations', auth, async (req, res) => {
  const r = recommendationsFor(req.userId);
  res.json({ unit: r.unit, ready: r.ready, holds: r.holds, soon: r.soon });
});

app.get('/api/progress', auth, async (req, res) => {
  const weeks = Math.min(52, Math.max(4, Number(req.query.weeks) || 13));
  const rec = recommendationsFor(req.userId);
  // localToday: same trust rule as /streak-status and /profile/me (self-view) -- this is always
  // the caller's OWN live request, so their own local calendar day is safe to accept. See the
  // comment above weeksFor for what this fixes.
  const w = weeksFor(req.userId, weeks, req.query.localToday);
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
    plateaus: plateausFor(req.userId),
    prs: recordsFor(req.userId),
    // Sep 1, round 5/6: widened from just This week (1) + 4-wk avg to a 3-range picker (This
    // week/Month/3 months) so Volume trend's card can offer a matching range control instead of a
    // separate per-week SVG chart (Jeff: "the whole report is blank and shows one bar when
    // selected" — see the comment above volTrendChart in app.js). Round 6 dropped a "6 months"
    // fourth range Consistency's own Month/3 months/6 months picker has — weekly SET VOLUME is a
    // "what's this looked like lately" question, and a 6-month average of it barely moves once
    // you're in a steady routine (see the comment above VOL_RANGES in app.js for the full
    // rationale). Each range is a true per-week average over its trailing window via the same
    // volumeFor(userId, weeks), not a sum — a consistently-trained muscle reads the same whether
    // you're looking at a week or 3 months.
    volume: volumeFor(req.userId, 1),
    volumeAvg: volumeFor(req.userId, 4),
    volume3mo: volumeFor(req.userId, 13),
    // No longer consumed by the client's Volume trend view as of round 5 (it used to drive a
    // per-week SVG trend chart, now retired in favor of the range-picker bar rows above) — left
    // computed/returned since Consistency's own weeksFor still needs this same `weeks` param, and
    // nothing else currently depends on removing this field. Candidate for cleanup later if truly
    // nothing else ever needs real per-week history again.
    volumeTrend: volumeTrendFor(req.userId, weeks),
    bodyweight: bodyweightFor(req.userId)
  });
});

app.post('/api/sessions/:id/log', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!s.participants.includes(req.userId) && !s.joinRequests.find(j=>j.userId===req.userId&&j.status==='approved'))
    return res.status(403).json({ error: 'forbidden' });
  const { exerciseId, weight, reps, set, setType, rir } = req.body || {};
  if (!s.logs[req.userId]) s.logs[req.userId] = [];
  const w = numIn(weight, 1e6), r = numIn(reps, 1e6);
  // reps are what make a set a set. Storing reps:0 silently turned "225, forgot to type reps"
  // into a zero-rep set, which reads downstream as a failed set.
  if (!(r > 0)) return res.status(400).json({ error: 'Enter the number of reps for this set' });
  const myExLogs = s.logs[req.userId].filter(l => l.exerciseId === exerciseId);
  const setNum = numIn(set, 1e6) || myExLogs.length + 1;
  const lt = loadTypeForName(exerciseNameFor(s, exerciseId, req.userId));
  const unit = (DB.users[req.userId] && DB.users[req.userId].units) || 'lb';
  // Snapshot the rep target AT LOG TIME. defaultReps/defaultRepsMax live on the session and
  // PUT /api/sessions/:id rewrites them in place, so without this, editing a finished workout
  // would retroactively change whether a set hit its target.
  const exDef = s.exercises.find(x => x.id === exerciseId);
  const rr = exDef ? repRange(exDef) : null;
  // Snapshot the exercise NAME too. Everything else about a set is already frozen at log time
  // (rep target, unit, loadType) so that editing a workout later cannot rewrite history — the
  // name was the one field still resolved live, through the session's exercise list. Remove that
  // exercise and the set pointed at nothing: records started showing raw ids like "e_ycc71vos",
  // permanently, and the sets could never be reattached because re-adding mints a new id.
  const entry = { id: 'log_'+uid(), exerciseId, exerciseName: exerciseNameFor(s, exerciseId, req.userId),
                  weight: w, reps: r, set: setNum, setType: setType || 'normal', isPr: false, at: new Date().toISOString() };
  if (lt) entry.loadType = lt;   // omitted entirely for unambiguous lifts (barbell, cable, machine)
  if (unit !== 'lb') entry.unit = unit;   // omitted when lb, so existing data stays byte-identical
  if (rr) { entry.targetReps = rr.lo; if (rr.hi !== rr.lo) entry.targetRepsMax = rr.hi; }
  // RIR (Reps In Reserve) is optional, per set, task #62. Omitted entirely when blank rather than
  // stored as 0 - those mean different things ("didn't track it" vs. "went to failure").
  if (rir !== undefined && rir !== null && String(rir).trim() !== '') entry.rir = numIn(rir, 20);
  s.logs[req.userId].push(entry);
  rebuildAllPrs();
  await save(DB);
  res.json(sessionView(s, req.userId));
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

// What lift a SET is. Prefers the name frozen onto the set at log time; falls back to resolving
// through the session for anything logged before v167. Use this for logs — exerciseNameFor()
// below is for the session's exercise list, which is a different question.
function logExerciseName(session, log, userId) {
  if (log && log.exerciseName) return log.exerciseName;
  return exerciseNameFor(session, log ? log.exerciseId : null, userId);
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

// v167: stamp the exercise name onto sets logged before the field existed. Where the exercise
// is still in the workout this is exact. Where it was already removed the name is unrecoverable —
// those are counted and named in the log rather than guessed at, because inventing a lift name
// would put a fabricated record on someone's profile.
function migrateExerciseNames() {
  let stamped = 0; const orphans = [];
  for (const sess of Object.values(DB.sessions)) {
    if (!sess.logs) continue;
    for (const userId of Object.keys(sess.logs)) {
      for (const l of sess.logs[userId]) {
        if (l.exerciseName) continue;                    // already stamped — never overwrite
        const known = (sess.exercises || []).some(x => x.id === l.exerciseId);
        if (!known) { orphans.push(`${sess.id}/${userId}/${l.exerciseId}`); continue; }
        l.exerciseName = exerciseNameFor(sess, l.exerciseId, userId);
        stamped++;
      }
    }
  }
  if (stamped) console.log('migrateExerciseNames: stamped ' + stamped + ' historical sets');
  if (orphans.length) console.log('migrateExerciseNames: ' + orphans.length +
    ' set(s) were ALREADY orphaned before this fix and cannot be named: ' + orphans.slice(0,20).join(', '));
  return stamped;
}

// v168: replace every stored plaintext password with a scrypt hash. Runs once; after it the
// clear password is gone from Postgres and from every future JSON snapshot backup. There is no
// way back, which is the point — and it is safe because we hold the plaintext at the moment of
// conversion.
// It is also the documented way to reset a password by hand while self-service reset is off
// (Aug 2026 — updated for the move off data.json onto Postgres, see DEPLOY.md's "Reset a
// password by hand" section for the full command): connect to Postgres and run
//   UPDATE users SET data = jsonb_set(data, '{pin}', to_jsonb('theNewPassword'::text))
//   WHERE username_lower = 'theirusername';
// then restart the app. A plaintext pin is always taken as an instruction to set that password,
// even over an existing hash, and is erased in the same pass — so the clear text never survives
// a boot.
function migratePasswords() {
  let done = 0;
  for (const u of Object.values(DB.users)) {
    if (!u.pin) continue;
    Object.assign(u, hashPin(u.pin));
    delete u.pin;
    done++;
  }
  if (done) console.log('migratePasswords: hashed ' + done + ' stored password(s)');
  return done;
}

// v168: an account's creation date was never recorded. For accounts that predate this there is
// no honest answer, so it is inferred from the earliest thing they actually did and marked as an
// estimate. Accounts with no activity are left without a date rather than given a made-up one.
function migrateCreatedAt() {
  const earliest = {};
  for (const s of Object.values(DB.sessions)) {
    const when = perfDate(s.scheduledAt);
    for (const id of Object.keys(s.logs || {})) {
      if (!(s.logs[id] || []).length) continue;
      if (!earliest[id] || when < earliest[id]) earliest[id] = when;
    }
    if (s.creatorId && (!earliest[s.creatorId] || when < earliest[s.creatorId])) earliest[s.creatorId] = when;
  }
  let done = 0;
  for (const u of Object.values(DB.users)) {
    if (u.createdAt || !earliest[u.id]) continue;
    u.createdAt = earliest[u.id];
    u.createdAtEstimated = true;              // inferred from first activity, not observed
    done++;
  }
  if (done) console.log('migrateCreatedAt: estimated a join date for ' + done + ' account(s)');
  return done;
}

// v168: usernames are now matched case-insensitively, so two accounts differing only by case
// would both answer to the same login. Report any that exist; do NOT merge automatically —
// choosing which account is the real one is a judgement call, not a migration.
function reportUsernameCollisions() {
  const byKey = {};
  for (const u of Object.values(DB.users)) (byKey[normUser(u.username)] ||= []).push(u);
  const clashes = Object.entries(byKey).filter(([, list]) => list.length > 1);
  for (const [key, list] of clashes) {
    console.log(`USERNAME COLLISION "${key}": ` + list.map(u => `${u.username}(${u.id})`).join(' + ') +
      ' — both answer to the same login. Resolve manually.');
  }
  return clashes.length;
}

// v168, one-off: Jeff's account list held two Brians. "Brian" (3o09ct9a, shown as Brybrykeith)
// is the real one — 8 workouts created, 10 sets logged. "brian" (f91omrrz) was an empty shell
// holding 5 friend connections, created before usernames were case-insensitive.
//
// Every precondition is re-checked here rather than trusted, because this DELETES an account.
// If anything does not match — the ids are absent, the empty one turns out to have logged
// something, or it appears in any session — this does nothing at all and says so. Idempotent:
// once the account is gone the whole thing is a no-op.
const MERGE_KEEP = '3o09ct9a', MERGE_DROP = 'f91omrrz';
function migrateMergeDuplicateBrian() {
  const keep = DB.users[MERGE_KEEP], drop = DB.users[MERGE_DROP];
  if (!keep || !drop) return 0;                                    // already done, or not this DB
  for (const s of Object.values(DB.sessions)) {
    const logged = ((s.logs || {})[MERGE_DROP] || []).length;
    const involved = s.creatorId === MERGE_DROP ||
      (s.participants || []).includes(MERGE_DROP) || (s.invited || []).includes(MERGE_DROP);
    if (logged || involved) {
      console.log(`MERGE ABORTED: ${MERGE_DROP} is referenced by session ${s.id} — not safe to remove.`);
      return 0;
    }
  }
  // hand the friendships over, in both directions, without duplicating -- `friends` is a retired
  // field (see canSeeProfile/connectionsOf, Sep 2026), but old rows can still carry it, and this
  // function's job is to fold a duplicate account's data into the real one field-by-field, not to
  // judge which fields still matter. ensureFriendArrays() itself is gone with the live feature, so
  // heal the shape inline instead.
  const add = (list, id) => { if (id && !list.includes(id)) list.push(id); };
  if (!Array.isArray(keep.friends)) keep.friends = [];
  for (const fid of (drop.friends || [])) {
    if (fid === MERGE_KEEP) continue;
    const other = DB.users[fid];
    if (!other) continue;
    if (!Array.isArray(other.friends)) other.friends = [];
    add(keep.friends, fid);
    add(other.friends, MERGE_KEEP);
    other.friends = other.friends.filter(x => x !== MERGE_DROP);
  }
  // and drop any dangling references to the removed account
  for (const u of Object.values(DB.users)) {
    if (u.id === MERGE_DROP) continue;
    if (Array.isArray(u.friends))   u.friends   = u.friends.filter(x => x !== MERGE_DROP);
    if (Array.isArray(u.followers)) u.followers = u.followers.filter(x => x !== MERGE_DROP);
    if (Array.isArray(u.incoming))  u.incoming  = u.incoming.filter(r => r && r.from !== MERGE_DROP);
    if (Array.isArray(u.outgoing))  u.outgoing  = u.outgoing.filter(r => r && r.to   !== MERGE_DROP);
  }
  delete DB.users[MERGE_DROP];
  if (DB.prs) delete DB.prs[MERGE_DROP];
  console.log(`MERGE: folded ${(drop.friends||[]).length} friendship(s) from "${drop.username}" into ` +
    `"${keep.username}" and removed the empty duplicate.`);
  return 1;
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
        const name = logExerciseName(s, l, userId);
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
      // ONE set carries the PR flag per exercise: the current record holder, nothing else.
      // This used to flag every set that beat the running best as it worked up the list, so a
      // normal ascending session tagged three or four sets "PR" for the same lift — Jeff's
      // Towel Pull-Up showed 45x8 PR and 79x8 PR in one workout. Only the 79 is a record. A
      // badge that appears on almost every set stops meaning anything.
      let bestW = -1, bestR = -1, bestLog = null;
      for (const l of chronological) {
        l.isPr = false;                       // cleared for every set; the winner is set below
        // v253 (audit finding): warm-ups and drop sets are deliberately NOT working sets (Jeff's
        // call — see WORKING_SET_TYPES/isWorkingSet above, and CLAUDE.md). The two other places
        // that decide "did this count" already skip them (search isWorkingSet(l) above), but this
        // PR-picking loop never did — a heavy warm-up or an easy drop set could become someone's
        // recorded all-time PR, and everything downstream (the profile PR card, the celebratory
        // feed item, beatSeed's "new record" check) trusted it as real.
        if (!isWorkingSet(l)) continue;
        // compare in lb regardless of what each set was typed in
        const w = toLb(l.weight, l.unit), r = Number(l.reps) || 0;
        const better = r > 0 && (w > bestW || (w === bestW && r > bestR));
        if (better) { bestW = w; bestR = r; bestLog = l; }
      }
      if (bestLog) {
        bestLog.isPr = true;
        // Jeff, Aug 21: "every new first rep will be considered a PR" -- a brand-new user's very
        // first-ever session, trying several exercises for the first time each, used to post one
        // "hit a new PR" feed item per exercise even though none of them beat anything. The
        // current record holder is the chronologically FIRST log for this (user, exercise) pair
        // exactly when nothing since has ever beaten it -- whether that's because there is
        // literally only one log, or because every later attempt fell short. Either way, that
        // record was never the result of an improvement, so it's a baseline, not an earned PR.
        // Still shown as the user's current best on their OWN profile (see profileOf's `prs`) --
        // just excluded from the celebratory feed/activity items (see groupPrsForFeed).
        const firstLog = bestLog === chronological[0];
        DB.prs[userId] = DB.prs[userId] || {};
        // v249 (audit finding): `unit` was dropped here, even though bestLog.weight is stored in
        // WHATEVER unit that specific set was logged in (kg bars move in 2.5s, lb in 5s — see the
        // comparator above, which correctly normalizes through toLb(l.weight, l.unit) before
        // picking a winner). Once written here without its unit, recordsFor()'s beatSeed check
        // (toLb(e.weight, e.unit)) silently treated e.unit as undefined -> lb, so a kg PR's real
        // weight was compared as if it were that many POUNDS: a 100kg squat (≈220lb) could lose a
        // beatSeed check against a 90kg seed (≈198lb) because 100 < toLb(90,'kg')≈198 numerically,
        // even though 100kg genuinely beats 90kg. Every kg lifter's "Record beaten" celebration was
        // wrong on this axis, and the client (prLabel) had no unit to trust for display either.
        DB.prs[userId][name] = { exercise: name, weight: Number(bestLog.weight) || 0,
          reps: Number(bestLog.reps) || 0, unit: bestLog.unit || 'lb',
          at: bestLog._performedAt || bestLog.at, firstLog };
      }
    }
  }
}

app.put('/api/sessions/:id/log/:logId', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error:'not found' });
  ensureSessionShape(s);
  const arr = s.logs[req.userId] || [];
  const log = arr.find(l => l.id === req.params.logId);
  if (!log) return res.status(404).json({ error:'log not found' });
  const { weight, reps, setType, set, rir } = req.body || {};
  if (weight!==undefined) log.weight = numIn(weight, 1e6);
  if (reps!==undefined) log.reps = numIn(reps, 1e6);
  if (setType!==undefined) log.setType = setType || 'normal';
  if (set!==undefined) log.set = numIn(set, 1e6) || log.set;
  // Same optional-field handling as POST /log above - clearing the box removes rir entirely
  // rather than writing a 0 ("went to failure"), which is a different, real answer.
  if (rir!==undefined) { if (rir===null || String(rir).trim()==='') delete log.rir; else log.rir = numIn(rir, 20); }
  rebuildAllPrs();
  await save(DB);
  res.json(sessionView(s, req.userId));
});

app.delete('/api/sessions/:id/log/:logId', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error:'not found' });
  ensureSessionShape(s);
  const arr = s.logs[req.userId] || [];
  const idx = arr.findIndex(l => l.id === req.params.logId);
  if (idx<0) return res.status(404).json({ error:'log not found' });
  arr.splice(idx,1);
  rebuildAllPrs();
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// lock session (mark done) -> record history for conflict detection
// Log & Finish — per-person, not a group lock. Jeff, Aug 19: "I want each person to have the
// ability to log and finish the workout on their own... I don't want one person in control of
// everything for each person." Any participant (creator included) can call this; it credits ONLY
// the caller's own history/streak/PRs and never touches anyone else's, and never locks the session
// for anyone. The URL keeps its old name ('lock') to avoid a client/server rename in lockstep —
// what it does underneath is now entirely different.
app.post('/api/sessions/:id/lock', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!canFinishOrPost(s, req.userId))
    return res.status(403).json({ error: 'not in this workout' });
  // creditFinish is idempotent per user — tapping "Log & Finish" twice must not push a second
  // history row for THIS person, inflating their own workout count, streak and weekly volume.
  // localDate: the client's own today (YYYY-MM-DD) — see the comment on creditFinish for why.
  if (creditFinish(s, req.userId, req.body && req.body.localDate)) await save(DB);
  res.json(sessionView(s, req.userId));
});

// Undo YOUR OWN Log & Finish — Jeff, Aug 30: "open re-activate a closed logged workout if
// needed." creditFinish above is meant to be a permanent record in general (see the
// othersWithCredit comment above it — leaving a workout deliberately never clears it), so this is
// a narrow, explicit exception, not a general-purpose unlock: it removes only the caller's own
// s.history row and nothing else. s.logs (their actual logged sets) and s.posts (their posted
// recap, if any) are left completely untouched — only the "this counts as finished" flag on it —
// so tapping this can never lose anything they've already saved, and it can never touch another
// participant's credit. Idempotent, same as /lock: calling it with no history row present is a
// harmless no-op. Streak, PRs and weekly volume are all derived from s.history at query time (see
// currentStreak/rebuildAllPrs et al), so removing a row here needs no other cache invalidated.
app.post('/api/sessions/:id/unlock', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const before = s.history.length;
  s.history = s.history.filter(h => h.userId !== req.userId);
  if (s.history.length !== before) await save(DB);
  res.json(sessionView(s, req.userId));
});

// Save YOUR OWN recap for this workout (notes + media + visibility) — any participant, not just
// the creator. Jeff, Aug 19: "I want photos and notes to stay separate for each user." One session
// now holds one recap per participant, each with its own visibility; this never reads or
// overwrites anyone else's.
app.post('/api/sessions/:id/post', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!canFinishOrPost(s, req.userId)) return res.status(403).json({ error: 'not in this workout' });
  const { notes, media, visibility } = req.body || {};
  // v190 (Sep 2026): binary -- 'private' (default) or 'public'. See canSeePostAuthor for what
  // each now means.
  const vis = visibility === 'public' ? 'public' : 'private';
  const incoming = Array.isArray(media) ? media : [];
  if (incoming.length > MEDIA_MAX_ITEMS)
    return res.status(413).json({ error: `Up to ${MEDIA_MAX_ITEMS} photos or videos per workout.` });
  // A media src may only be a data: URL of an allowed image/video type (written to disk below) or a
  // well-formed /uploads/ path from a prior save. Anything else is refused here rather than stored:
  // an application/octet-stream data URL used to skip the disk-write regex and land raw in
  // data.json; an off-site https URL would make every viewer's browser fetch it (an IP/tracking
  // leak); a /uploads/../ path is traversal.
  let total = 0;
  for (const m of incoming) {
    const src = String(m && m.src || '');
    if (/^\/uploads\/[\w.-]+$/.test(src)) continue;         // already on disk from a prior save
    const dm = src.match(ALLOWED_MEDIA);
    if (!dm) return res.status(415).json({ error: 'Only photos and videos can be attached.' });
    const bytes = b64Bytes(dm[2]);
    const isVideo = dm[1].startsWith('video/');
    const cap = isVideo ? MEDIA_MAX_VIDEO : MEDIA_MAX_PHOTO;
    if (bytes > cap) return res.status(413).json({
      error: `That ${isVideo ? 'video' : 'photo'} is ${mb(bytes)}. The limit is ${mb(cap)}.` });
    total += bytes;
  }
  if (total > MEDIA_MAX_TOTAL)
    return res.status(413).json({ error: `That is ${mb(total)} in one go. The limit is ${mb(MEDIA_MAX_TOTAL)}.` });
  // Persist media to disk on the volume (avoids huge/truncated base64 blobs in data.json).
  let writeFailed = null;
  const cleanMedia = incoming.map(m => {
    const type = m.type === 'video' ? 'video' : 'image';
    let src = String(m.src || '');
    const dm = src.match(ALLOWED_MEDIA);
    if (dm) {
      try {
        const sub = dm[1];
        const ext = sub.includes('png') ? 'png' : sub.includes('webp') ? 'webp' : sub.includes('gif') ? 'gif'
                  : sub.includes('mp4') ? 'mp4' : sub.includes('webm') ? 'webm' : sub.includes('quicktime') ? 'mov' : 'jpg';
        const fname = `post_${req.params.id}_${Date.now()}_${uid()}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(dm[2], 'base64'));
        src = `/uploads/${fname}`;
      } catch (e) {
        // The write failed — disk full, permissions, a full volume. That is NOT a bad photo, and
        // discarding it here silently lost a real one. Fail the whole request so the person still
        // has the photo and can try again.
        console.error('MEDIA_WRITE_ERR', e && e.message);
        writeFailed = e && e.message;
      }
    }
    return { type, src };
  }).filter(m => m.src);
  if (writeFailed) return res.status(507).json({
    error: 'Could not save that photo — the server is out of space. Your workout is not saved; please try again.' });
  // Editing notes/photos on an already-posted recap (the inline-edit "Save" path) hits this same
  // endpoint again — carry over any comments people already left rather than wiping the thread.
  const existingComments = (s.posts[req.userId] && Array.isArray(s.posts[req.userId].comments))
    ? s.posts[req.userId].comments : [];
  // Same carry-over as comments just above — re-saving notes/photos on an already-posted recap
  // must not wipe out reactions people already left on it (Task #157).
  const existingReactions = (s.posts[req.userId] && Array.isArray(s.posts[req.userId].reactions))
    ? s.posts[req.userId].reactions : [];
  s.posts[req.userId] = {
    at: new Date().toISOString(),
    notes: String(notes || '').slice(0, 2000),
    media: cleanMedia,
    visibility: vis,
    comments: existingComments,
    reactions: existingReactions
  };
  await save(DB);
  res.json(sessionView(s, req.userId));
});
// ---- Reactions on a POSTED recap (Task #157) ----
// Jeff, Sep 1: wanted something lightweight on a friend's posted workout -- not another comment to
// type, just a quick "nice work." Deliberately ONE reaction, not a picker (same "avoid adding a
// ton of fields" instinct behind Plateau watch). Toggle shape mirrors /api/favorites/toggle above:
// returns {reacted, count} directly rather than the whole session, so the client can flip the
// button locally without a full re-render, and so a fast double-tap can't race two overlapping
// POSTs into landing on the wrong final state (see FAV_BUSY's own comment in app.js for that exact
// bug class). Same read/write gate as commenting on the post — if you can see the recap, you can
// react to it (canSeePostAuthor).
app.post('/api/sessions/:id/posts/:authorId/react', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const p = s.posts && s.posts[req.params.authorId];
  if (!canSeePostAuthor(p, req.params.authorId, req.userId, s)) return res.status(403).json({ error: 'forbidden' });
  // Plain array of userIds, same defensive coerce-at-point-of-use as p.comments above (objArray
  // doesn't fit here — it keeps only object entries, and these are bare id strings).
  p.reactions = Array.isArray(p.reactions) ? p.reactions.filter(x => typeof x === 'string') : [];
  const i = p.reactions.indexOf(req.userId);
  const reacted = i === -1;
  if (reacted) p.reactions.push(req.userId); else p.reactions.splice(i, 1);
  await save(DB);
  if (reacted && req.params.authorId !== req.userId)
    notify(req.params.authorId, { title: 'New reaction', body: `${DB.users[req.userId].displayName} reacted to your workout` });
  res.json({ reacted, count: p.reactions.length });
});
// ---- Reactions on an individual COMMENT under a posted recap ----
// Jeff, Sep 1: wants the same Instagram feel inside the comments thread itself, not just under the
// workout. Same exact pattern as the post-level /react above, one level deeper: gated by the same
// canSeePostAuthor (if you can see/comment on the recap, you can react to a comment on it), same
// {reacted, count} toggle shape, same bare-userId-array storage. Lives on the comment object itself
// (c.reactions) so it rides along for free with the existing carry-over in POST /post above — that
// handler re-attaches the OLD comment objects by reference, reactions and all, no separate code
// needed. Notifies the COMMENT's author, not necessarily the recap's author.
app.post('/api/sessions/:id/posts/:authorId/comments/:commentId/react', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const p = s.posts && s.posts[req.params.authorId];
  if (!canSeePostAuthor(p, req.params.authorId, req.userId, s)) return res.status(403).json({ error: 'forbidden' });
  const c = objArray(p.comments).find(x => x.id === req.params.commentId);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.reactions = Array.isArray(c.reactions) ? c.reactions.filter(x => typeof x === 'string') : [];
  const i = c.reactions.indexOf(req.userId);
  const reacted = i === -1;
  if (reacted) c.reactions.push(req.userId); else c.reactions.splice(i, 1);
  await save(DB);
  if (reacted && c.userId !== req.userId)
    notify(c.userId, { title: 'New reaction', body: `${DB.users[req.userId].displayName} reacted to your comment` });
  res.json({ reacted, count: c.reactions.length });
});

// Catches whatever the async-route wrapper above forwards via next(err) — a thrown error or a
// rejected promise from any handler, including a Postgres error from save()/load(). Without
// this, Express's own default error handler would still respond (so a request never hangs
// forever), but as an HTML page with a stack trace — wrong content type for an API this security
// audit already treats as adversarial input surface, and a real information leak. status is read
// from err.status/err.statusCode so express.json's PayloadTooLargeError (413) still reports 413,
// not a generic 500 — v182's rate-limit/body-cap work depends on that exact status code.
app.use((err, req, res, next) => {
  const status = (err && (err.status || err.statusCode)) || 500;
  const message = status === 413 ? 'Request body too large.' : 'Something went wrong. Please try again.';
  console.error(err && err.stack || err);
  res.status(status).json({ error: message });
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
//
// Aug 2026: this whole sequence is now async (DB comes from Postgres — see db.js), so it's
// wrapped in an IIFE rather than running as top-level statements. `DB` and `server` are declared
// with `let` up where they used to be assigned synchronously; every route handler already only
// reads them from inside a closure that runs on a later request, long after this IIFE has
// resolved and app.listen has been called — same ordering guarantee the old synchronous code
// had, just async instead of sync. A rejection anywhere in this chain (most likely: Postgres
// unreachable) is loud and fatal — see the "REFUSING TO START IS THE FEATURE" design this
// preserves, now via db.js's connFromEnv() throwing when DATABASE_URL is unset.
(async () => {
  DB = await load();
  await backupOnBoot();       // FIRST — after this line, everything below may rewrite the DB
  loadOrCreateSecret();       // before anything can sign or verify a login
  migrateSessionShapes();     // heal malformed session rows BEFORE any migration below walks them
  await migrateMedia();
  await migratePosts();       // must run AFTER migrateMedia — see its own comment
  migratePasswords();
  migrateMergeDuplicateBrian();   // before the collision report, which it resolves
  reportUsernameCollisions();
  migrateCreatedAt();
  migrateFollowApproval();    // friends -> approved followers; old follows -> pending requests
  migrateFriendsIntoFollowers();      // retire "friends" entirely -> mutual followers, both ways
  migratePostAndSessionVisibilityBinary();   // 3-way post + 2-way session visibility -> one binary rule
  migrateExerciseNames();     // before rebuildAllPrs, which groups by the name
  rebuildAllPrs();
  migrateLoadTypes();
  await save(DB);
  server = app.listen(PORT, () => console.log('CrewFit on', PORT));
  module.exports.server = server;

  // Task #63: streak-loss push reminders. Polls every 30 minutes (cheap - it's an in-memory
  // object scan, not a query) and actually sends at most once per user per calendar day, the
  // first poll that lands inside STREAK_REMINDER_HOUR_UTC. A 30-minute period guarantees at
  // least one poll inside any given UTC hour regardless of how boot time lines up with the hour
  // boundary. There's no per-user timezone on this app, so this is a single fixed UTC hour for
  // everyone rather than a real "evening, wherever you are" - 23:00 UTC is evening for US time
  // zones (~6-7pm Eastern, ~3-4pm Pacific), which covers where this app's users actually are
  // today. Easy to move later if that changes.
  const STREAK_REMINDER_HOUR_UTC = 23;
  setInterval(async () => {
    try {
      if (new Date().getUTCHours() !== STREAK_REMINDER_HOUR_UTC) return;
      const today = new Date().toISOString().slice(0, 10);
      const atRiskIds = usersAtRiskOfLosingStreak();
      let sent = 0;
      for (const uid of atRiskIds) {
        const u = DB.users[uid];
        if (!u || u.notifyStreakReminders === false) continue;   // respects the in-app toggle
        if (u.lastStreakReminderAt === today) continue;          // already sent today
        u.lastStreakReminderAt = today;
        const streak = currentStreak(uid);
        notify(uid, { title: 'Keep your streak alive', body: `You're on a ${streak}-day streak - train today to keep it going.` });
        sent++;
      }
      if (sent) await save(DB);
    } catch (e) { console.error('streak reminder check failed:', e && e.message); }
  }, 30 * 60 * 1000);

  // Aug 31: "you have a workout scheduled today" push reminders — same polling shape as the
  // streak-loss timer above (30-min period, at-most-once-per-user-per-day via a stamped date),
  // deliberately a DIFFERENT fixed hour: this is a same-day heads-up, not an evening last-chance
  // nudge, so it fires in the morning instead. 14:00 UTC is ~10am Eastern / 7am Pacific — same
  // "no per-user timezone yet" caveat as STREAK_REMINDER_HOUR_UTC above.
  const WORKOUT_REMINDER_HOUR_UTC = 14;
  setInterval(async () => {
    try {
      if (new Date().getUTCHours() !== WORKOUT_REMINDER_HOUR_UTC) return;
      const today = new Date().toISOString().slice(0, 10);
      const pending = usersWithWorkoutToday();
      let sent = 0;
      for (const [uid, sessionName] of pending) {
        const u = DB.users[uid];
        if (!u || u.notifyWorkoutReminders === false) continue;   // respects the in-app toggle
        if (u.lastWorkoutReminderAt === today) continue;          // already sent today
        u.lastWorkoutReminderAt = today;
        notify(uid, { title: 'Workout today', body: sessionName ? `"${sessionName}" is on your schedule for today.` : 'You have a workout scheduled for today.' });
        sent++;
      }
      if (sent) await save(DB);
    } catch (e) { console.error('workout reminder check failed:', e && e.message); }
  }, 30 * 60 * 1000);
})().catch(e => {
  console.error('FATAL during boot:', e && e.stack || e);
  process.exit(1);
});
