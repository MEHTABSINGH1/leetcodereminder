'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readXlsxRows } = require('../src/lib/xlsx');
const { makeCtx } = require('./helpers');

/** Build a minimal zip (deflate) like Excel does. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function workbook(sheetXml, sharedStrings) {
  return zip({
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Students" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${sharedStrings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
  });
}

const SAMPLE = workbook(
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    // numeric phone, shared-string name with an entity
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>9876543210</v></c><c r="C2" t="s"><v>5</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    // blank row 3, then sparse row 4: phone in scientific notation, inline string name, no squad cell
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Aman</t></is></c><c r="B4"><v>9.876543211E9</v></c><c r="D4" t="b"><v>1</v></c></row>' +
    '<row r="5"><c r="A5" t="str"><v>Bad Phone</v></c><c r="B5"><v>12345</v></c></row>',
  ['Name', 'Phone', 'Squad', 'Consent', 'Rahul &amp; Co', 'Alpha', 'yes']
);

test('xlsx reader: shared/inline strings, numeric phones, sparse cells, blank rows', () => {
  const rows = readXlsxRows(SAMPLE);
  assert.deepEqual(rows[0], ['Name', 'Phone', 'Squad', 'Consent']);
  assert.deepEqual(rows[1], ['Rahul & Co', '9876543210', 'Alpha', 'yes']);
  assert.deepEqual(rows[2], []);
  assert.deepEqual(rows[3], ['Aman', '9876543211', '', 'TRUE']);
  assert.deepEqual(rows[4], ['Bad Phone', '12345']);
});

test('xlsx reader rejects non-xlsx and old .xls files', () => {
  assert.throws(() => readXlsxRows(Buffer.from('name,phone,squad\nRahul,9876543210,Alpha\n')), /Not an \.xlsx file/);
  const ole = Buffer.alloc(100);
  ole.writeUInt32LE(0xe011cfd0, 0); // legacy .xls (OLE) signature
  assert.throws(() => readXlsxRows(ole), /\.xls files are not supported/);
});

test('students can be imported from an .xlsx file', () => {
  const ctx = makeCtx();
  const r = ctx.students.importXlsx(SAMPLE, 'admin');
  assert.equal(r.created, 2);
  assert.equal(r.skipped, 1);
  const list = ctx.students.list();
  const rahul = list.find((s) => s.phone === '+919876543210');
  assert.equal(rahul.name, 'Rahul & Co');
  assert.equal(rahul.squad, 'Alpha');
  assert.equal(rahul.consent_status, 'granted');
  assert.equal(list.find((s) => s.name === 'Aman').consent_status, 'granted', 'TRUE counts as consent');
  assert.throws(() => ctx.students.importXlsx(Buffer.from('garbage-garbage-garbage')), /xlsx/i);
});
