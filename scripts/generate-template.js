'use strict';

const path = require('path');
const fs = require('fs');
const { buildTemplateWorkbook } = require('../src/bulk/excel');

(async () => {
  const out = path.join(__dirname, '..', 'templates', 'bulk-whatsapp-reminder-template.xlsx');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const wb = await buildTemplateWorkbook();
  await wb.xlsx.writeFile(out);
  console.info(`Wrote ${out}`);
})();
