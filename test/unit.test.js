'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { normalizePhone } = require('../src/bulk/phone');
const { renderTemplate, validateTemplate, renderForRecord, DEFAULT_TEMPLATE } = require('../src/bulk/template');
const { validateRows, parseAmount, parseDueDate } = require('../src/bulk/validation');
const { classifyMetaError, MetaCloudProvider } = require('../src/whatsapp/metaCloudProvider');
const { ERROR_KIND, ProviderSendError } = require('../src/whatsapp/provider');
const { safeCell } = require('../src/bulk/export');
const { effectivePermissions, PERMISSIONS } = require('../src/auth/permissions');

test('phone normalisation (India)', () => {
  const ok = (input, value) => assert.deepEqual(normalizePhone(input), { ok: true, value }, String(input));
  ok('9876543210', '919876543210');
  ok(9876543210, '919876543210');
  ok('+919876543210', '919876543210');
  ok('+91 98765 43210', '919876543210');
  ok('919876543210', '919876543210');
  ok(919876543210, '919876543210');
  ok('09876543210', '919876543210');
  ok('0091-98765-43210', '919876543210');
  ok('(987) 654-3210', '919876543210');
  ok('9876543210.0', '919876543210');
  const bad = (input, re) => {
    const r = normalizePhone(input);
    assert.equal(r.ok, false, String(input));
    assert.match(r.reason, re);
  };
  bad('98765', /incomplete/);
  bad('', /missing/);
  bad(null, /missing/);
  bad('1234567890', /Invalid Indian mobile/);
  bad('9.87654E+11', /scientific notation/);
  bad('98765abc10', /letters/);
  bad('+44 7911 123456', /International numbers are not enabled/);
  bad('9198765432101', /too many digits/);
});

test('international numbers are kept as-is only when enabled', () => {
  assert.deepEqual(normalizePhone('+44 7911 123456', { internationalEnabled: true }), { ok: true, value: '447911123456' });
  assert.deepEqual(normalizePhone('+1 (415) 555-2671', { internationalEnabled: true }), { ok: true, value: '14155552671' });
  // Indian numbers are still normalised.
  assert.deepEqual(normalizePhone('9876543210', { internationalEnabled: true }), { ok: true, value: '919876543210' });
});

test('template rendering with conditionals', () => {
  const msg = renderForRecord(DEFAULT_TEMPLATE, { customer_name: 'Ravi Kumar', amount_due: 5000, due_date: null, account_id: null });
  assert.equal(msg, 'Hello Ravi Kumar,\n\nThis is a reminder regarding your pending payment of ₹5,000.\n\nPlease make the payment at your earliest convenience.\n\nThank you.');
  assert.equal(renderTemplate('{{#if a}}A{{else}}B{{/if}}', { a: '' }), 'B');
  assert.equal(renderTemplate('{{#if a}}{{#if b}}AB{{/if}}{{/if}}', { a: 1, b: 1 }), 'AB');
  assert.equal(renderTemplate('Hi {{ customer_name }}', { customer_name: '<b>x</b>' }), 'Hi <b>x</b>');
  assert.equal(validateTemplate('{{#if due_date}}x').ok, false);
  assert.equal(validateTemplate('Hi {{customer_name}}').ok, false, 'amount required');
  assert.equal(validateTemplate(DEFAULT_TEMPLATE).ok, true);
  assert.equal(renderForRecord('{{amount_due}}', { amount_due: 1234567.5 }), '12,34,567.50');
});

test('amount and date parsing', () => {
  assert.deepEqual(parseAmount('₹5,000'), { ok: true, value: 5000 });
  assert.deepEqual(parseAmount('Rs. 1,250.75'), { ok: true, value: 1250.75 });
  assert.deepEqual(parseAmount(0), { ok: true, value: 0 });
  assert.equal(parseAmount('-1').ok, false);
  assert.equal(parseAmount('abc').ok, false);
  assert.equal(parseAmount(null).reason, 'Amount missing');
  assert.deepEqual(parseDueDate('30-09-2026'), { ok: true, value: '2026-09-30' });
  assert.deepEqual(parseDueDate('3/9/2026'), { ok: true, value: '2026-09-03' });
  assert.deepEqual(parseDueDate('2026-09-30'), { ok: true, value: '2026-09-30' });
  assert.deepEqual(parseDueDate(new Date(Date.UTC(2026, 8, 30))), { ok: true, value: '2026-09-30' });
  assert.deepEqual(parseDueDate(null), { ok: true, value: null });
  assert.equal(parseDueDate('31-02-2026').ok, false);
  assert.equal(parseDueDate('tomorrow').ok, false);
});

