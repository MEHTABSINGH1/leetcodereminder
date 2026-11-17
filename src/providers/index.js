'use strict';

const { createTwilioProvider } = require('./twilio');
const { createExotelProvider } = require('./exotel');
const { createMockProvider } = require('./mock');

/**
 * Build all providers from config. Credentials stay inside the provider
 * objects and are never returned to callers or the browser.
 */
function createProviderRegistry(config, { fetchImpl, mockOptions } = {}) {
  const providers = {
    mock: createMockProvider({ outcome: config.mock.outcome, ...(mockOptions || {}) }),
    twilio: createTwilioProvider(config.twilio, { fetchImpl }),
    exotel: createExotelProvider(config.exotel, { fetchImpl }),
  };
  return {
    get(name) {
      const p = providers[name];
      if (!p) throw new Error(`Unknown call provider "${name}"`);
      return p;
    },
    all: providers,
    /** Public, non-secret status for the dashboard. */
    status() {
      return Object.fromEntries(
        Object.entries(providers).map(([name, p]) => [
          name,
          { configured: p.isConfigured(), realCalls: name !== 'mock', optOutKeypress: Boolean(p.supportsOptOutKeypress) },
        ])
      );
    },
  };
}

module.exports = { createProviderRegistry };
