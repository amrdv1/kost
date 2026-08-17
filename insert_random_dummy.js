const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'backend', 'donations.db');
const db = new sqlite3.Database(dbPath);

function getRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Simple base64 empty/dummy audio (a tiny valid wav is best, but even invalid audio works if we just want it to load visually)
// We will use a very short valid base64 wav header just in case.
const dummyAudio = "UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA=="; 

db.serialize(() => {
    // 3 Sound donations
    for(let i=0; i<3; i++) {
        const name = `@@DUMMY@@${getRandomString(8)}`;
        const message = getRandomString(15);
        db.run(`
            INSERT INTO donations (customer_name, amount, message, audio_data, audio_type, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `, [name, 500.0, message, dummyAudio, 'audio/wav'], function(err) {
            if(err) console.error("Error inserting sound dummy:", err.message);
            else console.log(`Inserted dummy sound donation ID ${this.lastID}`);
        });
    }

    // 3 Normal donations
    for(let i=0; i<3; i++) {
        const name = getRandomString(10);
        const message = getRandomString(20);
        db.run(`
            INSERT INTO donations (customer_name, amount, message, audio_data, audio_type, created_at)
            VALUES (?, ?, ?, NULL, NULL, datetime('now'))
        `, [name, 50.0, message], function(err) {
            if(err) console.error("Error inserting normal dummy:", err.message);
            else console.log(`Inserted dummy normal donation ID ${this.lastID}`);
        });
    }
});

setTimeout(() => {
    db.close();
    console.log("Done inserting random dummy donations.");
}, 1000);
