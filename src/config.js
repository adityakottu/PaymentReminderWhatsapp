'use strict';

require('dotenv').config();

function int(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number (got "${raw}")`);
  return n;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function str(name, def) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
}

function list(name, def) {
  const raw = str(name, null);
  if (raw === null) return def;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the runtime configuration. Accepts overrides so tests can create
 * isolated configurations without mutating process.env.
 */
function loadConfig(overrides = {}) {
  const env = str('NODE_ENV', 'development');
  const config = {
    env,
    port: int('PORT', 3000),
    trustProxy: bool('TRUST_PROXY', false),

    database: {
      client: str('DATABASE_CLIENT', 'better-sqlite3'),
      url: str('DATABASE_URL', null),
      sqliteFilename: str('SQLITE_FILENAME', './data/app.sqlite'),
    },

    auth: {
      jwtSecret: str('JWT_SECRET', env === 'production' ? null : 'dev-only-insecure-secret-change-me'),
      sessionTtlHours: int('SESSION_TTL_HOURS', 12),
      cookieSecure: bool('COOKIE_SECURE', env === 'production'),
    },

    whatsapp: {
      provider: str('WHATSAPP_PROVIDER', 'mock'),
      apiToken: str('WHATSAPP_API_TOKEN', null),
      phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID', null),
      businessAccountId: str('WHATSAPP_BUSINESS_ACCOUNT_ID', null),
      apiBaseUrl: str('WHATSAPP_API_BASE_URL', 'https://graph.facebook.com'),
      apiVersion: str('WHATSAPP_API_VERSION', 'v21.0'),
      webhookSecret: str('WHATSAPP_WEBHOOK_SECRET', null),
      webhookVerifyToken: str('WHATSAPP_WEBHOOK_VERIFY_TOKEN', null),
      // "template" = pre-approved WhatsApp template (required for business-initiated messages).
      // "text" = free-form text (only allowed inside a 24h customer service window).
      sendMode: str('WHATSAPP_SEND_MODE', 'template'),
      templateName: str('WHATSAPP_TEMPLATE_NAME', 'payment_reminder'),
      templateLanguage: str('WHATSAPP_TEMPLATE_LANGUAGE', 'en'),
      templateParams: list('WHATSAPP_TEMPLATE_PARAMS', ['customer_name', 'amount_due', 'due_date', 'account_id']),
      // Approved templates for Telugu and bilingual (English + Telugu) messages.
      // Meta lets one template name carry several language translations, so Telugu
      // defaults to the same name with language code "te".
      templateNameTe: str('WHATSAPP_TEMPLATE_NAME_TE', str('WHATSAPP_TEMPLATE_NAME', 'payment_reminder')),
      templateLanguageTe: str('WHATSAPP_TEMPLATE_LANGUAGE_TE', 'te'),
      templateNameBoth: str('WHATSAPP_TEMPLATE_NAME_BOTH', 'payment_reminder_bilingual'),
      templateLanguageBoth: str('WHATSAPP_TEMPLATE_LANGUAGE_BOTH', 'en'),
      templateParamsBoth: list('WHATSAPP_TEMPLATE_PARAMS_BOTH', null),
      requestTimeoutMs: int('WHATSAPP_REQUEST_TIMEOUT_MS', 15000),
      mockSimulateStatusCallbacks: bool('MOCK_SIMULATE_STATUS_CALLBACKS', true),
    },

    queue: {
      // Total delivery attempts per recipient (attempt 1 + retries) before FINAL failure.
      maxRetries: int('MAX_RETRIES', 3),
      retryBaseDelayMs: int('RETRY_BASE_DELAY_MS', 30000),
      retryMaxDelayMs: int('RETRY_MAX_DELAY_MS', 15 * 60 * 1000),
      concurrency: int('WORKER_CONCURRENCY', 5),
      pollIntervalMs: int('WORKER_POLL_INTERVAL_MS', 1000),
      leaseMs: int('WORKER_LEASE_MS', 2 * 60 * 1000),
      // Messages per second this worker process may submit to the provider.
      sendRatePerSecond: int('SEND_RATE_PER_SECOND', 10),
      // How long to wait for a provider webhook before giving up on a message
      // whose outcome is unknown because a worker crashed mid-request.
      reconcileWindowMs: int('RECONCILE_WINDOW_MS', 15 * 60 * 1000),
      runInProcess: bool('RUN_WORKER_IN_PROCESS', true),
    },

    reminders: {
      duplicateWindowHours: int('DUPLICATE_WINDOW_HOURS', 24),
      reminderType: 'PAYMENT_REMINDER',
    },

    upload: {
      maxFileMb: int('MAX_UPLOAD_MB', 5),
      maxRows: int('MAX_ROWS', 10000),
      internationalNumbersEnabled: bool('INTERNATIONAL_NUMBERS_ENABLED', false),
      defaultCountryCode: str('DEFAULT_COUNTRY_CODE', '91'),
    },

    audit: {
      captureIp: bool('AUDIT_CAPTURE_IP', true),
    },
  };

  return deepMerge(config, overrides);
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function assertProductionConfig(config) {
  const problems = [];
  if (!config.auth.jwtSecret || config.auth.jwtSecret.length < 32) problems.push('JWT_SECRET must be set (>= 32 chars)');
  if (config.whatsapp.provider === 'meta_cloud') {
    for (const [key, val] of [
      ['WHATSAPP_API_TOKEN', config.whatsapp.apiToken],
      ['WHATSAPP_PHONE_NUMBER_ID', config.whatsapp.phoneNumberId],
      ['WHATSAPP_BUSINESS_ACCOUNT_ID', config.whatsapp.businessAccountId],
      ['WHATSAPP_WEBHOOK_SECRET', config.whatsapp.webhookSecret],
      ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', config.whatsapp.webhookVerifyToken],
    ]) {
      if (!val) problems.push(`${key} is required when WHATSAPP_PROVIDER=meta_cloud`);
    }
  }
  if (config.env === 'production' && config.whatsapp.provider === 'mock') {
    problems.push('WHATSAPP_PROVIDER=mock is not allowed in production');
  }
  return problems;
}

module.exports = { loadConfig, assertProductionConfig };
