'use strict';

const crypto = require('node:crypto');

const COOKIE = 'lr_session';
const SESSION_HOURS = 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, { password: plain, passwordHash }) {
  if (passwordHash) {
    const [scheme, saltB64, hashB64] = passwordHash.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, got);
  }
  if (!plain) return false;
  const a = crypto.createHash('sha256').update(String(password)).digest();
  const b = crypto.createHash('sha256').update(plain).digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(secret, username, nowMs = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: nowMs + SESSION_HOURS * 3600000 })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

function readSessionToken(secret, token, nowMs = Date.now()) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = Buffer.from(sign(secret, payload));
  const got = Buffer.from(sig || '');
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < nowMs) return null;
    return { username: data.u };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Simple fixed-window limiter for login attempts (per IP). */
function createLoginLimiter({ max = 10, windowMs = 15 * 60000 } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const t = Date.now();
      const e = hits.get(key);
      if (!e || e.reset < t) {
        hits.set(key, { n: 1, reset: t + windowMs });
        return true;
      }
      e.n++;
      return e.n <= max;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

function createAuth(config) {
  const limiter = createLoginLimiter();
  const configured = Boolean(config.admin.password || config.admin.passwordHash);

  function cookieHeader(value, maxAgeSec) {
    return `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${config.isProd ? '; Secure' : ''}`;
  }

  return {
    configured,
    login(req, res) {
      if (!configured) {
        return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD for local dev) in .env.' });
      }
      if (!limiter.check(req.ip)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      const { username, password } = req.body || {};
      const userOk = typeof username === 'string' && username === config.admin.username;
      const passOk = typeof password === 'string' && verifyPassword(password, config.admin);
      if (!userOk || !passOk) return res.status(401).json({ error: 'Invalid username or password' });
      limiter.reset(req.ip);
      res.setHeader('Set-Cookie', cookieHeader(createSessionToken(config.sessionSecret, username), SESSION_HOURS * 3600));
      return res.json({ ok: true, username });
    },
    logout(req, res) {
      res.setHeader('Set-Cookie', cookieHeader('', 0));
      res.json({ ok: true });
    },
    /** Admin-only guard + CSRF defence (SameSite=Strict cookie and a custom header on writes). */
    requireAdmin(req, res, next) {
      const session = readSessionToken(config.sessionSecret, parseCookies(req.headers.cookie)[COOKIE]);
      if (!session) return res.status(401).json({ error: 'Not signed in' });
      if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch') {
        return res.status(403).json({ error: 'Missing CSRF header' });
      }
      req.admin = session.username;
      next();
    },
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, createSessionToken, readSessionToken, parseCookies, COOKIE };
