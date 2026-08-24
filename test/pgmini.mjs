import { PgConnection, parseConnString } from '../pgmini.js';
import { freshTestDb } from './_pgtestdb.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// A throwaway database, same as every other Postgres-backed test file in this suite — no
// pre-created database or hardcoded credential assumed to already exist on the machine running
// this (a fresh CI box would have neither).
const testDb = await freshTestDb('pgmini');
const conn = new PgConnection(parseConnString(testDb.url));

console.log('basic connect + SELECT 1');
{
  const r = await conn.query('SELECT 1 as one');
  ok(r.rows.length === 1 && r.rows[0].one === '1', `got ${JSON.stringify(r.rows)}`);
}

console.log('\nDDL + parameterized insert + select');
{
  await conn.query('DROP TABLE IF EXISTS smoke_test');
  await conn.query('CREATE TABLE smoke_test (id text primary key, data jsonb not null, n integer)');
  await conn.query('INSERT INTO smoke_test (id, data, n) VALUES ($1, $2::jsonb, $3)', ['abc', JSON.stringify({ hello: 'world', nested: [1, 2, 3] }), '42']);
  const r = await conn.query('SELECT id, data, n FROM smoke_test WHERE id = $1', ['abc']);
  ok(r.rows.length === 1, 'one row back');
  ok(r.rows[0].id === 'abc', 'id round-tripped');
  ok(JSON.parse(r.rows[0].data).hello === 'world', 'jsonb round-tripped');
  ok(JSON.parse(r.rows[0].data).nested.length === 3, 'nested array in jsonb round-tripped');
  ok(r.rows[0].n === '42', 'integer round-tripped (as text)');
}

console.log('\nnull handling');
{
  await conn.query('INSERT INTO smoke_test (id, data, n) VALUES ($1, $2::jsonb, $3)', ['nulltest', '{}', null]);
  const r = await conn.query('SELECT n FROM smoke_test WHERE id = $1', ['nulltest']);
  ok(r.rows[0].n === null, `null round-tripped (got ${JSON.stringify(r.rows[0].n)})`);
}

console.log('\nunicode + embedded quotes + special chars (injection-shaped input, must be SAFE via params)');
{
  const nasty = `O'Brien "quoted" \\backslash\\ 你好 🏋️ '; DROP TABLE smoke_test; --`;
  await conn.query('INSERT INTO smoke_test (id, data, n) VALUES ($1, $2::jsonb, $3)', ['nasty', JSON.stringify({ text: nasty }), '1']);
  const r = await conn.query('SELECT data FROM smoke_test WHERE id = $1', ['nasty']);
  ok(JSON.parse(r.rows[0].data).text === nasty, 'nasty string round-tripped exactly, unmangled');
  const stillThere = await conn.query('SELECT count(*) as c FROM smoke_test');
  ok(Number(stillThere.rows[0].c) === 3, `table survived the injection-shaped string (count=${stillThere.rows[0].c})`);
}

console.log('\ntransaction commit');
{
  await conn.begin();
  await conn.query('INSERT INTO smoke_test (id, data, n) VALUES ($1, $2::jsonb, $3)', ['tx1', '{}', '1']);
  await conn.commit();
  const r = await conn.query('SELECT count(*) as c FROM smoke_test WHERE id = $1', ['tx1']);
  ok(Number(r.rows[0].c) === 1, 'committed row is visible');
}

console.log('\ntransaction rollback');
{
  await conn.begin();
  await conn.query('INSERT INTO smoke_test (id, data, n) VALUES ($1, $2::jsonb, $3)', ['tx2', '{}', '1']);
  await conn.rollback();
  const r = await conn.query('SELECT count(*) as c FROM smoke_test WHERE id = $1', ['tx2']);
  ok(Number(r.rows[0].c) === 0, 'rolled-back row is NOT visible');
}

console.log('\nerror surfaces correctly (bad SQL) and connection recovers for the next query');
{
  let threw = false;
  try { await conn.query('SELECT * FROM this_table_does_not_exist'); }
  catch (e) { threw = true; ok(/does not exist/.test(e.message), `error message mentions it: ${e.message}`); }
  ok(threw, 'query against missing table threw');
  const r = await conn.query('SELECT 1 as one');
  ok(r.rows[0].one === '1', 'connection still usable after an error');
}

console.log('\nconcurrent queries on one connection serialize correctly (no interleaving corruption)');
{
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(conn.query('INSERT INTO smoke_test (id, data, n) VALUES ($1, $2::jsonb, $3)', ['concurrent_' + i, '{}', String(i)]));
  }
  await Promise.all(promises);
  const r = await conn.query('SELECT count(*) as c FROM smoke_test WHERE id LIKE $1', ['concurrent_%']);
  ok(Number(r.rows[0].c) === 20, `all 20 concurrent inserts landed (got ${r.rows[0].c})`);
}

await conn.query('DROP TABLE smoke_test');
conn.close();
await testDb.drop();

console.log(fails ? `\n${fails} FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
