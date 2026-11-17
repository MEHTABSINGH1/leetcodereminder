'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeCtx } = require('./helpers');
const { callbackToken } = require('../src/lib/tokens');

const BASE_URL = 'https://calls.example.test';
const TWILIO_TOKEN = 'test-auth-token';

async function startServer(opts = {}) {
  const ctx = makeCtx({
    env: {
      PUBLIC_BASE_URL: BASE_URL,
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      TWILIO_PHONE_NUMBER: '+15550001111',
      ...(opts.env || {}),
    },
  });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (path, { method = 'GET', body, headers = {}, form, raw = false } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET' && !('X-Requested-With' in h)) h['X-Requested-With'] = 'fetch';
    let payload;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = text;
    if (!raw) {
      try {
        data = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    return { status: res.status, data, headers: res.headers };
  };
  const login = () => req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse battery' } });
  return { ctx, server, req, login, close: () => new Promise((r) => server.close(r)) };
}

function twilioSign(url, params) {
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  return crypto.createHmac('sha1', TWILIO_TOKEN).update(data).digest('base64');
}

test('admin-only: API requires login and CSRF header; secrets never returned', async () => {
  const t = await startServer();
  try {
    assert.equal((await t.req('/api/students')).status, 401);
    assert.equal((await t.req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope' } })).status, 401);
    assert.equal((await t.login()).status, 200);
    assert.equal((await t.req('/api/students')).status, 200);
    const noCsrf = await t.req('/api/calls/test', { method: 'POST', body: { phone: '9876543210' }, headers: { 'X-Requested-With': 'nope' } });
    assert.equal(noCsrf.status, 403);

    const s = await t.req('/api/settings');
    const json = JSON.stringify(s.data);
    assert.ok(!json.includes(TWILIO_TOKEN), 'auth token must never be sent to the browser');
    assert.equal(s.data.providers.twilio.configured, true);
    assert.equal(s.data.providers.exotel.configured, false);

    // Unconfigured provider cannot be activated; real providers are blocked in tests.
    assert.equal((await t.req('/api/settings', { method: 'PUT', body: { active_provider: 'exotel' } })).status, 400);
    assert.equal((await t.req('/api/settings', { method: 'PUT', body: { active_provider: 'twilio' } })).status, 400);
    assert.equal((await t.req('/api/settings', { method: 'PUT', body: { max_concurrent_calls: 999 } })).status, 400);
    assert.ok((await t.req('/api/audit')).data.some((a) => a.action === 'login'));
  } finally {
    await t.close();
  }
});

test('end-to-end: CSV upload, assign problem, bulk call with confirmation', async () => {
  const t = await startServer();
  try {
    await t.login();
    const csv = 'name,phone,squad,leetcode_username,consent\nRahul Sharma,9876543210,Alpha,rahul,yes\nAman,+91 98765 43211,Beta,,yes\nNoConsent,9876543212,Alpha,,\nBad Phone,12345,Alpha,,yes\n';
    const imp = await t.req('/api/students/import', { method: 'POST', body: { csv } });
    assert.equal(imp.status, 200);
    assert.equal(imp.data.created, 3);
    assert.equal(imp.data.skipped, 1);
    assert.match(imp.data.errors[0].error, /Unrecognised phone|Indian mobile/);

    // Re-upload updates instead of duplicating.
    const again = await t.req('/api/students/import', { method: 'POST', body: { csv: 'name,phone\nRahul S,9876543210\n' } });
    assert.equal(again.data.updated, 1);
    assert.equal((await t.req('/api/students')).data.length, 3);

    const a = await t.req('/api/assignments', { method: 'POST', body: { problem_title: 'Two Sum', difficulty: 'Easy', problem_url: 'https://leetcode.com/problems/two-sum/' } });
    assert.equal(a.status, 201);

    // Dry run tells the admin exactly how many will be called; nothing is queued yet.
    const dry = await t.req('/api/calls/bulk', { method: 'POST', body: { mode: 'pending' } });
    assert.equal(dry.data.dry_run, true);
    assert.equal(dry.data.would_call, 2);
    assert.equal(dry.data.skipped.consent_not_granted, 1);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM call_queue').get().n, 0);

    const go = await t.req('/api/calls/bulk', { method: 'POST', body: { mode: 'pending', confirm: true, request_id: dry.data.request_id } });
    assert.equal(go.status, 202);
    assert.equal(go.data.queued, 2);
    // Double-submit of the same request is a no-op.
    const dup = await t.req('/api/calls/bulk', { method: 'POST', body: { mode: 'pending', confirm: true, request_id: dry.data.request_id } });
    assert.equal(dup.data.queued, 0);

    await t.ctx.worker.tick();
    const dash = await t.req('/api/calls/dashboard?filter=all');
    assert.equal(dash.data.stats.total_calls_today, 2);
    assert.equal(dash.data.rows.find((r) => r.name === 'Rahul S').call_status, 'calling');
    assert.ok(t.ctx.mock.calls.some((c) => /Hello Rahul S!.*Two Sum/.test(c.message)));

    const ann = await t.req('/api/announcements');
    assert.deepEqual(ann.data.map((r) => r.student_name).sort(), ['Aman', 'NoConsent', 'Rahul S'], 'browser announcements need no phone consent');

    const one = await t.req(`/api/calls/student/${dash.data.rows[0].student_id}`, { method: 'POST', body: {} });
    assert.equal(one.status, 409, 'already has an active call');
  } finally {
    await t.close();
  }
});

test('Twilio status callback: token + signature required, updates call status and duration', async () => {
  const t = await startServer();
  try {
    const st = t.ctx.students.create({ name: 'Rahul', phone: '9876543210', consent_status: 'granted' });
    t.ctx.assignments.create({ problem_title: 'Two Sum' });
    const q = t.ctx.calls.enqueue({ studentId: st.id, templateType: 'pending_reminder', source: 'manual', createdBy: 'test' }).queued;
    const [item] = t.ctx.calls.claimDue({ limit: 1, providerName: 'twilio' });
    const sid = 'CA' + 'f'.repeat(32);
    t.ctx.calls.markDispatched(item.id, item.logId, sid, 'queued');

    const path = `/webhooks/twilio/status?q=${q.id}&t=${callbackToken('test-secret', q.id)}`;
    const params = { CallSid: sid, CallStatus: 'completed', CallDuration: '37' };

    assert.equal((await t.req(`/webhooks/twilio/status?q=${q.id}&t=bad`, { method: 'POST', form: params })).status, 403);
    assert.equal((await t.req(path, { method: 'POST', form: params, headers: { 'X-Twilio-Signature': 'forged' } })).status, 403);

    const ok = await t.req(path, { method: 'POST', form: params, headers: { 'X-Twilio-Signature': twilioSign(BASE_URL + path, params) } });
    assert.equal(ok.status, 204);
    const after = t.ctx.calls.getQueueItem(q.id);
    assert.equal(after.status, 'completed');
    assert.equal(after.duration_seconds, 37);

    // Replay is harmless.
    const replay = await t.req(path, { method: 'POST', form: params, headers: { 'X-Twilio-Signature': twilioSign(BASE_URL + path, params) } });
    assert.equal(replay.status, 204);
    assert.equal(t.ctx.calls.logsFor(q.id).length, 1);
  } finally {
    await t.close();
  }
});

test('student presses 9 during a Twilio call -> opted out and never called again', async () => {
  const t = await startServer();
  try {
    const st = t.ctx.students.create({ name: 'Aman', phone: '9876543211', consent_status: 'granted' });
    t.ctx.assignments.create({ problem_title: 'Valid Parentheses' });
    const q = t.ctx.calls.enqueue({ studentId: st.id, templateType: 'pending_reminder', source: 'manual', createdBy: 'test' }).queued;
    const path = `/webhooks/twilio/gather?q=${q.id}&t=${callbackToken('test-secret', q.id)}`;
    const params = { CallSid: 'CA1', Digits: '9' };
    const res = await t.req(path, { method: 'POST', form: params, raw: true, headers: { 'X-Twilio-Signature': twilioSign(BASE_URL + path, params) } });
    assert.equal(res.status, 200);
    assert.match(res.data, /unsubscribed/);
    const after = t.ctx.students.get(st.id);
    assert.equal(after.opted_out, 1);
    assert.equal(after.opt_out_source, 'phone_keypad');
    assert.equal(t.ctx.calls.enqueue({ studentId: st.id, templateType: 'pending_reminder', source: 'manual', createdBy: 'x' }).skipped, 'opted_out');
  } finally {
    await t.close();
  }
});

test('Exotel status callback and greeting text endpoint', async () => {
  const t = await startServer();
  try {
    const st = t.ctx.students.create({ name: 'Priya', phone: '9876543212', consent_status: 'granted' });
    t.ctx.assignments.create({ problem_title: 'Merge Intervals', difficulty: 'Medium' });
    const q = t.ctx.calls.enqueue({ studentId: st.id, templateType: 'pending_reminder', source: 'manual', createdBy: 'test' }).queued;
    const [item] = t.ctx.calls.claimDue({ limit: 1, providerName: 'exotel' });
    t.ctx.calls.markDispatched(item.id, item.logId, 'exo-sid-1', 'queued');

    const greet = await t.req('/webhooks/exotel/greeting?CallSid=exo-sid-1', { raw: true });
    assert.equal(greet.status, 200);
    assert.match(greet.data, /Hello Priya!.*Merge Intervals/);
    assert.equal((await t.req('/webhooks/exotel/greeting?CallSid=unknown', { raw: true })).status, 404);

    const path = `/webhooks/exotel/status?q=${q.id}&t=${callbackToken('test-secret', q.id)}`;
    const res = await t.req(path, { method: 'POST', body: { CallSid: 'exo-sid-1', Status: 'no-answer', ConversationDuration: 0 } });
    assert.equal(res.status, 204);
    const after = t.ctx.calls.getQueueItem(q.id);
    assert.equal(after.status, 'queued', 'no-answer is retried');
    assert.equal(t.ctx.calls.logsFor(q.id)[0].status, 'no_answer');
  } finally {
    await t.close();
  }
});

test('templates are editable with validation; pause/resume and stop scheduled calls', async () => {
  const t = await startServer();
  try {
    await t.login();
    const bad = await t.req('/api/templates/pending_reminder', { method: 'PUT', body: { body: 'Hi {nope}' } });
    assert.equal(bad.status, 400);
    const good = await t.req('/api/templates/pending_reminder', { method: 'PUT', body: { body: 'Hey {first_name}, {problem_title} is pending!' } });
    assert.equal(good.status, 200);
    const st = t.ctx.students.create({ name: 'Aman Verma', phone: '9876543211', consent_status: 'granted' });
    t.ctx.assignments.create({ problem_title: 'Valid Parentheses' });
    const q = t.ctx.calls.enqueue({ studentId: st.id, templateType: 'pending_reminder', source: 'schedule', createdBy: 'scheduler' }).queued;
    assert.equal(q.message, 'Hey Aman, Valid Parentheses is pending!');

    assert.equal((await t.req('/api/automation/pause', { method: 'POST', body: {} })).data.automation_paused, true);
    assert.equal(t.ctx.settings.get('automation_paused'), true);
    const stop = await t.req('/api/calls/cancel', { method: 'POST', body: { scope: 'scheduled' } });
    assert.equal(stop.data.cancelled, 1);
    assert.equal(t.ctx.calls.getQueueItem(q.id).status, 'cancelled');
    await t.req('/api/automation/resume', { method: 'POST', body: {} });
    assert.equal(t.ctx.settings.get('automation_paused'), false);
  } finally {
    await t.close();
  }
});
