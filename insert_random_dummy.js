require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:12345@localhost:5432/postgres",
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

function getRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

const dummyAudio = "UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA=="; 

async function seed() {
    try {
        // 3 Sound donations
        for(let i=0; i<3; i++) {
            const name = `@@DUMMY@@${getRandomString(8)}`;
            const message = getRandomString(15);
            await pool.query(`
                INSERT INTO donations (customer_name, amount, message, audio_base64, audio_type, payment_status, audio_status)
                VALUES ($1, $2, $3, $4, $5, 'PAID', 'APPROVED')
            `, [name, 500.0, message, dummyAudio, 'audio/wav']);
            console.log(`Inserted dummy sound donation ${i+1}`);
        }

        // 3 Normal donations
        for(let i=0; i<3; i++) {
            const name = getRandomString(10);
            const message = getRandomString(20);
            await pool.query(`
                INSERT INTO donations (customer_name, amount, message, payment_status, audio_status)
                VALUES ($1, $2, $3, 'PAID', 'APPROVED')
            `, [name, 50.0, message]);
            console.log(`Inserted dummy normal donation ${i+1}`);
        }
    } catch(err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

seed();
