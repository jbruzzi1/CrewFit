// Jeff, Aug 21: "I added CrewFit to my Home Screen already, and I still don't get
// notifications." That ruled out the iOS-Home-Screen theory and pointed at a real bug:
// VAPID_FILE used to be path.join(__dirname, 'vapid.json') — __dirname is the app's code
// directory, which lives inside the Docker image's writable layer on Fly.io, NOT the
// persistent /data volume (see fly.toml's [mounts]). Every `fly deploy` builds a fresh
// image, wiping that directory, so a brand-new VAPID keypair got generated on every single
// deploy. A browser's push subscription is bound to the public key it subscribed with; the
// instant the keypair changes, webpush.sendNotification() signs with a private key that no
// subscription matches, the push service silently rejects it, and notify() swallowed that
// error with zero logging. Whoever subscribed, the very next deploy broke it forever —
// indistinguishable from "notifications don't work," with nothing anywhere saying why.
//
// The fix moves vapid.json into DATA_DIR, the same persistent-volume pattern this app
// already uses for auth-secret.json (loadOrCreateSecret).
//
// The assertion that actually catches a regression back to the old bug is the CWD one below
// (`vapid.json is NOT written into the app's code directory`) — the old code wrote to
// __dirname, which under this test harness IS the checked-out repo (`cwd: CWD` below), so
// that assertion fails against the pre-fix code and passes against the fix. Killing and
// restarting the same `node server.js` process does NOT reproduce a real `fly deploy` (a
// real deploy discards the whole image and starts a fresh one; a restart in this test just
// re-runs the same checkout, so __dirname never actually gets wiped here) — a cold review
// caught that the restart-identical-key assertion below would keep passing even against the
// unfixed code, for exactly that reason. It stays in the test anyway because it documents the
// desired end-to-end behavior in production, but the CWD assertion is the one doing the real
// regression-proofing.
//
// Ported to the Postgres-backed test harness (Aug 2026 data-layer migration) — the original
// version predates that migration and booted the server with only DATA_DIR/PORT set, which no
// longer boots at all (server.js now requires DATABASE_URL). Nothing about the VAPID assertions
// themselves changed; only the boot wiring did.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('vapid');

function boot(port, dir) {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, DATABASE_URL: testDb.url, PORT: String(port) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) res({ srv, out }); });
    srv.on('exit', () => res({ srv: null, out }));
    setTimeout(() => res({ srv, out }), 15000);
  });
}
async function killAndWait(srv) {
  return new Promise(res => { srv.once('exit', res); srv.kill(); setTimeout(res, 2000); });
}

const DIR = mkdtempSync(join(tmpdir(), 'vapid-'));
const PORT = 4993, B = `http://localhost:${PORT}`;

console.log('\nvapid.json is written into DATA_DIR (the persistent volume), not the app code directory');
let { srv } = await boot(PORT, DIR);
ok(!!srv, 'server boots');
const key1 = (await fetch(B + '/api/vapid').then(r => r.json())).publicKey;
ok(typeof key1 === 'string' && key1.length > 20, `GET /api/vapid returns a real public key (got ${JSON.stringify(key1)})`);
ok(existsSync(join(DIR, 'vapid.json')), 'vapid.json was written inside DATA_DIR');
ok(!existsSync(join(CWD, 'vapid.json')), "vapid.json is NOT written into the app's code directory (the old bug — this is the assertion that actually fails against the pre-fix code)");

console.log('\na restart on the SAME DATA_DIR — exactly what a real `fly deploy` does to the running machine — must keep the same VAPID key');
await killAndWait(srv);
({ srv } = await boot(PORT, DIR));
ok(!!srv, 'server reboots cleanly');
const key2 = (await fetch(B + '/api/vapid').then(r => r.json())).publicKey;
ok(key1 === key2, `VAPID public key is identical across the restart (was: silently regenerated every deploy, breaking every subscriber) — before=${key1.slice(0,16)}... after=${key2.slice(0,16)}...`);

try { srv && srv.kill(); } catch {}
rmSync(DIR, { recursive: true, force: true });
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