test('duplicate detection rules', () => {
  const row = (n, values) => ({ rowNumber: n, values: { customer_name: 'X', amount_due: 1, ...values } });
  const { rows, summary } = validateRows([
    row(2, { phone: '9876543210', account_id: 'A1', installment_number: 1 }),
    row(3, { phone: '9876543210', account_id: 'A2', installment_number: 1 }), // same phone, other loan → warning
    row(4, { phone: '9876543211', account_id: 'A1', installment_number: 1 }), // same account+inst → duplicate
    row(5, { phone: '9876543211', account_id: 'A1', installment_number: 2 }), // next installment → valid
    row(6, { phone: '9876543212' }),
    row(7, { phone: '+91 98765 43212' }), // same phone no account → duplicate
  ]);
  assert.deepEqual(rows.map((r) => r.status), ['VALID', 'VALID', 'DUPLICATE', 'VALID', 'VALID', 'DUPLICATE']);
  assert.match(rows[1].warnings[0], /row\(s\) 2/);
  assert.match(rows[0].warnings[0], /row 3/);
  assert.equal(summary.duplicates, 2);
  assert.equal(rows[3].installment_number, '2');
});

test('Meta Cloud API error classification', () => {
  assert.equal(classifyMetaError({ code: 131026 }).kind, ERROR_KIND.NOT_ON_WHATSAPP);
  assert.equal(classifyMetaError({ code: 130429, httpStatus: 400 }).kind, ERROR_KIND.RATE_LIMITED);
  assert.equal(classifyMetaError({ code: 131056 }).kind, ERROR_KIND.RATE_LIMITED);
  assert.equal(classifyMetaError({ code: 131000, httpStatus: 500 }).kind, ERROR_KIND.TRANSIENT);
  assert.equal(classifyMetaError({ code: 132001 }).kind, ERROR_KIND.PERMANENT);
  assert.equal(classifyMetaError({ code: 131050 }).kind, ERROR_KIND.OPTED_OUT);
  assert.equal(classifyMetaError({ code: 100, message: 'Invalid parameter', details: 'Recipient phone number not valid' }).kind, ERROR_KIND.INVALID_NUMBER);
  assert.equal(classifyMetaError({ code: 100, message: 'Invalid parameter', details: 'template name' }).kind, ERROR_KIND.PERMANENT);
  assert.equal(classifyMetaError({ httpStatus: 503 }).kind, ERROR_KIND.TRANSIENT);
  assert.equal(classifyMetaError({ httpStatus: 429 }).kind, ERROR_KIND.RATE_LIMITED);
  // A generic 400 is NOT assumed to mean "not on WhatsApp".
  assert.equal(classifyMetaError({ httpStatus: 400, message: 'Bad request' }).kind, ERROR_KIND.PERMANENT);
});

function fakeFetch(status, body, { throwErr, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] } };
  };
  fn.calls = calls;
  return fn;
}

const metaCfg = {
  apiBaseUrl: 'https://graph.example.test',
  apiVersion: 'v21.0',
  phoneNumberId: '123',
  apiToken: 'tok',
  sendMode: 'template',
  templateName: 'payment_reminder',
  templateLanguage: 'en',
  templateParams: ['customer_name', 'amount_due', 'due_date', 'account_id'],
  requestTimeoutMs: 1000,
  webhookSecret: 'app-secret',
  webhookVerifyToken: 'vt',
};

test('Meta provider: builds an approved-template request and parses success', async () => {
  const f = fakeFetch(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: '919876543210' }], messages: [{ id: 'wamid.ABC' }] });
  const p = new MetaCloudProvider(metaCfg, { fetchImpl: f });
  const r = await p.sendMessage({ to: '919876543210', text: 'Hello', variables: { customer_name: 'Ravi', amount_due: '5,000', due_date: '', account_id: 'LN1' }, idempotencyKey: 'BULK-1:k' });
  assert.equal(r.providerMessageId, 'wamid.ABC');
  const { url, opts } = f.calls[0];
  assert.equal(url, 'https://graph.example.test/v21.0/123/messages');
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(opts.body);
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'payment_reminder');
  assert.equal(body.biz_opaque_callback_data, 'BULK-1:k');
  assert.deepEqual(body.template.components[0].parameters.map((x) => x.text), ['Ravi', '5,000', '-', 'LN1']);
});

