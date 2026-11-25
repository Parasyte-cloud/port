// End-to-end business tests: the full 12-step flow plus the controls an auditor would probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../core/engine.js';
import { makeQueries } from '../core/queries.js';
import { buildSeed, DEMO_PASSWORD } from '../core/seed.js';
import { hashPassword } from '../core/sha256.js';
import { makeContainerNo, validContainerNo } from '../core/reference.js';

const HOUR = 3600e3;
function world() {
  const now = Date.UTC(2026, 10, 20, 8);
  const seed = buildSeed(now);
  const E = createEngine(); E.load(seed.log);
  const Q = makeQueries(E);
  let t = Math.max(now, E.state.lastAt) + HOUR;
  const uid = (email) => E.findUserByEmail(email).id;
  const ex = (email, type, payload, adv = 1) => { t += adv * HOUR; return E.execute({ type, userId: email ? uid(email) : null, at: t, payload }); };
  const q = (email, name, p) => Q.run(E.actorFrom(uid(email)), name, p || {});
  const org = (name) => Object.values(E.state.orgs).find((o) => o.name === name).id;
  return { E, Q, ex, q, org, uid, seed };
}

test('seed replays deterministically and the audit chain verifies', () => {
  const { E, seed } = world();
  const E2 = createEngine(); E2.load(seed.log);
  assert.equal(E2.state.lastHash, E.state.lastHash);
  assert.ok(E.verifyAudit().ok);
  assert.ok(Object.keys(E.state.bls).length >= 15);
});

