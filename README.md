# LeetCode Reminder

An admin dashboard for mentors who manage a cohort of students (around 100) on daily LeetCode problems.
Upload your students as a CSV, assign today's problem, and the system **automatically phones every student
who hasn't solved it yet**. Each call speaks the student's name and their assigned problem:

> "Hello Rahul. This is your daily coding reminder from your mentor. Your problem for today is Two Sum.
> Difficulty level: Easy. Your deadline is 11:59 PM today. Please complete your LeetCode problem today.
> Thank you and happy coding!"

There is also a **free browser announcement mode**. It reads names and problems aloud through your
computer's speakers, so no telephony provider is needed.

> **Phone calls cost money.** Real calls through Twilio or Exotel are paid. They also need a verified
> caller ID (Twilio) or a KYC-verified ExoPhone (Exotel). The default `mock` provider **never dials
> anyone** and is what you should use for development and testing.

---

## Features

| Area | What you get |
|---|---|
| Students | CSV or Excel (.xlsx) import (re-imports update by phone number), squads, LeetCode usernames, Indian mobile validation (normalised to `+91…`) |
| Assignments | Assign a problem per day, either to everyone or to one squad. Track progress per student (not started / attempted / solved) manually or by syncing from LeetCode |
| Personalised calls | Five editable scripts: first reminder, pending, final deadline, overdue, assignment announcement. Placeholders: `{student_name}`, `{first_name}`, `{problem_title}`, `{difficulty}`, `{deadline}`, `{mentor_name}`, `{squad}` |
| Scheduling | Configurable times, weekdays, scripts and target groups. Defaults: 10:00 everyone unsolved, 16:00 not started, 20:00 unsolved, 22:00 final reminder. Holidays, pause/resume, calling-hours window |
| Reliable queue | Database-backed queue, background worker, concurrency cap, calls-per-minute limit, exponential-backoff retries, idempotency keys, recovery after a restart, provider polling when callbacks are missing |
| Dashboard | Totals for the day (calls, successful, failed, pending, not contacted, completed after a reminder), a per-student table, filters by pending / successful / failed / squad |
| Manual controls | Call one student, call all pending, call selected, retry failed, stop scheduled calls, pause/resume automation, test call. Bulk actions show a confirmation with the exact count first |
| Consent & safety | Consent tracking (pending / granted / revoked, with source and time), opt-out (admin, or the student **presses 9 during a Twilio call**), admin-only API, audit log of every action |
| Browser announcements | Web Speech API: pick students, voice and speed; play, pause, resume, stop. Clearly labelled as *not* a phone call |

## Quick start

Requires **Node.js 24+**. It uses the built-in `node:sqlite`, so there is no native build step.

```bash
npm install
cp .env.example .env
# Set an admin password. For anything beyond local use, store a hash instead:
npm run hash-password -- "a long admin password"   # paste the output into ADMIN_PASSWORD_HASH
# Set SESSION_SECRET to a long random string, e.g.:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

Open http://localhost:3000 and sign in. Then:

1. **Students**: upload a CSV or Excel `.xlsx` file (see [`docs/students.sample.csv`](docs/students.sample.csv) or [`docs/students.sample.xlsx`](docs/students.sample.xlsx)).
2. Record consent. Students are only called once their consent is `granted`. Use the `consent` CSV column (`yes`/`no`) or the bulk buttons.
3. **Assignments**: assign today's problem (title plus LeetCode URL).
4. **Voice Calls**: watch the dashboard. Scheduled calls run automatically, or click *Call all pending*.

With `CALL_PROVIDER=mock` everything works end to end, but calls are simulated. Set
`MOCK_CALL_OUTCOME=random` to see no-answers, busy signals and retries.

### Student file format (CSV or Excel)

```csv
name,phone,squad,leetcode_username,email,consent
Rahul Sharma,9876543210,Alpha,rahul_codes,rahul@example.com,yes
```

Only `name` and `phone` are required. Header aliases work too (`mobile`, `student_name`, `group`, …).
For Excel, the first worksheet is read; phone numbers stored as numbers are handled. Old binary `.xls`
files are not supported, so save them as `.xlsx` or `.csv`. The reader is built in (no third-party
spreadsheet library) and enforces size limits (5 MB file, 5,000 rows).
Rows with invalid phone numbers are skipped and reported by line number.

## Configuring a real calling provider

Configure **only** the provider you actually have. Credentials live in environment variables on the
server. They are never stored in the database or sent to the browser. In **Settings**, a provider can
only be selected once its credentials are present.

Set `PUBLIC_BASE_URL` to the public HTTPS address of this server. It is needed for status callbacks,
the Exotel greeting URL and the "press 9 to opt out" keypress. Without it, call outcomes are found by
polling the provider instead.

### Twilio Programmable Voice

```env
CALL_PROVIDER=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...        # a Twilio number or verified caller ID
TWILIO_VOICE=Polly.Aditi         # Indian-English voice
TWILIO_LANGUAGE=en-IN
PUBLIC_BASE_URL=https://your-server.example.com
```

* Speech is sent inline as TwiML `<Say>`, so no hosted TwiML app is needed.
* Status callbacks (`/webhooks/twilio/status`) are verified with the `X-Twilio-Signature` HMAC **and** a per-call token.
* Trial accounts can only call verified numbers and play a trial message first.
* Calls to Indian mobiles from a non-Indian Twilio number show an international caller ID. Check Twilio's current India guidelines for deliverability and pricing.

### Exotel (India)

```env
CALL_PROVIDER=exotel
EXOTEL_API_KEY=...
EXOTEL_API_TOKEN=...
EXOTEL_ACCOUNT_SID=...
EXOTEL_SUBDOMAIN=api.exotel.com   # or api.in.exotel.com for the Mumbai cluster
EXOTEL_CALLER_ID=0XXXXXXXXXX      # your KYC-verified ExoPhone
EXOTEL_APP_ID=123456              # call flow (App) id
PUBLIC_BASE_URL=https://your-server.example.com
```

Exotel's connect API cannot take inline text-to-speech, so you need a call flow:

1. In Exotel, create a flow (App) with a **Greeting** applet set to read **dynamic text from a URL**:
   `https://your-server.example.com/webhooks/exotel/greeting`. The exact URL is also shown in **Settings**.
