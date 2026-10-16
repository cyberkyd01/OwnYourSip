'use strict';
/* pi-sip-gateway admin console. Vanilla JS, no build step. */

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { me: null, status: null };
let P = {};            // per-page state, reset on every route change
let cleanups = [];     // functions run when leaving a page
let currentId = '';
let statusTimer = null;

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error('Network error: ' + e.message);
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { detail: text.slice(0, 200) }; } }
  if (!res.ok) {
    if (res.status === 401 && !['/api/login', '/api/setup', '/api/me'].includes(path)) showAuth('login');
    let d = data && data.detail;
    if (Array.isArray(d)) d = d.map((x) => x.msg || JSON.stringify(x)).join('; ');
    throw new Error(d || `HTTP ${res.status}`);
  }
  return data;
}

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'error' ? ' error' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

// Run a handler; if it returns a promise show a busy state on `el` and toast errors.
function run(el, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      if (el) el.classList.add('busy');
      return r.catch((err) => toast(err.message || String(err), 'error')).finally(() => el && el.classList.remove('busy'));
    }
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
}

function every(ms, fn) {
  const id = setInterval(fn, ms);
  cleanups.push(() => clearInterval(id));
}

function applied(r) {
  const a = r && r.applied;
  if (a && a.changed && a.changed.length) return ` Config applied (${a.changed.length} file(s) changed).`;
  return '';
}

function dot(color) { return `<i class="dot ${color}"></i>`; }
function badge(text, cls = '') { return `<span class="badge ${cls}">${esc(text)}</span>`; }
function empty(msg) { return `<div class="empty">${esc(msg)}</div>`; }

