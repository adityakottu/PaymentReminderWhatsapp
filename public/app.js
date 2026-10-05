'use strict';

/* Bulk WhatsApp Reminders – single page UI (no build step).
 * All dynamic content is inserted with textContent (never innerHTML) to avoid XSS. */

// Inside the iOS/Android app (Capacitor) the UI is bundled with the app, so it talks to a
// configurable server with a bearer token. In a browser it uses same-origin + HttpOnly cookie.
const NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch (_) {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (_) {}
  },
};
const serverUrl = () => (NATIVE ? store.get('serverUrl') || '' : '');
const apiUrl = (path) => `${serverUrl()}/api${path}`;
function authHeaders() {
  const token = NATIVE ? store.get('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
const state = { user: null, config: null };
let teardown = [];

// ------------------------------------------------------------------ helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    // CSSOM assignment is allowed by the strict CSP (style attributes are not).
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, path, body, { raw } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch', ...authHeaders() }, credentials: NATIVE ? 'omit' : 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (NATIVE && !serverUrl()) {
    location.hash = '#/login';
    throw new Error('Set the server address first');
  }
  let res;
  try {
    res = await fetch(apiUrl(path), opts);
  } catch (_) {
    throw new Error(NATIVE ? `Cannot reach the server at ${serverUrl()}. Check the address and your internet connection.` : 'Network error');
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    state.user = null;
    if (NATIVE) store.set('token', null);
    location.hash = '#/login';
    throw new Error('Please sign in');
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * A download link. In the browser it is a normal link (cookie auth). In the app the
 * file is fetched with the bearer token, saved to the cache and opened in the share
 * sheet (save to Files, WhatsApp, email, …).
 */
function downloadLink(path, label, fallbackName, cls = 'btn secondary') {
  if (!NATIVE) return h('a', { class: cls, href: apiUrl(path) }, label);
  return h('button', {
    class: cls,
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await fetch(apiUrl(path), { headers: authHeaders() });
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
        const name = (m ? m[1] : fallbackName).replace(/[^\w.\-]/g, '_');
        const { Filesystem, Share } = window.Capacitor.Plugins;
        const { uri } = await Filesystem.writeFile({ path: name, data: await blobToBase64(await res.blob()), directory: 'CACHE' });
        await Share.share({ title: name, files: [uri] });
      } catch (err) {
        if (!/cancel/i.test(String(err && err.message))) toast(err.message || 'Download failed', true);
      } finally {
        btn.disabled = false;
      }
    },
  }, label);
}

/**
 * Live batch updates. Browser: EventSource (cookie). App: EventSource cannot send an
 * Authorization header, so read the same event stream with fetch and reconnect when
 * the connection drops (e.g. the phone was locked).
 */
