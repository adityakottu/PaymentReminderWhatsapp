'use strict';

/**
 * Message language support (English / Telugu / both).
 *  - batches: chosen default language + Telugu template snapshot
 *  - upload rows / records: optional per-customer language from the Excel
 *    "Language" column; records store the resolved language at send time.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('bulk_upload_batches', (t) => {
    t.string('language', 8).notNullable().defaultTo('en');
    t.text('message_template_te').nullable();
  });
  await knex.schema.alterTable('bulk_upload_rows', (t) => {
    t.string('language', 8).nullable();
  });
  await knex.schema.alterTable('bulk_reminder_records', (t) => {
    t.string('language', 8).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('bulk_reminder_records', (t) => t.dropColumn('language'));
  await knex.schema.alterTable('bulk_upload_rows', (t) => t.dropColumn('language'));
  await knex.schema.alterTable('bulk_upload_batches', (t) => {
    t.dropColumn('message_template_te');
    t.dropColumn('language');
  });
};
