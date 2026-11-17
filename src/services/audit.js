'use strict';

function createAuditService(db, logger) {
  const ins = db.prepare('INSERT INTO audit_logs (actor, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?)');
  return {
    log(actor, action, details = {}, ip = null) {
      try {
        ins.run(actor || 'system', action, JSON.stringify(details), ip, new Date().toISOString());
      } catch (err) {
        logger.error('audit log write failed', { action, error: err.message });
      }
    },
    list({ limit = 200 } = {}) {
      return db
        .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
        .all(Math.min(Number(limit) || 200, 1000))
        .map((r) => ({ ...r, details: safeParse(r.details) }));
    },
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

module.exports = { createAuditService };
