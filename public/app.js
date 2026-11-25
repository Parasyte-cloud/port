// PCS web client. One codebase for the hosted server and the in-browser showcase (see api-*.js).
import { esc, money, usd, dt, dshort, hrs, ago, titleCase, stagePill, statusPill, lane, STAGES, STEPS, MY_STEPS, blSteps, flowHtml, toast, errList, openModal, closeModal, modalOpen, field, prefilled, toLocalInput } from './ui.js';
import { DEMO_ORGS, DEMO_PASSWORD } from '../core/seed.js';
import { validContainerNo, makeContainerNo, ORG_TYPES, PORTS, CPC, TARIFF, PERMISSIONS, DEFAULT_SETTINGS } from '../core/reference.js';

let api, S = null; // S = session
const app = () => document.getElementById('app');
const view = { tab: {} };
const BRAND = 'Parasyte PCS';
const LOGO = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0a5c8a"/><path d="M6 21h20l-3 5H9z" fill="#e3ebf1"/><rect x="9" y="14" width="5" height="6" fill="#f0b632"/><rect x="15" y="14" width="5" height="6" fill="#5aaedd"/><rect x="12" y="8" width="5" height="5" fill="#45c083"/><path d="M22 6v14M22 6l4 3" stroke="#e3ebf1" stroke-width="1.6" fill="none"/></svg>`;

const NAV = [
  ['Operate', [['home', 'Work queue', '*'], ['shipments', 'Shipments', '*'], ['voyages', 'Vessel calls', 'NPA CUSTOMS SHIPPING TERMINAL AUDIT'], ['berths', 'Berth plan', 'NPA SHIPPING TERMINAL AUDIT'], ['customs', 'Declarations', 'CUSTOMS NPA AUDIT FORWARDER IMPORTER'], ['requests', 'Service requests', 'NPA CUSTOMS SHIPPING TERMINAL FORWARDER IMPORTER OGA TRANSPORTER AUDIT'], ['yard', 'Yard', 'TERMINAL NPA CUSTOMS AUDIT'], ['gate', 'Gate', 'TERMINAL NPA AUDIT'], ['payments', 'Payments', '*']]],
  ['Oversee', [['inbox', 'Notifications', '*'], ['audit', 'Audit trail', '*'], ['reports', 'Reports & KPIs', '*'], ['directory', 'Common data', '*']]],
  ['Administer', [['integration', 'Integrations', '*'], ['access', 'Organisation & access', '*'], ['config', 'Configuration', 'NPA']]],
];

// ------------------------------------------------------------------ boot
export async function start(adapter) {
  api = adapter;
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  window.addEventListener('hashchange', () => render());
  api.subscribe(() => scheduleRefresh());
  window.addEventListener('pcs:modalclosed', () => { if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(); } });
  if (api.signedIn) { try { S = await api.q('session'); } catch { api.logout(); } }
  render();
}
let refreshT = null, pendingRefresh = false;
function scheduleRefresh() { if (modalOpen()) { pendingRefresh = true; return; } clearTimeout(refreshT); refreshT = setTimeout(async () => { if (!S) return; try { S = await api.q('session'); } catch {} render(true); }, 150); }

const route = () => { const h = decodeURIComponent(location.hash.slice(1)); const m = h.match(/^(bl|voyage)-(.+)$/); return m ? { v: m[1], arg: m[2] } : { v: h || 'home' }; };
const go = (h) => { if (location.hash === '#' + h) render(); else location.hash = h; };

async function render(soft) {
  const r = route();
  if (r.v === 'track' && !S) return renderPublic('track');
  if (r.v === 'register' && !S) return renderPublic('register');
  if (!S) return renderLogin();
  const y = window.scrollY;
  if (!document.querySelector('.shell')) app().innerHTML = shellHtml();
  updateShell(r.v);
  const main = document.getElementById('main');
  const fn = VIEWS[r.v] || VIEWS.home;
  if (!soft) main.innerHTML = '<div class="empty">Loading…</div>';
  try { main.innerHTML = await fn(r.arg); }
  catch (e) { main.innerHTML = `<div class="panel"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`; console.error(e); }
  if (soft) window.scrollTo(0, y); else window.scrollTo(0, 0);
  document.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== (view.tab[p.dataset.group] || p.dataset.default)));
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === (view.tab[b.dataset.group] || b.closest('.tabs').dataset.default)));
}

const can = (cmd) => S.permissions.includes(cmd);
const isType = (...t) => t.includes(S.org.type);
const navAllowed = (roles) => roles === '*' || roles.split(' ').includes(S.org.type);

function shellHtml() {
  return `<div class="shell"><aside class="rail" id="rail"><div class="brand">${LOGO}<div><b>${BRAND}</b><span>Port Community System</span></div></div><nav class="nav" id="nav" aria-label="Modules"></nav>
    <div class="rail-foot">${api.mode === 'local' ? 'Showcase mode: runs in this browser with seeded data. Changes stay on this device.' : 'Connected to PCS server.'}<br>Track cargo: <a href="#track" style="color:#8ec6ea">public tracker</a></div></aside>
    <div class="main"><div class="demo-banner">Showcase build with simulated data, payments and integrations. Values tagged <span class="guess">GUESS</span> are placeholders to confirm with the authorities.</div>
    <header class="topbar"><button class="btn sm menu-btn" data-act="menu" aria-label="Open menu">☰</button>
      <form class="search" data-form="search" role="search"><input id="gsearch" name="q" placeholder="Search B/L, container, declaration or consignee" aria-label="Search"></form>
      <span class="clock" id="clock" title="Platform clock (demo time can be advanced in Configuration)"></span>
      <div class="who"><div class="org"><b id="who-name"></b><span id="who-org"></span></div><button class="btn sm" data-act="switch">Switch role</button><button class="btn sm ghost" data-act="logout">Sign out</button></div></header>
    <main class="content" id="main"></main></div></div>`;
}
async function updateShell(active) {
  document.getElementById('who-name').textContent = `${S.user.name}`;
  document.getElementById('who-org').textContent = `${S.org.name} · ${S.org.typeLabel}`;
  document.getElementById('clock').textContent = new Date(S.now).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + (S.clockOffset ? ` (+${Math.round(S.clockOffset / 3600e3)}h)` : '');
  let wq = 0; try { wq = (await api.q('workQueue')).length; } catch {}
  document.getElementById('nav').innerHTML = NAV.map(([g, items]) => {
    const vis = items.filter(([, , roles]) => navAllowed(roles)).filter(([k]) => k !== 'config' || S.user.admin);
    if (!vis.length) return '';
    return `<div class="nav-group">${g}</div>` + vis.map(([k, l]) => `<a href="#${k}" class="${active === k || (active === 'bl' && k === 'shipments') || (active === 'voyage' && k === 'voyages') ? 'active' : ''}">${l}${k === 'home' && wq ? `<span class="count">${wq}</span>` : k === 'inbox' && S.unread ? `<span class="count">${S.unread}</span>` : ''}</a>`).join('');
  }).join('');
  document.getElementById('rail').classList.remove('open');
}

// ------------------------------------------------------------------ login & public pages
function renderLogin() {
  const groups = {};
  for (const o of DEMO_ORGS) (groups[o.type] = groups[o.type] || []).push(o);
  const order = ['NPA', 'CUSTOMS', 'SHIPPING', 'TERMINAL', 'FORWARDER', 'IMPORTER', 'OGA', 'BANK', 'TRANSPORTER', 'AUDIT'];
  const personas = order.flatMap((t) => (groups[t] || []).slice(0, t === 'OGA' ? 2 : 1).flatMap((o) => [[o.admin, o], ...(o.extra || []).map((x) => [x, o])]));
  app().innerHTML = `<div class="login">
    <section class="login-hero"><div class="brand" style="padding:0">${LOGO}<div><b>${BRAND}</b><span>Port Community System</span></div></div>
      <h1>One platform for every port transaction, from manifest to gate-out.</h1>
      <p>Shipping lines, terminals, Customs, agencies, forwarders, banks and hauliers work on the same shipment record. Data is captured once, approvals run in parallel, payments are consolidated, and every action lands in a tamper-evident audit trail.</p>
      ${flowHtml(STEPS.map(([n, label, who]) => ({ n, label, who })))}
      <p class="small">Showcase build: seeded with 5 vessel calls, 17 bills of lading and 20 organisations. Payments, e-mail, SMS and partner systems are simulated.</p></section>
    <section class="login-side">
      <div><div class="eyebrow">Sign in as a demo participant</div><h2 style="margin-top:4px">Pick a role to see its work queue</h2><p class="muted small" style="margin:4px 0 0">Every role sees only its own shipments, actions and data. Password for all demo users: <span class="mono">${DEMO_PASSWORD}</span></p></div>
      <div class="personas">${personas.map(([[name, email, title], o]) => `<button class="persona" data-act="persona" data-email="${esc(email)}"><b>${esc(ORG_TYPES[o.type].short)}${o.category ? ' · ' + esc(titleCase(o.category)) : ''}: ${esc(name)}</b><span>${esc(title)}, ${esc(o.name)}</span></button>`).join('')}</div>
      <form class="panel stack" data-form="login"><h3>Or sign in with email</h3><div class="form-grid">${field('email', 'Email', { type: 'email', required: true, attrs: 'autocomplete="username"' })}${field('password', 'Password', { type: 'password', required: true, attrs: 'autocomplete="current-password"' })}</div><div class="row"><button class="btn primary" type="submit">Sign in</button><a class="btn ghost" href="#register">Register an organisation</a><a class="btn ghost" href="#track">Track cargo</a></div></form>
    </section></div>`;
}

async function renderPublic(kind) {
  const back = `<a class="btn sm" href="#">← Back to sign in</a>`;
  if (kind === 'track') {
    app().innerHTML = `<div class="content" style="margin:0 auto;max-width:860px"><div class="row">${back}</div><div class="page-head"><div><h1>Track cargo</h1><p>Public status by bill of lading or container number. No commercial or Customs data is shown.</p></div></div>
      <form class="panel row" data-form="track"><input name="ref" id="f-ref" placeholder="e.g. AMLU046W001 or a container number" style="flex:1" value="${esc(view.trackRef || '')}" aria-label="B/L or container number"><button class="btn primary">Track</button></form><div id="track-out"></div></div>`;
    if (view.trackRef) doTrack(view.trackRef);
    return;
  }
  app().innerHTML = `<div class="content" style="margin:0 auto;max-width:860px"><div class="row">${back}</div><div class="page-head"><div><h1>Register your organisation</h1><p>Commercial participants apply online. The Port Authority verifies CAC and TIN before access is granted. Government agencies are onboarded by the Port Authority.</p></div></div>
    <form class="panel stack" data-form="register"><div class="form-grid">
      ${field('name', 'Organisation name', { required: true })}${field('type', 'Organisation type', { opts: ['SHIPPING', 'TERMINAL', 'FORWARDER', 'IMPORTER', 'BANK', 'TRANSPORTER'].map((t) => [t, ORG_TYPES[t].label]) })}
      ${field('rcNumber', 'CAC registration number', { required: true, placeholder: 'RC 123456' })}${field('tin', 'Tax identification number (TIN)', { required: true, placeholder: '12345678-0001' })}
      ${field('email', 'Organisation email', { type: 'email', required: true })}${field('phone', 'Phone', { placeholder: '+234…' })}
      ${field('port', 'Port (terminal operators)', { opts: [['', '–'], ...Object.entries(PORTS).map(([k, p]) => [k, p.name])] })}${field('address', 'Address')}
      ${field('adminName', 'Administrator name', { required: true })}${field('adminEmail', 'Administrator email', { type: 'email', required: true })}
      ${field('password', 'Password (8+ characters)', { type: 'password', required: true })}</div>
      <div class="row"><button class="btn primary">Submit application</button></div><div id="reg-out"></div></form></div>`;
}
async function doTrack(ref) {
  const out = document.getElementById('track-out'); if (!out) return;
  const r = await api.track(ref).catch((e) => ({ error: e.message }));
  if (!r || r.notFound || r.error) { out.innerHTML = `<div class="panel empty">No shipment found for “${esc(ref)}”.</div>`; return; }
  const order = [['manifested', 'Manifested'], ['discharged', 'Discharged to yard'], ['declared', 'Declared to Customs'], ['customsReleased', 'Customs released'], ['terminalReleased', 'Terminal released'], ['releaseOrdered', 'Release order issued'], ['gateOutAll', 'Left the port'], ['delivered', 'Delivered']];
  out.innerHTML = `<div class="panel stack"><div class="row"><h2 class="mono">${esc(r.blNo)}</h2>${stagePill(r.stage)}</div><div class="muted">${esc(r.vessel)} voy. ${esc(r.voyageNo)} · ${esc(r.port)}</div>
    <div class="tl">${order.map(([k, l]) => `<div class="te ${r.milestones[k] ? '' : 'sys'}"><div class="t">${r.milestones[k] ? dt(r.milestones[k]) : 'pending'}</div><div class="dot"></div><div class="s" style="${r.milestones[k] ? '' : 'color:var(--muted)'}">${l}</div></div>`).join('')}</div>
    <div class="table-wrap"><table><tr><th>Container</th><th>Size</th><th>Status</th></tr>${r.containers.map((c) => `<tr><td class="mono">${esc(c.no)}</td><td>${c.size}ft</td><td>${statusPill(c.status)}</td></tr>`).join('')}</table></div></div>`;
}

// ------------------------------------------------------------------ events
const ACT = {}; const FORMS = {};
async function onClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) { const tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('a,button,input,label')) go(tr.dataset.href); return; }
  e.preventDefault(); const fn = ACT[t.dataset.act]; if (fn) { try { await fn(t.dataset, t, e); } catch (err) { toast(err.message, 'err', errList(err)); } }
}
async function onSubmit(e) {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault(); const fn = FORMS[f.dataset.form]; if (fn) { try { await fn(new FormData(f), f); } catch (err) { toast(err.message, 'err', errList(err)); } }
}
const fd2o = (fd) => Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
async function cmd(type, payload, okMsg) { const r = await api.cmd(type, payload); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; }

