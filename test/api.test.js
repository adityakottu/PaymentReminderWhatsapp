'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { setup, login, client, makeXlsx, customers, uploadAndSend, records } = require('./helpers');

test('upload → validation preview with exact reasons; nothing is sent before confirmation', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const api = await login(env.base, 'admin');
    const xlsx = await makeXlsx([
      { 'Customer Name': 'Ravi Kumar', 'Phone Number': '9876543210', 'Amount Due': 5000, 'Due Date': '30-09-2026', 'Loan/Account ID': 'LN10045' },
      { 'Customer Name': 'Ravi', 'Phone Number': '98765', 'Amount Due': 5000 },
      { 'Customer Name': 'Kumar', 'Phone Number': '9876543211', 'Amount Due': null },
      { 'Customer Name': 'Suresh', 'Phone Number': '+91 98765 43210', 'Amount Due': 2000 }, // same phone, no account → duplicate
      { 'Customer Name': null, 'Phone Number': '9876543212', 'Amount Due': 100 },
      { 'Customer Name': 'Neg', 'Phone Number': '9876543213', 'Amount Due': -5 },
      { 'Customer Name': 'BadDate', 'Phone Number': '9876543214', 'Amount Due': 10, 'Due Date': '31-02-2026' },
      { 'Customer Name': 'Words', 'Phone Number': '9876543215', 'Amount Due': 'five hundred' },
      {}, // empty row – ignored
      { 'Customer Name': 'Dup Account', 'Phone Number': '9876543216', 'Amount Due': 10, 'Loan/Account ID': 'LN10045' },
      { 'Customer Name': 'Intl', 'Phone Number': '+44 7911 123456', 'Amount Due': 10 },
      { 'Customer Name': 'Rupee', 'Phone Number': '09876543217', 'Amount Due': '₹1,250.50' },
    ]);
    const up = await api.upload('/api/bulk-reminders/uploads', xlsx, 'Sept-Payments.xlsx');
    assert.equal(up.status, 201, JSON.stringify(up.data));
    const b = up.data.batch;
    assert.match(b.batchNumber, /^BULK-\d{8}-001$/);
    assert.equal(b.status, 'VALIDATED');
    assert.equal(b.totalRows, 11);
    assert.equal(b.validRecords, 2);
    assert.equal(b.duplicateRecords, 2);
    assert.equal(b.invalidRecords, 7);

    const issues = await api.get(`/api/bulk-reminders/batches/${b.id}/issues?pageSize=50`);
    const reasonFor = (row) => issues.data.rows.find((r) => r.rowNumber === row).reasons.join('; ');
    assert.match(reasonFor(3), /Phone number incomplete/);
    assert.match(reasonFor(4), /Amount missing/);
    assert.match(reasonFor(5), /Duplicate phone number/);
    assert.match(reasonFor(6), /Customer name missing/);
    assert.match(reasonFor(7), /negative/);
    assert.match(reasonFor(8), /Invalid due date/);
    assert.match(reasonFor(9), /not a number/);
    assert.match(reasonFor(11), /Duplicate Loan\/Account ID/);
    assert.match(reasonFor(12), /International numbers are not enabled/);

    // Nothing queued / sent yet.
    assert.equal((await env.db('bulk_reminder_records').count({ c: '*' }))[0].c, 0);

    const imp = await api.post(`/api/bulk-reminders/batches/${b.id}/import`);
    assert.equal(imp.data.batch.status, 'READY');
    const recs = await records(env.db, b.id);
    assert.deepEqual(recs.map((r) => r.phone_number), ['919876543210', '919876543217']);
    assert.equal(Number(recs[1].amount_due), 1250.5);
    assert.equal(recs[0].due_date, '2026-09-30');

    // Preview uses the default template.
    const pv = await api.post(`/api/bulk-reminders/batches/${b.id}/preview`, {});
    assert.equal(
      pv.data.previews[0].message,
      'Hello Ravi Kumar,\n\nThis is a reminder regarding your pending payment of ₹5,000.\n\nDue Date: 30-09-2026\n\nPlease make the payment at your earliest convenience.\n\nLoan/Account ID: LN10045\n\nThank you.'
    );

    // Sending requires explicit confirmation.
    const noConfirm = await api.post(`/api/bulk-reminders/batches/${b.id}/send`, {});
    assert.equal(noConfirm.status, 400);
    const ready = await api.get(`/api/bulk-reminders/batches/${b.id}/send-readiness`);
    assert.equal(ready.data.recipients, 2);
    const send = await api.post(`/api/bulk-reminders/batches/${b.id}/send`, { confirm: true, expectedRecipients: 2 });
    assert.equal(send.status, 202);
    assert.equal(send.data.batch.status, 'PROCESSING');
    const second = await api.post(`/api/bulk-reminders/batches/${b.id}/send`, { confirm: true });
    assert.equal(second.status, 409, 'a batch can never be started twice');
  } finally {
    await env.close();
  }
});