test('full 12-step flow: register → manifest → declare → pay → release → gate → close', () => {
  const { E, ex, q, org } = world();
  // 1. Register a new forwarder; Port Authority approves it.
  const salt = 's1';
  const reg = ex(null, 'org.register', { name: 'Test Forwarding Ltd', type: 'FORWARDER', email: 't@t.ng', tin: '41111111-0001', rcNumber: 'RC 99999', admin: { name: 'Tess', email: 'tess@test.ng', salt, passwordHash: hashPassword('password1', salt) } });
  assert.equal(reg.status, 'PENDING');
  assert.throws(() => ex('tess@test.ng', 'declaration.lodge', {}), /pending/i);
  ex('npa.admin@demo.pcs', 'org.approve', { orgId: reg.orgId, decision: 'approve' });
  // 2. Carrier notifies call, NPA allocates berth, carrier files manifest.
  const imo = E.state.vessels[Object.keys(E.state.vessels)[0]].imo;
  const { voyageId } = ex('shipping@demo.pcs', 'voyage.create', { imo, voyageNo: 'T99W', port: 'APAPA', terminalOrgId: org('Bight Container Terminal (Apapa)'), eta: Date.UTC(2026, 10, 25), etd: Date.UTC(2026, 10, 27), preferredBerth: 'APP-B06' });
  const berthReq = Object.values(E.state.services).find((s) => s.voyageId === voyageId);
  ex('npa.marine@demo.pcs', 'service.decide', { serviceId: berthReq.id, decision: 'approve', data: { berth: 'APP-B06' } });
  const c1 = makeContainerNo('TST', 1), c2 = makeContainerNo('TST', 2);
  const { blIds: [blId] } = ex('shipping@demo.pcs', 'manifest.submit', { voyageId, bls: [{ blNo: 'TESTBL001', shipper: 'Acme Shenzhen', consignee: { name: 'Lagos Electronics Hub', tin: '50000002-0001' }, forwarderOrgId: reg.orgId, portOfLoading: 'CNSZX', description: 'Laptops', hsCode: '8471', packages: 100, grossWeightKg: 5000, containers: [{ no: c1, size: '20', weightKg: 2500 }, { no: c2, size: '20', weightKg: 2500 }] }] });
  const bl = () => E.state.bls[blId];
  // 3. Common data reuse: consignee matched by TIN to the registered importer.
  assert.equal(bl().consigneeOrgId, org('Lagos Electronics Hub'));
  // Pre-arrival declaration: 14 fields reused.
  const { lane } = ex('tess@test.ng', 'declaration.lodge', { blId, fobValueUsd: 200000, formMNo: 'MF20269999', cpc: '4000', originCountry: 'CN' });
  const decl = E.state.declarations[bl().declarationId];
  assert.ok(decl.preArrival); assert.ok(decl.reuse.prefilled >= 12);
  // Forwarder sees lane but not the confidential risk reasons.
  assert.ok(q('tess@test.ng', 'shipment', { id: blId }).declaration.risk.hidden);
  assert.ok(q('customs@demo.pcs', 'shipment', { id: blId }).declaration.risk.reasons.length);
  // 6. Arrival + discharge.
  ex('npa.marine@demo.pcs', 'voyage.arrive', { voyageId });
  ex('terminal@demo.pcs', 'cargo.discharge', { voyageId });
  assert.ok(bl().milestones.discharged);
  // 7. Consolidated payment of everything owed so far.
  const unpaid = () => bl().invoiceIds.map((i) => E.state.invoices[i]).filter((i) => i.status === 'UNPAID').map((i) => i.id);
  ex('tess@test.ng', 'payment.pay', { invoiceIds: unpaid(), bankOrgId: org('Unity Commerce Bank'), method: 'card' });
  // 5. Customs lane handling.
  if (decl.status === 'AWAITING_REVIEW') ex('customs@demo.pcs', 'declaration.review', { declarationId: decl.id, decision: 'approve' });
  if (decl.status === 'AWAITING_EXAM') {
    const sr = Object.values(E.state.services).find((s) => s.blId === blId && s.type === 'EXAM_POSITION');
    ex('terminal@demo.pcs', 'service.decide', { serviceId: sr.id, decision: 'approve' });
    ex('customs@demo.pcs', 'exam.record', { declarationId: decl.id, finding: 'CLEAN' });
  }
  assert.equal(decl.status, 'RELEASED', `lane ${lane}`);
  // 4. Services: DO from carrier.
  const { serviceId: doId } = ex('tess@test.ng', 'service.request', { type: 'DELIVERY_ORDER', blId });
  ex('shipping@demo.pcs', 'service.decide', { serviceId: doId, decision: 'approve' });
  ex('tess@test.ng', 'payment.pay', { invoiceIds: unpaid(), bankOrgId: org('Unity Commerce Bank') });
  assert.equal(bl().deliveryOrder.status, 'ISSUED');
  // NPA cannot release before terminal release.
  assert.throws(() => ex('npa.admin@demo.pcs', 'release.approve', { blId }), /Terminal release/);
  let r = ex('terminal@demo.pcs', 'terminal.release', { blId });
  if (r.held) { ex('tess@test.ng', 'payment.pay', { invoiceIds: unpaid(), bankOrgId: org('Unity Commerce Bank') }); r = ex('terminal@demo.pcs', 'terminal.release', { blId }); }
  assert.ok(r.released);
  // Trucks.
  const { serviceId: tb } = ex('tess@test.ng', 'service.request', { type: 'TRUCK_BOOKING', blId, toOrgId: org('Eko Haulage') });
  assert.throws(() => ex('haulage@demo.pcs', 'service.decide', { serviceId: tb, decision: 'approve', data: { assignments: [{ containerNo: c1, plate: 'BAD', driver: 'x' }] } }), /plate|No truck/i);
  ex('haulage@demo.pcs', 'service.decide', { serviceId: tb, decision: 'approve', data: { assignments: [{ containerNo: c1, plate: 'LND-111AA', driver: 'A' }, { containerNo: c2, plate: 'LND-222BB', driver: 'B' }] } });
  // 8-9. Consolidated release order.
  assert.ok(E.checklist(bl()).ready);
  ex('npa.admin@demo.pcs', 'release.approve', { blId });
  // 10. Gate: wrong truck refused and logged, right truck passes.
  const gp1 = E.state.gatePasses[E.state.containers[bl().containerIds[0]].gatePassId];
  const gp2 = E.state.gatePasses[E.state.containers[bl().containerIds[1]].gatePassId];
  assert.equal(ex('gate@demo.pcs', 'gate.out', { token: gp1.token, plate: 'LND-999ZZ' }).denied, 'plate_mismatch');
  ex('gate@demo.pcs', 'gate.out', { token: gp1.token, plate: 'LND111AA' });
  assert.throws(() => ex('gate@demo.pcs', 'gate.out', { token: gp1.token, plate: 'LND-111AA' }), /used/);
  ex('gate@demo.pcs', 'gate.out', { token: gp2.token, plate: 'LND-222BB' });
  // 12. Close. One payment is left unreconciled on purpose: closing reports it and tells the bank.
  const ucb = org('Unity Commerce Bank');
  const pays = () => Object.values(E.state.payments).filter((p) => p.invoiceIds.some((i) => E.state.invoices[i].blId === blId));
  // The bank is told about every payment it must settle, linked to the shipment (finding from the first demo run).
  assert.equal(E.state.notifications.filter((n) => n.orgId === ucb && n.ref?.id === blId && /settlement/.test(n.title)).length, pays().length);
  const [last, ...rest] = pays().reverse();
  ex('bank@demo.pcs', 'payment.reconcile', { paymentIds: rest.map((p) => p.id) });
  assert.ok(E.state.notifications.some((n) => n.orgId === reg.orgId && /Payment settled/.test(n.title)));
  ex('tess@test.ng', 'delivery.confirm', { blId });
  assert.equal(bl().stage, 'CLOSED'); assert.ok(bl().kpi.dwellHours > 0);
  assert.equal(bl().kpi.unsettledPayments, 1); assert.ok(!bl().milestones.settled);
  assert.ok(E.state.notifications.some((n) => n.orgId === ucb && /Settlement outstanding/.test(n.title)));
  ex('bank@demo.pcs', 'payment.reconcile', { paymentIds: [last.id] });
  assert.ok(bl().milestones.settled);
  // Public tracker lists milestones in the order they happened (finding from the first demo run).
  const tl = q('tess@test.ng', 'track', { ref: 'TESTBL001' }) || makeQueries(E).run(null, 'track', { ref: 'TESTBL001' });
  const done = tl.timeline.filter((e) => e.at);
  assert.deepEqual(done.map((e) => e.at), [...done.map((e) => e.at)].sort((a, b) => a - b));
  assert.ok(done.findIndex((e) => e.key === 'declared') < done.findIndex((e) => e.key === 'discharged'), 'pre-arrival declaration shows before discharge');
  // Every message is queued for real delivery, never marked as sent by the engine.
  assert.ok(E.state.outbox.length && E.state.outbox.filter((m) => m.at > Date.UTC(2026, 10, 20, 9)).every((m) => m.status === 'QUEUED'));
  // 11. Every party was notified along the way.
  for (const o of [reg.orgId, org('Lagos Electronics Hub'), org('Bight Container Terminal (Apapa)'), org('Eko Haulage')]) assert.ok(E.state.notifications.some((n) => n.orgId === o && n.ref?.id === blId));
  // Audit: trace has the full story and chain verifies.
  const trace = E.state.audit.filter((a) => a.trace === 'TRC-TESTBL001').map((a) => a.action);
  for (const a of ['bl.manifested', 'declaration.lodged', 'payment.captured', 'customs.released', 'terminal.released', 'release.ordered', 'gate.denied', 'gate.out', 'shipment.closed']) assert.ok(trace.includes(a), a);
  assert.ok(E.verifyAudit().ok);
});