function openStream(path, onSummary) {
  if (!NATIVE) {
    const es = new EventSource(apiUrl(path));
    es.addEventListener('summary', (e) => onSummary(JSON.parse(e.data)));
    return () => es.close();
  }
  let stopped = false;
  let ctrl = null;
  (async () => {
    while (!stopped) {
      try {
        ctrl = new AbortController();
        const res = await fetch(apiUrl(path), { headers: authHeaders(), signal: ctrl.signal });
        if (res.status === 401) {
          store.set('token', null);
          state.user = null;
          location.hash = '#/login';
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(chunk);
            const data = /^data: (.*)$/m.exec(chunk);
            if (ev && ev[1] === 'summary' && data) onSummary(JSON.parse(data[1]));
          }
        }
      } catch (_) {
        if (stopped) return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  return () => {
    stopped = true;
    if (ctrl) ctrl.abort();
  };
}

function can(p) {
  return !!state.user && state.user.permissions.includes(p);
}

function toast(msg, bad) {
  const t = h('div', { class: `t${bad ? ' bad' : ''}` }, msg);
  document.getElementById('toast').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 4000);
}

const inr = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);
function time(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function dateOnly(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}
function ymdToDmy(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s || '—';
}

const LANG_LABEL = { en: 'English', te: 'తెలుగు Telugu', both: 'English + తెలుగు' };

const STATUS = {
  PENDING: ['Pending', ''],
  QUEUED: ['Queued', 'info'],
  PROCESSING: ['Processing', 'info'],
  SENT: ['Sent', 'ok'],
  DELIVERED: ['Delivered', 'ok'],
  READ: ['Read', 'ok'],
  FAILED: ['Failed', 'bad'],
  INVALID_NUMBER: ['Invalid Number', 'bad'],
  NOT_ON_WHATSAPP: ['Not on WhatsApp', 'bad'],
  RATE_LIMITED: ['Rate Limited', 'bad'],
  PROVIDER_ERROR: ['Provider Error', 'bad'],
  RETRY_SCHEDULED: ['Retry Scheduled', 'warn'],
  CANCELLED: ['Cancelled', ''],
  // batch statuses
  UPLOADED: ['Uploaded', ''],
  VALIDATING: ['Validating', 'info'],
  VALIDATED: ['Validated', 'info'],
  READY: ['Ready', 'info'],
  PAUSED: ['Paused', 'warn'],
  COMPLETED: ['Completed', 'ok'],
  COMPLETED_WITH_FAILURES: ['Completed with Failures', 'warn'],
  // validation
  VALID: ['Valid', 'ok'],
  INVALID: ['Invalid', 'bad'],
  DUPLICATE: ['Duplicate', 'warn'],
};
const PROVIDER_OUTCOMES = ['SENT', 'DELIVERED', 'READ', 'FAILED', 'INVALID_NUMBER', 'NOT_ON_WHATSAPP', 'RATE_LIMITED', 'PROVIDER_ERROR', 'RETRY_SCHEDULED'];
function badge(status, simulated) {
  const [label, cls] = STATUS[status] || [status, ''];
  // In test mode no outcome is real – neither "Sent/Delivered/Read" nor the mock's failures.
  if (simulated && PROVIDER_OUTCOMES.includes(status)) return h('span', { class: 'badge warn', title: 'Test mode – nothing was sent to WhatsApp' }, `${label} (simulated)`);
  return h('span', { class: `badge ${cls}` }, label);
}

const waMode = () => (state.config && state.config.whatsapp ? state.config.whatsapp.mode : null);

/** Banner shown on every page while WhatsApp is not really connected. */
function renderWhatsappBanner() {
  const el = document.getElementById('wa-banner');
  const wa = state.user && state.config && state.config.whatsapp;
  if (!wa || wa.mode === 'live') {
    el.hidden = true;
    return;
  }
  const settingsLink = can('whatsapp_settings.manage') ? h('a', { href: '#/whatsapp' }, 'Set up WhatsApp →') : h('span', {}, 'Ask your administrator to connect WhatsApp.');
  el.className = `wa-banner ${wa.mode === 'test' ? 'test' : 'off'}`;
  el.replaceChildren(
    h('strong', {}, wa.mode === 'test' ? 'TEST MODE' : 'WhatsApp not connected'),
    ' ',
    h('span', {}, wa.mode === 'test' ? 'Messages are simulated – nobody receives them, and "Sent/Delivered/Read" are not real.' : 'Reminders cannot be sent until WhatsApp is connected on the server.'),
    ' ',
    settingsLink
  );
  el.hidden = false;
}

function card(k, v, cls) {
  return h('div', { class: `card ${cls || ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
}

function pager(total, page, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return h(
    'div',
    { class: 'pager' },
    h('span', { class: 'muted' }, `${num(total)} rows · page ${page} of ${pages}`),
    h('button', { class: 'btn secondary small', disabled: page <= 1, onclick: () => onPage(page - 1) }, '‹ Prev'),
    h('button', { class: 'btn secondary small', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Next ›')
  );
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function confirmDialog({ title, body, confirmLabel, danger, requireCheck }) {
  return new Promise((resolve) => {
    const check = requireCheck ? h('input', { type: 'checkbox', id: 'dlg-check' }) : null;
    const ok = h('button', { class: `btn ${danger ? 'danger' : ''}`, disabled: !!requireCheck }, confirmLabel || 'Confirm');
    const cancel = h('button', { class: 'btn secondary' }, 'Cancel');
    const dlg = h(
      'dialog',
      {},
      h('h3', {}, title),
      h('p', {}, body),
      check ? h('p', {}, h('label', {}, check, ' ', requireCheck)) : null,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), cancel, ok)
    );
    if (check) check.addEventListener('change', () => (ok.disabled = !check.checked));
    const close = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    ok.addEventListener('click', () => close(true));
    cancel.addEventListener('click', () => close(false));
    dlg.addEventListener('cancel', () => close(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}

function setCrumbs(...parts) {
  const el = document.getElementById('crumbs');
  el.replaceChildren(...parts.flatMap((p, i) => [i ? ' › ' : '', p]));
}

function mount(...nodes) {
  const main = document.getElementById('main');
  main.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

function stepper(current) {
  const steps = [
    ['Upload', 'Upload Excel'],
    ['Validate', 'Check rows'],
    ['Review', 'Message & recipients'],
    ['Send', 'Send & track'],
  ];
  return h(
    'ol',
    { class: 'steps' },
    steps.map(([t, s], i) => h('li', { class: i < current ? 'done' : i === current ? 'current' : '' }, `${i + 1}. ${t}`, h('span', {}, s)))
  );
}

// ------------------------------------------------------------------- router

async function route() {
  teardown.forEach((fn) => fn());
  teardown = [];
  const hash = location.hash || '#/bulk';
  if (!state.user && hash !== '#/login') {
    try {
      state.user = (await api('GET', '/auth/me')).user;
    } catch (_) {
      location.hash = '#/login';
      return;
    }
  }
  renderChrome();
  const parts = hash.slice(2).split('/');
  try {
    if (parts[0] === 'login') return renderLogin();
    if (!can('bulk_whatsapp_reminders')) return mount(h('div', { class: 'panel' }, h('h1', {}, 'No access'), h('p', {}, 'Your account does not have the Bulk WhatsApp Reminders permission.')));
    if (!state.config) state.config = await api('GET', '/bulk-reminders/config');
    renderWhatsappBanner();
    if (parts[0] === 'bulk' && parts[1]) return await renderBatch(Number(parts[1]));
    if (parts[0] === 'bulk') return renderUpload();
    if (parts[0] === 'history') return await renderHistory();
    if (parts[0] === 'template') return await renderTemplateSettings();
    if (parts[0] === 'audit') return await renderAudit();
    if (parts[0] === 'whatsapp') return await renderWhatsappSettings();
    location.hash = '#/bulk';
  } catch (err) {
    mount(h('div', { class: 'notice bad' }, err.message));
  }
}

function renderChrome() {
  const logged = !!state.user;
  document.body.classList.remove('nav-open');
  renderWhatsappBanner();
  document.getElementById('menu-btn').hidden = !logged;
  document.getElementById('sidenav').hidden = !logged;
  document.getElementById('user-box').hidden = !logged;
  if (!logged) return;
  document.getElementById('user-name').textContent = `${state.user.displayName} (${state.user.role.replace('_', ' ')})`;
  const current = (location.hash.slice(2).split('/')[0] || 'bulk');
  document.querySelectorAll('.sidenav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === current);
    if (a.dataset.perm) a.hidden = !can(a.dataset.perm);
  });
  document.querySelectorAll('[data-admin-only]').forEach((el) => (el.hidden = !can('whatsapp_settings.manage') && !can('audit_logs.view')));
}

// -------------------------------------------------------------------- login

function renderLogin() {
  setCrumbs('Sign in');
  const u = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true });
  const p = h('input', { type: 'password', id: 'p', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'errors' });
  const srv = NATIVE ? h('input', { type: 'url', id: 's', placeholder: 'https://reminders.example.com', autocomplete: 'url', inputmode: 'url', autocapitalize: 'off', required: true }) : null;
  if (srv) srv.value = store.get('serverUrl') || '';
  const form = h(
    'form',
    {
      class: 'panel login',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          if (srv) {
            const url = srv.value.trim().replace(/\/+$/, '');
            if (!/^https:\/\/[^\s/]+/i.test(url)) throw new Error('Enter the server address starting with https://');
            store.set('serverUrl', url);
          }
          const data = await api('POST', '/auth/login', { username: u.value, password: p.value, ...(NATIVE ? { client: 'mobile' } : {}) });
          if (NATIVE) store.set('token', data.token);
          state.user = data.user;
          state.config = null;
          location.hash = '#/bulk';
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h('h1', {}, 'Sign in'),
    srv ? [h('label', { for: 's' }, 'Server address'), srv, h('div', { class: 'muted small' }, 'Ask your administrator for this address.')] : null,
    h('label', { for: 'u' }, 'Username'),
    u,
    h('label', { for: 'p' }, 'Password'),
    p,
    err,
    h('p', {}, h('button', { class: 'btn', type: 'submit' }, 'Sign in'))
  );
  mount(form);
  (srv && !srv.value ? srv : u).focus();
}

// --------------------------------------------------------- STEP 1: upload

function renderUpload() {
  setCrumbs('Payments', 'Bulk WhatsApp Reminders');
  const cfg = state.config;
  const canUpload = can('bulk_whatsapp_reminders.upload');
  const fileInput = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
  const bar = h('div', { style: 'width:0%' });
  const progress = h('div', { class: 'progress', hidden: true }, bar);
  const status = h('p', { class: 'muted' });
  const errors = h('div');

  const zone = h(
    'div',
    { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Upload Excel file' },
    h('strong', {}, NATIVE ? 'Tap to choose an Excel file' : 'Drag & drop your Excel file here'),
    h('div', { class: 'muted' }, `${NATIVE ? 'From Files, Drive or email attachments' : 'or click to choose a file'} · .xlsx only · max ${cfg.maxUploadMb} MB · up to ${num(cfg.maxRows)} rows`)
  );

  function upload(file) {
    errors.replaceChildren();
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      errors.replaceChildren(h('div', { class: 'notice bad' }, /\.xls$/i.test(file.name) ? 'Legacy .xls files are not supported – save the file as .xlsx.' : 'Please choose an Excel .xlsx file.'));
      return;
    }
    if (file.size > cfg.maxUploadMb * 1024 * 1024) {
      errors.replaceChildren(h('div', { class: 'notice bad' }, `File is larger than ${cfg.maxUploadMb} MB.`));
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/bulk-reminders/uploads'));
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    progress.hidden = false;
    status.textContent = `Uploading ${file.name}…`;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
      if (e.loaded === e.total) status.textContent = 'Validating rows…';
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (_) {}
      if (xhr.status === 201) {
        sessionStorage.setItem(`validation:${data.batch.id}`, JSON.stringify(data.validation));
        location.hash = `#/bulk/${data.batch.id}`;
      } else {
        progress.hidden = true;
        status.textContent = '';
        const details = data.details && data.details.missingColumns ? ` Expected columns: ${data.details.missingColumns.join(', ')}.` : '';
        errors.replaceChildren(h('div', { class: 'notice bad' }, (data.error || `Upload failed (${xhr.status})`) + details));
      }
    };
    xhr.onerror = () => {
      progress.hidden = true;
      errors.replaceChildren(h('div', { class: 'notice bad' }, 'Network error during upload.'));
    };
    xhr.send(fd);
  }

  if (canUpload) {
    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click());
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag');
      upload(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => upload(fileInput.files[0]));
  }

  mount(
    h('h1', {}, 'Bulk WhatsApp Reminders'),
    h('p', { class: 'sub' }, 'Upload an Excel file of pending payments. Nothing is sent until you review and confirm.'),
    stepper(0),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Upload Excel'), h('span', { class: 'spacer' }), downloadLink('/bulk-reminders/template.xlsx', '⬇ Download Excel Template', 'bulk-whatsapp-reminder-template.xlsx')),
      h('p', { class: 'muted' }, 'Required columns: Customer Name, Phone Number, Amount Due. Optional: Due Date, Loan/Account ID, Installment Number, Employee/Collector, Custom Message. Phone numbers do not need a "+" – Indian 10-digit numbers get the 91 prefix automatically.'),
      canUpload ? [zone, fileInput] : h('div', { class: 'notice info' }, 'You can view reminder status, but uploading requires the upload permission.'),
      h('div', { style: 'margin-top:12px' }, progress),
      status,
      errors
    )
  );
}

