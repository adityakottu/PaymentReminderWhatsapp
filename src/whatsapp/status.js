'use strict';

/**
 * Is WhatsApp actually connected?
 *
 *   live            – a real provider (Meta Cloud API) with credentials: messages really go out
 *   test            – WHATSAPP_PROVIDER=mock: everything is SIMULATED, nothing is sent
 *   not_configured  – no provider / missing credentials: sending is blocked
 */
function connectionStatus(whatsappConfig, providerName) {
  const c = whatsappConfig;
  if (providerName === 'mock') {
    return {
      mode: 'test',
      provider: 'mock',
      canSend: true,
      missing: [],
      warnings: [],
      message: 'WhatsApp is NOT connected (WHATSAPP_PROVIDER=mock): messages are simulated and nobody receives them.',
    };
  }
  if (providerName === 'meta_cloud') {
    const missing = [];
    if (!c.apiToken) missing.push('WHATSAPP_API_TOKEN');
    if (!c.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
    const warnings = [];
    if (!c.businessAccountId) warnings.push('WHATSAPP_BUSINESS_ACCOUNT_ID is not set – templates cannot be checked');
    if (!c.webhookSecret) warnings.push('WHATSAPP_WEBHOOK_SECRET is not set – delivered/read/failed updates are rejected');
    if (!c.webhookVerifyToken) warnings.push('WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set – the webhook cannot be registered in Meta');
    if (missing.length) {
      return {
        mode: 'not_configured',
        provider: 'meta_cloud',
        canSend: false,
        missing,
        warnings,
        message: `WhatsApp is not connected: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing on the server.`,
      };
    }
    return { mode: 'live', provider: 'meta_cloud', canSend: true, missing: [], warnings, message: 'Connected to the WhatsApp Business Platform (Meta Cloud API).' };
  }
  return {
    mode: 'not_configured',
    provider: providerName || 'none',
    canSend: false,
    missing: ['WHATSAPP_PROVIDER'],
    warnings: [],
    message: 'WhatsApp is not connected. Set WHATSAPP_PROVIDER=meta_cloud and the WhatsApp credentials on the server.',
  };
}

module.exports = { connectionStatus };
