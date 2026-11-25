// Shared UI helpers: escaping, formatting, modal, toast, status vocab and the 12-step flow model.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (n) => (n == null ? '–' : '₦' + Number(n).toLocaleString('en-NG', { maximumFractionDigits: 0 }));
export const usd = (n) => (n == null ? '–' : 'US$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
export const dt = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
export const dshort = (t) => (t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '–');
export const hrs = (h) => (h == null ? '–' : h >= 48 ? `${(h / 24).toFixed(1)} d` : `${Number(h).toFixed(1)} h`);
export const ago = (t, now = Date.now()) => { const m = Math.round((now - t) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 48) return `${h} h ago`; return `${Math.round(h / 24)} d ago`; };
export const titleCase = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const STAGES = {
  MANIFESTED: ['Manifested', 'info'], IN_YARD: ['In yard', 'info'], DECLARED: ['Declared', 'warn'], UNDER_REVIEW: ['Customs review', 'warn'],
  CUSTOMS_QUERY: ['Customs query', 'bad'], UNDER_EXAMINATION: ['Under examination', 'bad'], CUSTOMS_RELEASED: ['Customs released', 'info'],
  TERMINAL_RELEASED: ['Terminal released', 'info'], RELEASED: ['Release order issued', 'ok'], PARTLY_GATED_OUT: ['Partly gated out', 'ok'],
  IN_TRANSIT: ['In transit', 'ok'], DELIVERED: ['Delivered', 'ok'], CLOSED: ['Closed', ''],
};
export const stagePill = (s) => { const [l, t] = STAGES[s] || [titleCase(s), '']; return `<span class="pill ${t}">${esc(l)}</span>`; };
export const statusPill = (s) => { const tone = /APPROVED|PAID|RECONCILED|RELEASED|ACTIVE|SUCCESS|USED|ISSUED|ARRIVED|SENT/.test(s) ? 'ok' : /REJECT|SUSPEND|EXPIRED|DECLINED|QUERIED/.test(s) ? 'bad' : /PENDING|UNPAID|AWAITING|REQUESTED|PLANNED|ASSESSED|QUEUED/.test(s) ? 'act' : 'info'; return `<span class="pill ${tone}">${esc(titleCase(s))}</span>`; };
export const lane = (l) => (l ? `<span class="lane ${esc(l)}">${esc(l)}</span>` : '<span class="muted">–</span>');

export const STEPS = [
  [1, 'Register & sign in', 'Every participant'], [2, 'File manifest & B/L', 'Shipping line'], [3, 'Reuse common data', 'Forwarder, Customs'],
  [4, 'Request port & regulatory services', 'Forwarder, carrier, agencies'], [5, 'Customs & agency processing', 'Customs, agencies'], [6, 'Terminal operations', 'Port Authority, terminal'],
  [7, 'E-payments', 'Payers, banks'], [8, 'Consolidate approvals', 'Port Authority'], [9, 'Cargo release', 'Port Authority'],
  [10, 'Gate & cargo movement', 'Terminal, transporter'], [11, 'Notify all parties', 'Platform'], [12, 'Close & report', 'All, Audit'],
];
export const MY_STEPS = { NPA: [1, 4, 6, 8, 9, 12], CUSTOMS: [3, 5, 12], SHIPPING: [2, 4], TERMINAL: [6, 10], FORWARDER: [3, 4, 7, 10, 12], IMPORTER: [3, 4, 7, 12], OGA: [4, 5], BANK: [7], TRANSPORTER: [10], AUDIT: [11, 12] };
export function blSteps(d) {
  const m = d.bl.milestones; const ck = Object.fromEntries(d.checklist.items.map((i) => [i.key, i.ok]));
  const done = { 1: true, 2: !!m.manifested, 3: !!m.declared, 4: ck.do && ck.permits, 5: !!m.customsReleased && ck.permits, 6: !!m.discharged && !!m.terminalReleased, 7: ck.paid, 8: !!m.releaseOrdered, 9: !!m.releaseOrdered, 10: !!m.gateOutAll, 11: !!m.manifested, 12: !!m.closed };
  const firstOpen = STEPS.find(([n]) => !done[n])?.[0];
  return STEPS.map(([n, label, who]) => ({ n, label, who, state: done[n] ? 'done' : n === firstOpen ? 'now' : '' }));
}
export const flowHtml = (steps, mine = []) => `<div class="flow">${steps.map((s) => `<div class="fs ${s.state || ''} ${mine.includes(s.n) ? 'mine' : ''}"><span class="n">STEP ${String(s.n).padStart(2, '0')}${s.state === 'done' ? ' ✓' : s.state === 'now' ? ' · NOW' : ''}</span><b>${esc(s.label)}</b><span class="who">${esc(s.who)}</span></div>`).join('')}</div>`;

// ---- toast
export function toast(msg, kind = 'ok', list) {
  let box = document.querySelector('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = `toast ${kind === 'err' ? 'err' : ''}`;
  t.innerHTML = `${esc(msg)}${list && list.length ? `<ul>${list.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join('')}${list.length > 8 ? `<li>…and ${list.length - 8} more</li>` : ''}</ul>` : ''}`;
  box.appendChild(t); setTimeout(() => t.remove(), kind === 'err' ? 9000 : 4500);
}
export const errList = (e) => e?.details?.errors || (e?.details?.checklist ? e.details.checklist.items.filter((i) => !i.ok).map((i) => `${i.label}${i.detail ? ': ' + i.detail : ''}`) : null);

// ---- modal
let modalState = null;
export const modalOpen = () => !!modalState;
export function openModal({ title, sub, body, submit = 'Submit', submitClass = 'primary', onSubmit, cancel = 'Cancel', wide }) {
  closeModal();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ${wide ? 'style="width:min(1000px,100%)"' : ''}><form id="modal-form" novalidate>
    <header><div><h2 id="modal-title">${esc(title)}</h2>${sub ? `<div class="muted small">${sub}</div>` : ''}</div><button type="button" class="btn ghost sm" data-close aria-label="Close">✕</button></header>
    <div class="body"><div class="errors" hidden></div>${body}</div>
    <footer><button type="button" class="btn" data-close>${esc(cancel)}</button>${onSubmit ? `<button type="submit" class="btn ${submitClass}">${esc(submit)}</button>` : ''}</footer></form></div>`;
  document.body.appendChild(scrim);
  const form = scrim.querySelector('form');
  modalState = { scrim };
  scrim.addEventListener('click', (e) => { if (e.target === scrim || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', escClose);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!onSubmit) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    const errBox = form.querySelector('.errors'); errBox.hidden = true;
    try { const keep = await onSubmit(new FormData(form), form); if (keep !== true) closeModal(); }
    catch (err) { const l = errList(err); errBox.innerHTML = `${esc(err.message)}${l ? `<ul>${l.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`; errBox.hidden = false; errBox.scrollIntoView({ block: 'nearest' }); }
    finally { btn.disabled = false; }
  });
  setTimeout(() => form.querySelector('input:not([type=hidden]):not([readonly]),select,textarea')?.focus(), 30);
  return form;
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }
export function closeModal() { if (modalState) { modalState.scrim.remove(); modalState = null; document.removeEventListener('keydown', escClose); window.dispatchEvent(new Event('pcs:modalclosed')); } }

export const field = (name, label, { type = 'text', value = '', required, opts, attrs = '', full, hint, placeholder } = {}) => {
  const id = `f-${name}`;
  let input;
  if (opts) input = `<select id="${id}" name="${name}" ${required ? 'required' : ''} ${attrs}>${opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  else if (type === 'textarea') input = `<textarea id="${id}" name="${name}" ${required ? 'required' : ''} ${attrs} placeholder="${esc(placeholder || '')}">${esc(value)}</textarea>`;
  else input = `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${attrs} placeholder="${esc(placeholder || '')}">`;
  return `<label class="f ${full ? 'full' : ''}" for="${id}">${esc(label)}${input}${hint ? `<span class="tiny muted">${hint}</span>` : ''}</label>`;
};
export const prefilled = (label, value) => `<div class="f" style="display:flex;flex-direction:column;gap:4px;font-size:.8rem;color:var(--muted);font-weight:500"><span>${esc(label)} <span class="reuse-tag">reused</span></span><div class="prefill">${esc(value ?? '–')}</div></div>`;
export const toLocalInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
