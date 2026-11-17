'use strict';

/**
 * Ordered schema migrations. Each entry runs once, inside a transaction,
 * and is recorded in schema_migrations.
 */
module.exports = [
  {
    id: 1,
    name: 'core_tables',
    sql: `
      CREATE TABLE students (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT NOT NULL,
        phone             TEXT NOT NULL UNIQUE,      -- E.164
        email             TEXT,
        leetcode_username TEXT,
        squad             TEXT,
        active            INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX idx_students_squad ON students(squad);

      CREATE TABLE assignments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        problem_title TEXT NOT NULL,
        problem_slug  TEXT,
        problem_url   TEXT,
        difficulty    TEXT NOT NULL DEFAULT 'Medium',
        assigned_date TEXT NOT NULL,                -- YYYY-MM-DD in app timezone
        deadline_at   TEXT NOT NULL,                -- ISO UTC
        squad         TEXT,                         -- NULL = all students
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_assignments_date ON assignments(assigned_date);

      CREATE TABLE assignment_progress (
        assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        status        TEXT NOT NULL CHECK (status IN ('not_started','attempted','solved')),
        solved_at     TEXT,
        source        TEXT NOT NULL DEFAULT 'manual',  -- manual | leetcode_sync
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (assignment_id, student_id)
      );

      CREATE TABLE audit_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor      TEXT NOT NULL,
        action     TEXT NOT NULL,
        details    TEXT,
        ip         TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_logs(created_at);
    `,
  },
  {
    id: 2,
    name: 'voice_calling',
    sql: `
      CREATE TABLE call_templates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        body       TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE call_schedules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        time_of_day   TEXT NOT NULL,                 -- HH:MM in app timezone
        days_of_week  TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
        template_type TEXT NOT NULL REFERENCES call_templates(type),
        audience      TEXT NOT NULL CHECK (audience IN ('unsolved','not_started','overdue')),
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- One row per schedule per local date: guarantees a schedule fires at most once a day.
      CREATE TABLE call_schedule_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL REFERENCES call_schedules(id) ON DELETE CASCADE,
        run_date    TEXT NOT NULL,
        status      TEXT NOT NULL,                   -- running | done | skipped
        enqueued    INTEGER NOT NULL DEFAULT 0,
        note        TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (schedule_id, run_date)
      );

      CREATE TABLE call_holidays (
        date   TEXT PRIMARY KEY,                     -- YYYY-MM-DD
        reason TEXT
      );

      CREATE TABLE student_call_preferences (
        student_id     INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
        consent_status TEXT NOT NULL DEFAULT 'pending' CHECK (consent_status IN ('pending','granted','revoked')),
        consent_source TEXT,
        consent_at     TEXT,
        opted_out      INTEGER NOT NULL DEFAULT 0,
        opted_out_at   TEXT,
        opt_out_source TEXT,
        updated_at     TEXT NOT NULL
      );

      -- Key/value runtime settings (non-secret). Credentials live only in env vars.
      CREATE TABLE call_provider_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE call_queue (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id       INTEGER REFERENCES students(id) ON DELETE CASCADE,  -- NULL only for test calls
        assignment_id    INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
        template_type    TEXT NOT NULL,
        message          TEXT NOT NULL,
        to_override      TEXT,                       -- test calls only
        status           TEXT NOT NULL CHECK (status IN ('queued','calling','completed','no_answer','busy','failed','cancelled')),
        source           TEXT NOT NULL,              -- schedule | manual | bulk | retry | test
        schedule_id      INTEGER REFERENCES call_schedules(id) ON DELETE SET NULL,
        idempotency_key  TEXT NOT NULL UNIQUE,
        attempts         INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL,
        next_attempt_at  TEXT NOT NULL,
        locked_at        TEXT,
        provider         TEXT,
        provider_call_id TEXT,
        last_error       TEXT,
        duration_seconds INTEGER,
        created_by       TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        completed_at     TEXT
      );
      CREATE INDEX idx_queue_status_next ON call_queue(status, next_attempt_at);
      CREATE INDEX idx_queue_student ON call_queue(student_id, assignment_id);
      CREATE INDEX idx_queue_provider_call ON call_queue(provider_call_id);

      -- One row per dial attempt: permanent history.
      CREATE TABLE call_logs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id         INTEGER NOT NULL REFERENCES call_queue(id) ON DELETE CASCADE,
        student_id       INTEGER REFERENCES students(id) ON DELETE SET NULL,
        assignment_id    INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
        attempt          INTEGER NOT NULL,
        provider         TEXT NOT NULL,
        provider_call_id TEXT,
        to_number        TEXT NOT NULL,              -- number actually dialled (audit)
        message          TEXT NOT NULL,
        status           TEXT NOT NULL,
        provider_status  TEXT,
        started_at       TEXT NOT NULL,
        ended_at         TEXT,
        duration_seconds INTEGER,
        error_code       TEXT,
        error_message    TEXT
      );
      CREATE INDEX idx_logs_started ON call_logs(started_at);
      CREATE INDEX idx_logs_queue ON call_logs(queue_id);
      CREATE INDEX idx_logs_provider_call ON call_logs(provider_call_id);
    `,
  },
];
