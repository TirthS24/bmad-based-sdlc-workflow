// Admin dashboard. Plain DOM, no framework, no inline script or style (see the server's CSP).
// All text goes in with textContent, so nothing from the database is ever parsed as HTML.
const app = document.getElementById('app');
let token = null;
try { token = sessionStorage.getItem('wf_token'); } catch { /* storage blocked: stay in memory */ }

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(); throw new Error('session ended'); }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function signOut() {
  token = null;
  try { sessionStorage.removeItem('wf_token'); } catch { /* ignore */ }
  showLogin();
}

const fmtMs = (ms) => {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
};
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '-');

function table(cols, rows, testid) {
  return h('div', { class: 'scroll' }, h('table', { 'data-testid': testid },
    h('thead', {}, h('tr', {}, cols.map(([label]) => h('th', { scope: 'col' }, label)))),
    h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, cols.map(([, get]) => h('td', {}, get(r))))) : h('tr', {}, h('td', { colspan: cols.length, class: 'muted' }, 'No data yet')))));
}

function bars(items, value, label, format, testid) {
  const max = Math.max(1, ...items.map(value));
  return h('div', { class: 'bars card', 'data-testid': testid }, items.length ? items.map((it) => {
    const fill = h('div', { class: 'fill' });
    fill.style.width = `${Math.round((value(it) / max) * 100)}%`;
    return h('div', { class: 'row' }, h('span', {}, label(it)), h('div', { class: 'track' }, fill), h('span', {}, format(value(it))));
  }) : h('span', { class: 'muted' }, 'No data yet'));
}

const risk = (s) => h('span', { class: `badge ${s}`, 'data-testid': 'risk' }, { scrubbed_hits: 'scrubbed hits', no_hits: 'no hits found', not_checked: 'not checked' }[s] || s);

const views = {
  async overview() {
    const s = await api('GET', '/admin/summary');
    const tile = (n, l, id) => h('div', { class: 'card tile', 'data-testid': id }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
    return h('div', {},
      h('div', { class: 'tiles' },
        tile(s.runs.total, 'runs', 'tile-runs'), tile(s.runs.completed, 'completed', 'tile-completed'), tile(s.runs.aborted, 'aborted', 'tile-aborted'),
        tile(s.errors, 'errors', 'tile-errors'), tile(s.gate_rejections, 'gates held back', 'tile-gates'), tile(s.agent_failures, 'agent failures', 'tile-agents'), tile(s.users, 'users', 'tile-users')),
      h('h2', {}, 'PHI/PII risk per run'),
      h('p', { class: 'muted' }, '"No hits found" means the scrubber ran and found nothing. It is never a guarantee. "Not checked" means the harness gave no content hooks.'),
      h('div', { class: 'tiles' },
        tile(s.risk.scrubbed_hits || 0, 'scrubbed hits', 'risk-hits'), tile(s.risk.no_hits || 0, 'no hits found', 'risk-none'), tile(s.risk.not_checked || 0, 'not checked', 'risk-unchecked')));
  },
  async stages() {
    const rows = await api('GET', '/admin/stages');
    return h('div', {}, h('h2', {}, 'Total time per stage'),
      bars(rows, (r) => r.total_ms, (r) => r.stage, fmtMs, 'stage-bars'),
      h('h2', {}, 'Detail'),
      table([['Stage', (r) => r.stage], ['Runs', (r) => r.n], ['Average', (r) => fmtMs(r.avg_ms)], ['Median', (r) => fmtMs(r.median_ms)], ['Slowest', (r) => fmtMs(r.max_ms)], ['Total', (r) => fmtMs(r.total_ms)]], rows, 'stage-table'));
  },
  async errors() {
    const e = await api('GET', '/admin/errors');
    return h('div', {}, h('h2', {}, 'Errors by class'),
      bars(e.by_class, (r) => r.n, (r) => r.error_class, String, 'error-bars'),
      h('h2', {}, 'By stage'),
      table([['Stage', (r) => r.stage || '-'], ['Class', (r) => r.error_class], ['Count', (r) => r.n]], e.by_stage, 'error-table'));
  },
  async gates() {
    const g = await api('GET', '/admin/gates');
    return h('div', {}, h('h2', {}, 'Gates'),
      table([['Gate', (r) => r.gate], ['Approved', (r) => r.approved], ['Held back', (r) => r.rejected], ['Average wait', (r) => fmtMs(r.avg_wait_ms)]], g.per_gate, 'gate-table'),
      h('h2', {}, 'Held back by users'),
      table([['When', (r) => fmtTime(r.ts)], ['Who', (r) => r.user_email], ['Gate', (r) => r.gate], ['Why', (r) => r.reason || '-'], ['Waited', (r) => fmtMs(r.wait_ms)], ['Run', (r) => r.run_id]], g.rejections, 'rejection-table'));
  },
  async agents() {
    const [f, r] = await Promise.all([api('GET', '/admin/agent-failures'), api('GET', '/admin/retries')]);
    return h('div', {}, h('h2', {}, 'Agent failures'),
      table([['Agent', (x) => x.agent], ['Class', (x) => x.error_class], ['Count', (x) => x.n]], f.by_agent, 'agent-table'),
      h('h2', {}, `Retries (${r.total_rounds} rounds in total)`),
      table([['Run', (x) => x.run_id], ['Stage', (x) => x.stage], ['Rounds', (x) => x.rounds], ['Highest round', (x) => x.max_round], ['Cap', (x) => x.cap]], r.by_run_stage, 'retry-table'));
  },
  async runs() {
    const rows = await api('GET', '/admin/runs');
    return h('div', {}, h('h2', {}, 'Runs'),
      table([
        ['Run', (r) => h('button', { class: 'btn', 'data-testid': 'open-run', onclick: () => go('run', r.id) }, r.id)],
        ['User', (r) => r.user_email], ['Status', (r) => r.status], ['Started', (r) => fmtTime(r.started_at)],
        ['Errors', (r) => r.errors], ['Held back', (r) => r.rejections], ['Retries', (r) => r.loop_rounds], ['PHI/PII', (r) => risk(r.phi_pii_status)],
      ], rows, 'run-table'));
  },
  async run(id) {
    const d = await api('GET', `/admin/runs/${encodeURIComponent(id)}`);
    const attrs = (a) => Object.entries(a || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    return h('div', {}, h('p', {}, h('button', { class: 'btn', onclick: () => go('runs') }, 'Back to runs')),
      h('h2', {}, `Run ${d.run.id}`),
      h('p', { 'data-testid': 'run-meta' }, `${d.run.user_email} · ${d.run.status} · ${d.run.project || 'unknown project'} · `, risk(d.run.phi_pii_status)),
      table([['Time', (e) => fmtTime(e.ts)], ['Event', (e) => e.type], ['Stage', (e) => e.stage || '-'], ['Details', (e) => attrs(e.attrs)]], d.events, 'event-table'));
  },
  async users() {
    const [users, invites] = await Promise.all([api('GET', '/admin/users'), api('GET', '/admin/invites')]);
    const result = h('div', { 'data-testid': 'invite-result', role: 'status' });
    const email = h('input', { id: 'invite-email', type: 'email', required: 'required', autocomplete: 'off' });
    const form = h('form', { class: 'card', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        const inv = await api('POST', '/admin/invites', { email: email.value });
        result.replaceChildren(h('p', {}, `Invite for ${inv.email}, valid until ${fmtTime(inv.expires_at)}. Share this token once; it cannot be shown again:`), h('code', { class: 'token', 'data-testid': 'invite-token' }, inv.token));
        go('users', null, result);
      } catch (err) { result.replaceChildren(h('p', { class: 'error' }, err.message)); }
    } }, h('label', { for: 'invite-email' }, 'Invite by email'), email, ' ', h('button', { class: 'btn', type: 'submit' }, 'Create invite'));
    return h('div', {}, form, result,
      h('h2', {}, 'Users'),
      table([['Email', (u) => u.email], ['Role', (u) => u.role], ['Runs', (u) => u.runs], ['Status', (u) => (u.disabled_at ? 'disabled' : 'active')],
        ['', (u) => (u.role === 'admin' || u.disabled_at ? '' : h('button', { class: 'btn', onclick: async () => { await api('POST', `/admin/users/${u.id}/disable`); go('users'); } }, 'Disable'))]], users, 'user-table'),
      h('h2', {}, 'Invites'),
      table([['Email', (i) => i.email], ['Invited by', (i) => i.invited_by || '-'], ['Expires', (i) => fmtTime(i.expires_at)], ['Used', (i) => (i.used_at ? fmtTime(i.used_at) : 'no')]], invites, 'invite-table'));
  },
};

