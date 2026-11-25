// Acceptance test for the shared server (Cloudflare Worker + Durable Object + D1, run locally by wrangler).
// Two people on two devices complete steps 1 to 12 on one shipment, with live hand-over between them,
// using invite-only accounts and 2-step verification. Also probes the sign-in controls an auditor would.
// Run: npm run test:worker   (starts `wrangler dev` twice: demo mode on, and demo mode off)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { totpNow, unbase32 } from '../worker/crypto.js';
import { makeContainerNo } from '../core/reference.js';

const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const servers = [];
async function startServer(port, vars) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-wd-'));
  const cfg = ['-c', 'wrangler.worker.jsonc'];
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'parasyte-pcs', '--local', '--persist-to', dir, ...cfg], { stdio: 'ignore' });
  const args = ['wrangler', 'dev', ...cfg, '--port', String(port), '--persist-to', dir, '--var', `PCS_SECRET:${SECRET}`, '--show-interactive-dev-session=false', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  servers.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${base}/api/health`); if (r.ok) return base; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`wrangler dev did not start:\n${log}`);
}
after(() => { for (const c of servers) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} } });

// A "device": its own IP, its own sessions, its own live socket.
function device(base, ipAddr) {
  const d = {
    token: null, events: [],
    async call(method, url, body, extraHeaders = {}) {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ipAddr, ...(d.token ? { authorization: `Bearer ${d.token}` } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    },
    async ok(method, url, body) { const r = await d.call(method, url, body); assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; },
    async login(email, password = 'demo1234') { const r = await d.ok('POST', '/api/auth/login', { email, password }); d.token = r.token; return r; },
    cmd: async (type, payload) => (await d.ok('POST', '/api/cmd', { type, payload })).result,
    q: (name, params = {}) => d.ok('GET', `/api/q/${name}?${new URLSearchParams(params)}`),
    async connect() {
      const { ticket } = await d.ok('POST', '/api/ws-ticket');
      d.ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws?ticket=${encodeURIComponent(ticket)}`);
      d.ws.onmessage = (m) => { if (m.data !== 'pong') d.events.push(JSON.parse(m.data)); };
      await new Promise((res, rej) => { d.ws.onopen = res; d.ws.onerror = rej; });
    },
    async waitFor(pred, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = d.events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 25)); } throw new Error('Live update did not arrive'); },
  };
  return d;
}
const STRONG = 'harbour crane mango 2026';
const linkToken = (link) => link.split('#')[1].split('/')[1];
async function freshTotp(secret, lastUsed) { // wait for a new 30 s step when the current one was just used
  for (;;) { const step = Math.floor(Date.now() / 30000); if (step !== lastUsed) return { code: await totpNow(secret), step }; await new Promise((r) => setTimeout(r, 500)); }
}

let base;
before(async () => { base = await startServer(8791, { DEMO_MODE: 'on', SEED: 'showcase', MFA_ORG_TYPES: 'NPA,CUSTOMS,BANK' }); });

