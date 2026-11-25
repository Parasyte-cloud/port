// Sign-in service: credentials, sessions, invites, password reset and 2FA, stored in D1.
// Identity (who a user is, their organisation and role) stays in the ledger; secrets never enter
// the command log or the audit trail, only the fact that a security event happened.
import { hashPassword, verifyPassword, needsRehash, dummyVerify, passwordProblems, randomToken, sha256hex, newTotpSecret, totpCheck, sealSecret, openSecret, randomBytes, base32 } from './crypto.js';

const MIN = 60e3, HOUR = 60 * MIN;
export const SESSION_ABSOLUTE = 12 * HOUR;   // one working shift
export const SESSION_IDLE = 2 * HOUR;
const STEP_UP_TTL = 10 * MIN;                 // a password-only session waiting for its 2FA code
const INVITE_TTL = 7 * 24 * HOUR;
const RESET_TTL = 1 * HOUR;
const MAX_FAILS = 5, LOCK_MS = 15 * MIN;

export class AuthError extends Error { constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; } }

export const cfg = (env) => ({
  demoMode: String(env.DEMO_MODE || '').toLowerCase() === 'on',
  mfaOrgTypes: String(env.MFA_ORG_TYPES ?? 'NPA,CUSTOMS,BANK').split(',').map((s) => s.trim()).filter(Boolean),
  emailDelivery: env.RESEND_API_KEY && env.MAIL_FROM ? 'email' : 'outbox',
  appUrl: (env.APP_URL || '').replace(/\/$/, ''),
});
export const mfaRequired = (env, user, cred) => cfg(env).mfaOrgTypes.includes(user.orgType) && !(cred?.demo && cfg(env).demoMode);

export function requireSecret(env) {
  if (!env.PCS_SECRET || env.PCS_SECRET.length < 32) throw new AuthError(500, 'Server is not configured: set the PCS_SECRET secret (32+ random characters).', 'CONFIG');
  return env.PCS_SECRET;
}

