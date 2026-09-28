'use strict';

const crypto = require('crypto');
const os = require('os');
const { nowIso } = require('../db');
const { RateLimiter } = require('./rateLimiter');
const { RECORD_STATUS: R, BATCH_STATUS: B, CLAIMABLE_STATUSES, SUCCESS_STATUSES } = require('../bulk/statuses');
const { ERROR_KIND, ProviderSendError } = require('../whatsapp/provider');
const { failureStatusFor } = require('../bulk/service');
const { variablesForRecord } = require('../bulk/template');

/**
 * Durable, database-backed message worker.
 *
 * ONE CUSTOMER = ONE INDEPENDENT MESSAGE JOB
 *   - Each bulk_reminder_records row is claimed individually with a lease.
 *   - Each job runs inside its own try/catch; whatever happens to one job
 *     (provider error, timeout, bug, DB hiccup) is recorded on that job only.
 *   - The loop never stops because of a job failure; it simply claims the next job.
 *
 * Crash safety / idempotency
 *   - Before calling the provider an IN_FLIGHT attempt log is committed.
 *   - If a worker dies and the lease expires:
 *       * no IN_FLIGHT log  -> the provider was never called -> safe to re-queue.
 *       * IN_FLIGHT log     -> outcome unknown -> do NOT resend; wait for the
 *         provider webhook (matched by idempotency key) for RECONCILE_WINDOW_MS,
 *         then mark FAILED ("outcome unknown") so a human decides whether to retry.
 */
