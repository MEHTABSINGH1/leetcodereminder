'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const migrations = require('./schema');
const { DEFAULT_TEMPLATES } = require('../lib/templates');

const DEFAULT_SETTINGS = {
  active_provider: 'mock',
  automation_paused: 'false',
  calling_hours_start: '09:00',
  calling_hours_end: '22:30',
  max_concurrent_calls: '3',
  calls_per_minute: '10',
  max_attempts: '3',
  retry_base_seconds: '300',
  retry_on_statuses: 'no_answer,busy,failed',
  min_minutes_between_calls: '60',
  schedule_grace_minutes: '45',
  require_consent: 'true',
  opt_out_prompt_enabled: 'true',
  stale_call_minutes: '15',
  leetcode_sync_enabled: 'true',
  overdue_lookback_days: '3',
};

const DEFAULT_SCHEDULES = [
  { name: 'Morning: today\'s problem', time: '10:00', template: 'first_reminder', audience: 'unsolved' },
  { name: 'Afternoon: not started', time: '16:00', template: 'pending_reminder', audience: 'not_started' },
  { name: 'Evening: not solved', time: '20:00', template: 'pending_reminder', audience: 'unsolved' },
  { name: 'Night: final reminder', time: '22:00', template: 'final_reminder', audience: 'unsolved' },
];

/**
 * Open (and migrate) the database. `settingDefaults` overrides seeded defaults
 * for settings that don't exist yet (e.g. active_provider from CALL_PROVIDER).
 */
function openDatabase(dbPath, settingDefaults = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  seed(db, { ...DEFAULT_SETTINGS, ...settingDefaults });
  return db;
}

/** Run fn inside a transaction (re-entrant: nested calls join the outer one). */
function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString()
      );
    });
  }
}

function seed(db, settings) {
  const now = new Date().toISOString();
  transaction(db, () => {
    const insTpl = db.prepare(
      'INSERT OR IGNORE INTO call_templates (type, name, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)'
    );
    for (const [type, t] of Object.entries(DEFAULT_TEMPLATES)) insTpl.run(type, t.name, t.body, now, 'system');

    const insSet = db.prepare('INSERT OR IGNORE INTO call_provider_settings (key, value, updated_at) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries(settings)) insSet.run(k, String(v), now);

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM call_schedules').get();
    if (n === 0) {
      const insSch = db.prepare(
        `INSERT INTO call_schedules (name, time_of_day, days_of_week, template_type, audience, enabled, created_at, updated_at)
         VALUES (?, ?, '0,1,2,3,4,5,6', ?, ?, 1, ?, ?)`
      );
      for (const s of DEFAULT_SCHEDULES) insSch.run(s.name, s.time, s.template, s.audience, now, now);
    }
  });
}

module.exports = { openDatabase, transaction, DEFAULT_SETTINGS };
