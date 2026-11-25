// Adapter: runs the full PCS engine inside the browser (showcase mode). Same rules, same queries;
// the command log is kept in this browser's localStorage so changes survive a reload.
import { createEngine } from '../core/engine.js';
import { makeQueries } from '../core/queries.js';
import { buildSeed } from '../core/seed.js';
import { hashPassword, sha256 } from '../core/sha256.js';

const KEY = 'pcs.showcase.v1';
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, '0')).join(''); };

export function createLocalApi() {
  const E = createEngine(); const Q = makeQueries(E);
  let seedLen = 0, seedNow = Date.now();
  const store = { get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }, set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} } };
  function boot(fresh) {
    const saved = fresh ? null : store.get();
    seedNow = saved?.seedNow || Date.now();
    const { log } = buildSeed(seedNow); seedLen = log.length;
    try { E.load(saved ? log.concat(saved.extra || []) : log); } catch (e) { console.warn('Saved showcase changes could not be replayed; starting fresh', e); E.load(log); store.set(null); }
    persist();
  }
  const persist = () => store.set({ seedNow, extra: E.log.slice(seedLen) });
  boot(false);
  const subs = new Set();
  E.onCommit((rec) => { persist(); setTimeout(() => subs.forEach((f) => f({ seq: rec.seq, type: rec.type })), 0); });
  let uid = null; try { uid = sessionStorage.getItem('pcs.local.uid'); } catch {}
  const now = () => E.now(Date.now());
  const run = (type, userId, payload) => E.execute({ type, userId, at: now(), payload });
  const wrap = (fn) => async (...a) => { try { return structuredClone(fn(...a)); } catch (e) { const err = new Error(e.message); err.code = e.code; err.details = e.details; throw err; } };
  const secret = (pw) => { if (!pw || pw.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { code: 'VALIDATION' }); const salt = rand(12); return { salt, passwordHash: hashPassword(pw, salt) }; };

  return {
    mode: 'local',
    get signedIn() { return !!uid && !!E.state.users[uid]; },
    login: wrap((email, password) => {
      const lock = E.lockState(email, now()); if (lock) throw Object.assign(new Error(`Account locked until ${new Date(lock).toLocaleTimeString()} after repeated failures`), { code: 'LOCKED' });
      const u = E.findUserByEmail(email);
      if (!u || !E.verifyPassword(u, password)) { run('auth.failed', null, { email }); throw Object.assign(new Error('Email or password is incorrect'), { code: 'AUTH' }); }
      if (!u.active) throw Object.assign(new Error('User is deactivated'), { code: 'FORBIDDEN' });
      run('auth.login', u.id, { userId: u.id, channel: 'web' }); uid = u.id; try { sessionStorage.setItem('pcs.local.uid', uid); } catch {}
      return { userId: u.id };
    }),
    logout() { uid = null; try { sessionStorage.removeItem('pcs.local.uid'); } catch {} },
    register: wrap((b) => run('org.register', null, { ...b, password: undefined, admin: { name: b.adminName, email: b.adminEmail, title: b.adminTitle, ...secret(b.password) } })),
    cmd: wrap((type, payload = {}) => {
      let pl = payload, extra = {};
      if (type === 'user.create') { pl = { ...payload, ...secret(payload.password) }; delete pl.password; }
      if (type === 'org.register') { pl = { ...payload, admin: { name: payload.adminName, email: payload.adminEmail, ...secret(payload.password) } }; delete pl.password; }
      if (type === 'org.apikey.rotate') { const key = `pcs_${rand(24)}`; pl = { keyHash: sha256(key), keyPrefix: key.slice(0, 8) }; extra = { apiKey: key }; }
      return { ...run(type, uid, pl), ...extra };
    }),
    q: wrap((name, params = {}) => Q.run(uid ? E.actorFrom(uid) : null, name, params)),
    track: wrap((ref) => Q.run(null, 'track', { ref }) || { notFound: true }),
    reset: wrap(() => { boot(true); subs.forEach((f) => f({ type: 'reset' })); return { ok: true }; }),
    rebuild: wrap(() => { const t0 = performance.now(); const before = E.state.lastHash; const recs = E.log.slice(); E.load(recs); return { replayed: recs.length, ms: Math.round(performance.now() - t0), headBefore: before, headAfter: E.state.lastHash, identical: before === E.state.lastHash }; }),
    auditCsv: wrap(() => { const { entries } = Q.run(E.actorFrom(uid), 'audit', { limit: 500 }); return ['n,at,actor,organisation,action,trace,summary,hash', ...entries.map((e) => [e.n, new Date(e.at).toISOString(), e.by.name, e.by.orgName || '', e.action, e.trace || '', e.summary, e.hash].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n'); }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
