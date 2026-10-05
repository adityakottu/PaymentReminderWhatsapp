'use strict';

const crypto = require('crypto');
const { ERROR_KIND, ProviderSendError } = require('./provider');

/**
 * Meta WhatsApp Business Platform – Cloud API provider.
 *
 * Docs:
 *   Send messages:   POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 *   Error codes:     https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *   Webhooks:        https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 *   Signature:       X-Hub-Signature-256: sha256=HMAC_SHA256(app_secret, raw_body)
 *
 * Business-initiated messages (a reminder to a customer who has not messaged
 * you in the last 24h) MUST use a pre-approved message template. That is the
 * default send mode here; "text" mode is only valid within a service window.
 */

// Error-code → category. Only codes Meta documents are listed; anything
// unknown falls back to the HTTP status (5xx/429 → temporary, 4xx → permanent).
const META_ERROR_MAP = {
  // Recipient cannot receive the message. Meta's documented reasons include
  // "the recipient phone number is not a WhatsApp phone number".
  131026: { kind: ERROR_KIND.NOT_ON_WHATSAPP, reason: 'Message undeliverable – recipient is not reachable on WhatsApp' },
  131050: { kind: ERROR_KIND.OPTED_OUT, reason: 'Recipient has stopped receiving these messages from the business' },
  131021: { kind: ERROR_KIND.INVALID_NUMBER, reason: 'Recipient cannot be the sender number' },
  131030: { kind: ERROR_KIND.PERMANENT, reason: 'Recipient not in allowed list (test number restrictions)' },
  131047: { kind: ERROR_KIND.PERMANENT, reason: 'Outside 24h window – an approved template is required' },
  131049: { kind: ERROR_KIND.PERMANENT, reason: 'Meta chose not to deliver this message (ecosystem engagement limits)' },
  131051: { kind: ERROR_KIND.PERMANENT, reason: 'Unsupported message type' },
  131008: { kind: ERROR_KIND.PERMANENT, reason: 'Required parameter missing' },
  131009: { kind: ERROR_KIND.PERMANENT, reason: 'Parameter value is not valid' },
  131031: { kind: ERROR_KIND.PERMANENT, reason: 'Business account locked' },
  131042: { kind: ERROR_KIND.PERMANENT, reason: 'Business eligibility / payment issue' },
  131045: { kind: ERROR_KIND.PERMANENT, reason: 'Sender phone number not registered' },
  133010: { kind: ERROR_KIND.PERMANENT, reason: 'Sender phone number not registered' },
  132000: { kind: ERROR_KIND.PERMANENT, reason: 'Template parameter count mismatch' },
  132001: { kind: ERROR_KIND.PERMANENT, reason: 'Template does not exist (name/language)' },
  132005: { kind: ERROR_KIND.PERMANENT, reason: 'Template text too long after parameters' },
  132007: { kind: ERROR_KIND.PERMANENT, reason: 'Template format character policy violated' },
  132012: { kind: ERROR_KIND.PERMANENT, reason: 'Template parameter format mismatch' },
  132015: { kind: ERROR_KIND.PERMANENT, reason: 'Template is paused' },
  132016: { kind: ERROR_KIND.PERMANENT, reason: 'Template is disabled' },
  190: { kind: ERROR_KIND.PERMANENT, reason: 'Access token expired or invalid' },
  0: { kind: ERROR_KIND.PERMANENT, reason: 'Authentication exception' },
  3: { kind: ERROR_KIND.PERMANENT, reason: 'API method capability/permission missing' },
  10: { kind: ERROR_KIND.PERMANENT, reason: 'Permission denied' },
  368: { kind: ERROR_KIND.PERMANENT, reason: 'Temporarily blocked for policy violations' },
  // Throughput / rate limits – back off and retry.
  4: { kind: ERROR_KIND.RATE_LIMITED, reason: 'Application request limit reached' },
  80007: { kind: ERROR_KIND.RATE_LIMITED, reason: 'WhatsApp Business Account rate limit reached' },
  130429: { kind: ERROR_KIND.RATE_LIMITED, reason: 'Cloud API throughput limit reached' },
  131048: { kind: ERROR_KIND.RATE_LIMITED, reason: 'Spam rate limit hit' },
  131056: { kind: ERROR_KIND.RATE_LIMITED, reason: 'Too many messages to this recipient (pair rate limit)' },
  // Temporary provider-side problems.
  1: { kind: ERROR_KIND.TRANSIENT, reason: 'Unknown API error' },
  2: { kind: ERROR_KIND.TRANSIENT, reason: 'API service temporarily unavailable' },
  131000: { kind: ERROR_KIND.TRANSIENT, reason: 'Something went wrong (provider)' },
  131016: { kind: ERROR_KIND.TRANSIENT, reason: 'Service overloaded / unavailable' },
  133004: { kind: ERROR_KIND.TRANSIENT, reason: 'Server temporarily unavailable' },
};

