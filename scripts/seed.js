'use strict';

/**
 * Create the initial admin (and, outside production, demo users).
 *   ADMIN_USERNAME / ADMIN_PASSWORD are read from the environment.
 */
const { loadConfig } = require('../src/config');
const { createDb, migrate } = require('../src/db');
const { createUser } = require('../src/auth/auth');
const { PERMISSIONS } = require('../src/auth/permissions');

(async () => {
  const config = loadConfig();
  const db = createDb(config);
  await migrate(db);

  const ensure = async (spec) => {
    const exists = await db('users').where({ username: spec.username }).first();
    if (exists) return console.info(`User ${spec.username} already exists – skipped`);
    await createUser(db, spec);
    console.info(`Created ${spec.role} "${spec.username}"`);
  };

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error('Set ADMIN_PASSWORD (min 10 chars) to create the admin user.');
    process.exit(1);
  }
  await ensure({ username: process.env.ADMIN_USERNAME || 'admin', displayName: 'Admin', password: adminPassword, role: 'admin' });

  if (config.env !== 'production' && process.env.SEED_DEMO_USERS !== 'false') {
    await ensure({ username: 'mainhead', displayName: 'Main Head', password: adminPassword, role: 'main_head' });
    await ensure({ username: 'suresh', displayName: 'Suresh', password: adminPassword, role: 'employee' });
    await ensure({
      username: 'ramesh',
      displayName: 'Ramesh',
      password: adminPassword,
      role: 'employee',
      permissions: [PERMISSIONS.UPLOAD, PERMISSIONS.SEND],
    });
  }
  await db.destroy();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
