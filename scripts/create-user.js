'use strict';

/**
 * Usage:
 *   npm run user:create -- --username suresh --name "Suresh" --role employee --password '...' [--grant bulk_whatsapp_reminders.send,...]
 */
const { loadConfig } = require('../src/config');
const { createDb, migrate } = require('../src/db');
const { createUser } = require('../src/auth/auth');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
  const db = createDb(loadConfig());
  await migrate(db);
  const id = await createUser(db, {
    username: arg('username'),
    displayName: arg('name'),
    password: arg('password'),
    role: arg('role'),
    permissions: (arg('grant') || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  console.info(`Created user #${id}`);
  await db.destroy();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