const TABS = [['overview', 'Overview'], ['stages', 'Time per stage'], ['errors', 'Errors'], ['gates', 'Gates'], ['agents', 'Agents and retries'], ['runs', 'Runs'], ['users', 'Users and invites']];

async function go(view, arg, keep) {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading...'));
  const tab = view === 'run' ? 'runs' : view;
  app.replaceChildren(h('header', { class: 'bar' }, h('h1', {}, 'Workflow usage'), h('button', { class: 'btn', 'data-testid': 'signout', onclick: signOut }, 'Sign out')),
    h('nav', { 'aria-label': 'Sections' }, TABS.map(([id, label]) => h('button', { 'aria-current': id === tab ? 'page' : false, onclick: () => go(id) }, label))), body);
  try {
    body.replaceChildren(await views[view](arg));
    if (keep) body.firstChild.insertBefore(keep, body.firstChild.children[1] || null);
  } catch (err) { body.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message)); }
}

function showLogin(message) {
  const email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: 'required' });
  const password = h('input', { id: 'password', type: 'password', autocomplete: 'current-password', required: 'required' });
  const err = h('p', { class: 'error', role: 'alert', 'data-testid': 'login-error' }, message || '');
  app.replaceChildren(h('form', { class: 'card login', onsubmit: async (ev) => {
    ev.preventDefault();
    try {
      const res = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value, password: password.value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'login failed');
      if (data.role !== 'admin') throw new Error('this dashboard is for admins only');
      token = data.token;
      try { sessionStorage.setItem('wf_token', token); } catch { /* memory only */ }
      go('overview');
    } catch (e) { err.textContent = e.message; }
  } }, h('h1', {}, 'Workflow usage'), h('label', { for: 'email' }, 'Email'), email, h('label', { for: 'password' }, 'Password'), password, h('p', {}, h('button', { class: 'btn', type: 'submit' }, 'Sign in')), err));
}

if (token) go('overview'); else showLogin();
