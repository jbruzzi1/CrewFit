// Oct 10 2026 (deep-dive audit, Jeff: "let's correct everything" -- production had NO crash
// visibility at all: no uncaughtException/unhandledRejection handler, no error-tracking service.
// Node already prints an uncaught exception's stack trace to stderr and exits on its own -- the
// real gap was that nothing was watching `fly logs`, so the only way anyone found out the app
// crashed was a user noticing it was down. This has to be the literal first thing this file does
// (before any other require, before anything that could itself throw during boot) so that an
// error during boot is captured too, not just one during a request.
//
// Cold-reviewed before shipping (caught two real problems in the first draft, both fixed here):
// (1) registering these process.on() handlers has to come BEFORE requiring/initializing Sentry
// below, not after -- registration is plain synchronous code that cannot throw, so it's safe
// first; Sentry's own require/init is exactly the kind of "conditional failure invisible in
// testing, crashes boot in prod" hard rule #7 already exists for (a broken install, or a malformed
// SENTRY_DSN secret, could throw) -- if that ran first and threw, there'd be no handler registered
// yet to catch it. (2) Node's own guidance for an uncaughtException handler is synchronous cleanup
// only, not resuming the event loop with async work -- an earlier draft did
// `await Sentry.flush(2000)` before exiting, which means a hung flush() (network stall, SDK bug)
// would silently wedge the process instead of crashing it, the exact opposite of this change's
// purpose. captureException below is fire-and-forget; exit is immediate and unconditional.
function fatalCrash(label, err) {
  console.error(`\n=== FATAL: ${label} ===`, err && err.stack || err);
  try { if (SENTRY_ON) Sentry.captureException(err); } catch (e) {}
  process.exit(1);
}
process.on('uncaughtException', err => fatalCrash('uncaughtException', err));
process.on('unhandledRejection', err => fatalCrash('unhandledRejection', err));

// Sentry itself is OPTIONAL and must never be able to take the app down by failing to load or
// init -- wrapped in try/catch so a broken install or a malformed SENTRY_DSN just logs and leaves
// Sentry off, rather than crashing boot (before the handlers above even existed, pre-review).
// SENTRY_ON (not process.env.SENTRY_DSN) is what fatalCrash checks, so a failed init can never
// make fatalCrash call into a Sentry that didn't actually initialize.
// Jeff still needs to create a (free) Sentry account and hand over the DSN as a Fly secret --
// nothing here sends anything anywhere until he does; until then this only changes the LOG LINE
// an uncaught error gets (loud and prefixed, instead of Node's bare default).
let Sentry, SENTRY_ON = false;
try {
  Sentry = require('@sentry/node');
  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
    SENTRY_ON = true;
    console.log('Sentry error tracking: ON');
  } else {
    console.log('Sentry error tracking: OFF (no SENTRY_DSN set)');
  }
} catch (e) {
  console.error('Sentry failed to load/initialize -- continuing WITHOUT it:', e.message);
}
// Both uncaughtException and unhandledRejection are genuinely fatal -- the process is in an
// unknown state after either, and Node's own default (since Node 15) is already to exit on an
// unhandled rejection. Being explicit here just means: log it loudly and distinctively, report it
// to Sentry if configured, and exit -- rather than relying on each Node version's silent default.
// `auto_stop_machines = 'off'` + Fly's own health check means the machine gets restarted after
// this exit; this is what turns "silently wedged until someone notices" into "a few seconds of
// downtime that Sentry (once wired up) actually tells someone about."

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Sep 30 2026 (audit finding, Jeff: custom exercise names should stay open -- "anyone should be
// able to use whatever name they like - barring racial slurs and such"). A maintained word list
// beats a hand-rolled one for exactly the words this is meant to catch; used only as a hard
// content-safety gate on exercise names, never as a naming-uniqueness rule (see the comment on
// POST /api/exercises/custom below -- duplicate real names are explicitly fine).
const profanityFilter = require('leo-profanity');

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

// ---- Support contact (app-store readiness, Sep 2026) ----
// Apple requires a published way for a user to reach the developer about abuse/objectionable
// content (guideline 1.2), and App Store Connect separately requires a privacy-policy contact.
// This is a REAL placeholder, not a working inbox -- swap it for an address that's actually
// checked (a Fly secret `SUPPORT_EMAIL=...` overrides it with no code change) before submitting.
// Reused for both the client's Settings -> Help "Contact us" link and could replace the VAPID
// mailto: above too, whenever this becomes a real address.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@example.com';

// ---- Admin token (app-store readiness, Sep 2026) ----
// Gates GET/POST /api/admin/reports (below) and the standalone /admin.html page -- deliberately
// NOT tied to any particular app account (no "isAdmin" flag on a user, no hardcoded username to
// keep in sync if Jeff's account is ever renamed). Same generate-once-and-persist-to-the-volume
// pattern as VAPID above: an ADMIN_TOKEN env var (a Fly secret) always wins if set; otherwise one
// is generated on first boot and written to the volume so it survives restarts/deploys, and
// printed to the boot log (`fly logs`) so whoever is running the app can retrieve it once and
// paste it into /admin.html, which then remembers it in that browser's localStorage.
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin-token.json');
let ADMIN_TOKEN;
if (process.env.ADMIN_TOKEN) {
  ADMIN_TOKEN = process.env.ADMIN_TOKEN;
} else if (fs.existsSync(ADMIN_TOKEN_FILE)) {
  ADMIN_TOKEN = JSON.parse(fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8')).token;
} else {
  ADMIN_TOKEN = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(ADMIN_TOKEN_FILE, JSON.stringify({ token: ADMIN_TOKEN }, null, 2));
  // Only logged the one time it's freshly generated (not when it came from an env var or an
  // already-written file) -- this is the one and only place to retrieve it (fly logs), so it's
  // worth a boot-time line, same spirit as any other "here's your generated secret" first-run.
  console.log('Generated ADMIN_TOKEN for /admin.html (also saved to', ADMIN_TOKEN_FILE + '):', ADMIN_TOKEN);
}

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
// notify-helpers.js's firstExerciseStartNotification() is no longer called from this file (see the
// comment above POST /api/sessions, Sep 5: the creator no longer gets self-notified on their own
// workout) -- left required nowhere here on purpose, the function/its test still live in
// notify-helpers.js and test/first-exercise-notify.mjs, imported directly by the test instead.
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
  // currentExerciseName: a tab still running a pre-audit app.js (see EXERCISE_RENAMES) can post an
  // old library name for a while after deploy; file it under the current one, same as the boot
  // migration did for everything already stored, so history never splits on a stale client.
  const name = currentExerciseName(capStr(e && e.name, 80));   // another user's exercise name renders in your app
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
  // Sep 29 2026 (account deletion): a deleted account's row is anonymized in place with a
  // `deleted_<id>` username (see POST /api/me/delete-account) rather than removed outright, so
  // nothing else in this file has to null-check a vanished DB.users[id]. Blocking this prefix on
  // the way IN means nobody can ever pick a real username that later reads as a deleted account.
  if (normUser(raw).startsWith('deleted_')) return 'That username is reserved';
  return null;
}
// Sep 29 2026 (Jeff: "make it whatever they want as long as its longer than 6 characters... a
// cap thats default for passwords used elsewhere"): this already validated a real free-text
// password (the field's own name — hashPin/verifyPin/pinProblem — is the one thing left over
// from this app's original PIN-only design; the login/register UI has used type="password" text
// inputs with no character restriction for a while now, see authScreen()). The only actual change
// here is the floor: 6 -> 8, the near-universal minimum other apps use, so it won't read as an
// arbitrary number of this app's own invention. 64 was already the ceiling — also already the
// standard default (NIST SP 800-63B recommends allowing at least 64) — so it's unchanged.
function pinProblem(pin) {
  const p = String(pin == null ? '' : pin);
  if (p.length < 8) return 'Password must be at least 8 characters';
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

// ---- Starter routines (Sep 21 2026, Jeff: "I want to update the routines page with default
// routines that new users and already created users can choose from... I think having a library
// to choose from (maybe all of the above) is good? Not just a select two or so.") ------------
//
// These are pre-made routines every user can browse and use, not owned by anyone. Two shapes
// were considered: (A) seed a real "system" user account owning real DB.templates rows, so every
// existing routine mechanic (view/use/hide/edit-copy) works unmodified -- but that fake account
// would need auditing into every user-enumeration surface in this large, interconnected app
// (search, friend suggestions, follow flows) to make sure it never leaks in as a "person" to
// follow or message, and DB.templates rows are meant to be owned by a real user (ownerId is read
// all over: connectionsOf gating on GET, hide/unhide, PUT's ownership check). (B) static
// reference data, the same convention as exercise-library.json -- no fake account, no new surface
// to audit, and it fits what Jeff actually described (a browsable library to pick from, nothing
// about hiding/editing individual starters). Went with (B).
//
// Built LAZILY (first call, then cached) rather than eagerly at module-eval time like EX_LIB
// above. Each exercise in starter-routines.json is just {name}; withDefaults is what turns that
// into the same {name, defaultSets, defaultReps, defaultRepsMax} shape a real saved routine's
// exercises have -- but withDefaults' own body reaches for capStr/numIn (consts a bit further
// down this file) and currentExerciseName (which reaches for EXERCISE_RENAMES, a const much
// further down still, near the exercise-rename migration). Building this list up front tried
// twice and broke the server's own boot both times -- first on capStr/numIn, then again on
// EXERCISE_RENAMES, each a "Cannot access before initialization" thrown at require() time,
// nothing conditional about it, the server refusing to boot at all until fixed. A function most of
// this file's other lazy/derived values don't need is the one guaranteed-safe way to depend on
// consts declared anywhere else in this same file without caring about load order: by the time
// anything actually CALLS this (the first real request), the whole module has finished
// evaluating, so every const it reaches into is long since initialized. The result never changes
// between calls (starter-routines.json isn't user data), so it's computed once and reused.
const STARTER_FILE = path.join(__dirname, 'starter-routines.json');
let _STARTER_TEMPLATES = null;
function starterTemplates() {
  if (!_STARTER_TEMPLATES) {
    _STARTER_TEMPLATES = JSON.parse(fs.readFileSync(STARTER_FILE, 'utf8')).routines.map(r => ({
      id: r.id,
      name: r.name,
      split: r.split,
      starter: true,
      exercises: r.exercises.map(withDefaults),
    }));
  }
  return _STARTER_TEMPLATES;
}
// Sep 11 2026 (cold-review finding on the recap-date-mismatch fix, see rcDay() in public/app.js):
// a session's scheduledAt is trusted as-sent once capStr trims its length, but capStr only checks
// length, not shape -- and every screen that reads scheduledAt (this fix's rcDay, plus the
// already-shipped fmtDate/fmtWhen) hands it straight to `new Date()`, which treats a bare date
// ("2026-09-11", no time component) as UTC MIDNIGHT. For anyone west of UTC that is a fabricated
// clock time on the WRONG calendar day -- the exact mirror image of the bug rcDay just had fixed
// (that one was a fabricated UTC date built by slicing; this would be a client sending an
// incomplete one directly). Nothing reachable today can actually trigger this: every current
// app.js call site already builds scheduledAt via `new Date(...).toISOString()`, which always
// includes a time (see createFlow's submitSession and createQuickWorkout). This is a
// belt-and-suspenders guard for the future, not a fix for anything currently reachable -- a value
// with no real time component is treated exactly like no value at all: it falls back to the
// server's own "now", same as the existing `|| new Date().toISOString()` this replaces.
//
// First draft of this only accepted a full ISO-with-time string and rejected everything else --
// which silently broke a SECOND real, pre-existing, intentionally-supported shape: a pure-digits
// epoch number in seconds or milliseconds (see perfDate()'s own comment just below, and
// test/workout-reminders.mjs's "DIFFERENT scheduledAt formats" case, which caught this in the
// full suite before it ever reached Jeff). Both real shapes are accepted here unchanged; only a
// value that is neither -- most notably a bare date -- gets the "now" fallback.
function normalizedScheduledAt(v) {
  const s = capStr(v, 40);
  if (!s) return new Date().toISOString();
  const isEpoch = /^\d+$/.test(s);
  if (!isEpoch && !/T\d{2}:\d{2}/.test(s)) return new Date().toISOString();
  if (isEpoch) return isNaN(new Date(Number(s) < 1e12 ? Number(s) * 1000 : Number(s))) ? new Date().toISOString() : s;
  const d = new Date(s);
  return isNaN(d) ? new Date().toISOString() : s;
}
const b64Bytes = b64 => Math.floor(String(b64 || '').length * 3 / 4);
const mb = n => (n / 1048576).toFixed(1) + ' MB';
app.use(express.static(path.join(__dirname, 'public')));
// User-uploaded avatars live in the persistent volume so they survive redeploys.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Sep 24 2026 (audit finding): mints the short-lived media-viewer token app.js's mediaSrc() rides
// on every recap-photo/video URL (see the long comment on signMediaToken above).
app.get('/api/media-token', auth, (req, res) => res.json({ token: signMediaToken(req.userId) }));
// Sep 24 2026 (audit finding): gates recap media specifically -- every file this app ever writes
// under a 'post_' prefix (POST /api/sessions/:id/post, and the legacy 'post_mig_' migration
// above) belongs to exactly one post, and this looks up which one and re-runs the exact same
// canSeePostAuthor check the API itself uses before letting the static handler below serve it.
// Avatars (avatar_<userId>.ext) and anything else under UPLOAD_DIR fall straight through
// untouched -- they were never part of this finding, and this app's avatars are meant to be
// visible to anyone who can already see the profile.
app.get('/uploads/:fname', (req, res, next) => {
  const fname = req.params.fname;
  if (!/^post_/.test(fname)) return next();
  const payload = verifyMediaToken(req.query.tok);
  if (!payload) return res.status(401).end();
  const src = '/uploads/' + fname;
  for (const s of Object.values(DB.sessions)) {
    for (const [authorId, p] of Object.entries(s.posts || {})) {
      if (p && Array.isArray(p.media) && p.media.some(m => m && m.src === src)) {
        if (!canSeePostAuthor(p, authorId, payload.v, s)) return res.status(403).end();
        return next();
      }
    }
  }
  // Cold-review catch: this used to `next()` here on the assumption an untracked file "shouldn't
  // happen" -- it does. POST /api/sessions/:id/post fully REPLACES a post's media array on every
  // save (deletePhoto in app.js resaves without the removed photo), and remove-mine/reset-workouts
  // delete a whole post object outright -- none of those ever unlink the physical file, so a
  // removed photo's file becomes untracked by any post and, without this, fell straight through
  // to the unauthenticated static handler below: LESS protected than a photo still attached to a
  // visible post, exactly backwards. Fail closed instead -- a file no longer tracked as any post's
  // media isn't servable to anyone, full stop.
  return res.status(404).end();
});
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
// Oct 2 2026 (#182, deep audit finding, Jeff: "Just sign out this device"): `j` is new -- a random
// per-token id, present purely so ONE issued token can be individually named and revoked later
// (see revokeToken/userIdFromToken below) without touching any other token the same account has
// outstanding on other devices. Nothing else about the token (what it proves, how it's verified)
// changes; a token from before this change simply has no `j` and can never be individually
// revoked (only ever by the existing account-wide tokensValidFrom bump) -- never a validity
// problem, since userIdFromToken's revocation check below is additive, not required.
function signToken(userId) {
  const body = b64u(JSON.stringify({ u: userId, t: Date.now(), j: crypto.randomBytes(9).toString('base64url') }));
  const sig = b64u(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
  return body + '.' + sig;
}
// Decodes+verifies a token's signature and shape without checking expiry/revocation/user
// existence -- the one piece userIdFromToken and POST /api/logout (below) both need (the latter
// to know exactly which token id to revoke), split out so there's one HMAC-verify/JSON-parse
// implementation instead of two copies drifting apart, same reasoning as every other
// shared-implementation comment in this file (see blockUser's own, for one).
function parseToken(token) {
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
  return payload;
}
// Oct 2 2026 (#182): revoked token ids are kept as { [jti]: issuedAtMs } rather than a bare array,
// so they can be pruned -- a jti whose own issuedAt is already past TOKEN_TTL_DAYS would have
// failed userIdFromToken's expiry check on its own anyway, so there's no reason to keep tracking
// it forever. Pruned on every revoke (logout), which is the only time this list is written, so it
// never grows past "however many devices logged out in the last 90 days."
function revokeToken(u, jti, issuedAt) {
  if (!u.revokedJtis) u.revokedJtis = {};
  const cutoff = Date.now() - TOKEN_TTL_DAYS * 864e5;
  for (const j of Object.keys(u.revokedJtis)) if (u.revokedJtis[j] < cutoff) delete u.revokedJtis[j];
  u.revokedJtis[jti] = issuedAt;
}
// Sep 24 2026 (audit finding): recap media was served from /uploads with no auth at all and no
// link back to canSeePostAuthor -- once a viewer had a photo's URL (from normal viewing, browser
// cache, or just copying the link), blocking the poster, being removed from the session, or the
// poster flipping the recap to 'private' all correctly gated the API, but the raw file kept
// serving forever, to anyone, logged in or not. A plain <img>/<video> src can't carry the normal
// header-based bearer token (see auth() above), so this is a second, purpose-scoped, short-lived
// signed token instead -- reused AUTH_SECRET (rotating it also invalidates every outstanding
// media token, same as it does main login tokens). It only attests WHO is asking; the actual
// canSeePostAuthor check is re-run fresh on every single request in the /uploads/:fname route
// below, not baked into the token, so a block/removal/visibility-change still takes effect
// immediately even against a cached URL.
const MEDIA_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
function signMediaToken(viewerId) {
  const body = b64u(JSON.stringify({ v: viewerId, t: Date.now() }));
  const sig = b64u(crypto.createHmac('sha256', AUTH_SECRET).update('media:' + body).digest());
  return body + '.' + sig;
}
function verifyMediaToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = b64u(crypto.createHmac('sha256', AUTH_SECRET).update('media:' + body).digest());
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || !payload.v || !payload.t) return null;
  if (Date.now() - payload.t > MEDIA_TOKEN_TTL_MS) return null;
  if (!DB.users[payload.v]) return null;
  return payload;
}
function userIdFromToken(token) {
  const payload = parseToken(token);
  if (!payload) return null;
  if (Date.now() - payload.t > TOKEN_TTL_DAYS * 864e5) return null;          // expired
  const u = DB.users[payload.u];
  if (!u) return null;
  // lets a single account be signed out everywhere, e.g. after a password change
  if (u.tokensValidFrom && payload.t < Date.parse(u.tokensValidFrom)) return null;
  // Oct 2 2026 (#182): THIS one token, individually revoked via POST /api/logout -- every other
  // token the account still holds (other devices) is untouched, unlike tokensValidFrom just
  // above, which is deliberately all-or-nothing. payload.j is only absent on a token issued
  // before this change ever shipped; such a token was never put in revokedJtis by anything, so
  // the lookup below simply misses and that token keeps working exactly as it already did.
  if (payload.j && u.revokedJtis && Object.prototype.hasOwnProperty.call(u.revokedJtis, payload.j)) return null;
  return payload.u;
}

function auth(req, res, next) {
  const t = req.headers['authorization'] || '';
  const userId = userIdFromToken(t.replace(/^Bearer\s/, ''));
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  req.userId = userId;
  next();
}
// Gates the /api/admin/* routes (report review) -- see the comment above ADMIN_TOKEN's setup for
// why this is a standalone token rather than an isAdmin flag on a user account. Deliberately a
// SEPARATE middleware from auth() above, not layered on top of it: reviewing reports is an
// operator action, not a logged-in-user action, and requiring both would mean the token holder
// also needs a live CrewFit login token, which is one more thing to keep valid for no benefit.
// Sep 24 2026 audit round 4 (low finding): this was a plain `!==` string compare, unlike every
// other secret comparison in this file (the PIN check, session-token HMAC, media-token HMAC all
// explicitly use timingSafeEqual with a "constant time" comment) -- and had no rate limit at all,
// unlike /api/login and /api/register just above. A remote attacker with unlimited attempts and
// response-time measurements could in principle guess ADMIN_TOKEN byte-by-byte and gain access to
// real users' report identities plus the ability to resolve moderation reports. Same fix as
// everywhere else in this file: timingSafeEqual (length-checked first, since it throws on a
// length mismatch rather than returning false) and a per-IP rate limit, same shape as /api/login.
function adminAuth(req, res, next) {
  const ip = clientIp(req);
  if (ip && overLimit('admin:' + ip, 20, 60 * 1000))
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' });
  const t = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(t), b = Buffer.from(String(ADMIN_TOKEN || ''));
  if (!ADMIN_TOKEN || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
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
// Powers Settings -> Help -> "Contact us" (see SUPPORT_EMAIL's own comment above). No auth
// needed -- same publicly-fetchable shape as /api/vapid just above, and this specifically needs
// to be reachable before login too (a locked-out or not-yet-registered person still needs a way
// to reach support).
app.get('/api/config', (req, res) => res.json({ supportEmail: SUPPORT_EMAIL }));
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
  // Oct 2 2026 (deep audit finding): unlike every other auth-adjacent route in this file, this one
  // had no rate limit at all -- unauthenticated, and findUserByName does a full linear scan of
  // DB.users per call, so it was both a cheap CPU-exhaustion vector as the user table grows and a
  // free, unthrottled username-enumeration oracle. The client only debounces at 350ms (a UI nicety,
  // not a server cap) -- same overLimit() shape as /api/register itself, just a looser budget since
  // normal typing can fire this several times per second while someone is still choosing a name.
  const ip = clientIp(req);
  if (ip && overLimit('regcheck:' + ip, 120, 5 * 60 * 1000))
    return res.status(429).json({ available: false, reason: 'Too many checks — try again in a moment.' });
  const username = (req.query.username || '').trim();
  if (!username) return res.json({ available: false });
  // Sep 29 2026 (audit finding): usernameProblem() already has a differentiated message for each
  // real reason (too short/invalid characters, reserved word, the deleted_ prefix) -- this was the
  // one place that swallowed it into a bare available:false, so the client always showed
  // "username taken" even when that had nothing to do with the actual problem.
  const problem = usernameProblem(username);
  if (problem) return res.json({ available: false, reason: problem });
  if (findUserByName(username)) return res.json({ available: false, reason: 'That username is already taken' });
  res.json({ available: true });
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
  // Sep 29 2026 (account deletion): findUserByName already can't match a deleted account by its
  // OLD username (the row's username field is overwritten with an anonymized deleted_<id> tag at
  // deletion time, see POST /api/me/delete-account), and its pinHash/pinSalt are scrambled to an
  // unguessable value at the same time — so verifyPin below would already fail on its own. This
  // check is defense in depth, not the only thing stopping it: explicit and immediate rather than
  // relying on hash entropy, and it keeps the failure on the exact same generic "bad credentials"
  // path (no separate wording that would confirm to a caller that an account once existed here).
  if (!u || u.deleted || !verifyPin(u, pin)) {
    noteLoginFail(ipKey);
    bumpFail('acct:' + uname, 60 * 60 * 1000);
    // `code` added Sep 30 2026 (cold-review catch on the friendlier-login-error fix): the client's
    // H._req/doLogin used to match the DISPLAY string 'bad credentials' itself to tell this one 401
    // apart from a real expired-session 401 -- a silent wording change here (punctuation, a
    // friendlier phrase, anything) would have reintroduced the exact bug that fix was for, with
    // nothing enforcing the coupling. `code` is the stable, never-shown-to-a-person contract the two
    // sides actually match on now; `error` stays free to reword for display without breaking it.
    return res.status(401).json({ error: 'bad credentials', code: 'bad_credentials' });
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

// Oct 2 2026 (#182, deep audit finding, Jeff: "Just sign out this device"): logout() in app.js
// used to be purely client-side -- clear the local token, show the login screen -- which is fine
// for the device doing it, but did nothing server-side at all. The token itself stayed valid
// (signed, not remembered -- see signToken's own comment) for up to TOKEN_TTL_DAYS, so anyone who
//'d captured it off that device beforehand (synced browser storage, a shared/public computer, a
// backup) could keep using it right up until expiry, "Log out" notwithstanding. This revokes
// exactly the ONE token presented -- never u.tokensValidFrom, which is the account-wide "every
// device, everywhere" hammer /api/me/password and /api/me/delete-account already use and which
// would defeat the entire point of a per-DEVICE sign-out (every other logged-in device would be
// kicked too, including the one someone's mid-workout on).
// auth() has already validated this exact token by the time this handler runs, so parseToken's
// own signature/shape check here can't fail -- it's just the cleanest way to read back payload.j
// (parseToken is the single shared implementation userIdFromToken's own revocation check also
// reads from, see its comment above).
app.post('/api/logout', auth, async (req, res) => {
  const payload = parseToken((req.headers['authorization'] || '').replace(/^Bearer\s/, ''));
  const u = DB.users[req.userId];
  if (u && payload && payload.j) {
    revokeToken(u, payload.j, payload.t);
    await save(DB);
  }
  res.json({ ok: true });
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
  //
  // Sep 28 2026 (audit finding, Jeff: "'Assisted Pull-up,' 'Band Assisted Pull-up,' and 'Flat
  // Dumbbell Fly' are tagged 'your exercise' on this reviewer account, which never created a
  // custom exercise. Are custom exercises leaking globally, or is the tag wrong?"): the leak part
  // is deliberate and correct -- a custom exercise is shown to every user by design (see the
  // comment on POST /api/exercises/custom below), so the whole library benefits from what anyone
  // adds. The TAG was the actual bug: ownerId was stripped before this response ever reaches the
  // client, so app.js's `e.custom` flag was the only signal it had, and it's true for EVERY custom
  // exercise regardless of who made it -- so it labeled all of them "your exercise" for everyone.
  // This route still needs no login (browsing the library works logged out), so identity is read
  // the same soft, optional way userIdFromToken already supports elsewhere in this file -- a
  // missing/invalid token just means every custom exercise reads as not-mine, same as a guest.
  const myId = userIdFromToken((req.headers['authorization'] || '').replace(/^Bearer\s/, ''));
  const custom = Object.values(DB.customExercises || {}).flat()
    .map(({ ownerId, ...rest }) => {
      const mine = !!myId && ownerId === myId;
      const sanitized = sanitizeExercise(rest);
      // Oct 2 2026 (audit finding -- see the comment on PUT /api/exercises/custom/:id for the
      // full mechanism): only the OWNER's own edit sheet needs to know a custom exercise's muscle
      // group is locked, so this skips the exerciseNameEverLogged scan entirely for every exercise
      // that isn't `mine` -- same reasoning as `mine` itself being the only per-row thing computed
      // against the caller's identity here.
      return Object.assign(sanitized, { mine, historyLocked: mine && exerciseNameEverLogged(sanitized.name) });
    })
    // a custom exercise someone made under a name the library has SINCE adopted (the Sep 2026
    // audit added Dumbbell Romanian Deadlift, Incline Dumbbell Fly, ...) would list twice --
    // findExLibEntry already resolves that name to the library entry, so show only that one
    .filter(c => !EX_LIB.some(e => e.name === c.name));
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
// Sep 30 2026 (audit finding). Two separate, deliberately different rules -- asked and confirmed
// with Jeff, not to be merged into one:
//   - NAME UNIQUENESS: none, on purpose, not even per-user. "Anyone should be able to use whatever
//     name they like" -- two different people (or the same person) can both have a "Band Pull
//     Apart". findExLibEntry's own comment covers the one real bug this caused (a lookup could
//     resolve to the wrong PERSON's entry) and how that's mitigated without touching naming at all.
//   - CONTENT SAFETY: a hard line, not a naming rule -- "barring racial slurs and such". Checked
//     against a maintained word list (leo-profanity, required above) rather than one hand-rolled
//     here. This blocks the word regardless of who's creating it or whether it's already in use.
const KNOWN_PATTERNS = new Set(['push', 'pull', 'legs', 'core', 'cardio']);
app.post('/api/exercises/custom', auth, async (req, res) => {
  const { name, muscle_groups, equipment, level, is_compound, pattern } = req.body || {};
  if (!name || !Array.isArray(muscle_groups) || !muscle_groups.length) return res.status(400).json({ error: 'name + muscle_groups required' });
  const cleanName = capStr(name, 80);
  if (profanityFilter.check(cleanName)) return res.status(400).json({ error: 'That name isn’t allowed. Please pick something else.' });
  // Oct 1 2026 (audit finding, round-2 Tier 1 #2): this didn't used to check the new name against
  // the BUILT-IN library at all -- only GET /api/exercises did, by silently filtering any custom
  // row whose name exactly matches a library one out of every response it returns (its own comment,
  // a few lines up, explains that filter exists for the library LATER adopting a name someone's
  // custom exercise already had -- not for a brand-new custom exercise being created under an
  // existing library name from the start). The save itself used to succeed either way, so an
  // ordinary name like "Push-Up" or "Plank" created a row that vanished from every screen forever:
  // unreachable to edit or delete, permanently burning one of the user's 500 slots, with
  // findExLibEntry always resolving that name to the real library entry instead (it checks EX_LIB
  // first) so none of the custom fields ever took effect. Same exact (case-sensitive) comparison
  // the GET filter and findExLibEntry both already use, so this rejects precisely the names that
  // would otherwise disappear -- nothing stricter. Deliberately separate from, and does not touch,
  // this route's own no-uniqueness-between-custom-exercises rule just above (Jeff: "anyone should
  // be able to use whatever name they like") -- that rule was never about colliding with the
  // built-in library, only with each other.
  if (EX_LIB.some(e => e.name === cleanName))
    return res.status(400).json({ error: 'That’s already a library exercise — search for it instead of creating a new one.' });
  // A custom exercise is shown to every other user, so treat these as hostile. Muscle groups are
  // a closed vocabulary — there is no reason to accept anything outside it.
  const KNOWN_MG = new Set(EX_LIB.flatMap(x => x.muscle_groups || []));
  const mg = muscle_groups.filter(m => typeof m === 'string' && KNOWN_MG.has(m));
  if (!mg.length) return res.status(400).json({ error: 'muscle_groups must be from the library' });
  // Equipment is read back with .toLowerCase() on the client, so a single non-string here threw on
  // every render of that muscle group — for every user, permanently, from one bad POST.
  const equip = (Array.isArray(equipment) ? equipment : [])
    .filter(x => typeof x === 'string').map(x => x.slice(0, 40)).slice(0, 8);
  // Sep 30 2026 (audit finding, Jeff: build the real Pattern field now): this used to default an
  // unrecognized/missing pattern to the muscle group's own name -- which is exactly what made the
  // exercise detail sheet's "Pattern" row read as a mislabeled duplicate of "Primary muscle"
  // rather than an actual movement pattern. Same closed vocabulary the built-in library already
  // uses (push/pull/legs/core/cardio); anything else falls back to 'other', same as a library
  // entry with no real pattern of its own.
  const pat = KNOWN_PATTERNS.has(pattern) ? pattern : 'other';
  DB.customExercises[req.userId] = DB.customExercises[req.userId] || [];
  const ex = {
    id: crypto.randomUUID(),   // Sep 30 2026: stable address for PUT/DELETE below -- see migrateCustomExerciseIds' comment on why name alone can't be one
    name: cleanName,
    pattern: pat,
    category: mg[0] || 'other',                         // a validated group, never raw req.body
    muscle_groups: mg,
    equipment: equip,
    is_compound: !!is_compound,
    level: capStr(level, 20) || 'beginner',
    defaultSets: 3, defaultReps: 10,
    custom: true, ownerId: req.userId
  };
  // Every custom exercise persists into the one data.json AND is served to every user, so an
  // unbounded push is a slow wedge. 500 is far past any real athlete's own library (the built-in
  // one is 203).
  if (DB.customExercises[req.userId].length >= 500)
    return res.status(400).json({ error: 'You have reached the limit of custom exercises.' });
  DB.customExercises[req.userId].push(ex);
  await save(DB);
  res.json(ex);
});
// Sep 30 2026 (audit finding, Jeff: "build now" -- there was no way to edit or delete a custom
// exercise you made). Deliberately does NOT let name be changed: every logged set/session
// exercise/history row references a custom exercise by its NAME string, not this id (id exists
// solely so THIS route can find the right row when duplicate names are allowed -- see the comment
// above POST). Propagating a rename across every place a name is stored is real, separate work
// (the closest existing precedent, migrateExerciseRenames, only ever runs once at boot against a
// fixed table of BUILT-IN renames, not a live per-request rename) -- out of scope here, so name
// stays fixed after creation the same way the built-in library's own names are effectively fixed.
// Every other field (muscle groups, equipment, level, type, pattern) is freely editable, same
// validation as creation.
function findMyCustomExercise(userId, id) {
  return ((DB.customExercises || {})[userId] || []).find(x => x.id === id) || null;
}
app.put('/api/exercises/custom/:id', auth, async (req, res) => {
  const ex = findMyCustomExercise(req.userId, req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  const { muscle_groups, equipment, level, is_compound, pattern } = req.body || {};
  if (!Array.isArray(muscle_groups) || !muscle_groups.length) return res.status(400).json({ error: 'muscle_groups required' });
  const KNOWN_MG = new Set(EX_LIB.flatMap(x => x.muscle_groups || []));
  const mg = muscle_groups.filter(m => typeof m === 'string' && KNOWN_MG.has(m));
  if (!mg.length) return res.status(400).json({ error: 'muscle_groups must be from the library' });
  // Oct 2 2026 (audit finding, Jeff: "I agree, there should be a disclaimer for this also" --
  // flagging that editing a custom exercise's muscle group silently rewrites PAST Progress
  // stats). Confirmed mechanism: every Progress computation that credits a logged set to a
  // muscle group (volumeFor / volumeTrendFor / recentlyTrainedMusclesFor -- see each one's own
  // comment) resolves the exercise LIVE by name through findExLibEntry every single time it
  // runs. There is no snapshot of which muscle(s) a set counted toward at the moment it was
  // logged, so changing muscle_groups here doesn't just affect future sets -- it retroactively
  // changes what every ALREADY-LOGGED set under this name counts toward, silently, with nothing
  // on the Progress page hinting anything changed. Same shape of problem DELETE already guards
  // against (see exerciseNameEverLogged's own comment, directly below) -- once the name has ever
  // been logged by anyone, anywhere, muscle_groups (and category, which is only ever mg[0]) are
  // frozen, exactly like DELETE's name-based, not owner-scoped, check. Create a new exercise if a
  // different muscle group is genuinely needed. The other fields below (equipment / level /
  // is_compound / pattern) are NOT read by any Progress computation -- only display and the
  // add-time default-target suggestion (defaultTargetFor) -- so they stay freely editable even
  // once logged; only muscle_groups/category is locked.
  //
  // Cold-review catch (Oct 2 2026): comparing mg/ex.muscle_groups by JSON.stringify-of-the-raw-
  // array falsely flags a pure REORDER as a change -- exMuscles()/every real Progress computation
  // credits muscle groups by SET MEMBERSHIP in a loop (see exMuscles' own comment), never by
  // position, so ['chest','shoulders'] and ['shoulders','chest'] are identical as far as Progress
  // is concerned. The only thing position affects is `category` (mg[0], display-only, confirmed
  // above). Not reachable through today's UI (both call sites always send a single-element array,
  // where order can't vary), but the route itself should still only block an ACTUAL set change,
  // not a coincidental reorder from some other future or direct-API caller. Compared sorted.
  const mgChanged = exerciseNameEverLogged(ex.name) &&
    JSON.stringify([...mg].sort()) !== JSON.stringify([...ex.muscle_groups].sort());
  if (mgChanged) {
    return res.status(409).json({ error: 'This exercise has logged sets, so its muscle group is locked to protect your past Progress stats. Create a new exercise instead.' });
  }
  const equip = (Array.isArray(equipment) ? equipment : [])
    .filter(x => typeof x === 'string').map(x => x.slice(0, 40)).slice(0, 8);
  ex.muscle_groups = mg;
  ex.category = mg[0] || 'other';
  ex.equipment = equip;
  ex.is_compound = !!is_compound;
  ex.level = capStr(level, 20) || 'beginner';
  ex.pattern = KNOWN_PATTERNS.has(pattern) ? pattern : 'other';
  await save(DB);
  res.json(ex);
});
// Sep 30 2026 (audit finding). A custom exercise's name is the only link a logged set/session
// exercise/history row ever stores back to it (see the comment above PUT) -- deleting the
// DEFINITION can never delete anyone's actual logged data, but it WOULD orphan volume/muscle-group
// credit for any set already logged against it (findExLibEntry would no longer find a match).
// Refused whenever the name has ever been logged by anyone, anywhere -- not narrowed to just this
// owner's own logs, because two different people's custom exercises can share a name on purpose
// (Jeff's own confirmed rule above) and nothing links a stored log entry back to which OWNER's
// definition it meant, only the name string. This can occasionally over-refuse (blocking a delete
// over some OTHER person's same-named entry actually being the one that was logged) but never
// silently breaks anyone's real training history, which is the direction that actually matters.
function exerciseNameEverLogged(name) {
  for (const s of Object.values(DB.sessions || {})) {
    if ((s.exercises || []).some(e => e && e.name === name)) return true;
    for (const arr of Object.values(s.logs || {})) {
      if ((arr || []).some(l => l && l.exerciseName === name)) return true;
    }
    if ((s.history || []).some(h => Array.isArray(h.exercises) && h.exercises.includes(name))) return true;
  }
  return false;
}
app.delete('/api/exercises/custom/:id', auth, async (req, res) => {
  const list = (DB.customExercises || {})[req.userId] || [];
  const ex = list.find(x => x.id === req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  if (exerciseNameEverLogged(ex.name))
    return res.status(409).json({ error: 'This exercise has sets logged against it, so it can’t be deleted. You can still stop using it going forward.' });
  DB.customExercises[req.userId] = list.filter(x => x.id !== req.params.id);
  await save(DB);
  res.json({ ok: true });
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
  const name = currentExerciseName(capStr((req.body || {}).name, 80));   // stale client, old name -- see EXERCISE_RENAMES
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

// Sep 2026 (app-store readiness pass, Apple guideline 1.2 -- UGC apps must let a user block
// abusive accounts): 'blocked' lives on the user object exactly like followers/following/
// followReqs above -- an array of ids THIS account has blocked. Lazily created on first use,
// same pattern as ensureFollowArrays, so every account that existed before this shipped doesn't
// need a migration.
function ensureBlockArray(u) { if (!Array.isArray(u.blocked)) u.blocked = []; }
// Deliberately bidirectional/symmetric: if EITHER account has blocked the other, neither can see
// or interact with the other, regardless of who blocked whom. This matches how blocking works in
// every mainstream social app (Instagram, Twitter/X) -- the blocked person is never told they were
// blocked, but their experience of the blocker (and the blocker's experience of them) is
// identical either way. The alternative (one-directional: only the blocker stops seeing the
// blockee, who can still see and follow the blocker) is what a "mute" would be, not a block, and
// would not satisfy "block abusive users" -- an abusive account could still follow, invite, and
// message someone who blocked them, just without knowing they'd been noticed.
function isBlocked(aId, bId) {
  const a = DB.users[aId], b = DB.users[bId];
  return !!(a && Array.isArray(a.blocked) && a.blocked.includes(bId))
      || !!(b && Array.isArray(b.blocked) && b.blocked.includes(aId));
}
// v190 (profile-privacy unification, Sep 2026): the ONE rule for "can this viewer see {id}'s
// gated stuff" -- profile detail (PRs/streak/activity), a 'public' post, and session joinability
// all resolve through this now, instead of independently-written copies that drift apart (see the
// history below: a second copy of this exact check, keyed on the wrong person, once leaked a
// friends-only recap through a profile page while the session route correctly refused it).
// Public (default, unset counts as public) = anyone. Private is opt-in via Settings = only
// approved followers, and you.
//
// Sep 2026 (app-store readiness): the block check runs FIRST, before the public/private branch,
// and unconditionally overrides it -- a blocked relationship must win over 'public' the same way
// it wins over an approved follower, or blocking someone with a public profile would do nothing
// at all. Every caller of canSeeProfile (profileOf's isApproved, sessionTier's 'friend' tier via
// the line below, /api/sessions/:id/join) inherits this automatically, which is deliberate: one
// change here closes profile visibility, session joinability, and (via canSeePostAuthor, which
// has its own identical block check) posted-recap visibility all at once, instead of needing a
// block check bolted onto every call site independently.
function canSeeProfile(id, viewerId) {
  if (id === viewerId) return true;
  const u = DB.users[id];
  if (!u) return false;
  if (isBlocked(id, viewerId)) return false;
  if (u.profileVisibility !== 'private') return true;
  return (u.followers || []).includes(viewerId);
}
// Pre-existing (profileOf's own local viewerCanSee closure, now just given a name): a workout's
// full detail -- name, date, exercise list, collaborators, recap -- appears on the myWorkouts grid
// only if the viewer could legitimately reach it: their own, a post whose own visibility admits
// them, or a workout they were actually a member/invited of. Session-reader-privacy.mjs's own "a
// Public profile must not broadcast a Private-visibility session's metadata to a stranger" is what
// this guards.
function sessionViewableOnProfile(s, profileOwnerId, viewerId) {
  if (profileOwnerId === viewerId) return true;
  if (canSeePostAuthor(s.posts && s.posts[profileOwnerId], profileOwnerId, viewerId, s)) return true;
  const t = sessionTier(s, viewerId);
  return t === 'member' || t === 'invited';
}
// Oct 2 2026 (deep audit finding): the PR/Recent-Activity leak this closes is narrower than
// myWorkouts' own -- a PR is just the profile owner's OWN bare achievement number (exercise,
// weight, reps), not the full workout detail myWorkouts renders, and this app's profile model
// already treats that as the owner's to show to anyone who can see their profile at all ("the
// guest's own best lift is the guest's to show their own friend -- that is what a profile is",
// exposure.mjs's own comment; follow.mjs's whole flow is bob's own PR from his own PRIVATE,
// never-posted session reaching an approved follower). The ACTUAL Oct 2 audit finding was
// specifically about POSTS: "User A posts a session 'private' ... Recent Activity/prs still
// handed over the exact weight/reps" to someone who was never in that session -- i.e. a PR must
// respect the profile owner's OWN explicit privacy choice on a recap THEY posted, but there is
// nothing to additionally restrict when they never made that choice at all. sessionViewableOnProfile
// (above) was this function's first draft, reusing myWorkouts' own stricter member/invited-tier
// rule wholesale -- caught breaking exactly those two pre-existing tests the same day, since that
// tier requirement silently applies even when there's no post at all to be strict ABOUT.
function achievementViewableOnProfile(s, profileOwnerId, viewerId) {
  if (profileOwnerId === viewerId) return true;
  const post = s.posts && s.posts[profileOwnerId];
  if (!post) return true;
  return canSeePostAuthor(post, profileOwnerId, viewerId, s);
}
// ---- Profile (per-user, viewable by anyone logged in) ----
// localToday: the CALLER's own local day (see the comment above currentStreak) — only honored
// below when id === viewerId, i.e. this is genuinely a self-view. Whoever is viewing someone
// ELSE's profile has no way to know that person's timezone, so a friend's streak still falls back
// to the server's UTC approximation, same as it always has.
function profileOf(id, viewerId, localToday) {
  const u = DB.users[id];
  if (!u) return null;
  // Oct 2 2026 (Tier 3 #157, Jeff: "you should not be able to view a blocked profile - that
  // profile should no longer be viewable after they are blocked. The person that blocked them has
  // access to seeing the profile only in the blocked section. The person who was blocked will not
  // be able to see them anywhere."): canSeeProfile already folded isBlocked into isApproved below,
  // but isApproved only ever gated the PRs/streak/activity block -- the rest of this function
  // (publicUser's name/avatar/bio/follower-counts, myWorkouts, youFollow, workoutsCompleted) kept
  // returning in full, so a blocked relationship rendered as a thinner PRIVATE profile instead of
  // no profile at all. That's the exact mislabeling bug: client-side this was indistinguishable
  // from "private, not following," right down to reusing "This profile is private" copy and a
  // Follow button that always 403'd (POST /api/follow also resolves through canSeeProfile).
  // Short-circuits with a minimal, deliberately unidentifying shape -- no name, avatar, bio, or
  // counts in either direction -- before any of the real profile is assembled. Bidirectional and
  // symmetric, same as isBlocked itself: it doesn't matter who blocked whom, neither party's
  // client gets anything to render as a profile. The one deliberate exception is Settings ->
  // Blocked accounts (GET /api/blocked), which never calls profileOf at all -- it reads
  // publicUser() directly off the blocker's own me.blocked array, so the carve-out ("the blocker
  // can still see who they blocked, but only from that list") already works without this function
  // needing to know about it.
  if (viewerId && id !== viewerId && isBlocked(id, viewerId)) {
    return { id, blocked: true };
  }
  const selfToday = id === viewerId ? localToday : undefined;
  // workouts completed: distinct sessions with a history entry by this user,
  // OR sessions this user posted (saved) — both count as a completed workout
  const completed = new Set();
  for (const s of Object.values(DB.sessions)) {
    if ((s.history || []).some(h => h.userId === id)) completed.add(s.id);
    else if (s.posts && s.posts[id]) completed.add(s.id);
  }
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
  const viewerCanSee = s => sessionViewableOnProfile(s, id, viewerId);
  // Oct 2 2026 (deep audit finding, HIGH privacy leak): rebuildAllPrs() builds DB.prs[id] from
  // every session's logs with zero visibility check -- prs/recentActivity only ever gated on
  // isApproved (profile-level follow approval), never on the individual session's OWN
  // post.visibility. Concretely: User A posts a session 'private' ("only the creator or who was
  // part of it" -- Jeff's own words) and sets a PR in it; User B, who was never in that session
  // but can see A's profile (Public by default, or an approved follower), could not see the
  // workout itself in myWorkouts, but Recent Activity and the prs array still handed over the
  // exact exercise/weight/reps. Fixed via achievementViewableOnProfile, deliberately NOT the same
  // viewerCanSee/sessionViewableOnProfile myWorkouts uses just below -- see that function's own
  // comment for why a bare PR number and a full workout tile need two different rules here, and
  // the same-day cold-review catch (two pre-existing tests, follow.mjs/exposure.mjs) that proved
  // it. A PR whose session has since been deleted fails closed (hidden) for anyone but the owner,
  // same instinct as every other "can't resolve it, so don't show it" fallback in this file.
  const prVisibleToViewer = pr => {
    const s = pr.sessionId && DB.sessions[pr.sessionId];
    if (!s || !achievementViewableOnProfile(s, id, viewerId)) return null;
    // A set-PR (VOLUME pill) can come from a DIFFERENT session than the weight-PR on the same
    // record -- if that second session isn't visible to this viewer, strip just the set-PR
    // fields rather than hiding the whole (otherwise-visible) weight record over it.
    if (pr.setSessionId && pr.setSessionId !== pr.sessionId) {
      const s2 = DB.sessions[pr.setSessionId];
      if (!s2 || !achievementViewableOnProfile(s2, id, viewerId)) {
        const { setWeight, setReps, setUnit, setAt, setFirstLog, setSessionId, ...rest } = pr;
        return rest;
      }
    }
    return pr;
  };
  const rawPrs = (DB.prs && DB.prs[id]) ? Object.values(DB.prs[id]) : [];
  const prs = id === viewerId ? rawPrs : rawPrs.map(prVisibleToViewer).filter(Boolean);
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
      // Sep 24 2026 (audit finding): this used to rebuild itself from the LIVE s.participants on
      // every view, the exact bug the Sep 23 trainedWith snapshot fixed on the full recap
      // (viewPost) but never got ported to this Profile-tab tile preview -- same session, same
      // posted recap, two different "who trained with them" answers depending which screen you're
      // on. A departed training partner vanished from this tile while still correctly showing on
      // the full recap; worse, if someone else later joined the same session object, they'd show
      // up here as a collaborator despite never having trained it. Use the raw post's own
      // trainedWith snapshot (independent of whether THIS viewer is allowed to see the post's
      // content) when one exists; only fall back to live participants for a workout that hasn't
      // been posted yet, where no snapshot exists at all.
      const rawPost = s.posts && s.posts[id];
      const trainedWithIds = rawPost && Array.isArray(rawPost.trainedWith) ? rawPost.trainedWith : null;
      const others = inIt ? new Set((trainedWithIds || (s.participants||[])).filter(x=>x && x!==id)) : new Set();
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
    // Self only. null (not defaulted to any phase) for anyone who hasn't saved a pick yet -- see
    // the /api/me/training-phase route's own comment for why this must never silently default.
    trainingPhase: id === viewerId ? (TRAINING_PHASE_KEYS.has(u.trainingPhase) ? u.trainingPhase : null) : undefined,
    // Self only — the OTHER profile's own visibility isn't a thing a viewer needs (canSeeProfile
    // already decided whether they can see the gated stuff below); the Settings screen's own
    // Private/Public toggle is the only reader of this. Public unless explicitly set to
    // 'private', same rule as canSeeProfile.
    profileVisibility: id === viewerId ? (u.profileVisibility === 'private' ? 'private' : 'public') : undefined,
    // Self only, same "lazy boolean, unset reads as false" shape as the other self-only flags
    // just above. Oct 9 2026 (audit finding, Jeff's pick among options): lets the client show a
    // one-time explainer the FIRST time anyone on this account ever taps the RIR toggle while
    // logging a set, then never again -- see /api/me/rir-explainer-seen below and toggleRirInput
    // in app.js. Account-level (not per-device localStorage) so the explainer genuinely shows once
    // per person, not once per browser/device they happen to log from.
    seenRirExplainer: id === viewerId ? !!u.seenRirExplainer : undefined,
    workoutsCompleted: completed.size,
    // the follow button's state, and whether they follow you back
    youFollow: id === viewerId ? 'self'
      : ((u.followers || []).includes(viewerId) ? 'following'
      : ((u.followReqs || []).includes(viewerId) ? 'requested' : 'none')),
    followsYou: !!(viewerId && id !== viewerId && (DB.users[viewerId].followers || []).includes(id)),
    // Oct 10 2026 (audit finding): the ONLY place a pending incoming follow request was visible
    // used to be Notifications/the Friends-tab list -- landing on the requester's own profile
    // directly (search, a mutual crew, a shared workout...) showed nothing at all about it, so the
    // one person who most needs to see "they want to follow you, Accept/Decline right here" (the
    // viewer, about to decide whether to look closer at this exact profile) had no idea unless
    // they'd separately already seen it elsewhere. Same shape as followsYou just above, just
    // checking the VIEWER's own followReqs (pending incoming requests FOR them) instead of their
    // followers -- true only when `id` (the profile being viewed) is the one who sent it.
    requestedToFollowYou: !!(viewerId && id !== viewerId && (DB.users[viewerId].followReqs || []).includes(id)),
    // Sep 2026: whether the VIEWER has blocked this profile -- drives the Block/Unblock menu item
    // client-side. Deliberately not "did this profile block the viewer" (that's not the viewer's
    // business to know, same as every other block implementation -- see isBlocked's comment).
    youBlocked: !!(viewerId && id !== viewerId && (DB.users[viewerId].blocked || []).includes(id)),
    myWorkouts,
    // Below the line — approved followers (and you) only. The workout count and follower/following
    // counts from publicUser above stay public.
    prCount: isApproved ? prs.length : null,
    prs: isApproved ? prs.slice().sort((a,b)=> new Date(b.at) - new Date(a.at)) : [],
    streak: isApproved ? currentStreak(id, selfToday) : null,
    recentActivity: isApproved ? buildActivityFor(id, viewerId, selfToday) : [],
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
// Recent activity for a single user: PRs and weekly completions (most recent first). No longer
// includes a day-streak row -- see the comment where that used to be pushed, below.
// localToday: unused within this function as of Sep 30 2026 (the one thing it fed, the streak
// row, is gone) but left on the signature/call sites rather than threading a removal through
// profileOf too, in case a future recentActivity item needs a caller-local "today" again.
function buildActivityFor(userId, viewerId, localToday) {
  const items = [];
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  // Oct 2 2026 (deep audit finding, HIGH privacy leak): same gap as profileOf's own `prs` -- these
  // PR items used to come straight from DB.prs[userId] with no per-session visibility check at
  // all, so a private workout's exact PR (exercise/weight/reps) still surfaced in Recent Activity
  // to anyone who could merely see the profile. Filter through achievementViewableOnProfile, the
  // same rule profileOf's own `prs` uses and for the same reason (NOT sessionViewableOnProfile --
  // see that function's own comment on why a bare achievement number and a full workout tile need
  // two different rules), same as there a PR whose session has since been deleted fails closed for
  // anyone but the owner.
  const rawPrs = (DB.prs && DB.prs[userId]) ? Object.values(DB.prs[userId]) : [];
  const prs = userId === viewerId ? rawPrs : rawPrs
    .map(pr => {
      const s = pr.sessionId && DB.sessions[pr.sessionId];
      if (!s || !achievementViewableOnProfile(s, userId, viewerId)) return null;
      if (pr.setSessionId && pr.setSessionId !== pr.sessionId) {
        const s2 = DB.sessions[pr.setSessionId];
        if (!s2 || !achievementViewableOnProfile(s2, userId, viewerId)) {
          const { setWeight, setReps, setUnit, setAt, setFirstLog, setSessionId, ...rest } = pr;
          return rest;
        }
      }
      return pr;
    })
    .filter(Boolean);
  items.push(...groupPrsForFeed(prs, weekAgo));
  // Same visibility rule applied to the weekly-completion count/text -- lower severity than the
  // PR leak above (it's just a number, no exercise/weight detail), but the same class of gap:
  // "completed N workouts this week" used to count every session with a history entry regardless
  // of that session's own privacy.
  let count = 0, latest = 0;
  for (const s of Object.values(DB.sessions)) {
    if (userId !== viewerId && !achievementViewableOnProfile(s, userId, viewerId)) continue;
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
  // Sep 30 2026 (Jeff, audit Tier 4c, cold-review catch): this used to also push a
  // "hit a N day workout streak" row here -- the exact per-calendar-day streak concept Jeff asked
  // to drop everywhere ("we don't need the consecutive days with a finished workout -- as this
  // will ALWAYS be killed by a rest day. Leave only the week in progress"). Removing just the
  // profile/crew pills and leaving this text row was an incomplete read of that instruction -- a
  // cold review of the pill-removal screenshots caught this same text still rendering right below
  // the stats row it was supposed to be gone from. currentStreak() itself is untouched (still
  // powers the separate streak-loss-reminder push below).
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
  // Oct 1 2026 (Jeff, re-raising the Sep 29 "if they are blocked they shouldn't show at all --
  // similar to how instagram is" rule, this time against OTHER people's follower/following lists,
  // not just the search box): canSeeProfile just above only checks the relationship between the
  // viewer and THIS profile's owner (id) -- it says nothing about the people actually IN the list.
  // Browsing some third party's followers was a real way to find someone you'd blocked (or who'd
  // blocked you) by name, exactly the search-box leak that was already closed, just reached from a
  // different screen. Filtered the same bidirectional way isBlocked() always is -- the entry simply
  // isn't in the list, no error, same as a blocked search result just not turning up.
  // Oct 9 2026 (audit finding, Jeff's pick among options): this used to come back in whatever
  // order `u[kind]` happened to store ids (the order follows/being-followed actually occurred in)
  // -- fine for a handful of connections, but on a real account with dozens of them there was no
  // way to scan for a specific person except reading the whole list top to bottom. Sorted
  // alphabetically by the same name the client actually displays (displayName, falling back to
  // username exactly like the row template does) so it reads the same order a person expects from
  // any contacts list. localeCompare's sensitivity:'base' makes the sort case- and accent-insensitive
  // (so "bob" and "Bob" land together) without changing anything about what's actually shown.
  return (u[kind] || []).filter(fid => DB.users[fid] && !isBlocked(fid, viewerId)).map(fid => publicUser(fid))
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username, undefined, { sensitivity: 'base' }));
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
  const u = DB.users[req.userId];
  // Sep 24 2026 audit round 4 (low finding, storage hygiene only -- no security impact, since
  // avatars are meant to be public and req.userId comes from the auth token, never client input):
  // the old avatar file was never cleaned up when a re-upload lands under a DIFFERENT extension
  // (e.g. a PNG-sourced crop first, later a JPEG-sourced one) -- `avatar_<id>.png` and
  // `avatar_<id>.jpg` would both sit in UPLOAD_DIR forever, only one of them ever referenced.
  // Same-extension re-uploads already self-cleaned by simply overwriting the one file. Best-effort
  // unlink: nothing here should fail the request over a leftover file that's merely unreferenced.
  const prevPath = u.avatar ? path.join(UPLOAD_DIR, path.basename(u.avatar)) : null;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(b64, 'base64'));
  if (prevPath && path.basename(prevPath) !== fname) {
    try { fs.unlinkSync(prevPath); } catch (e) {}
  }
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
// Sep 29 2026 (Jeff: "add an edit display name or username"). displayName has no uniqueness rule
// (never has — see registration, where duplicate display names are already allowed and disambiguated
// by the @username everywhere they're shown together) and, unlike bio/defaultGym, isn't allowed to
// go empty: it's the one thing every profile card/feed row renders as the headline. capStr(...,80)
// matches the same cap registration itself already applies to a display name.
app.post('/api/me/display-name', auth, async (req, res) => {
  const { displayName } = req.body || {};
  const v = capStr(displayName, 80).trim();
  if (!v) return res.status(400).json({ error: 'Display name cannot be empty' });
  DB.users[req.userId].displayName = v;
  await save(DB);
  res.json({ displayName: v });
});
// Same usernameProblem + case-insensitive uniqueness rule registration already enforces (see
// usernameProblem, findUserByName, and the Aug-2026 comment above normUser on why exact-match
// comparison was a real bug). findUserByName's own match has to be excluded when it's just this
// account matching itself (e.g. re-submitting the same username unchanged, or a same-username-
// different-case correction like "Jordan" -> "jordan").
// Sep 30 2026 (audit finding, round-2 Tier 1 #1): username IS the login credential (/api/login
// authenticates by username, server.js:708-756) and password reset is permanently disabled
// (/api/forgot below, "ask Jeff") -- yet this route used to change it with nothing but a valid
// session token, no proof the caller actually knows the account's password. A stolen/leaked token
// alone was enough to silently rename someone out of their own account, with no self-service way
// back in. Now requires the current password, same bar and same shared 'pw-confirm:' counter as
// /api/me/password, /api/me/reset-workouts and /api/me/delete-account (see /api/me/password's own
// comment on why it's one shared 10/hour budget across all four routes, not 10 per route). No
// tokensValidFrom bump here, unlike a real password change -- the old session's token is still
// valid for the same account id either way; what this closes is an ATTACKER without the password
// being able to make the change at all, not a need to sign other devices out afterward.
app.post('/api/me/username', auth, async (req, res) => {
  if (failCount('pw-confirm:' + req.userId) >= 10)
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { username, password } = req.body || {};
  const u = DB.users[req.userId];
  // 400, not 401 -- same reasoning as POST /api/me/password: this request already carries a VALID
  // auth token, so a wrong confirmation password must not trip app.js's global "any 401 means your
  // session died" handler and force a surprise logout.
  if (!password || !verifyPin(u, password)) {
    bumpFail('pw-confirm:' + req.userId, 60 * 60 * 1000);
    return res.status(400).json({ error: 'Password is incorrect' });
  }
  clearFail('pw-confirm:' + req.userId);
  const uProblem = usernameProblem(username);
  if (uProblem) return res.status(400).json({ error: uProblem });
  const existing = findUserByName(username);
  if (existing && existing.id !== req.userId) return res.status(409).json({ error: 'username taken' });
  u.username = String(username).trim();
  await save(DB);
  res.json({ username: u.username });
});
// Distinct from the disabled /api/forgot + /api/reset above (which took no proof of identity at
// all — see the long comment there on why they're off) — this requires the CURRENT password,
// which only someone already able to log in has, so it carries none of that risk. The one and
// only self-service credential change this app offers today; "forgot" recovery genuinely has no
// safe implementation yet (no email/phone on file to verify against — same comment).
app.post('/api/me/password', auth, async (req, res) => {
  // Sep 29 2026 (audit finding, Tier 1 #1): this route already carries a valid session token, so
  // the only thing standing between a stolen token and the account's real password was however
  // many guesses someone wanted to make -- nothing here ever capped them. Same failCount/bumpFail/
  // clearFail pattern login already uses for its own per-account lockout (above) rather than a
  // blanket overLimit -- this only counts WRONG guesses against the cap and clears it on a
  // successful one, so a real user changing their password repeatedly (or this route being called
  // legitimately many times, e.g. in tests) never trips it; only a run of actual wrong guesses does.
  // Keyed on req.userId, not IP, since a stolen token can come from any IP. Cold-review catch (Sep
  // 29 2026): the 'pw-confirm:' key is deliberately SHARED with /api/me/reset-workouts and
  // /api/me/delete-account below, not a separate key per route -- all three check the exact same
  // verifyPin(u, ...) against the same account's real password, so a per-route counter would have
  // let a stolen token get 3x the effective guess budget just by rotating which of the three
  // routes it hit.
  if (failCount('pw-confirm:' + req.userId) >= 10)
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { currentPassword, newPassword } = req.body || {};
  const u = DB.users[req.userId];
  // 400, deliberately not 401: this request already carries a VALID auth token (it passed `auth`
  // above) -- the wrong thing here is the current-password confirmation, not the session. app.js's
  // shared H._req treats ANY 401 from ANYWHERE as "your session is dead," wipes the token, and
  // force-logs-out back to the auth screen (see its own comment) -- a wrong-password typo here
  // would otherwise silently sign the user out instead of showing them the actual error. Caught by
  // rendering this for real, not just by reading the code (see CLAUDE.md's own verification rule).
  if (!currentPassword || !verifyPin(u, currentPassword)) {
    bumpFail('pw-confirm:' + req.userId, 60 * 60 * 1000);
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  clearFail('pw-confirm:' + req.userId);
  const pProblem = pinProblem(newPassword);
  if (pProblem) return res.status(400).json({ error: pProblem });
  Object.assign(u, hashPin(newPassword));
  // Sep 29 2026 (audit finding, Tier 1 #3): userIdFromToken's own comment above already says this
  // field "lets a single account be signed out everywhere, e.g. after a password change" -- it was
  // checked there but never actually assigned anywhere, so that sentence was aspirational, not
  // real: every OTHER session stayed valid for up to TOKEN_TTL_DAYS (90) after a password change.
  // Setting it here is what actually closes that. This device's own request already carries a
  // token whose payload.t predates the timestamp being set below, so without doing anything else
  // this exact device would immediately fail its own next request -- a surprise logout right after
  // successfully changing your password, the same class of bug the 400-not-401 comment above this
  // route already goes out of its way to avoid. Fixed the same way: mint this device a fresh token
  // (signToken uses Date.now(), which is monotonic and therefore never earlier than the
  // tokensValidFrom timestamp just written) and hand it back so app.js can swap it in silently.
  u.tokensValidFrom = new Date().toISOString();
  await save(DB);
  res.json({ ok: true, token: signToken(u.id) });
});
// Following is a REQUEST now, not an instant grant. It stays pending until the target accepts.
app.post('/api/follow/:id', auth, async (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (req.params.id === req.userId) return res.status(400).json({ error: 'cannot follow self' });
  // Sep 2026 (app-store readiness): a blocked relationship (either direction) refuses a new
  // follow outright. Doesn't reveal WHICH direction the block is in -- same generic wording
  // either way, so this can't be used to probe whether someone blocked you.
  if (isBlocked(req.userId, req.params.id)) return res.status(403).json({ error: 'unable to follow this account' });
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
    notify(target.id, { title: 'New follower', body: `${DB.users[req.userId].displayName} started following you`, link: { type: 'profile', userId: req.userId } });
    // Sep 12 2026 (Jeff, three new Activity events): the notify() above is the private 1:1 heads-up
    // to the person being followed; this is the separate, public Activity-feed record of it, shown
    // to whoever is connected to the FOLLOWER (by design -- see CREW_SCOPED_FEED_TYPES' comment
    // above, this type is intentionally not crew-scoped).
    emitFeedEvent('started_following', req.userId, { targetId: target.id, targetName: target.displayName, text: `started following ${target.displayName}` });
    return res.json({ status: 'following' });
  }
  if (!target.followReqs.includes(req.userId)) {
    target.followReqs.push(req.userId);
    await save(DB);
    // history:false -- this is the live, still-pending "wants to follow you" ask, already shown
    // as an actionable row in GET /api/notifications' followRequests while it's pending; the
    // accepted/rejected outcome (line ~995 below) gets its own history entry instead.
    notify(target.id, { title: 'New follow request', body: `${DB.users[req.userId].displayName} wants to follow you`, link: { type: 'notifications' } }, { history: false });
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
// Sep 2026, Jeff: "remove followers from us on their account" -- the mirror image of
// /api/unfollow above (that one is ME choosing to stop following SOMEONE ELSE; this one is ME
// forcing SOMEONE ELSE to stop following ME). Deliberately one-directional: only touches
// me.followers (they're no longer approved to see my private stuff) and target.following (they no
// longer show me in their own following list) -- it does NOT touch me.following or
// target.followers, so if I also follow them, that direction is untouched. Nothing here stops them
// from sending a new follow request afterward (that's what Block is for, see blockUser above) --
// this only ends the CURRENT follow, same as the confirm sheet tells the user on the client.
app.post('/api/remove-follower/:id', auth, async (req, res) => {
  const target = DB.users[req.params.id];
  if (!target) return res.json({ ok: true });
  const me = DB.users[req.userId]; ensureFollowArrays(me); ensureFollowArrays(target);
  if (req.params.id === req.userId) return res.status(400).json({ error: 'cannot remove yourself' });
  me.followers = me.followers.filter(x => x !== req.params.id);
  target.following = target.following.filter(x => x !== req.userId);
  await save(DB);
  res.json({ ok: true, followers: me.followers.length });
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
  if (from) notify(fromId, { title: 'Follow request accepted', body: `${me.displayName} accepted your follow request`, link: { type: 'profile', userId: req.userId } });
  // Sep 12 2026: the private-profile mirror of the immediate-follow emit in POST /api/follow above
  // -- the follow only actually takes effect here (line ~1107), not when the request was sent, so
  // this is where the Activity-feed record belongs. `by` is the follower (fromId), same as the
  // immediate-follow path.
  if (from) emitFeedEvent('started_following', fromId, { targetId: req.userId, targetName: me.displayName, text: `started following ${me.displayName}` });
  res.json({ ok: true });
});
app.post('/api/follow-requests/:id/reject', auth, async (req, res) => {
  const me = DB.users[req.userId]; ensureFollowArrays(me);
  me.followReqs = me.followReqs.filter(x => x !== req.params.id);
  await save(DB);
  res.json({ ok: true });
});

// ---- Block / unblock (Sep 2026, app-store readiness: Apple guideline 1.2 requires letting
// users block abusive accounts in apps with social/UGC features) ----
// Blocking severs any existing follow relationship in BOTH directions and cancels any pending
// follow request either way -- an already-approved follower you've decided to block should not
// keep seeing your stuff just because they followed you before you blocked them, and a pending
// "wants to follow you" request from someone you're blocking should not sit there waiting for an
// answer you're never going to give. Nothing about a session the two of you already trained
// together is touched here (see the long comment on canSeePostAuthor's own block check above for
// why that's a deliberate, separate scope decision) -- this only affects the follow graph and,
// through canSeeProfile/canSeePostAuthor, everything gated by it going forward.
//
// Extracted so /api/block/:id (below) and the "also block" option on /api/report (further down)
// share exactly one implementation rather than two copies of the same follow-graph cleanup
// drifting apart over time. Returns false (does nothing) for a missing target or blocking
// yourself, so callers can no-op safely rather than needing their own guard first.
function blockUser(blockerId, targetId) {
  const me = DB.users[blockerId], target = DB.users[targetId];
  if (!me || !target || blockerId === targetId) return false;
  ensureBlockArray(me); ensureFollowArrays(me);
  ensureFollowArrays(target);
  if (!me.blocked.includes(targetId)) me.blocked.push(targetId);
  me.following = me.following.filter(x => x !== targetId);
  me.followers = me.followers.filter(x => x !== targetId);
  me.followReqs = me.followReqs.filter(x => x !== targetId);
  target.following = target.following.filter(x => x !== blockerId);
  target.followers = target.followers.filter(x => x !== blockerId);
  target.followReqs = target.followReqs.filter(x => x !== blockerId);
  return true;
}
app.post('/api/block/:id', auth, async (req, res) => {
  if (!DB.users[req.params.id]) return res.status(404).json({ error: 'user not found' });
  if (req.params.id === req.userId) return res.status(400).json({ error: 'cannot block yourself' });
  blockUser(req.userId, req.params.id);
  await save(DB);
  res.json({ ok: true, blocked: true });
});
app.post('/api/unblock/:id', auth, async (req, res) => {
  const me = DB.users[req.userId];
  ensureBlockArray(me);
  me.blocked = me.blocked.filter(x => x !== req.params.id);
  await save(DB);
  res.json({ ok: true, blocked: false });
});
// Powers Settings -> Blocked accounts. publicUser() is the same headline-only shape used
// everywhere else a list of OTHER people's accounts is returned (followList, etc.) -- a blocked
// account you can no longer see the private detail of, but you still get to see who it was to
// manage the list.
app.get('/api/blocked', auth, async (req, res) => {
  const me = DB.users[req.userId];
  ensureBlockArray(me);
  res.json(me.blocked.filter(id => DB.users[id]).map(id => publicUser(id)));
});

// ---- Report content / a user (Sep 2026, app-store readiness: Apple guideline 1.2) ----
// Deliberately simple: this is a single-operator app with no moderation team, so a report is
// stored durably and reviewed by Jeff (or whoever holds ADMIN_TOKEN) through GET /api/admin/
// reports below -- there is no automated action taken against the reported account, and reporting
// something does not by itself hide it from anyone. What DOES take immediate effect is the
// reporter's own view: alsoBlock (below) runs the exact same blockUser() the Block button uses,
// so "report and block" is one tap, matching what every mainstream app offers from a report sheet.
const REPORT_REASONS = ['spam', 'harassment', 'inappropriate', 'impersonation', 'other'];
const REPORT_TARGET_TYPES = ['user', 'post', 'comment'];
app.post('/api/report', auth, async (req, res) => {
  // Sep 8 2026 (cold-review finding): unlike /api/register and /api/login, this had no cap at
  // all -- one account could flood DB.reports without limit, burying real reports on the one
  // review screen that reads it (GET /api/admin/reports has no pagination either, which is a
  // known, accepted tradeoff for a single-operator app -- but it makes an unbounded flood worse,
  // not just annoying). Keyed per-user (not per-IP like login/register) since the thing being
  // protected here is the review queue's signal-to-noise, not a brute-force target.
  if (overLimit('report:' + req.userId, 30, 60 * 60 * 1000))
    return res.status(429).json({ error: 'Too many reports. Please try again later.' });
  const b = req.body || {};
  if (!REPORT_TARGET_TYPES.includes(b.targetType)) return res.status(400).json({ error: 'invalid report' });
  if (!REPORT_REASONS.includes(b.reason)) return res.status(400).json({ error: 'invalid report' });
  const targetUserId = (typeof b.targetUserId === 'string' && DB.users[b.targetUserId]) ? b.targetUserId : null;
  // A 'user' report always needs a real targetUserId; 'post'/'comment' reports are still useful
  // without one resolving (the content itself, named by sessionId/authorId/commentId below, is
  // the point) but in practice always carry one too since every post/comment has an author.
  if (b.targetType === 'user' && !targetUserId) return res.status(400).json({ error: 'invalid report' });
  const id = 'rep_' + uid();
  // sessionId/authorId/commentId are optional context for post/comment reports, capped and
  // stored as opaque labels only -- never dereferenced or trusted as anything but text an admin
  // reads on the review screen, so a stale or fabricated id here can't do anything but show up
  // oddly on that screen.
  DB.reports[id] = {
    id, reporterId: req.userId, targetType: b.targetType, targetUserId,
    sessionId: capStr(b.sessionId, 60), authorId: capStr(b.authorId, 60), commentId: capStr(b.commentId, 60),
    reason: b.reason, details: capStr(b.details, 1000),
    at: new Date().toISOString(), status: 'open',
  };
  if (b.alsoBlock && targetUserId) blockUser(req.userId, targetUserId);
  await save(DB);
  res.json({ ok: true });
});
// ---- Admin: review reports (Sep 2026) ----
// See adminAuth's comment for why this is token-gated rather than tied to a user account.
// Deliberately minimal -- list + resolve, no reply/messaging, no per-report detail route (the
// list already carries everything a report has). reporter/target are resolved to a display name
// server-side so /admin.html never has to make a second round trip per row.
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  const nameOf = id => { const u = DB.users[id]; return u ? (u.displayName || u.username) : (id ? '(deleted account)' : ''); };
  const list = Object.values(DB.reports || {})
    .map(r => ({ ...r, reporterName: nameOf(r.reporterId), targetName: nameOf(r.targetUserId) }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json(list);
});
app.post('/api/admin/reports/:id/resolve', adminAuth, async (req, res) => {
  const r = DB.reports[req.params.id];
  if (!r) return res.status(404).json({ error: 'not found' });
  r.status = 'resolved';
  r.resolvedAt = new Date().toISOString();
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
  // Sep 29 2026 (audit finding, Jeff: "if they are blocked they shouldn't show at all - similar to
  // how instagram is"): isBlocked() is already bidirectional (either side blocking hides both from
  // each other, see its own comment) -- this route was the one place that never checked it, so a
  // blocked person could still be found by name and would only hit the block on an actual follow
  // attempt. Filtering them out of results entirely means there's no longer a raw server error to
  // word better either -- they just don't turn up, same as Instagram.
  const hits = Object.values(DB.users).filter(u => u.id!==me && !isBlocked(u.id, me) && (
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
  // Oct 10 2026 (audit finding, same fix shape as followListFor's own Oct 9 2026 sort): this came
  // back in whatever order connectionsOf's Set happened to iterate (follow order), not a real
  // order a person could scan -- every picker built from this list (the invite-friends checklist
  // in createFlow, the share-routine target list in tplShareSheet) inherited that same
  // can't-find-anyone-past-a-handful problem a search box alone wouldn't fix on its own. Sorted
  // alphabetically by displayName (falling back to username), same localeCompare/sensitivity:'base'
  // convention as followListFor, so every friends-list surface in the app now agrees on one order.
  const friends = connectionsOf(req.userId).map(id => ({ ...publicUser(id), streak: currentStreak(id) }))
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username, undefined, { sensitivity: 'base' }));
  res.json({
    friends,
    followRequests: (me.followReqs || []).map(id => DB.users[id] ? publicUser(id) : null).filter(Boolean)
  });
});

// ---- Crews (Sep 2026, Jeff: "make the collaboration side stronger") ----
// Everything above is either 1:1 (a connection) or scoped to one workout (invited/participants).
// A crew is the missing standing group: name it once, and from then on invite the whole thing to
// a workout in one tap (client-side only -- see createFlow()/templateExercises() in app.js, which
// just pre-check every member's existing invite checkbox, so accept/decline/join-request all keep
// working exactly as they already do) and talk in one thread that outlives any single workout,
// unlike s.comments above (deliberately scoped to "while this workout is open," see its own
// comment). ownerId is always also a member of memberIds -- there is no separate "owner list" to
// keep in sync, the owner is just a member with rename/edit-membership/delete rights. No boot
// migration: crews is a brand-new collection, EMPTY_DB() already defaults it to {}, so there is no
// legacy shape to heal.
const CREW_NAME_MAX = 40;
const CREW_MAX_MEMBERS = 20;      // a "crew," not a broadcast list
const CREW_MSG_MAX = 2000;        // same cap as session/post comments above

function ensureCrewShape(c) {
  if (!Array.isArray(c.memberIds)) c.memberIds = [];
  // Oct 2 2026 (#178, deep audit finding): guarded on c.ownerId being truthy -- see the
  // "ownerless crew" comment on POST /api/me/delete-account's cleanup loop below for why
  // c.ownerId can now legitimately be null. Without this guard, the very next read of an
  // ownerless crew would push the literal value `null` into memberIds (`[].includes(null)` is
  // false, same as any other missing id), which would then render as a phantom roster row,
  // double-count against CREW_MAX_MEMBERS, and corrupt challenge-progress math that iterates
  // memberIds expecting every entry to be a real user id.
  if (c.ownerId && !c.memberIds.includes(c.ownerId)) c.memberIds.push(c.ownerId);
  if (!Array.isArray(c.messages)) c.messages = [];
  if (!Array.isArray(c.challenges)) c.challenges = [];
}
function isCrewMember(c, userId) { return Array.isArray(c.memberIds) && c.memberIds.includes(userId); }
function crewsFor(userId) {
  return Object.values(DB.crews || {}).filter(c => isCrewMember(c, userId))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}
function publicCrew(c, viewerId) {
  const challenges = Array.isArray(c.challenges) ? c.challenges : [];
  return {
    id: c.id, name: c.name, ownerId: c.ownerId, isOwner: c.ownerId === viewerId,
    createdAt: c.createdAt,
    // Sep 14 2026 (Jeff, crew/notification follow-up -- "leave them in the crew... don't have
    // access to their profile or anything"): a first pass at this (removing a blocked pair from
    // the crew entirely) got reverted the same day -- Jeff realized that made the OWNER notice a
    // member missing and start asking questions, exactly the awkwardness blocking is supposed to
    // avoid, not cause. The actual fix is much smaller: leave membership, chat, and crew
    // notifications completely untouched (nothing about the crew looks different to anyone), and
    // rely on the block wall that already exists everywhere else in the app -- tapping into a
    // blocked person's actual profile (PRs/streak/activity) already comes back limited via
    // canSeeProfile()'s own isBlocked() check, with zero new code needed for that part. The one
    // gap: this roster response has always tacked a `streak` figure onto every member unconditionally,
    // bypassing canSeeProfile entirely (unlike the rest of a profile's detail) -- Jeff specifically
    // asked for that one number hidden between a blocked pair too ("I'd say strip"), so it's null
    // (never 0, which the client would read as a real "no streak" rather than "hidden" -- see
    // crewView's `m.streak>1` check in app.js, which treats null exactly like "nothing to show,"
    // same as it already does for a real 0-day streak).
    members: c.memberIds.filter(id => DB.users[id]).map(id => ({ ...publicUser(id), streak: isBlocked(id, viewerId) ? null : currentStreak(id) })),
    challenge: publicChallenge(c, lastChallenge(c), viewerId),
    // Everything before the most-recent challenge, newest first -- the crew's track record. Added
    // Sep 6 (Jeff: the crew page "seemed poor and quickly done... difficult to track" -- wants to
    // tap into a challenge for full details). Reuses publicChallenge for each past entry so a
    // finished/expired week shows the exact same shape (leaderboard, total, dates) the current one
    // does on the new challenge-details page, not a stripped-down summary.
    pastChallenges: challenges.slice(0, -1).reverse().map(ch => publicChallenge(c, ch, viewerId)),
    challengesCompleted: challenges.filter(ch => ch.completedAt).length
  };
}
// A crew can only ever be built from people you're already connected to -- same trust boundary
// invite eligibility already uses (connectionsOf), so this can't become a way to add a stranger
// to a group thread. Silently drops any id that isn't (a real connection and) a real user, rather
// than erroring, so a stale id in the client's picker state can't block create/rename.
// Sep 24 2026 audit round 4 (medium finding): `existingMemberIds` is new -- previously this
// filtered EVERY submitted id against the owner's CURRENT connections, with no distinction
// between "a brand-new person being added" (should require a live connection, same as always)
// and "someone already in the crew" (should never need to still be a mutual connection just to
// stay put). The crew-edit sheet always resends every current member's id whether or not the
// owner touched membership at all (see the "always resubmits" comments in PUT /api/crews/:id
// below), and its picker only lists live connections -- so if the owner had simply unfollowed a
// member since (an everyday, unrelated action, no block involved), that member's id was still in
// the resubmitted list but silently failed this filter, and a totally unrelated save (a rename,
// or adding someone else) kicked them out with a "removed you from the crew" push the owner never
// chose to send. Existing members now pass through regardless of current connection status --
// the connection requirement still applies in full to anyone NOT already a member, exactly as
// before.
// Sep 24 2026 audit round 4 (low finding): used to end with `.slice(0, CREW_MAX_MEMBERS - 1)`,
// silently truncating an over-the-cap submission with no error at all -- unlike every other cap
// in this codebase (custom exercises, etc.), which returns an explicit 400 instead of quietly
// dropping data. At a full crew, adding one more member here could silently drop an arbitrary
// EXISTING member instead (order-dependent on iteration order) rather than rejecting the add or
// telling the owner they're at the limit. No longer slices -- callers now check the returned
// length against CREW_MAX_MEMBERS themselves and return a real error, same as everywhere else.
function validCrewMemberIds(ownerId, requested, existingMemberIds) {
  const allowed = new Set(connectionsOf(ownerId));
  // Sep 24 2026 cold-review catch (round 4 audit): existingMemberIds (passed as c.memberIds)
  // always includes the owner's own id, so without this exclusion a client that resubmits the
  // owner's id in requested/body.memberIds could slip it past the filter via already.has() even
  // though allowed never included it -- every call site then does
  // [req.userId, ...validCrewMemberIds(...)] with no dedup of its own, so the owner could end up
  // listed twice in c.memberIds (double-counted PRs in challengeProgress, doubled roster row in
  // publicCrew, and a correctly-sized crew wrongly rejected by the member cap). Excluding
  // ownerId here restores the pre-existing invariant that this function never returns it.
  const already = new Set((Array.isArray(existingMemberIds) ? existingMemberIds : []).filter(id => id !== ownerId));
  return [...new Set((Array.isArray(requested) ? requested : []).filter(id => id !== ownerId && (allowed.has(id) || already.has(id))))];
}

app.get('/api/crews', auth, async (req, res) => {
  res.json(crewsFor(req.userId).map(c => publicCrew(c, req.userId)));
});
app.post('/api/crews', auth, async (req, res) => {
  const name = capStr((req.body || {}).name, CREW_NAME_MAX).trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const memberIds = validCrewMemberIds(req.userId, (req.body || {}).memberIds);
  // Sep 24 2026 audit round 4: see the comment on validCrewMemberIds above -- was a silent
  // truncation, now a real error before the crew is ever created.
  if (memberIds.length > CREW_MAX_MEMBERS - 1) return res.status(400).json({ error: `a crew is limited to ${CREW_MAX_MEMBERS} members` });
  const c = { id: 'crew_' + uid(), name, ownerId: req.userId, memberIds: [req.userId, ...memberIds], messages: [], createdAt: new Date().toISOString() };
  DB.crews[c.id] = c;
  // Cold-review catch (Sep 11 2026): PUT /api/crews/:id already emits 'joined_crew' for anyone
  // ADDED later, but founding members picked right here at creation got nothing -- the exact same
  // real action (being put in a crew) produced a different, inconsistent result depending on which
  // endpoint happened to add you. Same event, same shape, just for memberIds instead of `before`.
  for (const mid of memberIds) emitFeedEvent('joined_crew', mid, { crewId: c.id, crewName: c.name, text: `joined ${c.name}` });
  await save(DB);
  // Every other "you were just put into something" flow in this app notifies (workout invite,
  // follow accepted, new follower) -- being silently dropped into a standing group chat with no
  // signal until you happen to open the Friends tab would be the odd one out (cold-review catch).
  for (const mid of memberIds) notify(mid, { title: c.name, body: `${DB.users[req.userId].displayName} added you to the crew`, link: { type: 'crew', crewId: c.id } });
  res.json(publicCrew(c, req.userId));
});
app.get('/api/crews/:id', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (!isCrewMember(c, req.userId)) return res.status(403).json({ error: 'forbidden' });
  res.json(publicCrew(c, req.userId));
});
// Rename and/or replace the member list in one call -- matches the client's picker, which always
// re-submits the full checked set rather than tracking individual adds/removes.
app.put('/api/crews/:id', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (c.ownerId !== req.userId) return res.status(403).json({ error: 'only the owner can edit this crew' });
  const body = req.body || {};
  // Sep 24 2026 audit round 4: validated and returned FIRST, before the name block below can
  // mutate/notify anything -- checking this down inside the memberIds block (its natural spot)
  // would let a name change (and its own notify/feed-event side effects) go through and then
  // fail on memberIds in the same request, leaving a half-applied edit. Fail closed, before
  // anything is touched.
  if (body.memberIds !== undefined && validCrewMemberIds(req.userId, body.memberIds, c.memberIds).length > CREW_MAX_MEMBERS - 1)
    return res.status(400).json({ error: `a crew is limited to ${CREW_MAX_MEMBERS} members` });
  if (body.name !== undefined) {
    const name = capStr(body.name, CREW_NAME_MAX).trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    // Sep 12 2026 (Jeff, three new Activity events): guarded on an ACTUAL change -- the edit sheet
    // always resubmits the current name alongside any membership change (see the comment above the
    // newly-added-members notify loop just below), so an unguarded emit here would fire a spurious
    // "renamed the crew" event on every single membership edit, not just real renames.
    if (name !== c.name) {
      emitFeedEvent('crew_renamed', req.userId, { crewId: c.id, crewName: name, oldName: c.name, text: `renamed the crew to "${name}"` });
      // Sep 13 2026 (Jeff, crew-notification gaps -- "what else may be a problem"): a real push/
      // inbox notification too, not just the passive Activity-feed row above. Matches every other
      // crew event (added to crew, challenge started/completed, chat message) already getting one --
      // without this, a member who doesn't regularly check Activity would never learn their crew got
      // renamed.
      // Cold-review catch: the client always resubmits name alongside any membership edit, so this
      // request can ALSO be dropping someone from the roster in the very same call (handled in the
      // memberIds block below). Sending them a rename push with a live crew link, right alongside
      // the "removed you" push with no link, is exactly the dead-tap the removal notification exists
      // to avoid -- so this only reaches whoever actually survives THIS request's membership edit
      // (or everyone currently in the crew, if this request doesn't touch membership at all).
      const survivors = body.memberIds !== undefined
        ? new Set([req.userId, ...validCrewMemberIds(req.userId, body.memberIds, c.memberIds)])
        : new Set(c.memberIds);
      // Sep 24 2026 audit round 4: a first draft added an isBlocked check here -- reverted. See
      // the Sep 14 2026 comment on publicCrew(): crew notifications are deliberately left
      // untouched by a block, unlike the crew's Activity-feed row for the same event (which does
      // filter by isBlocked -- the feed is a profile-adjacent surface, closer to the streak/
      // leaderboard carve-outs, not a push/inbox notification).
      for (const mid of c.memberIds) if (mid !== req.userId && survivors.has(mid)) notify(mid, { title: name, body: `${DB.users[req.userId].displayName} renamed the crew to "${name}"`, link: { type: 'crew', crewId: c.id } });
    }
    c.name = name;
  }
  if (body.memberIds !== undefined) {
    const before = new Set(c.memberIds);
    c.memberIds = [req.userId, ...validCrewMemberIds(req.userId, body.memberIds, c.memberIds)];
    // Only the newly-added members, not everyone -- an edit that touches just the name (or
    // re-submits the same roster, which the client always does alongside a name change) must not
    // re-notify people who were already in the crew, only whoever is actually new to it.
    for (const mid of c.memberIds) if (!before.has(mid)) notify(mid, { title: c.name, body: `${DB.users[req.userId].displayName} added you to the crew`, link: { type: 'crew', crewId: c.id } });
    // Sep 11 2026 (Activity page): one event per newly-added member, no heart in the UI (see
    // friends() in app.js) -- the "New follower"-style notification above already covers the
    // 1:1 heads-up, this is purely the Activity feed's record of it.
    for (const mid of c.memberIds) if (!before.has(mid)) emitFeedEvent('joined_crew', mid, { crewId: c.id, crewName: c.name, text: `joined ${c.name}` });
    // Sep 13 2026 (Jeff, crew-notification gaps): the mirror case -- someone dropped from the
    // roster (not a voluntary Leave) previously got no signal at all, the crew just silently
    // disappeared from their list next time they opened it. No feed event -- this is a private
    // removal, not something for anyone else to see -- and no link, since once removed they can no
    // longer open crewView (isCrewMember 403s it), so a link here would be a guaranteed dead tap.
    const after = new Set(c.memberIds);
    for (const mid of before) if (!after.has(mid)) notify(mid, { title: c.name, body: `${DB.users[req.userId].displayName} removed you from the crew`, link: null });
    // A newly-added member can already have logging that falls inside a running challenge's
    // window (see checkChallengeCompletion's comment) -- check right here, not just on the next
    // workout finish, so the crew isn't left staring at a stalled 100%+ bar with no celebration.
    checkChallengeCompletion(c);
  }
  await save(DB);
  res.json(publicCrew(c, req.userId));
});
// The owner can't "leave" -- a crew with no owner has nobody who can rename it or edit who's in
// it, so ownership would need somewhere to go. Simplest and clearest for v1: the owner deletes
// the crew (below) instead of leaving it orphaned.
app.post('/api/crews/:id/leave', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (!isCrewMember(c, req.userId)) return res.status(403).json({ error: 'forbidden' });
  if (c.ownerId === req.userId) return res.status(400).json({ error: 'the owner can\'t leave -- delete the crew instead' });
  c.memberIds = c.memberIds.filter(id => id !== req.userId);
  // Sep 12 2026 (Jeff, three new Activity events): the mirror image of 'joined_crew' above --
  // crew-scoped (see CREW_SCOPED_FEED_TYPES), so only the remaining members see it. The person who
  // left won't see their own row (isCrewMember(crew, viewer) is now false for them), which is fine
  // -- this is a record for the people still in the crew, not a receipt for the person who left.
  emitFeedEvent('left_crew', req.userId, { crewId: c.id, crewName: c.name, text: `left ${c.name}` });
  // Sep 13 2026 (Jeff, crew-notification gaps): a real push/inbox notification too, not just the
  // passive Activity-feed row above -- same reasoning as crew_renamed's notify loop just above in
  // PUT /api/crews/:id. c.memberIds has already had req.userId filtered out by this point, so this
  // reaches exactly the people still in the crew.
  // Sep 24 2026 audit round 4: a first draft added an isBlocked check here -- reverted, same
  // reason as crew_renamed's notify loop above (crew notifications deliberately untouched by a
  // block; see the Sep 14 2026 comment on publicCrew()).
  for (const mid of c.memberIds) notify(mid, { title: c.name, body: `${DB.users[req.userId].displayName} left the crew`, link: { type: 'crew', crewId: c.id } });
  await save(DB);
  res.json({ ok: true });
});
app.delete('/api/crews/:id', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  if (c.ownerId !== req.userId) return res.status(403).json({ error: 'only the owner can delete this crew' });
  // Cold-review catch: every other crew route calls this before touching c.memberIds -- DELETE
  // never needed to before (it only used c.ownerId), but the notify loop just below is now the
  // first thing here that reads memberIds, so a legacy/malformed record without it would throw.
  ensureCrewShape(c);
  // Sep 13 2026 (Jeff, crew-notification gaps -- "what else may be a problem"): tell remaining
  // members before the crew disappears -- previously it just vanished from their crew list with
  // zero signal, the same silent-disappearance pattern as the kicked-member case in PUT above. No
  // feed event and no link: the crew itself (and any crewView route to it) is gone the instant this
  // returns, so a link here would be a guaranteed dead tap.
  // Sep 24 2026 audit round 4: a first draft added an isBlocked check here -- reverted, same
  // reason as crew_renamed's notify loop above (crew notifications deliberately untouched by a
  // block; see the Sep 14 2026 comment on publicCrew()).
  for (const mid of c.memberIds) if (mid !== req.userId) notify(mid, { title: c.name, body: `${DB.users[req.userId].displayName} deleted the crew`, link: null });
  delete DB.crews[req.params.id];
  await save(DB);
  res.json({ ok: true });
});
app.get('/api/crews/:id/messages', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (!isCrewMember(c, req.userId)) return res.status(403).json({ error: 'forbidden' });
  // Sep 24 2026 audit round 4: a first draft of this round block-filtered crew chat the same way
  // session chat already is -- reverted. See the Sep 14 2026 comment on publicCrew() above:
  // membership, chat, and crew notifications are DELIBERATELY left untouched by a block ("nothing
  // about the crew looks different to anyone") after an earlier attempt at hiding things here made
  // the owner notice a missing member and start asking questions -- the opposite of what blocking
  // is supposed to protect against. Only per-member profile-detail numbers (the roster's `streak`
  // field, the challenge leaderboard's `count`) are hidden; the shared chat thread itself is not.
  res.json(c.messages);
});
app.post('/api/crews/:id/messages', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (!isCrewMember(c, req.userId)) return res.status(403).json({ error: 'forbidden' });
  const text = capStr((req.body || {}).text, CREW_MSG_MAX);
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  const m = { id: 'cm_' + uid(), userId: req.userId, text, at: new Date().toISOString() };
  c.messages.push(m);
  await save(DB);
  // Sep 8 2026 (Jeff: "I want a notification for ... comments ... We don't have to see multiple
  // comments, just 'brian commented on XYZ' ... or grouped notifications ... '7 New Comments in
  // XYZ Crew'"). Used to be history:false (a live group chat is exactly the kind of high-frequency
  // notify() call the history feature was never meant to absorb one-row-per-message -- cold-review
  // catch, Sep 5) -- now grouped instead of dropped: see the long comment above groupedHistoryWrite
  // (right above notify()) for the aggregation rule. The chat thread itself is still the durable,
  // full-detail place to catch up; this is just a pointer that something happened there.
  // Sep 8 2026, cont'd (Jeff: "when i open the notification page ... I want to be able to click
  // on the notification and it bring me to that notification ... if brian commented in our crew
  // or workout - it brings me to see his comments"). `crew-chat` (distinct from plain `crew`,
  // still used elsewhere for "added you to the crew"/challenge notifications, which correctly land
  // at the TOP of the crew page) is its own link type specifically so a comment notification lands
  // scrolled to the actual messages, not just somewhere on the crew page above them -- see
  // openCrewChat() in app.js.
  const who = DB.users[req.userId].displayName;
  // Sep 24 2026 audit round 4: a first draft added an isBlocked check here -- reverted, same
  // reason as the read side above (see the Sep 14 2026 comment on publicCrew()): crew chat
  // notifications are deliberately left untouched by a block.
  for (const pid of c.memberIds) if (pid !== req.userId) notify(pid, { title: c.name, body: `${who}: ${text.slice(0, 40)}`, link: { type: 'crew-chat', crewId: c.id } },
    { group: { key: `crew:${c.id}:chat`, singularBody: `${who} commented in ${c.name}`, pluralBody: n => `${n} new comments in ${c.name}` } });
  res.json(m);
});
// Sep 8 2026 (Jeff: "I want to be able to edit my comments - anywhere I can post one") -- same
// own-message-only edit as the session chat and posted-recap comment editors. `c.messages` can
// also hold a `system` row (crew-challenge-hit celebrations, no real userId) -- those simply have
// no matching userId to compare against req.userId, so this refuses them the same as anyone
// else's message, with no special-casing needed.
// Cold-review fix: also re-check isCrewMember, matching the sibling GET/POST routes just above --
// without it, someone who's since LEFT the crew (POST /leave, self-service, no re-invite needed)
// kept the ability to rewrite their old messages' text indefinitely, in a chat they can no longer
// read or post into, with no delete/moderation route on crew messages to undo it.
app.put('/api/crews/:id/messages/:messageId', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (!isCrewMember(c, req.userId)) return res.status(403).json({ error: 'forbidden' });
  const m = (c.messages || []).find(x => x.id === req.params.messageId);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.userId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  const text = capStr((req.body || {}).text, CREW_MSG_MAX);
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  m.text = text;
  m.editedAt = new Date().toISOString();
  await save(DB);
  res.json(m);
});
// Sep 8 2026 (Jeff: "I should be able to edit or delete any comment I have made anywhere also") --
// own message only, same shape as the PUT just above (isCrewMember re-checked for the identical
// leave-the-crew reason). Deliberately no "crew owner can delete anyone's message" branch, unlike
// the posted-recap DELETE below which lets a post owner moderate replies on their own post -- a
// crew has no equivalent "whose thread is this" owner concept for a chat everyone posts into
// equally, and Jeff's own wording here is scoped to "comment I have made," not moderation of
// others'. Add that only if he actually asks for it.
app.delete('/api/crews/:id/messages/:messageId', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (!isCrewMember(c, req.userId)) return res.status(403).json({ error: 'forbidden' });
  const m = (c.messages || []).find(x => x.id === req.params.messageId);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.userId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  c.messages = c.messages.filter(x => x.id !== req.params.messageId);
  await save(DB);
  res.json({ ok: true });
});

// ---- Crew Challenges (Sep 2026, Jeff: "make it more fun -- both collaborative AND competitive")
// One shared, week-long goal the whole crew works toward together (every member's finished
// workouts feed one running total) PLUS a contribution leaderboard, so it reads as a team effort
// with visible individual credit, not an anonymous shared number. Progress is DERIVED at read time
// from s.history/s.logs, the same "never store a counter" rule currentStreak/weeksFor/volumeFor
// above already follow -- there is nothing to keep in sync if a session is later unlocked, edited,
// or left. Lives inline on the crew object (c.challenges), same as c.messages -- no new table.
const CHALLENGE_MIN_TARGET = 1;
const CHALLENGE_MAX_TARGET = 500;   // sanity cap for workouts/sets/PRs; volume has its own, higher cap below
const CHALLENGE_VOLUME_MAX_TARGET = 500000;   // lb -- volume targets run much bigger than a rep/set count
const CHALLENGE_CUSTOM_TITLE_MAX = 80;        // same order of size as a crew name (CREW_NAME_MAX)
const CHALLENGE_DURATION_DAYS = 7;  // v1: one length, matches the app's existing week-anchored streak/volume language
// Sep 6 (Jeff: "seems to only be who can do the most workouts or sets... I want to be able to
// customize this"). Two kinds of challenge now exist under one `type` field:
// - Auto-tracked ('workouts' | 'sets' | 'volume' | 'prs'): a number, derived at read time exactly
//   like the original two, just from more of what's already logged -- total weight lifted (in lb,
//   normalized via toLb so a mixed lb/kg crew still adds up correctly) and PR count (real, earned
//   records only -- see the !firstLog filter below, same one the feed's "hit a new PR" celebration
//   already uses, so a brand-new exercise's very first log never counts as "hitting a PR").
// - 'custom' (Jeff: "I don't mind the honor system. We still be able to see it by posted workouts
//   etc"): a free-text goal with no computable number at all -- there is nothing to sum, so
//   completedAt is never set for one (checkChallengeCompletion's `total < ch.target` compares
//   against an undefined target and always stays false, which is exactly "never auto-completes",
//   not a bug to special-case there). What the crew gets instead is the actual posted workouts
//   from everyone in that window (see publicChallenge's 'custom' branch) so the crew can judge it
//   for themselves the same way they'd notice it happening in person.

// The most recent challenge, whatever state it's in -- what the client always DISPLAYS (a just-won
// challenge should still show its final numbers and the celebration banner, not vanish back to
// "no challenge running" the instant it's complete). Only ever superseded by starting a new one.
function lastChallenge(c) {
  if (!Array.isArray(c.challenges) || !c.challenges.length) return null;
  return c.challenges[c.challenges.length - 1];
}
// The challenge currently in progress, if any -- narrower than lastChallenge above, and used only
// to gate two things: whether the owner may start a new challenge, and whether checkCrewChallenges
// has anything left to check. "In progress" means started, not yet completed, and not yet past its
// own end date. A challenge that's completed (target hit) or expired (past endDate) is deliberately
// NOT "in progress" even if calendar days remain in its window -- either way the outcome is already
// decided, so the owner is free to start a fresh one immediately (chaining challenges) rather than
// waiting out a dead week, while lastChallenge above keeps showing the finished one until they do.
function runningChallenge(c) {
  const last = lastChallenge(c);
  if (!last) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (!last.completedAt && today < last.endDate) ? last : null;
}
// Per-member contribution + the shared total, recomputed from scratch every time (see the header
// comment above). Only CURRENT crew members are counted or shown on the leaderboard -- a member who
// has since left drops their contribution from the shared total along with themselves, the same
// "current membership only" rule crew chat access already applies. Documented tradeoff, not a bug:
// this is a fun bonus number, not a permanent ledger, and there is no historical-membership
// snapshot to attribute a departed member's share to even if we wanted to.
//
// Gated on each SET's own precise `at` timestamp against the challenge's precise createdAt, not
// s.history's day-only date string -- caught by test/crews.mjs chaining two challenges on the same
// real day (finish challenge #1, start #2 immediately): with only a day to compare, everything
// logged earlier that same day toward #1 was ALSO landing inside #2's freshly-started window,
// so a brand new challenge could open already partway (or, worse, instantly) complete. For the
// 'workouts' type, a finish with zero logged sets has no set timestamp to check -- creditFinish
// stamps `h.at` on every history row for exactly this case, so that's the fallback. The day-string
// range is a last resort only for history rows written before `h.at` existed; a bare day-string
// compare re-admits the exact same-day double-count bug the timestamp gating fixed, so it's used
// only when there's truly nothing more precise on the row.
function challengeProgress(c, ch) {
  const perMember = {};
  for (const mid of c.memberIds) perMember[mid] = 0;
  // A custom goal has nothing to sum -- see the header comment above. Short-circuit before touching
  // DB.sessions at all; there is no number here for any caller to compare against.
  if (ch.type === 'custom') return { total: 0, perMember };
  const endInstant = ch.endDate + 'T00:00:00.000Z';
  const inRange = at => typeof at === 'string' && at >= ch.createdAt && at < endInstant;
  if (ch.type === 'prs') {
    // Only the CURRENT record per (member, exercise) is ever stored (DB.prs is a snapshot, not a
    // log of every PR ever broken -- see rebuildAllPrs), so breaking the same lift's PR twice in
    // one challenge window only ever counts once here. Same documented tradeoff challengeProgress's
    // own header comment already accepts for membership -- a fun bonus number, not a perfect ledger.
    // !firstLog excludes a brand-new exercise's very first-ever log, same filter groupPrsForFeed
    // uses for the "hit a new PR" feed celebration -- a first attempt at something never beat a
    // prior best, so it isn't earning a PR for challenge purposes either.
    for (const mid of c.memberIds) {
      const byExercise = (DB.prs && DB.prs[mid]) || {};
      for (const p of Object.values(byExercise)) {
        if (p && !p.firstLog && inRange(p.at)) perMember[mid] += 1;
      }
    }
  } else {
    for (const s of Object.values(DB.sessions)) {
      for (const h of (s.history || [])) {
        if (!perMember.hasOwnProperty(h.userId)) continue;
        const logs = (s.logs && s.logs[h.userId]) || [];
        if (ch.type === 'sets') {
          perMember[h.userId] += logs.filter(l => isWorkingSet(l) && inRange(l.at)).length;
        } else if (ch.type === 'volume') {
          // lb regardless of what unit any individual set was logged in -- toLb is the same
          // normalizer rebuildAllPrs uses to compare a kg lift against an lb one fairly.
          for (const l of logs) if (isWorkingSet(l) && inRange(l.at)) perMember[h.userId] += toLb(l.weight, l.unit) * (Number(l.reps) || 0);
        } else {
          const counts = logs.length ? logs.some(l => inRange(l.at))
            : typeof h.at === 'string' ? inRange(h.at)
            : (h.date >= ch.startDate && h.date < ch.endDate);
          if (counts) perMember[h.userId] += 1;   // one finished workout = 1, regardless of how much was logged
        }
      }
    }
    if (ch.type === 'volume') for (const mid of c.memberIds) perMember[mid] = Math.round(perMember[mid]);
  }
  const total = Object.values(perMember).reduce((a, b) => a + b, 0);
  return { total, perMember };
}
function publicChallenge(c, ch, viewerId) {
  if (!ch) return null;
  if (ch.type === 'custom') {
    const expired = new Date().toISOString().slice(0, 10) >= ch.endDate;
    const endInstant = ch.endDate + 'T00:00:00.000Z';
    // No auto-tracked number, so the clearest signal the crew actually has is each other's real
    // posted workouts from that week (Jeff: "we still be able to see it by posted workouts etc").
    // Same visibility rule as everywhere else a recap is shown (canSeePostAuthor) -- being in the
    // same crew doesn't unlock a private post you're not otherwise allowed to see.
    const posts = [];
    for (const s of Object.values(DB.sessions)) {
      for (const mid of c.memberIds) {
        const p = s.posts && s.posts[mid];
        if (!p || !DB.users[mid]) continue;
        if (!(p.at >= ch.createdAt && p.at < endInstant)) continue;
        if (!canSeePostAuthor(p, mid, viewerId, s)) continue;
        posts.push({ sessionId: s.id, authorId: mid, author: publicUser(mid), at: p.at, name: s.name || 'Workout' });
      }
    }
    posts.sort((a, b) => new Date(b.at) - new Date(a.at));
    return {
      id: ch.id, type: 'custom', title: ch.title, startDate: ch.startDate, endDate: ch.endDate,
      createdBy: ch.createdBy, completed: false, expired, posts,
      daysLeft: Math.max(0, Math.ceil((new Date(ch.endDate + 'T00:00:00Z') - new Date()) / 86400000))
    };
  }
  const { total, perMember } = challengeProgress(c, ch);
  // Sep 24 2026 (audit finding): this tacked a personal "count" number onto every member
  // unconditionally, the same shape of leak the roster's `streak` field had (see the isBlocked
  // fix on `members` above, Sep 14 2026 -- "Jeff specifically asked for that one number hidden
  // between a blocked pair too"). That fix never got ported to this sibling leaderboard, so a
  // blocked pair in the same crew could still see each other's exact weekly challenge count and
  // rank here even though the roster's own streak correctly reads null for them. Sort by the
  // real count first (rank order itself isn't the sensitive part), then null the number out for
  // a blocked pair on the way out.
  // Oct 10 2026 (audit finding #229): ties broke on whatever order memberIds happened to be in
  // (join order), which reads to the crew as an arbitrary, unexplained ranking -- two members tied
  // at the same count could land in either order, with nothing on screen saying why. A tied count
  // now falls back to alphabetical by name, same deterministic tiebreaker GET /api/friends and
  // followListFor() already use for their own listings.
  const leaderboard = c.memberIds.filter(id => DB.users[id])
    .sort((a, b) => {
      const diff = (perMember[b] || 0) - (perMember[a] || 0);
      if (diff !== 0) return diff;
      const an = DB.users[a].displayName || DB.users[a].username;
      const bn = DB.users[b].displayName || DB.users[b].username;
      return an.localeCompare(bn, undefined, { sensitivity: 'base' });
    })
    .map(id => ({ ...publicUser(id), count: isBlocked(id, viewerId) ? null : (perMember[id] || 0) }));
  const completed = !!ch.completedAt;
  // Ran its full 7 days without hitting the target. lastChallenge() keeps showing this one (so the
  // "displayed" challenge is never just null the moment it goes stale) but runningChallenge() has
  // already stopped treating it as in-progress, which is what actually lets the owner start a new
  // one server-side -- without surfacing that split to the client, `challenge` here stayed
  // permanently non-null and the UI's "no challenge, show the Start CTA" branch never matched again
  // (cold-review catch: a missed week was a dead end with no way back in).
  const expired = !completed && new Date().toISOString().slice(0, 10) >= ch.endDate;
  return {
    id: ch.id, type: ch.type, target: ch.target, startDate: ch.startDate, endDate: ch.endDate,
    createdBy: ch.createdBy, total, leaderboard, completed, expired,
    daysLeft: Math.max(0, Math.ceil((new Date(ch.endDate + 'T00:00:00Z') - new Date()) / 86400000))
  };
}
// One crew's worth of the check below -- pulled out on its own because completion isn't only
// triggered by someone finishing a workout. Editing a crew's roster (PUT /api/crews/:id) can ALSO
// tip a challenge over its target with no new workout at all: adding a member whose own logging
// already falls inside the challenge's window (they trained on their own, then got added) raises
// `total` the instant they join, and without this call sitting on that path too, the challenge
// would sit frozen at >=target with completedAt still null until someone happened to log something
// else later (cold-review catch). Returns whether it just completed, so callers than don't already
// unconditionally save() can decide to.
function checkChallengeCompletion(c) {
  const ch = runningChallenge(c);
  if (!ch) return false;
  // A custom goal's target is undefined, so `total < ch.target` (total is always 0 for one -- see
  // challengeProgress's own short-circuit) compares against undefined and is always false here --
  // that IS "never auto-completes," not a case this function needs to special-case separately.
  const { total } = challengeProgress(c, ch);
  if (total < ch.target) return false;
  ch.completedAt = new Date().toISOString();
  const unit = ch.type === 'volume' ? ' lb' : '';
  // A system message (userId: null) so the client renders it as a celebration banner in the
  // thread, not attributed to "Someone" the way a departed member's old message is (see
  // crewView's own comment on that fallback) -- those two blanks mean different things.
  c.messages.push({ id: 'cm_' + uid(), userId: null, system: true, at: ch.completedAt,
    text: `🎉 Challenge complete! ${total}${unit} ${ch.type} as a crew.` });
  for (const mid of c.memberIds) notify(mid, { title: c.name, body: `Challenge complete: ${ch.target}${unit} ${ch.type} this week! 🎉`, link: { type: 'crew', crewId: c.id } });
  // Sep 11 2026 (Activity page): one shared feed event, `by` left null (see notify's own system-
  // message pattern just above) since this is the crew's win, not any one member's -- app.js
  // shows it once per viewer who's a member, same as the crew challenge banner already does.
  emitFeedEvent('challenge_completed', null, { crewId: c.id, crewName: c.name, challengeType: ch.type,
    target: ch.target, total, memberIds: [...c.memberIds], text: `crushed the ${ch.type} challenge — ${total}${unit} as a crew` });
  return true;
}
// Called right after a workout gets credited (session lock, and a keep-leave -- see creditFinish's
// two call sites) so a challenge notices the moment it's actually won, not on the next unrelated
// read. Cheap in practice: most users belong to zero or one crew, and this is a no-op unless that
// crew has a challenge running that isn't already marked complete.
function checkCrewChallenges(userId) {
  for (const c of Object.values(DB.crews || {})) {
    if (!isCrewMember(c, userId)) continue;
    ensureCrewShape(c);
    checkChallengeCompletion(c);
  }
}
// Sep 11 2026 (Activity page): snapshot of `userId`'s 1-based rank in every crew challenge they're
// currently part of, taken right before creditFinish runs. creditFinish has already updated
// DB.sessions by the time checkCrewChallenges runs after it, so "before" cannot be recovered from
// inside checkCrewChallenges itself -- it must be captured this early by the caller and handed to
// emitFinishFeedEvents below. Uses crewChallengeRank (defined near emitFeedEvent), which itself
// short-circuits to null for a crew with no running, non-custom challenge.
function crewRanksSnapshot(userId) {
  const snap = {};
  for (const c of Object.values(DB.crews || {})) {
    if (!isCrewMember(c, userId)) continue;
    snap[c.id] = crewChallengeRank(c, userId);
  }
  return snap;
}
// Called right after a workout is actually credited (session lock, and a keep-leave -- the same
// two moments checkCrewChallenges already hooks into), to emit whatever ephemeral Activity-page
// feed events that credit produced. Deliberately separate from checkCrewChallenges (which only
// cares about challenge COMPLETION) since this covers three different things: the plain "finished
// a workout" event, a streak milestone, and a crew-challenge rank improvement.
function emitFinishFeedEvents(s, userId, ranksBefore, localDate) {
  // `localDate` is the CLIENT's own today (see /lock and /leave, which already thread this same
  // value into creditFinish) -- cold-review catch: this used to default to server UTC, which is
  // wrong for most of a day across half the globe (a real two-consecutive-local-day streak could
  // silently fail to announce itself, or announce a day early/late) even though creditFinish and
  // currentStreak both already had the real local date on hand right here.
  const today = isValidLocalDateStr(localDate) ? localDate : new Date().toISOString().slice(0, 10);

  // "Finished a workout" -- ephemeral, and deliberately unconditional here: whether this ends up
  // superseded by a posted recap (or by that same session's own PR -- see GET /api/feed) is a
  // READ-time decision, not something decided at emit time, since either can happen any time
  // after finishing. Names the actual session (Jeff, Sep 11: several of these sitting next to each
  // other with nothing but "completed a workout" repeated was indistinguishable) -- same `s.name ||
  // 'a workout'` fallback the recap row above already uses, so an unnamed session still reads fine.
  // `at`: the workout's real performed date (perfDate(s.scheduledAt, ...), same helper/convention
  // the PR emission below already uses) -- NOT literal "now". Cold-review catch (Jeff, Sep 11): this
  // used to always stamp "now", so a backdated workout's plain completion row could misleadingly
  // read as having JUST happened -- exactly the v239/v247 bug class the PR emission was already
  // built to avoid, just missed here.
  emitFeedEvent('completed_no_recap', userId, { sessionId: s.id, text: `completed ${s.name || 'a workout'}`,
    at: perfDate(s.scheduledAt, new Date().toISOString()) });

  // Streak feed event REMOVED Sep 30 2026 (Jeff, audit Tier 4c, cold-review catch): this used to
  // emit a "hit a N-day streak" row into the Home/Friends' Activity feed, at most once per user per
  // LOCAL day. Same per-calendar-day streak concept Jeff asked to drop everywhere ("we don't need
  // the consecutive days with a finished workout -- as this will ALWAYS be killed by a rest day.
  // Leave only the week in progress") -- a cold review of the profile/crew pill-removal screenshots
  // caught this still emitting live, on a different surface than the pills the original ask named.
  // currentStreak() itself is untouched (still powers the separate streak-loss-reminder push).
  // compactRowHtml's ff.type==='streak' render branch in app.js is deliberately left in place --
  // harmless, and still renders any already-emitted historical 'streak' rows already sitting in
  // DB.feedEvents correctly rather than silently blanking them.

  // Crew-challenge rank change -- deliberately scoped to just these two creditFinish call sites
  // (not every place challengeProgress could theoretically shift), the same explicit scope
  // tradeoff checkCrewChallenges itself already makes. Only reported while the challenge is STILL
  // running: a crew whose challenge just completed as part of this same update gets its own, more
  // meaningful 'challenge_completed' event instead (see checkChallengeCompletion) -- showing both
  // for the same workout would be redundant.
  if (!ranksBefore) return;
  for (const c of Object.values(DB.crews || {})) {
    if (!isCrewMember(c, userId)) continue;
    const before = ranksBefore[c.id];
    const after = crewChallengeRank(c, userId);
    if (before == null || after == null || after >= before) continue;   // no challenge, or rank didn't improve
    if (!runningChallenge(c)) continue;   // completed in this same update -- that event covers it
    emitFeedEvent('rank', userId, { crewId: c.id, crewName: c.name, rank: after, text: `moved to #${after}` });
  }
}
app.post('/api/crews/:id/challenge', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (c.ownerId !== req.userId) return res.status(403).json({ error: 'only the owner can start a challenge' });
  if (runningChallenge(c)) return res.status(400).json({ error: 'a challenge is already running' });
  const body = req.body || {};
  const CHALLENGE_TYPES = ['workouts', 'sets', 'volume', 'prs', 'custom'];
  const type = CHALLENGE_TYPES.includes(body.type) ? body.type : 'workouts';
  const startDate = new Date().toISOString().slice(0, 10);
  const base = { id: 'chal_' + uid(), type, startDate, endDate: shiftDateStr(startDate, CHALLENGE_DURATION_DAYS),
    createdBy: req.userId, createdAt: new Date().toISOString(), completedAt: null };
  let ch, notifyBody;
  if (type === 'custom') {
    const title = capStr(body.title, CHALLENGE_CUSTOM_TITLE_MAX).trim();
    if (!title) return res.status(400).json({ error: 'describe the challenge' });
    ch = { ...base, title };
    notifyBody = `${DB.users[req.userId].displayName} started a challenge: ${title}`;
  } else {
    const target = Math.round(Number(body.target));
    if (!Number.isFinite(target) || target < CHALLENGE_MIN_TARGET) return res.status(400).json({ error: 'pick a target' });
    const max = type === 'volume' ? CHALLENGE_VOLUME_MAX_TARGET : CHALLENGE_MAX_TARGET;
    ch = { ...base, target: Math.min(max, target) };
    const unit = type === 'volume' ? ' lb' : '';
    notifyBody = `${DB.users[req.userId].displayName} started a challenge: ${ch.target}${unit} ${type} this week`;
  }
  c.challenges.push(ch);
  // Sep 11 2026 (Activity page): "started a challenge" -- attributed to the owner who started it,
  // no heart in the UI (see friends() in app.js) since nothing has been earned yet. Reuses
  // notifyBody's own wording, just without the "{displayName} " prefix -- app.js prepends the
  // actor's name itself, same as every other feed row.
  // Oct 10 2026 (audit finding, see the DELETE route right below): stashed on the challenge
  // itself so a cancel can clean up this exact feed entry rather than leaving a stray "started a
  // challenge" line sitting in the feed for something that got undone a minute later.
  const fev = emitFeedEvent('challenge_started', req.userId, { crewId: c.id, crewName: c.name, challengeType: ch.type,
    target: ch.target ?? null, title: ch.title || null,
    text: notifyBody.slice(DB.users[req.userId].displayName.length + 1) });
  ch.feedEventId = fev.id;
  await save(DB);
  // Sep 24 2026 audit round 4: a first draft added an isBlocked check here -- reverted, same
  // reason as the other crew-lifecycle notify loops (crew notifications deliberately untouched by
  // a block; see the Sep 14 2026 comment on publicCrew()). GET /api/feed's own challenge_started
  // event stays filtered, unchanged -- only this push/inbox notification is reverted.
  for (const mid of c.memberIds) if (mid !== req.userId) notify(mid, { title: c.name, body: notifyBody, link: { type: 'crew', crewId: c.id } });
  res.json(publicCrew(c, req.userId));
});
// Oct 10 2026 (audit finding): starting a challenge was a one-way door -- a wrong target, wrong
// type, or a fat-finger tap committed the whole crew for the full 7 days with nothing the owner
// could do but let it run. This is a true cancel, not an edit: it removes the just-started
// challenge entirely, as if it had never been created (not a "cancelledAt" flag left sitting in
// history -- there's nothing about a cancelled challenge worth a crew looking back on, and a flag
// would have meant teaching lastChallenge/publicChallenge/checkChallengeCompletion a brand new
// state for no real benefit). That's also exactly what unblocks starting a corrected one right
// away: runningChallenge(c) returning null the moment this runs is what POST .../challenge above
// already gates on, so no separate "allow restart" logic is needed. Scoped to the SPECIFIC
// challenge id the client has on screen, not just "whatever's running" -- a stale page open from
// before this challenge completed/expired and a new one started can't cancel the wrong one.
app.delete('/api/crews/:id/challenge/:challengeId', auth, async (req, res) => {
  const c = DB.crews[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  ensureCrewShape(c);
  if (c.ownerId !== req.userId) return res.status(403).json({ error: 'only the owner can cancel a challenge' });
  const ch = runningChallenge(c);
  if (!ch || ch.id !== req.params.challengeId) return res.status(400).json({ error: 'no running challenge to cancel' });
  c.challenges = c.challenges.filter(x => x.id !== ch.id);
  if (ch.feedEventId && DB.feedEvents[ch.feedEventId]) delete DB.feedEvents[ch.feedEventId];
  await save(DB);
  res.json(publicCrew(c, req.userId));
});

// ---- Notifications (aggregated inbox) ----
// Sep 4 (Jeff): a bell icon on Home + Profile leading to one inbox for "things needing your
// response" -- workout invites, follow requests, and requests to join a workout you created.
// Deliberately no new persisted collection for these three: they read the same pending-state
// fields the app already tracks (sessions[].invited, users[].followReqs, sessions[].joinRequests)
// and assemble on read, same shape as GET /api/friends' followRequests just above.
//
// Sep 5 (Jeff, see the long comment above notify()): that was the whole inbox, and it only ever
// covered things still AWAITING a response -- a completed, one-shot notification (someone
// followed you, a reaction, an accepted invite) had nowhere to live once its moment passed, even
// though a push for it had already gone out. `history` below is that missing piece: notify()'s
// own persisted log, filtered to the last NOTIFICATION_HISTORY_DAYS. `count` (the bell's badge)
// now also counts unseen history entries -- "unseen" tracked as a single per-user timestamp
// (notificationsSeenAt, stamped by POST /api/notifications/seen when the notifications PAGE is
// actually opened, not by this endpoint itself, since Home also calls this just to read the
// badge count and must not clear it before the page is ever opened).
app.get('/api/notifications', auth, async (req, res) => {
  const me = DB.users[req.userId]; ensureFollowArrays(me);
  // Sep 23 2026 (audit finding): `from` used to always be publicUser(s.creatorId) -- the CURRENT
  // owner, not whoever actually sent the invite. Once ownership hands off (see the invitedBy
  // comment on PUT /api/sessions/:id and on session creation), that silently credited the invite to
  // someone who may never have sent it. s.invitedBy[req.userId] is the real inviter when this
  // invite was created/edited after the field existed; older invites have no entry there and keep
  // the old creatorId fallback exactly as before.
  // Oct 1 2026 (audit finding, round-2 Tier 2): this had no block filter at all, unlike
  // followRequests/joinRequests/removals/suggestions right below -- all of which already check
  // isBlocked against whoever the item is attributed to. A pending invite from (or to) someone you
  // later blocked kept showing "X invited you" here, actionable Accept button included, regardless.
  // Filtered the same way, against fromId -- the identity actually shown in this list item.
  // Oct 9 2026 (audit finding, Jeff's pick among options): every section in this route used to
  // come back in whatever order Object.values(DB.sessions)/DB.templates happened to iterate --
  // i.e. the order those SESSIONS/TEMPLATES were originally CREATED, not when the pending item
  // itself (an invite, a join request, a suggestion...) actually happened. A brand-new invite on a
  // months-old workout sat buried below a day-old invite on a workout that merely happened to be
  // created more recently. Sorted newest-first within each section instead, using each item's own
  // real timestamp (invitedAt/at/sharedAt -- see each field's own comment where it's stamped).
  // Missing timestamps (an item that predates this fix) sort last within their section, same
  // "falls back gracefully, never crashes" shape every other lazily-added field in this file uses.
  const invites = Object.values(DB.sessions)
    .filter(s => Array.isArray(s.invited) && s.invited.includes(req.userId))
    .map(s => ({ s, fromId: (s.invitedBy && s.invitedBy[req.userId]) || s.creatorId, at: (s.invitedAt && s.invitedAt[req.userId]) || '' }))
    .filter(({ fromId }) => DB.users[fromId] && !isBlocked(fromId, req.userId))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ s, fromId }) => ({ type: 'invite', sessionId: s.id, sessionName: s.name || 'Workout', exerciseCount: (s.exercises || []).length, from: publicUser(fromId) }));
  // followReqs is append-only (ensureFollowArrays/the one push site -- see its own comment) and
  // never reordered or re-stamped in place, so reversing it is exactly "newest request first"
  // without needing a parallel timestamp map the way the other sections below do.
  const followRequests = [...(me.followReqs || [])].reverse()
    .filter(id => DB.users[id])
    .map(id => ({ type: 'follow', from: publicUser(id) }));
  const joinRequests = [];
  // Sep 23 2026 (cold-review catch): pendingRemovals is notified with { history: false } (see PUT
  // /api/sessions/:id), same as invites/followRequests/joinRequests above -- but unlike those
  // three, nothing reconstructed it here, so a required approver who missed or dismissed that one
  // push notification had no other way to ever discover a removal was waiting on their sign-off.
  // Given the whole point of this feature is that a removal now genuinely REQUIRES their approval,
  // a request that can go unnoticed indefinitely defeated it. Same shape as joinRequests below:
  // scan every session, surface only entries this viewer is actually a required (still undecided)
  // approver for.
  const removals = [];
  for (const s of Object.values(DB.sessions)) {
    // joinRequests are creator-only to answer, same as before -- but a removal's required
    // approver is a REGULAR PARTICIPANT, essentially never the creator (see PUT /api/sessions/:id:
    // requiredApprovals explicitly excludes req.userId, the proposer), so this second loop must
    // not be gated behind the same creator-only check the join-request one above needs.
    if (s.creatorId === req.userId) {
      for (const j of (s.joinRequests || [])) {
        // Sep 24 2026 audit round 4 (low finding): the actual approve action already 400s with
        // {error:'blocked'} for a since-blocked requester (see /join/:reqId/approve), but this
        // listing still showed their identity and free-text note here regardless -- a visible
        // leak through a surface that's supposed to fail closed.
        if (j.status !== 'pending' || !DB.users[j.userId] || isBlocked(j.userId, req.userId)) continue;
        joinRequests.push({ type: 'join', sessionId: s.id, reqId: j.id, sessionName: s.name || 'Workout', note: j.note || '', from: publicUser(j.userId), _at: j.at || '' });
      }
    }
    for (const pr of (s.pendingRemovals || [])) {
      if (pr.status !== 'pending') continue;
      if (!(pr.requiredApprovals || []).includes(req.userId)) continue;
      if ((pr.approvals || []).includes(req.userId)) continue;
      // Sep 24 2026 audit round 4 (low finding): same shape as joinRequests above -- the proposer's
      // identity leaked into this listing even when blocked.
      if (!DB.users[pr.proposedBy] || isBlocked(pr.proposedBy, req.userId)) continue;
      removals.push({ type: 'removal', sessionId: s.id, reqId: pr.id, sessionName: s.name || 'Workout', exerciseName: pr.exerciseName, from: publicUser(pr.proposedBy), _at: pr.at || '' });
    }
  }
  // Sep 29 2026 (audit finding, Tier 4e): a pending suggested edit (add/swap proposal awaiting the
  // creator's approve/reject) used to have no home here at all -- unlike invites/followRequests/
  // joinRequests/removals above, a creator who missed or dismissed the one push for a suggestion
  // had no way to rediscover it except by remembering which specific workout it was on and
  // reopening it. Same shape as removals just above: creator-only (approve/reject on an owned
  // session's suggestedEdits is creator-only -- see POST .../suggest/:editId/approve|reject),
  // pending entries only. Deliberately NOT reconstructed for ownerless sessions (s.creatorId ===
  // null, excluded by the creatorId check below) -- there, every participant can vote at any time
  // and the pending stack stays visible and standing for as long as it's unresolved (see the
  // ownerless redesign's own comment on suggestedEdits in openSession), so there's no single,
  // missable decision moment the way there is here.
  const suggestions = [];
  for (const s of Object.values(DB.sessions)) {
    if (s.creatorId !== req.userId) continue;
    for (const ed of (s.suggestedEdits || [])) {
      if (ed.status !== 'pending') continue;
      if (!DB.users[ed.proposedBy] || isBlocked(ed.proposedBy, req.userId)) continue;
      suggestions.push({ type: 'suggestion', sessionId: s.id, editId: ed.id, sessionName: s.name || 'Workout', editType: ed.type, swapTo: ed.swapTo, from: publicUser(ed.proposedBy), _at: ed.at || '' });
    }
  }
  // Sep 27 2026 (Jeff, part 1): a declined-then-changed-their-mind request (POST
  // .../reinvite-request) sits here the same way a join/removal request does, so the creator's
  // one-tap "Invite them back" button (app.js) survives missing the one push notification, same
  // reasoning as removals' own comment just above. Creator-only, same as joinRequests.
  const reinviteAsks = [];
  for (const s of Object.values(DB.sessions)) {
    if (s.creatorId !== req.userId) continue;
    for (const rr of (s.reinviteRequests || [])) {
      if (!DB.users[rr.userId] || isBlocked(rr.userId, req.userId)) continue;
      reinviteAsks.push({ type: 'reinviteAsk', sessionId: s.id, reqId: rr.id, sessionName: s.name || 'Workout', message: rr.message || '', from: publicUser(rr.userId), _at: rr.at || '' });
    }
  }
  // Oct 2 2026 (routine-sharing redesign): a routine explicitly shared with me (POST
  // /api/templates/:id/share) that I haven't yet accepted or declined -- same "surfaced here too,
  // not just the one push that created it" reasoning as every other pending-action list above,
  // and the same isBlocked re-check they all already carry (a block can happen any time between
  // the share and now).
  const routineShares = [];
  for (const t of Object.values(DB.templates || {})) {
    if (!Array.isArray(t.sharedTo) || !t.sharedTo.includes(req.userId)) continue;
    if (!DB.users[t.ownerId] || isBlocked(t.ownerId, req.userId)) continue;
    routineShares.push({ type: 'routineShare', routineId: t.id, routineName: t.name, exerciseCount: (t.exercises || []).length, from: publicUser(t.ownerId), _at: (t.sharedAt && t.sharedAt[req.userId]) || '' });
  }
  // Oct 9 2026: newest-first within each of the four sections just built -- see the big comment
  // above `invites` for why. `_at` was scaffolding for this sort only (joinRequests/removals/
  // suggestions/reinviteAsks/routineShares each stamped it on push, just above); stripped from
  // every item before it goes in the response, same "never shown, just how the order was decided"
  // shape as `s`/`fromId` in the invites pipeline above.
  const stripAt = arr => { arr.sort((a, b) => b._at.localeCompare(a._at)); for (const x of arr) delete x._at; return arr; };
  stripAt(joinRequests); stripAt(removals); stripAt(suggestions); stripAt(reinviteAsks); stripAt(routineShares);
  const cutoff = Date.now() - NOTIFICATION_HISTORY_DAYS * 86400000;
  const history = Object.values(DB.notifications)
    .filter(n => n.userId === req.userId && new Date(n.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50)
    .map(n => ({ type: 'history', id: n.id, title: n.title, body: n.body, at: n.createdAt, link: n.link || null }));
  const seenAt = me.notificationsSeenAt ? new Date(me.notificationsSeenAt).getTime() : 0;
  const unseenHistory = history.filter(n => new Date(n.at).getTime() > seenAt).length;
  res.json({ invites, followRequests, joinRequests, removals, suggestions, reinviteAsks, routineShares, history, count: invites.length + followRequests.length + joinRequests.length + removals.length + suggestions.length + reinviteAsks.length + routineShares.length + unseenHistory });
});
// Stamps "I have now looked at the notifications page" -- called by renderNotifications() in
// app.js when it actually lands on the page, deliberately NOT by GET /api/notifications itself
// (Home fetches that just to size the bell badge, on every Home load; if reading it cleared the
// badge, a push notification would go stale before anyone had a chance to see the badge at all).
app.post('/api/notifications/seen', auth, async (req, res) => {
  DB.users[req.userId].notificationsSeenAt = new Date().toISOString();
  await save(DB);
  res.json({ ok: true });
});
// Sep 9 (Jeff): "slide notifications away... to remove them from the list if I don't want to
// wait the full 7 days." A single history row's own dismiss, distinct from pruneOldNotifications'
// time-based sweep below -- same mechanism though: DB.notifications is a plain object map, so
// deleting a key and calling save(DB) is enough for syncTableDiff (db.js) to issue the real
// Postgres DELETE on the next save cycle, same as the prune job already relies on. Ownership is
// checked (404, not 403, so a guessed id doesn't confirm whether it exists for someone else) and
// no confirmation step -- Jeff explicitly said this one doesn't need it, unlike the app's other
// destructive actions (confirmSheet).
app.delete('/api/notifications/:id', auth, async (req, res) => {
  const n = DB.notifications[req.params.id];
  if (!n || n.userId !== req.userId) return res.status(404).json({ error: 'not found' });
  delete DB.notifications[req.params.id];
  await save(DB);
  res.json({ ok: true });
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

// Sep 11 2026: rewritten for the Activity page redesign. Two genuinely different sources feed
// into one merged, sorted list:
//   - Posted recaps (`s.posts[fid]`) -- UNCHANGED mechanism, permanent, profile-visible, with
//     their existing like count (p.reactions) now echoed here too, so the Activity page can show
//     the heart without a second request.
//   - DB.feedEvents -- the new ephemeral, type-tagged records (see emitFeedEvent's own long
//     comment for the full "why", and each emission site: the /log, /lock, /leave, and crew
//     challenge/roster routes). Deliberately includes the VIEWER'S OWN events now, not just
//     connections' -- Jeff's mockup shows the viewer's own PR as the very first card, so this is a
//     personal-plus-social feed, a real change from the old friends-only Home strip this replaces.
// `completed_no_recap` is suppressed here, at READ time, whenever that same session now HAS a
// posted recap for that user -- the recap row already covers it, and posting can happen any time
// after the plain "finished a workout" event was emitted (see emitFinishFeedEvents' own comment).
app.get('/api/feed', auth, async (req, res) => {
  const myConnections = connectionsOf(req.userId);
  const feedActors = new Set([req.userId, ...myConnections]);
  const items = [];
  const weekAgo = Date.now() - FEED_EVENT_RETENTION_DAYS * 24 * 3600 * 1000;

  for (const s of Object.values(DB.sessions)) {
    for (const fid of Object.keys(s.posts || {})) {
      if (!feedActors.has(fid)) continue;
      const p = s.posts[fid];
      if (!p || !p.at || !(new Date(p.at).getTime() >= weekAgo)) continue;   // NaN fails CLOSED
      if (!canSeePostAuthor(p, fid, req.userId, s)) continue;
      const img = (p.media || []).find(m => m && m.type === 'image' && typeof m.src === 'string' && m.src.startsWith('/uploads/'));
      const reactions = Array.isArray(p.reactions) ? p.reactions : [];
      items.push({ type: 'recap', by: fid, at: p.at, text: `finished ${s.name || 'a workout'}`,
        sessionId: s.id, thumb: img ? img.src : null,
        reactCount: reactions.length, reacted: reactions.includes(req.userId) });
    }
  }

  // Jeff, Sep 11 2026 ("worth changing"): a session that earns a real PR but never gets a posted
  // recap used to show TWICE -- the PR's own hero card, plus a separate, redundant "completed a
  // workout" row for the very same workout. A pr event is exactly as strong a signal that this
  // workout is already covered as a posted recap is, so it supersedes completed_no_recap the same
  // way -- keyed by (by, sessionId) since a PR always carries the session it was set in.
  const prSessions = new Set();
  for (const ev of Object.values(DB.feedEvents)) {
    if (ev.type === 'pr' && ev.sessionId) prSessions.add(ev.by + '|' + ev.sessionId);
  }
  for (const ev of Object.values(DB.feedEvents)) {
    if (new Date(ev.at).getTime() < weekAgo) continue;
    let visible;
    if (ev.by === null) {
      // Oct 2 2026 (deep audit finding): this used to be the frozen ev.memberIds snapshot ALONE
      // (who was in the crew the moment the challenge completed) -- unlike every other crew-scoped
      // type below, it never re-checked CURRENT membership, so a member who later left the crew
      // kept seeing (and could keep reacting to) this card for the rest of FEED_EVENT_RETENTION_DAYS,
      // the one crew-feed type that didn't disappear on departure like 'joined_crew'/'left_crew'/
      // 'rank'/'crew_renamed' all correctly do. Re-check live isCrewMember the same way those do;
      // ev.memberIds itself is untouched (still the honest "who actually achieved it" snapshot for
      // the card's own copy) -- only visibility now also requires still being a member today. Not
      // adding isBlocked here: this card has no single actor to check a block against (it's the
      // crew's shared win, same aggregate-only shape already accepted for challengeProgress.total),
      // and crew-internal block-blindness is itself an established, deliberate pattern elsewhere
      // (chat, lifecycle notify) -- flagged to Jeff rather than assumed silently.
      const crew = ev.crewId && DB.crews[ev.crewId];
      visible = !!crew && isCrewMember(crew, req.userId);
    } else if (CREW_SCOPED_FEED_TYPES.has(ev.type)) {
      // See CREW_SCOPED_FEED_TYPES' own comment -- Sep 13 2026, Jeff loosened this: crew
      // membership alone is enough, connection to the actor is no longer required.
      // Self-caught regression from that same loosening: the OLD gate required feedActors.has(ev.by)
      // (connected to the actor), and blockUser() severs the follow connection both ways the instant
      // you block someone -- so blocking a crew-mate used to ALSO incidentally hide their crew
      // activity from you, purely as a side effect of that connection check. Dropping the connection
      // requirement dropped that side effect too, silently un-blocking someone's crew activity even
      // though the block itself is still in effect. isBlocked here restores the guarantee directly,
      // the same way canSeeProfile/canSeePostAuthor check it explicitly rather than relying on it
      // falling out of some other, unrelated check.
      const crew = ev.crewId && DB.crews[ev.crewId];
      visible = !!crew && isCrewMember(crew, req.userId) && !isBlocked(ev.by, req.userId);
    } else {
      visible = feedActors.has(ev.by);
    }
    if (!visible) continue;
    if (ev.type === 'completed_no_recap') {
      const s = DB.sessions[ev.sessionId];
      const p = s && s.posts && s.posts[ev.by];
      // Cold-review catch: superseding this on the mere EXISTENCE of a recap made the whole
      // workout vanish for every viewer once ANY recap existed, even a 'private' one this
      // particular viewer can't see -- the real recap row above already applies canSeePostAuthor,
      // so this fallback row must apply the exact same gate before deferring to it.
      if (p && canSeePostAuthor(p, ev.by, req.userId, s)) continue;   // superseded by a recap THIS viewer can actually see
      if (prSessions.has(ev.by + '|' + ev.sessionId)) continue;   // superseded by that session's own PR hero card instead
    }
    const reactions = Array.isArray(ev.reactions) ? ev.reactions : [];
    items.push({ ...ev, reactCount: reactions.length, reacted: reactions.includes(req.userId) });
  }

  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  // This now powers the Activity page's own Today/This week sections, not just a Home quick-
  // glance strip -- a materially higher cap than the old 8. Nothing is lost either way: every
  // friend's complete recent activity is still on their own profile page (tap their name to get
  // there), and ephemeral events age out of DB.feedEvents entirely after FEED_EVENT_RETENTION_DAYS
  // regardless of this cap.
  res.json(items.slice(0, 40));
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
// Oct 2 2026 (Jeff, full redesign): "remove the visibility and the details for location, and
// inviting friends. You should solely be able to edit the exercises in the routine and then
// share the routine with others. that person should then get a notification that a routine was
// shared with them and they can then click on that be brought to the routine and accept the
// routine or decline it." This replaces the old PASSIVE share model (any 'public'-visibility
// routine silently appeared in every connection's "Shared by friends" list below, no action, no
// notification -- the old `friendT` filter that used to live here) with an ACTIVE one: a routine
// is only ever shared when its owner explicitly picks someone via POST .../share, which is the
// only thing that ever adds to t.sharedTo (a list of still-pending recipient user ids). `shared`
// below is now "routines explicitly, still-pending shared WITH ME", not "anything my connections
// happen to own and haven't marked private." Old t.location/t.visibility/t.invited left on
// existing routines are harmless, inert legacy data -- tplUse() (app.js) still legitimately reads
// them to pre-fill a brand-new WORKOUT session from an old routine; nothing here deletes or
// migrates them, and POST/PUT below simply stop accepting new values for them.
app.get('/api/templates', auth, async (req, res) => {
  const all = Object.values(DB.templates || {});
  const mine = all.filter(t => t.ownerId === req.userId);
  // Oct 2 2026: pending shares -- someone else's routine, explicitly shared with me via
  // POST /api/templates/:id/share, that I haven't yet accepted or declined. Block-filtered the
  // same way every other pending-action list in GET /api/notifications already is (invites,
  // joinRequests, removals, suggestions, reinviteAsks) -- sharing itself can't target a blocked
  // connection (resolveInvites only ever resolves against connectionsOf, which blockUser() already
  // keeps block-free), but a block can still happen AFTER the share and BEFORE it's accepted, and
  // this list must not keep showing that person's routine once it has.
  const pendingShares = all.filter(t => Array.isArray(t.sharedTo) && t.sharedTo.includes(req.userId)
    && DB.users[t.ownerId] && !isBlocked(t.ownerId, req.userId));
  // v239: shared rows carry WHO shared them - two friends' "Legs - Random" were otherwise
  // indistinguishable (Jeff's real list, Aug 28). Display name only; never the id-to-name map.
  // Every SHARED row also strips `invited` (legacy per-routine invite list, see POST/PUT below)
  // and `sharedTo` itself -- a recipient has no business seeing the full list of everyone else
  // this routine was also shared with, same reasoning hiddenBy is owner-only for everywhere else
  // in this file. Both stay on `mine` rows (your own routines) untouched -- sharedTo there is how
  // the owner's own "Share" sheet knows who it's already pending with.
  res.json({ mine: mine.map(stripHidden),
    shared: pendingShares.map(t => { const { invited, sharedTo, ...rest } = stripHidden(t);
      return { ...rest, ownerName: (DB.users[t.ownerId] && (DB.users[t.ownerId].displayName || DB.users[t.ownerId].username)) || '' }; }),
    // Sep 21 2026: the pre-made library (see starterTemplates() above). Static, same array for
    // every caller, not filtered by connections/hidden -- these aren't owned by anyone.
    starter: starterTemplates() });
});
// The non-owner half of "delete a routine": hides it from MY list, never touches the owner's
// row. See the comment above GET /api/templates for why this can't just be DELETE /:id.
// Oct 2 2026: left in place, unused by any current client code, after the active/explicit-share
// redesign retired the passive "any connection's public routine shows in my Shared list" model
// this was built for (see GET /api/templates's own comment) -- a routine the new flow actually
// shares with you is either pending (decline it, POST .../decline-share below) or yours outright
// once accepted (a real owned copy -- Delete, not Remove). Not deleted: it's a harmless no-op
// surface now, and removing it buys nothing while risking breaking some old client still calling it.
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
// Resolves invite usernames to user ids, scoped to the CALLER's own connections -- identical
// logic to POST/PUT /api/sessions' own invite resolution. A username that isn't one of the
// caller's connections is silently dropped rather than erroring, same as sessions: this doubles
// as the safety net for tplUse() (app.js) carrying a routine's saved invite list forward into a
// brand new session -- if the routine's owner is no longer connected to whoever they'd invited,
// or (for a friend's shared routine, though `invited` itself is stripped before it ever reaches
// a non-owner, see stripHidden's call site above) the names simply wouldn't resolve for the
// caller and are dropped, never invited by mistake.
const resolveInvites = (userId, usernames) => {
  if (!Array.isArray(usernames)) return [];
  const myConnections = connectionsOf(userId);
  const out = [];
  for (const un of usernames) {
    const f = myConnections.find(fid => normUser(DB.users[fid] && DB.users[fid].username) === normUser(un));
    // Sep 24 2026 (audit finding): no dedup -- ["bob","Bob"], or the same name submitted twice,
    // resolved to the same friend id pushed in twice, which meant a duplicate "Workout invite"
    // notification and a duplicated "Invited · waiting to respond" chip wherever this list is
    // rendered. `!out.includes(f)` is enough since every caller of this shared helper (session
    // creation, templates) starts from an empty invited list -- see the PUT /api/sessions/:id
    // invite-rewrite for the equivalent guard on the edit path, which additionally has to dedupe
    // against people already invited/participating.
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
};
// Oct 2 2026 (Jeff, full redesign): routine create/edit is now solely name + exercises --
// location/creatorNote/visibility/inviteUsernames (v306, "repeat a workout" folded into
// Routines) are no longer accepted here. A routine created or edited from today has none of
// those fields at all; an OLD routine that already has them keeps them untouched forever (this
// route never deletes a field it isn't told about) purely as inert legacy data -- tplUse()
// (app.js) still reads them to pre-fill a brand-new WORKOUT session, which this redesign
// deliberately does not touch. Sharing is its own explicit action now (POST .../share below),
// not something baked into create/edit.
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
// ---- Routine sharing (Oct 2 2026 redesign) ----
// The owner's explicit "share this with specific people" action -- the only thing that ever adds
// to t.sharedTo. Reuses resolveInvites, same as a session's own invite list: scoped to the
// CALLER's connections, which is automatically block-safe (blockUser() severs the follow graph
// both directions the instant either side blocks, so a blocked relationship can never resolve
// here in the first place -- see resolveInvites' own comment and blockUser's).
app.post('/api/templates/:id/share', auth, async (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.ownerId !== req.userId) return res.status(403).json({ error: 'not yours' });
  const targets = resolveInvites(req.userId, (req.body || {}).usernames);
  if (!targets.length) return res.status(400).json({ error: 'pick at least one person to share with' });
  t.sharedTo = t.sharedTo || [];
  // Oct 9 2026 (audit finding, Jeff's pick among options): { recipientId: ISO timestamp }, same
  // shape and reasoning as a session's own invitedAt (see ensureSessionShape's comment) -- lets GET
  // /api/notifications sort its "Routine shared" section by when the share actually happened,
  // rather than by which template happens to have been CREATED more recently.
  t.sharedAt = t.sharedAt || {};
  const newlyShared = targets.filter(id => !t.sharedTo.includes(id));
  for (const id of newlyShared) { t.sharedTo.push(id); t.sharedAt[id] = new Date().toISOString(); }
  await save(DB);
  // history:false -- already shown live as an actionable "Routine shared" row in GET
  // /api/notifications while it's unanswered, same pattern as a workout invite's own notify()
  // call just above in this file; accept/decline (below) get their own notify().
  for (const id of newlyShared) notify(id, { title: 'Routine shared', body: `${DB.users[req.userId].displayName} shared "${t.name}" with you`, link: { type: 'routine', routineId: t.id } }, { history: false });
  res.json(stripHidden(t));
});
// Accept: makes you the owner of a brand-new, fully independent COPY of the routine -- same
// "copy, not a live shared object" semantics tplEditCopy() already uses for a friend's old
// passively-shared routine, since routines have no collaborative-editing concept anywhere in
// this codebase. The ORIGINAL stays exactly where it is, owned by whoever shared it; this is not
// a transfer. Removes you from the pending t.sharedTo either way once decided.
app.post('/api/templates/:id/accept-share', auth, async (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!Array.isArray(t.sharedTo) || !t.sharedTo.includes(req.userId)) return res.status(403).json({ error: 'not shared with you' });
  // Defensive re-check at the moment ownership would actually be granted -- same reasoning as
  // POST /api/sessions/:id/accept's own isBlocked re-check (see its comment): the share itself
  // was created before any block could have existed between these two, but a block can happen
  // any time between then and now, and resolveInvites being block-safe at SHARE time says nothing
  // about block state at ACCEPT time. Refuse rather than letting a blocked owner's routine become
  // your own real, owned data; the pending share just sits there unaccepted (it's already
  // invisible in GET /api/templates' `shared` list and GET /api/notifications' routineShares once
  // blocked, so there's nothing left for either side to even see or act on).
  if (isBlocked(t.ownerId, req.userId)) return res.status(400).json({ error: 'blocked' });
  const id = 't_' + uid();
  const copy = { id, ownerId: req.userId, name: t.name, exercises: t.exercises.map(withDefaults) };
  if (!DB.templates) DB.templates = {};
  DB.templates[id] = copy;
  t.sharedTo = t.sharedTo.filter(x => x !== req.userId);
  if (isObj(t.sharedAt)) delete t.sharedAt[req.userId];
  await save(DB);
  res.json({ ok: true, id });
});
// Decline: just removes you from the pending list, no copy made. Always safe regardless of
// block state (removing your own pending entry can never hand anyone anything), so no isBlocked
// check here -- matching POST /api/sessions/:id/decline's own shape just above in this file.
app.post('/api/templates/:id/decline-share', auth, async (req, res) => {
  const t = DB.templates && DB.templates[req.params.id];
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!Array.isArray(t.sharedTo) || !t.sharedTo.includes(req.userId)) return res.status(403).json({ error: 'not shared with you' });
  t.sharedTo = t.sharedTo.filter(x => x !== req.userId);
  if (isObj(t.sharedAt)) delete t.sharedAt[req.userId];
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
  // Sep 24 2026 (audit finding): see visibleComments()'s own comment -- membership alone isn't
  // enough, a blocked co-participant's own messages must not come back either.
  res.json(visibleComments(s.comments, req.userId));
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
  // Sep 8 2026: same grouping treatment as crew chat above (see the long comment above
  // groupedHistoryWrite) -- was history:false, now aggregates into one durable "X commented on
  // {workout}" / "N new comments on {workout}" row per recipient instead of being dropped.
  // `session-chat` (distinct from plain `session`, still used for the swap/join/invite outcomes
  // above and below, which correctly land at the TOP of the workout) is its own link type so a
  // comment notification lands scrolled to the actual chat thread -- see openSessionChat() in
  // app.js (Jeff: "if brian commented in our ... workout - it brings me to see his comments").
  const who = DB.users[req.userId].displayName;
  const wkName = s.name || 'Workout';
  // Sep 23 2026 (audit finding): this used to only notify s.participants, but the tier check three
  // lines above this route (and on the GET right above it) already lets a pending, not-yet-accepted
  // invitee ('invited' tier) read AND post into this exact same thread — so an invited-but-not-
  // accepted person could post into the chat and then never hear about any reply to it, only
  // finding out by manually reopening the session. Notify everyone who can actually see this
  // thread, not just current participants.
  // Sep 24 2026 (audit finding): also skip anyone the poster has blocked or who has blocked the
  // poster -- a blocked co-participant's messages are now hidden from you on read (see
  // visibleComments above), so pushing them a notification for a comment they'll never actually
  // be able to see once they open it would be a dangling, confusing alert.
  const recipients = new Set([...(s.participants || []), ...(s.invited || [])]);
  // Sep 29 2026 (audit finding, Tier 4e): titled the generic literal 'New message' here while crew
  // chat's identical kind of event (below, same file) titles itself with the crew's own name --
  // same inconsistency this fixes, just the other direction: title it with the workout's name
  // (wkName, already computed just above) to match.
  for (const pid of recipients) if (pid !== req.userId && !isBlocked(req.userId, pid)) notify(pid, { title: wkName, body: `${who}: ${text.slice(0,40)}`, link: { type: 'session-chat', sessionId: s.id } },
    { group: { key: `session:${s.id}:chat`, singularBody: `${who} commented on ${wkName}`, pluralBody: n => `${n} new comments on ${wkName}` } });
  res.json(sessionView(s, req.userId));
});
// Sep 8 2026 (Jeff: "I want to be able to edit my comments - anywhere I can post one"). The
// posted-recap comment editor above (PUT .../posts/:authorId/comments/:commentId) only ever
// covered p.comments; this is the same permission shape (your own message only, stamps
// editedAt) applied to the OTHER place a user posts free text -- the live in-workout chat.
// Cold-review fix: this originally checked ownership ONLY, on the reasoning that the recap
// comment editor takes the same posture -- but it doesn't, really. The recap editor's own gate
// (post visibility) doesn't change when you edit; here, membership is the gate, and skipping it
// let someone who's since left a session (session tier no longer 'member'/'invited' -- same
// sessionTier check the GET/POST comment routes above already require) keep rewriting their old
// message's text indefinitely, in a thread they can no longer read or post into. Re-checking the
// same tier the sibling routes already enforce closes that.
app.put('/api/sessions/:id/comments/:commentId', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const tier = sessionTier(s, req.userId);
  if (tier !== 'member' && tier !== 'invited') return res.status(403).json({ error: 'forbidden' });
  const c = (s.comments || []).find(x => x.id === req.params.commentId);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (c.userId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  const text = capStr((req.body || {}).text, 2000);
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  c.text = text;
  c.editedAt = new Date().toISOString();
  await save(DB);
  res.json(c);
});
// Sep 8 2026 (Jeff: "I should be able to edit or delete any comment I have made anywhere also") --
// own message only, same membership-tier re-check as the PUT just above and the same reasoning
// (a departed member shouldn't keep any write access to a thread they can no longer read). No
// session-creator moderation branch here either, matching the crew DELETE above -- Jeff's ask is
// about his OWN comments, not clearing other people's live-chat messages.
app.delete('/api/sessions/:id/comments/:commentId', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const tier = sessionTier(s, req.userId);
  if (tier !== 'member' && tier !== 'invited') return res.status(403).json({ error: 'forbidden' });
  const c = (s.comments || []).find(x => x.id === req.params.commentId);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (c.userId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  s.comments = s.comments.filter(x => x.id !== req.params.commentId);
  await save(DB);
  res.json({ ok: true });
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
  // Sep 2026: canSeePostAuthor already refuses a blocked relationship (see its own comment) for
  // everyone EXCEPT current session participants, who keep read access to a workout they actually
  // trained together -- deliberate, see canSeePostAuthor's comment. Posting a brand new comment is
  // the highest-risk action here (new abusive text, not just re-reading old shared history), so it
  // gets its own, unconditional block check on top, regardless of that participant carve-out.
  if (isBlocked(req.params.authorId, req.userId)) return res.status(403).json({ error: 'forbidden' });
  const text = capStr((req.body || {}).text, 2000);
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  const c = { id: 'c_' + uid(), userId: req.userId, text, at: new Date().toISOString() };
  p.comments = objArray(p.comments);
  p.comments.push(c);
  await save(DB);
  if (req.params.authorId !== req.userId)
    notify(req.params.authorId, { title: 'New comment', body: `${DB.users[req.userId].displayName}: ${text.slice(0,40)}`, link: { type: 'post', sessionId: s.id, authorId: req.params.authorId } });
  res.json(sessionView(s, req.userId));
});
// ---- Edit / remove a comment on a posted recap (Sep 2026) ----
// Jeff: "I also want to be able to edit comments made or remove comments added to your profiles
// workouts" -- two distinct permissions in one sentence, both implemented here:
//   - Edit is YOUR OWN comment only (c.userId === req.userId). Editing someone else's words would
//     be tampering with what they actually said, not moderation -- nobody but the original author
//     ever gets to change a comment's text. Stamps editedAt so anyone reading the thread can tell
//     it was changed after posting, same honesty standard as everywhere else in this app (see the
//     "never state something about the user you can't stand behind" rule in CLAUDE.md, extended
//     here to "never show a comment as original when it's been edited").
//   - Delete allows EITHER the comment's own author OR the post owner (req.userId === authorId) --
//     your own comment, or anything left on your own posted workout. This is the actual moderation
//     tool Apple's UGC guideline (1.2) asks for: the owner of a piece of content must be able to
//     remove abusive replies to it without waiting on anyone else.
// Deliberately scoped to POSTED-recap comments only (p.comments), not the live in-workout chat
// (s.comments) -- Jeff's own wording ("your profiles workouts") matches the recap thread, which is
// also the one visible to a wider, less-trusted audience (canSeePostAuthor's 'public' branch);
// the workout chat is only ever visible to members/invitees of that specific session.
app.put('/api/sessions/:id/posts/:authorId/comments/:commentId', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const p = s.posts && s.posts[req.params.authorId];
  if (!p) return res.status(404).json({ error: 'not found' });
  p.comments = objArray(p.comments);
  const c = p.comments.find(x => x.id === req.params.commentId);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (c.userId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  // Sep 24 2026 (audit finding): this checked ownership only, never canSeePostAuthor -- unlike
  // the sibling live-chat comment routes just above, which explicitly re-check sessionTier "because
  // a departed member shouldn't keep any write access to a thread they can no longer read." The
  // exact same reasoning applies here: someone who commented while a session participant (admitted
  // regardless of the post's own visibility, per canSeePostAuthor's participant bypass) can leave
  // without keeping credit, or the post can go private, and GET .../comments now correctly 403s
  // them -- but until this line, they could still PUT/DELETE their own old comment on a thread
  // they'd otherwise have zero access to.
  if (!canSeePostAuthor(p, req.params.authorId, req.userId, s)) return res.status(403).json({ error: 'forbidden' });
  // Sep 8 2026 (cold-review finding): same unconditional block check as the POST-new-comment
  // route above, and for the same reason -- replacing an existing comment's text is exactly as
  // capable of landing new abusive content as posting a fresh one, so it can't be exempt from the
  // block check just because the row already existed. Without this, a post owner who blocks a
  // commenter AFTER the comment was left could not stop that commenter from rewriting it to
  // arbitrary new text indefinitely.
  if (isBlocked(req.params.authorId, req.userId)) return res.status(403).json({ error: 'forbidden' });
  const text = capStr((req.body || {}).text, 2000);
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  c.text = text;
  c.editedAt = new Date().toISOString();
  await save(DB);
  res.json(c);
});
app.delete('/api/sessions/:id/posts/:authorId/comments/:commentId', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const p = s.posts && s.posts[req.params.authorId];
  if (!p) return res.status(404).json({ error: 'not found' });
  p.comments = objArray(p.comments);
  const c = p.comments.find(x => x.id === req.params.commentId);
  if (!c) return res.status(404).json({ error: 'not found' });
  // Own comment, or the post owner removing anything left on their own post -- see the long
  // comment above the PUT handler just above for why these are the two allowed cases.
  if (c.userId !== req.userId && req.params.authorId !== req.userId) return res.status(403).json({ error: 'forbidden' });
  // Sep 24 2026 (audit finding): same gap and same fix as the PUT handler above -- deleting your
  // OWN old comment (the c.userId===req.userId branch; the post-owner-moderation branch already
  // implies canSeePostAuthor trivially, since authorId===viewerId) must not survive losing the
  // ability to see the thread at all.
  if (!canSeePostAuthor(p, req.params.authorId, req.userId, s)) return res.status(403).json({ error: 'forbidden' });
  p.comments = p.comments.filter(x => x.id !== req.params.commentId);
  await save(DB);
  res.json({ ok: true });
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
// Sep 5 2026 (Jeff: "I got a push saying someone followed me but the bell / notifications page
// showed nothing... it should also show past notifications for a specific amount of time"). Two
// separate bugs in one report: (1) GET /api/notifications (below) was built entirely from
// still-PENDING state (an unaccepted invite, an unapproved follow/join request) -- a public-
// profile follow completes instantly with no pending state left to read back, so it was never
// going to show up there no matter how long you waited; (2) even for things that DO have a
// one-shot moment, nothing was kept in-app past that moment -- there was no history at all, only
// "things needing a response right now."
// Fixed by making notify() -- already the ONE place every push in this app is sent from -- also
// append a durable, read-only history record, independent of whether the push itself succeeds
// (a user with push permission off, or the payload's target off this device entirely, should
// still see it in-app; the old `if (!sub) return` was strictly a push-delivery gate, not a
// "this happened" gate). Callers pass `{ history: false }` for the three still-pending types
// (invite/follow-request/join-request) -- those duplicate a type already shown live elsewhere
// (logging them too would show the exact same ask twice, once as a live actionable row and once
// as an inert history line). Everything else -- new follower, an accepted/declined invite or join,
// a reaction, a comment on a POSTED recap, a challenge event -- has no other durable trace once the
// moment passes, so it's exactly what "past notifications" needs to mean. Retention is
// NOTIFICATION_HISTORY_DAYS (pruneOldNotifications, below) -- an in-app inbox is not meant to
// become a permanent activity log.
const NOTIFICATION_HISTORY_DAYS = 7;

// ---- Feed events (Activity page) ----
// Sep 11 2026: the Friends page's redesign into "Activity" (Jeff's mockup + follow-up design
// discussion). Every persisted feed event gets a `reactions: []` array from day one, regardless
// of type -- Jeff: "why do we think we should add more to this list - as there won't ONLY be 3
// types of activities on this page. that we may want to like - what about workouts, etc?" --
// which types actually SHOW a heart in the UI is a separate, purely-client decision (see
// friends() in app.js), not baked into this data model.
//
// Posted recaps are DELIBERATELY NOT feed events -- they keep their existing, permanent,
// profile-visible like mechanism (s.posts[authorId].reactions, see POST
// /api/sessions/:id/posts/:authorId/react) exactly as before. Everything created here is
// EPHEMERAL by design (Jeff: "liking a PR on the activity page lets the user get awarded by
// friends seeing it - but it doesn't get stored anywhere. Only likes for workouts do and it gets
// stored on the profile"): pruned the same NOTIFICATION_HISTORY_DAYS-style window as
// notifications (see pruneOldFeedEvents below), never surfaced anywhere permanent, and never
// counted toward anything on the Profile page -- Jeff removed PRs from Profile specifically to
// avoid endless scrolling and does not want that undone.
const FEED_EVENT_RETENTION_DAYS = 7;
// Cold-review catch (Sep 11 2026): these types are all really ABOUT a specific crew (they carry a
// crewId), not just about the actor -- so GET /api/feed's visibility check below gates them on
// isCrewMember(crew, viewer), independent of the actor. 'challenge_completed' doesn't need this:
// `by` is null (crew-shared) and it already gates on a memberIds snapshot taken at emit time,
// which is its own, already-correct answer to "who saw it".
// Sep 12 2026 (Jeff, three new Activity events): 'left_crew' and 'crew_renamed' join the
// membership-shaped types above for the same reason 'joined_crew' is here. 'started_following' is
// deliberately NOT crew-scoped -- it's a person-to-person event with no crew involved, gated only
// by feedActors like 'pr'/'streak' below.
// Sep 13 2026 (Jeff: "if youre in a crew we should loosen that"): originally this ALSO required
// the viewer be connected (feedActors) to the actor, on top of crew membership -- so two crew-mates
// who didn't follow each other missed each other's crew activity, which Jeff called out as too
// tight once it shipped. Being in the crew is now sufficient on its own; connection to the actor is
// no longer required for these types. (The original crewView-403-dead-link concern that started
// this gate still holds -- isCrewMember(crew, viewer) alone still prevents a non-member from seeing
// a row that links to a crew they can't open.)
const CREW_SCOPED_FEED_TYPES = new Set(['rank', 'challenge_started', 'joined_crew', 'left_crew', 'crew_renamed']);
// type is one of: 'pr' | 'streak' | 'rank' | 'challenge_started' | 'challenge_completed' |
// 'joined_crew' | 'completed_no_recap' | 'left_crew' | 'crew_renamed' | 'started_following'. `by`
// is the userId whose activity this is; `fields` is whatever that type needs to render (see each
// call site below and friends() in app.js).
//
// Sep 12 2026 (real bug report investigation, Jeff: "Clarissa completed 2 workouts, but I only
// see the first one"): confirmed via a real repro that a workout logged for a day more than
// FEED_EVENT_RETENTION_DAYS ago (the session date picker supports logging a workout you forgot to
// log earlier) produces a 'completed_no_recap'/'pr' that never shows in Activity, even seconds
// after being logged -- because `at` is deliberately the workout's real performed date (Sep 11
// fix, so a backdated workout doesn't misleadingly read as breaking news), and this same 7-day
// window ALSO decides whether the row shows AT ALL, not just how recent it looks.
//
// A `loggedAt`-based fix (always show anything logged within the last 7 days, regardless of the
// workout's own age) was built and then reverted here: it broke the existing, deliberately-tested
// "a PR older than a week does not haunt the friends feed forever" behavior below (a 20-day-old
// PR, logged just now, is SUPPOSED to stay out of the feed) -- the two behaviors directly
// contradict each other, and which one is right is a real product call, not something to guess.
// Asked Jeff rather than picking a threshold unilaterally. See CLAUDE_HANDOFF.md / this thread for
// his answer before changing this again.
function emitFeedEvent(type, by, fields) {
  const id = 'fev_' + uid();
  DB.feedEvents[id] = { id, type, by, at: new Date().toISOString(), reactions: [], ...fields };
  return DB.feedEvents[id];
}
// Mirrors pruneOldNotifications below exactly -- GET /api/feed already filters to a recent window
// on read, so this is pure storage hygiene, not correctness; called once at boot and every few
// hours by a timer, same as notifications (see the boot section at the bottom of this file).
function pruneOldFeedEvents() {
  const cutoff = Date.now() - FEED_EVENT_RETENTION_DAYS * 86400000;
  let removed = 0;
  for (const id of Object.keys(DB.feedEvents)) {
    if (new Date(DB.feedEvents[id].at).getTime() < cutoff) { delete DB.feedEvents[id]; removed++; }
  }
  return removed;
}
// Current 1-based leaderboard rank of `userId` in crew `c`'s running challenge, or null when
// there's no running (non-custom) challenge to rank against -- a 'custom' challenge has no
// tracked number (see challengeProgress's own short-circuit), so there is nothing to rank.
function crewChallengeRank(c, userId) {
  const ch = runningChallenge(c);
  if (!ch || ch.type === 'custom') return null;
  if (!c.memberIds.includes(userId)) return null;
  const { perMember } = challengeProgress(c, ch);
  // Oct 10 2026 (audit finding #229 follow-up, cold-review catch): this computes the same "current
  // rank in this challenge" publicChallenge()'s own leaderboard sort does, for the Activity feed's
  // "moved to #N" event and the rank-improvement snapshot -- but it kept the OLD untie-broken sort
  // after publicChallenge's own sort got a deterministic alphabetical tiebreaker. Two members tied
  // at the same count could land in a different relative order here than on the leaderboard screen
  // itself -- a feed event saying "moved to #1" for someone the leaderboard shows in a tied #2 slot
  // under a different, alphabetically-earlier name. Same tiebreaker, kept in lockstep with
  // publicChallenge's sort rather than duplicating the old logic.
  const sorted = c.memberIds.filter(id => DB.users[id]).sort((a, b) => {
    const diff = (perMember[b] || 0) - (perMember[a] || 0);
    if (diff !== 0) return diff;
    const an = DB.users[a].displayName || DB.users[a].username;
    const bn = DB.users[b].displayName || DB.users[b].username;
    return an.localeCompare(bn, undefined, { sensitivity: 'base' });
  });
  const idx = sorted.indexOf(userId);
  return idx === -1 ? null : idx + 1;
}

// `opts.group` -- Sep 8 2026 (Jeff: "I want a notification for ... comments ... We don't have to
// see multiple comments, just 'brian commented on XYZ' within notifications. or grouped
// notifications for example '7 New Comments in XYZ Crew'"). Crew chat and in-workout chat used to
// pass `{ history: false }` and skip history ENTIRELY (cold-review catch, Sep 5: a chatty thread
// could blow past the history list's cap in hours, crowding out one-shot life events) -- this is
// the replacement: still exactly one durable row per (recipient, thread), but that ONE row gets
// updated in place as more messages arrive, rather than either duplicating one-row-per-message or
// being dropped outright. Shape: `{ key, singularBody, pluralBody(count) }` -- `key` scopes what
// counts as "the same thread" (e.g. `crew:${c.id}:chat`), `singularBody` is what a first, lone
// message reads as ("Brian commented in Iron Crew"), `pluralBody(n)` is what it becomes once a
// second message lands before the first was ever seen ("7 new comments in Iron Crew"). The row is
// only ever extended while STILL UNSEEN (createdAt after the recipient's own notificationsSeenAt,
// the same "have they actually looked" signal the bell badge already uses) -- once they've opened
// Notifications and seen it, the next message starts a fresh row rather than silently re-opening
// a group they already read. `payload.body` (the per-message push text, e.g. "Brian: on my way")
// is untouched by any of this -- only the durable history row's own text is aggregated; the live
// push notification still fires, and still reads, exactly as it always did per message.
function groupedHistoryWrite(userId, payload, group) {
  const seenAt = DB.users[userId] && DB.users[userId].notificationsSeenAt ? new Date(DB.users[userId].notificationsSeenAt).getTime() : 0;
  let existing = null;
  for (const n of Object.values(DB.notifications)) {
    if (n.userId === userId && n.groupKey === group.key && new Date(n.createdAt).getTime() > seenAt) {
      if (!existing || new Date(n.createdAt) > new Date(existing.createdAt)) existing = n;
    }
  }
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.title = capStr(payload.title, 120);
    existing.body = capStr(group.pluralBody(existing.count), 300);
    existing.link = isObj(payload.link) ? payload.link : existing.link;
    existing.createdAt = new Date().toISOString();   // bump to now -- re-sorts to the top, re-enters "Today" if the group started yesterday
  } else {
    const id = 'ntf_' + uid();
    DB.notifications[id] = { id, userId, title: capStr(payload.title, 120), body: capStr(group.singularBody, 300),
      link: isObj(payload.link) ? payload.link : null, groupKey: group.key, count: 1, createdAt: new Date().toISOString() };
  }
}
// `payload.link` (optional) -- Sep 8 2026 (Jeff, lock-screen screenshot: "when I click on a push
// notification it should open to where the notification happened... currently it just opens to
// where I was last"). One small tagged shape, `{type, ...ids}`, set by the callers below that have
// somewhere real to point at (a session, a posted recap, a profile, a crew) -- see
// public/sw.js's notificationclick and app.js's openDeepLink() for what each `type` opens. Callers
// with nothing specific to point at (a streak reminder, a follow REQUEST -- the notifications page
// itself is the destination) simply omit it, same as before this existed. Carried on the payload
// object itself (not nested under `data`) so it rides the exact same JSON.stringify(payload) the
// push already sends -- no wire-format change -- and is copied into the durable history row below
// so a tap on a PAST notification (not just a fresh push) can also deep-link.
function notify(userId, payload, opts) {
  if (!opts || opts.history !== false) {
    if (opts && opts.group) {
      groupedHistoryWrite(userId, payload, opts.group);
    } else {
      const id = 'ntf_' + uid();
      DB.notifications[id] = { id, userId, title: capStr(payload.title, 120), body: capStr(payload.body, 300), link: isObj(payload.link) ? payload.link : null, createdAt: new Date().toISOString() };
    }
    // Deliberately its own save(), not left to whatever save(DB) the calling route happens to run
    // -- several callers already `await save(DB)` BEFORE calling notify() (the mutation they're
    // persisting is unrelated to the notification), which would otherwise silently drop this
    // record until the next unrelated write. Fire-and-forget, same pattern as the dead-
    // subscription cleanup below; save() is internally queued, so this is safe to call from a
    // tight loop (e.g. notifying every crew member) without racing itself.
    save(DB).catch(e => console.error('notify: failed to persist notification history:', e && e.message));
  }
  // opts.push === false -- Sep 8 2026: for the one case where the recipient IS the actor (a
  // creator approving their own join request -- see /join/:reqId/approve below), a push would just
  // be telling someone about the button they themselves just tapped. The in-app history record is
  // still worth keeping (so "who's in my workout" has a durable trail), just not worth interrupting
  // them over -- same reasoning already applied to POST /api/sessions dropping ITS OWN self-push
  // ("you already know you just made it") a comment up in that route.
  if (opts && opts.push === false) return;
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
// Keeps DB.notifications from growing forever -- GET /api/notifications above already filters to
// the last NOTIFICATION_HISTORY_DAYS on read, so this is pure storage hygiene, not correctness;
// called once at boot and every few hours by a timer alongside the streak/workout reminder ones
// (see the boot section at the bottom of this file).
function pruneOldNotifications() {
  const cutoff = Date.now() - NOTIFICATION_HISTORY_DAYS * 86400000;
  let removed = 0;
  for (const id of Object.keys(DB.notifications)) {
    if (new Date(DB.notifications[id].createdAt).getTime() < cutoff) { delete DB.notifications[id]; removed++; }
  }
  return removed;
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
//   logs: { [userId]: [ { exerciseId, weight, reps, set, isPr, isSetPr } ] },
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
      // Sep 24 2026 (audit finding): same dedup gap as the shared resolveInvites() helper above --
      // see its comment. This route has its own separate copy of the same resolution logic rather
      // than calling resolveInvites, so the same fix has to be made here too.
      if (f && !invites.includes(f)) invites.push(f);
    }
  }
  const session = {
    id, creatorId: req.userId,
    scheduledAt: normalizedScheduledAt(scheduledAt),
    status: 'draft',
    // v190 (Sep 2026): binary, matching the posted-recap model -- 'public' = joinable by
    // whoever can see the creator's profile (canSeeProfile), 'private' = invite-only.
    visibility: visibility === 'public' ? 'public' : 'private',
    equipment: Array.isArray(equipment) ? equipment.filter(x => typeof x === 'string').slice(0, 20).map(x => capStr(x, 40)) : [],
    location: capStr(location, 120),
    lengthMin: numIn(lengthMin, 1440) || null,
    creatorNote: capStr(creatorNote, 2000),
    // trimmed: a name of "   " is truthy, so it would title the workout with a blank heading.
    // Sep 10 2026 (Jeff, real bug report): the "New workout" flow (unlike Quick Workout, which
    // already defaults client-side to 'Quick Workout' -- see createQuickWorkout in app.js) let a
    // blank name all the way through to here, and home()'s "Your sessions"/"joinable" filters in
    // app.js both used `s.name` as a truthy existence check -- so the session was created for
    // real (this whole object, with a real id) but then invisible everywhere on Home, reading as
    // "no workout appears" even though it existed. Fixed here, once, server-side, so it holds
    // regardless of client version: "if someone doesn't label it lets default to 'New workout'".
    name: capStr(name, 80).trim() || 'New workout',
    exercises: ex,
    participants: [req.userId],
    invited: invites,
    // Sep 23 2026 (audit finding): who actually sent each invite, captured once here and left
    // alone -- see the comment above the invite-list rewrite in PUT /api/sessions/:id for why this
    // exists. At creation time the inviter is always the creator, but it won't stay that way if
    // ownership later hands off (see /leave, /remove-mine), so it has to be its own fact, not
    // re-derived from s.creatorId on every read.
    invitedBy: Object.fromEntries(invites.map(fid => [fid, req.userId])),
    // Oct 9 2026 (audit finding): see invitedAt's own comment in ensureSessionShape.
    invitedAt: Object.fromEntries(invites.map(fid => [fid, new Date().toISOString()])),
    variations: {},
    suggestedEdits: [],
    joinRequests: [],
    attendance: {},
    logs: {},
    comments: [],
    history: [],
    posts: {},
    draftNotes: {},
    // Sep 9 2026 (Jeff: "I want to create a workout and it show up in what's up next until I click
    // 'Start now' then it moves to your sessions") -- see the long comment on the /start route
    // below for what this actually drives. null, not just absent, so `!s.startedAt` reads the same
    // whether a row was created before or after this field existed.
    startedAt: null
  };
  DB.sessions[id] = session;
  await save(DB);
  // notify invited friends
  // history:false -- already shown live as an actionable "Workout invites" row in GET
  // /api/notifications while it's unanswered; accept/decline (elsewhere) gets its own notify().
  for (const fid of invites) notify(fid, { title: 'Workout invite', body: `${DB.users[req.userId].displayName} invited you to a workout`, link: { type: 'session', sessionId: id } }, { history: false });
  // Jeff, Aug 31: lock-screen nudge naming the exercise you're about to walk up to, sent to the
  // CREATOR themselves the moment their own "starting now" session was created (see
  // notify-helpers.js for the original full reasoning and the START_WINDOW_MS scoping).
  // Reversed Sep 5: "Push notifications on created workouts shouldn't immediately show for the
  // creator who made it (they don't need to be notified instantly after making their own
  // workout)." You already know you just made it -- no push needed to tell you so. Left
  // firstExerciseStartNotification()/notify-helpers.js and its test in place rather than deleting
  // them: the decision logic is still correct and still unit-tested, this route just no longer
  // calls it. public/sw.js's openLog push-click handling and tryBoot's ?openLog= deep-link branch
  // (app.js) exist only to serve this notification's tap target -- now unreachable via this path,
  // left as harmless passthrough rather than ripped out, since nothing else generates that link.
  res.json(session);
});

// Sep 9 2026 (Jeff: "If I create a workout or quick workout they go to what's up next - but don't
// show in your sessions... I want to create a workout and it show up in what's up next until I
// click 'Start now' then it moves to your sessions"). Home's "Next up" card used to pick whichever
// open session was closest to now (see isSessionLiveNow, public/app.js) -- which meant a session
// scheduled for right now (every Quick Workout; any "New workout" once its time arrives) satisfied
// that check the instant it existed, stayed the single most-live-looking session for as long as it
// stayed unfinished, and so never once made it to "Your sessions" no matter how long it sat there.
// startedAt (session-level, set once by whoever actually taps Start now/Join now on it -- see the
// two call sites of this route in app.js) gives Home a distinct "has anyone actually begun this"
// signal to key "Next up" eligibility on INSTEAD of raw live-window timing: not yet started stays
// eligible for the Next up slot; started routes it into Your Sessions, still carrying its Live
// now/Upcoming badge there exactly as before (that badge logic is untouched, still purely
// time-based) -- only which SECTION it renders in changes. Idempotent (first tap wins, same
// shape as /lock's creditFinish) so a repeat call, or two participants tapping it moments apart,
// is a harmless no-op, not a moved timestamp. Same "in this workout" gate as /lock and /post
// (canFinishOrPost) -- starting is exactly as much "an action taken on this workout" as finishing
// or posting one, not open to someone merely invited-but-undecided.
//
// Sep 9 2026 (Jeff: "If I click 'start now' on a workout... I think it should show live right
// away. Even if the timer was for 8:00PM and its 7:30PM. It should change the time of the
// workout to the time at when you selected 'start now' and show live with that time"). Setting
// startedAt alone was not enough: Home's Live-now badge (isSessionLiveNow, public/app.js) is
// purely a clock comparison against scheduledAt, so an 8:00PM workout started early at 7:30PM
// kept reading "Upcoming" in Your Sessions for the next 20 minutes -- started, but not yet
// "live" by the original plan's clock. scheduledAt now moves to the same instant as startedAt,
// which both (a) makes it read Live now immediately, since "now" always satisfies the live
// window against itself, and (b) makes the workout's own displayed time (sessTitle/sessSub,
// wherever it's untitled) honestly say when it actually started rather than when it was
// originally planned for. Same idempotency guard as startedAt itself -- only the FIRST start
// moves the clock; a second participant's Join now, or a repeat tap, must not re-time it.
// Cold-review catch: the only UI paths that ever call this (the Next up card's Start/Join now,
// and Quick Workout's auto-start) are already restricted to a session that's live or scheduled
// TODAY -- so today, this route's safety around silently moving scheduledAt has depended
// entirely on that client-side gating, nothing here. A 24h guard below is the server-side
// backstop: if this were ever reached for a genuinely stale, days-old session (devtools, or a
// future UI surface), starting it must not ALSO quietly erase its "Missed" flag and relocate it
// onto today's week strip / weekly stats -- it still gets marked started, just without the
// re-time. (A future-scheduled session always passes this check -- Date.now() - scheduledMs is
// negative there -- this only ever holds back something already well in the past.)
//
// Oct 9 2026 (audit finding): this re-time only ever fired from the Next-Up card's own Start/Join
// now button (startSession(), app.js) -- but that is not the only door into "actually doing the
// workout, for real." Accepting a direct invite (acceptInvite()) and joining a discoverable public
// session (requestJoin/approveJoin) both drop straight into openSession() with no call to this
// route at all, so someone who accepted an invite for "Tomorrow, 9:15 PM" and then logged real
// sets immediately could finish and post with that stale scheduled time intact forever -- the
// recap permanently read "Tomorrow, 9:15 PM" for something that actually happened right then.
//
// Tempting fix, REJECTED: hook this into every set log (POST .../log) instead of here. Tried it
// first, and it breaks a real, deliberate, already-shipped feature -- the Oct 7 2026 "live session
// activity" line on Home's Next-Up card, whose whole point is showing a friend ALREADY logging
// real sets on a session the VIEWER has not yet tapped Start on ("Brian is in · Brian just
// started"), without that pulling the card out of Next-Up and into Your Sessions out from under
// them (test/home-live-session-activity-line.mjs's "still lands in Next-up" case is exactly this).
// A single participant logging a set is routine and must NOT globally flip startedAt by itself.
//
// What actually distinguishes the real bug from that: by the time someone finishes (/lock) a
// session nobody ever explicitly started, the workout has unambiguously already happened -- this
// is the exact "PRs/timestamps were still snapshotted from stale data at log time" shape the Sep
// 28 2026 fix two routes below (creditFinish's history timestamp over scheduledAt) already solved
// for PRs specifically; this closes the same gap for the session's own displayed date/time. Pulled
// the idempotent startedAt/scheduledAt logic out into its own helper so POST .../lock below can
// apply it too, backdated to the EARLIEST real log across every participant (closer to "when it
// actually began" than "now, at the moment someone tapped Finish") -- same 24h-guard shape, so a
// long-overdue session someone finally logs and finishes days later still gets marked started
// without silently erasing its "Missed" flag or back-dating itself into an implausible past.
function markSessionStarted(s, when) {
  if (s.startedAt) return;
  const now = when || new Date().toISOString();
  s.startedAt = now;
  const scheduledMs = new Date(s.scheduledAt).getTime();
  const nowMs = new Date(now).getTime();
  if (!isNaN(scheduledMs) && !isNaN(nowMs) && (nowMs - scheduledMs) < 24 * 3600e3) s.scheduledAt = now;
}
app.post('/api/sessions/:id/start', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!canFinishOrPost(s, req.userId)) return res.status(403).json({ error: 'not in this workout' });
  if (!s.startedAt) {
    markSessionStarted(s);
    await save(DB);
  }
  res.json(sessionView(s, req.userId));
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
  // Sep 23 2026 (audit finding): { inviteeId: inviterId }, set once when someone is invited and left
  // alone after that -- see the comment above the invite-list rewrite in PUT /api/sessions/:id for
  // why. Older sessions/invites predating this field simply have no entry here; every read site
  // falls back to s.creatorId for those, same as before this existed.
  if (!isObj(s.invitedBy)) s.invitedBy = {};
  // Oct 9 2026 (audit finding, Jeff's pick among options): { inviteeId: ISO timestamp }, parallel
  // to invitedBy above and following the exact same "set once, left alone, older invites simply
  // have no entry" shape -- GET /api/notifications sorts its invites section by this so a just-now
  // invite from an old session doesn't sit buried under a day-old invite from a session that merely
  // happens to have been CREATED more recently (Object.values(DB.sessions) iteration order was the
  // old, accidental sort -- session creation order, not invite recency).
  if (!isObj(s.invitedAt)) s.invitedAt = {};
  s.exercises = objArray(s.exercises);
  if (!isObj(s.logs)) s.logs = {};
  else for (const uid of Object.keys(s.logs)) s.logs[uid] = objArray(s.logs[uid]);  // each user's set list
  if (!isObj(s.attendance)) s.attendance = {};
  s.comments = objArray(s.comments);
  s.suggestedEdits = objArray(s.suggestedEdits);
  if (!isObj(s.variations)) s.variations = {};
  s.joinRequests = objArray(s.joinRequests);
  // Sep 23 2026 (Jeff, real bug report -> design confirmed with him): removing an exercise other
  // participants have already logged sets against no longer happens on the creator's one-tap Save
  // alone -- it needs every one of them to actually sign off first, so an honest accident can't
  // wipe out someone's logged work. See PUT /api/sessions/:id and the two /removal/:reqId routes.
  s.pendingRemovals = objArray(s.pendingRemovals);
  // Sep 23 2026: per-exercise "hide from just my own view" (bug #2 follow-up) -- { exerciseId:
  // [userIds who hid it] }, the same personal, doesn't-touch-the-shared-plan shape s.variations
  // already uses for a personal swap.
  if (!isObj(s.hiddenFor)) s.hiddenFor = {};
  s.history = objArray(s.history);
  if (!isObj(s.posts)) s.posts = {};
  if (!isObj(s.draftNotes)) s.draftNotes = {};
  // Sep 27 2026 (Jeff): "Brian declined... but later thought he could go... message the chat for a
  // re-invitation." A private-session decliner drops to sessionTier 'stranger' (see that function's
  // own comment) -- no participant/invited status, no logs, no history -- so they lose ALL access to
  // the session, including chat, the instant they decline. Rather than the heavier change of
  // re-granting chat access unilaterally, a decliner who changes their mind sends a short message
  // that goes straight to the creator as its own notification (see POST .../reinvite-request below);
  // the creator can then one-tap re-invite them from THEIR notification (see .../approve below),
  // which does the exact same s.invited/s.invitedBy work the normal invite flows already do. Same
  // objArray-normalized shape as joinRequests/pendingRemovals just above.
  s.reinviteRequests = objArray(s.reinviteRequests);
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
  // Oct 1 2026 (audit finding, round-2 Tier 2): every sibling gate in this file (canSeeProfile,
  // canSeePostAuthor, the member-tier filters just below) checks isBlocked before granting
  // anything -- this one didn't, so a PENDING invite kept working as a live, full-plan-revealing
  // 'invited' tier even after either side blocked the other. GET /api/sessions/:id was handing
  // over the full plan -- location, notes, exercises -- under the unguarded 'invited' tier, and
  // this session kept showing up in GET /api/sessions (Home's invite banner, Notifications) too.
  // Resolved against the actual inviter, not the bare s.creatorId: a session can go ownerless
  // (s.creatorId === null, permanently, once its creator /leave's -- see the "ownerless" comment
  // on that route) while an invite someone sent before leaving is still pending, since /leave
  // never clears s.invited/s.invitedBy. isBlocked(null, viewerId) always evaluates false (no
  // user's own .blocked array can contain the literal null), so checking the bare creatorId would
  // silently stop catching a block the instant the session went ownerless -- the exact gap a
  // cold-review pass on this fix caught. Same resolution GET /api/notifications' own invites list
  // already uses for this reason (see its comment) and the same one sessionView's own 'invited'/
  // 'invitedById' fields use below. Falls through to the same 'stranger'/'alumni' resolution below
  // a genuine non-invitee gets -- a blocked pending invite is not silently promoted to anything,
  // it is simply no longer 'invited'.
  const inviterId = (s.invitedBy && s.invitedBy[viewerId]) || s.creatorId;
  if (Array.isArray(s.invited) && s.invited.includes(viewerId) && !isBlocked(inviterId, viewerId)) return 'invited';
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
  // Sep 23 2026 (bug #2 follow-up, kick-a-participant): the exact same class of bug the comment
  // above describes, for someone the CREATOR removed rather than someone who left on their own.
  // Kicking deliberately never calls creditFinish (see /participants/:pid/remove's own comment --
  // crediting a full workout finish on someone's behalf when they were only removed, maybe after
  // one exercise, would overclaim what they actually did), so a kicked person has real s.logs but
  // no s.history row, and without this line they'd hit the identical "forbidden" dead end on data
  // that is explicitly supposed to survive for them (Jeff: "they just keep the sets they've
  // logged"). Scoped to genuinely having logged something here, not merely having been kicked --
  // someone removed before logging a single set has nothing of their own left to look at.
  if (s.logs && Array.isArray(s.logs[viewerId]) && s.logs[viewerId].length) return 'alumni';
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
  // Sep 2026 (app-store readiness): checked before the participant/membership bypass just below,
  // not just before the public-visibility branch -- a shared session's OWN participants can
  // normally always see each other's recaps regardless of visibility ("you were there"), and that
  // bypass must not survive a block. Without this a workout the two of you already did together
  // would keep exposing your recap to someone you've since blocked, since they'd still read as a
  // fellow participant. See the identical, more detailed comment on isBlocked/canSeeProfile above.
  if (isBlocked(authorId, viewerId)) return false;
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

// Sep 24 2026 (audit finding): the live in-workout chat thread (s.comments) is a single shared
// array read straight off the session, and neither GET /api/sessions/:id/comments nor
// sessionView's member/invited branches ever re-checked block on it -- sessionTier only gates
// whether you can see the THREAD at all, not which messages in it are from someone you've since
// blocked (or who's blocked you). Two co-participants who blocked each other could still read
// and post to each other in the exact same shared thread, contradicting this app's own documented
// block contract ("if EITHER account has blocked the other, neither can see or interact with the
// other, regardless of who blocked whom"). Same instinct as canSeePostAuthor's isBlocked check on
// recaps, just applied per-message instead of per-post since this is one shared array, not a
// per-author map.
function visibleComments(list, viewerId) {
  return (list || []).filter(c => !isBlocked(c.userId, viewerId));
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
      // Sep 24 2026 (audit finding): `current` had no isBlocked check, unlike `viaPost` (which
      // goes through the already-block-aware canSeePostAuthor) -- so two co-participants who
      // blocked each other still saw each other's full logged sets (every weight/rep) in the
      // shared sheet, even though the analogous posted-recap path was already correctly hidden.
      // `uid === viewerId` stays unconditional right below so this can never hide your own sets.
      const current = ((s.participants || []).includes(uid) || s.creatorId === uid) && !isBlocked(uid, viewerId);
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
    // Same "creator sees everything, everyone else sees only their own stake in it" rule as
    // joinRequests above: the creator needs the full list to track status/cancel; a required
    // approver needs to see the ones asking THEM to weigh in; someone with no stake in a given
    // request (didn't log sets on that exercise) never sees it at all.
    const pendingRemovals = (s.creatorId === viewerId) ? (s.pendingRemovals || [])
      : (s.pendingRemovals || []).filter(p => (p.requiredApprovals || []).includes(viewerId));
    // Same "yourself and nobody else" rule as joinRequests just above -- draftNotes is scratch,
    // own-eyes-only scribbling mid-workout, not a recap anyone else in the session gets to read.
    // `draftNotes: undefined` overrides the raw s.draftNotes object the spread below would
    // otherwise leak (every participant's draft, keyed by their id) with just your own string.
    const myDraftNotes = (s.draftNotes && s.draftNotes[viewerId]) || '';
    // Same "yourself and nobody else" rule again -- a plain per-exerciseId array of every hidden
    // exercise YOU chose to hide. `hiddenFor: undefined` overrides the raw s.hiddenFor object the
    // spread below would otherwise leak (who ELSE has personally hidden what is nobody else's
    // business, same instinct as everything above).
    const myHiddenExerciseIds = Object.keys(s.hiddenFor || {}).filter(exId => (s.hiddenFor[exId] || []).includes(viewerId));
    // Sep 23 2026 (cold-review catch): this Object.assign spreads the raw session, so s.invitedBy
    // -- who invited WHOM, for every invitee, not just the viewer's own -- went out unredacted to
    // every current member. Same "yourself and nobody else" rule as draftNotes/hiddenFor right
    // above, and the exact instinct the non-member `view` object's own invitedById already follows
    // (see its comment: "nobody else's business"). A member who is also still separately invited
    // (edge case, but s.invited/s.participants are independent arrays) gets their own entry back
    // the same scoped way; everyone else's is stripped.
    const myInvitedById = (Array.isArray(s.invited) && s.invited.includes(viewerId))
      ? ((s.invitedBy && s.invitedBy[viewerId]) || s.creatorId) : undefined;
    // Sep 24 2026 (audit finding): comments used to pass straight through the raw spread below
    // with no block filtering at all -- see the comment on visibleComments() above.
    const comments = visibleComments(s.comments, viewerId);
    // Sep 24 2026 (audit finding): joinableHiddenBy -- who swiped to hide THIS workout from their
    // own "Friends' workouts" feed -- went out as a raw array of every hider's user id to every
    // current member/creator via this same unfiltered spread, the exact "who did X privately" leak
    // draftNotes/hiddenFor/invitedBy right above were each already fixed for. Same "yourself and
    // nobody else" shape as those: a plain boolean for your own hide state (matching the non-member
    // view's hiddenForMe just below), never the list of who else hid it.
    const hiddenForMe = Array.isArray(s.joinableHiddenBy) && s.joinableHiddenBy.includes(viewerId);
    // Cold-review catch (same pass as the block-privacy cluster above): suggestedEdits (pending/
    // approved swap proposals, each carrying who proposed it) passed straight through the raw
    // spread with no block check at all, unlike comments/logs/posts right above -- a blocked
    // co-participant's swap proposal text was still visible to the person who blocked them.
    // Sep 27 2026 (ownerless redesign): a privatePreJoin edit (suggestOwnerless's still-invited
    // carve-out) is explicitly NOT part of the shared conversation every other suggestedEdits entry
    // is -- see the comment above suggestOwnerless's branch in /suggest for why ("stays entirely
    // private... nobody else is left to ask"). A current member never legitimately has one of their
    // own here (it only ever exists before they've joined, and /accept resolves and removes it the
    // moment they do), so this is a straightforward exclude, not a "your own only" carve-out.
    const suggestedEdits = (s.suggestedEdits || []).filter(se => !isBlocked(se.proposedBy, viewerId) && !se.privatePreJoin);
    return Object.assign({}, s, { posts, logs, comments, suggestedEdits, joinRequests, pendingRemovals, draftNotes: undefined, myDraftNotes, hiddenFor: undefined, myHiddenExerciseIds, invitedBy: undefined, invitedById: myInvitedById, joinableHiddenBy: undefined, hiddenForMe });
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
    // Sep 18 2026 -- Home's "Friends' workouts" swipe-to-remove (see POST /:id/hide-joinable
    // below). A boolean, not the raw joinableHiddenBy array: nobody but the viewer themselves
    // needs to know THEY hid it, and nobody at all needs to know who ELSE did -- same "don't leak
    // who removed it" instinct as templates' hiddenBy/stripHidden above, just computed per-viewer
    // instead of stripped from a shared object.
    hiddenForMe: Array.isArray(s.joinableHiddenBy) && s.joinableHiddenBy.includes(viewerId),
    creatorNote: seesFullPlan ? s.creatorNote : undefined, equipment: s.equipment || [],
    exercises: s.exercises || [], participants: s.participants || [],
    // Whether the creator has finished their own portion — not privacy-sensitive (just a
    // boolean, no one's actual data), so available to every non-member tier alike rather than
    // gated per-tier. Uses the real s.history, same source `history` below now draws its own
    // (viewer-only) slice from.
    creatorFinished: (s.history || []).some(h => h.userId === s.creatorId),
    // Sep 27 2026 (Jeff: a friend's past-dated, never-logged workout should auto-disappear from
    // "Friends' workouts" on Home -- "if its past the date it should disappear from my screen
    // until he changes the date or deletes it"). Home needs to tell "genuinely never touched" (the
    // whole reason this exists -- Brian created it, never opened it again) apart from "still
    // actively being logged, just running past its original date" (the exact case Aug 20's
    // creatorFinished carve-out already protects -- see the comment above it). The one signal that
    // tells them apart without exposing anyone's actual sets is whether ANYONE has logged
    // anything at all -- same "just a boolean, no one's actual data" reasoning as creatorFinished
    // right above, not the real per-person s.logs (`logs: {}` a few lines down is deliberately
    // empty for every non-member tier -- see its own comment -- so the client can never compute
    // this itself from what it's handed).
    anyLogged: !!(s.logs && Object.values(s.logs).some(arr => Array.isArray(arr) && arr.length)),
    // You are told about YOURSELF and nobody else. Emptying this entirely also erased the fact
    // that the viewer is invited, which is what the whole invitation screen keys on — "waiting on
    // you", the Respond block, and being able to suggest a swap before accepting all vanished.
    // Everyone else who was asked and has not answered is a fact about them, not about you.
    invited: (Array.isArray(s.invited) && s.invited.includes(viewerId)) ? [viewerId] : [],
    // Sep 23 2026 (audit finding): who actually invited YOU specifically -- see the invitedBy
    // comment on PUT /api/sessions/:id and on session creation for why this can no longer be
    // assumed to be s.creatorId. Same "yourself and nobody else" shape as `invited` just above:
    // the client gets a single resolved id for its own invite, not the whole map of who invited
    // everyone else (nobody else's business, same instinct as suggestedEdits/comments below).
    invitedById: (Array.isArray(s.invited) && s.invited.includes(viewerId))
      ? ((s.invitedBy && s.invitedBy[viewerId]) || s.creatorId) : undefined,
    // who proposed swapping what is a conversation between the people in the workout — a stranger
    // reading a public recap was never one of them (v250: this used to include 'reader' too).
    // Sep 27 2026 (ownerless redesign): EXCEPT a privatePreJoin edit, which is deliberately not
    // part of that shared conversation -- it's one still-invited person's own stashed swap, visible
    // only to them until they actually join (see suggestOwnerless's comment in /suggest). Another
    // invited-tier viewer (a different pending invitee to the same session) must not see it either.
    suggestedEdits: tier === 'invited' ? (s.suggestedEdits || []).filter(se => !se.privatePreJoin || se.proposedBy === viewerId) : [],
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
    comments: tier === 'invited' ? visibleComments(s.comments, viewerId) : [],
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
  // Oct 9 2026 (audit finding): 'friend' is this function's internal name for the OTHER "still
  // deciding" tier -- a public, joinable-but-not-yet-joined session (see sessionTier's own v190
  // comment on why it's named 'friend' rather than renamed to match) -- and it never got this same
  // signal, even though the client's own startedLine (app.js) exists for exactly this "help you
  // decide" reason on EITHER door in. Someone looking at a stranger's public workout, deciding
  // whether to tap "Join in?", got zero indication it was already underway. Same privacy posture
  // as 'invited' above -- counts only, current participants only, nothing from anyone's record.
  if (tier === 'invited' || tier === 'friend') {
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

// Sep 23 2026 (audit finding): the kick route below (POST .../participants/:pid/remove) is the
// only departure path that ever let go of a REQUIRED vote a departing person still held on a
// pending exercise-removal. /leave, /remove-mine and stripUserFromSession (used by
// /me/reset-workouts) all let someone erase their own participation in a workout without this
// cleanup, so a fully departed person stayed a standing, undiscoverable-except-via-notifications
// required approver forever -- and unlike a stuck-on-someone-inactive vote, the creator had no way
// to force THIS one, since you can't kick someone who already left. Same "drop their vote, let it
// resolve if that was the last one needed" behavior the kick route already had, now shared by every
// departure route. Returns the pendingRemovals that got auto-resolved so callers can notify.
function dropRequiredApprover(s, target) {
  const resolvedNow = [];
  for (const pr of (s.pendingRemovals || [])) {
    if (pr.status !== 'pending') continue;
    if (!pr.requiredApprovals.includes(target)) continue;
    pr.requiredApprovals = pr.requiredApprovals.filter(x => x !== target);
    pr.approvals = pr.approvals.filter(x => x !== target);
    if (pr.requiredApprovals.length && pr.requiredApprovals.every(uid_ => pr.approvals.includes(uid_))) {
      pr.status = 'approved';
      s.exercises = s.exercises.filter(e => e.id !== pr.exerciseId);
      resolvedNow.push(pr);
    } else if (!pr.requiredApprovals.length) {
      // They were the ONLY person this was waiting on -- nobody else has a stake in it, same as
      // if the exercise had never had anyone else's sets on it to begin with.
      pr.status = 'approved';
      s.exercises = s.exercises.filter(e => e.id !== pr.exerciseId);
      resolvedNow.push(pr);
    }
  }
  return resolvedNow;
}

// Sep 27 2026 (ownerless-workout redesign, Jeff: "the owner can just leave -- no new owner needed",
// mapped out in full in a reference doc -- "Ownerless Workout Flow" -- after the Sep 26 attempt to
// ship a plain ownership-HANDOFF notification turned out to directly contradict this already-
// decided design). The old behavior silently promoted another current participant to creatorId
// when the creator left; that's gone. Ownership now simply clears (creatorId -> null) and NEVER
// comes back -- nothing in this codebase ever re-assigns a null creatorId, which is what makes
// s.creatorId === null a reliable, permanent signal that a session is (and will remain) ownerless
// for the rest of its life. Every route below branches on that signal.
//
// Mutates a pending suggestedEdit into its applied, shared-plan-changing form -- the exact
// mutation the OWNED single-approver /suggest/:id/approve route has always performed. Factored out
// so the pivot moment (an edit still waiting on a now-departed owner's OK "auto-applies right now
// -- nobody's left to ask", the doc's own step 5a) can share it instead of duplicating it. Callers
// set edit.status and call save/notify themselves -- this function only ever mutates exercises/
// variations/logs, matching the shape approve() already returns to its own caller.
function applyOwnedSuggestedEdit(s, edit) {
  if (edit.type === 'add') {
    const newEx = Object.assign({ id: 'e_' + uid(), order: s.exercises.length }, withDefaults({ name: edit.swapTo }));
    s.exercises.push(newEx);
    return { fromName: null };
  }
  const ex = s.exercises.find(x => x.id === edit.exerciseId);
  const fromName = ex ? ex.name : null;
  if (!edit.swapTo || !edit.swapTo.trim()) return { fromName };   // a pre-Sep-6 blank proposal
  if (ex) ex.name = edit.swapTo;
  for (const pr of (s.pendingRemovals || [])) {
    if (pr.status === 'pending' && pr.exerciseId === edit.exerciseId) pr.exerciseName = edit.swapTo;
  }
  if (s.variations[edit.exerciseId]) {
    delete s.variations[edit.exerciseId][edit.proposedBy];
    for (const uid_ of Object.keys(s.variations[edit.exerciseId])) {
      if (s.variations[edit.exerciseId][uid_] && s.variations[edit.exerciseId][uid_].swapTo === edit.swapTo) delete s.variations[edit.exerciseId][uid_];
    }
  }
  const already = (s.logs && s.logs[edit.proposedBy]) || [];
  let renamed = 0;
  for (const l of already) {
    if (l.exerciseId !== edit.exerciseId) continue;
    if (l.exerciseName === edit.swapTo) continue;
    l.exerciseName = edit.swapTo; renamed++;
  }
  if (renamed) rebuildAllPrs();
  return { fromName };
}

// Sep 27 2026: at the exact pivot instant an owned session becomes ownerless, anything still
// waiting on that now-departed owner's OK can never be decided again (approve/reject become
// creator-only forever, and there is no creator) -- so it auto-applies right there, as the doc's
// own step 5a puts it: "nobody's left to ask. It would be stuck forever otherwise." Returns the
// list of applied edits so the caller can notify each proposer once, after its own save(DB).
function autoApplyPendingEditsAtPivot(s) {
  const applied = [];
  for (const edit of (s.suggestedEdits || [])) {
    if (edit.status !== 'pending' || edit.privatePreJoin) continue;
    edit.status = 'approved';
    applyOwnedSuggestedEdit(s, edit);
    applied.push(edit);
  }
  return applied;
}

// Sep 27 2026: applies (or clears) ONE current participant's own independent vote on an ownerless
// group proposal. This is deliberately NOT a shared-plan rename the way the owned approve route
// above is -- the doc is explicit that "the shared exercise name never changes for anyone -- every
// 'yes' is really that person's own personal swap, the same mechanism 'swap for just me' already
// used" (see POST /variation). A swap-vote is literally that: a personal s.variations entry. An
// add-vote is literally the existing per-viewer hide/unhide mechanism (s.hiddenFor) an "add"
// proposal already defaults everyone but the proposer into when it's created (see /suggest below).
// Never touches anyone else's card, never renames the shared exercise, never retroactively relabels
// sets already logged before this vote (same "frozen at log time" principle /variation already
// follows) -- only a fresh approve relabels going-forward/already-logged sets under the new name.
// Sep 27 2026 (Jeff, cold-review follow-up: "it should disappear/collapse once everyone's on
// board"): an ownerless "add" suggestion voted yes by every CURRENT participant has nothing left
// to decide, so it settles (status: 'approved') and drops out of "Suggested changes" for good --
// see the client's app.js `ed.type==='add' && ed.status==='approved'` skip in the pendingEdits/
// decidedHtml split, built ahead of this exact feature and dead (per its own comment) until now.
// Deliberately scoped to 'add' only: a swap never settles this way -- every "yes" on a swap is
// its own permanent personal choice, never a step toward one shared decision (see
// applyOwnerlessVote's own comment on why a swap never renames the shared exercise for everyone).
// Checked fresh against the CURRENT s.participants every time it's called (on every vote, and
// again after every departure route -- see /leave, /remove-mine, stripUserFromSession), so it
// naturally re-opens the moment someone new joins mid-vote (a late joiner is backfilled into
// s.hiddenFor by /accept, but only while this stays 'pending' -- exactly the state this guards)
// and can complete on its own when a holdout leaves instead of voting.
function maybeResolveOwnerlessAdd(s, edit) {
  if (edit.type !== 'add' || edit.status !== 'pending') return;
  const votes = edit.votes || {};
  if (s.participants.length && s.participants.every(pid => votes[pid] === 'approved')) edit.status = 'approved';
}

function applyOwnerlessVote(s, edit, userId, decision) {
  edit.votes = edit.votes || {};
  edit.votes[userId] = decision;
  if (edit.type === 'add') {
    s.hiddenFor[edit.exerciseId] = s.hiddenFor[edit.exerciseId] || [];
    const hidden = s.hiddenFor[edit.exerciseId];
    const idx = hidden.indexOf(userId);
    if (decision === 'approved') { if (idx !== -1) hidden.splice(idx, 1); }
    else if (idx === -1) hidden.push(userId);
    maybeResolveOwnerlessAdd(s, edit);
    return;
  }
  s.variations[edit.exerciseId] = s.variations[edit.exerciseId] || {};
  if (decision === 'approved') {
    s.variations[edit.exerciseId][userId] = { swapTo: edit.swapTo, reason: 'self' };
    let renamed = 0;
    for (const l of ((s.logs && s.logs[userId]) || [])) {
      if (l.exerciseId !== edit.exerciseId || l.exerciseName === edit.swapTo) continue;
      l.exerciseName = edit.swapTo; renamed++;
    }
    if (renamed) rebuildAllPrs();
  } else {
    // Only clear if the CURRENT variation is the one THIS proposal set -- never clobber an
    // unrelated personal "swap for just me" the same user made some other way.
    const v = s.variations[edit.exerciseId][userId];
    if (v && v.swapTo === edit.swapTo) delete s.variations[edit.exerciseId][userId];
  }
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
  // Sep 23 2026 (Jeff, real question: "does removing from his view hide anything underneath that
  // may be missed or an issue with logging and completing?"): confirmed a real gap -- an exercise
  // someone hid from just their OWN view (hide-for-me) was still counted in here, since this used
  // to map over every one of s.exercises with no per-viewer filter. Tapping Log & Finish after
  // hiding an exercise silently wrote it into that person's PERMANENT history record anyway --
  // "Leg Press" showing up in someone's history when they explicitly said not for me and never
  // logged a single set on it. Filtered out here the same way myHiddenExerciseIds already filters
  // it out of their own live card list (app.js) -- CLAUDE.md's own rule: never state something
  // about the user's history you can't stand behind.
  const hidden = new Set(Object.keys(s.hiddenFor || {}).filter(exId => (s.hiddenFor[exId] || []).includes(userId)));
  const exNames = s.exercises.filter(e => !hidden.has(e.id)).map(e => {
    const v = s.variations[e.id] && s.variations[e.id][userId];
    return v ? v.swapTo : e.name;
  });
  const mgs = new Set();
  for (const n of exNames) {
    const lib = EX_LIB.find(x => x.name === n);
    if (lib) exMuscles(lib).forEach(m => mgs.add(m));
  }
  const date = isValidLocalDateStr(localDate) ? localDate : new Date().toISOString().slice(0, 10);
  // `at` (real timestamp, independent of `date` which is a local YYYY-MM-DD string picked for
  // streak purposes) exists so challengeProgress below can gate on a precise instant even for a
  // workout finished with zero logged sets -- see the comment on that fallback branch for why a
  // day-string-only comparison there was a real double-counting bug.
  s.history.push({ userId, date, muscleGroups: [...mgs], exercises: exNames, at: new Date().toISOString() });
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
  const creditOthers = othersWithCredit(s, req.userId);
  // Sep 18 2026 (Jeff, real bug report on Home's swipe-to-delete): "if we delete a workout we
  // created and others have joined — it shouldn't delete the workout for everyone — it should just
  // let you leave, keeping that workout active for the others who are currently still in it."
  // othersWithCredit alone only protected participants who'd already logged something or had a
  // history row — someone who'd merely ACCEPTED an invite and hadn't logged a single set yet was
  // invisible to it, so deleting still wiped the workout out from under them with no warning.
  // othersStillHere is every other CURRENT participant, logged or not (s.participants was never
  // filtered by activity) — the same "every other current participant" set /leave's own ownership
  // handoff below already falls back to, so this now protects the exact same people that route
  // already knows how to hand the workout off to.
  const othersStillHere = (s.participants || []).filter(id => id !== req.userId);
  if (creditOthers.length || othersStillHere.length) {
    const withCredit = creditOthers.length > 0;
    const names = (withCredit ? creditOthers : othersStillHere)
      .map(id => (DB.users[id] && (DB.users[id].displayName || DB.users[id].username)) || 'someone');
    const verb = names.length === 1 ? 'is' : 'are';
    const error = withCredit
      ? `${names.join(' and ')} logged sets in this workout. Deleting it would erase their training history too.`
      : `${names.join(' and ')} ${verb} still in this workout. Deleting it would remove it for them too.`;
    return res.status(409).json({ error, othersLogged: creditOthers.length, canLeave: true });
  }
  delete DB.sessions[req.params.id];
  rebuildAllPrs();     // the records were built from sets that no longer exist
  await save(DB);
  res.json({ ok: true });
});

// Sep 29 2026 (audit finding, dedup): /leave and /remove-mine each carried an identical ~35-line
// block of "who to notify now that this person is gone" logic (the creator's resolved removal
// votes, any auto-applied suggestions, and the pivot/departure broadcast to whoever's left) --
// two copies of the same thing that had to be kept in sync by hand. Same shape as
// notifyWipePivots further down, which already does this once for reset-workouts/delete-account.
// One shared function, two call sites.
//
// Sep 30 2026 (audit finding, Tier 5 dedup): the creator-kicks-a-participant route (below) carried
// its own THIRD, near-identical copy of just the resolvedRemovals half of this -- never the
// autoApplied/wasOwner/alreadyOwnerless pivot broadcasts, which don't apply to a kick (ownership
// never changes when the creator kicks someone; only /leave and /remove-mine can make a session
// ownerless). Rather than leave that copy unshared, `resolvedPush` lets the kick route reuse this
// SAME function with autoApplied/wasOwner/alreadyOwnerless all passed as empty/false (no-ops, same
// as the resolvedRemovals-only work kick actually needs) and its own, different push behavior: kick
// is creator-only, so the person resolving the removal vote and the person being notified about it
// are always the SAME account -- muted (push:false) so the creator never gets buzzed about the
// button they themselves just tapped, unlike /leave and /remove-mine where the creator is someone
// ELSE and a real push is exactly right (the default here, unchanged for both of them).
function notifyDeparturePivots(s, me, { resolvedRemovals, autoApplied, wasOwner, alreadyOwnerless, resolvedPush = true }) {
  // Oct 2 2026 (deep audit finding): this was the one notify() in this function without an
  // isBlocked guard -- the autoApplied loop and both stillHere broadcasts right below it already
  // check isBlocked(me, ...), and resolvePendingRemoval's own direct approve/decline paths fire
  // this exact same "Removal approved"/"Removal declined" message with the identical guard. Only
  // this pivot-triggered path (fired when the departing participant's own leave/remove-mine
  // auto-resolves a pending removal they were a required approver for) was missing it.
  if (s.creatorId && !isBlocked(me, s.creatorId)) {
    for (const pr of resolvedRemovals) {
      notify(s.creatorId, { title: 'Removal approved', body: `${pr.exerciseName} was removed from ${s.name}`, link: { type: 'session', sessionId: s.id } }, { push: resolvedPush });
    }
  }
  for (const edit of autoApplied) {
    if (!isBlocked(me, edit.proposedBy)) {
      notify(edit.proposedBy, { title: 'Suggestion approved', body: `${edit.swapTo} was approved automatically — the host left before deciding`, link: { type: 'session', sessionId: s.id } });
    }
  }
  // Doc tab 07: two distinct broadcasts. The pivot itself ("Workout host left") only when THIS
  // departure is what caused it; a plain "[Name] left the workout" for any departure (owner or
  // not) once the session was ALREADY ownerless beforehand -- an owned session's ordinary
  // participant leaving is unaffected (no notification), same as before the ownerless redesign.
  const stillHere = (s.participants || []).filter(id => id !== me);
  if (wasOwner) {
    for (const uid_ of stillHere) {
      if (!DB.users[uid_] || isBlocked(me, uid_)) continue;
      notify(uid_, { title: s.name || 'Workout', body: 'Workout host left — this workout has no host now, but everyone can still add or swap exercises.', link: { type: 'session', sessionId: s.id } });
    }
  } else if (alreadyOwnerless) {
    const whoLeft = (DB.users[me] && DB.users[me].displayName) || 'Someone';
    for (const uid_ of stillHere) {
      if (!DB.users[uid_] || isBlocked(me, uid_)) continue;
      notify(uid_, { title: s.name || 'Workout', body: `${whoLeft} left the workout.`, link: { type: 'session', sessionId: s.id } });
    }
  }
}
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
  // Sep 18 2026: this guard has the same gap DELETE's own guard just got fixed for (see the long
  // comment on DELETE above) — othersWithCredit alone misses a participant who's genuinely still
  // here but hasn't logged or finished anything yet. Without also checking current participants,
  // DELETE would correctly refuse and offer canLeave (someone's still in it), but THIS route would
  // then turn around and 400 that exact same Leave attempt with "nobody else, delete instead" —
  // a dead end, since DELETE just said the opposite. The ownership-handoff fallback a few lines
  // below already treats any other current participant as a legitimate heir regardless of credit,
  // so the guard that decides whether there's anyone to hand off to has to agree with it.
  const otherCurrentParticipants = (s.participants || []).filter(id => id !== me);
  if (!others.length && !otherCurrentParticipants.length && s.creatorId === me)
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
  // A keep-leave credits a finished workout exactly like /lock does (see creditFinish's own
  // comment), so it can just as easily push a crew challenge over its target -- checked the same
  // way here as there. Same for the Activity page's own feed events (ranksBefore captured before
  // creditFinish runs -- see emitFinishFeedEvents' own comment on why).
  if (!discard) {
    const ranksBefore = crewRanksSnapshot(me);
    const credited = creditFinish(s, me, req.body && req.body.localDate);
    checkCrewChallenges(me);
    if (credited) emitFinishFeedEvents(s, me, ranksBefore, req.body && req.body.localDate);
  }

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
    if (s.draftNotes) delete s.draftNotes[me];
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
  // Sep 27 2026 (ownerless redesign, cold-review catch -- same fix /remove-mine and
  // stripUserFromSession already got, missed here): an ownerless group-vote proposal is shared,
  // possibly-already-voted-on state -- the proposer leaving must not retract every OTHER current
  // participant's own independent vote on it. e.votes is only ever set on that kind, never on the
  // old-style single-approver kind, so its presence reliably tells the two apart. Without this, a
  // proposer leaving an ownerless workout after someone else had already voted deleted the whole
  // row out from under that other person's still-live s.variations/s.hiddenFor state, leaving it
  // orphaned with nothing left to render or change it.
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === me && e.status === 'pending' && !e.votes));
  // Sep 27 2026 (cold-review follow-up, Jeff: an "add" should collapse "once everyone's on
  // board"): departing can BE the missing vote -- if the only holdout on a still-pending add
  // leaves rather than voting, whoever's left may now be unanimous. Re-check every pending add
  // against the just-shrunk s.participants so it settles the moment that's true, not only the
  // next time someone happens to vote (see maybeResolveOwnerlessAdd's own comment).
  for (const edit of s.suggestedEdits) maybeResolveOwnerlessAdd(s, edit);
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
  // Sep 27 2026 (ownerless-workout redesign -- see the "Ownerless Workout Flow" reference doc,
  // and the comment on applyOwnedSuggestedEdit above for the full history of how this replaced a
  // Sep 26 handoff-notification attempt that turned out to contradict this already-decided
  // design). The creator leaving no longer hands the workout to anyone -- ownership simply clears.
  // Everyone still in it keeps full use of it (see the ownerless branches of /suggest and
  // /suggest/:id/approve|reject below); a handful of creator-only actions (edit, delete, approve a
  // join request) become permanently locked, since nobody is ever promoted to fill the gap.
  const wasOwner = s.creatorId === me;
  const alreadyOwnerless = s.creatorId === null;
  if (wasOwner) s.creatorId = null;
  let autoApplied = [];
  if (wasOwner) {
    // Doc step 5a: anything still waiting on the now-departed owner's OK auto-applies right now --
    // approve/reject become creator-only forever from here on, and there is no creator, so it
    // would otherwise be stuck waiting for a decision that can never come.
    autoApplied = autoApplyPendingEditsAtPivot(s);
  }
  // Sep 23 2026 (audit finding): leaving used to never let go of a still-required removal-approval
  // vote -- see dropRequiredApprover's own comment above othersWithCredit for why that left a
  // departed person as a permanent, unresolvable required approver on a pending exercise removal.
  const resolvedRemovals = dropRequiredApprover(s, me);
  rebuildAllPrs();
  await save(DB);
  // Sep 23 2026: resolvedRemovals notified s.creatorId specifically -- with ownership never
  // handed off anymore, an ownerless session has no creatorId to notify, so this now only ever
  // fires for a still-owned session (unchanged for that case).
  // Sep 29 2026: pushes for real every time now, matching the identical "Removal approved" event
  // when every required approver actually taps Approve -- s.creatorId is already nulled out above
  // when the departing person IS the owner (wasOwner), so this never self-notifies; the recipient
  // here is always someone other than whoever's leaving.
  notifyDeparturePivots(s, me, { resolvedRemovals, autoApplied, wasOwner, alreadyOwnerless });
  res.json({ ok: true, left: true });
});

// Sep 23 2026 (Jeff, follow-up to the removal-approval fix above): the creator's way to resolve a
// removal request stuck waiting on someone inactive -- kick them, which drops their vote
// requirement from any pending request instead of leaving the creator with only "wait forever" or
// "withdraw the request". Deliberately always keeps the removed person's logged sets, same as
// Leave's "keep my credit" path (Jeff: "they just keep the sets they've logged, I feel that's the
// best scenario") -- but unlike Leave, nothing here synthesizes a finish/history credit on their
// behalf (creditFinish is never called): they didn't choose to end their workout, someone else
// removed them, and CLAUDE.md's own rule against stating something about a user you can't stand
// behind applies just as much to "you finished this" as to anything else. Their sets stay
// attributed to them, still feed their own PRs, they just won't show a completed-workout credit
// for it unless they'd already earned one before this.
app.post('/api/sessions/:id/participants/:pid/remove', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only the creator can remove someone' });
  const target = req.params.pid;
  if (target === req.userId) return res.status(400).json({ error: 'use Leave or Delete for yourself' });
  if (!(s.participants || []).includes(target)) return res.status(400).json({ error: 'not a current participant' });
  s.participants = s.participants.filter(x => x !== target);
  s.invited = (s.invited || []).filter(x => x !== target);
  // Same "only your own stuff, only while pending" cleanup Leave already does for these two --
  // see /leave's own comments for why an approved swap stays but a still-pending one does not, and
  // why a stale approved join request has to go with them.
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === target && e.status === 'pending'));
  s.joinRequests = (s.joinRequests || []).filter(j => j.userId !== target);
  if (s.attendance) delete s.attendance[target];
  // The actual point of this route: drop their vote requirement from anything still waiting on
  // them, and let it resolve if that was the last one needed -- the whole reason "kick" is a real
  // answer to a removal request stuck on someone inactive, not just a way to get rid of them.
  // (Sep 23 2026: this logic is now shared with every OTHER departure route -- see
  // dropRequiredApprover's own comment above othersWithCredit.)
  const resolvedNow = dropRequiredApprover(s, target);
  await save(DB);
  const hostName = DB.users[s.creatorId] ? DB.users[s.creatorId].displayName : 'The organizer';
  // Sep 29 2026 (audit finding): a kicked person with no logged sets on this workout resolves to
  // sessionTier() === 'stranger' the instant they're removed (no participant/creator/logs left to
  // grant any tier), so GET /api/sessions/:id 403s them the moment they tap this -- a guaranteed
  // dead link, same failure mode the crew-removal notification already avoids on purpose (see the
  // "guaranteed dead tap" comment on crew member removal, above). Someone who DID log sets keeps
  // 'alumni' tier and the link still works for them, so only null it when it would actually 403.
  const keepsAccess = sessionTier(s, target) !== 'stranger';
  notify(target, { title: 'Removed from workout', body: `${hostName} removed you from ${s.name}. Your logged sets are still saved.`, link: keepsAccess ? { type: 'session', sessionId: s.id } : null });
  // Sep 29 2026 (audit finding, Tier 4e; cold-review catch on the fix below): /leave and
  // /remove-mine's matching blocks were changed to always push "Removal approved" (see their own
  // comments) because in BOTH of those routes, when the actor IS the creator, s.creatorId is
  // already nulled out (wasOwner -> s.creatorId = null) before this notify runs -- so they never
  // actually self-notify. This route is different: it's creator-only (the 403 a few lines up), so
  // req.userId === s.creatorId on every call, and this notify block fires for the SAME person who
  // just tapped the kick button that resolved it. That's exactly the self-notification case
  // notify()'s own opts.push===false comment describes ("a push would just be telling someone
  // about the button they themselves just tapped") -- kept muted here, unlike its two siblings.
  // Sep 30 2026 (audit finding, Tier 5 dedup): now routes through notifyDeparturePivots (see its
  // own comment) instead of its own inline copy of this exact loop -- autoApplied/wasOwner/
  // alreadyOwnerless don't apply to a kick, so they're passed as no-ops; resolvedPush:false keeps
  // the muted self-notify behavior above, unchanged.
  notifyDeparturePivots(s, target, { resolvedRemovals: resolvedNow, autoApplied: [], wasOwner: false, alreadyOwnerless: false, resolvedPush: false });
  res.json(sessionView(s, req.userId));
});

// Sep 23 2026 (Jeff, same follow-up): the other half -- an owner who wants an exercise gone from
// THEIR OWN workout without asking anyone's permission, because it never touches the shared plan
// at all. Purely personal: s.exercises, everyone else's cards, and the group approval flow above
// are completely untouched -- this just adds the caller to that one exercise's hidden-for list, so
// their own view (myEx in app.js) filters it out of what THEY see, the same "for just me" shape
// swap suggestions already offer non-creators (see /variation).
app.post('/api/sessions/:id/exercises/:exId/hide-for-me', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!(s.participants || []).includes(req.userId) && s.creatorId !== req.userId)
    return res.status(403).json({ error: 'not in this workout' });
  if (!s.exercises.find(e => e.id === req.params.exId)) return res.status(404).json({ error: 'exercise not found' });
  if (!Array.isArray(s.hiddenFor[req.params.exId])) s.hiddenFor[req.params.exId] = [];
  if (!s.hiddenFor[req.params.exId].includes(req.userId)) s.hiddenFor[req.params.exId].push(req.userId);
  await save(DB);
  res.json(sessionView(s, req.userId));
});
app.post('/api/sessions/:id/exercises/:exId/unhide-for-me', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  // Sep 23 2026 (cold-review catch): hide-for-me (just above) checks real membership before
  // letting someone touch s.hiddenFor -- this route was missing the same check. Not actually
  // exploitable (it only ever removes the CALLER's own id from the array, and sessionView still
  // gates the response itself by tier), but a stranger calling this got a 200 instead of the same
  // 403 hide-for-me would give them, which is a real inconsistency for anyone auditing this route.
  if (!(s.participants || []).includes(req.userId) && s.creatorId !== req.userId)
    return res.status(403).json({ error: 'not in this workout' });
  if (Array.isArray(s.hiddenFor[req.params.exId])) s.hiddenFor[req.params.exId] = s.hiddenFor[req.params.exId].filter(x => x !== req.userId);
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// Sep 18 2026 (Jeff, on Home's swipe-to-delete): "For my friends" -- a friend's own joinable
// workout on Home's "Friends' Workouts" list isn't yours to delete or leave, you were never in it.
// Swiping it there can only mean one thing: stop showing ME this. Exactly the same shape as
// POST /api/templates/:id/hide (a friend's shared routine you don't own) -- hides it from THIS
// caller's own view only, never touches the session itself, never visible to the creator or any
// other friend (see hiddenForMe in sessionView above, which is what actually reads this back).
// Deliberately does NOT require the session to currently be "joinable" for this caller -- hiding
// something that's already off your list (you joined it since, or the creator finished it) is
// harmless and should never error; the flag simply sits unused until/unless it becomes joinable
// again (were it ever un-finished), same as templates' hide surviving an unfriend/re-friend.
app.post('/api/sessions/:id/hide-joinable', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  // Cold-review catch (Sep 18): the only thing this route is FOR is dismissing a session from your
  // own joinable list, so the caller has to actually be able to see it as joinable in the first
  // place -- same 'friend' tier sessionTier() already gives the real Friends' Workouts list (v190,
  // public + canSeeProfile). Without this, any authenticated account could name any session id at
  // all, including a private one they can't see, and force a write here -- same class of hole
  // /leave's own comment above warns about ("any account could name any session id and trigger a
  // full ... write"), and the same fix shape: check the relationship, not just that the id exists.
  if (sessionTier(s, req.userId) !== 'friend')
    return res.status(403).json({ error: 'not a joinable workout for you' });
  ensureSessionShape(s);
  s.joinableHiddenBy = s.joinableHiddenBy || [];
  if (!s.joinableHiddenBy.includes(req.userId)) s.joinableHiddenBy.push(req.userId);
  await save(DB);
  res.json({ ok: true });
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
  if (s.draftNotes) delete s.draftNotes[me];
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
  // Sep 27 2026 (ownerless redesign): an old-style, single-approver pending proposal is exclusively
  // mine until someone (the creator) decides it, so erasing every trace of me still withdraws it,
  // same as always. A group-vote (ownerless) proposal is shared, possibly-already-voted-on state --
  // the proposer leaving doesn't retract every OTHER current participant's own independent vote
  // on it, so those are left untouched here (e.votes is only ever set on that kind, never on the
  // old-style kind, so its presence reliably tells the two apart).
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === me && e.status === 'pending' && !e.votes));
  // Sep 27 2026 (cold-review follow-up, same reasoning as /leave's own copy of this): erasing me
  // (including any "no" vote I'd cast) from the workout can be exactly the thing that completes
  // consensus for whoever's left on a still-pending add.
  for (const edit of s.suggestedEdits) maybeResolveOwnerlessAdd(s, edit);
  const wasOwner = s.creatorId === me;
  const alreadyOwnerless = s.creatorId === null;
  if (wasOwner) s.creatorId = null;
  let autoApplied = [];
  if (wasOwner) autoApplied = autoApplyPendingEditsAtPivot(s);
  // Sep 23 2026 (audit finding, same as /leave above): drop any still-required removal-approval
  // vote this route was about to erase every OTHER trace of -- see dropRequiredApprover's own
  // comment above othersWithCredit.
  const resolvedRemovals = dropRequiredApprover(s, me);
  rebuildAllPrs();
  await save(DB);
  // Sep 29 2026: same push-consistency fix as /leave's identical block, same reasoning --
  // s.creatorId is already nulled out above when the departing person IS the owner, so this
  // never self-notifies either.
  notifyDeparturePivots(s, me, { resolvedRemovals, autoApplied, wasOwner, alreadyOwnerless });
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
  // Sep 10 2026: same default as creation (POST /api/sessions, see its own comment) -- clearing
  // the name on an edit and saving should not be able to drop the session out of Home's filters
  // the same way a blank name at creation did.
  if (typeof b.name === 'string') s.name = capStr(b.name, 80).trim() || 'New workout';
  if (b.scheduledAt) s.scheduledAt = normalizedScheduledAt(b.scheduledAt);
  if (typeof b.location === 'string') s.location = capStr(b.location, 120);
  if ('lengthMin' in b) s.lengthMin = numIn(b.lengthMin, 1440) || null;
  if (typeof b.creatorNote === 'string') s.creatorNote = capStr(b.creatorNote, 2000);
  if (b.visibility) s.visibility = b.visibility === 'public' ? 'public' : 'private';
  if (Array.isArray(b.exercises)) {
    // v253 (audit finding, see isPlainExercise above) -- a non-object element would have
    // thrown, both at `e.id` right below and inside withDefaults, returning a generic 500.
    if (!b.exercises.every(isPlainExercise)) return res.status(400).json({ error: 'invalid exercise' });
    // Sep 23 2026 (Jeff, real bug report): dropping an exercise from this list used to detach it
    // (and every OTHER participant's already-logged sets on it) from the shared workout the instant
    // the creator hit Save, on nothing but their own one-tap edit -- the client warns them first
    // (see saveWorkoutEdit's "Saving detaches those sets" confirm), but that's still the creator's
    // call alone, and Jeff explicitly asked for real sign-off instead: "the owner shouldn't just be
    // able to delete workouts others have added sets [to] -- this could be accidentally done."
    // Fixed here, not just in the client, so it holds no matter what UI reaches this route: an
    // exercise anyone OTHER than the creator has logged sets on doesn't actually leave s.exercises
    // just because it's missing from this PUT -- it's kept exactly as-is (still logs normally,
    // still visible to everyone) and a pendingRemovals entry is opened instead, requiring every one
    // of those participants to approve (see the two /removal/:reqId routes below) before it's
    // actually removed. One decline cancels the whole request and the exercise stays; the creator
    // can also withdraw it via /removal/:reqId/cancel if it stalls. Everything else in this same
    // save -- renames, reorders, additions, and any removal nobody else has logged against --
    // applies immediately, exactly as before; only a removal with a real stake for someone else
    // waits.
    // Sep 24 2026 (audit finding, HIGH): a stale Edit-session form (open in one tab/session while a
    // different one approves a removal or a swap) can otherwise resurrect an exercise everyone just
    // unanimously voted to remove, or silently revert an approved swap's rename, purely because the
    // submitted list still reflects whatever the form looked like when it was opened -- reintroducing
    // exactly the "owner can make sets vanish/reappear without real consent" failure the
    // pendingRemovals/suggestedEdits approval flows exist to prevent, just via a different route. An
    // id that's gone from s.exercises because a pendingRemoval on it was already APPROVED is dropped
    // from what's submitted here, instead of being re-minted as a "new" exercise under a fresh id.
    const approvedRemovedIds = new Set((s.pendingRemovals || [])
      .filter(p => p.status === 'approved').map(p => p.exerciseId));
    const submitted = b.exercises.filter(e => !(e && e.id && approvedRemovedIds.has(e.id) && !s.exercises.find(x => x.id === e.id)));
    const newIds = new Set(submitted.filter(e => e && e.id).map(e => e.id));
    const removedIds = s.exercises.map(e => e.id).filter(id => !newIds.has(id));
    // Sep 23 2026 (cold-review catch): a pendingRemovals entry stays 'pending' until someone
    // explicitly approves/declines/cancels it -- but the creator changing their mind (re-editing
    // and saving with the contested exercise back in the list, without ever tapping cancel on the
    // still-open request) used to leave that stale request sitting there anyway. If a required
    // approver later approved it, unaware the creator had already kept the exercise, this route's
    // own exercises rebuild below would put it back in (it's a kept id, in `incoming`) while
    // /removal/:reqId/approve independently filtered it back OUT -- whichever ran last silently
    // won, and the approver's own understanding of what they'd just agreed to was already wrong
    // either way. An id the creator is keeping can never legitimately still have an open request.
    for (const kid of newIds) {
      const stale = s.pendingRemovals.find(p => p.exerciseId === kid && p.status === 'pending');
      if (stale) stale.status = 'cancelled';
    }
    const blocked = [];
    for (const rid of removedIds) {
      const requiredApprovals = Object.keys(s.logs || {})
        .filter(uid_ => uid_ !== req.userId && (s.logs[uid_] || []).some(l => l.exerciseId === rid));
      if (!requiredApprovals.length) continue;
      const exOld = s.exercises.find(e => e.id === rid);
      let pr = s.pendingRemovals.find(p => p.exerciseId === rid && p.status === 'pending');
      if (!pr) {
        // Oct 9 2026 (audit finding, Jeff's pick among options): `at` lets GET /api/notifications
        // sort its "Removal requests" section newest-first -- see joinRequests' own `at` just above.
        pr = { id: 'rm_' + uid(), exerciseId: rid, exerciseName: exOld ? exOld.name : 'Exercise',
               proposedBy: req.userId, requiredApprovals, approvals: [], status: 'pending', at: new Date().toISOString() };
        s.pendingRemovals.push(pr);
        // Sep 24 2026 audit round 4: same missing block check as the crew-lifecycle notify loops
        // fixed above -- sessionView's own suggestedEdits/logs are already block-filtered for a
        // blocked co-participant, but this proposal notification had no equivalent check.
        for (const uid_ of requiredApprovals) if (!isBlocked(req.userId, uid_)) {
          notify(uid_, { title: 'Remove exercise?', body: `${DB.users[req.userId].displayName} wants to remove ${pr.exerciseName} from ${s.name} — you have sets logged on it`, link: { type: 'session', sessionId: s.id } }, { history: false });
        }
      }
      blocked.push(pr);
    }
    const blockedIds = new Set(blocked.map(p => p.exerciseId));
    const stillPending = s.exercises.filter(e => blockedIds.has(e.id));
    const incoming = submitted.map((e, i) => {
      const existing = e && e.id ? s.exercises.find(x => x.id === e.id) : null;
      let row = e;
      // Sep 24 2026 (audit finding, HIGH, part 2): a matching id that still exists but whose
      // submitted name equals the PRE-swap name of an already-APPROVED suggestedEdits swap on it
      // (while the live name already reflects that swap) means this row is stale, not a real rename
      // -- keep the live, swapped name instead of overwriting it. A genuine intentional rename by
      // the creator to anything else still goes through untouched.
      // Cold-review catch: matching only the SINGLE most recent approved swap missed a chained
      // case -- A approved to B, then B later approved to C, and a form stale enough to still say
      // A (predating BOTH swaps) has no single edit with fromName:'A' AND swapTo:'C'. Walk the
      // whole chain of approved renames backward from the live name instead, collecting every
      // historical name that led here, so any hop's pre-swap name is still recognized as stale.
      if (existing) {
        const approvedSwaps = (s.suggestedEdits || []).filter(x => x.type === 'swap' && x.exerciseId === existing.id
          && x.status === 'approved' && x.fromName);
        const historicalNames = new Set();
        let cursor = existing.name;
        for (let hop = 0; hop < approvedSwaps.length; hop++) {
          const hopEdit = approvedSwaps.find(x => x.swapTo === cursor && !historicalNames.has(x.fromName));
          if (!hopEdit) break;
          historicalNames.add(hopEdit.fromName);
          cursor = hopEdit.fromName;
        }
        if (e && historicalNames.has(e.name)) row = Object.assign({}, e, { name: existing.name });
      }
      return Object.assign({
        id: existing ? existing.id : 'e_' + uid(),
        order: i,
      }, withDefaults(row));
    });
    s.exercises = [...incoming, ...stillPending.map((e, i) => Object.assign({}, e, { order: incoming.length + i }))];
  }
  if (Array.isArray(b.inviteUsernames)) {
  const invites = [];
  const myConnections = connectionsOf(req.userId);
  for (const un of b.inviteUsernames) {
    const f = myConnections.find(fid => normUser(DB.users[fid] && DB.users[fid].username) === normUser(un));
    // Sep 24 2026 (audit finding): two gaps here. (1) no dedup at all -- submitting the same
    // person twice (or twice with different casing, since normUser already case-folds the MATCH
    // but the resulting id was still pushed once per input) queued a duplicate "Workout invite"
    // notify below and rendered a duplicate "Invited · waiting to respond" chip on the session.
    // (2) nothing stopped re-adding someone who's ALREADY a joined participant -- s.invited and
    // s.participants are independent arrays, so checking a friend's box who's already in the
    // workout put their own id into BOTH, and Home's own `yours`/`pending` filters treat
    // s.invited as authoritative for "still deciding" -- their own already-active workout (with
    // sets they may have already logged) vanished from "Your sessions" and was replaced by a
    // stale "waiting to respond" invite banner for something they were already part of.
    if (f && !s.participants.includes(f) && !invites.includes(f)) invites.push(f);
  }
  // v251 (audit finding): same gap as /decline just above -- the creator re-editing the invite
  // list can silently drop someone who has a pending swap suggestion in, same as them declining
  // outright. Whoever falls out of the invite list this way loses that pending suggestion too.
  const dropped = (s.invited || []).filter(uid => !invites.includes(uid));
  if (dropped.length) {
    s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(dropped.includes(e.proposedBy) && e.status === 'pending'));
  }
  // Sep 23 2026 (audit finding): "X invited you" (Home's banner and the Notifications page) used to
  // resolve the inviter as whoever CURRENTLY owns the workout, not whoever actually sent the invite
  // -- s.invited was always just a bare list of ids with no memory of who put someone on it. That
  // reads fine right up until ownership hands off (creator leaves -- see /leave), at which point
  // every invite still awaiting an answer silently switched to crediting the NEW owner, someone who
  // may not even know that invite was sent. Preserve the true inviter for anyone who was already on
  // the list (this route rewrites s.invited wholesale on every save, so without this an untouched
  // re-save of the same invite list would otherwise look like a fresh call to Object.fromEntries and
  // reset it); only newly-added names get credited to the person editing this list right now, since
  // they genuinely are the one sending it.
  // Sep 24 2026 (audit finding): a brand-new invitee added here got no notification at all,
  // unlike POST /api/sessions (creation) which explicitly notify()s every invite it sends --
  // someone invited through "Edit workout" only ever found out by chance, reopening the app and
  // happening to see it appear. Computed before s.invited is overwritten just below, so this is
  // genuinely "wasn't on the list before, is now," not "was already invited."
  const newlyInvited = invites.filter(fid => !(s.invited || []).includes(fid));
  for (const fid of invites) if (!s.invitedBy[fid]) s.invitedBy[fid] = req.userId;
  for (const fid of Object.keys(s.invitedBy)) if (!invites.includes(fid)) delete s.invitedBy[fid];
  // Oct 9 2026 (audit finding): invitedAt follows the exact same preserve-existing/stamp-new/
  // clean-up-dropped shape as invitedBy just above, for the exact same reason -- see its own
  // comment in ensureSessionShape.
  for (const fid of invites) if (!s.invitedAt[fid]) s.invitedAt[fid] = new Date().toISOString();
  for (const fid of Object.keys(s.invitedAt)) if (!invites.includes(fid)) delete s.invitedAt[fid];
  s.invited = invites;
  for (const fid of newlyInvited) notify(fid, { title: 'Workout invite', body: `${DB.users[req.userId].displayName} invited you to a workout`, link: { type: 'session', sessionId: s.id } }, { history: false });
  }
  s.updatedAt = new Date().toISOString();
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// Sep 23 2026: the sign-off side of the exercise-removal gate set up in PUT /api/sessions/:id
// above. A required approver saying yes; once every one of them has, the exercise actually leaves
// s.exercises for the first time. Same double-tap/stale-tab guard as suggest/join's own
// approve+reject pairs (v252) -- once a request is no longer 'pending', nothing here touches it
// again.
app.post('/api/sessions/:id/removal/:reqId/approve', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const pr = s.pendingRemovals.find(p => p.id === req.params.reqId);
  if (!pr) return res.status(404).json({ error: 'not found' });
  if (!(pr.requiredApprovals || []).includes(req.userId)) return res.status(403).json({ error: 'not yours to approve' });
  if (pr.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  if (!pr.approvals.includes(req.userId)) pr.approvals.push(req.userId);
  const allIn = pr.requiredApprovals.every(uid_ => pr.approvals.includes(uid_));
  if (allIn) {
    pr.status = 'approved';
    s.exercises = s.exercises.filter(e => e.id !== pr.exerciseId);
    // Sep 24 2026 audit round 4: same missing block check as the removal-request notify above.
    // Sep 27 2026 (ownerless redesign): a pendingRemoval opened before the creator left can still
    // get its last required sign-off after they're gone (this route gates on requiredApprovals,
    // not on being the creator) -- with nobody left to notify as "the creator," skip it rather than
    // notify(null, ...).
    if (s.creatorId && !isBlocked(req.userId, s.creatorId)) notify(s.creatorId, { title: 'Removal approved', body: `Everyone signed off — ${pr.exerciseName} was removed from ${s.name}`, link: { type: 'session', sessionId: s.id } });
  }
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// A single no cancels the whole request outright, not just that one person's slot -- unanimous
// consent is the whole point (Jeff: "the owner shouldn't just be able to delete... this could be
// accidentally done"), so one real objection is enough to keep the exercise exactly where it was.
app.post('/api/sessions/:id/removal/:reqId/decline', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const pr = s.pendingRemovals.find(p => p.id === req.params.reqId);
  if (!pr) return res.status(404).json({ error: 'not found' });
  if (!(pr.requiredApprovals || []).includes(req.userId)) return res.status(403).json({ error: 'not yours to decide' });
  if (pr.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  pr.status = 'declined';
  await save(DB);
  const who = DB.users[req.userId] ? DB.users[req.userId].displayName : 'Someone';
  // Sep 24 2026 audit round 4: same missing block check as the removal-request notify above.
  // Sep 27 2026 (ownerless redesign): same reasoning as the approve route just above -- a still-
  // pending removal from before the creator left can still be declined after they're gone.
  if (s.creatorId && !isBlocked(req.userId, s.creatorId)) notify(s.creatorId, { title: 'Removal declined', body: `${who} said no — ${pr.exerciseName} stays in ${s.name}`, link: { type: 'session', sessionId: s.id } });
  res.json(sessionView(s, req.userId));
});

// The creator's own way out if a request stalls waiting on someone (inactive, missed the
// notification, whatever) -- withdraws it outright rather than leaving it pending forever. The
// exercise was never actually touched while pending, so there's nothing to undo.
app.post('/api/sessions/:id/removal/:reqId/cancel', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const pr = s.pendingRemovals.find(p => p.id === req.params.reqId);
  if (!pr) return res.status(404).json({ error: 'not found' });
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator can cancel' });
  if (pr.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  pr.status = 'cancelled';
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// accept an invite (move from invited[] to participants[])
app.post('/api/sessions/:id/accept', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  // Sep 24 2026 audit round 4 (same gap as the join-request approve fix a round earlier, same
  // fix): the invite itself was sent before any block existed, but nothing re-checked block at
  // THIS moment -- the actual moment membership is granted. Either side could have blocked the
  // other in between, and Accept would still happily make them a full participant (chat, shared
  // log sheet, everything). Refuse rather than silently letting a blocked relationship become
  // co-participants; the invite itself just sits there unaccepted (matching /join's own behavior
  // when canSeeProfile already fails block-aware, before a request can even be filed).
  // Oct 1 2026 (audit finding, round-2 Tier 2, cold-review catch): this checked the bare
  // s.creatorId, same bug as sessionTier's own pre-fix version (see that function's comment) --
  // once a session goes ownerless (s.creatorId === null, permanent) with a still-pending invite,
  // isBlocked(null, req.userId) always evaluates false, so a block against the ORIGINAL inviter
  // (tracked in s.invitedBy) would not stop this route from making them full co-participants.
  // Resolved the same way sessionTier/the notifications list do.
  const inviterId = (s.invitedBy && s.invitedBy[req.userId]) || s.creatorId;
  if (isBlocked(inviterId, req.userId)) return res.status(400).json({ error: 'blocked' });
  s.invited = s.invited.filter(x => x !== req.userId);
  if (!s.participants.includes(req.userId)) s.participants.push(req.userId);
  // Sep 27 2026 (ownerless redesign, doc tab 04): a still-invited person can stash one private
  // pre-join swap via /suggest before deciding (see suggestOwnerless's privatePreJoin branch) --
  // nobody else ever saw it as a proposal, so it never went through group voting. The moment they
  // actually join, it becomes real: exactly their own personal swap on that exercise, the same
  // mechanism a vote itself uses (applyOwnerlessVote's swap branch also refiles their own
  // already-logged sets under the new name, same as any other approved swap would). It is never
  // promoted into a shared/group suggestedEdits entry -- nobody voted on it, nobody gets notified,
  // it was always theirs alone and just waited on them becoming a participant.
  if (s.creatorId === null) {
    const pre = s.suggestedEdits.find(e => e.privatePreJoin && e.proposedBy === req.userId);
    if (pre) {
      applyOwnerlessVote(s, pre, req.userId, 'approved');
      s.suggestedEdits = s.suggestedEdits.filter(e => e !== pre);
    }
    // Cold-review catch: suggestOwnerless's 'add' branch snapshots s.hiddenFor[newEx.id] to every
    // CURRENT participant at proposal time (everyone but the proposer, so it starts hidden for
    // them) -- someone who joins later was never in that snapshot, so "not in the hidden array"
    // silently read as "already voted yes" the moment they became a participant, showing the
    // suggested exercise on their card as if decided when they'd never seen or voted on it. Backfill
    // them into every still-pending add's hidden list, same as if they'd been a participant when it
    // was first proposed.
    for (const edit of s.suggestedEdits) {
      if (edit.type !== 'add' || edit.status !== 'pending' || edit.proposedBy === req.userId) continue;
      s.hiddenFor[edit.exerciseId] = s.hiddenFor[edit.exerciseId] || [];
      if (!s.hiddenFor[edit.exerciseId].includes(req.userId)) s.hiddenFor[edit.exerciseId].push(req.userId);
    }
  }
  await save(DB);
  // An ownerless workout has no creator to tell "someone joined" -- there's no notify(null, ...)
  // call to make (that would silently write a orphaned userId:null history row nobody ever reads).
  if (s.creatorId) notify(s.creatorId, { title: 'Invite accepted', body: `${DB.users[req.userId].displayName} joined your workout`, link: { type: 'session', sessionId: s.id } });
  res.json(sessionView(s, req.userId));
});

// decline an invite (remove from invited[], do not join)
app.post('/api/sessions/:id/decline', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!Array.isArray(s.invited) || !s.invited.includes(req.userId)) return res.status(403).json({ error: 'not invited' });
  // Oct 2 2026 (deep audit finding): s.invited is never purged on block, so a stale invite
  // survives a block either direction -- unlike /accept just above (which re-checks at the moment
  // of grant and refuses outright), Decline should still always succeed for the decliner (getting
  // out of a stale invite shouldn't itself be blockable), but the notify two lines below must not
  // carry the decliner's free-text reason to someone they're blocked with either direction. Same
  // inviterId resolution /accept uses, so this is block-aware for an ownerless session's original
  // inviter too, not just a live s.creatorId.
  const inviterId = (s.invitedBy && s.invitedBy[req.userId]) || s.creatorId;
  const declinerBlocked = isBlocked(inviterId, req.userId);
  s.invited = s.invited.filter(x => x !== req.userId);
  // Sep 24 2026 (audit finding): this left the decliner's s.invitedBy entry behind. PUT
  // /api/sessions/:id's invite-rewrite only ever SETS invitedBy for an id that doesn't already
  // have one ("if (!s.invitedBy[fid])") -- so if this person is re-invited later by a DIFFERENT
  // owner (e.g. after a leave/ownership handoff), the stale entry from whoever invited them the
  // first time around would keep winning, crediting an invite to someone who may not even be in
  // the session anymore. Declining ends that invite's whole lifecycle; its attribution should end
  // with it, same as the other per-invite state cleared just below (suggestedEdits, joinRequests).
  if (isObj(s.invitedBy)) delete s.invitedBy[req.userId];
  // Oct 9 2026 (cold-review catch): invitedAt (added this same batch, see ensureSessionShape's
  // own comment) is a parallel map to invitedBy and has to be cleared the same way, for the same
  // reason -- PUT /api/sessions/:id's invite-rewrite only ever SETS invitedAt for an id that
  // doesn't already have one, same as invitedBy just above. Without this, declining and later
  // being re-invited to this SAME session kept crediting the re-invite with the ORIGINAL, now-
  // stale invite timestamp forever, silently sorting it as older than it really is in GET
  // /api/notifications' invites section (fix #9, same bug shape invitedBy's own Sep 24 2026 fix
  // was written to prevent, just not carried over to its new sibling field).
  if (isObj(s.invitedAt)) delete s.invitedAt[req.userId];
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
  // Sep 27 2026 (Jeff): "along with this - we should add a 'reason for declining message' and the
  // owner will get this message." Optional, capped well short of anything that'd blow up a
  // notification body (this is a quick reason, not a chat message -- the reinvite-request flow
  // below is where an actual back-and-forth belongs).
  const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  await save(DB);
  // Same reasoning as /accept just above: an ownerless workout has no creator to tell. Also skip
  // entirely when blocked either direction (see declinerBlocked above) -- same privacy rule as
  // every other notify() in this file, so a blocked relationship never receives this message or
  // the decliner's free-text reason.
  if (s.creatorId && !declinerBlocked) notify(s.creatorId, { title: 'Invite declined', body: `${DB.users[req.userId].displayName} declined your workout${reason ? `: "${reason}"` : ''}`, link: { type: 'session', sessionId: s.id } });
  // Sep 27 2026 (Jeff, part 1): the decliner themselves used to get no notification of their own
  // decline at all -- nothing for "changed your mind" to hook into later. This is the tap target:
  // link:{type:'reinvite-ask'} opens a small compose sheet (client-side) rather than the session
  // itself, since a private-session decliner has just dropped to sessionTier 'stranger' and can't
  // GET the session at all anymore (see sessionTier's own comment). history:true (not the
  // {history:false} most invite-lifecycle notifies use) since this is meant to sit and wait for
  // "later thought he could go", not just flash by.
  notify(req.userId, { title: 'You declined', body: `You declined ${s.name || 'the workout'}. Changed your mind?`, link: { type: 'reinvite-ask', sessionId: s.id } }, { push: false });
  res.json(sessionView(s, req.userId));
});

// Sep 27 2026 (Jeff, part 1 continued): the other half of "message the chat for a re-invitation" --
// a decliner (now sessionTier 'stranger' or 'friend', neither of which has chat access -- see
// sessionView's own tier-gating comment) sends a short note that reaches the creator as a real
// notification, without re-granting any session access just to deliver one message. Deliberately
// NOT gated behind any tier check beyond auth: the whole point is this works for someone who has
// zero standing access to the session anymore.
app.post('/api/sessions/:id/reinvite-request', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!s.creatorId) return res.status(400).json({ error: 'no host to ask' });
  if (s.creatorId === req.userId) return res.status(400).json({ error: 'cannot re-invite yourself' });
  if ((s.invited || []).includes(req.userId) || (s.participants || []).includes(req.userId)) {
    return res.status(400).json({ error: 'already part of this workout' });
  }
  if (isBlocked(req.userId, s.creatorId)) return res.status(403).json({ error: 'not found' });
  const message = typeof (req.body && req.body.message) === 'string' ? req.body.message.trim().slice(0, 300) : '';
  // Oct 2 2026 (deep audit finding): every other "ask again" flow in this app (join requests
  // re-flipping an existing row to pending instead of duplicating, ownerless swap re-proposals,
  // template-share) reuses one row per requester instead of piling up duplicates -- this route was
  // the one place that pattern wasn't applied, so repeat taps (person thinks it didn't go through,
  // or just asks again days later) spammed the creator with a separate notification + Notifications
  // row per tap. Reuse the same pending row (refreshing message/timestamp) instead of pushing a new
  // one, and skip the duplicate notify -- the creator already has a live request to act on.
  const existing = s.reinviteRequests.find(r => r.userId === req.userId);
  if (existing) {
    existing.message = message;
    existing.at = new Date().toISOString();
    await save(DB);
    return res.json({ ok: true });
  }
  const rr = { id: 'rr_' + uid(), userId: req.userId, message, at: new Date().toISOString() };
  s.reinviteRequests.push(rr);
  await save(DB);
  notify(s.creatorId, { title: 'Wants back in', body: `${DB.users[req.userId].displayName} would like to be re-invited to ${s.name || 'your workout'}${message ? `: "${message}"` : ''}`, link: { type: 'session', sessionId: s.id } }, { history: false });
  res.json({ ok: true });
});

// The creator's one-tap side (Jeff's picked option): re-adds the requester exactly the way a fresh
// invite already works (s.invited/s.invitedBy + the same 'Workout invite' notify PUT /api/sessions/:id
// sends for a newly-added name), then clears the request. Creator-only, and still gated on being a
// real connection -- same eligibility check every other invite path already enforces -- so this can't
// be used to invite someone who was never connected in the first place.
app.post('/api/sessions/:id/reinvite-request/:reqId/approve', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'not your workout' });
  const rr = (s.reinviteRequests || []).find(r => r.id === req.params.reqId);
  if (!rr) return res.status(404).json({ error: 'not found' });
  s.reinviteRequests = s.reinviteRequests.filter(r => r.id !== rr.id);
  const stillConnected = connectionsOf(req.userId).includes(rr.userId);
  if (!stillConnected) { await save(DB); return res.status(400).json({ error: 'no longer connected' }); }
  if (!s.invited.includes(rr.userId) && !s.participants.includes(rr.userId)) {
    s.invited.push(rr.userId);
    s.invitedBy[rr.userId] = req.userId;
    s.invitedAt[rr.userId] = new Date().toISOString(); // Oct 9 2026 (audit finding) -- see invitedAt's own comment in ensureSessionShape
    notify(rr.userId, { title: 'Workout invite', body: `${DB.users[req.userId].displayName} invited you back to a workout`, link: { type: 'session', sessionId: s.id } }, { history: false });
  }
  await save(DB);
  res.json(sessionView(s, req.userId));
});

// Dismiss without re-inviting -- e.g. the creator has moved on and the workout is long over.
app.post('/api/sessions/:id/reinvite-request/:reqId/dismiss', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'not your workout' });
  s.reinviteRequests = (s.reinviteRequests || []).filter(r => r.id !== req.params.reqId);
  await save(DB);
  res.json({ ok: true });
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
  // Oct 1 2026 (audit finding, round-2 Tier 2, cold-review follow-up catch): "invited" above was a
  // bare s.invited.includes() check with zero block-awareness -- unlike sessionTier()'s own
  // 'invited' tier and the /accept route (both fixed earlier this same round), which both require
  // !isBlocked(inviterId, viewerId) before granting anything on a pending invite. That left this
  // route reachable directly even after a block: a blocked still-invited caller could still create
  // a real suggestedEdits row here, visible to non-blocked co-participants and approvable by the
  // creator -- a genuine interaction with someone they'd blocked, the exact thing the block
  // contract forbids, even though GET /api/sessions/:id had already stopped showing them the plan
  // at all. Resolved the same way: inviterId through s.invitedBy, falling back to s.creatorId,
  // same ownerless-session-safe resolution as the other two fixes.
  const inviterId = (s.invitedBy && s.invitedBy[req.userId]) || s.creatorId;
  if (!isParticipant && !approvedJoin && (!invited || isBlocked(inviterId, req.userId))) return res.status(403).json({ error: 'not a participant' });
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
  // Sep 27 2026 (ownerless-workout redesign): once there's no creator, a proposal stops being a
  // single yes/no for the whole group ("the actual redesign" -- doc tab 05). Someone still just
  // invited gets one, narrower carve-out instead (doc tab 04's "still invited" wrinkle): their ONE
  // pre-join swap stays entirely private, applied only to their own card the moment they actually
  // join -- nobody else in an ownerless workout is left to ask, and unlike the owned case, there's
  // no creator for it to go to in the meantime either.
  if (s.creatorId === null) return suggestOwnerless(req, res, s, type, isParticipant, approvedJoin, invited);
  let edit;
  if (type === 'add') {
    const name = currentExerciseName(capStr((req.body || {}).name, 80).trim());   // stale client -- see EXERCISE_RENAMES
    if (!name) return res.status(400).json({ error: 'needs a name' });
    // Oct 9 2026 (audit finding, Jeff's pick among options): `at` lets GET /api/notifications sort
    // its "Suggested changes" section newest-first -- see joinRequests' own `at` above.
    edit = { id: 'se_' + uid(), type: 'add', exerciseId: null, proposedBy: req.userId, swapTo: name, status: 'pending', at: new Date().toISOString() };
  } else {
    const exerciseId = capStr((req.body || {}).exerciseId, 64);
    const swapTo = currentExerciseName(capStr((req.body || {}).swapTo, 80).trim());   // stale client -- see EXERCISE_RENAMES
    // Sep 6 (cold-review catch): approving now renames the shared exercise to swapTo, so a blank
    // one -- which used to yield a harmless empty variation -- would blank the exercise for everyone.
    if (!swapTo) return res.status(400).json({ error: 'needs a name' });
    const fromEx = s.exercises.find(e => e.id === exerciseId);
    if (!fromEx) return res.status(404).json({ error: 'exercise not found' });
    // Sep 24 2026 (audit finding): no dedup at all -- two participants proposing different swaps
    // on the same exerciseId in close succession both landed as separate pending rows, and if the
    // creator approved both (each independently valid against its own status), the exercise got
    // renamed twice while only the SECOND approval's proposer had their own logged sets renamed to
    // match (approve only touches edit.proposedBy's own variation/logs) -- the first proposer's
    // sets stayed filed under a name the card no longer showed. One pending swap per exercise at a
    // time, same as the client's own (view-scoped, so racy) "hide the propose-a-swap button once
    // one's pending" affordance -- just actually enforced here. (Ownerless mode has no such race --
    // there's no shared rename to collide over, see suggestOwnerless -- so this stays scoped to the
    // owned path, which is the only one reachable past the branch above.)
    if (s.suggestedEdits.some(e => e.type === 'swap' && e.exerciseId === exerciseId && e.status === 'pending'))
      return res.status(409).json({ error: 'a swap is already pending for this exercise' });
    // Sep 24 2026 (audit finding): remembering the pre-swap name lets a later stale Edit-session
    // save recognize "this submitted name is exactly what this exercise used to be called before
    // an approved swap" and keep the live, swapped name instead of silently reverting it -- see
    // the guard in PUT /api/sessions/:id.
    edit = { id: 'se_' + uid(), type: 'swap', exerciseId, proposedBy: req.userId, swapTo, fromName: fromEx.name, status: 'pending', at: new Date().toISOString() };
  }
  s.suggestedEdits.push(edit);
  await save(DB);
  // Sep 6 (Jeff: "everyone in the workout gets a notification that a swap has been requested"):
  // a swap proposal is a change to the shared plan now (see approve below), so everyone it would
  // affect hears about it -- the host as the one who decides, everyone else as an FYI naming who
  // decides. An "add" stays host-only, as before.
  const who = DB.users[req.userId].displayName;
  const hostName = DB.users[s.creatorId] ? DB.users[s.creatorId].displayName : 'the host';
  // Sep 24 2026 audit round 4: neither notify below checked block -- sessionView's own
  // suggestedEdits are already block-filtered for a blocked co-participant, but proposing one
  // had no equivalent check on who gets told about it.
  // Oct 9 2026 (audit finding): both notifies below were missing { history: false }, the same flag
  // invites/followRequests/joinRequests/removals/reinviteAsks above it all pass for exactly this
  // reason (see GET /api/notifications' own comments) -- a still-pending suggestion is already
  // reconstructed live as an actionable "Suggested changes" card every time that endpoint is
  // called, so writing it to durable history too meant the SAME pending decision showed up twice:
  // once actionable, once as a separate read-only history row with different wording that never
  // goes away even after the actionable one is resolved.
  if (type === 'add') {
    if (!isBlocked(req.userId, s.creatorId)) notify(s.creatorId, { title: 'Exercise suggested', body: `${who} suggested adding ${edit.swapTo}`, link: { type: 'session', sessionId: s.id } }, { history: false });
  } else {
    const fromEx = s.exercises.find(e => e.id === edit.exerciseId);
    const fromName = fromEx ? fromEx.name : 'an exercise';
    const everyone = new Set([s.creatorId, ...s.participants]);
    for (const uid_ of everyone) {
      if (uid_ === req.userId || !DB.users[uid_] || isBlocked(req.userId, uid_)) continue;
      notify(uid_, uid_ === s.creatorId
        ? { title: 'Swap requested', body: `${who} wants to swap ${fromName} → ${edit.swapTo} for everyone. Your call.`, link: { type: 'session', sessionId: s.id } }
        : { title: 'Swap requested', body: `${who} wants to swap ${fromName} → ${edit.swapTo} for everyone — ${hostName} decides.`, link: { type: 'session', sessionId: s.id } },
        uid_ === s.creatorId ? { history: false } : undefined);
    }
  }
  res.json(sessionView(s, req.userId));
});

// Sep 27 2026 (ownerless-workout redesign): the ownerless half of POST /suggest, split out for
// its own clarity rather than tangled into the owned branch above via a dozen inline conditionals.
// Two completely different shapes, per the doc:
//   - still just invited (doc tab 04's wrinkle): a private, single pre-join swap, invisible to
//     everyone else, applied only to the proposer's own card once they actually accept (see
//     POST /:id/accept below).
//   - already in it: a group proposal (doc tab 05) -- the proposer's own "yes" applies instantly
//     (applyOwnerlessVote below), every other CURRENT participant gets their own independent,
//     never-expiring approve/reject via the *same* /suggest/:id/approve|reject routes used for the
//     owned case (those routes branch on s.creatorId === null the same way this one does).
async function suggestOwnerless(req, res, s, type, isParticipant, approvedJoin, invited) {
  if (!isParticipant && !approvedJoin) {
    // Still invited, ownerless: the private pre-join carve-out. Type is always 'swap' here --
    // 'add' already refused a still-invited caller above, before this function is ever reached.
    const exerciseId = capStr((req.body || {}).exerciseId, 64);
    const swapTo = currentExerciseName(capStr((req.body || {}).swapTo, 80).trim());
    if (!swapTo) return res.status(400).json({ error: 'needs a name' });
    const fromEx = s.exercises.find(e => e.id === exerciseId);
    if (!fromEx) return res.status(404).json({ error: 'exercise not found' });
    // Same "reuse one row" instinct as /join's own dedupe -- proposing again before joining just
    // replaces your own earlier private pick rather than piling up rows nobody but you will ever
    // see.
    let edit = s.suggestedEdits.find(e => e.privatePreJoin && e.proposedBy === req.userId);
    if (edit) { edit.exerciseId = exerciseId; edit.swapTo = swapTo; edit.fromName = fromEx.name; }
    else {
      edit = { id: 'se_' + uid(), type: 'swap', exerciseId, proposedBy: req.userId, swapTo, fromName: fromEx.name, status: 'pending', privatePreJoin: true };
      s.suggestedEdits.push(edit);
    }
    await save(DB);
    // Nobody else is asked or told -- doc tab 04: "Brian and Carla never see it, never vote on it,
    // and are never notified."
    return res.json(sessionView(s, req.userId));
  }
  const proposerId = req.userId;
  let edit;
  if (type === 'add') {
    const name = currentExerciseName(capStr((req.body || {}).name, 80).trim());
    if (!name) return res.status(400).json({ error: 'needs a name' });
    // Doc tab 05: "Adding an exercise ... now applies to the proposer's own card first" -- the
    // exercise is real and shared immediately, exactly like an owned add always was, just hidden
    // by default from everyone but the proposer (the existing hide-for-me mechanism, s.hiddenFor)
    // until each other current participant casts their own vote.
    const newEx = Object.assign({ id: 'e_' + uid(), order: s.exercises.length }, withDefaults({ name }));
    s.exercises.push(newEx);
    edit = { id: 'se_' + uid(), type: 'add', exerciseId: newEx.id, proposedBy: proposerId, swapTo: name, status: 'pending', votes: {} };
    s.hiddenFor[newEx.id] = s.participants.filter(id => id !== proposerId);
  } else {
    const exerciseId = capStr((req.body || {}).exerciseId, 64);
    const swapTo = currentExerciseName(capStr((req.body || {}).swapTo, 80).trim());
    if (!swapTo) return res.status(400).json({ error: 'needs a name' });
    const fromEx = s.exercises.find(e => e.id === exerciseId);
    if (!fromEx) return res.status(404).json({ error: 'exercise not found' });
    // Cold-review catch (finding #4, Jeff: "yes fix it"): re-proposing a DIFFERENT swap on the same
    // exercise you already have a pending proposal on used to just pile up a second independent row
    // -- your own stale earlier proposal (plus anyone who'd already voted on IT) kept sitting there
    // alongside the new one, reading as two options nobody actually meant to offer, since this is
    // one person changing their own mind, not proposing a genuine second alternative. Two DIFFERENT
    // people each proposing their own swap on the same exercise is unaffected and still stays two
    // rows -- that's a real choice for the group to have (per-proposer, not per-exercise, unlike the
    // owned path's single "one swap pending per exercise" 409 above, which is a real conflict there
    // because an owned approval renames the shared exercise for everyone).
    edit = s.suggestedEdits.find(e => e.type === 'swap' && e.exerciseId === exerciseId && e.proposedBy === proposerId && e.status === 'pending');
    if (edit) {
      // Same "reuse one row" instinct as the privatePreJoin branch above. It's now a materially
      // different proposal, so every vote already cast on the OLD swapTo is stale: clear each
      // voter's OWN row (so the UI doesn't keep showing a "you said yes" that no longer means
      // anything) and, for anyone whose approve had set their personal variation to that old value,
      // undo it too -- same "only clear if it's still the exact thing this edit set" guard
      // applyOwnerlessVote's own reject branch already uses, so an unrelated personal swap someone
      // made some other way is never touched.
      const oldSwapTo = edit.swapTo;
      for (const voterId of Object.keys(edit.votes || {})) {
        const v = s.variations[exerciseId] && s.variations[exerciseId][voterId];
        if (v && v.swapTo === oldSwapTo) delete s.variations[exerciseId][voterId];
      }
      edit.swapTo = swapTo;
      edit.fromName = fromEx.name;
      edit.votes = {};
    } else {
      edit = { id: 'se_' + uid(), type: 'swap', exerciseId, proposedBy: proposerId, swapTo, fromName: fromEx.name, status: 'pending', votes: {} };
      s.suggestedEdits.push(edit);
    }
  }
  if (type === 'add') s.suggestedEdits.push(edit);
  applyOwnerlessVote(s, edit, proposerId, 'approved');   // "proposing counts as his own yes"
  await save(DB);
  // Doc tab 07: "Every other current participant -- not the proposer, not anyone still just
  // invited" -- s.participants is exactly that population once proposerId is excluded.
  const who = DB.users[proposerId].displayName;
  const label = type === 'add' ? `suggested adding ${edit.swapTo}` : `wants to swap ${edit.fromName || 'an exercise'} → ${edit.swapTo}`;
  for (const uid_ of s.participants) {
    if (uid_ === proposerId || !DB.users[uid_] || isBlocked(proposerId, uid_)) continue;
    notify(uid_, { title: type === 'add' ? 'New exercise to review' : 'Swap to review', body: `${who} ${label}. Your call — approve or reject anytime.`, link: { type: 'session', sessionId: s.id } });
  }
  res.json(sessionView(s, proposerId));
}

// Sep 6 (Jeff, on the swap flow: "if there is more than 2 people in the workout they can do 'swap
// for just me'"). A personal swap: instant, no approval, touches nobody else's plan. Stored as
// the same s.variations[exerciseId][userId] shape everything downstream already reads
// (exerciseNameFor, /lock, rebuildAllPrs), with reason:'self' so it can be told apart from an
// approved proposal in the data. swapTo '' clears it (undo). Same set-renaming rule as approve:
// sets already logged on this card are yours and were the lift you actually did, so they follow
// the swap (and follow it back on undo). Participants only -- someone still holding an invite
// can't log yet, so "for me" has nothing to attach to; they propose instead.
app.post('/api/sessions/:id/variation', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const me = req.userId;
  const isParticipant = s.participants.includes(me);
  const approvedJoin = s.joinRequests.find(j => j.userId === me && j.status === 'approved');
  if (!isParticipant && !approvedJoin) return res.status(403).json({ error: 'not a participant' });
  const exerciseId = capStr((req.body || {}).exerciseId, 64);
  const e = s.exercises.find(x => x.id === exerciseId);
  if (!e) return res.status(404).json({ error: 'exercise not found' });
  const swapTo = currentExerciseName(capStr((req.body || {}).swapTo, 80).trim());
  s.variations[exerciseId] = s.variations[exerciseId] || {};
  const target = swapTo && swapTo !== e.name ? swapTo : null;
  if (target) s.variations[exerciseId][me] = { swapTo: target, reason: 'self' };
  else delete s.variations[exerciseId][me];
  const fileUnder = target || e.name;
  let renamed = 0;
  for (const l of ((s.logs && s.logs[me]) || [])) {
    if (l.exerciseId !== exerciseId || l.exerciseName === fileUnder) continue;
    l.exerciseName = fileUnder; renamed++;
  }
  if (renamed) rebuildAllPrs();
  await save(DB);
  res.json(sessionView(s, me));
});

// Sep 27 2026 (ownerless redesign, doc tab 04 "Can Change? Yes, anytime"): with no creator to make
// a single yes/no call, every "yes" is really that participant's own personal swap (or, for an
// add, un-hiding it from their own card) -- applyOwnerlessVote already does exactly that, the same
// mechanism /variation and s.hiddenFor already use elsewhere. A swap never touches edit.status (it
// stays 'pending' forever -- there is no global decision to reach, only each participant's own
// standing vote), and it never locks: the same participant calling this again later just moves
// their own vote, which is the whole point of "anytime." An add is the one exception, added same
// day (Jeff, cold-review follow-up): once applyOwnerlessVote's own maybeResolveOwnerlessAdd sees
// every current participant has voted yes, THAT settles and locks (see the guard just below) --
// same "once it's no longer pending, nobody touches it again" principle the owned-mode approve/
// reject routes already enforce. A privatePreJoin edit isn't a group vote at all (it's one still-
// invited person's own stashed swap, applied for real once they accept -- see POST /accept) so
// it's explicitly out of scope here, not silently voted on.
async function voteOwnerless(req, res, s, edit, decision) {
  if (edit.privatePreJoin) return res.status(400).json({ error: 'not a group suggestion' });
  if (!s.participants.includes(req.userId)) return res.status(403).json({ error: 'not a participant' });
  // Oct 1 2026 (audit finding, round-2 Tier 2 follow-up, cold-review catch, Jeff: "yes fix it
  // all"): same gap as the owned-session approve/reject fix just above this function -- voting on
  // someone's suggestion is a real interaction with their authored content (their proposed
  // swapTo), and sessionView's own suggestedEdits filter already hides a blocked proposer's
  // pending row from this voter's own GET response regardless of whether the proposer is still a
  // current participant (see that filter's comment) -- but the vote itself had no isBlocked check
  // at all, so a stale/cached editId could still cast a real vote (applyOwnerlessVote sets the
  // voter's own s.variations entry to the blocked proposer's swapTo) and, for an 'add' edit, still
  // count toward (or permanently block, via reject) the unanimous-consensus requirement
  // maybeResolveOwnerlessAdd checks against every current participant. Membership itself stays
  // untouched either way -- this only refuses the one vote action, same scope as the owned-path
  // fix.
  if (isBlocked(req.userId, edit.proposedBy)) return res.status(400).json({ error: 'blocked' });
  if (edit.type === 'add' && edit.status !== 'pending') return res.status(400).json({ error: 'already settled' });
  const prev = (edit.votes || {})[req.userId];
  if (prev === decision) return res.json(sessionView(s, req.userId)); // already their vote -- no-op, nobody re-notified
  applyOwnerlessVote(s, edit, req.userId, decision);
  await save(DB);
  // Only the proposer is told, and only when someone ELSE'S vote actually changed -- their own
  // vote changing is something they just did themselves, not news.
  if (req.userId !== edit.proposedBy && DB.users[edit.proposedBy] && !isBlocked(req.userId, edit.proposedBy)) {
    const who = DB.users[req.userId].displayName;
    const label = edit.type === 'add' ? `adding ${edit.swapTo}` : `your swap: ${edit.fromName || 'the exercise'} → ${edit.swapTo}`;
    notify(edit.proposedBy, {
      title: decision === 'approved' ? 'Suggestion approved' : 'Suggestion declined',
      body: decision === 'approved' ? `${who} approved ${label}.` : `${who} declined ${label}. It's still up to everyone else.`,
      link: { type: 'session', sessionId: s.id },
    });
  }
  res.json(sessionView(s, req.userId));
}

app.post('/api/sessions/:id/suggest/:editId/approve', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId === null) return voteOwnerless(req, res, s, edit, 'approved');
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  // Oct 1 2026 (audit finding, round-2 Tier 2 follow-up, cold-review catch): this had no isBlocked
  // check at all, even though sessionView's own suggestedEdits filter already hides a blocked
  // proposer's pending row from the creator's own GET response (see that filter's own comment) --
  // so a creator who'd blocked the proposer couldn't SEE this suggestion on screen anymore, but a
  // direct POST with the still-live editId (a stale cached id, a second tab, or just a replay)
  // could still approve it: renaming the shared exercise for everyone AND rewriting the blocked
  // proposer's own already-logged sets below, a real, unilateral mutation of a blocked person's
  // data. Matches sessionView's filter exactly (isBlocked(creator, proposedBy), not conditioned on
  // whether the proposer happens to still be a current participant) -- approving/rejecting someone
  // you've blocked is an action refused here the same way canSeePostAuthor re-checks block even
  // for existing participants' posts; it is not a membership question, so blockUser's own "doesn't
  // touch an already-joined member" scope boundary (see that function's comment) doesn't apply --
  // the proposer stays a full member either way, only this one approve/reject action is refused.
  if (isBlocked(req.userId, edit.proposedBy)) return res.status(400).json({ error: 'blocked' });
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
    // Sep 24 2026 audit round 4: same missing block check as the propose-side notifies above.
    if (!isBlocked(req.userId, edit.proposedBy)) notify(edit.proposedBy, { title: 'Exercise added', body: `${DB.users[s.creatorId].displayName} added ${edit.swapTo} to the workout`, link: { type: 'session', sessionId: s.id } });
    return res.json(sessionView(s, req.userId));
  }
  // Sep 6 (Jeff: "if brian suggests a swap and I approve it - that swaps the exercise for us both,
  // correct?"). It does now. This used to record the swap only as the PROPOSER's own variation,
  // while the client showed "X · swapped by Brian" to everyone -- so the host logged sets on a
  // card that said Cable Row and had them filed as Barbell Row. An approved swap is a change to
  // the shared plan: the exercise itself is renamed, for everyone, from here on. The proposer's
  // now-redundant personal variation on it (if any) is dropped so their card doesn't read "(your
  // swap)" on top of the shared change; anyone ELSE's personal swap on this card is theirs and
  // stays. "For just me" lives at POST /variation above and never comes through here.
  const ex = s.exercises.find(x => x.id === edit.exerciseId);
  const fromName = ex ? ex.name : null;
  if (!edit.swapTo || !edit.swapTo.trim()) return res.status(400).json({ error: 'needs a name' });   // a pre-Sep-6 blank proposal
  if (ex) ex.name = edit.swapTo;
  // Sep 24 2026 (audit finding, minor): a pendingRemovals row snapshots exerciseName ONCE, when
  // the removal request first opens (see PUT /api/sessions/:id) -- if this same exerciseId gets
  // renamed by an approved swap while that removal is still sitting open, every required
  // approver's "Remove X?" prompt kept showing the OLD name after everyone could already see the
  // new one on the card itself. Cosmetic only (approve/decline is keyed by id, not name) but
  // confusing enough to just keep in sync.
  for (const pr of (s.pendingRemovals || [])) {
    if (pr.status === 'pending' && pr.exerciseId === edit.exerciseId) pr.exerciseName = edit.swapTo;
  }
  if (s.variations[edit.exerciseId]) {
    delete s.variations[edit.exerciseId][edit.proposedBy];
    // ...and anyone else's personal swap that now just restates the shared name (cold-review nit:
    // it would read "(your swap · undo)" on a card whose base is already that lift).
    for (const uid_ of Object.keys(s.variations[edit.exerciseId])) {
      if (s.variations[edit.exerciseId][uid_] && s.variations[edit.exerciseId][uid_].swapTo === edit.swapTo) delete s.variations[edit.exerciseId][uid_];
    }
  }
  // Sets carry the exercise name frozen at log time, which is what stops an unrelated edit
  // rewriting history. Approving a swap is not unrelated for the PROPOSER — it is a deliberate
  // statement of what they actually performed — so their already-logged sets on this card follow
  // it (logging first and approving afterwards used to leave them filed under the lift not done).
  // Everyone else's already-logged sets keep their frozen name: the host who did three sets of
  // Barbell Row before approving really did Barbell Row. Only sets from here on file under the
  // new name (exerciseNameFor reads the renamed exercise).
  const already = (s.logs && s.logs[edit.proposedBy]) || [];
  let renamed = 0;
  for (const l of already) {
    if (l.exerciseId !== edit.exerciseId) continue;
    if (l.exerciseName === edit.swapTo) continue;
    l.exerciseName = edit.swapTo; renamed++;
  }
  if (renamed) rebuildAllPrs();            // the records are grouped by that name
  await save(DB);
  const hostName = DB.users[s.creatorId].displayName;
  const proposerName = DB.users[edit.proposedBy] ? DB.users[edit.proposedBy].displayName : 'Someone';
  // edit.proposedBy is added explicitly: /suggest lets someone still holding an invite propose
  // ("I'll come if we swap Barbell Row"), and they aren't in s.participants yet (cold-review catch).
  // Sep 24 2026 audit round 4: same missing block check as the propose-side notifies above.
  for (const uid_ of new Set([...s.participants, edit.proposedBy])) {
    if (uid_ === s.creatorId || !DB.users[uid_] || isBlocked(req.userId, uid_)) continue;
    notify(uid_, uid_ === edit.proposedBy
      ? { title: 'Swap approved', body: `${hostName} approved your swap: ${fromName || 'the exercise'} → ${edit.swapTo}, for everyone`, link: { type: 'session', sessionId: s.id } }
      : { title: 'Workout changed', body: `${hostName} approved ${proposerName}'s swap: ${fromName || 'the exercise'} → ${edit.swapTo}`, link: { type: 'session', sessionId: s.id } });
  }
  res.json(sessionView(s, req.userId));
});

app.post('/api/sessions/:id/suggest/:editId/reject', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (s.creatorId === null) return voteOwnerless(req, res, s, edit, 'rejected');
  if (s.creatorId !== req.userId) return res.status(403).json({ error: 'only creator approves' });
  // Oct 1 2026 (audit finding, round-2 Tier 2 follow-up): same fix, same reasoning as approve
  // above -- see its comment. Reject's own mutation is narrower (just a status flip, no shared
  // rename or logged-set rewrite) but it is still an action against a blocked person's data and
  // kept symmetric with approve rather than quietly allowed through.
  if (isBlocked(req.userId, edit.proposedBy)) return res.status(400).json({ error: 'blocked' });
  // v252: same guard as approve above -- a stale reject after it's already been approved (or
  // already rejected) must not silently flip a decided edit back and forth.
  if (edit.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  edit.status = 'rejected';
  await save(DB);
  // Sep 24 2026 audit round 4: same missing block check as the propose/approve-side notifies
  // above.
  // Sep 29 2026 (audit finding, Tier 4e): this used to skip the notify entirely for edit.type
  // ==='add' -- a rejected ADD suggestion told its proposer nothing at all, while a rejected SWAP
  // always did, even though the approve path notifies for both (see 'Exercise added' vs 'Swap
  // approved' just above). "Your suggestion was rejected" should reach you exactly as reliably as
  // "your suggestion was approved" does, regardless of which kind it was.
  if (!isBlocked(req.userId, edit.proposedBy)) {
    if (edit.type === 'add') {
      notify(edit.proposedBy, { title: 'Exercise not added', body: `${DB.users[s.creatorId].displayName} didn't add ${edit.swapTo} to the workout.`, link: { type: 'session', sessionId: s.id } });
    } else {
      const ex = s.exercises.find(x => x.id === edit.exerciseId);
      notify(edit.proposedBy, { title: 'Swap not approved', body: `${DB.users[s.creatorId].displayName} kept ${ex ? ex.name : 'the exercise'}. You can still swap it for just you.`, link: { type: 'session', sessionId: s.id } });
    }
  }
  res.json(sessionView(s, req.userId));
});

// Oct 2 2026 (#183, deep audit finding, Jeff: "Add a Cancel button for the proposer" (Recommended)):
// the only way to withdraw your OWN still-pending suggestion used to be leaving the workout
// outright (stripUserFromSession's inline suggestedEdits filter, reused by /leave and
// /remove-mine) -- changing your mind about a swap or an add while you're still very much in the
// workout had no path at all; the creator's own approve/reject were the only routes that could
// ever resolve it. Scoped narrowly and deliberately: only the ORIGINAL proposer can cancel (never
// the creator -- approve/reject above are still their only tools), and only while it's still
// genuinely undecided and nobody else has acted on it yet -- an owned edit whose status is no
// longer 'pending', or an ownerless edit someone ELSE has already cast their own vote on, or an
// ownerless 'add' that's already reached unanimous consensus, are all past the point where
// withdrawing it would silently retract a decision someone else already made. That's exactly the
// failure mode the ownerless redesign's own leave/remove-mine comment already flags and refuses
// to do ("the proposer leaving must not retract every OTHER current participant's own independent
// vote") -- this reuses that same boundary for a voluntary cancel, not just a departure.
app.post('/api/sessions/:id/suggest/:editId/cancel', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const edit = s.suggestedEdits.find(e => e.id === req.params.editId);
  if (!edit) return res.status(404).json({ error: 'edit not found' });
  if (edit.proposedBy !== req.userId) return res.status(403).json({ error: 'only the person who proposed this can cancel it' });
  // A still-invited person's own private pre-join stash (suggestOwnerless's privatePreJoin
  // branch) -- never shown to anyone else, never voted on, so there's nothing it could be
  // retracting out from under anyone. Just drop it.
  if (edit.privatePreJoin) {
    s.suggestedEdits = s.suggestedEdits.filter(e => e !== edit);
    await save(DB);
    return res.json(sessionView(s, req.userId));
  }
  if (s.creatorId === null) {
    // Ownerless group proposal: proposing one casts the proposer's own automatic "yes"
    // (applyOwnerlessVote(...,'approved') in suggestOwnerless) -- safe to fully withdraw only
    // while that's still the ONLY vote on it. Once another current participant has cast their
    // own real vote, it's their independent decision now, not just the proposer's pitch.
    const othersVoted = Object.keys(edit.votes || {}).some(id => id !== req.userId);
    if (othersVoted) return res.status(400).json({ error: "someone else has already weighed in — it's too late to cancel" });
    if (edit.type === 'add') {
      // maybeResolveOwnerlessAdd only ever settles an 'add' once EVERY current participant has
      // voted yes -- which the othersVoted check just above already ruled out whenever
      // s.participants.length > 1, so this is really only reachable (status something other than
      // 'pending') in the one-person-workout edge case. Guarded anyway rather than assumed.
      if (edit.status !== 'pending') return res.status(400).json({ error: 'already settled' });
      // Doc tab 05: an ownerless 'add' creates the real, shared exercise immediately (just hidden
      // from everyone but the proposer by default) -- so cancelling has a real exercise to remove,
      // unlike the owned path's 'add', which never creates one until approved. If ANYONE has
      // already logged real sets against it, this is no longer "nothing happened yet" -- refuse
      // rather than silently discarding logged data; the normal removal flow (which routes through
      // every current credit-holder's approval) is what that actually needs.
      // Cold-review catch (same day): this used to check only req.userId's (the proposer's) own
      // logs -- but hiddenFor/unhide-for-me is a completely separate, vote-independent mechanism
      // (any current participant can call it on any exercise id, including this still-pending
      // one, same as sessionView already exposes its id via suggestedEdits) and /log never checks
      // hiddenFor at all, so another participant can unhide this exercise and log real sets on it
      // without ever casting a vote -- othersVoted above would never catch that. Checking every
      // current participant's logs, not just the proposer's, is what actually makes "nobody has
      // real data on this yet" true.
      const hasLogs = Object.keys(s.logs || {}).some(uid_ => (s.logs[uid_] || []).some(l => l.exerciseId === edit.exerciseId));
      if (hasLogs) return res.status(400).json({ error: "someone has already logged sets on this — use the normal remove flow instead" });
      s.exercises = s.exercises.filter(e => e.id !== edit.exerciseId);
      if (s.hiddenFor) delete s.hiddenFor[edit.exerciseId];
    } else {
      // Undoes the proposer's own auto-yes variation, same "only clear if it's still the exact
      // thing THIS edit set" guard applyOwnerlessVote's reject branch already applies -- it's a
      // no-op if the proposer already changed their own card some other way since proposing.
      applyOwnerlessVote(s, edit, req.userId, 'rejected');
    }
    s.suggestedEdits = s.suggestedEdits.filter(e => e !== edit);
    await save(DB);
    // Nobody but the proposer has ever seen or acted on this (othersVoted just ruled that out),
    // so there's no one to tell -- same "nobody is told" shape as the privatePreJoin branch above.
    return res.json(sessionView(s, req.userId));
  }
  // Owned session: a single, straightforward pending proposal the creator hasn't decided on yet.
  if (edit.status !== 'pending') return res.status(400).json({ error: 'already decided' });
  s.suggestedEdits = s.suggestedEdits.filter(e => e !== edit);
  await save(DB);
  // Mirrors the propose-side notify in POST /suggest above -- everyone who was told "X wants to
  // swap/add..." gets told it's off the table again, instead of being left to wonder why a
  // suggestion they saw never resolved. Same isBlocked guard as every other notify on this route.
  const who = DB.users[req.userId].displayName;
  if (edit.type === 'add') {
    if (!isBlocked(req.userId, s.creatorId)) notify(s.creatorId, { title: 'Suggestion withdrawn', body: `${who} withdrew their suggestion to add ${edit.swapTo}`, link: { type: 'session', sessionId: s.id } });
  } else {
    const fromEx = s.exercises.find(e => e.id === edit.exerciseId);
    const fromName = fromEx ? fromEx.name : 'an exercise';
    for (const uid_ of new Set([s.creatorId, ...s.participants])) {
      if (uid_ === req.userId || !DB.users[uid_] || isBlocked(req.userId, uid_)) continue;
      notify(uid_, { title: 'Suggestion withdrawn', body: `${who} withdrew their swap: ${fromName} → ${edit.swapTo}`, link: { type: 'session', sessionId: s.id } });
    }
  }
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
  // Sep 27 2026 (ownerless redesign, doc tab 06 "Locked Forever"): a public ownerless workout
  // can't be asked to join at all, first time or not -- there's no creator left to ask, and
  // nothing in this codebase ever promotes anyone to fill that gap. Explicit and up front, rather
  // than relying on canSeeProfile(null, ...) incidentally returning false below.
  if (s.creatorId === null) return res.status(400).json({ error: 'this workout has no host to ask' });
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
  // Oct 9 2026 (audit finding, Jeff's pick among options): stamps/refreshes `at` so GET
  // /api/notifications can sort its "Join requests" section newest-first -- same reasoning as
  // reinviteRequests' own `at`, which this reuse-the-row shape was already modeled on.
  if (jr) { jr.status = 'pending'; jr.note = note; jr.at = new Date().toISOString(); }
  else { jr = { id: 'jr_' + uid(), userId: req.userId, note, status: 'pending', at: new Date().toISOString() }; s.joinRequests.push(jr); }
  await save(DB);
  // history:false -- already shown live as an actionable "Join requests" row in GET
  // /api/notifications while it's pending; the approved/declined outcome (below) notifies too.
  notify(s.creatorId, { title: 'Join request', body: `${DB.users[req.userId].displayName} wants to join your workout`, link: { type: 'session', sessionId: s.id } }, { history: false });
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
  // Sep 24 2026 (audit finding): /join itself gates on canSeeProfile (which is block-aware), but
  // approval never re-checked block at the moment of decision -- if either side blocked the other
  // AFTER the request was filed but before the creator answered it, Approve still happily made
  // them a full member (chat, shared log sheet, everything). Re-check right here, since this is
  // the actual moment membership is granted.
  if (isBlocked(jr.userId, req.userId)) return res.status(400).json({ error: 'blocked' });
  jr.status = 'approved';
  if (!s.participants.includes(jr.userId)) s.participants.push(jr.userId);
  // Sep 23 2026 (Jeff, real bug report): someone directly invited AND approved through a separate
  // join request (see the respondHere fix in app.js for how they end up on this path despite
  // already having a real invite on file) became a genuine participant here but stayed in
  // s.invited forever -- /accept is the only other route that ever clears it, and nothing routes
  // an approved-join-request user through /accept. Home kept showing them a stale "invite" for a
  // workout they were already in, on top of (correctly) showing it under Your Sessions. Mirrors
  // /accept's own invited-array cleanup so "became a participant" always implies "no longer
  // invited," regardless of which door they came in through.
  if (Array.isArray(s.invited) && s.invited.includes(jr.userId)) s.invited = s.invited.filter(x => x !== jr.userId);
  await save(DB);
  notify(jr.userId, { title: 'Join approved', body: `${DB.users[s.creatorId].displayName} approved your join request`, link: { type: 'session', sessionId: s.id } });
  // Sep 8 2026 (Jeff: a "test workout" where Brian requested to join and Jeff approved him left
  // NOTHING in Jeff's own notification history for "Brian joined" -- only the invite-and-accept
  // path (above) notifies the creator; this request-and-approve path only ever told the
  // REQUESTER their request went through. The creator, having just tapped Approve themselves,
  // doesn't need a PUSH about their own action (same reasoning as POST /api/sessions dropping its
  // own self-push) -- push:false -- but "who's actually in my workout" is exactly what the
  // in-app history is for, so it still gets a durable record.
  notify(s.creatorId, { title: 'New participant', body: `${DB.users[jr.userId].displayName} joined your workout`, link: { type: 'session', sessionId: s.id } }, { push: false });
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
  // Oct 2 2026 (deep audit finding): /approve right above re-checks isBlocked at the moment of
  // decision since a block can form between request-filed and decision -- reject never had the
  // same re-check before notifying. Reject grants nothing, so this doesn't need to refuse the
  // action itself, just skip telling a now-blocked requester who declined them.
  if (!isBlocked(jr.userId, req.userId)) {
    notify(jr.userId, { title: 'Join declined', body: `${DB.users[s.creatorId].displayName} declined your join request`, link: { type: 'session', sessionId: s.id } });
  }
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

// Oct 9 2026 (audit finding, Jeff's pick among options): one-way, idempotent -- there is no path
// back to false (same shape as every other "seen it once" flag in this app, e.g.
// notificationsSeenAt). Called by app.js the moment the RIR explainer sheet is actually shown
// (not merely eligible to show), so a request that races with another tab/device never races the
// EXPLAINER itself, only this bookkeeping call -- worst case it shows once more than strictly
// necessary, never zero times.
app.post('/api/me/rir-explainer-seen', auth, async (req, res) => {
  DB.users[req.userId].seenRirExplainer = true;
  await save(DB);
  res.json({ seenRirExplainer: true });
});

// Sep 15 2026 -- see TRAINING_PHASE_RANGES/repRange()'s own comment for the full picture. Nothing
// writes this field except an explicit save from the training-focus picker screen -- a user who
// has never touched it stays undefined forever, so repRange() keeps behaving exactly as it always
// has for them (Jeff: "nobody's rep targets silently change the day this ships").
//
// Sep 16 2026 -- Jeff: "I think we should be able to deselect all of them and it just goes back
// to the default way it was prior." `phase: null` is the deliberate clear signal (tapping the
// already-active card again, client-side -- see setTrainingPhase() in app.js), distinct from a
// garbage/misspelled key, which is still rejected below exactly as before.
app.post('/api/me/training-phase', auth, async (req, res) => {
  const phase = (req.body || {}).phase;
  if (phase === null) {
    DB.users[req.userId].trainingPhase = null;
    await save(DB);
    return res.json({ trainingPhase: null });
  }
  if (!TRAINING_PHASE_KEYS.has(phase)) return res.status(400).json({ error: 'phase must be one of: ' + [...TRAINING_PHASE_KEYS].join(', ') });
  DB.users[req.userId].trainingPhase = phase;
  await save(DB);
  res.json({ trainingPhase: phase });
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
  if (s.draftNotes) delete s.draftNotes[userId];
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
  // Sep 27 2026 (ownerless redesign): don't erase a shared group-vote proposal (e.votes set) just
  // because its proposer got reset -- see the identical guard and reasoning on /remove-mine.
  s.suggestedEdits = (s.suggestedEdits || []).filter(e => !(e.proposedBy === userId && e.status === 'pending' && !e.votes));
  // Sep 27 2026 (cold-review follow-up, same reasoning as /leave's and /remove-mine's own copy of
  // this): reset-workouts erasing userId (including any "no" vote they'd cast) can be exactly the
  // thing that completes consensus on a still-pending add for whoever's left.
  for (const edit of s.suggestedEdits) maybeResolveOwnerlessAdd(s, edit);
  // Sep 23 2026 (audit finding, same as /leave and /remove-mine): reset-workouts is the third
  // route that erases someone's participation without ever letting go of a still-required
  // removal-approval vote they held -- see dropRequiredApprover's own comment above
  // othersWithCredit. No notification here (this helper runs inside a loop over every touched
  // session and reset-workouts doesn't notify per-session for anything else it does either, e.g.
  // the ownership handoff just above its own call site) -- the vote cleanup itself is the fix.
  dropRequiredApprover(s, userId);
}

// Scoped to req.userId ONLY — never a body param, so this can never be pointed at anyone else,
// spoofed userId in the body or not. Account identity (username, login, friends) is untouched;
// that was Jeff's own explicit choice when asked what "start over" should mean — only what he
// actually LOGGED disappears. Requires the caller's real current password (see the route below,
// Sep 29 2026 audit finding, Tier 1 #2 -- it used to just be a bare confirm:true, which is proof
// you tapped a button, not proof you're really the account holder) so a bare/misfired POST, or a
// stolen session, can never silently wipe someone's training history.
//
// For every session this user has any real footprint in (current participant, creator, or a
// history-only alumni row): if they're the creator and nobody else has real credit
// (othersWithCredit — same rule DELETE and /leave already use), the whole session is theirs alone
// and gets hard-deleted. If they're the creator and someone else DOES have credit, ownership hands
// off to a current credit-holder (same deterministic rule /leave uses — never Jeff, never a coin
// flip), creatorId going explicitly null if nobody current remains, and their own trace is
// stripped from the now-handed-off session. If they're not the creator, the session and its actual
// owner are left completely alone — only their own trace is stripped out of it.
// Sep 29 2026 (account deletion): extracted verbatim out of POST /api/me/reset-workouts below —
// deleting an account needs to erase exactly this same per-session footprint (every creator
// hand-off/hard-delete rule, every ownerless-vote/pending-edit edge case this loop already
// accounts for), and reimplementing any of that a second time for delete-account would be exactly
// the kind of drift blockUser's own comment warns about ("share exactly one implementation rather
// than two copies... drifting apart"). Pure function: no req/res, callers own save(DB) + notifying
// from the returned pivots/autoApprovals (see reset-workouts below for the reference shape).
function wipeUserFromAllSessions(me) {
  let sessionsDeleted = 0, sessionsHandedOff = 0, sessionsCleared = 0;
  // Sep 27 2026 (ownerless redesign): collected here instead of notifying inline, so every
  // notify() call happens after the caller's own await save(DB) -- a crash partway through this
  // loop can never leave someone notified about a pivot that didn't actually get persisted.
  const pivots = [];       // { sessionId, sessionName, stillHere: [ids] } -- "host left" broadcast
  const autoApprovals = [];  // { proposedBy, swapTo, sessionId } -- from auto-applying pending edits
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
      || (s.logs && s.logs[me])
      || (s.draftNotes && s.draftNotes[me]);
    if (!isTouched) continue;
    if (isCreator) {
      const others = othersWithCredit(s, me);
      // Sep 18 2026: same gap DELETE /api/sessions/:id and POST /:id/leave were just fixed for
      // (see their own comments) — othersWithCredit alone misses a participant who's genuinely
      // still in this workout but hasn't logged or finished anything yet. Without also checking
      // current participants, "reset my workouts" would hard-delete a session out from under a
      // friend who'd merely accepted the invite, the exact silent data loss the other two routes
      // now refuse to do.
      const othersStillHere = (s.participants || []).filter(id => id !== me);
      if (!others.length && !othersStillHere.length) {
        delete DB.sessions[s.id];
        sessionsDeleted++;
        continue;
      }
      // Sep 27 2026 (ownerless redesign): ownership no longer hands off to othersWhoLogged -- it
      // just clears, same as /leave and /remove-mine. Anything still waiting on this now-departed
      // owner's OK auto-applies right now (doc step 5a), same helper those two routes use.
      //
      // Cold-review catch (finding #3): this used to call autoApplyPendingEditsAtPivot(s) BEFORE
      // stripUserFromSession(s, me), the opposite order from /leave and /remove-mine (both of which
      // withdraw the departing creator's own still-pending, non-voted self-proposal -- see
      // stripUserFromSession's own suggestedEdits filter, identical to the one duplicated inline in
      // those two routes -- before ever calling autoApplyPendingEditsAtPivot). With the old order
      // here, a creator who reset their workouts while their OWN pending suggestion was still
      // outstanding got it auto-approved (nobody left to reject it -- vacuously "no one voted no"),
      // while the identical scenario via a single Leave or Remove-mine discarded it instead. Calling
      // stripUserFromSession first withdraws that self-proposal before autoApply ever sees it, so all
      // three routes now treat a departing creator's own pending self-proposal the same way.
      stripUserFromSession(s, me);
      const autoApplied = autoApplyPendingEditsAtPivot(s);
      s.creatorId = null;
      sessionsHandedOff++;   // field name kept for API-shape compatibility; it now counts pivots, not handoffs
      pivots.push({ sessionId: s.id, sessionName: s.name || 'Workout', stillHere: othersStillHere, wasOwner: true });
      for (const edit of autoApplied) autoApprovals.push({ sessionId: s.id, proposedBy: edit.proposedBy, swapTo: edit.swapTo });
    } else {
      const alreadyOwnerless = s.creatorId === null;
      const othersStillHere = (s.participants || []).filter(id => id !== me);
      stripUserFromSession(s, me);
      sessionsCleared++;
      if (alreadyOwnerless) pivots.push({ sessionId: s.id, sessionName: s.name || 'Workout', stillHere: othersStillHere, wasOwner: false });
    }
  }
  rebuildAllPrs();     // every record was built from logs that may no longer be theirs
  return { sessionsDeleted, sessionsHandedOff, sessionsCleared, pivots, autoApprovals };
}
// Notifies every pivot/auto-approval wipeUserFromAllSessions collected, in the one shared shape
// both reset-workouts and delete-account send it in. Split out so the two callers' own res.json()
// (different shapes -- reset-workouts echoes counts back for its own UI, delete-account doesn't)
// don't have to duplicate this notify loop too.
function notifyWipePivots(me, pivots, autoApprovals) {
  const whoLeft = (DB.users[me] && DB.users[me].displayName) || 'Someone';
  for (const a of autoApprovals) {
    if (!isBlocked(me, a.proposedBy)) {
      notify(a.proposedBy, { title: 'Suggestion approved', body: `${a.swapTo} was approved automatically — the host left before deciding`, link: { type: 'session', sessionId: a.sessionId } });
    }
  }
  // Doc tab 07, same two broadcasts as /leave and /remove-mine -- one notification per affected
  // workout, never bundled (each is a different workout with its own name and link).
  for (const p of pivots) {
    const body = p.wasOwner
      ? 'Workout host left — this workout has no host now, but everyone can still add or swap exercises.'
      : `${whoLeft} left the workout.`;
    for (const uid_ of p.stillHere) {
      if (!DB.users[uid_] || isBlocked(me, uid_)) continue;
      notify(uid_, { title: p.sessionName, body, link: { type: 'session', sessionId: p.sessionId } });
    }
  }
}
// Sep 29 2026 (audit finding, Tier 1 #2): this used to accept a bare `confirm:true` -- proof you
// tapped a button, not proof you're really the account holder -- while /api/me/delete-account
// (just below) requires the actual current password for the exact same severity of action
// (erases every workout/log/PR, no undo). Now matches that bar exactly: current password
// required, same verifyPin check, same error shape/status, and the SAME 'pw-confirm:' failure
// counter that route and /api/me/password share -- see /api/me/password's own comment on why
// this is one shared per-account budget across all three password-confirmation routes, not a
// separate 10/hour per route.
app.post('/api/me/reset-workouts', auth, async (req, res) => {
  const me = req.userId;
  const u = DB.users[me];
  if (failCount('pw-confirm:' + me) >= 10)
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { password } = req.body || {};
  if (!password || !verifyPin(u, password)) {
    bumpFail('pw-confirm:' + me, 60 * 60 * 1000);
    return res.status(400).json({ error: 'Password is incorrect' });
  }
  clearFail('pw-confirm:' + me);
  const { sessionsDeleted, sessionsHandedOff, sessionsCleared, pivots, autoApprovals } = wipeUserFromAllSessions(me);
  await save(DB);
  notifyWipePivots(me, pivots, autoApprovals);
  res.json({ ok: true, sessionsDeleted, sessionsHandedOff, sessionsCleared });
});
// Sep 29 2026 (Jeff: "add... account deletion"; app-store readiness -- Apple guideline 5.1.1(v)
// requires letting a user delete their own account from within an app that lets them create one).
// Requires the CURRENT password re-entered, same proof-of-identity bar as /api/me/password above
// -- an irreversible action needs at least that, not just "you're already logged in right now."
//
// This anonymizes the account IN PLACE rather than actually removing the DB.users[id] row.
// Considered a real hard delete first: `nameOf` (crew/challenge display helper, above) is the only
// place in this whole file that already tolerates a vanished user id (falls back to "(deleted
// account)") -- everywhere else that reads DB.users[someId] (profileOf, canSeeProfile, avatarHtml,
// publicUser, ...) assumes the row exists and was never audited against one disappearing out from
// under a still-live session/comment/report/notification that references it. That's exactly the
// class of "conditional failure invisible until the one missing case actually happens in
// production" this file's own boot-migration rule (CLAUDE.md #7) exists to avoid, and account
// deletion is not a place to find out the hard way. Anonymizing gets the same practical outcome
// Apple's guideline is actually after -- the account is gone, cannot be logged into again, and no
// longer identifies this person -- without that referential-integrity risk. u.deleted + the /login
// check above are what actually enforce "gone"; the scrambled credentials are defense in depth.
//
// Flagged, not silently decided: deleting frees this account's OLD username for anyone else to
// register (findUserByName can no longer match it once u.username below is overwritten) -- nothing
// reserves it against reuse/impersonation. That's a real product call, not an engineering one; easy
// to add a reserved-usernames list later if it turns out to matter.
app.post('/api/me/delete-account', auth, async (req, res) => {
  const me = req.userId;
  const u = DB.users[me];
  if (!u) return res.status(404).json({ error: 'not found' });
  // Sep 29 2026 (audit finding, Tier 1 #1): same reasoning as POST /api/me/password's own comment
  // -- a valid-but-stolen token could otherwise guess this account's real password against this
  // route forever, nothing here ever capped it. Same failCount/bumpFail/clearFail pattern (only
  // wrong guesses count, cleared on a correct one), and the SAME shared 'pw-confirm:' counter as
  // /api/me/password and /api/me/reset-workouts -- one 10/hour budget across all three, not 10
  // per route (see /api/me/password's own comment on why).
  if (failCount('pw-confirm:' + me) >= 10)
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { password } = req.body || {};
  // 400, not 401 -- same reasoning as POST /api/me/password just above: this request already has
  // a valid session token, a wrong confirmation password here must not trip app.js's global
  // "any 401 means your session died" handler and force a surprise logout.
  if (!password || !verifyPin(u, password)) {
    bumpFail('pw-confirm:' + me, 60 * 60 * 1000);
    return res.status(400).json({ error: 'Password is incorrect' });
  }
  clearFail('pw-confirm:' + me);

  const { pivots, autoApprovals } = wipeUserFromAllSessions(me);
  // Persist + notify about the session wipe FIRST, same order reset-workouts uses (save, then
  // notify only what's actually saved -- see notifyWipePivots' own comment on why) and, just as
  // important here, BEFORE any of the follow-severance/anonymization below runs. Cold-review catch
  // (Sep 29 2026): notifyWipePivots reads DB.users[me].displayName (the "X left the workout" body)
  // and calls isBlocked(me, ...) to decide who to skip -- both need REAL data. Anonymizing first
  // would have every one of those notifications read "Deleted user left the workout" instead of
  // the actual name, and would silently defeat every "don't notify someone you're blocked with"
  // check (isBlocked reads the very following/followers/blocked arrays the step below empties, so
  // it would return false for everyone -- not "no one is blocked", just "the data being asked is
  // already gone"). Doing this phase first, and the anonymization as its own second phase with its
  // own save, keeps both halves correct without changing wipeUserFromAllSessions/notifyWipePivots
  // themselves (still exactly what reset-workouts calls, unmodified).
  await save(DB);
  notifyWipePivots(me, pivots, autoApprovals);

  // Sever the follow graph in every direction, app-wide -- blockUser (above) only ever does this
  // for ONE other account at a time (the two people on either side of a single block); deletion
  // needs the same following/followers/followReqs/blocked cleanup applied against every account
  // that has a reference to `me` anywhere in those four lists.
  for (const other of Object.values(DB.users)) {
    if (other.id === me) continue;
    if (Array.isArray(other.following)) other.following = other.following.filter(x => x !== me);
    if (Array.isArray(other.followers)) other.followers = other.followers.filter(x => x !== me);
    if (Array.isArray(other.followReqs)) other.followReqs = other.followReqs.filter(x => x !== me);
    if (Array.isArray(other.blocked)) other.blocked = other.blocked.filter(x => x !== me);
  }
  delete DB.pushSubs[me];   // stop push delivery dead rather than let it 404/410 itself out later

  // Oct 2 2026 (deep audit finding): wipeUserFromAllSessions above cleans up every pending-action
  // type that lives on DB.sessions (invites, join requests, removals, suggestions, reinvite-asks),
  // but DB.templates (routines) was never wired into any cleanup pass -- the Oct 2 routine-sharing
  // redesign introduced t.sharedTo (a real pending-action list, same shape as the others) without
  // adding the equivalent teardown. Left alone: a deleted owner's own routines sit in DB.templates
  // forever, unreachable by anyone, and their id keeps dangling in t.sharedTo on anyone else's
  // routine THEY shared with (or were shared a routine by) this account -- the recipient's pending-
  // shares list keeps showing it attributed to "Deleted user" indefinitely, and can still actually
  // accept-share it to get a working copy, long after the account is gone. Mirrors the follow-graph
  // severance loop just above: strip `me` from every other routine's sharedTo, then remove every
  // routine `me` owned outright (a routine has no collaborative-editing concept -- see /accept's own
  // comment -- so there is no "hand off ownership" equivalent to build here, unlike sessions/crews).
  for (const t of Object.values(DB.templates || {})) {
    if (Array.isArray(t.sharedTo) && t.sharedTo.includes(me)) t.sharedTo = t.sharedTo.filter(x => x !== me);
    if (isObj(t.sharedAt)) delete t.sharedAt[me];
  }
  for (const tid of Object.keys(DB.templates || {})) {
    if (DB.templates[tid].ownerId === me) delete DB.templates[tid];
  }

  // Oct 2 2026 (#178, deep audit finding): a crew the deleted account OWNED was never touched by
  // this route at all. Unlike a routine (no collaborative-editing concept -- see the comment on
  // the templates cleanup just above, "remove every routine me owned outright"), a crew is a real
  // shared group its other members are still actively using, so deleting it out from under them
  // the way a routine is deleted here would be the wrong call for anyone with co-members. The
  // crew's own existing design already anticipated an owner going away -- "The owner can't
  // 'leave' -- ... the owner deletes the crew instead of leaving it orphaned" (see POST
  // /api/crews/:id/leave's comment) -- but that escape hatch assumes the owner is still around to
  // make the call. Account deletion is permanent and bypasses /leave entirely, so without this,
  // c.ownerId keeps pointing at an id that can never log in and match `c.ownerId === req.userId`
  // again: PUT/DELETE /api/crews/:id and POST .../challenge (every owner-gated action) silently
  // 403 for literally everyone, forever -- an unrenamable, unmanageable, undeletable zombie crew.
  // Mirrors sessions' own ownerless redesign (s.creatorId -> null, "ownership now simply clears
  // and NEVER comes back" -- see wipeUserFromAllSessions' comment): c.ownerId -> null is the same
  // permanent, one-way signal, and ensureCrewShape (above) already tolerates it. Deliberately NOT
  // building crews an equivalent of sessions' full ownerless voting system (new owner-gated
  // actions like rename/add-member/start-challenge simply stay unavailable to everyone once a
  // crew is ownerless, rather than opening them up to every member) -- that's a real product
  // decision with no signal from Jeff either way, flagged rather than silently built out, same
  // spirit as the username-reuse note on u.deleted above.
  //
  // A solo crew (the deleted owner was the only member -- memberIds is kept in sync with
  // CREW_MAX_MEMBERS checks everywhere else, so this is the one place that can safely assume it's
  // accurate) has no one left to leave it ownerless FOR, so it's deleted outright instead, same
  // as the ownerless-but-empty edge case sessions already collapse to a hard delete for.
  for (const cid of Object.keys(DB.crews || {})) {
    const c = DB.crews[cid];
    if (c.ownerId !== me) continue;
    ensureCrewShape(c);
    const others = c.memberIds.filter(id => id !== me);
    if (!others.length) { delete DB.crews[cid]; continue; }
    c.ownerId = null;
    for (const mid of others) {
      if (!DB.users[mid] || isBlocked(me, mid)) continue;
      notify(mid, { title: c.name, body: 'The crew owner\'s account was deleted — this crew has no owner now.', link: { type: 'crew', crewId: c.id } });
    }
  }

  // Cold-review catch (Sep 29 2026): u.avatar='' below only clears the REFERENCE -- same gap
  // POST /api/me/avatar's own comment already documents for a re-upload landing under a different
  // extension. Left unlinked, avatar_<id>.<ext> keeps sitting in UPLOAD_DIR and keeps being served
  // by the unauthenticated `/uploads` static mount at its same old, already-known URL forever --
  // directly contradicting this route's own point ("no longer identifies this person"). Same
  // best-effort unlink POST /api/me/avatar already uses for exactly this reason.
  if (u.avatar) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(u.avatar))); } catch (e) {}
  }

  const tag = 'deleted_' + me;   // uid() is already exactly 8 lowercase alnum chars -- see its own comment
  u.username = tag;
  u.displayName = 'Deleted user';
  u.bio = '';
  u.avatar = '';
  u.defaultGym = '';
  u.profileVisibility = 'private';
  Object.assign(u, hashPin(crypto.randomBytes(32).toString('hex')));   // unusable, unguessable -- see /login's own check, this is belt-and-suspenders
  u.following = []; u.followers = []; u.followReqs = [];
  ensureBlockArray(u); u.blocked = [];
  u.deleted = true;
  u.deletedAt = new Date().toISOString();
  // Sep 29 2026 (audit finding, Tier 1 #3): this screen's own confirmation copy already promises
  // "You'll be signed out everywhere" -- that wasn't actually true until this line existed.
  // u.deleted + the pinHash scramble above stop a NEW login, but userIdFromToken never checked
  // u.deleted, so a token issued before deletion kept authenticating as this (now-anonymized)
  // account for up to TOKEN_TTL_DAYS (90) after. tokensValidFrom is the mechanism
  // userIdFromToken's own comment already describes for exactly this; it was just never assigned
  // anywhere. Setting it here makes every outstanding token -- including this device's own,
  // which is fine, since the client calls logout() right after this response either way -- fail
  // immediately on its next use.
  u.tokensValidFrom = u.deletedAt;

  await save(DB);   // second save: the follow-severance + anonymization phase above, its own step
  res.json({ ok: true });
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
      // The heaviest set of the session decides it; ties broken by reps -- EXCEPT for an assisted
      // exercise (loadType==='assisted', see rebuildAllPrs' comment), where the number runs
      // backwards: the LEAST assist is the hardest, most representative set of the session, so
      // that direction flips too. This is what recommendationsFor() below judges "topped out"
      // and "ready to progress" against, so getting the wrong set here would pick the wrong
      // weight to compare and suggest from, even once that function's own +/-step is fixed.
      const assisted = loadTypeForName(name) === 'assisted';
      const top = sets.reduce((a, b) => {
        const wa = toLb(a.weight, a.unit), wb = toLb(b.weight, b.unit);
        const better = assisted ? (wb < wa || (wb === wa && (b.reps||0) > (a.reps||0)))
                                 : (wb > wa || (wb === wa && (b.reps||0) > (a.reps||0)));
        return better ? b : a;
      });
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
    // Sep 11 2026: computed once here (not just inside the `ready` branch below) so `holds` and
    // `soon` carry it too — the log sheet's "one more like that" / "match that today" copy for an
    // assisted exercise needs to say the assist goes DOWN next time, not up, even before there's
    // an actual `ready` suggestion to show.
    const lessIsMore = loadTypeForName(name) === 'assisted';
    const bodyweight = !(Number(latest.top.weight) > 0);
    // Oct 9 2026 (audit finding): this whole section is a WEIGHT-progression suggestion -- its own
    // "How it works" copy literally says "the weight goes up" -- but a bodyweight TIMED_HOLD
    // exercise (Plank, Wall Sit, Dead Hang, ...) has no weight to add in the first place. Before
    // this check, Plank showed "Hit 10 reps at bodyweight ... +5 lb" here while the exact same PR
    // correctly showed "45 reps" with no weight unit at all on the Records tab -- the identical
    // underlying data presented two contradictory ways on two tabs of the same screen. Same "say
    // nothing rather than something false" principle defaultTargetFor above already applies to
    // these exact exercises (its own TIMED_HOLD regex, reused here) -- only gated on `bodyweight`
    // too, so a genuinely loaded one (Weighted Plank, a loaded Farmer's Carry) still gets real
    // weight-progression advice exactly as before; only the true-bodyweight-hold case is skipped.
    if (bodyweight && TIMED_HOLD.test(name)) continue;
    const base = { exercise: name, group, weight: inUnit(latest.top.weight, latest.top.unit, unit), unit,
                   bodyweight,
                   reps: Number(latest.top.reps) || 0,
                   targetRepsMax: Number(latest.top.targetRepsMax) || Number(latest.top.targetReps) || null,
                   at: latest.when, lessIsMore };
    // Logged before rep targets were stamped (pre-v154): there is nothing to judge the set
    // against, so say nothing rather than render "8 of null reps last time".
    if (!base.targetRepsMax) continue;
    // Double progression is "top of the range TWICE AT THE SAME WEIGHT". Without this check a
    // deload triggered it: miss 225x7, drop to 135x10, and the next 135x10 read as two clean
    // sessions and told someone whose squat is 225 to try 140. Compared in lb so a user who
    // switched units mid-cycle is not told their own weight changed.
    if (toppedOut(latest) && toppedOut(prev) && sameLoad(latest.top, prev.top)) {
      // Oct 10 2026 (audit finding, same "say nothing rather than something false" principle as
      // the TIMED_HOLD skip above -- Oct 9 2026 comment on `bodyweight` a few lines up): a true
      // bodyweight exercise with no added-weight variant tracked in the library has nothing real
      // to add here. Push-Up, Sit-Up, Burpee, Mountain Climber, and the rest of the plain
      // equipment:['bodyweight'] roster carry no `loadType` at all; Pull-Up/Chin-Up/Dip DO carry
      // loadType:'added' specifically because a weighted vest/belt is a genuine, trackable next
      // step for those -- "+5 lb" was telling someone to add weight to a push-up, with no way in
      // this app to actually log that as progress on the exercise's own terms. Scoped to just this
      // push, not a top-level `continue` like TIMED_HOLD's: an exercise still working UP to its
      // rep ceiling correctly lands in `holds` below either way ("Hit X reps -- Y moves you up"),
      // which says nothing about weight and stays true regardless of whether weight can ever be
      // added; only the topped-out-twice "add weight" suggestion was ever false for these. A
      // maxed-out bodyweight exercise like this one simply stops appearing here, same as a maxed-
      // out assisted exercise already does below (lessIsMore clamped at 0) -- there's nothing left
      // this card can suggest, so it says nothing rather than something wrong.
      if (!bodyweight || loadTypeForName(name) === 'added') {
        const step = incrementFor(name, unit);
        // Sep 11 2026: for an assisted exercise, topping out twice at the same assist weight means
        // ready to REDUCE assist (harder), not add more — same inversion as everywhere else this
        // touches. Clamped at 0 (can't assist less than "none") rather than going negative; at 0
        // there is nothing left to suggest, so this exercise simply stops appearing in `ready` —
        // toppedOut()/sameLoad() themselves stay untouched, only which direction counts as progress.
        const suggested = lessIsMore ? Math.max(0, base.weight - step) : base.weight + step;
        if (!lessIsMore || suggested < base.weight) ready.push(Object.assign({}, base, { suggested, step }));
      }
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
// Sep 13 2026 (Jeff): bumped every target up by 4 sets/week across the board -- "I want to add 4
// sets to the total set # within the volume trend... everything increases by 4." Flat bump, same
// relative weighting as before. This needs no separate handling for Month/3 months: volumeFor(N)
// already returns a true PER-WEEK AVERAGE for every range (This week/Month/3 months all compare
// against this same weekly number, never a raw multi-week sum -- see the comment above
// volumeFor and the one above the volume/volumeAvg/volume3mo fields in GET /api/progress), so the
// higher bar applies identically and automatically everywhere the target is shown.
const MUSCLE_TARGETS = {
  chest: 16, lats: 16, shoulders: 16, traps: 12, biceps: 14, triceps: 14, forearms: 10,
  quads: 16, hamstrings: 14, glutes: 14, calves: 14, abdominals: 14
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
// Every muscle a lift works: the primary movers (muscle_groups -- what the library tiles file it
// under) plus the helpers (secondary -- a bench press's triceps). Volume and finish history credit
// both alike; only the tiles care about the split. See the _note in exercise-library.json.
function exMuscles(lib) {
  return ((lib && lib.muscle_groups) || []).concat((lib && lib.secondary) || []);
}
// Sep 30 2026 (audit finding, Jeff: real names stay open to everyone -- "anyone should be able to
// use whatever name they like" -- this is purely about the app not getting confused internally,
// never about restricting what someone names their own exercise). The global "first match" fallback
// below is still genuinely ambiguous when it fires, but `s` (the session the set was logged
// against) narrows it in the one case that matters most in practice: whoever built the workout
// picked its exercises, so the CREATOR's own custom list is checked before the fully-blind
// global scan -- still a fallback, not a guarantee, since a session carries no owner tag per
// exercise (and never will -- see POST /api/exercises/custom's own comment on why ownerId isn't
// exposed to other users at all), but it resolves the common real case instead of only the rare one.
function findExLibEntry(name, userId, s) {
  const hit = EX_LIB.find(x => x.name === name);
  if (hit) return hit;
  const mine = ((DB.customExercises || {})[userId] || []).find(x => x.name === name);
  if (mine) return mine;
  if (s && s.creatorId && s.creatorId !== userId) {
    const creatorsOwn = ((DB.customExercises || {})[s.creatorId] || []).find(x => x.name === name);
    if (creatorsOwn) return creatorsOwn;
  }
  for (const arr of Object.values(DB.customExercises || {})) {
    const c = (arr || []).find(x => x.name === name);
    if (c) return c;
  }
  return null;
}

// Sep 28 2026 (audit finding: "Chest shows 0/16 sets this week even though a set was logged and
// counted everywhere else -- the finish screen said '1 working set', Home said '1 PR this week',
// Progress's own header said '1 day trained this week'"). Root cause: volumeFor/volumeTrendFor
// bucketed sessions by s.scheduledAt/perfDate and the server's own bare UTC clock -- the EXACT bug
// weeksFor/currentStreak already hit and fixed (v247, see the comment above weeksFor): a session's
// SCHEDULED timestamp can land on a different UTC calendar day/week than the day the user actually
// trained in their own local time, and the server's bare `new Date()` "today" has no idea what the
// caller's local day even is. This shared helper answers "which day did THIS finished session
// count for" exactly the way weeksFor already does: prefer the session's own history row for this
// user (h.date, stamped from the caller's localDate at the moment they hit Finish) and only fall
// back to scheduledAt for a session that's been logged into but not yet finished (no h.date yet --
// there is no better source for that case). Used by volumeFor, volumeTrendFor and firstLogDateFor
// below so all three agree with weeksFor on what "this week" means, instead of each other.
function sessionDateFor(s, userId) {
  const hist = (s.history || []).find(h => h.userId === userId);
  return hist ? hist.date : perfDate(s.scheduledAt).slice(0, 10);
}

// Working sets logged THIS calendar week (Monday–Sunday, anchored to the CALLER's own local day —
// see localToday and sessionDateFor above), attributed to every muscle group the exercise targets
// — full credit to each, same "touch it, it counts" rule creditFinish already uses for
// history.muscleGroups, just counted in sets instead of "did I touch this at all."
//
// `weeks` widens the window to a trailing N-Monday-anchored span (including the current partial
// week, same "count the week you're mid-way through" precedent weeksFor already sets) and returns
// the PER-WEEK AVERAGE instead of a raw count, so it's directly comparable to the same target —
// e.g. weeks=4 answers "what has this looked like lately" without one light or one heavy week
// swinging the number. weeks=1 (the default) is untouched — same math as before this existed.
function volumeFor(userId, weeks = 1, localToday) {
  const today = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  const [ty, tm, td] = today.split('-').map(Number);
  const monday = new Date(Date.UTC(ty, tm - 1, td));
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
    const at = sessionDateFor(s, userId);
    if (at < a || at >= b) continue;
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const lib = findExLibEntry(logExerciseName(s, l, userId), userId, s);
      if (!lib) continue;
      for (const m of exMuscles(lib)) if (sets.hasOwnProperty(m)) sets[m]++;
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
function volumeTrendFor(userId, weeks, localToday) {
  const today = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  const [ty, tm, td] = today.split('-').map(Number);
  const monday = new Date(Date.UTC(ty, tm - 1, td));
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
    const at = sessionDateFor(s, userId);
    if (at < a0 || at >= bN) continue;         // outside the whole range — skip the bucket scan
    const bucket = buckets.find(w => at >= w.a && at < w.b);
    if (!bucket) continue;
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const lib = findExLibEntry(logExerciseName(s, l, userId), userId, s);
      if (!lib) continue;
      for (const m of exMuscles(lib)) if (bucket.sets.hasOwnProperty(m)) bucket.sets[m]++;
    }
  }
  return {
    weeks: buckets.map(w => ({
      weekOf: w.weekOf, a: w.a, b: w.b,
      groups: MUSCLE_ORDER.map(g => ({ group: g, sets: w.sets[g], target: MUSCLE_TARGETS[g] }))
    }))
  };
}

// The earliest date this user has any REAL working set logged, across every session -- used below
// to keep muscleBalanceFor() from blaming a muscle group for weeks that happened before the user
// ever started training (a brand-new account otherwise reads every muscle as "2 weeks behind" on
// day one, which is true of the calendar but not a fact about THEM -- same instinct as the
// Consistency card's own "average starts at your first active week, not the window's start" fix).
function firstLogDateFor(userId) {
  let min = null;
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine || !mine.some(isWorkingSet)) continue;
    const at = sessionDateFor(s, userId);
    if (!min || at < min) min = at;
  }
  return min;
}

// Sep 28 2026 (audit finding, Jeff: "every muscle group now says 'Behind target 2 weeks in a
// row'... twelve red 'behind target' lines on a new account is the same demoralizing-first-
// impression problem as before, just louder... at least collapse the streak warning to only
// muscles the user has actually trained"). Originally shipped ALL-TIME (no date window -- "have
// you EVER touched this muscle", not "lately"), same touch-it-it-counts credit as volumeFor.
//
// Oct 9 2026 (audit finding, Jeff's pick among options): all-time meant a muscle group trained
// once, long since dropped from someone's actual routine, still read as "trained" forever -- so it
// kept getting flagged "Behind target" indefinitely for a muscle they genuinely stopped including
// months or years ago. Same "wall of red on things I'm not actually doing" complaint as above,
// just surviving in a different shape (abandoned rather than never-started). Narrowed from ALL-TIME
// to RECENT: the identical trailing window volume3mo already shows on this same card
// (volumeFor(userId, 13, ...) below -- 13 weeks), so "recent" here means exactly what "3 months"
// already means elsewhere on this screen, not a separately-invented number. A muscle with real
// volume sometime in that window is still "yours to keep up with" and can flag; one with nothing in
// it at all -- whether truly never-trained, or simply abandoned more than 3 months ago -- now reads
// the same, and neither flags.
function recentlyTrainedMusclesFor(userId, localToday) {
  const today = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  const [ty, tm, td] = today.split('-').map(Number);
  const monday = new Date(Date.UTC(ty, tm - 1, td));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const windowStart = new Date(monday); windowStart.setUTCDate(windowStart.getUTCDate() - 7 * (13 - 1));
  const a = windowStart.toISOString().slice(0, 10);
  // Cold-review catch (Oct 9 2026): volumeFor (what this is supposed to mirror exactly -- see the
  // comment above) also caps the window at the END of the current week (`b`, one week past
  // `monday`) and filters `at >= b` out, not just `at < a`. Without that same upper bound, a
  // session SCHEDULED in the future that already has a real logged set on it (a reachable flow --
  // accept an invite and log sets immediately, well before the session's own scheduled time; see
  // fix #3's own comment on markSessionStarted for exactly this shape) counted as "recently
  // trained" with no cutoff, even though volume3mo on this same screen correctly excludes that same
  // future-dated set -- directly contradicting the number right next to this flag.
  const nextWeek = new Date(monday); nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  const b = nextWeek.toISOString().slice(0, 10);
  const touched = new Set();
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine || !mine.length) continue;
    const at = sessionDateFor(s, userId);
    if (at < a || at >= b) continue;
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const lib = findExLibEntry(logExerciseName(s, l, userId), userId, s);
      if (!lib) continue;
      for (const m of exMuscles(lib)) touched.add(m);
    }
  }
  return touched;
}

// Sep 14 2026 (Jeff, "what else can we add to the progress page" -- picked "under target 2 weeks
// running" as the threshold): flags a muscle group only when it's missed its weekly Volume trend
// target for the last TWO fully-completed weeks in a row -- one slow week is normal training
// variation (Volume trend already shows that plainly, no flag needed); two in a row is a real
// pattern worth surfacing. Deliberately looks at the last 2 COMPLETED weeks, never the current
// in-progress one -- flagging a week that still has days left in it would be stating something
// about the user's week before it's over (CLAUDE.md: never claim something you can't stand
// behind), the same reasoning the Consistency bar chart already applies by outlining (not
// judging) the current week. Suppressed entirely for a user who hasn't been training long enough
// for both comparison weeks to be real (see firstLogDateFor) -- a brand-new account should never
// see "behind" on muscles it hasn't had the chance to train yet.
// Sep 28 2026: ALSO suppressed per muscle group the user has never once trained (originally via
// everTrainedMusclesFor above, all-time) -- same principle as the account-age guard just above,
// applied per muscle instead of per account. A muscle you've genuinely been neglecting lately
// still flags; one you've simply never included in your training doesn't.
// Oct 9 2026: narrowed further, from "ever trained" to "recently trained" (recentlyTrainedMusclesFor,
// trailing 3 months) -- see that function's own comment for why an all-time check still let a
// long-abandoned muscle flag forever.
function muscleBalanceFor(userId, localToday) {
  const vt = volumeTrendFor(userId, 3, localToday);
  const [twoAgo, oneAgo] = vt.weeks;   // vt.weeks[2] is the current, in-progress week -- excluded
  const firstLog = firstLogDateFor(userId);
  if (!firstLog || firstLog > twoAgo.a) return { groups: [] };
  const recentlyTrained = recentlyTrainedMusclesFor(userId, localToday);
  const byGroup2 = {}; for (const g of twoAgo.groups) byGroup2[g.group] = g.sets;
  const byGroup1 = {}; for (const g of oneAgo.groups) byGroup1[g.group] = g.sets;
  const flagged = [];
  for (const g of MUSCLE_ORDER) {
    if (!recentlyTrained.has(g)) continue;
    const target = MUSCLE_TARGETS[g];
    const s2 = byGroup2[g] || 0, s1 = byGroup1[g] || 0;
    if (s2 < target && s1 < target) flagged.push({ group: g, target, weeks: [s2, s1] });
  }
  // Worst first -- furthest under target across the two weeks combined, same "surface what needs
  // attention first" instinct as Volume trend's own collapsed ranking.
  flagged.sort((a, b) => (a.weeks[0] + a.weeks[1] - 2 * a.target) - (b.weeks[0] + b.weeks[1] - 2 * b.target));
  return { groups: flagged };
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

// Sep 14 2026: pulled out of trendFor() unchanged (same loop, same eligibility rules) so a new
// topLiftsFor() (the Progress-page "Top lifts" snapshot) can share this exact history instead of
// re-deriving it with a second, independently-maintained copy of the same eligibility logic --
// see the "delegates to the one shared rule" precedent elsewhere in this file (canSeeProfile).
// trendFor()'s own output is unchanged by this extraction; verified via npm test before and
// after.
function liftHistoryFor(userId) {
  const byName = {};
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine) continue;
    const perEx = {};
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const name = logExerciseName(s, l, userId);
      const assisted = loadTypeForName(name) === 'assisted';
      const e = estMax(l);
      // estMax() returns 0 at weight 0 -- for every OTHER loadType that means "bodyweight /
      // incomplete, nothing to compare" and is correctly skipped. For assisted, weight 0 is not
      // incomplete data -- it is the single BEST possible set (a full unassisted rep) -- so
      // skipping on `!e` here would silently drop a user's best session the moment they reach it,
      // right when it matters most. Only skip an assisted set for missing reps, not zero weight.
      if (assisted ? !(Number(l.reps) > 0) : !e) continue;
      // Machine-Assisted Pull-Up etc: less assist weight is the harder, more representative set,
      // same question sessionsForUser() already answers for recommendationsFor() -- so the pick
      // uses that same weight-ascending/reps-tiebreak comparison instead of estMax's raw score,
      // which stays weight-ascending (bigger e = more assist = easier) and would pick the wrong
      // set here if compared directly.
      const w = toLb(l.weight, l.unit);
      const cur = perEx[name];
      const better = !cur || (assisted
        ? (w < cur.w || (w === cur.w && (Number(l.reps) || 0) > (Number(cur.l.reps) || 0)))
        : (e > cur.e));
      if (better) perEx[name] = { e, l, w };
    }
    for (const name of Object.keys(perEx)) {
      const point = {
        // Oct 2 2026 (deep audit finding, HIGH): this used to be perfDate(s.scheduledAt) -- WHEN
        // the workout was PLANNED to start, not when it actually happened -- the exact bug class
        // the Sep 28 2026 fix already closed for volumeFor/volumeTrendFor/weeksFor (see
        // sessionDateFor's own comment above). A session scheduled weeks ago but left open and
        // only actually finished/logged today used to date its lift points back to the original
        // schedule, which could misdate a genuinely recent PR into the past -- corrupting the
        // trend's "current" smoothing (bestPointOfWindow) and, worse, feeding plateausFor a false
        // baseline that could flag a genuinely improving lift as plateaued. sessionDateFor already
        // prefers the real finish date (the caller's own h.date) and only falls back to scheduledAt
        // for a session that's been logged into but not yet finished -- same rule, same fallback.
        at: sessionDateFor(s, userId),
        // est is always Epley-scored off toLb() inside estMax() above, regardless of what unit
        // this particular set was typed in -- it is canonically a POUNDS number internally, used
        // that way for every comparison in this file (bestPointOfWindow, currentEst, the overall
        // ratio blend below). It carries no meaningful "source unit" of its own the way weight
        // does; see the Sep 24 2026 audit-round-4 fix at trendFor()/topLiftsFor() below, which
        // converts it into the viewer's current display unit only at the point it's returned to
        // the client -- never here, where other internal math still depends on it staying lb.
        est: Math.round(perEx[name].e),
        // Sep 24 2026 audit round 4 (cold-review finding): weight is stored/returned in whatever
        // unit the winning set was actually TYPED in -- exactly like every other raw logged
        // weight in this file (see the big comment above toLb/inUnit). Without a unit tag riding
        // along, trendFor()/topLiftsFor() had no way to know whether this number needed
        // converting before being shown under the viewer's CURRENT unit, and were sending it
        // straight through unconverted -- a kg-preference user logging in kg the whole time never
        // noticed, but anyone who ever logged the same lift in the other unit (or switched
        // preference) got a raw lb number displayed with a "kg" label bolted on, off by ~2.2x.
        weight: Number(perEx[name].l.weight) || 0,
        unit: perEx[name].l.unit || 'lb',
        // The REAL reps performed, never the rir-adjusted count -- estMax() alone applies the
        // rir bump to the score. Client and this point both need what actually happened.
        reps: Number(perEx[name].l.reps) || 0
      };
      if (perEx[name].l.rir !== undefined) point.rir = perEx[name].l.rir;
      (byName[name] = byName[name] || []).push(point);
    }
  }
  return Object.keys(byName)
    .map(name => ({ name, points: byName[name].sort((a, b) => a.at.localeCompare(b.at)) }))
    .filter(x => x.points.length >= 2)                   // one point is not a trend
    .sort((a, b) => b.points.length - a.points.length);  // most logged first = the default 5
}

// Also pulled out of trendFor() unchanged, for the same reason as liftHistoryFor() above --
// topLiftsFor() needs the identical "current" smoothing (best of the trailing
// TREND_SMOOTH_SESSIONS sessions, not literally the latest one) so its numbers never disagree
// with what Strength trend already shows for the same lift. See the Sep 5 comment that used to
// sit above this inside trendFor() for the full "one off day doesn't wreck the number" rationale
// -- unchanged, just relocated.
const TREND_SMOOTH_SESSIONS = 3;
function bestPointOfWindow(points, asOfDate, assisted) {
  const upTo = asOfDate ? points.filter(p => p.at <= asOfDate) : points;
  if (!upTo.length) return points[0];
  const window = upTo.slice(-TREND_SMOOTH_SESSIONS);
  return window.reduce((best, p) => {
    const better = assisted ? p.est < best.est : p.est > best.est;
    return better ? p : best;
  }, window[0]);
}
function currentEst(points, asOfDate, assisted) { return bestPointOfWindow(points, asOfDate, assisted).est; }

function trendFor(userId, localToday) {
  const lifts = liftHistoryFor(userId);
  // Sep 24 2026 audit round 4: the unit every number below gets displayed in. All the ratio/
  // smoothing math above and below stays in liftHistoryFor()'s canonical lb points, untouched --
  // this only controls the final conversion applied in toChip(), right before each lift's points/
  // currentWeight leave this function for the client.
  const displayUnit = (DB.users[userId] && DB.users[userId].units) || 'lb';

  // Sep 5 (Jeff: "I was having an off day and exhausted so didn't lift my heaviest ... it
  // dropped my strength trend a ton overall"): the overall % and each lift's own changePct used
  // to read "now" as literally that lift's single most recent session -- one rough day, especially
  // one that touched several lifts at once, could yank the whole overall number down immediately,
  // with nothing to recover it until the NEXT session on every affected lift individually beat it.
  // estMax()'s RIR bump (Aug 22, comment above) already protects a single SET from being misjudged
  // when you honestly had more in the tank -- this protects a single SESSION the same way when you
  // genuinely didn't. The app already has the right instinct for this exact shape of problem:
  // plateausFor() (below) deliberately compares your BEST set across a trailing window rather than
  // your literal latest one, specifically so "one rough or one lucky session ... doesn't flip the
  // flag." currentEst() applies that same idea here -- "now" for a lift is the best estimated max
  // across its last TREND_SMOOTH_SESSIONS sessions (as of whatever date is being asked about), not
  // literally its single most recent set. A real, sustained drop across several sessions still
  // shows up; this only absorbs one bad day. Applies to the OVERALL line/number and to changePct
  // (the per-lift headline used in "what's driving it") -- NOT to an individual lift's own chart,
  // which stays the raw literal points on purpose so an off day is still honestly visible there.
  //
  // bestPointOfWindow() (not just the number) so toChip() below can also report the WEIGHT that
  // earned changePct, not just the score -- an early version of this fix kept showing the driver
  // row's weight range as literal-first-to-literal-last (e.g. "200 -> 180 lb") right next to the
  // now-smoothed "+10%", which self-contradicts (a lighter weight next to a green up-arrow). The
  // row has to name the session that actually produced the number beside it.
  // `assisted` is threaded through here because it flips which end of a window/lift counts as
  // "best": for a normal lift, best = highest est (heaviest/most reps); for an assisted lift
  // (loadType==='assisted' -- Machine-Assisted Pull-Up today), less assist is the harder,
  // more-improved set, so best = LOWEST est. estMax()'s own formula is left untouched (still
  // just w*(1+r/30)) -- only which direction counts as "better" changes at each call site below.
  // bestPointOfWindow()/currentEst()/TREND_SMOOTH_SESSIONS themselves now live at module scope
  // (see above liftHistoryFor) so topLiftsFor() can share them -- unchanged otherwise.

  // Sep 30 2026 (audit finding, Jeff: confirmed option A -- "what's driving it" and the plateau
  // card should use the same window, long term): this used to baseline everything against
  // l.points[0] -- the lift's literal all-time first session, no window at all -- while
  // plateausFor() (below) already judges progress over a trailing PLATEAU_WEEKS window. Almost
  // everyone is better than their very first-ever session forever, so "what's driving it" nearly
  // always said "improving" while the plateau card, looking at the same lift over the last 6
  // weeks, could honestly say "stalled" -- both technically true, but answering different
  // questions dressed up as the same one. Baseline is now the smoothed (bestPointOfWindow, same
  // helper "now" already uses) value AS OF PLATEAU_WEEKS ago, so both cards measure the identical
  // stretch of training and can't contradict each other. A lift with no history older than the
  // window falls back to l.points[0] automatically (bestPointOfWindow's own behavior when nothing
  // is that old yet) -- unchanged behavior for anyone who's only ever logged it recently.
  // Oct 2 2026 (deep audit finding, HIGH, same root cause as liftHistoryFor's own `at` fix above):
  // this used to anchor the window to the bare SERVER clock (new Date()) instead of accepting
  // localToday the way weeksFor/volumeFor/volumeTrendFor all do -- so the window boundary itself
  // could land on a different calendar day than the caller's own "today" near midnight UTC,
  // compounding the misdated-points bug above. Same isValidLocalDateStr fallback those siblings use.
  const todayStr = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  const [twy, twm, twd] = todayStr.split('-').map(Number);
  const trendWindowStart = new Date(Date.UTC(twy, twm - 1, twd));
  trendWindowStart.setUTCDate(trendWindowStart.getUTCDate() - PLATEAU_WEEKS * 7);
  const trendWindowStartStr = trendWindowStart.toISOString().slice(0, 10);
  // Sep 30 2026 (real regression caught in test/trend-smoothing.mjs, fixed same day as the window
  // change above): the first attempt at this baseline used bestPointOfWindow(l.points,
  // trendWindowStartStr, ...) -- the BEST session among whatever is at-or-before that date. That
  // breaks whenever a lift's entire history predates the window (e.g. logged twice, both 7+ weeks
  // ago, nothing since): every point qualifies as "at or before the window start," so instead of
  // falling back to the true first session, it picks whichever of those (all old) sessions
  // happened to be best -- which can be the exact same point currentEst() above lands on for "now"
  // (same "best of the last few sessions" pool, nothing more recent to tell "then" from "now"
  // apart). Baseline and current collapse to the same number and changePct reads 0%, erasing a
  // real improvement between those old sessions -- exactly what test/trend-smoothing.mjs's Cable
  // Fly case caught.
  //
  // The actual fix mirrors plateausFor()'s OWN gating, not just its window: plateausFor() only
  // ever judges a lift "stalled" when it has >= PLATEAU_MIN_SESSIONS within the trailing window
  // AND at least one session before it to compare against (see its comments below) -- any other
  // lift is simply never flagged, so there is no contradiction for "what's driving it" to avoid in
  // the first place. So the window-based baseline (bestBefore, same "best/least-assist of every
  // prior-window point" plateausFor itself uses -- not a smoothed last-3-sessions pick, the exact
  // number the plateau card would show) only replaces l.points[0] in that same exact case. Every
  // other lift -- not enough recent training to be judged, or no history predating the window --
  // falls back to l.points[0], the true all-time first session, unchanged from before Sep 30 2026.
  //
  // Sep 30 2026 (audit finding, Jeff: confirmed while checking the fix above -- the driver row's
  // own "40x12 -> 45x15" weight/reps range was still hardcoded to l.points[0], the all-time first
  // session, even after changePct itself moved to the windowed baseline. Same self-contradicting-
  // number shape as the Sep 5/Sep 28 fixes above -- e.g. a lift logged for 8 months could show
  // "▲ +4%" (a real, small, recent gain, correctly windowed) right next to an 8-month-old starting
  // weight that has nothing to do with the number beside it. baselinePointOf returns the ACTUAL
  // point baselineOf's number came from (not just its .est), so the client can show a weight/reps
  // range that matches whatever session the % was really computed against.
  const baselinePointOf = l => {
    const assisted = loadTypeForName(l.name) === 'assisted';
    const windowPoints = l.points.filter(p => p.at >= trendWindowStartStr);
    const priorPoints = l.points.filter(p => p.at < trendWindowStartStr);
    if (windowPoints.length < PLATEAU_MIN_SESSIONS || !priorPoints.length) return l.points[0];
    return priorPoints.reduce((best, p) => {
      const better = assisted ? p.est < best.est : p.est > best.est;
      return better ? p : best;
    }, priorPoints[0]);
  };
  const baselineOf = l => baselinePointOf(l).est;
  // Overall stays computed from EVERY eligible lift, never just the picked/displayed subset --
  // it is a holistic "how is your training going" number, and shrinking it to whatever chips
  // happen to be picked would make it lie by omission the moment someone picks fewer than 5.
  const dates = [...new Set(lifts.flatMap(l => l.points.map(p => p.at)))].sort();
  const wsum = lifts.reduce((a, l) => a + baselineOf(l), 0);
  const overall = !lifts.length ? [] : dates.map(d => {
    let acc = 0;
    for (const l of lifts) {
      const assisted = loadTypeForName(l.name) === 'assisted';
      const cur = currentEst(l.points, d, assisted);
      const start = baselineOf(l);
      // A normal lift's ratio is cur/start (>1 = up = good). An assisted lift's improvement is a
      // DROP in assist weight, so the ratio is inverted (start/cur) to keep ">1 = good" true for
      // every lift feeding this blend, regardless of loadType.
      // cur===0 means the best set in this window was fully unassisted -- the best an assisted lift
      // can ever be, but start/0 is a division by zero. Capped at 2 (the same "maxed out" ceiling
      // toChip's changePct below uses, ratio 2 == +100%) instead of Infinity/NaN, which would
      // otherwise corrupt this WHOLE user's overall blended trend, not just this one lift's line.
      const ratio = assisted
        ? (cur > 0 ? (start / cur) : (start > 0 ? 2 : 1))
        : (cur / start);
      acc += ratio * (start / wsum);
    }
    return { at: d, pct: Number(((acc - 1) * 100).toFixed(1)) };
  });

  const toChip = l => {
    const assisted = loadTypeForName(l.name) === 'assisted';
    const bestPoint = bestPointOfWindow(l.points, undefined, assisted);
    // Same start/cur swap as the overall blend above, so changePct reads positive when an
    // assisted lift's assist weight has genuinely dropped, not just when est happens to be higher.
    // Same bestPoint.est===0 guard as the overall blend above (a fully-unassisted best set would
    // otherwise divide by zero) -- capped at +100% ("maxed out") rather than Infinity/NaN.
    // Sep 30 2026 (audit finding): baselineOf() (same PLATEAU_WEEKS-window baseline the overall
    // blend above now uses), not l.points[0] -- see the comment above trendWindowStartStr.
    const basePoint = baselinePointOf(l);
    const start = basePoint.est;
    const changePct = assisted
      ? (bestPoint.est > 0 ? (start / bestPoint.est - 1) * 100 : (start > 0 ? 100 : 0))
      : (bestPoint.est / start - 1) * 100;
    return {
      name: l.name,
      // Sep 24 2026 audit round 4 (HIGH finding, cold-review): l.points was being handed to the
      // client as-is -- raw weight in whatever unit each set was typed in, and an `est` that is
      // ALWAYS lb-scaled internally (see the comment in liftHistoryFor above) -- while the client
      // (trendChart in app.js) prints both under the viewer's CURRENT unit with no conversion of
      // its own. A kg-preference user got their own lb-scored est displayed as "kg" (off by
      // ~2.2x, e.g. a 110kg squat read as a 283 "kg" estimated max instead of ~128), and anyone
      // who ever logged the same lift in the other unit got the same mislabeling on the raw
      // weight tooltip. Converted here, once, right before this leaves the function -- every
      // internal comparison above (bestPointOfWindow, changePct, the overall blend) already ran
      // against the untouched lb-canonical points, so this can't affect any of that math.
      points: l.points.map(p => ({
        at: p.at,
        est: Math.round(inUnit(p.est, 'lb', displayUnit)),
        weight: inUnit(p.weight, p.unit || 'lb', displayUnit),
        unit: displayUnit,
        reps: p.reps,
        rir: p.rir
      })),
      changePct: Number(changePct.toFixed(1)),
      // The weight from the SAME session changePct is computed against -- not literally the most
      // recent session's weight -- so "what's driving it" never shows a lighter number next to a
      // green up-arrow (see the comment above bestPointOfWindow). Now unit-converted too (same
      // fix as points above -- bestPoint.weight/unit are the untouched raw values).
      currentWeight: inUnit(bestPoint.weight, bestPoint.unit || 'lb', displayUnit),
      // Sep 30 2026 (audit finding, same fix as basePoint/start just above): the "from" side of
      // the driver row's weight/reps range used to be hardcoded to l.points[0] (the all-time first
      // session) client-side, which could now disagree with whatever session `start`/changePct
      // actually came from. baselineWeight/baselineReps are THAT session's own numbers, unit-
      // converted the same way currentWeight/currentReps already are -- so the range the client
      // shows always matches the % next to it, however far back the real baseline turned out to be.
      baselineWeight: inUnit(basePoint.weight, basePoint.unit || 'lb', displayUnit),
      baselineReps: basePoint.reps,
      // Sep 28 2026 (audit finding, Jeff: "the 7% is from reps (12 → 15), but showing the weight
      // unchanged next to an up-arrow looks like a bug even though it isn't"). "What's driving it"
      // only ever showed weight-vs-weight, but changePct is scored off est (weight AND reps via
      // Epley) -- a rep-only improvement at the same weight is a completely real, positive change
      // that the weight-only line couldn't show at all. Two candidate fixes, both real numbers
      // already computed above, neither needing new math -- exposed here so the client can render
      // either (or both, for Jeff to pick from) without another round trip:
      //   - currentReps (+ l.points[0].reps, already sent): "40×12 → 40×15"
      //   - currentEst (+ l.points[0].est, already sent): "115 → 123 lb (est.)"
      currentReps: bestPoint.reps,
      currentEst: Math.round(inUnit(bestPoint.est, 'lb', displayUnit)),
      // Sep 11 2026 (Jeff, asked before building): the per-lift Strength Trend chart plots this
      // lift's own points, and for an assisted exercise the client flips its y-axis so the line
      // still reads "up = improving" like every other lift, even though the underlying number
      // (assist weight) is genuinely decreasing. Same flag name/meaning as recommendationsFor's
      // ready-suggestion objects.
      lessIsMore: assisted
    };
  };
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

// Sep 14 2026 (Jeff, "what else can we add to the progress page" -- "Top lifts"): a compact
// snapshot of your current best on your most-important lifts, separate from Strength trend's line
// chart above (that's about direction/movement over time; this is just "what are you at right
// now"). Shares liftHistoryFor()/bestPointOfWindow() with trendFor() so the two never disagree
// about what "current" means for the same lift. Auto-picks your 3 most-logged lifts by default;
// topLiftPicks (validated the same lazy way trendPicks is above -- a temporarily-unlogged pick
// isn't silently dropped from what's saved, only from what's shown) lets a user override that,
// capped at 3 -- deliberately a SEPARATE saved list from trendPicks/5, not a reuse of it: the
// Strength trend chip picker and this snapshot answer different questions ("what do you want to
// watch trend" vs "what do you want featured up top") and nothing requires them to match.
function topLiftsFor(userId) {
  const lifts = liftHistoryFor(userId);
  const allNames = lifts.map(l => l.name);
  const u = DB.users[userId];
  // Sep 24 2026 audit round 4: same unit-conversion gap as trendFor() above, same fix -- see the
  // comment on toTile below.
  const displayUnit = (u && u.units) || 'lb';
  const rawPicks = Array.isArray(u && u.topLiftPicks) ? u.topLiftPicks : [];
  const seen = new Set();
  const picks = [];
  for (const name of rawPicks) {
    if (seen.has(name) || !allNames.includes(name)) continue;
    seen.add(name);
    picks.push(name);
    if (picks.length >= 3) break;
  }
  const shown = picks.length ? picks.map(name => lifts.find(l => l.name === name)) : lifts.slice(0, 3);
  const toTile = l => {
    const assisted = loadTypeForName(l.name) === 'assisted';
    const bestPoint = bestPointOfWindow(l.points, undefined, assisted);
    return {
      name: l.name,
      // Sep 24 2026 audit round 4 (cold-review finding): bestPoint.weight/est are the raw
      // liftHistoryFor() values (weight in whatever unit that set was typed in; est always
      // lb-scaled) -- the client's Top-lifts tile prints both straight under the viewer's current
      // unit with no conversion of its own (`${l.weight} ${U}`), same gap as trendFor() above.
      weight: inUnit(bestPoint.weight, bestPoint.unit || 'lb', displayUnit),
      reps: bestPoint.reps,
      est: Math.round(inUnit(bestPoint.est, 'lb', displayUnit)),
      unit: displayUnit,
      at: bestPoint.at,
      sessions: l.points.length,
      lessIsMore: assisted
    };
  };
  return { lifts: shown.map(toTile), allNames, picks };
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

function plateausFor(userId, localToday) {
  const unit = (DB.users[userId] && DB.users[userId].units) || 'lb';
  const byName = {};
  for (const s of Object.values(DB.sessions)) {
    const mine = s.logs && s.logs[userId];
    if (!mine) continue;
    const perEx = {};
    for (const l of mine) {
      if (!isWorkingSet(l)) continue;
      const name = logExerciseName(s, l, userId);
      const assisted = loadTypeForName(name) === 'assisted';
      const e = estMax(l);
      // See the identical comment in trendFor() above: weight 0 is the BEST possible assisted
      // set, not incomplete data, so it must not be excluded here the way bodyweight 0 is for
      // every other loadType.
      if (assisted ? !(Number(l.reps) > 0) : !e) continue;   // bodyweight / incomplete -- see estMax
      // Same assisted-aware pick as trendFor() above -- see its comment.
      const w = toLb(l.weight, l.unit);
      const cur = perEx[name];
      const better = !cur || (assisted
        ? (w < cur.w || (w === cur.w && (Number(l.reps) || 0) > (Number(cur.l.reps) || 0)))
        : (e > cur.e));
      if (better) perEx[name] = { e, l, w };
    }
    for (const name of Object.keys(perEx)) {
      // Oct 2 2026 (#174, part of the same misdated-points fix as liftHistoryFor()/trendFor()
      // above): this used to date each point by perfDate(s.scheduledAt) -- when the session was
      // SCHEDULED, not when it was actually logged. A lift trained late, or finished after
      // midnight relative to its scheduled slot, landed its point on the wrong side of the
      // PLATEAU_WEEKS window boundary below, which can make a genuinely improving lift read as
      // "stuck" just because its most recent sessions got dated into the prior period instead of
      // the current one. sessionDateFor() (shared with liftHistoryFor()) prefers the real logged
      // date from s.history and only falls back to the scheduled date when that's unavailable.
      const at = sessionDateFor(s, userId);
      const l = perEx[name].l;
      (byName[name] = byName[name] || []).push({
        at, est: perEx[name].e,
        weight: Number(l.weight) || 0, unit: l.unit || 'lb', reps: Number(l.reps) || 0
      });
    }
  }

  // Oct 2 2026 (#174, same localToday-aware window fix as trendFor()'s trendWindowStart above):
  // a bare `new Date()` here uses the SERVER's clock instant, which can already be "tomorrow"
  // relative to the caller's local day (or still "yesterday"), shifting the window boundary by a
  // day and flipping which side of it a borderline session lands on. isValidLocalDateStr's
  // fallback to the server date keeps this safe for any caller that doesn't pass localToday.
  const todayStr2 = isValidLocalDateStr(localToday) ? localToday : new Date().toISOString().slice(0, 10);
  const [pwy, pwm, pwd] = todayStr2.split('-').map(Number);
  const windowStart = new Date(Date.UTC(pwy, pwm - 1, pwd));
  windowStart.setUTCDate(windowStart.getUTCDate() - PLATEAU_WEEKS * 7);
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  const out = [];
  for (const name of Object.keys(byName)) {
    const points = byName[name].sort((a, b) => a.at.localeCompare(b.at));
    const windowPoints = points.filter(p => p.at >= windowStartStr);
    if (windowPoints.length < PLATEAU_MIN_SESSIONS) continue;    // not trained enough lately
    const priorPoints = points.filter(p => p.at < windowStartStr);
    if (!priorPoints.length) continue;                           // no baseline before the window
    // Assisted (loadType==='assisted'): the "best" est in each period is the LOWEST (least
    // assist), and real progress is bestDuring dropping below bestBefore by more than the
    // threshold -- both inverted from the normal heaviest-wins reading, same direction flip as
    // trendFor() above.
    const assisted = loadTypeForName(name) === 'assisted';
    const bestBefore = assisted ? Math.min(...priorPoints.map(p => p.est)) : Math.max(...priorPoints.map(p => p.est));
    const bestDuring = assisted ? Math.min(...windowPoints.map(p => p.est)) : Math.max(...windowPoints.map(p => p.est));
    const madeRealProgress = assisted
      ? bestDuring < bestBefore * (1 - PLATEAU_THRESHOLD)
      : bestDuring > bestBefore * (1 + PLATEAU_THRESHOLD);
    if (madeRealProgress) continue;   // real progress -- not stuck

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

// Oct 10 2026 (audit finding): a seed is stored in whatever unit it was TYPED in (PUT below always
// stamps the CURRENT u.units at save time), same convention as a logged set -- but unlike every
// other place that reads a stored weight back (recordsFor's goal normalization just above,
// GET /api/progress/exercise/:name's own `seed` field a few hundred lines down, both already use
// inUnit() for exactly this), this route used to hand back the raw, unconverted number. The
// Starting-weights screen labels its inputs with the viewer's CURRENT unit (myUnit() client-side)
// but was filling them with the OLD unit's raw number -- switch lb->kg, open Starting weights, see
// your 185 lb squat seed still reading "185" under a "(kg)" label (should read ~84). Tap Save
// without touching anything and PUT re-stamps unit:'kg' against that same unconverted 185,
// permanently mislabeling it as 185 kg (~408 lb) -- silent, real data corruption from the
// completely ordinary act of switching units. Converting here, at read time, is non-destructive:
// storage keeps each seed's own original unit untouched (same as a logged set), only the
// response is expressed in the viewer's current unit, so re-saving an untouched value round-trips
// losslessly.
app.get('/api/me/seeds', auth, (req, res) => {
  const unit = (DB.users[req.userId] && DB.users[req.userId].units) || 'lb';
  const raw = seedsOf(req.userId);
  const seeds = {};
  for (const name of Object.keys(raw)) {
    const s = raw[name];
    seeds[name] = {
      ...s,
      weight: inUnit(s.weight, s.unit || 'lb', unit),
      goal: (s.goal != null) ? inUnit(s.goal, s.unit || 'lb', unit) : s.goal,
      unit,
    };
  }
  res.json({ seeds });
});

app.put('/api/me/seeds', auth, async (req, res) => {
  // `weight`/`reps` are the user's CURRENT working set, not an all-time best. Jeff's call:
  // a working weight is self-correcting (real logs replace it within a week) whereas a
  // self-reported all-time best is permanent, may be unbeatable, and would block the first
  // real record forever.
  const { weight, reps, goal } = req.body || {};
  const exercise = currentExerciseName((req.body || {}).exercise);   // stale client, old name -- see EXERCISE_RENAMES
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
    const name = currentExerciseName(capStr(p, 80));   // stale client, old name -- see EXERCISE_RENAMES
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push(name);
    if (clean.length >= 5) break;
  }
  DB.users[req.userId].trendPicks = clean;
  await save(DB);
  res.json({ picks: clean });
});

// Same shape/rules as POST /api/me/trend-picks above, just its own separate field (topLiftPicks)
// and a lower cap (3, matching the Top lifts snapshot it feeds -- see topLiftsFor()).
app.post('/api/me/top-lift-picks', auth, async (req, res) => {
  const { picks } = req.body || {};
  if (!Array.isArray(picks)) return res.status(400).json({ error: 'picks must be an array' });
  const seen = new Set();
  const clean = [];
  for (const p of picks) {
    const name = currentExerciseName(capStr(p, 80));   // stale client, old name -- see EXERCISE_RENAMES
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push(name);
    if (clean.length >= 3) break;
  }
  DB.users[req.userId].topLiftPicks = clean;
  await save(DB);
  res.json({ picks: clean });
});

// The record list the UI renders: earned records, plus seeded entries for lifts with none yet.
// An earned record that has passed its seed is flagged so the UI can celebrate it once.
function recordsFor(userId) {
  const earned = (DB.prs && DB.prs[userId]) ? DB.prs[userId] : {};
  const seeds = seedsOf(userId);
  const out = [];
  for (const name of Object.keys(earned)) {
    const e = earned[name], seed = seeds[name];
    // Sep 11 2026: an assisted exercise's seed is a STARTING assist weight — beating it means
    // using LESS assist than that, same inversion as rebuildAllPrs' own weight record above.
    const assisted = loadTypeForName(name) === 'assisted';
    const beatSeed = seed && (assisted
      ? toLb(e.weight, e.unit) < toLb(seed.weight, seed.unit)
      : toLb(e.weight, e.unit) > toLb(seed.weight, seed.unit));
    out.push(Object.assign({}, e, {
      source: 'earned',
      beatSeed: !!beatSeed,
      seedWeight: seed ? seed.weight : null, seedReps: seed ? seed.reps : null,
      goal: seed && seed.goal ? seed.goal : null,
      // The goal's OWN unit (whatever u.units was at seed time -- see PUT /api/me/seeds), which is
      // not necessarily this earned record's own p.unit if the user has changed their unit
      // preference since seeding the goal. Consumed (and stripped back off) immediately below --
      // never part of the object this function actually returns.
      _goalUnit: seed ? seed.unit : null
    }));
  }
  for (const name of Object.keys(seeds)) {
    if (earned[name]) continue;                       // a real record supersedes the entry
    // _goalUnit === unit here always (same seed object) -- set explicitly anyway so the
    // normalization loop below can treat every row the same way regardless of source.
    out.push(Object.assign({}, seeds[name], { source: 'entered', _goalUnit: seeds[name].unit }));
  }
  // Sep 14 2026 (Jeff, "what else can we add" -- Goals section + inline bar on this same row):
  // progress toward a set goal, computed once here so the new Goals card and the inline bar added
  // to this exact PR row in Personal records can never show two different numbers for the same
  // goal. Cold-review catch: an earlier version of this compared p.weight and p.goal as raw
  // numbers, silently assuming they were in the same unit -- true for an 'entered' seed (weight and
  // goal come from the same object) but NOT guaranteed for an 'earned' record, whose own p.unit is
  // whatever unit the winning LOG was typed in, independent of whatever unit was active when the
  // goal was seeded (_goalUnit, above). A user who set a kg goal and later beat it with a lb-typed
  // log would have silently gotten a wildly wrong pct/"reached" claim -- exactly the class of thing
  // CLAUDE.md's "never state something about the user you can't stand behind" exists to prevent,
  // and the same mistake prLabel's own v249 fix already corrected once elsewhere on this same
  // object (that fix only reached p.weight's own label, never touched a goal figure).
  //
  // Fixed by normalizing p.goal ITSELF into this record's own unit right here, unconditionally,
  // the moment it's read -- not just inside goalProgress's percentage math. That means every
  // existing display of a goal number (including the plain-text "goal N lb" fallback the client
  // already showed before today, for a bodyweight/assisted entry goalProgress deliberately skips
  // below) is correct too, not only the two new spots this diff adds. Same toLb/inUnit approach
  // beatSeed (above) already uses for the same class of comparison.
  for (const p of out) {
    p.goalProgress = null;
    if (p.goal) {
      const wUnit = p.unit || 'lb';
      p.goal = Number(inUnit(p.goal, p._goalUnit || wUnit, wUnit));
    }
    delete p._goalUnit;
    if (!p.goal || !(Number(p.weight) > 0)) continue;
    if (loadTypeForName(p.exercise) === 'assisted') continue;
    const cur = Number(p.weight), goal = Number(p.goal);
    if (!(goal > 0)) continue;
    p.goalProgress = {
      pct: Math.max(0, Math.min(100, Math.round(100 * cur / goal))),
      remaining: Math.max(0, Number((goal - cur).toFixed(1))),
      reached: cur >= goal
    };
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
  // Sep 5 (Jeff, exercise-detail sheet): "add in what the users personal best is for that
  // exercise." A direct DB.prs[userId][name] lookup, not recordsFor() -- recordsFor() also
  // walks every seeded lift to build the full Progress-tab list, which is real work this
  // single-exercise sheet has no reason to pay for. This is the one earned record for this
  // exercise, in whatever unit they're on now, or null if they haven't logged it yet.
  const earnedPr = (DB.prs && DB.prs[req.userId] && DB.prs[req.userId][name]) || null;
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
    soon:  r.soon.find(x => x.exercise === name) || null,
    pr: earnedPr
      ? { weight: inUnit(earnedPr.weight, earnedPr.unit, r.unit), reps: earnedPr.reps, unit: r.unit, at: earnedPr.at }
      : null,
    // Sep 9 2026: the second, independent record (see rebuildAllPrs) — most total weight moved
    // in a single set (weight × reps), not the heaviest weight. Same explicit field pick as `pr`
    // above rather than forwarding earnedPr wholesale, so this route's response shape stays a
    // deliberate contract, not whatever happens to be sitting on the DB.prs record today.
    setPr: (earnedPr && earnedPr.setWeight !== undefined)
      ? { weight: inUnit(earnedPr.setWeight, earnedPr.setUnit, r.unit), reps: earnedPr.setReps, unit: r.unit, at: earnedPr.setAt }
      : null
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
  // Sep 29 2026 (audit finding): this used to walk backward through `w`, which is capped at
  // whatever the caller's range picker asked for (4/13/26 weeks) -- so switching to a shorter
  // range visibly shrank your own streak, even though nothing about your training history
  // changed. Home (weeksFor(...,26,...)) and the recap screen both already hardcode 26 weeks
  // specifically to dodge this; streak here now does the same, independent of `weeks`/the
  // picker, instead of being the one place still coupled to the display range.
  const streakWindow = weeks === 26 ? w : weeksFor(req.userId, 26, req.query.localToday);
  let streak = 0;
  for (let i = streakWindow.length - 1; i >= 0; i--) { if (streakWindow[i].days > 0) streak++; else break; }
  res.json({
    unit: rec.unit,
    ready: rec.ready,
    holds: rec.holds,
    soon: rec.soon,     // one clean session away — the log sheet shows this, so Progress must too
    weeks: w,
    thisWeek: w.length ? w[w.length - 1].days : 0,
    avgPerWeek: w.length ? Number((trained / w.length).toFixed(1)) : 0,
    streakWeeks: streak,
    trend: trendFor(req.userId, req.query.localToday),
    plateaus: plateausFor(req.userId, req.query.localToday),
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
    // Sep 28 2026: all four now take req.query.localToday, same trust rule as weeksFor just above
    // (this is always the caller's own live request) -- see the comment above sessionDateFor for
    // the bug this fixes (volume was disagreeing with weeksFor/Home on what "this week" means).
    volume: volumeFor(req.userId, 1, req.query.localToday),
    volumeAvg: volumeFor(req.userId, 4, req.query.localToday),
    volume3mo: volumeFor(req.userId, 13, req.query.localToday),
    // No longer consumed by the client's Volume trend view as of round 5 (it used to drive a
    // per-week SVG trend chart, now retired in favor of the range-picker bar rows above) — left
    // computed/returned since Consistency's own weeksFor still needs this same `weeks` param, and
    // nothing else currently depends on removing this field. Candidate for cleanup later if truly
    // nothing else ever needs real per-week history again.
    volumeTrend: volumeTrendFor(req.userId, weeks, req.query.localToday),
    // Sep 14 2026 additions -- see topLiftsFor()/muscleBalanceFor() for the reasoning behind each.
    topLifts: topLiftsFor(req.userId),
    muscleBalance: muscleBalanceFor(req.userId, req.query.localToday)
  });
});

app.post('/api/sessions/:id/log', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!s.participants.includes(req.userId) && !s.joinRequests.find(j=>j.userId===req.userId&&j.status==='approved'))
    return res.status(403).json({ error: 'forbidden' });
  const { exerciseId, weight, reps, set, setType, rir } = req.body || {};
  // Sep 24 2026 (audit finding): exerciseId was never checked against the live exercise list at
  // all before this point -- so a stale client (its card still showing an exercise that's since
  // been removed, e.g. via an approved pendingRemoval) could log a "set" that attaches to nothing
  // real. exerciseNameFor falls back to returning the raw internal id string when it can't resolve
  // a name, so the set -- and any PR it triggered -- got permanently filed under a garbage name
  // like "e_ycc71vos" with no way to ever relabel it. Reject up front instead -- but only when
  // s.exercises genuinely HAS entries and this id just isn't one of them; a session with an EMPTY
  // exercises list is exposure.mjs's documented legacy/hand-edited-row case (a row saved before
  // this schema existed, or fixed by hand per DEPLOY.md), where the established, tested rule is
  // "never drop a real set just because the row is malformed" -- see "the set actually survives in
  // the database" there. Only a populated list that's missing this specific id is the real signal
  // something was actually, deliberately removed.
  if (s.exercises.length && !s.exercises.find(x => x.id === exerciseId)) return res.status(404).json({ error: 'exercise not found' });
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
  const rr = exDef ? repRange(exDef, DB.users[req.userId] && DB.users[req.userId].trainingPhase) : null;
  // Snapshot the exercise NAME too. Everything else about a set is already frozen at log time
  // (rep target, unit, loadType) so that editing a workout later cannot rewrite history — the
  // name was the one field still resolved live, through the session's exercise list. Remove that
  // exercise and the set pointed at nothing: records started showing raw ids like "e_ycc71vos",
  // permanently, and the sets could never be reattached because re-adding mints a new id.
  const entry = { id: 'log_'+uid(), exerciseId, exerciseName: exerciseNameFor(s, exerciseId, req.userId),
                  weight: w, reps: r, set: setNum, setType: setType || 'normal', isPr: false, isSetPr: false, at: new Date().toISOString() };
  if (lt) entry.loadType = lt;   // omitted entirely for unambiguous lifts (barbell, cable, machine)
  if (unit !== 'lb') entry.unit = unit;   // omitted when lb, so existing data stays byte-identical
  if (rr) { entry.targetReps = rr.lo; if (rr.hi !== rr.lo) entry.targetRepsMax = rr.hi; }
  // RIR (Reps In Reserve) is optional, per set, task #62. Omitted entirely when blank rather than
  // stored as 0 - those mean different things ("didn't track it" vs. "went to failure").
  if (rir !== undefined && rir !== null && String(rir).trim() !== '') entry.rir = numIn(rir, 20);
  // Captured BEFORE the rebuild below wipes and re-derives DB.prs from scratch -- the only way to
  // know what the record was a moment ago, for the Activity feed's "+10 lb over last max" delta.
  const prevPr = DB.prs[req.userId] && DB.prs[req.userId][entry.exerciseName];
  s.logs[req.userId].push(entry);
  // Sep 23 2026 (cold-review catch): requiredApprovals is captured once, when a removal request
  // first opens (PUT /api/sessions/:id) -- someone who logs a set on the SAME exercise afterward,
  // while the request is still pending, was never asked for their own sign-off, so the exercise
  // could be removed without ever having their consent even though they now have a real stake in
  // it too (their own logged sets survive either way, per the design -- this is purely about
  // making sure their vote is actually asked for). Widen the still-open request the moment they
  // log, the same way it would have been sized if they'd already had this set in when it opened.
  const openPr = s.pendingRemovals.find(p => p.status === 'pending' && p.exerciseId === exerciseId);
  if (openPr && openPr.proposedBy !== req.userId && !openPr.requiredApprovals.includes(req.userId)) {
    openPr.requiredApprovals.push(req.userId);
  }
  rebuildAllPrs();
  // Sep 11 2026 (Activity page): a real, earned PR (entry.isPr, mutated in place by
  // rebuildAllPrs -- see its own comment on why bestLog IS this same entry object) gets an
  // ephemeral feed event, same "!firstLog" exclusion groupPrsForFeed already applies elsewhere --
  // a brand-new exercise's very first log is a baseline, not something anyone beat.
  if (entry.isPr) {
    const rec = DB.prs[req.userId] && DB.prs[req.userId][entry.exerciseName];
    if (rec && !rec.firstLog) {
      const assisted = loadTypeForName(entry.exerciseName) === 'assisted';
      const prevWeightLb = prevPr ? toLb(prevPr.weight, prevPr.unit) : null;
      const newWeightLb = toLb(rec.weight, rec.unit);
      // Signed lb delta, always "positive = better" regardless of assisted's inverted sense (see
      // rebuildAllPrs's own comment on why less assist is the harder set) -- app.js's display
      // formatting decides the exact wording per `assisted`.
      const deltaLb = prevWeightLb == null ? null
        : Math.round((assisted ? prevWeightLb - newWeightLb : newWeightLb - prevWeightLb) * 10) / 10;
      // headline/sub, not a single `text` -- the Activity page's PR row is a two-line hero card
      // (bold headline + a lighter delta line), unlike every other row type here which is one
      // plain line. weightPart mirrors groupPrsForFeed's own bodyweight-vs-weighted formatting.
      const weightPart = rec.weight === 0 ? `${rec.reps} reps` : `${rec.weight} ${rec.unit} × ${rec.reps}`;
      const headline = `New PR — ${weightPart}`;
      const sub = (deltaLb != null && deltaLb > 0)
        ? (assisted ? `${deltaLb} lb less assist than last time` : `+${deltaLb} lb over last max`)
        : null;
      // `at` is the PERFORMED date (entry._performedAt, stamped by rebuildAllPrs from the
      // session's scheduledAt), not literal "now" -- logging a backdated workout must not make a
      // week-old PR read as breaking news today, same reasoning as groupPrsForFeed's own weekAgo
      // filter and the v239/v247 "stamped now" fixes elsewhere in this file.
      emitFeedEvent('pr', req.userId, { sessionId: s.id, exerciseId, exerciseName: entry.exerciseName,
        weight: rec.weight, reps: rec.reps, unit: rec.unit, assisted, deltaLb,
        text: `hit a new PR on ${entry.exerciseName} (${weightPart})`, headline, sub,
        at: entry._performedAt || entry.at });
    }
  }
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

// Sep 15 2026 (Jeff): training-focus phases, mapped from the NASM OPT Model he asked to have
// mapped onto CrewFit's own progression logic. A phase, when a user has picked one, overrides
// the per-exercise defaultReps/defaultRepsMax below with one flat range for every exercise --
// same simplification the client-side preview used, now real. Mirrored client-side in app.js's
// own TRAINING_PHASES (labels/blurb live only there; this is the one place the actual numbers
// that matter for progression live) -- same "duplicated small constant" pattern PLATEAU_MIN_SESSIONS
// already uses between the two files.
// Power is the one phase NASM itself doesn't reduce to a single range (paired heavy/explosive
// sets) -- CrewFit has no concept of a paired/superset target, so this uses the heavy side (1-5)
// for the progression check. A real limitation, not an oversight -- flagged to Jeff alongside this
// build rather than silently picked.
const TRAINING_PHASE_RANGES = {
  stabilization: { lo: 12, hi: 20 },
  strength_endurance: { lo: 8, hi: 12 },
  hypertrophy: { lo: 6, hi: 12 },
  max_strength: { lo: 1, hi: 5 },
  power: { lo: 1, hi: 5 },
};
const TRAINING_PHASE_KEYS = new Set(Object.keys(TRAINING_PHASE_RANGES));

function repRange(e, phase) {
  // A user who has never opened the training-focus picker has no phase on their record at all --
  // repRange must behave BYTE-IDENTICAL to before this feature existed for them (Jeff: "nobody's
  // rep targets silently change the day this ships"). Only a real, saved phase pick overrides the
  // exercise's own configured range.
  if (phase && TRAINING_PHASE_KEYS.has(phase)) return TRAINING_PHASE_RANGES[phase];
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

// Sep 2026 library audit (Jeff: "Flat Dumbbell Press ... should say Flat Dumbbell Bench Press",
// "Bulgarian split squats should be just one dumbbell", "make corrections throughout the entire
// exercise library"). Everything in this app keys off the exercise NAME string -- logged sets
// (exerciseName), PRs (rebuilt from those), favorites, trend picks, seeded lifts, routines, swap
// variations, pending suggestions and finish history -- so renaming a library entry without
// touching stored data would split every user's history in two: "Flat Dumbbell Press" up to
// today, "Flat Dumbbell Bench Press" from tomorrow, with the PR and the progression suggestion
// lost in between. This map is the single source of truth for old -> current name; the migration
// below walks every stored reference through it on boot. Idempotent (a name already current is
// left alone), and it runs BEFORE rebuildAllPrs so PRs regroup under the new names in the same
// boot. Merged duplicates (Cable Crossover -> Cable Fly) go through the same map. When a future
// audit renames or merges an entry, add it HERE, never just in exercise-library.json.
const EXERCISE_RENAMES = {
  "Flat Dumbbell Press":                "Flat Dumbbell Bench Press",
  "Incline Dumbbell Press":             "Incline Dumbbell Bench Press",
  "Decline Dumbbell Press":             "Decline Dumbbell Bench Press",
  "Incline Machine Press":              "Incline Machine Chest Press",
  "Incline Smith Machine Press":        "Incline Smith Machine Bench Press",
  "Overhead Barbell Press":             "Barbell Overhead Press",
  "Strict Dumbbell Shoulder Press":     "Standing Dumbbell Shoulder Press",
  "Seated Dumbbell Press":              "Seated Dumbbell Shoulder Press",
  "Single-Arm Dumbbell Press":          "Single-Arm Dumbbell Shoulder Press",
  "Lateral Raise":                      "Dumbbell Lateral Raise",
  "Front Raise":                        "Dumbbell Front Raise",
  "Rear Delt Fly":                      "Dumbbell Rear Delt Fly",
  "W Raises":                           "Dumbbell W Raise",
  "Y Raises":                           "Dumbbell Y Raise",
  "Shrugs":                             "Barbell Shrug",
  "Dip (Triceps)":                      "Triceps Dip",
  "Overhead Dumbbell Extension":        "Overhead Dumbbell Triceps Extension",
  "Skull Crusher":                      "EZ-Bar Skull Crusher",
  "Triceps Kickback":                   "Dumbbell Triceps Kickback",
  "Wide-Grip Pulldown":                 "Wide-Grip Lat Pulldown",
  "Close-Grip Pulldown":                "Close-Grip Lat Pulldown",
  "Neutral-Grip Pulldown":              "Neutral-Grip Lat Pulldown",
  "Hammer Curl":                        "Dumbbell Hammer Curl",
  "Preacher Curl":                      "EZ-Bar Preacher Curl",
  "Spider Curl":                        "EZ-Bar Spider Curl",
  "21s Curl":                           "Barbell 21s Curl",
  "Cable Curl (Single Arm)":            "Single-Arm Cable Curl",
  "Crunches":                           "Crunch",
  "Scissor Kicks":                      "Scissor Kick",
  "Toe Touchers":                       "Toe Touch Crunch",
  "Treadmill Walk (incline)":           "Incline Treadmill Walk",
  "Deadlift (Romanian) to Row":         "Dumbbell Romanian Deadlift to Row",
  "Wrist Curl":                         "Dumbbell Wrist Curl",
  "Reverse Wrist Curl":                 "Dumbbell Reverse Wrist Curl",
  "Good Morning (Seated)":              "Seated Good Morning",
  "Split Squat (static)":               "Split Squat",
  "Assisted Pull-Up (Machine)":         "Machine-Assisted Pull-Up",
  "Hip Abduction Machine":              "Machine Hip Abduction",
  "Hip Adduction Machine":              "Machine Hip Adduction",
  "B-stance Hip Thrust":                "B-Stance Hip Thrust",
  "Cable Kickback":                     "Cable Glute Kickback",
  "Banded Pull-Apart":                  "Band Pull-Apart",
  "Romanian Deadlift":                  "Barbell Romanian Deadlift",
  "Hip Thrust":                         "Barbell Hip Thrust",
  "Overhead Rope Extension":            "Rope Overhead Triceps Extension",
  "Single-Arm Cable Overhead Extension": "Single-Arm Cable Overhead Triceps Extension",
  // merged duplicates -> the entry that survived
  "Bulgarian Split Squat (Dumbbell)":   "Bulgarian Split Squat",
  "Calf Raise on Leg Press":            "Leg Press Calf Raise",
  "Dumbbell Floor Press (Triceps)":     "Dumbbell Floor Press",
  "Lying Triceps Extension (EZ)":       "EZ-Bar Skull Crusher",
  "Plate Press":                        "Svend Press",
  "Cable Crossover":                    "Cable Fly",
  "Bent-Over Lateral Raise":            "Dumbbell Rear Delt Fly",
  "Machine Rear Delt Fly":              "Reverse Pec Deck",
  "Cable Rope Curl":                    "Rope Hammer Curl",
  "Dumbbell Bayesian Curl":             "Incline Dumbbell Curl",
  "Landmine Chest Press":               "Landmine Press",
  "Fan Bike":                           "Assault Bike",
  "Step Mill":                          "Stair Climber",
  "Machine Fly":                        "Pec Deck",
  "Triceps Pushdown (V-Bar)":           "V-Bar Pushdown",
};
function currentExerciseName(name) {
  return (typeof name === 'string' && Object.prototype.hasOwnProperty.call(EXERCISE_RENAMES, name))
    ? EXERCISE_RENAMES[name] : name;
}
function migrateExerciseRenames() {
  let n = 0;
  const ren = (v) => { const c = currentExerciseName(v); if (c !== v) n++; return c; };
  // a list of names where the same lift must not appear twice after two old names collapse into one
  const renList = (arr) => {
    const out = []; for (const v of arr) { const c = ren(v); if (!out.includes(c)) out.push(c); }
    return out;
  };
  for (const u of Object.values(DB.users || {})) {
    if (!u || typeof u !== 'object') continue;
    if (Array.isArray(u.favoriteExercises)) u.favoriteExercises = renList(u.favoriteExercises);
    if (Array.isArray(u.trendPicks)) u.trendPicks = renList(u.trendPicks);
    if (u.seeded && typeof u.seeded === 'object') {
      for (const k of Object.keys(u.seeded)) {
        const c = ren(k);
        if (c === k) continue;
        if (!u.seeded[c]) u.seeded[c] = u.seeded[k];      // a seed already under the new name wins
        delete u.seeded[k];
      }
    }
  }
  for (const s of Object.values(DB.sessions || {})) {
    if (!s || typeof s !== 'object') continue;
    for (const e of (s.exercises || [])) if (e && typeof e.name === 'string') e.name = ren(e.name);
    for (const arr of Object.values(s.logs || {})) for (const l of (arr || [])) {
      if (l && typeof l.exerciseName === 'string') l.exerciseName = ren(l.exerciseName);
    }
    for (const perUser of Object.values(s.variations || {})) for (const v of Object.values(perUser || {})) {
      if (v && typeof v.swapTo === 'string') v.swapTo = ren(v.swapTo);
    }
    for (const e of (s.suggestedEdits || [])) if (e && typeof e.swapTo === 'string') e.swapTo = ren(e.swapTo);
    for (const h of (s.history || [])) if (h && Array.isArray(h.exercises)) h.exercises = h.exercises.map(ren);
  }
  for (const t of Object.values(DB.templates || {})) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.exercises)) continue;   // templates get no shape-heal pass; never let one bad row stop boot
    for (const e of t.exercises) if (e && typeof e.name === 'string') e.name = ren(e.name);
  }
  if (n) console.log('migrateExerciseRenames: moved ' + n + ' stored reference(s) to current library names');
  return n;
}

// Sep 30 2026 (audit finding, custom exercise edit/delete): every custom exercise created before
// today has no `id` -- POST /api/exercises/custom never assigned one, and name alone can't address
// one to edit/delete now that duplicate names are explicitly allowed (see that route's own
// comment) -- two of a user's own exercises can share a name on purpose. Backfills a stable id
// once, here, rather than generating one fresh on every read (which would be a different id each
// time and useless for a later PUT/DELETE to actually find the same row again).
function migrateCustomExerciseIds() {
  let n = 0;
  for (const arr of Object.values(DB.customExercises || {})) {
    for (const e of (arr || [])) {
      if (e && typeof e === 'object' && !e.id) { e.id = crypto.randomUUID(); n++; }
    }
  }
  if (n) console.log('migrateCustomExerciseIds: assigned ' + n + ' id(s)');
  return n;
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
        // Sep 28 2026 (audit finding, Jeff: "Workout timestamps drift by a minute: Profile lists
        // 'Sep 27, 10:19 PM' (finish), Records and Activity say '10:18 PM' (start). Pick one."):
        // _performedAt used to be s.scheduledAt unconditionally -- WHEN the workout was PLANNED to
        // start, not when it actually happened -- while Profile's own "Your Workouts" list (see
        // profileOf, `at: post ? post.at : ...`) already preferred the recap-post time. Same
        // priority now, everywhere: the posted recap's own timestamp first (matches Profile
        // exactly whenever a recap was posted, the common case), else the real finish moment
        // (s.history's own `at`, stamped by creditFinish at /lock -- more precise than scheduledAt
        // for a workout that was finished but never posted), else the old scheduledAt/l.at
        // fallback for a session that's still in progress and has neither.
        const hist = (s.history || []).find(h => h.userId === userId);
        const post = s.posts && s.posts[userId];
        // non-persisted: the training date, used for ordering only
        Object.defineProperty(l, '_performedAt', {
          value: perfDate(post && post.at, perfDate(hist && hist.at, perfDate(s.scheduledAt, l.at))),
          enumerable: false, configurable: true });
        // Oct 2 2026 (deep audit finding, privacy leak): non-persisted, same shape as _performedAt
        // -- which session this set actually came from, carried through to the final PR record
        // below so profileOf/buildActivityFor can gate a PR on ITS OWN session's post.visibility,
        // not just profile-level follow approval (see the comment on `prs`/`viewerCanSee` in
        // profileOf for the full reasoning).
        Object.defineProperty(l, '_sessionId', { value: s.id, enumerable: false, configurable: true });
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
      // Sep 28 2026 (cold-review catch on the firstLog/setFirstLog addition above): firstLog can't
      // be based on `chronological[0]` (sorted by `_performedAt`) the way the weight/date fields
      // are -- `_performedAt` now prefers the session's finish/post time (see the comment on it in
      // the grouping loop above), which can jump FORWARD every time /lock or /unlock reruns this
      // function. Leave a session open for days, log a real PR in a separate, already-finished
      // later session in between, then finally lock the old one: the old session's _performedAt
      // jumps to "now" (its late finish time), pushing it chronologically AFTER the later session's
      // already-recorded PR -- which flips that later, genuinely-not-first log's firstLog to true
      // and silently hides its earned PR/VOLUME badge on next render, purely because an unrelated
      // session got locked late. `l.at` (stamped once, at the moment that specific set was actually
      // logged) never gets rewritten by a later /lock or /unlock, so it's the only stable signal for
      // "was this genuinely the very first attempt ever" -- used ONLY for that question, not for the
      // `.at`/`setAt` display timestamps below, which correctly keep preferring the finish/post time.
      const everByAt = groups[userId][name].slice().sort((a, b) => new Date(a.at) - new Date(b.at));
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
      // Sep 11 2026, Jeff: "assisted machine pull ups - the more weight actually makes it easier
      // and more of an assist. the less weight the better." loadType==='assisted' (see the _note
      // atop exercise-library.json) is the ONE exercise class where the entered number runs
      // backwards from every other lift — a counterweight/assist machine's number is how much of
      // your own bodyweight is being taken OFF, so LESS of it is the harder, more impressive set.
      // `assisted` below flips "better" to a lower number for this whole function's weight record;
      // trendFor/plateausFor (search loadType==='assisted' there) get the same treatment for the
      // same reason, and recommendationsFor flips which direction "add weight" suggests next.
      // The weight×reps "VOLUME" record just below is deliberately SKIPPED entirely for assisted
      // (Jeff, confirmed): less-assist-but-more-reps has no coherent "bigger number is better"
      // meaning the way weight×reps does for every other loadType, so bestSetLog/isSetPr simply
      // never gets set, and setPr reads null downstream (see recordsFor/GET /api/progress) exactly
      // like it already does for any exercise with no set-PR yet.
      const assisted = loadTypeForName(name) === 'assisted';
      let bestW = assisted ? Infinity : -1, bestR = -1, bestLog = null;
      // Sep 9 2026, Jeff: "a set of 10 at my heaviest weight ive ever done is just as significant
      // as a set of 2 just trying my max out on a weight." The weight record above can never
      // recognize that — a heavier single/double always outranks it no matter how many reps a
      // lighter set got, so a big, hard-earned set at a real (not-quite-max) weight got zero
      // recognition. This is a SECOND, independent "best ever" search over the exact same sets,
      // comparing total weight moved in the set (weight × reps) instead of weight alone. It runs
      // in the same pass so a set can win neither, one, or both records without the two ever
      // being compared against each other.
      let bestVol = -1, bestVolR = -1, bestSetLog = null;
      for (const l of chronological) {
        l.isPr = false;                       // cleared for every set; the winner is set below
        l.isSetPr = false;                    // same, for the weight×reps record below
        // v253 (audit finding): warm-ups and drop sets are deliberately NOT working sets (Jeff's
        // call — see WORKING_SET_TYPES/isWorkingSet above, and CLAUDE.md). The two other places
        // that decide "did this count" already skip them (search isWorkingSet(l) above), but this
        // PR-picking loop never did — a heavy warm-up or an easy drop set could become someone's
        // recorded all-time PR, and everything downstream (the profile PR card, the celebratory
        // feed item, beatSeed's "new record" check) trusted it as real.
        if (!isWorkingSet(l)) continue;
        // compare in lb regardless of what each set was typed in
        const w = toLb(l.weight, l.unit), r = Number(l.reps) || 0;
        const better = r > 0 && (assisted
          ? (w < bestW || (w === bestW && r > bestR))
          : (w > bestW || (w === bestW && r > bestR)));
        if (better) { bestW = w; bestR = r; bestLog = l; }
        if (assisted) continue;               // no VOLUME/set-PR for assisted — see the comment above
        // Same lb-normalized weight, but the number being compared is weight × reps. Bodyweight
        // sets (w===0, e.g. a Pull-Up) hit the exact pitfall the comment above already names for
        // the weight loop: volume is 0×reps=0 no matter the reps, so the FIRST bodyweight set ever
        // logged would become an unbeatable "record" forever, and every later, harder set (more
        // reps, same 0 weight) would never touch it. Same fix as the weight loop: tie-break on reps
        // instead of raw volume, so among equal-volume sets (bodyweight sets always tie at 0) more
        // reps still wins. A genuine tie (identical weight AND reps) just keeps whichever was found
        // first, same as the weight record above.
        const vol = r > 0 ? w * r : -1;
        const betterVol = r > 0 && (vol > bestVol || (vol === bestVol && r > bestVolR));
        if (betterVol) { bestVol = vol; bestVolR = r; bestSetLog = l; }
      }
      if (bestLog) {
        bestLog.isPr = true;
        if (bestSetLog) bestSetLog.isSetPr = true;   // never set for assisted — bestSetLog stays null
        // Jeff, Aug 21: "every new first rep will be considered a PR" -- a brand-new user's very
        // first-ever session, trying several exercises for the first time each, used to post one
        // "hit a new PR" feed item per exercise even though none of them beat anything. The
        // current record holder is the chronologically FIRST log for this (user, exercise) pair
        // exactly when nothing since has ever beaten it -- whether that's because there is
        // literally only one log, or because every later attempt fell short. Either way, that
        // record was never the result of an improvement, so it's a baseline, not an earned PR.
        // Still shown as the user's current best on their OWN profile (see profileOf's `prs`) --
        // just excluded from the celebratory feed/activity items (see groupPrsForFeed).
        const firstLog = bestLog === everByAt[0];
        const setFirstLog = bestSetLog === everByAt[0];
        // Sep 28 2026 (audit finding, Jeff: "Barbell Row 95x8 got a PR badge and appeared in the
        // finish screen's '2 personal records,' but it's not in the Activity feed ... A first-ever
        // log of a lift shouldn't be a PR anywhere -- that's the cleaner rule."): firstLog/setFirstLog
        // were only ever written into DB.prs, so groupPrsForFeed (the ONE place that reads DB.prs
        // for this) correctly excluded a first-ever log, but every OTHER celebratory surface reading
        // isPr/isSetPr straight off the log entry itself -- the finish screen's own PR count/list,
        // the live "PR" badge on a just-logged set -- had no way to apply the same exclusion and
        // counted it anyway. Stamped onto the log entry itself now, right alongside isPr/isSetPr, so
        // every surface can apply Jeff's own rule the same way groupPrsForFeed already does: a
        // celebratory PR is `isPr && !firstLog` (or `isSetPr && !setFirstLog`), never isPr alone.
        bestLog.firstLog = firstLog;
        if (bestSetLog) bestSetLog.setFirstLog = setFirstLog;
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
        // setWeight/setReps/setUnit/setAt/setFirstLog live on this SAME per-(user,exercise) object
        // rather than a separate table — no new persistence plumbing needed, since DB.prs[userId]
        // is already stored as one jsonb blob per user (see db.js's prs table).
        DB.prs[userId][name] = { exercise: name, weight: Number(bestLog.weight) || 0,
          reps: Number(bestLog.reps) || 0, unit: bestLog.unit || 'lb',
          at: bestLog._performedAt || bestLog.at, firstLog,
          // Oct 2 2026 (deep audit finding): which session this record was actually set in --
          // see the comment on l._sessionId above and on `prs`/`viewerCanSee` in profileOf.
          sessionId: bestLog._sessionId,
          // bestSetLog is null for assisted (see the comment above) — the set*/VOLUME fields are
          // simply omitted rather than written as zeros, so recordsFor()'s
          // `earnedPr.setWeight !== undefined` check (and GET /api/progress's identical one) reads
          // this exactly like any other exercise with no set-PR yet: setPr comes back null, no
          // VOLUME pill renders. Object.assign lets the ternary contribute nothing at all instead
          // of contributing undefined-valued keys, which `!== undefined` would still see as present.
          ...(bestSetLog ? { setWeight: Number(bestSetLog.weight) || 0, setReps: Number(bestSetLog.reps) || 0,
            setUnit: bestSetLog.unit || 'lb', setAt: bestSetLog._performedAt || bestSetLog.at,
            setFirstLog,
            // bestSetLog (the VOLUME/set-record winner) can be a DIFFERENT session than bestLog
            // (the weight-record winner) for the same exercise -- its own sessionId, so a viewer
            // who can see the weight record's session but not the set record's session doesn't
            // get the set record's weight/reps leaked through anyway.
            setSessionId: bestSetLog._sessionId } : {}) };
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
  // This is the one true "just finished a workout" moment, so it's also where a crew challenge
  // this user belongs to notices it's been won -- checked only on an actual new credit, not a
  // repeat /lock ping, same reasoning as the save() just below. ranksBefore (Activity page) is
  // captured before creditFinish runs -- see emitFinishFeedEvents' own comment on why it must be.
  const ranksBefore = crewRanksSnapshot(req.userId);
  if (creditFinish(s, req.userId, req.body && req.body.localDate)) {
    checkCrewChallenges(req.userId);
    emitFinishFeedEvents(s, req.userId, ranksBefore, req.body && req.body.localDate);
    // Oct 9 2026 (audit finding, see markSessionStarted's own comment above): if nobody ever
    // tapped Start/Join now, this finish is the first unambiguous proof the workout really
    // happened -- back-date startedAt/scheduledAt to the EARLIEST real log across every
    // participant (closer to the truth than "now"), so the recap no longer permanently shows
    // whatever time this was originally scheduled for. Computed BEFORE rebuildAllPrs() just below,
    // same reasoning as that fix's own PR-snapshot-ordering note.
    if (!s.startedAt) {
      let earliest = null;
      for (const uid_ of Object.keys(s.logs || {})) {
        for (const l of (s.logs[uid_] || [])) {
          if (!earliest || new Date(l.at) < new Date(earliest)) earliest = l.at;
        }
      }
      markSessionStarted(s, earliest);
    }
    // Sep 28 2026 (audit finding, Jeff: "Workout timestamps drift by a minute: Profile lists the
    // finish time, Records and Activity say the start time"): rebuildAllPrs' _performedAt now
    // prefers this user's s.history finish timestamp (stamped by creditFinish just above) over
    // scheduledAt -- but every PR/record in DB.prs was still only a SNAPSHOT taken back at log
    // time, before this history row existed, so it kept the old scheduledAt-based value forever
    // unless something logged again afterward. /lock is exactly the moment that history row is
    // created, so it's also exactly the moment the snapshot needs to be retaken.
    rebuildAllPrs();
    await save(DB);
  }
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
// harmless no-op. Streak and weekly volume are derived from s.history at query time (see
// currentStreak et al), so removing a row here needs no other cache invalidated for those. PRs are
// the one exception (Sep 28 2026 audit finding): DB.prs' own `.at` is a SNAPSHOT taken by
// rebuildAllPrs, now preferring this same s.history entry's finish timestamp (see its comment) --
// without a rebuild here too, undoing a finish would leave that snapshot stamped with a finish time
// that no longer happened until some unrelated later action anywhere happens to trigger the next
// global rebuild. Cheap and already called from far hotter paths (every single set log) -- see the
// same reasoning in /lock and /post above.
app.post('/api/sessions/:id/unlock', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  const before = s.history.length;
  s.history = s.history.filter(h => h.userId !== req.userId);
  if (s.history.length !== before) { rebuildAllPrs(); await save(DB); }
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
  // Sep 6: editing an already-posted recap (notes autosave on the active screen, editPostNotes,
  // adding a photo) keeps the ORIGINAL post time. `at` is what the feed sorts by, what the profile
  // dates the workout with, and what a crew challenge's window checks -- re-stamping it on every
  // edit bumped an old recap to the top of everyone's feed each time a sentence was tweaked
  // (cold-review catch, once notes started saving themselves while typing) and could drag a
  // last-month workout into this week's challenge. A recap is posted once; edits are edits.
  const existingAt = s.posts[req.userId] && typeof s.posts[req.userId].at === 'string' ? s.posts[req.userId].at : null;
  // Sep 23 2026 (audit finding): the "with @X, Y" collaborator line on a posted recap (viewPost in
  // app.js) used to rebuild itself from the CURRENT s.participants on every single view, instead of
  // who was actually training alongside this author when they posted -- so someone who genuinely
  // trained that session but later left (even choosing to keep their credit) or was kicked silently
  // vanished from a recap that was already posted, understating who was really there. Snapshot it
  // once, same "posted once, edits are edits" precedent `at` above already set for this exact
  // reason -- re-saving notes/a photo later must not reset it, and a departure afterward must not be
  // able to rewrite history either. A legacy recap with no snapshot yet (existingTrainedWith null)
  // takes one the first time it's touched again after this shipped -- better late than never, and
  // it only ever moves it from "recomputed live, always" to "fixed as of now," never worse.
  const existingTrainedWith = (s.posts[req.userId] && Array.isArray(s.posts[req.userId].trainedWith))
    ? s.posts[req.userId].trainedWith : null;
  s.posts[req.userId] = {
    at: existingAt || new Date().toISOString(),
    notes: String(notes || '').slice(0, 2000),
    media: cleanMedia,
    visibility: vis,
    comments: existingComments,
    reactions: existingReactions,
    // Sep 24 2026 (audit finding): this used to snapshot every CURRENT participant, including
    // someone approved into a public workout who never opened it or logged a single set -- "with
    // @X" credited a person for training that never actually happened for them. Scoped to people
    // who have actually logged something on this session, same "did they really do it" bar the
    // rest of the app already applies (sessionTier's own 'alumni' tier, canFinishOrPost, etc).
    trainedWith: existingTrainedWith || (s.participants || []).filter(pid =>
      pid !== req.userId && s.logs && Array.isArray(s.logs[pid]) && s.logs[pid].length > 0)
  };
  // Cold-review catch (Sep 4): a real post now exists with its own notes -- including possibly
  // blank, if that's what the person actually typed/left. A leftover draft from before they
  // posted must not go on masquerading as "what to prefill" the next time they reopen this
  // screen (e.g. tapping "Add a photo/video" on an already-posted recap re-opens showSavePage),
  // or a discarded draft could silently overwrite an intentionally-blank real recap on the next
  // unrelated save. The draft did its job (getting notes typed during the workout to this point);
  // once posted, s.posts[req.userId].notes is the one source of truth.
  if (s.draftNotes) delete s.draftNotes[req.userId];
  // Sep 28 2026 (audit finding, timestamp drift -- see the matching comment in /lock above):
  // _performedAt/DB.prs' own `at` prefer this user's posted-recap timestamp (s.posts[userId].at,
  // just set above) over the finish/scheduledAt fallbacks -- posting is exactly the moment that
  // field starts existing (or, on an edit, stays the same by design -- existingAt above), so the
  // snapshot needs retaking here too, the same as /lock.
  rebuildAllPrs();
  await save(DB);
  res.json(sessionView(s, req.userId));
});
// ---- Draft notes on an ACTIVE (not yet posted) session ----
// Jeff, Sep 4: "Can we add the notes section that we fill after the workout - also within the
// workout while its active." Deliberately its OWN field, not a write into s.posts -- s.posts[me]
// existing is exactly what profileOf() (below) counts as "workout completed" for the Workouts
// stat/profile list, AND what the friends'-activity feed (GET /api/feed) reads as "finished a
// workout" for the recap row it shows your connections. Routing draft notes through /post would
// have quietly marked a still-in-progress workout as done and broadcast it to friends before you
// ever hit Log & Finish. draftNotes is scratch, own-eyes-only (see sessionView's member-tier
// branch, which deliberately does not spread the whole s.draftNotes object to other members) --
// the client reads it back as a starting point once you actually post your real recap.
app.post('/api/sessions/:id/draft-notes', auth, async (req, res) => {
  const s = DB.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  ensureSessionShape(s);
  if (!canFinishOrPost(s, req.userId)) return res.status(403).json({ error: 'not in this workout' });
  const { notes } = req.body || {};
  s.draftNotes[req.userId] = String(notes || '').slice(0, 2000);
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
    notify(req.params.authorId, { title: 'New reaction', body: `${DB.users[req.userId].displayName} reacted to your workout`, link: { type: 'post', sessionId: s.id, authorId: req.params.authorId } });
  res.json({ reacted, count: p.reactions.length });
});
// ---- Reactions on an Activity-page feed event ----
// Sep 11 2026: same toggle shape as the posts reaction just above ({reacted, count}, bare-userId-
// array storage), for the OTHER kind of like -- an ephemeral feed event (PR, crew win, etc; see
// the "Feed events" comment above emitFeedEvent) rather than a permanent posted recap. Visibility:
// a shared crew event (challenge_completed, `by: null`) is reactable by any current member of that
// crew; every other type is reactable by the actor themselves or anyone connected to them, the
// same "can you even see this in your feed" gate GET /api/feed itself applies.
app.post('/api/feed-events/:id/react', auth, async (req, res) => {
  const ev = DB.feedEvents[req.params.id];
  if (!ev) return res.status(404).json({ error: 'not found' });
  // Oct 2 2026 (deep audit finding): same current-membership fix as GET /api/feed's own
  // ev.by===null branch -- a departed member could otherwise keep reacting to their old crew's
  // challenge-completed card forever (see that comment for the full reasoning).
  const allowed = ev.by === null
    ? (() => { const crew = ev.crewId && DB.crews[ev.crewId]; return !!crew && isCrewMember(crew, req.userId); })()
    : ev.by === req.userId || connectionsOf(req.userId).includes(ev.by);
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  ev.reactions = Array.isArray(ev.reactions) ? ev.reactions.filter(x => typeof x === 'string') : [];
  const i = ev.reactions.indexOf(req.userId);
  const reacted = i === -1;
  if (reacted) ev.reactions.push(req.userId); else ev.reactions.splice(i, 1);
  await save(DB);
  if (reacted && ev.by && ev.by !== req.userId)
    notify(ev.by, { title: 'New reaction', body: `${DB.users[req.userId].displayName} reacted to your activity`, link: { type: 'profile', userId: ev.by } });
  res.json({ reacted, count: ev.reactions.length });
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
  // Sep 8 2026 (cold-review finding): canSeePostAuthor above only checks the block relationship
  // between the VIEWER and the POST's author -- it says nothing about the individual COMMENTER,
  // who may be a third party neither the viewer nor the post author has any block relationship
  // with. Without this, two users who've blocked each OTHER could still react to (and notify) one
  // another through a shared, unrelated third party's comment thread -- a direct interaction the
  // block was supposed to prevent, even though neither of them is the post's own author.
  if (isBlocked(c.userId, req.userId)) return res.status(403).json({ error: 'forbidden' });
  c.reactions = Array.isArray(c.reactions) ? c.reactions.filter(x => typeof x === 'string') : [];
  const i = c.reactions.indexOf(req.userId);
  const reacted = i === -1;
  if (reacted) c.reactions.push(req.userId); else c.reactions.splice(i, 1);
  await save(DB);
  if (reacted && c.userId !== req.userId)
    notify(c.userId, { title: 'New reaction', body: `${DB.users[req.userId].displayName} reacted to your comment`, link: { type: 'post', sessionId: s.id, authorId: req.params.authorId } });
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
  migrateExerciseRenames();   // after the stamp above (it walks exerciseName), before the PR regroup
  migrateCustomExerciseIds(); // backfill ids for edit/delete -- order doesn't matter, nothing else depends on them yet
  rebuildAllPrs();
  migrateLoadTypes();
  pruneOldNotifications();    // storage hygiene, not a schema migration -- see its own comment
  pruneOldFeedEvents();       // same, for the Activity page's ephemeral feed events
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

  // Sep 5 2026: notification-history storage hygiene (see pruneOldNotifications, and the boot-
  // time call to it above) -- every few hours is plenty for a 7-day retention window; this is
  // cleanup, not a user-facing feature, so it doesn't need the same tight cadence as the
  // reminder timers above.
  setInterval(async () => {
    try { if (pruneOldNotifications()) await save(DB); }
    catch (e) { console.error('notification history prune failed:', e && e.message); }
  }, 6 * 60 * 60 * 1000);

  // Sep 11 2026: same storage-hygiene sweep as notifications above, for the Activity page's
  // ephemeral feed events (see pruneOldFeedEvents and the "Feed events" comment above it).
  setInterval(async () => {
    try { if (pruneOldFeedEvents()) await save(DB); }
    catch (e) { console.error('feed event prune failed:', e && e.message); }
  }, 6 * 60 * 60 * 1000);
})().catch(e => {
  console.error('FATAL during boot:', e && e.stack || e);
  process.exit(1);
});
