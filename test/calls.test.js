'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, addStudent, completeAll } = require('./helpers');

function setup() {
  const ctx = makeCtx();
  const rahul = addStudent(ctx, 'Rahul', '9876543210', { squad: 'Alpha' });
  const aman = addStudent(ctx, 'Aman', '9876543211', { squad: 'Beta' });
  const priya = addStudent(ctx, 'Priya', '9876543212', { squad: 'Alpha' });
  const twoSum = ctx.assignments.create({ problem_title: 'Two Sum', difficulty: 'Easy' });
  return { ctx, rahul, aman, priya, twoSum };
}

const enqueue = (ctx, studentId, extra = {}) =>
  ctx.calls.enqueue({ studentId, templateType: 'pending_reminder', source: 'manual', createdBy: 'test', ...extra });

test('individual call: personalised message is spoken and status/duration tracked', async () => {
  const { ctx, rahul } = setup();
  const r = enqueue(ctx, rahul.id, { templateType: 'first_reminder' });
  assert.ok(r.queued);
  assert.match(r.queued.message, /^Hello Rahul\. This is your daily coding reminder from Mentor Mehtab\. Your problem for today is Two Sum\. Difficulty level: Easy\. Your deadline is 11:59 PM today\./);

  const tick = await ctx.worker.tick();
  assert.equal(tick.dispatched, 1);
  assert.equal(ctx.mock.calls[0].to, '+919876543210');
  assert.equal(ctx.mock.calls[0].message, r.queued.message);
  assert.equal(ctx.calls.getQueueItem(r.queued.id).status, 'calling');

  await completeAll(ctx, 'completed', 42);
  const item = ctx.calls.getQueueItem(r.queued.id);
  assert.equal(item.status, 'completed');
  assert.equal(item.duration_seconds, 42);
  const logs = ctx.calls.logsFor(item.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].duration_seconds, 42);

  const dash = ctx.calls.dashboard();
  assert.equal(dash.stats.total_calls_today, 1);
  assert.equal(dash.stats.successful_calls, 1);
  assert.equal(dash.stats.students_not_contacted, 2);
});

test('pending student identification excludes solved students and respects squads/audiences', () => {
  const { ctx, rahul, aman, priya, twoSum } = setup();
  ctx.assignments.setProgress(twoSum.id, aman.id, 'solved');
  ctx.assignments.setProgress(twoSum.id, priya.id, 'attempted');
  const names = (rows) => rows.map((r) => r.student_name).sort();
  assert.deepEqual(names(ctx.assignments.findTargets({ audience: 'unsolved' })), ['Priya', 'Rahul']);
  assert.deepEqual(names(ctx.assignments.findTargets({ audience: 'not_started' })), ['Rahul']);
  assert.deepEqual(names(ctx.assignments.findTargets({ audience: 'unsolved', squad: 'Beta' })), []);

  // Squad-specific assignment only targets that squad.
  ctx.assignments.create({ problem_title: 'Valid Parentheses', squad: 'Beta' });
  const t = ctx.assignments.findTargets({ audience: 'unsolved' }).filter((r) => r.problem_title === 'Valid Parentheses');
  assert.deepEqual(t.map((r) => r.student_id), [aman.id]);

  // Overdue: after the deadline passes, Two Sum moves to the overdue audience.
  ctx.setTime('2026-11-18T04:00:00.000Z');
  assert.deepEqual(names(ctx.assignments.findTargets({ audience: 'overdue' }).filter((r) => r.problem_title === 'Two Sum')), ['Priya', 'Rahul']);
  assert.equal(rahul.id > 0, true);
});

test('never calls a student who already solved the problem', async () => {
  const { ctx, aman, rahul, twoSum } = setup();
  ctx.assignments.setProgress(twoSum.id, aman.id, 'solved');
  assert.equal(enqueue(ctx, aman.id, { assignmentId: twoSum.id }).skipped, 'already_solved');
  assert.equal(enqueue(ctx, aman.id).skipped, 'no_pending_assignment');

  // Solved after being queued: queued call is cancelled immediately.
  const r = enqueue(ctx, rahul.id);
  ctx.assignments.setProgress(twoSum.id, rahul.id, 'solved');
  assert.equal(ctx.calls.getQueueItem(r.queued.id).status, 'cancelled');
  await ctx.worker.tick();
  assert.equal(ctx.mock.calls.length, 0);
});

