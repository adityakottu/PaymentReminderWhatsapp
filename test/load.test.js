'use strict';

/**
 * Volume tests: 1,000 and 5,000 recipients with a ~2% failure mix.
 * Runs as part of `npm test` (1,000) – the 5,000 case runs with `npm run test:load`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, customers, uploadAndSend } = require('./helpers');
const { ERROR_KIND } = require('../src/whatsapp/provider');

function mixedScript(to, attempt) {
  const n = Number(to.slice(-4));
  if (n % 97 === 0) return ERROR_KIND.NOT_ON_WHATSAPP;
  if (n % 89 === 0) return ERROR_KIND.INVALID_NUMBER;
  if (n % 53 === 0 && attempt === 1) return ERROR_KIND.TRANSIENT;
  return 'success';
}

async function run(n) {
  const env = await setup({ script: mixedScript, queue: { concurrency: 25 } });
  try {
    const api = await login(env.base, 'admin');
    const rows = customers(n, { phoneFor: (i) => String(9000000000 + i) });
    const t0 = Date.now();
    const { id } = await uploadAndSend(api, rows);
    const t1 = Date.now();
    await env.worker.drain({ timeoutMs: 300000 });
    const t2 = Date.now();

    const batch = await env.db('bulk_upload_batches').where({ id }).first();
    const expectedNotOnWa = rows.filter((_, i) => (i + 1) % 97 === 0).length;
    const expectedInvalid = rows.filter((_, i) => (i + 1) % 97 !== 0 && (i + 1) % 89 === 0).length;
    assert.equal(batch.pending_records, 0);
    assert.equal(batch.failed_records, expectedNotOnWa + expectedInvalid);
    assert.equal(batch.successful_records, n - expectedNotOnWa - expectedInvalid);
    assert.equal(batch.status, 'COMPLETED_WITH_FAILURES');
    // Exactly one accepted send per successful recipient (no duplicates).
    assert.equal(env.mock.sent.length, batch.successful_records);
    assert.equal(new Set(env.mock.sent.map((s) => s.to)).size, env.mock.sent.length);
    console.info(`[load] ${n} recipients: upload+import+queue ${t1 - t0}ms, processing ${t2 - t1}ms`);
  } finally {
    await env.close();
  }
}

test('1,000 recipients complete with isolated failures', { timeout: 300000 }, () => run(1000));

test('5,000 recipients complete with isolated failures', { timeout: 600000, skip: !process.env.LOAD_TEST && 'set LOAD_TEST=1 (npm run test:load)' }, () => run(5000));
