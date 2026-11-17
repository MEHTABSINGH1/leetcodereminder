'use strict';

/**
 * Minimal, dependency-free .xlsx reader (first worksheet -> 2-D array of strings).
 * An .xlsx file is a ZIP of XML parts; we read the central directory, inflate only
 * the parts we need, and enforce size limits to defend against zip bombs.
 */
const zlib = require('node:zlib');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLS = 50;

class XlsxError extends Error {}

function readZipEntries(buf) {
  // End of central directory record: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('Not a valid .xlsx file (zip directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Corrupt .xlsx file');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  if (e.size > MAX_PART_BYTES) throw new XlsxError('Spreadsheet is too large');
  const lo = e.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new XlsxError('Corrupt .xlsx file');
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString('utf8');
    } catch {
      throw new XlsxError('Could not decompress spreadsheet (file corrupt or too large)');
    }
  }
  throw new XlsxError(`Unsupported compression in .xlsx (method ${e.method})`);
}

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, ent) => {
    const e = ent.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Concatenate <t> text runs, ignoring phonetic (<rPh>) runs. */
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXml(out);
}

function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Numbers like phone numbers can come back as 9876543210 or 9.87654321E9. */
function formatNumber(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toFixed(0);
  return String(n);
}

function firstSheetPath(buf, entries) {
  const wb = readEntry(buf, entries, 'xl/workbook.xml');
  const rels = readEntry(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb);
    if (sheet) {
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /\bId="([^"]+)"/.exec(m[0]);
        const target = /\bTarget="([^"]+)"/.exec(m[0]);
        if (id && target && id[1] === sheet[1]) {
          const t = target[1].replace(/^\/?xl\//, '').replace(/^\//, '');
          return `xl/${t}`;
        }
      }
    }
  }
  const fallback = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  if (fallback.length) return fallback[0];
  throw new XlsxError('No worksheet found in .xlsx file');
}

/** Read the first worksheet of an .xlsx buffer as rows of strings. */
function readXlsxRows(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new XlsxError('Not a valid .xlsx file');
  if (buf.length > MAX_FILE_BYTES) throw new XlsxError('Spreadsheet is too large (max 5 MB)');
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    throw new XlsxError('Not an .xlsx file. Old .xls files are not supported - save as .xlsx or .csv.');
  }
  const entries = readZipEntries(buf);
  const shared = [];
  const sst = readEntry(buf, entries, 'xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const sheet = readEntry(buf, entries, firstSheetPath(buf, entries));
  if (!sheet) throw new XlsxError('Worksheet missing from .xlsx file');

  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_ROWS) throw new XlsxError(`Too many rows (max ${MAX_ROWS})`);
    const rAttr = /\br="(\d+)"/.exec(rm[1]);
    const rowIdx = rAttr ? Number(rAttr[1]) - 1 : rows.length;
    const cells = [];
    let next = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      const col = ref ? colIndex(ref[1]) : next;
      next = col + 1;
      if (col < 0 || col >= MAX_COLS) continue;
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const inner = cm[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let value = '';
      if (type === 's') value = v ? shared[Number(v[1])] ?? '' : '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'b') value = v && v[1] === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = v ? decodeXml(v[1]) : '';
      else value = v ? formatNumber(decodeXml(v[1])) : '';
      cells[col] = value.trim();
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    while (rows.length < rowIdx) rows.push([]);
    rows.push(cells);
  }
  return rows;
}

module.exports = { readXlsxRows, XlsxError };
