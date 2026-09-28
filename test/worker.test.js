'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, customers, uploadAndSend, records } = require('./helpers');
const { MessageWorker } = require('../src/queue/worker');
const { ERROR_KIND } = require('../src/whatsapp/provider');

function secondWorker(env, id = 'worker-2') {
  return new MessageWorker({ db: env.db, provider: env.mock, service: env.service, config: env.config, audit: env.audit, logger: { info() {}, error() {}, warn() {} }, workerId: id });
}

test('API timeout is retried and then succeeds', async () => {
  const env = await setup({ script: (to, attempt) => (to.endsWith('7') && attempt === 1 ? ERROR_KIND.TIMEOUT : 'success') });
  try {
    const api = await login(env.base, 'admin');
    const rows = customers(3, { phoneFor: (i) => `987654321${i === 2 ? 7 : i}` });
    const { id } = await uploadAndSend(api, rows);
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['SENT', 'SENT', 'SENT']);
    assert.equal(recs[1].attempt_count, 2);
    const logs = await env.db('whatsapp_message_logs').where({ record_id: recs[1].id }).orderBy('id');
    assert.deepEqual(logs.map((l) => [l.request_status, l.error_kind]), [['FAILED', 'TIMEOUT'], ['ACCEPTED', null]]);
  } finally {
    await env.close();
  }
});

test('rate limit → RETRY_SCHEDULED, exhausted → RATE_LIMITED; other jobs unaffected', async () => {
  const env = await setup({ script: (to) => (to.endsWith('2') ? { kind: ERROR_KIND.RATE_LIMITED, retryAfterMs: 1 } : 'success') });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(3, { phoneFor: (i) => `987654321${i}` }));
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['SENT', 'RATE_LIMITED', 'SENT']);
    assert.equal(recs[1].attempt_count, 3);
  } finally {
    await env.close();
  }
});

test('worker crash BEFORE provider call → job is requeued and sent exactly once', async () => {
  const env = await setup({ script: () => 'success', queue: { leaseMs: 50 } });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(3, { phoneFor: (i) => `987654321${i}` }));
    // Simulate a worker that claimed jobs and then died (no attempt log written).
    const dead = secondWorker(env, 'dead-worker');
    const claimed = await dead.claim(2);
    assert.equal(claimed.length, 2);
    await new Promise((r) => setTimeout(r, 80)); // lease expires

    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['SENT', 'SENT', 'SENT']);
    for (const r of recs) assert.equal(env.mock.calls.filter((c) => c.to === r.phone_number).length, 1, 'sent exactly once');
    const actions = (await env.db('audit_logs').where({ action: 'message.requeued' })).length;
    assert.equal(actions, 2);
  } finally {
    await env.close();
  }
});

test('worker crash AFTER provider call (before DB update) → NOT resent; reconciled by webhook', async () => {
  const env = await setup({ script: () => 'success', queue: { leaseMs: 50, reconcileWindowMs: 60000 } });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(2, { phoneFor: (i) => `987654321${i}` }));
    const dead = secondWorker(env, 'dead-worker');
    const [job] = await dead.claim(1);
    // Replay what processJob does up to the provider call, then "crash".
    await env.db('whatsapp_message_logs').insert({ record_id: job.id, attempt_number: 1, provider: 'mock', request_status: 'IN_FLIGHT', request_started_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await env.db('bulk_reminder_records').where({ id: job.id }).update({ attempt_count: 1, round_attempts: 1 });
    const accepted = await env.mock.sendMessage({ to: job.phone_number, text: job.message, idempotencyKey: job.idempotency_key });
    await new Promise((r) => setTimeout(r, 80)); // lease expires

    await env.worker.drain();
    let rec = await env.db('bulk_reminder_records').where({ id: job.id }).first();
    assert.equal(rec.status, 'PROCESSING', 'held for reconciliation, not resent');
    assert.ok(rec.reconcile_until);
    assert.equal(env.mock.calls.filter((c) => c.to === job.phone_number).length, 1, 'no duplicate send after crash');
    let batch = await env.db('bulk_upload_batches').where({ id }).first();
    assert.equal(batch.status, 'PROCESSING', 'batch waits for the unknown outcome');

    // Provider webhook arrives carrying the idempotency key → reconciled.
    await env.service.applyStatusEvent({ providerMessageId: accepted.providerMessageId, status: 'delivered', timestamp: new Date().toISOString(), callbackData: job.idempotency_key }, 'mock');
    rec = await env.db('bulk_reminder_records').where({ id: job.id }).first();
    assert.equal(rec.status, 'DELIVERED');
    assert.equal(rec.provider_message_id, accepted.providerMessageId);
    batch = await env.db('bulk_upload_batches').where({ id }).first();
    assert.equal(batch.status, 'COMPLETED');
  } finally {
    await env.close();
  }
});

test('unknown outcome with no webhook → FAILED after reconcile window (manual retry allowed)', async () => {
  const env = await setup({ script: () => 'success', queue: { leaseMs: 30, reconcileWindowMs: 30 } });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(1, { phoneFor: () => '9876543211' }));
    const dead = secondWorker(env, 'dead');
    const [job] = await dead.claim(1);
    await env.db('whatsapp_message_logs').insert({ record_id: job.id, attempt_number: 1, provider: 'mock', request_status: 'IN_FLIGHT', created_at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 50));
    await env.worker.recoverStaleJobs(); // → reconciling
    await new Promise((r) => setTimeout(r, 50));
    await env.worker.recoverStaleJobs(); // → window expired
    await env.service.refreshCounters(id);
    const rec = await env.db('bulk_reminder_records').where({ id: job.id }).first();
    assert.equal(rec.status, 'FAILED');
    assert.match(rec.failure_reason, /Outcome unknown/);
    assert.equal(env.mock.calls.length, 0);
    const batch = await env.db('bulk_upload_batches').where({ id }).first();
    assert.equal(batch.status, 'COMPLETED_WITH_FAILURES');
  } finally {
    await env.close();
  }
});

