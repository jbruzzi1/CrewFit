#!/usr/bin/env bash
# Oct 11 2026 (deep-dive audit, Jeff: "for #1 lets do what is best for long term overall").
#
# The ONLY safety net this app had before today was same-infrastructure: the boot-time JSON
# snapshot server.js's backupOnBoot() writes to the app's own Fly volume, plus whatever Fly's
# own default daily volume snapshots are doing underneath spotmeapp-db. Both are real and both
# are tested (see test/data-safety.mjs's restore drill) -- but if Fly itself ever had an
# account-level problem, every copy of the data goes with it. This script is the off-platform
# half of fixing that: it can dump a real Postgres database to a GPG-encrypted file, and restore
# one back. .github/workflows/backup.yml runs `dump` nightly and uploads the result to Cloudflare
# R2 -- a different company's infrastructure entirely, not Fly.
#
# `restore` is the other half of that story on purpose -- a backup nobody has ever restored from
# is a theory, not a backup. test/backup-roundtrip.mjs proves both commands round-trip real data
# correctly, including the "restoring OVER an already-populated, corrupted database" case (the
# actual disaster-recovery shape), not just "restoring into an empty one."
#
# Encrypted with GPG symmetric (AES-256) before the dump ever leaves this machine -- not relying
# on the destination bucket being private. These dumps hold every user's PIN hash+salt (same
# fact DEPLOY.md already states about the on-Fly pg_dump this mirrors: "that file holds every
# user's PIN-derived hash and salt"). A leaked bucket credential alone should not be enough to
# read a single real password hash out of one of these.
#
# Worth knowing, not fixed here: this is symmetric encryption, so whatever holds the passphrase
# (BACKUP_ENCRYPTION_KEY, a GitHub secret) can both encrypt AND decrypt every backup, past and
# future. A public-key split (CI holds only a public key; decrypting needs a private key that
# never touches CI) would mean a leaked CI secret couldn't read any backup -- a real tradeoff,
# left as symmetric for now because it needs no keypair management from a non-technical operator.
#
# Oct 11 2026 cold-review fixes (two real issues caught before this shipped):
# (1) the passphrase used to be passed as a bare CLI arg to `gpg --passphrase`, which is visible
# to anything that can read this process's argv (e.g. `ps aux`) for as long as it runs. Low risk
# on GitHub's ephemeral, single-tenant hosted runners specifically, but a known anti-pattern
# worth not doing anyway -- now written to a 600-permission temp file and passed via
# --passphrase-file instead, cleaned up by the same trap as the other temp files.
# (2) `pg_restore --clean` had no `--single-transaction`. Without it, a restore that dies partway
# (disk full, one bad object) leaves some tables dropped-and-empty and others restored -- a WORSE
# state than the wrong/corrupted database you started from. --single-transaction wraps the whole
# restore in one transaction so a failure rolls back completely instead of partially landing.
set -euo pipefail

cmd="${1:-}"

usage() {
  echo "usage:" >&2
  echo "  backup-db.sh dump    <DATABASE_URL> <passphrase> <output-file.gpg>" >&2
  echo "  backup-db.sh restore <input-file.gpg> <passphrase> <DATABASE_URL>" >&2
  exit 1
}

case "$cmd" in
  dump)
    db_url="${2:?DATABASE_URL required}"
    passphrase="${3:?passphrase required}"
    out="${4:?output path required}"
    tmp="$(mktemp)"
    pass_file="$(mktemp)"
    chmod 600 "$pass_file"
    trap 'rm -f "$tmp" "$pass_file"' EXIT
    printf '%s' "$passphrase" > "$pass_file"
    pg_dump "$db_url" -Fc -f "$tmp"
    gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$pass_file" -o "$out" "$tmp"
    echo "backup-db.sh: wrote $(wc -c < "$out" | tr -d ' ') encrypted bytes to $out"
    ;;
  restore)
    in="${2:?input path required}"
    passphrase="${3:?passphrase required}"
    db_url="${4:?DATABASE_URL required}"
    tmp="$(mktemp)"
    pass_file="$(mktemp)"
    chmod 600 "$pass_file"
    trap 'rm -f "$tmp" "$pass_file"' EXIT
    printf '%s' "$passphrase" > "$pass_file"
    gpg --batch --yes --decrypt --passphrase-file "$pass_file" -o "$tmp" "$in"
    # --clean --if-exists drops the restore target's own objects first. Restoring into an
    # ALREADY-POPULATED database -- the real disaster-recovery case, spotmeapp-db already exists,
    # it's just wrong/corrupted/wiped -- should win over whatever is already there, not error out
    # on "relation already exists" or silently merge old and new rows together.
    # --single-transaction: see the cold-review comment above -- a failure partway through rolls
    # back the whole restore instead of leaving some tables dropped-and-empty, others restored.
    pg_restore --clean --if-exists --single-transaction -d "$db_url" "$tmp"
    echo "backup-db.sh: restored into the target database"
    ;;
  *)
    usage
    ;;
esac