// Generic "invalid parameter" errors whose details point at the recipient number.
const RECIPIENT_HINT = /(phone|recipient|\bto\b|wa_id|msisdn)/i;

function classifyMetaError({ code, httpStatus, message, details }) {
  const numeric = code === null || code === undefined ? null : Number(code);
  const text = [message, details].filter(Boolean).join(' – ');
  if ((numeric === 100 || numeric === 131009) && RECIPIENT_HINT.test(text)) {
    return { kind: ERROR_KIND.INVALID_NUMBER, reason: text || 'Invalid recipient phone number' };
  }
  const mapped = numeric !== null ? META_ERROR_MAP[numeric] : undefined;
  if (mapped) return { kind: mapped.kind, reason: text ? `${mapped.reason}: ${text}` : mapped.reason };
  if (httpStatus === 429) return { kind: ERROR_KIND.RATE_LIMITED, reason: text || 'Rate limited' };
  if (httpStatus && httpStatus >= 500) return { kind: ERROR_KIND.TRANSIENT, reason: text || `Provider HTTP ${httpStatus}` };
  if (numeric === 100) return { kind: ERROR_KIND.PERMANENT, reason: text || 'Invalid parameter' };
  if (httpStatus && httpStatus >= 400) return { kind: ERROR_KIND.PERMANENT, reason: text || `Provider HTTP ${httpStatus}` };
  return { kind: ERROR_KIND.TRANSIENT, reason: text || 'Unknown provider error' };
}

