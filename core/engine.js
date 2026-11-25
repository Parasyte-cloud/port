// PCS core engine: isomorphic (Node + browser), deterministic, command-sourced.
// Every state change is a command; successful commands are appended to a log that can be replayed
// to rebuild state exactly (disaster recovery), and every business action is written to a
// SHA-256 hash-chained audit trail (tamper evidence). All business rules live here so the server,
// the API and the in-browser demo enforce identical behaviour.
import { sha256, hashPassword } from './sha256.js';
import * as R from './reference.js';

export class PcsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const fail = (code, msg, details) => { throw new PcsError(code, msg, details); };
const HOUR = 3600e3, DAY = 24 * HOUR;
const round2 = (n) => Math.round(n * 100) / 100;
const APPEND_ONLY = ['audit', 'notifications', 'outbox'];

function emptyState() {
  return {
    seq: 0, seed: '', lastAt: 0, clockOffset: 0, settings: { ...R.DEFAULT_SETTINGS }, counters: {},
    orgs: {}, users: {}, vessels: {}, voyages: {}, manifests: {}, bls: {}, containers: {},
    declarations: {}, services: {}, invoices: {}, payments: {}, releaseOrders: {}, gatePasses: {},
    fx: null, parties: {}, importerHistory: {}, reads: {}, apiKeys: {}, loginFails: {},
    audit: [], lastHash: 'GENESIS', notifications: [], outbox: [],
  };
}

