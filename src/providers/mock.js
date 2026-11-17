'use strict';

const crypto = require('node:crypto');
const { ProviderError } = require('./errors');

const OUTCOMES = ['completed', 'no_answer', 'busy', 'failed'];

/**
 * Mock provider: never contacts a phone network. It simulates the provider
 * lifecycle and delivers status callbacks through `onStatus`, exercising the
 * same code paths as real webhooks.
 *
 * outcome: completed | no_answer | busy | failed | random | throw (provider API failure)
 */
function createMockProvider({ outcome = 'completed', delayMs = 1500, autoComplete = true } = {}) {
  const calls = [];
  let onStatus = null;
  let nextOutcome = outcome;

  const pick = () => (nextOutcome === 'random' ? OUTCOMES[crypto.randomInt(OUTCOMES.length)] : nextOutcome);

  return {
    name: 'mock',
    supportsOptOutKeypress: false,
    calls,

    isConfigured() {
      return true;
    },
    setStatusHandler(fn) {
      onStatus = fn;
    },
    setOutcome(o) {
      nextOutcome = o;
    },

    async createCall({ to, message, queueId }) {
      const result = pick();
      if (result === 'throw') {
        throw new ProviderError('Mock provider API failure', { code: 'mock_failure', retryable: true });
      }
      const providerCallId = `mock-${crypto.randomUUID()}`;
      const call = { providerCallId, to, message, queueId, outcome: result, status: 'calling' };
      calls.push(call);
      if (autoComplete && onStatus) {
        const t = setTimeout(() => {
          call.status = result;
          onStatus({
            providerCallId,
            status: result,
            providerStatus: `mock-${result}`,
            durationSeconds: result === 'completed' ? 15 + crypto.randomInt(30) : 0,
          }).catch(() => {});
        }, delayMs);
        t.unref?.();
      }
      return { providerCallId, status: 'calling', providerStatus: 'mock-initiated' };
    },

    async fetchCallStatus(providerCallId) {
      const call = calls.find((c) => c.providerCallId === providerCallId);
      if (!call) return { status: 'failed', providerStatus: 'mock-unknown', durationSeconds: null };
      return { status: call.status, providerStatus: `mock-${call.status}`, durationSeconds: call.status === 'completed' ? 20 : 0 };
    },

    parseStatusCallback(params) {
      return {
        providerCallId: params.providerCallId,
        status: params.status,
        providerStatus: params.providerStatus,
        durationSeconds: params.durationSeconds ?? null,
      };
    },
  };
}

module.exports = { createMockProvider };
