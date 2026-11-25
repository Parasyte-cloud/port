// Read models. Every query is scoped to what the caller's organisation is entitled to see.
import * as R from './reference.js';
import { typeLabel } from './engine.js';

const HOUR = 3600e3;
const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);

export function makeQueries(E) {
  const S = () => E.state;
  const org = (id) => S().orgs[id];
  const orgName = (id) => (id ? org(id)?.name || id : null);
  const sees = {
    risk: (a) => a && ['CUSTOMS', 'AUDIT'].includes(a.orgType),
    all: (a) => a && ['NPA', 'CUSTOMS', 'AUDIT'].includes(a.orgType),
  };

  function canSeeBl(a, bl) {
    if (!a) return false;
    if (sees.all(a)) return true;
    const v = S().voyages[bl.voyageId];
    switch (a.orgType) {
      case 'SHIPPING': return v.shippingOrgId === a.orgId;
      case 'TERMINAL': return v.terminalOrgId === a.orgId;
      case 'FORWARDER': return bl.forwarderOrgId === a.orgId;
      case 'IMPORTER': return bl.consigneeOrgId === a.orgId;
      case 'OGA': case 'TRANSPORTER': return bl.serviceIds.some((s) => S().services[s].deciderOrgId === a.orgId);
      case 'BANK': return bl.invoiceIds.some((i) => { const p = S().invoices[i].paymentId; return p && S().payments[p].bankOrgId === a.orgId; });
      default: return false;
    }
  }
  const visibleBls = (a) => Object.values(S().bls).filter((b) => canSeeBl(a, b));
  const canSeeVoyage = (a, v) => sees.all(a) || v.shippingOrgId === a.orgId || v.terminalOrgId === a.orgId || visibleBls(a).some((b) => b.voyageId === v.id);

  function blSummary(a, bl) {
    const v = S().voyages[bl.voyageId];
    const d = bl.declarationId && S().declarations[bl.declarationId];
    const invs = bl.invoiceIds.map((i) => S().invoices[i]);
    const ms = Object.values(bl.milestones);
    return {
      id: bl.id, blNo: bl.blNo, stage: bl.stage, vessel: v.vesselName, voyageNo: v.voyageNo, port: v.port, terminal: orgName(v.terminalOrgId),
      consignee: bl.consigneeName, forwarder: orgName(bl.forwarderOrgId), description: bl.description, hsCode: bl.hsCode,
      containers: bl.containerIds.length, teu: bl.containerIds.reduce((x, c) => x + R.teu(S().containers[c].size), 0),
      lane: d ? d.lane : null, declarationNo: d ? d.no : null,
      unpaid: invs.filter((i) => i.status === 'UNPAID' && (sees.all(a) || i.payerOrgId === a.orgId || i.beneficiaryOrgId === a.orgId)).reduce((x, i) => x + i.total, 0),
      updatedAt: Math.max(...ms), eta: v.eta, manifestedAt: bl.milestones.manifested,
    };
  }

  function timeline(a, trace) {
    return S().audit.filter((e) => e.trace === trace).map((e) => ({ n: e.n, at: e.at, action: e.action, summary: e.summary, by: e.by.system ? 'PCS rules engine' : `${e.by.name}${e.by.orgName ? ', ' + e.by.orgName : ''}`, system: !!e.by.system, hash: e.hash }));
  }

  function workQueue(a) {
    const items = [];
    const push = (title, detail, ref, action, extra = {}) => items.push({ title, detail, ref, action, ...extra });
    const st = S(); const now = E.now(Date.now());
    const myServices = Object.values(st.services).filter((s) => s.deciderOrgId === a.orgId && s.status === 'PENDING');
    for (const s of myServices) {
      const bl = s.blId && st.bls[s.blId]; const v = st.voyages[s.voyageId];
      push(`${R.SERVICE_TYPES[s.type].label}: ${bl ? bl.blNo : v.vesselName + ' ' + v.voyageNo}`, `Requested by ${orgName(s.requesterOrgId)}`, bl ? { type: 'bl', id: bl.id } : { type: 'voyage', id: v.id }, 'Decide', { due: s.slaDueAt, overdue: now > s.slaDueAt, serviceId: s.id, step: s.type === 'BERTH' ? 4 : s.type === 'EXAM_POSITION' ? 6 : s.type === 'TRUCK_BOOKING' ? 10 : 4 });
    }
    const bls = visibleBls(a);
    switch (a.orgType) {
      case 'NPA':
        if (a.admin) Object.values(st.orgs).filter((o) => o.status === 'PENDING').forEach((o) => push(`Approve registration: ${o.name}`, `${R.ORG_TYPES[o.type].label}, CAC ${o.rcNumber}, TIN ${o.tin}`, { type: 'admin', id: o.id }, 'Review', { step: 1 }));
        Object.values(st.voyages).filter((v) => v.status === 'BERTH_ALLOCATED' && v.eta <= now + 6 * HOUR).forEach((v) => push(`Record arrival: ${v.vesselName} ${v.voyageNo}`, `Berth ${v.berth}, ETA ${new Date(v.eta).toUTCString()}`, { type: 'voyage', id: v.id }, 'Record arrival', { step: 6 }));
        bls.filter((b) => !b.milestones.releaseOrdered && E.checklist(b).ready).forEach((b) => push(`Issue release order: ${b.blNo}`, 'All seven release conditions satisfied', { type: 'bl', id: b.id }, 'Release', { step: 8 }));
        break;
      case 'CUSTOMS':
        Object.values(st.declarations).forEach((d) => {
          const b = st.bls[d.blId];
          if (d.status === 'AWAITING_REVIEW') push(`Documentary review: ${d.no}`, `${b.blNo}, ${b.description}, risk ${d.risk.score}`, { type: 'bl', id: b.id }, 'Review', { step: 5, lane: d.lane });
          if (d.status === 'AWAITING_EXAM' && d.examReady) push(`Record examination: ${d.no}`, `${b.blNo} positioned at exam bay`, { type: 'bl', id: b.id }, 'Record exam', { step: 5, lane: 'RED' });
        });
        break;
      case 'SHIPPING':
        Object.values(st.voyages).filter((v) => v.shippingOrgId === a.orgId && !v.manifestIds.length && v.status !== 'DEPARTED').forEach((v) => push(`File manifest: ${v.vesselName} ${v.voyageNo}`, `ETA ${new Date(v.eta).toUTCString()}`, { type: 'voyage', id: v.id }, 'File manifest', { step: 2 }));
        break;
      case 'TERMINAL':
        Object.values(st.voyages).filter((v) => v.terminalOrgId === a.orgId && v.status === 'ARRIVED' && Object.values(st.containers).some((c) => c.voyageId === v.id && !c.dischargedAt)).forEach((v) => push(`Discharge: ${v.vesselName} ${v.voyageNo}`, `At ${v.berth}`, { type: 'voyage', id: v.id }, 'Discharge', { step: 6 }));
        bls.filter((b) => b.milestones.customsReleased && b.milestones.discharged && !b.milestones.terminalReleased).forEach((b) => push(`Terminal release: ${b.blNo}`, 'Customs released; check terminal charges', { type: 'bl', id: b.id }, 'Release', { step: 6 }));
        bls.filter((b) => b.milestones.releaseOrdered && !b.milestones.gateOutAll).forEach((b) => push(`Gate-out pending: ${b.blNo}`, `${b.containerIds.filter((c) => st.containers[c].status !== 'GATED_OUT').length} container(s) awaiting truck`, { type: 'gate', id: b.id }, 'Open gate', { step: 10 }));
        break;
      case 'FORWARDER': case 'IMPORTER':
        for (const b of bls) {
          if (b.milestones.closed) continue;
          const d = b.declarationId && st.declarations[b.declarationId];
          if (!d && a.orgType === 'FORWARDER') push(`Lodge declaration: ${b.blNo}`, `${b.description}. Data pre-filled from the manifest${!b.milestones.discharged ? '; pre-arrival lodgement saves dwell time' : ''}`, { type: 'bl', id: b.id }, 'Declare', { step: 3 });
          if (d && d.status === 'QUERIED' && d.lodgedBy === a.orgId) push(`Answer Customs query: ${d.no}`, d.queries.at(-1).question, { type: 'bl', id: b.id }, 'Respond', { step: 5 });
          const unpaid = b.invoiceIds.map((i) => st.invoices[i]).filter((i) => i.status === 'UNPAID' && i.payerOrgId === a.orgId);
          if (unpaid.length) push(`Pay ${unpaid.length} invoice(s): ${b.blNo}`, `NGN ${unpaid.reduce((x, i) => x + i.total, 0).toLocaleString('en-US')} in one consolidated payment`, { type: 'bl', id: b.id }, 'Pay', { step: 7 });
          if (d) for (const cat of b.permitsRequired) if (!b.permits[cat] || b.permits[cat].status === 'REJECTED') push(`Request ${cat.toLowerCase()} permit: ${b.blNo}`, `Required for HS ${b.hsCode}`, { type: 'bl', id: b.id }, 'Request', { step: 4 });
          if (d && b.milestones.customsReleased && !b.deliveryOrder) push(`Request delivery order: ${b.blNo}`, `From ${orgName(st.voyages[b.voyageId].shippingOrgId)}`, { type: 'bl', id: b.id }, 'Request', { step: 4 });
          if (b.milestones.customsReleased && !b.serviceIds.some((s) => st.services[s].type === 'TRUCK_BOOKING' && st.services[s].status !== 'REJECTED')) push(`Book trucks: ${b.blNo}`, `${b.containerIds.length} container(s)`, { type: 'bl', id: b.id }, 'Book', { step: 10 });
          if (b.milestones.gateOutAll && !b.milestones.delivered) push(`Confirm delivery: ${b.blNo}`, 'All containers have left the port', { type: 'bl', id: b.id }, 'Confirm', { step: 12 });
        }
        break;
      case 'BANK': {
        const p = Object.values(st.payments).filter((x) => x.bankOrgId === a.orgId && x.status === 'SUCCESS');
        if (p.length) push(`Reconcile ${p.length} payment(s)`, `NGN ${p.reduce((x, y) => x + y.total, 0).toLocaleString('en-US')} awaiting settlement`, { type: 'payments' }, 'Reconcile', { step: 7 });
        break;
      }
      default:
    }
    return items;
  }

  const Q = {
    session(a) {
      const unread = S().notifications.filter((n) => n.orgId === a.orgId && !(S().reads[a.userId] || []).includes(n.id)).length;
      const perms = Object.keys(R.PERMISSIONS).filter((k) => E.allowed(k, a));
      return { user: { id: a.userId, name: a.name, email: a.user.email, title: a.user.title, admin: a.admin }, org: { id: a.orgId, name: a.orgName, type: a.orgType, typeLabel: R.ORG_TYPES[a.orgType].label, status: a.org.status, category: a.org.category, port: a.org.port }, permissions: perms, unread, now: E.now(Date.now()), clockOffset: S().clockOffset };
    },
    workQueue,
    shipments(a, p = {}) {
      let list = visibleBls(a).map((b) => blSummary(a, b));
      if (p.stage) list = list.filter((b) => b.stage === p.stage);
      if (p.q) { const q = p.q.toLowerCase(); list = list.filter((b) => [b.blNo, b.consignee, b.description, b.vessel, b.declarationNo].join(' ').toLowerCase().includes(q) || S().bls[b.id].containerIds.some((c) => S().containers[c].no.toLowerCase().includes(q))); }
      return list.sort((x, y) => y.updatedAt - x.updatedAt);
    },
    shipment(a, { id }) {
      const bl = S().bls[id]; if (!bl || !canSeeBl(a, bl)) return null;
      const v = S().voyages[bl.voyageId];
      const d = bl.declarationId ? { ...S().declarations[bl.declarationId] } : null;
      if (d && !sees.risk(a)) { d.risk = { lane: d.lane, hidden: true }; }
      const showMoney = (i) => sees.all(a) || i.payerOrgId === a.orgId || i.beneficiaryOrgId === a.orgId;
      return {
        bl: { ...bl, forwarder: orgName(bl.forwarderOrgId) }, summary: blSummary(a, bl),
        voyage: { ...v, shipping: orgName(v.shippingOrgId), terminal: orgName(v.terminalOrgId), portName: R.PORTS[v.port].name },
        vessel: S().vessels[v.imo],
        containers: bl.containerIds.map((c) => { const x = S().containers[c]; const gp = x.gatePassId && S().gatePasses[x.gatePassId]; return { ...x, gatePass: gp ? { token: (sees.all(a) || a.orgType !== 'BANK') ? gp.token : '••••', status: gp.status, expiresAt: gp.expiresAt, truck: gp.truck, usedAt: gp.usedAt } : null }; }),
        declaration: d,
        services: bl.serviceIds.map((s) => ({ ...S().services[s], label: R.SERVICE_TYPES[S().services[s].type].label, requester: orgName(S().services[s].requesterOrgId), decider: orgName(S().services[s].deciderOrgId) })),
        invoices: bl.invoiceIds.map((i) => S().invoices[i]).filter(showMoney).map((i) => ({ ...i, label: typeLabel(i.type), beneficiary: orgName(i.beneficiaryOrgId), payer: orgName(i.payerOrgId) })),
        checklist: E.checklist(bl),
        releaseOrder: bl.releaseOrderId ? S().releaseOrders[bl.releaseOrderId] : null,
        timeline: timeline(a, `TRC-${bl.blNo}`),
        permits: Object.entries(bl.permits).map(([cat, p]) => ({ cat, ...p, agency: orgName(p.orgId) })),
        options: {
          ogas: Object.values(S().orgs).filter((o) => o.type === 'OGA' && o.status === 'ACTIVE').map((o) => ({ id: o.id, name: o.name, category: o.category })),
          transporters: Object.values(S().orgs).filter((o) => o.type === 'TRANSPORTER' && o.status === 'ACTIVE').map((o) => ({ id: o.id, name: o.name })),
          banks: Object.values(S().orgs).filter((o) => o.type === 'BANK' && o.status === 'ACTIVE').map((o) => ({ id: o.id, name: o.name })),
          forwarders: Object.values(S().orgs).filter((o) => o.type === 'FORWARDER' && o.status === 'ACTIVE').map((o) => ({ id: o.id, name: o.name })),
        },
        tariff: R.TARIFF[bl.hsCode],
      };
    },
    voyages(a) {
      return Object.values(S().voyages).filter((v) => canSeeVoyage(a, v)).map((v) => ({ ...v, shipping: orgName(v.shippingOrgId), terminal: orgName(v.terminalOrgId), portName: R.PORTS[v.port].name, bls: Object.values(S().bls).filter((b) => b.voyageId === v.id).length, containers: Object.values(S().containers).filter((c) => c.voyageId === v.id).length, discharged: Object.values(S().containers).filter((c) => c.voyageId === v.id && c.dischargedAt).length, berthRequest: Object.values(S().services).find((s) => s.voyageId === v.id && s.type === 'BERTH') || null })).sort((x, y) => y.eta - x.eta);
    },
    voyage(a, { id }) {
      const v = S().voyages[id]; if (!v || !canSeeVoyage(a, v)) return null;
      const bls = Object.values(S().bls).filter((b) => b.voyageId === id && canSeeBl(a, b)).map((b) => blSummary(a, b));
      return { ...Q.voyages(a).find((x) => x.id === id), vessel: S().vessels[v.imo], manifests: v.manifestIds.map((m) => S().manifests[m]), blList: bls, timeline: timeline(a, `TRC-${v.voyageNo}`), berths: R.PORTS[v.port].berths };
    },
    services(a, p = {}) {
      return Object.values(S().services).filter((s) => sees.all(a) || s.deciderOrgId === a.orgId || s.requesterOrgId === a.orgId)
        .filter((s) => !p.status || s.status === p.status)
        .map((s) => { const bl = s.blId && S().bls[s.blId]; const v = S().voyages[s.voyageId]; return { ...s, label: R.SERVICE_TYPES[s.type].label, subject: bl ? bl.blNo : `${v.vesselName} ${v.voyageNo}`, requester: orgName(s.requesterOrgId), decider: orgName(s.deciderOrgId), canDecide: s.deciderOrgId === a.orgId && s.status === 'PENDING', containers: bl ? bl.containerIds.map((c) => S().containers[c].no) : [], port: v?.port, berths: v ? R.PORTS[v.port].berths : [] }; })
        .sort((x, y) => (x.status === 'PENDING') - (y.status === 'PENDING') || y.requestedAt - x.requestedAt).reverse();
    },
    declarations(a) {
      return Object.values(S().declarations).filter((d) => canSeeBl(a, S().bls[d.blId])).map((d) => ({ id: d.id, no: d.no, blId: d.blId, blNo: d.blNo, consignee: d.consignee, description: d.description, hsCode: d.hsCode, lane: d.lane, score: sees.risk(a) ? d.risk.score : null, status: d.status, lodgedAt: d.lodgedAt, releasedAt: d.releasedAt || null, preArrival: d.preArrival, total: d.valuation.lines.reduce((x, l) => x + l.amount, 0), declarant: orgName(d.lodgedBy) })).sort((x, y) => y.lodgedAt - x.lodgedAt);
    },
    invoices(a) {
      return Object.values(S().invoices).filter((i) => sees.all(a) || i.payerOrgId === a.orgId || i.beneficiaryOrgId === a.orgId || (i.paymentId && S().payments[i.paymentId].bankOrgId === a.orgId))
        .map((i) => ({ ...i, label: typeLabel(i.type), blNo: S().bls[i.blId].blNo, payer: orgName(i.payerOrgId), beneficiary: orgName(i.beneficiaryOrgId), canPay: i.payerOrgId === a.orgId && i.status === 'UNPAID' })).sort((x, y) => y.issuedAt - x.issuedAt);
    },
    payments(a) {
      return Object.values(S().payments).filter((p) => sees.all(a) || p.payerOrgId === a.orgId || p.bankOrgId === a.orgId || p.invoiceIds.some((i) => S().invoices[i].beneficiaryOrgId === a.orgId))
        .map((p) => ({ ...p, payer: orgName(p.payerOrgId), bank: orgName(p.bankOrgId), invoices: p.invoiceIds.map((i) => S().invoices[i].no), canReconcile: p.bankOrgId === a.orgId && p.status === 'SUCCESS' })).sort((x, y) => y.paidAt - x.paidAt);
    },
    yard(a, p = {}) {
      const terminals = Object.values(S().orgs).filter((o) => o.type === 'TERMINAL' && (sees.all(a) || o.id === a.orgId));
      const tid = p.terminalOrgId || (a.orgType === 'TERMINAL' ? a.orgId : terminals[0]?.id);
      const cons = Object.values(S().containers).filter((c) => c.location && S().voyages[c.voyageId].terminalOrgId === tid);
      const slots = {}; for (const c of cons) slots[c.location] = { no: c.no, size: c.size, status: c.status, blNo: S().bls[c.blId].blNo, blId: c.blId, dwellDays: Math.floor((E.now(Date.now()) - c.dischargedAt) / (24 * HOUR)) };
      return { terminals: terminals.map((t) => ({ id: t.id, name: t.name })), terminalOrgId: tid, layout: R.YARD, slots, inYard: cons.length, capacity: R.YARD.blocks.length * R.YARD.bays * R.YARD.rows * R.YARD.tiers };
    },
    berths(a) {
      return Object.entries(R.PORTS).map(([code, p]) => ({ code, name: p.name, berths: p.berths.map((b) => ({ berth: b, voyages: Object.values(S().voyages).filter((v) => v.berth === b).map((v) => ({ id: v.id, vessel: v.vesselName, voyageNo: v.voyageNo, eta: v.eta, etd: v.etd, ata: v.ata, atd: v.atd, status: v.status, mine: v.shippingOrgId === a.orgId })) })) }));
    },
    notifications(a) {
      const read = new Set(S().reads[a.userId] || []);
      return S().notifications.filter((n) => n.orgId === a.orgId).slice(-200).reverse().map((n) => ({ ...n, read: read.has(n.id) }));
    },
    audit(a, p = {}) {
      let list = S().audit;
      if (!sees.all(a)) { const traces = new Set(visibleBls(a).map((b) => `TRC-${b.blNo}`)); list = list.filter((e) => e.by.orgId === a.orgId || traces.has(e.trace)); }
      if (p.trace) list = list.filter((e) => e.trace === p.trace);
      if (p.q) { const q = p.q.toLowerCase(); list = list.filter((e) => (e.summary + ' ' + e.action + ' ' + (e.by.name || '') + ' ' + (e.by.orgName || '') + ' ' + (e.trace || '')).toLowerCase().includes(q)); }
      if (p.action) list = list.filter((e) => e.action.startsWith(p.action));
      const total = list.length; const limit = Math.min(Number(p.limit) || 100, 500); const offset = Number(p.offset) || 0;
      return { total, entries: list.slice().reverse().slice(offset, offset + limit), head: S().lastHash, scope: sees.all(a) ? 'full' : 'organisation' };
    },
    auditVerify(a) { return E.verifyAudit(); },
    kpis(a) {
      const bls = visibleBls(a); const st = S();
      const closed = bls.filter((b) => b.kpi);
      const decls = bls.map((b) => b.declarationId && st.declarations[b.declarationId]).filter(Boolean);
      const stageCounts = {}; bls.forEach((b) => (stageCounts[b.stage] = (stageCounts[b.stage] || 0) + 1));
      const lanes = { GREEN: 0, YELLOW: 0, RED: 0 }; decls.forEach((d) => lanes[d.lane]++);
      const segs = [['Declared → Customs release', 'declared', 'customsReleased'], ['Customs release → Terminal release', 'customsReleased', 'terminalReleased'], ['Terminal release → Release order', 'terminalReleased', 'releaseOrdered'], ['Release order → All gated out', 'releaseOrdered', 'gateOutAll'], ['Gated out → Delivered', 'gateOutAll', 'delivered']];
      const stageDur = segs.map(([label, f, t]) => ({ label, hours: avg(bls.filter((b) => b.milestones[f] && b.milestones[t]).map((b) => (b.milestones[t] - b.milestones[f]) / HOUR)) }));
      const invs = bls.flatMap((b) => b.invoiceIds.map((i) => st.invoices[i]));
      const revenue = {}; const outstanding = {};
      invs.forEach((i) => { const k = R.ORG_TYPES[st.orgs[i.beneficiaryOrgId].type].short; if (i.status === 'UNPAID') outstanding[k] = (outstanding[k] || 0) + i.total; else revenue[k] = (revenue[k] || 0) + i.total; });
      const svcs = Object.values(st.services).filter((s) => sees.all(a) || s.deciderOrgId === a.orgId || s.requesterOrgId === a.orgId);
      const sla = Object.keys(R.SERVICE_TYPES).map((t) => { const d = svcs.filter((s) => s.type === t && s.decidedAt); return { type: t, label: R.SERVICE_TYPES[t].label, decided: d.length, pending: svcs.filter((s) => s.type === t && s.status === 'PENDING').length, metPct: d.length ? Math.round((d.filter((s) => s.slaMet).length / d.length) * 100) : null, avgHours: avg(d.map((s) => (s.decidedAt - s.requestedAt) / HOUR)), slaHours: R.SERVICE_TYPES[t].slaHours }; });
      const now = E.now(Date.now()); const days = [];
      for (let i = 13; i >= 0; i--) { const d0 = new Date(now - i * 24 * HOUR); d0.setUTCHours(0, 0, 0, 0); const d1 = d0.getTime() + 24 * HOUR; days.push({ day: d0.toISOString().slice(5, 10), gateOut: Object.values(st.containers).filter((c) => c.gateOutAt >= d0.getTime() && c.gateOutAt < d1 && canSeeBl(a, st.bls[c.blId])).length, discharged: Object.values(st.containers).filter((c) => c.dischargedAt >= d0.getTime() && c.dischargedAt < d1 && canSeeBl(a, st.bls[c.blId])).length }); }
      const reuseP = decls.reduce((x, d) => x + d.reuse.prefilled, 0), reuseE = decls.reduce((x, d) => x + d.reuse.entered, 0);
      const docs = { manifests: new Set(bls.map((b) => b.manifestId)).size, declarations: decls.length, permits: bls.reduce((x, b) => x + Object.values(b.permits).filter((p) => p.status === 'APPROVED').length, 0), deliveryOrders: bls.filter((b) => b.deliveryOrder?.status === 'ISSUED').length, invoices: invs.length, gatePasses: bls.reduce((x, b) => x + (b.releaseOrderId ? b.containerIds.length : 0), 0) };
      return {
        scope: sees.all(a) ? 'All port community' : `Shipments visible to ${a.orgName}`,
        totals: { shipments: bls.length, active: bls.length - closed.length, closed: closed.length, teu: bls.reduce((x, b) => x + b.containerIds.reduce((y, c) => y + R.teu(st.containers[c].size), 0), 0) },
        avg: { dwellHours: avg(closed.map((b) => b.kpi.dwellHours)), clearanceHours: avg(decls.filter((d) => d.releasedAt).map((d) => (d.releasedAt - d.lodgedAt) / HOUR)), endToEndHours: avg(closed.map((b) => b.kpi.endToEndHours)), releaseToGateHours: avg(closed.map((b) => b.kpi.releaseToGateHours)) },
        stageCounts, lanes, stageDur, revenue, outstanding, sla, days,
        reusePct: reuseP + reuseE ? Math.round((reuseP / (reuseP + reuseE)) * 100) : null,
        preArrivalPct: decls.length ? Math.round((decls.filter((d) => d.preArrival).length / decls.length) * 100) : null,
        docs, paperlessPct: 100,
        berthCalls: Object.values(st.voyages).filter((v) => v.berth && canSeeVoyage(a, v)).length,
      };
    },
    directory(a) {
      return {
        orgs: Object.values(S().orgs).filter((o) => o.status === 'ACTIVE').map((o) => ({ id: o.id, name: o.name, type: o.type, typeLabel: R.ORG_TYPES[o.type].label, category: o.category, port: o.port, email: o.email })),
        vessels: Object.values(S().vessels), parties: Object.values(S().parties).sort((x, y) => y.uses - x.uses),
        tariff: Object.entries(R.TARIFF).map(([hs, t]) => ({ hs, ...t })), ports: R.PORTS, cpc: R.CPC,
      };
    },
    admin(a) {
      const all = a.orgType === 'NPA' && a.admin;
      const orgs = Object.values(S().orgs).filter((o) => all || o.id === a.orgId);
      return { orgs: orgs.map((o) => ({ ...o, typeLabel: R.ORG_TYPES[o.type].label, users: Object.values(S().users).filter((u) => u.orgId === o.id).map(({ passwordHash, salt, ...u }) => u), apiKey: S().apiKeys[o.id] ? { prefix: S().apiKeys[o.id].prefix, createdAt: S().apiKeys[o.id].createdAt } : null })), roles: R.PERMISSIONS, orgTypes: R.ORG_TYPES, canApprove: all };
    },
    gatePass(a, { token }) {
      const gp = Object.values(S().gatePasses).find((g) => g.token === String(token || '').toUpperCase().trim());
      if (!gp) return null; const bl = S().bls[gp.blId]; if (!canSeeBl(a, bl)) return null;
      return { ...gp, blNo: bl.blNo, consignee: bl.consigneeName, description: bl.description, terminal: orgName(S().voyages[bl.voyageId].terminalOrgId) };
    },
    gateQueue(a) {
      return Object.values(S().gatePasses).filter((g) => g.status === 'ACTIVE' && canSeeBl(a, S().bls[g.blId])).map((g) => ({ ...g, blNo: S().bls[g.blId].blNo, consignee: S().bls[g.blId].consigneeName }));
    },
    integration(a) {
      return { outbox: S().outbox.filter((m) => sees.all(a) || m.orgId === a.orgId).slice(-100).reverse(), apiKey: S().apiKeys[a.orgId] ? { prefix: S().apiKeys[a.orgId].prefix, createdAt: S().apiKeys[a.orgId].createdAt } : null, commands: E.log.length };
    },
    settings(a) { return { settings: S().settings, defaults: R.DEFAULT_SETTINGS, fx: S().fx }; },
  };

  function track(ref) {
    const r = String(ref || '').toUpperCase().trim(); if (!r) return null;
    const c = Object.values(S().containers).find((x) => x.no === r);
    const bl = c ? S().bls[c.blId] : Object.values(S().bls).find((b) => b.blNo === r);
    if (!bl) return null;
    const v = S().voyages[bl.voyageId];
    const LABELS = { manifested: 'Manifested', declared: 'Declared to Customs', discharged: 'Discharged to yard', customsReleased: 'Customs released', doIssued: 'Delivery order issued', terminalReleased: 'Terminal released', releaseOrdered: 'Release order issued', gateOutFirst: 'First container left the port', gateOutAll: 'Left the port', delivered: 'Delivered', settled: 'All payments settled' };
    const m = bl.milestones;
    // Public timeline in the order things actually happened (pending steps last, in process order).
    const timeline = Object.keys(LABELS).filter((k) => !(k === 'gateOutFirst' && m.gateOutFirst === m.gateOutAll)).map((k, i) => ({ key: k, label: LABELS[k], at: m[k] || null, i }))
      .sort((a, b) => (a.at == null) - (b.at == null) || (a.at ?? 0) - (b.at ?? 0) || a.i - b.i).map(({ i, ...e }) => e);
    return { blNo: bl.blNo, vessel: v.vesselName, voyageNo: v.voyageNo, port: R.PORTS[v.port].name, stage: bl.stage, milestones: bl.milestones, timeline, containers: bl.containerIds.map((id) => ({ no: S().containers[id].no, size: S().containers[id].size, status: S().containers[id].status })) };
  }

  return {
    run(actor, name, params) {
      if (name === 'track') return track(params.ref);
      if (!actor) throw Object.assign(new Error('Sign in required'), { code: 'AUTH' });
      const fn = Q[name]; if (!fn) throw Object.assign(new Error(`Unknown query ${name}`), { code: 'UNKNOWN' });
      return fn(actor, params || {});
    },
    canSeeBl,
  };
}