test('uploading the exact same file twice is flagged; batch numbers increment per day', async () => {
  const env = await setup();
  try {
    const api = await login(env.base, 'admin');
    const buf = await makeXlsx(customers(2, { phoneFor: (i) => `987654321${i}` }));
    const a = await api.upload('/api/bulk-reminders/uploads', buf, 'Sept.xlsx');
    const b = await api.upload('/api/bulk-reminders/uploads', buf, 'Sept.xlsx');
    assert.equal(a.data.validation.sameFileUploadedAs, null);
    assert.equal(b.data.validation.sameFileUploadedAs, a.data.batch.batchNumber);
    assert.match(a.data.batch.batchNumber, /-001$/);
    assert.match(b.data.batch.batchNumber, /-002$/);
  } finally {
    await env.close();
  }
});

test('rejects empty, corrupted, legacy .xls, missing-column and oversized files', async () => {
  const env = await setup();
  try {
    const api = await login(env.base, 'admin');
    let r = await api.upload('/api/bulk-reminders/uploads', Buffer.from('not a zip file at all'), 'x.xlsx');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /not a valid .xlsx/);
    r = await api.upload('/api/bulk-reminders/uploads', Buffer.from('PK\u0003\u0004garbage'), 'x.xlsx');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /could not be read/);
    r = await api.upload('/api/bulk-reminders/uploads', Buffer.from('x'), 'old.xls');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /\.xls/);
    r = await api.upload('/api/bulk-reminders/uploads', await makeXlsx([]), 'empty.xlsx');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /no data rows/);
    r = await api.upload('/api/bulk-reminders/uploads', await makeXlsx([['Ravi', '9876543210']], { headers: ['Customer Name', 'Phone Number'] }), 'cols.xlsx');
    assert.equal(r.status, 400);
    assert.deepEqual(r.data.details.missingColumns, ['Amount Due']);
    env.config.upload.maxFileMb = 0.001;
    r = await api.upload('/api/bulk-reminders/uploads', Buffer.alloc(5000, 1), 'big.xlsx');
    assert.equal(r.status, 413);
  } finally {
    await env.close();
  }
});

test('downloadable template has the expected columns and its sample row is never imported', async () => {
  const env = await setup();
  try {
    const api = await login(env.base, 'admin');
    const r = await api.get('/api/bulk-reminders/template.xlsx');
    assert.equal(r.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.data);
    const ws = wb.getWorksheet('Reminders');
    assert.deepEqual(ws.getRow(1).values.slice(1), ['Customer Name', 'Phone Number', 'Amount Due', 'Due Date', 'Loan/Account ID', 'Installment Number', 'Employee/Collector', 'Custom Message', 'Language']);
    assert.match(String(ws.getRow(2).getCell(8).value), /SAMPLE/);
    const up = await api.upload('/api/bulk-reminders/uploads', r.data, 'template.xlsx');
    assert.equal(up.status, 400, 'template with only the sample row has no data rows');
  } finally {
    await env.close();
  }
});

