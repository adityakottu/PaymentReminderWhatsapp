'use strict';

const express = require('express');
const multer = require('multer');
const { PERMISSIONS: P } = require('../auth/permissions');
const { HttpError } = require('../auth/auth');
const { requestContext } = require('../audit/audit');
const { buildTemplateWorkbook } = require('./excel');
const { buildResultsWorkbook, streamResultsPdf } = require('./export');
const { normalizePhone } = require('./phone');
const { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_TE, VARIABLES, LANGUAGES } = require('./template');

const str = (v) => (typeof v === 'string' ? v : undefined);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function pageParams(req, maxSize = 200) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  return { page, pageSize };
}

function createBulkRouter({ service, auth, config, audit }) {
  const { authenticate, requirePermission } = auth;
  const r = express.Router();
  const json = express.json({ limit: '64kb' });

  const upload = () =>
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: Math.floor(config.upload.maxFileMb * 1024 * 1024), files: 1, fields: 5 },
    });

  r.use(authenticate, requirePermission(P.ACCESS));

  // ---- template download (no customer data)
  r.get(
    '/template.xlsx',
    wrap(async (req, res) => {
      const wb = await buildTemplateWorkbook();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="bulk-whatsapp-reminder-template.xlsx"');
      await wb.xlsx.write(res);
      res.end();
    })
  );

  r.get('/config', (req, res) =>
    res.json({
      maxUploadMb: config.upload.maxFileMb,
      maxRows: config.upload.maxRows,
      duplicateWindowHours: config.reminders.duplicateWindowHours,
      maxRetries: config.queue.maxRetries,
      provider: config.whatsapp.provider,
      sendMode: config.whatsapp.sendMode,
      templateVariables: VARIABLES,
      languages: LANGUAGES,
    })
  );

  // ---- STEP 1: upload + validate
  r.post(
    '/uploads',
    requirePermission(P.UPLOAD),
    (req, res, next) =>
      upload().single('file')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `File is larger than ${config.upload.maxFileMb} MB`));
        if (err) return next(new HttpError(400, err.message));
        next();
      }),
    wrap(async (req, res) => {
      const result = await service.createUploadBatch(req.user, req.file, requestContext(req));
      res.status(201).json(result);
    })
  );

  // ---- history
  r.get(
    '/batches',
    wrap(async (req, res) => res.json(await service.listBatches(req.user, { ...pageParams(req, 100), q: req.query.q ? String(req.query.q).slice(0, 64) : null })))
  );

  r.get('/batches/:id', wrap(async (req, res) => res.json({ batch: await service.getBatchForUser(req.user, req.params.id) })));

  r.get(
    '/batches/:id/issues',
    wrap(async (req, res) => res.json(await service.listIssues(req.user, req.params.id, { ...pageParams(req), status: req.query.status })))
  );

  // ---- STEP 2: import or cancel
  r.post('/batches/:id/import', requirePermission(P.UPLOAD), wrap(async (req, res) => res.json({ batch: await service.importValidRecords(req.user, req.params.id, requestContext(req)) })));
  r.post('/batches/:id/cancel-upload', requirePermission(P.UPLOAD), wrap(async (req, res) => res.json({ batch: await service.cancelUpload(req.user, req.params.id, requestContext(req)) })));

  // ---- STEP 3: review
  r.post(
    '/batches/:id/preview',
    json,
    wrap(async (req, res) => {
      const b = req.body || {};
      res.json(await service.previewMessages(req.user, req.params.id, { template: str(b.template), templateTe: str(b.templateTe), language: str(b.language), limit: 3 }));
    })
  );
  r.put(
    '/batches/:id/template',
    requirePermission(P.EDIT_BATCH_TEMPLATE),
    json,
    wrap(async (req, res) => {
      const b = req.body || {};
      res.json({ batch: await service.setBatchTemplate(req.user, req.params.id, { template: str(b.template), templateTe: str(b.templateTe), language: str(b.language) }, requestContext(req)) });
    })
  );
  r.get('/batches/:id/send-readiness', wrap(async (req, res) => res.json(await service.getSendReadiness(req.user, req.params.id))));

  // ---- STEP 4: send + controls
  r.post(
    '/batches/:id/send',
    requirePermission(P.SEND),
    json,
    wrap(async (req, res) => {
      const { confirm, overrideDuplicates, expectedRecipients } = req.body || {};
      res.status(202).json({ batch: await service.startSending(req.user, req.params.id, { confirm, overrideDuplicates: !!overrideDuplicates, expectedRecipients }, requestContext(req)) });
    })
  );
  r.post('/batches/:id/pause', requirePermission(P.CONTROL), wrap(async (req, res) => res.json({ batch: await service.pauseBatch(req.user, req.params.id, requestContext(req)) })));
  r.post('/batches/:id/resume', requirePermission(P.CONTROL), wrap(async (req, res) => res.json({ batch: await service.resumeBatch(req.user, req.params.id, requestContext(req)) })));
  r.post('/batches/:id/cancel', requirePermission(P.CONTROL), wrap(async (req, res) => res.json({ batch: await service.cancelRemaining(req.user, req.params.id, requestContext(req)) })));
  r.post(
    '/batches/:id/retry-failed',
    requirePermission(P.RETRY),
    json,
    wrap(async (req, res) => res.json(await service.retryFailed(req.user, req.params.id, { recordIds: req.body && req.body.recordIds }, requestContext(req))))
  );

  // ---- live table / failed messages
  r.get(
    '/batches/:id/records',
    wrap(async (req, res) =>
      res.json(
        await service.listRecords(req.user, req.params.id, {
          ...pageParams(req),
          filter: req.query.filter ? String(req.query.filter) : null,
          q: req.query.q ? String(req.query.q).slice(0, 64) : null,
        })
      )
    )
  );
  r.get('/batches/:id/records/:recordId/attempts', wrap(async (req, res) => res.json(await service.recordLogs(req.user, req.params.id, req.params.recordId))));

  // ---- real-time progress (Server-Sent Events). Browser can close at any time; sending continues server-side.
  r.get(
    '/batches/:id/stream',
    wrap(async (req, res) => {
      const batch = await service.getVisibleBatch(req.user, req.params.id);
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      let last = null;
      let closed = false;
      let timer = null;
      const push = async () => {
        if (closed) return;
        try {
          const v = await service.batchVersion(batch.id);
          if (v !== last) {
            last = v;
            const summary = await service.getBatchForUser(req.user, batch.id);
            res.write(`event: summary\ndata: ${JSON.stringify(summary)}\n\n`);
          } else {
            res.write(': keep-alive\n\n');
          }
        } catch (err) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: 'update failed' })}\n\n`);
        }
        if (!closed) timer = setTimeout(push, 1000);
      };
      req.on('close', () => {
        closed = true;
        if (timer) clearTimeout(timer);
      });
      push();
    })
  );

  // ---- exports
  r.get(
    '/batches/:id/export.xlsx',
    requirePermission(P.EXPORT),
    wrap(async (req, res) => {
      const data = await service.allRecordsForExport(req.user, req.params.id);
      const wb = await buildResultsWorkbook(data);
      await auditExport(req, data.batch, 'xlsx');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${data.batch.batchNumber}-results.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    })
  );
  r.get(
    '/batches/:id/export.pdf',
    requirePermission(P.EXPORT),
    wrap(async (req, res) => {
      const data = await service.allRecordsForExport(req.user, req.params.id);
      await auditExport(req, data.batch, 'pdf');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${data.batch.batchNumber}-report.pdf"`);
      streamResultsPdf(data, res);
    })
  );

  function auditExport(req, batch, format) {
    return audit.log({
      actor: req.user,
      action: 'bulk.exported',
      description: `${req.user.username} exported ${batch.batchNumber} as ${format.toUpperCase()}`,
      batchId: batch.id,
      ctx: requestContext(req),
    });
  }

  // ---- global template (admin)
  r.get('/message-template', wrap(async (req, res) => res.json({ ...(await service.getGlobalTemplate()), defaultBody: DEFAULT_TEMPLATE, defaultBodyTe: DEFAULT_TEMPLATE_TE, variables: VARIABLES })));
  r.put(
    '/message-template',
    requirePermission(P.MANAGE_SETTINGS),
    json,
    wrap(async (req, res) => {
      const b = req.body || {};
      res.json(await service.updateGlobalTemplate(req.user, { body: str(b.body), bodyTe: str(b.bodyTe) }, requestContext(req)));
    })
  );

  // ---- consent / opt-outs (admin)
  r.get('/opt-outs', requirePermission(P.MANAGE_SETTINGS), wrap(async (req, res) => res.json({ optOuts: await service.listOptOuts() })));
  r.post(
    '/opt-outs',
    requirePermission(P.MANAGE_SETTINGS),
    json,
    wrap(async (req, res) => {
      const p = normalizePhone((req.body || {}).phoneNumber, { internationalEnabled: config.upload.internationalNumbersEnabled });
      if (!p.ok) throw new HttpError(400, p.reason);
      await service.addOptOut(p.value, 'manual', String((req.body || {}).reason || '').slice(0, 200), req.user.id);
      await audit.log({ actor: req.user, action: 'optout.added', description: `${req.user.username} added opt-out for ${p.value}`, ctx: requestContext(req) });
      res.status(201).json({ phoneNumber: p.value });
    })
  );
  r.delete(
    '/opt-outs/:phone',
    requirePermission(P.MANAGE_SETTINGS),
    wrap(async (req, res) => {
      const n = await service.removeOptOut(String(req.params.phone));
      await audit.log({ actor: req.user, action: 'optout.removed', description: `${req.user.username} removed opt-out for ${req.params.phone}`, ctx: requestContext(req) });
      res.json({ removed: n });
    })
  );

  return r;
}

function createAuditRouter({ service, auth }) {
  const r = express.Router();
  r.use(auth.authenticate, auth.requirePermission(P.VIEW_AUDIT));
  r.get(
    '/',
    wrap(async (req, res) =>
      res.json(await service.listAudit({ ...pageParams(req, 500), batchId: req.query.batchId, action: req.query.action ? String(req.query.action).slice(0, 64) : null }))
    )
  );
  return r;
}

module.exports = { createBulkRouter, createAuditRouter };