// ------------------------------------------------------------- batch view

async function renderBatch(id) {
  const { batch } = await api('GET', `/bulk-reminders/batches/${id}`);
  setCrumbs('Payments', h('a', { href: '#/history', style: 'color:inherit' }, 'Bulk WhatsApp Reminders'), batch.batchNumber);
  if (batch.status === 'VALIDATED') return renderValidation(batch);
  if (batch.status === 'READY') return renderReview(batch);
  if (batch.status === 'CANCELLED' && !batch.startedAt) {
    return mount(
      h('h1', {}, batch.batchNumber),
      h('div', { class: 'notice warn' }, `This upload (${batch.filename}) was cancelled before any message was sent.`),
      h('a', { class: 'btn', href: '#/bulk' }, 'Upload another file')
    );
  }
  return renderDashboard(batch);
}

// ------------------------------------------------------- STEP 2: validate

async function renderValidation(batch) {
  const extra = JSON.parse(sessionStorage.getItem(`validation:${batch.id}`) || 'null');
  const tableBox = h('div');
  let filter = '';
  let page = 1;

  async function loadIssues() {
    const data = await api('GET', `/bulk-reminders/batches/${batch.id}/issues?page=${page}&pageSize=50${filter ? `&status=${filter}` : ''}`);
    const rows = data.rows.map((r) =>
      h(
        'tr',
        {},
        h('td', { class: 'num' }, r.rowNumber),
        h('td', {}, r.customerName || '—'),
        h('td', { class: 'mono' }, r.phoneRaw || '—', r.phoneNumber && r.phoneNumber !== r.phoneRaw ? h('div', { class: 'muted' }, `→ ${r.phoneNumber}`) : null),
        h('td', { class: 'num' }, r.amountDue !== null ? inr(r.amountDue) : r.amountRaw || '—'),
        h('td', {}, badge(r.status), r.warnings.length && r.status === 'VALID' ? [' ', h('span', { class: 'badge warn' }, 'Warning')] : null),
        h('td', {}, [...r.reasons, ...r.warnings].join('; '))
      )
    );
    tableBox.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', { class: 'num' }, 'Row'), h('th', {}, 'Customer'), h('th', {}, 'Phone'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Status'), h('th', {}, 'Reason'))),
          h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No issues found – every row is valid.')))
        )
      ),
      pager(data.total, page, 50, (p) => {
        page = p;
        loadIssues();
      })
    );
  }

  const chips = h('div', { class: 'chips' });
  const chipDefs = [
    ['', 'All issues'],
    ['INVALID', 'Invalid'],
    ['DUPLICATE', 'Duplicates'],
    ['WARNING', 'Warnings'],
  ];
  function drawChips() {
    chips.replaceChildren(
      ...chipDefs.map(([v, l]) =>
        h('button', {
          class: `chip ${filter === v ? 'active' : ''}`,
          onclick: () => {
            filter = v;
            page = 1;
            drawChips();
            loadIssues();
          },
        }, l)
      )
    );
  }
  drawChips();

  const canUpload = can('bulk_whatsapp_reminders.upload');
  mount(
    h('h1', {}, 'Preview & Validation'),
    h('p', { class: 'sub' }, `${batch.batchNumber} · ${batch.filename}`),
    stepper(1),
    h('h2', {}, 'Import Summary'),
    h('div', { class: 'cards' }, card('Total rows', num(batch.totalRows)), card('Valid', num(batch.validRecords), 'ok'), card('Invalid', num(batch.invalidRecords), batch.invalidRecords ? 'bad' : ''), card('Duplicates', num(batch.duplicateRecords), batch.duplicateRecords ? 'warn' : '')),
    extra && extra.sameFileUploadedAs ? h('div', { class: 'notice warn' }, `This exact file was already uploaded as ${extra.sameFileUploadedAs}. Make sure you are not sending the same reminders twice.`) : null,
    extra && extra.recentlyReminded ? h('div', { class: 'notice warn' }, `${extra.recentlyReminded} customer(s) already received this reminder in the last ${state.config.duplicateWindowHours}h. They will be skipped unless an authorised user overrides duplicate protection.`) : null,
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('h2', { style: 'margin:0' }, 'Rows needing attention'), h('span', { class: 'spacer' }), chips),
    tableBox,
    canUpload
      ? h(
          'div',
          { class: 'row', style: 'margin-top:16px' },
          h('button', {
            class: 'btn',
            disabled: !batch.validRecords,
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api('POST', `/bulk-reminders/batches/${batch.id}/import`);
                toast(`Imported ${batch.validRecords} valid records`);
                route();
              } catch (err) {
                toast(err.message, true);
                e.target.disabled = false;
              }
            },
          }, `Import ${num(batch.validRecords)} Valid Records`),
          h('button', {
            class: 'btn secondary',
            onclick: async () => {
              if (!(await confirmDialog({ title: 'Cancel upload?', body: 'No messages will be sent for this file.', confirmLabel: 'Cancel Upload', danger: true }))) return;
              await api('POST', `/bulk-reminders/batches/${batch.id}/cancel-upload`);
              location.hash = '#/bulk';
            },
          }, 'Cancel Upload')
        )
      : null
  );
  await loadIssues();
}

