'use strict';

const crypto = require('node:crypto');
const { ProviderError } = require('./errors');

const STATUS_MAP = {
  queued: 'calling',
  initiated: 'calling',
  ringing: 'calling',
  'in-progress': 'calling',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'cancelled',
};

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

/**
 * Twilio Programmable Voice via REST (no SDK needed).
 * Docs: https://www.twilio.com/docs/voice/api/call-resource
 */
function createTwilioProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}`;
  const authHeader = 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');

  async function request(method, path, form) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          Authorization: authHeader,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? form.toString() : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new ProviderError(`Twilio request failed: ${err.message}`, { retryable: true, code: 'network' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ProviderError(`Twilio error ${body.code || res.status}: ${body.message || res.statusText}`, {
        code: String(body.code || res.status),
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return body;
  }

  return {
    name: 'twilio',
    supportsOptOutKeypress: true,

    isConfigured() {
      return Boolean(cfg.accountSid && cfg.authToken && cfg.phoneNumber);
    },

    buildTwiml({ message, gatherUrl, optOutPrompt }) {
      const say = (t) => `<Say voice="${xmlEscape(cfg.voice)}" language="${xmlEscape(cfg.language)}">${xmlEscape(t)}</Say>`;
      if (gatherUrl && optOutPrompt) {
        return (
          `<Response><Gather numDigits="1" timeout="5" method="POST" action="${xmlEscape(gatherUrl)}">` +
          say(message) +
          '<Pause length="1"/>' +
          say('To stop receiving these reminder calls, press 9.') +
          `</Gather>${say('Goodbye.')}</Response>`
        );
      }
      return `<Response>${say(message)}<Pause length="1"/>${say('Goodbye.')}</Response>`;
    },

    async createCall({ to, message, statusCallbackUrl, gatherUrl, optOutPrompt }) {
      const form = new URLSearchParams();
      form.set('To', to);
      form.set('From', cfg.phoneNumber);
      form.set('Twiml', this.buildTwiml({ message, gatherUrl, optOutPrompt }));
      form.set('Timeout', '30');
      if (statusCallbackUrl) {
        form.set('StatusCallback', statusCallbackUrl);
        form.set('StatusCallbackMethod', 'POST');
        for (const ev of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', ev);
      }
      const body = await request('POST', '/Calls.json', form);
      return { providerCallId: body.sid, status: STATUS_MAP[body.status] || 'calling', providerStatus: body.status };
    },

    async fetchCallStatus(providerCallId) {
      const body = await request('GET', `/Calls/${encodeURIComponent(providerCallId)}.json`);
      return {
        status: STATUS_MAP[body.status] || 'calling',
        providerStatus: body.status,
        durationSeconds: body.duration != null ? Number(body.duration) : null,
      };
    },

    parseStatusCallback(params) {
      return {
        providerCallId: params.CallSid,
        status: STATUS_MAP[params.CallStatus] || 'calling',
        providerStatus: params.CallStatus,
        durationSeconds: params.CallDuration != null ? Number(params.CallDuration) : null,
        errorCode: params.ErrorCode || null,
        errorMessage: params.ErrorMessage || null,
      };
    },

    /** Verify X-Twilio-Signature (HMAC-SHA1 over URL + sorted POST params). */
    validateSignature(url, params, signature) {
      if (!signature || !cfg.authToken) return false;
      const data = Object.keys(params)
        .sort()
        .reduce((acc, k) => acc + k + (Array.isArray(params[k]) ? params[k].join('') : params[k]), url);
      const expected = crypto.createHmac('sha1', cfg.authToken).update(Buffer.from(data, 'utf8')).digest('base64');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

module.exports = { createTwilioProvider, TWILIO_STATUS_MAP: STATUS_MAP, xmlEscape };
