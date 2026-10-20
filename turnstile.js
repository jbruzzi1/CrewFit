// Oct 20 2026 (App Store readiness review, "no CAPTCHA or bot-detection layer at all" item).
// Jeff's own fair pushback before building this: "I feel like many fitness apps aren't using
// captcha" -- true for native apps specifically, which lean on Apple App Attest / Google Play
// Integrity instead (a separate, later piece of work once CrewFit is actually wrapped natively --
// see CLAUDE.md hard rule #8's standing "is this browser-specific" question). CrewFit is tested
// and used today as a website, not a native/wrapped app, so POST /api/register is a plain public
// HTTP endpoint with none of that app-store-distribution friction or device-attestation signal.
// Rate limiting (see server.js's overLimit('reg:'+ip, ...)) handles accidents and simple scripts;
// it doesn't stop someone with a handful of rotating IPs.
//
// Cloudflare Turnstile, not a classic visible CAPTCHA puzzle -- rendered client-side with
// appearance:'interaction-only' (see public/app.js), so it stays invisible unless Cloudflare
// actually needs to show a real challenge. Confirmed (Cloudflare's own mobile-implementation docs)
// that this still works inside a WebView-wrapped native app later, with some configuration to get
// right at that point (JS/storage enabled, challenges.cloudflare.com reachable, stable user agent,
// cookies/storage persisted across the session) -- flagged here, not treated as "done forever,"
// per hard rule #8. Re-verify this specific piece if/when a native wrapper actually ships.
//
// Same "env var wins, else byte-identical no-op" shape every other Phase 3 slice in this app uses
// (see storage.js, loadOrCreateSecret in server.js): unconfigured today, and in every test in this
// suite, so this is a pure no-op -- POST /api/register behaves exactly as it did before this file
// existed -- until Jeff actually creates a Turnstile widget and sets TURNSTILE_SECRET_KEY (and the
// client-safe TURNSTILE_SITE_KEY) as real Fly secrets.
const SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
// Client-safe by design (Turnstile's own model -- this is meant to be public, same as a reCAPTCHA
// sitekey), exposed to the client via GET /api/config in server.js.
const SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
// Override point for tests only (see test/turnstile-bot-defense.mjs) -- a from-scratch local HTTP
// server standing in for the real siteverify endpoint, not a mock of this module's own internals,
// same spirit as Phase 3 Slice 1b's storage.js tests. Defaults to the real Cloudflare endpoint
// (exact shape confirmed against Cloudflare's own docs, not guessed: POST, JSON or form body,
// {secret, response, remoteip?}, response {success, 'error-codes'?}).
const VERIFY_URL = process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_ON = !!SECRET_KEY;
if (TURNSTILE_ON) console.log('Turnstile bot-defense: ON');

// Returns { ok: true } (pass -- including the "unconfigured" and "fail-open" no-op cases) or
// { ok: false, error } (a genuine, Cloudflare-confirmed failure -- bad/missing/expired/reused
// token). Never throws.
async function verifyTurnstile(token, remoteip) {
  if (!TURNSTILE_ON) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: 'missing-input-response' };
  let data;
  try {
    const r = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET_KEY, response: token, ...(remoteip ? { remoteip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    data = await r.json();
  } catch (e) {
    // Oct 20 2026 (disclosed design choice, not an oversight): fails OPEN on a transport/timeout
    // error talking to Cloudflare -- this is one defense-in-depth layer on top of the existing
    // per-IP rate limit, not the only gate, and a Cloudflare-side hiccup taking down all new
    // signups would be a worse outcome than this layer being briefly unavailable. Logged loudly so
    // a real outage is visible in the logs, not silently swallowed.
    console.error('Turnstile verify request failed (failing OPEN, registration proceeds):', e && e.message || e);
    return { ok: true, failedOpen: true };
  }
  // A real response FROM Cloudflare saying the challenge failed (bad token, expired, already
  // used, wrong secret, etc.) fails CLOSED -- this is the actual signal the whole feature exists
  // to act on, unlike the transport-error case just above.
  if (!data || data.success !== true) {
    const code = (data && Array.isArray(data['error-codes']) && data['error-codes'][0]) || 'verification-failed';
    return { ok: false, error: code };
  }
  return { ok: true };
}

module.exports = { verifyTurnstile, TURNSTILE_ON, SITE_KEY };
