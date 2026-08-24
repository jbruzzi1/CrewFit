// Throwaway Postgres database per test file, so tests never share state and never touch anything
// real. Mirrors the old mkdtempSync(DATA_DIR)-per-test-file pattern from the file-based era, just
// for a database instead of a directory.
//
// IMPORTANT: this file is genuinely load-bearing (every Postgres-backed test file imports it) —
// it is NOT one of the throwaway `_*.mjs` agent-scratch probes .gitignore's `_*.mjs` rule is for.
// See the negated `!test/_pgtestdb.mjs` line right below that rule in .gitignore.
//
// Connects as the local test superuser (peer/trust auth in this sandbox; on Fly this file is
// never used at all — the app only ever connects to the real DATABASE_URL). Override
// PGTEST_ADMIN_URL to point at a different admin connection if the default doesn't apply.
import { PgConnection, parseConnString } from '../pgmini.js';

const ADMIN_URL = process.env.PGTEST_ADMIN_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function randSuffix() {
  // No Math.random() dependence on anything workflow-unsafe here — this is a plain test helper,
  // not a Workflow script — but process.hrtime.bigint() + pid is more than enough uniqueness for
  // a same-machine, same-run set of test databases.
  return process.hrtime.bigint().toString(36) + '_' + process.pid.toString(36);
}

export async function freshTestDb(label) {
  const safeLabel = String(label || 'test').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const dbName = `crewfit_t_${safeLabel}_${randSuffix()}`;
  const admin = new PgConnection(parseConnString(ADMIN_URL));
  // CREATE DATABASE cannot run inside a transaction / with parameters — build the identifier
  // ourselves. dbName is entirely derived from a-z0-9_ above, so this is not injectable.
  await admin.query(`CREATE DATABASE ${dbName}`);
  admin.close();

  const parsed = parseConnString(ADMIN_URL);
  const url = `postgres://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/${dbName}`;

  return {
    url,
    async drop() {
      const a = new PgConnection(parseConnString(ADMIN_URL));
      // Terminate any lingering backends on the test DB first — a test process that crashed
      // mid-connection would otherwise make DROP DATABASE hang or fail with "database is being
      // accessed by other users."
      await a.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      );
      await a.query(`DROP DATABASE IF EXISTS ${dbName}`);
      a.close();
    },
  };
}