test('duplicate protection: the same reminder uploaded twice is skipped within 24h unless overridden', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const admin = await login(env.base, 'admin');
    const rows = customers(3, { phoneFor: (i) => `987654321${i}` });
    const first = await uploadAndSend(admin, rows);
    await env.worker.drain();

    const up = await admin.upload('/api/bulk-reminders/uploads', await makeXlsx(rows));
    assert.equal(up.data.validation.recentlyReminded, 3);
    const id2 = up.data.batch.id;
    await admin.post(`/api/bulk-reminders/batches/${id2}/import`);
    const ready = await admin.get(`/api/bulk-reminders/batches/${id2}/send-readiness`);
    assert.equal(ready.data.recentlyReminded, 3);

    // Main head may not override duplicates.
    const head = await login(env.base, 'head');
    const denied = await head.post(`/api/bulk-reminders/batches/${id2}/send`, { confirm: true, overrideDuplicates: true });
    assert.equal(denied.status, 403);

    await admin.post(`/api/bulk-reminders/batches/${id2}/send`, { confirm: true });
    await env.worker.drain();
    const recs = await records(env.db, id2);
    assert.deepEqual(recs.map((r) => r.status), ['CANCELLED', 'CANCELLED', 'CANCELLED']);
    assert.match(recs[0].failure_reason, /already sent within 24h/);
    assert.equal(env.mock.calls.length, 3, 'no second message');
    assert.equal((await env.db('bulk_upload_batches').where({ id: id2 }).first()).status, 'COMPLETED');

    // Authorised override sends again.
    const third = await uploadAndSend(admin, rows, { overrideDuplicates: true });
    await env.worker.drain();
    assert.deepEqual((await records(env.db, third.id)).map((r) => r.status), ['SENT', 'SENT', 'SENT']);
    assert.ok(first.id);
  } finally {
    await env.close();
  }
});

test('role-based access: employees see only assigned customers and cannot send or change settings', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const admin = await login(env.base, 'admin');
    const rows = customers(4, { phoneFor: (i) => `987654321${i}` });
    rows[0]['Employee/Collector'] = 'Suresh';
    rows[2]['Employee/Collector'] = 'suresh';
    const { id } = await uploadAndSend(admin, rows);
    await env.worker.drain();

    const emp = await login(env.base, 'suresh');
    const list = await emp.get('/api/bulk-reminders/batches');
    assert.equal(list.data.total, 1);
    const recs = await emp.get(`/api/bulk-reminders/batches/${id}/records`);
    assert.equal(recs.data.total, 2);
    const summary = await emp.get(`/api/bulk-reminders/batches/${id}`);
    assert.equal(summary.data.batch.scoped, true);
    assert.equal(summary.data.batch.recipients, 2);

    assert.equal((await emp.upload('/api/bulk-reminders/uploads', await makeXlsx(rows))).status, 403);
    assert.equal((await emp.post(`/api/bulk-reminders/batches/${id}/retry-failed`)).status, 403);
    assert.equal((await emp.post(`/api/bulk-reminders/batches/${id}/pause`)).status, 403);
    assert.equal((await emp.put('/api/bulk-reminders/message-template', { body: 'x' })).status, 403);
    assert.equal((await emp.get('/api/audit-logs')).status, 403);
    assert.equal((await emp.get(`/api/bulk-reminders/batches/${id}/export.xlsx`)).status, 403);

    // Revoking the feature permission blocks everything.
    const empId = (await env.db('users').where({ username: 'suresh' }).first()).id;
    await admin.put(`/api/users/${empId}/permissions`, { permission: 'bulk_whatsapp_reminders', granted: false });
    assert.equal((await emp.get('/api/bulk-reminders/batches')).status, 403);

    // Unauthenticated + CSRF.
    const anon = client(env.base, null);
    assert.equal((await anon.get('/api/bulk-reminders/batches')).status, 401);
    const noHeader = await fetch(`${env.base}/api/bulk-reminders/batches/${id}/pause`, { method: 'POST', headers: { Cookie: admin.cookie } });
    assert.equal(noHeader.status, 403);
  } finally {
    await env.close();
  }
});

