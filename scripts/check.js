'use strict';

/**
 * Build check: syntax-checks every JS file, verifies the app boots against an
 * in-memory database, and scans tracked source for accidentally committed secrets.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dirs = ['src', 'public', 'scripts', 'test'];
let failed = false;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

const files = dirs.flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : []));
for (const f of files.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed = true;
    console.error(`Syntax error in ${path.relative(root, f)}:\n${e.stderr}`);
  }
}

// Secret patterns (Twilio SIDs/tokens, generic keys) must never appear in source.
const SECRET_PATTERNS = [/AC[0-9a-f]{32}/, /SK[0-9a-f]{32}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
for (const f of [...files, path.join(root, 'README.md'), path.join(root, '.env.example')].filter((f) => fs.existsSync(f))) {
  const text = fs.readFileSync(f, 'utf8');
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      failed = true;
      console.error(`Possible secret (${re}) in ${path.relative(root, f)}`);
    }
  }
}

// Boot check.
try {
  const { buildConfig } = require('../src/config');
  const { createApplication } = require('../src/app');
  const ctx = createApplication(buildConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', SESSION_SECRET: 'check' }));
  ctx.db.close();
} catch (e) {
  failed = true;
  console.error('App failed to boot:', e);
}

if (failed) process.exit(1);
console.log(`check ok: ${files.filter((f) => f.endsWith('.js')).length} JS files, no secrets found, app boots`);