test('the valuation exchange rate is posted by the Customs administrator, with its source', () => {
  const { E, ex } = world();
  assert.throws(() => ex('npa.admin@demo.pcs', 'customs.fx.set', { rate: 1400, source: 'x', effectiveFrom: '2026-11-25' }), /not permitted/);
  assert.throws(() => ex('npa.admin@demo.pcs', 'settings.update', { changes: { fxNgnPerUsd: 1400 } }), /Customs/);
  assert.throws(() => ex('customs@demo.pcs', 'customs.fx.set', { rate: 3, source: 'x', effectiveFrom: '2026-11-25' }), /rate/);
  ex('customs@demo.pcs', 'customs.fx.set', { rate: 1412.5, source: 'CBN official rate', effectiveFrom: '2026-11-25' });
  assert.equal(E.state.settings.fxNgnPerUsd, 1412.5);
  assert.equal(E.state.audit.at(-1).action, 'customs.fx.set');
  assert.ok(E.verifyAudit().ok);
});

test('RBAC and data scoping', () => {
  const { ex, q } = world();
  const bls = q('forwarder@demo.pcs', 'shipments').map((b) => b.blNo);
  const other = q('harbourline@demo.pcs', 'shipments').map((b) => b.blNo);
  assert.ok(bls.length && other.length);
  assert.equal(bls.filter((b) => other.includes(b)).length, 0, 'forwarders must not see each other’s shipments');
  const foreign = q('npa.admin@demo.pcs', 'shipments').find((b) => !bls.includes(b.blNo));
  assert.equal(q('forwarder@demo.pcs', 'shipment', { id: foreign.id }), null);
  assert.throws(() => ex('forwarder@demo.pcs', 'release.approve', { blId: foreign.id }), /not permitted/);
  assert.throws(() => ex('npa.marine@demo.pcs', 'org.approve', { orgId: 'ORG-0001' }), /not permitted/, 'non-admin NPA user cannot approve orgs');
  assert.throws(() => ex(null, 'org.register', { name: 'Fake Customs', type: 'CUSTOMS', email: 'a@b.c', tin: '12345678-0001', rcNumber: 'RC 1234', admin: { name: 'x', email: 'x@y.z', salt: 's', passwordHash: 'h' } }), /onboarded/);
});

