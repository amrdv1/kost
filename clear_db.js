require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function clear() {
  try {
    await pool.query('DELETE FROM donations');
    console.log('All donations cleared successfully.');
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

clear();
