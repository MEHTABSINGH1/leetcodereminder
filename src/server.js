'use strict';

const { loadEnvFile, buildConfig } = require('./config');

loadEnvFile();
const config = buildConfig();
const { createApplication } = require('./app');

const ctx = createApplication(config);
const { app, worker, scheduler, logger, providers, settings } = ctx;

const active = settings.get('active_provider');
if (!providers.get(active).isConfigured()) {
  logger.warn('active call provider is not configured; calls will wait in the queue', { provider: active });
}
if (active === 'mock') logger.info('using MOCK call provider - no real phone calls will be placed');
if (!config.publicBaseUrl) logger.warn('PUBLIC_BASE_URL not set: provider status callbacks disabled, falling back to status polling');

worker.start(3000);
scheduler.start(30000);

const server = app.listen(config.port, () => {
  logger.info('LeetCode Reminder running', { url: `http://localhost:${config.port}`, timezone: config.timezone });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  worker.stop();
  scheduler.stop();
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
