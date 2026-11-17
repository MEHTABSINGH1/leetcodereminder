'use strict';

const { zonedParts, zonedTimeToUtc, parseHHMM } = require('../lib/time');
const { transaction } = require('../db');
const { httpError } = require('./settings');

const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
const PROGRESS = ['not_started', 'attempted', 'solved'];
const AUDIENCES = ['unsolved', 'not_started', 'overdue'];

function slugFrom(input) {
  const s = String(input || '').trim();
  const m = /leetcode\.com\/problems\/([a-z0-9-]+)/i.exec(s);
  if (m) return m[1].toLowerCase();
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createAssignmentService(db, { timezone, now = () => new Date() }) {
  const TARGET_SELECT = `
    SELECT s.id AS student_id, s.name AS student_name, s.phone, s.squad, s.leetcode_username,
           a.id AS assignment_id, a.problem_title, a.problem_slug, a.difficulty, a.deadline_at, a.assigned_date,
           COALESCE(p.status, 'not_started') AS progress_status
    FROM assignments a
    JOIN students s ON s.active = 1 AND (a.squad IS NULL OR a.squad = s.squad)
    LEFT JOIN assignment_progress p ON p.assignment_id = a.id AND p.student_id = s.id`;

  const service = {
    today() {
      return zonedParts(now(), timezone).date;
    },

    list({ date, limit = 100 } = {}) {
      const rows = date
        ? db.prepare('SELECT * FROM assignments WHERE assigned_date = ? ORDER BY id DESC').all(date)
        : db.prepare('SELECT * FROM assignments ORDER BY assigned_date DESC, id DESC LIMIT ?').all(Number(limit));
      const countStmt = db.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(p.status,'not_started') = 'solved' THEN 1 ELSE 0 END) AS solved
        FROM assignments a JOIN students s ON s.active = 1 AND (a.squad IS NULL OR a.squad = s.squad)
        LEFT JOIN assignment_progress p ON p.assignment_id = a.id AND p.student_id = s.id
        WHERE a.id = ?`);
      return rows.map((a) => {
        const c = countStmt.get(a.id);
        return { ...a, total_students: c.total, solved_count: c.solved || 0 };
      });
    },

    get(id) {
      return db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(id)) || null;
    },

    create(input) {
      const title = String(input.problem_title || '').replace(/[\u0000-\u001f<>{}]/g, ' ').trim().slice(0, 120);
      if (!title) throw httpError(400, 'Problem title is required');
      const difficulty = DIFFICULTIES.find((d) => d.toLowerCase() === String(input.difficulty || 'Medium').toLowerCase());
      if (!difficulty) throw httpError(400, 'Difficulty must be Easy, Medium or Hard');
      const assignedDate = input.assigned_date || service.today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(assignedDate)) throw httpError(400, 'assigned_date must be YYYY-MM-DD');
      const deadlineDate = input.deadline_date || assignedDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate)) throw httpError(400, 'deadline_date must be YYYY-MM-DD');
      const deadlineTime = input.deadline_time || '23:59';
      if (parseHHMM(deadlineTime) === null) throw httpError(400, 'deadline_time must be HH:MM');
      const deadlineAt = zonedTimeToUtc(deadlineDate, deadlineTime, timezone).toISOString();
      if (deadlineDate < assignedDate) throw httpError(400, 'Deadline cannot be before the assigned date');
      const slug = slugFrom(input.problem_url || input.problem_slug || title);
      const squad = input.squad ? String(input.squad).trim().slice(0, 60) : null;
      const r = db
        .prepare(
          `INSERT INTO assignments (problem_title, problem_slug, problem_url, difficulty, assigned_date, deadline_at, squad, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(title, slug, `https://leetcode.com/problems/${slug}/`, difficulty, assignedDate, deadlineAt, squad, now().toISOString());
      return service.get(Number(r.lastInsertRowid));
    },

    remove(id) {
      const r = transaction(db, () => {
        db.prepare(
          "UPDATE call_queue SET status = 'cancelled', last_error = 'Assignment deleted', updated_at = ? WHERE assignment_id = ? AND status = 'queued'"
        ).run(now().toISOString(), Number(id));
        return db.prepare('DELETE FROM assignments WHERE id = ?').run(Number(id));
      });
      if (!r.changes) throw httpError(404, 'Assignment not found');
    },

    progress(assignmentId) {
      return db.prepare(`${TARGET_SELECT} WHERE a.id = ? ORDER BY s.name`).all(Number(assignmentId));
    },

    getProgressStatus(assignmentId, studentId) {
      const row = db
        .prepare('SELECT status FROM assignment_progress WHERE assignment_id = ? AND student_id = ?')
        .get(Number(assignmentId), Number(studentId));
      return row ? row.status : 'not_started';
    },

    setProgress(assignmentId, studentId, status, source = 'manual') {
      if (!PROGRESS.includes(status)) throw httpError(400, 'Invalid progress status');
      if (!service.get(assignmentId)) throw httpError(404, 'Assignment not found');
      const t = now().toISOString();
      db.prepare(
        `INSERT INTO assignment_progress (assignment_id, student_id, status, solved_at, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(assignment_id, student_id) DO UPDATE SET
           status = excluded.status,
           solved_at = CASE WHEN excluded.status = 'solved' THEN COALESCE(assignment_progress.solved_at, excluded.solved_at) ELSE NULL END,
           source = excluded.source, updated_at = excluded.updated_at`
      ).run(Number(assignmentId), Number(studentId), status, status === 'solved' ? t : null, source, t);
      if (status === 'solved') {
        // Never call a student about a problem they have already solved.
        db.prepare(
          "UPDATE call_queue SET status = 'cancelled', last_error = 'Problem already solved', updated_at = ? WHERE assignment_id = ? AND student_id = ? AND status = 'queued'"
        ).run(t, Number(assignmentId), Number(studentId));
      }
    },

    /**
     * Identify students to contact for an audience:
     *   unsolved    - today's active assignments, student has not solved
     *   not_started - today's active assignments, no attempt recorded
     *   overdue     - deadline passed within lookback window, still unsolved
     */
    findTargets({ audience, squad, lookbackDays = 3, assignmentId } = {}) {
      if (!AUDIENCES.includes(audience)) throw httpError(400, `Unknown audience "${audience}"`);
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      const where = ["COALESCE(p.status, 'not_started') <> 'solved'"];
      const args = [];
      if (audience === 'overdue') {
        where.push('a.deadline_at <= ? AND a.deadline_at > ?');
        args.push(nowIso, new Date(nowDate.getTime() - lookbackDays * 86400000).toISOString());
      } else {
        where.push('a.assigned_date <= ? AND a.deadline_at > ?');
        args.push(service.today(), nowIso);
      }
      if (audience === 'not_started') where.push("COALESCE(p.status, 'not_started') = 'not_started'");
      if (squad) {
        where.push('s.squad = ?');
        args.push(squad);
      }
      if (assignmentId) {
        where.push('a.id = ?');
        args.push(Number(assignmentId));
      }
      return db.prepare(`${TARGET_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.name, a.id`).all(...args);
    },

    /** The assignment a manual call to this student should be about (earliest-deadline open one). */
    currentForStudent(studentId, lookbackDays = 3) {
      const nowDate = now();
      const rows = db
        .prepare(
          `${TARGET_SELECT} WHERE s.id = ? AND COALESCE(p.status,'not_started') <> 'solved'
             AND a.assigned_date <= ? AND a.deadline_at > ?
           ORDER BY CASE WHEN a.deadline_at > ? THEN 0 ELSE 1 END, a.deadline_at ASC`
        )
        .all(
          Number(studentId),
          service.today(),
          new Date(nowDate.getTime() - lookbackDays * 86400000).toISOString(),
          nowDate.toISOString()
        );
      return rows[0] || null;
    },
  };
  return service;
}

module.exports = { createAssignmentService, slugFrom, AUDIENCES, DIFFICULTIES };
