// Oct 19 2026 (Phase 3 Slice 1c -- getting backupOnBoot()'s JSON snapshots off the volume too,
// same "doomsday" effort as Slices 1a/1b). Worth being honest about scope up front, same as the
// comment now sitting above backupOnBoot() in server.js: this is NOT the app's primary disaster
// recovery backup -- DEPLOY.md's "Off-platform backup" section already ships a nightly encrypted
// pg_dump to Cloudflare R2, a different company/infra entirely, on top of Fly's own default
// volume snapshots (see test/backup-roundtrip.mjs for THAT mechanism's own test). What this slice
// buys is volume-independence for the one remaining local-disk writer in the boot path, plus
// keeping the existing "restore to right-before-this-boot's-migrations" convenience working the
// same way once a machine has no local disk to depend on at all.
//
// backupOnBoot() now goes through storage.js, same shape as every photo/avatar call site from
// Slice 1b, PLUS a new storage.listObjects() this slice adds specifically for pruning: unlike
// put/get/delete (one filename, one clear fallback), deciding "which backups are old enough to
// delete" needs to see EVERY backup that exists on EITHER side of a Storage cutover, together --
// a backup written before Jeff sets the three env vars lives only on local disk; one written
// after lives only in Storage; the kept-10 retention policy has to be enforced across the union
// of both, or a pre-cutover backup would simply never age out.
//
// test/data-safety.mjs already covers the UNCONFIGURED path thoroughly (one backup per boot, 14
// boots -> newest 10 kept, the documented restore path actually restores) -- that suite was not
// touched by this slice and still passes unmodified, proving today's real deploy behaves exactly
// as before. This file covers what's NEW: the CONFIGURED branch really drives storage.js (a real,
// if unreachable, network call -- not a hand-rolled mock) and, specifically, that a Storage
// failure during the boot backup is non-fatal to boot (the server must still come up even if the
// backup itself couldn't be written) and -- the asymmetry that matters most here -- does NOT
// silently fall back to writing the local disk it was configured to stop using.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('phase3backupstorage');

function boot(port, dir, extraEnv) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port), ...extraEnv }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    srv.stdout.on('data', d => { out += d; });
    srv.stderr.on('data', d => { err += d; });
    let resolved = false;
    srv.stdout.on('data', d => { if (!resolved && String(d).includes('CrewFit on')) { resolved = true; res({ srv, out: () => out, err: () => err }); } });
    srv.on('exit', () => { if (!resolved) { resolved = true; res({ srv: null, out: () => out, err: () => err }); } });
    setTimeout(() => { if (!resolved) { resolved = true; res({ srv, out: () => out, err: () => err }); } }, 15000);
  });
}

