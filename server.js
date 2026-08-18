const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const EMPTY_DB = () => ({ users: {}, sessions: {}, friendships: {}, pushSubs: {}, customExercises: {} });

// REFUSING TO START IS THE FEATURE. This used to `catch` a parse failure and return an empty
// database — and because the boot block below calls save(DB), the very next thing that happened
// was writing that emptiness over the file. Measured Aug 17, 2026 against a copy of production:
// 639,995 bytes and 377 users went to 112 bytes and 0 users, with no error, and the server
// stayed up reporting healthy. Every user, workout and PR, gone, unrecoverably, in silence.
//
// A process that will not start is loud, obvious, and fixable from a backup. A process that
// starts on an empty database destroys the thing it was supposed to be serving. Never soften
// this into a fallback.
function load() {
  if (!fs.existsSync(DATA_FILE)) return EMPTY_DB();          // genuinely first run
  const raw = fs.readFileSync(DATA_FILE, 'utf8');            // an unreadable file must throw too
  let d;
  try { d = JSON.parse(raw); }
  catch (e) {
    throw new Error(
      `REFUSING TO START: ${DATA_FILE} is not valid JSON (${raw.length} bytes) — ${e.message}\n` +
      `The file was NOT touched. Starting on an empty database would overwrite it.\n` +
      `Restore the newest file from ${path.join(DATA_DIR, 'backups')} over it, then restart.`);
  }
  if (!d || typeof d !== 'object' || typeof d.users !== 'object' || typeof d.sessions !== 'object') {
    throw new Error(
      `REFUSING TO START: ${DATA_FILE} parsed but has no users/sessions — it is not a database.\n` +
      `The file was NOT touched. Restore from ${path.join(DATA_DIR, 'backups')} and restart.`);
  }
  d.friendships = d.friendships || {};
  d.pushSubs = d.pushSubs || {};
  d.customExercises = d.customExercises || {};
  return d;
}

// Write to a temp file, flush it to disk, then rename. rename(2) is atomic on POSIX, so
// data.json is only ever the old complete file or the new complete file — never the half-written
// one. The plain writeFileSync this replaces could be interrupted (crash, OOM kill — this box has
// 256 MB and holds the whole DB in memory while serialising a second copy of it, restart, full
// disk) leaving invalid JSON, which is precisely what load() above used to wipe.
function save(d) {
  const tmp = DATA_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(d, null, 2));
    fs.fsyncSync(fd);                                        // on the platter before the rename
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, DATA_FILE);
}

