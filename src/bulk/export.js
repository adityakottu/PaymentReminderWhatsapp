'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const STATUS_LABEL = {
  PENDING: 'Pending',
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Failed',
  INVALID_NUMBER: 'Invalid Number',
  NOT_ON_WHATSAPP: 'Not Available on WhatsApp',
  RATE_LIMITED: 'Rate Limited',
  PROVIDER_ERROR: 'Provider Error',
  RETRY_SCHEDULED: 'Retry Scheduled',
  CANCELLED: 'Cancelled',
};

const LANGUAGE_LABEL = { en: 'English', te: 'Telugu', both: 'English + Telugu' };

/**
 * Neutralise spreadsheet formula injection: any text cell starting with
 * = + - @ (or tab/CR) is prefixed with an apostrophe so Excel treats it as text.
 */
function safeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function fmtDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : ymd || '';
}

async function buildResultsWorkbook({ batch, records }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Payment Reminder – Bulk WhatsApp';
  const ws = wb.addWorksheet('Results');
  ws.columns = [
    { header: 'Customer Name', key: 'customerName', width: 24 },
    { header: 'Phone Number', key: 'phoneNumber', width: 16 },
    { header: 'Amount Due', key: 'amountDue', width: 12 },
    { header: 'Due Date', key: 'dueDate', width: 12 },
    { header: 'Account ID', key: 'accountId', width: 14 },
    { header: 'Message', key: 'message', width: 60 },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Failure Reason', key: 'failureReason', width: 40 },
    { header: 'Provider Error Code', key: 'providerErrorCode', width: 14 },
    { header: 'Attempts', key: 'attempts', width: 9 },
    { header: 'Sent Time', key: 'sentAt', width: 20 },
    { header: 'Delivered Time', key: 'deliveredAt', width: 20 },
    { header: 'Read Time', key: 'readAt', width: 20 },
    { header: 'Language', key: 'language', width: 16 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of records) {
    const row = ws.addRow({
      customerName: safeCell(r.customerName),
      phoneNumber: safeCell(r.phoneNumber),
      amountDue: Number(r.amountDue),
      dueDate: safeCell(fmtDate(r.dueDate)),
      accountId: safeCell(r.accountId),
      message: safeCell(r.message),
      status: STATUS_LABEL[r.status] || r.status,
      failureReason: safeCell(r.failureReason),
      providerErrorCode: safeCell(r.providerErrorCode),
      attempts: r.attempts,
      sentAt: fmtDateTime(r.sentAt),
      deliveredAt: fmtDateTime(r.deliveredAt),
      readAt: fmtDateTime(r.readAt),
      language: LANGUAGE_LABEL[r.language] || '',
    });
    row.getCell('phoneNumber').numFmt = '@';
    row.getCell('amountDue').numFmt = '#,##0.00';
    row.getCell('message').alignment = { wrapText: false };
  }
  ws.autoFilter = { from: 'A1', to: 'N1' };

  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 22 }, { width: 40 }];
  const summary = [
    ['Batch ID', batch.batchNumber],
    ['File', batch.filename],
    ['Uploaded By', batch.uploadedByName || ''],
    ['Upload Date', fmtDateTime(batch.uploadedAt)],
    ['Status', batch.status],
    ['Total Recipients', batch.recipients],
    ['Successful', batch.successful],
    ['Failed', batch.failed],
    ['Pending', batch.pending],
    ['Cancelled', batch.cancelled],
    ['Success %', batch.successRatePct === null ? '' : `${batch.successRatePct}%`],
    ['Failure %', batch.failureRatePct === null ? '' : `${batch.failureRatePct}%`],
    ['Generated', fmtDateTime(new Date().toISOString())],
  ];
  for (const [k, v] of summary) s.addRow([k, safeCell(v)]).getCell(1).font = { bold: true };
  return wb;
}

