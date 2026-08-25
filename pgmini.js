// Minimal, dependency-free Postgres client.
//
// Why this exists instead of `require('pg')`: this project's data layer used to be one
// JSON file rewritten in full on every save (see server.js's old load()/save() history) —
// no transactions, no concurrent-write protection, no real backups. Moving to Postgres
// fixes that. The standard `pg` npm package would normally be the obvious choice, but it
// could not be installed in the sandbox this migration was built and tested in (no
// package-registry access at all — npm, apt, pip were all blocked). Rather than write code
// against an untested dependency and hope it behaves the same in production, this is a
// small hand-written client using only Node's built-in `net` and `crypto` modules, so the
// exact code that was tested here (against a real local Postgres 16) is the exact code
// that runs in production — no dev/prod divergence, and one less `npm install` step that
// could fail mid-deploy.
//
// Deliberately narrow scope: supports exactly what server.js needs (parameterized queries,
// transactions, scram-sha-256 auth) and nothing else — no connection pooling (this app's
// traffic doesn't need it; a single persistent connection with a FIFO query queue is
// simpler and just as correct), no binary result format, no COPY, no LISTEN/NOTIFY.
//
// Protocol reference: https://www.postgresql.org/docs/current/protocol.html

const net = require('net');
const crypto = require('crypto');

// ---- wire framing helpers ----

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function cstr(s) { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); }

function frontendMessage(type, payload) {
  // type is a single ASCII char, or null for the untyped StartupMessage
  const len = u32(payload.length + 4);
  return type ? Buffer.concat([Buffer.from(type), len, payload]) : Buffer.concat([len, payload]);
}

function startupMessage(user, database) {
  const parts = [
    Buffer.from('user\0', 'ascii'), cstr(user),
    Buffer.from('database\0', 'ascii'), cstr(database),
    Buffer.from('client_encoding\0', 'ascii'), cstr('UTF8'),
    Buffer.from([0]),
  ];
  const body = Buffer.concat([u32(196608), ...parts]); // protocol version 3.0
  return frontendMessage(null, body);
}

// ---- SCRAM-SHA-256 (RFC 5802 / RFC 7677), no channel binding ----

function randomNonce() { return crypto.randomBytes(18).toString('base64'); }
function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }
function xorBuf(a, b) { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; }

