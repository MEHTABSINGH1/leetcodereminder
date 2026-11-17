'use strict';

const { parseHHMM } = require('../lib/time');

const STATUS_VALUES = ['no_answer', 'busy', 'failed'];

/** Validators/parsers for each setting. Unknown keys are rejected. */
const SPEC = {
  active_provider: { type: 'enum', values: ['mock', 'twilio', 'exotel'] },
  automation_paused: { type: 'bool' },
  calling_hours_start: { type: 'hhmm' },
  calling_hours_end: { type: 'hhmm' },
  max_concurrent_calls: { type: 'int', min: 1, max: 20 },
  calls_per_minute: { type: 'int', min: 1, max: 120 },
  max_attempts: { type: 'int', min: 1, max: 6 },
  retry_base_seconds: { type: 'int', min: 30, max: 86400 },
  retry_on_statuses: { type: 'list', values: STATUS_VALUES },
  min_minutes_between_calls: { type: 'int', min: 0, max: 1440 },
  schedule_grace_minutes: { type: 'int', min: 1, max: 600 },
  require_consent: { type: 'bool' },
  opt_out_prompt_enabled: { type: 'bool' },
  stale_call_minutes: { type: 'int', min: 2, max: 240 },
  leetcode_sync_enabled: { type: 'bool' },
  overdue_lookback_days: { type: 'int', min: 1, max: 30 },
};

function parseValue(spec, raw) {
  switch (spec.type) {
    case 'bool':
      return raw === 'true';
    case 'int':
      return Number(raw);
    case 'list':
      return raw ? raw.split(',').filter(Boolean) : [];
    default:
      return raw;
  }
}

function validateValue(key, value) {
  const spec = SPEC[key];
  if (!spec) throw httpError(400, `Unknown setting "${key}"`);
  switch (spec.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw httpError(400, `${key} must be true or false`);
      return String(value);
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw httpError(400, `${key} must be an integer between ${spec.min} and ${spec.max}`);
      }
      return String(n);
    }
    case 'hhmm':
      if (parseHHMM(value) === null) throw httpError(400, `${key} must be HH:MM (24h)`);
      return value;
    case 'enum':
      if (!spec.values.includes(value)) throw httpError(400, `${key} must be one of ${spec.values.join(', ')}`);
      return value;
    case 'list': {
      const arr = Array.isArray(value) ? value : String(value).split(',');
      for (const v of arr) if (!spec.values.includes(v)) throw httpError(400, `${key}: invalid value "${v}"`);
      return arr.join(',');
    }
    default:
      throw httpError(400, `Unsupported setting ${key}`);
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function createSettingsService(db) {
  const getAllStmt = db.prepare('SELECT key, value FROM call_provider_settings');
  const upsert = db.prepare(
    `INSERT INTO call_provider_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  return {
    getAll() {
      const out = {};
      for (const { key, value } of getAllStmt.all()) {
        if (SPEC[key]) out[key] = parseValue(SPEC[key], value);
      }
      return out;
    },
    get(key) {
      return this.getAll()[key];
    },
    /** Validate all values first, then write atomically. */
    update(patch) {
      const entries = Object.entries(patch || {}).map(([k, v]) => [k, validateValue(k, v)]);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [k, v] of entries) upsert.run(k, v, now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return this.getAll();
    },
  };
}

module.exports = { createSettingsService, httpError, SETTINGS_SPEC: SPEC };