/** Stream a PDF summary + recipient table. (Built-in PDF fonts lack ₹, so amounts use "Rs.") */
function streamResultsPdf({ batch, records }, out) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: `WhatsApp Payment Reminder Report ${batch.batchNumber}` } });
  doc.pipe(out);
  const green = '#1f6f50';

  doc.fillColor(green).fontSize(18).font('Helvetica-Bold').text('WhatsApp Payment Reminder Report');
  doc.moveDown(0.2).fillColor('#555').fontSize(9).font('Helvetica').text(`Generated ${fmtDateTime(new Date().toISOString())} IST`);
  doc.moveDown(0.8);

  const pairs = [
    ['Batch ID', batch.batchNumber],
    ['File', batch.filename],
    ['Upload Date', fmtDateTime(batch.uploadedAt)],
    ['Uploaded By', batch.uploadedByName || '-'],
    ['Status', batch.status.replace(/_/g, ' ')],
    ['Total Recipients', String(batch.recipients)],
    ['Successful', String(batch.successful)],
    ['Failed', String(batch.failed)],
    ['Pending', String(batch.pending)],
    ['Cancelled', String(batch.cancelled)],
    ['Success %', batch.successRatePct === null ? '-' : `${batch.successRatePct}%`],
    ['Failure %', batch.failureRatePct === null ? '-' : `${batch.failureRatePct}%`],
  ];
  const colW = 250;
  const startY = doc.y;
  pairs.forEach(([k, v], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 36 + col * colW;
    const y = startY + row * 30;
    doc.fillColor('#777').fontSize(8).font('Helvetica').text(k.toUpperCase(), x, y, { width: colW - 10 });
    doc.fillColor('#111').fontSize(11).font('Helvetica-Bold').text(String(v), x, y + 10, { width: colW - 10, ellipsis: true, height: 14 });
  });
  doc.y = startY + Math.ceil(pairs.length / 3) * 30 + 12;
  doc.x = 36;

  const cols = [
    { h: '#', w: 30, v: (r) => String(r.rowNumber) },
    { h: 'Customer', w: 120, v: (r) => r.customerName },
    { h: 'Phone', w: 85, v: (r) => r.phoneNumber },
    { h: 'Amount (Rs.)', w: 70, v: (r) => Number(r.amountDue).toLocaleString('en-IN'), align: 'right' },
    { h: 'Account', w: 70, v: (r) => r.accountId || '' },
    { h: 'Status', w: 90, v: (r) => STATUS_LABEL[r.status] || r.status },
    { h: 'Reason', w: 175, v: (r) => r.failureReason || '' },
    { h: 'Code', w: 45, v: (r) => r.providerErrorCode || '' },
    { h: 'Tries', w: 30, v: (r) => String(r.attempts), align: 'right' },
    { h: 'Sent', w: 55, v: (r) => (r.sentAt ? fmtDateTime(r.sentAt).split(', ')[1] || '' : '') },
  ];
  const tableX = 36;
  const bottom = doc.page.height - 40;
  const header = () => {
    let x = tableX;
    const y = doc.y;
    doc.rect(tableX, y - 2, cols.reduce((a, c) => a + c.w, 0), 14).fill(green);
    doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
    for (const c of cols) {
      doc.text(c.h, x + 2, y + 1, { width: c.w - 4, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    doc.y = y + 14;
  };
  header();
  doc.font('Helvetica').fontSize(7.5);
  records.forEach((r, i) => {
    if (doc.y + 12 > bottom) {
      doc.addPage();
      doc.y = 36;
      header();
      doc.font('Helvetica').fontSize(7.5);
    }
    const y = doc.y;
    if (i % 2) doc.rect(tableX, y - 1, cols.reduce((a, c) => a + c.w, 0), 12).fill('#f2f5f3');
    doc.fillColor('#111');
    let x = tableX;
    for (const c of cols) {
      doc.text(String(c.v(r) || ''), x + 2, y + 1, { width: c.w - 4, height: 10, ellipsis: true, lineBreak: false, align: c.align || 'left' });
      x += c.w;
    }
    doc.y = y + 12;
  });
  doc.end();
}

module.exports = { buildResultsWorkbook, streamResultsPdf, safeCell, STATUS_LABEL };
