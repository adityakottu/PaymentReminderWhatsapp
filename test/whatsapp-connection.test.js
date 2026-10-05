'use strict';

/**
 * WhatsApp must never look "sent" when it is not connected:
 *  - not configured  → sending is blocked, nothing is marked sent
 *  - test mode       → works, but every batch/export is labelled simulated
 *  - live (Meta)     → real Cloud API requests are made
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, makeXlsx, customers, uploadAndSend, records } = require('./helpers');
const { connectionStatus } = require('../src/whatsapp/status');
const { NotConfiguredProvider } = require('../src/whatsapp');
const { MetaCloudProvider } = require('../src/whatsapp/metaCloudProvider');
const { MessageWorker } = require('../src/queue/worker');

const META = {
  provider: 'meta_cloud',
  apiToken: 'EAAG-test-token',
  phoneNumberId: '1098765',
  businessAccountId: '2003004',
  apiBaseUrl: 'https://graph.example.test',
  apiVersion: 'v21.0',
  webhookSecret: 'app-secret',
  webhookVerifyToken: 'vt',
  sendMode: 'template',
  templateName: 'payment_reminder',
  templateLanguage: 'en',
  templateNameTe: 'payment_reminder',
  templateLanguageTe: 'te',
  templateNameBoth: 'payment_reminder_bilingual',
  templateLanguageBoth: 'en',
  templateParams: ['customer_name', 'amount_due', 'due_date', 'account_id'],
  requestTimeoutMs: 2000,
};

/** Fake Graph API: accepts messages, reports the phone number and templates. */
function fakeGraph({ templates = [{ name: 'payment_reminder', language: 'en', status: 'APPROVED', category: 'UTILITY' }] } = {}) {
  const calls = [];
  let n = 0;
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
    if (opts.headers && opts.headers.Authorization !== `Bearer ${META.apiToken}`) return json(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
    if (url.endsWith('/messages')) return json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.REAL${++n}` }] });
    if (url.includes('/message_templates')) return json(200, { data: templates });
    if (url.includes(`/${META.phoneNumberId}?`)) return json(200, { display_phone_number: '+91 90000 00000', verified_name: 'Lending Desk', quality_rating: 'GREEN' });
    return json(404, { error: { code: 100, message: 'Unknown path' } });
  };
  fn.calls = calls;
  return fn;
}

test('connection status: test / not configured / live', () => {
  assert.equal(connectionStatus({}, 'mock').mode, 'test');
  assert.equal(connectionStatus({}, 'none').mode, 'not_configured');
  const missing = connectionStatus({ ...META, apiToken: null, phoneNumberId: null }, 'meta_cloud');
  assert.equal(missing.mode, 'not_configured');
  assert.deepEqual(missing.missing, ['WHATSAPP_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
  assert.equal(missing.canSend, false);
  const live = connectionStatus(META, 'meta_cloud');
  assert.equal(live.mode, 'live');
  assert.equal(live.canSend, true);
  assert.deepEqual(connectionStatus({ ...META, webhookSecret: null }, 'meta_cloud').warnings.length, 1);
});

test('default (no WHATSAPP_PROVIDER) is NOT connected – sending is blocked, nothing marked sent', async () => {
  const env = await setup({ provider: new NotConfiguredProvider(), whatsapp: { provider: 'none' } });
  try {
    const api = await login(env.base, 'admin');
    const cfg = await api.get('/api/bulk-reminders/config');
    assert.equal(cfg.data.whatsapp.mode, 'not_configured');
    const up = await api.upload('/api/bulk-reminders/uploads', await makeXlsx(customers(2, { phoneFor: (i) => `987654321${i}` })));
    const id = up.data.batch.id;
    await api.post(`/api/bulk-reminders/batches/${id}/import`);
    const ready = await api.get(`/api/bulk-reminders/batches/${id}/send-readiness`);
    assert.equal(ready.data.whatsapp.canSend, false);
    const send = await api.post(`/api/bulk-reminders/batches/${id}/send`, { confirm: true });
    assert.equal(send.status, 409);
    assert.match(send.data.error, /WhatsApp is not connected/);
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['PENDING', 'PENDING'], 'nothing is marked as sent');
    assert.equal((await env.db('bulk_upload_batches').where({ id }).first()).status, 'READY');
  } finally {
    await env.close();
  }
});

test('test mode: batch, history and export are labelled simulated', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const api = await login(env.base, 'admin');
    assert.equal((await api.get('/api/bulk-reminders/config')).data.whatsapp.mode, 'test');
    const { id } = await uploadAndSend(api, customers(1, { phoneFor: () => '9876543211' }));
    await env.worker.drain();
    const b = (await api.get(`/api/bulk-reminders/batches/${id}`)).data.batch;
    assert.equal(b.simulated, true);
    assert.equal(b.whatsappProvider, 'mock');
    assert.equal((await api.get('/api/bulk-reminders/batches')).data.batches[0].simulated, true);
  } finally {
    await env.close();
  }
});

test('live: messages go to the WhatsApp Cloud API with the approved template', async () => {
  const graph = fakeGraph();
  const provider = new MetaCloudProvider(META, { fetchImpl: graph });
  const env = await setup({ provider, whatsapp: META });
  try {
    const api = await login(env.base, 'admin');
    assert.equal((await api.get('/api/bulk-reminders/config')).data.whatsapp.mode, 'live');
    const { id } = await uploadAndSend(api, customers(2, { phoneFor: (i) => `987654321${i}` }));
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['SENT', 'SENT']);
    assert.deepEqual(recs.map((r) => r.provider_message_id).sort(), ['wamid.REAL1', 'wamid.REAL2']);
    const sends = graph.calls.filter((c) => c.url.endsWith('/messages'));
    assert.equal(sends.length, 2);
    assert.equal(sends[0].url, 'https://graph.example.test/v21.0/1098765/messages');
    const body = JSON.parse(sends[0].opts.body);
    assert.equal(body.to, '919876543211');
    assert.equal(body.template.name, 'payment_reminder');
    assert.equal(body.template.components[0].parameters[0].text, 'Customer 1');
    const b = (await api.get(`/api/bulk-reminders/batches/${id}`)).data.batch;
    assert.equal(b.simulated, false);
    assert.equal(b.whatsappProvider, 'meta_cloud');
  } finally {
    await env.close();
  }
});

test('a test-mode batch is never sent for real after WhatsApp is connected', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(2, { phoneFor: (i) => `987654321${i}` }));
    // The server is now restarted with real WhatsApp: its worker must not pick up the test batch.
    const graph = fakeGraph();
    const live = new MessageWorker({ db: env.db, provider: new MetaCloudProvider(META, { fetchImpl: graph }), service: env.service, config: env.config, audit: env.audit, logger: { info() {}, error() {}, warn() {} } });
    assert.equal((await live.claim(10)).length, 0);
    assert.equal(graph.calls.length, 0);
    assert.deepEqual((await records(env.db, id)).map((r) => r.status), ['QUEUED', 'QUEUED']);
  } finally {
    await env.close();
  }
});

test('admin WhatsApp page: status without secrets, connection check, test message', async () => {
  const graph = fakeGraph({ templates: [{ name: 'payment_reminder', language: 'en', status: 'APPROVED', category: 'UTILITY' }, { name: 'payment_reminder', language: 'te', status: 'PENDING', category: 'UTILITY' }] });
  const provider = new MetaCloudProvider(META, { fetchImpl: graph });
  const env = await setup({ provider, whatsapp: META });
  try {
    const admin = await login(env.base, 'admin');
    const st = await admin.get('/api/bulk-reminders/whatsapp');
    assert.equal(st.status, 200);
    assert.equal(st.data.status.mode, 'live');
    assert.equal(st.data.settings.accessTokenSet, true);
    assert.ok(!JSON.stringify(st.data).includes(META.apiToken), 'access token never returned');
    assert.ok(!JSON.stringify(st.data).includes(META.webhookSecret), 'app secret never returned');
    assert.match(st.data.webhook.callbackUrl, /\/webhooks\/whatsapp$/);

    const check = await admin.post('/api/bulk-reminders/whatsapp/check');
    assert.equal(check.data.ok, true, 'required checks pass');
    const byLabel = Object.fromEntries(check.data.checks.map((c) => [c.key, c]));
    assert.equal(byLabel.phone_number.ok, true);
    assert.match(byLabel.phone_number.detail, /Lending Desk/);
    assert.equal(byLabel.template_English.ok, true);
    assert.equal(byLabel.template_Telugu.ok, false);
    assert.match(byLabel.template_Telugu.detail, /PENDING/);
    assert.equal(byLabel['template_English + Telugu'].ok, false);
    assert.equal(byLabel['template_English + Telugu'].required, false);

    const tm = await admin.post('/api/bulk-reminders/whatsapp/test-message', { phoneNumber: '9876543210', language: 'en' });
    assert.equal(tm.data.ok, true);
    assert.equal(tm.data.simulated, false);
    assert.equal(tm.data.to, '919876543210');
    const audit = await env.db('audit_logs').where({ action: 'whatsapp.test_message' }).first();
    assert.match(audit.description, /test WhatsApp message to 919876543210: accepted/);

    const head = await login(env.base, 'head');
    assert.equal((await head.get('/api/bulk-reminders/whatsapp')).status, 403);
    assert.equal((await head.post('/api/bulk-reminders/whatsapp/test-message', { phoneNumber: '9876543210' })).status, 403);
  } finally {
    await env.close();
  }
});

test('connection check reports a bad access token', async () => {
  const provider = new MetaCloudProvider({ ...META, apiToken: 'wrong' }, { fetchImpl: fakeGraph() });
  const env = await setup({ provider, whatsapp: { ...META, apiToken: 'wrong' } });
  try {
    const admin = await login(env.base, 'admin');
    const check = await admin.post('/api/bulk-reminders/whatsapp/check');
    assert.equal(check.data.ok, false);
    assert.match(check.data.checks[0].detail, /Access token expired or invalid/);
  } finally {
    await env.close();
  }
});