// Build a responsive table. cols: header labels ('' = actions column). rows: arrays of trusted HTML cells.
function tbl(cols, rows, emptyMsg = 'Nothing here yet.') {
  if (!rows.length) return empty(emptyMsg);
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.map((r) => '<tr>' + r.map((cell, i) =>
    `<td${cols[i] === '' ? ' class="actions"' : ''} data-label="${esc(cols[i])}">${cell}</td>`).join('') + '</tr>').join('');
  return `<div class="tablewrap"><table class="stack"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T'));
  if (isNaN(d)) return String(s);
  return d.toLocaleString();
}
function fmtTs(ts) {
  if (ts === null || ts === undefined || ts === '') return '';
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleString();
  return fmtTime(ts);
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function randPassword(n = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => chars[x % chars.length]).join('');
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  toast('Copied');
}
const val = (form, name) => (form.elements[name] ? form.elements[name].value.trim() : '');
const chk = (form, name) => !!(form.elements[name] && form.elements[name].checked);
const numOrNull = (v) => (v === '' || isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------- modal / confirm
function openModal(title, body, opts = {}) {
  $('#modalRoot').innerHTML = `<div class="overlay" data-overlay="1"><div class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <h2>${esc(title)}</h2>${body}</div></div>`;
  const f = $('#modalRoot input:not([type=hidden]):not([readonly]), #modalRoot select');
  if (f && !opts.noFocus) f.focus();
}
function closeModal() { $('#modalRoot').innerHTML = ''; P.modal = null; }
function confirmDlg(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const prev = $('#modalRoot').innerHTML;
    openModal('Please confirm', `<p>${esc(message)}</p><div class="row end">
      <button class="btn secondary" data-act="confirm-no">Cancel</button>
      <button class="btn danger" data-act="confirm-yes">${esc(okLabel)}</button></div>`, { noFocus: true });
    P.confirmResolve = (v) => { P.confirmResolve = null; $('#modalRoot').innerHTML = prev; resolve(v); };
  });
}

// ---------------------------------------------------------------- auth gate
function showAuth(mode) {
  stopAll();
  state.me = state.me ? { ...state.me, user: null } : state.me;
  $('#shell').classList.add('hidden');
  const el = $('#auth');
  el.classList.remove('hidden');
  const setup = mode === 'setup';
  el.innerHTML = `<form data-form="${setup ? 'setup' : 'login'}" autocomplete="on">
    <h1>${setup ? 'Create admin account' : 'Sign in'}</h1>
    <p class="muted small">${setup ? 'First run: choose the administrator credentials for this gateway.' : 'pi-sip-gateway admin console'}</p>
    <label>Username<input name="username" autocomplete="username" required value="${setup ? 'admin' : ''}"></label>
    <label>Password<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 6 : 1}"></label>
    <button class="btn" type="submit">${setup ? 'Create account' : 'Sign in'}</button>
  </form>`;
}

function enterApp() {
  $('#auth').classList.add('hidden');
  $('#auth').innerHTML = '';
  $('#shell').classList.remove('hidden');
  $('#mockBadge').classList.toggle('hidden', !(state.me && state.me.mock));
  buildNav();
  if (!location.hash) location.hash = '#/dashboard';
  route();
}

async function boot() {
  try {
    state.me = await api('GET', '/api/me');
  } catch (e) {
    document.body.innerHTML = `<p style="padding:16px">Cannot reach the gateway API: ${esc(e.message)}</p>`;
    return;
  }
  if (state.me.setup_needed) showAuth('setup');
  else if (!state.me.user) showAuth('login');
  else enterApp();
}

// ---------------------------------------------------------------- shell: nav, status pill
const ICONS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  extensions: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  trunks: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  routing: 'M6 3v12M18 9v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  softphone: 'M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4l2.8.7a2 2 0 0 1 1.7 2z',
  calllog: 'M12 8v4l3 3M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  sms: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  remote: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z',
  advanced: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
};
const PAGES = [
  { id: 'dashboard', label: 'Dashboard', render: pDashboard },
  { id: 'extensions', label: 'Extensions', render: pExtensions },
  { id: 'trunks', label: 'Trunks', render: pTrunks },
  { id: 'routing', label: 'Routing', render: pRouting },
  { id: 'softphone', label: 'Softphone', render: pSoftphone },
  { id: 'calllog', label: 'Call Log', render: pCallLog },
  { id: 'sms', label: 'SMS', render: pSms },
  { id: 'remote', label: 'Remote Access', render: pRemote },
  { id: 'advanced', label: 'Advanced', render: pAdvanced },
];
function buildNav() {
  $('#nav').innerHTML = PAGES.map((p) => `<a href="#/${p.id}" data-nav="${p.id}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[p.id]}"/></svg>${esc(p.label)}</a>`).join('');
}

function setPill(connected) {
  const pill = $('#statusPill');
  if (!pill) return;
  if (connected === null) pill.innerHTML = `${dot('amber')}<span>Asterisk unknown</span>`;
  else pill.innerHTML = `${dot(connected ? 'green' : 'red')}<span>Asterisk ${connected ? 'connected' : 'disconnected'}</span>`;
}

async function pollStatus() {
  clearTimeout(statusTimer);
  let s = null;
  if (state.me && state.me.user) {
    try {
      s = await api('GET', '/api/status');
      state.status = s;
      setPill(!!(s.asterisk && s.asterisk.connected));
      if (currentId === 'dashboard' && P.onStatus) P.onStatus(s);
    } catch { setPill(null); }
    statusTimer = setTimeout(pollStatus, currentId === 'dashboard' ? 5000 : 15000);
  }
  return s;
}

function stopAll() {
  clearTimeout(statusTimer);
  cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
  cleanups = [];
}

async function route() {
  if (!state.me || !state.me.user) return;
  cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
  cleanups = [];
  const id = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  currentId = page.id;
  P = {};
  $('#sidebar').classList.remove('open');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === page.id));
  const main = $('#main');
  main.innerHTML = `<h1>${esc(page.label)}</h1><div id="page"><p class="muted"><span class="spinner"></span> Loading…</p></div>`;
  const root = $('#page');
  const mine = root;
  try {
    await page.render(root);
  } catch (e) {
    if (mine.isConnected) mine.innerHTML = `<div class="note err">${esc(e.message)}</div>`;
  }
  if (page.id !== 'dashboard') pollStatus();
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- Dashboard
function trunkColor(live) {
  if (!live) return 'grey';
  const st = String(live.state || '');
  if (/fail|not|disconnect/i.test(st)) return 'red';
  if (/^(free|connected)$/i.test(st)) return 'green';
  return 'amber';
}
function rssiBar(rssi) {
  const n = Number(rssi);
  if (rssi === '' || rssi === null || rssi === undefined || isNaN(n) || n > 31) return '<span class="muted">n/a</span>';
  return `<div class="row" style="flex-wrap:nowrap"><div class="bar"><span style="width:${Math.round(n / 31 * 100)}%"></span></div><span class="small">${n}/31</span></div>`;
}

async function pDashboard(root) {
  root.innerHTML = `<div id="dashLive"></div>
    <div class="card"><h2>Click to call</h2>
      <p class="muted small">Rings the extension first, then dials the number through the outbound routes.</p>
      <form data-form="originate" class="form-grid">
        <label>Extension<select name="ext" id="ccExt"></select></label>
        <label>Number to dial<input name="number" required placeholder="0912345678" autocomplete="off"></label>
        <div><button class="btn" type="submit">Call</button></div>
      </form></div>`;
  const draw = (s) => {
    const el = $('#dashLive');
    if (!el) return;
    const regs = (s.extensions || []).filter((e) => e.registered).length;
    const net = s.network || {}, cf = s.cloudflared || {}, ts = s.tailscale || {};
    el.innerHTML = `<div class="grid">
      <div class="card"><h2>Asterisk</h2><div class="row">${dot(s.asterisk && s.asterisk.connected ? 'green' : 'red')}<b>${s.asterisk && s.asterisk.connected ? 'Connected' : 'Disconnected'}</b></div>
        <p class="muted small">${esc((s.asterisk && s.asterisk.version) || 'version unknown')}</p></div>
      <div class="card"><h2>Extensions</h2><div style="font-size:2rem;font-weight:700">${regs} <span class="muted" style="font-size:1rem">/ ${(s.extensions || []).length} registered</span></div></div>
      <div class="card"><h2>Network</h2><dl class="kv">
        <dt>Hostname</dt><dd>${esc(net.hostname || '-')}</dd>
        <dt>LAN IP</dt><dd>${esc(net.lan_ip || '-')}</dd>
        <dt>Public IP</dt><dd>${esc(net.public_ip || '-')}</dd>
        <dt>Tailscale IP</dt><dd>${esc(ts.running && ts.ip ? ts.ip : '-')}</dd>
        <dt>Cloudflare tunnel</dt><dd>${cf.active ? dot('green') + ' active' : dot('grey') + (cf.installed ? ' inactive' : ' not installed')}</dd></dl></div>
    </div>
    <h2>Trunks</h2>
    ${(s.trunks || []).length ? `<div class="grid">${s.trunks.map((t) => {
      const l = t.live;
      return `<div class="card"><div class="row">${dot(trunkColor(l))}<b>${esc(t.name)}</b>${badge(t.tech)}${t.enabled ? '' : badge('disabled', 'warn')}</div>
        <div class="muted small">${esc(t.label || '')}</div>
        ${l ? `<dl class="kv" style="margin-top:8px"><dt>State</dt><dd>${esc(l.state || '-')}</dd>
          <dt>Signal</dt><dd>${rssiBar(l.rssi)}</dd><dt>Provider</dt><dd>${esc(l.provider || '-')}</dd>
          <dt>Number</dt><dd>${esc(l.number || '-')}</dd></dl>` : '<p class="muted small">No live data from driver.</p>'}</div>`;
    }).join('')}</div>` : '<div class="card">' + empty('No trunks configured. Add one on the Trunks page.') + '</div>'}
    <div class="card"><h2>Active calls</h2>${tbl(['Channel', 'Caller', 'Exten', 'State', 'Duration', ''],
      (s.channels || []).map((c) => [esc(c.channel), esc(c.callerid), esc(c.exten), esc(c.state), esc(c.duration),
        `<button class="btn small danger" data-act="hangup" data-ch="${esc(c.channel)}">Hangup</button>`]), 'No active calls.')}</div>`;
    const sel = $('#ccExt');
    if (sel && !P.ccBuilt && (s.extensions || []).length) {
      P.ccBuilt = true;
      sel.innerHTML = s.extensions.map((e) => `<option value="${esc(e.ext)}">${esc(e.ext)} - ${esc(e.name)}</option>`).join('');
    }
  };
  P.onStatus = draw;
  const s = await pollStatus();
  if (!s) $('#dashLive').innerHTML = '<div class="note err">Could not load status.</div>';
}

// ---------------------------------------------------------------- Extensions
async function pExtensions(root) {
  P.root = root;
  await loadExtensions();
}
async function loadExtensions() {
  const [exts, st] = await Promise.all([api('GET', '/api/extensions'), api('GET', '/api/status').catch(() => null)]);
  P.exts = exts; P.st = st;
  const live = {};
  ((st && st.extensions) || []).forEach((e) => { live[e.ext] = e; });
  const root = P.root;
  if (!root || !root.isConnected) return;
  root.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">Extensions</h2><button class="btn right" data-act="ext-add">Add extension</button></div>
    ${tbl(['Ext', 'Name', 'Browser login', 'Registered', 'Web registered', ''], exts.map((e) => {
      const l = live[e.ext] || {};
      return [`<b>${esc(e.ext)}</b>`, esc(e.name), e.webrtc ? 'Enabled' : 'Off',
        `${dot(l.registered ? 'green' : 'grey')} ${l.registered ? esc((l.contacts || [])[0] || 'registered') : 'offline'}`,
        dot(l.web_registered ? 'green' : 'grey') + (l.web_registered ? ' online' : ''),
        `<button class="btn small secondary" data-act="ext-cfg" data-ext="${esc(e.ext)}">Show config</button>
         <button class="btn small secondary" data-act="ext-edit" data-ext="${esc(e.ext)}">Edit</button>
         <button class="btn small danger" data-act="ext-del" data-ext="${esc(e.ext)}">Delete</button>`];
    }), 'No extensions yet.')}</div>`;
}
function extForm(e) {
  const edit = !!e;
  return `<form data-form="ext" data-edit="${edit ? esc(e.ext) : ''}">
    <label>Extension (2-8 digits)<input name="ext" pattern="[0-9]{2,8}" required value="${edit ? esc(e.ext) : ''}" ${edit ? 'readonly' : ''}></label>
    <label>Display name<input name="name" value="${edit ? esc(e.name) : ''}"></label>
    <label>Password${edit ? '' : ' (leave blank to let the server generate one)'}
      <div class="inline"><input name="secret" autocomplete="off" value="${edit ? esc(e.secret) : ''}"><button type="button" class="btn secondary" data-act="gen-pass">Generate</button></div></label>
    <label class="check"><input type="checkbox" name="webrtc" ${!edit || e.webrtc ? 'checked' : ''}> Enable browser softphone login</label>
    <div class="row end"><button type="button" class="btn secondary" data-act="modal-close">Cancel</button><button class="btn" type="submit">Save</button></div></form>`;
}
function extConfigModal(e) {
  const net = (P.st && P.st.network) || {}, ts = (P.st && P.st.tailscale) || {};
  const host = location.hostname;
  const alts = [];
  if (net.lan_ip && net.lan_ip !== host) alts.push(['LAN IP', net.lan_ip]);
  if (ts.running && ts.ip && ts.ip !== host) alts.push(['Tailscale IP', ts.ip]);
  const row = (k, v) => `<div class="cfgrow"><b>${esc(k)}</b><code>${esc(v)}</code><button class="btn small secondary" data-act="copy" data-v="${esc(v)}">Copy</button></div>`;
  openModal(`SIP settings for ${e.ext}`, `
    <p class="muted small">Type these into Zoiper, X-Lite or any SIP app.</p>
    ${row('Server / Domain', host)}
    ${alts.map(([k, v]) => row('Alt: ' + k, v)).join('')}
    ${row('Username', e.ext)}${row('Password', e.secret)}${row('Transport', 'UDP (TCP also works)')}${row('Port', '5060')}
    <div class="note">Remote over the internet: connect through Tailscale, or use the Softphone page in this browser.</div>
    <div class="row end"><button class="btn secondary" data-act="modal-close">Close</button></div>`, { noFocus: true });
}

