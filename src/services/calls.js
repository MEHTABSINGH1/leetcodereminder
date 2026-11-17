'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../db');
const { renderTemplate, TEMPLATE_TYPES, DEFAULT_TEMPLATES, validateTemplate } = require('../lib/templates');
const { formatDeadlineForSpeech, zonedParts, zonedTimeToUtc } = require('../lib/time');
const { normalizePhone } = require('../lib/phone');
const { httpError } = require('./settings');

const TERMINAL = ['completed', 'no_answer', 'busy', 'failed', 'cancelled'];
const FAILED_LIKE = ['no_answer', 'busy', 'failed'];
const ACTIVE = ['queued', 'calling'];

/**
 * Call queue + call history state machine.
 *
 *   queued --claim--> calling --status--> completed | no_answer | busy | failed | cancelled
 *                        |                         (retryable & attempts left)
 *                        +--------------------------> queued (next_attempt_at = now + base * 2^(n-1))
 */
function createCallService(db, { settings, students, assignments, config, now = () => new Date() }) {
  const iso = () => now().toISOString();

  // ---------- templates ----------
  const templates = {
    list() {
      return db.prepare('SELECT * FROM call_templates ORDER BY id').all();
    },
    get(type) {
      return db.prepare('SELECT * FROM call_templates WHERE type = ?').get(type) || null;
    },
    update(type, { name, body }, actor) {
      if (!TEMPLATE_TYPES.includes(type)) throw httpError(404, 'Unknown template type');
      const errors = validateTemplate(body);
      if (errors.length) throw httpError(400, errors.join('; '));
      const cleanName = String(name || DEFAULT_TEMPLATES[type].name).trim().slice(0, 80);
      db.prepare('UPDATE call_templates SET name = ?, body = ?, updated_at = ?, updated_by = ? WHERE type = ?').run(
        cleanName,
        String(body).trim(),
        iso(),
        actor,
        type
      );
      return templates.get(type);
    },
    reset(type, actor) {
      if (!TEMPLATE_TYPES.includes(type)) throw httpError(404, 'Unknown template type');
      return templates.update(type, DEFAULT_TEMPLATES[type], actor);
    },
  };

  function buildMessage(templateType, student, assignment) {
    const tpl = templates.get(templateType);
    if (!tpl) throw httpError(400, `Unknown template "${templateType}"`);
    return renderTemplate(tpl.body, {
      student_name: student.name,
      problem_title: assignment.problem_title,
      difficulty: assignment.difficulty,
      deadline: formatDeadlineForSpeech(assignment.deadline_at, config.timezone, now()),
      mentor_name: config.mentorName,
      squad: student.squad || '',
    });
  }

  /** Why a student may not be called right now (null = OK). */
  function contactBlocker(student, s = settings.getAll()) {
    if (!student || !student.active) return 'student_inactive';
    if (student.opted_out) return 'opted_out';
    if (student.consent_status === 'revoked') return 'consent_revoked';
    if (s.require_consent && student.consent_status !== 'granted') return 'consent_not_granted';
    if (!normalizePhone(student.phone).ok) return 'invalid_phone';
    return null;
  }

  function dayRangeUtc(date = zonedParts(now(), config.timezone).date) {
    const start = zonedTimeToUtc(date, '00:00', config.timezone);
    return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
  }

  /**
   * Add one personalised call to the queue. Returns { queued: row } or { skipped: reason }.
   * Every guard runs inside one transaction so concurrent requests can't double-queue.
   */
  function enqueue({ studentId, assignmentId, templateType, source, scheduleId = null, createdBy, idempotencyKey, enforceGap = false }) {
    if (!TEMPLATE_TYPES.includes(templateType)) throw httpError(400, `Unknown template "${templateType}"`);
    const s = settings.getAll();
    return transaction(db, () => {
      const student = students.get(studentId);
      const blocker = contactBlocker(student, s);
      if (blocker) return { skipped: blocker, studentId };

      const assignment = assignmentId
        ? assignments.get(assignmentId)
        : assignments.currentForStudent(studentId, s.overdue_lookback_days);
      if (!assignment) return { skipped: 'no_pending_assignment', studentId };
      const aId = assignment.assignment_id || assignment.id;
      const full = assignments.get(aId);
      if (full.squad && full.squad !== student.squad) return { skipped: 'not_assigned_to_student', studentId };
      if (assignments.getProgressStatus(aId, student.id) === 'solved') return { skipped: 'already_solved', studentId };

      const active = db
        .prepare(`SELECT id FROM call_queue WHERE student_id = ? AND status IN ('queued','calling') LIMIT 1`)
        .get(student.id);
      if (active) return { skipped: 'already_queued', studentId, queueId: active.id };

      if (enforceGap && s.min_minutes_between_calls > 0) {
        const since = new Date(now().getTime() - s.min_minutes_between_calls * 60000).toISOString();
        const recent = db.prepare('SELECT id FROM call_logs WHERE student_id = ? AND started_at > ? LIMIT 1').get(student.id, since);
        if (recent) return { skipped: 'called_recently', studentId };
      }

      const message = buildMessage(templateType, student, full);
      const key = idempotencyKey || `${source}:${student.id}:${aId}:${templateType}:${crypto.randomUUID()}`;
      const t = iso();
      const r = db
        .prepare(
          `INSERT INTO call_queue (student_id, assignment_id, template_type, message, status, source, schedule_id,
             idempotency_key, attempts, max_attempts, next_attempt_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`
        )
        .run(student.id, aId, templateType, message, source, scheduleId, key, s.max_attempts, t, createdBy, t, t);
      if (!r.changes) return { skipped: 'duplicate', studentId };
      return { queued: getQueueItem(Number(r.lastInsertRowid)) };
    });
  }

  /** Queue a call to an admin-supplied number with a sample message (no student data). */
  function enqueueTest({ phone, templateType = 'first_reminder', createdBy, sampleName = 'Rahul' }) {
    const p = normalizePhone(phone);
    if (!p.ok) throw httpError(400, p.error);
    const tpl = templates.get(templateType);
    if (!tpl) throw httpError(400, 'Unknown template');
    const message = renderTemplate(tpl.body, {
      student_name: sampleName,
      problem_title: 'Two Sum',
      difficulty: 'Easy',
      deadline: '11:59 PM today',
      mentor_name: config.mentorName,
      squad: '',
    });
    const t = iso();
    const r = db
      .prepare(
        `INSERT INTO call_queue (student_id, assignment_id, template_type, message, to_override, status, source,
           idempotency_key, attempts, max_attempts, next_attempt_at, created_by, created_at, updated_at)
         VALUES (NULL, NULL, ?, ?, ?, 'queued', 'test', ?, 0, 1, ?, ?, ?, ?)`
      )
      .run(templateType, message, p.e164, `test:${crypto.randomUUID()}`, t, createdBy, t, t);
    return getQueueItem(Number(r.lastInsertRowid));
  }

  function getQueueItem(id) {
    return db.prepare('SELECT * FROM call_queue WHERE id = ?').get(Number(id)) || null;
  }

  /** Atomically move due items to 'calling' and open a call_logs row for each attempt. */
  function claimDue({ limit, includeScheduled = true, onlyTest = false, providerName }) {
    if (limit <= 0) return [];
    return transaction(db, () => {
      const t = iso();
      const where = ["q.status = 'queued'", 'q.next_attempt_at <= ?'];
      if (!includeScheduled) where.push("q.source <> 'schedule'");
      if (onlyTest) where.push("q.source = 'test'");
      const rows = db
        .prepare(
          `SELECT q.*, s.phone AS student_phone FROM call_queue q LEFT JOIN students s ON s.id = q.student_id
           WHERE ${where.join(' AND ')} ORDER BY q.next_attempt_at, q.id LIMIT ?`
        )
        .all(t, limit);
      const claimed = [];
      for (const row of rows) {
        const u = db
          .prepare(
            `UPDATE call_queue SET status = 'calling', attempts = attempts + 1, locked_at = ?, provider = ?,
               provider_call_id = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`
          )
          .run(t, providerName, t, row.id);
        if (!u.changes) continue;
        const to = row.to_override || row.student_phone;
        const attempt = row.attempts + 1;
        const log = db
          .prepare(
            `INSERT INTO call_logs (queue_id, student_id, assignment_id, attempt, provider, to_number, message, status, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'calling', ?)`
          )
          .run(row.id, row.student_id, row.assignment_id, attempt, providerName, to, row.message, t);
        claimed.push({ ...row, status: 'calling', attempts: attempt, to, logId: Number(log.lastInsertRowid), provider: providerName });
      }
      return claimed;
    });
  }

  function markDispatched(queueId, logId, providerCallId, providerStatus) {
    transaction(db, () => {
      db.prepare('UPDATE call_queue SET provider_call_id = ?, updated_at = ? WHERE id = ?').run(providerCallId, iso(), queueId);
      db.prepare('UPDATE call_logs SET provider_call_id = ?, provider_status = ? WHERE id = ?').run(providerCallId, providerStatus || null, logId);
    });
  }

  function backoffSeconds(attempt, base) {
    return base * 2 ** Math.max(0, attempt - 1);
  }

  /**
   * Apply a provider status (from webhook, poll, mock, or dispatch error). Idempotent:
   * duplicate or late callbacks for an already-finished attempt are ignored.
   */
  function applyStatus({ providerCallId, logId, status, providerStatus = null, durationSeconds = null, errorCode = null, errorMessage = null, retryable = true }) {
    return transaction(db, () => {
      const log = logId
        ? db.prepare('SELECT * FROM call_logs WHERE id = ?').get(logId)
        : db.prepare('SELECT * FROM call_logs WHERE provider_call_id = ? ORDER BY id DESC LIMIT 1').get(String(providerCallId || ''));
      if (!log) return { ignored: 'unknown_call' };
      if (TERMINAL.includes(log.status)) return { ignored: 'already_final', status: log.status };

      if (!TERMINAL.includes(status)) {
        db.prepare('UPDATE call_logs SET provider_status = COALESCE(?, provider_status) WHERE id = ?').run(providerStatus, log.id);
        return { updated: 'in_progress' };
      }

      const t = iso();
      const dur = Number.isFinite(durationSeconds) ? Math.max(0, Math.round(durationSeconds)) : null;
      db.prepare(
        `UPDATE call_logs SET status = ?, provider_status = COALESCE(?, provider_status), ended_at = ?, duration_seconds = ?,
           error_code = ?, error_message = ? WHERE id = ?`
      ).run(status, providerStatus, t, dur, errorCode, errorMessage ? String(errorMessage).slice(0, 500) : null, log.id);

      const item = getQueueItem(log.queue_id);
      if (!item || item.status !== 'calling' || item.attempts !== log.attempt) return { updated: 'log_only' };

      const s = settings.getAll();
      const canRetry =
        retryable &&
        FAILED_LIKE.includes(status) &&
        s.retry_on_statuses.includes(status) &&
        item.source !== 'test' &&
        item.attempts < item.max_attempts;
      const errText = errorMessage || (status === 'completed' ? null : status.replace('_', ' '));
      if (canRetry) {
        const next = new Date(now().getTime() + backoffSeconds(item.attempts, s.retry_base_seconds) * 1000).toISOString();
        db.prepare(
          `UPDATE call_queue SET status = 'queued', next_attempt_at = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`
        ).run(next, errText, t, item.id);
        return { updated: 'retry_scheduled', nextAttemptAt: next };
      }
      db.prepare(
        `UPDATE call_queue SET status = ?, duration_seconds = ?, last_error = ?, locked_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`
      ).run(status, dur, errText, t, t, item.id);
      return { updated: 'final', status };
    });
  }

  /** Cancel a claimed attempt before dialling (e.g. student solved meanwhile). Not counted as a failure. */
  function cancelClaimed(item, reason) {
    transaction(db, () => {
      const t = iso();
      db.prepare("UPDATE call_logs SET status = 'cancelled', ended_at = ?, error_message = ? WHERE id = ?").run(t, reason, item.logId);
      db.prepare(
        "UPDATE call_queue SET status = 'cancelled', last_error = ?, locked_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(reason, t, t, item.id);
    });
  }

  function cancel({ queueIds, scope }, reason = 'Cancelled by admin') {
    const t = iso();
    if (Array.isArray(queueIds) && queueIds.length) {
      const ids = queueIds.map(Number).filter(Number.isInteger);
      const ph = ids.map(() => '?').join(',');
      return db
        .prepare(`UPDATE call_queue SET status = 'cancelled', last_error = ?, updated_at = ? WHERE status = 'queued' AND id IN (${ph})`)
        .run(reason, t, ...ids).changes;
    }
    if (scope === 'scheduled') {
      return db
        .prepare("UPDATE call_queue SET status = 'cancelled', last_error = ?, updated_at = ? WHERE status = 'queued' AND source = 'schedule'")
        .run(reason, t).changes;
    }
    if (scope === 'all') {
      return db.prepare("UPDATE call_queue SET status = 'cancelled', last_error = ?, updated_at = ? WHERE status = 'queued'").run(reason, t).changes;
    }
    throw httpError(400, 'Provide queue_ids or scope (scheduled | all)');
  }

  /** Re-queue finished-but-unsuccessful calls for one more attempt each. */
  function retryFailed({ queueIds } = {}) {
    const t = iso();
    const { start } = dayRangeUtc();
    return transaction(db, () => {
      let rows;
      if (Array.isArray(queueIds) && queueIds.length) {
        const ids = queueIds.map(Number).filter(Number.isInteger);
        rows = db
          .prepare(`SELECT * FROM call_queue WHERE status IN ('no_answer','busy','failed') AND id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids);
      } else {
        rows = db
          .prepare("SELECT * FROM call_queue WHERE status IN ('no_answer','busy','failed') AND source <> 'test' AND created_at >= ?")
          .all(start);
      }
      let requeued = 0;
      const skipped = [];
      for (const row of rows) {
        if (row.student_id) {
          const busy = db
            .prepare("SELECT id FROM call_queue WHERE student_id = ? AND status IN ('queued','calling') AND id <> ?")
            .get(row.student_id, row.id);
          if (busy) {
            skipped.push({ queueId: row.id, reason: 'already_queued' });
            continue;
          }
        }
        db.prepare(
          `UPDATE call_queue SET status = 'queued', max_attempts = attempts + 1, next_attempt_at = ?, last_error = NULL,
             completed_at = NULL, updated_at = ? WHERE id = ?`
        ).run(t, t, row.id);
        requeued++;
      }
      return { requeued, skipped };
    });
  }

  /**
   * Startup recovery. Items stuck in 'calling' without a provider id were claimed but
   * never confirmed by the provider (crash mid-dispatch): count that as a failed attempt,
   * which re-queues them with backoff if attempts remain. Items with a provider id are
   * reconciled by polling the provider (see worker.reconcile).
   */
  function recoverInterrupted() {
    const rows = db.prepare("SELECT * FROM call_queue WHERE status = 'calling' AND provider_call_id IS NULL").all();
    let recovered = 0;
    for (const item of rows) {
      const log = db.prepare('SELECT id FROM call_logs WHERE queue_id = ? AND attempt = ? ORDER BY id DESC LIMIT 1').get(item.id, item.attempts);
      if (log) {
        applyStatus({ logId: log.id, status: 'failed', errorCode: 'interrupted', errorMessage: 'Server restarted before the provider confirmed the call' });
      } else {
        db.prepare("UPDATE call_queue SET status = 'queued', locked_at = NULL, updated_at = ? WHERE id = ?").run(iso(), item.id);
      }
      recovered++;
    }
    return recovered;
  }

  function staleCalling(olderThanIso) {
    return db
      .prepare("SELECT * FROM call_queue WHERE status = 'calling' AND provider_call_id IS NOT NULL AND locked_at < ? ORDER BY locked_at LIMIT 20")
      .all(olderThanIso);
  }

  function counts() {
    const t = new Date(now().getTime() - 60000).toISOString();
    return {
      calling: db.prepare("SELECT COUNT(*) AS n FROM call_queue WHERE status = 'calling'").get().n,
      startedLastMinute: db.prepare('SELECT COUNT(*) AS n FROM call_logs WHERE started_at > ?').get(t).n,
    };
  }

  function logsFor(queueId) {
    return db.prepare('SELECT * FROM call_logs WHERE queue_id = ? ORDER BY attempt').all(Number(queueId));
  }

  /** Dashboard data for one local date. */
  function dashboard({ filter = 'all', squad = null } = {}) {
    const today = zonedParts(now(), config.timezone).date;
    const { start, end } = dayRangeUtc(today);
    const list = students.list({ squad: squad || undefined });

    const logStats = db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful,
           SUM(CASE WHEN status IN ('failed','no_answer','busy') THEN 1 ELSE 0 END) AS failed
         FROM call_logs WHERE started_at >= ? AND started_at < ? AND student_id IS NOT NULL`
      )
      .get(start, end);
    const pending = db.prepare("SELECT COUNT(*) AS n FROM call_queue WHERE status IN ('queued','calling')").get().n;

    const latestStmt = db.prepare(
      `SELECT q.*, (SELECT MAX(started_at) FROM call_logs l WHERE l.queue_id = q.id) AS last_call_at
       FROM call_queue q WHERE q.student_id = ? AND q.created_at >= ? AND q.created_at < ? ORDER BY q.id DESC LIMIT 1`
    );
    const todaysAssignStmt = db.prepare(
      `SELECT a.*, COALESCE(p.status,'not_started') AS progress_status, p.solved_at
       FROM assignments a LEFT JOIN assignment_progress p ON p.assignment_id = a.id AND p.student_id = ?
       WHERE a.assigned_date <= ? AND a.deadline_at > ? AND (a.squad IS NULL OR a.squad = ?)
       ORDER BY CASE WHEN COALESCE(p.status,'not_started') = 'solved' THEN 1 ELSE 0 END, a.deadline_at LIMIT 1`
    );
    const contactedStmt = db.prepare('SELECT 1 FROM call_logs WHERE student_id = ? AND started_at >= ? AND started_at < ? LIMIT 1');
    const remindedBeforeSolve = db.prepare(
      "SELECT 1 FROM call_logs WHERE student_id = ? AND assignment_id = ? AND status = 'completed' AND started_at < ? LIMIT 1"
    );
    const s = settings.getAll();
    const dayStartMinusLookback = new Date(new Date(start).getTime() - s.overdue_lookback_days * 86400000).toISOString();

    let notContacted = 0;
    let completedAfterReminder = 0;
    const rows = list.map((st) => {
      const a = todaysAssignStmt.get(st.id, today, dayStartMinusLookback, st.squad || '');
      const q = latestStmt.get(st.id, start, end);
      const contacted = Boolean(contactedStmt.get(st.id, start, end));
      if (a && a.progress_status !== 'solved' && !contacted) notContacted++;
      if (a && a.progress_status === 'solved' && a.solved_at && remindedBeforeSolve.get(st.id, a.id, a.solved_at)) completedAfterReminder++;
      return {
        student_id: st.id,
        name: st.name,
        phone: st.phone,
        squad: st.squad,
        consent_status: st.consent_status,
        opted_out: Boolean(st.opted_out),
        blocker: contactBlocker(st, s),
        assignment_id: a ? a.id : null,
        problem_title: a ? a.problem_title : null,
        difficulty: a ? a.difficulty : null,
        progress_status: a ? a.progress_status : null,
        queue_id: q ? q.id : null,
        call_status: q ? q.status : null,
        attempts: q ? q.attempts : 0,
        call_time: q ? q.last_call_at : null,
        duration_seconds: q ? q.duration_seconds : null,
        last_error: q ? q.last_error : null,
        source: q ? q.source : null,
      };
    });

    const filtered = rows.filter((r) => {
      switch (filter) {
        case 'pending':
          return r.problem_title && r.progress_status !== 'solved';
        case 'successful':
          return r.call_status === 'completed';
        case 'failed':
          return FAILED_LIKE.includes(r.call_status);
        default:
          return true;
      }
    });

    return {
      date: today,
      stats: {
        total_students: list.length,
        total_calls_today: logStats.total || 0,
        successful_calls: logStats.successful || 0,
        failed_calls: logStats.failed || 0,
        calls_pending: pending,
        students_not_contacted: notContacted,
        completed_after_reminders: completedAfterReminder,
      },
      rows: filtered,
    };
  }

  return {
    templates,
    buildMessage,
    contactBlocker,
    enqueue,
    enqueueTest,
    getQueueItem,
    claimDue,
    markDispatched,
    applyStatus,
    cancelClaimed,
    cancel,
    retryFailed,
    recoverInterrupted,
    staleCalling,
    counts,
    logsFor,
    dashboard,
    backoffSeconds,
    dayRangeUtc,
    TERMINAL,
    ACTIVE,
  };
}

module.exports = { createCallService };
