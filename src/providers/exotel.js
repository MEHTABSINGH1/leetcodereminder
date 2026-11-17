'use strict';

const { ProviderError } = require('./errors');

const STATUS_MAP = {
  queued: 'calling',
  ringing: 'calling',
  'in-progress': 'calling',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'cancelled',
};

/**
 * Exotel outbound calls (India).
 * Docs: https://developer.exotel.com/api/make-a-call-api
 *
 * Exotel does not accept inline TTS on the connect API. The call is connected to
 * a call flow (EXOTEL_APP_ID) whose Greeting applet is configured to read dynamic
 * text from GET {PUBLIC_BASE_URL}/webhooks/exotel/greeting - which returns the
 * personalised message for the CallSid. See README "Exotel setup".
 */
function createExotelProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const base = `https://${cfg.subdomain}/v1/Accounts/${encodeURIComponent(cfg.accountSid)}`;
  const authHeader = 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString('base64');

  async function request(method, path, form) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? form.toString() : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new ProviderError(`Exotel request failed: ${err.message}`, { retryable: true, code: 'network' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.RestException?.Message || res.statusText;
      throw new ProviderError(`Exotel error ${res.status}: ${msg}`, {
        code: String(body?.RestException?.Code || res.status),
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return body;
  }

  return {
    name: 'exotel',
    supportsOptOutKeypress: false,

    isConfigured() {
      return Boolean(cfg.apiKey && cfg.apiToken && cfg.accountSid && cfg.subdomain && cfg.callerId && cfg.appId);
    },

    async createCall({ to, queueId, statusCallbackUrl }) {
      const form = new URLSearchParams();
      form.set('From', to); // Exotel dials "From" first, then connects it to the flow
      form.set('CallerId', cfg.callerId);
      form.set('Url', `http://my.exotel.com/${cfg.accountSid}/exoml/start_voice/${cfg.appId}`);
      form.set('CallType', 'trans');
      form.set('TimeOut', '30');
      form.set('CustomField', String(queueId));
      if (statusCallbackUrl) {
        form.set('StatusCallback', statusCallbackUrl);
        form.set('StatusCallbackEvents[0]', 'terminal');
        form.set('StatusCallbackContentType', 'application/json');
      }
      const body = await request('POST', '/Calls/connect.json', form);
      const call = body.Call || {};
      return { providerCallId: call.Sid, status: STATUS_MAP[call.Status] || 'calling', providerStatus: call.Status };
    },

    async fetchCallStatus(providerCallId) {
      const body = await request('GET', `/Calls/${encodeURIComponent(providerCallId)}.json`);
      const call = body.Call || {};
      return {
        status: STATUS_MAP[call.Status] || 'calling',
        providerStatus: call.Status,
        durationSeconds: call.Duration != null ? Number(call.Duration) : null,
      };
    },

    parseStatusCallback(params) {
      const duration = params.ConversationDuration ?? params.Duration;
      return {
        providerCallId: params.CallSid,
        status: STATUS_MAP[params.Status] || 'calling',
        providerStatus: params.Status,
        durationSeconds: duration != null && duration !== '' ? Number(duration) : null,
        errorCode: null,
        errorMessage: null,
      };
    },
  };
}

module.exports = { createExotelProvider, EXOTEL_STATUS_MAP: STATUS_MAP };
