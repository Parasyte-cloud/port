// Parasyte PCS on Cloudflare Workers.
// Static web app from Workers Static Assets; JSON API, sign-in and live updates from this Worker;
// the shared ledger in one Durable Object (worker/ledger.js); durable data in D1.
import * as A from './auth.js';
import { AuthError, cfg } from './auth.js';
import { sha256hex, signTicket, verifyTicket, randomToken } from './crypto.js';
import { DEMO_PASSWORD } from '../core/seed.js';
export { Ledger } from './ledger.js';

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...headers } });
const STATUS = { AUTH: 401, MFA: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 422, DUPLICATE: 409, CONFLICT: 409, STATE: 409, CAPACITY: 409, LOCKED: 423, UNKNOWN: 400, UNAVAILABLE: 503 };
const fail = (code, message, details) => { throw new AuthError(STATUS[code] || 400, message, code, details); };
const unwrap = (r) => { if (r.error) throw new AuthError(STATUS[r.error.code] || 500, r.error.message, r.error.code, r.error.details); return r.result; };
async function body(req) {
  const len = Number(req.headers.get('content-length') || 0); if (len > 2e6) fail('VALIDATION', 'Payload too large');
  const t = await req.text(); if (t.length > 2e6) fail('VALIDATION', 'Payload too large');
  try { return t ? JSON.parse(t) : {}; } catch { fail('VALIDATION', 'Invalid JSON'); }
}
const ledgerOf = (env) => env.LEDGER.get(env.LEDGER.idFromName('main'));
const ip = (req) => req.headers.get('cf-connecting-ip') || 'local';
const link = (env, req, kind, token) => `${cfg(env).appUrl || new URL(req.url).origin}/#${kind}/${token}`;
const PUBLIC_POST = new Set(['/api/auth/login', '/api/auth/password/forgot', '/api/auth/link/inspect', '/api/auth/link/redeem', '/api/setup']);

// Cross-site request guard for state-changing calls: same-origin browsers send Origin; partner API uses keys.
function sameOrigin(req) {
  const o = req.headers.get('origin'); if (!o) return true; // non-browser clients
  return o === new URL(req.url).origin;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url); const p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (req.method !== 'GET' && !p.startsWith('/api/v1/') && !sameOrigin(req)) fail('FORBIDDEN', 'Cross-site request refused');
      return await route(req, env, ctx, url, p);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message, code: e.code, details: e.details }, e.status);
      console.error(e); return json({ error: 'Internal error', code: 'INTERNAL' }, 500);
    }
  },
};

async function sessionFrom(req, env, url) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const s = await A.loadSession(env, token); if (!s) return null;
  const user = await ledgerOf(env).user(s.user_id);
  if (!user || !user.active) { await A.endSession(env, s); return null; }
  return { s, user };
}

