require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await pool.query(`ALTER TABLE donations ALTER COLUMN audio_base64 DROP NOT NULL;`);
        await pool.query(`ALTER TABLE donations ALTER COLUMN audio_type DROP NOT NULL;`);
        console.log("Schema updated successfully.");
    } catch (e) {
        console.error("Schema update error:", e.message);
    } finally {
        pool.end();
    }
}
run();