// ---------------------------------------------------------------- Trunks
const TECH_LABEL = { dongle: 'Huawei (chan_dongle)', quectel: 'Quectel / SimCom (chan_quectel)', mobile: 'Bluetooth phone (chan_mobile)' };
async function pTrunks(root) {
  P.root = root; P.disc = null; P.bt = null; P.btAdapters = []; P.pair = {};
  await loadTrunks();
  api('GET', '/api/bluetooth/adapters').then((r) => { P.btAdapters = r.adapters || []; drawTrunks(); }).catch(() => {});
}
async function loadTrunks() {
  P.trunks = await api('GET', '/api/trunks');
  drawTrunks();
}
function drawTrunks() {
  const root = P.root;
  if (!root || !root.isConnected) return;
  const d = P.disc;
  const bt = P.bt;
  root.innerHTML = `
  <div class="card"><div class="row"><h2 style="margin:0">Configured trunks</h2>
    <button class="btn secondary right" data-act="tr-refresh">Refresh</button><button class="btn" data-act="tr-add">Add trunk</button></div>
    ${tbl(['Name', 'Type', 'Label', 'State', 'Signal', 'Enabled', ''], P.trunks.map((t) => {
      const l = t.live;
      return [`<b>${esc(t.name)}</b>`, badge(t.tech), esc(t.label), `${dot(trunkColor(l))} ${esc(l ? l.state : 'unknown')}`,
        l && t.tech !== 'mobile' ? rssiBar(l.rssi) : '-', t.enabled ? 'Yes' : 'No',
        `<button class="btn small secondary" data-act="tr-edit" data-name="${esc(t.name)}">Edit</button>
         <button class="btn small danger" data-act="tr-del" data-name="${esc(t.name)}">Delete</button>`];
    }), 'No trunks configured yet.')}</div>

  <div class="card"><div class="row"><h2 style="margin:0">USB modems</h2><button class="btn right" data-act="usb-scan">Scan USB modems</button></div>
    <p class="muted small">Plug in a Huawei or Quectel/SimCom USB modem with a SIM, then scan.</p>
    ${d ? `<h3>Discovered devices</h3>${tbl(['Type', 'IMEI', 'IMSI', 'Audio port', 'Data port', ''], (d.devices || []).map((x, i) =>
      [badge(x.tech), esc(x.imei), esc(x.imsi), esc(x.audio), esc(x.data),
        `<button class="btn small" data-act="usb-add" data-i="${i}">Add as trunk</button>`]), 'No modems detected.')}
      <h3>Drivers loaded</h3><div class="row">${Object.entries(d.drivers || {}).map(([k, v]) => `<span class="pill">${dot(v ? 'green' : 'red')} ${esc(k)}</span>`).join('') || '<span class="muted">unknown</span>'}</div>
      <details><summary>Serial ports (${(d.ports || []).length})</summary>
        ${tbl(['Port id', 'Device'], (d.ports || []).map((p) => [`<code>${esc(p.id)}</code>`, `<code>${esc(p.dev)}</code>`]), 'No serial ports found.')}</details>` : ''}
  </div>

  <div class="card"><h2>Bluetooth phones</h2>
    <div class="row">
      <label style="margin:0;flex:1;min-width:220px">Adapter<select data-change="bt-adapter">
        ${P.btAdapters.length ? P.btAdapters.map((a) => `<option value="${esc(a.address)}" ${a.default ? 'selected' : ''}>${esc(a.name || a.address)} (${esc(a.address)})</option>`).join('') : '<option value="">No adapters found</option>'}</select></label>
      <button class="btn" data-act="bt-scan">Search for phones (10 s)</button></div>
    ${bt ? (bt.error ? `<div class="note err">${esc(bt.error)}</div>` : '') +
      tbl(['Name', 'Address', 'Usable', 'Port', ''], (bt.phones || []).map((p, i) => [esc(p.name), `<code>${esc(p.address)}</code>`,
        /^y/i.test(String(p.usable)) ? dot('green') + ' yes' : dot('red') + ' no', esc(p.port ?? ''),
        `<button class="btn small secondary" data-act="bt-pair" data-i="${i}">Pair</button>
         <button class="btn small" data-act="bt-add" data-i="${i}">Add as trunk</button>
         ${P.pair[p.address] ? `<div class="small">${P.pair[p.address].busy ? '<span class="spinner"></span> Accept the pairing prompt on the phone…' : `<pre>${esc(P.pair[p.address].output)}</pre>`}</div>` : ''}`]),
      'No phones found. Make the phone discoverable and search again.') : ''}
  </div>`;
}

function trunkForm(t, pre) {
  const edit = !!t;
  const tr = t || pre || { tech: 'dongle', name: '', label: '', config: {}, enabled: 1 };
  const c = tr.config || {};
  const isMobile = tr.tech === 'mobile';
  return `<form data-form="trunk" data-edit="${edit ? esc(t.name) : ''}">
    <div class="form-grid">
      <label>Name (letters, digits, underscore)<input name="name" required pattern="[A-Za-z0-9_]{1,24}" value="${esc(tr.name)}" ${edit ? 'readonly' : ''}></label>
      <label>Label<input name="label" value="${esc(tr.label)}" placeholder="Vodafone SIM"></label>
      <label>Type<select name="tech" data-change="tech" ${edit ? 'disabled' : ''}>
        ${['dongle', 'quectel', 'mobile'].map((k) => `<option value="${k}" ${tr.tech === k ? 'selected' : ''}>${esc(TECH_LABEL[k])}</option>`).join('')}</select></label>
    </div>
    <div data-techbox="usb" class="${isMobile ? 'hidden' : ''}"><div class="form-grid">
      <label>IMEI<input name="imei" value="${esc(c.imei)}"></label>
      <label>IMSI<input name="imsi" value="${esc(c.imsi)}"></label>
      <label>Audio port (manual)<input name="audio" placeholder="/dev/ttyUSB1" value="${esc(c.audio)}"></label>
      <label>Data port (manual)<input name="data" placeholder="/dev/ttyUSB2" value="${esc(c.data)}"></label>
      <label>RX gain (optional)<input name="rxgain" type="number" step="any" value="${esc(c.rxgain ?? '')}"></label>
      <label>TX gain (optional)<input name="txgain" type="number" step="any" value="${esc(c.txgain ?? '')}"></label></div>
      <p class="muted small">Give either the IMEI, or both audio and data ports.</p></div>
    <div data-techbox="bt" class="${isMobile ? '' : 'hidden'}"><div class="form-grid">
      <label>Bluetooth address<input name="address" placeholder="AA:BB:CC:DD:EE:FF" value="${esc(c.address)}"></label>
      <label>RFCOMM port<input name="port" type="number" value="${esc(c.port ?? '')}"></label></div></div>
    <label class="check"><input type="checkbox" name="enabled" ${tr.enabled ? 'checked' : ''}> Enabled</label>
    <div class="row end"><button type="button" class="btn secondary" data-act="modal-close">Cancel</button><button class="btn" type="submit">Save</button></div></form>`;
}