test('employee with send permission can upload and send their own batch', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const admin = await login(env.base, 'admin');
    const empId = (await env.db('users').where({ username: 'suresh' }).first()).id;
    await admin.put(`/api/users/${empId}/permissions`, { permission: 'bulk_whatsapp_reminders.upload', granted: true });
    await admin.put(`/api/users/${empId}/permissions`, { permission: 'bulk_whatsapp_reminders.send', granted: true });
    const emp = await login(env.base, 'suresh');
    const { id } = await uploadAndSend(emp, customers(2, { phoneFor: (i) => `987654321${i}` }));
    await env.worker.drain();
    assert.equal((await env.db('bulk_upload_batches').where({ id }).first()).status, 'COMPLETED');
    // ...but still not the global template.
    assert.equal((await emp.put('/api/bulk-reminders/message-template', { body: 'Hi {{customer_name}} {{amount_due}}' })).status, 403);
  } finally {
    await env.close();
  }
});

test('template editing: validation, per-batch edit, rendered message stored per record', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const admin = await login(env.base, 'admin');
    let r = await admin.put('/api/bulk-reminders/message-template', { body: 'Hi {{customer_name}} {{unknown_thing}}' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Unknown placeholder/);
    r = await admin.put('/api/bulk-reminders/message-template', { body: 'Hi {{customer_name}}, pay ₹{{amount_due}}{{#if due_date}} by {{due_date}}{{/if}}.' });
    assert.equal(r.status, 200);

    const up = await admin.upload('/api/bulk-reminders/uploads', await makeXlsx(customers(1, { phoneFor: () => '9876543211' })));
    const id = up.data.batch.id;
    await admin.post(`/api/bulk-reminders/batches/${id}/import`);
    r = await admin.put(`/api/bulk-reminders/batches/${id}/template`, { template: 'Dear {{customer_name}}, ₹{{amount_due}} is due{{#if account_id}} on {{account_id}}{{/if}}.' });
    assert.equal(r.status, 200);
    await admin.post(`/api/bulk-reminders/batches/${id}/send`, { confirm: true });
    await env.worker.drain();
    const [rec] = await records(env.db, id);
    assert.equal(rec.message, 'Dear Customer 1, ₹1,001 is due on LN00001.');
    assert.equal(env.mock.calls[0].text, rec.message);
    assert.equal(env.mock.calls[0].variables.amount_due, '1,001');
    assert.equal(env.mock.calls[0].idempotencyKey, rec.idempotency_key);
  } finally {
    await env.close();
  }
});

test('exports: Excel neutralises formula injection; PDF is generated', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const admin = await login(env.base, 'admin');
    const rows = customers(2, { phoneFor: (i) => `987654321${i}` });
    rows[0]['Customer Name'] = '=HYPERLINK("http://evil","x")';
    rows[1]['Loan/Account ID'] = '+SUM(A1:A2)';
    const { id } = await uploadAndSend(admin, rows);
    await env.worker.drain();

    const x = await admin.get(`/api/bulk-reminders/batches/${id}/export.xlsx`);
    assert.equal(x.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.data);
    const ws = wb.getWorksheet('Results');
    assert.deepEqual(ws.getRow(1).values.slice(1, 14), ['Customer Name', 'Phone Number', 'Amount Due', 'Due Date', 'Account ID', 'Message', 'Status', 'Failure Reason', 'Provider Error Code', 'Attempts', 'Sent Time', 'Delivered Time', 'Read Time']);
    const name = ws.getRow(2).getCell(1).value;
    assert.equal(typeof name, 'string');
    assert.ok(name.startsWith("'="), 'formula neutralised');
    assert.ok(String(ws.getRow(3).getCell(5).value).startsWith("'+"));
    assert.equal(ws.getRow(2).getCell(7).value, 'Sent (simulated)', 'test-mode batches are labelled simulated');

    const p = await admin.get(`/api/bulk-reminders/batches/${id}/export.pdf`);
    assert.equal(p.status, 200);
    assert.equal(p.data.subarray(0, 5).toString(), '%PDF-');
    const audits = await env.db('audit_logs').where({ action: 'bulk.exported' });
    assert.equal(audits.length, 2);
  } finally {
    await env.close();
  }
});

