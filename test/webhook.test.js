'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, customers, uploadAndSend, records } = require('./helpers');
const { MockProvider } = require('../src/whatsapp/mockProvider');

function metaStatusPayload(statuses) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses } }] }],
  };
}

async function postWebhook(env, payload, { sign = true, signature } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['X-Hub-Signature-256'] = signature || env.mock.sign(raw);
  const res = await fetch(`${env.base}/webhooks/whatsapp`, { method: 'POST', headers, body: raw });
  return res.status;
}

test('webhook: verification challenge', async () => {
  const env = await setup();
  try {
    let res = await fetch(`${env.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '12345');
    res = await fetch(`${env.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
    assert.equal(res.status, 403);
  } finally {
    await env.close();
  }
});

test('webhook: rejects unsigned and wrongly signed requests', async () => {
  const env = await setup();
  try {
    const payload = metaStatusPayload([{ id: 'wamid.x', status: 'delivered', timestamp: '1759000000' }]);
    assert.equal(await postWebhook(env, payload, { sign: false }), 401);
    assert.equal(await postWebhook(env, payload, { signature: 'sha256=' + '0'.repeat(64) }), 401);
    const rejected = await env.db('audit_logs').where({ action: 'webhook.rejected' });
    assert.equal(rejected.length, 2);
  } finally {
    await env.close();
  }
});

test('webhook: delivered/read updates, duplicates and out-of-order events are idempotent', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(2, { phoneFor: (i) => `987654321${i}` }));
    await env.worker.drain();
    const [a, b] = await records(env.db, id);
    assert.equal(a.status, 'SENT');

    // read arrives BEFORE delivered (out of order), then delivered is redelivered twice.
    assert.equal(await postWebhook(env, metaStatusPayload([{ id: a.provider_message_id, status: 'read', timestamp: '1759000100', recipient_id: a.phone_number }])), 200);
    assert.equal(await postWebhook(env, metaStatusPayload([{ id: a.provider_message_id, status: 'delivered', timestamp: '1759000050' }])), 200);
    assert.equal(await postWebhook(env, metaStatusPayload([{ id: a.provider_message_id, status: 'delivered', timestamp: '1759000050' }])), 200);
    let rec = await env.db('bulk_reminder_records').where({ id: a.id }).first();
    assert.equal(rec.status, 'READ', 'read is never downgraded to delivered');
    assert.ok(rec.read_at);
    assert.ok(rec.delivered_at);

    // Asynchronous failure reported for b (e.g. 131026 undeliverable) → NOT_ON_WHATSAPP.
    await postWebhook(env, metaStatusPayload([{ id: b.provider_message_id, status: 'failed', timestamp: '1759000200', errors: [{ code: 131026, title: 'Message undeliverable' }] }]));
    rec = await env.db('bulk_reminder_records').where({ id: b.id }).first();
    assert.equal(rec.status, 'NOT_ON_WHATSAPP');
    assert.equal(rec.provider_error_code, '131026');
    assert.equal(rec.retry_eligible ? 1 : 0, 0);

    const batch = await env.db('bulk_upload_batches').where({ id }).first();
    assert.equal(batch.successful_records, 1);
    assert.equal(batch.failed_records, 1);

    const dupes = await env.db('webhook_events').where({ provider_message_id: a.provider_message_id });
    assert.equal(dupes.length, 2, 'duplicate delivered event stored once');
  } finally {
    await env.close();
  }
});

test('webhook arriving before the worker stored the message id is replayed', async () => {
  // A provider without callback-data support whose HTTP response is slower than its webhook.
  let release;
  const gate = new Promise((r) => (release = r));
  const provider = new MockProvider({ webhookSecret: 'whsec_test', verifyToken: 'verify-me' });
  provider.sendMessage = async (msg) => {
    provider.calls.push(msg);
    await gate;
    return { providerMessageId: 'wamid.KNOWN' };
  };
  const env = await setup({ provider });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(1, { phoneFor: () => '9876543211' }));
    const drain = env.worker.drain();
    while (provider.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    const early = await env.service.applyStatusEvent({ providerMessageId: 'wamid.KNOWN', status: 'delivered', timestamp: new Date().toISOString(), callbackData: null }, 'mock');
    assert.equal(early.outcome, 'UNMATCHED');

    release();
    await drain;
    const [rec] = await records(env.db, id);
    assert.equal(rec.provider_message_id, 'wamid.KNOWN');
    assert.equal(rec.status, 'DELIVERED', 'early webhook applied once the message id was stored');
    const batch = await env.db('bulk_upload_batches').where({ id }).first();
    assert.equal(batch.status, 'COMPLETED');
  } finally {
    await env.close();
  }
});

test('STOP reply opts the customer out; later sends to that number are skipped', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ from: '919876543211', type: 'text', text: { body: 'STOP' } }] } }] }],
    };
    assert.equal(await postWebhook(env, payload), 200);
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(2, { phoneFor: (i) => `987654321${i}` }));
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.equal(recs[0].status, 'CANCELLED');
    assert.match(recs[0].failure_reason, /opted out/);
    assert.equal(recs[1].status, 'SENT');
    assert.equal(env.mock.calls.length, 1);
  } finally {
    await env.close();
  }
});
