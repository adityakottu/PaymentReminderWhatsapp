'use strict';

const crypto = require('crypto');
const { nowIso, toIso } = require('../db');
const { parseWorkbook, ExcelParseError } = require('./excel');
const { validateRows } = require('./validation');
const { DEFAULT_TEMPLATE, validateTemplate, renderForRecord } = require('./template');
const { HttpError } = require('../auth/auth');
const { PERMISSIONS } = require('../auth/permissions');
const {
  BATCH_STATUS: B,
  RECORD_STATUS: R,
  SUCCESS_STATUSES,
  FAILURE_STATUSES,
  IN_PROGRESS_STATUSES,
  MANUAL_RETRY_STATUSES,
  SUCCESS_RANK,
  FILTERS,
} = require('./statuses');
const { ERROR_KIND } = require('../whatsapp/provider');

const TEMPLATE_KEY = 'payment_reminder_default';
const CHUNK = 400;

function chunks(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function insertedId(row) {
  return row && typeof row === 'object' ? row.id : row;
}

function dedupeKey(row, reminderType) {
  return [row.phone_number, (row.account_id || '').toLowerCase(), row.installment_number || '', reminderType].join('|');
}

/** Map a provider error kind to the final record status. */
function failureStatusFor(kind, exhausted) {
  switch (kind) {
    case ERROR_KIND.INVALID_NUMBER:
      return { status: R.INVALID_NUMBER, retryEligible: false };
    case ERROR_KIND.NOT_ON_WHATSAPP:
      return { status: R.NOT_ON_WHATSAPP, retryEligible: false };
    case ERROR_KIND.OPTED_OUT:
      return { status: R.PROVIDER_ERROR, retryEligible: false };
    case ERROR_KIND.PERMANENT:
      return { status: R.PROVIDER_ERROR, retryEligible: true };
    case ERROR_KIND.RATE_LIMITED:
      return exhausted ? { status: R.RATE_LIMITED, retryEligible: true } : { status: R.RETRY_SCHEDULED, retryEligible: true };
    default:
      return exhausted ? { status: R.FAILED, retryEligible: true } : { status: R.RETRY_SCHEDULED, retryEligible: true };
  }
}

function createBulkService({ db, config, audit, logger = console, clock = () => Date.now() }) {
  const reminderType = config.reminders.reminderType;
  const now = () => nowIso(clock);

  // ---------------------------------------------------------------- helpers

  function canViewAll(user) {
    return user.permissions.has(PERMISSIONS.VIEW_ALL);
  }

  async function getBatchOr404(id) {
    const batch = await db('bulk_upload_batches').where({ id: Number(id) || 0 }).first();
    if (!batch) throw new HttpError(404, 'Batch not found');
    return batch;
  }

  /** Throws 404 when the user may not see this batch (no information leak). */
  async function getVisibleBatch(user, id) {
    const batch = await getBatchOr404(id);
    if (canViewAll(user) || batch.uploaded_by === user.id) return batch;
    const assigned = await db('bulk_reminder_records').where({ batch_id: batch.id, assigned_user_id: user.id }).first('id');
    if (!assigned) throw new HttpError(404, 'Batch not found');
    return batch;
  }

  /** Only the uploader or users with view_all may operate a batch. */
  async function getOperableBatch(user, id) {
    const batch = await getBatchOr404(id);
    if (!(canViewAll(user) || batch.uploaded_by === user.id)) throw new HttpError(404, 'Batch not found');
    return batch;
  }

  function recordScope(user, batch) {
    return (q) => {
      if (!(canViewAll(user) || batch.uploaded_by === user.id)) q.where('assigned_user_id', user.id);
    };
  }

  async function nextBatchNumber(trx) {
    const d = new Date(clock());
    const prefix = `BULK-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-`;
    const last = await trx('bulk_upload_batches').where('batch_number', 'like', `${prefix}%`).max('batch_number as m').first();
    const seq = last && last.m ? Number(String(last.m).slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(seq).padStart(3, '0')}`;
  }

  // --------------------------------------------------------------- template

  async function getGlobalTemplate() {
    const row = await db('message_templates').where({ template_key: TEMPLATE_KEY }).first();
    return row ? { body: row.body, updatedAt: toIso(row.updated_at), updatedBy: row.updated_by } : { body: DEFAULT_TEMPLATE, updatedAt: null, updatedBy: null };
  }

  async function updateGlobalTemplate(user, body, ctx) {
    const v = validateTemplate(body);
    if (!v.ok) throw new HttpError(400, v.errors.join('; '), { errors: v.errors });
    const existing = await db('message_templates').where({ template_key: TEMPLATE_KEY }).first();
    if (existing) await db('message_templates').where({ id: existing.id }).update({ body, updated_by: user.id, updated_at: now() });
    else await db('message_templates').insert({ template_key: TEMPLATE_KEY, body, updated_by: user.id, created_at: now(), updated_at: now() });
    await audit.log({ actor: user, action: 'template.updated', description: `${user.username} updated the default WhatsApp reminder template`, details: { body }, ctx });
    return getGlobalTemplate();
  }

  // ----------------------------------------------------------------- upload

  async function createUploadBatch(user, file, ctx) {
    if (!file || !file.buffer || !file.buffer.length) throw new HttpError(400, 'No file uploaded');
    const name = String(file.originalname || 'upload.xlsx').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    if (/\.xls$/i.test(name)) throw new HttpError(400, 'Legacy .xls files are not supported. Open the file in Excel and "Save As" .xlsx.');
    if (!/\.xlsx$/i.test(name)) throw new HttpError(400, 'Unsupported file type. Upload an Excel .xlsx file.');
    // .xlsx files are ZIP archives – reject anything else early.
    if (file.buffer.length < 4 || file.buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new HttpError(400, 'The file is not a valid .xlsx workbook (it may be corrupted).');
    }
    const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');

    let parsed;
    try {
      parsed = await parseWorkbook(file.buffer, { maxRows: config.upload.maxRows });
    } catch (err) {
      if (err instanceof ExcelParseError) {
        await audit.log({ actor: user, action: 'bulk.upload_rejected', description: `${user.username} uploaded ${name} – rejected: ${err.message}`, ctx });
        throw new HttpError(400, err.message, err.details);
      }
      throw err;
    }

    const { rows, summary } = validateRows(parsed.rows, {
      internationalEnabled: config.upload.internationalNumbersEnabled,
      defaultCountryCode: config.upload.defaultCountryCode,
    });

    // Cross-batch duplicate protection (warning at import; enforced again at send time).
    const cutoff = new Date(clock() - config.reminders.duplicateWindowHours * 3600 * 1000).toISOString();
    const keyToRow = new Map();
    for (const r of rows) if (r.status === 'VALID') keyToRow.set(dedupeKey(r, reminderType), r);
    let recentlyReminded = 0;
    for (const keys of chunks([...keyToRow.keys()])) {
      const hits = await db('bulk_reminder_records as r')
        .join('bulk_upload_batches as b', 'b.id', 'r.batch_id')
        .whereIn('r.dedupe_key', keys)
        .whereIn('r.status', SUCCESS_STATUSES)
        .where('r.sent_at', '>=', cutoff)
        .select('r.dedupe_key', 'r.sent_at', 'b.batch_number');
      for (const h of hits) {
        const row = keyToRow.get(h.dedupe_key);
        if (row && !row.warnings.some((w) => w.startsWith('Reminder already sent'))) {
          row.warnings.push(`Reminder already sent ${toIso(h.sent_at)} in ${h.batch_number} – will be skipped unless duplicates are overridden`);
          recentlyReminded++;
        }
      }
    }
    const sameFile = await db('bulk_upload_batches').where({ file_sha256: sha }).whereNot('status', B.CANCELLED).first('batch_number');

    let batchId;
    let batchNumber;
    for (let attempt = 0; ; attempt++) {
      try {
        await db.transaction(async (trx) => {
          batchNumber = await nextBatchNumber(trx);
          const [row] = await trx('bulk_upload_batches')
            .insert({
              batch_number: batchNumber,
              filename: name,
              file_sha256: sha,
              uploaded_by: user.id,
              uploaded_at: now(),
              status: B.VALIDATING,
              reminder_type: reminderType,
              total_records: summary.total,
              valid_records: summary.valid,
              invalid_records: summary.invalid,
              duplicate_records: summary.duplicates,
              created_at: now(),
              updated_at: now(),
            })
            .returning('id');
          batchId = insertedId(row);
          const ts = now();
          for (const part of chunks(rows, 200)) {
            await trx('bulk_upload_rows').insert(
              part.map((r) => ({
                batch_id: batchId,
                row_number: r.row_number,
                customer_name: r.customer_name,
                phone_raw: r.phone_raw,
                phone_number: r.phone_number,
                amount_raw: r.amount_raw,
                amount_due: r.amount_due,
                due_date: r.due_date,
                account_id: r.account_id,
                installment_number: r.installment_number,
                collector_name: r.collector_name,
                custom_message: r.custom_message,
                status: r.status,
                reasons: r.reasons.length ? JSON.stringify(r.reasons) : null,
                warnings: r.warnings.length ? JSON.stringify(r.warnings) : null,
                created_at: ts,
              }))
            );
          }
          await trx('bulk_upload_batches').where({ id: batchId }).update({ status: B.VALIDATED, updated_at: now() });
        });
        break;
      } catch (err) {
        // Two uploads racing for the same batch number – retry with the next one.
        if (attempt < 5 && /unique|duplicate/i.test(err.message) && /batch_number/i.test(err.message)) continue;
        throw err;
      }
    }

    await audit.log({ actor: user, action: 'bulk.uploaded', description: `${user.username} uploaded ${name}`, batchId, details: { batchNumber, sha256: sha }, ctx });
    await audit.log({
      actor: user,
      action: 'bulk.validated',
      description: `${user.username} validated ${summary.total} rows: ${summary.valid} valid, ${summary.invalid} invalid, ${summary.duplicates} duplicates`,
      batchId,
      details: summary,
      ctx,
    });

    return {
      batch: await getBatchSummary(batchId),
      validation: { ...summary, recentlyReminded, sameFileUploadedAs: sameFile ? sameFile.batch_number : null },
    };
  }

  async function listIssues(user, batchId, { page = 1, pageSize = 50, status } = {}) {
    const batch = await getOperableBatch(user, batchId);
    const base = db('bulk_upload_rows').where({ batch_id: batch.id }).where((q) => {
      if (status === 'INVALID' || status === 'DUPLICATE') q.where('status', status);
      else if (status === 'WARNING') q.where('status', 'VALID').whereNotNull('warnings');
      else q.whereIn('status', ['INVALID', 'DUPLICATE']).orWhereNotNull('warnings');
    });
    const [{ c }] = await base.clone().count({ c: '*' });
    const rows = await base.clone().orderBy('row_number').limit(pageSize).offset((page - 1) * pageSize);
    return {
      total: Number(c),
      page,
      pageSize,
      rows: rows.map((r) => ({
        rowNumber: r.row_number,
        customerName: r.customer_name,
        phoneRaw: r.phone_raw,
        phoneNumber: r.phone_number,
        amountDue: r.amount_due === null ? null : Number(r.amount_due),
        amountRaw: r.amount_raw,
        status: r.status,
        reasons: r.reasons ? JSON.parse(r.reasons) : [],
        warnings: r.warnings ? JSON.parse(r.warnings) : [],
      })),
    };
  }

  async function importValidRecords(user, batchId, ctx) {
    const batch = await getOperableBatch(user, batchId);
    if (batch.status !== B.VALIDATED) throw new HttpError(409, `Batch is ${batch.status}; only validated uploads can be imported`);
    const valid = await db('bulk_upload_rows').where({ batch_id: batch.id, status: 'VALID' }).orderBy('row_number');
    if (!valid.length) throw new HttpError(400, 'There are no valid records to import');
    const users = await db('users').where({ is_active: true }).select('id', 'username', 'display_name');
    const byName = new Map();
    for (const u of users) {
      byName.set(u.display_name.toLowerCase(), u.id);
      byName.set(u.username.toLowerCase(), u.id);
    }
    const template = (await getGlobalTemplate()).body;
    await db.transaction(async (trx) => {
      const locked = await trx('bulk_upload_batches').where({ id: batch.id, status: B.VALIDATED }).update({ status: B.READY, message_template: template, updated_at: now() });
      if (!locked) throw new HttpError(409, 'Batch was already imported or cancelled');
      const ts = now();
      for (const part of chunks(valid, 200)) {
        await trx('bulk_reminder_records').insert(
          part.map((r) => {
            const key = dedupeKey(r, reminderType);
            return {
              batch_id: batch.id,
              upload_row_id: r.id,
              row_number: r.row_number,
              customer_name: r.customer_name,
              phone_number: r.phone_number,
              amount_due: r.amount_due,
              due_date: r.due_date,
              account_id: r.account_id,
              installment_number: r.installment_number,
              collector_name: r.collector_name,
              assigned_user_id: r.collector_name ? byName.get(r.collector_name.toLowerCase()) || null : null,
              custom_message: r.custom_message,
              reminder_type: reminderType,
              dedupe_key: key,
              idempotency_key: `${batch.batch_number}:${key}`,
              status: R.PENDING,
              created_at: ts,
              updated_at: ts,
            };
          })
        );
      }
    });
    await refreshCounters(batch.id);
    await audit.log({
      actor: user,
      action: 'bulk.imported',
      description: `${user.username} imported ${valid.length} valid records into ${batch.batch_number}`,
      batchId: batch.id,
      ctx,
    });
    return getBatchSummary(batch.id);
  }

  async function cancelUpload(user, batchId, ctx) {
    const batch = await getOperableBatch(user, batchId);
    if (![B.UPLOADED, B.VALIDATING, B.VALIDATED, B.READY].includes(batch.status)) {
      throw new HttpError(409, `Batch is ${batch.status}; use "Cancel Remaining" for batches that are sending`);
    }
    await db.transaction(async (trx) => {
      await trx('bulk_reminder_records').where({ batch_id: batch.id }).whereIn('status', [R.PENDING]).update({ status: R.CANCELLED, failure_reason: 'Upload cancelled before sending', updated_at: now() });
      await trx('bulk_upload_batches').where({ id: batch.id }).update({ status: B.CANCELLED, cancelled_at: now(), updated_at: now() });
    });
    await refreshCounters(batch.id);
    await audit.log({ actor: user, action: 'bulk.upload_cancelled', description: `${user.username} cancelled upload ${batch.batch_number}`, batchId: batch.id, ctx });
    return getBatchSummary(batch.id);
  }

  // ------------------------------------------------------------ review/send

  async function setBatchTemplate(user, batchId, body, ctx) {
    const batch = await getOperableBatch(user, batchId);
    if (batch.status !== B.READY) throw new HttpError(409, 'The message can only be edited before sending starts');
    const v = validateTemplate(body);
    if (!v.ok) throw new HttpError(400, v.errors.join('; '), { errors: v.errors });
    await db('bulk_upload_batches').where({ id: batch.id }).update({ message_template: body, updated_at: now() });
    await audit.log({ actor: user, action: 'bulk.template_edited', description: `${user.username} edited the message for ${batch.batch_number}`, batchId: batch.id, details: { body }, ctx });
    return getBatchSummary(batch.id);
  }

  async function previewMessages(user, batchId, { template, limit = 3 } = {}) {
    const batch = await getVisibleBatch(user, batchId);
    const body = template !== undefined && template !== null ? template : batch.message_template || (await getGlobalTemplate()).body;
    const v = validateTemplate(body);
    let sample = await db('bulk_reminder_records').where({ batch_id: batch.id }).modify(recordScope(user, batch)).orderBy('row_number').limit(Math.min(10, limit));
    if (!sample.length) {
      sample = await db('bulk_upload_rows').where({ batch_id: batch.id, status: 'VALID' }).orderBy('row_number').limit(Math.min(10, limit));
    }
    return {
      template: body,
      validation: v,
      previews: v.ok
        ? sample.map((r) => ({ rowNumber: r.row_number, customerName: r.customer_name, phoneNumber: r.phone_number, message: renderForRecord(body, r) }))
        : [],
    };
  }

  async function duplicateCheck(batch) {
    const cutoff = new Date(clock() - config.reminders.duplicateWindowHours * 3600 * 1000).toISOString();
    const rows = await db('bulk_reminder_records as r')
      .whereIn('r.status', [R.PENDING, R.QUEUED, R.RETRY_SCHEDULED])
      .where('r.batch_id', batch.id)
      .whereExists(function () {
        this.select(db.raw('1'))
          .from('bulk_reminder_records as o')
          .whereRaw('o.dedupe_key = r.dedupe_key')
          .whereRaw('o.id <> r.id')
          .whereIn('o.status', SUCCESS_STATUSES)
          .where('o.sent_at', '>=', cutoff);
      })
      .count({ c: '*' });
    return Number(rows[0].c);
  }

  async function getSendReadiness(user, batchId) {
    const batch = await getVisibleBatch(user, batchId);
    const [{ c }] = await db('bulk_reminder_records').where({ batch_id: batch.id, status: R.PENDING }).count({ c: '*' });
    return {
      batchNumber: batch.batch_number,
      recipients: Number(c),
      estimatedMessages: Number(c),
      recentlyReminded: await duplicateCheck(batch),
      duplicateWindowHours: config.reminders.duplicateWindowHours,
      canOverrideDuplicates: user.permissions.has(PERMISSIONS.OVERRIDE_DUPLICATES),
    };
  }

  async function startSending(user, batchId, { confirm, overrideDuplicates = false, expectedRecipients } = {}, ctx) {
    const batch = await getOperableBatch(user, batchId);
    if (batch.status !== B.READY) throw new HttpError(409, `Batch is ${batch.status}; it can only be sent once from READY`);
    if (confirm !== true) throw new HttpError(400, 'Sending must be explicitly confirmed');
    if (overrideDuplicates && !user.permissions.has(PERMISSIONS.OVERRIDE_DUPLICATES)) {
      throw new HttpError(403, 'You are not allowed to override duplicate-send protection');
    }
    const body = batch.message_template || (await getGlobalTemplate()).body;
    const v = validateTemplate(body);
    if (!v.ok) throw new HttpError(400, `Message template is invalid: ${v.errors.join('; ')}`);

    const records = await db('bulk_reminder_records').where({ batch_id: batch.id, status: R.PENDING }).orderBy('row_number');
    if (!records.length) throw new HttpError(400, 'No recipients to send to');
    if (expectedRecipients !== undefined && Number(expectedRecipients) !== records.length) {
      throw new HttpError(409, `Recipient count changed (expected ${expectedRecipients}, now ${records.length}). Review the batch again.`);
    }

    await db.transaction(async (trx) => {
      const ok = await trx('bulk_upload_batches').where({ id: batch.id, status: B.READY }).update({
        status: B.PROCESSING,
        message_template: body,
        override_duplicates: !!overrideDuplicates,
        started_by: user.id,
        started_at: now(),
        updated_at: now(),
      });
      if (!ok) throw new HttpError(409, 'Batch was already started');
      const ts = now();
      // One record == one job. Each gets its own rendered message and is queued independently.
      for (const r of records) {
        await trx('bulk_reminder_records')
          .where({ id: r.id, status: R.PENDING })
          .update({
            message: renderForRecord(body, r),
            status: R.QUEUED,
            queued_at: ts,
            next_attempt_at: ts,
            override_duplicate: !!overrideDuplicates,
            round_attempts: 0,
            updated_at: ts,
          });
      }
    });
    await refreshCounters(batch.id);
    await audit.log({
      actor: user,
      action: 'bulk.send_started',
      description: `${user.username} started WhatsApp batch ${batch.batch_number} (${records.length} recipients)`,
      batchId: batch.id,
      details: { recipients: records.length, overrideDuplicates: !!overrideDuplicates },
      ctx,
    });
    return getBatchSummary(batch.id);
  }

  async function pauseBatch(user, batchId, ctx) {
    const batch = await getOperableBatch(user, batchId);
    const ok = await db('bulk_upload_batches').where({ id: batch.id, status: B.PROCESSING }).update({ status: B.PAUSED, paused_at: now(), updated_at: now() });
    if (!ok) throw new HttpError(409, `Batch is ${batch.status}; only processing batches can be paused`);
    await audit.log({ actor: user, action: 'bulk.paused', description: `${user.username} paused ${batch.batch_number}`, batchId: batch.id, ctx });
    return getBatchSummary(batch.id);
  }

  async function resumeBatch(user, batchId, ctx) {
    const batch = await getOperableBatch(user, batchId);
    const ok = await db('bulk_upload_batches').where({ id: batch.id, status: B.PAUSED }).update({ status: B.PROCESSING, paused_at: null, updated_at: now() });
    if (!ok) throw new HttpError(409, `Batch is ${batch.status}; only paused batches can be resumed`);
    await audit.log({ actor: user, action: 'bulk.resumed', description: `${user.username} resumed ${batch.batch_number}`, batchId: batch.id, ctx });
    await refreshCounters(batch.id);
    return getBatchSummary(batch.id);
  }

  async function cancelRemaining(user, batchId, ctx) {
    const batch = await getOperableBatch(user, batchId);
    if (![B.PROCESSING, B.PAUSED].includes(batch.status)) throw new HttpError(409, `Batch is ${batch.status}; nothing to cancel`);
    let cancelled = 0;
    await db.transaction(async (trx) => {
      await trx('bulk_upload_batches').where({ id: batch.id }).update({ status: B.CANCELLED, cancelled_at: now(), updated_at: now() });
      // Already-sent messages stay sent; in-flight (PROCESSING) jobs finish on their own.
      cancelled = await trx('bulk_reminder_records')
        .where({ batch_id: batch.id })
        .whereIn('status', [R.PENDING, R.QUEUED, R.RETRY_SCHEDULED])
        .update({ status: R.CANCELLED, failure_reason: 'Cancelled by user', next_attempt_at: null, updated_at: now() });
    });
    await refreshCounters(batch.id);
    await audit.log({
      actor: user,
      action: 'bulk.cancelled',
      description: `${user.username} cancelled the remaining ${cancelled} messages in ${batch.batch_number}`,
      batchId: batch.id,
      details: { cancelled },
      ctx,
    });
    return getBatchSummary(batch.id);
  }

  async function retryFailed(user, batchId, { recordIds } = {}, ctx) {
    const batch = await getOperableBatch(user, batchId);
    if ([B.CANCELLED, B.VALIDATED, B.READY, B.UPLOADED, B.VALIDATING].includes(batch.status)) {
      throw new HttpError(409, `Batch is ${batch.status}; failed messages cannot be retried`);
    }
    let count = 0;
    await db.transaction(async (trx) => {
      const q = trx('bulk_reminder_records').where({ batch_id: batch.id, retry_eligible: true }).whereIn('status', MANUAL_RETRY_STATUSES);
      if (Array.isArray(recordIds) && recordIds.length) q.whereIn('id', recordIds.map(Number).filter(Number.isFinite));
      count = await q.update({
        status: R.QUEUED,
        round_attempts: 0,
        next_attempt_at: now(),
        queued_at: now(),
        failure_reason: null,
        updated_at: now(),
      });
      if (count && [B.COMPLETED, B.COMPLETED_WITH_FAILURES].includes(batch.status)) {
        await trx('bulk_upload_batches').where({ id: batch.id }).update({ status: B.PROCESSING, completed_at: null, updated_at: now() });
      }
    });
    await refreshCounters(batch.id);
    await audit.log({
      actor: user,
      action: 'bulk.retry_failed',
      description: `${user.username} retried ${count} failed messages in ${batch.batch_number}`,
      batchId: batch.id,
      details: { count, recordIds: recordIds || 'all-eligible' },
      ctx,
    });
    return { retried: count, batch: await getBatchSummary(batch.id) };
  }

  // --------------------------------------------------------------- counters

  /**
   * Recompute batch counters from the records and finish the batch when no
   * job is left in progress. Safe to call from anywhere, any number of times.
   */
  async function refreshCounters(batchId) {
    const rows = await db('bulk_reminder_records').where({ batch_id: batchId }).groupBy('status').select('status').count({ c: '*' });
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
    const sum = (list) => list.reduce((a, s) => a + (by[s] || 0), 0);
    const successful = sum(SUCCESS_STATUSES);
    const failed = sum(FAILURE_STATUSES);
    const pending = sum(IN_PROGRESS_STATUSES);
    const cancelled = by[R.CANCELLED] || 0;
    await db('bulk_upload_batches').where({ id: batchId }).update({
      successful_records: successful,
      failed_records: failed,
      pending_records: pending,
      cancelled_records: cancelled,
      processed_records: successful + failed + cancelled,
      updated_at: now(),
    });
    if (pending === 0) {
      const finalStatus = failed > 0 ? B.COMPLETED_WITH_FAILURES : B.COMPLETED;
      const done = await db('bulk_upload_batches').where({ id: batchId, status: B.PROCESSING }).update({ status: finalStatus, completed_at: now(), updated_at: now() });
      if (done) {
        const b = await db('bulk_upload_batches').where({ id: batchId }).first();
        await audit.log({
          action: 'bulk.completed',
          description: `Batch ${b.batch_number} completed: ${successful} sent, ${failed} failed${cancelled ? `, ${cancelled} cancelled` : ''}`,
          batchId,
          details: { successful, failed, cancelled },
        });
      }
    }
    return by;
  }

  // ---------------------------------------------------------------- queries

  function serializeBatch(b, extra = {}) {
    const decided = b.successful_records + b.failed_records;
    const total = b.status === B.VALIDATED ? b.valid_records : b.successful_records + b.failed_records + b.pending_records + b.cancelled_records;
    return {
      id: b.id,
      batchNumber: b.batch_number,
      filename: b.filename,
      status: b.status,
      uploadedBy: b.uploaded_by,
      uploadedByName: b.uploaded_by_name || extra.uploadedByName || null,
      uploadedAt: toIso(b.uploaded_at),
      startedAt: toIso(b.started_at),
      completedAt: toIso(b.completed_at),
      cancelledAt: toIso(b.cancelled_at),
      pausedAt: toIso(b.paused_at),
      totalRows: b.total_records,
      validRecords: b.valid_records,
      invalidRecords: b.invalid_records,
      duplicateRecords: b.duplicate_records,
      recipients: total,
      processed: b.processed_records,
      successful: b.successful_records,
      failed: b.failed_records,
      pending: b.pending_records,
      cancelled: b.cancelled_records,
      progressPct: total ? Math.round((b.processed_records / total) * 1000) / 10 : 0,
      successRatePct: decided ? Math.round((b.successful_records / decided) * 1000) / 10 : null,
      failureRatePct: decided ? Math.round((b.failed_records / decided) * 1000) / 10 : null,
      messageTemplate: b.message_template,
      overrideDuplicates: !!b.override_duplicates,
      updatedAt: toIso(b.updated_at),
      ...extra,
    };
  }

  async function getBatchSummary(batchId) {
    const b = await db('bulk_upload_batches as b').leftJoin('users as u', 'u.id', 'b.uploaded_by').where('b.id', batchId).first('b.*', 'u.display_name as uploaded_by_name');
    return serializeBatch(b);
  }

  /** Summary scoped to what the user may see (employees: only assigned records' counts). */
  async function getBatchForUser(user, batchId) {
    const batch = await getVisibleBatch(user, batchId);
    const summary = await getBatchSummary(batch.id);
    const scoped = !(canViewAll(user) || batch.uploaded_by === user.id);
    if (!scoped) return { ...summary, scoped: false };
    const rows = await db('bulk_reminder_records').where({ batch_id: batch.id, assigned_user_id: user.id }).groupBy('status').select('status').count({ c: '*' });
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
    const sum = (list) => list.reduce((a, s) => a + (by[s] || 0), 0);
    const successful = sum(SUCCESS_STATUSES);
    const failed = sum(FAILURE_STATUSES);
    const pending = sum(IN_PROGRESS_STATUSES);
    const cancelled = by[R.CANCELLED] || 0;
    const total = successful + failed + pending + cancelled;
    return {
      ...summary,
      scoped: true,
      messageTemplate: null,
      recipients: total,
      processed: successful + failed + cancelled,
      successful,
      failed,
      pending,
      cancelled,
      progressPct: total ? Math.round(((successful + failed + cancelled) / total) * 1000) / 10 : 0,
      successRatePct: successful + failed ? Math.round((successful / (successful + failed)) * 1000) / 10 : null,
      failureRatePct: successful + failed ? Math.round((failed / (successful + failed)) * 1000) / 10 : null,
    };
  }

  async function listBatches(user, { page = 1, pageSize = 25, q } = {}) {
    const base = db('bulk_upload_batches as b').leftJoin('users as u', 'u.id', 'b.uploaded_by');
    if (!canViewAll(user)) {
      base.where((w) =>
        w.where('b.uploaded_by', user.id).orWhereExists(function () {
          this.select(db.raw('1')).from('bulk_reminder_records as r').whereRaw('r.batch_id = b.id').where('r.assigned_user_id', user.id);
        })
      );
    }
    if (q) base.where((w) => w.where('b.batch_number', 'like', `%${q}%`).orWhere('b.filename', 'like', `%${q}%`));
    const [{ c }] = await base.clone().count({ c: '*' });
    const rows = await base.clone().select('b.*', 'u.display_name as uploaded_by_name').orderBy('b.id', 'desc').limit(pageSize).offset((page - 1) * pageSize);
    return { total: Number(c), page, pageSize, batches: rows.map((b) => serializeBatch(b)) };
  }

  function serializeRecord(r) {
    return {
      id: r.id,
      rowNumber: r.row_number,
      customerName: r.customer_name,
      phoneNumber: r.phone_number,
      amountDue: Number(r.amount_due),
      dueDate: r.due_date,
      accountId: r.account_id,
      installmentNumber: r.installment_number,
      collectorName: r.collector_name,
      message: r.message,
      status: r.status,
      failureReason: r.failure_reason,
      providerErrorCode: r.provider_error_code,
      providerMessageId: r.provider_message_id,
      attempts: r.attempt_count,
      retryEligible: !!r.retry_eligible && MANUAL_RETRY_STATUSES.includes(r.status),
      nextAttemptAt: r.status === R.RETRY_SCHEDULED ? toIso(r.next_attempt_at) : null,
      queuedAt: toIso(r.queued_at),
      sentAt: toIso(r.sent_at),
      deliveredAt: toIso(r.delivered_at),
      readAt: toIso(r.read_at),
      failedAt: toIso(r.failed_at),
      lastAttemptAt: toIso(r.last_attempt_at),
      updatedAt: toIso(r.updated_at),
    };
  }

  function recordsQuery(user, batch, { filter, q } = {}) {
    const base = db('bulk_reminder_records').where({ batch_id: batch.id }).modify(recordScope(user, batch));
    const statuses = filter && Object.prototype.hasOwnProperty.call(FILTERS, filter) ? FILTERS[filter] : filter && Object.values(R).includes(filter) ? [filter] : null;
    if (statuses) base.whereIn('status', statuses);
    if (q) {
      const term = `%${String(q).trim().toLowerCase()}%`;
      const digits = String(q).replace(/\D/g, '');
      base.where((w) => {
        w.whereRaw('lower(customer_name) like ?', [term]).orWhereRaw('lower(account_id) like ?', [term]);
        if (digits.length >= 3) w.orWhere('phone_number', 'like', `%${digits}%`);
      });
    }
    return base;
  }

  async function listRecords(user, batchId, { filter, q, page = 1, pageSize = 50 } = {}) {
    const batch = await getVisibleBatch(user, batchId);
    const base = recordsQuery(user, batch, { filter, q });
    const [{ c }] = await base.clone().count({ c: '*' });
    const rows = await base.clone().orderBy('row_number').limit(pageSize).offset((page - 1) * pageSize);
    return { total: Number(c), page, pageSize, records: rows.map(serializeRecord) };
  }

  async function allRecordsForExport(user, batchId) {
    const batch = await getVisibleBatch(user, batchId);
    const rows = await recordsQuery(user, batch, {}).orderBy('row_number');
    return { batch: await getBatchForUser(user, batch.id), records: rows.map(serializeRecord) };
  }

  async function recordLogs(user, batchId, recordId) {
    const batch = await getVisibleBatch(user, batchId);
    const rec = await db('bulk_reminder_records').where({ id: Number(recordId), batch_id: batch.id }).modify(recordScope(user, batch)).first();
    if (!rec) throw new HttpError(404, 'Record not found');
    const logs = await db('whatsapp_message_logs').where({ record_id: rec.id }).orderBy('id');
    return {
      record: serializeRecord(rec),
      attempts: logs.map((l) => ({
        attempt: l.attempt_number,
        provider: l.provider,
        providerMessageId: l.provider_message_id,
        requestStatus: l.request_status,
        deliveryStatus: l.delivery_status,
        errorKind: l.error_kind,
        errorCode: l.error_code,
        errorMessage: l.error_message,
        startedAt: toIso(l.request_started_at),
        respondedAt: toIso(l.response_at),
      })),
    };
  }

  async function listAudit({ batchId, action, page = 1, pageSize = 100 } = {}) {
    const base = db('audit_logs');
    if (batchId) base.where({ batch_id: Number(batchId) });
    if (action) base.where('action', 'like', `${action}%`);
    const [{ c }] = await base.clone().count({ c: '*' });
    const rows = await base.clone().orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize);
    return {
      total: Number(c),
      page,
      pageSize,
      entries: rows.map((a) => ({
        id: a.id,
        userId: a.user_id,
        username: a.username,
        role: a.user_role,
        action: a.action,
        description: a.description,
        details: a.details ? safeJson(a.details) : null,
        batchId: a.batch_id,
        recordId: a.record_id,
        ip: a.ip_address,
        userAgent: a.user_agent,
        createdAt: toIso(a.created_at),
      })),
    };
  }

  // ------------------------------------------------------- webhook statuses

  /**
   * Apply a provider delivery status event. Idempotent: duplicate webhooks are
   * ignored, statuses only move forward, and events that arrive before the
   * worker stored the provider message id are matched via the idempotency key
   * the provider echoes back (callbackData).
   */
  async function applyStatusEvent(ev, providerName) {
    const eventKey = `${providerName}:${ev.providerMessageId}:${ev.status}`;
    try {
      await db('webhook_events').insert({
        provider: providerName,
        event_key: eventKey,
        provider_message_id: ev.providerMessageId,
        status: ev.status,
        payload: JSON.stringify(ev).slice(0, 4000),
        created_at: now(),
      });
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) return { outcome: 'DUPLICATE' };
      throw err;
    }
    try {
      return await applyStatusEventInner(ev, eventKey);
    } catch (err) {
      // Let the provider's redelivery be processed instead of being dropped as a duplicate.
      await db('webhook_events').where({ event_key: eventKey }).del().catch(() => {});
      throw err;
    }
  }

  async function applyStatusEventInner(ev, eventKey) {
    let rec = ev.providerMessageId ? await db('bulk_reminder_records').where({ provider_message_id: ev.providerMessageId }).first() : null;
    if (!rec && ev.callbackData) rec = await db('bulk_reminder_records').where({ idempotency_key: ev.callbackData }).first();
    if (!rec) {
      await db('webhook_events').where({ event_key: eventKey }).update({ outcome: 'UNMATCHED' });
      return { outcome: 'UNMATCHED' };
    }

    const ts = ev.timestamp || now();
    const patch = { updated_at: now() };
    let outcome = 'IGNORED';
    const currentRank = SUCCESS_RANK[rec.status] || 0;

    if (['sent', 'delivered', 'read'].includes(ev.status)) {
      const target = { sent: R.SENT, delivered: R.DELIVERED, read: R.READ }[ev.status];
      if (!rec.provider_message_id && ev.providerMessageId) patch.provider_message_id = ev.providerMessageId;
      if (ev.status === 'sent' && !rec.sent_at) patch.sent_at = ts;
      if (ev.status === 'delivered' && !rec.delivered_at) patch.delivered_at = ts;
      if (ev.status === 'read') {
        if (!rec.read_at) patch.read_at = ts;
        if (!rec.delivered_at) patch.delivered_at = ts;
      }
      if (!rec.sent_at && !patch.sent_at) patch.sent_at = ts;
      // Upgrade only (never downgrade READ -> DELIVERED). A success event also
      // overrides a failure we inferred locally (e.g. an unknown outcome after a crash).
      if (SUCCESS_RANK[target] > currentRank && rec.status !== R.CANCELLED) {
        patch.status = target;
        patch.failure_reason = null;
        patch.provider_error_code = null;
        patch.reconcile_until = null;
        if (rec.status === R.PROCESSING) {
          patch.locked_by = null;
          patch.lock_token = null;
          patch.locked_until = null;
        }
      }
      outcome = 'APPLIED';
    } else if (ev.status === 'failed') {
      // A delivery failure reported after the provider accepted the message.
      if (currentRank < SUCCESS_RANK[R.DELIVERED]) {
        const err = ev.error || {};
        const { status } = failureStatusFor(err.kind === ERROR_KIND.TRANSIENT || err.kind === ERROR_KIND.TIMEOUT ? 'FINAL_TRANSIENT' : err.kind, true);
        patch.status = status;
        patch.retry_eligible = ![R.INVALID_NUMBER, R.NOT_ON_WHATSAPP].includes(status) && err.kind !== ERROR_KIND.OPTED_OUT;
        patch.failure_reason = err.message || 'Delivery failed (reported by provider)';
        patch.provider_error_code = err.code || null;
        patch.failed_at = ts;
        patch.reconcile_until = null;
        if (!rec.provider_message_id && ev.providerMessageId) patch.provider_message_id = ev.providerMessageId;
        if (rec.status === R.PROCESSING) {
          patch.locked_by = null;
          patch.lock_token = null;
          patch.locked_until = null;
        }
        if (err.kind === ERROR_KIND.OPTED_OUT) await addOptOut(rec.phone_number, 'provider_error', patch.failure_reason);
        outcome = 'APPLIED';
      }
    }

    if (Object.keys(patch).length > 1) await db('bulk_reminder_records').where({ id: rec.id }).update(patch);
    if (ev.providerMessageId) {
      await db('whatsapp_message_logs')
        .where({ record_id: rec.id })
        .where((w) => w.where({ provider_message_id: ev.providerMessageId }).orWhereIn('request_status', ['IN_FLIGHT', 'UNKNOWN']))
        .update({
          delivery_status: ev.status,
          provider_message_id: ev.providerMessageId,
          ...(ev.status === 'failed' && ev.error ? { error_code: ev.error.code, error_message: ev.error.message } : {}),
          updated_at: now(),
        });
    }
    await db('webhook_events').where({ event_key: eventKey }).update({ record_id: rec.id, outcome });
    if (outcome === 'APPLIED' && patch.status && FAILURE_STATUSES.includes(patch.status)) {
      await audit.log({ action: 'message.failed', description: `Delivery failed for ${rec.customer_name}: ${patch.failure_reason}`, batchId: rec.batch_id, recordId: rec.id });
    }
    if (patch.status) await refreshCounters(rec.batch_id);
    return { outcome, recordId: rec.id };
  }

  async function addOptOut(phone, source, reason, userId = null) {
    try {
      await db('whatsapp_opt_outs').insert({ phone_number: phone, source, reason, created_by: userId, created_at: now() });
    } catch (err) {
      if (!/unique|duplicate|constraint/i.test(err.message)) throw err;
    }
  }

  async function removeOptOut(phone) {
    return db('whatsapp_opt_outs').where({ phone_number: phone }).del();
  }

  async function listOptOuts() {
    const rows = await db('whatsapp_opt_outs').orderBy('created_at', 'desc');
    return rows.map((r) => ({ phoneNumber: r.phone_number, source: r.source, reason: r.reason, createdAt: toIso(r.created_at) }));
  }

  /** Cheap change marker for the live dashboard. */
  async function batchVersion(batchId) {
    const r = await db('bulk_reminder_records').where({ batch_id: batchId }).max('updated_at as m').first();
    const b = await db('bulk_upload_batches').where({ id: batchId }).first('updated_at', 'status');
    return `${b && b.status}|${toIso(b && b.updated_at)}|${toIso(r && r.m)}`;
  }

  return {
    // upload & validation
    createUploadBatch,
    listIssues,
    importValidRecords,
    cancelUpload,
    // template
    getGlobalTemplate,
    updateGlobalTemplate,
    setBatchTemplate,
    previewMessages,
    // sending
    getSendReadiness,
    startSending,
    pauseBatch,
    resumeBatch,
    cancelRemaining,
    retryFailed,
    refreshCounters,
    // queries
    getVisibleBatch,
    getBatchForUser,
    getBatchSummary,
    listBatches,
    listRecords,
    allRecordsForExport,
    recordLogs,
    listAudit,
    batchVersion,
    // webhooks / consent
    applyStatusEvent,
    addOptOut,
    removeOptOut,
    listOptOuts,
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return s;
  }
}

module.exports = { createBulkService, failureStatusFor, dedupeKey };
