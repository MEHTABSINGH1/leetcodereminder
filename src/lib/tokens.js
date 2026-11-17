'use strict';

const crypto = require('node:crypto');

/** Per-call callback token so webhook URLs can't be forged or replayed for other calls. */
function callbackToken(secret, queueId) {
  return crypto.createHmac('sha256', secret).update(`callback:${queueId}`).digest('hex').slice(0, 32);
}

function verifyCallbackToken(secret, queueId, token) {
  const expected = Buffer.from(callbackToken(secret, queueId));
  const got = Buffer.from(String(token || ''));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

module.exports = { callbackToken, verifyCallbackToken };
