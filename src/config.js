'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

function resolveDatabasePath(url) {
  if (!url) return path.join(ROOT, 'data', 'leetcode-reminder.db');
  if (url === ':memory:' || url === 'sqlite::memory:') return ':memory:';
  if (!url.startsWith('sqlite:')) {
    throw new Error(
      `Unsupported DATABASE_URL scheme "${url.split(':')[0]}:". This app uses SQLite, e.g. DATABASE_URL=sqlite:./data/leetcode-reminder.db`
    );
  }
  const p = url.slice('sqlite:'.length).replace(/^\/\//, '');
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** Build a config object from an env map (defaults to process.env). */
function buildConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const isTest = env.NODE_ENV === 'test';
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProd) throw new Error('SESSION_SECRET must be set in production');
    sessionSecret = crypto.randomBytes(32).toString('hex'); // ephemeral dev secret
  }
  return {
    root: ROOT,
    isProd,
    isTest,
    port: Number(env.PORT || 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    timezone: env.APP_TIMEZONE || 'Asia/Kolkata',
    mentorName: env.MENTOR_NAME || 'your mentor',
    databasePath: resolveDatabasePath(env.DATABASE_URL),
    admin: {
      username: env.ADMIN_USERNAME || 'admin',
      password: env.ADMIN_PASSWORD || '',
      passwordHash: env.ADMIN_PASSWORD_HASH || '',
    },
    sessionSecret,
    // Tests can never place real calls.
    callProvider: isTest ? 'mock' : (env.CALL_PROVIDER || 'mock').toLowerCase(),
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      phoneNumber: env.TWILIO_PHONE_NUMBER || '',
      voice: env.TWILIO_VOICE || 'Polly.Aditi',
      language: env.TWILIO_LANGUAGE || 'en-IN',
    },
    exotel: {
      apiKey: env.EXOTEL_API_KEY || '',
      apiToken: env.EXOTEL_API_TOKEN || '',
      accountSid: env.EXOTEL_ACCOUNT_SID || '',
      subdomain: env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
      callerId: env.EXOTEL_CALLER_ID || '',
      appId: env.EXOTEL_APP_ID || '',
    },
    mock: {
      outcome: env.MOCK_CALL_OUTCOME || 'completed',
    },
  };
}

module.exports = { loadEnvFile, buildConfig, resolveDatabasePath, ROOT };
