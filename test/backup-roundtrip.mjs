// Proves scripts/backup-db.sh actually round-trips real data -- a backup nobody has restored
// from is a theory, not a backup. Seeds a SOURCE throwaway db through db.js's real save() path
// (not a hand-written INSERT, so this exercises the exact same write path production uses),
// dumps+encrypts it, then restores into a SEPARATE throwaway db that already has different,
// conflicting data in it -- the realistic disaster-recovery shape (spotmeapp-db already exists,
// it's just wrong) -- and checks the restored db matches the source, with the target's old data
// actually gone, not just added on top.
//
// Only the dump/encrypt/restore/decrypt mechanics are testable here -- the GitHub Actions
// workflow's `flyctl proxy` tunnel and the R2 upload step need real credentials this sandbox
// doesn't have, so those stay unverified by this test (see .github/workflows/backup.yml's own
// comments).
//
// Oct 11 2026 cold-review note: the first draft of this test seeded the target with an
// unrelated `decoy` table and expected --clean to remove it. That's not what --clean does --
// pg_restore --clean only emits a DROP for each object it is ABOUT to restore (i.e. objects
// present in the dump), not a wipe-the-whole-target-schema-first operation. An object in the
// target that was never part of the dump is simply not pg_restore's business and is correctly
// left alone. Fixed to seed the target with CONFLICTING ROWS IN THE SAME TABLES the dump
// actually restores (users/sessions) -- that's the real disaster-recovery shape (spotmeapp-db
// already has the users/sessions tables, the DATA in them is wrong) and the thing --clean
// actually guarantees: the old row is gone, not merged with or left beside the restored one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

const CWD = new URL('..', import.meta.url).pathname;
const SCRIPT = join(CWD, 'scripts/backup-db.sh');
const PASSPHRASE = 'test-only-passphrase-not-a-real-secret';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

const src = await freshTestDb('backupsrc');
const dst = await freshTestDb('backupdst');
const dir = mkdtempSync(join(tmpdir(), 'crewfit-backup-test-'));
const dumpFile = join(dir, 'backup.gpg');

try {

console.log('seed the SOURCE db through db.js\'s real save() path');
process.env.DATABASE_URL = src.url;
const db = (await import('../db.js')).default;
await db.ensureSchema();
const d = db.EMPTY_DB();
d.users['u1'] = { id: 'u1', username: 'alice', displayName: 'Alice' };
d.sessions['s1'] = { id: 's1', name: 'Leg Day', exercises: [{ id: 'e1', name: 'Bench Press' }] };
await db.save(d);
ok(true, 'source db seeded via db.save()');

console.log('\nseed the TARGET db with the SAME tables but different, conflicting rows -- the real disaster-recovery shape: restoring OVER an existing, wrong database, not an empty one');
execFileSync('psql', [dst.url, '-c', `
  CREATE TABLE users (id text PRIMARY KEY, username_lower text UNIQUE NOT NULL, data jsonb NOT NULL);
  CREATE TABLE sessions (id text PRIMARY KEY, data jsonb NOT NULL);
  INSERT INTO users VALUES ('u1', 'stale', '{"id":"u1","username":"stale-wrong-user"}');
  INSERT INTO sessions VALUES ('s1', '{"id":"s1","name":"Stale Wrong Session"}');
`]);

console.log('\nbackup-db.sh dump produces a non-empty file');
execFileSync('bash', [SCRIPT, 'dump', src.url, PASSPHRASE, dumpFile]);
const size = statSync(dumpFile).size;
ok(size > 0, `dump file is non-empty (${size} bytes)`);

console.log('\nthe dump file is actually encrypted -- a known plaintext value cannot be found in it by just grepping');
let foundPlaintext = true;
try { execFileSync('grep', ['-a', 'alice', dumpFile]); } catch (e) { foundPlaintext = false; }
ok(!foundPlaintext, 'grepping the raw dump file for "alice" finds nothing (it is really encrypted, not just renamed)');

console.log('\nrestore with the WRONG passphrase fails loudly instead of silently corrupting the target');
let wrongPassFailed = false;
try { execFileSync('bash', [SCRIPT, 'restore', dumpFile, 'definitely-the-wrong-passphrase', dst.url], { stdio: 'pipe' }); }
catch (e) { wrongPassFailed = true; }
ok(wrongPassFailed, 'restore with the wrong passphrase exits non-zero instead of succeeding');

console.log('\nthe stale row from before that failed attempt is untouched');
const staleStillThere = execFileSync('psql', [dst.url, '-tAc', `SELECT data->>'username' FROM users WHERE id='u1'`]).toString().trim();
ok(staleStillThere === 'stale-wrong-user', `stale row survives a failed restore attempt (got "${staleStillThere}")`);

console.log('\nrestore with the RIGHT passphrase actually restores the source data into the target');
execFileSync('bash', [SCRIPT, 'restore', dumpFile, PASSPHRASE, dst.url]);

const restoredUsername = execFileSync('psql', [dst.url, '-tAc', `SELECT data->>'username' FROM users WHERE id='u1'`]).toString().trim();
ok(restoredUsername === 'alice', `restored db has the source's user (got "${restoredUsername}")`);

const restoredSession = execFileSync('psql', [dst.url, '-tAc', `SELECT data->>'name' FROM sessions WHERE id='s1'`]).toString().trim();
ok(restoredSession === 'Leg Day', `restored db has the source's session (got "${restoredSession}")`);

const staleUserCount = execFileSync('psql', [dst.url, '-tAc', `SELECT count(*) FROM users WHERE username_lower='stale'`]).toString().trim();
ok(staleUserCount === '0', 'the target\'s OLD conflicting row is actually gone, not left sitting alongside the restored one');

} finally {
  rmSync(dir, { recursive: true, force: true });
  await src.drop();
  await dst.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
