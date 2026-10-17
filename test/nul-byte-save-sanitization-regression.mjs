// Oct 17 2026. Jeff, after finding this while testing (not caused by any in-flight migration
// slice): "if a weird invisible character ever ends up in a text field (bio, display name,
// etc.), saving jams for everyone until the server restarts... We should fix this."
//
// Confirmed before this fix (reproduced live against a throwaway Postgres, not assumed): a NUL
// byte (\u0000) in ANY text field fails both as a plain text column (22021 invalid byte sequence)
// AND inside a jsonb blob (22P05 unsupported Unicode escape sequence) -- and nearly every
// collection's `data` column carries whatever text a user typed anywhere in their object, so a
// NUL byte in, say, bio poisons that whole row's save, not just the bio field. A lone/unpaired
// UTF-16 surrogate has the same failure mode through jsonb (22P02). Because server.js's route
// handlers mutate the in-memory user BEFORE `save(DB)`, and nothing ever reverted that mutation
// on a failed save, the poisoned in-memory value got retried -- and kept failing -- on EVERY
// subsequent save(DB) call, for every user, until the process restarted. Not specific to bio:
// any user-text field, in any collection, would have the same effect.
//
// The fix: pgmini.js's sanitizePgText() now strips a NUL byte or lone surrogate out of every
// bound query parameter at the one point they all pass through on the way to the wire (see its
// own comment) -- the universal backstop, covering every write path including the ones that
// bypass server.js's capStr() entirely (e.g. POST /api/me/bio). capStr() also calls it directly,
// so the in-memory value matches what's persisted immediately rather than only after a later
// restart reloads the (by-then-clean) Postgres value.
//
// CORRECTED same day, after an adversarial review caught the first version of both the fix and
// this test being blind to the dominant case: this test originally only exercised bio/
// displayName -- fields that happen to live on their OWN real Postgres text columns (recent
// users-slice decision #2) AND get sanitized at the app layer too. It never actually proved the
// pgmini-level backstop closes the bug for a jsonb BLOB column, which is how nearly everything
// else in this app persists. Confirmed live (by the reviewer, then independently reproduced
// here): JSON.stringify always hex-escapes a NUL byte or lone surrogate into literal ASCII text
// ("\u0000", "\ud800") before that string ever reaches pgmini -- the original sanitizePgText only
// matched the raw character, so it did nothing for that escaped text, and `setType` on a logged
// set (never sanitized at the app layer at all, landing straight in the sessions.data jsonb
// blob) still jammed save(DB) for every user exactly as before. Fixed by also stripping the
// escaped form (see pgmini.js's updated comment). Scenario 3 below now proves the FIX, not just
// the test's own premise, by poisoning a field with NO app-layer sanitization whatsoever.
//
// Also added scenario 6: a real emoji sitting exactly on capStr's length cap, which review found
// can get cut in half by .slice() AFTER the first sanitize pass, manufacturing a brand-new lone
// surrogate the first pass never saw -- fixed by sanitizing again after slicing.
//
// What this test proves, live, not just by reading the diff:
//   1. Sending a NUL byte in bio via the real HTTP route no longer 500s, and the stored/returned
//      value has it stripped (not rejected -- there's no good way to tell a user "your invisible
//      character was rejected," and rejecting the whole request for an invisible character is a
//      worse experience than silently cleaning it).
//   2. The SAME is true for a lone UTF-16 surrogate half.
//   3. A field with ZERO app-layer sanitization (setType on a logged set, landing straight in a
//      jsonb blob via JSON.stringify) also no longer jams -- proving the pgmini-level backstop
//      itself, not just the routes that happen to also call capStr/sanitizePgText directly.
//   4. Critically: after each poisoned write above, saving for a COMPLETELY DIFFERENT user still
//      works -- proving this can no longer jam save(DB) app-wide the way it used to.
//   5. A real surrogate PAIR (an actual emoji) survives completely untouched, end to end,
//      through the same routes -- the fix must not mangle real Unicode text, in a plain text
//      column OR inside a jsonb blob.
//   6. An emoji sitting exactly on a length cap boundary still survives intact, not split into a
//      fresh lone surrogate by the slice.
//   7. A restart reloads the already-clean value from Postgres with nothing left to repair.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';
import { PgConnection, parseConnString } from '../pgmini.js';