FORMS.login = async (fd) => { const { email, password } = fd2o(fd); await api.login(email, password); S = await api.q('session'); location.hash = 'home'; render(); };
ACT.persona = async ({ email }) => { await api.login(email, DEMO_PASSWORD); S = await api.q('session'); toast(`Signed in as ${S.user.name}, ${S.org.name}`); location.hash = 'home'; document.querySelector('.shell')?.remove(); render(); };
ACT.logout = () => { api.logout(); S = null; location.hash = ''; render(); };
ACT.switch = () => { api.logout(); S = null; location.hash = ''; renderLogin(); };
ACT.menu = () => document.getElementById('rail').classList.toggle('open');
ACT.go = ({ href }) => go(href);
ACT.tab = ({ group, tab }) => { view.tab[group] = tab; document.querySelectorAll(`[data-pane][data-group="${group}"]`).forEach((p) => (p.hidden = p.dataset.pane !== tab)); document.querySelectorAll(`.tabs button[data-group="${group}"]`).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab)); };
FORMS.search = (fd) => { view.shipQ = fd.get('q'); go('shipments'); };
FORMS.track = (fd) => { view.trackRef = fd.get('ref'); doTrack(view.trackRef); };
FORMS.register = async (fd, f) => { const r = await api.register(fd2o(fd)); f.querySelector('#reg-out').innerHTML = `<div class="note">Application received (${esc(r.orgId)}). Status: <b>${esc(r.status)}</b>. The Port Authority has been notified to verify your CAC and TIN. Sign in as the Port Authority administrator to approve it.</div>`; f.reset(); };