let cleanedUp = false;
const liveSrvs = new Set();
const liveDirs = new Set();
async function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  for (const s of liveSrvs) { try { s.kill(); } catch {} }
  for (const d of liveDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { await testDb.drop(); } catch {}
}
process.on('uncaughtException', async (e) => { console.error('UNCAUGHT', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('UNHANDLED', e); await cleanup(); process.exit(1); });

const PORT = 5964;

console.log('=== STORAGE CONFIGURED but unreachable -- boot must survive a failed backup, and must NOT silently fall back to local disk ===');
{
  // Port 1 refuses connections immediately on this sandbox -- a real, fast ECONNREFUSED from the
  // real @supabase/supabase-js client, not a mock (same approach as phase3-photo-storage-slice1b.mjs).
  const FAKE_ENV = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-key-for-wiring-test', SUPABASE_STORAGE_BUCKET: 'fake-bucket' };
  const dir = mkdtempSync(join(tmpdir(), 'phase3backup-storageon-')); liveDirs.add(dir);
  const { srv, out, err } = await boot(PORT, dir, FAKE_ENV);
  ok(!!srv, `server still boots even though the configured backup destination is unreachable (stderr: ${err().slice(0, 400)})`);
  if (srv) liveSrvs.add(srv);
  ok(/BACKUP FAILED/.test(out()) || /BACKUP FAILED/.test(err()), `the failed backup is logged loudly, not swallowed (got stdout tail: ${out().slice(-300)})`);
  const bdir = join(dir, 'backups');
  const localBackups = existsSync(bdir) ? readdirSync(bdir).filter(f => /^data-.*\.json$/.test(f)) : [];
  ok(localBackups.length === 0, `critically: NO backup file was written to local disk either -- a failed Storage write must throw, never silently fall back to the volume it was configured to stop using (found ${localBackups.length})`);
  if (srv) { try { srv.kill(); } catch {} liveSrvs.delete(srv); }
}

console.log('\n=== storage.listObjects() unit-level: the pruning union really merges local disk + Storage, and degrades gracefully when the Storage side errors ===');
{
  const FAKE_ENV = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-key-for-wiring-test', SUPABASE_STORAGE_BUCKET: 'fake-bucket' };
  const dir = mkdtempSync(join(tmpdir(), 'phase3backup-listobjects-')); liveDirs.add(dir);
  const bdir = join(dir, 'backups');
  mkdirSync(bdir, { recursive: true });

  function runStorageScript(env, code) {
    const r = spawnSync('node', ['-e', code], { cwd: CWD, env: { ...process.env, ...env }, timeout: 10000, encoding: 'utf8' });
    return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  }

  console.log('\nunconfigured: listObjects returns exactly the local files matching the prefix, nothing else');
  {
    writeFileSync(join(bdir, 'data-2026-01-01T00-00-00-000Z.json'), '{}');
    writeFileSync(join(bdir, 'data-2026-01-02T00-00-00-000Z.json'), '{}');
    writeFileSync(join(bdir, 'unrelated-file.txt'), 'x');
    writeFileSync(join(bdir, 'database-not-a-backup.json'), '{}'); // starts with "data" but NOT the "data-" prefix (5th char is 'b', not '-') -- must not false-match
    const r = runStorageScript({}, `
      const storage = require('${join(CWD, 'storage.js')}');
      storage.listObjects(${JSON.stringify(bdir)}, 'data-').then(names => console.log(JSON.stringify(names)));
    `);
    const names = JSON.parse(r.stdout || '[]');
    ok(names.length === 2 && names.every(n => n.startsWith('data-')), `found exactly the 2 real backup files, sorted (got ${JSON.stringify(names)})`);
    ok(names[0] < names[1], 'and they sort chronologically (ISO timestamp strings sort correctly as plain strings)');
  }

  console.log('\nconfigured but unreachable: listObjects still returns the local files -- the Storage-side list() failure degrades gracefully instead of throwing or returning nothing');
  {
    const r = runStorageScript(FAKE_ENV, `
      const storage = require('${join(CWD, 'storage.js')}');
      storage.listObjects(${JSON.stringify(bdir)}, 'data-').then(names => console.log(JSON.stringify(names))).catch(e => console.log('THREW:' + e.message));
    `);
    // stdout has storage.js's own "Object storage: ON ..." console.log on its own line first
    // (module-load side effect, same as every other STORAGE_ON=true script in this suite) --
    // the JSON payload is always the LAST line.
    const lastLine = r.stdout.split('\n').filter(Boolean).pop() || '';
    const parsed = (() => { try { return JSON.parse(lastLine); } catch { return null; } })();
    ok(Array.isArray(parsed) && parsed.length === 2, `did not throw, and still found the 2 local backups despite Storage being unreachable (got stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr.slice(0, 300))})`);
  }
}

console.log('\n=== END-TO-END against a real (synthetic) Supabase Storage server: proves the union-merge actually prunes a pre-cutover LOCAL-ONLY backup once new backups start landing in Storage -- the one part of this slice\'s own rationale the earlier sections above don\'t exercise ===');
{
  // A minimal, faithful stand-in for the real Supabase Storage REST API -- NOT a mock of
  // storage.js's own internals. Request/response shapes below were confirmed by pointing the
  // real @supabase/supabase-js client at a logging server and reading what it actually sent,
  // not guessed from docs: POST /storage/v1/object/list/<bucket> (body {prefix,limit,...}) ->
  // a raw JSON array of {name,...}; POST /storage/v1/object/<bucket>/<fname> -> upload (any 2xx
  // JSON body is accepted as success); DELETE /storage/v1/object/<bucket> (body
  // {prefixes:[...]}) -> remove. storage.js's real putObject/listObjects/deleteObject code runs
  // completely unmodified against this -- only which server answers the HTTP calls is fake.
  const remoteObjects = new Map(); // fname -> Buffer, this test's own observation point into "what's really in Storage"
  const fakeSupabase = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url.startsWith('/storage/v1/object/list/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(Array.from(remoteObjects.keys()).map(name => ({ name }))));
      }
      if (req.method === 'DELETE' && req.url === '/storage/v1/object/fake-bucket') {
        const { prefixes } = JSON.parse(body.toString() || '{}');
        for (const p of (prefixes || [])) remoteObjects.delete(p);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(prefixes || []));
      }
      const uploadMatch = req.method === 'POST' && req.url.match(/^\/storage\/v1\/object\/fake-bucket\/(.+)$/);
      if (uploadMatch) {
        remoteObjects.set(decodeURIComponent(uploadMatch[1]), body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Key: `fake-bucket/${uploadMatch[1]}` }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found in fake server', path: req.url, method: req.method }));
    });
  });
  await new Promise(res => fakeSupabase.listen(0, res));
  const fakePort = fakeSupabase.address().port;
  const SUPABASE_ENV = { SUPABASE_URL: `http://127.0.0.1:${fakePort}`, SUPABASE_SERVICE_ROLE_KEY: 'fake-key-points-at-our-own-synthetic-server', SUPABASE_STORAGE_BUCKET: 'fake-bucket' };

  const dir = mkdtempSync(join(tmpdir(), 'phase3backup-e2e-')); liveDirs.add(dir);
  const bdir = join(dir, 'backups');
  mkdirSync(bdir, { recursive: true });
  // One backup that exists ONLY on local disk, as if written before Jeff ever set the three env
  // vars -- deliberately timestamped older than anything else that will exist by the end of
  // this block, so it's unambiguously "the oldest of all of them" once merged with the new ones.
  const legacyFname = 'data-2020-01-01T00-00-00-000Z.json';
  writeFileSync(join(bdir, legacyFname), '{"legacy":true}');

  const PORT2 = 5965;
  // Boot the REAL server 10 times with Storage configured and REACHABLE this time -- each boot's
  // real backupOnBoot() writes a new backup to the fake remote and re-runs the real pruning
  // logic end to end. 1 legacy (local-only) + 10 new (remote-only) = 11 total, one over
  // BACKUPS_KEPT (10) -- by the 10th boot the legacy local backup, the oldest of all 11, must be
  // the one that gets pruned, not any of the newer remote ones.
  for (let i = 0; i < 10; i++) {
    const { srv, err } = await boot(PORT2, dir, SUPABASE_ENV);
    ok(!!srv, `boot ${i + 1}/10 with Storage configured and reachable succeeds (stderr: ${srv ? '' : err().slice(0, 300)})`);
    if (srv) { try { srv.kill(); } catch {} }
  }
  ok(!existsSync(join(bdir, legacyFname)), 'the pre-cutover LOCAL-ONLY backup -- the oldest of all 11 -- was actually pruned: this is the union-merge from storage.js\'s listObjects actually mattering, not just returning the right shape in isolation');
  ok(remoteObjects.size === 10, `exactly the newest 10 backups remain, and they're all in the fake remote (found ${remoteObjects.size})`);
  const localLeftovers = readdirSync(bdir).filter(f => /^data-.*\.json$/.test(f));
  ok(localLeftovers.length === 0, `local disk holds ZERO backup files now -- every one of the 10 new backups went straight to Storage and none ever fell back to disk (found ${localLeftovers.length})`);

  fakeSupabase.close();
}

await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
