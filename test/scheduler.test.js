'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, addStudent } = require('./helpers');

// Default schedules: 10:00 first_reminder/unsolved, 16:00 pending/not_started, 20:00 pending/unsolved, 22:00 final/unsolved.

function setup(opts) {
  const ctx = makeCtx({ now: '2026-11-17T04:31:00.000Z', ...opts }); // 10:01 IST
  const rahul = addStudent(ctx, 'Rahul', '9876543210', { leetcode_username: 'rahul_lc' });
  const aman = addStudent(ctx, 'Aman', '9876543211', { leetcode_username: 'aman_lc' });
  const twoSum = ctx.assignments.create({ problem_title: 'Two Sum', problem_url: 'https://leetcode.com/problems/two-sum/', difficulty: 'Easy' });
  ctx.settings.update({ leetcode_sync_enabled: false });
  return { ctx, rahul, aman, twoSum };
}

const queued = (ctx) => ctx.db.prepare("SELECT * FROM call_queue WHERE status = 'queued'").all();

test('scheduler fires a due schedule exactly once per day', async () => {
  const { ctx } = setup();
  const fired = await ctx.scheduler.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].queued, 2);
  const q = queued(ctx);
  assert.equal(q.length, 2);
  assert.ok(q.every((r) => r.template_type === 'first_reminder' && r.source === 'schedule'));
  assert.match(q.find((r) => r.message.includes('Rahul')).message, /Hello Rahul.*Two Sum/);

  ctx.advance(60000);
  assert.deepEqual(await ctx.scheduler.tick(), [], 'second tick same day does nothing');
  assert.equal(queued(ctx).length, 2);
});

test('scheduler only targets the right audience and skips solved students', async () => {
  const { ctx, aman, twoSum } = setup();
  ctx.assignments.setProgress(twoSum.id, aman.id, 'attempted');
  ctx.setTime('2026-11-17T10:31:00.000Z'); // 16:01 IST -> "not started" schedule
  const fired = await ctx.scheduler.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].queued, 1, 'Aman has started, only Rahul called');

  ctx.assignments.setProgress(twoSum.id, aman.id, 'solved');
  ctx.setTime('2026-11-17T14:31:00.000Z'); // 20:01 IST -> unsolved
  const f2 = await ctx.scheduler.tick();
  assert.equal(f2[0].queued, 0, 'Rahul already has an active call; Aman solved');
  assert.equal(f2[0].skipped.already_queued, 1);
});

test('scheduler respects pause, holidays, grace window and calling hours', async () => {
  const { ctx } = setup();
  ctx.settings.update({ automation_paused: true });
  assert.deepEqual(await ctx.scheduler.tick(), []);
  ctx.settings.update({ automation_paused: false });

  ctx.scheduler.holidays.add('2026-11-17', 'Diwali break');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(queued(ctx).length, 0);
  const run = ctx.db.prepare('SELECT * FROM call_schedule_runs').get();
  assert.equal(run.status, 'skipped');
  assert.equal(run.note, 'holiday');

  // Next day, but the server was down until well after the grace window.
  ctx.scheduler.holidays.remove('2026-11-17');
  ctx.assignments.create({ problem_title: 'Valid Parentheses', assigned_date: '2026-11-18' });
  ctx.setTime('2026-11-18T06:00:00.000Z'); // 11:30 IST, grace is 45 min after 10:00
  assert.deepEqual(await ctx.scheduler.tick(), []);

  // A 22:00 schedule outside calling hours (ending 21:30) is skipped.
  ctx.settings.update({ calling_hours_end: '21:30' });
  ctx.setTime('2026-11-18T16:31:00.000Z'); // 22:01 IST
  await ctx.scheduler.tick();
  const late = ctx.db.prepare("SELECT * FROM call_schedule_runs WHERE run_date = '2026-11-18'").all();
  assert.equal(late.length, 1);
  assert.equal(late[0].note, 'outside calling hours');
  assert.equal(queued(ctx).length, 0);
});

test('schedules are configurable: days of week and disabled schedules', async () => {
  const { ctx } = setup();
  for (const s of ctx.scheduler.schedules.list()) ctx.scheduler.schedules.update(s.id, { enabled: false });
  assert.deepEqual(await ctx.scheduler.tick(), []);
  const s = ctx.scheduler.schedules.create({ name: 'Weekend only', time_of_day: '10:00', days_of_week: [0, 6], template_type: 'pending_reminder', audience: 'unsolved' });
  assert.deepEqual(await ctx.scheduler.tick(), [], 'Tuesday is not a weekend');
  ctx.scheduler.schedules.update(s.id, { days_of_week: [2] });
  assert.equal((await ctx.scheduler.tick()).length, 1);
  assert.throws(() => ctx.scheduler.schedules.create({ name: 'x', time_of_day: '25:00', template_type: 'pending_reminder', audience: 'unsolved' }));
});

test('LeetCode sync before a scheduled run removes students who solved', async () => {
  const calls = [];
  const leetcodeFetch = async (url, init) => {
    const { variables } = JSON.parse(init.body);
    calls.push(variables.username);
    const ts = String(Date.parse('2026-11-17T03:00:00Z') / 1000);
    const list = variables.username === 'rahul_lc' ? [{ titleSlug: 'two-sum', statusDisplay: 'Accepted', timestamp: ts }] : [{ titleSlug: 'two-sum', statusDisplay: 'Wrong Answer', timestamp: ts }];
    return { ok: true, json: async () => ({ data: { recentSubmissionList: list } }) };
  };
  const { ctx, twoSum, rahul, aman } = setup({ leetcodeFetch });
  ctx.settings.update({ leetcode_sync_enabled: true });
  const fired = await ctx.scheduler.tick();
  assert.deepEqual(calls.sort(), ['aman_lc', 'rahul_lc']);
  assert.equal(fired[0].queued, 1);
  assert.equal(ctx.assignments.getProgressStatus(twoSum.id, rahul.id), 'solved');
  assert.equal(ctx.assignments.getProgressStatus(twoSum.id, aman.id), 'attempted');
  assert.match(queued(ctx)[0].message, /Hello Aman/);
});

test('LeetCode sync failure does not block the schedule', async () => {
  const { ctx } = setup({ leetcodeFetch: async () => { throw new Error('network down'); } });
  ctx.settings.update({ leetcode_sync_enabled: true });
  const fired = await ctx.scheduler.tick();
  assert.equal(fired[0].queued, 2);
});
