'use strict';

const { loadConfig } = require('../src/config');
const { createDb, migrate } = require('../src/db');

(async () => {
  const db = createDb(loadConfig());
  await migrate(db);
  console.info('Migrations applied.');
  await db.destroy();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
