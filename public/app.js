'use strict';

/* LeetCode Reminder admin dashboard (vanilla JS, no build step).
 * All dynamic text is inserted with textContent via el() to prevent XSS. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (res.status === 401 && path !== '/auth/login') {
    showLogin();
    throw new Error('Please sign in');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const fail = (e) => toast(e.message || String(e), 5000);

/** Confirmation modal; resolves true/false. */
function confirmDialog(title, bodyNodes, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    const body = $('#modal-body');
    body.replaceChildren(...[].concat(bodyNodes));
    $('#modal-ok').textContent = okLabel;
    $('#modal').hidden = false;
    const done = (v) => {
      $('#modal').hidden = true;
      $('#modal-ok').onclick = $('#modal-cancel').onclick = null;
      resolve(v);
    };
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}

const STATUS_CLASS = { completed: 'ok', calling: 'info', queued: 'info', no_answer: 'warn', busy: 'warn', failed: 'bad', cancelled: '' };
const STATUS_LABEL = { queued: 'Queued', calling: 'Calling', completed: 'Completed', no_answer: 'No Answer', busy: 'Busy', failed: 'Failed', cancelled: 'Cancelled' };
const PROGRESS_LABEL = { not_started: 'Not started', attempted: 'Attempted', solved: 'Solved' };
const TEMPLATE_LABEL = {
  first_reminder: 'First daily reminder',
  pending_reminder: 'Pending reminder',
  final_reminder: 'Final deadline reminder',
  overdue_reminder: 'Overdue reminder',
  assignment_announcement: 'Assignment announcement',
};
const AUDIENCE_LABEL = { unsolved: 'Not solved', not_started: "Haven't started", overdue: 'Overdue' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const state = { me: null, squads: [], settings: null, tab: 'calls', callsTimer: null, progressAssignment: null };

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDuration = (s) => (s === null || s === undefined ? '—' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const maskPhone = (p) => (p && p.length > 6 ? `${p.slice(0, 3)} ••••• ${p.slice(-4)}` : p || '');
const badge = (text, cls = '') => el('span', { class: `badge ${cls}` }, text);

// ---------------- auth ----------------
function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  stopCallsRefresh();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('/auth/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------------- tabs ----------------
const loaders = {
  calls: loadCalls,
  students: loadStudents,
  assignments: loadAssignments,
  templates: loadTemplates,
  schedules: loadSchedules,
  announce: loadAnnouncements,
  settings: loadSettings,
  audit: loadAudit,
};
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});
function switchTab(tab) {
  state.tab = tab;
  for (const b of $$('#tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of $$('.tab')) s.hidden = s.id !== `tab-${tab}`;
  stopCallsRefresh();
  if (tab === 'calls') state.callsTimer = setInterval(() => loadCalls().catch(() => {}), 5000);
  loaders[tab]().catch(fail);
}
function stopCallsRefresh() {
  clearInterval(state.callsTimer);
  state.callsTimer = null;
}

async function loadSquads() {
  state.squads = await api('/squads');
  for (const sel of ['#call-squad', '#announce-squad', '#assignment-squad']) {
    const s = $(sel);
    const cur = s.value;
    s.replaceChildren(el('option', { value: '' }, sel === '#assignment-squad' ? 'All students' : 'All squads'), ...state.squads.map((q) => el('option', { value: q }, q)));
    s.value = cur;
  }
}

async function refreshHeader() {
  const s = await api('/settings');
  state.settings = s;
  const p = s.settings.active_provider;
  const pb = $('#provider-badge');
  pb.textContent = p === 'mock' ? 'Provider: MOCK (no real calls)' : `Provider: ${p.toUpperCase()} (real paid calls)`;
  pb.className = `badge ${p === 'mock' ? 'info' : 'warn'}`;
}

// ---------------- voice calls ----------------
async function loadCalls() {
  const filter = $('#call-filter').value;
  const squad = $('#call-squad').value;
  const data = await api(`/calls/dashboard?filter=${encodeURIComponent(filter)}&squad=${encodeURIComponent(squad)}`);
  const st = data.stats;
  const stats = [
    ['Total students', st.total_students],
    ['Total calls today', st.total_calls_today],
    ['Successful calls', st.successful_calls],
    ['Failed calls', st.failed_calls],
    ['Calls pending', st.calls_pending],
    ['Students not contacted', st.students_not_contacted],
    ['Completed after reminders', st.completed_after_reminders],
  ];
  $('#stats').replaceChildren(...stats.map(([l, v]) => el('div', { class: 'stat' }, el('div', { class: 'value' }, v), el('div', { class: 'label' }, l))));

  const paused = data.automation_paused;
  $('#automation-state').textContent = paused ? 'Automation paused' : 'Automation running';
  $('#automation-state').className = `badge ${paused ? 'warn' : 'ok'}`;
  $('#toggle-automation').textContent = paused ? 'Resume automation' : 'Pause automation';
  $('#toggle-automation').dataset.paused = paused ? '1' : '';
  $('#calls-updated').textContent = `Updated ${new Date().toLocaleTimeString()} · ${data.date}`;

  const selected = new Set($$('#calls-body input[type=checkbox]:checked').map((c) => c.value));
  $('#calls-body').replaceChildren(
    ...(data.rows.length
      ? data.rows.map((r) => {
          const status = r.call_status
            ? badge(STATUS_LABEL[r.call_status] + (r.attempts > 1 ? ` (${r.attempts})` : ''), STATUS_CLASS[r.call_status])
            : r.blocker
              ? badge(r.blocker.replace(/_/g, ' '), 'bad')
              : badge('Not contacted');
          if (r.last_error && r.call_status !== 'completed') status.title = r.last_error;
          const actions = [];
          if (r.call_status === 'queued') actions.push(el('button', { class: 'btn small', onclick: () => cancelCall(r.queue_id) }, 'Cancel'));
          else if (['failed', 'no_answer', 'busy'].includes(r.call_status)) actions.push(el('button', { class: 'btn small', onclick: () => retryCall(r.queue_id) }, 'Retry'));
          if (r.call_status !== 'queued' && r.call_status !== 'calling' && r.problem_title && r.progress_status !== 'solved') {
            actions.push(el('button', { class: 'btn small', onclick: () => callStudent(r) }, 'Call'));
          }
          if (r.queue_id) actions.push(el('button', { class: 'btn small ghost', onclick: () => showHistory(r) }, 'History'));
          return el(
            'tr',
            {},
            el('td', {}, el('input', { type: 'checkbox', value: String(r.student_id), checked: selected.has(String(r.student_id)), 'aria-label': `Select ${r.name}` })),
            el('td', {}, r.name, r.squad ? el('div', { class: 'muted small' }, r.squad) : null),
            el('td', { class: 'num' }, maskPhone(r.phone)),
            el('td', {}, r.problem_title || el('span', { class: 'muted' }, 'No active problem')),
            el('td', {}, r.progress_status ? badge(PROGRESS_LABEL[r.progress_status], r.progress_status === 'solved' ? 'ok' : '') : '—'),
            el('td', {}, status),
            el('td', { class: 'num' }, fmtTime(r.call_time)),
            el('td', { class: 'num' }, fmtDuration(r.duration_seconds)),
            el('td', {}, actions)
          );
        })
      : [el('tr', {}, el('td', { colspan: '9', class: 'muted' }, 'No students match this filter.'))])
  );
}

async function callStudent(r) {
  const ok = await confirmDialog('Call student', el('p', {}, `Place a pending-reminder call to ${r.name} about "${r.problem_title}"?`), 'Call now');
  if (!ok) return;
  try {
    await api(`/calls/student/${r.student_id}`, { method: 'POST', body: { assignment_id: r.assignment_id, template_type: 'pending_reminder' }, idempotencyKey: uuid() });
    toast(`Call to ${r.name} queued`);
    loadCalls();
  } catch (e) {
    fail(e);
  }
}
async function cancelCall(id) {
  try {
    await api('/calls/cancel', { method: 'POST', body: { queue_ids: [id] } });
    toast('Call cancelled');
    loadCalls();
  } catch (e) {
    fail(e);
  }
}
async function retryCall(id) {
  try {
    const r = await api('/calls/retry-failed', { method: 'POST', body: { queue_ids: [id] } });
    toast(r.requeued ? 'Call re-queued' : 'Could not re-queue (another call is already queued)');
    loadCalls();
  } catch (e) {
    fail(e);
  }
}
async function showHistory(r) {
  const logs = await api(`/calls/${r.queue_id}/logs`);
  await confirmDialog(
    `Call history — ${r.name}`,
    [
      el('p', { class: 'small muted' }, logs[0] ? `Message: "${logs[0].message}"` : ''),
      el(
        'table',
        { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Started'), el('th', {}, 'Status'), el('th', {}, 'Duration'), el('th', {}, 'Error'))),
        el(
          'tbody',
          {},
          logs.map((l) =>
            el(
              'tr',
              {},
              el('td', {}, l.attempt),
              el('td', {}, fmtDateTime(l.started_at)),
              el('td', {}, badge(STATUS_LABEL[l.status] || l.status, STATUS_CLASS[l.status])),
              el('td', {}, fmtDuration(l.duration_seconds)),
              el('td', { class: 'small' }, l.error_message || '')
            )
          )
        )
      ),
    ],
    'Close'
  );
}

async function bulkCall(body) {
  const requestId = uuid();
  const preview = await api('/calls/bulk', { method: 'POST', body: { ...body, confirm: false, request_id: requestId } });
  const skipped = Object.entries(preview.skipped);
  if (!preview.would_call) {
    return toast(`No students to call${skipped.length ? ` (skipped: ${skipped.map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')})` : ''}`, 6000);
  }
  const provider = state.settings?.settings.active_provider;
  const ok = await confirmDialog(
    `Call ${preview.would_call} student${preview.would_call === 1 ? '' : 's'}?`,
    [
      el('p', {}, `${preview.would_call} personalised call${preview.would_call === 1 ? '' : 's'} will be queued and placed in controlled batches via `, el('strong', {}, provider), provider === 'mock' ? ' (simulated — no real calls).' : ' (real phone calls, charged by the provider).'),
      el('p', { class: 'small muted' }, preview.students.slice(0, 30).join(', ') + (preview.students.length > 30 ? ` and ${preview.students.length - 30} more` : '')),
      skipped.length ? el('p', { class: 'small' }, 'Will not be called: ' + skipped.map(([k, v]) => `${v} × ${k.replace(/_/g, ' ')}`).join(', ')) : null,
    ],
    `Call ${preview.would_call} students`
  );
  if (!ok) return;
  const res = await api('/calls/bulk', { method: 'POST', body: { ...body, confirm: true, request_id: requestId }, idempotencyKey: requestId });
  toast(`${res.queued} calls queued`);
  loadCalls();
}

$('#call-pending').addEventListener('click', () => bulkCall({ mode: 'pending', squad: $('#call-squad').value || undefined, template_type: 'pending_reminder' }).catch(fail));
$('#call-selected').addEventListener('click', () => {
  const ids = $$('#calls-body input[type=checkbox]:checked').map((c) => Number(c.value));
  if (!ids.length) return toast('Select students first');
  bulkCall({ mode: 'selected', student_ids: ids, template_type: 'pending_reminder' }).catch(fail);
});
$('#select-all').addEventListener('change', (e) => $$('#calls-body input[type=checkbox]').forEach((c) => (c.checked = e.target.checked)));
$('#retry-failed').addEventListener('click', async () => {
  if (!(await confirmDialog('Retry failed calls', el('p', {}, "Re-queue all of today's failed, busy and unanswered calls for one more attempt?"), 'Retry'))) return;
  try {
    const r = await api('/calls/retry-failed', { method: 'POST', body: {} });
    toast(`${r.requeued} calls re-queued`);
    loadCalls();
  } catch (e) {
    fail(e);
  }
});
$('#stop-scheduled').addEventListener('click', async () => {
  if (!(await confirmDialog('Stop scheduled calls', el('p', {}, 'Cancel every scheduled call that is still waiting in the queue? Calls already ringing are not affected.'), 'Stop calls'))) return;
  try {
    const r = await api('/calls/cancel', { method: 'POST', body: { scope: 'scheduled' } });
    toast(`${r.cancelled} queued calls cancelled`);
    loadCalls();
  } catch (e) {
    fail(e);
  }
});
$('#toggle-automation').addEventListener('click', async (e) => {
  const paused = Boolean(e.target.dataset.paused);
  try {
    await api(paused ? '/automation/resume' : '/automation/pause', { method: 'POST', body: {} });
    toast(paused ? 'Automation resumed' : 'Automation paused — schedules will not run');
    loadCalls();
  } catch (err) {
    fail(err);
  }
});
$('#test-call').addEventListener('click', async () => {
  const input = el('input', { type: 'tel', placeholder: 'Your own phone number', class: 'full' });
  const tpl = el('select', {}, Object.entries(TEMPLATE_LABEL).map(([k, v]) => el('option', { value: k }, v)));
  const provider = state.settings?.settings.active_provider;
  const ok = await confirmDialog(
    'Test call',
    [
      el('p', { class: 'small' }, provider === 'mock' ? 'Mock provider: the call is simulated, nothing rings.' : `This places a REAL call through ${provider} (charged).`),
      el('label', {}, 'Phone number ', input),
      el('label', {}, 'Script ', tpl),
      el('p', { class: 'small muted' }, 'Sample data is used (student "Rahul", problem "Two Sum").'),
    ],
    'Place test call'
  );
  if (!ok) return;
  try {
    await api('/calls/test', { method: 'POST', body: { phone: input.value, template_type: tpl.value } });
    toast('Test call queued');
  } catch (e) {
    fail(e);
  }
});
$('#call-filter').addEventListener('change', () => loadCalls().catch(fail));
$('#call-squad').addEventListener('change', () => loadCalls().catch(fail));

// ---------------- students ----------------
async function loadStudents() {
  await loadSquads();
  const list = await api('/students');
  $('#students-body').replaceChildren(
    ...(list.length
      ? list.map((s) => {
          const consent = el(
            'select',
            { 'aria-label': `Consent for ${s.name}`, onchange: (e) => updatePrefs(s.id, { consent_status: e.target.value }) },
            ['pending', 'granted', 'revoked'].map((v) => el('option', { value: v, selected: s.consent_status === v }, v))
          );
          const optOut = el('input', { type: 'checkbox', checked: Boolean(s.opted_out), 'aria-label': `Opted out ${s.name}`, onchange: (e) => updatePrefs(s.id, { opted_out: e.target.checked }) });
          return el(
            'tr',
            {},
            el('td', {}, el('input', { type: 'checkbox', value: String(s.id), 'aria-label': `Select ${s.name}` })),
            el('td', {}, s.name),
            el('td', { class: 'num' }, s.phone),
            el('td', {}, s.squad || ''),
            el('td', {}, s.leetcode_username || ''),
            el('td', {}, consent),
            el('td', {}, optOut, s.opt_out_source ? el('span', { class: 'muted small' }, ` (${s.opt_out_source})`) : null),
            el('td', {}, el('button', { class: 'btn small danger', onclick: () => removeStudent(s) }, 'Remove'))
          );
        })
      : [el('tr', {}, el('td', { colspan: '8', class: 'muted' }, 'No students yet. Upload a CSV to get started.'))])
  );
}
async function updatePrefs(id, body) {
  try {
    await api(`/students/${id}/preferences`, { method: 'PUT', body });
    toast('Saved');
  } catch (e) {
    fail(e);
    loadStudents();
  }
}
async function removeStudent(s) {
  if (!(await confirmDialog('Remove student', el('p', {}, `Remove ${s.name}? Their call history is kept; queued calls are cancelled.`), 'Remove'))) return;
  try {
    await api(`/students/${s.id}`, { method: 'DELETE' });
    loadStudents();
  } catch (e) {
    fail(e);
  }
}
$('#students-select-all').addEventListener('change', (e) => $$('#students-body input[type=checkbox][value]').forEach((c) => (c.checked = e.target.checked)));
async function bulkConsent(status) {
  const ids = $$('#students-body input[type=checkbox][value]:checked').map((c) => Number(c.value));
  if (!ids.length) return toast('Select students first');
  if (!(await confirmDialog('Update consent', el('p', {}, `Record consent as "${status}" for ${ids.length} students? Only do this if you have their consent on record.`), 'Update'))) return;
  try {
    await api('/students/preferences/bulk', { method: 'POST', body: { student_ids: ids, consent_status: status } });
    toast('Consent updated');
    loadStudents();
  } catch (e) {
    fail(e);
  }
}
$('#consent-grant').addEventListener('click', () => bulkConsent('granted'));
$('#consent-revoke').addEventListener('click', () => bulkConsent('revoked'));
$('#csv-upload').addEventListener('click', async () => {
  const file = $('#csv-file').files[0];
  if (!file) return toast('Choose a CSV file first');
  if (file.size > 2_000_000) return toast('CSV is too large (max 2 MB)');
  try {
    const r = await api('/students/import', { method: 'POST', body: { csv: await file.text() } });
    $('#csv-result').textContent =
      `Created: ${r.created}   Updated: ${r.updated}   Skipped: ${r.skipped}` + (r.errors.length ? '\n' + r.errors.map((e) => `Line ${e.line} (${e.name}): ${e.error}`).join('\n') : '');
    loadStudents();
  } catch (e) {
    $('#csv-result').textContent = e.message;
  }
});
$('#student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/students', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Student added');
    loadStudents();
  } catch (err) {
    fail(err);
  }
});

// ---------------- assignments ----------------
async function loadAssignments() {
  await loadSquads();
  const f = $('#assignment-form');
  if (!f.assigned_date.value) f.assigned_date.value = state.me.today;
  const list = await api('/assignments');
  $('#assignments-body').replaceChildren(
    ...(list.length
      ? list.map((a) =>
          el(
            'tr',
            {},
            el('td', {}, a.assigned_date),
            el('td', {}, el('a', { href: a.problem_url, target: '_blank', rel: 'noopener noreferrer' }, a.problem_title)),
            el('td', {}, a.difficulty),
            el('td', {}, a.squad || 'All'),
            el('td', {}, fmtDateTime(a.deadline_at)),
            el('td', { class: 'num' }, `${a.solved_count} / ${a.total_students}`),
            el(
              'td',
              {},
              el('button', { class: 'btn small', onclick: () => openProgress(a) }, 'Progress'),
              el('button', { class: 'btn small danger', onclick: () => removeAssignment(a) }, 'Delete')
            )
          )
        )
      : [el('tr', {}, el('td', { colspan: '7', class: 'muted' }, 'No assignments yet.'))])
  );
}
$('#assignment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);
  body.announce_by_call = fd.get('announce_by_call') === 'on';
  if (!body.deadline_date) delete body.deadline_date;
  if (!body.squad) delete body.squad;
  try {
    if (body.announce_by_call && !(await confirmDialog('Announce by phone', el('p', {}, 'Queue an announcement call to every assigned student who has consented?'), 'Assign & call'))) return;
    const r = await api('/assignments', { method: 'POST', body });
    toast(r.announced ? `Assigned. ${r.announced.queued} announcement calls queued.` : 'Problem assigned');
    e.target.problem_title.value = '';
    e.target.problem_url.value = '';
    loadAssignments();
  } catch (err) {
    fail(err);
  }
});
async function removeAssignment(a) {
  if (!(await confirmDialog('Delete assignment', el('p', {}, `Delete "${a.problem_title}" (${a.assigned_date})? Queued calls for it are cancelled.`), 'Delete'))) return;
  try {
    await api(`/assignments/${a.id}`, { method: 'DELETE' });
    $('#progress-panel').hidden = true;
    loadAssignments();
  } catch (e) {
    fail(e);
  }
}
async function openProgress(a) {
  state.progressAssignment = a;
  $('#progress-panel').hidden = false;
  $('#progress-title').textContent = `${a.problem_title} — ${a.assigned_date}`;
  const rows = await api(`/assignments/${a.id}/progress`);
  $('#progress-body').replaceChildren(
    ...rows.map((r) =>
      el(
        'tr',
        {},
        el('td', {}, r.student_name),
        el('td', {}, r.squad || ''),
        el('td', {}, r.leetcode_username || el('span', { class: 'muted' }, '—')),
        el(
          'td',
          {},
          el(
            'select',
            {
              'aria-label': `Progress for ${r.student_name}`,
              onchange: async (e) => {
                try {
                  await api(`/assignments/${a.id}/progress/${r.student_id}`, { method: 'PUT', body: { status: e.target.value } });
                  toast('Progress saved');
                } catch (err) {
                  fail(err);
                }
              },
            },
            Object.entries(PROGRESS_LABEL).map(([k, v]) => el('option', { value: k, selected: r.progress_status === k }, v))
          )
        )
      )
    )
  );
  $('#progress-panel').scrollIntoView({ behavior: 'smooth' });
}
$('#progress-sync').addEventListener('click', async () => {
  const a = state.progressAssignment;
  if (!a) return;
  try {
    const r = await api(`/assignments/${a.id}/sync`, { method: 'POST', body: {} });
    toast(`Checked ${r.checked} LeetCode profiles: ${r.solved} solved, ${r.attempted} attempted${r.errors ? `, ${r.errors} errors` : ''}`, 6000);
    openProgress(a);
    loadAssignments();
  } catch (e) {
    fail(e);
  }
});

// ---------------- templates ----------------
function speakPreview(text) {
  if (!('speechSynthesis' in window)) return toast('Speech not supported in this browser');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  speechSynthesis.speak(u);
}
async function loadTemplates() {
  const { templates, placeholders } = await api('/templates');
  $('#placeholders').textContent = placeholders.map((p) => `{${p}}`).join('  ');
  $('#templates-list').replaceChildren(
    ...templates.map((t) => {
      const ta = el('textarea', { 'aria-label': t.name, maxlength: '1000' });
      ta.value = t.body;
      const preview = el('p', { class: 'small muted' });
      const doPreview = async () => {
        const r = await api('/templates/preview', { method: 'POST', body: { body: ta.value } });
        preview.textContent = r.errors.length ? '⚠ ' + r.errors.join('; ') : `Preview: ${r.text}`;
        return r;
      };
      return el(
        'div',
        { class: 'card' },
        el('h3', {}, TEMPLATE_LABEL[t.type] || t.name),
        el('p', { class: 'small muted' }, `Last updated ${fmtDateTime(t.updated_at)} by ${t.updated_by || 'system'}`),
        ta,
        preview,
        el(
          'div',
          { class: 'toolbar' },
          el('button', { class: 'btn primary', onclick: async () => {
            try {
              await api(`/templates/${t.type}`, { method: 'PUT', body: { name: t.name, body: ta.value } });
              toast('Script saved');
              doPreview();
            } catch (e) {
              fail(e);
            }
          } }, 'Save'),
          el('button', { class: 'btn', onclick: () => doPreview().catch(fail) }, 'Preview'),
          el('button', { class: 'btn', onclick: async () => {
            const r = await doPreview().catch(fail);
            if (r && !r.errors.length) speakPreview(r.text);
          } }, 'Listen (browser)'),
          el('button', { class: 'btn ghost', onclick: async () => {
            if (!(await confirmDialog('Reset script', el('p', {}, 'Restore the default text for this script?'), 'Reset'))) return;
            await api(`/templates/${t.type}/reset`, { method: 'POST', body: {} }).catch(fail);
            loadTemplates();
          } }, 'Reset to default')
        )
      );
    })
  );
}

// ---------------- schedules ----------------
function templateOptions(selected) {
  return Object.entries(TEMPLATE_LABEL).map(([k, v]) => el('option', { value: k, selected: k === selected }, v));
}
async function loadSchedules() {
  $$('.tz').forEach((n) => (n.textContent = state.me.timezone));
  const [list, holidays] = await Promise.all([api('/schedules'), api('/holidays')]);
  $('#schedules-body').replaceChildren(
    ...list.map((s) => {
      const days = s.days_of_week.split(',').map(Number);
      return el(
        'tr',
        {},
        el('td', {}, s.name),
        el('td', { class: 'num' }, s.time_of_day),
        el('td', { class: 'small' }, days.length === 7 ? 'Every day' : days.map((d) => DAY_NAMES[d]).join(', ')),
        el('td', {}, TEMPLATE_LABEL[s.template_type] || s.template_type),
        el('td', {}, AUDIENCE_LABEL[s.audience] || s.audience),
        el('td', {}, el('input', { type: 'checkbox', checked: Boolean(s.enabled), 'aria-label': `Enable ${s.name}`, onchange: async (e) => {
          try {
            await api(`/schedules/${s.id}`, { method: 'PUT', body: { enabled: e.target.checked } });
            toast(e.target.checked ? 'Schedule enabled' : 'Schedule disabled');
          } catch (err) {
            fail(err);
          }
        } })),
        el('td', { class: 'small muted' }, s.last_run || 'never'),
        el(
          'td',
          {},
          el('button', { class: 'btn small', onclick: async () => {
            if (!(await confirmDialog('Run schedule now', el('p', {}, `Run "${s.name}" immediately? Eligible students will be queued for calls.`), 'Run now'))) return;
            try {
              const r = await api(`/schedules/${s.id}/run-now`, { method: 'POST', body: {} });
              toast(`${r.queued} calls queued`);
              loadSchedules();
            } catch (e) {
              fail(e);
            }
          } }, 'Run now'),
          el('button', { class: 'btn small danger', onclick: async () => {
            if (!(await confirmDialog('Delete schedule', el('p', {}, `Delete "${s.name}"?`), 'Delete'))) return;
            await api(`/schedules/${s.id}`, { method: 'DELETE' }).catch(fail);
            loadSchedules();
          } }, 'Delete')
        )
      );
    })
  );
  $('#holidays-list').replaceChildren(
    ...(holidays.length
      ? holidays.map((h) =>
          el('li', {}, el('strong', {}, h.date), h.reason || '', el('button', { class: 'btn small ghost', onclick: async () => {
            await api(`/holidays/${h.date}`, { method: 'DELETE' }).catch(fail);
            loadSchedules();
          } }, 'Remove'))
        )
      : [el('li', { class: 'muted' }, 'No holidays configured.')])
  );
}
(function initScheduleForm() {
  $('#schedule-form .template-select').replaceChildren(...templateOptions('pending_reminder'));
  $('#schedule-days').replaceChildren(...DAY_NAMES.map((d, i) => el('label', {}, el('input', { type: 'checkbox', name: 'day', value: String(i), checked: true }), d)));
})();
$('#schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = { name: fd.get('name'), time_of_day: fd.get('time_of_day'), template_type: fd.get('template_type'), audience: fd.get('audience'), days_of_week: fd.getAll('day').map(Number) };
  try {
    await api('/schedules', { method: 'POST', body });
    e.target.name.value = '';
    toast('Schedule added');
    loadSchedules();
  } catch (err) {
    fail(err);
  }
});
$('#holiday-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/holidays', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    loadSchedules();
  } catch (err) {
    fail(err);
  }
});

// ---------------- browser announcements (SpeechSynthesis) ----------------
const announce = { rows: [], queue: [], speaking: false };
const synthOk = 'speechSynthesis' in window;
function populateVoices() {
  if (!synthOk) return;
  const voices = speechSynthesis.getVoices();
  const sel = $('#announce-voice');
  const cur = sel.value;
  sel.replaceChildren(
    el('option', { value: '' }, 'Default voice'),
    ...voices
      .slice()
      .sort((a, b) => (b.lang.startsWith('en-IN') - a.lang.startsWith('en-IN')) || a.name.localeCompare(b.name))
      .map((v) => el('option', { value: v.name }, `${v.name} (${v.lang})`))
  );
  sel.value = cur;
}
if (synthOk) {
  populateVoices();
  speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
} else $('#announce-unsupported').hidden = false;

async function loadAnnouncements() {
  await loadSquads();
  announce.rows = await api(`/announcements?squad=${encodeURIComponent($('#announce-squad').value)}`);
  $('#announce-body').replaceChildren(
    ...(announce.rows.length
      ? announce.rows.map((r) =>
          el(
            'tr',
            { 'data-student': String(r.student_id) },
            el('td', {}, el('input', { type: 'checkbox', value: String(r.student_id), checked: $('#announce-all').checked, 'aria-label': `Select ${r.student_name}` })),
            el('td', {}, r.student_name),
            el('td', {}, r.squad || ''),
            el('td', {}, r.problem_title),
            el('td', {}, r.difficulty)
          )
        )
      : [el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No pending students — everyone has solved today\'s problem (or nothing is assigned).'))])
  );
}
function phraseFor(r) {
  const first = r.student_name.trim().split(/\s+/)[0];
  return $('#announce-format').value === 'long'
    ? `${first}, your problem ${r.problem_title} is still pending. Please complete it today.`
    : `${first}, complete ${r.problem_title}.`;
}
function setSpeakingRow(id) {
  $$('#announce-body tr').forEach((tr) => tr.classList.toggle('speaking', tr.dataset.student === String(id)));
}
function speakNext() {
  const r = announce.queue.shift();
  if (!r) {
    announce.speaking = false;
    setSpeakingRow(null);
    $('#announce-status').textContent = 'Finished';
    return;
  }
  const u = new SpeechSynthesisUtterance(phraseFor(r));
  const voice = speechSynthesis.getVoices().find((v) => v.name === $('#announce-voice').value);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else u.lang = 'en-IN';
  u.rate = Number($('#announce-rate').value);
  u.onstart = () => {
    setSpeakingRow(r.student_id);
    $('#announce-status').textContent = `Speaking: ${r.student_name} (${announce.queue.length} left)`;
  };
  u.onend = () => announce.speaking && setTimeout(speakNext, 500);
  u.onerror = (ev) => {
    if (ev.error !== 'interrupted' && ev.error !== 'canceled') toast(`Speech error: ${ev.error}`);
  };
  speechSynthesis.speak(u);
}
$('#announce-play').addEventListener('click', () => {
  if (!synthOk) return;
  const ids = new Set($$('#announce-body input[type=checkbox]:checked').map((c) => c.value));
  announce.queue = announce.rows.filter((r) => ids.has(String(r.student_id)));
  if (!announce.queue.length) return toast('Select at least one student');
  speechSynthesis.cancel();
  announce.speaking = true;
  speakNext();
});
$('#announce-pause').addEventListener('click', () => {
  if (synthOk && speechSynthesis.speaking) {
    speechSynthesis.pause();
    $('#announce-status').textContent = 'Paused';
  }
});
$('#announce-resume').addEventListener('click', () => {
  if (synthOk) speechSynthesis.resume();
});
$('#announce-stop').addEventListener('click', () => {
  announce.speaking = false;
  announce.queue = [];
  if (synthOk) speechSynthesis.cancel();
  setSpeakingRow(null);
  $('#announce-status').textContent = 'Stopped';
});
$('#announce-reload').addEventListener('click', () => loadAnnouncements().catch(fail));
$('#announce-squad').addEventListener('change', () => loadAnnouncements().catch(fail));
$('#announce-all').addEventListener('change', (e) => $$('#announce-body input[type=checkbox]').forEach((c) => (c.checked = e.target.checked)));
$('#announce-rate').addEventListener('input', (e) => ($('#announce-rate-val').textContent = e.target.value));

