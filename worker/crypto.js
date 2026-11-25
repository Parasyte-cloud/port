// Security primitives for the hosted PCS on Cloudflare Workers (WebCrypto only, no dependencies).
//
// Passwords: HMAC-SHA256 pepper (key held only in the Worker secret) followed by PBKDF2-HMAC-SHA256
// at 100,000 iterations with a 16-byte random salt. 100,000 is the ceiling the Workers runtime allows
// for PBKDF2; the pepper means a stolen D1 copy alone cannot be brute-forced. Hashes carry their
// algorithm and cost so they can be upgraded transparently on the next sign-in (see needsRehash).
// argon2id (the OWASP first choice) is not native to Workers; it can replace this via a WASM module
// later without changing the stored format's shape.
//
// 2FA: RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with a one-step tolerance and replay protection.
// TOTP secrets are stored encrypted (AES-256-GCM, key derived from the Worker secret via HKDF).

const te = new TextEncoder();
const td = new TextDecoder();
export const PBKDF2_ITERATIONS = 100_000;

export const b64u = {
  enc(bytes) { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const randomToken = (n = 32) => b64u.enc(randomBytes(n));
export async function sha256hex(str) { const d = await crypto.subtle.digest('SHA-256', te.encode(str)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }

export function timingSafeEqual(a, b) {
  const x = typeof a === 'string' ? te.encode(a) : a, y = typeof b === 'string' ? te.encode(b) : b;
  if (x.length !== y.length) return false; // lengths are public here (fixed-size hashes and codes)
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---- keys derived from the single Worker secret (PCS_SECRET), one per purpose
const keyCache = new Map();
async function subkey(secret, label, algo, usages) {
  const id = `${label}|${secret.length}|${secret.slice(0, 4)}`;
  if (keyCache.has(id)) return keyCache.get(id);
  const base = await crypto.subtle.importKey('raw', te.encode(secret), 'HKDF', false, ['deriveKey']);
  const k = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('parasyte-pcs/v1'), info: te.encode(label) }, base, algo, false, usages);
  keyCache.set(id, k); return k;
}
const pepperKey = (s) => subkey(s, 'password-pepper', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
const totpEncKey = (s) => subkey(s, 'totp-encryption', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
const ticketKey = (s) => subkey(s, 'ws-ticket', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);

// ---- passwords
async function derive(secret, password, salt, iterations) {
  const peppered = await crypto.subtle.sign('HMAC', await pepperKey(secret), te.encode(password.normalize('NFKC')));
  const k = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, k, 256));
}
export async function hashPassword(secret, password) {
  const salt = randomBytes(16);
  const h = await derive(secret, password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64u.enc(salt)}$${b64u.enc(h)}`;
}
export async function verifyPassword(secret, password, stored) {
  const [alg, it, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2-sha256' || !salt || !hash) { await derive(secret, password || '', randomBytes(16), PBKDF2_ITERATIONS); return false; }
  const h = await derive(secret, password || '', b64u.dec(salt), Number(it));
  return timingSafeEqual(h, b64u.dec(hash));
}
export const needsRehash = (stored) => !String(stored).startsWith(`pbkdf2-sha256$${PBKDF2_ITERATIONS}$`);
// Burn the same CPU as a real check so response time does not reveal whether an email exists.
export const dummyVerify = (secret, password) => derive(secret, password || '', randomBytes(16), PBKDF2_ITERATIONS).then(() => false);

const COMMON = new Set(['password', 'password1', 'password123', '123456789012', 'qwertyuiop', 'iloveyou', 'welcome123', 'admin123456', 'letmein123', 'changeme123', 'passw0rd', 'p@ssw0rd', 'qwerty123456', '1q2w3e4r5t6y', 'abc123456789', 'nigeria123', 'lagos123456', 'portharcourt', 'customs12345', 'demo1234']);
export function passwordProblems(pw, { email = '', name = '' } = {}) {
  const p = String(pw || ''); const out = [];
  if (p.length < 12) out.push('Use at least 12 characters (a short phrase of three or four words works well).');
  if (p.length > 128) out.push('Use at most 128 characters.');
  const low = p.toLowerCase();
  if (COMMON.has(low)) out.push('This password is too common.');
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && low.includes(local)) out.push('Do not include your email name in the password.');
  for (const part of name.toLowerCase().split(/\s+/)) if (part.length >= 4 && low.includes(part)) { out.push('Do not include your own name in the password.'); break; }
  if (/^(.)\1+$/.test(p)) out.push('Do not repeat one character.');
  return out;
}

// ---- TOTP (RFC 6238 / RFC 4226)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) { let bits = 0, val = 0, out = ''; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
export function unbase32(str) { const s = str.replace(/=+$/, '').replace(/\s/g, '').toUpperCase(); let bits = 0, val = 0; const out = []; for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
async function hotp(secretBytes, counter) {
  const k = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8); let c = counter; for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg)); const o = h[19] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
export const totpNow = (b32, at = Date.now()) => hotp(unbase32(b32), Math.floor(at / 30000));
// Returns the matched time step (to store as "last used" and refuse replays), or 0 when the code is wrong.
export async function totpCheck(b32, code, lastStep = 0, at = Date.now()) {
  const c = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return 0;
  const step = Math.floor(at / 30000); const bytes = unbase32(b32);
  for (const d of [0, -1, 1]) { const s = step + d; if (s <= lastStep) continue; if (timingSafeEqual(await hotp(bytes, s), c)) return s; }
  return 0;
}
export const newTotpSecret = () => base32(randomBytes(20));
export async function sealSecret(secret, plain) {
  const iv = randomBytes(12); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await totpEncKey(secret), te.encode(plain));
  return `v1.${b64u.enc(iv)}.${b64u.enc(ct)}`;
}
export async function openSecret(secret, sealed) {
  const [v, iv, ct] = String(sealed).split('.'); if (v !== 'v1') throw new Error('Unknown secret format');
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(iv) }, await totpEncKey(secret), b64u.dec(ct)));
}

// ---- short-lived signed tickets (WebSocket connect; browsers cannot send headers on WebSocket)
export async function signTicket(secret, obj) {
  const body = b64u.enc(te.encode(JSON.stringify(obj)));
  const sig = b64u.enc(await crypto.subtle.sign('HMAC', await ticketKey(secret), te.encode(body)));
  return `${body}.${sig}`;
}
export async function verifyTicket(secret, ticket) {
  const [body, sig] = String(ticket || '').split('.'); if (!body || !sig) return null;
  let ok = false; try { ok = await crypto.subtle.verify('HMAC', await ticketKey(secret), b64u.dec(sig), te.encode(body)); } catch { return null; }
  if (!ok) return null;
  const o = JSON.parse(td.decode(b64u.dec(body))); return o.exp > Date.now() ? o : null;
}