class MetaCloudProvider {
  constructor(cfg, { fetchImpl } = {}) {
    this.name = 'meta_cloud';
    this.cfg = cfg;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  /** Approved template (name, language code, body parameters) for a message language. */
  templateFor(language) {
    const c = this.cfg;
    if (language === 'te') return { name: c.templateNameTe || c.templateName, code: c.templateLanguageTe || 'te', params: c.templateParams };
    if (language === 'both') {
      return { name: c.templateNameBoth || c.templateName, code: c.templateLanguageBoth || c.templateLanguage, params: c.templateParamsBoth || c.templateParams };
    }
    return { name: c.templateName, code: c.templateLanguage, params: c.templateParams };
  }

  buildPayload({ to, text, variables, idempotencyKey, language }) {
    const base = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      // Echoed back in status webhooks – lets us reconcile a message even if
      // the worker crashed before storing the provider message id.
      biz_opaque_callback_data: idempotencyKey,
    };
    if (this.cfg.sendMode === 'text') {
      return { ...base, type: 'text', text: { preview_url: false, body: text } };
    }
    const tpl = this.templateFor(language || 'en');
    const parameters = (tpl.params || []).map((name) => {
      const v = variables && variables[name] !== undefined && variables[name] !== null ? String(variables[name]).trim() : '';
      // Template parameters may not be empty and may not contain newlines/tabs or 4+ consecutive spaces.
      return { type: 'text', text: (v || '-').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 1024) };
    });
    return {
      ...base,
      type: 'template',
      template: {
        name: tpl.name,
        language: { code: tpl.code },
        components: parameters.length ? [{ type: 'body', parameters }] : [],
      },
    };
  }

  async sendMessage(msg) {
    const url = `${this.cfg.apiBaseUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPayload(msg)),
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ProviderSendError({ kind: ERROR_KIND.TIMEOUT, message: `Provider request timed out after ${this.cfg.requestTimeoutMs}ms` });
      }
      throw new ProviderSendError({ kind: ERROR_KIND.TRANSIENT, message: `Network error: ${err && err.message}` });
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }

    if (res.ok && body && Array.isArray(body.messages) && body.messages[0] && body.messages[0].id) {
      return { providerMessageId: body.messages[0].id, waId: body.contacts && body.contacts[0] && body.contacts[0].wa_id };
    }

    const err = (body && body.error) || {};
    const code = err.code !== undefined ? err.code : null;
    const details = err.error_data && err.error_data.details;
    const { kind, reason } = classifyMetaError({ code, httpStatus: res.status, message: err.message, details });
    const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    throw new ProviderSendError({
      kind,
      code: code !== null ? code : `HTTP_${res.status}`,
      httpStatus: res.status,
      message: reason,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      raw: body,
    });
  }

  /** GET a Graph API resource with the configured token; throws a readable error. */
  async _graphGet(pathAndQuery) {
    const url = `${this.cfg.apiBaseUrl.replace(/\/$/, '')}/${this.cfg.apiVersion}/${pathAndQuery}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    let res;
    try {
      res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.cfg.apiToken}` }, signal: controller.signal });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError' ? 'Meta did not respond in time' : `Cannot reach Meta: ${err && err.message}`);
    } finally {
      clearTimeout(timer);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (body && body.error) || {};
      const { reason } = classifyMetaError({ code: e.code, httpStatus: res.status, message: e.message, details: e.error_data && e.error_data.details });
      throw new Error(`${reason}${e.code !== undefined ? ` (code ${e.code})` : ''}`);
    }
    return body;
  }

  /**
   * Check the real WhatsApp connection without sending anything: the access token and
   * sender number, and that each message template exists and is APPROVED.
   */
  async checkConnection() {
    const c = this.cfg;
    const checks = [];
    try {
      const p = await this._graphGet(`${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`);
      checks.push({
        key: 'phone_number',
        ok: true,
        required: true,
        label: 'Access token and sender phone number',
        detail: `${p.display_phone_number || '?'} · ${p.verified_name || 'no verified name'}${p.quality_rating ? ` · quality ${p.quality_rating}` : ''}`,
      });
    } catch (err) {
      checks.push({ key: 'phone_number', ok: false, required: true, label: 'Access token and sender phone number', detail: err.message });
    }

    if (c.sendMode === 'text') {
      checks.push({ key: 'templates', ok: true, required: false, label: 'Message templates', detail: 'Send mode is "text" – free text only works within 24h of the customer messaging you' });
      return { checks };
    }
    const wanted = [
      { use: 'English', name: c.templateName, code: c.templateLanguage, required: true },
      { use: 'Telugu', name: c.templateNameTe || c.templateName, code: c.templateLanguageTe || 'te', required: false },
      { use: 'English + Telugu', name: c.templateNameBoth || c.templateName, code: c.templateLanguageBoth || c.templateLanguage, required: false },
    ];
    if (!c.businessAccountId) {
      for (const w of wanted) {
        checks.push({ key: `template_${w.use}`, ok: false, required: w.required, label: `Template for ${w.use}: ${w.name} (${w.code})`, detail: 'Set WHATSAPP_BUSINESS_ACCOUNT_ID to check templates' });
      }
      return { checks };
    }
    const byName = new Map();
    for (const name of new Set(wanted.map((w) => w.name))) {
      try {
        const res = await this._graphGet(`${encodeURIComponent(c.businessAccountId)}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status,category&limit=100`);
        byName.set(name, { list: (res && res.data) || [] });
      } catch (err) {
        byName.set(name, { error: err.message });
      }
    }
    for (const w of wanted) {
      const found = byName.get(w.name);
      const label = `Template for ${w.use}: ${w.name} (${w.code})`;
      if (found.error) {
        checks.push({ key: `template_${w.use}`, ok: false, required: w.required, label, detail: found.error });
        continue;
      }
      const t = found.list.find((x) => x.name === w.name && x.language === w.code);
      checks.push({
        key: `template_${w.use}`,
        ok: !!t && t.status === 'APPROVED',
        required: w.required,
        label,
        detail: t ? `${t.status}${t.category ? ` · ${t.category}` : ''}` : `Not found in WhatsApp Manager${w.required ? '' : ` – only needed to send ${w.use} reminders`}`,
      });
    }
    return { checks };
  }

  verifyWebhookSignature(rawBody, headers) {
    const secret = this.cfg.webhookSecret;
    const header = headers['x-hub-signature-256'];
    if (!secret || !header || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    let given;
    try {
      given = Buffer.from(header.slice(7), 'hex');
    } catch (_) {
      return false;
    }
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  handleVerificationChallenge(query) {
    if (
      query['hub.mode'] === 'subscribe' &&
      this.cfg.webhookVerifyToken &&
      typeof query['hub.verify_token'] === 'string' &&
      safeEqual(query['hub.verify_token'], this.cfg.webhookVerifyToken)
    ) {
      return String(query['hub.challenge'] || '');
    }
    return null;
  }

  parseWebhook(body) {
    const statuses = [];
    const optOuts = [];
    for (const entry of (body && body.entry) || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const s of value.statuses || []) {
          const ev = {
            providerMessageId: s.id,
            status: s.status,
            timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : new Date().toISOString(),
            callbackData: s.biz_opaque_callback_data || null,
            recipient: s.recipient_id || null,
          };
          if (s.status === 'failed') {
            const e = (s.errors && s.errors[0]) || {};
            const { kind, reason } = classifyMetaError({
              code: e.code,
              message: e.title || e.message,
              details: e.error_data && e.error_data.details,
            });
            ev.error = { kind, code: e.code !== undefined ? String(e.code) : null, message: reason };
          }
          statuses.push(ev);
        }
        // Consent: honour STOP / UNSUBSCRIBE replies.
        for (const m of value.messages || []) {
          const txt = m.type === 'text' && m.text && m.text.body;
          if (txt && /^\s*(stop|unsubscribe|opt ?out)\s*$/i.test(txt) && m.from) optOuts.push(String(m.from));
        }
      }
    }
    return { statuses, optOuts };
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { MetaCloudProvider, classifyMetaError, META_ERROR_MAP };
