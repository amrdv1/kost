require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function fill50() {
  try {
    console.log('Inserting 50 test sound donations...');
    for (let i = 1; i <= 50; i++) {
      await pool.query(
        `INSERT INTO donations (stripe_payment_id, customer_name, message, amount, audio_base64, audio_type, payment_status, audio_status) 
         VALUES ($1, $2, $3, $4, $5, $6, 'PAID', 'APPROVED')`,
        ['test_fill_' + Date.now() + '_' + i, 'Тест Донат ' + i, 'Це фейковий донат для перевірки ліміту №' + i, 500, 'UklGRiQAAABXRUJN', 'audio/webm']
      );
    }
    
    const countRes = await pool.query(`SELECT COUNT(*) FROM donations WHERE audio_status = 'APPROVED' AND amount >= 500`);
    console.log('Total sound donations in DB now:', countRes.rows[0].count);
    
    console.log('Successfully added 50 donations.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

fill50();