test('Meta provider: maps error responses, timeouts and network errors', async () => {
  const p1 = new MetaCloudProvider(metaCfg, { fetchImpl: fakeFetch(400, { error: { code: 131026, message: 'Message undeliverable' } }) });
  await assert.rejects(p1.sendMessage({ to: '91', variables: {} }), (e) => e instanceof ProviderSendError && e.kind === ERROR_KIND.NOT_ON_WHATSAPP && e.code === '131026');
  const p2 = new MetaCloudProvider(metaCfg, { fetchImpl: fakeFetch(429, { error: { code: 130429 } }, { headers: { 'retry-after': '7' } }) });
  await assert.rejects(p2.sendMessage({ to: '91', variables: {} }), (e) => e.kind === ERROR_KIND.RATE_LIMITED && e.retryAfterMs === 7000);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const p3 = new MetaCloudProvider(metaCfg, { fetchImpl: fakeFetch(0, null, { throwErr: abort }) });
  await assert.rejects(p3.sendMessage({ to: '91', variables: {} }), (e) => e.kind === ERROR_KIND.TIMEOUT);
  const p4 = new MetaCloudProvider(metaCfg, { fetchImpl: fakeFetch(0, null, { throwErr: new TypeError('fetch failed') }) });
  await assert.rejects(p4.sendMessage({ to: '91', variables: {} }), (e) => e.kind === ERROR_KIND.TRANSIENT);
  const p5 = new MetaCloudProvider(metaCfg, { fetchImpl: fakeFetch(502, null) });
  await assert.rejects(p5.sendMessage({ to: '91', variables: {} }), (e) => e.kind === ERROR_KIND.TRANSIENT && e.code === 'HTTP_502');
});

test('Meta provider: webhook signature verification and parsing', () => {
  const p = new MetaCloudProvider(metaCfg);
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'failed', timestamp: '1759000000', biz_opaque_callback_data: 'K', errors: [{ code: 131026, title: 'Message undeliverable' }] }] } }] }] }));
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');
  assert.equal(p.verifyWebhookSignature(raw, { 'x-hub-signature-256': sig }), true);
  assert.equal(p.verifyWebhookSignature(Buffer.concat([raw, Buffer.from(' ')]), { 'x-hub-signature-256': sig }), false);
  assert.equal(p.verifyWebhookSignature(raw, {}), false);
  const { statuses } = p.parseWebhook(JSON.parse(raw));
  assert.equal(statuses[0].callbackData, 'K');
  assert.equal(statuses[0].error.kind, ERROR_KIND.NOT_ON_WHATSAPP);
  assert.equal(statuses[0].timestamp, new Date(1759000000 * 1000).toISOString());
  assert.equal(p.handleVerificationChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'c' }), 'c');
  assert.equal(p.handleVerificationChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'no', 'hub.challenge': 'c' }), null);
});

test('formula injection is neutralised in exports', () => {
  assert.equal(safeCell('=1+1'), "'=1+1");
  assert.equal(safeCell('+91'), "'+91");
  assert.equal(safeCell('-2'), "'-2");
  assert.equal(safeCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(safeCell('Ravi'), 'Ravi');
  assert.equal(safeCell(5000), 5000);
});

test('role permissions', () => {
  const emp = effectivePermissions('employee');
  assert.ok(emp.has(PERMISSIONS.ACCESS));
  assert.ok(!emp.has(PERMISSIONS.SEND));
  const empSend = effectivePermissions('employee', [{ permission: PERMISSIONS.SEND, granted: true }, { permission: PERMISSIONS.MANAGE_SETTINGS, granted: true }]);
  assert.ok(empSend.has(PERMISSIONS.SEND));
  assert.ok(!empSend.has(PERMISSIONS.MANAGE_SETTINGS), 'employees can never modify system-wide WhatsApp settings');
  const head = effectivePermissions('main_head');
  assert.ok(head.has(PERMISSIONS.RETRY) && head.has(PERMISSIONS.EXPORT) && !head.has(PERMISSIONS.MANAGE_SETTINGS));
  const revoked = effectivePermissions('admin', [{ permission: PERMISSIONS.ACCESS, granted: false }]);
  assert.ok(!revoked.has(PERMISSIONS.SEND), 'feature switch gates every bulk permission');
});