test('two people on two devices complete steps 1-12 on one shipment, with live hand-over', { timeout: 180000 }, async () => {
  const A = device(base, '10.0.0.1'); // Person 1: trade side (forwarder, carrier, haulier)
  const B = device(base, '10.0.0.2'); // Person 2: authorities and terminal (Port Authority, Customs, terminal, gate)
  const orgs = Object.fromEntries((await (await A.login('shipping@demo.pcs'), A.q('directory'))).orgs.map((o) => [o.name, o.id]));

  // 1. Register (invite-only): the Port Authority onboards a new forwarder and invites its administrator.
  await B.login('npa.admin@demo.pcs');
  const reg = await B.cmd('org.register', { name: 'Test Forwarding Ltd', type: 'FORWARDER', email: 'ops@testfwd.ng', tin: '41111111-0001', rcNumber: 'RC 99999', adminName: 'Tess Adebayo', adminEmail: 'tess@testfwd.ng', adminTitle: 'Clearing Manager', password: 'ignored-by-server' });
  assert.equal(reg.status, 'ACTIVE');
  assert.match(reg.invite.link, /#invite\//);
  const inv = await A.ok('POST', '/api/auth/link/inspect', { token: linkToken(reg.invite.link) });
  assert.equal(inv.email, 'tess@testfwd.ng'); assert.equal(inv.mfaRequired, false);
  const weak = await A.call('POST', '/api/auth/link/redeem', { token: linkToken(reg.invite.link), password: 'password1' });
  assert.equal(weak.status, 422, 'weak password refused');
  const tess = await A.ok('POST', '/api/auth/link/redeem', { token: linkToken(reg.invite.link), password: STRONG });
  assert.equal(tess.stage, 'full');
  assert.equal((await A.call('POST', '/api/auth/link/redeem', { token: linkToken(reg.invite.link), password: STRONG })).status, 410, 'invite link is single-use');
  const tessTok = tess.token;

  // Customs invites a new officer, who must set up 2-step verification before doing anything.
  await B.login('customs@demo.pcs'); // shared demo persona: exempt from 2FA while DEMO_MODE=on
  const officer = await B.cmd('user.create', { name: 'Musa Ibrahim', email: 'm.ibrahim@customs.test', title: 'Valuation Officer' });
  const red = await B.ok('POST', '/api/auth/link/redeem', { token: linkToken(officer.invite.link), password: STRONG });
  assert.equal(red.stage, 'mfa_setup');
  B.token = red.token;
  assert.equal((await B.call('GET', '/api/q/session')).status, 401, 'no access before 2FA is set up');
  const setup = await B.ok('POST', '/api/auth/mfa/setup');
  assert.equal(unbase32(setup.secret).length, 20); assert.match(setup.otpauth, /^otpauth:\/\/totp\//);
  const first = await freshTotp(setup.secret, -1);
  const en = await B.ok('POST', '/api/auth/mfa/enable', { code: first.code });
  assert.equal(en.recoveryCodes.length, 8);
  await B.ok('POST', '/api/auth/logout');
  const again = await B.login('m.ibrahim@customs.test', STRONG);
  assert.equal(again.stage, 'mfa');
  assert.equal((await B.call('POST', '/api/auth/mfa/verify', { code: first.code })).status, 401, 'a used code cannot be replayed');
  await B.ok('POST', '/api/auth/mfa/verify', { code: en.recoveryCodes[0] }); // recovery code (single use)
  const customsTok = B.token;

  // Both people open their screens; live sockets for the forwarder (A) and the Customs officer (B).
  A.token = tessTok; await A.connect();
  B.token = customsTok; await B.connect();

  // 2. Carrier notifies the call, Port Authority allocates the berth, carrier files the manifest.
  const tokens = {};
  const as = async (dev, email) => { if (!tokens[email]) { await dev.login(email); tokens[email] = dev.token; } dev.token = tokens[email]; return dev; };
  const dir = await A.q('directory');
  const imo = dir.vessels[0].imo;
  await as(A, 'shipping@demo.pcs');
  const { voyageId } = await A.cmd('voyage.create', { imo, voyageNo: 'T99W', port: 'APAPA', terminalOrgId: orgs['Bight Container Terminal (Apapa)'], eta: Date.now() + 2 * 86400e3, etd: Date.now() + 4 * 86400e3, preferredBerth: 'APP-B06' });
  await B.waitFor((e) => e.t === 'commit' && e.type === 'voyage.create'); // Person 2's screen refreshes live
  await as(B, 'npa.marine@demo.pcs');
  const berthReq = (await B.q('services')).find((s) => s.voyageId === voyageId && s.type === 'BERTH');
  await B.cmd('service.decide', { serviceId: berthReq.id, decision: 'approve', data: { berth: 'APP-B06' } });
  const c1 = makeContainerNo('TST', 1), c2 = makeContainerNo('TST', 2);
  const { blIds: [blId] } = await A.cmd('manifest.submit', { voyageId, bls: [{ blNo: 'TESTBL001', shipper: 'Acme Shenzhen', consignee: { name: 'Lagos Electronics Hub', tin: '50000002-0001' }, forwarderOrgId: reg.orgId, portOfLoading: 'CNSZX', description: 'Laptops', hsCode: '8471', packages: 100, grossWeightKg: 5000, containers: [{ no: c1, size: '20', weightKg: 2500 }, { no: c2, size: '20', weightKg: 2500 }] }] });

  // 3. Common data reused: consignee matched by TIN; the declaration pre-fills from the manifest.
  A.token = tessTok;
  const sh = () => A.q('shipment', { id: blId });
  assert.equal((await sh()).bl.consigneeOrgId, orgs['Lagos Electronics Hub']);
  const { lane } = await A.cmd('declaration.lodge', { blId, fobValueUsd: 200000, formMNo: 'MF20269999', cpc: '4000', originCountry: 'CN' });
  assert.ok((await sh()).declaration.reuse.prefilled >= 12);

  // 6. Arrival and discharge (Person 2).
  await as(B, 'npa.marine@demo.pcs'); await B.cmd('voyage.arrive', { voyageId });
  await as(B, 'terminal@demo.pcs'); await B.cmd('cargo.discharge', { voyageId });

  // 7. One consolidated payment (Person 1).
  A.token = tessTok;
  const unpaid = async () => (await sh()).invoices.filter((i) => i.status === 'UNPAID').map((i) => i.id);
  await A.cmd('payment.pay', { invoiceIds: await unpaid(), bankOrgId: orgs['Unity Commerce Bank'], method: 'card' });

  // 5. Customs processing by the 2FA-protected officer on device B.
  B.token = customsTok;
  let decl = (await B.q('shipment', { id: blId })).declaration;
  if (decl.status === 'AWAITING_REVIEW') await B.cmd('declaration.review', { declarationId: decl.id, decision: 'approve' });
  if (decl.status === 'AWAITING_EXAM') {
    const sr = (await B.q('shipment', { id: blId })).services.find((s) => s.type === 'EXAM_POSITION');
    await as(B, 'terminal@demo.pcs'); await B.cmd('service.decide', { serviceId: sr.id, decision: 'approve' });
    B.token = customsTok; await B.cmd('exam.record', { declarationId: decl.id, finding: 'CLEAN' });
  }
  decl = (await B.q('shipment', { id: blId })).declaration;
  assert.equal(decl.status, 'RELEASED', `lane ${lane}`);
  // Live hand-over: the forwarder's screen (device A) is told Customs released the cargo.
  const handover = await A.waitFor((e) => e.t === 'commit' && e.notices?.some((n) => /Customs released/.test(n.title)));
  assert.equal(handover.by.name, 'Musa Ibrahim');

  // 4. Service request: delivery order from the carrier.
  A.token = tessTok;
  const { serviceId: doId } = await A.cmd('service.request', { type: 'DELIVERY_ORDER', blId });
  await as(A, 'shipping@demo.pcs'); await A.cmd('service.decide', { serviceId: doId, decision: 'approve' });
  A.token = tessTok; await A.cmd('payment.pay', { invoiceIds: await unpaid(), bankOrgId: orgs['Unity Commerce Bank'] });
  assert.equal((await sh()).bl.deliveryOrder.status, 'ISSUED');

  // Terminal release, then truck booking accepted by the haulier.
  await as(B, 'terminal@demo.pcs');
  let r = await B.cmd('terminal.release', { blId });
  if (r.held) { A.token = tessTok; await A.cmd('payment.pay', { invoiceIds: await unpaid(), bankOrgId: orgs['Unity Commerce Bank'] }); r = await B.cmd('terminal.release', { blId }); }
  assert.ok(r.released);
  A.token = tessTok;
  const { serviceId: tb } = await A.cmd('service.request', { type: 'TRUCK_BOOKING', blId, toOrgId: orgs['Eko Haulage'] });
  await as(A, 'haulage@demo.pcs');
  await A.cmd('service.decide', { serviceId: tb, decision: 'approve', data: { assignments: [{ containerNo: c1, plate: 'LND-111AA', driver: 'A' }, { containerNo: c2, plate: 'LND-222BB', driver: 'B' }] } });

  // 8-9. Consolidated approval: one Port Authority release order; gate passes issued.
  await as(B, 'npa.admin@demo.pcs');
  assert.ok((await B.q('shipment', { id: blId })).checklist.ready);
  await B.cmd('release.approve', { blId });

  // 10. Gate: wrong truck refused, right trucks pass.
  await as(B, 'gate@demo.pcs');
  const conts = (await B.q('shipment', { id: blId })).containers;
  assert.equal((await B.cmd('gate.out', { token: conts[0].gatePass.token, plate: 'LND-999ZZ' })).denied, 'plate_mismatch');
  await B.cmd('gate.out', { token: conts[0].gatePass.token, plate: 'LND111AA' });
  await B.cmd('gate.out', { token: conts[1].gatePass.token, plate: 'LND-222BB' });

  // 12. Close: the forwarder confirms delivery.
  A.token = tessTok; await A.cmd('delivery.confirm', { blId });
  const done = await sh();
  assert.equal(done.bl.stage, 'CLOSED'); assert.equal(typeof done.bl.kpi.dwellHours, 'number'); // real time: seconds, not days

  // 11. Notifications reached the parties; the Customs officer's screen saw every step live.
  const notes = await A.q('notifications');
  assert.ok(notes.some((n) => n.ref?.id === blId));
  // Each notification message was handed to the delivery layer and its real outcome recorded
  // (no provider is configured in tests, and seeded demo contacts are never messaged).
  await new Promise((r) => setTimeout(r, 500));
  const integ = await A.q('integration');
  assert.equal(integ.delivery.email, 'not configured');
  const mine = integ.outbox.filter((m) => m.to === 'ops@testfwd.ng');
  assert.ok(mine.length && mine.every((m) => m.status === 'NOT SENT: no e-mail provider configured'), JSON.stringify(mine.slice(0, 2)));
  await as(A, 'lehub@demo.pcs');
  assert.ok((await A.q('integration')).outbox.some((m) => /demo organisation contact/.test(m.status)));
  A.token = tessTok;
  assert.ok(B.events.some((e) => e.type === 'delivery.confirm'), 'device B saw the close live');
  // Audit trail: the shipment's trace tells the whole story, sign-in events included, and the chain verifies.
  await as(B, 'auditor@demo.pcs');
  const actions = [...(await B.q('audit', { limit: 500, trace: 'TRC-TESTBL001' })).entries, ...(await B.q('audit', { limit: 500, action: 'auth.' })).entries].map((e) => e.action);
  for (const a of ['bl.manifested', 'declaration.lodged', 'payment.captured', 'customs.released', 'release.ordered', 'gate.denied', 'gate.out', 'shipment.closed', 'auth.invite.issued', 'auth.invite.accepted', 'auth.mfa.enabled', 'auth.mfa.recovery_used']) assert.ok(actions.includes(a), a);
  assert.ok((await B.q('auditVerify')).ok);
  A.ws.close(); B.ws.close();
});

test('sign-in controls: invite-only, lockout, CSRF, reserved commands, reset links, deactivation', { timeout: 60000 }, async () => {
  const X = device(base, '10.0.1.1');
  assert.equal((await X.call('POST', '/api/auth/register', { name: 'x' })).status, 403, 'no public self-registration');
  // Lockout after 5 wrong passwords, even with the right password afterwards.
  for (let i = 0; i < 5; i++) assert.equal((await X.call('POST', '/api/auth/login', { email: 'delta@demo.pcs', password: 'nope' })).status, 401);
  assert.equal((await X.call('POST', '/api/auth/login', { email: 'delta@demo.pcs', password: 'demo1234' })).status, 423);
  // Unknown email and wrong password look the same.
  const u = await X.call('POST', '/api/auth/login', { email: 'nobody@nowhere.ng', password: 'x' });
  assert.equal(u.status, 401); assert.equal(u.data.error, 'Email or password is incorrect');

  await X.login('lehub@demo.pcs');
  assert.equal((await X.call('POST', '/api/cmd', { type: 'auth.login', payload: { userId: 'USR-0001' } })).status, 403, 'clients cannot forge sign-in audit events');
  assert.equal((await X.call('POST', '/api/cmd', { type: 'org.register', payload: { name: 'Sneaky' } })).status, 403, 'only the Port Authority onboards organisations');
  assert.equal((await X.call('POST', '/api/cmd', { type: 'notification.read', payload: {} }, { origin: 'https://evil.example' })).status, 403, 'cross-site POST refused');

  // Admin-issued reset link works once and signs the user out everywhere.
  const Y = device(base, '10.0.1.2'); await Y.login('lehub@demo.pcs');
  const staff = await X.cmd('user.create', { name: 'Kola Ade', email: 'kola@lehub.test', title: 'Buyer' });
  await X.ok('POST', '/api/auth/link/redeem', { token: linkToken(staff.invite.link), password: STRONG });
  const K = device(base, '10.0.1.3'); await K.login('kola@lehub.test', STRONG);
  const rl = await X.ok('POST', '/api/admin/link', { userId: staff.userId });
  assert.equal(rl.purpose, 'reset');
  await K.ok('POST', '/api/auth/link/redeem', { token: linkToken(rl.link), password: 'new harbour phrase 77' });
  const K2 = device(base, '10.0.1.4');
  assert.equal((await K2.call('POST', '/api/auth/login', { email: 'kola@lehub.test', password: STRONG })).status, 401, 'old password no longer works');
  await K2.login('kola@lehub.test', 'new harbour phrase 77');
  // Deactivation ends the user's sessions at once.
  await X.cmd('user.setActive', { userId: staff.userId, active: false });
  assert.equal((await K2.call('GET', '/api/q/session')).status, 401);
  // Demo personas cannot change the shared demo password.
  assert.equal((await Y.call('POST', '/api/auth/password/change', { current: 'demo1234', next: STRONG })).status, 403);
});

test('demo mode off: demo password hidden and refused; first administrator via setup link', { timeout: 120000 }, async () => {
  const prod = await startServer(8792, { DEMO_MODE: 'off', SEED: 'empty', SETUP_TOKEN: 'setup-token-abcdef-123456' });
  const P = device(prod, '10.0.2.1');
  const c = await P.ok('GET', '/api/config');
  assert.equal(c.demoMode, false); assert.equal(c.demoPassword, null); assert.equal(c.needsSetup, true);
  assert.equal((await P.call('POST', '/api/auth/login', { email: 'npa.admin@demo.pcs', password: 'demo1234' })).status, 401);
  assert.equal((await P.call('POST', '/api/setup', { setupToken: 'wrong-token-0000000000' })).status, 403);
  const s = await P.ok('POST', '/api/setup', { setupToken: 'setup-token-abcdef-123456', orgName: 'Port Authority', orgEmail: 'ops@port.test', tin: '10000009-0001', rcNumber: 'IT 100009', adminName: 'Ada Admin', adminEmail: 'ada@port.test' });
  const r = await P.ok('POST', '/api/auth/link/redeem', { token: linkToken(s.link), password: STRONG });
  assert.equal(r.stage, 'mfa_setup', 'Port Authority accounts must use 2-step verification');
  assert.equal((await P.call('POST', '/api/setup', { setupToken: 'setup-token-abcdef-123456', adminEmail: 'ada@port.test' })).status, 409, 'setup runs once');
  assert.equal((await P.call('POST', '/api/reset', {})).status, 401);
});