// ---------------------------------------------------------------- Routing
async function pRouting(root) {
  P.root = root;
  await loadRouting();
}
async function loadRouting() {
  const [ob, ib, trunks, exts] = await Promise.all([api('GET', '/api/routes/outbound'), api('GET', '/api/routes/inbound'),
    api('GET', '/api/trunks'), api('GET', '/api/extensions')]);
  Object.assign(P, { ob, ib, trunks, exts });
  const root = P.root;
  if (!root || !root.isConnected) return;
  root.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">Outbound routes</h2><button class="btn right" data-act="ob-add">Add route</button></div>
    <p class="muted small">Asterisk picks the most specific matching pattern, not the list order. Trunks are tried in order until one connects.</p>
    ${tbl(['Label', 'Pattern', 'Strip', 'Prepend', 'Trunk order', 'Enabled', ''], ob.map((r) => [esc(r.label), `<code>${esc(r.pattern)}</code>`, esc(r.strip), esc(r.prepend),
      esc((r.trunks || []).join(' → ')), r.enabled ? 'Yes' : 'No',
      `<button class="btn small secondary" data-act="ob-edit" data-id="${esc(r.id)}">Edit</button> <button class="btn small danger" data-act="ob-del" data-id="${esc(r.id)}">Delete</button>`]), 'No outbound routes. Calls cannot go out until you add one.')}</div>
    <div class="card"><div class="row"><h2 style="margin:0">Inbound routes</h2><button class="btn right" data-act="ib-add">Add route</button></div>
    <div class="note">A trunk with no inbound route rings every extension.</div>
    ${tbl(['Trunk', 'Destinations', 'Ring time', 'Enabled', ''], ib.map((r) => [esc(r.trunk), esc((r.destinations || []).join(', ')), esc(r.ring_time) + ' s', r.enabled ? 'Yes' : 'No',
      `<button class="btn small secondary" data-act="ib-edit" data-id="${esc(r.id)}">Edit</button> <button class="btn small danger" data-act="ib-del" data-id="${esc(r.id)}">Delete</button>`]), 'No inbound routes.')}</div>`;
}
function ordHtml() {
  const o = P.ord;
  const avail = P.trunks.map((t) => t.name).filter((n) => !o.includes(n));
  return `<ul class="ordlist">${o.map((n, i) => `<li><span>${i + 1}. ${esc(n)}</span>
      <button type="button" class="btn small secondary" data-act="ord-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>Up</button>
      <button type="button" class="btn small secondary" data-act="ord-down" data-i="${i}" ${i === o.length - 1 ? 'disabled' : ''}>Down</button>
      <button type="button" class="btn small danger" data-act="ord-rm" data-i="${i}">Remove</button></li>`).join('') || '<li class="muted">No trunks selected</li>'}</ul>
    <div class="inline"><select id="ordSel" ${avail.length ? '' : 'disabled'}>${avail.map((n) => `<option>${esc(n)}</option>`).join('')}</select>
    <button type="button" class="btn secondary" data-act="ord-add" ${avail.length ? '' : 'disabled'}>Add trunk</button></div>`;
}
function obForm(r) {
  r = r || { label: '', pattern: '_X.', strip: 0, prepend: '', trunks: [], enabled: 1 };
  P.ord = [...(r.trunks || [])];
  return `<form data-form="ob" data-id="${r.id ?? ''}">
    <label>Label<input name="label" required value="${esc(r.label)}"></label>
    <label>Pattern<input name="pattern" required value="${esc(r.pattern)}"></label>
    <div class="note small">Patterns: <code>_X.</code> anything; <code>_0X.</code> numbers starting with 0; <code>_+X.</code> numbers starting with +.
      X = any digit, N = 2-9, Z = 1-9, <code>.</code> = one or more further characters. Asterisk picks the most specific match.</div>
    <div class="form-grid"><label>Strip leading digits<input name="strip" type="number" min="0" value="${esc(r.strip)}"></label>
    <label>Prepend<input name="prepend" value="${esc(r.prepend)}"></label></div>
    <label>Trunk order (failover)</label><div id="ordBox">${ordHtml()}</div>
    <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Enabled</label>
    <div class="row end"><button type="button" class="btn secondary" data-act="modal-close">Cancel</button><button class="btn" type="submit">Save</button></div></form>`;
}
function ibForm(r) {
  r = r || { trunk: '', destinations: [], ring_time: 30, enabled: 1 };
  return `<form data-form="ib" data-id="${r.id ?? ''}">
    <label>Trunk<select name="trunk" required>${P.trunks.map((t) => `<option ${t.name === r.trunk ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label>Ring these extensions</label>
    <div style="margin-bottom:10px">${P.exts.map((e) => `<label class="check"><input type="checkbox" name="dest" value="${esc(e.ext)}" ${(r.destinations || []).includes(e.ext) ? 'checked' : ''}> ${esc(e.ext)} - ${esc(e.name)}</label>`).join('') || '<span class="muted">No extensions</span>'}</div>
    <label>Ring time (seconds)<input name="ring_time" type="number" min="5" value="${esc(r.ring_time)}"></label>
    <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Enabled</label>
    <div class="row end"><button type="button" class="btn secondary" data-act="modal-close">Cancel</button><button class="btn" type="submit">Save</button></div></form>`;
}

// ---------------------------------------------------------------- Softphone (JsSIP)
const SP = { ua: null, session: null, incoming: null, timer: null, t0: 0, ring: null, ctx: null, ice: [], info: null };

function spCleanup() {
  stopRing();
  clearInterval(SP.timer); SP.timer = null;
  try { if (SP.session) SP.session.terminate(); } catch { /* ignore */ }
  try { if (SP.ua) SP.ua.stop(); } catch { /* ignore */ }
  SP.ua = null; SP.session = null; SP.incoming = null;
}
function startRing() {
  stopRing();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    SP.ctx = SP.ctx || new Ctx();
    if (SP.ctx.resume) SP.ctx.resume();
    let on = false;
    const beep = () => {
      on = !on;
      if (!on) return;
      const o = SP.ctx.createOscillator(), g = SP.ctx.createGain();
      o.frequency.value = 440; g.gain.value = 0.15;
      o.connect(g); g.connect(SP.ctx.destination);
      o.start(); o.stop(SP.ctx.currentTime + 0.8);
    };
    beep();
    SP.ring = setInterval(() => { on = false; beep(); }, 2500);
  } catch { /* audio not available */ }
}
function stopRing() { if (SP.ring) { clearInterval(SP.ring); SP.ring = null; } }

function spUi() {
  const s = SP.session;
  const active = !!s && !SP.incoming;
  const set = (id, fn) => { const e = $('#' + id); if (e) fn(e); };
  set('spBanner', (e) => {
    e.classList.toggle('hidden', !SP.incoming);
    if (SP.incoming) $('#spCaller', e).textContent = (SP.incoming.remote_identity && SP.incoming.remote_identity.uri.user) || 'unknown';
  });
  set('spCall', (e) => { e.disabled = !SP.ua || !SP.ua.isRegistered() || !!s; });
  set('spHang', (e) => { e.disabled = !s; });
  set('spMute', (e) => { e.disabled = !active; e.textContent = s && s.isMuted && s.isMuted().audio ? 'Unmute' : 'Mute'; });
  set('spTimerBox', (e) => e.classList.toggle('hidden', !active));
}
function spState(txt, color) {
  const e = $('#spReg');
  if (e) e.innerHTML = `${dot(color)} ${esc(txt)}`;
}
function attachMedia(session) {
  const audio = $('#spAudio');
  const pc = session.connection;
  if (!pc || session._mediaAttached || !audio) return;
  session._mediaAttached = true;
  pc.addEventListener('track', (e) => { if (e.streams && e.streams[0]) { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); } });
  pc.addEventListener('addstream', (e) => { audio.srcObject = e.stream; audio.play().catch(() => {}); });
}
function spBind(session) {
  SP.session = session;
  session.on('peerconnection', () => attachMedia(session));
  session.on('progress', () => spState('Ringing…', 'amber'));
  const onUp = () => {
    attachMedia(session);
    SP.incoming = null; stopRing();
    if (!SP.timer) {
      SP.t0 = Date.now();
      SP.timer = setInterval(() => { const t = $('#spTimer'); if (t) t.textContent = fmtDur((Date.now() - SP.t0) / 1000); }, 1000);
    }
    spState('In call', 'green'); spUi();
  };
  session.on('accepted', onUp);
  session.on('confirmed', onUp);
  const onEnd = (e) => {
    if (SP.session !== session) return;
    stopRing(); clearInterval(SP.timer); SP.timer = null;
    SP.session = null; SP.incoming = null;
    const t = $('#spTimer'); if (t) t.textContent = '00:00';
    const a = $('#spAudio'); if (a) a.srcObject = null;
    spState(e && e.cause ? `Call ended: ${e.cause}` : 'Call ended', 'grey');
    spUi();
  };
  session.on('ended', onEnd);
  session.on('failed', onEnd);
  session.on('muted', spUi);
  session.on('unmuted', spUi);
  spUi();
}
function spConnect() {
  if (!window.JsSIP) throw new Error('JsSIP failed to load');
  const ext = $('#spExt').value;
  const e = SP.info.extensions.find((x) => x.ext === ext);
  if (!e) throw new Error('Choose an extension');
  try { localStorage.setItem('psg_ext', ext); } catch { /* ignore */ }
  if (SP.ua) { try { SP.ua.stop(); } catch { /* ignore */ } SP.ua = null; }
  const socket = new JsSIP.WebSocketInterface(SP.info.ws_url);
  const ua = new JsSIP.UA({ sockets: [socket], uri: `sip:${e.ext}-web@${SP.info.domain}`, password: e.secret,
    display_name: e.name || e.ext, register: true, session_timers: false });
  ua.on('connected', () => spState('Connected, registering…', 'amber'));
  ua.on('disconnected', () => { spState('Disconnected from server', 'red'); spUi(); });
  ua.on('registered', () => { spState('Registered as ' + e.ext, 'green'); spUi(); });
  ua.on('unregistered', () => { spState('Unregistered', 'grey'); spUi(); });
  ua.on('registrationFailed', (d) => { spState('Registration failed: ' + (d.cause || ''), 'red'); spUi(); });
  ua.on('newRTCSession', (d) => {
    const s = d.session;
    if (SP.session && s !== SP.session) { try { s.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch { /* ignore */ } return; }
    if (d.originator === 'remote') { SP.incoming = s; startRing(); }
    spBind(s);
  });
  SP.ua = ua;
  ua.start();
  spState('Connecting…', 'amber');
  $('#spConn').textContent = 'Disconnect';
  $('#spConn').dataset.act = 'sp-disconnect';
}
function spOpts() {
  return { mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: SP.ice }, rtcOfferConstraints: { offerToReceiveAudio: true } };
}

