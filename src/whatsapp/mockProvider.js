'use strict';

const crypto = require('crypto');
const { ERROR_KIND, ProviderSendError } = require('./provider');
const { MetaCloudProvider } = require('./metaCloudProvider');

/**
 * Mock provider for local development, demos and automated tests.
 * NEVER used in production (config validation refuses it).
 *
 * Default behaviour is driven by the last 3 digits of the recipient number so a
 * demo spreadsheet can exercise every path:
 *   ...000 -> NOT_ON_WHATSAPP (permanent)
 *   ...111 -> INVALID_NUMBER  (permanent)
 *   ...222 -> temporary failure on attempt 1, success afterwards
 *   ...333 -> temporary failure on every attempt (ends FAILED after max retries)
 *   ...444 -> rate limited on attempt 1, success afterwards
 *   ...555 -> timeout on attempt 1, success afterwards
 *   ...666 -> template/permanent provider error
 *   anything else -> accepted
 *
 * Tests can pass `script(to, attemptNumber, message)` returning one of
 * 'success' | ERROR_KIND values | { kind, code, message, delayMs } to fully control outcomes.
 *
 * Webhooks use the Meta payload format and X-Hub-Signature-256 signing so the
 * real webhook endpoint can be exercised end-to-end.
 */
class MockProvider {
  constructor({ script, latencyMs = 0, webhookSecret = 'mock-webhook-secret', verifyToken = 'mock-verify-token', simulateStatusCallbacks = false } = {}) {
    this.name = 'mock';
    this.script = script || defaultScript;
    this.latencyMs = latencyMs;
    this.webhookSecret = webhookSecret;
    this.verifyToken = verifyToken;
    this.simulateStatusCallbacks = simulateStatusCallbacks;
    this.attempts = new Map(); // to -> attempt count
    this.sent = []; // accepted messages
    this.calls = []; // every call
    this.statusListener = null;
    this.timers = new Set();
    this._meta = new MetaCloudProvider({ webhookSecret, webhookVerifyToken: verifyToken, templateParams: [] });
  }

  onStatus(fn) {
    this.statusListener = fn;
  }

  async sendMessage(msg) {
    const attempt = (this.attempts.get(msg.to) || 0) + 1;
    this.attempts.set(msg.to, attempt);
    this.calls.push({ ...msg, attempt, at: Date.now() });
    let outcome = this.script(msg.to, attempt, msg);
    if (outcome && typeof outcome.then === 'function') outcome = await outcome;
    const o = typeof outcome === 'string' ? { kind: outcome } : outcome || { kind: 'success' };
    const delay = o.delayMs !== undefined ? o.delayMs : this.latencyMs;
    if (delay) await new Promise((r) => setTimeout(r, delay));

    if (o.kind === 'success') {
      const providerMessageId = `wamid.MOCK${crypto.randomBytes(8).toString('hex')}`;
      this.sent.push({ ...msg, providerMessageId });
      if (this.simulateStatusCallbacks && this.statusListener) this._simulateCallbacks(providerMessageId, msg.idempotencyKey);
      return { providerMessageId };
    }
    const defaults = {
      [ERROR_KIND.NOT_ON_WHATSAPP]: { code: '131026', message: 'Message undeliverable – recipient is not reachable on WhatsApp' },
      [ERROR_KIND.INVALID_NUMBER]: { code: '100', message: 'Invalid parameter: recipient phone number is not valid' },
      [ERROR_KIND.OPTED_OUT]: { code: '131050', message: 'Recipient opted out' },
      [ERROR_KIND.PERMANENT]: { code: '132001', message: 'Template does not exist' },
      [ERROR_KIND.RATE_LIMITED]: { code: '130429', message: 'Rate limit hit', retryAfterMs: 0 },
      [ERROR_KIND.TRANSIENT]: { code: '131000', message: 'Something went wrong (temporary)' },
      [ERROR_KIND.TIMEOUT]: { code: null, message: 'Provider request timed out' },
    }[o.kind] || { code: null, message: 'Unknown error' };
    throw new ProviderSendError({
      kind: o.kind,
      code: o.code !== undefined ? o.code : defaults.code,
      message: o.message || defaults.message,
      retryAfterMs: o.retryAfterMs !== undefined ? o.retryAfterMs : defaults.retryAfterMs || null,
    });
  }

  _simulateCallbacks(id, callbackData) {
    const fire = (status, ms) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        Promise.resolve(
          this.statusListener({ providerMessageId: id, status, timestamp: new Date().toISOString(), callbackData })
        ).catch(() => {});
      }, ms);
      t.unref && t.unref();
      this.timers.add(t);
    };
    fire('delivered', 1500 + Math.random() * 2000);
    if (Math.random() < 0.6) fire('read', 5000 + Math.random() * 8000);
  }

  sign(rawBody) {
    return `sha256=${crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')}`;
  }

  verifyWebhookSignature(rawBody, headers) {
    return this._meta.verifyWebhookSignature(rawBody, headers);
  }

  handleVerificationChallenge(query) {
    return this._meta.handleVerificationChallenge(query);
  }

  parseWebhook(body) {
    return this._meta.parseWebhook(body);
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

function defaultScript(to, attempt) {
  const tail = String(to).slice(-3);
  switch (tail) {
    case '000':
      return ERROR_KIND.NOT_ON_WHATSAPP;
    case '111':
      return ERROR_KIND.INVALID_NUMBER;
    case '222':
      return attempt === 1 ? ERROR_KIND.TRANSIENT : 'success';
    case '333':
      return ERROR_KIND.TRANSIENT;
    case '444':
      return attempt === 1 ? ERROR_KIND.RATE_LIMITED : 'success';
    case '555':
      return attempt === 1 ? ERROR_KIND.TIMEOUT : 'success';
    case '666':
      return ERROR_KIND.PERMANENT;
    default:
      return 'success';
  }
}

module.exports = { MockProvider, defaultScript };
