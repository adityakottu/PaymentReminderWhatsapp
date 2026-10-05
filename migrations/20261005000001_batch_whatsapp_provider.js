'use strict';

/**
 * Record which WhatsApp provider a batch was sent with, so batches sent in
 * test mode (mock provider) are permanently marked as simulated.
 * Existing batches are back-filled from their message logs.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('bulk_upload_batches', (t) => {
    t.string('whatsapp_provider', 32).nullable();
  });
  await knex.raw(`
    UPDATE bulk_upload_batches SET whatsapp_provider = (
      SELECT l.provider FROM whatsapp_message_logs l
      JOIN bulk_reminder_records r ON r.id = l.record_id
      WHERE r.batch_id = bulk_upload_batches.id
      ORDER BY l.id LIMIT 1
    )
    WHERE whatsapp_provider IS NULL`);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('bulk_upload_batches', (t) => t.dropColumn('whatsapp_provider'));
};