// --------------------------------------------------------- STEP 3: review

async function renderReview(batch) {
  const readiness = await api('GET', `/bulk-reminders/batches/${batch.id}/send-readiness`);
  const canEdit = can('bulk_whatsapp_reminders.edit_batch_template');
  const editor = h('textarea', { spellcheck: 'false', readonly: !canEdit, 'aria-label': 'English message template' });
  editor.value = batch.messageTemplate || '';
  const editorTe = h('textarea', { spellcheck: 'false', readonly: !canEdit, lang: 'te', 'aria-label': 'Telugu message template' });
  editorTe.value = batch.messageTemplateTe || '';
  let language = batch.language || 'en';
  const langChips = h('div', { class: 'chips' });
  const enBlock = h('div', {}, h('h3', { class: 'lang-h' }, 'English message'), editor);
  const teBlock = h('div', {}, h('h3', { class: 'lang-h' }, 'Telugu message (తెలుగు)'), editorTe);
  function drawLanguage() {
    langChips.replaceChildren(
      ...Object.keys(LANG_LABEL).map((l) =>
        h('button', {
          class: `chip ${language === l ? 'active' : ''}`,
          disabled: !canEdit,
          'aria-pressed': String(language === l),
          onclick: () => {
            language = l;
            drawLanguage();
            if (saveBtn) saveBtn.disabled = false;
            refreshPreview();
          },
        }, LANG_LABEL[l])
      )
    );
    // Show the editors the chosen language needs (customers with their own Language column value may still use the other one).
    enBlock.classList.toggle('dim', language === 'te');
    teBlock.classList.toggle('dim', language === 'en');
  }
  const previewBox = h('div');
  const errBox = h('ul', { class: 'errors' });
  const saveBtn = canEdit
    ? h('button', {
        class: 'btn secondary small',
        onclick: async () => {
          try {
            await api('PUT', `/bulk-reminders/batches/${batch.id}/template`, { template: editor.value, templateTe: editorTe.value, language });
            toast('Message saved for this batch');
            saveBtn.disabled = true;
          } catch (e) {
            toast(e.message, true);
          }
        },
        disabled: true,
      }, 'Save message')
    : null;

  const refreshPreview = debounce(async () => {
    const data = await api('POST', `/bulk-reminders/batches/${batch.id}/preview`, { template: editor.value, templateTe: editorTe.value, language });
    errBox.replaceChildren(...data.validation.errors.map((e) => h('li', {}, e)));
    previewBox.replaceChildren(
      ...data.previews.map((p) => h('div', { class: 'bubble', lang: p.language === 'en' ? 'en' : 'te' }, h('div', { class: 'to' }, `To ${p.customerName} · ${p.phoneNumber} · ${LANG_LABEL[p.language]}`), p.message))
    );
  }, 300);
  for (const ed of [editor, editorTe]) {
    ed.addEventListener('input', () => {
      if (saveBtn) saveBtn.disabled = false;
      refreshPreview();
    });
  }
  drawLanguage();

  const recBox = h('div');
  let page = 1;
  async function loadRecipients() {
    const data = await api('GET', `/bulk-reminders/batches/${batch.id}/records?page=${page}&pageSize=25`);
    recBox.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', { class: 'num' }, 'Row'), h('th', {}, 'Customer'), h('th', {}, 'Phone'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Due Date'), h('th', {}, 'Account'), h('th', {}, 'Collector'), h('th', {}, 'Language'))),
          h('tbody', {}, data.records.map((r) => h('tr', {}, h('td', { class: 'num' }, r.rowNumber), h('td', {}, r.customerName), h('td', { class: 'mono' }, r.phoneNumber), h('td', { class: 'num' }, inr(r.amountDue)), h('td', {}, ymdToDmy(r.dueDate)), h('td', {}, r.accountId || '—'), h('td', {}, r.collectorName || '—'), h('td', {}, r.language ? LANG_LABEL[r.language] : h('span', { class: 'muted' }, 'Batch language')))))
        )
      ),
      pager(data.total, page, 25, (p) => {
        page = p;
        loadRecipients();
      })
    );
  }

  const override = readiness.recentlyReminded && readiness.canOverrideDuplicates ? h('input', { type: 'checkbox', id: 'override' }) : null;
  const canSend = can('bulk_whatsapp_reminders.send');
  const wa = readiness.whatsapp || { mode: 'live', canSend: true };
  const testMode = wa.mode === 'test';
  const sendBtn = h('button', {
    class: 'btn',
    disabled: !canSend || !readiness.recipients || !wa.canSend,
    onclick: async () => {
      if (saveBtn && !saveBtn.disabled) return toast('Save the edited message first.', true);
      const ok = await confirmDialog({
        title: testMode ? 'TEST MODE – simulate sending?' : 'Send WhatsApp reminders?',
        body: `${testMode ? 'WhatsApp is NOT connected: this is a simulation and NO real messages will be sent. ' : ''}You are about to send ${num(readiness.recipients)} WhatsApp payment reminders (batch ${readiness.batchNumber}) in ${LANG_LABEL[language]}. Customers with their own Language value in the Excel get that language. This cannot be undone.`,
        confirmLabel: testMode ? `Simulate ${num(readiness.recipients)} Reminders` : `Send ${num(readiness.recipients)} Reminders`,
        requireCheck: 'I confirm these customers should receive this reminder.',
      });
      if (!ok) return;
      try {
        await api('POST', `/bulk-reminders/batches/${batch.id}/send`, { confirm: true, overrideDuplicates: !!(override && override.checked), expectedRecipients: readiness.recipients });
        toast('Sending started – you can close this page; processing continues on the server.');
        route();
      } catch (e) {
        toast(e.message, true);
      }
    },
  }, testMode ? `Simulate ${num(readiness.recipients)} Reminders (test mode)` : `Send ${num(readiness.recipients)} WhatsApp Reminders`);

  mount(
    h('h1', {}, 'Review & Send'),
    h('p', { class: 'sub' }, `${batch.batchNumber} · ${batch.filename}`),
    stepper(2),
    h(
      'div',
      { class: 'two-col' },
      h('div', { class: 'panel' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Message Template'), h('span', { class: 'spacer' }), saveBtn),
        h('div', { class: 'row', style: 'margin:10px 0' }, h('strong', {}, 'Message language'), langChips),
        h('p', { class: 'muted' }, `Placeholders: ${state.config.templateVariables.map((v) => `{{${v}}}`).join(' ')} · conditional blocks: {{#if due_date}}…{{/if}}. "English + తెలుగు" sends one message with the English text followed by the Telugu text. A Language column in the Excel overrides this per customer.`),
        enBlock, teBlock, errBox,
        state.config.sendMode === 'template' ? h('div', { class: 'notice info', style: 'margin-top:10px' }, 'WhatsApp requires business-initiated messages to use a pre-approved template. The text above is stored with each record and used for the preview/report; the provider sends the approved template with these same values.') : null),
      h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, 'Message Preview'), previewBox)
    ),
    h('h2', {}, `Recipients (${num(readiness.recipients)})`),
    recBox,
    h(
      'div',
      { class: 'panel', style: 'margin-top:16px' },
      h('h2', { style: 'margin-top:0' }, 'Ready to Send'),
      h('div', { class: 'cards' }, card('Batch', readiness.batchNumber), card('Recipients', num(readiness.recipients)), card('Estimated messages', num(readiness.estimatedMessages))),
      readiness.recentlyReminded
        ? h(
            'div',
            { class: 'notice warn' },
            `${readiness.recentlyReminded} recipient(s) already received this reminder in the last ${readiness.duplicateWindowHours}h and will be skipped. `,
            override ? h('label', {}, override, ' Override and send to them anyway') : null
          )
        : null,
      !wa.canSend ? h('div', { class: 'notice bad' }, wa.message, can('whatsapp_settings.manage') ? [' ', h('a', { href: '#/whatsapp' }, 'Open WhatsApp Connection')] : null) : null,
      testMode ? h('div', { class: 'notice warn' }, wa.message) : null,
      canSend ? sendBtn : h('div', { class: 'notice info' }, 'You do not have permission to send reminders.'),
      ' ',
      can('bulk_whatsapp_reminders.upload')
        ? h('button', {
            class: 'btn secondary',
            onclick: async () => {
              if (!(await confirmDialog({ title: 'Cancel this batch?', body: 'No messages will be sent.', confirmLabel: 'Cancel batch', danger: true }))) return;
              await api('POST', `/bulk-reminders/batches/${batch.id}/cancel-upload`);
              location.hash = '#/history';
            },
          }, 'Cancel')
        : null
    )
  );
  refreshPreview();
  loadRecipients();
}