test('validation: ISO 6346, duplicate B/L, berth clash, manifest error aggregation', () => {
  const { E, ex, org } = world();
  assert.ok(validContainerNo('CSQU3054383')); assert.ok(!validContainerNo('CSQU3054384'));
  const v = Object.values(E.state.voyages).find((x) => x.status === 'BERTH_ALLOCATED');
  try { ex('shipping@demo.pcs', 'manifest.submit', { voyageId: v.id, bls: [{ blNo: 'AMLU045W001', shipper: 'x', consignee: { name: 'y' }, description: 'd', hsCode: '9999', packages: 1, grossWeightKg: 10, containers: [{ no: 'CSQU3054384', size: '20' }] }] }); assert.fail(); }
  catch (e) { assert.equal(e.code, 'VALIDATION'); assert.ok(e.details.errors.length >= 3, JSON.stringify(e.details.errors)); }
  const planned = Object.values(E.state.voyages).find((x) => x.status === 'PLANNED');
  const sr = Object.values(E.state.services).find((s) => s.voyageId === planned.id && s.status === 'PENDING');
  // Force a clash: allocate the berth currently held by the allocated voyage if windows overlap.
  const { voyageId } = ex('shipping@demo.pcs', 'voyage.create', { imo: v.imo, voyageNo: 'CLASH1', port: v.port, terminalOrgId: v.terminalOrgId, eta: v.eta, etd: v.etd });
  const sr2 = Object.values(E.state.services).find((s) => s.voyageId === voyageId);
  assert.throws(() => ex('npa.marine@demo.pcs', 'service.decide', { serviceId: sr2.id, decision: 'approve', data: { berth: v.berth } }), /allocated to/);
  assert.ok(sr);
});

test('failed commands leave no trace (atomicity) and tampering is detected', () => {
  const { E, ex } = world();
  const before = { seq: E.state.seq, audit: E.state.audit.length, hash: E.state.lastHash, inv: Object.keys(E.state.invoices).length };
  assert.throws(() => ex('forwarder@demo.pcs', 'payment.pay', { invoiceIds: ['INV-99999'], bankOrgId: 'nope' }));
  assert.deepEqual({ seq: E.state.seq, audit: E.state.audit.length, hash: E.state.lastHash, inv: Object.keys(E.state.invoices).length }, before);
  E.state.audit[10].summary = 'tampered';
  const r = E.verifyAudit(); assert.equal(r.ok, false); assert.equal(r.brokenAt, 11);
});

test('login lockout after five failures', () => {
  const { E, ex } = world();
  for (let i = 0; i < 5; i++) ex(null, 'auth.failed', { email: 'customs@demo.pcs' }, 0.01);
  assert.ok(E.lockState('customs@demo.pcs', E.state.lastAt) > 0);
  assert.ok(E.verifyPassword(E.findUserByEmail('customs@demo.pcs'), DEMO_PASSWORD));
});
