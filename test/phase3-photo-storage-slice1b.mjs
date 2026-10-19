// Oct 19 2026 (Phase 3 Slice 1b -- getting photos/avatars off the single Fly volume, same
// "doomsday" effort as Slice 1a's AUTH_SECRET). Every upload/download/delete of a user file used
// to go straight through fs.writeFileSync/fs.readFileSync/fs.unlinkSync against UPLOAD_DIR on the
// volume. storage.js is now the one place all five call sites go through instead (POST
// /api/me/avatar, POST /api/sessions/:id/post's recap media, anonymizeAndDeleteAccount's avatar
// unlink, migrateMedia's legacy migration, and the /uploads/:fname serving route), with the same
// "env var wins, else fall back to local disk" shape Slice 1a used.
//
// Two things need proving, and they need different test shapes:
//
//   1. UNCONFIGURED behavior (today's actual deploy -- no SUPABASE_* secrets set yet) must be
//      byte-identical to the old fs.* calls: upload writes to local disk, the new /uploads/:fname
//      route serves exactly what express.static used to, delete removes the local file, and a
//      path-traversal-shaped filename is refused (express.static used to do this refusal for
//      free -- the hand-rolled route has to do it itself now, and that's new code with no prior
//      test covering it). This is proven end-to-end against a real booted server process, same as
//      every other integration test in this suite.
//
//   2. The STORAGE_ON branch (once Jeff sets the three env vars) can't be proven end-to-end here
//      -- there is no real Supabase project in this sandbox, and guessing at a fake REST response
//      shape would just be testing a mock of our own invention, not the real client. Instead this
//      proves the actual @supabase-js client really gets invoked and really drives the documented
//      asymmetry using a REAL (failing) network call to a closed port, not a hand-rolled stub:
//        - putObject with storage configured NEVER falls back to local disk on a failed upload --
//          it throws, same as a real Supabase outage should surface as a write failure rather than
//          a silent, confusing switch back to the volume.
//        - getObject with storage configured still falls back to local disk when the Storage
//          request fails -- the exact behavior the comments in storage.js promise ("every photo
//          uploaded BEFORE Jeff sets these secrets keeps serving correctly forever").
//        - deleteObject with storage configured still removes the local copy even though the
//          Storage-side remove() call fails.
//      These exercise storage.js directly (via a throwaway `node -e` child process, not through
//      server.js) since its three constants are read at module-load time -- a single process
//      can't flip STORAGE_ON after boot, same reason phase3-auth-secret-env.mjs boots a whole new
//      server process per AUTH_SECRET value instead of mutating process.env mid-run.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('phase3photostorage');

function boot(port, dir, extraEnv) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port), ...extraEnv }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    srv.on('exit', () => res(null));
    setTimeout(() => res(null), 15000);
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

const PORT = 5963, BASE = `http://localhost:${PORT}`;
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG = 'data:image/png;base64,' + TINY_PNG_B64;