2. Put that flow's id in `EXOTEL_APP_ID`.
3. When a call connects, Exotel requests the URL with the `CallSid`. The server returns the personalised
   message, but only for a call that is in progress at that moment.

The "press 9" opt-out is only available on Twilio. With Exotel, opt-outs are recorded by the admin.

> The Twilio and Exotel integrations follow each provider's public REST API. They were tested here
> against mocked HTTP responses only, not against live accounts. Place a **Test call** to your own number
> before you enable schedules.

### Compliance (India)

* Only call students who have agreed to receive calls. Consent is tracked per student, and by default calls are blocked unless it is `granted`.
* Opt-outs take effect immediately: queued calls are cancelled and future calls are refused.
* Calls are restricted to the **calling hours** window (default 09:00–22:30 IST; shorten it if needed).
* Follow your provider's requirements (KYC, caller ID registration, and DLT/TRAI rules for your call category).

## How the calling system works

```
scheduler (every 30s) ──► find targets (unsolved / not started / overdue)
        │                   └─ optional LeetCode sync first, so solved students drop out
        ▼
   call_queue  (status=queued, idempotency_key UNIQUE)
        │
worker (every 3s) ──► claim ≤ min(free concurrency, per-minute budget) items atomically
        │              └─ re-check: opted out? consent? already solved?  → cancel
        ▼
   provider.createCall()  ──► call_logs row per attempt
        │
status callback / polling ──► completed | no_answer | busy | failed | cancelled
        └─ retryable & attempts left → queued again at now + base × 2^(attempt-1)
```

* **No duplicate calls.** A student never has two active calls. Each scheduled call has a key
  `sched:{schedule}:{date}:{student}:{assignment}`, so a schedule fires once per day even across restarts.
  Bulk requests carry a request id, so double-clicks do nothing. Automated calls also respect a minimum gap per student.
* **Never 100 calls at once.** The defaults are 3 simultaneous calls and 10 new calls per minute (both configurable).
* **Restart recovery.** On startup, calls that were claimed but never confirmed by the provider count as a failed
  attempt and are retried. In-flight calls are reconciled by polling the provider. Calls with no final status after
  `stale_call_minutes` are marked failed.
* **Callbacks are idempotent.** Duplicate or late provider callbacks for a finished attempt are ignored.

## Database

SQLite (WAL mode) at `DATABASE_URL=sqlite:./data/leetcode-reminder.db`. Migrations run automatically.

| Table | Purpose |
|---|---|
| `students`, `assignments`, `assignment_progress` | Core data. Call tables reference these by id; student details are not copied |
| `call_queue` | Pending and active calls with attempts, backoff, idempotency key and provider call id |
| `call_logs` | Permanent history: one row per dial attempt, with status, duration, errors and the number dialled |
| `call_templates` | Editable call scripts |
| `call_schedules`, `call_schedule_runs`, `call_holidays` | Automation config and the once-per-day run ledger |
| `student_call_preferences` | Consent status/source/time and opt-out |
| `call_provider_settings` | Non-secret runtime settings (active provider, hours, limits, retries) |
| `audit_logs` | Who did what, when, from which IP |

## Testing

```bash
npm test        # 36 tests, all on the mock provider + in-memory DB - never dials anyone
npm run check   # syntax check, secret scan, boot check
```

The tests cover individual calls, bulk batching and rate limits, personalised speech, pending-student identification,
duplicate prevention, retries with backoff, provider failures, Twilio/Exotel callbacks (including signature checks),
keypad opt-out, consent, the scheduler (once per day, holidays, pause, calling hours, weekdays), LeetCode sync,
restart recovery and stale-call handling. In test mode the app refuses to use any real provider.

## Project structure

```
src/
  server.js            entry point (starts HTTP server, worker, scheduler)
  app.js               dependency wiring + Express app
  config.js            env → config
  auth.js              admin login, signed session cookie, CSRF guard
  db/                  SQLite connection, migrations, seed defaults
  lib/                 phone, csv, templates, time zone, tokens, logger
  services/            students, assignments, calls (queue state machine), settings, audit, leetcodeSync
  providers/           mock, twilio, exotel (+ registry)
  workers/             callWorker (dispatch/retry/reconcile), scheduler
  routes/              /api (admin), /webhooks (providers)
public/                dashboard (vanilla JS, no build step)
test/                  node:test suites
docs/                  sample CSV
```

## Security notes

* Every `/api` route needs an admin session: an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie. Write
  requests also need an `X-Requested-With` header (CSRF defence). Login attempts are rate limited.
* Webhooks need a per-call HMAC token, and Twilio webhooks also need a valid Twilio signature.
* A strict Content-Security-Policy is set, and all dynamic text in the UI is rendered as text, never as HTML.
* `.env`, databases, logs and editor/AI tool folders are git-ignored. `npm run check` scans source files for leaked keys.
