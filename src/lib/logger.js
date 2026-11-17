'use strict';

/** Tiny structured logger. Never pass secrets in `meta`. */
function createLogger({ silent = false } = {}) {
  const write = (level, msg, meta) => {
    if (silent) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta || {}) });
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  };
  return {
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}

module.exports = { createLogger };
