// The shared ledger: one Durable Object instance owns the PCS engine for the whole platform.
//
// Why a Durable Object in front of D1: the engine is command-sourced and needs one writer applying
// commands in a single order. The DO gives exactly one live instance worldwide, so every user hits
// the same in-memory state; D1 holds the durable, append-only command log that the DO replays on
// start. A command is only acknowledged after its log row is written to D1; if that write fails the
// DO reloads from D1 so memory never runs ahead of the durable log.
//
// It also holds every open WebSocket (hibernation API) and pushes each committed change, plus the
// notifications addressed to that viewer's organisation, so a hand-over shows on the next
// person's screen within a second.
import { DurableObject } from 'cloudflare:workers';
import { createEngine, PcsError } from '../core/engine.js';
import { makeQueries } from '../core/queries.js';
import { buildSeed, DEMO_PASSWORD } from '../core/seed.js';
import { syncDemoCredentials } from './auth.js';
import { deliver } from './deliver.js';

const CLIENT_BLOCKED = /^(auth\.|system\.)/; // only the server itself may write sign-in and system events
const toErr = (e) => ({ error: { code: e.code || 'INTERNAL', message: e instanceof PcsError || e.code ? e.message : 'Internal error', details: e.details } });

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.E = createEngine(); this.Q = makeQueries(this.E);
    this.lock = Promise.resolve();
    this.metrics = { commands: 0, commandErrors: 0, byType: {}, bootMs: 0, replayed: 0 };
    this.E.onCommit((rec) => { this.pending = rec; });
    ctx.blockConcurrencyWhile(() => this.boot());
  }

  // ------------------------------------------------------------- persistence
  async readLog() {
    const out = []; let after = 0;
    for (;;) {
      const { results } = await this.env.DB.prepare('SELECT seq, type, user_id, at, payload FROM commands WHERE seq > ? ORDER BY seq LIMIT 1000').bind(after).all();
      for (const r of results) out.push({ seq: r.seq, type: r.type, userId: r.user_id, at: r.at, payload: JSON.parse(r.payload) });
      if (results.length < 1000) return out;
      after = results[results.length - 1].seq;
    }
  }
  async writeLog(records) {
    const now = Date.now();
    const stmts = records.map((r) => this.env.DB.prepare('INSERT INTO commands (seq, type, user_id, at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(r.seq, r.type, r.userId || null, r.at, JSON.stringify(r.payload || {}), now));
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
  }
  async boot() {
    const t0 = Date.now();
    let records = await this.readLog();
    if (!records.length) {
      const { log } = this.env.SEED === 'empty' ? { log: [{ seq: 1, type: 'system.init', userId: null, at: Date.now(), payload: { seed: `pcs-${crypto.randomUUID()}` } }] } : buildSeed(Date.now());
      await this.writeLog(log); records = log;
    }
    this.E.load(records);
    await this.syncDemo();
    this.metrics.bootMs = Date.now() - t0; this.metrics.replayed = records.length;
  }
  // Shared demo personas (the seeded @demo.pcs users) get the published demo password only while DEMO_MODE is on.
  async syncDemo() { await syncDemoCredentials(this.env, Object.values(this.E.state.users).filter((u) => u.email.endsWith('@demo.pcs')).map((u) => u.id), DEMO_PASSWORD); }
  // Serialise every write: execute in memory, persist, then acknowledge and broadcast.
  serial(fn) { const run = this.lock.then(fn, fn); this.lock = run.catch(() => {}); return run; }

  async apply(type, userId, payload, { fromClient = true } = {}) {
    return this.serial(async () => {
      if (fromClient && CLIENT_BLOCKED.test(type)) return toErr(new PcsError('FORBIDDEN', 'This action is reserved for the platform'));
      if (userId) { const u = this.E.state.users[userId]; if (!u) return toErr(new PcsError('AUTH', 'Unknown user')); }
      const before = this.E.state.notifications.length; const outBefore = this.E.state.outbox.length;
      let result; this.pending = null;
      try { result = this.E.execute({ type, userId, at: this.E.now(Date.now()), payload }); }
      catch (e) { this.metrics.commandErrors++; return toErr(e); }
      const rec = this.pending;
      try { await this.writeLog([rec]); }
      catch (e) {
        console.error('D1 append failed; reloading ledger from D1', e);
        this.E.load(await this.readLog());
        return toErr(new PcsError('UNAVAILABLE', 'The change could not be saved. Please try again.'));
      }
      this.metrics.commands++; this.metrics.byType[type] = (this.metrics.byType[type] || 0) + 1;
      this.broadcast(rec, this.E.state.notifications.slice(before));
      const msgs = structuredClone(this.E.state.outbox.slice(outBefore));
      if (msgs.length) { const orgs = this.E.state.orgs; const job = deliver(this.env, msgs, orgs).catch((e) => console.error('delivery failed', e)); this.ctx.waitUntil ? this.ctx.waitUntil(job) : null; }
      return { ok: true, result: structuredClone(result || {}) };
    });
  }

  // ------------------------------------------------------------- RPC surface (called by the Worker only)
  command(userId, type, payload = {}) { return this.apply(type, userId, payload); }
  system(userId, type, payload = {}) { return this.apply(type, userId, payload, { fromClient: false }); }
  query(userId, name, params = {}) {
    try {
      const a = userId ? this.E.actorFrom(userId) : null;
      if (a && !a.user.active) return toErr(new PcsError('AUTH', 'User is deactivated'));
      return { ok: true, result: structuredClone(this.Q.run(a, name, params) ?? null) };
    } catch (e) { return toErr(e); }
  }
  user(userId) { const u = this.E.state.users[userId]; return u ? this.userView(u) : null; }
  userByEmail(email) { const u = this.E.findUserByEmail(email || ''); return u ? this.userView(u) : null; }
  userView(u) { const o = this.E.state.orgs[u.orgId]; return { id: u.id, name: u.name, email: u.email, title: u.title, admin: !!u.admin, active: !!u.active, orgId: o.id, orgName: o.name, orgType: o.type, orgStatus: o.status }; }
  usersIn(orgIds) { return Object.values(this.E.state.users).filter((u) => !orgIds || orgIds.includes(u.orgId)).map((u) => this.userView(u)); }
  allUserIds() { return Object.keys(this.E.state.users); }
  orgCount() { return Object.keys(this.E.state.orgs).length; }
  apiKeyOrg(keyHash) {
    const orgId = this.E.apiKeyOrg(keyHash); if (!orgId) return null;
    const sys = Object.values(this.E.state.users).find((u) => u.orgId === orgId && u.admin && u.active);
    return sys ? sys.id : null;
  }
  health() { const v = this.E.verifyAudit(); return { status: 'ok', commands: this.E.log.length, auditEntries: this.E.state.audit.length, auditChain: v.ok ? 'verified' : 'broken', bootMs: this.metrics.bootMs, sockets: this.ctx.getWebSockets().length }; }
  metricsText() {
    const m = this.metrics;
    return [`pcs_commands_total ${m.commands}`, `pcs_command_errors_total ${m.commandErrors}`, `pcs_log_records ${this.E.log.length}`, `pcs_boot_replay_ms ${m.bootMs}`, `pcs_ws_clients ${this.ctx.getWebSockets().length}`, ...Object.entries(m.byType).map(([k, v]) => `pcs_commands_by_type_total{type="${k}"} ${v}`)].join('\n') + '\n';
  }
  async rebuild() {
    return this.serial(async () => {
      const t0 = Date.now(); const before = this.E.state.lastHash;
      const records = await this.readLog(); this.E.load(records);
      return { replayed: records.length, ms: Date.now() - t0, headBefore: before, headAfter: this.E.state.lastHash, identical: before === this.E.state.lastHash, source: 'D1 command log' };
    });
  }
  async reset() {
    return this.serial(async () => {
      await this.env.DB.prepare('DELETE FROM commands').run();
      const { log } = this.env.SEED === 'empty' ? { log: [{ seq: 1, type: 'system.init', userId: null, at: Date.now(), payload: { seed: `pcs-${crypto.randomUUID()}` } }] } : buildSeed(Date.now());
      await this.writeLog(log); this.E.load(log); await this.syncDemo();
      for (const ws of this.ctx.getWebSockets()) this.send(ws, { t: 'reset' });
      return { ok: true, users: Object.keys(this.E.state.users) };
    });
  }
  auditCsv(userId, q) {
    const { entries } = this.Q.run(this.E.actorFrom(userId), 'audit', { limit: 5000, q: q || '' });
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; }; // CSV-injection safe
    return ['n,at,actor,organisation,action,trace,summary,hash', ...entries.map((e) => [e.n, new Date(e.at).toISOString(), e.by.name, e.by.orgName || '', e.action, e.trace || '', e.summary, e.hash].map(cell).join(','))].join('\n');
  }
  // Closes live connections of a user (sign-out everywhere, password reset, deactivation).
  kick(userId) { for (const ws of this.ctx.getWebSockets(`u:${userId}`)) { try { ws.close(4001, 'Signed out'); } catch {} } }

  // ------------------------------------------------------------- live updates (WebSocket hibernation)
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const userId = request.headers.get('x-pcs-user'); const sid = request.headers.get('x-pcs-sid');
    const u = this.E.state.users[userId]; if (!u) return new Response('Unknown user', { status: 401 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [`u:${userId}`, `o:${u.orgId}`, `s:${sid}`]);
    pair[1].serializeAttachment({ userId, orgId: u.orgId, sid });
    this.send(pair[1], { t: 'hello', seq: this.E.state.seq });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('pong'); }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch {} }
  webSocketError() {}
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(rec, notes) {
    const actor = rec.userId && this.E.state.users[rec.userId];
    const by = actor ? { name: actor.name, orgName: this.E.state.orgs[actor.orgId]?.name, userId: actor.id } : null;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      const mine = notes.filter((n) => n.orgId === a.orgId).map(({ id, title, body, ref, severity }) => ({ id, title, body, ref, severity }));
      this.send(ws, { t: 'commit', seq: rec.seq, type: rec.type, at: rec.at, by: a.userId === by?.userId ? { self: true } : by, notices: a.userId === by?.userId ? [] : mine });
    }
  }
  sessionsClosed(sid) { for (const ws of this.ctx.getWebSockets(`s:${sid}`)) { try { ws.close(4001, 'Signed out'); } catch {} } }
}