test('re-checks eligibility right before dialling', async () => {
  const { ctx, rahul, twoSum } = setup();
  const r = enqueue(ctx, rahul.id);
  // Simulate progress written directly (e.g. by another process) without the cancel hook.
  ctx.db.prepare("INSERT INTO assignment_progress (assignment_id, student_id, status, updated_at) VALUES (?, ?, 'solved', ?)").run(twoSum.id, rahul.id, new Date().toISOString());
  await ctx.worker.tick();
  assert.equal(ctx.mock.calls.length, 0);
  const item = ctx.calls.getQueueItem(r.queued.id);
  assert.equal(item.status, 'cancelled');
  assert.match(item.last_error, /already solved/);
});

test('duplicate call prevention: active-call guard and idempotency keys', async () => {
  const { ctx, rahul, aman } = setup();
  assert.ok(enqueue(ctx, rahul.id).queued);
  assert.equal(enqueue(ctx, rahul.id).skipped, 'already_queued');

  const key = 'sched:1:2026-11-17:aman';
  assert.ok(enqueue(ctx, aman.id, { idempotencyKey: key }).queued);
  await ctx.worker.tick();
  await completeAll(ctx);
  // Same key after the first call finished: still refused.
  assert.equal(enqueue(ctx, aman.id, { idempotencyKey: key }).skipped, 'duplicate');
  // Automated calls respect the minimum gap between calls.
  assert.equal(enqueue(ctx, aman.id, { enforceGap: true }).skipped, 'called_recently');
});

test('opt-out and consent: never call opted-out or non-consenting students', async () => {
  const { ctx, rahul, aman } = setup();
  const r = enqueue(ctx, rahul.id);
  ctx.students.setPreferences(rahul.id, { opted_out: true }, 'test');
  assert.equal(ctx.calls.getQueueItem(r.queued.id).status, 'cancelled', 'opting out cancels queued calls');
  assert.equal(enqueue(ctx, rahul.id).skipped, 'opted_out');

  ctx.students.setPreferences(aman.id, { consent_status: 'pending' }, 'test');
  assert.equal(enqueue(ctx, aman.id).skipped, 'consent_not_granted');
  ctx.settings.update({ require_consent: false });
  assert.ok(enqueue(ctx, aman.id).queued, 'pending consent allowed when consent not required');
  ctx.students.setPreferences(aman.id, { consent_status: 'revoked' }, 'test');
  assert.equal(enqueue(ctx, aman.id).skipped, 'consent_revoked');

  await ctx.worker.tick();
  assert.equal(ctx.mock.calls.length, 0);
});

test('bulk calls are processed in controlled batches (concurrency + rate limit)', async () => {
  const ctx = makeCtx();
  for (let i = 0; i < 12; i++) addStudent(ctx, `Student ${i}`, `98765432${String(i).padStart(2, '0')}`);
  ctx.assignments.create({ problem_title: 'Two Sum' });
  ctx.settings.update({ max_concurrent_calls: 3, calls_per_minute: 5 });
  for (const t of ctx.assignments.findTargets({ audience: 'unsolved' })) {
    assert.ok(enqueue(ctx, t.student_id, { source: 'bulk' }).queued);
  }
  assert.equal((await ctx.worker.tick()).dispatched, 3, 'never more than 3 simultaneous calls');
  assert.equal((await ctx.worker.tick()).dispatched, 0, 'all slots busy');
  await completeAll(ctx);
  assert.equal((await ctx.worker.tick()).dispatched, 2, 'per-minute budget: 5 - 3 already started');
  await completeAll(ctx);
  assert.equal((await ctx.worker.tick()).dispatched, 0, 'rate limited');
  ctx.advance(61000);
  assert.equal((await ctx.worker.tick()).dispatched, 3);
  assert.equal(ctx.mock.calls.length, 8);
});