class ScramState {
  constructor(password) {
    this.password = password;
    this.clientNonce = randomNonce();
    this.clientFirstBare = `n=*,r=${this.clientNonce}`;
  }
  clientFirstMessage() { return `n,,${this.clientFirstBare}`; }
  // server sends: r=<combined nonce>,s=<base64 salt>,i=<iterations>
  handleServerFirst(serverFirstMessage) {
    this.serverFirstMessage = serverFirstMessage;
    const m = /r=([^,]+),s=([^,]+),i=(\d+)/.exec(serverFirstMessage);
    if (!m) throw new Error('SCRAM: malformed server-first-message: ' + serverFirstMessage);
    const [, combinedNonce, saltB64, iterStr] = m;
    if (!combinedNonce.startsWith(this.clientNonce)) throw new Error('SCRAM: server nonce does not extend client nonce (possible MITM)');
    const salt = Buffer.from(saltB64, 'base64');
    const iterations = parseInt(iterStr, 10);
    const saltedPassword = crypto.pbkdf2Sync(this.password, salt, iterations, 32, 'sha256');
    const clientKey = hmac(saltedPassword, 'Client Key');
    const storedKey = sha256(clientKey);
    const channelBinding = Buffer.from('n,,', 'utf8').toString('base64');
    const clientFinalWithoutProof = `c=${channelBinding},r=${combinedNonce}`;
    const authMessage = `${this.clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
    const clientSignature = hmac(storedKey, authMessage);
    const clientProof = xorBuf(clientKey, clientSignature).toString('base64');
    this.serverKey = hmac(saltedPassword, 'Server Key');
    this.authMessage = authMessage;
    return `${clientFinalWithoutProof},p=${clientProof}`;
  }
  // server sends: v=<base64 server signature> — verify we're really talking to the DB, not
  // an impostor that guessed/relayed a valid client proof.
  verifyServerFinal(serverFinalMessage) {
    const m = /v=([^,]+)/.exec(serverFinalMessage);
    if (!m) throw new Error('SCRAM: malformed server-final-message: ' + serverFinalMessage);
    const expected = hmac(this.serverKey, this.authMessage).toString('base64');
    if (m[1] !== expected) throw new Error('SCRAM: server signature verification failed (possible MITM) — refusing the connection');
  }
}

// ---- connection ----

class PgConnection {
  constructor({ host, port, user, password, database }) {
    this.opts = { host, port, user, password, database };
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.queue = Promise.resolve(); // serializes all query() calls over the one connection
    this.connectPromise = null;
  }

  async ensureConnected() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connect().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.opts.host, port: this.opts.port });
      // Every query() call is a strict request/response round trip (write, then wait for
      // ReadyForQuery before the next one starts — see the FIFO queue below), which is exactly
      // the traffic pattern Nagle's algorithm plus the peer's delayed-ACK timer punishes: without
      // this, each round trip can stall ~40ms waiting for the ACK timer instead of returning as
      // soon as Postgres actually replies. save()'s per-collection sync issues dozens of small
      // sequential queries, so that 40ms was landing on every single one of them — this one call
      // was worth ~10x on save() latency in testing (measured ~440ms/write to ~10-40ms/write).
      sock.setNoDelay(true);
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; sock.destroy(); reject(e); } };
      // sock.on('error', fail) only matters before `settled` flips true (during the initial
      // connect+handshake) — fail() is a no-op after that. A cold review caught that a POST-connect
      // drop (Postgres restart, failover, a killed backend, an ordinary network blip) was then
      // handled by NOTHING: `close` only nulled this.socket, and whatever query was mid-flight —
      // sitting in _readUntil awaiting a reply — never got resolved OR rejected. It just hung
      // forever, and every later query() queued behind it via the FIFO queue (see query() below)
      // also hung forever, silently, with no error anywhere and /healthz still reporting healthy
      // (it only reads the in-memory DB, never touches Postgres). Reproduced with
      // pg_terminate_backend mid-query — a clean FIN, no 'error' event at all, just a hang.
      // _onSocketGone is the fix: any drop, at any point in the connection's life, rejects
      // whatever is currently waiting on a reply and clears this.socket so the NEXT query() call
      // reconnects instead of queuing behind a connection that is never coming back.
      sock.on('error', (e) => { fail(e); this._onSocketGone(e); });
      sock.once('connect', async () => {
        this.socket = sock;
        this.buf = Buffer.alloc(0);
        sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
        sock.on('close', () => { this._onSocketGone(new Error('PG connection closed unexpectedly')); });
        try {
          await this._handshake();
          if (!settled) { settled = true; resolve(); }
        } catch (e) { fail(e); }
      });
    });
  }

  // Drops the dead socket and, if a query (or the handshake) is actively waiting on a reply on
  // it, rejects that wait loudly instead of leaving it hanging — see the comment in _connect().
  _onSocketGone(err) {
    this.socket = null;
    if (this._pendingReject) {
      const reject = this._pendingReject;
      this._pending = null;
      this._pendingReject = null;
      reject(err);
    }
  }

  _write(buf) { this.socket.write(buf); }

  // Pulls one full message off this.buf and returns {type, payload} or null if incomplete.
  _takeMessage() {
    if (this.buf.length < 5) return null;
    const type = String.fromCharCode(this.buf[0]);
    const len = this.buf.readUInt32BE(1);
    if (this.buf.length < 1 + len) return null;
    const payload = this.buf.subarray(5, 1 + len);
    this.buf = this.buf.subarray(1 + len);
    return { type, payload };
  }

  // Called on every socket 'data' event. Feeds queued waiters via this._pending (set by
  // _readUntil while a handshake or query is actively awaiting messages).
  _pump() {
    if (!this._pending) return;
    while (true) {
      const msg = this._takeMessage();
      if (!msg) return;
      this._pending(msg);
      if (!this._pending) return; // waiter satisfied and cleared itself
    }
  }

  // Reads messages one at a time via a callback until it returns a truthy "done" value.
  // _pendingReject is tracked separately from _pending (not just closed over inside it) so
  // _onSocketGone can reject this exact promise directly if the connection dies mid-wait.
  _readUntil(onMessage) {
    return new Promise((resolve, reject) => {
      this._pending = (msg) => {
        let result;
        try { result = onMessage(msg); }
        catch (e) { this._pending = null; this._pendingReject = null; reject(e); return; }
        if (result !== undefined) { this._pending = null; this._pendingReject = null; resolve(result); }
      };
      this._pendingReject = reject;
      this._pump();
    });
  }

  async _handshake() {
    this._write(startupMessage(this.opts.user, this.opts.database));
    let scram = null;
    const result = await this._readUntil((msg) => {
      if (msg.type === 'E') throw pgError(msg.payload);
      if (msg.type === 'R') {
        const authType = msg.payload.readUInt32BE(0);
        if (authType === 0) return; // AuthenticationOk-during-startup edge case; keep reading
        if (authType === 10) { // SASL — offer list follows as null-terminated strings
          scram = new ScramState(this.opts.password);
          const first = scram.clientFirstMessage();
          const mechanism = cstr('SCRAM-SHA-256');
          const respBody = Buffer.concat([mechanism, u32(Buffer.byteLength(first)), Buffer.from(first, 'utf8')]);
          this._write(frontendMessage('p', respBody));
          return;
        }
        if (authType === 11) { // SASLContinue
          const serverFirst = msg.payload.subarray(4).toString('utf8');
          const clientFinal = scram.handleServerFirst(serverFirst);
          this._write(frontendMessage('p', Buffer.from(clientFinal, 'utf8')));
          return;
        }
        if (authType === 12) { // SASLFinal
          const serverFinal = msg.payload.subarray(4).toString('utf8');
          scram.verifyServerFinal(serverFinal);
          return;
        }
        if (authType === 3) { // cleartext password (fallback, e.g. local dev without scram)
          this._write(frontendMessage('p', cstr(this.opts.password)));
          return;
        }
        if (authType === 5) { // md5 password
          const salt = msg.payload.subarray(4);
          const inner = crypto.createHash('md5').update(this.opts.password + this.opts.user).digest('hex');
          const outer = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          this._write(frontendMessage('p', cstr(outer)));
          return;
        }
        throw new Error('PG auth: unsupported AuthenticationRequest type ' + authType);
      }
      if (msg.type === 'S' || msg.type === 'K') return; // ParameterStatus / BackendKeyData — ignore
      if (msg.type === 'Z') return true; // ReadyForQuery — handshake complete
      // Anything else during handshake is unexpected but non-fatal; keep reading.
    });
    return result;
  }

  // Extended query protocol: Parse (unnamed) + Bind (all params as text) + Describe +
  // Execute + Sync. Always requests text result format, so every value comes back as a
  // string (or null) and callers decode further (Number(), JSON.parse() for jsonb, etc.)
  // — this keeps the client from needing to understand Postgres's binary type encodings.
  async query(sql, params = []) {
    await this.ensureConnected();
    // Serialize: only one query in flight on this connection at a time.
    const run = this.queue.then(() => this._query(sql, params));
    // Keep the queue alive even if this query rejects, so later calls aren't stuck forever.
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  _query(sql, params) {
    const paramBufs = params.map(p => (p === null || p === undefined) ? null : Buffer.from(String(p), 'utf8'));
    const parse = Buffer.concat([
      cstr(''), cstr(sql), Buffer.from([0, 0]), // no parameter type OIDs specified — let PG infer
    ]);
    const bindParts = [cstr(''), cstr('')];
    bindParts.push(Buffer.alloc(2)); bindParts[bindParts.length - 1].writeUInt16BE(0, 0); // 0 param format codes = all text
    const nParamsBuf = Buffer.alloc(2); nParamsBuf.writeUInt16BE(paramBufs.length, 0);
    bindParts.push(nParamsBuf);
    for (const p of paramBufs) {
      if (p === null) { bindParts.push(Buffer.from([0xff, 0xff, 0xff, 0xff])); } // -1 length = NULL
      else { bindParts.push(u32(p.length)); bindParts.push(p); }
    }
    bindParts.push(Buffer.from([0, 0])); // 0 result format codes = all text
    const bind = Buffer.concat(bindParts);
    const describe = Buffer.concat([Buffer.from('P'), cstr('')]);
    const execute = Buffer.concat([cstr(''), u32(0)]);

    this._write(frontendMessage('P', parse));
    this._write(frontendMessage('B', bind));
    this._write(frontendMessage('D', describe));
    this._write(frontendMessage('E', execute));
    this._write(frontendMessage('S', Buffer.alloc(0)));

    let columns = null;
    const rows = [];
    let commandTag = '';
    let error = null;

    return this._readUntil((msg) => {
      switch (msg.type) {
        case 'T': { // RowDescription
          const n = msg.payload.readUInt16BE(0);
          let off = 2; columns = [];
          for (let i = 0; i < n; i++) {
            const end = msg.payload.indexOf(0, off);
            columns.push(msg.payload.subarray(off, end).toString('utf8'));
            off = end + 1 + 18; // name\0 + (tableOid4 + colAttr2 + typeOid4 + typeLen2 + typeMod4 + formatCode2)
          }
          return;
        }
        case 'D': { // DataRow
          const n = msg.payload.readUInt16BE(0);
          let off = 2; const row = {};
          for (let i = 0; i < n; i++) {
            const len = msg.payload.readInt32BE(off); off += 4;
            const val = len === -1 ? null : msg.payload.subarray(off, off + len).toString('utf8');
            if (len !== -1) off += len;
            row[columns[i]] = val;
          }
          rows.push(row);
          return;
        }
        case 'C': commandTag = msg.payload.toString('utf8').replace(/\0$/, ''); return;
        case 'E': error = pgError(msg.payload); return;
        case '1': case '2': case 'n': return; // ParseComplete / BindComplete / NoData
        case 'Z': // ReadyForQuery — this query's response is fully drained
          if (error) throw error;
          return { rows, commandTag };
        default: return;
      }
    });
  }

  async begin() { await this.query('BEGIN'); }
  async commit() { await this.query('COMMIT'); }
  async rollback() { await this.query('ROLLBACK').catch(() => {}); }

  close() { if (this.socket) { this.socket.end(); this.socket = null; } }
}

function pgError(payload) {
  // ErrorResponse body: repeated (1-byte field code + null-terminated string), ending in \0
  const fields = {};
  let off = 0;
  while (off < payload.length) {
    const code = String.fromCharCode(payload[off]); off += 1;
    if (code === '\0') break;
    const end = payload.indexOf(0, off);
    fields[code] = payload.subarray(off, end).toString('utf8');
    off = end + 1;
  }
  const e = new Error(`Postgres error ${fields.C || '?'}: ${fields.M || 'unknown error'}${fields.D ? ' — ' + fields.D : ''}`);
  e.pgCode = fields.C;
  e.pgDetail = fields.D;
  return e;
}

// Parses a standard postgres://user:password@host:port/database connection string (what
// Fly injects as DATABASE_URL when a Postgres app is attached) into PgConnection's options.
function parseConnString(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database: decodeURIComponent((u.pathname || '/').slice(1)) || 'postgres',
  };
}

module.exports = { PgConnection, parseConnString };
