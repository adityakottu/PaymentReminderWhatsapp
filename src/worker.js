'use strict';

/**
 * Standalone worker process. Run one or more of these (with
 * RUN_WORKER_IN_PROCESS=false on the web servers) to scale sending
 * independently of the HTTP tier. Requires DATABASE_CLIENT=pg when running
 * more than one process against the same database.
 */
const { loadConfig, assertProductionConfig } = require('./config');
const { createDb, migrate } = require('./db');
const { createApplication } = require('./app');

async function main() {
  const config = loadConfig();
  const problems = assertProductionConfig(config);
  if (problems.length && config.env === 'production') {
    console.error(`Refusing to start:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  const db = createDb(config);
  await migrate(db);
  const { worker } = createApplication({ db, config });
  worker.start();

  const shutdown = async (signal) => {
    console.info(`[worker] ${signal} received, finishing in-flight jobs`);
    await worker.stop();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