test('history, records filters and search', async () => {
  const env = await setup({ script: (to) => (to.endsWith('2') ? 'NOT_ON_WHATSAPP' : 'success') });
  try {
    const admin = await login(env.base, 'admin');
    const { id } = await uploadAndSend(admin, customers(4, { phoneFor: (i) => `987654321${i}` }));
    await env.worker.drain();
    const hist = await admin.get('/api/bulk-reminders/batches');
    assert.equal(hist.data.batches[0].successful, 3);
    assert.equal(hist.data.batches[0].failed, 1);
    assert.equal(hist.data.batches[0].status, 'COMPLETED_WITH_FAILURES');
    assert.equal((await admin.get(`/api/bulk-reminders/batches/${id}/records?filter=not_on_whatsapp`)).data.total, 1);
    assert.equal((await admin.get(`/api/bulk-reminders/batches/${id}/records?filter=sent`)).data.total, 3);
    assert.equal((await admin.get(`/api/bulk-reminders/batches/${id}/records?q=customer%203`)).data.total, 1);
    assert.equal((await admin.get(`/api/bulk-reminders/batches/${id}/records?q=543214`)).data.total, 1);
    assert.equal((await admin.get(`/api/bulk-reminders/batches/${id}/records?q=ln00002`)).data.total, 1);
    const att = await admin.get(`/api/bulk-reminders/batches/${id}/records/${(await records(env.db, id))[1].id}/attempts`);
    assert.equal(att.data.attempts.length, 1);
    assert.equal(att.data.attempts[0].errorCode, '131026');
  } finally {
    await env.close();
  }
});

test('mobile app: bearer-token login, CORS for the app origins, no CSRF header needed', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    // Pre-flight from the iOS app web view.
    let res = await fetch(`${env.base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
    // Unknown origins get no CORS headers.
    res = await fetch(`${env.base}/api/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);

    res = await fetch(`${env.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Origin: 'https://localhost' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery', client: 'mobile' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null, 'mobile login does not set a cookie');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://localhost');
    const { token, user, expiresIn } = await res.json();
    assert.ok(token && user.username === 'admin');
    assert.equal(expiresIn, 7 * 24 * 3600);

    const auth = { Authorization: `Bearer ${token}` };
    res = await fetch(`${env.base}/api/auth/me`, { headers: auth });
    assert.equal(res.status, 200);
    // Upload + import with bearer only (no cookie, no X-Requested-With).
    const form = new FormData();
    form.append('file', new Blob([await makeXlsx(customers(2, { phoneFor: (i) => `987654321${i}` }))]), 'm.xlsx');
    res = await fetch(`${env.base}/api/bulk-reminders/uploads`, { method: 'POST', headers: auth, body: form });
    assert.equal(res.status, 201);
    const id = (await res.json()).batch.id;
    res = await fetch(`${env.base}/api/bulk-reminders/batches/${id}/import`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    res = await fetch(`${env.base}/api/bulk-reminders/batches/${id}/export.xlsx`, { headers: { ...auth, Origin: 'capacitor://localhost' } });
    assert.equal(res.headers.get('access-control-expose-headers'), 'Content-Disposition');

    // A tampered token is rejected.
    res = await fetch(`${env.base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}x` } });
    assert.equal(res.status, 401);
    // Cookie sessions still require the CSRF header.
    const web = await login(env.base, 'admin');
    res = await fetch(`${env.base}/api/bulk-reminders/batches/${id}/cancel-upload`, { method: 'POST', headers: { Cookie: web.cookie } });
    assert.equal(res.status, 403);
  } finally {
    await env.close();
  }
});