async function pSoftphone(root) {
  cleanups.push(() => { spCleanup(); });
  const warn = [];
  if (!window.JsSIP) warn.push('The JsSIP library could not be loaded (the browser needs internet access to cdn.jsdelivr.net). The softphone is unavailable.');
  if (!navigator.mediaDevices) warn.push('Microphone access is unavailable. Open this page over HTTPS (or localhost) to use the browser softphone.');
  const [info, ice] = await Promise.all([api('GET', '/api/softphone'), api('GET', '/api/ice').catch(() => ({ iceServers: [] }))]);
  SP.info = info; SP.ice = (ice && ice.iceServers) || [];
  let last = ''; try { last = localStorage.getItem('psg_ext') || ''; } catch { /* ignore */ }
  const exts = info.extensions || [];
  root.innerHTML = `${warn.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
  <div id="spBanner" class="banner hidden"><b>Incoming call from <span id="spCaller"></span></b>
    <button class="btn" data-act="sp-answer">Answer</button><button class="btn danger" data-act="sp-hang">Reject</button></div>
  <div class="card" style="max-width:520px">
    ${exts.length ? `<div class="inline"><label>Extension<select id="spExt">${exts.map((e) => `<option value="${esc(e.ext)}" ${e.ext === last ? 'selected' : ''}>${esc(e.ext)} - ${esc(e.name)}</option>`).join('')}</select></label>
      <button class="btn" id="spConn" data-act="sp-connect" ${window.JsSIP ? '' : 'disabled'}>Connect</button></div>`
      : '<div class="note warn">No extensions have browser login enabled. Enable it on the Extensions page.</div>'}
    <p id="spReg" class="small">${dot('grey')} Not connected</p>
    <label>Number<input id="spNum" inputmode="tel" autocomplete="off" placeholder="Number to dial"></label>
    <div class="dialpad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => `<button class="btn secondary" data-act="sp-dtmf" data-d="${d}">${d}</button>`).join('')}</div>
    <div class="row"><button class="btn" id="spCall" data-act="sp-call" disabled>Call</button>
      <button class="btn danger" id="spHang" data-act="sp-hang" disabled>Hang up</button>
      <button class="btn secondary" id="spMute" data-act="sp-mute" disabled>Mute</button></div>
    <p id="spTimerBox" class="hidden">Call time <span class="timer" id="spTimer">00:00</span></p>
    <audio id="spAudio" autoplay></audio>
  </div>`;
}

// ---------------------------------------------------------------- Call log
async function pCallLog(root) {
  P.root = root; P.q = '';
  root.innerHTML = `<div class="card"><div class="row"><input class="filter" id="cdrQ" placeholder="Filter…" style="margin:0"><button class="btn right" data-act="cdr-refresh">Refresh</button></div>
    <div id="cdrBox"></div></div>`;
  await loadCdr();
}
async function loadCdr() {
  P.cdr = await api('GET', '/api/cdr?limit=200');
  drawCdr();
}
function drawCdr() {
  const box = $('#cdrBox');
  if (!box) return;
  const q = (P.q || '').toLowerCase();
  const rows = P.cdr.filter((r) => !q || [r.start, r.src, r.dst, r.direction, r.trunk, r.disposition].join(' ').toLowerCase().includes(q));
  box.innerHTML = tbl(['Time', 'Dir', 'From', 'To', 'Trunk', 'Result', 'Talk time'], rows.map((r) => [esc(fmtTime(r.start)),
    badge(r.direction || '?', r.direction === 'in' || r.direction === 'inbound' ? 'in' : 'out'), esc(r.src), esc(r.dst), esc(r.trunk), esc(r.disposition), esc(fmtDur(Number(r.billsec) || 0))]), 'No calls recorded.');
}

