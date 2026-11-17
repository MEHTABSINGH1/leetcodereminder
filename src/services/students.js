'use strict';

const { normalizePhone } = require('../lib/phone');
const { parseStudentCsv, parseStudentRows } = require('../lib/csv');
const { readXlsxRows, XlsxError } = require('../lib/xlsx');
const { transaction } = require('../db');
const { httpError } = require('./settings');

const CONSENT_VALUES = ['pending', 'granted', 'revoked'];

function parseConsent(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', '1', 'granted', 'agreed'].includes(s)) return 'granted';
  if (['no', 'n', 'false', '0', 'revoked', 'denied'].includes(s)) return 'revoked';
  return null;
}

function cleanText(v, max = 120) {
  const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function createStudentService(db) {
  const SELECT = `
    SELECT s.*, COALESCE(p.consent_status, 'pending') AS consent_status, p.consent_source, p.consent_at,
           COALESCE(p.opted_out, 0) AS opted_out, p.opted_out_at, p.opt_out_source
    FROM students s LEFT JOIN student_call_preferences p ON p.student_id = s.id`;

  const upsertPref = db.prepare(`
    INSERT INTO student_call_preferences (student_id, consent_status, consent_source, consent_at, opted_out, opted_out_at, opt_out_source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      consent_status = excluded.consent_status, consent_source = excluded.consent_source, consent_at = excluded.consent_at,
      opted_out = excluded.opted_out, opted_out_at = excluded.opted_out_at, opt_out_source = excluded.opt_out_source,
      updated_at = excluded.updated_at`);

  const service = {
    list({ squad, includeInactive = false } = {}) {
      const where = [];
      const args = [];
      if (!includeInactive) where.push('s.active = 1');
      if (squad) {
        where.push('s.squad = ?');
        args.push(squad);
      }
      return db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.name`).all(...args);
    },

    get(id) {
      return db.prepare(`${SELECT} WHERE s.id = ?`).get(Number(id)) || null;
    },

    squads() {
      return db
        .prepare("SELECT DISTINCT squad FROM students WHERE squad IS NOT NULL AND squad <> '' AND active = 1 ORDER BY squad")
        .all()
        .map((r) => r.squad);
    },

    validate(input) {
      const name = cleanText(input.name, 80);
      if (!name) throw httpError(400, 'Name is required');
      const phone = normalizePhone(input.phone);
      if (!phone.ok) throw httpError(400, phone.error);
      const lc = cleanText(input.leetcode_username, 60);
      if (lc && !/^[A-Za-z0-9_.-]+$/.test(lc)) throw httpError(400, 'Invalid LeetCode username');
      const email = cleanText(input.email, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Invalid email');
      return { name, phone: phone.e164, email, leetcode_username: lc, squad: cleanText(input.squad, 60) };
    },

    create(input, actor = 'admin') {
      const v = service.validate(input);
      const now = new Date().toISOString();
      try {
        return transaction(db, () => {
          const r = db
            .prepare(
              `INSERT INTO students (name, phone, email, leetcode_username, squad, active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
            )
            .run(v.name, v.phone, v.email, v.leetcode_username, v.squad, now, now);
          const id = Number(r.lastInsertRowid);
          const consent = CONSENT_VALUES.includes(input.consent_status) ? input.consent_status : 'pending';
          service.setPreferences(id, { consent_status: consent }, actor);
          return service.get(id);
        });
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw httpError(409, 'A student with this phone number already exists');
        throw e;
      }
    },

    update(id, input) {
      const existing = service.get(id);
      if (!existing) throw httpError(404, 'Student not found');
      const v = service.validate({ ...existing, ...input });
      try {
        db.prepare(
          `UPDATE students SET name = ?, phone = ?, email = ?, leetcode_username = ?, squad = ?, updated_at = ? WHERE id = ?`
        ).run(v.name, v.phone, v.email, v.leetcode_username, v.squad, new Date().toISOString(), existing.id);
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw httpError(409, 'Another student already uses this phone number');
        throw e;
      }
      return service.get(id);
    },

    /** Soft delete keeps call history intact. */
    deactivate(id) {
      const r = db.prepare('UPDATE students SET active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), Number(id));
      if (!r.changes) throw httpError(404, 'Student not found');
      db.prepare("UPDATE call_queue SET status = 'cancelled', last_error = 'Student removed', updated_at = ? WHERE student_id = ? AND status = 'queued'").run(
        new Date().toISOString(),
        Number(id)
      );
    },

    /**
     * Update consent / opt-out. Opting out also cancels any queued calls.
     * `source` records how the change happened (admin, csv, keypad, ...).
     */
    setPreferences(id, { consent_status, opted_out }, source = 'admin') {
      const student = db.prepare('SELECT id FROM students WHERE id = ?').get(Number(id));
      if (!student) throw httpError(404, 'Student not found');
      const cur = db.prepare('SELECT * FROM student_call_preferences WHERE student_id = ?').get(student.id) || {
        consent_status: 'pending',
        consent_source: null,
        consent_at: null,
        opted_out: 0,
        opted_out_at: null,
        opt_out_source: null,
      };
      const now = new Date().toISOString();
      const next = { ...cur };
      if (consent_status !== undefined) {
        if (!CONSENT_VALUES.includes(consent_status)) throw httpError(400, 'Invalid consent status');
        if (consent_status !== cur.consent_status) {
          next.consent_status = consent_status;
          next.consent_source = source;
          next.consent_at = now;
        }
      }
      if (opted_out !== undefined) {
        const o = opted_out ? 1 : 0;
        if (o !== cur.opted_out) {
          next.opted_out = o;
          next.opted_out_at = o ? now : null;
          next.opt_out_source = o ? source : null;
        }
      }
      transaction(db, () => {
        upsertPref.run(
          student.id,
          next.consent_status,
          next.consent_source,
          next.consent_at,
          next.opted_out,
          next.opted_out_at,
          next.opt_out_source,
          now
        );
        if (next.opted_out || next.consent_status === 'revoked') {
          db.prepare(
            "UPDATE call_queue SET status = 'cancelled', last_error = 'Student opted out / consent revoked', updated_at = ? WHERE student_id = ? AND status = 'queued'"
          ).run(now, student.id);
        }
      });
      return service.get(student.id);
    },

    /** Upsert students from CSV text, matching existing students by phone. */
    importCsv(text, actor = 'admin') {
      return service.importParsed(parseStudentCsv(text), actor);
    },

    /** Import the first worksheet of an .xlsx file (same columns as the CSV). */
    importXlsx(buffer, actor = 'admin') {
      let rows;
      try {
        rows = readXlsxRows(buffer);
      } catch (e) {
        if (e instanceof XlsxError) throw httpError(400, e.message);
        throw e;
      }
      return service.importParsed(parseStudentRows(rows), actor);
    },

    importParsed({ records, errors }, actor = 'admin') {
      if (errors.length) throw httpError(400, errors.join('; '));
      const result = { created: 0, updated: 0, skipped: 0, errors: [] };
      transaction(db, () => {
        for (const rec of records) {
          let v;
          try {
            v = service.validate(rec);
          } catch (e) {
            result.skipped++;
            result.errors.push({ line: rec.line, name: rec.name || '', error: e.message });
            continue;
          }
          const existing = db.prepare('SELECT id FROM students WHERE phone = ?').get(v.phone);
          const now = new Date().toISOString();
          let id;
          if (existing) {
            db.prepare(
              `UPDATE students SET name = ?, email = COALESCE(?, email), leetcode_username = COALESCE(?, leetcode_username),
                 squad = COALESCE(?, squad), active = 1, updated_at = ? WHERE id = ?`
            ).run(v.name, v.email, v.leetcode_username, v.squad, now, existing.id);
            id = existing.id;
            result.updated++;
          } else {
            const r = db
              .prepare(
                `INSERT INTO students (name, phone, email, leetcode_username, squad, active, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
              )
              .run(v.name, v.phone, v.email, v.leetcode_username, v.squad, now, now);
            id = Number(r.lastInsertRowid);
            result.created++;
          }
          const consent = parseConsent(rec.consent);
          if (consent) service.setPreferences(id, { consent_status: consent }, `csv:${actor}`);
          else if (!existing) service.setPreferences(id, { consent_status: 'pending' }, `csv:${actor}`);
        }
      });
      return result;
    },
  };
  return service;
}

module.exports = { createStudentService, parseConsent };
