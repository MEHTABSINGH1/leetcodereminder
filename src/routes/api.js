'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { httpError } = require('../services/settings');
const { TEMPLATE_TYPES, PLACEHOLDERS, renderTemplate, validateTemplate } = require('../lib/templates');

/** Admin API. Every route here is behind auth.requireAdmin. */
function createApiRouter(ctx) {
  const { auth, students, assignments, calls, settings, scheduler, providers, audit, leetcodeSync, config, db } = ctx;
  const r = express.Router();
  const actor = (req) => req.admin;
  const log = (req, action, details) => audit.log(req.admin, action, details, req.ip);
  const ids = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

  r.post('/auth/login', (req, res) => {
    auth.login(req, res);
    if (res.statusCode === 200) audit.log(req.body.username, 'login', {}, req.ip);
  });
  r.post('/auth/logout', (req, res) => auth.logout(req, res));

  r.use(auth.requireAdmin);

  r.get('/me', (req, res) => res.json({ username: req.admin, timezone: config.timezone, today: assignments.today() }));

  // ---------- students ----------
  r.get('/students', (req, res) => res.json(students.list({ squad: req.query.squad || undefined })));
  r.get('/squads', (req, res) => res.json(students.squads()));
  r.post('/students', (req, res) => {
    const s = students.create(req.body || {}, actor(req));
    log(req, 'student_create', { studentId: s.id });
    res.status(201).json(s);
  });
  r.put('/students/:id', (req, res) => {
    const s = students.update(req.params.id, req.body || {});
    log(req, 'student_update', { studentId: s.id });
    res.json(s);
  });
  r.delete('/students/:id', (req, res) => {
    students.deactivate(req.params.id);
    log(req, 'student_remove', { studentId: Number(req.params.id) });
    res.status(204).end();
  });
  /** Import students from CSV text ({ csv }) or an Excel workbook ({ xlsx: base64 }). */
  r.post('/students/import', (req, res) => {
    const { csv, xlsx } = req.body || {};
    let result;
    let format;
    if (typeof xlsx === 'string' && xlsx) {
      if (xlsx.length > 7_000_000) throw httpError(413, 'Spreadsheet too large (max 5 MB)');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(xlsx)) throw httpError(400, 'Invalid file encoding');
      format = 'xlsx';
      result = students.importXlsx(Buffer.from(xlsx, 'base64'), actor(req));
    } else if (typeof csv === 'string' && csv.trim()) {
      if (csv.length > 2_000_000) throw httpError(413, 'CSV too large');
      format = 'csv';
      result = students.importCsv(csv, actor(req));
    } else {
      throw httpError(400, 'Provide a CSV ("csv") or Excel file ("xlsx", base64)');
    }
    log(req, 'students_import', { format, created: result.created, updated: result.updated, skipped: result.skipped });
    res.json(result);
  });
  r.put('/students/:id/preferences', (req, res) => {
    const { consent_status, opted_out } = req.body || {};
    const s = students.setPreferences(req.params.id, { consent_status, opted_out }, `admin:${actor(req)}`);
    log(req, 'student_preferences', { studentId: s.id, consent_status, opted_out });
    res.json(s);
  });
  r.post('/students/preferences/bulk', (req, res) => {
    const list = ids(req.body?.student_ids);
    const { consent_status, opted_out } = req.body || {};
    for (const id of list) students.setPreferences(id, { consent_status, opted_out }, `admin:${actor(req)}`);
    log(req, 'student_preferences_bulk', { count: list.length, consent_status, opted_out });
    res.json({ updated: list.length });
  });
  r.get('/students/:id/calls', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT l.*, a.problem_title FROM call_logs l LEFT JOIN assignments a ON a.id = l.assignment_id
           WHERE l.student_id = ? ORDER BY l.id DESC LIMIT 100`
        )
        .all(Number(req.params.id))
    );
  });

  // ---------- assignments ----------
  r.get('/assignments', (req, res) => res.json(assignments.list({ date: req.query.date || undefined })));
  r.post('/assignments', async (req, res) => {
    const a = assignments.create(req.body || {});
    log(req, 'assignment_create', { assignmentId: a.id, problem: a.problem_title, squad: a.squad });
    let announced = null;
    if (req.body?.announce_by_call) {
      const targets = assignments.findTargets({ audience: 'unsolved', assignmentId: a.id });
      announced = { queued: 0, skipped: {} };
      for (const t of targets) {
        const out = calls.enqueue({
          studentId: t.student_id,
          assignmentId: a.id,
          templateType: 'assignment_announcement',
          source: 'bulk',
          createdBy: actor(req),
          idempotencyKey: `announce:${a.id}:${t.student_id}`,
        });
        if (out.queued) announced.queued++;
        else announced.skipped[out.skipped] = (announced.skipped[out.skipped] || 0) + 1;
      }
      log(req, 'assignment_announce_calls', { assignmentId: a.id, ...announced });
    }
    res.status(201).json({ assignment: a, announced });
  });
  r.delete('/assignments/:id', (req, res) => {
    assignments.remove(req.params.id);
    log(req, 'assignment_delete', { assignmentId: Number(req.params.id) });
    res.status(204).end();
  });
  r.get('/assignments/:id/progress', (req, res) => res.json(assignments.progress(req.params.id)));
  r.put('/assignments/:id/progress/:studentId', (req, res) => {
    assignments.setProgress(req.params.id, req.params.studentId, req.body?.status, `manual:${actor(req)}`);
    log(req, 'progress_update', { assignmentId: Number(req.params.id), studentId: Number(req.params.studentId), status: req.body?.status });
    res.json({ ok: true });
  });
  r.post('/assignments/:id/sync', async (req, res) => {
    if (!assignments.get(req.params.id)) throw httpError(404, 'Assignment not found');
    const result = await leetcodeSync.syncTargets(assignments.progress(req.params.id));
    log(req, 'leetcode_sync', { assignmentId: Number(req.params.id), ...result });
    res.json(result);
  });

  // ---------- voice calls ----------
  r.get('/calls/dashboard', (req, res) => {
    const data = calls.dashboard({ filter: req.query.filter || 'all', squad: req.query.squad || null });
    const s = settings.getAll();
    res.json({ ...data, automation_paused: s.automation_paused, active_provider: s.active_provider });
  });
  r.get('/calls/:queueId/logs', (req, res) => res.json(calls.logsFor(req.params.queueId)));

  r.post('/calls/student/:id', (req, res) => {
    const templateType = req.body?.template_type || 'pending_reminder';
    const out = calls.enqueue({
      studentId: Number(req.params.id),
      assignmentId: req.body?.assignment_id ? Number(req.body.assignment_id) : undefined,
      templateType,
      source: 'manual',
      createdBy: actor(req),
      idempotencyKey: req.get('idempotency-key') ? `manual:${req.get('idempotency-key')}` : undefined,
    });
    log(req, 'call_student', { studentId: Number(req.params.id), templateType, result: out.queued ? 'queued' : out.skipped });
    if (out.skipped) return res.status(409).json({ error: `Not queued: ${out.skipped.replace(/_/g, ' ')}`, reason: out.skipped });
    res.status(202).json(out.queued);
  });

  /**
   * Bulk calls. Without confirm=true this is a dry run returning exactly how many students
   * would be contacted (the dashboard shows it in a confirmation dialog).
   */
  r.post('/calls/bulk', (req, res) => {
    const body = req.body || {};
    const templateType = body.template_type || 'pending_reminder';
    if (!TEMPLATE_TYPES.includes(templateType)) throw httpError(400, 'Invalid template_type');
    let candidates;
    if (body.mode === 'pending') {
      const seen = new Set();
      candidates = assignments
        .findTargets({ audience: 'unsolved', squad: body.squad || undefined })
        .filter((t) => (seen.has(t.student_id) ? false : seen.add(t.student_id)))
        .map((t) => ({ studentId: t.student_id, assignmentId: t.assignment_id }));
    } else if (body.mode === 'selected') {
      candidates = ids(body.student_ids).map((id) => ({ studentId: id }));
      if (!candidates.length) throw httpError(400, 'No students selected');
    } else throw httpError(400, 'mode must be "pending" or "selected"');

    const requestId = String(req.get('idempotency-key') || body.request_id || crypto.randomUUID()).slice(0, 64);
    const run = () => {
      const summary = { queued: 0, skipped: {}, students: [] };
      for (const c of candidates) {
        const out = calls.enqueue({
          ...c,
          templateType,
          source: 'bulk',
          createdBy: actor(req),
          idempotencyKey: `bulk:${requestId}:${c.studentId}`,
        });
        if (out.queued) {
          summary.queued++;
          summary.students.push(students.get(c.studentId)?.name);
        } else summary.skipped[out.skipped] = (summary.skipped[out.skipped] || 0) + 1;
      }
      return summary;
    };

    if (body.confirm !== true) {
      // Dry run inside a transaction that is always rolled back.
      db.exec('BEGIN IMMEDIATE');
      let preview;
      try {
        preview = run();
      } finally {
        db.exec('ROLLBACK');
      }
      return res.json({ dry_run: true, would_call: preview.queued, skipped: preview.skipped, students: preview.students, request_id: requestId });
    }
    const summary = run();
    log(req, 'call_bulk', { mode: body.mode, templateType, queued: summary.queued, skipped: summary.skipped });
    res.status(202).json({ dry_run: false, ...summary });
  });

  r.post('/calls/retry-failed', (req, res) => {
    const out = calls.retryFailed({ queueIds: ids(req.body?.queue_ids) });
    log(req, 'call_retry_failed', out);
    res.json(out);
  });
  r.post('/calls/cancel', (req, res) => {
    const n = calls.cancel({ queueIds: ids(req.body?.queue_ids), scope: req.body?.scope });
    log(req, 'call_cancel', { scope: req.body?.scope || 'selected', cancelled: n });
    res.json({ cancelled: n });
  });
  r.post('/calls/test', (req, res) => {
    const s = settings.getAll();
    const item = calls.enqueueTest({ phone: req.body?.phone, templateType: req.body?.template_type, createdBy: actor(req) });
    log(req, 'call_test', { queueId: item.id, provider: s.active_provider });
    res.status(202).json({ ...item, provider: s.active_provider });
  });
  r.post('/automation/pause', (req, res) => {
    settings.update({ automation_paused: true });
    const cancelled = req.body?.cancel_queued ? calls.cancel({ scope: 'scheduled' }, 'Automation paused') : 0;
    log(req, 'automation_pause', { cancelled });
    res.json({ automation_paused: true, cancelled });
  });
  r.post('/automation/resume', (req, res) => {
    settings.update({ automation_paused: false });
    log(req, 'automation_resume', {});
    res.json({ automation_paused: false });
  });

  // ---------- browser announcements (free, no telephony) ----------
  r.get('/announcements', (req, res) => {
    const seen = new Set();
    const rows = assignments
      .findTargets({ audience: 'unsolved', squad: req.query.squad || undefined })
      .filter((t) => (seen.has(t.student_id) ? false : seen.add(t.student_id)))
      .map((t) => ({ student_id: t.student_id, student_name: t.student_name, squad: t.squad, problem_title: t.problem_title, difficulty: t.difficulty }));
    res.json(rows);
  });

  // ---------- templates ----------
  r.get('/templates', (req, res) => res.json({ templates: calls.templates.list(), placeholders: PLACEHOLDERS }));
  r.put('/templates/:type', (req, res) => {
    const t = calls.templates.update(req.params.type, req.body || {}, actor(req));
    log(req, 'template_update', { type: req.params.type });
    res.json(t);
  });
  r.post('/templates/:type/reset', (req, res) => {
    const t = calls.templates.reset(req.params.type, actor(req));
    log(req, 'template_reset', { type: req.params.type });
    res.json(t);
  });
  r.post('/templates/preview', (req, res) => {
    const errors = validateTemplate(req.body?.body);
    const text = renderTemplate(String(req.body?.body || ''), {
      student_name: 'Rahul Sharma',
      problem_title: 'Two Sum',
      difficulty: 'Easy',
      deadline: '11:59 PM today',
      mentor_name: config.mentorName,
      squad: 'Alpha',
    });
    res.json({ text, errors });
  });

  // ---------- schedules & holidays ----------
  r.get('/schedules', (req, res) => res.json(scheduler.schedules.list()));
  r.post('/schedules', (req, res) => {
    const s = scheduler.schedules.create(req.body || {});
    log(req, 'schedule_create', { scheduleId: s.id });
    res.status(201).json(s);
  });
  r.put('/schedules/:id', (req, res) => {
    const s = scheduler.schedules.update(req.params.id, req.body || {});
    log(req, 'schedule_update', { scheduleId: s.id, enabled: s.enabled });
    res.json(s);
  });
  r.delete('/schedules/:id', (req, res) => {
    scheduler.schedules.remove(req.params.id);
    log(req, 'schedule_delete', { scheduleId: Number(req.params.id) });
    res.status(204).end();
  });
  r.post('/schedules/:id/run-now', async (req, res) => {
    const out = await scheduler.runNow(req.params.id, actor(req));
    log(req, 'schedule_run_now', { scheduleId: Number(req.params.id), ...out });
    res.json(out);
  });
  r.get('/holidays', (req, res) => res.json(scheduler.holidays.list()));
  r.post('/holidays', (req, res) => {
    scheduler.holidays.add(req.body?.date, req.body?.reason);
    log(req, 'holiday_add', { date: req.body?.date });
    res.status(201).json({ ok: true });
  });
  r.delete('/holidays/:date', (req, res) => {
    scheduler.holidays.remove(req.params.date);
    log(req, 'holiday_remove', { date: req.params.date });
    res.status(204).end();
  });

  // ---------- settings (no secrets ever leave the server) ----------
  r.get('/settings', (req, res) => {
    res.json({
      settings: settings.getAll(),
      providers: providers.status(),
      callbacks_enabled: Boolean(config.publicBaseUrl),
      timezone: config.timezone,
      exotel_greeting_url: config.publicBaseUrl ? `${config.publicBaseUrl}/webhooks/exotel/greeting` : null,
    });
  });
  r.put('/settings', (req, res) => {
    const patch = req.body || {};
    if (patch.active_provider && !providers.get(patch.active_provider).isConfigured()) {
      throw httpError(400, `Provider "${patch.active_provider}" is not configured. Add its credentials to .env and restart.`);
    }
    if (config.isTest && patch.active_provider && patch.active_provider !== 'mock') {
      throw httpError(400, 'Real providers are disabled in test mode');
    }
    const updated = settings.update(patch);
    log(req, 'settings_update', { keys: Object.keys(patch), active_provider: patch.active_provider });
    res.json(updated);
  });

  r.get('/audit', (req, res) => res.json(audit.list({ limit: req.query.limit })));

  return r;
}

module.exports = { createApiRouter };
