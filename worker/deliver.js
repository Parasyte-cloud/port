// Hands queued notification messages (engine outbox) to real providers and records each answer in D1.
//   e-mail  : Resend       (RESEND_API_KEY + MAIL_FROM)
//   SMS     : Termii       (TERMII_API_KEY + TERMII_SENDER_ID), Nigerian numbers in +234 format
//   webhook : HTTPS POST to the organisation's webhook URL, signed with HMAC-SHA256 (x-pcs-signature)
// Seeded demo organisations have made-up contacts (*.demo e-mail, +2348010000xxx phones). Messages to
// them are never sent, so a demo run cannot e-mail or text a stranger; the status says so.
import { cfg } from './auth.js';

export function deliveryConfig(env) {
  return {
    email: cfg(env).emailDelivery === 'email' ? 'Resend' : 'not configured',
    sms: env.TERMII_API_KEY && env.TERMII_SENDER_ID ? 'Termii' : 'not configured',
    webhook: env.PCS_SECRET ? 'signed HTTPS POST' : 'not configured',
  };
}

const isDemoContact = (org, to) => /\.demo$/i.test(org?.email || '') || /\.demo$/i.test(to || '') || /^\+?2348010000\d{3}$/.test(String(to || '').replace(/\s/g, ''));

async function hmacHex(secret, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendOne(env, m, org, fetchImpl) {
  const c = deliveryConfig(env);
  if (isDemoContact(org, m.to)) return { status: 'NOT SENT: demo organisation contact (fictional address)' };
  if (m.channel === 'email') {
    if (c.email !== 'Resend') return { status: 'NOT SENT: no e-mail provider configured' };
    const r = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to], subject: m.subject, text: `${m.body || ''}\n\nAPAPA Technologies Port Community System` }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { status: 'SENT', ref: j.id || null } : { status: `FAILED ${r.status}` };
  }
  if (m.channel === 'sms') {
    if (c.sms !== 'Termii') return { status: 'NOT SENT: no SMS provider configured' };
    const to = String(m.to).replace(/[^\d]/g, '');
    const r = await fetchImpl('https://v3.api.termii.com/api/sms/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: env.TERMII_API_KEY, to, from: env.TERMII_SENDER_ID, sms: `${m.subject}. ${m.body || ''}`.slice(0, 300), type: 'plain', channel: 'generic' }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { status: 'SENT', ref: j.message_id || null } : { status: `FAILED ${r.status}` };
  }
  if (m.channel === 'webhook') {
    if (!/^https:\/\//i.test(m.to || '')) return { status: 'NOT SENT: webhook URL must be https' };
    const payload = JSON.stringify({ id: m.id, at: m.at, title: m.subject, body: m.body, ref: m.ref || null });
    const r = await fetchImpl(m.to, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pcs-signature': await hmacHex(env.PCS_SECRET || '', payload) }, body: payload });
    return { status: r.ok ? 'DELIVERED' : `FAILED ${r.status}` };
  }
  return { status: 'NOT SENT: unknown channel' };
}

export async function deliver(env, msgs, orgs, fetchImpl = fetch) {
  if (!msgs.length) return;
  const rows = [];
  for (const m of msgs) {
    let out; try { out = await sendOne(env, m, orgs[m.orgId], fetchImpl); } catch (e) { out = { status: `FAILED ${String(e.message || e).slice(0, 60)}` }; }
    rows.push(env.DB.prepare('INSERT OR REPLACE INTO deliveries (msg_id, org_id, channel, to_addr, subject, status, provider_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(m.id, m.orgId, m.channel, m.to || null, m.subject || null, out.status, out.ref || null, Date.now()));
  }
  for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50));
}

// Replaces the engine's QUEUED status with what the provider answered.
export async function withDeliveryStatus(env, integ) {
  if (!integ?.outbox?.length) return { ...integ, delivery: deliveryConfig(env) };
  const ids = integ.outbox.map((m) => m.id);
  const { results } = await env.DB.prepare(`SELECT msg_id, status, provider_ref FROM deliveries WHERE msg_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const by = Object.fromEntries(results.map((r) => [r.msg_id, r]));
  return { ...integ, delivery: deliveryConfig(env), outbox: integ.outbox.map((m) => by[m.id] ? { ...m, status: by[m.id].status + (by[m.id].provider_ref ? ` (${by[m.id].provider_ref})` : '') } : { ...m, status: m.at < Date.now() - 60e3 ? 'NOT SENT: recorded before message delivery was switched on' : 'QUEUED' }) };
}
