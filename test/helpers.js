'use strict';

const { buildConfig } = require('../src/config');
const { createApplication } = require('../src/app');

// 10:30 AM IST on a Tuesday.
const DEFAULT_NOW = '2026-11-17T05:00:00.000Z';

/**
 * Build an isolated app instance: in-memory DB, fake clock, mock provider that does
 * NOT auto-complete (tests drive status updates explicitly). No real calls, ever.
 */
function makeCtx({ now = DEFAULT_NOW, env = {}, leetcodeFetch, fetchImpl } = {}) {
  const clock = { t: new Date(now) };
  const config = buildConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    SESSION_SECRET: 'test-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'correct horse battery',
    MENTOR_NAME: 'Mentor Mehtab',
    ...env,
  });
  const ctx = createApplication(config, {
    now: () => clock.t,
    mockOptions: { autoComplete: false },
    leetcodeFetch: leetcodeFetch || (async () => ({ ok: true, json: async () => ({ data: { recentSubmissionList: [] } }) })),
    fetchImpl,
  });
  ctx.clock = clock;
  ctx.advance = (ms) => (clock.t = new Date(clock.t.getTime() + ms));
  ctx.setTime = (iso) => (clock.t = new Date(iso));
  ctx.mock = ctx.providers.get('mock');
  // Generous calling hours unless a test narrows them.
  ctx.settings.update({ calling_hours_start: '08:00', calling_hours_end: '23:00' });
  return ctx;
}

function addStudent(ctx, name, phone, extra = {}) {
  return ctx.students.create({ name, phone, consent_status: 'granted', ...extra });
}

/** Deliver the mock provider's final status for every in-flight call. */
async function completeAll(ctx, status = 'completed', durationSeconds = 25) {
  for (const c of ctx.mock.calls.filter((c) => c.status === 'calling')) {
    c.status = status;
    await ctx.worker.handleStatus({ providerCallId: c.providerCallId, status, providerStatus: `mock-${status}`, durationSeconds });
  }
}

module.exports = { makeCtx, addStudent, completeAll, DEFAULT_NOW };