export function createEngine() {
  let S = emptyState();
  let log = [];
  const listeners = new Set();

  // ---------------------------------------------------------------- helpers
  const nextId = (prefix, pad = 5) => {
    S.counters[prefix] = (S.counters[prefix] || 0) + 1;
    return `${prefix}-${String(S.counters[prefix]).padStart(pad, '0')}`;
  };
  const token = (label, len = 8) => {
    const h = sha256(`${S.seed}|${S.seq}|${label}|${(S.counters.TOK = (S.counters.TOK || 0) + 1)}`);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[parseInt(h.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
    return out;
  };
  const orgOfType = (type) => Object.values(S.orgs).find((o) => o.type === type && o.status === 'ACTIVE');
  const blTrace = (bl) => `TRC-${bl.blNo}`;
  const payerOf = (bl) => bl.forwarderOrgId || bl.consigneeOrgId;
  const voyageOf = (bl) => S.voyages[bl.voyageId];
  const containersOf = (bl) => bl.containerIds.map((id) => S.containers[id]);
  const teuOf = (bl) => containersOf(bl).reduce((a, c) => a + R.teu(c.size), 0);
  const isRegulatorView = (actor) => actor && ['NPA', 'CUSTOMS', 'AUDIT'].includes(actor.orgType);

  function actorFrom(userId) {
    if (!userId) return null;
    if (userId === 'SYSTEM') return { system: true, userId: 'SYSTEM', name: 'PCS rules engine', orgType: 'SYSTEM' };
    const u = S.users[userId]; if (!u) fail('AUTH', 'Unknown user');
    const o = S.orgs[u.orgId];
    return { userId: u.id, name: u.name, orgId: o.id, orgName: o.name, orgType: o.type, admin: u.admin, user: u, org: o };
  }

  function allowed(type, actor) {
    const rules = R.PERMISSIONS[type]; if (!rules) return false;
    for (const r of rules) {
      if (r === '*public') return true;
      if (!actor || actor.system) continue;
      const [t, mod] = r.split(':');
      if ((t === '*' || t === actor.orgType) && (!mod || (mod === 'admin' && actor.admin))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- per-command context
  function makeCtx(cmd, actor) {
    const at = cmd.at;
    const ctx = {
      at, actor, result: {},
      audit(action, entity, summary, opts = {}) {
        const by = opts.system ? { system: true, name: 'PCS rules engine' } : actor
          ? { userId: actor.userId, name: actor.name, orgId: actor.orgId, orgName: actor.orgName, orgType: actor.orgType }
          : { name: String(cmd.type).startsWith('auth.') ? 'Sign-in service' : 'Public registration' };
        const entry = {
          n: S.audit.length + 1, cmdSeq: S.seq, at, by, action, entity, summary,
          trace: opts.trace || null, data: opts.data || null, prev: S.lastHash,
        };
        entry.hash = sha256(JSON.stringify(entry));
        S.lastHash = entry.hash; S.audit.push(entry);
      },
      notify(orgIds, title, body, ref, severity = 'info') {
        for (const orgId of new Set(orgIds.filter(Boolean))) {
          const org = S.orgs[orgId]; if (!org) continue;
          const n = { id: nextId('NTF', 6), at, orgId, title, body, ref: ref || null, severity };
          S.notifications.push(n);
          // Queued here; the hosting layer (worker/deliver.js) hands each message to the e-mail, SMS or webhook
          // provider and records the provider's answer. In the in-browser showcase nothing leaves the browser.
          S.outbox.push({ id: nextId('MSG', 6), at, orgId, channel: 'email', to: org.email, subject: title, body, ntf: n.id, status: 'QUEUED' });
          if (severity !== 'info' && org.phone) S.outbox.push({ id: nextId('MSG', 6), at, orgId, channel: 'sms', to: org.phone, subject: title, body, ntf: n.id, status: 'QUEUED' });
          if (org.webhookUrl) S.outbox.push({ id: nextId('MSG', 6), at, orgId, channel: 'webhook', to: org.webhookUrl, subject: `${ref ? ref.type : 'event'}: ${title}`, body, ntf: n.id, ref: ref || null, status: 'QUEUED' });
        }
      },
    };
    return ctx;
  }

  // ---------------------------------------------------------------- domain helpers (used by handlers)
  function addParty(kind, name, tin) {
    const key = (tin || name).trim().toUpperCase();
    const p = S.parties[key] || (S.parties[key] = { key, name: name.trim(), tin: tin || null, kinds: [], uses: 0 });
    if (!p.kinds.includes(kind)) p.kinds.push(kind);
    p.uses++;
    return p;
  }

  function unsettledOf(bl) {
    const ids = new Set(bl.invoiceIds.map((i) => S.invoices[i]?.paymentId).filter(Boolean));
    return [...ids].map((id) => S.payments[id]).filter((p) => p && p.status !== 'RECONCILED');
  }

  function issueInvoice(ctx, { bl, type, beneficiaryOrgId, payerOrgId, lines, ref }) {
    const total = round2(lines.reduce((a, l) => a + l.amount, 0));
    if (total <= 0) return null;
    const inv = {
      id: nextId('INV'), no: `${type.split('_')[0]}/${new Date(ctx.at).getUTCFullYear()}/${String((S.counters['INVNO-' + type] = (S.counters['INVNO-' + type] || 0) + 1)).padStart(5, '0')}`,
      blId: bl.id, type, beneficiaryOrgId, payerOrgId, lines, total, currency: 'NGN', status: 'UNPAID',
      issuedAt: ctx.at, dueAt: ctx.at + 3 * DAY, ref: ref || null, rrr: token('RRR', 12).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) % 10)),
    };
    S.invoices[inv.id] = inv; bl.invoiceIds.push(inv.id);
    ctx.audit('invoice.issued', { type: 'invoice', id: inv.id }, `${inv.no} issued to ${S.orgs[payerOrgId]?.name} for NGN ${total.toLocaleString('en-US')}`, { trace: blTrace(bl), system: true, data: { type, total } });
    ctx.notify([payerOrgId], `Invoice ${inv.no} issued`, `${typeLabel(type)} for B/L ${bl.blNo}: NGN ${total.toLocaleString('en-US')}. Pay online with RRR ${inv.rrr}.`, { type: 'bl', id: bl.id }, 'action');
    return inv;
  }

  function valuation(decl) {
    const st = S.settings;
    const t = R.TARIFF[decl.hsCode];
    const fob = decl.fobValueUsd;
    const cifUsd = decl.freightUsd != null || decl.insuranceUsd != null
      ? fob + (decl.freightUsd || 0) + (decl.insuranceUsd || 0) : fob * st.cifFactor;
    const cif = cifUsd * st.fxNgnPerUsd, fobNgn = fob * st.fxNgnPerUsd;
    const duty = cif * t.duty, vat = (cif + duty) * st.vatRate, ciss = fobNgn * st.cissRate, etls = cif * st.etlsRate;
    return {
      fxRate: st.fxNgnPerUsd, fxSource: S.fx ? `${S.fx.source}, effective ${S.fx.effectiveFrom} (set by ${S.fx.setByName})` : 'platform default (not an official rate)', cifUsd: round2(cifUsd), cifNgn: round2(cif), dutyRate: t.duty,
      lines: [
        { desc: `Import duty ${(t.duty * 100).toFixed(0)}% (HS ${decl.hsCode})`, qty: 1, rate: round2(duty), amount: round2(duty) },
        { desc: `VAT ${(st.vatRate * 100).toFixed(1)}%`, qty: 1, rate: round2(vat), amount: round2(vat) },
        { desc: `CISS ${(st.cissRate * 100).toFixed(1)}% of FOB`, qty: 1, rate: round2(ciss), amount: round2(ciss) },
        { desc: `ETLS ${(st.etlsRate * 100).toFixed(1)}% of CIF`, qty: 1, rate: round2(etls), amount: round2(etls) },
      ],
    };
  }

  function riskAssess(decl, bl) {
    const st = S.settings, t = R.TARIFF[decl.hsCode];
    const reasons = [];
    const add = (pts, why) => { if (pts) reasons.push({ pts, why }); };
    add(t.risk, `Commodity risk weighting for HS ${decl.hsCode}`);
    const usdPerKg = decl.fobValueUsd / Math.max(1, decl.grossWeightKg);
    if (usdPerKg < t.minUsdPerKg) add(30, `Possible undervaluation: USD ${usdPerKg.toFixed(2)}/kg below reference USD ${t.minUsdPerKg}/kg`);
    const wDiff = Math.abs(decl.grossWeightKg - bl.grossWeightKg) / bl.grossWeightKg;
    if (wDiff > 0.05) add(25, `Declared weight differs from manifest by ${(wDiff * 100).toFixed(1)}%`);
    if (decl.hsCode !== bl.hsCode) add(20, `Declared HS ${decl.hsCode} differs from manifest HS ${bl.hsCode}`);
    const hist = S.importerHistory[bl.consigneeKey] || { clean: 0, discrepancies: 0 };
    if (hist.clean + hist.discrepancies === 0) add(15, 'New importer with no compliance history');
    if (hist.discrepancies > 0) add(20 * hist.discrepancies, `${hist.discrepancies} prior examination discrepancy(ies) for this importer`);
    if (hist.clean >= 3 && hist.discrepancies === 0) add(-10, 'Trusted importer: 3+ clean clearances');
    if (st.highRiskOrigins.includes(decl.originCountry)) add(10, `Origin ${decl.originCountry} on intelligence watch-list`);
    const draw = parseInt(sha256(`${S.seed}|rand|${decl.id}`).slice(0, 4), 16) % 100;
    if (draw < st.randomSelectionPct) add(60, 'Random compliance selection');
    const score = Math.max(0, reasons.reduce((a, r) => a + r.pts, 0));
    const lane = score >= st.riskRedAt ? 'RED' : score >= st.riskYellowAt ? 'YELLOW' : 'GREEN';
    return { score, lane, reasons };
  }

  function customsRelease(ctx, decl, how) {
    const bl = S.bls[decl.blId];
    decl.status = 'RELEASED'; decl.releasedAt = ctx.at; decl.releaseNo = `CR-${token('CR', 6)}`;
    bl.milestones.customsReleased = ctx.at;
    const hist = S.importerHistory[bl.consigneeKey] || (S.importerHistory[bl.consigneeKey] = { clean: 0, discrepancies: 0 });
    if (!decl.discrepancy) hist.clean++;
    ctx.audit('customs.released', { type: 'declaration', id: decl.id }, `Customs release ${decl.releaseNo} for ${decl.no} (${how})`, { trace: blTrace(bl), system: how.startsWith('auto') });
    const v = voyageOf(bl);
    ctx.notify([payerOf(bl), bl.consigneeOrgId, v.terminalOrgId, orgOfType('NPA')?.id], `Customs released B/L ${bl.blNo}`, `Declaration ${decl.no} released (${how}).`, { type: 'bl', id: bl.id }, 'success');
    afterChange(ctx, bl);
  }

  function onInvoicePaid(ctx, inv) {
    const bl = S.bls[inv.blId];
    const decl = bl.declarationId && S.declarations[bl.declarationId];
    if (inv.type === 'CUSTOMS_DUTY' && decl && decl.status === 'ASSESSED') {
      bl.milestones.dutyPaid = ctx.at;
      if (decl.lane === 'GREEN') customsRelease(ctx, decl, 'auto: green lane after duty payment');
      else if (decl.lane === 'YELLOW') {
        decl.status = 'AWAITING_REVIEW';
        ctx.audit('declaration.routed', { type: 'declaration', id: decl.id }, `${decl.no} routed to documentary review (yellow lane)`, { trace: blTrace(bl), system: true });
        ctx.notify([orgOfType('CUSTOMS')?.id], `Documentary review: ${decl.no}`, `Yellow-lane declaration for B/L ${bl.blNo} is ready for review.`, { type: 'bl', id: bl.id }, 'action');
      } else {
        decl.status = 'AWAITING_EXAM';
        openService(ctx, { type: 'EXAM_POSITION', bl, deciderOrgId: voyageOf(bl).terminalOrgId, requesterOrgId: orgOfType('CUSTOMS')?.id, details: { declarationId: decl.id, note: 'Position all containers at the examination bay' }, system: true });
        ctx.notify([orgOfType('CUSTOMS')?.id, payerOf(bl)], `Physical examination required: ${decl.no}`, `Red-lane declaration for B/L ${bl.blNo}. Containers are being positioned for joint examination.`, { type: 'bl', id: bl.id }, 'warning');
      }
    }
    if (inv.type === 'CUSTOMS_SUPP' && decl && decl.status === 'AWAITING_SUPP_PAYMENT') customsRelease(ctx, decl, 'after supplementary payment');
    if (inv.type === 'SHIPPING_DO' && bl.deliveryOrder && bl.deliveryOrder.status === 'AWAITING_PAYMENT') {
      bl.deliveryOrder.status = 'ISSUED'; bl.deliveryOrder.no = `DO-${token('DO', 6)}`; bl.deliveryOrder.issuedAt = ctx.at;
      bl.milestones.doIssued = ctx.at;
      ctx.audit('do.issued', { type: 'bl', id: bl.id }, `Delivery order ${bl.deliveryOrder.no} issued for B/L ${bl.blNo}`, { trace: blTrace(bl), system: true });
      ctx.notify([payerOf(bl), voyageOf(bl).terminalOrgId], `Delivery order issued for ${bl.blNo}`, `Electronic DO ${bl.deliveryOrder.no} is now valid.`, { type: 'bl', id: bl.id }, 'success');
    }
    afterChange(ctx, bl);
  }

  function openService(ctx, { type, bl, voyage, deciderOrgId, requesterOrgId, details, system }) {
    const def = R.SERVICE_TYPES[type];
    const sr = {
      id: nextId('SR'), type, blId: bl ? bl.id : null, voyageId: voyage ? voyage.id : bl ? bl.voyageId : null,
      requesterOrgId, deciderOrgId, details: details || {}, status: 'PENDING', requestedAt: ctx.at,
      slaDueAt: ctx.at + def.slaHours * HOUR, decidedAt: null, decision: null,
    };
    S.services[sr.id] = sr;
    if (bl) bl.serviceIds.push(sr.id);
    const subject = bl ? `B/L ${bl.blNo}` : voyage ? `voyage ${voyage.voyageNo}` : '';
    ctx.audit('service.requested', { type: 'service', id: sr.id }, `${def.label} requested for ${subject} (${sr.id})`, { trace: bl ? blTrace(bl) : voyage ? `TRC-${voyage.voyageNo}` : null, system });
    ctx.notify([deciderOrgId], `New request: ${def.label}`, `${sr.id} for ${subject}. SLA ${def.slaHours}h.`, { type: 'service', id: sr.id }, 'action');
    return sr;
  }

  // Ground slots first, spread across blocks and bays; stacking only when the ground tier is full.
  function freeSlots() {
    const used = new Set(Object.values(S.containers).filter((c) => c.location && c.status !== 'GATED_OUT').flatMap((c) => [c.location, c.homeSlot]).filter(Boolean));
    const out = [];
    for (let tier = 1; tier <= R.YARD.tiers; tier++) for (let bay = 1; bay <= R.YARD.bays; bay++) for (let row = 1; row <= R.YARD.rows; row++) for (const b of R.YARD.blocks) {
      const k = `${b}${String(bay).padStart(2, '0')}-${row}-${tier}`;
      if (!used.has(k) && (tier === 1 || used.has(`${b}${String(bay).padStart(2, '0')}-${row}-${tier - 1}`))) out.push(k);
    }
    return out;
  }

  function storageCharge(bl, untilAt) {
    const st = S.settings;
    let lines = [];
    for (const c of containersOf(bl)) {
      if (!c.dischargedAt) continue;
      if (c.storagePaidThrough && c.storagePaidThrough >= untilAt - S.settings.gatePassValidHours * HOUR) continue; // already billed through the current release window
      const days = Math.ceil((untilAt - c.dischargedAt) / DAY);
      const chargeable = Math.max(0, days - st.storageFreeDays) - (c.storageBilledDays || 0);
      if (chargeable > 0) lines.push({ desc: `Storage ${c.no} (${c.size}ft) ${chargeable} day(s) beyond ${st.storageFreeDays} free`, qty: chargeable * R.teu(c.size), rate: st.storagePerTeuDay, amount: chargeable * R.teu(c.size) * st.storagePerTeuDay, containerId: c.id, days: chargeable });
    }
    return lines;
  }

  function checklist(bl) {
    const decl = bl.declarationId && S.declarations[bl.declarationId];
    const invs = bl.invoiceIds.map((i) => S.invoices[i]);
    const unpaid = invs.filter((i) => i.status === 'UNPAID');
    const cons = containersOf(bl);
    const permitsMissing = bl.permitsRequired.filter((cat) => !(bl.permits[cat] && bl.permits[cat].status === 'APPROVED'));
    const items = [
      { key: 'manifest', label: 'Manifest and B/L filed by shipping line', ok: true, owner: 'SHIPPING' },
      { key: 'discharged', label: 'All containers discharged to yard', ok: cons.every((c) => c.dischargedAt), owner: 'TERMINAL', detail: `${cons.filter((c) => c.dischargedAt).length}/${cons.length} discharged` },
      { key: 'customs', label: 'Customs release', ok: !!(decl && decl.status === 'RELEASED'), owner: 'CUSTOMS', detail: decl ? `${decl.no}: ${decl.status.replace(/_/g, ' ').toLowerCase()}` : 'No declaration lodged' },
      { key: 'permits', label: 'Agency permits', ok: permitsMissing.length === 0, owner: 'OGA', detail: bl.permitsRequired.length ? (permitsMissing.length ? `Missing: ${permitsMissing.join(', ')}` : 'All approved') : decl ? 'None required' : 'Determined at declaration' , na: decl && bl.permitsRequired.length === 0 },
      { key: 'do', label: 'Delivery order issued', ok: !!(bl.deliveryOrder && bl.deliveryOrder.status === 'ISSUED'), owner: 'SHIPPING', detail: bl.deliveryOrder ? bl.deliveryOrder.status.replace(/_/g, ' ').toLowerCase() : 'Not requested' },
      { key: 'paid', label: 'All charges paid', ok: invs.length > 0 && unpaid.length === 0, owner: 'FORWARDER', detail: unpaid.length ? `${unpaid.length} unpaid (NGN ${round2(unpaid.reduce((a, i) => a + i.total, 0)).toLocaleString('en-US')})` : `${invs.length} paid` },
      { key: 'terminal', label: 'Terminal release', ok: !!bl.milestones.terminalReleased, owner: 'TERMINAL' },
    ];
    if (!decl) items[3].ok = false;
    return { items, ready: items.every((i) => i.ok), released: !!bl.milestones.releaseOrdered };
  }

  function stageOf(bl) {
    const m = bl.milestones;
    if (m.closed) return 'CLOSED';
    if (m.delivered) return 'DELIVERED';
    if (m.gateOutAll) return 'IN_TRANSIT';
    if (m.gateOutFirst) return 'PARTLY_GATED_OUT';
    if (m.releaseOrdered) return 'RELEASED';
    if (m.terminalReleased) return 'TERMINAL_RELEASED';
    if (m.customsReleased) return 'CUSTOMS_RELEASED';
    const decl = bl.declarationId && S.declarations[bl.declarationId];
    if (decl) return decl.status === 'QUERIED' ? 'CUSTOMS_QUERY' : decl.status === 'AWAITING_EXAM' ? 'UNDER_EXAMINATION' : decl.status === 'AWAITING_REVIEW' ? 'UNDER_REVIEW' : 'DECLARED';
    if (m.discharged) return 'IN_YARD';
    return 'MANIFESTED';
  }

  function afterChange(ctx, bl) {
    bl.stage = stageOf(bl);
    if (S.settings.autoReleaseOrder && !bl.milestones.releaseOrdered && checklist(bl).ready) issueRelease(ctx, bl, 'auto: all checks passed', true);
  }

  function issueRelease(ctx, bl, note, system) {
    const ro = { id: nextId('RO'), no: `RO-${token('RO', 8)}`, blId: bl.id, at: ctx.at, note: note || '', byOrgId: orgOfType('NPA')?.id };
    S.releaseOrders[ro.id] = ro; bl.releaseOrderId = ro.id; bl.milestones.releaseOrdered = ctx.at;
    for (const c of containersOf(bl)) {
      const gp = { id: nextId('GP'), token: `${token('GP', 4)}-${token('GP', 4)}`, blId: bl.id, containerId: c.id, containerNo: c.no, status: 'ACTIVE', issuedAt: ctx.at, expiresAt: ctx.at + S.settings.gatePassValidHours * HOUR, truck: null };
      const asg = (bl.trucks || []).find((t) => t.containerNo === c.no);
      if (asg) gp.truck = asg;
      S.gatePasses[gp.id] = gp; c.gatePassId = gp.id; c.status = 'RELEASED';
    }
    ctx.audit('release.ordered', { type: 'release', id: ro.id }, `Release order ${ro.no} issued for B/L ${bl.blNo}; ${bl.containerIds.length} gate pass(es) generated`, { trace: blTrace(bl), system });
    const v = voyageOf(bl);
    const transporters = bl.serviceIds.map((s) => S.services[s]).filter((s) => s.type === 'TRUCK_BOOKING' && s.status === 'APPROVED').map((s) => s.deciderOrgId);
    ctx.notify([payerOf(bl), bl.consigneeOrgId, v.terminalOrgId, v.shippingOrgId, ...transporters], `Cargo released: ${bl.blNo}`, `Release order ${ro.no}. Electronic gate passes are active for ${S.settings.gatePassValidHours}h.`, { type: 'bl', id: bl.id }, 'success');
    bl.stage = stageOf(bl);
    return ro;
  }

  function assertBlAccess(actor, bl, roles) {
    if (!bl) fail('NOT_FOUND', 'Bill of lading not found');
    if (roles && !roles(actor, bl)) fail('FORBIDDEN', 'Your organisation is not a party to this shipment');
  }
  const isCargoInterest = (actor, bl) => actor.orgId === bl.forwarderOrgId || actor.orgId === bl.consigneeOrgId;

  function parseTime(v, label) {
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(t)) fail('VALIDATION', `${label} is not a valid date/time`);
    return t;
  }
  const req = (obj, keys) => { const miss = keys.filter((k) => obj[k] == null || obj[k] === ''); if (miss.length) fail('VALIDATION', `Missing required field(s): ${miss.join(', ')}`, { fields: miss }); };

  // ---------------------------------------------------------------- command handlers
  const H = {
    'system.init'(ctx, p) {
      if (S.seq !== 1) fail('STATE', 'System already initialised');
      S.seed = p.seed; Object.assign(S.settings, p.settings || {});
      ctx.audit('system.init', { type: 'system', id: 'PCS' }, 'Platform initialised; audit chain genesis');
    },

    'org.register'(ctx, p) {
      req(p, ['name', 'type', 'email', 'tin', 'rcNumber']); req(p.admin || {}, ['name', 'email']); // credentials are optional: the hosted server keeps them outside the ledger
      if (!R.ORG_TYPES[p.type]) fail('VALIDATION', 'Unknown organisation type');
      const byNpa = ctx.actor && ctx.actor.orgType === 'NPA' && ctx.actor.admin;
      if (R.ORG_TYPES[p.type].regulator && !byNpa && Object.keys(S.orgs).length > 0) fail('FORBIDDEN', 'Government agencies are onboarded by the Port Authority administrator');
      if (!/^\d{8}-?\d{4}$/.test(p.tin)) fail('VALIDATION', 'TIN must be 12 digits (format 12345678-0001)');
      if (!/^(RC|BN|IT)?\s?\d{4,8}$/i.test(p.rcNumber)) fail('VALIDATION', 'CAC registration number looks invalid (e.g. RC 123456)');
      const norm = (s) => s.trim().toLowerCase();
      if (Object.values(S.orgs).some((o) => norm(o.name) === norm(p.name))) fail('DUPLICATE', 'An organisation with this name is already registered');
      if (Object.values(S.orgs).some((o) => o.tin.replace('-', '') === p.tin.replace('-', ''))) fail('DUPLICATE', 'This TIN is already registered');
      if (Object.values(S.users).some((u) => norm(u.email) === norm(p.admin.email))) fail('DUPLICATE', 'A user with this email already exists');
      if (p.type === 'OGA' && !p.category) fail('VALIDATION', 'Agency category required (FOOD, STANDARDS, HEALTH)');
      const first = Object.keys(S.orgs).length === 0;
      const org = {
        id: nextId('ORG', 4), name: p.name.trim(), type: p.type, email: p.email, phone: p.phone || '', address: p.address || '',
        tin: p.tin, rcNumber: p.rcNumber.toUpperCase(), category: p.category || null, port: p.port || null,
        status: first || byNpa ? 'ACTIVE' : 'PENDING', registeredAt: ctx.at, approvedAt: first || byNpa ? ctx.at : null, webhookUrl: p.webhookUrl || null,
      };
      S.orgs[org.id] = org;
      const user = { id: nextId('USR', 4), orgId: org.id, name: p.admin.name, email: p.admin.email.trim().toLowerCase(), title: p.admin.title || 'Administrator', admin: true, active: true, ...(p.admin.passwordHash ? { passwordHash: p.admin.passwordHash, salt: p.admin.salt } : {}), createdAt: ctx.at };
      S.users[user.id] = user;
      ctx.audit('org.registered', { type: 'org', id: org.id }, `${org.name} (${R.ORG_TYPES[org.type].label}) registered${org.status === 'PENDING' ? ', awaiting approval' : ''}`);
      if (org.status === 'PENDING') ctx.notify([orgOfType('NPA')?.id], `Registration pending: ${org.name}`, `${R.ORG_TYPES[org.type].label} applied for access. Verify CAC ${org.rcNumber} and TIN ${org.tin}.`, { type: 'org', id: org.id }, 'action');
      ctx.result = { orgId: org.id, userId: user.id, status: org.status };
    },

    'org.approve'(ctx, p) {
      const org = S.orgs[p.orgId]; if (!org) fail('NOT_FOUND', 'Organisation not found');
      if (org.status !== 'PENDING') fail('STATE', `Organisation is ${org.status}`);
      if (p.decision === 'reject' && !p.note) fail('VALIDATION', 'A reason is required to reject');
      org.status = p.decision === 'reject' ? 'REJECTED' : 'ACTIVE'; org.approvedAt = ctx.at; org.decisionNote = p.note || '';
      ctx.audit(`org.${org.status === 'ACTIVE' ? 'approved' : 'rejected'}`, { type: 'org', id: org.id }, `${org.name} ${org.status === 'ACTIVE' ? 'approved' : 'rejected'}${p.note ? ': ' + p.note : ''}`);
      ctx.notify([org.id], `Registration ${org.status === 'ACTIVE' ? 'approved' : 'rejected'}`, org.status === 'ACTIVE' ? 'Your organisation can now use the Port Community System.' : `Reason: ${p.note}`, { type: 'org', id: org.id }, org.status === 'ACTIVE' ? 'success' : 'warning');
    },

    'org.suspend'(ctx, p) {
      const org = S.orgs[p.orgId]; if (!org) fail('NOT_FOUND', 'Organisation not found');
      if (org.type === 'NPA') fail('FORBIDDEN', 'The Port Authority cannot be suspended');
      req(p, ['reason']);
      org.status = p.suspended ? 'SUSPENDED' : 'ACTIVE';
      ctx.audit(p.suspended ? 'org.suspended' : 'org.reinstated', { type: 'org', id: org.id }, `${org.name} ${p.suspended ? 'suspended' : 'reinstated'}: ${p.reason}`);
      ctx.notify([org.id], `Access ${p.suspended ? 'suspended' : 'reinstated'}`, p.reason, { type: 'org', id: org.id }, 'warning');
    },

    'org.apikey.rotate'(ctx, p) {
      req(p, ['keyHash', 'keyPrefix']);
      S.apiKeys[ctx.actor.orgId] = { keyHash: p.keyHash, prefix: p.keyPrefix, createdAt: ctx.at, createdBy: ctx.actor.userId };
      ctx.audit('apikey.rotated', { type: 'org', id: ctx.actor.orgId }, `API key rotated (prefix ${p.keyPrefix}…)`);
    },

    'user.create'(ctx, p) {
      req(p, ['name', 'email']);
      const email = p.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('VALIDATION', 'Invalid email');
      if (Object.values(S.users).some((u) => u.email === email)) fail('DUPLICATE', 'A user with this email already exists');
      const user = { id: nextId('USR', 4), orgId: ctx.actor.orgId, name: p.name, email, title: p.title || 'Officer', admin: !!p.admin, active: true, ...(p.passwordHash ? { passwordHash: p.passwordHash, salt: p.salt } : {}), createdAt: ctx.at };
      S.users[user.id] = user;
      ctx.audit('user.created', { type: 'user', id: user.id }, `User ${user.name} <${email}> added${user.admin ? ' as administrator' : ''}`);
      ctx.result = { userId: user.id };
    },

    'user.setActive'(ctx, p) {
      const u = S.users[p.userId]; if (!u || u.orgId !== ctx.actor.orgId) fail('NOT_FOUND', 'User not found in your organisation');
      if (u.id === ctx.actor.userId) fail('STATE', 'You cannot deactivate yourself');
      u.active = !!p.active;
      ctx.audit(u.active ? 'user.activated' : 'user.deactivated', { type: 'user', id: u.id }, `User ${u.name} ${u.active ? 'activated' : 'deactivated'}`);
    },

    'auth.login'(ctx, p) {
      const u = S.users[p.userId]; if (!u) fail('NOT_FOUND', 'User not found');
      delete S.loginFails[u.email];
      u.lastLoginAt = ctx.at;
      ctx.audit('auth.login', { type: 'user', id: u.id }, `${u.name} signed in${p.channel ? ' via ' + p.channel : ''}`);
    },
    'auth.failed'(ctx, p) {
      const email = String(p.email || '').toLowerCase();
      const f = S.loginFails[email] || (S.loginFails[email] = { count: 0, lockedUntil: 0 });
      f.count++; if (f.count >= 5) { f.lockedUntil = ctx.at + 15 * 60e3; f.count = 0; }
      ctx.audit('auth.failed', { type: 'user', id: email }, `Failed sign-in for ${email}${f.lockedUntil > ctx.at ? ' (account locked 15 min)' : ''}`);
    },
    // Security events from the hosted server's sign-in service (password set/reset, 2FA, invites, sessions).
    // Written to the same hash-chained audit trail; only the server may issue these (never a client).
    'auth.event'(ctx, p) {
      req(p, ['event', 'subject']);
      if (!/^[a-z][a-z0-9_.]{1,40}$/.test(p.event)) fail('VALIDATION', 'Bad auth event name');
      const u = S.users[p.subject];
      ctx.audit(`auth.${p.event}`, { type: 'user', id: p.subject }, `${u ? u.name : p.subject}: ${String(p.summary || p.event).slice(0, 200)}`);
    },

    'vessel.register'(ctx, p) {
      req(p, ['imo', 'name']);
      const imo = String(p.imo).replace(/\D/g, '');
      if (!validImo(imo)) fail('VALIDATION', `IMO number ${p.imo} fails the check digit`);
      if (S.vessels[imo]) fail('DUPLICATE', 'Vessel already in the common registry');
      S.vessels[imo] = { imo, name: p.name.toUpperCase(), flag: p.flag || '', type: p.vesselType || 'Container ship', grt: Number(p.grt) || null, loa: Number(p.loa) || null, addedBy: ctx.actor.orgId, addedAt: ctx.at };
      ctx.audit('vessel.registered', { type: 'vessel', id: imo }, `Vessel ${p.name.toUpperCase()} (IMO ${imo}) added to the common registry`);
      ctx.result = { imo };
    },

    'voyage.create'(ctx, p) {
      req(p, ['imo', 'voyageNo', 'port', 'terminalOrgId', 'eta', 'etd']);
      const vessel = S.vessels[String(p.imo)]; if (!vessel) fail('VALIDATION', 'Vessel not in registry; register it first');
      if (!R.PORTS[p.port]) fail('VALIDATION', 'Unknown port');
      const term = S.orgs[p.terminalOrgId]; if (!term || term.type !== 'TERMINAL' || term.status !== 'ACTIVE') fail('VALIDATION', 'Select an active terminal operator');
      if (term.port && term.port !== p.port) fail('VALIDATION', `${term.name} operates at ${R.PORTS[term.port].name}`);
      const eta = parseTime(p.eta, 'ETA'), etd = parseTime(p.etd, 'ETD');
      if (etd <= eta) fail('VALIDATION', 'ETD must be after ETA');
      if (Object.values(S.voyages).some((v) => v.voyageNo === p.voyageNo && v.imo === vessel.imo)) fail('DUPLICATE', 'Voyage already exists for this vessel');
      const v = { id: nextId('VOY'), imo: vessel.imo, vesselName: vessel.name, voyageNo: p.voyageNo, port: p.port, terminalOrgId: term.id, shippingOrgId: ctx.actor.orgId, eta, etd, lastPort: p.lastPort || '', nextPort: p.nextPort || '', status: 'PLANNED', berth: null, ata: null, atd: null, createdAt: ctx.at, manifestIds: [] };
      S.voyages[v.id] = v;
      ctx.audit('voyage.created', { type: 'voyage', id: v.id }, `Vessel call ${vessel.name} voy. ${v.voyageNo} notified for ${R.PORTS[v.port].name}, ETA ${new Date(eta).toISOString().slice(0, 16).replace('T', ' ')}`, { trace: `TRC-${v.voyageNo}` });
      ctx.notify([term.id, orgOfType('NPA')?.id], `Vessel call notified: ${vessel.name}`, `Voyage ${v.voyageNo} ETA ${new Date(eta).toUTCString()}.`, { type: 'voyage', id: v.id });
      if (p.requestBerth !== false) openService(ctx, { type: 'BERTH', voyage: v, deciderOrgId: orgOfType('NPA')?.id, requesterOrgId: ctx.actor.orgId, details: { preferredBerth: p.preferredBerth || null, eta, etd } });
      ctx.result = { voyageId: v.id };
    },

    'voyage.arrive'(ctx, p) {
      const v = S.voyages[p.voyageId]; if (!v) fail('NOT_FOUND', 'Voyage not found');
      if (v.status !== 'BERTH_ALLOCATED') fail('STATE', v.status === 'PLANNED' ? 'Allocate a berth before recording arrival' : `Voyage is ${v.status}`);
      v.status = 'ARRIVED'; v.ata = ctx.at;
      ctx.audit('voyage.arrived', { type: 'voyage', id: v.id }, `${v.vesselName} voy. ${v.voyageNo} arrived and berthed at ${v.berth}`, { trace: `TRC-${v.voyageNo}` });
      const blOrgs = Object.values(S.bls).filter((b) => b.voyageId === v.id).flatMap((b) => [b.forwarderOrgId, b.consigneeOrgId]);
      ctx.notify([v.shippingOrgId, v.terminalOrgId, orgOfType('CUSTOMS')?.id, ...blOrgs], `Vessel arrived: ${v.vesselName}`, `Berthed at ${v.berth}. Discharge can begin.`, { type: 'voyage', id: v.id }, 'success');
    },

    'voyage.depart'(ctx, p) {
      const v = S.voyages[p.voyageId]; if (!v) fail('NOT_FOUND', 'Voyage not found');
      if (v.status !== 'ARRIVED') fail('STATE', 'Only an arrived vessel can depart');
      const pending = Object.values(S.containers).filter((c) => c.voyageId === v.id && !c.dischargedAt);
      if (pending.length && !p.force) fail('STATE', `${pending.length} manifested container(s) not yet discharged`);
      v.status = 'DEPARTED'; v.atd = ctx.at;
      ctx.audit('voyage.departed', { type: 'voyage', id: v.id }, `${v.vesselName} departed; berth ${v.berth} freed`, { trace: `TRC-${v.voyageNo}` });
      ctx.notify([v.shippingOrgId, v.terminalOrgId], `Vessel departed: ${v.vesselName}`, `Berth ${v.berth} is free.`, { type: 'voyage', id: v.id });
    },

    'manifest.submit'(ctx, p) {
      const v = S.voyages[p.voyageId]; if (!v) fail('NOT_FOUND', 'Voyage not found');
      if (v.shippingOrgId !== ctx.actor.orgId) fail('FORBIDDEN', 'Only the carrier of this voyage can file its manifest');
      if (v.status === 'DEPARTED') fail('STATE', 'Voyage has departed');
      const lines = Array.isArray(p.bls) ? p.bls : [];
      if (!lines.length) fail('VALIDATION', 'Manifest has no bills of lading');
      const errors = []; const seenBl = new Set(), seenCtr = new Set();
      const activeCtr = new Set(Object.values(S.containers).filter((c) => !['GATED_OUT'].includes(c.status)).map((c) => c.no));
      lines.forEach((b, i) => {
        const at = `Line ${i + 1}${b.blNo ? ` (${b.blNo})` : ''}`;
        for (const k of ['blNo', 'shipper', 'description', 'hsCode', 'grossWeightKg', 'packages']) if (b[k] == null || b[k] === '') errors.push(`${at}: ${k} is required`);
        if (!b.consignee || (!b.consignee.orgId && !b.consignee.name)) errors.push(`${at}: consignee is required`);
        if (b.blNo && (seenBl.has(b.blNo) || Object.values(S.bls).some((x) => x.blNo === b.blNo))) errors.push(`${at}: duplicate B/L number`);
        seenBl.add(b.blNo);
        if (b.hsCode && !R.TARIFF[String(b.hsCode).slice(0, 4)]) errors.push(`${at}: HS ${b.hsCode} not in tariff`);
        if (!(Number(b.grossWeightKg) > 0)) errors.push(`${at}: gross weight must be positive`);
        if (b.forwarderOrgId && S.orgs[b.forwarderOrgId]?.type !== 'FORWARDER') errors.push(`${at}: nominated forwarder is not a registered forwarder`);
        if (b.consignee?.orgId && S.orgs[b.consignee.orgId]?.type !== 'IMPORTER') errors.push(`${at}: consignee must be a registered cargo owner`);
        const cs = b.containers || [];
        if (!cs.length) errors.push(`${at}: at least one container is required`);
        let sumW = 0;
        cs.forEach((c) => {
          const no = String(c.no || '').toUpperCase().replace(/\s/g, '');
          if (!R.validContainerNo(no)) errors.push(`${at}: container ${c.no} fails ISO 6346 check digit`);
          if (seenCtr.has(no) || activeCtr.has(no)) errors.push(`${at}: container ${no} already active in the port`);
          if (!['20', '40', '45'].includes(String(c.size))) errors.push(`${at}: container ${no} size must be 20, 40 or 45`);
          seenCtr.add(no); sumW += Number(c.weightKg) || 0;
        });
        if (sumW && Math.abs(sumW - Number(b.grossWeightKg)) / Number(b.grossWeightKg) > 0.1) errors.push(`${at}: container weights (${sumW} kg) differ from B/L gross weight by more than 10%`);
      });
      if (errors.length) fail('VALIDATION', `Manifest rejected: ${errors.length} error(s)`, { errors });
      const man = { id: nextId('MAN'), no: `MFT/${v.voyageNo}/${(v.manifestIds.length + 1)}`, voyageId: v.id, submittedBy: ctx.actor.orgId, submittedAt: ctx.at, source: p.source || 'form', blIds: [], amendments: [] };
      S.manifests[man.id] = man; v.manifestIds.push(man.id);
      let reused = 0;
      const notifyOrgs = new Set();
      for (const b of lines) {
        const consOrg = b.consignee.orgId ? S.orgs[b.consignee.orgId] : Object.values(S.orgs).find((o) => o.type === 'IMPORTER' && b.consignee.tin && o.tin.replace('-', '') === String(b.consignee.tin).replace('-', ''));
        if (consOrg) reused++;
        const consName = consOrg ? consOrg.name : b.consignee.name;
        const consTin = consOrg ? consOrg.tin : b.consignee.tin || null;
        addParty('shipper', b.shipper, null); addParty('consignee', consName, consTin);
        const bl = {
          id: nextId('BL'), blNo: b.blNo, manifestId: man.id, voyageId: v.id, shipper: b.shipper, consigneeName: consName, consigneeTin: consTin,
          consigneeOrgId: consOrg ? consOrg.id : null, consigneeKey: (consTin || consName).toUpperCase(), notifyParty: b.notifyParty || consName,
          forwarderOrgId: b.forwarderOrgId || null, portOfLoading: b.portOfLoading || '', description: b.description, hsCode: String(b.hsCode).slice(0, 4),
          packages: Number(b.packages), packageType: b.packageType || 'PKG', grossWeightKg: Number(b.grossWeightKg), containerIds: [],
          milestones: { manifested: ctx.at }, invoiceIds: [], serviceIds: [], permitsRequired: [], permits: {}, declarationId: null, deliveryOrder: null,
          trucks: [], releaseOrderId: null, stage: 'MANIFESTED', createdAt: ctx.at,
        };
        S.bls[bl.id] = bl; man.blIds.push(bl.id);
        for (const c of b.containers) {
          const no = String(c.no).toUpperCase().replace(/\s/g, '');
          const ctr = { id: nextId('CTR', 6), no, size: String(c.size), type: c.type || 'GP', sealNo: c.sealNo || '', weightKg: Number(c.weightKg) || null, blId: bl.id, voyageId: v.id, status: v.status === 'ARRIVED' ? 'ON_VESSEL' : 'EXPECTED', location: null, dischargedAt: null, gatePassId: null, moves: [] };
          S.containers[ctr.id] = ctr; bl.containerIds.push(ctr.id);
        }
        ctx.audit('bl.manifested', { type: 'bl', id: bl.id }, `B/L ${bl.blNo} filed on ${man.no}: ${bl.containerIds.length} container(s), ${bl.description}`, { trace: blTrace(bl) });
        [bl.forwarderOrgId, bl.consigneeOrgId].forEach((o) => o && notifyOrgs.add(o));
        if (bl.forwarderOrgId || bl.consigneeOrgId) ctx.notify([bl.forwarderOrgId, bl.consigneeOrgId], `Cargo manifested: ${bl.blNo}`, `${bl.description} on ${v.vesselName} voy. ${v.voyageNo}, ETA ${new Date(v.eta).toUTCString()}. You can lodge the declaration before arrival.`, { type: 'bl', id: bl.id });
      }
      ctx.audit('manifest.submitted', { type: 'manifest', id: man.id }, `Manifest ${man.no} submitted (${lines.length} B/L, source: ${man.source}); ${reused} consignee(s) matched from the common repository`, { trace: `TRC-${v.voyageNo}` });
      ctx.notify([v.terminalOrgId, orgOfType('CUSTOMS')?.id, orgOfType('NPA')?.id], `Manifest received: ${man.no}`, `${lines.length} B/L for ${v.vesselName} voy. ${v.voyageNo}.`, { type: 'voyage', id: v.id });
      ctx.result = { manifestId: man.id, blIds: man.blIds };
    },

    'manifest.amend'(ctx, p) {
      const bl = S.bls[p.blId]; assertBlAccess(ctx.actor, bl, (a, b) => voyageOf(b).shippingOrgId === a.orgId);
      if (bl.declarationId) fail('STATE', 'B/L is already declared to Customs; amendments must go through Customs');
      req(p, ['reason']);
      const allowedKeys = ['forwarderOrgId', 'description', 'grossWeightKg', 'packages', 'notifyParty', 'consigneeOrgId'];
      const diff = {};
      for (const k of allowedKeys) if (p.changes && p.changes[k] !== undefined && p.changes[k] !== bl[k]) {
        if (k === 'forwarderOrgId' && p.changes[k] && S.orgs[p.changes[k]]?.type !== 'FORWARDER') fail('VALIDATION', 'Not a registered forwarder');
        if (k === 'consigneeOrgId') { const o = S.orgs[p.changes[k]]; if (!o || o.type !== 'IMPORTER') fail('VALIDATION', 'Not a registered cargo owner'); bl.consigneeName = o.name; bl.consigneeTin = o.tin; bl.consigneeKey = o.tin.toUpperCase(); }
        diff[k] = { from: bl[k], to: p.changes[k] }; bl[k] = k === 'grossWeightKg' || k === 'packages' ? Number(p.changes[k]) : p.changes[k];
      }
      if (!Object.keys(diff).length) fail('VALIDATION', 'No changes');
      S.manifests[bl.manifestId].amendments.push({ at: ctx.at, blId: bl.id, diff, reason: p.reason });
      ctx.audit('bl.amended', { type: 'bl', id: bl.id }, `B/L ${bl.blNo} amended (${Object.keys(diff).join(', ')}): ${p.reason}`, { trace: blTrace(bl), data: diff });
      ctx.notify([bl.forwarderOrgId, bl.consigneeOrgId, orgOfType('CUSTOMS')?.id, diff.forwarderOrgId?.from], `B/L amended: ${bl.blNo}`, p.reason, { type: 'bl', id: bl.id });
    },

    'service.request'(ctx, p) {
      const def = R.SERVICE_TYPES[p.type]; if (!def) fail('VALIDATION', 'Unknown service type');
      if (!def.requester.includes(ctx.actor.orgType)) fail('FORBIDDEN', `${R.ORG_TYPES[ctx.actor.orgType].label} cannot request ${def.label}`);
      if (p.type === 'BERTH') {
        const v = S.voyages[p.voyageId]; if (!v || v.shippingOrgId !== ctx.actor.orgId) fail('NOT_FOUND', 'Voyage not found');
        if (v.status !== 'PLANNED') fail('STATE', 'Berth already allocated');
        if (Object.values(S.services).some((s) => s.type === 'BERTH' && s.voyageId === v.id && s.status === 'PENDING')) fail('DUPLICATE', 'A berth request is already pending');
        const sr = openService(ctx, { type: 'BERTH', voyage: v, deciderOrgId: orgOfType('NPA')?.id, requesterOrgId: ctx.actor.orgId, details: { preferredBerth: p.preferredBerth || null, eta: v.eta, etd: v.etd } });
        ctx.result = { serviceId: sr.id }; return;
      }
      const bl = S.bls[p.blId]; assertBlAccess(ctx.actor, bl, isCargoInterest);
      if (bl.milestones.closed) fail('STATE', 'Shipment is closed');
      let decider, details = { note: p.note || '' };
      if (p.type === 'PERMIT') {
        const org = S.orgs[p.toOrgId]; if (!org || org.type !== 'OGA' || org.status !== 'ACTIVE') fail('VALIDATION', 'Select an active government agency');
        if (bl.permitsRequired.length && !bl.permitsRequired.includes(org.category)) fail('VALIDATION', `This cargo does not need a ${org.category} permit (needs: ${bl.permitsRequired.join(', ')})`);
        if (bl.permits[org.category]?.status === 'APPROVED') fail('DUPLICATE', 'Permit already approved');
        decider = org.id; details.category = org.category;
      } else if (p.type === 'DELIVERY_ORDER') {
        decider = voyageOf(bl).shippingOrgId;
        if (bl.deliveryOrder && bl.deliveryOrder.status !== 'REJECTED') fail('DUPLICATE', 'Delivery order already requested');
      } else if (p.type === 'TRUCK_BOOKING') {
        const org = S.orgs[p.toOrgId]; if (!org || org.type !== 'TRANSPORTER' || org.status !== 'ACTIVE') fail('VALIDATION', 'Select an active transporter');
        if (!bl.milestones.customsReleased) fail('STATE', 'Trucks can be booked once Customs has released the cargo');
        decider = org.id; details.pickupFrom = p.pickupFrom || null; details.destination = p.destination || '';
      } else fail('VALIDATION', 'This service is created automatically');
      if (bl.serviceIds.some((s) => S.services[s].type === p.type && S.services[s].status === 'PENDING' && S.services[s].deciderOrgId === decider)) fail('DUPLICATE', 'An identical request is already pending');
      const sr = openService(ctx, { type: p.type, bl, deciderOrgId: decider, requesterOrgId: ctx.actor.orgId, details });
      if (p.type === 'DELIVERY_ORDER') bl.deliveryOrder = { status: 'REQUESTED', serviceId: sr.id };
      if (p.type === 'PERMIT') bl.permits[details.category] = { status: 'REQUESTED', serviceId: sr.id, orgId: decider };
      ctx.result = { serviceId: sr.id };
    },

    'service.decide'(ctx, p) {
      const sr = S.services[p.serviceId]; if (!sr) fail('NOT_FOUND', 'Request not found');
      if (sr.deciderOrgId !== ctx.actor.orgId) fail('FORBIDDEN', 'This request is assigned to another organisation');
      if (sr.status !== 'PENDING') fail('STATE', `Request already ${sr.status.toLowerCase()}`);
      const approve = p.decision === 'approve';
      if (!approve && !p.note) fail('VALIDATION', 'A reason is required to reject');
      const bl = sr.blId && S.bls[sr.blId]; const d = p.data || {};
      const def = R.SERVICE_TYPES[sr.type];
      if (sr.type === 'BERTH') {
        const v = S.voyages[sr.voyageId];
        if (approve) {
          if (!R.PORTS[v.port].berths.includes(d.berth)) fail('VALIDATION', `Choose a berth at ${R.PORTS[v.port].name}`);
          const clash = Object.values(S.voyages).find((o) => o.id !== v.id && o.berth === d.berth && ['BERTH_ALLOCATED', 'ARRIVED'].includes(o.status) && o.eta < v.etd && v.eta < o.etd);
          if (clash) fail('CONFLICT', `${d.berth} is allocated to ${clash.vesselName} (${new Date(clash.eta).toISOString().slice(0, 10)} to ${new Date(clash.etd).toISOString().slice(0, 10)})`);
          v.berth = d.berth; v.status = 'BERTH_ALLOCATED';
        }
      }
      if (sr.type === 'PERMIT') {
        const cat = sr.details.category;
        bl.permits[cat] = approve ? { status: 'APPROVED', no: `${cat.slice(0, 3)}-${token('PMT', 6)}`, orgId: ctx.actor.orgId, at: ctx.at, conditions: d.conditions || '' } : { status: 'REJECTED', orgId: ctx.actor.orgId, at: ctx.at, note: p.note };
        if (approve && bl.permitsRequired.every((c) => bl.permits[c]?.status === 'APPROVED')) bl.milestones.permitsApproved = ctx.at;
      }
      if (sr.type === 'DELIVERY_ORDER') {
        if (approve) {
          const st = S.settings;
          bl.deliveryOrder = { status: 'AWAITING_PAYMENT', serviceId: sr.id };
          issueInvoice(ctx, { bl, type: 'SHIPPING_DO', beneficiaryOrgId: ctx.actor.orgId, payerOrgId: payerOf(bl), lines: [
            { desc: 'Delivery order fee', qty: 1, rate: st.shippingDoFee, amount: st.shippingDoFee },
            { desc: 'Container charges (per TEU)', qty: teuOf(bl), rate: st.shippingPerTeu, amount: teuOf(bl) * st.shippingPerTeu },
          ] });
        } else bl.deliveryOrder = { status: 'REJECTED', serviceId: sr.id, note: p.note };
      }
      if (sr.type === 'EXAM_POSITION' && approve) {
        const cons = containersOf(bl);
        if (!cons.every((c) => c.dischargedAt)) fail('STATE', 'All containers must be discharged before positioning');
        cons.forEach((c, i) => { c.homeSlot = c.location; c.moves.push({ at: ctx.at, from: c.location, to: `EXAM-${String(i + 1).padStart(2, '0')}`, reason: 'Customs examination' }); c.location = `EXAM-${String(i + 1).padStart(2, '0')}`; c.status = 'AT_EXAM'; });
        const decl = S.declarations[sr.details.declarationId]; decl.examReady = ctx.at;
        ctx.notify([orgOfType('CUSTOMS')?.id, payerOf(bl)], `Containers positioned for exam: ${bl.blNo}`, `Examination of ${decl.no} can proceed at the exam bay.`, { type: 'bl', id: bl.id }, 'action');
      }
      if (sr.type === 'TRUCK_BOOKING' && approve) {
        const asg = Array.isArray(d.assignments) ? d.assignments : [];
        const cons = containersOf(bl);
        const errs = [];
        for (const c of cons) {
          const a = asg.find((x) => x.containerNo === c.no);
          if (!a) { errs.push(`No truck for ${c.no}`); continue; }
          if (!/^[A-Z]{3}-?\d{3}[A-Z]{2}$/i.test(a.plate || '')) errs.push(`Plate ${a.plate} for ${c.no} is not a valid Nigerian format (e.g. LND-482XY)`);
          if (!a.driver) errs.push(`Driver missing for ${c.no}`);
        }
        if (errs.length) fail('VALIDATION', errs.join('; '), { errors: errs });
        bl.trucks = cons.map((c) => { const a = asg.find((x) => x.containerNo === c.no); return { containerNo: c.no, plate: a.plate.toUpperCase().replace(/^([A-Z]{3})(\d)/, '$1-$2'), driver: a.driver, phone: a.phone || '', slotAt: a.slotAt ? parseTime(a.slotAt, 'Slot') : ctx.at + 4 * HOUR, transporterOrgId: ctx.actor.orgId }; });
        for (const c of cons) if (c.gatePassId) S.gatePasses[c.gatePassId].truck = bl.trucks.find((t) => t.containerNo === c.no);
      }
      sr.status = approve ? 'APPROVED' : 'REJECTED'; sr.decidedAt = ctx.at; sr.decision = { by: ctx.actor.userId, note: p.note || '', data: d };
      sr.slaMet = ctx.at <= sr.slaDueAt;
      const subject = bl ? `B/L ${bl.blNo}` : `voyage ${S.voyages[sr.voyageId].voyageNo}`;
      ctx.audit(`service.${approve ? 'approved' : 'rejected'}`, { type: 'service', id: sr.id }, `${def.label} ${approve ? 'approved' : 'rejected'} for ${subject}${sr.type === 'BERTH' && approve ? ` (berth ${d.berth})` : ''}${p.note ? ': ' + p.note : ''}${sr.slaMet ? '' : ' [SLA breached]'}`, { trace: bl ? blTrace(bl) : `TRC-${S.voyages[sr.voyageId].voyageNo}` });
      ctx.notify([sr.requesterOrgId], `${def.label} ${approve ? 'approved' : 'rejected'}`, `${sr.id} for ${subject}${p.note ? ': ' + p.note : ''}`, bl ? { type: 'bl', id: bl.id } : { type: 'voyage', id: sr.voyageId }, approve ? 'success' : 'warning');
      if (bl) afterChange(ctx, bl);
    },

    'cargo.discharge'(ctx, p) {
      const v = S.voyages[p.voyageId]; if (!v) fail('NOT_FOUND', 'Voyage not found');
      if (v.terminalOrgId !== ctx.actor.orgId) fail('FORBIDDEN', 'Vessel is not calling at your terminal');
      if (v.status !== 'ARRIVED') fail('STATE', 'Vessel has not arrived');
      let targets = Object.values(S.containers).filter((c) => c.voyageId === v.id && !c.dischargedAt);
      if (p.containerNos && p.containerNos.length) targets = targets.filter((c) => p.containerNos.includes(c.no));
      if (!targets.length) fail('STATE', 'No containers left to discharge');
      const free = freeSlots();
      if (free.length < targets.length) fail('CAPACITY', 'Yard is full');
      const touched = new Set();
      targets.forEach((c, i) => { c.location = free[i]; c.status = 'IN_YARD'; c.dischargedAt = ctx.at; c.moves.push({ at: ctx.at, from: 'VESSEL', to: c.location, reason: 'Discharge' }); touched.add(c.blId); });
      ctx.audit('cargo.discharged', { type: 'voyage', id: v.id }, `${targets.length} container(s) discharged from ${v.vesselName} to yard`, { trace: `TRC-${v.voyageNo}` });
      const st = S.settings;
      for (const blId of touched) {
        const bl = S.bls[blId];
        if (containersOf(bl).every((c) => c.dischargedAt)) {
          bl.milestones.discharged = ctx.at;
          ctx.audit('bl.discharged', { type: 'bl', id: bl.id }, `All containers of B/L ${bl.blNo} in yard (${containersOf(bl).map((c) => c.location).join(', ')})`, { trace: blTrace(bl) });
          if (payerOf(bl)) issueInvoice(ctx, { bl, type: 'TERMINAL_HANDLING', beneficiaryOrgId: v.terminalOrgId, payerOrgId: payerOf(bl), lines: [{ desc: 'Terminal handling (per TEU)', qty: teuOf(bl), rate: st.terminalHandlingPerTeu, amount: teuOf(bl) * st.terminalHandlingPerTeu }] });
          for (const sid of bl.serviceIds) { const sv = S.services[sid]; if (sv.type === 'EXAM_POSITION' && sv.status === 'PENDING') sv.slaDueAt = ctx.at + R.SERVICE_TYPES.EXAM_POSITION.slaHours * HOUR; }
          ctx.notify([bl.forwarderOrgId, bl.consigneeOrgId], `Discharged: ${bl.blNo}`, `Free storage ends after ${st.storageFreeDays} days.`, { type: 'bl', id: bl.id });
          afterChange(ctx, bl);
        }
      }
      ctx.result = { discharged: targets.length };
    },

    'declaration.lodge'(ctx, p) {
      const bl = S.bls[p.blId]; assertBlAccess(ctx.actor, bl, isCargoInterest);
      if (bl.declarationId) fail('DUPLICATE', 'A declaration already exists for this B/L');
      req(p, ['fobValueUsd', 'formMNo', 'cpc', 'originCountry']);
      if (!R.CPC[p.cpc]) fail('VALIDATION', 'Unknown customs procedure code');
      if (!/^MF\d{8}$/i.test(p.formMNo)) fail('VALIDATION', 'Form M number must look like MF20260001');
      if (!/^[A-Z]{2}$/.test(p.originCountry)) fail('VALIDATION', 'Origin must be an ISO country code (e.g. CN)');
      const fob = Number(p.fobValueUsd); if (!(fob > 0)) fail('VALIDATION', 'FOB value must be positive');
      const hs = String(p.hsCode || bl.hsCode).slice(0, 4); if (!R.TARIFF[hs]) fail('VALIDATION', 'HS code not in tariff');
      const v = voyageOf(bl);
      // Single-window data reuse: these fields come from the manifest and common repository, not re-typed.
      const prefilled = { blNo: bl.blNo, vessel: v.vesselName, voyageNo: v.voyageNo, imo: v.imo, port: v.port, portOfLoading: bl.portOfLoading, shipper: bl.shipper, consignee: bl.consigneeName, consigneeTin: bl.consigneeTin, description: bl.description, hsCode: bl.hsCode, packages: bl.packages, grossWeightKg: bl.grossWeightKg, containers: containersOf(bl).map((c) => c.no).join(', ') };
      const overrides = {};
      if (p.hsCode && hs !== bl.hsCode) overrides.hsCode = hs;
      if (p.grossWeightKg != null && Number(p.grossWeightKg) !== bl.grossWeightKg) overrides.grossWeightKg = Number(p.grossWeightKg);
      if (p.description && p.description !== bl.description) overrides.description = p.description;
      const entered = ['fobValueUsd', 'formMNo', 'cpc', 'originCountry', 'freightUsd', 'insuranceUsd'].filter((k) => p[k] != null && p[k] !== '').length + Object.keys(overrides).length;
      const decl = {
        id: nextId('DCL'), no: `SGD/${new Date(ctx.at).getUTCFullYear()}/${String((S.counters.SGD = (S.counters.SGD || 0) + 1)).padStart(6, '0')}`, blId: bl.id,
        lodgedBy: ctx.actor.orgId, lodgedAt: ctx.at, ...prefilled, ...overrides, hsCode: hs, grossWeightKg: overrides.grossWeightKg ?? bl.grossWeightKg,
        fobValueUsd: fob, freightUsd: p.freightUsd != null && p.freightUsd !== '' ? Number(p.freightUsd) : null, insuranceUsd: p.insuranceUsd != null && p.insuranceUsd !== '' ? Number(p.insuranceUsd) : null,
        formMNo: p.formMNo.toUpperCase(), cpc: p.cpc, originCountry: p.originCountry, preArrival: v.status !== 'ARRIVED' && v.status !== 'DEPARTED',
        reuse: { prefilled: Object.keys(prefilled).length - Object.keys(overrides).length, entered }, status: 'ASSESSED', queries: [],
      };
      S.declarations[decl.id] = decl; bl.declarationId = decl.id;
      const val = valuation(decl); decl.valuation = val;
      const risk = riskAssess(decl, bl); decl.risk = risk; decl.lane = risk.lane;
      bl.permitsRequired = R.TARIFF[hs].permits.slice();
      bl.milestones.declared = ctx.at;
      ctx.audit('declaration.lodged', { type: 'declaration', id: decl.id }, `${decl.no} lodged for B/L ${bl.blNo}${decl.preArrival ? ' (pre-arrival)' : ''}; ${decl.reuse.prefilled} fields reused, ${decl.reuse.entered} entered`, { trace: blTrace(bl) });
      ctx.audit('declaration.assessed', { type: 'declaration', id: decl.id }, `Risk score ${risk.score}: ${risk.lane} lane; assessed duty and taxes NGN ${round2(val.lines.reduce((a, l) => a + l.amount, 0)).toLocaleString('en-US')}`, { trace: blTrace(bl), system: true, data: { score: risk.score, lane: risk.lane } });
      issueInvoice(ctx, { bl, type: 'CUSTOMS_DUTY', beneficiaryOrgId: orgOfType('CUSTOMS').id, payerOrgId: payerOf(bl) || ctx.actor.orgId, lines: val.lines, ref: { declarationId: decl.id } });
      const st = S.settings;
      issueInvoice(ctx, { bl, type: 'NPA_DUES', beneficiaryOrgId: orgOfType('NPA').id, payerOrgId: payerOf(bl) || ctx.actor.orgId, lines: [{ desc: 'Port authority cargo dues (per TEU)', qty: teuOf(bl), rate: st.npaDuesPerTeu, amount: teuOf(bl) * st.npaDuesPerTeu }] });
      if (bl.permitsRequired.length) ctx.notify([ctx.actor.orgId], `Permit(s) required for ${bl.blNo}`, `HS ${hs} needs: ${bl.permitsRequired.join(', ')}. Request them from the shipment page.`, { type: 'bl', id: bl.id }, 'action');
      afterChange(ctx, bl);
      ctx.result = { declarationId: decl.id, lane: decl.lane };
    },

    'declaration.review'(ctx, p) {
      const decl = S.declarations[p.declarationId]; if (!decl) fail('NOT_FOUND', 'Declaration not found');
      if (decl.status !== 'AWAITING_REVIEW') fail('STATE', `Declaration is ${decl.status.toLowerCase().replace(/_/g, ' ')}`);
      const bl = S.bls[decl.blId];
      if (p.decision === 'approve') {
        ctx.audit('declaration.reviewed', { type: 'declaration', id: decl.id }, `Documentary review passed for ${decl.no}${p.note ? ': ' + p.note : ''}`, { trace: blTrace(bl) });
        customsRelease(ctx, decl, 'after documentary review');
      } else if (p.decision === 'exam') {
        decl.status = 'AWAITING_EXAM'; decl.lane = 'RED';
        ctx.audit('declaration.escalated', { type: 'declaration', id: decl.id }, `${decl.no} escalated to physical examination: ${p.note || ''}`, { trace: blTrace(bl) });
        openService(ctx, { type: 'EXAM_POSITION', bl, deciderOrgId: voyageOf(bl).terminalOrgId, requesterOrgId: ctx.actor.orgId, details: { declarationId: decl.id, note: p.note || 'Escalated from documentary review' }, system: true });
      } else {
        req(p, ['note']);
        decl.status = 'QUERIED'; decl.queries.push({ at: ctx.at, by: ctx.actor.userId, question: p.note, answer: null });
        ctx.audit('declaration.queried', { type: 'declaration', id: decl.id }, `Query raised on ${decl.no}: ${p.note}`, { trace: blTrace(bl) });
        ctx.notify([decl.lodgedBy], `Customs query on ${decl.no}`, p.note, { type: 'bl', id: bl.id }, 'warning');
      }
      afterChange(ctx, bl);
    },

    'declaration.respond'(ctx, p) {
      const decl = S.declarations[p.declarationId]; if (!decl) fail('NOT_FOUND', 'Declaration not found');
      if (decl.lodgedBy !== ctx.actor.orgId) fail('FORBIDDEN', 'Only the declarant can respond');
      if (decl.status !== 'QUERIED') fail('STATE', 'No open query');
      req(p, ['note']);
      const bl = S.bls[decl.blId];
      decl.queries[decl.queries.length - 1].answer = { at: ctx.at, text: p.note, documents: p.documents || [] };
      if (p.fobValueUsd != null && Number(p.fobValueUsd) !== decl.fobValueUsd) {
        const before = decl.valuation.lines.reduce((a, l) => a + l.amount, 0);
        decl.fobValueUsd = Number(p.fobValueUsd); decl.valuation = valuation(decl);
        const extra = round2(decl.valuation.lines.reduce((a, l) => a + l.amount, 0) - before);
        if (extra > 0) {
          decl.status = 'AWAITING_SUPP_PAYMENT';
          issueInvoice(ctx, { bl, type: 'CUSTOMS_SUPP', beneficiaryOrgId: orgOfType('CUSTOMS').id, payerOrgId: decl.lodgedBy, lines: [{ desc: `Additional duty & taxes after value correction to USD ${decl.fobValueUsd}`, qty: 1, rate: extra, amount: extra }], ref: { declarationId: decl.id } });
        } else decl.status = 'AWAITING_REVIEW';
      } else decl.status = 'AWAITING_REVIEW';
      ctx.audit('declaration.responded', { type: 'declaration', id: decl.id }, `Declarant responded to query on ${decl.no}${p.documents?.length ? ` with ${p.documents.length} document(s)` : ''}`, { trace: blTrace(bl) });
      ctx.notify([orgOfType('CUSTOMS')?.id], `Query answered: ${decl.no}`, p.note, { type: 'bl', id: bl.id }, 'action');
      afterChange(ctx, bl);
    },

    'exam.record'(ctx, p) {
      const decl = S.declarations[p.declarationId]; if (!decl) fail('NOT_FOUND', 'Declaration not found');
      if (decl.status !== 'AWAITING_EXAM') fail('STATE', 'Declaration is not awaiting examination');
      if (!decl.examReady) fail('STATE', 'Containers have not been positioned by the terminal yet');
      const bl = S.bls[decl.blId];
      req(p, ['finding']);
      decl.exam = { at: ctx.at, by: ctx.actor.userId, finding: p.finding, note: p.note || '' };
      for (const c of containersOf(bl)) { const back = c.homeSlot; c.homeSlot = null; c.moves.push({ at: ctx.at, from: c.location, to: back, reason: 'Return from exam' }); c.location = back; c.status = 'IN_YARD'; }
      if (p.finding === 'CLEAN') {
        ctx.audit('exam.recorded', { type: 'declaration', id: decl.id }, `Examination of ${decl.no}: no discrepancy${p.note ? ' (' + p.note + ')' : ''}`, { trace: blTrace(bl) });
        customsRelease(ctx, decl, 'after physical examination');
      } else if (p.finding === 'DISCREPANCY') {
        req(p, ['note']);
        const before = decl.valuation.lines.reduce((a, l) => a + l.amount, 0);
        if (p.revisedFobUsd) decl.fobValueUsd = Number(p.revisedFobUsd);
        if (p.revisedHs) { if (!R.TARIFF[p.revisedHs]) fail('VALIDATION', 'Revised HS not in tariff'); decl.hsCode = p.revisedHs; }
        decl.valuation = valuation(decl); decl.discrepancy = true;
        const extra = round2(decl.valuation.lines.reduce((a, l) => a + l.amount, 0) - before);
        const hist = S.importerHistory[bl.consigneeKey] || (S.importerHistory[bl.consigneeKey] = { clean: 0, discrepancies: 0 }); hist.discrepancies++;
        ctx.audit('exam.recorded', { type: 'declaration', id: decl.id }, `Examination of ${decl.no}: DISCREPANCY, ${p.note}`, { trace: blTrace(bl), data: { extra } });
        if (extra > 0) {
          decl.status = 'AWAITING_SUPP_PAYMENT';
          const pen = round2(extra * S.settings.examPenaltyRate);
          issueInvoice(ctx, { bl, type: 'CUSTOMS_SUPP', beneficiaryOrgId: orgOfType('CUSTOMS').id, payerOrgId: decl.lodgedBy, lines: [
            { desc: 'Additional duty & taxes (exam finding)', qty: 1, rate: extra, amount: extra },
            { desc: `Penalty ${(S.settings.examPenaltyRate * 100).toFixed(0)}% of additional duty`, qty: 1, rate: pen, amount: pen }], ref: { declarationId: decl.id } });
        } else customsRelease(ctx, decl, 'after examination (discrepancy, no additional duty)');
      } else fail('VALIDATION', 'Finding must be CLEAN or DISCREPANCY');
      afterChange(ctx, bl);
    },

    'payment.pay'(ctx, p) {
      const ids = p.invoiceIds || []; if (!ids.length) fail('VALIDATION', 'Select at least one invoice');
      const bank = S.orgs[p.bankOrgId]; if (!bank || bank.type !== 'BANK' || bank.status !== 'ACTIVE') fail('VALIDATION', 'Select an active bank / payment provider');
      const invs = ids.map((i) => S.invoices[i]);
      if (invs.some((i) => !i)) fail('NOT_FOUND', 'Invoice not found');
      if (invs.some((i) => i.payerOrgId !== ctx.actor.orgId)) fail('FORBIDDEN', 'You can only pay invoices addressed to your organisation');
      if (invs.some((i) => i.status !== 'UNPAID')) fail('STATE', 'One or more invoices are already paid');
      const total = round2(invs.reduce((a, i) => a + i.total, 0));
      if (p.simulateDecline) {
        ctx.audit('payment.declined', { type: 'payment', id: 'declined' }, `Gateway declined NGN ${total.toLocaleString('en-US')} via ${bank.name} (simulated)`, { trace: blTrace(S.bls[invs[0].blId]) });
        ctx.result = { declined: true }; return;
      }
      const pay = { id: nextId('PAY'), ref: `PGW-${token('PGW', 10)}`, invoiceIds: ids, payerOrgId: ctx.actor.orgId, bankOrgId: bank.id, method: p.method || 'card', total, currency: 'NGN', status: 'SUCCESS', paidAt: ctx.at, reconciledAt: null };
      S.payments[pay.id] = pay;
      for (const inv of invs) { inv.status = 'PAID'; inv.paidAt = ctx.at; inv.paymentId = pay.id; }
      const traces = [...new Set(invs.map((i) => S.bls[i.blId].blNo))];
      ctx.audit('payment.captured', { type: 'payment', id: pay.id }, `Payment ${pay.ref} of NGN ${total.toLocaleString('en-US')} captured via ${bank.name} (${pay.method}) for ${invs.map((i) => i.no).join(', ')}`, { trace: `TRC-${traces[0]}` });
      ctx.notify([bank.id], `Payment received for settlement: ${pay.ref}`, `NGN ${total.toLocaleString('en-US')} from ${ctx.actor.orgName} for B/L ${traces.join(', ')} (${invs.map((i) => i.no).join(', ')}). Reconcile to release settlement to the beneficiaries.`, { type: 'bl', id: invs[0].blId, paymentId: pay.id }, 'action');
      ctx.notify([...new Set(invs.map((i) => i.beneficiaryOrgId))], `Payment received ${pay.ref}`, `${invs.map((i) => i.no).join(', ')} paid by ${ctx.actor.orgName}.`, { type: 'bl', id: invs[0].blId }, 'success');
      for (const inv of invs) onInvoicePaid(ctx, inv);
      ctx.result = { paymentId: pay.id, ref: pay.ref };
    },

    'payment.reconcile'(ctx, p) {
      const ids = p.paymentIds || []; if (!ids.length) fail('VALIDATION', 'Select payments');
      for (const id of ids) {
        const pay = S.payments[id];
        if (!pay || pay.bankOrgId !== ctx.actor.orgId) fail('FORBIDDEN', `Payment ${id} was not processed by your bank`);
        if (pay.status !== 'SUCCESS') fail('STATE', `Payment ${pay.ref} already reconciled`);
      }
      for (const id of ids) {
        const pay = S.payments[id];
        pay.status = 'RECONCILED'; pay.reconciledAt = ctx.at; pay.settlementRef = `STL-${token('STL', 8)}`;
        for (const iid of pay.invoiceIds) S.invoices[iid].status = 'RECONCILED';
        const bl = S.bls[S.invoices[pay.invoiceIds[0]].blId];
        ctx.audit('payment.reconciled', { type: 'payment', id: pay.id }, `Payment ${pay.ref} settled to beneficiaries (${pay.settlementRef})`, { trace: `TRC-${bl.blNo}` });
        const benef = [...new Set(pay.invoiceIds.map((i) => S.invoices[i].beneficiaryOrgId))];
        ctx.notify([pay.payerOrgId, ...benef], `Payment settled: ${pay.ref}`, `${ctx.actor.orgName} settled NGN ${pay.total.toLocaleString('en-US')} to the beneficiaries (settlement ${pay.settlementRef}).`, { type: 'bl', id: bl.id }, 'success');
        if (bl.milestones.closed && unsettledOf(bl).length === 0 && !bl.milestones.settled) {
          bl.milestones.settled = ctx.at;
          ctx.audit('shipment.settled', { type: 'bl', id: bl.id }, `All payments for closed shipment ${bl.blNo} are now settled`, { trace: blTrace(bl), system: true });
        }
      }
    },

    'terminal.release'(ctx, p) {
      const bl = S.bls[p.blId]; assertBlAccess(ctx.actor, bl, (a, b) => voyageOf(b).terminalOrgId === a.orgId);
      if (bl.milestones.terminalReleased) fail('STATE', 'Already released by terminal');
      if (!bl.milestones.discharged) fail('STATE', 'Containers not yet discharged');
      if (!bl.milestones.customsReleased) fail('STATE', 'Awaiting Customs release');
      const until = ctx.at + S.settings.gatePassValidHours * HOUR;
      const lines = storageCharge(bl, until);
      if (lines.length) {
        issueInvoice(ctx, { bl, type: 'TERMINAL_STORAGE', beneficiaryOrgId: ctx.actor.orgId, payerOrgId: payerOf(bl), lines: lines.map(({ containerId, days, ...l }) => l) });
        for (const l of lines) { const c = S.containers[l.containerId]; c.storageBilledDays = (c.storageBilledDays || 0) + l.days; c.storagePaidThrough = until; }
      }
      const unpaid = bl.invoiceIds.map((i) => S.invoices[i]).filter((i) => i.beneficiaryOrgId === ctx.actor.orgId && i.status === 'UNPAID');
      if (unpaid.length) {
        ctx.audit('terminal.release.held', { type: 'bl', id: bl.id }, `Terminal release of ${bl.blNo} held: ${unpaid.length} terminal invoice(s) unpaid`, { trace: blTrace(bl) });
        ctx.result = { held: true, unpaid: unpaid.map((i) => i.no) }; return;
      }
      bl.milestones.terminalReleased = ctx.at;
      ctx.audit('terminal.released', { type: 'bl', id: bl.id }, `Terminal release granted for B/L ${bl.blNo}`, { trace: blTrace(bl) });
      ctx.notify([payerOf(bl), orgOfType('NPA')?.id], `Terminal release: ${bl.blNo}`, 'Terminal charges settled; awaiting Port Authority release order.', { type: 'bl', id: bl.id }, 'success');
      afterChange(ctx, bl);
      ctx.result = { released: true };
    },

    'release.approve'(ctx, p) {
      const bl = S.bls[p.blId]; if (!bl) fail('NOT_FOUND', 'B/L not found');
      if (bl.milestones.releaseOrdered) fail('STATE', 'Release order already issued');
      const cl = checklist(bl);
      if (!cl.ready) fail('STATE', `Cannot release: ${cl.items.filter((i) => !i.ok).map((i) => i.label).join('; ')}`, { checklist: cl });
      const ro = issueRelease(ctx, bl, p.note, false);
      ctx.result = { releaseOrderId: ro.id, no: ro.no };
    },

    'gate.out'(ctx, p) {
      req(p, ['token', 'plate']);
      const gp = Object.values(S.gatePasses).find((g) => g.token === String(p.token).toUpperCase().trim());
      if (!gp) fail('NOT_FOUND', 'Gate pass not recognised');
      const bl = S.bls[gp.blId]; const v = voyageOf(bl); const c = S.containers[gp.containerId];
      if (v.terminalOrgId !== ctx.actor.orgId) fail('FORBIDDEN', 'Gate pass is for another terminal');
      if (gp.status !== 'ACTIVE') fail('STATE', `Gate pass is ${gp.status.toLowerCase()}`);
      if (ctx.at > gp.expiresAt) { gp.status = 'EXPIRED'; ctx.audit('gate.denied', { type: 'gatepass', id: gp.id }, `Gate pass for ${c.no} expired`, { trace: blTrace(bl) }); ctx.result = { denied: 'expired' }; return; }
      if (!gp.truck) fail('STATE', 'No truck has been booked for this container');
      const plate = String(p.plate).toUpperCase().replace(/\s/g, '').replace(/^([A-Z]{3})-?/, '$1-');
      if (plate !== gp.truck.plate) {
        ctx.audit('gate.denied', { type: 'gatepass', id: gp.id }, `Gate-out of ${c.no} denied: truck ${plate} does not match booked ${gp.truck.plate}`, { trace: blTrace(bl) });
        ctx.notify([payerOf(bl), orgOfType('NPA')?.id], `Gate denied: ${c.no}`, `Truck ${plate} is not the booked truck.`, { type: 'bl', id: bl.id }, 'warning');
        ctx.result = { denied: 'plate_mismatch' }; return;
      }
      gp.status = 'USED'; gp.usedAt = ctx.at; c.status = 'GATED_OUT'; c.moves.push({ at: ctx.at, from: c.location, to: `GATE-OUT ${plate}`, reason: 'Delivery' }); c.location = null; c.gateOutAt = ctx.at;
      if (!bl.milestones.gateOutFirst) bl.milestones.gateOutFirst = ctx.at;
      const all = containersOf(bl).every((x) => x.status === 'GATED_OUT');
      if (all) bl.milestones.gateOutAll = ctx.at;
      ctx.audit('gate.out', { type: 'gatepass', id: gp.id }, `${c.no} gated out on truck ${plate} (driver ${gp.truck.driver})${ctx.at > gp.truck.slotAt + 2 * HOUR ? ' [late for slot]' : ''}`, { trace: blTrace(bl) });
      ctx.notify([payerOf(bl), bl.consigneeOrgId, gp.truck.transporterOrgId], `Container gated out: ${c.no}`, `Truck ${plate} left ${S.orgs[v.terminalOrgId].name}.${all ? ' All containers are out.' : ''}`, { type: 'bl', id: bl.id }, 'success');
      afterChange(ctx, bl);
      ctx.result = { ok: true, allOut: all };
    },

    'delivery.confirm'(ctx, p) {
      const bl = S.bls[p.blId]; assertBlAccess(ctx.actor, bl, isCargoInterest);
      if (!bl.milestones.gateOutAll) fail('STATE', 'Not all containers have left the port');
      if (bl.milestones.delivered) fail('STATE', 'Already confirmed');
      bl.milestones.delivered = ctx.at; bl.milestones.closed = ctx.at;
      const m = bl.milestones;
      const firstDis = Math.min(...containersOf(bl).map((c) => c.dischargedAt));
      bl.kpi = { dwellHours: round2((m.gateOutAll - firstDis) / HOUR), clearanceHours: S.declarations[bl.declarationId] ? round2((m.customsReleased - S.declarations[bl.declarationId].lodgedAt) / HOUR) : null, endToEndHours: round2((m.delivered - m.manifested) / HOUR), releaseToGateHours: round2((m.gateOutAll - m.releaseOrdered) / HOUR) };
      ctx.audit('delivery.confirmed', { type: 'bl', id: bl.id }, `Delivery of B/L ${bl.blNo} confirmed${p.note ? ': ' + p.note : ''}`, { trace: blTrace(bl) });
      const open = unsettledOf(bl);
      bl.kpi.unsettledPayments = open.length;
      if (!open.length) bl.milestones.settled = ctx.at;
      ctx.audit('shipment.closed', { type: 'bl', id: bl.id }, `Shipment ${bl.blNo} closed. Port dwell ${bl.kpi.dwellHours}h, Customs clearance ${bl.kpi.clearanceHours}h${open.length ? `; ${open.length} payment(s) still awaiting bank settlement` : '; all payments settled'}`, { trace: blTrace(bl), system: true, data: bl.kpi });
      for (const pay of open) ctx.notify([pay.bankOrgId], `Settlement outstanding: ${pay.ref}`, `Shipment ${bl.blNo} has closed but payment ${pay.ref} (NGN ${pay.total.toLocaleString('en-US')}) is not yet reconciled.`, { type: 'bl', id: bl.id, paymentId: pay.id }, 'action');
      const v = voyageOf(bl);
      ctx.notify([v.shippingOrgId, v.terminalOrgId, orgOfType('NPA')?.id, bl.forwarderOrgId, bl.consigneeOrgId], `Shipment closed: ${bl.blNo}`, 'Delivery confirmed. Records archived for reporting.', { type: 'bl', id: bl.id });
      afterChange(ctx, bl);
    },

    'notification.read'(ctx, p) {
      const set = new Set(S.reads[ctx.actor.userId] || []);
      const mine = S.notifications.filter((n) => n.orgId === ctx.actor.orgId);
      for (const n of mine) if (p.all || (p.ids || []).includes(n.id)) set.add(n.id);
      S.reads[ctx.actor.userId] = [...set];
    },

    'clock.advance'(ctx, p) {
      const h = Number(p.hours); if (!(h > 0 && h <= 24 * 30)) fail('VALIDATION', 'Hours must be between 1 and 720');
      S.clockOffset += h * HOUR;
      ctx.audit('clock.advanced', { type: 'system', id: 'clock' }, `Demo clock advanced by ${h}h (simulation only)`);
    },

    // The valuation exchange rate is the Customs Service's to publish (it applies the CBN rate), not the Port Authority's.
    'customs.fx.set'(ctx, p) {
      req(p, ['rate', 'source', 'effectiveFrom']);
      const rate = Number(p.rate);
      if (!(rate > 100 && rate < 100000)) fail('VALIDATION', 'Enter the NGN per USD rate, e.g. 1450.25');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.effectiveFrom))) fail('VALIDATION', 'effectiveFrom must be a date (YYYY-MM-DD)');
      const from = S.settings.fxNgnPerUsd;
      S.settings.fxNgnPerUsd = rate;
      S.fx = { rate, source: String(p.source).slice(0, 200), effectiveFrom: String(p.effectiveFrom), setBy: ctx.actor.userId, setByName: `${ctx.actor.name}, ${ctx.actor.orgName}`, setAt: ctx.at };
      ctx.audit('customs.fx.set', { type: 'system', id: 'fx' }, `Customs valuation rate set to NGN ${rate} per USD from ${S.fx.effectiveFrom} (${S.fx.source})`, { data: { from, to: rate, source: S.fx.source, effectiveFrom: S.fx.effectiveFrom } });
      ctx.notify(Object.values(S.orgs).filter((o) => ['FORWARDER', 'IMPORTER', 'NPA', 'BANK'].includes(o.type) && o.status === 'ACTIVE').map((o) => o.id), `Customs exchange rate: NGN ${rate}/USD`, `Applies to declarations valued from ${S.fx.effectiveFrom}. Source: ${S.fx.source}.`, null, 'info');
    },

    'settings.update'(ctx, p) {
      const changes = p.changes || {}; const diff = {};
      for (const [k, val] of Object.entries(changes)) {
        if (!(k in R.DEFAULT_SETTINGS)) fail('VALIDATION', `Unknown setting ${k}`);
        if (k === 'fxNgnPerUsd' && Number(val) !== S.settings.fxNgnPerUsd) fail('FORBIDDEN', 'The valuation exchange rate is set by the Customs Service');
        const typed = typeof R.DEFAULT_SETTINGS[k] === 'number' ? Number(val) : typeof R.DEFAULT_SETTINGS[k] === 'boolean' ? !!val : val;
        if (typeof typed === 'number' && !(typed >= 0)) fail('VALIDATION', `${k} must be a non-negative number`);
        if (S.settings[k] !== typed) { diff[k] = { from: S.settings[k], to: typed }; S.settings[k] = typed; }
      }
      ctx.audit('settings.updated', { type: 'system', id: 'settings' }, `Settings changed: ${Object.keys(diff).join(', ') || 'none'}`, { data: diff });
    },
  };

  function validImo(imo) {
    if (!/^\d{7}$/.test(imo)) return false;
    const s = [...imo.slice(0, 6)].reduce((a, d, i) => a + Number(d) * (7 - i), 0);
    return s % 10 === Number(imo[6]);
  }

  // ---------------------------------------------------------------- execute
  function execute(cmd, { replay = false } = {}) {
    const handler = H[cmd.type]; if (!handler) fail('UNKNOWN', `Unknown command ${cmd.type}`);
    const at = Math.max(cmd.at || 0, S.lastAt);
    const actor = cmd.userId ? actorFrom(cmd.userId) : null;
    if (cmd.type !== 'system.init' && !['auth.failed', 'auth.login', 'auth.event'].includes(cmd.type)) {
      if (!allowed(cmd.type, actor)) fail('FORBIDDEN', `Your role is not permitted to perform ${cmd.type}`);
      if (actor && !actor.system) {
        if (!actor.user.active) fail('FORBIDDEN', 'User is deactivated');
        if (actor.org.status !== 'ACTIVE' && cmd.type !== 'notification.read') fail('FORBIDDEN', `Organisation is ${actor.org.status.toLowerCase()}`);
      }
    }
    // Atomicity: snapshot mutable state; append-only arrays are truncated on failure.
    const lens = Object.fromEntries(APPEND_ONLY.map((k) => [k, S[k].length]));
    const saved = {}; for (const k of Object.keys(S)) if (!APPEND_ONLY.includes(k)) saved[k] = S[k];
    const snapshot = structuredClone(saved);
    const prevHash = S.lastHash;
    S.seq++;
    const ctx = makeCtx({ ...cmd, at }, actor);
    try {
      handler(ctx, cmd.payload || {});
    } catch (e) {
      Object.assign(S, snapshot); S.lastHash = prevHash;
      for (const k of APPEND_ONLY) S[k].length = lens[k];
      throw e;
    }
    S.lastAt = at;
    const record = { seq: S.seq, type: cmd.type, userId: cmd.userId || null, at, payload: cmd.payload || {} };
    log.push(record);
    if (!replay) for (const l of listeners) l(record, ctx.result);
    return ctx.result;
  }

  function load(records) {
    S = emptyState(); log = [];
    for (const r of records) execute({ type: r.type, userId: r.userId, at: r.at, payload: r.payload }, { replay: true });
  }

  function verifyAudit() {
    let prev = 'GENESIS';
    for (const e of S.audit) {
      const { hash, ...rest } = e;
      if (rest.prev !== prev) return { ok: false, brokenAt: e.n, reason: 'Link to previous entry broken' };
      if (sha256(JSON.stringify(rest)) !== hash) return { ok: false, brokenAt: e.n, reason: 'Entry contents altered' };
      prev = hash;
    }
    return { ok: true, entries: S.audit.length, head: prev };
  }

  return {
    execute, load, verifyAudit, checklist, stageOf, actorFrom, allowed, valuation,
    get state() { return S; }, get log() { return log; },
    now: (real) => Math.max(real + S.clockOffset, S.lastAt),
    onCommit: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    findUserByEmail: (email) => Object.values(S.users).find((u) => u.email === String(email).trim().toLowerCase()),
    verifyPassword: (user, password) => !!user.passwordHash && hashPassword(password, user.salt) === user.passwordHash,
    lockState: (email, at) => { const f = S.loginFails[String(email).toLowerCase()]; return f && f.lockedUntil > at ? f.lockedUntil : 0; },
    apiKeyOrg: (keyHash) => Object.entries(S.apiKeys).find(([, k]) => k.keyHash === keyHash)?.[0] || null,
  };
}

export function typeLabel(t) {
  return ({ NPA_DUES: 'Port authority cargo dues', CUSTOMS_DUTY: 'Customs duty & taxes', CUSTOMS_SUPP: 'Supplementary customs assessment', TERMINAL_HANDLING: 'Terminal handling', TERMINAL_STORAGE: 'Terminal storage', SHIPPING_DO: 'Shipping line delivery order charges' })[t] || t;
}