// ---------------------------------------------------------------- SMS
async function pSms(root) {
  P.root = root;
  const trunks = await api('GET', '/api/trunks');
  root.innerHTML = `<div class="split"><div class="card"><div class="row"><h2 style="margin:0">Messages</h2><button class="btn secondary right" data-act="sms-refresh">Refresh</button></div><div id="smsBox"></div></div>
    <div class="card"><h2>Send SMS</h2><form data-form="sms">
      <label>Trunk<select name="trunk" required>${trunks.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}${t.label ? ' - ' + esc(t.label) : ''}</option>`).join('')}</select></label>
      <label>Number<input name="number" required placeholder="+919876543210"></label>
      <label>Message<textarea name="body" required style="font-family:inherit"></textarea></label>
      <button class="btn" type="submit">Send</button><div id="smsOut"></div></form></div></div>`;
  await loadSms();
  every(15000, () => loadSms().catch(() => {}));
}
async function loadSms() {
  const list = await api('GET', '/api/sms?limit=200');
  const box = $('#smsBox');
  if (!box) return;
  box.innerHTML = tbl(['Dir', 'Trunk', 'Number', 'Message', 'Time'], list.map((m) => [badge(m.direction, m.direction === 'in' ? 'in' : 'out'),
    esc(m.trunk), esc(m.number), `<span style="white-space:pre-wrap">${esc(m.body)}</span>`, esc(fmtTs(m.ts))]), 'No messages.');
}

// ---------------------------------------------------------------- Remote access
async function pRemote(root) {
  P.root = root;
  root.innerHTML = '<div id="rmCf"></div><div id="rmTs"></div><div id="rmTurn"></div><div id="rmNet"></div>';
  await loadRemote();
}
async function loadRemote(only) {
  const r = await api('GET', '/api/remote');
  P.r = r;
  if (!$('#rmCf')) return r;
  if (!only || only === 'ts') drawTs(r);
  if (!only) { drawCf(r); drawTurn(r); drawNet(r); }
  return r;
}
function drawCf(r) {
  const c = r.cloudflared || {};
  $('#rmCf').innerHTML = `<div class="card"><h2>Cloudflare Tunnel</h2>
    <p>${c.active ? dot('green') + ' Active' : dot('grey') + (c.installed ? ' Installed, not running' : ' Not installed')}</p>
    <ol class="small"><li>Zero Trust dashboard → Networks → Tunnels → Create tunnel (Cloudflared).</li><li>Copy the token and paste it below.</li>
      <li>Add a Public Hostname pointing to <code>http://localhost:8080</code> (plain HTTP).</li><li>Optionally protect it with Cloudflare Access.</li></ol>
    <form data-form="cf-install"><label>Tunnel token<textarea name="token" placeholder="eyJ…" required></textarea></label>
      <div class="row"><button class="btn" type="submit">Install tunnel</button>
      <button type="button" class="btn danger" data-act="cf-uninstall">Uninstall</button></div></form>
    <div id="cfOut"></div>
    <form data-form="cf-host" class="inline" style="margin-top:12px"><label>Public hostname<input name="public_hostname" placeholder="pbx.example.com" value="${esc(r.public_hostname || '')}"></label><button class="btn" type="submit">Save</button></form>
    <details><summary>Tunnel log</summary><pre>${esc(c.log || '(empty)')}</pre></details></div>`;
}
function drawTs(r) {
  const t = r.tailscale || {};
  P.tsAuth = t.auth_url || P.tsAuth;
  $('#rmTs').innerHTML = `<div class="card"><h2>Tailscale</h2>
    <p>${t.running ? dot('green') + ' Running' + (t.ip ? ' — IP <code>' + esc(t.ip) + '</code>' : '') : dot('grey') + (t.installed ? ' Not connected' : ' Not installed')}</p>
    ${!t.running && P.tsAuth ? `<div class="note">Open <a href="${esc(P.tsAuth)}" target="_blank" rel="noopener noreferrer">${esc(P.tsAuth)}</a> to authorise this device. ${P.tsPoll ? '<span class="spinner"></span>' : ''}</div>` : ''}
    <div class="row"><button class="btn" data-act="ts-up" ${t.installed ? '' : 'disabled'}>Connect</button><button class="btn secondary" data-act="ts-down" ${t.running ? '' : 'disabled'}>Disconnect</button></div>
    <p class="muted small">Install Tailscale on your PC/phone and point Zoiper at the Tailscale IP.</p></div>`;
}
function drawTurn(r) {
  const t = r.turn || {};
  const m = t.mode || 'none';
  $('#rmTurn').innerHTML = `<div class="card"><h2>Browser calling media / TURN</h2>
    <p class="small">A Cloudflare Tunnel carries only the web page and signaling. Call audio needs a direct path (LAN, Tailscale, port forwarding) or a TURN relay.</p>
    <form data-form="turn">
      <div class="row" style="margin-bottom:10px">${['none', 'custom', 'cloudflare'].map((k) => `<label class="check"><input type="radio" name="mode" value="${k}" data-change="turn-mode" ${m === k ? 'checked' : ''}> ${k === 'none' ? 'None' : k === 'custom' ? 'Custom TURN' : 'Cloudflare TURN'}</label>`).join('')}</div>
      <div data-turnbox="custom" class="form-grid ${m === 'custom' ? '' : 'hidden'}">
        <label>Host<input name="host" value="${esc(t.host)}"></label><label>Port<input name="port" value="${esc(t.port || '3478')}"></label>
        <label>Username<input name="user" value="${esc(t.user)}"></label>
        <label>Password${t.has_pass ? ' (stored; blank keeps it)' : ''}<input name="pass" type="password" autocomplete="new-password"></label></div>
      <div data-turnbox="cloudflare" class="form-grid ${m === 'cloudflare' ? '' : 'hidden'}">
        <label>Key ID<input name="cf_key_id" value="${esc(t.cf_key_id)}"></label>
        <label>API token${t.has_cf_token ? ' (stored; blank keeps it)' : ''}<input name="cf_token" type="password" autocomplete="new-password"></label>
        <p class="muted small" style="grid-column:1/-1">Cloudflare dashboard → Realtime → TURN → create key.</p></div>
      <div class="row"><button class="btn" type="submit">Save</button>
        <button type="button" class="btn secondary" data-act="turn-refresh">Refresh credentials</button></div></form>
    <p class="small muted">Last refresh: ${esc(t.last_refresh ? fmtTs(t.last_refresh) : 'never')}</p>
    ${t.last_error ? `<div class="note err">${esc(t.last_error)}</div>` : ''}</div>`;
}
function drawNet(r) {
  const n = r.network || {};
  $('#rmNet').innerHTML = `<div class="card"><h2>Direct port forwarding (advanced)</h2>
    <p class="small">Only needed if you forward UDP 5060 and 10000-20000 on your router to this device yourself. It tells Asterisk which address to advertise in SDP.</p>
    <form data-form="net"><div class="form-grid">
      <label>External address (IP or hostname)<input name="external_address" value="${esc(n.external_address)}" placeholder="${esc(n.public_ip || '')}"></label>
      <label>Local networks (comma separated)<input name="local_net" value="${esc(n.local_net)}" placeholder="192.168.1.0/24,100.64.0.0/10"></label>
      <label>STUN server<input name="stun" value="${esc(n.stun)}" placeholder="stun.l.google.com:19302"></label></div>
      <button class="btn" type="submit">Save</button></form></div>`;
}

// ---------------------------------------------------------------- Advanced
async function pAdvanced(root) {
  root.innerHTML = `<div class="card"><h2>Asterisk</h2><div class="row"><button class="btn" data-act="apply">Apply config now</button>
      <button class="btn danger" data-act="restart">Restart Asterisk</button></div><div id="applyOut"></div></div>
    <div class="card"><h2>Generated config</h2><button class="btn secondary" data-act="preview">Load preview</button><div id="prevBox"></div></div>
    <div class="card"><h2>Logs</h2><div class="row"><select id="logUnit" style="width:auto">${['asterisk', 'cloudflared', 'pi-sip-gateway', 'bluetooth'].map((u) => `<option>${u}</option>`).join('')}</select>
      <input id="logLines" type="number" min="10" max="2000" value="100" style="width:100px"><button class="btn" data-act="logs">Show logs</button></div><div id="logBox"></div></div>
    <div class="card"><h2>Change password</h2><form data-form="pw" class="inline"><label>New password<input name="password" type="password" minlength="6" required autocomplete="new-password"></label><button class="btn" type="submit">Change</button></form></div>
    <div class="card"><details><summary>Recent AMI events</summary><button class="btn secondary small" data-act="events">Load events</button><div id="evBox"></div></details></div>`;
}
function reloadList(res) {
  return (res.reload || []).map((x) => `<details><summary>${esc(x.cmd)}</summary><pre>${esc(x.output)}</pre></details>`).join('');
}

// ---------------------------------------------------------------- actions (click delegation)
const acts = {
  menu() { $('#sidebar').classList.toggle('open'); },
  'modal-close': closeModal,
  'confirm-yes'() { if (P.confirmResolve) P.confirmResolve(true); },
  'confirm-no'() { if (P.confirmResolve) P.confirmResolve(false); },
  async logout() { try { await api('POST', '/api/logout'); } catch { /* ignore */ } state.me.user = null; showAuth('login'); },
  copy(el) { return copyText(el.dataset.v); },
  'gen-pass'(el) { el.closest('form').elements.secret.value = randPassword(); },
  async hangup(el) {
    await api('POST', '/api/calls/hangup', { channel: el.dataset.ch });
    toast('Hangup sent');
    pollStatus();
  },
  // extensions
  'ext-add'() { openModal('Add extension', extForm(null)); },
  'ext-edit'(el) { openModal('Edit extension', extForm(P.exts.find((e) => e.ext === el.dataset.ext))); },
  'ext-cfg'(el) { extConfigModal(P.exts.find((e) => e.ext === el.dataset.ext)); },
  async 'ext-del'(el) {
    if (!(await confirmDlg(`Delete extension ${el.dataset.ext}?`))) return;
    closeModal();
    const r = await api('DELETE', '/api/extensions/' + encodeURIComponent(el.dataset.ext));
    toast('Extension deleted.' + applied(r));
    await loadExtensions();
  },
  // trunks
  'tr-refresh'() { return loadTrunks(); },
  'tr-add'() { openModal('Add trunk', trunkForm(null), { wide: true }); },
  'tr-edit'(el) { openModal('Edit trunk', trunkForm(P.trunks.find((t) => t.name === el.dataset.name)), { wide: true }); },
  async 'tr-del'(el) {
    if (!(await confirmDlg(`Delete trunk ${el.dataset.name}?`))) return;
    closeModal();
    const r = await api('DELETE', '/api/trunks/' + encodeURIComponent(el.dataset.name));
    toast('Trunk deleted.' + applied(r));
    await loadTrunks();
  },
  async 'usb-scan'() { P.disc = await api('GET', '/api/trunks/discover/usb'); drawTrunks(); },
  'usb-add'(el) {
    const d = P.disc.devices[Number(el.dataset.i)];
    openModal('Add trunk', trunkForm(null, { name: d.name || '', label: '', tech: d.tech === 'quectel' ? 'quectel' : 'dongle', enabled: 1,
      config: { imei: d.imei, imsi: d.imsi, audio: d.audio, data: d.data } }), { wide: true });
  },
  async 'bt-scan'() { P.bt = await api('GET', '/api/trunks/discover/bluetooth'); drawTrunks(); },
  async 'bt-pair'(el) {
    const p = P.bt.phones[Number(el.dataset.i)];
    P.pair[p.address] = { busy: true }; drawTrunks();
    toast('Accept the pairing prompt on the phone.');
    try {
      const r = await api('POST', '/api/bluetooth/pair', { address: p.address });
      P.pair[p.address] = { output: r.output || (r.ok ? 'Paired.' : 'Pairing failed.') };
      toast(r.ok ? 'Paired' : 'Pairing failed', r.ok ? 'ok' : 'error');
    } catch (e) { P.pair[p.address] = { output: e.message }; throw e; } finally { drawTrunks(); }
  },
  'bt-add'(el) {
    const p = P.bt.phones[Number(el.dataset.i)];
    const used = new Set(P.trunks.map((t) => t.name));
    let n = 1; while (used.has('phone' + n)) n++;
    openModal('Add trunk', trunkForm(null, { name: 'phone' + n, label: p.name || '', tech: 'mobile', enabled: 1, config: { address: p.address, port: p.port } }), { wide: true });
  },
  // routing
  'ob-add'() { openModal('Add outbound route', obForm(null)); },
  'ob-edit'(el) { openModal('Edit outbound route', obForm(P.ob.find((r) => String(r.id) === el.dataset.id))); },
  async 'ob-del'(el) {
    if (!(await confirmDlg('Delete this outbound route?'))) return;
    closeModal();
    const r = await api('DELETE', '/api/routes/outbound/' + encodeURIComponent(el.dataset.id));
    toast('Route deleted.' + applied(r)); await loadRouting();
  },
  'ib-add'() { openModal('Add inbound route', ibForm(null)); },
  'ib-edit'(el) { openModal('Edit inbound route', ibForm(P.ib.find((r) => String(r.id) === el.dataset.id))); },
  async 'ib-del'(el) {
    if (!(await confirmDlg('Delete this inbound route?'))) return;
    closeModal();
    const r = await api('DELETE', '/api/routes/inbound/' + encodeURIComponent(el.dataset.id));
    toast('Route deleted.' + applied(r)); await loadRouting();
  },
  'ord-up'(el) { const i = +el.dataset.i; [P.ord[i - 1], P.ord[i]] = [P.ord[i], P.ord[i - 1]]; $('#ordBox').innerHTML = ordHtml(); },
  'ord-down'(el) { const i = +el.dataset.i; [P.ord[i + 1], P.ord[i]] = [P.ord[i], P.ord[i + 1]]; $('#ordBox').innerHTML = ordHtml(); },
  'ord-rm'(el) { P.ord.splice(+el.dataset.i, 1); $('#ordBox').innerHTML = ordHtml(); },
  'ord-add'() { const v = $('#ordSel').value; if (v) P.ord.push(v); $('#ordBox').innerHTML = ordHtml(); },
  // softphone
  'sp-connect'() { spConnect(); },
  'sp-disconnect'(el) {
    if (SP.session) { try { SP.session.terminate(); } catch { /* ignore */ } }
    if (SP.ua) { try { SP.ua.stop(); } catch { /* ignore */ } SP.ua = null; }
    el.textContent = 'Connect'; el.dataset.act = 'sp-connect';
    spState('Not connected', 'grey'); spUi();
  },
  'sp-dtmf'(el) {
    const d = el.dataset.d;
    if (SP.session && !SP.incoming) { try { SP.session.sendDTMF(d); } catch (e) { toast(e.message, 'error'); } }
    const n = $('#spNum'); if (n) n.value += d;
  },
  'sp-call'() {
    if (!SP.ua) throw new Error('Connect first');
    const num = $('#spNum').value.trim();
    if (!num) throw new Error('Enter a number');
    if (!navigator.mediaDevices) throw new Error('Microphone unavailable: use HTTPS');
    SP.ua.call(`sip:${num.replace(/#/g, '%23')}@${SP.info.domain}`, spOpts());
    spState('Calling…', 'amber');
  },
  'sp-answer'() { if (SP.incoming) { const s = SP.incoming; stopRing(); s.answer(spOpts()); } },
  'sp-hang'() { if (SP.session) { stopRing(); try { SP.session.terminate(); } catch { /* ignore */ } } },
  'sp-mute'() { const s = SP.session; if (!s) return; if (s.isMuted().audio) s.unmute({ audio: true }); else s.mute({ audio: true }); spUi(); },
  // cdr / sms
  'cdr-refresh'() { return loadCdr(); },
  'sms-refresh'() { return loadSms(); },
  // remote
  async 'cf-uninstall'() {
    if (!(await confirmDlg('Uninstall the Cloudflare tunnel service?', 'Uninstall'))) return;
    const r = await api('DELETE', '/api/remote/cloudflare');
    toast('Tunnel uninstalled'); const o = $('#cfOut'); if (o) o.innerHTML = `<pre>${esc(r.output || '')}</pre>`; await loadRemote();
  },
  async 'ts-up'() {
    const r = await api('POST', '/api/remote/tailscale/up');
    P.tsAuth = r.auth_url || null; P.tsPoll = true;
    drawTs(P.r);
    clearInterval(P.tsTimer);
    P.tsTimer = setInterval(async () => {
      try {
        const x = await loadRemote('ts');
        if (x.tailscale && x.tailscale.running) { clearInterval(P.tsTimer); P.tsPoll = false; P.tsAuth = null; drawTs(x); toast('Tailscale connected'); }
      } catch { /* keep polling */ }
    }, 3000);
    cleanups.push(() => clearInterval(P.tsTimer));
  },
  async 'ts-down'() { await api('POST', '/api/remote/tailscale/down'); clearInterval(P.tsTimer); P.tsPoll = false; P.tsAuth = null; toast('Tailscale disconnected'); await loadRemote('ts'); },
  async 'turn-refresh'() { await api('POST', '/api/remote/turn/refresh'); toast('Credentials refreshed'); await loadRemote(); },
  // advanced
  async apply(el) {
    const r = await api('POST', '/api/apply');
    $('#applyOut').innerHTML = `<p class="small">Changed files: ${(r.changed || []).map((f) => `<code>${esc(f)}</code>`).join(', ') || 'none'}</p>${reloadList(r)}`;
    toast('Config applied');
  },
  async restart() {
    if (!(await confirmDlg('Restart Asterisk? Active calls will be dropped.', 'Restart'))) return;
    await api('POST', '/api/system/restart-asterisk');
    toast('Asterisk restarting');
  },
  async preview() {
    const r = await api('GET', '/api/config/preview');
    $('#prevBox').innerHTML = Object.entries(r).map(([k, v]) => `<details><summary>${esc(k)}</summary><pre>${esc(v)}</pre></details>`).join('') || empty('No files.');
  },
  async logs() {
    const r = await api('GET', `/api/logs?unit=${encodeURIComponent($('#logUnit').value)}&lines=${encodeURIComponent($('#logLines').value || 100)}`);
    $('#logBox').innerHTML = `<pre>${esc(r.text || '(empty)')}</pre>`;
  },
  async events() {
    const r = await api('GET', '/api/events?since=0');
    $('#evBox').innerHTML = `<pre>${esc(r.map((e) => JSON.stringify(e)).join('\n') || '(none)')}</pre>`;
  },
};

