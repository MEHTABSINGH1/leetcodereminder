'use strict';

const { zonedParts, parseHHMM, inWindow } = require('../lib/time');
const { TEMPLATE_TYPES } = require('../lib/templates');
const { AUDIENCES } = require('../services/assignments');
const { httpError } = require('../services/settings');

/**
 * Schedule runner. A schedule fires once per local day when the current time is within
 * [time_of_day, time_of_day + grace). The (schedule_id, run_date) unique row makes this
 * idempotent across ticks, restarts and multiple processes; per-call idempotency keys
 * make re-runs harmless too.
 */
function createScheduler({ db, calls, assignments, settings, leetcodeSync, config, logger, audit, now = () => new Date() }) {
  let timer = null;
  let running = false;

  const schedules = {
    list() {
      return db
        .prepare(
          `SELECT s.*, (SELECT run_date || ' ' || status || ' (' || enqueued || ' queued)' FROM call_schedule_runs r
             WHERE r.schedule_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_run
           FROM call_schedules s ORDER BY s.time_of_day`
        )
        .all();
    },
    validate(input) {
      const name = String(input.name || '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'Schedule name is required');
      if (parseHHMM(input.time_of_day) === null) throw httpError(400, 'time_of_day must be HH:MM');
      if (!TEMPLATE_TYPES.includes(input.template_type)) throw httpError(400, 'Invalid template_type');
      if (!AUDIENCES.includes(input.audience)) throw httpError(400, 'Invalid audience');
      const days = Array.isArray(input.days_of_week) ? input.days_of_week : String(input.days_of_week ?? '0,1,2,3,4,5,6').split(',');
      const dayNums = [...new Set(days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      if (!dayNums.length) throw httpError(400, 'Select at least one day');
      return { name, time_of_day: input.time_of_day, template_type: input.template_type, audience: input.audience, days_of_week: dayNums.join(','), enabled: input.enabled === false ? 0 : 1 };
    },
    create(input) {
      const v = schedules.validate(input);
      const t = new Date().toISOString();
      const r = db
        .prepare(
          `INSERT INTO call_schedules (name, time_of_day, days_of_week, template_type, audience, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(v.name, v.time_of_day, v.days_of_week, v.template_type, v.audience, v.enabled, t, t);
      return db.prepare('SELECT * FROM call_schedules WHERE id = ?').get(Number(r.lastInsertRowid));
    },
    update(id, input) {
      const cur = db.prepare('SELECT * FROM call_schedules WHERE id = ?').get(Number(id));
      if (!cur) throw httpError(404, 'Schedule not found');
      const merged = { ...cur, enabled: Boolean(cur.enabled), ...input };
      const v = schedules.validate(merged);
      db.prepare(
        `UPDATE call_schedules SET name = ?, time_of_day = ?, days_of_week = ?, template_type = ?, audience = ?, enabled = ?, updated_at = ? WHERE id = ?`
      ).run(v.name, v.time_of_day, v.days_of_week, v.template_type, v.audience, v.enabled, new Date().toISOString(), cur.id);
      return db.prepare('SELECT * FROM call_schedules WHERE id = ?').get(cur.id);
    },
    remove(id) {
      const r = db.prepare('DELETE FROM call_schedules WHERE id = ?').run(Number(id));
      if (!r.changes) throw httpError(404, 'Schedule not found');
    },
  };

  const holidays = {
    list() {
      return db.prepare('SELECT * FROM call_holidays ORDER BY date').all();
    },
    add(date, reason) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw httpError(400, 'Date must be YYYY-MM-DD');
      db.prepare('INSERT OR REPLACE INTO call_holidays (date, reason) VALUES (?, ?)').run(date, String(reason || '').slice(0, 120) || null);
    },
    remove(date) {
      db.prepare('DELETE FROM call_holidays WHERE date = ?').run(String(date));
    },
    isHoliday(date) {
      return Boolean(db.prepare('SELECT 1 FROM call_holidays WHERE date = ?').get(date));
    },
  };

  /** Find targets for a schedule, sync progress from LeetCode, and enqueue calls. */
  async function execute(schedule, { runDate, keyPrefix, actor }) {
    const s = settings.getAll();
    let targets = assignments.findTargets({ audience: schedule.audience, lookbackDays: s.overdue_lookback_days });
    if (s.leetcode_sync_enabled && leetcodeSync && targets.length) {
      try {
        const r = await leetcodeSync.syncTargets(targets);
        logger.info('leetcode sync before schedule', { scheduleId: schedule.id, ...r });
      } catch (err) {
        logger.warn('leetcode sync failed; continuing with stored progress', { error: err.message });
      }
      targets = assignments.findTargets({ audience: schedule.audience, lookbackDays: s.overdue_lookback_days });
    }
    const summary = { queued: 0, skipped: {} };
    for (const t of targets) {
      const r = calls.enqueue({
        studentId: t.student_id,
        assignmentId: t.assignment_id,
        templateType: schedule.template_type,
        source: 'schedule',
        scheduleId: schedule.id,
        createdBy: actor,
        idempotencyKey: `${keyPrefix}:${schedule.id}:${runDate}:${t.student_id}:${t.assignment_id}`,
        enforceGap: true,
      });
      if (r.queued) summary.queued++;
      else summary.skipped[r.skipped] = (summary.skipped[r.skipped] || 0) + 1;
    }
    return summary;
  }

  async function tick() {
    if (running) return [];
    running = true;
    const fired = [];
    try {
      const s = settings.getAll();
      if (s.automation_paused) return fired;
      const local = zonedParts(now(), config.timezone);
      const due = db
        .prepare('SELECT * FROM call_schedules WHERE enabled = 1')
        .all()
        .filter((sch) => {
          const m = parseHHMM(sch.time_of_day);
          return sch.days_of_week.split(',').map(Number).includes(local.weekday) && local.minutes >= m && local.minutes < m + s.schedule_grace_minutes;
        });
      for (const sch of due) {
        const t = new Date().toISOString();
        const claim = db
          .prepare(
            `INSERT INTO call_schedule_runs (schedule_id, run_date, status, started_at) VALUES (?, ?, 'running', ?)
             ON CONFLICT(schedule_id, run_date) DO NOTHING`
          )
          .run(sch.id, local.date, t);
        if (!claim.changes) continue; // already ran today
        const runId = Number(claim.lastInsertRowid);
        const finish = (status, enqueued, note) =>
          db.prepare('UPDATE call_schedule_runs SET status = ?, enqueued = ?, note = ?, finished_at = ? WHERE id = ?').run(
            status,
            enqueued,
            note,
            new Date().toISOString(),
            runId
          );
        if (holidays.isHoliday(local.date)) {
          finish('skipped', 0, 'holiday');
          continue;
        }
        if (!inWindow(parseHHMM(sch.time_of_day), s.calling_hours_start, s.calling_hours_end)) {
          finish('skipped', 0, 'outside calling hours');
          logger.warn('schedule outside calling hours skipped', { scheduleId: sch.id });
          continue;
        }
        try {
          const summary = await execute(sch, { runDate: local.date, keyPrefix: 'sched', actor: 'scheduler' });
          finish('done', summary.queued, JSON.stringify(summary.skipped));
          audit?.log('scheduler', 'schedule_run', { scheduleId: sch.id, name: sch.name, ...summary });
          fired.push({ scheduleId: sch.id, ...summary });
        } catch (err) {
          finish('failed', 0, err.message);
          logger.error('schedule run failed', { scheduleId: sch.id, error: err.message });
        }
      }
      return fired;
    } finally {
      running = false;
    }
  }

  async function runNow(scheduleId, actor) {
    const sch = db.prepare('SELECT * FROM call_schedules WHERE id = ?').get(Number(scheduleId));
    if (!sch) throw httpError(404, 'Schedule not found');
    const local = zonedParts(now(), config.timezone);
    return execute(sch, { runDate: local.date, keyPrefix: 'sched-manual', actor });
  }

  return {
    schedules,
    holidays,
    tick,
    runNow,
    start(intervalMs = 30000) {
      timer = setInterval(() => tick().catch((e) => logger.error('scheduler tick failed', { error: e.message })), intervalMs);
      timer.unref?.();
      tick().catch((e) => logger.error('scheduler tick failed', { error: e.message }));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createScheduler };
