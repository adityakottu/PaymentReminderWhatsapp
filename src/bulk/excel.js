'use strict';

const ExcelJS = require('exceljs');

/**
 * Column definitions for the bulk reminder Excel file.
 * `aliases` are matched case-insensitively after stripping spaces/punctuation.
 */
const COLUMNS = [
  { key: 'customer_name', header: 'Customer Name', required: true, aliases: ['customer', 'name', 'customername', 'borrowername'] },
  { key: 'phone', header: 'Phone Number', required: true, aliases: ['phone', 'mobile', 'mobilenumber', 'phoneno', 'mobileno', 'whatsappnumber', 'contactnumber'] },
  { key: 'amount_due', header: 'Amount Due', required: true, aliases: ['amount', 'dueamount', 'pendingamount', 'amountdue'] },
  { key: 'due_date', header: 'Due Date', required: false, aliases: ['duedate', 'date'] },
  { key: 'account_id', header: 'Loan/Account ID', required: false, aliases: ['loanaccountid', 'loanid', 'accountid', 'account', 'loanno', 'accountno', 'loannumber', 'accountnumber'] },
  { key: 'installment_number', header: 'Installment Number', required: false, aliases: ['installment', 'installmentno', 'emino', 'emi', 'installmentnumber'] },
  { key: 'collector_name', header: 'Employee/Collector', required: false, aliases: ['employee', 'collector', 'employeecollector', 'agent'] },
  { key: 'custom_message', header: 'Custom Message', required: false, aliases: ['message', 'custommessage', 'note', 'remarks'] },
  { key: 'language', header: 'Language', required: false, aliases: ['lang', 'preferredlanguage', 'messagelanguage'] },
];

class ExcelParseError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
    this.status = 400;
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function matchColumn(headerText) {
  const n = norm(headerText);
  if (!n) return null;
  for (const col of COLUMNS) {
    if (norm(col.header) === n || col.aliases.includes(n)) return col.key;
  }
  return null;
}

/** Convert an ExcelJS cell value into a primitive (string | number | Date | null). */
function cellToValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return cellToValue(value.result); // formula: use cached result only
    if ('formula' in value || 'sharedFormula' in value) return null; // formula without cached result
    if ('text' in value) return cellToValue(value.text); // hyperlink
    if ('error' in value) return null;
  }
  return String(value);
}

/**
 * Parse an .xlsx buffer into { headers, rows } where each row is
 * { rowNumber, values: { customer_name, phone, ... } }.
 */
async function parseWorkbook(buffer, { maxRows }) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    throw new ExcelParseError('The file could not be read. Make sure it is a valid, non-password-protected .xlsx file.');
  }
  const sheet = workbook.worksheets.find((ws) => ws.state !== 'hidden' && ws.actualRowCount > 0) || workbook.worksheets[0];
  if (!sheet || sheet.actualRowCount === 0) throw new ExcelParseError('The Excel file is empty.');

  // Locate the header row: first row (within the first 10) that matches the required columns.
  let headerRowNumber = null;
  let mapping = null;
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const m = {};
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = matchColumn(cellToValue(cell.value));
      if (key && !Object.values(m).includes(key)) m[colNumber] = key;
    });
    const found = new Set(Object.values(m));
    if (found.has('customer_name') && found.has('phone')) {
      headerRowNumber = r;
      mapping = m;
      break;
    }
  }
  if (!mapping) {
    throw new ExcelParseError('Required columns not found. Download the Excel template and use its header row.', {
      missingColumns: COLUMNS.filter((c) => c.required).map((c) => c.header),
    });
  }
  const found = new Set(Object.values(mapping));
  const missing = COLUMNS.filter((c) => c.required && !found.has(c.key)).map((c) => c.header);
  if (missing.length) {
    throw new ExcelParseError(`Missing required column(s): ${missing.join(', ')}`, { missingColumns: missing });
  }

  const rows = [];
  let dataRowCount = 0;
  for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const values = {};
    let empty = true;
    for (const [colNumber, key] of Object.entries(mapping)) {
      const v = cellToValue(row.getCell(Number(colNumber)).value);
      const isEmpty = v === null || (typeof v === 'string' && v.trim() === '');
      if (!isEmpty) empty = false;
      values[key] = isEmpty ? null : v;
    }
    if (empty) continue; // skip blank rows silently
    // The downloadable template contains a sample row – never import it.
    if (typeof values.custom_message === 'string' && /^\s*\[?sample/i.test(values.custom_message)) continue;
    dataRowCount++;
    if (dataRowCount > maxRows) {
      throw new ExcelParseError(`The file contains more than ${maxRows} data rows. Split it into smaller files.`);
    }
    rows.push({ rowNumber: r, values });
  }
  if (rows.length === 0) throw new ExcelParseError('The Excel file has a header row but no data rows.');
  return { rows, headerRowNumber };
}

/** Build the downloadable template workbook. */
async function buildTemplateWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Payment Reminder – Bulk WhatsApp';
  const ws = wb.addWorksheet('Reminders');
  ws.columns = COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.max(16, c.header.length + 6),
    style: { numFmt: '@' }, // Text format: keeps leading zeros / long phone numbers intact
  }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6F50' } };
  COLUMNS.forEach((c, i) => {
    ws.getRow(1).getCell(i + 1).note = `${c.required ? 'Required' : 'Optional'}${c.key === 'phone' ? '. 10-digit Indian mobile or with 91 prefix. No "+" needed.' : ''}${c.key === 'due_date' ? '. Format DD-MM-YYYY.' : ''}`;
  });
  const sample = ws.addRow({
    customer_name: 'Ravi Kumar',
    phone: '919876543210',
    amount_due: 5000,
    due_date: '30-09-2026',
    account_id: 'LN10045',
    installment_number: '5',
    collector_name: 'Suresh',
    custom_message: 'SAMPLE ROW – delete this row before uploading (it is ignored on import)',
    language: 'English',
  });
  sample.font = { italic: true, color: { argb: 'FF888888' } };
  sample.getCell('amount_due').numFmt = '0.00';
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const help = wb.addWorksheet('Instructions');
  help.columns = [{ header: 'Column', width: 22 }, { header: 'Required', width: 10 }, { header: 'Notes', width: 80 }];
  help.getRow(1).font = { bold: true };
  const notes = {
    customer_name: 'Full name of the customer.',
    phone: 'Indian mobile number. 9876543210, 919876543210 and +91 98765 43210 are all accepted and normalised to 919876543210.',
    amount_due: 'Numeric amount in rupees (0 or more). Do not include ₹ or commas if possible.',
    due_date: 'DD-MM-YYYY (e.g. 30-09-2026). Excel date cells are also accepted.',
    account_id: 'Loan or account reference. Used for duplicate protection.',
    installment_number: 'Installment/EMI number. Used for duplicate protection.',
    collector_name: 'Employee/collector responsible. Matched to application users for access control.',
    custom_message: 'Optional extra line added to the message.',
    language: 'Optional. English, Telugu or Both (English + Telugu in one message). Empty = the language chosen for the batch.',
  };
  for (const c of COLUMNS) help.addRow([c.header, c.required ? 'Yes' : 'No', notes[c.key]]);
  help.addRow([]);
  help.addRow(['', '', 'The row marked SAMPLE on the Reminders sheet is ignored automatically, but delete it anyway.']);
  return wb;
}

module.exports = { COLUMNS, ExcelParseError, parseWorkbook, buildTemplateWorkbook, cellToValue, matchColumn };