test('pause stops new sends; resume continues; nothing is lost', async () => {
  const env = await setup({ script: () => 'success', queue: { concurrency: 2 } });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(8, { phoneFor: (i) => `98765432${String(i).padStart(2, '0')}` }));
    await env.worker.tick();
    await Promise.all([...env.worker.inFlight]);
    assert.equal((await api.post(`/api/bulk-reminders/batches/${id}/pause`)).status, 200);
    await env.worker.drain();
    let recs = await records(env.db, id);
    assert.equal(recs.filter((r) => r.status === 'SENT').length, 2);
    assert.equal(recs.filter((r) => r.status === 'QUEUED').length, 6);
    assert.equal((await env.db('bulk_upload_batches').where({ id }).first()).status, 'PAUSED');

    assert.equal((await api.post(`/api/bulk-reminders/batches/${id}/resume`)).status, 200);
    await env.worker.drain();
    recs = await records(env.db, id);
    assert.equal(recs.filter((r) => r.status === 'SENT').length, 8);
    assert.equal((await env.db('bulk_upload_batches').where({ id }).first()).status, 'COMPLETED');
    assert.equal(env.mock.calls.length, 8);
  } finally {
    await env.close();
  }
});

test('cancel remaining: sent stay sent, pending become CANCELLED, history kept', async () => {
  const env = await setup({ script: () => 'success', queue: { concurrency: 3 } });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(10, { phoneFor: (i) => `98765432${String(i).padStart(2, '0')}` }));
    await env.worker.tick();
    await Promise.all([...env.worker.inFlight]);
    const res = await api.post(`/api/bulk-reminders/batches/${id}/cancel`);
    assert.equal(res.status, 200);
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.equal(recs.length, 10, 'records are never deleted');
    assert.equal(recs.filter((r) => r.status === 'SENT').length, 3);
    assert.equal(recs.filter((r) => r.status === 'CANCELLED').length, 7);
    const batch = await env.db('bulk_upload_batches').where({ id }).first();
    assert.equal(batch.status, 'CANCELLED');
    assert.equal(batch.cancelled_records, 7);
    assert.equal(env.mock.calls.length, 3);
  } finally {
    await env.close();
  }
});

test('job claimed before cancel is not sent when the batch is cancelled', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(2, { phoneFor: (i) => `987654321${i}` }));
    const jobs = await env.worker.claim(2);
    await api.post(`/api/bulk-reminders/batches/${id}/cancel`);
    for (const j of jobs) await env.worker.processJob(j);
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['CANCELLED', 'CANCELLED']);
    assert.equal(env.mock.calls.length, 0);
  } finally {
    await env.close();
  }
});

test('Retry Failed re-queues only eligible failures (never invalid / not-on-WhatsApp)', async () => {
  let providerHealthy = false;
  const env = await setup({
    script: (to) => {
      if (to.endsWith('1')) return ERROR_KIND.INVALID_NUMBER;
      if (to.endsWith('2')) return ERROR_KIND.NOT_ON_WHATSAPP;
      if (to.endsWith('3')) return providerHealthy ? 'success' : ERROR_KIND.TRANSIENT;
      if (to.endsWith('4')) return providerHealthy ? 'success' : ERROR_KIND.PERMANENT;
      return 'success';
    },
  });
  try {
    const api = await login(env.base, 'head');
    const { id } = await uploadAndSend(api, customers(5, { phoneFor: (i) => `987654321${i}` }));
    await env.worker.drain();
    let recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['INVALID_NUMBER', 'NOT_ON_WHATSAPP', 'FAILED', 'PROVIDER_ERROR', 'SENT']);

    providerHealthy = true;
    const res = await api.post(`/api/bulk-reminders/batches/${id}/retry-failed`, {});
    assert.equal(res.status, 200);
    assert.equal(res.data.retried, 2);
    assert.equal(res.data.batch.status, 'PROCESSING');
    await env.worker.drain();
    recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['INVALID_NUMBER', 'NOT_ON_WHATSAPP', 'SENT', 'SENT', 'SENT']);
    assert.equal(env.mock.calls.filter((c) => c.to.endsWith('1')).length, 1, 'invalid number never resent');
    const audit = await env.db('audit_logs').where({ action: 'bulk.retry_failed' }).first();
    assert.match(audit.description, /retried 2 failed messages/);
    assert.equal(audit.user_role, 'main_head');
  } finally {
    await env.close();
  }
});

test('processing continues with no browser attached (server-side only)', async () => {
  const env = await setup({ script: () => 'success', latencyMs: 2 });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(20, { phoneFor: (i) => `98765432${String(i).padStart(2, '0')}` }));
    // "Browser closes": log out; the running worker must continue by itself.
    await api.post('/api/auth/logout');
    env.worker.start();
    const deadline = Date.now() + 10000;
    let batch;
    do {
      await new Promise((r) => setTimeout(r, 20));
      batch = await env.db('bulk_upload_batches').where({ id }).first();
    } while (batch.status === 'PROCESSING' && Date.now() < deadline);
    assert.equal(batch.status, 'COMPLETED');
    assert.equal(batch.successful_records, 20);
  } finally {
    await env.close();
  }
});
