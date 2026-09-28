'use strict';

/**
 * Bulk WhatsApp payment reminders schema.
 *
 * One row in bulk_reminder_records == one independent message job. The worker
 * claims rows individually (lease + lock token), so a failure on one row can
 * never affect any other row.
 */

exports.up = async function up(knex) {
  const ts = (t, name) => t.timestamp(name, { useTz: true }).nullable();

  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable().unique();
    t.string('display_name', 128).notNullable();
    t.string('password_hash', 128).notNullable();
    t.string('role', 32).notNullable(); // admin | main_head | employee
    t.boolean('is_active').notNullable().defaultTo(true);
    ts(t, 'created_at');
    ts(t, 'updated_at');
  });

  // Per-user overrides on top of role defaults (granted=false revokes a role default).
  await knex.schema.createTable('user_permissions', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('permission', 64).notNullable();
    t.boolean('granted').notNullable().defaultTo(true);
    ts(t, 'created_at');
    t.primary(['user_id', 'permission']);
  });

  await knex.schema.createTable('message_templates', (t) => {
    t.increments('id').primary();
    t.string('template_key', 64).notNullable().unique();
    t.text('body').notNullable();
    t.integer('updated_by').nullable().references('id').inTable('users');
    ts(t, 'created_at');
    ts(t, 'updated_at');
  });

  await knex.schema.createTable('bulk_upload_batches', (t) => {
    t.increments('id').primary();
    t.string('batch_number', 32).notNullable().unique();
    t.string('filename', 255).notNullable();
    t.string('file_sha256', 64).nullable().index();
    t.integer('uploaded_by').notNullable().references('id').inTable('users');
    ts(t, 'uploaded_at');
    // UPLOADED | VALIDATING | VALIDATED | READY | PROCESSING | PAUSED |
    // COMPLETED | COMPLETED_WITH_FAILURES | CANCELLED
    t.string('status', 32).notNullable();
    t.string('reminder_type', 32).notNullable().defaultTo('PAYMENT_REMINDER');
    t.text('message_template').nullable();
    t.boolean('override_duplicates').notNullable().defaultTo(false);
    t.integer('total_records').notNullable().defaultTo(0); // data rows in the file
    t.integer('valid_records').notNullable().defaultTo(0);
    t.integer('invalid_records').notNullable().defaultTo(0);
    t.integer('duplicate_records').notNullable().defaultTo(0);
    t.integer('processed_records').notNullable().defaultTo(0);
    t.integer('successful_records').notNullable().defaultTo(0);
    t.integer('failed_records').notNullable().defaultTo(0);
    t.integer('pending_records').notNullable().defaultTo(0);
    t.integer('cancelled_records').notNullable().defaultTo(0);
    t.integer('started_by').nullable().references('id').inTable('users');
    ts(t, 'started_at');
    ts(t, 'paused_at');
    ts(t, 'completed_at');
    ts(t, 'cancelled_at');
    ts(t, 'created_at');
    ts(t, 'updated_at');
  });

  // Every parsed Excel row with its validation outcome (kept for the preview + audit).
  await knex.schema.createTable('bulk_upload_rows', (t) => {
    t.increments('id').primary();
    t.integer('batch_id').notNullable().references('id').inTable('bulk_upload_batches').onDelete('CASCADE');
    t.integer('row_number').notNullable();
    t.string('customer_name', 128).nullable();
    t.string('phone_raw', 64).nullable();
    t.string('phone_number', 20).nullable();
    t.string('amount_raw', 64).nullable();
    t.decimal('amount_due', 14, 2).nullable();
    t.string('due_date', 10).nullable(); // YYYY-MM-DD
    t.string('account_id', 64).nullable();
    t.string('installment_number', 16).nullable();
    t.string('collector_name', 128).nullable();
    t.text('custom_message').nullable();
    t.string('status', 16).notNullable(); // VALID | INVALID | DUPLICATE
    t.text('reasons').nullable(); // JSON array
    t.text('warnings').nullable(); // JSON array
    ts(t, 'created_at');
    t.index(['batch_id', 'status']);
  });

  await knex.schema.createTable('bulk_reminder_records', (t) => {
    t.increments('id').primary();
    t.integer('batch_id').notNullable().references('id').inTable('bulk_upload_batches').onDelete('CASCADE');
    t.integer('upload_row_id').nullable().references('id').inTable('bulk_upload_rows');
    t.integer('row_number').notNullable();
    t.integer('customer_id').nullable(); // link to a customers table when one exists
    t.string('customer_name', 128).notNullable();
    t.string('phone_number', 20).notNullable();
    t.decimal('amount_due', 14, 2).notNullable();
    t.string('due_date', 10).nullable();
    t.string('account_id', 64).nullable();
    t.string('installment_number', 16).nullable();
    t.string('collector_name', 128).nullable();
    t.integer('assigned_user_id').nullable().references('id').inTable('users');
    t.text('custom_message').nullable();
    t.string('reminder_type', 32).notNullable();
    t.string('dedupe_key', 255).notNullable();
    t.string('idempotency_key', 300).notNullable().unique();
    t.text('message').nullable();
    t.string('status', 32).notNullable();
    t.text('failure_reason').nullable();
    t.string('provider_error_code', 32).nullable();
    t.string('provider_message_id', 128).nullable();
    t.integer('attempt_count').notNullable().defaultTo(0);
    t.integer('round_attempts').notNullable().defaultTo(0);
    t.boolean('retry_eligible').notNullable().defaultTo(true);
    t.boolean('override_duplicate').notNullable().defaultTo(false);
    ts(t, 'next_attempt_at');
    t.string('locked_by', 64).nullable();
    t.string('lock_token', 64).nullable();
    ts(t, 'locked_until');
    ts(t, 'reconcile_until');
    ts(t, 'queued_at');
    ts(t, 'sent_at');
    ts(t, 'delivered_at');
    ts(t, 'read_at');
    ts(t, 'failed_at');
    ts(t, 'last_attempt_at');
    ts(t, 'created_at');
    ts(t, 'updated_at');
    t.index(['batch_id', 'status']);
    t.index(['status', 'next_attempt_at']);
    t.index(['lock_token']);
    t.index(['dedupe_key', 'sent_at']);
    t.index(['provider_message_id']);
    t.index(['batch_id', 'updated_at']);
    t.index(['assigned_user_id']);
  });

  // One row per provider request (attempt) + delivery status updates.
  await knex.schema.createTable('whatsapp_message_logs', (t) => {
    t.increments('id').primary();
    t.integer('record_id').notNullable().references('id').inTable('bulk_reminder_records').onDelete('CASCADE');
    t.integer('attempt_number').notNullable();
    t.string('provider', 32).notNullable();
    t.string('provider_message_id', 128).nullable();
    // IN_FLIGHT | ACCEPTED | FAILED | UNKNOWN
    t.string('request_status', 16).notNullable();
    t.string('delivery_status', 16).nullable();
    t.string('error_kind', 32).nullable();
    t.string('error_code', 32).nullable();
    t.text('error_message').nullable();
    ts(t, 'request_started_at');
    ts(t, 'response_at');
    ts(t, 'created_at');
    ts(t, 'updated_at');
    t.index(['record_id']);
    t.index(['provider_message_id']);
  });

  await knex.schema.createTable('webhook_events', (t) => {
    t.increments('id').primary();
    t.string('provider', 32).notNullable();
    t.string('event_key', 255).notNullable().unique(); // de-duplicates redelivered webhooks
    t.string('provider_message_id', 128).nullable();
    t.string('status', 16).nullable();
    t.integer('record_id').nullable();
    t.string('outcome', 32).nullable(); // APPLIED | IGNORED | UNMATCHED
    t.text('payload').nullable();
    ts(t, 'created_at');
    t.index(['provider_message_id']);
  });

  await knex.schema.createTable('whatsapp_opt_outs', (t) => {
    t.string('phone_number', 20).primary();
    t.string('source', 32).notNullable(); // webhook_keyword | provider_error | manual
    t.text('reason').nullable();
    t.integer('created_by').nullable();
    ts(t, 'created_at');
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.increments('id').primary();
    t.integer('user_id').nullable();
    t.string('username', 64).nullable();
    t.string('user_role', 32).nullable();
    t.string('action', 64).notNullable();
    t.text('description').nullable();
    t.text('details').nullable(); // JSON
    t.integer('batch_id').nullable();
    t.integer('record_id').nullable();
    t.string('ip_address', 64).nullable();
    t.string('user_agent', 255).nullable();
    ts(t, 'created_at');
    t.index(['batch_id']);
    t.index(['created_at']);
    t.index(['action']);
  });
};

exports.down = async function down(knex) {
  for (const table of [
    'audit_logs',
    'whatsapp_opt_outs',
    'webhook_events',
    'whatsapp_message_logs',
    'bulk_reminder_records',
    'bulk_upload_rows',
    'bulk_upload_batches',
    'message_templates',
    'user_permissions',
    'users',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
};