document.addEventListener('click', (e) => {
  const ov = e.target.closest('[data-overlay]');
  if (ov && e.target === ov) { if (P.confirmResolve) P.confirmResolve(false); else closeModal(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = acts[el.dataset.act];
  if (fn) run(el, () => fn(el, e));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modalRoot').innerHTML) { if (P.confirmResolve) P.confirmResolve(false); else closeModal(); } });

document.addEventListener('change', (e) => {
  const t = e.target;
  const kind = t.dataset && t.dataset.change;
  if (kind === 'tech') {
    const mobile = t.value === 'mobile';
    $('[data-techbox=usb]').classList.toggle('hidden', mobile);
    $('[data-techbox=bt]').classList.toggle('hidden', !mobile);
  } else if (kind === 'turn-mode') {
    $$('[data-turnbox]').forEach((b) => b.classList.toggle('hidden', b.dataset.turnbox !== t.value));
  } else if (kind === 'bt-adapter' && t.value) {
    run(t, async () => { await api('POST', '/api/bluetooth/adapter', { address: t.value }); toast('Bluetooth adapter selected'); });
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'cdrQ') { P.q = e.target.value; drawCdr(); }
});

// ---------------------------------------------------------------- form submit handlers
const forms = {
  async login(f) {
    await api('POST', '/api/login', { username: val(f, 'username'), password: f.elements.password.value });
    state.me = await api('GET', '/api/me');
    enterApp();
  },
  async setup(f) {
    await api('POST', '/api/setup', { username: val(f, 'username'), password: f.elements.password.value });
    state.me = await api('GET', '/api/me');
    enterApp();
  },
  async originate(f) {
    await api('POST', '/api/calls/originate', { ext: val(f, 'ext'), number: val(f, 'number') });
    toast('Calling… answer extension ' + val(f, 'ext') + ' first.');
  },
  async ext(f) {
    const editing = f.dataset.edit;
    const body = { name: val(f, 'name'), webrtc: chk(f, 'webrtc') };
    const secret = f.elements.secret.value.trim();
    if (secret) body.secret = secret;
    let r;
    if (editing) r = await api('PUT', '/api/extensions/' + encodeURIComponent(editing), body);
    else r = await api('POST', '/api/extensions', { ext: val(f, 'ext'), ...body });
    closeModal();
    toast('Extension saved.' + applied(r));
    await loadExtensions();
  },
  async trunk(f) {
    const editing = f.dataset.edit;
    const tech = f.elements.tech.value;
    let config = {};
    if (editing) config = { ...(P.trunks.find((t) => t.name === editing) || {}).config };
    const setOpt = (k, v) => { if (v === '' || v === null) delete config[k]; else config[k] = v; };
    if (tech === 'mobile') {
      setOpt('address', val(f, 'address'));
      setOpt('port', numOrNull(val(f, 'port')));
      if (!config.address) throw new Error('Bluetooth address is required');
    } else {
      ['imei', 'imsi', 'audio', 'data'].forEach((k) => setOpt(k, val(f, k)));
      ['rxgain', 'txgain'].forEach((k) => setOpt(k, numOrNull(val(f, k))));
      if (!config.imei && !(config.audio && config.data)) throw new Error('Provide the IMEI, or both audio and data ports');
    }
    const enabled = chk(f, 'enabled') ? 1 : 0;
    let r;
    if (editing) r = await api('PUT', '/api/trunks/' + encodeURIComponent(editing), { label: val(f, 'label'), config, enabled });
    else r = await api('POST', '/api/trunks', { name: val(f, 'name'), tech, label: val(f, 'label'), config, enabled });
    closeModal();
    toast('Trunk saved.' + applied(r));
    await loadTrunks();
  },
  async ob(f) {
    const body = { label: val(f, 'label'), pattern: val(f, 'pattern'), strip: parseInt(val(f, 'strip'), 10) || 0, prepend: val(f, 'prepend'),
      trunks: [...P.ord], enabled: chk(f, 'enabled') ? 1 : 0 };
    if (!body.trunks.length) throw new Error('Select at least one trunk');
    const r = f.dataset.id ? await api('PUT', '/api/routes/outbound/' + encodeURIComponent(f.dataset.id), body) : await api('POST', '/api/routes/outbound', body);
    closeModal(); toast('Route saved.' + applied(r)); await loadRouting();
  },
  async ib(f) {
    const body = { trunk: val(f, 'trunk'), destinations: $$('input[name=dest]:checked', f).map((x) => x.value),
      ring_time: parseInt(val(f, 'ring_time'), 10) || 30, enabled: chk(f, 'enabled') ? 1 : 0 };
    const r = f.dataset.id ? await api('PUT', '/api/routes/inbound/' + encodeURIComponent(f.dataset.id), body) : await api('POST', '/api/routes/inbound', body);
    closeModal(); toast('Route saved.' + applied(r)); await loadRouting();
  },
  async sms(f) {
    const r = await api('POST', '/api/sms/send', { trunk: val(f, 'trunk'), number: val(f, 'number'), body: f.elements.body.value });
    $('#smsOut').innerHTML = `<div class="note ${r.ok ? '' : 'err'}">${r.ok ? 'Sent.' : 'Failed.'} ${esc(r.output || '')}</div>`;
    if (r.ok) f.elements.body.value = '';
    await loadSms();
  },
  async 'cf-install'(f) {
    const r = await api('POST', '/api/remote/cloudflare', { token: f.elements.token.value.trim() });
    $('#cfOut').innerHTML = `<div class="note ${r.ok ? '' : 'err'}">${r.ok ? 'Installed.' : 'Failed.'}</div><pre>${esc(r.output || '')}</pre>`;
    toast(r.ok ? 'Tunnel installed' : 'Install failed', r.ok ? 'ok' : 'error');
  },
  async 'cf-host'(f) {
    const n = (P.r && P.r.network) || {};
    await api('POST', '/api/remote/network', { external_address: n.external_address || '', local_net: n.local_net || '', stun: n.stun || '', public_hostname: val(f, 'public_hostname') });
    toast('Saved'); await loadRemote();
  },
  async turn(f) {
    await api('POST', '/api/remote/turn', { mode: f.elements.mode.value, host: val(f, 'host'), port: val(f, 'port'), user: val(f, 'user'),
      pass: f.elements.pass.value, cf_key_id: val(f, 'cf_key_id'), cf_token: f.elements.cf_token.value });
    toast('TURN settings saved'); await loadRemote();
  },
  async net(f) {
    await api('POST', '/api/remote/network', { external_address: val(f, 'external_address'), local_net: val(f, 'local_net'), stun: val(f, 'stun'),
      public_hostname: (P.r && P.r.public_hostname) || '' });
    toast('Saved'); await loadRemote();
  },
  async pw(f) {
    await api('POST', '/api/password', { password: f.elements.password.value });
    f.reset(); toast('Password changed');
  },
};
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const h = forms[f.dataset.form];
  if (!h) return;
  run(e.submitter || f.querySelector('button[type=submit]'), () => h(f, e));
});

boot();