const tabs = (group, items, def) => `<div class="tabs" role="tablist" data-default="${def}">${items.map(([k, l]) => `<button type="button" data-act="tab" data-group="${group}" data-tab="${k}">${l}</button>`).join('')}</div>`;
const pane = (group, key, def, html) => `<div data-pane="${key}" data-group="${group}" data-default="${def}">${html}</div>`;
const head = (title, sub, actions = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`;
const tile = (v, l, unit = '') => `<div class="tile"><span class="v num">${v ?? '–'}${unit ? `<small>${unit}</small>` : ''}</span><span class="l">${l}</span></div>`;

// ------------------------------------------------------------------ views
const VIEWS = {};

VIEWS.home = async () => {
  const [wq, k, notes] = await Promise.all([api.q('workQueue'), api.q('kpis'), api.q('notifications')]);
  const mine = MY_STEPS[S.org.type] || [];
  return `${head(`Work queue`, `${esc(S.org.name)} · ${esc(S.org.typeLabel)}. Items appear here when a shipment needs your organisation’s action.`)}
  <div class="split"><div class="panel"><div class="panel-head"><h2>Needs your action <span class="muted num">(${wq.length})</span></h2></div>
    ${wq.length ? `<div class="queue">${wq.map((i) => `<div class="qi"><span class="step" title="Step ${i.step} of 12">${String(i.step || '').padStart(2, '0')}</span><div style="min-width:0"><b>${esc(i.title)}</b><span>${esc(i.detail)}</span>${i.due ? `<div class="tiny ${i.overdue ? 'overdue' : 'muted'}">${i.overdue ? 'SLA breached · was due ' : 'SLA due '}${dt(i.due)}</div>` : ''}</div><button class="btn action sm" data-act="go" data-href="${refHref(i.ref)}">${esc(i.action)}</button></div>`).join('')}</div>` : `<div class="empty">Nothing is waiting on ${esc(S.org.name)} right now.</div>`}</div>
    <div class="stack"><div class="grid g2">${tile(k.totals.active, 'Active shipments')}${tile(hrs(k.avg.clearanceHours), 'Avg Customs clearance')}${tile(hrs(k.avg.dwellHours), 'Avg port dwell')}${tile(k.reusePct, 'Declaration data reused', '%')}</div>
      <div class="panel"><div class="panel-head"><h3>Latest notifications</h3><a href="#inbox" class="small">All</a></div>${notes.slice(0, 6).map((n) => `<div style="padding:7px 0;border-top:1px solid var(--line)"><div class="row"><b class="small" style="flex:1">${esc(n.title)}</b><span class="tiny muted">${ago(n.at, S.now)}</span></div><div class="small muted">${esc(n.body)}</div></div>`).join('') || '<div class="empty">No notifications</div>'}</div></div></div>
  <div class="panel"><div class="panel-head"><div><h2>The 12-step port transaction</h2><div class="muted small">Outlined steps are where ${esc(S.org.typeLabel.toLowerCase())} users act.</div></div><a class="btn sm" href="#shipments">Follow a shipment</a></div>${flowHtml(STEPS.map(([n, label, who]) => ({ n, label, who })), mine)}</div>`;
};
const refHref = (r) => (r.type === 'bl' ? `bl-${r.id}` : r.type === 'voyage' ? `voyage-${r.id}` : r.type === 'admin' ? 'access' : r.type === 'gate' ? 'gate' : r.type === 'payments' ? 'payments' : r.type === 'service' ? 'requests' : 'home');

VIEWS.shipments = async () => {
  const list = await api.q('shipments', { q: view.shipQ || '', stage: view.shipStage || '' });
  return `${head('Shipments', 'Every bill of lading your organisation is a party to, with its live stage across all agencies.', can('manifest.submit') ? `<a class="btn primary" href="#voyages">File a manifest</a>` : '')}
  <form class="row" data-form="shipfilter"><input name="q" id="f-shipq" value="${esc(view.shipQ || '')}" placeholder="Filter by B/L, container, consignee…" style="flex:1 1 240px" aria-label="Filter"><select name="stage" id="f-shipstage" aria-label="Stage"><option value="">All stages</option>${Object.entries(STAGES).map(([k, [l]]) => `<option value="${k}" ${view.shipStage === k ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="btn">Apply</button>${view.shipQ || view.shipStage ? `<button class="btn ghost" type="button" data-act="clearship">Clear</button>` : ''}</form>
  <div class="table-wrap"><table><thead><tr><th>B/L</th><th>Consignee</th><th>Cargo</th><th>Vessel / voyage</th><th class="r">Ctrs</th><th>Lane</th><th>Stage</th><th class="r">Unpaid</th><th>Updated</th></tr></thead><tbody>
  ${list.map((b) => `<tr class="click" data-href="bl-${b.id}"><td class="mono"><a href="#bl-${b.id}">${esc(b.blNo)}</a></td><td>${esc(b.consignee)}<div class="tiny muted">${esc(b.forwarder || 'No forwarder')}</div></td><td>${esc(b.description)}<div class="tiny muted">HS ${esc(b.hsCode)}</div></td><td>${esc(b.vessel)} <span class="muted">${esc(b.voyageNo)}</span><div class="tiny muted">${esc(PORTS[b.port].name)}</div></td><td class="r">${b.containers} <span class="muted tiny">(${b.teu} TEU)</span></td><td>${lane(b.lane)}</td><td>${stagePill(b.stage)}</td><td class="r">${b.unpaid ? money(b.unpaid) : '<span class="muted">–</span>'}</td><td class="small muted">${ago(b.updatedAt, S.now)}</td></tr>`).join('') || `<tr><td colspan="9" class="empty">No shipments match.</td></tr>`}</tbody></table></div>`;
};
FORMS.shipfilter = (fd) => { view.shipQ = fd.get('q'); view.shipStage = fd.get('stage'); render(); };
ACT.clearship = () => { view.shipQ = ''; view.shipStage = ''; render(); };

// ---------------- shipment detail
VIEWS.bl = async (id) => {
  const d = await api.q('shipment', { id }); if (!d) return `<div class="panel empty">Shipment not found or not visible to your organisation.</div>`;
  view.cur = d;
  const { bl, voyage: v, declaration: decl } = d;
  const acts = blActions(d);
  const steps = blSteps(d);
  const unpaidMine = d.invoices.filter((i) => i.status === 'UNPAID' && i.payerOrgId === S.org.id);
  return `<div class="row"><a href="#shipments" class="small">← Shipments</a></div>
  <div class="page-head"><div><div class="eyebrow">Bill of lading · trace TRC-${esc(bl.blNo)}</div><div class="row" style="margin-top:2px"><h1 class="mono">${esc(bl.blNo)}</h1>${stagePill(bl.stage)}${decl ? lane(decl.lane) : ''}</div><p>${esc(bl.description)} · ${bl.containerIds.length} container(s) · ${esc(v.vesselName)} voy. ${esc(v.voyageNo)} → ${esc(v.portName)}</p></div>
    <div class="row">${acts.map((a) => `<button class="btn ${a.primary ? 'action' : ''}" data-act="${a.act}" ${a.data || ''}>${esc(a.label)}</button>`).join('')}</div></div>
  <div class="panel">${flowHtml(steps)}</div>
  <div class="split"><div class="stack">
    ${tabs('bl', [['ov', 'Overview'], ['ctr', `Containers (${d.containers.length})`], ['decl', 'Declaration'], ['svc', `Requests (${d.services.length})`], ['inv', `Charges (${d.invoices.length})`], ['tl', `Timeline (${d.timeline.length})`]], 'ov')}
    ${pane('bl', 'ov', 'ov', `<div class="grid g2"><div class="panel"><h3>Cargo & parties</h3><dl class="kv"><dt>Shipper</dt><dd>${esc(bl.shipper)}</dd><dt>Consignee</dt><dd>${esc(bl.consigneeName)}${bl.consigneeOrgId ? ' <span class="reuse-tag">registered</span>' : ''}<div class="tiny muted">TIN ${esc(bl.consigneeTin || '–')}</div></dd><dt>Notify</dt><dd>${esc(bl.notifyParty)}</dd><dt>Forwarder</dt><dd>${esc(bl.forwarder || 'Not nominated')}</dd><dt>Goods</dt><dd>${esc(bl.description)}</dd><dt>HS heading</dt><dd class="mono">${esc(bl.hsCode)} <span class="muted">${esc(d.tariff?.desc || '')}</span></dd><dt>Packages</dt><dd class="num">${bl.packages} ${esc(bl.packageType)}</dd><dt>Gross weight</dt><dd class="num">${bl.grossWeightKg.toLocaleString()} kg</dd><dt>Port of loading</dt><dd class="mono">${esc(bl.portOfLoading)}</dd></dl></div>
      <div class="panel"><h3>Vessel call</h3><dl class="kv"><dt>Vessel</dt><dd><a href="#voyage-${v.id}">${esc(v.vesselName)}</a> <span class="mono muted">IMO ${esc(v.imo)}</span></dd><dt>Voyage</dt><dd>${esc(v.voyageNo)}</dd><dt>Carrier</dt><dd>${esc(v.shipping)}</dd><dt>Terminal</dt><dd>${esc(v.terminal)}</dd><dt>Berth</dt><dd class="mono">${esc(v.berth || 'Not allocated')}</dd><dt>ETA / ATA</dt><dd>${dt(v.eta)} / ${dt(v.ata)}</dd><dt>Status</dt><dd>${statusPill(v.status)}</dd></dl>
      ${d.releaseOrder ? `<div class="note" style="margin-top:12px">Release order <b class="mono">${esc(d.releaseOrder.no)}</b> issued ${dt(d.releaseOrder.at)}.</div>` : ''}
      ${bl.deliveryOrder?.no ? `<div class="note" style="margin-top:8px">Delivery order <b class="mono">${esc(bl.deliveryOrder.no)}</b> issued ${dt(bl.deliveryOrder.issuedAt)}.</div>` : ''}
      ${bl.kpi ? `<div class="grid g2" style="margin-top:12px">${tile(hrs(bl.kpi.dwellHours), 'Port dwell')}${tile(hrs(bl.kpi.clearanceHours), 'Customs clearance')}</div>` : ''}</div></div>`)}
    ${pane('bl', 'ctr', 'ov', `<div class="table-wrap"><table><tr><th>Container</th><th>Size/type</th><th>Seal</th><th>Location</th><th>Status</th><th>Gate pass</th><th>Truck</th></tr>${d.containers.map((c) => `<tr><td class="mono">${esc(c.no)}</td><td>${c.size}ft ${esc(c.type)}</td><td class="mono small">${esc(c.sealNo)}</td><td class="mono">${esc(c.location || (c.status === 'GATED_OUT' ? 'Out ' + dt(c.gateOutAt) : '–'))}</td><td>${statusPill(c.status)}</td><td>${c.gatePass ? `<span class="mono">${esc(c.gatePass.token)}</span> ${statusPill(c.gatePass.status)}<div class="tiny muted">valid to ${dt(c.gatePass.expiresAt)}</div>` : '<span class="muted">–</span>'}</td><td>${(c.gatePass?.truck || bl.trucks.find((t) => t.containerNo === c.no)) ? (() => { const t = c.gatePass?.truck || bl.trucks.find((x) => x.containerNo === c.no); return `<span class="mono">${esc(t.plate)}</span><div class="tiny muted">${esc(t.driver)}, slot ${dt(t.slotAt)}</div>`; })() : '<span class="muted">–</span>'}</td></tr>`).join('')}</table></div>
      ${d.containers.some((c) => c.moves.length) ? `<div class="panel"><h3>Container moves</h3><div class="table-wrap"><table><tr><th>Time</th><th>Container</th><th>From</th><th>To</th><th>Reason</th></tr>${d.containers.flatMap((c) => c.moves.map((m) => ({ ...m, no: c.no }))).sort((a, b) => a.at - b.at).map((m) => `<tr><td class="small">${dt(m.at)}</td><td class="mono">${esc(m.no)}</td><td class="mono">${esc(m.from || '–')}</td><td class="mono">${esc(m.to || '–')}</td><td>${esc(m.reason)}</td></tr>`).join('')}</table></div></div>` : ''}`)}
    ${pane('bl', 'decl', 'ov', declHtml(d))}
    ${pane('bl', 'svc', 'ov', d.services.length ? `<div class="table-wrap"><table><tr><th>Request</th><th>From → To</th><th>Status</th><th>Requested</th><th>SLA</th><th>Decision</th></tr>${d.services.map((s) => `<tr><td><b>${esc(s.label)}</b><div class="tiny muted mono">${esc(s.id)}</div></td><td class="small">${esc(s.requester)} → ${esc(s.decider)}</td><td>${statusPill(s.status)}</td><td class="small">${dt(s.requestedAt)}</td><td class="small">${s.decidedAt ? (s.slaMet ? '<span class="pill ok">Met</span>' : '<span class="pill bad">Breached</span>') : S.now > s.slaDueAt ? '<span class="pill bad">Overdue</span>' : 'due ' + dt(s.slaDueAt)}</td><td class="small">${s.decision ? esc(s.decision.note || '') : ''}${s.deciderOrgId === S.org.id && s.status === 'PENDING' ? `<button class="btn action sm" data-act="decide" data-id="${s.id}">Decide</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="panel empty">No service requests yet.</div>')}
    ${pane('bl', 'inv', 'ov', d.invoices.length ? `<div class="table-wrap"><table><tr><th>Invoice</th><th>Charge</th><th>Beneficiary</th><th>Status</th><th class="r">Amount</th></tr>${d.invoices.map((i) => `<tr><td class="mono small">${esc(i.no)}<div class="tiny muted">RRR ${esc(i.rrr)}</div></td><td>${esc(i.label)}<div class="tiny muted">${i.lines.map((l) => esc(l.desc)).join(' · ')}</div></td><td class="small">${esc(i.beneficiary)}</td><td>${statusPill(i.status)}</td><td class="r">${money(i.total)}</td></tr>`).join('')}<tr><td colspan="4" class="r"><b>Total</b> <span class="muted small">(unpaid ${money(d.invoices.filter((i) => i.status === 'UNPAID').reduce((a, i) => a + i.total, 0))})</span></td><td class="r"><b>${money(d.invoices.reduce((a, i) => a + i.total, 0))}</b></td></tr></table></div>${unpaidMine.length ? `<div class="row"><button class="btn action" data-act="pay" data-ids="${unpaidMine.map((i) => i.id).join(',')}">Pay ${unpaidMine.length} invoice(s) in one transaction</button></div>` : ''}` : '<div class="panel empty">No charges yet. Invoices are raised automatically as each party’s service is rendered.</div>')}
    ${pane('bl', 'tl', 'ov', `<div class="panel">${timelineHtml(d.timeline)}</div>`)}
  </div>
  <div class="stack"><div class="panel"><div class="panel-head"><h3>Release conditions</h3>${d.checklist.released ? '<span class="pill ok">Released</span>' : d.checklist.ready ? '<span class="pill act">Ready for release order</span>' : `<span class="pill">${d.checklist.items.filter((i) => i.ok).length}/7 met</span>`}</div>
    <div class="check">${d.checklist.items.map((i) => `<div class="ck ${i.ok ? 'ok' : 'no'}"><span class="ico">${i.ok ? '✓' : ''}</span><div><b class="small">${esc(i.label)}</b><small>${esc(i.detail || (i.ok ? 'Done' : 'Pending'))}</small></div><span class="tiny muted">${esc(ORG_TYPES[i.owner]?.short || '')}</span></div>`).join('')}</div>
    <p class="tiny muted" style="margin:8px 0 0">The Port Authority issues one release order when all seven are met, replacing separate paper approvals.</p></div>
    ${d.permits.length || bl.permitsRequired.length ? `<div class="panel"><h3>Agency permits</h3>${bl.permitsRequired.map((cat) => { const p = d.permits.find((x) => x.cat === cat); return `<div class="row" style="padding:6px 0"><b class="small" style="flex:1">${esc(titleCase(cat))}</b>${p ? statusPill(p.status) : '<span class="pill act">Not requested</span>'}${p?.no ? `<span class="mono tiny">${esc(p.no)}</span>` : ''}</div>`; }).join('')}</div>` : ''}
  </div></div>`;
};

function declHtml(d) {
  const x = d.declaration;
  if (!x) return `<div class="panel empty">No declaration yet. ${isType('FORWARDER', 'IMPORTER') && (d.bl.forwarderOrgId === S.org.id || d.bl.consigneeOrgId === S.org.id) ? `<div style="margin-top:10px"><button class="btn action" data-act="lodge">Lodge declaration (pre-filled from manifest)</button></div>` : ''}</div>`;
  const total = x.valuation.lines.reduce((a, l) => a + l.amount, 0);
  return `<div class="grid g2"><div class="panel"><div class="panel-head"><h3 class="mono">${esc(x.no)}</h3>${statusPill(x.status)}</div><dl class="kv"><dt>Lodged</dt><dd>${dt(x.lodgedAt)}${x.preArrival ? ' <span class="pill info">Pre-arrival</span>' : ''}</dd><dt>Procedure</dt><dd>${esc(x.cpc)} ${esc(CPC[x.cpc] || '')}</dd><dt>Form M</dt><dd class="mono">${esc(x.formMNo)}</dd><dt>Origin</dt><dd>${esc(x.originCountry)}</dd><dt>HS heading</dt><dd class="mono">${esc(x.hsCode)}</dd><dt>FOB</dt><dd>${usd(x.fobValueUsd)}</dd><dt>CIF</dt><dd>${usd(x.valuation.cifUsd)} → ${money(x.valuation.cifNgn)} <span class="tiny muted">@ ${x.valuation.fxRate} <span class="guess">GUESS</span></span></dd><dt>Data reuse</dt><dd><b>${x.reuse.prefilled}</b> fields reused from the manifest, <b>${x.reuse.entered}</b> typed</dd>${x.releaseNo ? `<dt>Customs release</dt><dd class="mono">${esc(x.releaseNo)} · ${dt(x.releasedAt)}</dd>` : ''}</dl></div>
    <div class="panel"><h3>Assessment</h3><div class="table-wrap" style="border:0"><table>${x.valuation.lines.map((l) => `<tr><td>${esc(l.desc)}</td><td class="r">${money(l.amount)}</td></tr>`).join('')}<tr><td><b>Total duty & taxes</b></td><td class="r"><b>${money(total)}</b></td></tr></table></div>
    <div style="margin-top:12px"><div class="row"><b class="small">Risk lane</b>${lane(x.lane)}${x.risk.score != null ? `<span class="muted small">score ${x.risk.score}</span>` : ''}</div>
    ${x.risk.hidden ? `<p class="tiny muted">Risk rules are confidential to Customs. ${x.lane === 'GREEN' ? 'Green: released automatically once duty is paid.' : x.lane === 'YELLOW' ? 'Yellow: documentary check by Customs.' : 'Red: joint physical examination.'}</p>` : `<ul class="small" style="margin:6px 0 0;padding-left:18px">${x.risk.reasons.map((r) => `<li><span class="mono">${r.pts > 0 ? '+' : ''}${r.pts}</span> ${esc(r.why)}</li>`).join('')}</ul>`}</div></div>
    ${x.queries.length ? `<div class="panel" style="grid-column:1/-1"><h3>Customs queries</h3>${x.queries.map((q) => `<div style="padding:8px 0;border-top:1px solid var(--line)"><div class="small"><b>Customs, ${dt(q.at)}:</b> ${esc(q.question)}</div>${q.answer ? `<div class="small" style="margin-top:4px"><b>Declarant, ${dt(q.answer.at)}:</b> ${esc(q.answer.text)} ${(q.answer.documents || []).map((f) => `<span class="pill info">${esc(f)}</span>`).join(' ')}</div>` : '<div class="small muted">Awaiting response</div>'}</div>`).join('')}</div>` : ''}
    ${x.exam ? `<div class="panel" style="grid-column:1/-1"><h3>Examination</h3><div class="small">${statusPill(x.exam.finding)} ${dt(x.exam.at)}: ${esc(x.exam.note)}</div></div>` : ''}</div>`;
}
function timelineHtml(tl) { return tl.length ? `<div class="tl">${tl.map((e) => `<div class="te ${e.system ? 'sys' : ''}"><div class="t">${dt(e.at)}</div><div class="dot"></div><div><div class="s">${esc(e.summary)}</div><div class="by">${esc(e.by)} · #${e.n} <span class="hash">${e.hash.slice(0, 16)}…</span></div></div></div>`).join('')}</div>` : '<div class="empty">No events</div>'; }

function blActions(d) {
  const { bl, declaration: x, voyage: v } = d; const me = S.org.id; const a = [];
  const cargo = bl.forwarderOrgId === me || bl.consigneeOrgId === me;
  const pend = (type) => d.services.find((s) => s.type === type && s.status === 'PENDING' && s.deciderOrgId === me);
  if (cargo && isType('FORWARDER', 'IMPORTER')) {
    if (!x) a.push({ act: 'lodge', label: 'Lodge declaration', primary: true });
    if (x?.status === 'QUERIED' && x.lodgedBy === me) a.push({ act: 'respond', label: 'Answer Customs query', primary: true });
    const unpaid = d.invoices.filter((i) => i.status === 'UNPAID' && i.payerOrgId === me); if (unpaid.length) a.push({ act: 'pay', label: `Pay ${money(unpaid.reduce((s, i) => s + i.total, 0))}`, primary: true, data: `data-ids="${unpaid.map((i) => i.id).join(',')}"` });
    if (x && bl.permitsRequired.some((c) => !d.permits.find((p) => p.cat === c && p.status !== 'REJECTED'))) a.push({ act: 'permit', label: 'Request permit' });
    if (x && (!bl.deliveryOrder || bl.deliveryOrder.status === 'REJECTED')) a.push({ act: 'reqdo', label: 'Request delivery order' });
    if (bl.milestones.customsReleased && !d.services.some((s) => s.type === 'TRUCK_BOOKING' && s.status !== 'REJECTED')) a.push({ act: 'trucks', label: 'Book trucks' });
    if (bl.milestones.gateOutAll && !bl.milestones.delivered) a.push({ act: 'deliver', label: 'Confirm delivery', primary: true });
  }
  if (isType('SHIPPING') && v.shippingOrgId === me && !x) a.push({ act: 'amend', label: 'Amend B/L' });
  if (isType('CUSTOMS') && x?.status === 'AWAITING_REVIEW') a.push({ act: 'review', label: 'Review declaration', primary: true });
  if (isType('CUSTOMS') && x?.status === 'AWAITING_EXAM' && x.examReady) a.push({ act: 'exam', label: 'Record examination', primary: true });
  if (isType('TERMINAL') && v.terminalOrgId === me && bl.milestones.customsReleased && bl.milestones.discharged && !bl.milestones.terminalReleased) a.push({ act: 'termrel', label: 'Grant terminal release', primary: true });
  if (isType('TERMINAL') && v.terminalOrgId === me && bl.milestones.releaseOrdered && !bl.milestones.gateOutAll) a.push({ act: 'go', label: 'Open gate', data: 'data-href="gate"' });
  if (isType('NPA') && d.checklist.ready && !bl.milestones.releaseOrdered) a.push({ act: 'release', label: 'Issue release order', primary: true });
  for (const t of ['DELIVERY_ORDER', 'EXAM_POSITION', 'PERMIT', 'TRUCK_BOOKING']) { const s = pend(t); if (s) a.push({ act: 'decide', label: `Decide: ${s.label}`, primary: true, data: `data-id="${s.id}"` }); }
  return a;
}

// ---- shipment actions
ACT.lodge = async () => {
  const d = view.cur; const b = d.bl, v = d.voyage;
  openModal({ title: `Lodge declaration for ${b.blNo}`, sub: 'Fields marked <span class="reuse-tag">reused</span> come from the manifest and the common data repository. You only add what the manifest does not hold.', wide: true, submit: 'Lodge and assess',
    body: `<div class="form-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${[['B/L', b.blNo], ['Vessel / voyage', `${v.vesselName} ${v.voyageNo}`], ['Port of loading', b.portOfLoading], ['Shipper', b.shipper], ['Consignee', b.consigneeName], ['Consignee TIN', b.consigneeTin], ['Goods', b.description], ['HS heading', `${b.hsCode} ${d.tariff?.desc || ''}`], ['Packages', `${b.packages} ${b.packageType}`], ['Gross weight', `${b.grossWeightKg} kg`], ['Containers', d.containers.map((c) => c.no).join(', ')], ['Agency permits', (d.tariff?.permits || []).join(', ') || 'None']].map(([l, val]) => prefilled(l, val)).join('')}</div>
      <h3>Declarant entries</h3><div class="form-grid">${field('fobValueUsd', 'FOB value (USD)', { type: 'number', required: true, attrs: 'min="1" step="any"' })}${field('freightUsd', 'Freight (USD, optional)', { type: 'number', attrs: 'min="0" step="any"', hint: 'If left blank, CIF is estimated as FOB × 1.10 <span class="guess">GUESS</span>' })}${field('insuranceUsd', 'Insurance (USD, optional)', { type: 'number', attrs: 'min="0" step="any"' })}${field('formMNo', 'Form M number', { required: true, value: 'MF2026' + String(Math.floor(1000 + Math.random() * 8999)) })}${field('cpc', 'Customs procedure', { opts: Object.entries(CPC).map(([k, l]) => [k, `${k} ${l}`]) })}${field('originCountry', 'Country of origin (ISO code)', { required: true, value: (b.portOfLoading || '').slice(0, 2), attrs: 'maxlength="2"' })}</div>
      <details><summary class="small">Correct manifest data (increases Customs scrutiny)</summary><div class="form-grid" style="margin-top:8px">${field('hsCode', 'HS heading', { opts: [['', `Keep ${b.hsCode}`], ...Object.entries(TARIFF).map(([k, t]) => [k, `${k} ${t.desc}`])] })}${field('grossWeightKg', 'Gross weight (kg)', { type: 'number', placeholder: String(b.grossWeightKg) })}</div></details>`,
    onSubmit: async (fd) => { const o = fd2o(fd); const r = await cmd('declaration.lodge', { blId: b.id, fobValueUsd: Number(o.fobValueUsd), freightUsd: o.freightUsd || null, insuranceUsd: o.insuranceUsd || null, formMNo: o.formMNo, cpc: o.cpc, originCountry: o.originCountry.toUpperCase(), hsCode: o.hsCode || undefined, grossWeightKg: o.grossWeightKg ? Number(o.grossWeightKg) : undefined }); toast(`Declaration lodged and assessed: ${r.lane} lane. Duty and port dues invoices raised.`); view.tab.bl = 'decl'; } });
};
ACT.respond = () => { const x = view.cur.declaration; openModal({ title: `Answer query on ${x.no}`, sub: esc(x.queries.at(-1).question), body: `${field('note', 'Response', { type: 'textarea', required: true, value: 'Supplier invoice and packing list attached.' })}${field('fobValueUsd', 'Corrected FOB value (USD, optional)', { type: 'number', placeholder: String(x.fobValueUsd) })}${field('docs', 'Attached documents (names, comma separated)', { value: 'supplier-invoice.pdf, packing-list.pdf', hint: 'File storage is simulated in this showcase.' })}`, submit: 'Send response', onSubmit: async (fd) => { const o = fd2o(fd); await cmd('declaration.respond', { declarationId: x.id, note: o.note, fobValueUsd: o.fobValueUsd ? Number(o.fobValueUsd) : undefined, documents: o.docs ? o.docs.split(',').map((s) => s.trim()).filter(Boolean) : [] }, 'Response sent to Customs'); } }); };
ACT.permit = () => { const d = view.cur; const need = d.bl.permitsRequired.filter((c) => !d.permits.find((p) => p.cat === c && p.status !== 'REJECTED')); const ogas = d.options.ogas.filter((o) => need.includes(o.category)); openModal({ title: 'Request agency permit', sub: `Required for HS ${d.bl.hsCode}: ${need.join(', ')}`, body: `${field('toOrgId', 'Agency', { opts: ogas.map((o) => [o.id, `${o.name} (${titleCase(o.category)})`]) })}${field('note', 'Supporting note', { type: 'textarea', value: 'Certificate of analysis and product registration attached.' })}`, submit: 'Send request', onSubmit: async (fd) => { await cmd('service.request', { type: 'PERMIT', blId: d.bl.id, ...fd2o(fd) }, 'Permit request sent'); } }); };
ACT.reqdo = () => { const d = view.cur; openModal({ title: 'Request delivery order', sub: `From ${esc(d.voyage.shipping)}`, body: field('note', 'Note to carrier', { type: 'textarea', value: 'Original B/L surrendered electronically. Freight prepaid.' }), submit: 'Send request', onSubmit: async (fd) => { await cmd('service.request', { type: 'DELIVERY_ORDER', blId: d.bl.id, ...fd2o(fd) }, 'Delivery order requested'); } }); };
ACT.trucks = () => { const d = view.cur; openModal({ title: 'Book trucks (call-up)', sub: `${d.containers.length} container(s) to collect from ${esc(d.voyage.terminal)}`, body: `${field('toOrgId', 'Transporter', { opts: d.options.transporters.map((o) => [o.id, o.name]) })}${field('destination', 'Destination', { value: 'Ikeja warehouse, Lagos' })}`, submit: 'Send booking', onSubmit: async (fd) => { await cmd('service.request', { type: 'TRUCK_BOOKING', blId: d.bl.id, ...fd2o(fd) }, 'Truck booking sent to transporter'); } }); };
ACT.deliver = () => { const d = view.cur; openModal({ title: `Confirm delivery of ${d.bl.blNo}`, body: field('note', 'Delivery note', { value: 'Received in good order' }), submit: 'Confirm and close shipment', onSubmit: async (fd) => { await cmd('delivery.confirm', { blId: d.bl.id, ...fd2o(fd) }, 'Delivery confirmed. Shipment closed and KPIs recorded.'); } }); };
ACT.amend = () => { const d = view.cur; openModal({ title: `Amend ${d.bl.blNo}`, sub: 'Allowed until the B/L is declared to Customs. Every change is recorded with its reason.', body: `<div class="form-grid">${field('forwarderOrgId', 'Nominated forwarder', { opts: [['', 'None'], ...d.options.forwarders.map((o) => [o.id, o.name])], value: d.bl.forwarderOrgId || '' })}${field('grossWeightKg', 'Gross weight (kg)', { type: 'number', value: d.bl.grossWeightKg })}${field('packages', 'Packages', { type: 'number', value: d.bl.packages })}${field('description', 'Description', { value: d.bl.description })}${field('reason', 'Reason for amendment', { required: true, full: true })}</div>`, submit: 'Save amendment', onSubmit: async (fd) => { const o = fd2o(fd); await cmd('manifest.amend', { blId: d.bl.id, reason: o.reason, changes: { forwarderOrgId: o.forwarderOrgId || null, grossWeightKg: Number(o.grossWeightKg), packages: Number(o.packages), description: o.description } }, 'B/L amended'); } }); };
ACT.review = () => { const x = view.cur.declaration; openModal({ title: `Documentary review: ${x.no}`, sub: `Risk score ${x.risk.score ?? ''}. ${x.risk.reasons ? esc(x.risk.reasons.map((r) => r.why).join('; ')) : ''}`, body: `${field('decision', 'Decision', { opts: [['approve', 'Approve and release'], ['query', 'Raise a query to the declarant'], ['exam', 'Escalate to physical examination']] })}${field('note', 'Note', { type: 'textarea', value: 'Documents verified against supplier invoice.' })}`, submit: 'Record decision', onSubmit: async (fd) => { const o = fd2o(fd); await cmd('declaration.review', { declarationId: x.id, ...o }, o.decision === 'approve' ? 'Declaration released' : o.decision === 'query' ? 'Query sent to declarant' : 'Escalated to examination'); } }); };
ACT.exam = () => { const x = view.cur.declaration; openModal({ title: `Record examination: ${x.no}`, body: `${field('finding', 'Finding', { opts: [['CLEAN', 'Goods as declared (release)'], ['DISCREPANCY', 'Discrepancy found (re-assess)']] })}${field('note', 'Examination note', { type: 'textarea', value: 'Joint examination completed. Goods as declared.' })}<div class="form-grid">${field('revisedFobUsd', 'Revised FOB (USD) if discrepancy', { type: 'number', placeholder: String(x.fobValueUsd) })}${field('revisedHs', 'Revised HS heading', { opts: [['', 'No change'], ...Object.entries(TARIFF).map(([k, t]) => [k, `${k} ${t.desc}`])] })}</div>`, submit: 'Record finding', onSubmit: async (fd) => { const o = fd2o(fd); await cmd('exam.record', { declarationId: x.id, finding: o.finding, note: o.note, revisedFobUsd: o.revisedFobUsd ? Number(o.revisedFobUsd) : undefined, revisedHs: o.revisedHs || undefined }, o.finding === 'CLEAN' ? 'Released after examination' : 'Discrepancy recorded; supplementary invoice raised'); } }); };
ACT.termrel = async () => { const r = await cmd('terminal.release', { blId: view.cur.bl.id }); if (r.held) toast(`Release held: storage/terminal invoice(s) ${r.unpaid.join(', ')} must be paid first. The payer has been notified.`, 'err'); else toast('Terminal release granted'); };
ACT.release = () => { const d = view.cur; openModal({ title: `Issue release order for ${d.bl.blNo}`, sub: 'All seven release conditions are met. Gate passes will be generated for each container.', body: field('note', 'Note', { value: 'All conditions satisfied' }), submit: 'Issue release order', submitClass: 'action', onSubmit: async (fd) => { const r = await cmd('release.approve', { blId: d.bl.id, ...fd2o(fd) }); toast(`Release order ${r.no} issued; gate passes are active.`); } }); };

ACT.decide = async ({ id }) => {
  const svcs = await api.q('services'); const s = svcs.find((x) => x.id === id); if (!s) return toast('Request not found', 'err');
  let extra = '';
  if (s.type === 'BERTH') { const berths = await api.q('berths'); const port = berths.find((p) => p.code === s.port); const free = (b) => !b.voyages.some((v) => ['BERTH_ALLOCATED', 'ARRIVED'].includes(v.status) && v.eta < s.details.etd && s.details.eta < v.etd); extra = field('berth', 'Berth', { opts: port.berths.map((b) => [b.berth, `${b.berth} ${free(b) ? '(free for this window)' : '(occupied)'}`]), value: s.details.preferredBerth || '' }) + `<div class="small muted">Window ${dt(s.details.eta)} to ${dt(s.details.etd)}. Requested: ${esc(s.details.preferredBerth || 'any')}.</div>`; }
  if (s.type === 'PERMIT') extra = field('conditions', 'Conditions (optional)', { value: 'Batch sampling at warehouse' });
  if (s.type === 'TRUCK_BOOKING') { const plates = ['LND-482XY', 'KJA-219AB', 'APP-773KD', 'EPE-104GH']; extra = `<div class="small muted">Destination: ${esc(s.details.destination || '–')}. Plates use the Nigerian format, e.g. LND-482XY.</div><div class="table-wrap"><table><tr><th>Container</th><th>Plate</th><th>Driver</th><th>Phone</th><th>Slot</th></tr>${s.containers.map((c, i) => `<tr><td class="mono">${esc(c)}</td><td><input name="plate_${i}" value="${plates[i % 4]}" aria-label="Plate" style="width:110px"></td><td><input name="driver_${i}" value="${['Musa Ibrahim', 'John Okon', 'Peter Ade', 'Usman Lawal'][i % 4]}" aria-label="Driver"></td><td><input name="phone_${i}" value="+2348030000000" aria-label="Phone" style="width:140px"></td><td><input type="datetime-local" name="slot_${i}" value="${toLocalInput(S.now + 4 * 3600e3)}" aria-label="Slot"></td></tr>`).join('')}</table></div>`; }
  openModal({ title: `${s.label}: ${s.subject}`, sub: `${esc(s.id)} from ${esc(s.requester)} · SLA due ${dt(s.slaDueAt)}${s.details.note ? ' · “' + esc(s.details.note) + '”' : ''}`, wide: s.type === 'TRUCK_BOOKING',
    body: `${field('decision', 'Decision', { opts: [['approve', s.type === 'TRUCK_BOOKING' ? 'Accept and assign trucks' : s.type === 'EXAM_POSITION' ? 'Containers positioned at exam bay' : 'Approve'], ['reject', 'Reject']] })}${extra}${field('note', 'Note (required to reject)', { value: s.type === 'DELIVERY_ORDER' ? 'Freight confirmed paid' : '' })}`, submit: 'Record decision',
    onSubmit: async (fd) => { const o = fd2o(fd); const data = {}; if (o.berth) data.berth = o.berth; if (o.conditions) data.conditions = o.conditions; if (s.type === 'TRUCK_BOOKING') data.assignments = s.containers.map((c, i) => ({ containerNo: c, plate: o[`plate_${i}`], driver: o[`driver_${i}`], phone: o[`phone_${i}`], slotAt: o[`slot_${i}`] ? new Date(o[`slot_${i}`]).getTime() : undefined })); await cmd('service.decide', { serviceId: s.id, decision: o.decision, note: o.note, data }, `${s.label} ${o.decision === 'approve' ? 'approved' : 'rejected'}`); } });
};

ACT.pay = async ({ ids }) => {
  const all = await api.q('invoices'); const invs = all.filter((i) => ids.split(',').includes(i.id)); const total = invs.reduce((a, i) => a + i.total, 0);
  const banks = (await api.q('directory')).orgs.filter((o) => o.type === 'BANK');
  openModal({ title: 'Pay online', sub: `Simulated payment gateway. One transaction settles ${invs.length} invoice(s) to ${new Set(invs.map((i) => i.beneficiary)).size} beneficiaries.`, submit: `Pay ${money(total)}`, submitClass: 'action',
    body: `<div class="table-wrap"><table>${invs.map((i) => `<tr><td class="mono small">${esc(i.no)}</td><td>${esc(i.label)}<div class="tiny muted">to ${esc(i.beneficiary)} · B/L ${esc(i.blNo)}</div></td><td class="r">${money(i.total)}</td></tr>`).join('')}<tr><td colspan="2" class="r"><b>Total</b></td><td class="r"><b>${money(total)}</b></td></tr></table></div>
    <div class="form-grid">${field('bankOrgId', 'Bank / payment provider', { opts: banks.map((b) => [b.id, b.name]) })}${field('method', 'Method', { opts: [['card', 'Card'], ['transfer', 'Bank transfer'], ['ussd', 'USSD'], ['remita', 'Government collection (RRR)']] })}${field('card', 'Card number (test)', { value: '5399 8300 0000 0008' })}${field('exp', 'Expiry / CVV (test)', { value: '12/29 · 123' })}</div>
    <label class="row small"><input type="checkbox" name="decline" id="f-decline"> Simulate a declined payment</label>`,
    onSubmit: async (fd) => { const o = fd2o(fd); const r = await api.cmd('payment.pay', { invoiceIds: invs.map((i) => i.id), bankOrgId: o.bankOrgId, method: o.method, simulateDecline: !!o.decline }); if (r.declined) throw Object.assign(new Error('Payment declined by the issuer (simulated). No invoice was marked paid. Try again without the decline option.'), {}); setTimeout(() => openModal({ title: 'Payment successful', body: `<div class="note">Reference <b class="mono">${esc(r.ref)}</b>. ${money(total)} received. Beneficiaries and the bank have been notified, and every dependent approval was re-evaluated automatically.</div>`, cancel: 'Close' }), 50); } });
};

// ---------------- voyages & berths
VIEWS.voyages = async () => {
  const list = await api.q('voyages');
  return `${head('Vessel calls', 'Vessel call notifications, berth requests, manifests and discharge status.', can('voyage.create') ? `<button class="btn primary" data-act="newvoyage">Notify a vessel call</button>` : '')}
  <div class="table-wrap"><table><thead><tr><th>Vessel</th><th>Voyage</th><th>Port / terminal</th><th>ETA</th><th>Berth</th><th>Status</th><th class="r">B/L</th><th class="r">Discharged</th></tr></thead><tbody>${list.map((v) => `<tr class="click" data-href="voyage-${v.id}"><td><a href="#voyage-${v.id}">${esc(v.vesselName)}</a><div class="tiny muted mono">IMO ${esc(v.imo)}</div></td><td class="mono">${esc(v.voyageNo)}</td><td>${esc(v.portName)}<div class="tiny muted">${esc(v.terminal)}</div></td><td class="small">${dt(v.eta)}</td><td class="mono">${esc(v.berth || '–')}</td><td>${statusPill(v.status)}</td><td class="r">${v.bls}</td><td class="r">${v.discharged}/${v.containers}</td></tr>`).join('')}</tbody></table></div>`;
};
VIEWS.voyage = async (id) => {
  const v = await api.q('voyage', { id }); if (!v) return '<div class="panel empty">Vessel call not found.</div>';
  view.curVoyage = v;
  const acts = [];
  const br = v.berthRequest;
  if (isType('NPA') && br && br.status === 'PENDING') acts.push(`<button class="btn action" data-act="decide" data-id="${br.id}">Allocate berth</button>`);
  if (isType('NPA') && v.status === 'BERTH_ALLOCATED') acts.push(`<button class="btn action" data-act="arrive" data-id="${v.id}">Record arrival</button>`);
  if (isType('NPA') && v.status === 'ARRIVED') acts.push(`<button class="btn" data-act="depart" data-id="${v.id}">Record departure</button>`);
  if (isType('TERMINAL') && v.terminalOrgId === S.org.id && v.status === 'ARRIVED' && v.discharged < v.containers) acts.push(`<button class="btn action" data-act="discharge" data-id="${v.id}">Discharge ${v.containers - v.discharged} container(s)</button>`);
  if (isType('SHIPPING') && v.shippingOrgId === S.org.id && v.status !== 'DEPARTED') acts.push(`<button class="btn ${v.manifestIds.length ? '' : 'action'}" data-act="manifest" data-id="${v.id}">File manifest</button>`);
  if (isType('SHIPPING') && v.shippingOrgId === S.org.id && v.status === 'PLANNED' && (!br || br.status === 'REJECTED')) acts.push(`<button class="btn" data-act="reqberth" data-id="${v.id}">Request berth</button>`);
  return `<div class="row"><a href="#voyages" class="small">← Vessel calls</a></div>
  ${head(`${esc(v.vesselName)} <span class="muted mono" style="font-size:1rem">voy. ${esc(v.voyageNo)}</span>`, `${esc(v.portName)} · ${esc(v.terminal)} · carrier ${esc(v.shipping)}`, acts.join(''))}
  <div class="grid g4">${tile(statusPill(v.status), 'Status')}${tile(`<span class="mono" style="font-size:1.2rem">${esc(v.berth || '–')}</span>`, 'Berth')}${tile(v.bls, 'Bills of lading')}${tile(`${v.discharged}/${v.containers}`, 'Containers discharged')}</div>
  <div class="split"><div class="stack"><div class="panel"><h3>Bills of lading</h3>${v.blList.length ? `<div class="table-wrap" style="border:0"><table><tr><th>B/L</th><th>Consignee</th><th>Cargo</th><th>Lane</th><th>Stage</th></tr>${v.blList.map((b) => `<tr class="click" data-href="bl-${b.id}"><td class="mono"><a href="#bl-${b.id}">${esc(b.blNo)}</a></td><td>${esc(b.consignee)}</td><td>${esc(b.description)}</td><td>${lane(b.lane)}</td><td>${stagePill(b.stage)}</td></tr>`).join('')}</table></div>` : '<div class="empty">No manifest filed yet.</div>'}</div>
    <div class="panel"><h3>Voyage timeline</h3>${timelineHtml(v.timeline)}</div></div>
  <div class="stack"><div class="panel"><h3>Vessel (common registry)</h3><dl class="kv"><dt>IMO</dt><dd class="mono">${esc(v.imo)}</dd><dt>Flag</dt><dd>${esc(v.vessel?.flag)}</dd><dt>Type</dt><dd>${esc(v.vessel?.type)}</dd><dt>GRT / LOA</dt><dd>${esc(v.vessel?.grt)} / ${esc(v.vessel?.loa)} m</dd><dt>ETA</dt><dd>${dt(v.eta)}</dd><dt>ETD</dt><dd>${dt(v.etd)}</dd><dt>ATA / ATD</dt><dd>${dt(v.ata)} / ${dt(v.atd)}</dd><dt>Last / next port</dt><dd>${esc(v.lastPort)} / ${esc(v.nextPort)}</dd></dl></div>
    <div class="panel"><h3>Manifests</h3>${v.manifests.map((m) => `<div class="small" style="padding:6px 0;border-top:1px solid var(--line)"><b class="mono">${esc(m.no)}</b> · ${m.blIds.length} B/L · ${esc(m.source)} · ${dt(m.submittedAt)}${m.amendments.length ? ` · ${m.amendments.length} amendment(s)` : ''}</div>`).join('') || '<div class="muted small">None</div>'}</div>
    ${br ? `<div class="panel"><h3>Berth request</h3><div class="small">${statusPill(br.status)} requested ${dt(br.requestedAt)}${br.decision?.note ? ': ' + esc(br.decision.note) : ''}</div></div>` : ''}</div></div>`;
};
ACT.arrive = async ({ id }) => cmd('voyage.arrive', { voyageId: id }, 'Arrival recorded. Terminal, Customs and cargo interests notified.');
ACT.depart = async ({ id }) => cmd('voyage.depart', { voyageId: id }, 'Departure recorded; berth freed.');
ACT.discharge = async ({ id }) => cmd('cargo.discharge', { voyageId: id }, (r) => `${r.discharged} container(s) discharged and assigned yard slots. Handling invoices raised.`);
ACT.reqberth = async ({ id }) => cmd('service.request', { type: 'BERTH', voyageId: id }, 'Berth requested');
ACT.newvoyage = async () => {
  const dir = await api.q('directory'); const terms = dir.orgs.filter((o) => o.type === 'TERMINAL');
  openModal({ title: 'Notify a vessel call', sub: 'Vessel particulars come from the common registry. A berth request goes to the Port Authority automatically.', submit: 'Notify and request berth',
    body: `<div class="form-grid">${field('imo', 'Vessel', { opts: dir.vessels.map((v) => [v.imo, `${v.name} (IMO ${v.imo})`]) })}${field('voyageNo', 'Voyage number', { required: true, value: '0' + Math.floor(50 + Math.random() * 40) + 'W' })}${field('port', 'Port', { opts: Object.entries(PORTS).map(([k, p]) => [k, p.name]) })}${field('terminalOrgId', 'Terminal', { opts: terms.map((t) => [t.id, `${t.name}`]) })}${field('eta', 'ETA', { type: 'datetime-local', value: toLocalInput(S.now + 3 * 86400e3), required: true })}${field('etd', 'ETD', { type: 'datetime-local', value: toLocalInput(S.now + 5 * 86400e3), required: true })}${field('preferredBerth', 'Preferred berth', { opts: [['', 'Any'], ...Object.values(PORTS).flatMap((p) => p.berths)] })}${field('lastPort', 'Last port', { value: 'Lome' })}</div>
      <details><summary class="small">Vessel not in the registry? Register it</summary><div class="form-grid" style="margin-top:8px">${field('newImo', 'IMO number (7 digits, check digit validated)')}${field('newName', 'Vessel name')}${field('newFlag', 'Flag (ISO)')}</div></details>`,
    onSubmit: async (fd) => { const o = fd2o(fd); let imo = o.imo; if (o.newImo) { await api.cmd('vessel.register', { imo: o.newImo, name: o.newName, flag: o.newFlag }); imo = o.newImo; } const r = await cmd('voyage.create', { imo, voyageNo: o.voyageNo, port: o.port, terminalOrgId: o.terminalOrgId, eta: new Date(o.eta).getTime(), etd: new Date(o.etd).getTime(), preferredBerth: o.preferredBerth || null, lastPort: o.lastPort }, 'Vessel call notified; berth requested'); go(`voyage-${r.voyageId}`); } });
};
ACT.manifest = async ({ id }) => {
  const dir = await api.q('directory'); const v = view.curVoyage;
  const fwd = dir.orgs.filter((o) => o.type === 'FORWARDER'); const imp = dir.orgs.filter((o) => o.type === 'IMPORTER');
  const sample = () => { const n = () => 200000 + Math.floor(Math.random() * 700000); const imps = imp.length ? imp : [{ tin: '50000001-0001' }]; return ['blNo,shipper,consigneeName,consigneeTin,forwarder,portOfLoading,description,hsCode,packages,grossWeightKg,containers',
    `AMLU${v.voyageNo}${String(Math.floor(Math.random() * 900) + 100)},Shenzhen Bright Electronics Co.,${imps[1 % imps.length].name || ''},${imps[1 % imps.length].tin},${fwd[0]?.name || ''},CNSZX,Laptop computers,8471,600,7200,${makeContainerNo('MSC', n())}:40:7200`,
    `AMLU${v.voyageNo}${String(Math.floor(Math.random() * 900) + 100)},Bangkok Rice Exporters Ltd,${imps[0].name || ''},${imps[0].tin},${fwd[0]?.name || ''},THBKK,Parboiled rice 50kg bags,1006,1000,50000,${makeContainerNo('MSC', n())}:20:25000;${makeContainerNo('MSC', n())}:20:25000`].join('\n'); };
  openModal({ title: `File manifest: ${v.vesselName} ${v.voyageNo}`, wide: true, submit: 'Validate and submit',
    sub: 'Paste CSV from your carrier system (or call the partner API). Containers as NUMBER:SIZE:WEIGHT separated by “;”. Every container number is checked against ISO 6346; consignees are matched to registered cargo owners by TIN.',
    body: `<div class="row"><button type="button" class="btn sm" data-act="samplecsv">Load sample lines</button><span class="tiny muted">Try breaking a container’s last digit to see validation.</span></div>${field('csv', 'Manifest lines (CSV)', { type: 'textarea', value: sample(), attrs: 'style="min-height:180px"' })}<div id="csv-preview" class="small muted"></div>`,
    onSubmit: async (fd) => {
      const rows = String(fd.get('csv')).trim().split(/\r?\n/).filter(Boolean); const hdr = rows.shift().split(',').map((s) => s.trim());
      const bls = rows.map((line) => { const c = line.split(',').map((s) => s.trim()); const o = Object.fromEntries(hdr.map((h, i) => [h, c[i]])); const f = fwd.find((x) => x.name.toLowerCase() === (o.forwarder || '').toLowerCase());
        return { blNo: o.blNo, shipper: o.shipper, consignee: { name: o.consigneeName || o.consigneeTin, tin: o.consigneeTin }, forwarderOrgId: f ? f.id : null, portOfLoading: o.portOfLoading, description: o.description, hsCode: o.hsCode, packages: Number(o.packages), packageType: 'CTN', grossWeightKg: Number(o.grossWeightKg), containers: (o.containers || '').split(';').filter(Boolean).map((x) => { const [no, size, w] = x.split(':'); return { no, size, weightKg: Number(w) || 0 }; }) }; });
      const r = await cmd('manifest.submit', { voyageId: id, bls, source: 'csv' }); toast(`Manifest accepted: ${r.blIds.length} B/L filed. Forwarders, consignees, terminal and Customs notified.`); } });
  ACT.samplecsv = () => { document.getElementById('f-csv').value = sample(); };
  const ta = document.getElementById('f-csv'); const prev = () => { const bad = [...ta.value.matchAll(/([A-Z]{4}\d{7})/g)].map((m) => m[1]).filter((n) => !validContainerNo(n)); document.getElementById('csv-preview').innerHTML = bad.length ? `<span style="color:var(--bad)">ISO 6346 check digit fails for: ${bad.map(esc).join(', ')}</span>` : 'All container numbers pass the ISO 6346 check digit.'; };
  ta.addEventListener('input', prev); prev();
};

VIEWS.berths = async () => {
  const ports = await api.q('berths'); const now = S.now; const from = now - 7 * 86400e3, to = now + 7 * 86400e3; const pct = (t) => Math.max(0, Math.min(100, ((t - from) / (to - from)) * 100));
  const days = Array.from({ length: 15 }, (_, i) => from + i * 86400e3);
  return `${head('Berth plan', 'Berth occupancy for the past and next seven days. Allocation rejects overlapping windows automatically.')}
  ${ports.map((p) => `<div class="panel"><h3>${esc(p.name)}</h3><div style="overflow-x:auto"><div style="min-width:640px"><div style="display:grid;grid-template-columns:90px 1fr;font-size:.68rem" class="muted mono"><span></span><div style="position:relative;height:16px">${days.map((d, i) => `<span style="position:absolute;left:${(i / 14) * 100}%;transform:translateX(-50%)">${i % 2 ? '' : dshort(d)}</span>`).join('')}</div></div>
    ${p.berths.map((b) => `<div style="display:grid;grid-template-columns:90px 1fr;align-items:center;border-top:1px solid var(--line);height:34px"><span class="mono small">${esc(b.berth)}</span><div style="position:relative;height:24px;background:var(--surface-2);border-radius:4px"><div style="position:absolute;left:${pct(now)}%;top:-4px;bottom:-4px;width:2px;background:var(--signal)" title="Now"></div>${b.voyages.filter((v) => (v.atd || v.etd) > from && (v.ata || v.eta) < to).map((v) => { const s = v.ata || v.eta, e = v.atd || v.etd; return `<a href="#voyage-${v.id}" title="${esc(v.vessel)} ${esc(v.voyageNo)} ${dt(s)} to ${dt(e)}" style="position:absolute;left:${pct(s)}%;width:${Math.max(2, pct(e) - pct(s))}%;top:2px;bottom:2px;border-radius:3px;background:${v.status === 'DEPARTED' ? 'var(--surface-3)' : v.status === 'ARRIVED' ? 'var(--accent)' : 'var(--accent-soft)'};color:${v.status === 'ARRIVED' ? 'var(--accent-ink)' : 'var(--ink)'};font-size:.7rem;padding:2px 6px;overflow:hidden;white-space:nowrap;text-decoration:none">${esc(v.vessel)} ${esc(v.voyageNo)}</a>`; }).join('')}</div></div>`).join('')}</div></div></div>`).join('')}
  <div class="row small muted"><span class="pill info">Allocated</span><span class="pill" style="background:var(--accent);color:var(--accent-ink)">Alongside</span><span class="pill">Departed</span><span>Amber line marks now.</span></div>`;
};

// ---------------- customs, requests
VIEWS.customs = async () => {
  const list = await api.q('declarations'); const f = view.declFilter || '';
  const rows = list.filter((d) => !f || d.status === f || d.lane === f);
  const c = (k) => list.filter((d) => d.status === k || d.lane === k).length;
  return `${head('Declarations', isType('CUSTOMS') ? 'Single goods declarations with automated risk lanes. Green releases on payment; yellow goes to documentary review; red to joint examination.' : 'Declarations you have lodged and their Customs status.')}
  <div class="row">${[['', 'All', list.length], ['AWAITING_REVIEW', 'Awaiting review', c('AWAITING_REVIEW')], ['AWAITING_EXAM', 'Awaiting exam', c('AWAITING_EXAM')], ['QUERIED', 'Queried', c('QUERIED')], ['ASSESSED', 'Awaiting payment', c('ASSESSED')], ['RELEASED', 'Released', c('RELEASED')], ['GREEN', 'Green', c('GREEN')], ['YELLOW', 'Yellow', c('YELLOW')], ['RED', 'Red', c('RED')]].map(([k, l, n]) => `<button class="btn sm ${f === k ? 'primary' : ''}" data-act="declf" data-k="${k}">${l} <span class="num">${n}</span></button>`).join('')}</div>
  <div class="table-wrap"><table><tr><th>Declaration</th><th>B/L</th><th>Consignee / declarant</th><th>Goods</th><th>Lane</th>${isType('CUSTOMS', 'AUDIT') ? '<th class="r">Score</th>' : ''}<th>Status</th><th class="r">Duty & taxes</th><th>Lodged</th><th>Clearance</th></tr>${rows.map((d) => `<tr class="click" data-href="bl-${d.blId}"><td class="mono small">${esc(d.no)}${d.preArrival ? '<div><span class="pill info">Pre-arrival</span></div>' : ''}</td><td class="mono"><a href="#bl-${d.blId}">${esc(d.blNo)}</a></td><td>${esc(d.consignee)}<div class="tiny muted">${esc(d.declarant)}</div></td><td>${esc(d.description)}<div class="tiny muted">HS ${esc(d.hsCode)}</div></td><td>${lane(d.lane)}</td>${isType('CUSTOMS', 'AUDIT') ? `<td class="r mono">${d.score}</td>` : ''}<td>${statusPill(d.status)}</td><td class="r">${money(d.total)}</td><td class="small">${dt(d.lodgedAt)}</td><td class="small">${d.releasedAt ? hrs((d.releasedAt - d.lodgedAt) / 3600e3) : '–'}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">None</td></tr>'}</table></div>`;
};
ACT.declf = ({ k }) => { view.declFilter = k; render(true); };

VIEWS.requests = async () => {
  const list = await api.q('services'); const pend = list.filter((s) => s.status === 'PENDING');
  const row = (s) => `<tr><td><b>${esc(s.label)}</b><div class="tiny muted mono">${esc(s.id)}</div></td><td class="mono">${s.blId ? `<a href="#bl-${s.blId}">${esc(s.subject)}</a>` : `<a href="#voyage-${s.voyageId}">${esc(s.subject)}</a>`}</td><td class="small">${esc(s.requester)} → ${esc(s.decider)}</td><td>${statusPill(s.status)}</td><td class="small">${dt(s.requestedAt)}</td><td class="small">${s.decidedAt ? (s.slaMet ? '<span class="pill ok">Met</span>' : '<span class="pill bad">Breached</span>') : S.now > s.slaDueAt ? '<span class="pill bad">Overdue</span>' : 'due ' + dt(s.slaDueAt)}</td><td>${s.canDecide ? `<button class="btn action sm" data-act="decide" data-id="${s.id}">Decide</button>` : esc(s.decision?.note || '')}</td></tr>`;
  return `${head('Service requests', 'Berths, permits, delivery orders, exam positioning and truck bookings, each routed to the organisation that decides it, with an SLA clock.')}
  <div class="panel"><h2>Open <span class="muted num">(${pend.length})</span></h2></div><div class="table-wrap"><table><tr><th>Request</th><th>Subject</th><th>From → To</th><th>Status</th><th>Requested</th><th>SLA</th><th></th></tr>${pend.map(row).join('') || '<tr><td colspan="7" class="empty">No open requests</td></tr>'}</table></div>
  <h2>Decided</h2><div class="table-wrap"><table><tr><th>Request</th><th>Subject</th><th>From → To</th><th>Status</th><th>Requested</th><th>SLA</th><th>Note</th></tr>${list.filter((s) => s.status !== 'PENDING').slice(0, 60).map(row).join('')}</table></div>`;
};

// ---------------- yard & gate
VIEWS.yard = async () => {
  const y = await api.q('yard', { terminalOrgId: view.yardTerm || '' });
  const L = y.layout; const exam = Object.entries(y.slots).filter(([k]) => k.startsWith('EXAM'));
  return `${head('Yard', `${y.inYard} of ${y.capacity} slots occupied (${Math.round((y.inYard / y.capacity) * 100)}%). Each cell is a bay/row ground slot; shade shows stacking tiers used.`, y.terminals.length > 1 ? `<select data-act="noop" id="yardterm" aria-label="Terminal">${y.terminals.map((t) => `<option value="${t.id}" ${t.id === y.terminalOrgId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button class="btn" data-act="yardterm">Show</button>` : '')}
  <div class="yard">${L.blocks.map((b) => `<div class="block"><div class="row"><b>Block ${b}</b><span class="tiny muted">bays 1–${L.bays} × rows 1–${L.rows}</span></div><div class="bays">${Array.from({ length: L.rows }, (_, r) => Array.from({ length: L.bays }, (_, bay) => { const key = `${b}${String(bay + 1).padStart(2, '0')}-${r + 1}`; const stack = Array.from({ length: L.tiers }, (_, t) => y.slots[`${key}-${t + 1}`]).filter(Boolean); const top = stack[stack.length - 1]; return `<button class="slot ${stack.length ? 'f' + stack.length : ''} ${stack.some((c) => c.status === 'RELEASED') ? 'rel' : ''} ${stack.some((c) => c.dwellDays > 3) ? 'old' : ''}" ${top ? `data-act="go" data-href="bl-${top.blId}" title="${esc(stack.map((c) => `${c.no} (${c.size}ft) ${c.blNo}, ${c.dwellDays} d`).join('\n'))}"` : 'tabindex="-1" aria-hidden="true"'}>${stack.length || ''}</button>`; }).join('')).join('')}</div></div>`).join('')}</div>
  <div class="row small muted"><span class="pill" style="box-shadow:inset 0 0 0 2px var(--ok)">Released, awaiting gate-out</span><span class="pill" style="box-shadow:inset 0 0 0 2px var(--warn)">Past free storage</span></div>
  <div class="panel"><h3>Examination bay</h3>${exam.length ? exam.map(([k, c]) => `<div class="row small"><span class="mono">${esc(k)}</span><a class="mono" href="#bl-${c.blId}">${esc(c.no)}</a><span>${esc(c.blNo)}</span></div>`).join('') : '<div class="muted small">Empty</div>'}</div>`;
};
ACT.yardterm = () => { view.yardTerm = document.getElementById('yardterm').value; render(true); };
ACT.noop = () => {};

VIEWS.gate = async () => {
  const q = await api.q('gateQueue');
  return `${head('Gate', 'Verify the electronic gate pass and the booked truck before letting a container out. Mismatched trucks are refused and logged.')}
  <div class="split"><form class="panel stack" data-form="gate"><h2>Gate-out check</h2><div class="form-grid">${field('token', 'Gate pass code', { required: true, value: view.gateToken || '', placeholder: 'XXXX-XXXX' })}${field('plate', 'Truck plate at the gate', { required: true, value: view.gatePlate || '', placeholder: 'LND-482XY' })}</div><div class="row"><button class="btn" type="button" data-act="verifygp">Verify</button>${can('gate.out') ? '<button class="btn action" type="submit">Gate out</button>' : '<span class="small muted">Only terminal gate staff can gate out.</span>'}</div><div id="gp-out"></div></form>
  <div class="panel"><h3>Active gate passes <span class="muted num">(${q.length})</span></h3>${q.length ? q.map((g) => `<div class="row" style="padding:7px 0;border-top:1px solid var(--line)"><div style="flex:1;min-width:0"><b class="mono">${esc(g.containerNo)}</b> <span class="small muted">${esc(g.blNo)}</span><div class="tiny muted">${g.truck ? `Booked truck <span class="mono">${esc(g.truck.plate)}</span>, ${esc(g.truck.driver)}` : 'No truck booked yet'} · expires ${dt(g.expiresAt)}</div></div><button class="btn sm" data-act="loadgp" data-token="${esc(g.token)}" data-plate="${esc(g.truck?.plate || '')}">Load</button></div>`).join('') : '<div class="empty">No containers awaiting gate-out.</div>'}</div></div>`;
};
ACT.loadgp = ({ token, plate }) => { view.gateToken = token; view.gatePlate = plate; document.getElementById('f-token').value = token; document.getElementById('f-plate').value = plate; ACT.verifygp(); };
ACT.verifygp = async () => {
  const token = document.getElementById('f-token').value; const plate = document.getElementById('f-plate').value.toUpperCase();
  const g = await api.q('gatePass', { token }); const out = document.getElementById('gp-out');
  if (!g) { out.innerHTML = '<div class="errors">Gate pass not recognised for this terminal.</div>'; return; }
  const match = g.truck && g.truck.plate.replace('-', '') === plate.replace(/[-\s]/g, '');
  out.innerHTML = `<div class="${match && g.status === 'ACTIVE' ? 'note' : 'errors'}"><b class="mono">${esc(g.containerNo)}</b> · B/L ${esc(g.blNo)} · ${esc(g.consignee)}<br>Pass ${esc(g.status)} until ${dt(g.expiresAt)}. Booked truck: <span class="mono">${esc(g.truck?.plate || 'none')}</span> (${esc(g.truck?.driver || '–')}). ${match ? 'Plate matches.' : 'Plate does NOT match the booking.'}</div>`;
};
FORMS.gate = async (fd) => { const o = fd2o(fd); const r = await api.cmd('gate.out', o); if (r.denied) toast(r.denied === 'plate_mismatch' ? 'Gate-out refused: truck does not match the booking. Logged and the cargo owner and Port Authority alerted.' : 'Gate pass expired. Gate-out refused.', 'err'); else { toast(`Gated out.${r.allOut ? ' All containers for this B/L have left; the consignee can confirm delivery.' : ''}`); view.gateToken = ''; view.gatePlate = ''; } };

// ---------------- payments
VIEWS.payments = async () => {
  const [invs, pays] = await Promise.all([api.q('invoices'), api.q('payments')]);
  const payable = invs.filter((i) => i.canPay); const recon = pays.filter((p) => p.canReconcile);
  return `${head('Payments', 'Port, Customs, terminal and carrier charges raised automatically by the platform. Pay several in one transaction; banks reconcile and settle to each beneficiary.')}
  <div class="grid g4">${tile(money(invs.filter((i) => i.status === 'UNPAID').reduce((a, i) => a + i.total, 0)), 'Outstanding')}${tile(money(invs.filter((i) => i.status !== 'UNPAID').reduce((a, i) => a + i.total, 0)), 'Collected')}${tile(pays.length, 'Payments')}${tile(pays.filter((p) => p.status === 'RECONCILED').length + '/' + pays.length, 'Reconciled')}</div>
  ${payable.length ? `<div class="panel"><div class="panel-head"><h2>Invoices to pay</h2><button class="btn action" data-act="paysel">Pay selected</button></div><div class="table-wrap"><table><tr><th></th><th>Invoice</th><th>Charge</th><th>B/L</th><th>Beneficiary</th><th>Due</th><th class="r">Amount</th></tr>${payable.map((i) => `<tr><td><input type="checkbox" class="paychk" value="${i.id}" checked aria-label="Select ${esc(i.no)}"></td><td class="mono small">${esc(i.no)}</td><td>${esc(i.label)}</td><td class="mono"><a href="#bl-${i.blId}">${esc(i.blNo)}</a></td><td class="small">${esc(i.beneficiary)}</td><td class="small">${dt(i.dueAt)}</td><td class="r">${money(i.total)}</td></tr>`).join('')}</table></div></div>` : ''}
  ${recon.length ? `<div class="panel"><div class="panel-head"><h2>Awaiting reconciliation</h2><button class="btn action" data-act="recon" data-ids="${recon.map((p) => p.id).join(',')}">Reconcile and settle ${recon.length}</button></div></div>` : ''}
  <h2>Payment ledger</h2><div class="table-wrap"><table><tr><th>Reference</th><th>Payer</th><th>Bank</th><th>Method</th><th>Invoices</th><th>Status</th><th>Paid</th><th class="r">Amount</th></tr>${pays.map((p) => `<tr><td class="mono small">${esc(p.ref)}${p.settlementRef ? `<div class="tiny muted">${esc(p.settlementRef)}</div>` : ''}</td><td class="small">${esc(p.payer)}</td><td class="small">${esc(p.bank)}</td><td>${esc(titleCase(p.method))}</td><td class="tiny mono">${p.invoices.map(esc).join('<br>')}</td><td>${statusPill(p.status)}</td><td class="small">${dt(p.paidAt)}</td><td class="r">${money(p.total)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No payments</td></tr>'}</table></div>
  <h2>All invoices</h2><div class="table-wrap"><table><tr><th>Invoice</th><th>Charge</th><th>B/L</th><th>Payer → beneficiary</th><th>Status</th><th>Issued</th><th class="r">Amount</th></tr>${invs.map((i) => `<tr><td class="mono small">${esc(i.no)}</td><td>${esc(i.label)}</td><td class="mono"><a href="#bl-${i.blId}">${esc(i.blNo)}</a></td><td class="small">${esc(i.payer)} → ${esc(i.beneficiary)}</td><td>${statusPill(i.status)}</td><td class="small">${dt(i.issuedAt)}</td><td class="r">${money(i.total)}</td></tr>`).join('')}</table></div>`;
};
ACT.paysel = () => { const ids = [...document.querySelectorAll('.paychk:checked')].map((c) => c.value); if (!ids.length) return toast('Select at least one invoice', 'err'); ACT.pay({ ids: ids.join(',') }); };
ACT.recon = ({ ids }) => cmd('payment.reconcile', { paymentIds: ids.split(',') }, 'Payments reconciled and settled to beneficiaries');

// ---------------- notifications, audit
VIEWS.inbox = async () => {
  const list = await api.q('notifications');
  return `${head('Notifications', `Every event that concerns ${esc(S.org.name)}. Copies go by e-mail and SMS (simulated; see Integrations).`, `<button class="btn" data-act="readall">Mark all read</button>`)}
  <div class="panel">${list.map((n) => `<div class="row" style="padding:9px 0;border-top:1px solid var(--line);align-items:flex-start;${n.read ? 'opacity:.7' : ''}"><span class="pill ${n.severity === 'action' ? 'act' : n.severity === 'success' ? 'ok' : n.severity === 'warning' ? 'bad' : 'info'}">${esc(titleCase(n.severity))}</span><div style="flex:1;min-width:0"><b class="small">${esc(n.title)}</b><div class="small muted">${esc(n.body)}</div></div><span class="tiny muted">${dt(n.at)}</span>${n.ref ? `<a class="btn sm" href="#${refHref(n.ref)}">Open</a>` : ''}</div>`).join('') || '<div class="empty">No notifications</div>'}</div>`;
};
ACT.readall = () => cmd('notification.read', { all: true }, 'All notifications marked read');

VIEWS.audit = async () => {
  const a = await api.q('audit', { q: view.auditQ || '', trace: view.auditTrace || '', limit: view.auditLimit || 100 });
  return `${head('Audit trail', `${a.scope === 'full' ? 'Complete platform record.' : 'Entries for your organisation and its shipments.'} Each entry is chained to the previous one by SHA-256, so any edit or deletion breaks the chain and is detected.`, `<button class="btn" data-act="verify">Verify chain</button>${isType('NPA', 'AUDIT') ? '<button class="btn" data-act="rebuild">Disaster-recovery replay</button>' : ''}<button class="btn" data-act="csv">Export CSV</button>`)}
  <div id="verify-out"></div>
  <form class="row" data-form="auditf"><input name="q" id="f-aq" value="${esc(view.auditQ || '')}" placeholder="Search actions, people, organisations, B/L…" style="flex:1 1 260px" aria-label="Search audit"><input name="trace" id="f-at" value="${esc(view.auditTrace || '')}" placeholder="Trace, e.g. TRC-AMLU045W001" aria-label="Trace"><button class="btn">Filter</button>${view.auditQ || view.auditTrace ? '<button type="button" class="btn ghost" data-act="auditclear">Clear</button>' : ''}</form>
  <div class="small muted">${a.total} entries · chain head <span class="hash">${esc(a.head)}</span></div>
  <div class="table-wrap"><table><tr><th class="r">#</th><th>Time</th><th>Actor</th><th>Action</th><th>Summary</th><th>Trace</th><th>Hash</th></tr>${a.entries.map((e) => `<tr><td class="r mono small">${e.n}</td><td class="small" style="white-space:nowrap">${dt(e.at)}</td><td class="small">${esc(e.by.name)}${e.by.orgName ? `<div class="tiny muted">${esc(e.by.orgName)}</div>` : ''}</td><td class="mono tiny">${esc(e.action)}</td><td class="small">${esc(e.summary)}</td><td>${e.trace ? `<a href="#" class="mono tiny" data-act="trace" data-t="${esc(e.trace)}">${esc(e.trace)}</a>` : ''}</td><td class="hash" title="prev ${esc(e.prev)}">${e.hash.slice(0, 12)}…</td></tr>`).join('')}</table></div>
  ${a.total > a.entries.length ? `<button class="btn" data-act="auditmore">Show more</button>` : ''}`;
};
FORMS.auditf = (fd) => { view.auditQ = fd.get('q'); view.auditTrace = fd.get('trace'); render(true); };
ACT.auditclear = () => { view.auditQ = ''; view.auditTrace = ''; render(true); };
ACT.trace = ({ t }) => { view.auditTrace = t; render(true); };
ACT.auditmore = () => { view.auditLimit = (view.auditLimit || 100) + 200; render(true); };
ACT.verify = async () => { const r = await api.q('auditVerify'); document.getElementById('verify-out').innerHTML = r.ok ? `<div class="note">Chain intact: all ${r.entries} entries re-hashed and linked correctly. Head <span class="hash">${esc(r.head)}</span>.</div>` : `<div class="errors">Chain broken at entry #${r.brokenAt}: ${esc(r.reason)}</div>`; };
ACT.rebuild = async () => { const r = await api.rebuild(); document.getElementById('verify-out').innerHTML = `<div class="note">Rebuilt the entire platform state by replaying ${r.replayed} logged commands in ${r.ms} ms. Resulting audit head ${r.identical ? '<b>matches</b>' : '<b>DIFFERS from</b>'} the live state, proving the log is a complete recovery source.</div>`; };
ACT.csv = async () => {
  if (api.mode === 'server') { const a = document.createElement('a'); a.href = api.auditCsvUrl(); a.click(); return; }
  const csv = await api.auditCsv(); openModal({ title: 'Audit export (CSV)', sub: 'Copy the text below into a .csv file. Direct downloads are disabled in this preview.', body: `<textarea id="f-csvout" style="min-height:260px" readonly>${esc(csv)}</textarea><button type="button" class="btn" data-act="copycsv">Copy to clipboard</button>`, cancel: 'Close' });
};
ACT.copycsv = async () => { const ta = document.getElementById('f-csvout'); try { await navigator.clipboard.writeText(ta.value); toast('Copied'); } catch { ta.select(); toast('Selected. Press Ctrl+C / ⌘C to copy.'); } };

// ---------------- reports
VIEWS.reports = async () => {
  const k = await api.q('kpis');
  const maxStage = Math.max(1, ...k.stageDur.map((s) => s.hours || 0));
  const rev = Object.entries(k.revenue); const maxRev = Math.max(1, ...rev.map(([, v]) => v));
  const laneTot = k.lanes.GREEN + k.lanes.YELLOW + k.lanes.RED || 1;
  const W = 980, Hh = 170, pad = 26, bw = (W - pad * 2) / k.days.length; const maxD = Math.max(2, ...k.days.map((d) => Math.max(d.gateOut, d.discharged)));
  const ticks = [0, Math.ceil(maxD / 2), maxD];
  return `${head('Reports & KPIs', `${esc(k.scope)}. Computed live from the shipment records and audit trail.`)}
  <div class="grid g4">${tile(k.totals.shipments, 'Bills of lading')}${tile(k.totals.teu, 'TEU handled')}${tile(hrs(k.avg.clearanceHours), 'Avg Customs clearance')}${tile(hrs(k.avg.dwellHours), 'Avg port dwell (closed)')}${tile(hrs(k.avg.endToEndHours), 'Avg manifest to delivery')}${tile(hrs(k.avg.releaseToGateHours), 'Avg release order to gate-out')}${tile(k.reusePct, 'Declaration fields reused', '%')}${tile(k.preArrivalPct, 'Declared before arrival', '%')}</div>
  <div class="grid g2"><div class="panel"><h3>Where time goes</h3><p class="small muted" style="margin:0 0 10px">Average hours between milestones. The longest bar is the bottleneck to attack.</p><div class="bars">${k.stageDur.map((s) => `<div class="bar"><span class="small">${esc(s.label)}</span><div class="track"><div class="fill" style="width:${((s.hours || 0) / maxStage) * 100}%;${s.hours === maxStage ? 'background:var(--signal)' : ''}"></div></div><span class="val">${hrs(s.hours)}</span></div>`).join('')}</div></div>
    <div class="panel"><h3>Customs risk lanes</h3><div style="display:flex;height:22px;border-radius:4px;overflow:hidden;margin:6px 0 10px">${['GREEN', 'YELLOW', 'RED'].map((l) => `<div style="width:${(k.lanes[l] / laneTot) * 100}%;background:var(--${l === 'GREEN' ? 'ok' : l === 'YELLOW' ? 'warn' : 'bad'})" title="${l} ${k.lanes[l]}"></div>`).join('')}</div><div class="row small">${['GREEN', 'YELLOW', 'RED'].map((l) => `${lane(l)} <span class="num">${k.lanes[l]} (${Math.round((k.lanes[l] / laneTot) * 100)}%)</span>`).join(' ')}</div><p class="small muted">Higher green share means faster, intelligence-led clearance with exams focused on genuine risk.</p></div></div>
  <div class="panel"><h3>Daily container moves, last 14 days</h3><div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${Hh + 30}" style="width:100%;min-width:480px;height:auto" role="img" aria-label="Discharges and gate-outs per day">
    ${ticks.map((t) => { const yy = Hh - (t / maxD) * (Hh - 10); return `<line x1="${pad}" x2="${W - 4}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/><text x="${pad - 6}" y="${yy + 3}" text-anchor="end">${t}</text>`; }).join('')}
    ${k.days.map((d, i) => { const x = pad + i * bw; const h1 = (d.discharged / maxD) * (Hh - 10), h2 = (d.gateOut / maxD) * (Hh - 10); return `<rect x="${x + bw * 0.12}" y="${Hh - h1}" width="${bw * 0.36}" height="${h1}" fill="var(--accent)" rx="1.5"><title>${d.day}: ${d.discharged} discharged</title></rect><rect x="${x + bw * 0.52}" y="${Hh - h2}" width="${bw * 0.36}" height="${h2}" fill="var(--signal)" rx="1.5"><title>${d.day}: ${d.gateOut} gated out</title></rect>${i % 2 === 0 ? `<text x="${x + bw / 2}" y="${Hh + 14}" text-anchor="middle">${d.day}</text>` : ''}`; }).join('')}
  </svg></div><div class="row small"><span class="pill" style="background:var(--accent);color:var(--accent-ink)">Discharged</span><span class="pill" style="background:var(--signal);color:#1a1300">Gated out</span></div></div>
  <div class="grid g2"><div class="panel"><h3>Revenue collected by beneficiary</h3><div class="bars">${rev.map(([l, v]) => `<div class="bar"><span class="small">${esc(l)}</span><div class="track"><div class="fill" style="width:${(v / maxRev) * 100}%"></div></div><span class="val">${(v / 1e6).toFixed(1)}m</span></div>`).join('') || '<div class="muted small">None yet</div>'}</div><p class="small muted">Outstanding: ${Object.entries(k.outstanding).map(([l, v]) => `${esc(l)} ${money(v)}`).join(' · ') || 'none'}. Amounts in NGN.</p></div>
    <div class="panel"><h3>Service level agreements</h3><div class="table-wrap" style="border:0"><table><tr><th>Service</th><th class="r">SLA</th><th class="r">Decided</th><th class="r">Avg</th><th class="r">Met</th><th class="r">Open</th></tr>${k.sla.map((s) => `<tr><td class="small">${esc(s.label)}</td><td class="r small">${s.slaHours}h <span class="guess">GUESS</span></td><td class="r">${s.decided}</td><td class="r">${hrs(s.avgHours)}</td><td class="r">${s.metPct == null ? '–' : `<span class="pill ${s.metPct >= 90 ? 'ok' : s.metPct >= 60 ? 'warn' : 'bad'}">${s.metPct}%</span>`}</td><td class="r">${s.pending}</td></tr>`).join('')}</table></div></div></div>
  <div class="grid g2"><div class="panel"><h3>Shipments by stage</h3><div class="bars">${Object.entries(k.stageCounts).map(([s, n]) => `<div class="bar"><span class="small">${esc(STAGES[s]?.[0] || s)}</span><div class="track"><div class="fill" style="width:${(n / k.totals.shipments) * 100}%"></div></div><span class="val">${n}</span></div>`).join('')}</div></div>
    <div class="panel"><h3>Paperless exchange</h3><p class="small muted" style="margin-top:0">Documents exchanged electronically on the platform instead of on paper.</p><dl class="kv">${Object.entries({ Manifests: k.docs.manifests, 'Customs declarations': k.docs.declarations, 'Agency permits': k.docs.permits, 'Delivery orders': k.docs.deliveryOrders, Invoices: k.docs.invoices, 'Gate passes': k.docs.gatePasses }).map(([l, v]) => `<dt>${l}</dt><dd class="num">${v}</dd>`).join('')}</dl></div></div>`;
};

// ---------------- directory, integration, access, config
VIEWS.directory = async () => {
  const d = await api.q('directory');
  return `${head('Common data', 'The single source of reference data every participant reuses: organisations, vessels, trading parties and tariff. Captured once, used everywhere.')}
  ${tabs('dir', [['orgs', `Organisations (${d.orgs.length})`], ['ves', `Vessels (${d.vessels.length})`], ['par', `Trading parties (${d.parties.length})`], ['tar', 'Tariff']], 'orgs')}
  ${pane('dir', 'orgs', 'orgs', `<div class="table-wrap"><table><tr><th>Organisation</th><th>Type</th><th>Detail</th><th>Contact</th></tr>${d.orgs.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.typeLabel)}</td><td class="small">${esc(o.category ? titleCase(o.category) : o.port ? PORTS[o.port].name : '')}</td><td class="small">${esc(o.email)}</td></tr>`).join('')}</table></div>`)}
  ${pane('dir', 'ves', 'orgs', `<div class="table-wrap"><table><tr><th>Vessel</th><th>IMO</th><th>Flag</th><th>Type</th><th>Added</th></tr>${d.vessels.map((v) => `<tr><td>${esc(v.name)}</td><td class="mono">${esc(v.imo)}</td><td>${esc(v.flag)}</td><td>${esc(v.type)}</td><td class="small">${dt(v.addedAt)}</td></tr>`).join('')}</table></div>`)}
  ${pane('dir', 'par', 'orgs', `<div class="table-wrap"><table><tr><th>Party</th><th>TIN</th><th>Roles</th><th class="r">Times reused</th></tr>${d.parties.map((p) => `<tr><td>${esc(p.name)}</td><td class="mono small">${esc(p.tin || '–')}</td><td class="small">${p.kinds.map(esc).join(', ')}</td><td class="r">${p.uses}</td></tr>`).join('')}</table></div>`)}
  ${pane('dir', 'tar', 'orgs', `<div class="note small">Tariff extract for the showcase. Rates follow ECOWAS CET bands but are <span class="guess">GUESS</span> values; replace with the official tariff.</div><div class="table-wrap"><table><tr><th>HS</th><th>Description</th><th class="r">Duty</th><th>Permits</th><th class="r">Risk weight</th><th class="r">Ref. USD/kg</th></tr>${d.tariff.map((t) => `<tr><td class="mono">${esc(t.hs)}</td><td>${esc(t.desc)}</td><td class="r">${(t.duty * 100).toFixed(0)}%</td><td class="small">${t.permits.map((p) => titleCase(p)).join(', ') || '–'}</td><td class="r">${t.risk}</td><td class="r">${t.minUsdPerKg}</td></tr>`).join('')}</table></div>`)}`;
};

VIEWS.integration = async () => {
  const i = await api.q('integration'); const base = api.mode === 'server' ? location.origin : 'https://<your-pcs-host>';
  return `${head('Integrations', 'Partner systems (carrier, terminal operating system, Customs, banks) connect through secured APIs and messaging. In this showcase, outbound e-mail, SMS and webhooks are simulated.', S.user.admin ? `<button class="btn" data-act="apikey">${i.apiKey ? 'Rotate' : 'Create'} API key</button>` : '')}
  <div class="grid g2"><div class="panel"><h3>Partner API</h3><p class="small muted" style="margin-top:0">${i.apiKey ? `Active key <span class="mono">${esc(i.apiKey.prefix)}…</span> created ${dt(i.apiKey.createdAt)}. Keys are stored only as SHA-256 hashes.` : 'No API key yet for your organisation.'}</p>
    <div class="table-wrap" style="border:0"><table><tr><th>Method</th><th>Endpoint</th><th>Purpose</th></tr>${[['POST', '/api/v1/manifests', 'Carrier systems file a manifest (same validation as the web form)'], ['GET', '/api/v1/shipments', 'List shipments visible to your organisation'], ['GET', '/api/v1/shipments/{id}', 'Full shipment record, checklist and timeline'], ['GET', '/api/v1/events', 'Notifications feed for polling integrations'], ['GET', '/api/track?ref=', 'Public cargo status'], ['GET', '/api/health', 'Liveness, audit-chain status'], ['GET', '/api/metrics', 'Prometheus metrics for monitoring']].map(([m, e, p]) => `<tr><td class="mono small">${m}</td><td class="mono small">${e}</td><td class="small">${p}</td></tr>`).join('')}</table></div>
    <pre class="mono tiny" style="background:var(--surface-2);padding:10px;border-radius:6px;overflow-x:auto">curl -X POST ${esc(base)}/api/v1/manifests \\\n  -H "X-API-Key: pcs_…" -H "content-type: application/json" \\\n  -d '{"voyageId":"VOY-00005","bls":[…]}'</pre></div>
    <div class="panel"><h3>Platform</h3><dl class="kv"><dt>Mode</dt><dd>${api.mode === 'server' ? 'Hosted server' : 'In-browser showcase'}</dd><dt>Command log</dt><dd>${i.commands} records (append-only, replayable)</dd><dt>Real-time</dt><dd>${api.mode === 'server' ? 'Server-sent events push changes to every open screen' : 'Instant within this browser'}</dd><dt>Messaging</dt><dd>E-mail, SMS, webhook (simulated)</dd></dl></div></div>
  <h2>Message outbox</h2><div class="table-wrap"><table><tr><th>Time</th><th>Channel</th><th>To</th><th>Subject</th><th>Status</th></tr>${i.outbox.map((m) => `<tr><td class="small">${dt(m.at)}</td><td>${esc(m.channel)}</td><td class="small mono">${esc(m.to)}</td><td class="small">${esc(m.subject)}</td><td class="tiny muted">${esc(m.status)}</td></tr>`).join('')}</table></div>`;
};
ACT.apikey = async () => { const r = await api.cmd('org.apikey.rotate', {}); openModal({ title: 'New API key', sub: 'Copy it now. It will not be shown again.', body: `<div class="prefill mono" style="word-break:break-all">${esc(r.apiKey)}</div>`, cancel: 'Done' }); };

VIEWS.access = async () => {
  const a = await api.q('admin');
  const types = Object.keys(ORG_TYPES);
  return `${head('Organisation & access', a.canApprove ? 'Approve or reject registrations, suspend participants, and review what each role may do.' : 'Manage your organisation’s users.')}
  ${a.orgs.map((o) => `<div class="panel"><div class="panel-head"><div><h3>${esc(o.name)}</h3><div class="small muted">${esc(o.typeLabel)} · CAC ${esc(o.rcNumber)} · TIN <span class="mono">${esc(o.tin)}</span> · registered ${dt(o.registeredAt)}</div></div><div class="row">${statusPill(o.status)}
    ${a.canApprove && o.status === 'PENDING' ? `<button class="btn action sm" data-act="orgdecide" data-id="${o.id}" data-d="approve">Approve</button><button class="btn danger sm" data-act="orgdecide" data-id="${o.id}" data-d="reject">Reject</button>` : ''}
    ${a.canApprove && o.type !== 'NPA' && ['ACTIVE', 'SUSPENDED'].includes(o.status) ? `<button class="btn sm" data-act="orgsuspend" data-id="${o.id}" data-s="${o.status === 'ACTIVE'}">${o.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'}</button>` : ''}
    ${o.id === S.org.id && S.user.admin ? `<button class="btn sm primary" data-act="adduser">Add user</button>` : ''}</div></div>
    <div class="table-wrap" style="border:0"><table><tr><th>User</th><th>Email</th><th>Title</th><th>Role</th><th>Last sign-in</th><th>Status</th><th></th></tr>${o.users.map((u) => `<tr><td>${esc(u.name)}</td><td class="small mono">${esc(u.email)}</td><td class="small">${esc(u.title)}</td><td>${u.admin ? '<span class="pill info">Admin</span>' : 'Officer'}</td><td class="small">${dt(u.lastLoginAt)}</td><td>${u.active ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Deactivated</span>'}</td><td>${o.id === S.org.id && S.user.admin && u.id !== S.user.id ? `<button class="btn sm" data-act="useractive" data-id="${u.id}" data-a="${!u.active}">${u.active ? 'Deactivate' : 'Activate'}</button>` : ''}</td></tr>`).join('')}</table></div></div>`).join('')}
  <div class="panel"><h3>Role-based access matrix</h3><p class="small muted" style="margin-top:0">Enforced in the core engine for every screen and API call. “Admin” means only the organisation’s administrators. Data is further scoped so each organisation sees only shipments it is party to.</p>
    <div class="table-wrap"><table><tr><th>Action</th>${types.map((t) => `<th title="${esc(ORG_TYPES[t].label)}">${esc(ORG_TYPES[t].short)}</th>`).join('')}</tr>${Object.entries(a.roles).filter(([k]) => !k.startsWith('auth')).map(([k, rules]) => `<tr><td class="mono tiny">${esc(k)}</td>${types.map((t) => { const r = rules.find((x) => x === '*public' || x === '*' || x === t || x === `*:admin` || x === `${t}:admin`); return `<td class="small" style="text-align:center">${!r ? '' : r.endsWith(':admin') ? 'admin' : r === '*public' ? 'public' : '●'}</td>`; }).join('')}</tr>`).join('')}</table></div></div>`;
};
ACT.orgdecide = ({ id, d }) => openModal({ title: d === 'approve' ? 'Approve registration' : 'Reject registration', body: field('note', d === 'approve' ? 'Verification note' : 'Reason (sent to applicant)', { value: d === 'approve' ? 'CAC and TIN verified' : '', required: d !== 'approve' }), submit: d === 'approve' ? 'Approve' : 'Reject', onSubmit: async (fd) => { await cmd('org.approve', { orgId: id, decision: d, note: fd.get('note') }, d === 'approve' ? 'Organisation approved and notified' : 'Registration rejected'); } });
ACT.orgsuspend = ({ id, s }) => openModal({ title: s === 'true' ? 'Suspend organisation' : 'Reinstate organisation', body: field('reason', 'Reason', { required: true }), submit: 'Confirm', onSubmit: async (fd) => { await cmd('org.suspend', { orgId: id, suspended: s === 'true', reason: fd.get('reason') }, 'Done'); } });
ACT.adduser = () => openModal({ title: 'Add user', body: `<div class="form-grid">${field('name', 'Full name', { required: true })}${field('email', 'Email', { type: 'email', required: true })}${field('title', 'Job title')}${field('password', 'Initial password (8+ characters)', { type: 'password', required: true })}</div><label class="row small"><input type="checkbox" name="admin" id="f-admin"> Organisation administrator</label>`, submit: 'Add user', onSubmit: async (fd) => { const o = fd2o(fd); await cmd('user.create', { ...o, admin: !!o.admin }, 'User added'); } });
ACT.useractive = ({ id, a }) => cmd('user.setActive', { userId: id, active: a === 'true' }, 'User updated');

VIEWS.config = async () => {
  const { settings } = await api.q('settings');
  const labels = { fxNgnPerUsd: 'Exchange rate (NGN per USD)', cifFactor: 'CIF estimate factor', vatRate: 'VAT rate', cissRate: 'CISS rate', etlsRate: 'ETLS rate', npaDuesPerTeu: 'Port dues per TEU (NGN)', terminalHandlingPerTeu: 'Terminal handling per TEU (NGN)', storageFreeDays: 'Free storage days', storagePerTeuDay: 'Storage per TEU per day (NGN)', shippingDoFee: 'Delivery order fee (NGN)', shippingPerTeu: 'Carrier charges per TEU (NGN)', examPenaltyRate: 'Exam discrepancy penalty rate', riskYellowAt: 'Risk score for yellow lane', riskRedAt: 'Risk score for red lane', randomSelectionPct: 'Random selection %', gatePassValidHours: 'Gate pass validity (hours)' };
  return `${head('Configuration', 'Business rules the platform applies. Every change is audit-logged.')}
  <form class="panel stack" data-form="settings"><h2>Tariffs and rules <span class="guess">GUESS values</span></h2><div class="form-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${Object.entries(labels).map(([k, l]) => field(k, l, { type: 'number', value: settings[k], attrs: 'step="any" min="0"' })).join('')}</div>
    <label class="row small"><input type="checkbox" name="autoReleaseOrder" id="f-autoReleaseOrder" ${settings.autoReleaseOrder ? 'checked' : ''}> Issue the Port Authority release order automatically when all seven conditions pass</label><div class="row"><button class="btn primary">Save rules</button></div></form>
  <div class="panel stack"><h2>Showcase controls</h2><p class="small muted" style="margin:0">Advance the platform clock to demonstrate storage charges, SLA breaches and gate-pass expiry. Reset restores the seeded scenario.</p>
    <div class="row"><button class="btn" data-act="clock" data-h="6">+6 hours</button><button class="btn" data-act="clock" data-h="24">+1 day</button><button class="btn" data-act="clock" data-h="72">+3 days</button><span class="spacer"></span><button class="btn danger" data-act="reset">Reset showcase data</button></div></div>`;
};
FORMS.settings = async (fd) => { const o = fd2o(fd); const changes = {}; for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in o && k !== 'highRiskOrigins') changes[k] = Number(o[k]); changes.autoReleaseOrder = !!o.autoReleaseOrder; await cmd('settings.update', { changes }, 'Rules saved'); };
ACT.clock = ({ h }) => cmd('clock.advance', { hours: Number(h) }, `Clock advanced ${h} hours`);
ACT.reset = () => openModal({ title: 'Reset showcase data?', body: '<p>This discards every change made since the seeded scenario was loaded and restores the original 17 shipments.</p>', submit: 'Reset', submitClass: 'danger', onSubmit: async () => { await api.reset(); toast('Showcase reset'); S = await api.q('session').catch(() => null); if (!S) { api.logout(); } go('home'); } });

VIEWS.track = async () => { setTimeout(() => view.trackRef && doTrack(view.trackRef)); return `${head('Track cargo', 'The same public status view that cargo owners and the public can use without signing in.')}<form class="panel row" data-form="track"><input name="ref" id="f-ref" value="${esc(view.trackRef || '')}" placeholder="B/L or container number" style="flex:1" aria-label="B/L or container number"><button class="btn primary">Track</button></form><div id="track-out"></div>`; };
