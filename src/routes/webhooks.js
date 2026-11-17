'use strict';

const express = require('express');
const { verifyCallbackToken } = require('../lib/tokens');
const { xmlEscape } = require('../providers/twilio');

/**
 * Provider callbacks. These are public endpoints, so each request must carry the
 * per-call HMAC token (q + t query params) and, for Twilio, a valid X-Twilio-Signature.
 */
function createWebhookRouter({ db, calls, students, providers, config, audit, logger }) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false, limit: '50kb' }));
  r.use(express.json({ limit: '50kb' }));

  function authorise(req, res) {
    const queueId = Number(req.query.q);
    if (!Number.isInteger(queueId) || !verifyCallbackToken(config.sessionSecret, queueId, req.query.t)) {
      res.status(403).end();
      return null;
    }
    const item = calls.getQueueItem(queueId);
    if (!item) {
      res.status(404).end();
      return null;
    }
    return item;
  }

  function twilioSignatureOk(req) {
    const url = `${config.publicBaseUrl}${req.originalUrl}`;
    return providers.get('twilio').validateSignature(url, req.body || {}, req.get('x-twilio-signature'));
  }

  /** The callback's call id must belong to the queue item named in the signed URL. */
  function belongsTo(item, providerCallId) {
    return Boolean(db.prepare('SELECT 1 FROM call_logs WHERE queue_id = ? AND provider_call_id = ?').get(item.id, String(providerCallId || '')));
  }

  r.post('/twilio/status', (req, res) => {
    const item = authorise(req, res);
    if (!item) return;
    if (!twilioSignatureOk(req)) return res.status(403).end();
    const update = providers.get('twilio').parseStatusCallback(req.body || {});
    if (!belongsTo(item, update.providerCallId)) return res.status(404).end();
    const out = calls.applyStatus(update);
    logger.info('twilio status', { queueId: item.id, status: update.status, result: out.updated || out.ignored });
    res.status(204).end();
  });

  r.post('/twilio/gather', (req, res) => {
    const item = authorise(req, res);
    if (!item) return;
    if (!twilioSignatureOk(req)) return res.status(403).end();
    res.type('text/xml');
    const voice = `voice="${xmlEscape(config.twilio.voice)}" language="${xmlEscape(config.twilio.language)}"`;
    if (String(req.body?.Digits) === '9' && item.student_id) {
      students.setPreferences(item.student_id, { opted_out: true }, 'phone_keypad');
      audit.log('student', 'opt_out_keypad', { studentId: item.student_id, queueId: item.id });
      return res.send(`<Response><Say ${voice}>You have been unsubscribed from reminder calls. Goodbye.</Say></Response>`);
    }
    res.send(`<Response><Say ${voice}>Thank you. Goodbye.</Say></Response>`);
  });

  r.post('/exotel/status', (req, res) => {
    const item = authorise(req, res);
    if (!item) return;
    const update = providers.get('exotel').parseStatusCallback(req.body || {});
    if (!belongsTo(item, update.providerCallId)) return res.status(404).end();
    calls.applyStatus(update);
    res.status(204).end();
  });

  /**
   * Exotel Greeting applet ("dynamic text from URL"). Returns the personalised message
   * only for a call that is currently in progress, identified by its unguessable CallSid.
   */
  r.get('/exotel/greeting', (req, res) => {
    const sid = String(req.query.CallSid || '');
    const log = sid
      ? db.prepare("SELECT message FROM call_logs WHERE provider_call_id = ? AND provider = 'exotel' AND status = 'calling'").get(sid)
      : null;
    res.type('text/plain');
    if (!log) return res.status(404).send('Hello. This is your LeetCode reminder. Please complete today\'s problem.');
    res.send(log.message);
  });

  return r;
}

module.exports = { createWebhookRouter };
