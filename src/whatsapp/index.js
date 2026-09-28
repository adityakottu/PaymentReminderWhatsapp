'use strict';

const { MetaCloudProvider } = require('./metaCloudProvider');
const { MockProvider } = require('./mockProvider');

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
    default:
      throw new Error(`Unknown WHATSAPP_PROVIDER "${whatsappConfig.provider}"`);
  }
}

module.exports = { createProvider };
