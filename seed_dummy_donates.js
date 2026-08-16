require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function run() {
  try {
    console.log('Clearing database...');
    await pool.query('DELETE FROM donations');

    console.log('Inserting dummy donations...');
    
    // Ordinary donation 1
    await pool.query(`
      INSERT INTO donations (customer_name, message, amount, currency, payment_status)
      VALUES ('Степан', 'Бро, давай рви чарти!', 150.00, 'UAH', 'PAID')
    `);

    // Ordinary donation 2
    await pool.query(`
      INSERT INTO donations (customer_name, message, amount, currency, payment_status)
      VALUES ('Анонім', 'Просто на каву', 50.00, 'UAH', 'PAID')
    `);

    // Voice donation 1
    // We'll just provide a tiny valid or invalid base64 audio string so it renders in the UI
    const dummyAudio = "data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////FUmpZpkq17GDD0JATYCGQ2hyb21lV0GGQ2hyb21lFlSua7+uvdeBAXPFh2xG8oXw4L+DgQKGhkFfT1BVU2Oik09wdXNIZWFkAQEAAIC7AAAAAADhjbWERqqflzxAA==";
    await pool.query(`
      INSERT INTO donations (customer_name, message, amount, currency, payment_status, audio_status, audio_base64, audio_type)
      VALUES ('Макс', 'Оце звук!', 500.00, 'UAH', 'PAID', 'APPROVED', $1, 'audio/webm')
    `, [dummyAudio]);

    // Voice donation 2
    await pool.query(`
      INSERT INTO donations (customer_name, message, amount, currency, payment_status, audio_status, audio_base64, audio_type)
      VALUES ('Оля', 'Привіт зі Львова, дуже чекаю на альбом!', 1000.00, 'UAH', 'PAID', 'APPROVED', $1, 'audio/webm')
    `, [dummyAudio]);

    console.log('Done!');
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
