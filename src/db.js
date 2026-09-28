'use strict';

const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');

function createDb(config) {
  const { client, url, sqliteFilename } = config.database;
  if (client === 'pg') {
    return knexFactory({
      client: 'pg',
      connection: url,
      pool: { min: 1, max: 10 },
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
  }
  if (sqliteFilename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(sqliteFilename)), { recursive: true });
  }
  return knexFactory({
    client: 'better-sqlite3',
    connection: { filename: sqliteFilename },
    useNullAsDefault: true,
    // A single connection keeps SQLite writes serialised and makes :memory: databases usable.
    pool: {
      min: 1,
      max: 1,
      afterCreate(conn, done) {
        conn.pragma('journal_mode = WAL');
        conn.pragma('busy_timeout = 5000');
        conn.pragma('foreign_keys = ON');
        done();
      },
    },
    migrations: { directory: path.join(__dirname, '..', 'migrations') },
  });
}

async function migrate(db) {
  await db.migrate.latest();
}

/** Current time as an ISO-8601 string. All timestamps are stored in this format. */
function nowIso(clock) {
  return new Date(clock ? clock() : Date.now()).toISOString();
}

/** Normalise a DB timestamp (Date on pg, string on SQLite) to ISO or null. */
function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

module.exports = { createDb, migrate, nowIso, toIso };