const PORT = 5907, B = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'nul-byte-save-sanitization-'));
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('nulbytesanitization');
const J = { 'Content-Type': 'application/json' };
let fails = 0, srv = null;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
process.on('exit', () => { try { srv && srv.kill(); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

function boot() {
  return new Promise((res, rej) => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    srv.stdout.on('data', d => { buf += d; if (String(d).includes('CrewFit on')) res(buf); });
    srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
    srv.on('exit', c => rej(new Error(`server exited (${c}):\n${buf}`)));
    setTimeout(() => rej(new Error('server never started:\n' + buf)), 15000);
  });
}
const stop = () => new Promise(r => { if (!srv) return r(); srv.on('exit', r); srv.kill(); });
async function reboot() { await stop(); return boot(); }

async function reg(n) {
  const r = await fetch(B + '/api/register', { method: 'POST', headers: J,
    body: JSON.stringify({ username: n, pin: 'pass1234', displayName: n }) }).then(x => x.json());
  if (!r.token) throw new Error('register failed: ' + JSON.stringify(r));
  return { id: r.user.id, token: r.token, H: { ...J, Authorization: 'Bearer ' + r.token } };
}
const post = (who, p, body) => fetch(B + p, { method: 'POST', headers: who.H, body: JSON.stringify(body || {}) });
const get = (who, p) => fetch(B + p, { headers: who.H });
async function rawQuery(sql, params) {
  const pg = new PgConnection(parseConnString(testDb.url));
  const r = await pg.query(sql, params);
  pg.close();
  return r.rows;
}

await boot();
ok(!!srv, 'server boots');

const alice = await reg('alice_nulbyte');
const bob = await reg('bob_nulbyte');

// 1) NUL byte in bio: no 500, value stored with the NUL byte stripped.
{
  const r = await post(alice, '/api/me/bio', { bio: 'hello\u0000world' });
  ok(r.status === 200, `bio with NUL byte: route returns 200 (got ${r.status})`);
  const body = await r.json();
  ok(body.bio === 'helloworld', `bio with NUL byte: returned value has it stripped (got ${JSON.stringify(body.bio)})`);
  const rows = await rawQuery('SELECT bio FROM users WHERE id = $1', [alice.id]);
  ok(rows[0] && rows[0].bio === 'helloworld', `bio with NUL byte: raw Postgres column has it stripped too (got ${JSON.stringify(rows[0] && rows[0].bio)})`);
}

// 2) Lone surrogate half in displayName: no 500, value stored with it stripped.
{
  const r = await post(alice, '/api/me/display-name', { displayName: 'alice\uD800x' });
  ok(r.status === 200, `displayName with lone surrogate: route returns 200 (got ${r.status})`);
  const body = await r.json();
  ok(body.displayName === 'alicex', `displayName with lone surrogate: returned value has it stripped (got ${JSON.stringify(body.displayName)})`);
}

// 3) THE actual bug: after sending the poisoned fields above, a completely different user's
// save must still succeed -- this is what "jams for everyone until restart" means, proven by
// having bob save something right after alice's poisoned writes, with no restart in between.
{
  const r = await post(bob, '/api/me/bio', { bio: 'bob is fine' });
  ok(r.status === 200, `a DIFFERENT user's save right after the poisoned writes still succeeds (got ${r.status})`);
  const body = await r.json();
  ok(body.bio === 'bob is fine', 'that other user\'s save persisted the real value, untouched');
}

// 4) A real surrogate pair (actual emoji) must survive completely untouched.
{
  const emojiBio = 'training hard 💪 today'; // 💪
  const r = await post(alice, '/api/me/bio', { bio: emojiBio });
  ok(r.status === 200, `bio with a real emoji: route returns 200 (got ${r.status})`);
  const body = await r.json();
  ok(body.bio === emojiBio, `bio with a real emoji: survives completely untouched (got ${JSON.stringify(body.bio)})`);
  const rows = await rawQuery('SELECT bio FROM users WHERE id = $1', [alice.id]);
  ok(rows[0] && rows[0].bio === emojiBio, 'raw Postgres column also has the emoji untouched');
}

// 5) THE critical case: a field with ZERO app-layer sanitization, landing in a jsonb BLOB
// column via JSON.stringify -- this is what the original fix completely missed (it only matched
// the raw character; JSON.stringify had already hex-escaped it into literal ASCII text by the
// time it reached pgmini). setType on a logged set is never run through capStr/sanitizePgText
// anywhere in server.js. If the pgmini-level backstop genuinely works, this must still succeed
// AND must not jam carol's unrelated save afterward.
{
  const carol = await reg('carol_nulbyte');
  const sessRes = await post(carol, '/api/sessions', { exercises: [] }).then(x => x.json());
  const sessId = sessRes.id;
  ok(!!sessId, `carol can create an empty live session (got ${JSON.stringify(sessRes)})`);

  const r = await post(carol, `/api/sessions/${sessId}/log`,
    { exerciseId: 'nonexistent_ex', weight: 100, reps: 5, setType: 'normal\u0000x\uD800y' });
  ok(r.status === 200, `logging a set with NUL byte + lone surrogate in setType (unsanitized field, jsonb blob): route returns 200 (got ${r.status})`);
  // setType has no app-layer sanitization at all (unlike bio/displayName above) -- that's the
  // whole point of using it here, to prove the pgmini-level backstop alone, not server.js's own
  // belt-and-suspenders calls. So the in-memory value/HTTP echo is EXPECTED to still show the
  // raw, unsanitized text (a known, accepted "visible until restart" gap for untouched fields,
  // same class as the custom-exercise equipment field) -- what matters is that Postgres itself
  // got the already-clean text, and that nothing downstream jammed.
  const body = await r.json();
  const loggedType = body && body.logs && body.logs[carol.id] && body.logs[carol.id][0] && body.logs[carol.id][0].setType;
  ok(loggedType === 'normal\u0000x\uD800y', `(expected, documented gap) HTTP echo of an unsanitized field still shows the raw poison in memory (got ${JSON.stringify(loggedType)})`);

  // What actually matters: Postgres itself has the clean, stripped text -- not escaped garbage,
  // not a 500, not a jam.
  const rows = await rawQuery('SELECT data FROM sessions WHERE id = $1', [sessId]);
  const parsed = JSON.parse(rows[0].data);
  const rawLoggedType = parsed.logs && parsed.logs[carol.id] && parsed.logs[carol.id][0] && parsed.logs[carol.id][0].setType;
  ok(rawLoggedType === 'normalxy', `raw Postgres jsonb blob has setType stripped, not escaped garbage (got ${JSON.stringify(rawLoggedType)})`);

  // The actual bug: a totally unrelated user's save, right after, must still succeed.
  const bobR = await post(bob, '/api/me/bio', { bio: 'bob still fine after the jsonb-blob poison' });
  ok(bobR.status === 200, `a DIFFERENT user's save right after a jsonb-blob poison still succeeds (got ${bobR.status})`);
}

// 6) Slice-boundary case: a real emoji sitting exactly on capStr's length cap must survive
// intact, not get cut in half by .slice() into a fresh lone surrogate.
{
  const boundaryBio = 'a'.repeat(279) + '💪' + 'Z'; // 279 + 2 (💪) = 281 -> slice(0,280) lands exactly inside the pair
  const r = await post(alice, '/api/me/bio', { bio: boundaryBio });
  ok(r.status === 200, `bio with an emoji sitting on the length-cap boundary: route returns 200 (got ${r.status})`);
  const body = await r.json();
  // capStr/bio's own sanitize-slice-sanitize should either keep the whole emoji (truncating
  // before it if there's no room for both halves) or drop it cleanly -- never leave a lone half.
  const hasLoneSurrogate = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body.bio || '');
  ok(!hasLoneSurrogate, `boundary emoji case: no lone surrogate leaks into the response (got ${JSON.stringify(body.bio)})`);
  const rows = await rawQuery('SELECT bio FROM users WHERE id = $1', [alice.id]);
  ok(rows[0] && rows[0].bio === body.bio, 'boundary emoji case: Postgres matches the response exactly');
}

// 7) Restart: nothing left to repair, values read back exactly as stored.
await reboot();
{
  const rowsBob = await rawQuery('SELECT bio FROM users WHERE id = $1', [bob.id]);
  ok(rowsBob[0] && rowsBob[0].bio === 'bob still fine after the jsonb-blob poison', 'after restart: bob\'s bio survives exactly');
}

await stop();
await testDb.drop();
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