// ------------------------------------------------ STEP 4: live dashboard

async function renderDashboard(initial) {
  let batch = initial;
  const header = h('div');
  const summary = h('div');
  const liveBox = h('div');
  const failedBox = h('div');
  let filter = 'all';
  let q = '';
  let page = 1;
  let failedPage = 1;

  const FILTERS = [
    ['all', 'All'],
    ['pending', 'Pending'],
    ['processing', 'Processing'],
    ['sent', 'Sent'],
    ['delivered', 'Delivered'],
    ['read', 'Read'],
    ['failed', 'Failed'],
    ['invalid_number', 'Invalid Number'],
    ['not_on_whatsapp', 'Not on WhatsApp'],
    ['cancelled', 'Cancelled'],
  ];

  function drawHeader() {
    const running = batch.status === 'PROCESSING';
    const paused = batch.status === 'PAUSED';
    const canControl = can('bulk_whatsapp_reminders.control') && !batch.scoped;
    const act = (path, msg, confirmOpts) => async () => {
      if (confirmOpts && !(await confirmDialog(confirmOpts))) return;
      try {
        const r = await api('POST', `/bulk-reminders/batches/${batch.id}/${path}`);
        batch = r.batch;
        toast(msg);
        drawHeader();
        drawSummary();
      } catch (e) {
        toast(e.message, true);
      }
    };
    header.replaceChildren(
      h(
        'div',
        { class: 'row' },
        h('div', {}, h('h1', {}, running ? 'Sending Reminders' : 'Batch Report'), h('p', { class: 'sub' }, `Batch: ${batch.batchNumber} · ${batch.filename} · uploaded ${time(batch.uploadedAt)}${batch.uploadedByName ? ` by ${batch.uploadedByName}` : ''}`)),
        h('span', { class: 'spacer' }),
        badge(batch.status),
        canControl && running ? h('button', { class: 'btn secondary', onclick: act('pause', 'Batch paused') }, '⏸ Pause Batch') : null,
        canControl && paused ? h('button', { class: 'btn', onclick: act('resume', 'Batch resumed') }, '▶ Resume Batch') : null,
        canControl && (running || paused)
          ? h('button', { class: 'btn danger', onclick: act('cancel', 'Remaining messages cancelled', { title: 'Cancel remaining messages?', body: 'Messages already sent stay sent. Messages not yet sent will be marked Cancelled. History is kept.', confirmLabel: 'Cancel Remaining', danger: true }) }, 'Cancel Remaining')
          : null,
        can('bulk_whatsapp_reminders.export') ? downloadLink(`/bulk-reminders/batches/${batch.id}/export.xlsx`, 'Export Excel', `${batch.batchNumber}-results.xlsx`) : null,
        can('bulk_whatsapp_reminders.export') ? downloadLink(`/bulk-reminders/batches/${batch.id}/export.pdf`, 'Export PDF', `${batch.batchNumber}-report.pdf`) : null
      ),
      stepper(batch.status === 'PROCESSING' || batch.status === 'PAUSED' ? 3 : 4)
    );
  }

  function drawSummary() {
    summary.replaceChildren(
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'row', style: 'margin-bottom:6px' }, h('strong', {}, 'Progress'), h('span', { class: 'spacer' }), h('strong', {}, `${batch.progressPct}%`)),
        h('div', { class: 'progress big', role: 'progressbar', 'aria-valuenow': batch.progressPct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${batch.progressPct}%` })),
        batch.status === 'PAUSED' ? h('div', { class: 'notice warn', style: 'margin-top:10px' }, 'Paused – no new messages are being sent. Messages already in flight finish normally.') : null,
        batch.scoped ? h('div', { class: 'notice info', style: 'margin-top:10px' }, 'Showing only customers assigned to you.') : null,
        batch.simulated ? h('div', { class: 'notice bad', style: 'margin-top:10px' }, h('strong', {}, 'Test mode batch. '), 'WhatsApp was not connected when this batch ran: these messages were simulated and no customer received them.') : null
      ),
      h(
        'div',
        { class: 'cards' },
        card('Total', num(batch.recipients)),
        card('Processed', num(batch.processed)),
        card('Successful', num(batch.successful), 'ok'),
        card('Failed', num(batch.failed), batch.failed ? 'bad' : ''),
        card('Pending', num(batch.pending), batch.pending ? 'warn' : ''),
        card('Success Rate', pct(batch.successRatePct), 'ok'),
        card('Failed Rate', pct(batch.failureRatePct), batch.failed ? 'bad' : ''),
        batch.cancelled ? card('Cancelled', num(batch.cancelled)) : null
      )
    );
  }

  const search = h('input', { type: 'search', placeholder: 'Search customer / phone / account ID', style: 'min-width:280px' });
  search.addEventListener(
    'input',
    debounce(() => {
      q = search.value.trim();
      page = 1;
      loadLive();
    }, 300)
  );
  const chips = h('div', { class: 'chips' });
  function drawChips() {
    chips.replaceChildren(
      ...FILTERS.map(([v, l]) =>
        h('button', {
          class: `chip ${filter === v ? 'active' : ''}`,
          onclick: () => {
            filter = v;
            page = 1;
            drawChips();
            loadLive();
          },
        }, l)
      )
    );
  }
  drawChips();

  async function showAttempts(rec) {
    const data = await api('GET', `/bulk-reminders/batches/${batch.id}/records/${rec.id}/attempts`);
    const dlg = h(
      'dialog',
      { style: 'max-width:760px' },
      h('h3', {}, `${rec.customerName} · ${rec.phoneNumber}`),
      h('div', { class: 'bubble' }, rec.message || ''),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Request'), h('th', {}, 'Delivery'), h('th', {}, 'Error'), h('th', {}, 'Started'), h('th', {}, 'Provider ID'))),
          h('tbody', {}, data.attempts.length ? data.attempts.map((a) => h('tr', {}, h('td', {}, a.attempt), h('td', {}, a.requestStatus), h('td', {}, a.deliveryStatus || '—'), h('td', {}, [a.errorKind, a.errorCode, a.errorMessage].filter(Boolean).join(' · ') || '—'), h('td', {}, time(a.startedAt)), h('td', { class: 'mono' }, a.providerMessageId || '—'))) : h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No attempts yet')))
        )
      ),
      h('p', {}, h('button', { class: 'btn secondary', onclick: () => dlg.close() }, 'Close'))
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  async function loadLive() {
    const data = await api('GET', `/bulk-reminders/batches/${batch.id}/records?page=${page}&pageSize=50&filter=${filter}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    liveBox.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Customer'), h('th', {}, 'Phone'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Attempts'), h('th', {}, 'Last Update'), h('th', {}, 'Details'))),
          h(
            'tbody',
            {},
            data.records.length
              ? data.records.map((r) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => showAttempts(r), title: 'Show attempts' },
                    h('td', {}, r.customerName, r.accountId ? h('div', { class: 'muted' }, r.accountId) : null),
                    h('td', { class: 'mono' }, r.phoneNumber),
                    h('td', { class: 'num' }, inr(r.amountDue)),
                    h('td', {}, badge(r.status, batch.simulated)),
                    h('td', { class: 'num' }, r.attempts),
                    h('td', {}, r.attempts || r.status !== 'PENDING' ? time(r.updatedAt) : '—'),
                    h('td', { class: 'muted' }, r.status === 'RETRY_SCHEDULED' && r.nextAttemptAt ? `Next try ${time(r.nextAttemptAt)}` : r.failureReason || '')
                  )
                )
              : h('tr', {}, h('td', { colspan: 7, class: 'empty' }, 'No matching records'))
          )
        )
      ),
      pager(data.total, page, 50, (p) => {
        page = p;
        loadLive();
      })
    );
  }

  async function loadFailed() {
    const data = await api('GET', `/bulk-reminders/batches/${batch.id}/records?page=${failedPage}&pageSize=25&filter=all_failures`);
    const eligible = data.records.filter((r) => r.retryEligible).length;
    const canRetry = can('bulk_whatsapp_reminders.retry') && !batch.scoped && !['CANCELLED'].includes(batch.status);
    failedBox.replaceChildren(
      ...[
      h(
        'div',
        { class: 'row', style: 'margin-bottom:8px' },
        h('h2', { style: 'margin:0' }, `Failed Messages (${num(data.total)})`),
        h('span', { class: 'spacer' }),
        canRetry && eligible
          ? h('button', {
              class: 'btn',
              onclick: async () => {
                if (!(await confirmDialog({ title: 'Retry failed messages?', body: 'Only temporary/provider failures are retried. Invalid numbers and numbers not on WhatsApp are never resent automatically.', confirmLabel: 'Retry Failed' }))) return;
                try {
                  const r = await api('POST', `/bulk-reminders/batches/${batch.id}/retry-failed`, {});
                  batch = r.batch;
                  toast(`${r.retried} message(s) queued for retry`);
                  drawHeader();
                  drawSummary();
                  loadFailed();
                  loadLive();
                } catch (e) {
                  toast(e.message, true);
                }
              },
            }, 'Retry Failed')
          : null
      ),
      data.total
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Customer'), h('th', {}, 'Phone'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Status'), h('th', {}, 'Failure Reason'), h('th', {}, 'Error Code'), h('th', { class: 'num' }, 'Attempts'), h('th', {}, 'Last Attempt'), h('th', {}, 'Retry'))),
              h(
                'tbody',
                {},
                data.records.map((r) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, r.customerName),
                    h('td', { class: 'mono' }, r.phoneNumber),
                    h('td', { class: 'num' }, inr(r.amountDue)),
                    h('td', {}, badge(r.status, batch.simulated)),
                    h('td', {}, r.failureReason || '—'),
                    h('td', { class: 'mono' }, r.providerErrorCode || '—'),
                    h('td', { class: 'num' }, r.attempts),
                    h('td', {}, time(r.lastAttemptAt)),
                    h('td', {}, r.retryEligible ? h('span', { class: 'badge info' }, 'Eligible') : h('span', { class: 'badge' }, 'Permanent'))
                  )
                )
              )
            )
          )
        : h('div', { class: 'panel empty' }, 'No failed messages.'),
      data.total > 25 ? pager(data.total, failedPage, 25, (p) => ((failedPage = p), loadFailed())) : null,
      eligible || !data.total ? null : h('p', { class: 'muted' }, 'None of the failures on this page are eligible for retry.'),
      ].filter(Boolean)
    );
  }

  mount(
    header,
    summary,
    h('div', { class: 'row', style: 'margin:18px 0 10px' }, h('h2', { style: 'margin:0' }, 'Recipients'), h('span', { class: 'spacer' }), search),
    h('div', { style: 'margin-bottom:10px' }, chips),
    liveBox,
    h('div', { style: 'margin-top:24px' }, failedBox)
  );
  drawHeader();
  drawSummary();
  await Promise.all([loadLive(), loadFailed()]);

  // Live updates (Server-Sent Events). Closing the browser does not affect sending.
  const refreshTables = debounce(() => {
    loadLive().catch(() => {});
    loadFailed().catch(() => {});
  }, 800);
  const closeStream = openStream(`/bulk-reminders/batches/${batch.id}/stream`, (next) => {
    const statusChanged = next.status !== batch.status;
    batch = next;
    drawSummary();
    if (statusChanged) drawHeader();
    refreshTables();
  });
  teardown.push(closeStream);
}

