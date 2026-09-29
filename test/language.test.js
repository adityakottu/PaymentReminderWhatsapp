'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, makeXlsx, customers, records, HEADERS } = require('./helpers');
const { renderLocalized, parseLanguage, DEFAULT_TEMPLATE_TE } = require('../src/bulk/template');
const { MetaCloudProvider } = require('../src/whatsapp/metaCloudProvider');

const rec = { customer_name: 'Ravi Kumar', amount_due: 5000, due_date: '2026-09-30', account_id: 'LN10045' };

test('Telugu and bilingual rendering', () => {
  const te = renderLocalized({}, 'te', rec);
  assert.equal(
    te,
    'నమస్కారం Ravi Kumar గారు,\n\nమీరు చెల్లించవలసిన ₹5,000 బకాయి గురించి ఇది ఒక రిమైండర్.\n\nచెల్లింపు గడువు తేదీ: 30-09-2026\n\nదయచేసి వీలైనంత త్వరగా చెల్లింపు చేయండి.\n\nలోన్/ఖాతా నంబర్: LN10045\n\nధన్యవాదాలు.'
  );
  const both = renderLocalized({}, 'both', rec);
  assert.ok(both.startsWith('Hello Ravi Kumar,'));
  assert.ok(both.endsWith('ధన్యవాదాలు.'));
  assert.match(both, /Thank you\.\n\n— — —\n\nనమస్కారం/);
  assert.ok(renderLocalized({}, 'en', rec).startsWith('Hello Ravi Kumar'));
  assert.ok(renderLocalized({ te: 'Namaskaram {{customer_name}} ₹{{amount_due}}' }, 'te', rec) === 'Namaskaram Ravi Kumar ₹5,000');
});

test('language values from Excel', () => {
  for (const v of ['en', 'English', ' ENGLISH ']) assert.equal(parseLanguage(v), 'en');
  for (const v of ['te', 'Telugu', 'తెలుగు']) assert.equal(parseLanguage(v), 'te');
  for (const v of ['both', 'Bilingual', 'English + Telugu', 'English+Telugu']) assert.equal(parseLanguage(v), 'both');
  assert.equal(parseLanguage(''), null);
  assert.equal(parseLanguage(null), null);
  assert.equal(parseLanguage('Hindi'), undefined);
});

test('Meta provider sends the approved template for each language', () => {
  const p = new MetaCloudProvider({
    sendMode: 'template',
    templateName: 'payment_reminder',
    templateLanguage: 'en',
    templateNameTe: 'payment_reminder',
    templateLanguageTe: 'te',
    templateNameBoth: 'payment_reminder_bilingual',
    templateLanguageBoth: 'en',
    templateParams: ['customer_name', 'amount_due'],
    templateParamsBoth: ['customer_name', 'amount_due', 'customer_name', 'amount_due'],
  });
  const vars = { customer_name: 'Ravi', amount_due: '5,000' };
  const en = p.buildPayload({ to: '91', variables: vars, language: 'en' }).template;
  const te = p.buildPayload({ to: '91', variables: vars, language: 'te' }).template;
  const both = p.buildPayload({ to: '91', variables: vars, language: 'both' }).template;
  assert.deepEqual([en.name, en.language.code], ['payment_reminder', 'en']);
  assert.deepEqual([te.name, te.language.code], ['payment_reminder', 'te']);
  assert.deepEqual([both.name, both.language.code], ['payment_reminder_bilingual', 'en']);
  assert.equal(both.components[0].parameters.length, 4);
});

test('batch language choice + per-customer Language column', async () => {
  const env = await setup({ script: () => 'success' });
  try {
    const api = await login(env.base, 'admin');
    const headers = [...HEADERS, 'Language'];
    const rows = customers(4, { phoneFor: (i) => `987654321${i}` });
    rows[1].Language = 'English';
    rows[2].Language = 'Both';
    rows[3].Language = 'Hindi';
    const up = await api.upload('/api/bulk-reminders/uploads', await makeXlsx(rows, { headers }));
    assert.equal(up.status, 201);
    assert.equal(up.data.batch.validRecords, 3);
    const issues = await api.get(`/api/bulk-reminders/batches/${up.data.batch.id}/issues`);
    assert.match(issues.data.rows[0].reasons.join(), /Language must be English, Telugu or Both/);
    const id = up.data.batch.id;
    await api.post(`/api/bulk-reminders/batches/${id}/import`);

    // Invalid Telugu template is rejected with a language-specific message.
    let r = await api.put(`/api/bulk-reminders/batches/${id}/template`, { templateTe: 'నమస్కారం {{customer_name}}' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Telugu template: Template must include \{\{amount_due\}\}/);
    r = await api.put(`/api/bulk-reminders/batches/${id}/template`, { language: 'hindi' });
    assert.equal(r.status, 400);

    // Choose Telugu as the batch language.
    r = await api.put(`/api/bulk-reminders/batches/${id}/template`, { language: 'te' });
    assert.equal(r.status, 200);
    assert.equal(r.data.batch.language, 'te');

    const pv = await api.post(`/api/bulk-reminders/batches/${id}/preview`, {});
    assert.deepEqual(pv.data.previews.map((p) => p.language), ['te', 'en', 'both']);
    assert.ok(pv.data.previews[0].message.startsWith('నమస్కారం Customer 1 గారు'));

    await api.post(`/api/bulk-reminders/batches/${id}/send`, { confirm: true });
    await env.worker.drain();
    const recs = await records(env.db, id);
    assert.deepEqual(recs.map((x) => x.language), ['te', 'en', 'both']);
    assert.deepEqual(recs.map((x) => x.status), ['SENT', 'SENT', 'SENT']);
    assert.ok(recs[0].message.startsWith('నమస్కారం'));
    assert.ok(recs[1].message.startsWith('Hello'));
    assert.ok(recs[2].message.includes('Thank you.') && recs[2].message.includes('ధన్యవాదాలు.'));
    assert.deepEqual(env.mock.calls.map((c) => c.language), ['te', 'en', 'both']);

    const list = await api.get(`/api/bulk-reminders/batches/${id}/records`);
    assert.equal(list.data.records[0].language, 'te');
  } finally {
    await env.close();
  }
});

test('default Telugu template can be edited globally (admin only)', async () => {
  const env = await setup();
  try {
    const admin = await login(env.base, 'admin');
    let r = await admin.get('/api/bulk-reminders/message-template');
    assert.equal(r.data.bodyTe, DEFAULT_TEMPLATE_TE);
    r = await admin.put('/api/bulk-reminders/message-template', { bodyTe: 'ప్రియమైన {{customer_name}}, ₹{{amount_due}} చెల్లించండి.' });
    assert.equal(r.status, 200);
    assert.equal(r.data.bodyTe, 'ప్రియమైన {{customer_name}}, ₹{{amount_due}} చెల్లించండి.');
    assert.ok(r.data.body.startsWith('Hello'), 'English template unchanged');
    // New batches pick up the edited Telugu default.
    const up = await admin.upload('/api/bulk-reminders/uploads', await makeXlsx(customers(1, { phoneFor: () => '9876543211' })));
    const imp = await admin.post(`/api/bulk-reminders/batches/${up.data.batch.id}/import`);
    assert.equal(imp.data.batch.messageTemplateTe, 'ప్రియమైన {{customer_name}}, ₹{{amount_due}} చెల్లించండి.');
    const head = await login(env.base, 'head');
    assert.equal((await head.put('/api/bulk-reminders/message-template', { bodyTe: 'x {{customer_name}} {{amount_due}}' })).status, 403);
  } finally {
    await env.close();
  }
});
