const https = require('https');

function getRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function sendFakeDonate(type) {
    return new Promise((resolve, reject) => {
        const amount = type === 'sound' ? 500 : 50;
        let name = getRandomString(10);
        if (type === 'sound') {
            name = '@@DUMMY@@' + name;
        } else {
            // we probably want normal dummy donations to also not fill scale, 
            // wait, normal donations don't fill the scale anyway (the counter is only for sound donations)
            // But let's add @@DUMMY@@ just in case, or leave it.
            name = '@@DUMMY@@' + name;
        }
        const msg = getRandomString(20);
        
        const url = `https://kostiuchenko.live/api/fake-donate?type=${type}&amount=${amount}&name=${encodeURIComponent(name)}&msg=${encodeURIComponent(msg)}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function run() {
    console.log("Sending 3 sound donations...");
    for(let i=0; i<3; i++) {
        await sendFakeDonate('sound');
        console.log(`Sound donation ${i+1} sent`);
    }
    console.log("Sending 3 normal donations...");
    for(let i=0; i<3; i++) {
        await sendFakeDonate('normal');
        console.log(`Normal donation ${i+1} sent`);
    }
    console.log("Done!");
}

run();