// ---------------- settings ----------------
async function loadSettings() {
  await refreshHeader();
  const { settings, providers, callbacks_enabled, exotel_greeting_url } = state.settings;
  $('#provider-status').replaceChildren(
    ...Object.entries(providers).map(([name, p]) =>
      el(
        'div',
        { class: 'stat' },
        el('div', { class: 'value' }, name),
        el('div', { class: 'label' }, p.configured ? (p.realCalls ? 'Configured — real, paid calls' : 'Always available — simulated calls') : 'Not configured (missing env vars)')
      )
    ),
    el(
      'div',
      { class: 'stat' },
      el('div', { class: 'value' }, callbacks_enabled ? 'On' : 'Off'),
      el('div', { class: 'label' }, callbacks_enabled ? 'Status callbacks via PUBLIC_BASE_URL' : 'Status callbacks off (polling instead). Set PUBLIC_BASE_URL.')
    )
  );
  if (exotel_greeting_url) $('#provider-status').append(el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Exotel greeting URL'), el('code', {}, exotel_greeting_url)));
  const f = $('#settings-form');
  f.active_provider.replaceChildren(
    ...Object.entries(providers).map(([name, p]) => el('option', { value: name, disabled: !p.configured, selected: settings.active_provider === name }, name + (p.configured ? '' : ' (not configured)')))
  );
  for (const k of ['calling_hours_start', 'calling_hours_end', 'max_concurrent_calls', 'calls_per_minute', 'max_attempts', 'retry_base_seconds', 'min_minutes_between_calls', 'schedule_grace_minutes', 'stale_call_minutes', 'overdue_lookback_days']) {
    f[k].value = settings[k];
  }
  for (const k of ['require_consent', 'opt_out_prompt_enabled', 'leetcode_sync_enabled']) f[k].checked = settings[k];
  for (const st of ['no_answer', 'busy', 'failed']) f[`retry_${st}`].checked = settings.retry_on_statuses.includes(st);
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    active_provider: f.active_provider.value,
    calling_hours_start: f.calling_hours_start.value,
    calling_hours_end: f.calling_hours_end.value,
    require_consent: f.require_consent.checked,
    opt_out_prompt_enabled: f.opt_out_prompt_enabled.checked,
    leetcode_sync_enabled: f.leetcode_sync_enabled.checked,
    retry_on_statuses: ['no_answer', 'busy', 'failed'].filter((s) => f[`retry_${s}`].checked),
  };
  for (const k of ['max_concurrent_calls', 'calls_per_minute', 'max_attempts', 'retry_base_seconds', 'min_minutes_between_calls', 'schedule_grace_minutes', 'stale_call_minutes', 'overdue_lookback_days']) {
    body[k] = Number(f[k].value);
  }
  if (body.active_provider !== 'mock' && body.active_provider !== state.settings.settings.active_provider) {
    const ok = await confirmDialog('Switch to a real provider', el('p', {}, `Switching to ${body.active_provider} means queued and scheduled calls will ring real phones and incur charges. Continue?`), 'Switch');
    if (!ok) return;
  }
  try {
    await api('/settings', { method: 'PUT', body });
    $('#settings-msg').textContent = 'Saved.';
    loadSettings();
  } catch (err) {
    $('#settings-msg').textContent = err.message;
  }
});

// ---------------- audit ----------------
async function loadAudit() {
  const rows = await api('/audit?limit=300');
  $('#audit-body').replaceChildren(
    ...rows.map((r) =>
      el(
        'tr',
        {},
        el('td', { class: 'num small' }, fmtDateTime(r.created_at)),
        el('td', {}, r.actor),
        el('td', {}, r.action.replace(/_/g, ' ')),
        el('td', { class: 'small' }, typeof r.details === 'object' ? JSON.stringify(r.details) : String(r.details || ''))
      )
    )
  );
}

// ---------------- boot ----------------
async function boot() {
  try {
    state.me = await api('/me');
  } catch {
    return showLogin();
  }
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await Promise.all([refreshHeader(), loadSquads()]).catch(fail);
  switchTab(state.tab);
}
boot();