// ------------------------------------------------------------------ history

async function renderHistory() {
  setCrumbs('Payments', 'Bulk Reminder History');
  const box = h('div');
  let page = 1;
  async function load() {
    const data = await api('GET', `/bulk-reminders/batches?page=${page}&pageSize=25`);
    box.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Batch'), h('th', {}, 'File'), h('th', {}, 'Date'), h('th', {}, 'Uploaded By'), h('th', { class: 'num' }, 'Records'), h('th', { class: 'num' }, 'Sent'), h('th', { class: 'num' }, 'Failed'), h('th', {}, 'Status'))),
          h(
            'tbody',
            {},
            data.batches.length
              ? data.batches.map((b) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => (location.hash = `#/bulk/${b.id}`) },
                    h('td', { class: 'mono' }, b.batchNumber),
                    h('td', {}, b.filename),
                    h('td', {}, dateOnly(b.uploadedAt)),
                    h('td', {}, b.uploadedByName || '—'),
                    h('td', { class: 'num' }, num(b.recipients || b.validRecords)),
                    h('td', { class: 'num' }, num(b.successful)),
                    h('td', { class: 'num' }, num(b.failed)),
                    h('td', {}, badge(b.status), b.simulated ? [' ', h('span', { class: 'badge warn', title: 'Sent in test mode – nothing reached WhatsApp' }, 'Test')] : null)
                  )
                )
              : h('tr', {}, h('td', { colspan: 8, class: 'empty' }, 'No batches yet'))
          )
        )
      ),
      pager(data.total, page, 25, (p) => ((page = p), load()))
    );
  }
  mount(h('div', { class: 'row' }, h('h1', {}, 'Bulk Reminder History'), h('span', { class: 'spacer' }), can('bulk_whatsapp_reminders.upload') ? h('a', { class: 'btn', href: '#/bulk' }, 'New upload') : null), h('p', { class: 'sub' }, 'Click a batch to open its detailed report.'), box);
  await load();
}

