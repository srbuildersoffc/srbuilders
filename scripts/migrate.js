'use strict';
require('dotenv').config();
process.env.VERCEL = process.env.VERCEL || '1'; // prevent server listen() during CLI migration
const app = require('../server');

(async () => {
  try {
    await app.initDatabaseSchema({ force: true });
    console.log('[MIGRATE] Database schema and indexes applied successfully.');
  } catch (err) {
    console.error('[MIGRATE ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    await app.pool.end();
  }
})();
