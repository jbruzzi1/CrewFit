// Oct 19 2026 (Phase 3 Slice 1b -- off-single-machine prep). Every uploaded photo/avatar used to
// live only on spotmeapp_data, the volume mounted at DATA_DIR/uploads -- tied to one physical
// Fly host, same blocker that already kept the auth secret (see server.js's loadOrCreateSecret,
// fixed in Slice 1a) and blue-green deploys stuck on a single machine.
//
// This module is the one place every upload/download/delete of a user file goes through, with
// the exact same "env var wins, else fall back to local disk" shape Slice 1a used for the auth
// secret -- purely additive, zero behavior change for today's single-machine deploy until Jeff
// actually creates the bucket and sets the three env vars below as Fly secrets.
//
// Backend is Supabase Storage (the official @supabase/supabase-js client, not a hand-rolled REST
// call against a guessed API shape) -- Jeff's database is already on Supabase, so this is one
// less vendor to run and pay for, not a new one.
//
// Deliberately asymmetric, and that asymmetry is the point, not an oversight:
//   - WRITES go to Supabase Storage whenever it's configured, never to local disk once it is.
//   - READS try Supabase Storage first (when configured), then fall back to local disk. This
//     means every photo uploaded BEFORE Jeff sets these secrets keeps serving correctly forever
//     without a bulk backfill step -- old files simply stay findable on the volume, new files
//     land in Storage. A full backfill (copy every pre-existing file into Storage, so the volume
//     could eventually be deleted outright) is a disclosed, NOT-yet-done follow-up -- see
//     CLAUDE.md's Phase 3 section -- not required for this slice to be safe to ship.
//   - DELETES best-effort-remove from BOTH locations, since a given file could be in either one
//     depending on when it was created relative to the cutover -- same "swallow the error, this
//     is cleanup not a correctness path" spirit every existing unlink call site already uses.
const fs = require('fs');
const path = require('path');

const STORAGE_URL = process.env.SUPABASE_URL;
const STORAGE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;
const STORAGE_ON = !!(STORAGE_URL && STORAGE_KEY && STORAGE_BUCKET);

let bucket = null;
if (STORAGE_ON) {
  // Lazy-required so a deploy with none of these three set (today's deploy, and every test in
  // this suite) never even needs @supabase/supabase-js resolvable -- same spirit as Sentry's own
  // `try { Sentry = require('@sentry/node'); } catch {}` gate elsewhere in this app.
  const { createClient } = require('@supabase/supabase-js');
  bucket = createClient(STORAGE_URL, STORAGE_KEY, { auth: { persistSession: false } }).storage.from(STORAGE_BUCKET);
  console.log('Object storage: ON (Supabase bucket "' + STORAGE_BUCKET + '")');
}

const EXT_CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
function contentTypeFor(fname) {
  const ext = (fname.split('.').pop() || '').toLowerCase();
  return EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
}

// uploadDir is UPLOAD_DIR from server.js, passed in rather than imported, so this module has no
// hard dependency on server.js's own module-load order (same reasoning as pgmini.js staying a
// leaf module with no circular requires).
async function putObject(uploadDir, fname, buffer) {
  if (STORAGE_ON) {
    const { error } = await bucket.upload(fname, buffer, { contentType: contentTypeFor(fname), upsert: true });
    if (error) throw new Error('object storage upload failed: ' + (error.message || error));
    return;
  }
  fs.writeFileSync(path.join(uploadDir, fname), buffer);
}

// Returns a Buffer, or null if the object genuinely doesn't exist anywhere (caller decides
// whether that's a 404). Never throws for "not found" -- only for a real transport error.
async function getObject(uploadDir, fname) {
  if (STORAGE_ON) {
    const { data, error } = await bucket.download(fname);
    if (data) return Buffer.from(await data.arrayBuffer());
    // Fall through to local disk below on ANY download error (not just "not found" specifically)
    // -- a pre-cutover file living only on the volume is expected to 404 from Storage, and
    // treating that as fatal would break every photo uploaded before Jeff set these secrets.
    //
    // Cold-review catch (Oct 19 2026): this used to swallow `error` with no logging at all --
    // completely silent, forever, for a file that's actually ON the local disk fallback (the
    // common case right after cutover, and for any OLD file that never gets backfilled). A wrong
    // bucket name or bad credentials would degrade 100% of reads to local-disk-only with zero
    // signal anything was wrong -- the only visible symptom would be a brand-NEW upload 404ing,
    // which looks like an unrelated missing-file bug, not a pointer back to the real
    // misconfiguration. Logged here (not reportNonFatal -- this module has no dependency on
    // server.js's Sentry wiring, same "leaf module" reasoning as pgmini.js staying dependency-free)
    // so a real Storage outage/misconfig is at least visible in the server logs, not just inferred
    // after the fact from a confusing downstream symptom.
    console.error('OBJECT_STORAGE_READ_ERR', fname, error && (error.message || error));
  }
  const local = path.join(uploadDir, fname);
  try { return fs.readFileSync(local); } catch (e) { return null; }
}

// Best-effort, swallows errors -- matches every existing fs.unlinkSync(...) call site's own
// try/catch, "a leftover unreferenced file is acceptable, a thrown error from cleanup is not."
async function deleteObject(uploadDir, fname) {
  if (STORAGE_ON) {
    try { await bucket.remove([fname]); } catch (e) {}
  }
  try { fs.unlinkSync(path.join(uploadDir, fname)); } catch (e) {}
}

module.exports = { STORAGE_ON, STORAGE_BUCKET, putObject, getObject, deleteObject, contentTypeFor };