async function api(path, method, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
async function reg(username) {
  const { json } = await api('/api/register', 'POST', null, { username, pin: '12345678', displayName: username });
  return { token: json.token, id: json.user && json.user.id, username };
}

console.log('=== Part 1: UNCONFIGURED (today\'s real deploy) -- end to end against a real server ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'phase3photo-unconfigured-')); liveDirs.add(dir);
  const srv = await boot(PORT, dir, {});
  ok(!!srv, 'server boots with no SUPABASE_* env vars set');
  if (srv) liveSrvs.add(srv);

  const bailey = await reg('p3bailey');
  ok(!!bailey.token, 'registered a user');

  console.log('\navatar upload writes to local disk and serves back through the new /uploads/:fname route');
  const up = await api('/api/me/avatar', 'POST', bailey.token, { data: TINY_PNG, type: 'image/png' });
  ok(up.status < 400 && !!up.json.avatar, `avatar upload succeeded (got ${JSON.stringify(up.json)})`);
  const fname = up.json.avatar ? up.json.avatar.split('/').pop() : null;
  ok(!!fname && existsSync(join(dir, 'uploads', fname)), `the file actually landed on local disk at DATA_DIR/uploads/${fname}`);
  const served = await fetch(BASE + up.json.avatar);
  ok(served.status === 200, `GET ${up.json.avatar} serves 200 (got ${served.status})`);
  ok(served.headers.get('content-type') === 'image/png', `content-type is image/png (got ${served.headers.get('content-type')})`);
  const servedBuf = Buffer.from(await served.arrayBuffer());
  ok(servedBuf.equals(Buffer.from(TINY_PNG_B64, 'base64')), 'served bytes exactly match what was uploaded');

  console.log('\nre-uploading under a DIFFERENT extension gets a new filename and deletes the OLD one from local disk (storage.deleteObject) -- avatar_<id>.png and avatar_<id>.jpg are different files, same-extension re-uploads just overwrite in place by design');
  const TINY_JPEG = 'data:image/jpeg;base64,' + TINY_PNG_B64; // content doesn't matter here, only that /^data:image\/(png|jpeg|jpg|webp);base64,/ matches and the extension differs from the first upload
  const up2 = await api('/api/me/avatar', 'POST', bailey.token, { data: TINY_JPEG, type: 'image/jpeg' });
  ok(up2.status < 400 && up2.json.avatar !== up.json.avatar, `second avatar upload (different extension) got a new filename (got ${JSON.stringify(up2.json)})`);
  ok(!existsSync(join(dir, 'uploads', fname)), 'the OLD (.png) avatar file is gone from local disk after replacement');

  console.log('\nrecap photo upload (POST /api/sessions/:id/post) writes media through storage.putObject too');
  const sess = await api('/api/sessions', 'POST', bailey.token, { name: 'Leg Day', scheduledAt: new Date().toISOString(), visibility: 'private', exercises: [{ name: 'Squat' }] });
  ok(!!sess.json.id, 'created a session');
  await api(`/api/sessions/${sess.json.id}/lock`, 'POST', bailey.token);
  const post = await api(`/api/sessions/${sess.json.id}/post`, 'POST', bailey.token, { notes: 'good lift', media: [{ type: 'image', src: TINY_PNG }], visibility: 'private' });
  ok(post.status < 400, `recap post with a photo succeeded (got ${post.status} ${JSON.stringify(post.json)})`);
  const media = post.json.posts && post.json.posts[bailey.id] && post.json.posts[bailey.id].media;
  const mediaSrc = Array.isArray(media) && media[0] && media[0].src;
  ok(/^\/uploads\/post_/.test(mediaSrc || ''), `recap photo got a real /uploads/post_... path (got ${JSON.stringify(mediaSrc)})`);
  const mediaFname = mediaSrc ? mediaSrc.split('/').pop() : null;
  ok(!!mediaFname && existsSync(join(dir, 'uploads', mediaFname)), 'recap photo file actually landed on local disk');
  // post_-prefixed files are gated by the auth middleware just above the storage route
  // (server.js:669) -- it requires a signed media token (GET /api/media-token), not just the
  // request being logged in, same as every other recap-photo fetch in this app.
  const tokRes = await api('/api/media-token', 'GET', bailey.token);
  ok(!!tokRes.json.token, 'got a media token');
  const servedPostNoTok = await fetch(BASE + mediaSrc);
  ok(servedPostNoTok.status === 401, `without a media token, a post_ photo is refused (got ${servedPostNoTok.status})`);
  const servedPost = await fetch(BASE + mediaSrc + '?tok=' + tokRes.json.token);
  ok(servedPost.status === 200, `with a valid media token, recap photo serves back at ${mediaSrc} (got ${servedPost.status})`);

  console.log('\n/uploads/:fname rejects a path-traversal-shaped filename (express.static used to do this for free; the hand-rolled route must now)');
  const traversal1 = await fetch(BASE + '/uploads/..%2f..%2fserver.js');
  ok(traversal1.status === 404, `encoded ../.. is refused (got ${traversal1.status})`);
  const traversal2 = await fetch(BASE + '/uploads/' + encodeURIComponent('../server.js'));
  ok(traversal2.status === 404, `../server.js is refused (got ${traversal2.status})`);

  console.log('\n/uploads/:fname supports HTTP Range requests (cold-review catch: express.static gave this for free; dropping it would break iOS Safari seek/scrub on recap videos)');
  {
    const fullBuf = Buffer.from(TINY_PNG_B64, 'base64');
    const total = fullBuf.length;
    const plain = await fetch(BASE + up2.json.avatar);
    ok(plain.status === 200 && plain.headers.get('accept-ranges') === 'bytes', `a plain GET (no Range header) advertises Accept-Ranges: bytes (got status ${plain.status}, header ${plain.headers.get('accept-ranges')})`);

    const r1 = await fetch(BASE + up2.json.avatar, { headers: { Range: 'bytes=0-3' } });
    ok(r1.status === 206, `Range: bytes=0-3 gets a 206 (got ${r1.status})`);
    ok(r1.headers.get('content-range') === `bytes 0-3/${total}`, `Content-Range header is correct (got ${r1.headers.get('content-range')})`);
    const r1buf = Buffer.from(await r1.arrayBuffer());
    ok(r1buf.equals(fullBuf.subarray(0, 4)), `the first 4 bytes exactly match the full file's first 4 bytes (got length ${r1buf.length})`);

    const r2 = await fetch(BASE + up2.json.avatar, { headers: { Range: `bytes=-4` } });
    ok(r2.status === 206, `a suffix range "bytes=-4" (last 4 bytes) gets a 206 (got ${r2.status})`);
    const r2buf = Buffer.from(await r2.arrayBuffer());
    ok(r2buf.equals(fullBuf.subarray(total - 4)), `and the bytes really are the last 4 of the file (got length ${r2buf.length})`);

    const r3 = await fetch(BASE + up2.json.avatar, { headers: { Range: `bytes=${total + 1000}-${total + 2000}` } });
    ok(r3.status === 416, `a Range entirely past the end of the file gets 416, not a silent full-file 200 (got ${r3.status})`);
    ok(r3.headers.get('content-range') === `bytes */${total}`, `and the 416's Content-Range names the real total length (got ${r3.headers.get('content-range')})`);
  }

  console.log('\n/uploads/:fname 404s on a well-formed but nonexistent filename, instead of throwing');
  const missing = await fetch(BASE + '/uploads/avatar_doesnotexist.png');
  ok(missing.status === 404, `nonexistent file 404s cleanly (got ${missing.status})`);

  console.log('\naccount deletion removes the avatar file from local disk (anonymizeAndDeleteAccount)');
  const avatarFname2 = up2.json.avatar.split('/').pop();
  const delRes = await api('/api/me/delete-account', 'POST', bailey.token, { password: '12345678' });
  ok(delRes.status < 400, `account delete succeeded (got ${delRes.status} ${JSON.stringify(delRes.json)})`);
  ok(!existsSync(join(dir, 'uploads', avatarFname2)), 'avatar file is gone from local disk after account deletion');

  if (srv) { try { srv.kill(); } catch {} liveSrvs.delete(srv); }
}

console.log('\n=== Part 2: STORAGE CONFIGURED but unreachable -- proves the real @supabase/supabase-js client is actually wired, not bypassed ===');
{
  // Port 1 refuses connections immediately on this sandbox (nothing listens on a privileged
  // port as this user) -- a real, fast ECONNREFUSED from the real http client, not a mock.
  const FAKE_ENV = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-key-for-wiring-test', SUPABASE_STORAGE_BUCKET: 'fake-bucket' };
  const dir = mkdtempSync(join(tmpdir(), 'phase3photo-storageon-')); liveDirs.add(dir);
  const uploadsDir = join(dir, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });

  function runStorageScript(code) {
    const r = spawnSync('node', ['-e', code], { cwd: CWD, env: { ...process.env, ...FAKE_ENV }, timeout: 10000, encoding: 'utf8' });
    return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
  }

  console.log('\nputObject with storage configured throws on a failed upload -- never silently falls back to local disk');
  {
    const fname = 'wiring-test-put.png';
    const r = runStorageScript(`
      const storage = require('${join(CWD, 'storage.js')}');
      storage.putObject(${JSON.stringify(uploadsDir)}, ${JSON.stringify(fname)}, Buffer.from('hello'))
        .then(() => console.log('RESOLVED'))
        .catch(e => console.log('THREW:' + e.message));
    `);
    ok(r.stdout.includes('THREW'), `putObject rejected rather than resolving (got stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr.slice(0, 300))})`);
    ok(!existsSync(join(uploadsDir, fname)), 'and critically: it did NOT silently write the file to local disk instead');
  }

  console.log('\ngetObject with storage configured still falls back to local disk when the Storage request fails');
  {
    const fname = 'wiring-test-get.png';
    writeFileSync(join(uploadsDir, fname), Buffer.from('already-on-local-disk'));
    const r = runStorageScript(`
      const storage = require('${join(CWD, 'storage.js')}');
      storage.getObject(${JSON.stringify(uploadsDir)}, ${JSON.stringify(fname)})
        .then(buf => console.log('GOT:' + (buf ? buf.toString() : 'null')))
        .catch(e => console.log('THREW:' + e.message));
    `);
    ok(r.stdout.includes('GOT:already-on-local-disk'), `getObject fell back to the local file after Storage failed (got stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr.slice(0, 300))})`);
  }

  console.log('\ndeleteObject with storage configured still removes the local copy even though the Storage-side remove() fails');
  {
    const fname = 'wiring-test-delete.png';
    writeFileSync(join(uploadsDir, fname), Buffer.from('to-be-deleted'));
    const r = runStorageScript(`
      const storage = require('${join(CWD, 'storage.js')}');
      storage.deleteObject(${JSON.stringify(uploadsDir)}, ${JSON.stringify(fname)})
        .then(() => console.log('DONE'))
        .catch(e => console.log('THREW:' + e.message));
    `);
    ok(r.stdout.includes('DONE'), `deleteObject completed without throwing despite Storage being unreachable (got stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr.slice(0, 300))})`);
    ok(!existsSync(join(uploadsDir, fname)), 'and the local copy really is gone');
  }

  console.log('\nSTORAGE_ON itself is really true with all three env vars set (confirms the module actually took the configured branch, not just that this test happened to pass by coincidence)');
  {
    const r = runStorageScript(`const storage = require('${join(CWD, 'storage.js')}'); console.log('STORAGE_ON=' + storage.STORAGE_ON + ' BUCKET=' + storage.STORAGE_BUCKET);`);
    ok(r.stdout.includes('STORAGE_ON=true'), `STORAGE_ON is true when all three env vars are set (got ${JSON.stringify(r.stdout)})`);
    ok(r.stdout.includes('BUCKET=fake-bucket'), 'and STORAGE_BUCKET reflects the env var');
  }

  console.log('\nsanity: with none of the three env vars set, STORAGE_ON is false (today\'s real deploy)');
  {
    const r = spawnSync('node', ['-e', `const storage = require('${join(CWD, 'storage.js')}'); console.log('STORAGE_ON=' + storage.STORAGE_ON);`], { cwd: CWD, env: process.env, encoding: 'utf8' });
    ok((r.stdout || '').includes('STORAGE_ON=false'), `STORAGE_ON is false with no env vars set (got ${JSON.stringify(r.stdout)})`);
  }
}

await cleanup();
console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