test('failed calls retry with exponential backoff up to max attempts', async () => {
  const { ctx, rahul } = setup();
  ctx.settings.update({ max_attempts: 3, retry_base_seconds: 300 });
  const id = enqueue(ctx, rahul.id).queued.id;

  await ctx.worker.tick();
  await completeAll(ctx, 'no_answer', 0);
  let item = ctx.calls.getQueueItem(id);
  assert.equal(item.status, 'queued');
  assert.equal(new Date(item.next_attempt_at) - ctx.clock.t, 300 * 1000, 'first retry after base delay');
  assert.equal((await ctx.worker.tick()).dispatched, 0, 'not before backoff elapses');

  ctx.advance(300 * 1000);
  await ctx.worker.tick();
  await completeAll(ctx, 'busy', 0);
  item = ctx.calls.getQueueItem(id);
  assert.equal(new Date(item.next_attempt_at) - ctx.clock.t, 600 * 1000, 'doubles each attempt');

  ctx.advance(600 * 1000);
  await ctx.worker.tick();
  await completeAll(ctx, 'failed', 0);
  item = ctx.calls.getQueueItem(id);
  assert.equal(item.status, 'failed', 'gives up after max attempts');
  assert.equal(item.attempts, 3);
  assert.equal(ctx.calls.logsFor(id).length, 3, 'every attempt kept in history');

  // Manual "retry failed calls" grants one more attempt.
  assert.equal(ctx.calls.retryFailed({}).requeued, 1);
  await ctx.worker.tick();
  await completeAll(ctx, 'completed');
  assert.equal(ctx.calls.getQueueItem(id).status, 'completed');
});

test('provider failure is logged and retried; non-retryable errors fail immediately', async () => {
  const { ctx, rahul, aman } = setup();
  ctx.mock.setOutcome('throw');
  const id = enqueue(ctx, rahul.id).queued.id;
  await ctx.worker.tick();
  const item = ctx.calls.getQueueItem(id);
  assert.equal(item.status, 'queued', 'retry scheduled after provider error');
  assert.match(item.last_error, /Mock provider API failure/);
  assert.equal(ctx.calls.logsFor(id)[0].error_code, 'mock_failure');
  assert.ok(ctx.audit.list().some((a) => a.action === 'provider_error'));

  // Non-retryable provider error (e.g. invalid number) -> final failed.
  const { ProviderError } = require('../src/providers/errors');
  const orig = ctx.mock.createCall;
  ctx.mock.createCall = async () => {
    throw new ProviderError('Invalid To number', { code: '21211', retryable: false });
  };
  const id2 = enqueue(ctx, aman.id).queued.id;
  ctx.advance(10 * 60 * 1000);
  await ctx.worker.tick();
  assert.equal(ctx.calls.getQueueItem(id2).status, 'failed');
  ctx.mock.createCall = orig;
});

test('status callbacks are idempotent; late/duplicate callbacks are ignored', async () => {
  const { ctx, rahul } = setup();
  const id = enqueue(ctx, rahul.id).queued.id;
  await ctx.worker.tick();
  const sid = ctx.mock.calls[0].providerCallId;
  assert.equal(ctx.calls.applyStatus({ providerCallId: sid, status: 'calling', providerStatus: 'ringing' }).updated, 'in_progress');
  assert.equal(ctx.calls.applyStatus({ providerCallId: sid, status: 'completed', durationSeconds: 30 }).updated, 'final');
  assert.equal(ctx.calls.applyStatus({ providerCallId: sid, status: 'failed' }).ignored, 'already_final');
  assert.equal(ctx.calls.applyStatus({ providerCallId: 'nope', status: 'completed' }).ignored, 'unknown_call');
  assert.equal(ctx.calls.getQueueItem(id).status, 'completed');
});