// ----------------------------------------------------------- template page

async function renderTemplateSettings() {
  setCrumbs('Settings', 'Message Template');
  const data = await api('GET', '/bulk-reminders/message-template');
  const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'English template' });
  ta.value = data.body;
  const taTe = h('textarea', { spellcheck: 'false', lang: 'te', 'aria-label': 'Telugu template' });
  taTe.value = data.bodyTe;
  const msg = h('div');
  mount(
    h('h1', {}, 'Default WhatsApp Message Templates'),
    h('p', { class: 'sub' }, `Used for new batches (English and Telugu). Placeholders: ${data.variables.map((v) => `{{${v}}}`).join(' ')}`),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'two-col' },
        h('div', {}, h('h3', { class: 'lang-h' }, 'English'), ta, h('button', { class: 'btn secondary small', style: 'margin-top:6px', onclick: () => (ta.value = data.defaultBody) }, 'Reset English to default')),
        h('div', {}, h('h3', { class: 'lang-h' }, 'Telugu (తెలుగు)'), taTe, h('button', { class: 'btn secondary small', style: 'margin-top:6px', onclick: () => (taTe.value = data.defaultBodyTe) }, 'Reset Telugu to default'))
      ),
      msg,
      h(
        'div',
        { class: 'row', style: 'margin-top:10px' },
        h('button', {
          class: 'btn',
          onclick: async () => {
            try {
              await api('PUT', '/bulk-reminders/message-template', { body: ta.value, bodyTe: taTe.value });
              msg.replaceChildren();
              toast('Template saved');
            } catch (e) {
              msg.replaceChildren(h('div', { class: 'notice bad', style: 'margin-top:10px' }, e.message));
            }
          },
        }, 'Save Templates'),
        h('span', { class: 'muted' }, data.updatedAt ? `Last updated ${time(data.updatedAt)}` : 'Using built-in default')
      )
    )
  );
}

// ------------------------------------------------------- WhatsApp connection

