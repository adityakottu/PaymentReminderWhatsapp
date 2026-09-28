'use strict';

const { nowIso } = require('../db');

/**
 * Append-only audit trail. Never throws – an audit write failure must not
 * break the business operation (it is logged to stderr instead).
 *
 * actor: { id, username, role } for users, or null for system/worker actions.
 * ctx:   { ip, userAgent } captured from the request where appropriate.
 */
function createAudit(db, { captureIp = true, logger = console } = {}) {
  async function log({ actor = null, action, description = null, details = null, batchId = null, recordId = null, ctx = {} }, trx) {
    try {
      await (trx || db)('audit_logs').insert({
        user_id: actor ? actor.id : null,
        username: actor ? actor.username : 'system',
        user_role: actor ? actor.role : 'system',
        action,
        description,
        details: details ? JSON.stringify(details) : null,
        batch_id: batchId,
        record_id: recordId,
        ip_address: captureIp && ctx.ip ? String(ctx.ip).slice(0, 64) : null,
        user_agent: captureIp && ctx.userAgent ? String(ctx.userAgent).slice(0, 255) : null,
        created_at: nowIso(),
      });
    } catch (err) {
      logger.error('[audit] failed to write audit log', action, err.message);
    }
  }
  return { log };
}

function requestContext(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

module.exports = { createAudit, requestContext };