// A copy of the database as it was BEFORE this boot's migrations touch it. Migrations rewrite
// data.json on every start, so this is the last point at which the previous state still exists.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUPS_KEPT = 10;
function backupOnBoot() {
  if (!fs.existsSync(DATA_FILE)) return null;                // nothing to lose yet
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `data-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
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
  if (sessionsChanged) { save(DB); console.log(`MIGRATE media: sessions=${sessionsChanged} recovered=${recovered} dropped=${dropped}`); }
}
let DB = load();
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
const TIMED_HOLD = /^(plank|side plank|wall sit|hollow body hold|dead hang|plate pinch)$/i;
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
  if (p.length < 4) return 'Password must be at least 4 characters';
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
app.get('/healthz', (req, res) => {
  if (!DB || typeof DB.users !== 'object' || typeof DB.sessions !== 'object')
    return res.status(503).json({ ok: false, error: 'database not loaded' });
  res.json({ ok: true, users: Object.keys(DB.users).length, sessions: Object.keys(DB.sessions).length });
});
app.get('/api/vapid', (req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/register', (req, res) => {
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
    displayName: capStr(displayName || username, 80).trim(), friends: [], units: 'lb',
    createdAt: new Date().toISOString() }, hashPin(pin));
  save(DB);
  res.json({ token: signToken(id), user: publicUser(id) });
});
// Live username availability check (used by the register popup as the user types)
app.get('/api/register/check', (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username) return res.json({ available: false });
  if (usernameProblem(username)) return res.json({ available: false });
  res.json({ available: !findUserByName(username) });
});

app.post('/api/login', (req, res) => {
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
  res.json({ token: signToken(u.id), user: publicUser(u.id) });
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
  return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio || '', avatar: u.avatar || '', followers: (u.followers || []).length, following: (u.friends || []).length, units: u.units || 'lb' };
}

// ---- Exercise library (136 base + user-created) ----
app.get('/api/exercises', (req, res) => {
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
app.post('/api/exercises/custom', auth, (req, res) => {
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
  // Delegates. This used to be a second, independently-written copy of the same rule, keyed on
  // whose profile you are looking at instead of who WROTE the post — so a friend of a participant
  // was handed the creator's friends-only notes and photo URLs on a profile, while the session
  // route correctly refused them. One rule, one place.
  const canSeePost = (post) => {
    if (!post) return false;
    if (id === viewerId && (post.by || id) === viewerId) return true;   // your own post
    const owner = Object.values(DB.sessions).find(x => x.post === post);
    return canSeePostOf(owner || { post, creatorId: post.by }, viewerId);
  };
  // A profile listed EVERY workout the person had done, including private ones, to any logged-in
  // stranger: the name, the date, the first three exercises, and the usernames of everyone
  // participating OR still holding an unanswered invitation. sessionView goes to the trouble of
  // withholding the invite list from non-invitees; this route handed the same names to anybody.
  //
  // A workout appears on a profile only if the viewer could legitimately reach it: their own, a
  // post whose own visibility admits them, or a workout they were actually part of.
  const viewerCanSee = s => {
    if (id === viewerId) return true;
    if (s.post && canSeePost(s.post)) return true;
    const t = sessionTier(s, viewerId);
    return t === 'member' || t === 'invited';
  };
  const myWorkouts = Object.values(DB.sessions)
    .filter(s => (s.post && s.post.by === id) || (s.history || []).some(h => h.userId === id))
    .filter(viewerCanSee)
    .sort((a,b)=> new Date(b.scheduledAt||0) - new Date(a.scheduledAt||0))
    .map(s => {
      const post = canSeePost(s.post) ? s.post : null;
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
          at: post.at
        } : null
      };
    });
  // Your training is for you and the people you train with. A logged-in stranger who happens to
  // know your id got the whole record: every lift, every best, and what you did last week. The
  // headline counts stay — a profile has to be worth opening — but the detail is for friends.
  const closeEnough = id === viewerId || viewerIsFriend;
  return {
    ...publicUser(id),
    units: (DB.users[id] && DB.users[id].units) || 'lb',
    workoutsCompleted: completed.size,
    myWorkouts,
    prCount: prs.length,
    // v148: full PR list (name, best weight×reps, when it was set), most recent first — powers the
    // profile's "Personal Records" section. prCount above still just needs the length.
    prs: closeEnough ? prs.slice().sort((a,b)=> new Date(b.at) - new Date(a.at)) : [],
    streak: currentStreak(id),
    recentActivity: closeEnough ? buildActivityFor(id) : [],
    limited: !closeEnough        // so the profile can say why it is thin rather than look empty
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
  if (b64Bytes(b64) > MEDIA_MAX_PHOTO) return res.status(413).json({ error: `That image is too large (limit ${mb(MEDIA_MAX_PHOTO)}).` });
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
    (DB.users[me].outgoing||[]).some(r=>r.to===u.id&&r.status==='pending') ? 'sent' :
    (DB.users[me].friends||[]).includes(u.id) ? 'friends' : 'none'
  }));
  res.json(hits);
});
app.post('/api/friends/request', auth, (req, res) => {
  const { username } = req.body || {};
  const friend = findUserByName(username);
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
  const t = { id, ownerId: req.userId, name: capStr(name, 80), exercises: exercises.map(withDefaults) };
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
  if (name) t.name = capStr(name, 80);
  if (Array.isArray(exercises) && exercises.length) t.exercises = exercises.map(withDefaults);
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
  // There was no check here at all. Any logged-in account could read any workout's entire chat by
  // id — including after their join request was rejected, and after declining an invitation. The
  // WRITE path five lines below has always been guarded; the read path simply never was.
  const tier = sessionTier(s, req.userId);
  if (tier !== 'member' && tier !== 'invited') return res.status(403).json({ error: 'forbidden' });
  res.json(s.comments || []);
});
app.post('/api/sessions/:id/comments', auth, (req, res) => {
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
  save(DB);
  for (const pid of s.participants) if (pid !== req.userId) notify(pid, { title: 'New message', body: `${DB.users[req.userId].displayName}: ${text.slice(0,40)}` });
  res.json(sessionView(s, req.userId));
});

// ---- Push subscribe ----
app.post('/api/push/subscribe', auth, (req, res) => {
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
  const ex = exercises.map((e, i) => Object.assign({ id: 'e_' + uid(), order: i }, withDefaults(e)));
  const invites = [];
  if (Array.isArray(inviteUsernames)) {
    for (const un of inviteUsernames) {
      const f = DB.users[req.userId].friends.find(fid => normUser(DB.users[fid] && DB.users[fid].username) === normUser(un));
      if (f) invites.push(f);
    }
  }
  const session = {
    id, creatorId: req.userId,
    scheduledAt: capStr(scheduledAt, 40) || new Date().toISOString(),
    status: 'draft',
    visibility: visibility === 'friends' ? 'friends' : 'private',
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
    history: []
  };
  DB.sessions[id] = session;
  save(DB);
  // notify invited friends
  for (const fid of invites) notify(fid, { title: 'Workout invite', body: `${DB.users[req.userId].displayName} invited you to a workout` });
  res.json(session);
});

// list sessions visible to me: mine, invited to, or friends-visibility from friends
// THE HOME SCREEN. This runs on every single app open, and it used to return raw sessions — so
// merely being a friend of the creator delivered every participant's sets, the whole chat, and
// the notes and photo URLs of an "only me" post, to your phone, unasked, several times a day.
app.get('/api/sessions', auth, (req, res) => {
  const out = Object.values(DB.sessions)
    .map(s => sessionView(s, req.userId))     // tier decides the fields; stranger yields null
    .filter(Boolean)
    .sort((a,b)=> new Date(a.scheduledAt) - new Date(b.scheduledAt));
  res.json(out);
});

app.get('/api/sessions/:id', auth, (req, res) => {
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
//                 Gets the PLAN — what the workout is — and the creator's post only if the post's
//                 own visibility allows it. Never anyone's sets. Never the chat.
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
  const u = DB.users[viewerId];
  const friends = (u && Array.isArray(u.friends)) ? u.friends : [];
  if (s.visibility === 'friends' && friends.includes(s.creatorId)) return 'friend';
  // A PUBLISHED workout is its own thing. Sharing is the point of posting, and session visibility
  // defaults to 'private' — so gating the published record behind it meant a post shared publicly
  // could not be opened by the people it was shared with. The post's own visibility decides.
  if (canSeePostOf(s, viewerId)) return 'reader';
  return 'stranger';
}

// A post carries its OWN visibility, chosen when it was published, and it is not the same setting
// as the workout's. "only me" has to mean only me even to people who were in the workout — the
// creator wrote those notes for themselves.
function canSeePostOf(s, viewerId) {
  const p = s && s.post;
  if (!p) return false;
  // The AUTHOR, not whoever holds creatorId today. Leaving a shared workout transfers creatorId to
  // someone else (see /leave), so keying on it meant the person who wrote "only me" notes lost
  // them and the other participant inherited them — and could republish them publicly.
  const author = p.by || s.creatorId;
  if (author === viewerId) return true;
  if (p.visibility === 'public') return true;
  if (p.visibility === 'friends') {
    const u = DB.users[viewerId];
    return !!(u && Array.isArray(u.friends) && u.friends.includes(author));
  }
  return false;                                    // 'only_me', or no visibility recorded
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
    // still not automatic: an "only me" post belongs to whoever wrote it
    if (s.post && !canSeePostOf(s, viewerId)) {
      const { post, ...rest } = s;
      return Object.assign({}, rest, { post: { hidden: true, visibility: s.post.visibility } });
    }
    return s;
  }
  if (tier === 'stranger') return null;

  // The plan, and nothing that belongs to the people doing it.
  const view = {
    id: s.id, creatorId: s.creatorId, scheduledAt: s.scheduledAt, status: s.status,
    visibility: s.visibility, name: s.name, location: s.location, lengthMin: s.lengthMin,
    creatorNote: s.creatorNote, equipment: s.equipment || [],
    exercises: s.exercises || [], participants: s.participants || [],
    // You are told about YOURSELF and nobody else. Emptying this entirely also erased the fact
    // that the viewer is invited, which is what the whole invitation screen keys on — "waiting on
    // you", the Respond block, and being able to suggest a swap before accepting all vanished.
    // Everyone else who was asked and has not answered is a fact about them, not about you.
    invited: (Array.isArray(s.invited) && s.invited.includes(viewerId)) ? [viewerId] : [],
    // who proposed swapping what is a conversation between the people in the workout
    suggestedEdits: (tier === 'invited' || tier === 'reader') ? (s.suggestedEdits || []) : [],
    // your OWN swap comes back; nobody else's
    variations: pickMine(s.variations, viewerId),
    attendance: {}, history: [],
    joinRequests: [],                    // other people's requests, and their notes, are not yours
    logs: {},                            // NOBODY else's sets — see the reader case below
    comments: tier === 'invited' ? (s.comments || []) : [],
  };
  // A published workout IS the author's sets. That is what was shared, and stripping them rendered
  // an empty record to exactly the people it was published for.
  if (tier === 'reader' && canSeePostOf(s, viewerId)) {
    const author = (s.post && s.post.by) || s.creatorId;
    if (s.logs && s.logs[author]) view.logs = { [author]: s.logs[author] };
  }
  // "Brian's already started - 2 sets in" is the fact that decides an invitation, and it survives
  // this change. It does not need Brian's SETS to say so, only how many there were: no weights,
  // no reps, nothing that belongs on his record. Counts only, and only for someone deciding.
  if (tier === 'invited') {
    const counts = {};
    for (const [pid, arr] of Object.entries(s.logs || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const per = {};
      for (const l of arr) per[l.exerciseId] = (per[l.exerciseId] || 0) + 1;
      counts[pid] = per;
    }
    view.logCounts = counts;
  }
  if (canSeePostOf(s, viewerId)) view.post = s.post;
  else if (s.post) view.post = { hidden: true, visibility: s.post.visibility };
  return view;
}

// delete a session (creator only)
// Who OTHER than me has logged sets in this workout.
function othersWhoLogged(s, meId) {
  return Object.keys(s.logs || {}).filter(uid => uid !== meId && (s.logs[uid] || []).length);
}

app.delete('/api/sessions/:id', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'not yours' });
  // Delete is creator-only, which sounds safe — but a workout holds EVERYONE's sets, so deleting
  // it took a training partner's history with it, silently and with no undo. Declining an invite
  // already removes only you; delete now behaves the same way once anyone else is involved.
  const others = othersWhoLogged(s, req.userId);
  if (others.length) {
    const names = others.map(id => (DB.users[id] && (DB.users[id].displayName || DB.users[id].username)) || 'someone');
    return res.status(409).json({
      error: `${names.join(' and ')} logged sets in this workout. Deleting it would erase their training history too.`,
      othersLogged: others.length, canLeave: true });
  }
  delete DB.sessions[req.params.id];
  rebuildAllPrs();     // the records were built from sets that no longer exist
  save(DB);
  res.json({ ok: true });
});

// Take yourself out of a shared workout without destroying it for the people still in it.
// Removes your participation, your logged sets and your history row; theirs are untouched.
app.post('/api/sessions/:id/leave', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  // You can only leave something you are in. Without this, any account could name any session id
  // and trigger a full PR rebuild and a whole-database write.
  if (!(s.participants || []).includes(req.userId) && s.creatorId !== req.userId)
    return res.status(403).json({ error: 'not in this workout' });
  const me = req.userId;
  const others = othersWhoLogged(s, me);
  if (!others.length && s.creatorId === me)
    return res.status(400).json({ error: 'Nobody else has logged in this workout — delete it instead.' });

  if (s.logs) delete s.logs[me];
  s.participants = (s.participants || []).filter(x => x !== me);
  s.invited      = (s.invited || []).filter(x => x !== me);
  s.history      = (s.history || []).filter(h => h.userId !== me);
  if (s.attendance) delete s.attendance[me];
  for (const exId of Object.keys(s.variations || {})) {
    if (s.variations[exId]) delete s.variations[exId][me];
  }
  // If the creator walks away, the workout needs a new owner or nobody can ever finish or edit
  // it. It goes to whoever else has actually logged in it.
  if (s.creatorId === me) {
    s.creatorId = others[0];
    if (!s.participants.includes(others[0])) s.participants.push(others[0]);
  }
  rebuildAllPrs();
  save(DB);
  res.json({ ok: true, left: true });
});

// update a session (creator only): name/time/location/note/visibility/exercises/invites
app.put('/api/sessions/:id', auth, (req, res) => {
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
  if (b.visibility) s.visibility = b.visibility === 'friends' ? 'friends' : 'private';
  if (Array.isArray(b.exercises)) {
    s.exercises = b.exercises.map((e, i) => Object.assign({
      id: (e.id && s.exercises.find(x => x.id === e.id)) ? e.id : 'e_' + uid(),
      order: i,
    }, withDefaults(e)));
  }
  if (Array.isArray(b.inviteUsernames)) {
  const invites = [];
  for (const un of b.inviteUsernames) {
    const f = DB.users[req.userId].friends.find(fid => normUser(DB.users[fid] && DB.users[fid].username) === normUser(un));
    if (f) invites.push(f);
  }
  s.invited = invites;
  }
  s.updatedAt = new Date().toISOString();
  save(DB);
  res.json(sessionView(s, req.userId));
});

// accept an invite (move from invited[] to participants[])
app.post('/api/sessions/:id/accept', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  s.invited = s.invited.filter(x => x !== req.userId);
  if (!s.participants.includes(req.userId)) s.participants.push(req.userId);
  save(DB);
  notify(s.creatorId, { title: 'Invite accepted', body: `${DB.users[req.userId].displayName} joined your workout` });
  res.json(sessionView(s, req.userId));
});

// decline an invite (remove from invited[], do not join)
app.post('/api/sessions/:id/decline', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  s.invited = s.invited.filter(x => x !== req.userId);
  save(DB);
  notify(s.creatorId, { title: 'Invite declined', body: `${DB.users[req.userId].displayName} declined your workout` });
  res.json(sessionView(s, req.userId));
});

// suggest a swap (any participant; also join-requester after approval)
app.post('/api/sessions/:id/suggest', auth, (req, res) => {
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
  const exerciseId = capStr((req.body || {}).exerciseId, 64);
  const swapTo = capStr((req.body || {}).swapTo, 80);
  const edit = { id: 'se_' + uid(), exerciseId, proposedBy: req.userId, swapTo, status: 'pending' };
  s.suggestedEdits.push(edit);
  save(DB);
  // notify creator
  notify(s.creatorId, { title: 'Swap suggested', body: `${DB.users[req.userId].displayName} suggested swapping to ${swapTo}` });
  res.json(sessionView(s, req.userId));
});

app.post('/api/sessions/:id/suggest/:editId/approve', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  edit.status = 'approved';
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
  save(DB);
  notify(edit.proposedBy, { title: 'Swap approved', body: `${DB.users[s.creatorId].displayName} approved your swap to ${edit.swapTo}` });
  res.json(sessionView(s, req.userId));
});

app.post('/api/sessions/:id/suggest/:editId/reject', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  edit.status = 'rejected';
  save(DB);
  res.json(sessionView(s, req.userId));
});

// join request (friends-visibility sessions)
app.post('/api/sessions/:id/join', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  // "not joinable" tested a property of the WORKOUT and never asked anything about the caller, so
  // any logged-in account could ask to join any friends-visibility workout and the reply handed
  // back the entire thing — everyone's sets, the whole chat, the post, the invite list, and other
  // people's join requests with their notes. Rejecting them afterwards changed nothing; they
  // already had it. Asking to join is now something only the creator's friends can do, and the
  // reply says nothing except that the request was filed.
  if (!s || s.visibility !== 'friends') return res.status(400).json({ error: 'not joinable' });
  const me = DB.users[req.userId];
  const myFriends = (me && Array.isArray(me.friends)) ? me.friends : [];
  if (s.creatorId !== req.userId && !myFriends.includes(s.creatorId))
    return res.status(403).json({ error: 'forbidden' });
  if (s.joinRequests.find(j => j.userId === req.userId)) return res.status(400).json({ error: 'already requested' });
  s.joinRequests.push({ id: 'jr_' + uid(), userId: req.userId, note: capStr((req.body||{}).note, 500), status: 'pending' });
  save(DB);
  notify(s.creatorId, { title: 'Join request', body: `${DB.users[req.userId].displayName} wants to join your workout` });
  res.json({ ok: true, requested: true });     // the answer to "may I join" is not the workout
});

app.post('/api/sessions/:id/join/:reqId/approve', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const jr = s.joinRequests.find(j => j.id === req.params.reqId);
  if (!jr || s.creatorId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  jr.status = 'approved';
  if (!s.participants.includes(jr.userId)) s.participants.push(jr.userId);
  save(DB);
  notify(jr.userId, { title: 'Join approved', body: `${DB.users[s.creatorId].displayName} approved your join request` });
  res.json(sessionView(s, req.userId));
});

app.post('/api/sessions/:id/join/:reqId/reject', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const jr = s.joinRequests.find(j => j.id === req.params.reqId);
  if (!jr || s.creatorId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  jr.status = 'rejected';
  save(DB);
  notify(jr.userId, { title: 'Join declined', body: `${DB.users[s.creatorId].displayName} declined your join request` });
  res.json(sessionView(s, req.userId));
});

// attendance
app.post('/api/sessions/:id/attendance', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!s.participants.includes(req.userId)) return res.status(403).json({ error: 'forbidden' });
  s.attendance[req.userId] = capStr((req.body||{}).status, 20) || 'in';
  save(DB);
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
      const name = logExerciseName(s, l, userId);
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
  const w = numIn(weight, 1e6), r = numIn(reps, 1e6), g = numIn(goal, 1e6);
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
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!s.participants.includes(req.userId) && !s.joinRequests.find(j=>j.userId===req.userId&&j.status==='approved'))
    return res.status(403).json({ error: 'forbidden' });
  const { exerciseId, weight, reps, set, setType } = req.body || {};
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
  s.logs[req.userId].push(entry);
  rebuildAllPrs();
  save(DB);
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
// clear password is gone from disk and from every future backup. There is no way back, which is
// the point — and it is safe because we hold the plaintext at the moment of conversion.
// It is also the documented way to reset a password by hand while self-service reset is off:
// set `"pin": "theNewPassword"` on the account in data.json and restart. A plaintext pin is
// always taken as an instruction to set that password, even over an existing hash, and is
// erased in the same pass — so the clear text never survives a boot.
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
  // hand the friendships over, in both directions, without duplicating
  const add = (list, id) => { if (id && !list.includes(id)) list.push(id); };
  ensureFriendArrays(keep);
  for (const fid of (drop.friends || [])) {
    if (fid === MERGE_KEEP) continue;
    const other = DB.users[fid];
    if (!other) continue;
    ensureFriendArrays(other);
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
        // compare in lb regardless of what each set was typed in
        const w = toLb(l.weight, l.unit), r = Number(l.reps) || 0;
        const better = r > 0 && (w > bestW || (w === bestW && r > bestR));
        if (better) { bestW = w; bestR = r; bestLog = l; }
        l.isPr = false;                       // cleared for every set; the winner is set below
      }
      if (bestLog) {
        bestLog.isPr = true;
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
  ensureSessionShape(s);
  const arr = s.logs[req.userId] || [];
  const log = arr.find(l => l.id === req.params.logId);
  if (!log) return res.status(404).json({ error:'log not found' });
  const { weight, reps, setType, set } = req.body || {};
  if (weight!==undefined) log.weight = numIn(weight, 1e6);
  if (reps!==undefined) log.reps = numIn(reps, 1e6);
  if (setType!==undefined) log.setType = setType || 'normal';
  if (set!==undefined) log.set = numIn(set, 1e6) || log.set;
  rebuildAllPrs();
  save(DB);
  res.json(sessionView(s, req.userId));
});

app.delete('/api/sessions/:id/log/:logId', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error:'not found' });
  ensureSessionShape(s);
  const arr = s.logs[req.userId] || [];
  const idx = arr.findIndex(l => l.id === req.params.logId);
  if (idx<0) return res.status(404).json({ error:'log not found' });
  arr.splice(idx,1);
  rebuildAllPrs();
  save(DB);
  res.json(sessionView(s, req.userId));
});

// lock session (mark done) -> record history for conflict detection
app.post('/api/sessions/:id/lock', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator' });
  // Idempotent: tapping "Log & Finish" twice used to push a SECOND history row for every
  // participant, inflating workout counts, streaks and the weekly activity line.
  if (s.completed) return res.json(sessionView(s, req.userId));
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
  res.json(sessionView(s, req.userId));
});

// Save a post for a locked session (notes + media + visibility)
app.post('/api/sessions/:id/post', auth, (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator' });
  const { notes, media, visibility } = req.body || {};
  const vis = ['only_me','friends','public'].includes(visibility) ? visibility : 'only_me';
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
  s.post = {
    by: req.userId,
    at: new Date().toISOString(),
    notes: String(notes || '').slice(0, 2000),
    media: cleanMedia,
    visibility: vis
  };
  save(DB);
  res.json(sessionView(s, req.userId));
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
backupOnBoot();          // FIRST — after this line, everything below may rewrite data.json
loadOrCreateSecret();       // before anything can sign or verify a login
migrateSessionShapes();     // heal malformed session rows BEFORE any migration below walks them
migrateMedia();
migratePasswords();
migrateMergeDuplicateBrian();   // before the collision report, which it resolves
reportUsernameCollisions();
migrateCreatedAt();
migrateExerciseNames();     // before rebuildAllPrs, which groups by the name
rebuildAllPrs();
migrateLoadTypes();
save(DB);

const server = app.listen(PORT, () => console.log('CrewFit on', PORT));
module.exports = { app, server };
