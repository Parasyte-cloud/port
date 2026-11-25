// PCS server: zero-dependency Node.js (>=22). Serves the web app, a session-authenticated JSON API,
// an API-key integration API for partner systems, server-sent events for real-time updates,
// health/metrics endpoints, and an append-only command log for durability and replay (DR).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEngine, PcsError } from './core/engine.js';
import { makeQueries } from './core/queries.js';
import { buildSeed } from './core/seed.js';
import { hashPassword } from './core/sha256.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.PCS_DATA_DIR || path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA, 'commands.jsonl');
const PORT = Number(process.env.PORT || 8080);
fs.mkdirSync(DATA, { recursive: true });
const SECRET = process.env.PCS_SECRET || (() => { const f = path.join(DATA, '.secret'); if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 }); return fs.readFileSync(f, 'utf8'); })();

const E = createEngine();
const Q = makeQueries(E);
const started = Date.now();
const metrics = { requests: 0, commands: 0, commandErrors: 0, byType: {}, latencyMs: [] };

function boot() {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 0) {
    const records = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    E.load(records);
    console.log(`Replayed ${records.length} commands; audit chain ${E.verifyAudit().ok ? 'verified' : 'BROKEN'}`);
  } else {
    const { log } = buildSeed(Date.now());
    E.load(log);
    fs.writeFileSync(LOG_FILE, log.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`Seeded showcase data: ${log.length} commands`);
  }
}
boot();
E.onCommit((rec) => { fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n'); broadcast(rec); });

// ---- auth: HMAC-signed stateless tokens (survive restarts)
const sign = (obj) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${crypto.createHmac('sha256', SECRET).update(b).digest('base64url')}`; };
function verifyToken(tok) {
  if (!tok) return null; const [b, s] = tok.split('.');
  if (!b || !s) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  const o = JSON.parse(Buffer.from(b, 'base64url').toString()); if (o.exp < Date.now()) return null;
  return o;
}
const secretFor = (pw) => { if (!pw || pw.length < 8) throw new PcsError('VALIDATION', 'Password must be at least 8 characters'); const salt = crypto.randomBytes(12).toString('hex'); return { salt, passwordHash: hashPassword(pw, salt) }; };

function exec(type, userId, payload) {
  const t0 = Date.now();
  try { const r = E.execute({ type, userId, at: E.now(Date.now()), payload }); metrics.commands++; metrics.byType[type] = (metrics.byType[type] || 0) + 1; return r; }
  catch (e) { metrics.commandErrors++; throw e; }
  finally { metrics.latencyMs.push(Date.now() - t0); if (metrics.latencyMs.length > 500) metrics.latencyMs.shift(); }
}

// ---- SSE
const clients = new Set();
function broadcast(rec) { const msg = `data: ${JSON.stringify({ seq: rec.seq, type: rec.type, at: rec.at })}\n\n`; for (const c of clients) c.write(msg); }

// ---- http helpers
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:" };
const readBody = (req) => new Promise((resolve, reject) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) { reject(new PcsError('VALIDATION', 'Payload too large')); req.destroy(); } }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new PcsError('VALIDATION', 'Invalid JSON')); } }); });
const errCode = (e) => ({ AUTH: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 422, DUPLICATE: 409, CONFLICT: 409, STATE: 409, CAPACITY: 409, LOCKED: 423 })[e.code] || 500;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const base = p.startsWith('/core/') ? ROOT : path.join(ROOT, 'public');
  const file = path.normalize(path.join(base, p));
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { p = '/index.html'; return serveStatic(req, res, p); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', ...SEC_HEADERS });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  metrics.requests++;
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);
    const auth = verifyToken((req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token'));
    const actor = auth && E.state.users[auth.uid] ? E.actorFrom(auth.uid) : null;

    if (p === '/api/health') return send(res, 200, { status: 'ok', uptimeS: Math.round((Date.now() - started) / 1000), commands: E.log.length, auditEntries: E.state.audit.length, auditChain: E.verifyAudit().ok ? 'verified' : 'broken' });
    if (p === '/api/metrics') {
      const l = [...metrics.latencyMs].sort((a, b) => a - b); const q = (x) => l[Math.floor(l.length * x)] || 0;
      return send(res, 200, [`pcs_http_requests_total ${metrics.requests}`, `pcs_commands_total ${metrics.commands}`, `pcs_command_errors_total ${metrics.commandErrors}`, `pcs_command_latency_ms{quantile="0.5"} ${q(0.5)}`, `pcs_command_latency_ms{quantile="0.95"} ${q(0.95)}`, `pcs_log_records ${E.log.length}`, `pcs_sse_clients ${clients.size}`, ...Object.entries(metrics.byType).map(([k, v]) => `pcs_commands_by_type_total{type="${k}"} ${v}`)].join('\n') + '\n', { 'content-type': 'text/plain' });
    }
    if (p === '/api/stream') {
      if (!actor) return send(res, 401, { error: 'Sign in required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': ok\n\n');
      clients.add(res); const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); }); return;
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const now = E.now(Date.now());
      const locked = E.lockState(email || '', now); if (locked) return send(res, 423, { error: `Account locked until ${new Date(locked).toUTCString()} after repeated failures` });
      const u = E.findUserByEmail(email || '');
      if (!u || !E.verifyPassword(u, password || '')) { exec('auth.failed', null, { email }); return send(res, 401, { error: 'Email or password is incorrect' }); }
      if (!u.active) return send(res, 403, { error: 'User is deactivated' });
      exec('auth.login', u.id, { userId: u.id, channel: 'web' });
      return send(res, 200, { token: sign({ uid: u.id, exp: Date.now() + 12 * 3600e3 }), userId: u.id });
    }
    if (p === '/api/auth/register' && req.method === 'POST') {
      const b = await readBody(req);
      const r = exec('org.register', null, { ...b, admin: { name: b.adminName, email: b.adminEmail, title: b.adminTitle, ...secretFor(b.password) }, password: undefined });
      return send(res, 201, r);
    }
    if (p === '/api/track') return send(res, 200, Q.run(null, 'track', { ref: url.searchParams.get('ref') }) || { notFound: true });

    // ---- partner integration API (API key)
    if (p.startsWith('/api/v1/')) {
      const key = req.headers['x-api-key']; const orgId = key && E.apiKeyOrg(crypto.createHash('sha256').update(String(key)).digest('hex'));
      if (!orgId) return send(res, 401, { error: 'Valid X-API-Key required' });
      const sysUser = Object.values(E.state.users).find((u) => u.orgId === orgId && u.admin && u.active);
      const a = E.actorFrom(sysUser.id);
      if (p === '/api/v1/manifests' && req.method === 'POST') return send(res, 201, exec('manifest.submit', sysUser.id, { ...(await readBody(req)), source: 'api' }));
      if (p === '/api/v1/shipments') return send(res, 200, Q.run(a, 'shipments', {}));
      if (p.startsWith('/api/v1/shipments/')) return send(res, 200, Q.run(a, 'shipment', { id: p.split('/').pop() }) || { notFound: true });
      if (p === '/api/v1/events') return send(res, 200, Q.run(a, 'notifications', {}));
      return send(res, 404, { error: 'Unknown endpoint' });
    }

    if (!actor) return send(res, 401, { error: 'Sign in required' });
    if (p === '/api/cmd' && req.method === 'POST') {
      const { type, payload = {} } = await readBody(req);
      let pl = payload; let extra = {};
      if (type === 'user.create') { pl = { ...payload, ...secretFor(payload.password) }; delete pl.password; }
      if (type === 'org.register') { pl = { ...payload, admin: { name: payload.adminName, email: payload.adminEmail, ...secretFor(payload.password) } }; delete pl.password; }
      if (type === 'org.apikey.rotate') { const key = `pcs_${crypto.randomBytes(24).toString('base64url')}`; pl = { keyHash: crypto.createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 8) }; extra = { apiKey: key }; }
      return send(res, 200, { ok: true, result: { ...exec(type, actor.userId, pl), ...extra } });
    }
    if (p === '/api/reset' && req.method === 'POST') {
      if (!(actor.orgType === 'NPA' && actor.admin)) return send(res, 403, { error: 'Only the Port Authority administrator can reset the showcase' });
      const { log } = buildSeed(Date.now()); E.load(log); fs.writeFileSync(LOG_FILE, log.map((r) => JSON.stringify(r)).join('\n') + '\n'); broadcast({ seq: 0, type: 'reset', at: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/dr/rebuild' && req.method === 'POST') {
      if (!['NPA', 'AUDIT'].includes(actor.orgType)) return send(res, 403, { error: 'Not permitted' });
      const t0 = Date.now(); const before = E.state.lastHash; const records = E.log.slice(); E.load(records);
      return send(res, 200, { replayed: records.length, ms: Date.now() - t0, headBefore: before, headAfter: E.state.lastHash, identical: before === E.state.lastHash });
    }
    if (p === '/api/export/audit.csv') {
      const { entries } = Q.run(actor, 'audit', { limit: 500, q: url.searchParams.get('q') || '' });
      const csv = ['n,at,actor,organisation,action,trace,summary,hash', ...entries.map((e) => [e.n, new Date(e.at).toISOString(), e.by.name, e.by.orgName || '', e.action, e.trace || '', e.summary, e.hash].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
      return send(res, 200, csv, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="pcs-audit.csv"' });
    }
    if (p.startsWith('/api/q/')) return send(res, 200, Q.run(actor, p.slice(7), Object.fromEntries(url.searchParams)) ?? null);
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!(e instanceof PcsError) && !e.code) console.error(e);
    return send(res, errCode(e), { error: e.message, code: e.code, details: e.details });
  }
});
server.listen(PORT, () => console.log(`PCS running on http://localhost:${PORT}`));