test('calling hours: nothing is dialled outside the window except admin test calls', async () => {
  const { ctx, rahul } = setup();
  ctx.settings.update({ calling_hours_start: '11:00', calling_hours_end: '21:00' }); // now is 10:30 IST
  enqueue(ctx, rahul.id);
  ctx.calls.enqueueTest({ phone: '9999999999', createdBy: 'test' });
  assert.equal((await ctx.worker.tick()).dispatched, 1);
  assert.equal(ctx.mock.calls[0].to, '+919999999999');
  assert.match(ctx.mock.calls[0].message, /Hello Rahul/, 'test call uses sample data');
  ctx.advance(31 * 60 * 1000);
  assert.equal((await ctx.worker.tick()).dispatched, 1, 'queued call goes out once hours open');
});

test('paused automation holds scheduled calls but not manual ones', async () => {
  const { ctx, rahul, aman } = setup();
  enqueue(ctx, rahul.id, { source: 'schedule' });
  enqueue(ctx, aman.id, { source: 'manual' });
  ctx.settings.update({ automation_paused: true });
  await ctx.worker.tick();
  assert.deepEqual(ctx.mock.calls.map((c) => c.to), ['+919876543211']);
  ctx.settings.update({ automation_paused: false });
  await ctx.worker.tick();
  assert.equal(ctx.mock.calls.length, 2);
});

test('server restart recovery: interrupted dispatches are retried, in-flight calls reconciled', async () => {
  const { ctx, rahul, aman } = setup();
  const a = enqueue(ctx, rahul.id).queued.id;
  const b = enqueue(ctx, aman.id).queued.id;
  // Crash after claiming but before the provider confirmed (no provider id stored).
  ctx.calls.claimDue({ limit: 1, providerName: 'mock' });
  // Second call was placed and is ringing when the server dies.
  await ctx.worker.tick();
  assert.equal(ctx.calls.getQueueItem(a).status, 'calling');
  assert.equal(ctx.calls.getQueueItem(a).provider_call_id, null);
  assert.ok(ctx.calls.getQueueItem(b).provider_call_id);

  // "Restart": recovery runs on startup.
  assert.equal(ctx.calls.recoverInterrupted(), 1);
  const ra = ctx.calls.getQueueItem(a);
  assert.equal(ra.status, 'queued', 'interrupted call re-queued');
  assert.equal(ctx.calls.logsFor(a)[0].error_code, 'interrupted');

  // In-flight call finished while we were down: reconcile polls the provider.
  ctx.mock.calls[0].status = 'completed';
  ctx.advance(3 * 60 * 1000);
  await ctx.worker.reconcile();
  assert.equal(ctx.calls.getQueueItem(b).status, 'completed');
});

test('calls with no final status are failed after the stale timeout', async () => {
  const { ctx, rahul } = setup();
  ctx.settings.update({ stale_call_minutes: 10, max_attempts: 1 });
  const id = enqueue(ctx, rahul.id).queued.id;
  await ctx.worker.tick();
  ctx.advance(5 * 60 * 1000);
  await ctx.worker.reconcile();
  assert.equal(ctx.calls.getQueueItem(id).status, 'calling', 'still within timeout');
  ctx.advance(6 * 60 * 1000);
  await ctx.worker.reconcile();
  const item = ctx.calls.getQueueItem(id);
  assert.equal(item.status, 'failed');
  assert.match(item.last_error, /No final status/);
});

test('dashboard: completed-after-reminder and filters', async () => {
  const { ctx, rahul, aman, twoSum } = setup();
  enqueue(ctx, rahul.id);
  enqueue(ctx, aman.id);
  await ctx.worker.tick();
  await completeAll(ctx, 'completed');
  ctx.advance(60 * 60 * 1000);
  ctx.assignments.setProgress(twoSum.id, rahul.id, 'solved');
  const d = ctx.calls.dashboard();
  assert.equal(d.stats.completed_after_reminders, 1);
  assert.equal(ctx.calls.dashboard({ filter: 'pending' }).rows.length, 2);
  assert.equal(ctx.calls.dashboard({ filter: 'successful' }).rows.length, 2);
  assert.equal(ctx.calls.dashboard({ filter: 'failed' }).rows.length, 0);
  assert.equal(ctx.calls.dashboard({ squad: 'Beta' }).rows.length, 1);
});
