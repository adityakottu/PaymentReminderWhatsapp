'use strict';

/**
 * ACCEPTANCE TEST (spec §30)
 *
 *   Customer 1 → Success            Customer 6  → Success
 *   Customer 2 → Success            Customer 7  → Invalid number
 *   Customer 3 → Not on WhatsApp    Customer 8  → Success
 *   Customer 4 → Success            Customer 9  → Success
 *   Customer 5 → Temporary failure  Customer 10 → Success
 *
 * Customer 3 and 7 must never stop the batch; the batch must complete.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, customers, uploadAndSend, records } = require('./helpers');
const { ERROR_KIND } = require('../src/whatsapp/provider');

const phone = (i) => `98765432${String(i).padStart(2, '0')}`; // 10-digit Indian mobiles
const PLAN = { 3: ERROR_KIND.NOT_ON_WHATSAPP, 5: ERROR_KIND.TRANSIENT, 7: ERROR_KIND.INVALID_NUMBER };

function scriptFor(plan, { recoverOnAttempt } = {}) {
  return (to, attempt) => {
    const i = Number(to.slice(-2));
    const kind = plan[i];
    if (!kind) return 'success';
    if (recoverOnAttempt && kind === ERROR_KIND.TRANSIENT && attempt >= recoverOnAttempt) return 'success';
    return kind;
  };
}

test('10 customers: failures are isolated and the batch completes', async () => {
  const env = await setup({ script: scriptFor(PLAN) });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(10, { phoneFor: phone }));

    // First pass: every job is attempted once. Customer 5 is scheduled for retry.
    await env.worker.tick();
    await Promise.all([...env.worker.inFlight]);
    await env.worker.tick();
    await Promise.all([...env.worker.inFlight]);
    let recs = await records(env.db, id);
    const first = Object.fromEntries(recs.map((r) => [r.row_number - 1, r.status]));
    assert.equal(first[5], 'RETRY_SCHEDULED', 'customer 5 should be scheduled for retry after a temporary failure');
    assert.equal(first[3], 'NOT_ON_WHATSAPP');
    assert.equal(first[7], 'INVALID_NUMBER');
    // Customers after the failing ones were still processed (no stop at #3 or #7).
    for (const i of [4, 6, 8, 9, 10]) assert.equal(first[i], 'SENT', `customer ${i} must still be sent`);

    // Run to completion.
    await env.worker.drain();
    recs = await records(env.db, id);
    const final = Object.fromEntries(recs.map((r) => [r.row_number - 1, r]));
    for (const i of [1, 2, 4, 6, 8, 9, 10]) {
      assert.equal(final[i].status, 'SENT', `customer ${i}`);
      assert.equal(final[i].attempt_count, 1);
      assert.ok(final[i].provider_message_id);
    }
    assert.equal(final[3].status, 'NOT_ON_WHATSAPP');
    assert.equal(final[3].retry_eligible ? 1 : 0, 0);
    assert.equal(final[3].attempt_count, 1, 'permanent failures are never retried');
    assert.equal(final[7].status, 'INVALID_NUMBER');
    assert.equal(final[7].attempt_count, 1);
    assert.equal(final[5].status, 'FAILED', 'temporary failure exhausts MAX_RETRIES and becomes final failed');
    assert.equal(final[5].attempt_count, 3);
    assert.match(final[5].failure_reason, /Failed after 3 attempts/);

    const { data } = await api.get(`/api/bulk-reminders/batches/${id}`);
    assert.equal(data.batch.status, 'COMPLETED_WITH_FAILURES');
    assert.equal(data.batch.successful, 7);
    assert.equal(data.batch.failed, 3);
    assert.equal(data.batch.pending, 0);
    assert.equal(data.batch.progressPct, 100);
    assert.equal(data.batch.successRatePct, 70);

    // Provider was called exactly once for 3 and 7, three times for 5.
    const calls = (i) => env.mock.calls.filter((c) => c.to === `91${phone(i)}`).length;
    assert.equal(calls(3), 1);
    assert.equal(calls(7), 1);
    assert.equal(calls(5), 3);

    // Audit trail contains per-message outcomes and completion.
    const actions = (await env.db('audit_logs').where({ batch_id: id }).select('action')).map((a) => a.action);
    for (const a of ['bulk.uploaded', 'bulk.validated', 'bulk.imported', 'bulk.send_started', 'message.sent', 'message.failed', 'message.retry_scheduled', 'bulk.completed']) {
      assert.ok(actions.includes(a), `audit should include ${a}`);
    }
  } finally {
    await env.close();
  }
});

test('10 customers: temporary failure recovers on retry → batch completes', async () => {
  const env = await setup({ script: scriptFor(PLAN, { recoverOnAttempt: 2 }) });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(10, { phoneFor: phone }));
    await env.worker.drain();
    const recs = await records(env.db, id);
    const expected = ['SENT', 'SENT', 'NOT_ON_WHATSAPP', 'SENT', 'SENT', 'SENT', 'INVALID_NUMBER', 'SENT', 'SENT', 'SENT'];
    assert.deepEqual(recs.map((r) => r.status), expected);
    assert.equal(recs[4].attempt_count, 2);
    const batch = await env.db('bulk_upload_batches').where({ id }).first();
    assert.equal(batch.status, 'COMPLETED_WITH_FAILURES');
    assert.equal(batch.successful_records, 8);
    assert.equal(batch.failed_records, 2);
  } finally {
    await env.close();
  }
});

test('a crashing job (unexpected exception) never stops other jobs', async () => {
  const env = await setup({
    script: (to) => {
      if (to.endsWith('02')) throw new Error('boom – provider adapter bug');
      return 'success';
    },
  });
  try {
    const api = await login(env.base, 'admin');
    const { id } = await uploadAndSend(api, customers(5, { phoneFor: phone }));
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((r) => r.status), ['SENT', 'FAILED', 'SENT', 'SENT', 'SENT']);
    assert.match(recs[1].failure_reason, /boom/);
  } finally {
    await env.close();
  }
});
