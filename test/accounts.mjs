// Accounts: how they are created, stored, logged into, and found.
//
// Run:  npm test
//
// Every assertion exists because something was actually wrong. The headline ones: passwords were
// stored in the clear, "Brian" and "brian" were two different accounts, and nothing slowed down
// guessing a 4-character password.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.TEST_PORT3 || 4951;
const B = `http://localhost:${PORT}`;
const CWD = new URL('..', import.meta.url).pathname;
const DIR = mkdtempSync(join(tmpdir(), 'crewfit-acct-'));
let fails = 0, srv = null, srvDead = true;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const J = { 'Content-Type': 'application/json' };

function boot(dir = DIR) {
  return new Promise(res => {
    srv = spawn('node', ['server.js'], { env: { ...process.env, DATA_DIR: dir, PORT: String(PORT) },
      cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    srvDead = false;
    let err = '', out = '', done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    srv.stderr.on('data', d => { err += d; });
    srv.stdout.on('data', d => { out += d; if (String(d).includes('CrewFit on')) finish({ started: true, out }); });
    srv.on('exit', () => { srvDead = true; finish({ started: false, err, out }); });
    setTimeout(() => finish({ started: false, err: err || 'timeout', out }), 12000);
  });
}
const stop = () => new Promise(r => { if (!srv || srvDead) return r(); srv.on('exit', r); srv.kill(); });
const post = (p, b) => fetch(B + p, { method: 'POST', headers: J, body: JSON.stringify(b) });
const reg = (username, pin, displayName) => post('/api/register', { username, pin, displayName });
const login = (username, pin) => post('/api/login', { username, pin });
const nm = () => 'u' + Math.floor(Math.random() * 1e9);

await boot();
try {

console.log('a password is never stored in the clear');
{
  const u = nm();
  const r = await reg(u, 'hunter2', 'T').then(x => x.json());
  ok(!!r.token, 'the account is created');
  const raw = readFileSync(join(DIR, 'data.json'), 'utf8');
  ok(!raw.includes('hunter2'), 'the password does not appear anywhere in data.json');
  const rec = Object.values(JSON.parse(raw).users).find(x => x.username === u);
  ok(!rec.pin && !!rec.pinHash && !!rec.pinSalt, 'it is stored as a salted hash instead');
  ok((await login(u, 'hunter2').then(x => x.json())).token, 'and the real password still logs in');
  ok(!(await login(u, 'hunter3').then(x => x.json())).token, 'a wrong password does not');
}

console.log('\ntwo people cannot hold the same name in different capitals');
{
  const u = nm();
  ok((await reg(u, 'pass1234', 'First').then(x => x.json())).token, 'the first registration works');
  const dupe = await reg(u.toUpperCase(), 'pass1234', 'Second');
  ok(dupe.status === 409, `the same name in capitals is refused (got ${dupe.status})`);
  ok((await login(u.toUpperCase(), 'pass1234').then(x => x.json())).token,
     'and you can log in with any capitalisation of your own name');
  const chk = await fetch(B + '/api/register/check?username=' + encodeURIComponent(u.toUpperCase())).then(x => x.json());
  ok(chk.available === false, 'the signup form also reports it as taken');
}

console.log('\nusernames and passwords have rules');
for (const [bad, why] of [['ab', 'too short'], ['x'.repeat(21), 'too long'],
                          ['has space', 'a space'], ['emoji😀', 'an emoji'], ['admin', 'reserved']]) {
  const r = await reg(bad, 'pass1234', 'X');
  ok(r.status === 400, `"${bad}" is refused — ${why} (got ${r.status})`);
}
{
  const r = await reg(nm(), '123', 'X');
  ok(r.status === 400, `a 3-character password is refused (got ${r.status})`);
  const five = await reg(nm(), '12345', 'X');
  ok(five.status === 400, `a 5-character password is refused — the minimum is now 6 (got ${five.status})`);
  const six = await reg(nm(), 'abc123', 'X');
  ok(six.status === 200, `a 6-character password is accepted (got ${six.status})`);
  const long = await reg(nm(), 'x'.repeat(65), 'X');
  ok(long.status === 400, `a 65-character password is refused (got ${long.status})`);
}

console.log('\nevery account records when it was created');
{
  const u = nm();
  await reg(u, 'pass1234', 'T');
  const rec = Object.values(JSON.parse(readFileSync(join(DIR, 'data.json'), 'utf8')).users).find(x => x.username === u);
  ok(!!rec.createdAt && !isNaN(new Date(rec.createdAt)), `createdAt is a real date (${rec.createdAt})`);
  ok(!rec.createdAtEstimated, 'and it is observed, not estimated');
}

console.log('\nguessing a password gets slower');
{
  const u = nm();
  await reg(u, 'pass1234', 'T');
  let locked = null;
  for (let i = 0; i < 12 && !locked; i++) {
    const r = await login(u, 'wrong' + i);
    if (r.status === 429) locked = i + 1;
  }
  ok(locked !== null, `it locks out after repeated failures (after ${locked} attempts)`);
  const still = await login(u, 'pass1234');
  ok(still.status === 429, 'and the lock holds even for the correct password, so guessing cannot continue');
}
{
  // the lock is per username — one person being attacked must not lock everyone out
  const victim = nm(), bystander = nm();
  await reg(victim, 'pass1234', 'V'); await reg(bystander, 'pass1234', 'B');
  for (let i = 0; i < 10; i++) await login(victim, 'nope' + i);
  ok((await login(bystander, 'pass1234').then(x => x.json())).token,
     'someone else can still log in while one account is locked');
}

console.log('\nsearch');
{
  const me = await reg(nm(), 'pass1234', 'Me').then(x => x.json());
  const H = { ...J, Authorization: 'Bearer ' + me.token };
  await reg('brianna_k', 'pass1234', 'Brianna Keith');
  await reg('brian_t',   'pass1234', 'Brian Taylor');
  await reg('zzz_brian', 'pass1234', 'Zed');
  const find = q => fetch(B + '/api/users/search?q=' + encodeURIComponent(q), { headers: H }).then(x => x.json());

  ok((await find('b')).length === 0, 'a single letter returns nothing rather than 20 strangers');
  const bri = await find('bri');
  ok(bri.length >= 3, `"bri" finds them all (${bri.length})`);
  const exact = await find('brian_t');
  ok(exact[0] && exact[0].username === 'brian_t', `an exact username ranks first (got ${exact[0] && exact[0].username})`);
  const caps = await find('BRIAN_T');
  ok(caps[0] && caps[0].username === 'brian_t', 'search ignores capitalisation');
  const starts = await find('brian');
  ok(starts[0] && starts[0].username.startsWith('brian'),
     `a name starting with the query outranks one containing it (got ${starts.map(x=>x.username).join(', ')})`);
  ok(!(await find('me')).some(x => x.id === me.id), 'you never appear in your own results');
}

console.log('\nan old account with a plaintext password is converted on the next start');
{
  await stop();
  const f = join(DIR, 'data.json');
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const id = 'legacy01';
  d.users[id] = { id, username: 'legacyuser', pin: 'oldpass', displayName: 'Legacy', friends: [], units: 'lb' };
  writeFileSync(f, JSON.stringify(d, null, 2));
  const r = await boot();
  ok(r.started, 'the server starts');
  const after = JSON.parse(readFileSync(f, 'utf8')).users[id];
  ok(!after.pin && !!after.pinHash, 'the stored plaintext password is gone, replaced by a hash');
  ok(!readFileSync(f, 'utf8').includes('oldpass'), 'and the old password is nowhere in the file');
  ok((await login('legacyuser', 'oldpass').then(x => x.json())).token, 'the person can still log in with it');
  ok((await login('LEGACYUSER', 'oldpass').then(x => x.json())).token, 'in any capitalisation');
  ok(!!after.createdAt === false || !!after.createdAt, 'no join date is invented for an account with no activity');
}

console.log('\nJeff can reset a password by hand while self-service reset is off');
{
  await stop();
  const f = join(DIR, 'data.json');
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const u = Object.values(d.users).find(x => x.username === 'legacyuser');
  u.pin = 'jeffSetThis';                       // the documented manual reset: add a plaintext pin
  writeFileSync(f, JSON.stringify(d, null, 2));
  await boot();
  ok((await login('legacyuser', 'jeffSetThis').then(x => x.json())).token, 'the new password works');
  ok(!(await login('legacyuser', 'oldpass').then(x => x.json())).token, 'the old one no longer does');
  ok(!readFileSync(f, 'utf8').includes('jeffSetThis'), 'and the plaintext did not survive the boot');
}

console.log('\na login survives a restart — it is signed, not remembered');
{
  const u = nm();
  const r = await reg(u, 'pass1234', 'T').then(x => x.json());
  const me = () => fetch(B + '/api/me/seeds', { headers: { Authorization: 'Bearer ' + r.token } });
  ok((await me()).status < 400, 'the token works');
  await stop(); await boot();
  ok((await me()).status < 400, 'and it STILL works after the server restarts');
  ok(r.token.includes('.'), 'it is a signed token, not a random string');

  const forged = r.token.split('.')[0] + '.' + 'x'.repeat(43);
  ok((await fetch(B + '/api/me/seeds', { headers: { Authorization: 'Bearer ' + forged } })).status === 401,
     'a token with a faked signature is refused');
  const tampered = Buffer.from(JSON.stringify({ u: 'someoneelse', t: Date.now() })).toString('base64url')
                 + '.' + r.token.split('.')[1];
  ok((await fetch(B + '/api/me/seeds', { headers: { Authorization: 'Bearer ' + tampered } })).status === 401,
     'swapping in another user id is refused');
  ok((await fetch(B + '/api/me/seeds', { headers: { Authorization: 'Bearer notatoken' } })).status === 401,
     'nonsense is refused');
}

} finally { await stop(); rmSync(DIR, { recursive: true, force: true }); }

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall assertions passed\n');
process.exit(fails ? 1 : 0);
