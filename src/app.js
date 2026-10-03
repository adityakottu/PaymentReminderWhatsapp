'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createAuth, HttpError } = require('./auth/auth');
const { createAudit } = require('./audit/audit');
const { createBulkService } = require('./bulk/service');
const { createBulkRouter, createAuditRouter } = require('./bulk/routes');
const { createWebhookRouter } = require('./bulk/webhookRoutes');
const { createProvider } = require('./whatsapp');
const { MessageWorker } = require('./queue/worker');

/**
 * Build the application (HTTP app + services + worker) around a database.
 * Nothing here starts listening or processing; see server.js / worker.js.
 */
function createApplication({ db, config, provider, logger = console, clock }) {
  const audit = createAudit(db, { captureIp: config.audit.captureIp, logger });
  const service = createBulkService({ db, config, audit, logger, clock });
  const whatsapp = provider || createProvider(config.whatsapp);
  const auth = createAuth({ db, config, audit });
  const worker = new MessageWorker({ db, provider: whatsapp, service, config, audit, logger, clock });

  // Mock provider can simulate delivery/read callbacks for local demos.
  if (typeof whatsapp.onStatus === 'function') {
    whatsapp.onStatus((ev) => service.applyStatusEvent(ev, whatsapp.name));
  }

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });

  // Webhooks first: they need the raw body for signature verification and use no cookies.
  app.use('/webhooks', createWebhookRouter({ provider: whatsapp, service, audit, logger }));

  app.get('/healthz', async (req, res) => {
    try {
      await db.raw('select 1');
      res.json({ ok: true, provider: whatsapp.name, workerRunning: worker.running });
    } catch (e) {
      res.status(503).json({ ok: false });
    }
  });

  // CORS for the mobile app's web view (bearer-token auth, no cookies).
  const corsOrigins = new Set(config.corsOrigins || []);
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && corsOrigins.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Expose-Headers': 'Content-Disposition',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(cookieParser());
  app.use('/api', auth.csrfGuard);
  app.use('/api/auth', auth.router);
  app.use('/api/users', auth.usersRouter);
  app.use('/api/bulk-reminders', createBulkRouter({ service, auth, config, audit }));
  app.use('/api/audit-logs', createAuditRouter({ service, auth }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: config.env === 'production' ? '1h' : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof HttpError || err.status ? err.status || 500 : 500;
    if (status >= 500) logger.error('[http] unhandled error', err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, details: status < 500 ? err.details : undefined });
  });

  return { app, service, worker, provider: whatsapp, audit, auth };
}

module.exports = { createApplication };
