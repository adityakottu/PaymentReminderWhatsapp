'use strict';

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
  for (const p of problems) console.warn(`[config] ${p}`);

  const db = createDb(config);
  await migrate(db);
  const { app, worker } = createApplication({ db, config });

  const server = app.listen(config.port, () => console.info(`[http] listening on :${config.port}`));
  if (config.queue.runInProcess) worker.start();

  const shutdown = async (signal) => {
    console.info(`[server] ${signal} received, shutting down gracefully`);
    server.close();
    // In-flight jobs are allowed to finish; unstarted jobs stay QUEUED in the database.
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
