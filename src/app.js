'use strict';

const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const { createLogger } = require('./lib/logger');
const { createAuth } = require('./auth');
const { createSettingsService } = require('./services/settings');
const { createAuditService } = require('./services/audit');
const { createStudentService } = require('./services/students');
const { createAssignmentService } = require('./services/assignments');
const { createCallService } = require('./services/calls');
const { createLeetcodeSync } = require('./services/leetcodeSync');
const { createProviderRegistry } = require('./providers');
const { createCallWorker } = require('./workers/callWorker');
const { createScheduler } = require('./workers/scheduler');
const { createApiRouter } = require('./routes/api');
const { createWebhookRouter } = require('./routes/webhooks');

/**
 * Wire everything together. Options allow tests to inject an in-memory DB,
 * a fake clock, a fake fetch and a non-auto-completing mock provider.
 */
function createApplication(config, opts = {}) {
  const now = opts.now || (() => new Date());
  const logger = opts.logger || createLogger({ silent: config.isTest });
  const db = opts.db || openDatabase(config.databasePath, { active_provider: config.callProvider });

  const settings = createSettingsService(db);
  const audit = createAuditService(db, logger);
  const students = createStudentService(db);
  const assignments = createAssignmentService(db, { timezone: config.timezone, now });
  const calls = createCallService(db, { settings, students, assignments, config, now });
  const providers = opts.providers || createProviderRegistry(config, { fetchImpl: opts.fetchImpl, mockOptions: opts.mockOptions });
  const leetcodeSync = createLeetcodeSync({
    assignments,
    timezone: config.timezone,
    logger,
    fetchImpl: opts.leetcodeFetch || globalThis.fetch,
  });
  const worker = createCallWorker({ calls, students, assignments, settings, providers, config, logger, audit, now });
  const scheduler = createScheduler({ db, calls, assignments, settings, leetcodeSync, config, logger, audit, now });
  const auth = createAuth(config);

  const ctx = { db, config, logger, settings, audit, students, assignments, calls, providers, leetcodeSync, worker, scheduler, auth };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/webhooks', createWebhookRouter(ctx));
  app.use('/api', express.json({ limit: '8mb' }), createApiRouter(ctx));
  app.use(express.static(path.join(config.root, 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error('request failed', { path: req.path, error: err.message });
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return { app, ...ctx };
}

module.exports = { createApplication };
