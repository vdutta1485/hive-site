require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const { Pool } = require('pg');

// Use SSL for any remote database (e.g. Supabase requires it). Disable SSL only
// for a genuinely local Postgres, regardless of NODE_ENV.
const connStr = process.env.DATABASE_URL || '';
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])/.test(connStr);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

module.exports = pool;