async function route(req, env, ctx, url, p) {
  const L = ledgerOf(env); const c = cfg(env); const M = req.method;

  // ---------------- public
  if (p === '/api/config') return json({ mode: 'server', demoMode: c.demoMode, demoPassword: c.demoMode ? DEMO_PASSWORD : null, inviteOnly: true, mfaOrgTypes: c.mfaOrgTypes, emailDelivery: c.emailDelivery, needsSetup: !c.demoMode && !(await env.DB.prepare('SELECT 1 FROM credentials WHERE demo = 0 LIMIT 1').first()) });
  if (p === '/api/health') return json(await L.health());
  if (p === '/api/metrics') return new Response(await L.metricsText(), { headers: { 'content-type': 'text/plain', ...SEC_HEADERS } });
  if (p === '/api/track') { await A.rateLimit(env, `track:${ip(req)}`, 120, 60e3); return json(unwrap(await L.query(null, 'track', { ref: url.searchParams.get('ref') })) || { notFound: true }); }
  if (p === '/api/auth/register') fail('FORBIDDEN', 'Accounts are by invitation only. Ask the Port Authority to onboard your organisation.');

  if (p === '/api/auth/login' && M === 'POST') {
    const { email, password } = await body(req);
    await A.rateLimit(env, `login:${ip(req)}`, 30, 15 * 60e3);
    await A.rateLimit(env, `login-email:${String(email || '').toLowerCase()}`, 20, 15 * 60e3);
    const { user, stage } = await A.signIn(env, L, email, password);
    const token = await A.createSession(env, user.id, stage, req);
    if (stage === 'full') await L.system(user.id, 'auth.login', { userId: user.id, channel: 'web' });
    return json({ token, stage, userId: user.id });
  }
  if (p === '/api/auth/password/forgot' && M === 'POST') {
    const { email } = await body(req);
    await A.rateLimit(env, `forgot:${ip(req)}`, 5, 15 * 60e3);
    const user = await L.userByEmail(String(email || '').trim().toLowerCase());
    const cred = user && await A.getCred(env, user.id);
    if (user && user.active && cred && !cred.demo && c.emailDelivery === 'email') {
      const { token } = await A.issueLink(env, L, user, 'reset', null);
      ctx.waitUntil(A.sendMail(env, user.email, 'Reset your Parasyte PCS password', `Someone asked to reset the password for ${user.email}.\n\nOpen this link within 1 hour to choose a new password:\n${link(env, req, 'reset', token)}\n\nIf this was not you, ignore this email; your password is unchanged.`));
    }
    // Same answer whether or not the account exists (no account discovery).
    return json({ ok: true, delivery: c.emailDelivery, message: c.emailDelivery === 'email' ? 'If that email belongs to an account, a reset link is on its way. It works for 1 hour.' : 'Email is not switched on for this server yet, so ask your organisation administrator to send you a reset link from Organisation & access.' });
  }
  if (p === '/api/auth/link/inspect' && M === 'POST') {
    await A.rateLimit(env, `link:${ip(req)}`, 30, 15 * 60e3);
    const { token } = await body(req); const { t, user } = await A.inspectLink(env, L, token);
    return json({ purpose: t.purpose, name: user.name, email: user.email, orgName: user.orgName, orgType: user.orgType, expiresAt: t.expires_at, mfaRequired: A.mfaRequired(env, user, null) });
  }
  if (p === '/api/auth/link/redeem' && M === 'POST') {
    await A.rateLimit(env, `link:${ip(req)}`, 30, 15 * 60e3);
    const { token, password } = await body(req);
    const { user, stage } = await A.redeemLink(env, L, token, password);
    const st = await A.createSession(env, user.id, stage, req);
    if (stage === 'full') await L.system(user.id, 'auth.login', { userId: user.id, channel: 'web' });
    return json({ token: st, stage, userId: user.id });
  }
  // First-run: create a sign-in link for the Port Authority administrator (needs the SETUP_TOKEN secret).
  if (p === '/api/setup' && M === 'POST') {
    await A.rateLimit(env, `setup:${ip(req)}`, 5, 15 * 60e3);
    const b = await body(req);
    if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 16 || !(await timingEq(b.setupToken, env.SETUP_TOKEN))) fail('FORBIDDEN', 'Setup token is not valid');
    if (await env.DB.prepare("SELECT 1 FROM credentials c WHERE c.demo = 0 LIMIT 1").first()) fail('STATE', 'Setup is already complete. Use invitations from Organisation & access.');
    let user;
    if ((await L.orgCount()) === 0) {
      const r = unwrap(await L.system(null, 'org.register', { name: b.orgName, type: 'NPA', email: b.orgEmail, tin: b.tin, rcNumber: b.rcNumber, address: b.address || '', admin: { name: b.adminName, email: b.adminEmail, title: b.adminTitle || 'Administrator' } }));
      user = await L.user(r.userId);
    } else {
      user = await L.userByEmail(String(b.adminEmail || '').toLowerCase());
      if (!user || user.orgType !== 'NPA' || !user.admin) fail('VALIDATION', 'adminEmail must be an existing Port Authority administrator');
    }
    const { token, expiresAt } = await A.issueLink(env, L, user, 'invite', null);
    return json({ link: link(env, req, 'invite', token), expiresAt, userId: user.id });
  }

  // ---------------- partner integration API (API key)
  if (p.startsWith('/api/v1/')) {
    const key = req.headers.get('x-api-key');
    await A.rateLimit(env, `api:${ip(req)}`, 600, 60e3);
    const uid = key && await L.apiKeyOrg(await sha256hex(String(key)));
    if (!uid) fail('AUTH', 'Valid X-API-Key required');
    if (p === '/api/v1/manifests' && M === 'POST') return json(unwrap(await L.command(uid, 'manifest.submit', { ...(await body(req)), source: 'api' })), 201);
    if (p === '/api/v1/shipments') return json(unwrap(await L.query(uid, 'shipments', {})));
    if (p.startsWith('/api/v1/shipments/')) return json(unwrap(await L.query(uid, 'shipment', { id: p.split('/').pop() })) || { notFound: true });
    if (p === '/api/v1/events') return json(unwrap(await L.query(uid, 'notifications', {})));
    fail('NOT_FOUND', 'Unknown endpoint');
  }

  // ---------------- live updates
  if (p === '/api/ws') {
    const t = await verifyTicket(A.requireSecret(env), url.searchParams.get('ticket'));
    if (!t) return new Response('Ticket expired', { status: 401 });
    const s = await env.DB.prepare("SELECT user_id FROM sessions WHERE id_hash = ? AND stage = 'full' AND expires_at > ?").bind(t.sid, Date.now()).first();
    if (!s) return new Response('Session ended', { status: 401 });
    const h = new Headers(req.headers); h.set('x-pcs-user', s.user_id); h.set('x-pcs-sid', t.sid);
    return L.fetch(new Request(req, { headers: h }));
  }

  // ---------------- signed in (any stage)
  const auth = await sessionFrom(req, env, url);
  if (!auth) fail('AUTH', 'Sign in required');
  const { s, user } = auth;
  if (p === '/api/auth/logout' && M === 'POST') { await A.endSession(env, s); await L.sessionsClosed(s.id); return json({ ok: true }); }
  if (p === '/api/auth/me') { const cred = await A.getCred(env, user.id); return json({ stage: s.stage, user, mfa: { enabled: !!cred?.totp_enabled, required: A.mfaRequired(env, user, cred) }, demoAccount: !!cred?.demo, sessionExpiresAt: s.expires_at }); }
  if (p === '/api/auth/mfa/verify' && M === 'POST') {
    if (s.stage !== 'mfa') fail('STATE', 'No 2-step check is pending');
    const how = await A.mfaVerify(env, L, user, (await body(req)).code);
    await A.promoteSession(env, s); await L.system(user.id, 'auth.login', { userId: user.id, channel: `web + ${how === 'totp' ? 'authenticator code' : 'recovery code'}` });
    return json({ stage: 'full' });
  }
  if (p === '/api/auth/mfa/setup' && M === 'POST') { if (!['mfa_setup', 'full'].includes(s.stage)) fail('STATE', 'Finish signing in first'); return json(await A.mfaBegin(env, user)); }
  if (p === '/api/auth/mfa/enable' && M === 'POST') {
    if (!['mfa_setup', 'full'].includes(s.stage)) fail('STATE', 'Finish signing in first');
    const codes = await A.mfaEnable(env, L, user, (await body(req)).code);
    if (s.stage === 'mfa_setup') { await A.promoteSession(env, s); await L.system(user.id, 'auth.login', { userId: user.id, channel: 'web + authenticator code (first setup)' }); }
    return json({ stage: 'full', recoveryCodes: codes });
  }
  if (s.stage !== 'full') fail('MFA', s.stage === 'mfa' ? 'Enter your 2-step verification code' : 'Set up 2-step verification to continue');

  // ---------------- fully signed in
  if (p === '/api/auth/mfa/disable' && M === 'POST') { await A.mfaDisable(env, L, user, (await body(req)).password); return json({ ok: true }); }
  if (p === '/api/auth/password/change' && M === 'POST') {
    const cred = await A.getCred(env, user.id); if (cred?.demo) fail('FORBIDDEN', 'Shared demo accounts keep the published demo password.');
    const b = await body(req); await A.changePassword(env, L, user, b.current, b.next, s.id); return json({ ok: true });
  }
  if (p === '/api/auth/logout-all' && M === 'POST') { await A.endAllSessions(env, user.id); await L.kick(user.id); await L.system(user.id, 'auth.event', { event: 'sessions.revoked', subject: user.id, summary: 'signed out on every device' }); return json({ ok: true }); }
  if (p === '/api/ws-ticket' && M === 'POST') return json({ ticket: await signTicket(A.requireSecret(env), { sid: s.id, exp: Date.now() + 60e3, n: randomToken(8) }) });

  // Accounts the caller may manage: own organisation for org admins; every organisation for the Port Authority admin.
  const manageable = async () => {
    if (!user.admin) fail('FORBIDDEN', 'Only organisation administrators can manage users');
    const all = user.orgType === 'NPA';
    return (await L.usersIn(all ? null : [user.orgId]));
  };
  if (p === '/api/admin/accounts') {
    const users = await manageable(); const st = await A.credStatus(env, users.map((u) => u.id));
    const pend = await env.DB.prepare(`SELECT user_id, purpose, expires_at FROM auth_tokens WHERE used_at IS NULL AND expires_at > ?`).bind(Date.now()).all();
    const live = Object.fromEntries(pend.results.map((r) => [r.user_id, r]));
    return json(Object.fromEntries(users.map((u) => [u.id, { ...(st[u.id] || { hasPassword: false, mfa: false }), mfaRequired: A.mfaRequired(env, u, st[u.id]), pendingLink: live[u.id] ? { purpose: live[u.id].purpose, expiresAt: live[u.id].expires_at } : null }])));
  }
  if (p === '/api/admin/link' && M === 'POST') {
    const { userId } = await body(req);
    const target = (await manageable()).find((u) => u.id === userId);
    if (!target) fail('NOT_FOUND', 'User not found in your scope');
    if (user.orgType === 'NPA' && target.orgId !== user.orgId && !target.admin) fail('FORBIDDEN', 'The Port Authority manages each organisation’s administrators; that organisation’s admin invites its own staff.');
    if (!target.active) fail('STATE', 'Activate the user first');
    const cred = await A.getCred(env, target.id);
    if (cred?.demo) fail('STATE', 'This is a shared demo persona; it signs in with the demo password.');
    const purpose = cred ? 'reset' : 'invite';
    const issued = await A.issueLink(env, L, target, purpose, user.id);
    const href = link(env, req, purpose, issued.token);
    const emailed = await A.sendMail(env, target.email, purpose === 'invite' ? `You are invited to Parasyte PCS (${target.orgName})` : 'Your Parasyte PCS password reset link', `${user.name} (${user.orgName}) ${purpose === 'invite' ? 'invited you to the Parasyte Port Community System' : 'sent you a password reset link'}.\n\nOpen this link to set your password${purpose === 'invite' ? ' (valid 7 days)' : ' (valid 1 hour)'}:\n${href}`);
    return json({ purpose, link: href, emailed, expiresAt: issued.expiresAt });
  }

  if (p === '/api/cmd' && M === 'POST') {
    const { type, payload = {} } = await body(req);
    await A.rateLimit(env, `cmd:${user.id}`, 240, 60e3);
    let pl = { ...payload }; let extra = {};
    if (type === 'org.register') {
      if (!(user.orgType === 'NPA' && user.admin)) fail('FORBIDDEN', 'Organisations are onboarded by the Port Authority administrator (invite-only).');
      pl = { ...payload, admin: { name: payload.adminName, email: payload.adminEmail, title: payload.adminTitle || 'Administrator' } };
      delete pl.password; delete pl.adminName; delete pl.adminEmail; delete pl.adminTitle;
    }
    if (type === 'user.create') { delete pl.password; delete pl.passwordHash; delete pl.salt; }
    if (type === 'org.apikey.rotate') { const key = `pcs_${randomToken(24)}`; pl = { keyHash: await sha256hex(key), keyPrefix: key.slice(0, 8) }; extra = { apiKey: key }; }
    const result = unwrap(await L.command(user.id, type, pl));
    // New people get a single-use invitation link instead of a password chosen by someone else.
    if (type === 'user.create' || type === 'org.register') {
      const invitee = await L.user(result.userId);
      const issued = await A.issueLink(env, L, invitee, 'invite', user.id);
      const href = link(env, req, 'invite', issued.token);
      const emailed = await A.sendMail(env, invitee.email, `You are invited to Parasyte PCS (${invitee.orgName})`, `${user.name} (${user.orgName}) invited you to the Parasyte Port Community System as ${invitee.title}.\n\nOpen this link within 7 days to set your password:\n${href}`);
      extra = { invite: { link: href, emailed, expiresAt: issued.expiresAt } };
    }
    if (type === 'user.setActive' && payload.active === false) { await A.endAllSessions(env, payload.userId); await L.kick(payload.userId); }
    return json({ ok: true, result: { ...result, ...extra } });
  }
  if (p === '/api/reset' && M === 'POST') {
    if (!c.demoMode) fail('FORBIDDEN', 'Resetting data is only available in demo mode');
    if (!(user.orgType === 'NPA' && user.admin)) fail('FORBIDDEN', 'Only the Port Authority administrator can reset the showcase');
    const r = await L.reset();
    await A.dropOrphans(env, r.users);
    return json({ ok: true });
  }
  if (p === '/api/dr/rebuild' && M === 'POST') { if (!['NPA', 'AUDIT'].includes(user.orgType)) fail('FORBIDDEN', 'Not permitted'); return json(await L.rebuild()); }
  if (p === '/api/export/audit.csv') return new Response(await L.auditCsv(user.id, url.searchParams.get('q')), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="pcs-audit.csv"', ...SEC_HEADERS } });
  if (p.startsWith('/api/q/')) return json(unwrap(await L.query(user.id, p.slice(7), Object.fromEntries(url.searchParams))));
  fail('NOT_FOUND', 'Not found');
}

async function timingEq(a, b) { const [x, y] = await Promise.all([sha256hex(String(a || '')), sha256hex(String(b || ''))]); let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i); return d === 0; }
