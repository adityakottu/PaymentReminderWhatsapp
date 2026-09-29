'use strict';

const { normalizePhone } = require('./phone');
const { parseLanguage } = require('./template');

const LIMITS = { customer_name: 128, account_id: 64, installment_number: 16, collector_name: 128, custom_message: 500 };
const MAX_AMOUNT = 1e11;

/** Strip control characters and surrounding whitespace. */
function cleanText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, (m) => (m.includes('\n') ? '\n' : ' '))
    .trim();
  return s === '' ? null : s;
}

function parseAmount(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: false, reason: 'Amount missing' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, reason: 'Amount is not a number' };
    return checkAmount(v);
  }
  if (v instanceof Date || typeof v === 'boolean') return { ok: false, reason: 'Amount is not a number' };
  const s = String(v).trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/,/g, '').replace(/\s/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: 'Amount is not a number' };
  return checkAmount(Number(s));
}

function checkAmount(n) {
  if (n < 0) return { ok: false, reason: 'Amount cannot be negative' };
  if (n > MAX_AMOUNT) return { ok: false, reason: 'Amount is unrealistically large' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

function isValidYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2200;
}

/** Accepts Excel dates, DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY and YYYY-MM-DD. Returns YYYY-MM-DD. */
function parseDueDate(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { ok: false, reason: 'Invalid due date' };
    // ExcelJS returns dates as UTC midnight.
    return { ok: true, value: v.toISOString().slice(0, 10) };
  }
  if (typeof v === 'number') {
    // Raw Excel serial date (1900 date system).
    if (v > 20000 && v < 100000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return { ok: true, value: d.toISOString().slice(0, 10) };
    }
    return { ok: false, reason: 'Invalid due date' };
  }
  const s = String(v).trim();
  let m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isValidYmd(y, mo, d)) return { ok: false, reason: 'Invalid due date (use DD-MM-YYYY)' };
    return { ok: true, value: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isValidYmd(y, mo, d)) return { ok: false, reason: 'Invalid due date (use DD-MM-YYYY)' };
    return { ok: true, value: `${m[1]}-${m[2]}-${m[3]}` };
  }
  return { ok: false, reason: 'Invalid due date (use DD-MM-YYYY)' };
}

function textField(values, key, reasons, label) {
  const raw = values[key];
  if (raw instanceof Date) {
    reasons.push(`${label} has an unsupported value`);
    return null;
  }
  const v = cleanText(typeof raw === 'number' ? String(raw) : raw);
  if (v && v.length > LIMITS[key]) {
    reasons.push(`${label} is longer than ${LIMITS[key]} characters`);
    return v.slice(0, LIMITS[key]);
  }
  return v;
}

/**
 * Validate parsed rows and detect duplicates.
 * Returns rows annotated with { status: VALID|INVALID|DUPLICATE, reasons[], warnings[] } and a summary.
 */
function validateRows(parsedRows, { internationalEnabled = false, defaultCountryCode = '91' } = {}) {
  const out = [];
  for (const { rowNumber, values } of parsedRows) {
    const reasons = [];
    const warnings = [];

    const customer_name = textField(values, 'customer_name', reasons, 'Customer name');
    if (!customer_name) reasons.push('Customer name missing');

    const phone_raw = values.phone === null || values.phone === undefined ? null : String(values.phone).trim();
    let phone_number = null;
    if (values.phone instanceof Date) reasons.push('Phone number has an unsupported value');
    else {
      const p = normalizePhone(values.phone, { internationalEnabled, defaultCountryCode });
      if (p.ok) phone_number = p.value;
      else reasons.push(p.reason);
    }

    const amt = parseAmount(values.amount_due);
    const amount_due = amt.ok ? amt.value : null;
    if (!amt.ok) reasons.push(amt.reason);

    const dd = parseDueDate(values.due_date);
    const due_date = dd.ok ? dd.value : null;
    if (!dd.ok) reasons.push(dd.reason);

    const account_id = textField(values, 'account_id', reasons, 'Loan/Account ID');
    let installment_number = textField(values, 'installment_number', reasons, 'Installment number');
    if (installment_number && !/^[A-Za-z0-9\-/]+$/.test(installment_number)) reasons.push('Installment number has unsupported characters');
    if (installment_number) installment_number = installment_number.replace(/\.0+$/, '');
    const collector_name = textField(values, 'collector_name', reasons, 'Employee/Collector');
    const custom_message = textField(values, 'custom_message', reasons, 'Custom message');
    const language = parseLanguage(values.language instanceof Date ? 'invalid' : values.language);
    if (language === undefined) reasons.push('Language must be English, Telugu or Both');

    out.push({
      row_number: rowNumber,
      customer_name,
      phone_raw: phone_raw ? phone_raw.slice(0, 64) : null,
      phone_number,
      amount_raw: values.amount_due === null || values.amount_due === undefined ? null : String(values.amount_due).slice(0, 64),
      amount_due,
      due_date,
      account_id,
      installment_number,
      collector_name,
      custom_message,
      language: language || null,
      status: reasons.length ? 'INVALID' : 'VALID',
      reasons,
      warnings,
    });
  }

  // Duplicate detection among valid rows.
  //  - Same phone + same account + same installment  -> DUPLICATE (excluded)
  //  - Same account + same installment, other phone -> DUPLICATE (excluded)
  //  - Same phone, no account ids on either row      -> DUPLICATE (excluded)
  //  - Same phone, different account ids             -> warning only (customer with several loans)
  const byPhone = new Map();
  const byAccount = new Map();
  for (const row of out) {
    if (row.status !== 'VALID') continue;
    const inst = row.installment_number || '';
    const accKey = row.account_id ? `${row.account_id.toLowerCase()}|${inst}` : null;
    const phoneRows = byPhone.get(row.phone_number) || [];

    if (accKey && byAccount.has(accKey)) {
      const first = byAccount.get(accKey);
      row.status = 'DUPLICATE';
      row.reasons.push(
        first.phone_number === row.phone_number
          ? `Duplicate of row ${first.row_number} (same phone, account and installment)`
          : `Duplicate Loan/Account ID (same as row ${first.row_number})`
      );
      continue;
    }
    const samePhoneNoAccount = phoneRows.find((r) => !r.account_id || !row.account_id);
    if (samePhoneNoAccount) {
      row.status = 'DUPLICATE';
      row.reasons.push(`Duplicate phone number (same as row ${samePhoneNoAccount.row_number})`);
      continue;
    }
    if (phoneRows.length) {
      row.warnings.push(`Same phone number also appears in row(s) ${phoneRows.map((r) => r.row_number).join(', ')} with a different account`);
      for (const r of phoneRows) {
        if (!r.warnings.some((w) => w.startsWith('Same phone'))) r.warnings.push(`Same phone number also appears in row ${row.row_number} with a different account`);
      }
    }
    phoneRows.push(row);
    byPhone.set(row.phone_number, phoneRows);
    if (accKey) byAccount.set(accKey, row);
  }

  const summary = {
    total: out.length,
    valid: out.filter((r) => r.status === 'VALID').length,
    invalid: out.filter((r) => r.status === 'INVALID').length,
    duplicates: out.filter((r) => r.status === 'DUPLICATE').length,
    warnings: out.filter((r) => r.warnings.length).length,
  };
  return { rows: out, summary };
}

module.exports = { validateRows, parseAmount, parseDueDate, cleanText };
