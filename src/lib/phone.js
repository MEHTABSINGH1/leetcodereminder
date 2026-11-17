'use strict';

/**
 * Normalise a phone number to E.164.
 * Indian mobiles (10 digits starting 6-9, optionally prefixed by 0, 91 or +91)
 * become +91XXXXXXXXXX. Other numbers must already be in +<country><number> form.
 * Returns { ok, e164 } or { ok: false, error }.
 */
function normalizePhone(input) {
  if (input === undefined || input === null) return { ok: false, error: 'Phone number is required' };
  const raw = String(input).trim();
  if (!raw) return { ok: false, error: 'Phone number is required' };
  if (/[^\d+\s\-().]/.test(raw)) return { ok: false, error: 'Phone number contains invalid characters' };
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');

  let national = null;
  if (!hasPlus && digits.length === 10) national = digits;
  else if (!hasPlus && digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91')) national = digits.slice(2);

  if (national !== null) {
    if (!/^[6-9]\d{9}$/.test(national)) {
      return { ok: false, error: 'Indian mobile numbers must be 10 digits starting with 6, 7, 8 or 9' };
    }
    return { ok: true, e164: `+91${national}` };
  }
  if (hasPlus && /^[1-9]\d{7,14}$/.test(digits)) return { ok: true, e164: `+${digits}` };
  return { ok: false, error: 'Unrecognised phone number (use a 10-digit Indian mobile or +countrycode format)' };
}

function maskPhone(e164) {
  if (!e164) return '';
  return e164.length > 6 ? `${e164.slice(0, 3)}******${e164.slice(-4)}` : '****';
}

module.exports = { normalizePhone, maskPhone };
