'use strict';

const { MetaCloudProvider } = require('./metaCloudProvider');
const { MockProvider } = require('./mockProvider');
const { ERROR_KIND, ProviderSendError } = require('./provider');

/** Used when no WhatsApp provider is configured: nothing can be sent. */
class NotConfiguredProvider {
  constructor() {
    this.name = 'none';
  }

  async sendMessage() {
    throw new ProviderSendError({ kind: ERROR_KIND.PERMANENT, code: 'NOT_CONNECTED', message: 'WhatsApp is not connected on the server' });
  }

  verifyWebhookSignature() {
    return false;
  }

  handleVerificationChallenge() {
    return null;
  }

  parseWebhook() {
    return { statuses: [], optOuts: [] };
  }
}

/**
 * WhatsApp service factory. Application code depends only on the provider
 * contract (see ./provider.js), so switching to another approved provider
 * means adding one adapter here – nothing else changes.
 */
function createProvider(whatsappConfig) {
  switch (whatsappConfig.provider) {
    case 'meta_cloud':
      return new MetaCloudProvider(whatsappConfig);
    case 'mock':
      return new MockProvider({
        webhookSecret: whatsappConfig.webhookSecret || 'mock-webhook-secret',
        verifyToken: whatsappConfig.webhookVerifyToken || 'mock-verify-token',
        simulateStatusCallbacks: whatsappConfig.mockSimulateStatusCallbacks,
        latencyMs: 150,
      });
    case 'none':
    case '':
    case null:
    case undefined:
      return new NotConfiguredProvider();
    default:
      throw new Error(`Unknown WHATSAPP_PROVIDER "${whatsappConfig.provider}" (use meta_cloud, or mock for test mode)`);
  }
}

module.exports = { createProvider, NotConfiguredProvider };
