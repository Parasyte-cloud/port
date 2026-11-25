// Adapter: talks to the PCS server over HTTPS (JSON API + server-sent events).
export function createServerApi() {
  let token = null; try { token = sessionStorage.getItem('pcs.token'); } catch {}
  const subs = new Set(); let es = null;
  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.code = data.code; e.details = data.details; e.status = r.status; throw e; }
    return data;
  }
  function stream() {
    if (es) es.close(); if (!token) return;
    es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
    es.onmessage = (m) => { const ev = JSON.parse(m.data); subs.forEach((f) => f(ev)); };
  }
  return {
    mode: 'server',
    get signedIn() { return !!token; },
    async login(email, password) { const r = await call('POST', '/api/auth/login', { email, password }); token = r.token; try { sessionStorage.setItem('pcs.token', token); } catch {} stream(); return r; },
    logout() { token = null; try { sessionStorage.removeItem('pcs.token'); } catch {} if (es) es.close(); },
    register: (data) => call('POST', '/api/auth/register', data),
    cmd: async (type, payload) => (await call('POST', '/api/cmd', { type, payload })).result,
    q: (name, params = {}) => call('GET', `/api/q/${name}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''))}`),
    track: (ref) => call('GET', `/api/track?ref=${encodeURIComponent(ref)}`),
    reset: () => call('POST', '/api/reset'),
    rebuild: () => call('POST', '/api/dr/rebuild'),
    auditCsvUrl: () => `/api/export/audit.csv?token=${encodeURIComponent(token)}`,
    subscribe(fn) { subs.add(fn); if (token && !es) stream(); return () => subs.delete(fn); },
  };
}
