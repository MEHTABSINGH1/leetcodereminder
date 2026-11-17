'use strict';

/**
 * Timezone helpers built on Intl (no external deps).
 * All instants are stored in the database as ISO-8601 UTC strings.
 */

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: WEEKDAYS[p.weekday],
  };
}

function tzOffsetMs(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock date ("YYYY-MM-DD") + time ("HH:MM") in timeZone to a UTC Date. */
function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True if minutesOfDay falls in [start, end). Supports windows crossing midnight. */
function inWindow(minutesOfDay, startHHMM, endHHMM) {
  const s = parseHHMM(startHHMM);
  const e = parseHHMM(endHHMM);
  if (s === null || e === null || s === e) return false;
  return s < e ? minutesOfDay >= s && minutesOfDay < e : minutesOfDay >= s || minutesOfDay < e;
}

/** Speech-friendly deadline, e.g. "11:59 PM today" or "11:59 PM on 18 November". */
function formatDeadlineForSpeech(isoUtc, timeZone, now = new Date()) {
  if (!isoUtc) return 'the end of today';
  const d = new Date(isoUtc);
  const [hh, mm] = zonedParts(d, timeZone).time.split(':').map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const time = `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  if (zonedParts(d, timeZone).date === zonedParts(now, timeZone).date) return `${time} today`;
  const dayMonth = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long' }).format(d);
  return `${time} on ${dayMonth}`;
}

module.exports = { zonedParts, zonedTimeToUtc, parseHHMM, inWindow, formatDeadlineForSpeech, tzOffsetMs };
