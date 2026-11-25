// Seeded showcase data. Drives the REAL engine through realistic, interleaved scenarios so every
// record, invoice, notification and audit entry is produced by the same business rules users hit.
import { createEngine } from './engine.js';
import { hashPassword } from './sha256.js';
import { makeContainerNo } from './reference.js';

export const DEMO_PASSWORD = 'demo1234';
const HOUR = 3600e3, DAY = 24 * HOUR;

function imoWithCheck(six) { const s = [...String(six)].reduce((a, d, i) => a + Number(d) * (7 - i), 0); return `${six}${s % 10}`; }

export const DEMO_ORGS = [
  { key: 'npa', type: 'NPA', name: 'Port Authority (Demo)', email: 'ops@npa.demo', tin: '10000001-0001', rc: 'IT 100001', admin: ['Amaka Obi', 'npa.admin@demo.pcs', 'Head, Port Operations'], extra: [['Tunde Bakare', 'npa.marine@demo.pcs', 'Harbour Master (Berthing)']] },
  { key: 'customs', type: 'CUSTOMS', name: 'Customs Service, Apapa Command (Demo)', email: 'apapa@customs.demo', tin: '10000002-0001', rc: 'IT 100002', admin: ['Halima Musa', 'customs@demo.pcs', 'Deputy Comptroller'], byNpa: true },
  { key: 'audit', type: 'AUDIT', name: 'Audit & Compliance Unit (Demo)', email: 'audit@pcs.demo', tin: '10000003-0001', rc: 'IT 100003', admin: ['Ifeoma Nwosu', 'auditor@demo.pcs', 'Chief Auditor'], byNpa: true },
  { key: 'fda', type: 'OGA', category: 'FOOD', name: 'Food & Drug Agency (Demo)', email: 'ports@fda.demo', tin: '10000004-0001', rc: 'IT 100004', admin: ['Dr. Kemi Adeyemi', 'fda@demo.pcs', 'Ports Inspection Director'], byNpa: true },
  { key: 'son', type: 'OGA', category: 'STANDARDS', name: 'Standards Organisation (Demo)', email: 'ports@son.demo', tin: '10000005-0001', rc: 'IT 100005', admin: ['Engr. Musa Danladi', 'son@demo.pcs', 'Conformity Assessment'], byNpa: true },
  { key: 'aml', type: 'SHIPPING', name: 'Atlantic Meridian Lines', email: 'ng@aml.demo', phone: '+2348010000001', tin: '20000001-0001', rc: 'RC 410221', admin: ['Chidi Eze', 'shipping@demo.pcs', 'Country Manager'] },
  { key: 'gss', type: 'SHIPPING', name: 'Gulf Star Shipping Agency', email: 'ops@gss.demo', tin: '20000002-0001', rc: 'RC 389112', admin: ['Bola Ahmed', 'gulfstar@demo.pcs', 'Agency Manager'] },
  { key: 'bct', type: 'TERMINAL', port: 'APAPA', name: 'Bight Container Terminal (Apapa)', email: 'ops@bct.demo', tin: '30000001-0001', rc: 'RC 502331', admin: ['Segun Alade', 'terminal@demo.pcs', 'Terminal Operations Manager'], extra: [['Grace Etim', 'gate@demo.pcs', 'Gate Supervisor']] },
  { key: 'cst', type: 'TERMINAL', port: 'TINCAN', name: 'Creekside Terminals (Tin Can)', email: 'ops@cst.demo', tin: '30000002-0001', rc: 'RC 502998', admin: ['Yusuf Bello', 'creekside@demo.pcs', 'Terminal Manager'] },
  { key: 'swift', type: 'FORWARDER', name: 'Swiftclear Logistics', email: 'desk@swiftclear.demo', phone: '+2348010000002', tin: '40000001-0001', rc: 'RC 611200', admin: ['Ngozi Okeke', 'forwarder@demo.pcs', 'Licensed Customs Agent'] },
  { key: 'hfl', type: 'FORWARDER', name: 'Harbourline Freight', email: 'ops@harbourline.demo', tin: '40000002-0001', rc: 'RC 623455', admin: ['Emeka Uche', 'harbourline@demo.pcs', 'Clearing Manager'] },
  { key: 'okafor', type: 'IMPORTER', name: 'Okafor Foods Ltd', email: 'imports@okaforfoods.demo', tin: '50000001-0001', rc: 'RC 700101', admin: ['Mrs. Ada Okafor', 'importer@demo.pcs', 'Supply Chain Director'] },
  { key: 'lehub', type: 'IMPORTER', name: 'Lagos Electronics Hub', email: 'buying@lehub.demo', tin: '50000002-0001', rc: 'RC 712877', admin: ['Femi Johnson', 'lehub@demo.pcs', 'Procurement Lead'] },
  { key: 'delta', type: 'IMPORTER', name: 'Delta Steel Traders', email: 'info@deltasteel.demo', tin: '50000003-0001', rc: 'RC 733019', admin: ['Ibrahim Sani', 'delta@demo.pcs', 'MD'] },
  { key: 'ucb', type: 'BANK', name: 'Unity Commerce Bank', email: 'trade@ucb.demo', tin: '60000001-0001', rc: 'RC 120044', admin: ['Joy Akpan', 'bank@demo.pcs', 'Trade Services'] },
  { key: 'ppg', type: 'BANK', name: 'PayPort Gateway', email: 'settlement@payport.demo', tin: '60000002-0001', rc: 'RC 130551', admin: ['Ken Odu', 'payport@demo.pcs', 'Settlement Ops'] },
  { key: 'eko', type: 'TRANSPORTER', name: 'Eko Haulage', email: 'dispatch@ekohaulage.demo', phone: '+2348010000003', tin: '70000001-0001', rc: 'RC 801122', admin: ['Sunday Obi', 'haulage@demo.pcs', 'Dispatch Manager'] },
  { key: 'nct', type: 'TRANSPORTER', name: 'Northern Corridor Trucks', email: 'ops@nct.demo', tin: '70000002-0001', rc: 'RC 809001', admin: ['Aliyu Garba', 'nct@demo.pcs', 'Fleet Manager'] },
];