// ------------------------------------------------------------- rate limiting (fixed window, per key)
export async function rateLimit(env, key, limit, windowMs) {
  const now = Date.now(); const start = now - (now % windowMs);
  const row = await env.DB.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END, window_start = ?2 RETURNING count`).bind(key, start).first();
  if (row.count > limit) throw new AuthError(429, 'Too many attempts. Please wait a few minutes and try again.', 'RATE_LIMIT');
}

// ------------------------------------------------------------- credentials
export const getCred = (env, userId) => env.DB.prepare('SELECT * FROM credentials WHERE user_id = ?').bind(userId).first();
export async function credStatus(env, userIds) {
  if (!userIds.length) return {};
  const out = {};
  for (let i = 0; i < userIds.length; i += 90) {
    const chunk = userIds.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT user_id, totp_enabled, demo, locked_until FROM credentials WHERE user_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of results) out[r.user_id] = { hasPassword: true, mfa: !!r.totp_enabled, demo: !!r.demo, locked: r.locked_until > Date.now() };
  }
  return out;
}
async function setPassword(env, user, password, { demo = false } = {}) {
  const probs = demo ? [] : passwordProblems(password, user);
  if (probs.length) throw new AuthError(422, probs[0], 'VALIDATION', { errors: probs });
  const h = await hashPassword(requireSecret(env), password);
  await env.DB.prepare(`INSERT INTO credentials (user_id, pw_hash, pw_set_at, demo) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(user_id) DO UPDATE SET pw_hash = ?2, pw_set_at = ?3, demo = ?4, failed = 0, locked_until = 0`).bind(user.id, h, Date.now(), demo ? 1 : 0).run();
}
// Demo personas share one public password. They exist only while DEMO_MODE is on.
export async function syncDemoCredentials(env, userIds, demoPassword) {
  if (!cfg(env).demoMode) { await env.DB.prepare('DELETE FROM credentials WHERE demo = 1').run(); return; }
  const h = await hashPassword(requireSecret(env), demoPassword); const now = Date.now();
  const stmts = userIds.map((id) => env.DB.prepare('INSERT OR IGNORE INTO credentials (user_id, pw_hash, pw_set_at, demo) VALUES (?, ?, ?, 1)').bind(id, h, now));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}
export async function dropOrphans(env, liveUserIds) {
  const live = new Set(liveUserIds);
  const { results } = await env.DB.prepare('SELECT user_id FROM credentials').all();
  const gone = results.map((r) => r.user_id).filter((id) => !live.has(id));
  for (const id of gone) await env.DB.batch(['credentials', 'sessions', 'auth_tokens', 'recovery_codes'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(id)));
  return gone.length;
}

// ------------------------------------------------------------- sessions (opaque bearer tokens, stored hashed)
export async function createSession(env, userId, stage, req) {
  const token = randomToken(32); const now = Date.now();
  const exp = stage === 'full' ? now + SESSION_ABSOLUTE : now + STEP_UP_TTL;
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen, expires_at, stage, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256hex(token), userId, now, now, exp, stage, req.headers.get('cf-connecting-ip') || '', (req.headers.get('user-agent') || '').slice(0, 200)).run();
  return token;
}
export async function loadSession(env, token) {
  if (!token || token.length > 100) return null;
  const id = await sha256hex(token);
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE id_hash = ?').bind(id).first();
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at < now || (s.stage === 'full' && s.last_seen + SESSION_IDLE < now)) { await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(id).run(); return null; }
  if (now - s.last_seen > 5 * MIN) await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').bind(now, id).run();
  return { ...s, id };
}
export const promoteSession = async (env, s) => env.DB.prepare('UPDATE sessions SET stage = ?, expires_at = ?, last_seen = ? WHERE id_hash = ?').bind('full', Date.now() + SESSION_ABSOLUTE, Date.now(), s.id).run();
export const endSession = (env, s) => env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(s.id).run();
export const endAllSessions = (env, userId, exceptId = '') => env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').bind(userId, exceptId).run();

// ------------------------------------------------------------- sign-in
// Returns { userId, stage }. stage: 'full' | 'mfa' (enter code) | 'mfa_setup' (must enrol first).
export async function signIn(env, ledger, email, password) {
  const secret = requireSecret(env);
  const user = await ledger.userByEmail(String(email || '').trim().toLowerCase());
  const cred = user && await getCred(env, user.id);
  if (!user || !cred || (cred.demo && !cfg(env).demoMode)) { await dummyVerify(secret, password); throw new AuthError(401, 'Email or password is incorrect', 'AUTH'); }
  if (cred.locked_until > Date.now()) throw new AuthError(423, `Too many failed attempts. Try again after ${new Date(cred.locked_until).toUTCString().slice(17, 22)} UTC, or ask your administrator for a reset link.`, 'LOCKED');
  if (!(await verifyPassword(secret, password, cred.pw_hash))) { await recordFailure(env, ledger, user, cred, 'password'); throw new AuthError(401, 'Email or password is incorrect', 'AUTH'); }
  if (!user.active) throw new AuthError(403, 'Your account has been deactivated. Contact your organisation administrator.', 'FORBIDDEN');
  if (user.orgStatus === 'REJECTED') throw new AuthError(403, 'Your organisation’s registration was rejected.', 'FORBIDDEN');
  await env.DB.prepare('UPDATE credentials SET failed = 0, locked_until = 0 WHERE user_id = ?').bind(user.id).run();
  if (needsRehash(cred.pw_hash)) await setPassword(env, user, password, { demo: !!cred.demo }).catch(() => {});
  const stage = !mfaRequired(env, user, cred) && !cred.totp_enabled ? 'full' : cred.totp_enabled ? 'mfa' : 'mfa_setup';
  return { user, stage };
}
async function recordFailure(env, ledger, user, cred, what) {
  const failed = (cred.failed || 0) + 1; const lock = failed >= MAX_FAILS;
  await env.DB.prepare('UPDATE credentials SET failed = ?, locked_until = ? WHERE user_id = ?').bind(lock ? 0 : failed, lock ? Date.now() + LOCK_MS : cred.locked_until || 0, user.id).run();
  await ledger.system(null, 'auth.failed', { email: user.email, factor: what });
}

// ------------------------------------------------------------- 2FA
export async function mfaVerify(env, ledger, user, code) {
  const cred = await getCred(env, user.id);
  if (!cred?.totp_enabled) throw new AuthError(409, '2-step verification is not set up', 'STATE');
  if (cred.locked_until > Date.now()) throw new AuthError(423, 'Too many failed attempts. Try again in 15 minutes.', 'LOCKED');
  const c = String(code || '').replace(/[\s-]/g, '');
  if (/^\d{6}$/.test(c)) {
    const step = await totpCheck(await openSecret(requireSecret(env), cred.totp_secret), c, cred.totp_last_step);
    if (step) { await env.DB.prepare('UPDATE credentials SET totp_last_step = ?, failed = 0 WHERE user_id = ?').bind(step, user.id).run(); return 'totp'; }
  } else if (/^[A-Z2-7]{10}$/i.test(c)) {
    const h = await sha256hex(c.toUpperCase());
    const r = await env.DB.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL RETURNING code_hash').bind(Date.now(), user.id, h).first();
    if (r) { await ledger.system(user.id, 'auth.event', { event: 'mfa.recovery_used', subject: user.id, summary: 'signed in with a one-time recovery code' }); return 'recovery'; }
  }
  await recordFailure(env, ledger, user, cred, 'second factor');
  throw new AuthError(401, 'That code is not valid. Check the time on your phone and try the newest code.', 'AUTH');
}
export async function mfaBegin(env, user) {
  const cred = await getCred(env, user.id);
  if (cred?.totp_enabled) throw new AuthError(409, '2-step verification is already on. Turn it off first to move it to a new phone.', 'STATE');
  const secret = newTotpSecret();
  await env.DB.prepare('UPDATE credentials SET totp_secret = ?, totp_enabled = 0 WHERE user_id = ?').bind(await sealSecret(requireSecret(env), secret), user.id).run();
  const label = encodeURIComponent(`Parasyte PCS:${user.email}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Parasyte PCS')}&algorithm=SHA1&digits=6&period=30` };
}
export async function mfaEnable(env, ledger, user, code) {
  const cred = await getCred(env, user.id);
  if (!cred?.totp_secret || cred.totp_enabled) throw new AuthError(409, 'Start 2-step verification setup first', 'STATE');
  const step = await totpCheck(await openSecret(requireSecret(env), cred.totp_secret), code, 0);
  if (!step) throw new AuthError(422, 'That code is not valid. Make sure you scanned the newest QR code.', 'VALIDATION');
  const codes = Array.from({ length: 8 }, () => base32(randomBytes(7)).slice(0, 10));
  await env.DB.batch([
    env.DB.prepare('UPDATE credentials SET totp_enabled = 1, totp_last_step = ? WHERE user_id = ?').bind(step, user.id),
    env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(user.id),
    ...(await Promise.all(codes.map(async (c) => env.DB.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)').bind(user.id, await sha256hex(c))))),
  ]);
  await ledger.system(user.id, 'auth.event', { event: 'mfa.enabled', subject: user.id, summary: 'turned on 2-step verification' });
  return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
}
export async function mfaDisable(env, ledger, user, password) {
  if (mfaRequired(env, user, null)) throw new AuthError(403, `2-step verification is mandatory for ${user.orgType === 'BANK' ? 'banks' : user.orgType === 'NPA' ? 'the Port Authority' : 'Customs'}.`, 'FORBIDDEN');
  const cred = await getCred(env, user.id);
  if (!(await verifyPassword(requireSecret(env), password, cred.pw_hash))) throw new AuthError(401, 'Password is incorrect', 'AUTH');
  await env.DB.batch([env.DB.prepare('UPDATE credentials SET totp_enabled = 0, totp_secret = NULL WHERE user_id = ?').bind(user.id), env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(user.id)]);
  await ledger.system(user.id, 'auth.event', { event: 'mfa.disabled', subject: user.id, summary: 'turned off 2-step verification' });
}

// ------------------------------------------------------------- invites and password reset (single-use links)
export async function issueLink(env, ledger, user, purpose, byUserId) {
  const token = randomToken(32); const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now, user.id), // one live link per user
    env.DB.prepare('INSERT INTO auth_tokens (token_hash, user_id, purpose, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(await sha256hex(token), user.id, purpose, byUserId || null, now, now + (purpose === 'invite' ? INVITE_TTL : RESET_TTL)),
  ]);
  await ledger.system(byUserId || user.id, 'auth.event', { event: purpose === 'invite' ? 'invite.issued' : 'reset.issued', subject: user.id, summary: purpose === 'invite' ? `invitation link issued${byUserId ? ' by ' + byUserId : ''}` : `password reset link issued${byUserId ? ' by ' + byUserId : ' (self-service)'}` });
  return { token, expiresAt: now + (purpose === 'invite' ? INVITE_TTL : RESET_TTL) };
}
export async function inspectLink(env, ledger, token) {
  const t = await env.DB.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').bind(await sha256hex(String(token || ''))).first();
  if (!t || t.used_at || t.expires_at < Date.now()) throw new AuthError(410, 'This link has expired or was already used. Ask your administrator for a new one.', 'EXPIRED');
  const user = await ledger.user(t.user_id); if (!user || !user.active) throw new AuthError(410, 'This account is no longer active.', 'EXPIRED');
  return { t, user };
}
export async function redeemLink(env, ledger, token, password) {
  const { t, user } = await inspectLink(env, ledger, token);
  await setPassword(env, user, password);
  const claimed = await env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING user_id').bind(Date.now(), t.token_hash).first();
  if (!claimed) throw new AuthError(410, 'This link was already used.', 'EXPIRED');
  await endAllSessions(env, user.id);
  await ledger.kick(user.id);
  await ledger.system(user.id, 'auth.event', { event: t.purpose === 'invite' ? 'invite.accepted' : 'password.reset', subject: user.id, summary: t.purpose === 'invite' ? 'accepted the invitation and set a password' : 'reset their password; all sessions signed out' });
  const cred = await getCred(env, user.id);
  return { user, stage: cred.totp_enabled ? 'mfa' : mfaRequired(env, user, cred) ? 'mfa_setup' : 'full', purpose: t.purpose };
}
export async function changePassword(env, ledger, user, current, next, keepSessionId) {
  const cred = await getCred(env, user.id);
  if (!(await verifyPassword(requireSecret(env), current, cred.pw_hash))) throw new AuthError(401, 'Current password is incorrect', 'AUTH');
  await setPassword(env, user, next);
  await endAllSessions(env, user.id, keepSessionId);
  await ledger.system(user.id, 'auth.event', { event: 'password.changed', subject: user.id, summary: 'changed their password; other sessions signed out' });
}

// ------------------------------------------------------------- outbound mail (Resend if configured, else a D1 outbox)
export async function sendMail(env, to, subject, text) {
  const c = cfg(env);
  if (c.emailDelivery === 'email') {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }) });
    await env.DB.prepare('INSERT INTO mail_outbox (to_addr, subject, body, created_at, status) VALUES (?, ?, ?, ?, ?)').bind(to, subject, '(sent; body not stored)', Date.now(), r.ok ? 'SENT' : `FAILED ${r.status}`).run();
    return r.ok;
  }
  await env.DB.prepare('INSERT INTO mail_outbox (to_addr, subject, body, created_at, status) VALUES (?, ?, ?, ?, ?)').bind(to, subject, '(not delivered: no email provider configured)', Date.now(), 'NOT_SENT').run();
  return false;
}
