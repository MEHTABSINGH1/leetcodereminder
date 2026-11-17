'use strict';

const { zonedParts, inWindow } = require('../lib/time');
const { callbackToken } = require('../lib/tokens');

/**
 * Background dispatcher. Each tick it:
 *   1. respects calling hours and the automation pause flag,
 *   2. computes capacity = min(free concurrency slots, per-minute rate budget),
 *   3. atomically claims that many due items from the DB queue,
 *   4. re-checks eligibility (opt-out / consent / solved) right before dialling,
 *   5. places calls one by one through the active provider.
 * A separate reconcile pass polls the provider for calls whose callback never arrived.
 */
function createCallWorker({ calls, students, assignments, settings, providers, config, logger, audit, now = () => new Date() }) {
  let timer = null;
  let running = false;
  let lastReconcile = 0;

  function urlsFor(queueId, providerName) {
    if (!config.publicBaseUrl) return {};
    const t = callbackToken(config.sessionSecret, queueId);
    const q = `q=${queueId}&t=${t}`;
    return {
      statusCallbackUrl: `${config.publicBaseUrl}/webhooks/${providerName}/status?${q}`,
      gatherUrl: `${config.publicBaseUrl}/webhooks/${providerName}/gather?${q}`,
    };
  }

  function activeProvider(s) {
    const p = providers.get(s.active_provider);
    if (!p.isConfigured()) return null;
    if (config.isTest && p.name !== 'mock') return null; // never dial real numbers from tests
    return p;
  }

  async function dispatch(item, provider, s) {
    // Last-moment eligibility check: things may have changed since the call was queued.
    if (item.student_id) {
      const st = students.get(item.student_id);
      const blocker = calls.contactBlocker(st, s);
      if (blocker) return calls.cancelClaimed(item, `Skipped before dialling: ${blocker}`);
      if (item.assignment_id && assignments.getProgressStatus(item.assignment_id, item.student_id) === 'solved') {
        return calls.cancelClaimed(item, 'Skipped before dialling: problem already solved');
      }
    }
    const urls = urlsFor(item.id, provider.name);
    try {
      const res = await provider.createCall({
        to: item.to,
        message: item.message,
        queueId: item.id,
        statusCallbackUrl: urls.statusCallbackUrl,
        gatherUrl: item.student_id ? urls.gatherUrl : undefined,
        optOutPrompt: Boolean(s.opt_out_prompt_enabled && item.student_id),
      });
      if (!res.providerCallId) throw new Error('Provider did not return a call id');
      calls.markDispatched(item.id, item.logId, res.providerCallId, res.providerStatus);
      if (res.status && res.status !== 'calling') {
        await handleStatus({ providerCallId: res.providerCallId, status: res.status, providerStatus: res.providerStatus });
      }
      logger.info('call dispatched', { queueId: item.id, attempt: item.attempts, provider: provider.name });
    } catch (err) {
      logger.warn('call dispatch failed', { queueId: item.id, provider: provider.name, error: err.message });
      calls.applyStatus({
        logId: item.logId,
        status: 'failed',
        errorCode: err.code || 'dispatch_error',
        errorMessage: err.message,
        retryable: err.retryable !== false,
      });
      audit?.log('system', 'provider_error', { queueId: item.id, provider: provider.name, code: err.code || null, error: err.message });
    }
  }

  async function handleStatus(update) {
    return calls.applyStatus(update);
  }

  async function tick() {
    if (running) return { skipped: 'busy' };
    running = true;
    try {
      const s = settings.getAll();
      const provider = activeProvider(s);
      if (!provider) return { skipped: 'provider_not_configured' };
      const local = zonedParts(now(), config.timezone);
      const withinHours = inWindow(local.minutes, s.calling_hours_start, s.calling_hours_end);
      const c = calls.counts();
      const capacity = Math.min(s.max_concurrent_calls - c.calling, s.calls_per_minute - c.startedLastMinute);
      if (capacity <= 0) return { dispatched: 0, reason: 'rate_limited' };
      const items = calls.claimDue({
        limit: capacity,
        includeScheduled: !s.automation_paused,
        onlyTest: !withinHours, // outside calling hours only admin test calls go out
        providerName: provider.name,
      });
      for (const item of items) await dispatch(item, provider, s);
      if (now().getTime() - lastReconcile > 60000) await reconcile();
      return { dispatched: items.length };
    } catch (err) {
      logger.error('worker tick failed', { error: err.message });
      return { error: err.message };
    } finally {
      running = false;
    }
  }

  /** Poll the provider for calls with no final callback; give up after stale_call_minutes. */
  async function reconcile() {
    lastReconcile = now().getTime();
    const s = settings.getAll();
    const items = calls.staleCalling(new Date(now().getTime() - 2 * 60000).toISOString());
    for (const item of items) {
      const stale = new Date(item.locked_at).getTime() < now().getTime() - s.stale_call_minutes * 60000;
      try {
        const st = await providers.get(item.provider).fetchCallStatus(item.provider_call_id);
        if (calls.TERMINAL.includes(st.status)) {
          calls.applyStatus({ providerCallId: item.provider_call_id, ...st });
          continue;
        }
      } catch (err) {
        logger.warn('status poll failed', { queueId: item.id, error: err.message });
      }
      if (stale) {
        calls.applyStatus({
          providerCallId: item.provider_call_id,
          status: 'failed',
          errorCode: 'no_final_status',
          errorMessage: `No final status received within ${s.stale_call_minutes} minutes`,
        });
      }
    }
  }

  return {
    tick,
    reconcile,
    handleStatus,
    start(intervalMs = 3000) {
      const recovered = calls.recoverInterrupted();
      if (recovered) logger.warn('recovered interrupted calls after restart', { count: recovered });
      providers.get('mock').setStatusHandler?.((u) => handleStatus(u));
      timer = setInterval(() => tick(), intervalMs);
      timer.unref?.();
      // Kick off reconciliation of in-flight calls right away after a restart.
      reconcile().catch((e) => logger.error('initial reconcile failed', { error: e.message }));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createCallWorker };
