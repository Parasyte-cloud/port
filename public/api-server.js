// Adapter: talks to the shared PCS server (JSON API + WebSocket live updates).
// The session token lives in this tab only (sessionStorage), so two tabs can be two different people.
export function createServerApi() {
  let token = null; try { token = sessionStorage.getItem('pcs.token'); } catch {}
  const subs = new Set(); let ws = null, wsTimer = null, backoff = 1000, closedByUs = false, ping = null;
  const setToken = (t) => { token = t; try { t ? sessionStorage.setItem('pcs.token', t) : sessionStorage.removeItem('pcs.token'); } catch {} };
  const emit = (ev) => subs.forEach((f) => { try { f(ev); } catch (e) { console.error(e); } });

  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error || `Request failed (${r.status})`); e.code = data.code; e.details = data.details; e.status = r.status;
      if (r.status === 401 && data.code === 'AUTH' && token && !url.startsWith('/api/auth/')) { setToken(null); stopLive(); emit({ t: 'signedout' }); }
      throw e;
    }
    return data;
  }
  async function startLive() {
    stopLive(); closedByUs = false; if (!token) return;
    let ticket; try { ({ ticket } = await call('POST', '/api/ws-ticket')); } catch (e) { return e.status === 401 ? null : retry(); }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    ws.onopen = () => { backoff = 1000; emit({ t: 'live', up: true }); ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 30000); };
    ws.onmessage = (m) => { if (m.data === 'pong') return; try { const ev = JSON.parse(m.data); if (ev.t === 'hello') emit({ t: 'resync' }); else emit(ev); } catch {} };
    ws.onclose = (e) => { clearInterval(ping); emit({ t: 'live', up: false }); if (e.code === 4001) { setToken(null); emit({ t: 'signedout' }); return; } if (!closedByUs) retry(); };
  }
  function retry() { clearTimeout(wsTimer); if (!token || closedByUs) return; wsTimer = setTimeout(startLive, backoff); backoff = Math.min(backoff * 2, 30000); }
  function stopLive() { closedByUs = true; clearTimeout(wsTimer); clearInterval(ping); if (ws) { try { ws.close(1000); } catch {} ws = null; } }
  const begin = (r) => { setToken(r.token); if (r.stage === 'full') startLive(); return r; };

  return {
    mode: 'server',
    get signedIn() { return !!token; },
    config: () => call('GET', '/api/config'),
    me: () => call('GET', '/api/auth/me'),
    async login(email, password) { return begin(await call('POST', '/api/auth/login', { email, password })); },
    async mfaVerify(code) { const r = await call('POST', '/api/auth/mfa/verify', { code }); startLive(); return r; },
    mfaSetup: () => call('POST', '/api/auth/mfa/setup'),
    async mfaEnable(code) { const r = await call('POST', '/api/auth/mfa/enable', { code }); startLive(); return r; },
    mfaDisable: (password) => call('POST', '/api/auth/mfa/disable', { password }),
    forgot: (email) => call('POST', '/api/auth/password/forgot', { email }),
    inspectLink: (t) => call('POST', '/api/auth/link/inspect', { token: t }),
    async redeemLink(t, password) { return begin(await call('POST', '/api/auth/link/redeem', { token: t, password })); },
    changePassword: (current, next) => call('POST', '/api/auth/password/change', { current, next }),
    logoutAll: async () => { await call('POST', '/api/auth/logout-all'); setToken(null); stopLive(); },
    logout() { const t = token; stopLive(); setToken(null); if (t) fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${t}` } }).catch(() => {}); },
    accounts: () => call('GET', '/api/admin/accounts'),
    sendLink: (userId) => call('POST', '/api/admin/link', { userId }),
    register: () => Promise.reject(Object.assign(new Error('Accounts are by invitation only.'), { code: 'FORBIDDEN' })),
    cmd: async (type, payload) => (await call('POST', '/api/cmd', { type, payload })).result,
    q: (name, params = {}) => call('GET', `/api/q/${name}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''))}`),
    track: (ref) => call('GET', `/api/track?ref=${encodeURIComponent(ref)}`),
    reset: () => call('POST', '/api/reset'),
    rebuild: () => call('POST', '/api/dr/rebuild'),
    async auditCsv() { const r = await fetch('/api/export/audit.csv', { headers: { authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error('Export failed'); return r.text(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    live() { if (token && !ws) startLive(); },
  };
}
