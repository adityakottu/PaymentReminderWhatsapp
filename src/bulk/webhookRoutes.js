'use strict';

const express = require('express');

/**
 * Provider webhook endpoints.
 *
 *   GET  /webhooks/whatsapp  – subscription verification challenge (hub.challenge)
 *   POST /webhooks/whatsapp  – delivery status events (sent / delivered / read / failed)
 *
 * The signature is verified against the RAW request body before anything is
 * parsed; unsigned or badly signed requests are rejected with 401.
 */
function createWebhookRouter({ provider, service, audit, logger = console }) {
  const r = express.Router();

  r.get('/whatsapp', (req, res) => {
    const challenge = provider.handleVerificationChallenge(req.query);
    if (challenge === null) return res.sendStatus(403);
    res.type('text/plain').send(challenge);
  });

  r.post('/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!provider.verifyWebhookSignature(raw, req.headers)) {
      await audit.log({ action: 'webhook.rejected', description: 'Rejected WhatsApp webhook with missing/invalid signature', ctx: { ip: req.ip, userAgent: req.get('user-agent') } });
      return res.sendStatus(401);
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return res.sendStatus(400);
    }
    const { statuses, optOuts } = provider.parseWebhook(body);
    let failed = false;
    for (const ev of statuses) {
      try {
        await service.applyStatusEvent(ev, provider.name);
      } catch (err) {
        failed = true;
        logger.error('[webhook] failed to apply status event', err);
      }
    }
    for (const phone of optOuts) {
      await service.addOptOut(phone, 'webhook_keyword', 'Customer replied STOP');
      await audit.log({ action: 'optout.added', description: `Customer ${phone} opted out via WhatsApp reply` });
    }
    // Non-2xx makes the provider redeliver; processing is idempotent.
    res.sendStatus(failed ? 500 : 200);
  });

  return r;
}

module.exports = { createWebhookRouter };
