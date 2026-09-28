'use strict';

/**
 * Provider-neutral WhatsApp messaging contract.
 *
 * The application talks only to this interface (via WhatsAppService); concrete
 * providers (Meta WhatsApp Cloud API, a BSP such as Twilio/Gupshup, or the mock)
 * translate to and from their own wire formats and error codes.
 *
 * sendMessage({ to, text, variables, idempotencyKey })
 *   -> resolves { providerMessageId }
 *   -> rejects with ProviderSendError (never a raw error)
 *
 * verifyWebhookSignature(rawBody: Buffer, headers) -> boolean
 * handleVerificationChallenge(query) -> string | null
 * parseWebhook(body) -> { statuses: StatusEvent[], optOuts: string[] }
 *
 * StatusEvent = {
 *   providerMessageId, status: 'sent'|'delivered'|'read'|'failed',
 *   timestamp (ISO), callbackData (idempotency key echoed back, if supported),
 *   error?: { kind, code, message }
 * }
 */

/** Error categories. The worker decides what to do purely from `kind`. */
const ERROR_KIND = Object.freeze({
  INVALID_NUMBER: 'INVALID_NUMBER', // permanent – number is malformed / not a valid recipient
  NOT_ON_WHATSAPP: 'NOT_ON_WHATSAPP', // permanent – provider says recipient cannot receive WhatsApp
  OPTED_OUT: 'OPTED_OUT', // permanent – recipient opted out / blocked business messages
  PERMANENT: 'PERMANENT', // permanent – template/config/policy errors; no automatic retry
  RATE_LIMITED: 'RATE_LIMITED', // temporary – back off, then retry
  TRANSIENT: 'TRANSIENT', // temporary – provider 5xx / network error
  TIMEOUT: 'TIMEOUT', // temporary – request timed out (outcome unknown)
});

const RETRYABLE_KINDS = new Set([ERROR_KIND.RATE_LIMITED, ERROR_KIND.TRANSIENT, ERROR_KIND.TIMEOUT]);

class ProviderSendError extends Error {
  constructor({ kind, code = null, httpStatus = null, message, retryAfterMs = null, raw = null }) {
    super(message || kind);
    this.name = 'ProviderSendError';
    this.kind = kind;
    this.code = code === null || code === undefined ? null : String(code);
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
    this.raw = raw;
  }

  get retryable() {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

module.exports = { ERROR_KIND, RETRYABLE_KINDS, ProviderSendError };
