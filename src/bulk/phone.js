'use strict';

/**
 * Normalise a phone number to the internal format: digits only, country code
 * included, no "+" (e.g. 919876543210).
 *
 * Indian numbers are normalised automatically:
 *   9876543210      -> 919876543210
 *   09876543210     -> 919876543210
 *   +91 98765 43210 -> 919876543210
 *   919876543210    -> 919876543210
 *
 * Numbers carrying another country code (+44..., 0044...) are NOT rewritten.
 * They are rejected unless international support is enabled, in which case
 * they are kept as-is (digits only).
 *
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
function normalizePhone(input, { internationalEnabled = false, defaultCountryCode = '91' } = {}) {
  if (input === null || input === undefined) return { ok: false, reason: 'Phone number missing' };
  let raw = String(input).trim();
  if (raw === '') return { ok: false, reason: 'Phone number missing' };

  // Excel may turn long numbers into scientific notation (9.19876E+11) – digits are lost.
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(raw)) {
    return { ok: false, reason: 'Phone number is in scientific notation – format the column as Text' };
  }
  // Numeric cells can come through as "9876543210.0".
  raw = raw.replace(/\.0+$/, '');

  if (/[a-z]/i.test(raw)) return { ok: false, reason: 'Phone number contains letters' };
  if (!/^[+\d\s\-().]+$/.test(raw)) return { ok: false, reason: 'Phone number contains invalid characters' };

  const hasPlus = raw.startsWith('+');
  if (raw.indexOf('+', 1) !== -1) return { ok: false, reason: 'Phone number contains invalid characters' };
  let digits = raw.replace(/\D/g, '');
  let explicitInternational = hasPlus;
  if (!hasPlus && digits.startsWith('00')) {
    digits = digits.slice(2);
    explicitInternational = true;
  }

  const cc = defaultCountryCode;
  const isIndianMobile = (d) => /^[6-9]\d{9}$/.test(d);

  if (explicitInternational) {
    if (digits.startsWith(cc) && cc === '91') {
      const national = digits.slice(2);
      if (national.length < 10) return { ok: false, reason: 'Phone number incomplete' };
      if (national.length > 10) return { ok: false, reason: 'Phone number has too many digits' };
      if (!isIndianMobile(national)) return { ok: false, reason: 'Invalid Indian mobile number' };
      return { ok: true, value: cc + national };
    }
    return international(digits, internationalEnabled);
  }

  if (digits.length < 10) return { ok: false, reason: 'Phone number incomplete' };

  if (digits.length === 10) {
    if (!isIndianMobile(digits)) return { ok: false, reason: 'Invalid Indian mobile number' };
    return { ok: true, value: cc + digits };
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    const national = digits.slice(1);
    if (!isIndianMobile(national)) return { ok: false, reason: 'Invalid Indian mobile number' };
    return { ok: true, value: cc + national };
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    const national = digits.slice(2);
    if (!isIndianMobile(national)) return { ok: false, reason: 'Invalid Indian mobile number' };
    return { ok: true, value: digits };
  }
  // Any other length without an explicit "+"/"00" prefix is ambiguous.
  if (internationalEnabled) return international(digits, true);
  return { ok: false, reason: digits.length > 12 ? 'Phone number has too many digits' : 'Invalid phone number' };
}

function international(digits, enabled) {
  if (!enabled) return { ok: false, reason: 'International numbers are not enabled' };
  // E.164: max 15 digits; shortest real numbers are around 8 digits incl. country code.
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) {
    return { ok: false, reason: 'Invalid international phone number' };
  }
  return { ok: true, value: digits };
}

function maskPhone(phone) {
  if (!phone) return phone;
  const s = String(phone);
  return s.length <= 4 ? s : `${'•'.repeat(s.length - 4)}${s.slice(-4)}`;
}

module.exports = { normalizePhone, maskPhone };
