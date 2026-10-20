#!/usr/bin/env node
// Oct 20 2026 (Phase 3, recurring restore-drill schedule). Used only by
// .github/workflows/restore-drill.yml, right after it has pg_restore'd the newest real R2
// backup into a brand-new, throwaway Postgres service container that exists only for this one
// CI job. This is the automated "does the backup actually come back with real data in it"
// check that makes the monthly schedule worth having — a restore that silently produces an
// empty or near-empty database (a wrong bucket object, a pg_restore that errored on everything
// but still exited 0, a backup taken mid-corruption) would otherwise look identical to success
// from the workflow's own exit code alone.
//
// Deliberately NOT a full content/diff check against live production — that's what the two
// manual drills (CLAUDE.md, Phase 3 Slice 3 and the Oct 20 Supabase-snapshot addendum) already
// did by hand, with a human looking at real usernames and template contents. This script runs
// unattended every month with nobody watching the output, so it checks the thing most likely to
// silently go wrong and be worth paging over: every core table has real rows in it, not zero.
// A floor of 1 row (not some larger number) is deliberate — this app's real user/session counts
// will keep growing, and hardcoding today's count here would make this script's own maintenance
// quietly depend on remembering to update it, the kind of staleness this project exists to avoid
// elsewhere. "At least one row in every core table" still catches the failure modes above.
//
// Usage: node scripts/verify-restore-drill.mjs <postgres-url-to-the-restored-database>
import { PgConnection, parseConnString } from '../pgmini.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/verify-restore-drill.mjs <postgres-url>');
  process.exit(1);
}

// Mirrors db.js's EMPTY_DB shape — the tables backupOnBoot()'s JSON snapshot covers are a
// STRICT SUBSET of what the full pg_dump/R2 backup this script actually checks contains (see
// CLAUDE.md's Oct 20 addendum for the honest accounting of that gap) — the real pg_dump has
// every table, so this checks the full list, not just the JSON-snapshot subset.
const CORE_TABLES = ['users', 'sessions', 'templates', 'prs', 'crews'];

const db = new PgConnection(parseConnString(url));
let failed = false;
try {
  for (const table of CORE_TABLES) {
    const { rows } = await db.query(`SELECT count(*) AS n FROM ${table}`);
    // pgmini.js always returns text-format results (see its own query() comment) -- every
    // column, including this count(*), comes back as a string, so parse before comparing.
    const n = parseInt(rows[0]?.n ?? '0', 10);
    if (n > 0) {
      console.log(`  OK  ${table}: ${n} rows`);
    } else {
      console.error(`  FAIL ${table}: 0 rows — a real backup should never restore to an empty core table`);
      failed = true;
    }
  }
} finally {
  db.close();
}

if (failed) {
  console.error('\nRestore drill verification FAILED — the restore ran, but the result does not look like real data.');
  process.exit(1);
}
console.log('\nRestore drill verification passed — every core table has real rows after restore.');
