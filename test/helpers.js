'use strict';

const ExcelJS = require('exceljs');
const { loadConfig } = require('../src/config');
const { createDb, migrate } = require('../src/db');
const { createApplication } = require('../src/app');
const { createUser } = require('../src/auth/auth');
const { MockProvider } = require('../src/whatsapp/mockProvider');

const PASSWORD = 'correct-horse-battery';
const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * Spin up an isolated app on an in-memory SQLite DB with a scripted mock provider.
 */
async function setup({ script, queue = {}, reminders = {}, provider, latencyMs = 0, whatsapp = {} } = {}) {
  const config = loadConfig({
    env: 'test',
    database: { client: 'better-sqlite3', sqliteFilename: ':memory:' },
    auth: { jwtSecret: 'test-secret-test-secret-test-secret', cookieSecure: false },
    whatsapp: { provider: 'mock', webhookSecret: 'whsec_test', webhookVerifyToken: 'verify-me', ...whatsapp },
    queue: { maxRetries: 3, retryBaseDelayMs: 5, retryMaxDelayMs: 20, concurrency: 5, pollIntervalMs: 5, leaseMs: 60000, sendRatePerSecond: 0, reconcileWindowMs: 60000, runInProcess: false, ...queue },
    reminders: { duplicateWindowHours: 24, ...reminders },
    audit: { captureIp: true },
  });
  const db = createDb(config);
  await migrate(db);
  const mock = provider || new MockProvider({ script, latencyMs, webhookSecret: 'whsec_test', verifyToken: 'verify-me' });
  const ctx = createApplication({ db, config, provider: mock, logger: quietLogger });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await createUser(db, { username: 'admin', displayName: 'Admin', password: PASSWORD, role: 'admin' });
  await createUser(db, { username: 'head', displayName: 'Main Head', password: PASSWORD, role: 'main_head' });
  await createUser(db, { username: 'suresh', displayName: 'Suresh', password: PASSWORD, role: 'employee' });

  async function close() {
    await ctx.worker.stop();
    mock.close && mock.close();
    await new Promise((r) => server.close(r));
    await db.destroy();
  }

  return { ...ctx, db, config, mock, base, close };
}

async function login(base, username) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return client(base, cookie);
}

function client(base, cookie) {
  const call = async (method, path, body, { form } = {}) => {
    const headers = { 'X-Requested-With': 'fetch' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    cookie,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b === undefined ? {} : b),
    put: (p, b) => call('PUT', p, b),
    upload: (p, buffer, filename = 'reminders.xlsx') => {
      const form = new FormData();
      form.append('file', new Blob([buffer]), filename);
      return call('POST', p, undefined, { form });
    },
  };
}

const HEADERS = ['Customer Name', 'Phone Number', 'Amount Due', 'Due Date', 'Loan/Account ID', 'Installment Number', 'Employee/Collector', 'Custom Message'];

/** rows: arrays or objects keyed by the header names. */
async function makeXlsx(rows, { headers = HEADERS } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reminders');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(Array.isArray(r) ? r : headers.map((h) => (r[h] === undefined ? null : r[h])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Generate N valid customers with unique phones/accounts. */
function customers(n, { phoneFor } = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      'Customer Name': `Customer ${i}`,
      'Phone Number': phoneFor ? phoneFor(i) : String(9000000000 + i * 7),
      'Amount Due': 1000 + i,
      'Due Date': '30-09-2026',
      'Loan/Account ID': `LN${String(i).padStart(5, '0')}`,
      'Installment Number': '1',
    });
  }
  return out;
}

/** Upload → import → send; returns batch id. */
async function uploadAndSend(api, rows, { overrideDuplicates = false } = {}) {
  const up = await api.upload('/api/bulk-reminders/uploads', await makeXlsx(rows));
  if (up.status !== 201) throw new Error(`upload failed: ${JSON.stringify(up.data)}`);
  const id = up.data.batch.id;
  const imp = await api.post(`/api/bulk-reminders/batches/${id}/import`);
  if (imp.status !== 200) throw new Error(`import failed: ${JSON.stringify(imp.data)}`);
  const send = await api.post(`/api/bulk-reminders/batches/${id}/send`, { confirm: true, overrideDuplicates });
  if (send.status !== 202) throw new Error(`send failed: ${JSON.stringify(send.data)}`);
  return { id, upload: up.data };
}

async function records(db, batchId) {
  return db('bulk_reminder_records').where({ batch_id: batchId }).orderBy('row_number');
}

module.exports = { setup, login, client, makeXlsx, customers, uploadAndSend, records, HEADERS, PASSWORD };