export function buildSeed(nowMs = Date.now()) {
  const E = createEngine();
  let t = nowMs - 21 * DAY;
  let saltN = 0;
  const secret = (pw) => { const salt = `seed-salt-${++saltN}`; return { salt, passwordHash: hashPassword(pw, salt) }; };
  const U = {}, O = {};
  const ex = (type, who, payload) => E.execute({ type, userId: who ? U[who] : null, at: t, payload });

  ex('system.init', null, { seed: 'pcs-showcase-v1' });
  for (const o of DEMO_ORGS) {
    const res = ex('org.register', o.byNpa ? 'npa.admin@demo.pcs' : null, { name: o.name, type: o.type, email: o.email, phone: o.phone, tin: o.tin, rcNumber: o.rc, category: o.category, port: o.port, address: 'Lagos, Nigeria',
      admin: { name: o.admin[0], email: o.admin[1], title: o.admin[2], ...secret(DEMO_PASSWORD) } });
    O[o.key] = res.orgId; U[o.admin[1]] = res.userId; t += 10 * 60e3;
    if (res.status === 'PENDING') { t += 2 * HOUR; ex('org.approve', 'npa.admin@demo.pcs', { orgId: res.orgId, decision: 'approve', note: 'CAC and TIN verified' }); }
    for (const [name, email, title] of o.extra || []) { const r = ex('user.create', o.admin[1], { name, email, title, ...secret(DEMO_PASSWORD) }); U[email] = r.userId; }
  }
  t += HOUR;
  const pending = ex('org.register', null, { name: 'New Wave Forwarding', type: 'FORWARDER', email: 'hello@newwave.demo', tin: '40000003-0001', rcNumber: 'RC 690004', admin: { name: 'Tolu Bankole', email: 'newwave@demo.pcs', ...secret(DEMO_PASSWORD) } });

  const vessels = [['MERIDIAN STAR', 932148, 'LR'], ['GULF PIONEER', 941207, 'PA'], ['MERIDIAN GRACE', 950339, 'MT'], ['ATLANTIC DAWN', 962280, 'LR']];
  const IMO = {};
  for (const [name, six, flag] of vessels) { IMO[name] = imoWithCheck(six); ex('vessel.register', name.startsWith('GULF') ? 'gulfstar@demo.pcs' : 'shipping@demo.pcs', { imo: IMO[name], name, flag, grt: 54000, loa: 294 }); }

  // ----- deterministic scheduler
  let rnd = 42; const rand = (a, b) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return a + (rnd / 2147483648) * (b - a); };
  const jobs = [];
  const spawn = (gen, delayH = 0) => jobs.push({ gen, wake: t + delayH * HOUR });
  const cutoff = nowMs - 20 * 60e3;
  const S = () => E.state;

  let serial = 100000;
  const ctr = (owner, size) => ({ no: makeContainerNo(owner, ++serial), size: String(size), type: 'GP', sealNo: `SL${serial}`, weightKg: 0 });

  function* voyageFlow(v) {
    const owner = v.carrier;
    const { voyageId } = ex('voyage.create', owner, { imo: IMO[v.vessel], voyageNo: v.no, port: v.port, terminalOrgId: O[v.terminal], eta: v.eta, etd: v.eta + 3 * DAY, lastPort: v.lastPort, nextPort: 'Tema', preferredBerth: v.berth });
    yield rand(3, 9);
    const sr = Object.values(S().services).find((s) => s.voyageId === voyageId && s.type === 'BERTH');
    if (v.stop === 'berth_pending') return;
    ex('service.decide', 'npa.marine@demo.pcs', { serviceId: sr.id, decision: 'approve', data: { berth: v.berth }, note: 'Allocated per berth plan' });
    yield rand(2, 6);
    const bls = v.bls.map((b) => {
      const containers = Array.from({ length: b.n }, () => ctr(v.prefix, b.size));
      containers.forEach((c) => (c.weightKg = Math.round(b.kg / b.n)));
      return { blNo: b.blNo, shipper: b.shipper, consignee: { orgId: O[b.cons] }, forwarderOrgId: b.fwd ? O[b.fwd] : null, portOfLoading: b.pol, description: b.desc, hsCode: b.hs, packages: b.pk, packageType: 'CTN', grossWeightKg: b.kg, containers };
    });
    const { blIds } = ex('manifest.submit', owner, { voyageId, bls, source: v.source || 'api' });
    blIds.forEach((id, i) => spawn(blFlow(id, v.bls[i]), rand(1, 10)));
    while (t < v.eta) yield (v.eta - t) / HOUR;
    if (v.stop === 'not_arrived') return;
    ex('voyage.arrive', 'npa.marine@demo.pcs', { voyageId });
    yield rand(2, 5);
    ex('cargo.discharge', 'terminal@demo.pcs'.replace('terminal', v.terminal === 'bct' ? 'terminal' : 'creekside'), { voyageId });
    yield rand(40, 60);
    ex('voyage.depart', 'npa.marine@demo.pcs', { voyageId });
  }

  const STEPS = ['declared', 'paid', 'permits', 'customs', 'do', 'terminal', 'trucks', 'released', 'gated', 'delivered'];
  function* blFlow(blId, b) {
    const bl = () => S().bls[blId];
    const fwdUser = b.fwdUser, payer = fwdUser;
    const stopAfter = (name) => b.target === name;
    const payAll = () => {
      const unpaid = bl().invoiceIds.map((i) => S().invoices[i]).filter((i) => i.status === 'UNPAID');
      if (unpaid.length) ex('payment.pay', payer, { invoiceIds: unpaid.map((i) => i.id), bankOrgId: O[b.bank || 'ucb'], method: b.method || 'card' });
    };
    if (b.target === 'manifested') return;
    while (!bl().milestones.discharged && !b.preArrival) yield 3;
    yield rand(2, 18);
    ex('declaration.lodge', fwdUser, { blId, fobValueUsd: b.fob, freightUsd: b.freight, formMNo: `MF2026${String(serial++).slice(-4).padStart(4, '0')}`, cpc: '4000', originCountry: b.origin, grossWeightKg: b.declKg });
    if (stopAfter('declared')) return;
    yield rand(2, 12);
    payAll();
    if (stopAfter('paid')) return;
    for (const cat of bl().permitsRequired) {
      yield rand(1, 4);
      const oga = Object.values(S().orgs).find((o) => o.type === 'OGA' && o.category === cat);
      const { serviceId } = ex('service.request', fwdUser, { type: 'PERMIT', blId, toOrgId: oga.id, note: 'Certificate of analysis and SONCAP attached' });
      if (b.target === 'permit_pending') return;
      yield rand(6, 30);
      ex('service.decide', cat === 'FOOD' ? 'fda@demo.pcs' : 'son@demo.pcs', { serviceId, decision: 'approve', note: 'Documents conform', data: { conditions: 'Batch sampling at warehouse' } });
    }
    if (stopAfter('permits')) return;
    // Customs lane handling
    for (let guard = 0; guard < 50 && S().declarations[bl().declarationId].status !== 'RELEASED'; guard++) {
      const d = S().declarations[bl().declarationId];
      if (d.status === 'AWAITING_REVIEW') {
        if (b.target === 'review') return;
        yield rand(3, 20);
        if (b.query && !d.queries.length) { ex('declaration.review', 'customs@demo.pcs', { declarationId: d.id, decision: 'query', note: 'Provide supplier invoice and packing list for value verification' }); if (b.target === 'query') return; continue; }
        ex('declaration.review', 'customs@demo.pcs', { declarationId: d.id, decision: 'approve', note: 'Documents verified' });
      } else if (d.status === 'QUERIED') {
        yield rand(4, 16);
        ex('declaration.respond', fwdUser, { declarationId: d.id, note: 'Supplier invoice INV-88231 and packing list uploaded', documents: ['supplier-invoice.pdf', 'packing-list.pdf'] });
      } else if (d.status === 'AWAITING_EXAM') {
        if (!bl().milestones.discharged) { yield 3; continue; }
        const sr = Object.values(S().services).find((s) => s.blId === blId && s.type === 'EXAM_POSITION' && s.status === 'PENDING');
        if (sr) { yield rand(2, 10); ex('service.decide', S().voyages[bl().voyageId].terminalOrgId === O.bct ? 'terminal@demo.pcs' : 'creekside@demo.pcs', { serviceId: sr.id, decision: 'approve', note: 'Positioned at exam bay' }); }
        if (b.target === 'exam') return;
        yield rand(4, 14);
        if (b.discrepancy) ex('exam.record', 'customs@demo.pcs', { declarationId: d.id, finding: 'DISCREPANCY', note: 'Quantity found exceeds declared; value uplifted', revisedFobUsd: Math.round(b.fob * 1.4) });
        else ex('exam.record', 'customs@demo.pcs', { declarationId: d.id, finding: 'CLEAN', note: 'Goods as declared' });
      } else if (d.status === 'AWAITING_SUPP_PAYMENT') { yield rand(3, 12); payAll(); }
      else if (d.status === 'ASSESSED') { yield 2; payAll(); }
      else yield 3;
    }
    if (stopAfter('customs')) return;
    yield rand(1, 6);
    const doReq = ex('service.request', fwdUser, { type: 'DELIVERY_ORDER', blId, note: 'Original B/L surrendered electronically' });
    yield rand(3, 14);
    const carrierUser = S().voyages[bl().voyageId].shippingOrgId === O.aml ? 'shipping@demo.pcs' : 'gulfstar@demo.pcs';
    ex('service.decide', carrierUser, { serviceId: doReq.serviceId, decision: 'approve', note: 'Freight confirmed paid' });
    if (b.target === 'do_unpaid') return;
    yield rand(1, 6);
    payAll();
    if (stopAfter('do')) return;
    while (!bl().milestones.discharged) yield 3;
    yield rand(2, 8);
    const termUser = S().voyages[bl().voyageId].terminalOrgId === O.bct ? 'terminal@demo.pcs' : 'creekside@demo.pcs';
    let r = ex('terminal.release', termUser, { blId });
    if (r.held) { yield rand(1, 5); payAll(); yield rand(1, 3); ex('terminal.release', termUser, { blId }); }
    if (stopAfter('terminal')) return;
    yield rand(1, 4);
    const trans = b.trans || 'eko';
    const tb = ex('service.request', fwdUser, { type: 'TRUCK_BOOKING', blId, toOrgId: O[trans], destination: b.dest || 'Ikeja warehouse' });
    yield rand(1, 6);
    const plates = ['LND-482XY', 'KJA-219AB', 'APP-773KD', 'EPE-104GH', 'AGL-655TR', 'FKJ-390LM', 'MUS-871QP', 'LSR-226BN'];
    const assignments = bl().containerIds.map((cid, i) => ({ containerNo: S().containers[cid].no, plate: plates[(i + serial) % plates.length], driver: ['Musa Ibrahim', 'John Okon', 'Peter Ade', 'Usman Lawal'][i % 4], phone: '+2348030000000', slotAt: t + 6 * HOUR }));
    ex('service.decide', trans === 'eko' ? 'haulage@demo.pcs' : 'nct@demo.pcs', { serviceId: tb.serviceId, decision: 'approve', data: { assignments }, note: 'Trucks assigned' });
    if (stopAfter('trucks')) return;
    yield rand(1, 8);
    ex('release.approve', 'npa.admin@demo.pcs', { blId, note: 'All conditions satisfied' });
    if (stopAfter('released')) return;
    for (const cid of bl().containerIds) {
      yield rand(3, 8);
      const c = S().containers[cid]; const gp = S().gatePasses[c.gatePassId];
      ex('gate.out', termUser === 'terminal@demo.pcs' ? 'gate@demo.pcs' : termUser, { token: gp.token, plate: gp.truck.plate });
    }
    if (stopAfter('gated')) return;
    yield rand(4, 20);
    ex('delivery.confirm', fwdUser, { blId, note: 'Received in good order' });
    if (Math.random && rand(0, 1) > 0.3) {
      const pays = Object.values(S().payments).filter((p) => p.status === 'SUCCESS');
      const byBank = {}; pays.forEach((p) => (byBank[p.bankOrgId] = byBank[p.bankOrgId] || []).push(p.id));
      for (const [bankId, ids] of Object.entries(byBank)) ex('payment.reconcile', bankId === O.ucb ? 'bank@demo.pcs' : 'payport@demo.pcs', { paymentIds: ids });
    }
  }

  const sh = (n) => ['Shenzhen Bright Electronics Co.', 'Bangkok Rice Exporters Ltd', 'Rotterdam Dairy BV', 'Antwerp Steel NV', 'Guangzhou Footwear Mfg', 'Mumbai Pharma Exports'][n];
  const voyagesPlan = [
    { vessel: 'MERIDIAN STAR', no: '045W', carrier: 'shipping@demo.pcs', prefix: 'AML', port: 'APAPA', terminal: 'bct', berth: 'APP-B02', eta: nowMs - 18 * DAY, lastPort: 'Lome', start: 0,
      bls: [
        { blNo: 'AMLU045W001', shipper: sh(0), cons: 'lehub', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'CNSZX', desc: 'Laptop computers', hs: '8471', pk: 800, kg: 9600, n: 1, size: 40, fob: 410000, origin: 'CN', target: 'delivered' },
        { blNo: 'AMLU045W002', shipper: sh(1), cons: 'okafor', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'THBKK', desc: 'Parboiled rice, 50kg bags', hs: '1006', pk: 1000, kg: 50000, n: 2, size: 20, fob: 31000, origin: 'TH', target: 'delivered', preArrival: true },
        { blNo: 'AMLU045W003', shipper: sh(3), cons: 'delta', fwd: 'hfl', fwdUser: 'harbourline@demo.pcs', pol: 'BEANR', desc: 'Steel reinforcing bars', hs: '7214', pk: 60, kg: 52000, n: 2, size: 20, fob: 36000, origin: 'BE', target: 'delivered', trans: 'nct', bank: 'ppg' },
        { blNo: 'AMLU045W004', shipper: sh(2), cons: 'okafor', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'NLRTM', desc: 'Evaporated milk, cartons', hs: '0402', pk: 2400, kg: 21000, n: 1, size: 40, fob: 52000, origin: 'NL', target: 'delivered' },
        { blNo: 'AMLU045W005', shipper: sh(4), cons: 'lehub', fwd: 'hfl', fwdUser: 'harbourline@demo.pcs', pol: 'CNCAN', desc: 'Leather shoes', hs: '6403', pk: 600, kg: 7000, n: 1, size: 40, fob: 18000, origin: 'CN', target: 'delivered', discrepancy: true, declKg: 6000, bank: 'ppg' },
      ] },
    { vessel: 'GULF PIONEER', no: '112E', carrier: 'gulfstar@demo.pcs', prefix: 'GSS', port: 'TINCAN', terminal: 'cst', berth: 'TCI-B03', eta: nowMs - 10 * DAY, lastPort: 'Abidjan', start: 0,
      bls: [
        { blNo: 'GSSU112E001', shipper: sh(0), cons: 'lehub', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'CNSZX', desc: 'Smartphones', hs: '8517', pk: 300, kg: 4200, n: 1, size: 20, fob: 520000, origin: 'CN', target: 'delivered', preArrival: true },
        { blNo: 'GSSU112E002', shipper: sh(5), cons: 'okafor', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'INNSA', desc: 'Packaged paracetamol tablets', hs: '3004', pk: 900, kg: 8000, n: 1, size: 20, fob: 61000, origin: 'IN', target: 'gated' },
        { blNo: 'GSSU112E003', shipper: sh(3), cons: 'delta', fwd: 'hfl', fwdUser: 'harbourline@demo.pcs', pol: 'BEANR', desc: 'Steel bars', hs: '7214', pk: 40, kg: 26000, n: 1, size: 20, fob: 17500, origin: 'BE', target: 'released', trans: 'nct', bank: 'ppg' },
      ] },
    { vessel: 'MERIDIAN GRACE', no: '046W', carrier: 'shipping@demo.pcs', prefix: 'AMG', port: 'APAPA', terminal: 'bct', berth: 'APP-B04', eta: nowMs - 4 * DAY, lastPort: 'Lome', start: 0,
      bls: [
        { blNo: 'AMLU046W001', shipper: sh(0), cons: 'lehub', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'CNSZX', desc: 'Desktop computers and monitors', hs: '8471', pk: 500, kg: 11000, n: 2, size: 40, fob: 380000, origin: 'CN', target: 'trucks' },
        { blNo: 'AMLU046W002', shipper: sh(1), cons: 'okafor', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'THBKK', desc: 'Rice, 25kg bags', hs: '1006', pk: 1800, kg: 45000, n: 2, size: 20, fob: 16000, origin: 'TH', target: 'query', query: true },
        { blNo: 'AMLU046W007', shipper: sh(1), cons: 'delta', fwd: 'hfl', fwdUser: 'harbourline@demo.pcs', pol: 'THBKK', desc: 'Rice, 50kg bags', hs: '1006', pk: 600, kg: 30000, n: 1, size: 20, fob: 9000, origin: 'TH', target: 'review', bank: 'ppg' },
        { blNo: 'AMLU046W003', shipper: 'Unknown Trading FZE', cons: 'delta', fwd: 'hfl', fwdUser: 'harbourline@demo.pcs', pol: 'AEJEA', desc: 'Cigarettes', hs: '2402', pk: 700, kg: 9000, n: 1, size: 40, fob: 60000, origin: 'AE', target: 'exam' },
        { blNo: 'AMLU046W004', shipper: sh(2), cons: 'okafor', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'NLRTM', desc: 'Milk powder', hs: '0402', pk: 1500, kg: 18000, n: 1, size: 40, fob: 47000, origin: 'NL', target: 'permit_pending' },
        { blNo: 'AMLU046W005', shipper: sh(4), cons: 'lehub', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'CNCAN', desc: 'Refrigerators', hs: '8418', pk: 120, kg: 8500, n: 1, size: 40, fob: 42000, origin: 'CN', target: 'declared' },
        { blNo: 'AMLU046W006', shipper: sh(3), cons: 'delta', fwd: 'hfl', fwdUser: 'harbourline@demo.pcs', pol: 'BEANR', desc: 'Steel rods', hs: '7214', pk: 30, kg: 24000, n: 1, size: 20, fob: 16500, origin: 'BE', target: 'do_unpaid', bank: 'ppg' },
      ] },
    { vessel: 'ATLANTIC DAWN', no: '210N', carrier: 'shipping@demo.pcs', prefix: 'ATD', port: 'APAPA', terminal: 'bct', berth: 'APP-B01', eta: nowMs + 2 * DAY, lastPort: 'Dakar', start: 0, stop: 'berth_pending', bls: [] },
    { vessel: 'MERIDIAN STAR', no: '047W', carrier: 'shipping@demo.pcs', prefix: 'AMS', port: 'APAPA', terminal: 'bct', berth: 'APP-B02', eta: nowMs + 1 * DAY, lastPort: 'Lome', stop: 'not_arrived',
      bls: [
        { blNo: 'AMLU047W001', shipper: sh(0), cons: 'lehub', fwd: 'swift', fwdUser: 'forwarder@demo.pcs', pol: 'CNSZX', desc: 'Tablet computers', hs: '8471', pk: 400, kg: 5200, n: 1, size: 20, fob: 290000, origin: 'CN', target: 'manifested' },
        { blNo: 'AMLU047W002', shipper: sh(2), cons: 'okafor', fwd: 'hfl', fwdUser: 'harbourline@demo.pcs', pol: 'NLRTM', desc: 'Cane sugar', hs: '1701', pk: 1000, kg: 25000, n: 1, size: 20, fob: 14000, origin: 'NL', target: 'declared', preArrival: true },
      ] },
  ];
  const starts = [nowMs - 20 * DAY, nowMs - 12.5 * DAY, nowMs - 6.5 * DAY, nowMs - 1.2 * DAY, nowMs - 1.5 * DAY];
  voyagesPlan.forEach((v, i) => jobs.push({ gen: voyageFlow(v), wake: starts[i] }));

  while (jobs.length) {
    jobs.sort((a, b) => a.wake - b.wake);
    const job = jobs[0];
    if (job.wake > cutoff) break;
    t = Math.max(t, job.wake);
    const r = job.gen.next();
    if (r.done) jobs.shift(); else job.wake = t + Math.max(0.05, r.value) * HOUR;
  }
  return { log: E.log.slice(), users: U, orgs: O, pendingOrgId: pending.orgId };
}
