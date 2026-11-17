'use strict';

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF, BOM). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const HEADER_ALIASES = {
  name: ['name', 'student_name', 'student', 'full_name'],
  phone: ['phone', 'mobile', 'phone_number', 'mobile_number', 'contact'],
  email: ['email', 'email_address'],
  leetcode_username: ['leetcode_username', 'leetcode', 'leetcode_id', 'username'],
  squad: ['squad', 'group', 'batch', 'team'],
  consent: ['consent', 'call_consent', 'voice_consent'],
};

/** Parse a student CSV into objects keyed by canonical column names. */
function parseStudentCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { records: [], errors: ['CSV is empty'] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const index = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) index[key] = i;
  }
  const errors = [];
  if (index.name === undefined) errors.push('CSV must contain a "name" column');
  if (index.phone === undefined) errors.push('CSV must contain a "phone" column');
  if (errors.length) return { records: [], errors };
  const records = rows.slice(1).map((r, i) => {
    const rec = { line: i + 2 };
    for (const [key, idx] of Object.entries(index)) rec[key] = (r[idx] || '').trim();
    return rec;
  });
  return { records, errors };
}

module.exports = { parseCsv, parseStudentCsv };