async function renderWhatsappSettings() {
  setCrumbs('Settings', 'WhatsApp Connection');
  const data = await api('GET', '/bulk-reminders/whatsapp');
  const st = data.status;
  const set = data.settings;
  const yes = (v) => (v ? h('span', { class: 'badge ok' }, '✓ set') : h('span', { class: 'badge bad' }, '✗ missing'));
  const modeText = { live: 'Connected (live)', test: 'Test mode – not connected', not_configured: 'Not connected' }[st.mode];

  const checkBox = h('div');
  const checkBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      checkBtn.disabled = true;
      checkBox.replaceChildren(h('p', { class: 'muted' }, 'Checking with WhatsApp…'));
      try {
        const r = await api('POST', '/bulk-reminders/whatsapp/check');
        checkBox.replaceChildren(
          h('div', { class: `notice ${r.ok ? 'info' : 'bad'}` }, r.ok ? 'Everything required for sending is working.' : 'Problems found – see below.'),
          h(
            'ul',
            { class: 'checks' },
            r.checks.map((c) => {
              const cls = c.ok ? 'ok' : c.required ? 'bad' : 'optional';
              return h('li', { class: cls }, h('span', { class: 'icon' }, c.ok ? '✓' : c.required ? '✗' : '!'), h('div', {}, h('div', {}, h('strong', {}, c.label), c.required ? null : h('span', { class: 'muted' }, ' (optional)')), h('div', { class: 'muted' }, c.detail)));
            })
          )
        );
      } catch (e) {
        checkBox.replaceChildren(h('div', { class: 'notice bad' }, e.message));
      } finally {
        checkBtn.disabled = false;
      }
    },
  }, 'Check connection');

  const phone = h('input', { type: 'text', placeholder: '98765 43210', inputmode: 'tel', 'aria-label': 'Phone number for the test message' });
  const lang = h('select', { 'aria-label': 'Language' }, Object.entries(LANG_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const testResult = h('div');
  const testBtn = h('button', {
    class: 'btn secondary',
    disabled: !st.canSend,
    onclick: async () => {
      if (!phone.value.trim()) return toast('Enter a phone number', true);
      const ok = await confirmDialog({
        title: st.mode === 'test' ? 'Simulate a test message?' : 'Send a real test message?',
        body: st.mode === 'test' ? 'Test mode: nothing will be sent.' : `A real WhatsApp payment-reminder template message (₹1, account TEST-0001) will be sent to ${phone.value}. Only send to a number that agreed to receive it, e.g. your own.`,
        confirmLabel: 'Send test',
      });
      if (!ok) return;
      testBtn.disabled = true;
      try {
        const r = await api('POST', '/bulk-reminders/whatsapp/test-message', { phoneNumber: phone.value, language: lang.value });
        testResult.replaceChildren(
          r.ok
            ? h('div', { class: `notice ${r.simulated ? 'warn' : 'info'}` }, r.simulated ? 'Simulated only (test mode) – nothing was sent.' : `Accepted by WhatsApp for ${r.to} (message id ${r.providerMessageId}). Check the phone; delivery updates arrive through the webhook.`)
            : h('div', { class: 'notice bad' }, `WhatsApp rejected the message: ${r.error}${r.errorCode ? ` (code ${r.errorCode})` : ''}`)
        );
      } catch (e) {
        testResult.replaceChildren(h('div', { class: 'notice bad' }, e.message));
      } finally {
        testBtn.disabled = !st.canSend;
      }
    },
  }, 'Send test message');

  mount(
    h('h1', {}, 'WhatsApp Connection'),
    h('p', { class: 'sub' }, 'Reminders are sent through the official WhatsApp Business Platform (Meta Cloud API). Credentials are kept on the server, never in this page.'),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'row' }, h('span', { class: `status-pill ${st.mode}` }, modeText), h('span', {}, st.message)),
      st.missing.length && st.mode !== 'test' ? h('div', { class: 'notice bad', style: 'margin-top:12px' }, `Missing on the server: ${st.missing.join(', ')}`) : null,
      st.warnings.length ? h('ul', { class: 'errors' }, st.warnings.map((w) => h('li', {}, w))) : null
    ),
    h(
      'div',
      { class: 'two-col' },
      h(
        'div',
        { class: 'panel' },
        h('h2', { style: 'margin-top:0' }, 'Server settings'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', {}, 'Provider (WHATSAPP_PROVIDER)'), h('dd', {}, set.provider === 'none' ? h('span', { class: 'badge bad' }, 'not set') : set.provider === 'mock' ? h('span', { class: 'badge warn' }, 'mock (test mode)') : set.provider),
          h('dt', {}, 'Access token'), h('dd', {}, yes(set.accessTokenSet)),
          h('dt', {}, 'Phone number ID'), h('dd', { class: 'mono' }, set.phoneNumberId || h('span', { class: 'badge bad' }, '✗ missing')),
          h('dt', {}, 'Business account ID'), h('dd', { class: 'mono' }, set.businessAccountId || h('span', { class: 'badge bad' }, '✗ missing')),
          h('dt', {}, 'App secret (webhook)'), h('dd', {}, yes(set.webhookSecretSet)),
          h('dt', {}, 'Webhook verify token'), h('dd', {}, yes(set.webhookVerifyTokenSet)),
          h('dt', {}, 'Send mode'), h('dd', {}, set.sendMode),
          ...set.templates.flatMap((t) => [h('dt', {}, `Template – ${t.use}`), h('dd', { class: 'mono' }, `${t.name} (${t.language})`)])
        )
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', { style: 'margin-top:0' }, 'Webhook (delivery updates)'),
        h('p', { class: 'muted' }, 'In Meta → your app → WhatsApp → Configuration, set the callback URL below, the same verify token as WHATSAPP_WEBHOOK_VERIFY_TOKEN, and subscribe to "messages".'),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Callback URL'), h('dd', { class: 'mono' }, data.webhook.callbackUrl),
          h('dt', {}, 'Last update received'), h('dd', {}, data.webhook.lastEventAt ? time(data.webhook.lastEventAt) : 'never'),
          h('dt', {}, 'Last rejected (bad signature)'), h('dd', {}, data.webhook.lastRejectedAt ? time(data.webhook.lastRejectedAt) : 'never')
        ),
        data.webhook.callbackUrl.startsWith('http://') ? h('div', { class: 'notice warn', style: 'margin-top:10px' }, 'Meta only accepts https:// callback URLs – deploy the server with HTTPS.') : null
      )
    ),
    h('div', { class: 'panel' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Check connection'), h('span', { class: 'spacer' }), checkBtn), h('p', { class: 'muted' }, 'Verifies the access token and sender number with Meta and that each message template is approved. Sends nothing.'), checkBox),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, 'Send a test message'), h('p', { class: 'muted' }, 'Sends one payment-reminder template message to a single number so you can see it arrive.'), h('div', { class: 'row' }, phone, lang, testBtn), testResult),
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'How to connect WhatsApp'),
      h(
        'ol',
        { class: 'steps-list' },
        h('li', {}, 'In Meta Business Manager, create a WhatsApp Business Account and complete business verification.'),
        h('li', {}, 'In developers.facebook.com create a Business app, add WhatsApp, and register your sending phone number.'),
        h('li', {}, 'Create a System User with a permanent token (whatsapp_business_messaging, whatsapp_business_management).'),
        h('li', {}, 'In WhatsApp Manager create the "payment_reminder" Utility template (English, and a Telugu translation if needed) and wait for approval.'),
        h('li', {}, 'On the server set: WHATSAPP_PROVIDER=meta_cloud, WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_WEBHOOK_SECRET (App Secret), WHATSAPP_WEBHOOK_VERIFY_TOKEN – then restart.'),
        h('li', {}, 'Configure the webhook above, then use "Check connection" and "Send a test message".')
      ),
      h('p', { class: 'muted' }, 'Full guide: docs/BULK_WHATSAPP_REMINDERS.md, section 4.')
    )
  );
}

// ---------------------------------------------------------------- audit log

async function renderAudit() {
  setCrumbs('Settings', 'Audit Log');
  const box = h('div');
  let page = 1;
  let action = '';
  const sel = h('select', {}, [['', 'All actions'], ['bulk.', 'Batch actions'], ['message.', 'Message events'], ['auth.', 'Sign-in'], ['template.', 'Template'], ['optout.', 'Opt-outs'], ['whatsapp.', 'WhatsApp connection'], ['webhook.', 'Webhooks']].map(([v, l]) => h('option', { value: v }, l)));
  sel.addEventListener('change', () => {
    action = sel.value;
    page = 1;
    load();
  });
  async function load() {
    const data = await api('GET', `/audit-logs?page=${page}&pageSize=100${action ? `&action=${encodeURIComponent(action)}` : ''}`);
    box.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'User'), h('th', {}, 'Role'), h('th', {}, 'Action'), h('th', {}, 'Description'), h('th', {}, 'Batch'), h('th', {}, 'Record'), h('th', {}, 'IP'))),
          h('tbody', {}, data.entries.map((a) => h('tr', {}, h('td', {}, time(a.createdAt)), h('td', {}, a.username || '—'), h('td', {}, a.role || '—'), h('td', { class: 'mono' }, a.action), h('td', {}, a.description || ''), h('td', {}, a.batchId ? h('a', { href: `#/bulk/${a.batchId}` }, `#${a.batchId}`) : '—'), h('td', {}, a.recordId || '—'), h('td', { class: 'mono' }, a.ip || '—'))))
        )
      ),
      pager(data.total, page, 100, (p) => ((page = p), load()))
    );
  }
  mount(h('div', { class: 'row' }, h('h1', {}, 'Audit Log'), h('span', { class: 'spacer' }), sel), h('p', { class: 'sub' }, 'Every upload, validation, send, retry, cancellation and message outcome.'), box);
  await load();
}

// --------------------------------------------------------------------- boot

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  if (NATIVE) store.set('token', null);
  state.user = null;
  location.hash = '#/login';
});
// Phone layout: the side menu becomes a slide-over opened from the ☰ button.
document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.getElementById('sidenav').addEventListener('click', (e) => {
  if (e.target.closest('a')) document.body.classList.remove('nav-open');
});
if (NATIVE) document.documentElement.classList.add('native');
window.addEventListener('hashchange', route);
route();