class MessageWorker {
  constructor({ db, provider, service, config, audit, logger = console, clock = () => Date.now(), workerId }) {
    this.db = db;
    this.provider = provider;
    this.service = service;
    this.q = config.queue;
    this.reminders = config.reminders;
    this.audit = audit;
    this.logger = logger;
    this.clock = clock;
    this.workerId = workerId || `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
    this.limiter = new RateLimiter(this.q.sendRatePerSecond);
    this.inFlight = new Set();
    this.running = false;
    this.loopPromise = null;
    this.lastRecovery = 0;
    this.dirtyBatches = new Set();
    this.lastCounterFlush = 0;
  }

  now() {
    return nowIso(this.clock);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info(`[worker] ${this.workerId} started (concurrency=${this.q.concurrency}, rate=${this.q.sendRatePerSecond}/s)`);
    this.loopPromise = this._loop();
  }

  async stop() {
    this.running = false;
    if (this.loopPromise) await this.loopPromise;
    await Promise.allSettled([...this.inFlight]);
    await this._flushCounters(true);
  }

  async _loop() {
    while (this.running) {
      try {
        const claimed = await this.tick();
        if (!claimed) await sleep(this.q.pollIntervalMs);
      } catch (err) {
        // The loop itself must never die.
        this.logger.error('[worker] loop error', err);
        await sleep(this.q.pollIntervalMs);
      }
    }
  }

  /**
   * One scheduling round: recover stale leases, claim up to the free
   * concurrency and start those jobs. Returns number of jobs started.
   */
  async tick() {
    if (this.clock() - this.lastRecovery > Math.min(this.q.leaseMs, 30000)) {
      this.lastRecovery = this.clock();
      await this.recoverStaleJobs();
    }
    await this._flushCounters(false);
    const free = this.q.concurrency - this.inFlight.size;
    if (free <= 0) {
      await Promise.race([...this.inFlight]);
      return 1;
    }
    const jobs = await this.claim(free);
    for (const job of jobs) {
      const p = this.processJob(job)
        .catch((err) => this.logger.error(`[worker] job ${job.id} crashed unexpectedly`, err))
        .finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return jobs.length;
  }

  /** Test/ops helper: process until nothing is claimable and nothing is in flight. */
  async drain({ timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error('drain timed out');
      this.lastRecovery = 0; // always run recovery while draining
      const started = await this.tick();
      if (!started && this.inFlight.size === 0) {
        const due = await this._hasWaitingJobs();
        if (!due) break;
        await sleep(10);
      }
      if (!started && this.inFlight.size) await Promise.race([...this.inFlight]);
    }
    await this._flushCounters(true);
  }

  async _hasWaitingJobs() {
    const row = await this.db('bulk_reminder_records as r')
      .join('bulk_upload_batches as b', 'b.id', 'r.batch_id')
      .where('b.status', B.PROCESSING)
      .whereIn('r.status', CLAIMABLE_STATUSES)
      .first('r.id');
    return !!row;
  }

  /** Atomically claim up to `limit` due jobs from batches that are PROCESSING. */
  async claim(limit) {
    const token = crypto.randomBytes(12).toString('hex');
    const ts = this.now();
    const leaseUntil = new Date(this.clock() + this.q.leaseMs).toISOString();
    const isPg = this.db.client.config.client === 'pg';
    await this.db.transaction(async (trx) => {
      const q = trx('bulk_reminder_records as r')
        .join('bulk_upload_batches as b', 'b.id', 'r.batch_id')
        .where('b.status', B.PROCESSING)
        .whereIn('r.status', CLAIMABLE_STATUSES)
        .where('r.next_attempt_at', '<=', ts)
        .orderBy('r.next_attempt_at')
        .orderBy('r.id')
        .limit(limit)
        .select('r.id');
      if (isPg) q.forUpdate('r').skipLocked();
      const ids = (await q).map((x) => x.id);
      if (!ids.length) return;
      await trx('bulk_reminder_records')
        .whereIn('id', ids)
        .whereIn('status', CLAIMABLE_STATUSES)
        .update({ status: R.PROCESSING, locked_by: this.workerId, lock_token: token, locked_until: leaseUntil, updated_at: ts });
    });
    return this.db('bulk_reminder_records').where({ lock_token: token, status: R.PROCESSING });
  }

  /** Process a single job. Every outcome is written to this job only. */
  async processJob(job) {
    try {
      // 1. Re-check batch state: pause / cancel requested after the claim.
      const batch = await this.db('bulk_upload_batches').where({ id: job.batch_id }).first('status', 'batch_number');
      if (!batch || batch.status === B.CANCELLED) {
        return await this._finish(job, { status: R.CANCELLED, failure_reason: 'Cancelled by user', next_attempt_at: null });
      }
      if (batch.status !== B.PROCESSING) {
        return await this._finish(job, { status: R.QUEUED }); // paused – hand the job back untouched
      }

      // 2. Consent: never message an opted-out number.
      const optOut = await this.db('whatsapp_opt_outs').where({ phone_number: job.phone_number }).first();
      if (optOut) {
        return await this._finish(job, { status: R.CANCELLED, failure_reason: 'Recipient has opted out of WhatsApp reminders', retry_eligible: false }, 'message.skipped_opt_out');
      }

      // 3. Duplicate protection across batches (same customer + account + installment + type).
      if (!job.override_duplicate) {
        const cutoff = new Date(this.clock() - this.reminders.duplicateWindowHours * 3600 * 1000).toISOString();
        const dup = await this.db('bulk_reminder_records')
          .where({ dedupe_key: job.dedupe_key })
          .whereNot({ id: job.id })
          .where((w) => w.where((x) => x.whereIn('status', SUCCESS_STATUSES).where('sent_at', '>=', cutoff)).orWhere('status', R.PROCESSING))
          .first('id', 'status', 'sent_at', 'batch_id');
        if (dup && dup.status === R.PROCESSING) {
          // Same reminder is being sent right now by another batch – look again shortly.
          return await this._finish(job, { status: R.QUEUED, next_attempt_at: new Date(this.clock() + 30000).toISOString() });
        }
        if (dup) {
          return await this._finish(
            job,
            {
              status: R.CANCELLED,
              failure_reason: `Skipped: the same reminder was already sent within ${this.reminders.duplicateWindowHours}h (record #${dup.id})`,
              retry_eligible: false,
            },
            'message.skipped_duplicate'
          );
        }
      }

      // 4. Rate limit, then commit an IN_FLIGHT attempt BEFORE calling the provider.
      await this.limiter.acquire();
      const attemptNumber = job.attempt_count + 1;
      const startedAt = this.now();
      const [logRow] = await this.db('whatsapp_message_logs')
        .insert({
          record_id: job.id,
          attempt_number: attemptNumber,
          provider: this.provider.name,
          request_status: 'IN_FLIGHT',
          request_started_at: startedAt,
          created_at: startedAt,
          updated_at: startedAt,
        })
        .returning('id');
      const logId = logRow && typeof logRow === 'object' ? logRow.id : logRow;
      const counted = await this.db('bulk_reminder_records')
        .where({ id: job.id, lock_token: job.lock_token })
        .update({ attempt_count: attemptNumber, round_attempts: job.round_attempts + 1, last_attempt_at: startedAt, updated_at: startedAt });
      if (!counted) {
        // Lease was lost (e.g. extremely slow DB) – another worker owns the job now.
        await this.db('whatsapp_message_logs').where({ id: logId }).update({ request_status: 'FAILED', error_message: 'Lease lost before send', updated_at: this.now() });
        return;
      }
      const roundAttempts = job.round_attempts + 1;

      // 5. Call the provider.
      let result;
      try {
        result = await this.provider.sendMessage({
          to: job.phone_number,
          text: job.message,
          variables: variablesForRecord(job),
          idempotencyKey: job.idempotency_key,
        });
      } catch (err) {
        const pe =
          err instanceof ProviderSendError
            ? err
            : new ProviderSendError({ kind: ERROR_KIND.TRANSIENT, message: `Unexpected error: ${err && err.message}` });
        return await this._handleFailure(job, pe, { logId, attemptNumber, roundAttempts, batchNumber: batch.batch_number });
      }

      // 6. Success.
      const ts = this.now();
      await this.db('whatsapp_message_logs')
        .where({ id: logId })
        .update({ request_status: 'ACCEPTED', provider_message_id: result.providerMessageId, delivery_status: 'sent', response_at: ts, updated_at: ts });
      // Only move PROCESSING -> SENT: a webhook may already have advanced this record to DELIVERED/READ.
      const n = await this.db('bulk_reminder_records')
        .where({ id: job.id, lock_token: job.lock_token, status: R.PROCESSING })
        .update({
          status: R.SENT,
          provider_message_id: result.providerMessageId,
          sent_at: ts,
          failure_reason: null,
          provider_error_code: null,
          locked_by: null,
          lock_token: null,
          locked_until: null,
          next_attempt_at: null,
          updated_at: ts,
        });
      if (!n) {
        await this.db('bulk_reminder_records')
          .where({ id: job.id })
          .whereNull('provider_message_id')
          .update({ provider_message_id: result.providerMessageId, locked_by: null, lock_token: null, locked_until: null, updated_at: ts });
      }
      await this.audit.log({ action: 'message.sent', description: `Message sent to ${job.customer_name}`, batchId: job.batch_id, recordId: job.id, details: { providerMessageId: result.providerMessageId, attempt: attemptNumber } });
      await this._replayEarlyWebhooks(result.providerMessageId);
      this._markDirty(job.batch_id);
    } catch (err) {
      // Infrastructure error while handling this job (e.g. DB write failed).
      // Leave the lease to expire: recovery will requeue or reconcile it. Other jobs are unaffected.
      this.logger.error(`[worker] error while processing record ${job.id}`, err);
    }
  }

  async _handleFailure(job, err, { logId, attemptNumber, roundAttempts, batchNumber }) {
    const ts = this.now();
    const exhausted = roundAttempts >= this.q.maxRetries;
    const { status, retryEligible } = failureStatusFor(err.kind, exhausted);

    await this.db('whatsapp_message_logs').where({ id: logId }).update({
      request_status: 'FAILED',
      error_kind: err.kind,
      error_code: err.code,
      error_message: String(err.message || '').slice(0, 1000),
      response_at: ts,
      updated_at: ts,
    });

    const patch = {
      status,
      failure_reason: String(err.message || err.kind).slice(0, 1000),
      provider_error_code: err.code,
      retry_eligible: retryEligible,
    };
    if (status === R.RETRY_SCHEDULED) {
      const backoff = Math.min(this.q.retryMaxDelayMs, this.q.retryBaseDelayMs * 2 ** (roundAttempts - 1));
      const jitter = Math.floor(Math.random() * Math.min(1000, backoff * 0.1 + 1));
      const delay = Math.max(backoff + jitter, err.retryAfterMs || 0);
      patch.next_attempt_at = new Date(this.clock() + delay).toISOString();
      patch.failure_reason = `${err.kind === ERROR_KIND.RATE_LIMITED ? 'Rate limited' : 'Temporary failure'} (attempt ${roundAttempts}/${this.q.maxRetries}): ${err.message}`;
    } else {
      patch.failed_at = ts;
      patch.next_attempt_at = null;
      if (exhausted && (err.kind === ERROR_KIND.TRANSIENT || err.kind === ERROR_KIND.TIMEOUT || err.kind === ERROR_KIND.RATE_LIMITED)) {
        patch.failure_reason = `Failed after ${roundAttempts} attempts: ${err.message}`;
      }
    }
    if (err.kind === ERROR_KIND.RATE_LIMITED) {
      // Slow the whole worker down, not just this job.
      this.limiter.penalize(err.retryAfterMs || Math.min(60000, Math.max(1000, this.q.retryBaseDelayMs)));
    }
    if (err.kind === ERROR_KIND.OPTED_OUT) await this.service.addOptOut(job.phone_number, 'provider_error', err.message);

    await this._finish(job, patch, status === R.RETRY_SCHEDULED ? 'message.retry_scheduled' : 'message.failed', {
      errorKind: err.kind,
      errorCode: err.code,
      attempt: attemptNumber,
      batchNumber,
    });
  }

  /** Release the job with a final/next state (only if we still hold the lease). */
  async _finish(job, patch, auditAction, details) {
    const ts = this.now();
    const n = await this.db('bulk_reminder_records')
      .where({ id: job.id, lock_token: job.lock_token, status: R.PROCESSING })
      .update({ ...patch, locked_by: null, lock_token: null, locked_until: null, updated_at: ts });
    if (n && auditAction) {
      const verb = {
        'message.failed': `Message failed for ${job.customer_name}: ${patch.failure_reason}`,
        'message.retry_scheduled': `Retry scheduled for ${job.customer_name}: ${patch.failure_reason}`,
        'message.skipped_duplicate': `Skipped duplicate reminder for ${job.customer_name}`,
        'message.skipped_opt_out': `Skipped ${job.customer_name}: opted out`,
      }[auditAction];
      await this.audit.log({ action: auditAction, description: verb, batchId: job.batch_id, recordId: job.id, details });
    }
    this._markDirty(job.batch_id);
    return n;
  }

  /**
   * Handle jobs whose lease expired (worker crash / restart / server restart).
   */
  async recoverStaleJobs() {
    const ts = this.now();
    const stale = await this.db('bulk_reminder_records').where({ status: R.PROCESSING }).where('locked_until', '<', ts).limit(500);
    for (const job of stale) {
      try {
        if (job.reconcile_until) {
          // Reconcile window over and no webhook confirmed the message.
          const n = await this.db('bulk_reminder_records')
            .where({ id: job.id, status: R.PROCESSING, lock_token: job.lock_token })
            .update({
              status: R.FAILED,
              failure_reason: 'Outcome unknown: the worker stopped while sending and the provider never confirmed delivery. Verify with the customer before retrying.',
              retry_eligible: true,
              failed_at: ts,
              reconcile_until: null,
              locked_by: null,
              lock_token: null,
              locked_until: null,
              updated_at: ts,
            });
          if (n) {
            await this.db('whatsapp_message_logs').where({ record_id: job.id, request_status: 'IN_FLIGHT' }).update({ request_status: 'UNKNOWN', updated_at: ts });
            await this.audit.log({ action: 'message.outcome_unknown', description: `Delivery outcome unknown for ${job.customer_name} after worker interruption`, batchId: job.batch_id, recordId: job.id });
          }
          this._markDirty(job.batch_id);
          continue;
        }
        const inFlight = await this.db('whatsapp_message_logs').where({ record_id: job.id, request_status: 'IN_FLIGHT' }).first('id');
        if (inFlight) {
          // The provider may have accepted the message. Do NOT resend – wait for its webhook.
          const until = new Date(this.clock() + this.q.reconcileWindowMs).toISOString();
          await this.db('bulk_reminder_records')
            .where({ id: job.id, status: R.PROCESSING, lock_token: job.lock_token })
            .update({ reconcile_until: until, locked_until: until, locked_by: 'reconcile', updated_at: ts });
          await this.audit.log({ action: 'message.reconciling', description: `Worker interrupted while sending to ${job.customer_name}; awaiting provider confirmation (no resend)`, batchId: job.batch_id, recordId: job.id });
        } else {
          // The provider was never called – safe to put the job back in the queue.
          await this.db('bulk_reminder_records')
            .where({ id: job.id, status: R.PROCESSING, lock_token: job.lock_token })
            .update({ status: R.QUEUED, next_attempt_at: ts, locked_by: null, lock_token: null, locked_until: null, updated_at: ts });
          await this.audit.log({ action: 'message.requeued', description: `Requeued ${job.customer_name} after worker interruption (not yet sent)`, batchId: job.batch_id, recordId: job.id });
        }
        this._markDirty(job.batch_id);
      } catch (err) {
        this.logger.error(`[worker] recovery failed for record ${job.id}`, err);
      }
    }
    // Safety net: batches that are PROCESSING but have nothing left (e.g. finished while another process crashed).
    const active = await this.db('bulk_upload_batches').where({ status: B.PROCESSING }).select('id');
    for (const b of active) this._markDirty(b.id);
  }

  /** Status webhooks that arrived before we stored the provider message id. */
  async _replayEarlyWebhooks(providerMessageId) {
    const early = await this.db('webhook_events').where({ provider_message_id: providerMessageId, outcome: 'UNMATCHED' });
    for (const e of early) {
      await this.db('webhook_events').where({ id: e.id }).del();
      try {
        await this.service.applyStatusEvent(JSON.parse(e.payload), e.provider);
      } catch (err) {
        this.logger.error('[worker] failed to replay early webhook', err);
      }
    }
  }

  _markDirty(batchId) {
    this.dirtyBatches.add(batchId);
  }

  /** Batch counters are refreshed at most once a second (and at the end). */
  async _flushCounters(force) {
    if (!this.dirtyBatches.size) return;
    if (!force && this.clock() - this.lastCounterFlush < 1000) return;
    this.lastCounterFlush = this.clock();
    const ids = [...this.dirtyBatches];
    this.dirtyBatches.clear();
    for (const id of ids) {
      try {
        await this.service.refreshCounters(id);
      } catch (err) {
        this.dirtyBatches.add(id);
        this.logger.error(`[worker] failed to refresh counters for batch ${id}`, err);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { MessageWorker };
