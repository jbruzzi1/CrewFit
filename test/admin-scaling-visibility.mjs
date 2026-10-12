// Oct 12 2026 (scaling fix #1, visibility): GET /api/admin/scaling reports current memory usage,
// user/session counts, and a rolling latency window for the specific routes already identified
// as the real scaling risk (Progress/Notifications/Sessions list/Login -- see WATCHED_ROUTES'
// own comment in server.js). The point of this endpoint is to turn "is this app starting to feel
// the scan/RAM ceiling" into a real number someone can check, before it becomes a user
// complaint -- this test just confirms it's actually wired up correctly: admin-token-gated like
// every other /api/admin route, and the latency window actually picks up a real request.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };
const CWD = new URL('..', import.meta.url).pathname;
const testDb = await freshTestDb('adminscaling');
const DIR = mkdtempSync(join(tmpdir(), 'admin-scaling-'));
const PORT = 4991, B = `http://localhost:${PORT}`;

function boot() {
  return new Promise(res => {
    const srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: DIR, DATABASE_URL: testDb.url, PORT: String(PORT) }, cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { if (String(d).includes('CrewFit on')) res(srv); });
    setTimeout(() => res(null), 15000);
  });
}
const post = (p, b, tok) => fetch(B + p, { method: 'POST', headers: tok ? { ...J, Authorization: 'Bearer ' + tok } : J, body: JSON.stringify(b) }).then(r => r.json());
const get = (p, headers) => fetch(B + p, { headers }).then(r => r.json());

const srv = await boot();
ok(!!srv, 'server boots');
const adminToken = JSON.parse(readFileSync(join(DIR, 'admin-token.json'), 'utf8')).token;

try {

const noTok = await get('/api/admin/scaling');
ok(noTok.error === 'unauthorized', 'no token at all is refused, same as every other admin route');
const wrongTok = await get('/api/admin/scaling', { 'x-admin-token': 'definitely-not-it' });
ok(wrongTok.error === 'unauthorized', 'a wrong token is refused');

const alice = await post('/api/register', { username: 'adminscale_alice', pin: 'pass1234', displayName: 'Alice' });
ok(!!alice.token, 'setup: registered a real user');
await get('/api/progress?weeks=4', { Authorization: 'Bearer ' + alice.token });
await get('/api/progress?weeks=4', { Authorization: 'Bearer ' + alice.token });

const scaling = await get('/api/admin/scaling', { 'x-admin-token': adminToken });
ok(scaling.ok === true, 'real admin token is accepted');
ok(scaling.users === 1, `reports the one real (non-deleted) user (got ${scaling.users})`);
ok(scaling.sessions === 0, `reports zero sessions (none created) (got ${scaling.sessions})`);
ok(typeof scaling.memoryMB.rss === 'number' && scaling.memoryMB.rss > 0, `reports a real, positive RSS figure (got ${scaling.memoryMB.rss})`);
ok(scaling.latency.progress && scaling.latency.progress.samples === 2, `the two /api/progress calls above actually landed in the rolling window (got ${JSON.stringify(scaling.latency.progress)})`);
ok(typeof scaling.latency.progress.medianMs === 'number', 'reports a real median latency figure, not a placeholder');
ok(scaling.latency.notifications === null, 'an unhit watched route reports null, not a crash or a fake zero');

} finally {
  if (srv) srv.kill();
  await testDb.drop();
}

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
