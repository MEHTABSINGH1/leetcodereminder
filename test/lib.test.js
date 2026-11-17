'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../src/lib/phone');
const { parseCsv, parseStudentCsv } = require('../src/lib/csv');
const { renderTemplate, validateTemplate, DEFAULT_TEMPLATES } = require('../src/lib/templates');
const { zonedTimeToUtc, inWindow, formatDeadlineForSpeech, zonedParts } = require('../src/lib/time');
const { hashPassword, verifyPassword, createSessionToken, readSessionToken } = require('../src/auth');
const { callbackToken, verifyCallbackToken } = require('../src/lib/tokens');
const { createTwilioProvider } = require('../src/providers/twilio');

test('phone validation normalises Indian mobiles and rejects bad numbers', () => {
  assert.deepEqual(normalizePhone('98765 43210'), { ok: true, e164: '+919876543210' });
  assert.equal(normalizePhone('+91-98765-43210').e164, '+919876543210');
  assert.equal(normalizePhone('09876543210').e164, '+919876543210');
  assert.equal(normalizePhone('919876543210').e164, '+919876543210');
  assert.equal(normalizePhone('+14155550100').e164, '+14155550100');
  assert.equal(normalizePhone('12345').ok, false);
  assert.equal(normalizePhone('5876543210').ok, false, 'Indian mobiles start with 6-9');
  assert.equal(normalizePhone('98765abc10').ok, false);
  assert.equal(normalizePhone('').ok, false);
});

test('CSV parser handles quotes, CRLF, BOM and header aliases', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n'), [
    ['a', 'b'],
    ['x, y', 'he said "hi"'],
  ]);
  const { records, errors } = parseStudentCsv('﻿Student Name,Mobile,Squad,LeetCode,Consent\nRahul,9876543210,Alpha,rahul_lc,yes\n');
  assert.deepEqual(errors, []);
  assert.equal(records[0].name, 'Rahul');
  assert.equal(records[0].phone, '9876543210');
  assert.equal(records[0].leetcode_username, 'rahul_lc');
  assert.equal(records[0].consent, 'yes');
  assert.ok(parseStudentCsv('foo,bar\n1,2').errors.length);
});

test('templates render personalised speech and reject unknown placeholders', () => {
  const text = renderTemplate(DEFAULT_TEMPLATES.first_reminder.body, {
    student_name: 'Rahul',
    problem_title: 'Two Sum',
    difficulty: 'Easy',
    deadline: '11:59 PM today',
    mentor_name: 'your mentor',
  });
  assert.match(text, /^Hello Rahul\./);
  assert.match(text, /Your problem for today is Two Sum\./);
  assert.match(text, /Difficulty level: Easy/);
  assert.match(text, /11:59 PM today/);
  assert.equal(renderTemplate('Hi {first_name}', { student_name: 'Aman Verma' }), 'Hi Aman');
  assert.equal(renderTemplate('Hi {student_name}', { student_name: 'Bad <Say>' }), 'Hi Bad Say', 'markup stripped');
  assert.ok(validateTemplate('Hello {student_name} {unknown}').some((e) => /Unknown placeholder/.test(e)));
  assert.ok(validateTemplate('Hello there').some((e) => /student_name/.test(e)));
  for (const t of Object.values(DEFAULT_TEMPLATES)) assert.deepEqual(validateTemplate(t.body), []);
});

test('time helpers handle IST conversion, windows and speech deadlines', () => {
  assert.equal(zonedTimeToUtc('2026-11-17', '23:59', 'Asia/Kolkata').toISOString(), '2026-11-17T18:29:00.000Z');
  assert.deepEqual(zonedParts(new Date('2026-11-17T05:00:00Z'), 'Asia/Kolkata').time, '10:30');
  assert.equal(inWindow(600, '09:00', '21:00'), true);
  assert.equal(inWindow(1300, '09:00', '21:00'), false);
  assert.equal(inWindow(30, '22:00', '02:00'), true, 'window across midnight');
  const now = new Date('2026-11-17T05:00:00Z');
  assert.equal(formatDeadlineForSpeech('2026-11-17T18:29:00Z', 'Asia/Kolkata', now), '11:59 PM today');
  assert.equal(formatDeadlineForSpeech('2026-11-18T18:29:00Z', 'Asia/Kolkata', now), '11:59 PM on 18 November');
});

test('password hashing, sessions and callback tokens', () => {
  const h = hashPassword('a very long password');
  assert.ok(verifyPassword('a very long password', { passwordHash: h }));
  assert.ok(!verifyPassword('wrong', { passwordHash: h }));
  const tok = createSessionToken('s', 'admin', 1000);
  assert.equal(readSessionToken('s', tok, 2000).username, 'admin');
  assert.equal(readSessionToken('other', tok, 2000), null, 'wrong secret');
  assert.equal(readSessionToken('s', tok, 1000 + 13 * 3600000), null, 'expired');
  assert.equal(readSessionToken('s', tok.slice(0, -2) + 'xx', 2000), null, 'tampered');
  assert.ok(verifyCallbackToken('s', 5, callbackToken('s', 5)));
  assert.ok(!verifyCallbackToken('s', 6, callbackToken('s', 5)));
});

test('Twilio TwiML escapes text and signature validation matches Twilio algorithm', () => {
  const p = createTwilioProvider({ accountSid: 'ACx', authToken: '12345', phoneNumber: '+10000000000', voice: 'Polly.Aditi', language: 'en-IN' });
  const xml = p.buildTwiml({ message: 'Hi Rahul & <friends>', gatherUrl: 'https://x/g?q=1&t=2', optOutPrompt: true });
  assert.match(xml, /Hi Rahul &amp; &lt;friends&gt;/);
  assert.match(xml, /press 9/);
  assert.match(xml, /action="https:\/\/x\/g\?q=1&amp;t=2"/);
  // Example from Twilio's security docs.
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  const crypto = require('node:crypto');
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  const sig = crypto.createHmac('sha1', '12345').update(data).digest('base64');
  assert.ok(p.validateSignature(url, params, sig));
  assert.ok(!p.validateSignature(url, { ...params, Digits: '9' }, sig));
});
