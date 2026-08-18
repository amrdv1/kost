require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const port = process.env.PORT || 3000;

// Security variables
const activeSessions = new Set();
const failedAttempts = new Map();

// Initialize PostgreSQL Pool (optimized for high traffic)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,                // Max 20 connections (up from default 10)
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if DB is unreachable
});

// Handle pool errors gracefully (prevent server crash)
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// GLOBAL TEST MODE (Bypasses Stripe for all donations)
const TEST_MODE = false;

// Auto-create tables if not exist
pool.query(`
  CREATE TABLE IF NOT EXISTS donations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_payment_id VARCHAR UNIQUE,
    customer_name VARCHAR NOT NULL,
    message TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'UAH',
    payment_status VARCHAR NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED')),
    audio_status VARCHAR NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (audio_status IN ('PENDING_PAYMENT', 'PENDING_MODERATION', 'APPROVED', 'REJECTED')),
    audio_base64 TEXT,
    audio_type VARCHAR,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS album_settings (
    item_key VARCHAR PRIMARY KEY,
    item_value VARCHAR NOT NULL
  );
`).then(() => console.log('Database initialized')).catch(e => console.error('DB Init Error:', e));

// Configure Multer for in-memory file uploads (max 10MB)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// --- MIDDLEWARE ---

// Gzip compression (reduces response size by ~70%)
app.use(compression());

// CORS
app.use(cors());

// Trust proxy (Railway runs behind a proxy)
app.set('trust proxy', 1);

// --- RATE LIMITING ---

// General API rate limit: 100 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато запитів. Зачекайте хвилину.' }
});

// Upload rate limit: 3 uploads per minute per IP (anti-spam)
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб. Зачекайте хвилину.' }
});

// Apply general limiter to all API routes
app.use('/api/', generalLimiter);

// --- ANTI-SPAM ---

// Track recent submissions to detect duplicates
const recentSubmissions = new Map(); // key: ip -> { lastSubmitTime, lastHash }

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of recentSubmissions) {
    if (now - data.lastSubmitTime > 5 * 60 * 1000) {
      recentSubmissions.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Simple hash for duplicate detection
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

// --- CACHING ---

// Cache for /api/status (refreshes every 5 seconds)
let statusCache = { count: 0, lastUpdate: 0 };
const STATUS_CACHE_TTL = 5000; // 5 seconds

// Cache for /api/config (never changes during runtime)
let configCache = null;

// --- WEBHOOK (needs raw body, must be BEFORE express.json()) ---

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (stripeEvent.type === 'payment_intent.succeeded') {
    const paymentIntent = stripeEvent.data.object;
    const donationId = paymentIntent.metadata.donation_id;
    const paymentId = paymentIntent.id;

    if (donationId) {
      try {
        await pool.query(
          `UPDATE donations SET stripe_payment_id = $1, payment_status = 'PAID', audio_status = 'APPROVED', updated_at = NOW() WHERE id = $2`,
          [paymentId, donationId]
        );
        console.log('Payment processed & instantly approved for donation:', donationId);
        
        // Fetch ONLY metadata (no audio blob) to broadcast
        const resDonation = await pool.query(
          `SELECT id, customer_name, message, amount, audio_type, created_at FROM donations WHERE id = $1`,
          [donationId]
        );
        if (resDonation.rowCount > 0) {
          io.emit('new_donation', resDonation.rows[0]);
        }
      } catch (err) {
        console.error('DB Update Error:', err);
      }
    }
  }
  res.json({ received: true });
});

// JSON middleware for other routes (limit body size to 1MB)
app.use(express.json({ limit: '1mb' }));

// --- PUBLIC API ---

// Config API (cached — Stripe key never changes)
app.get('/api/config', (req, res) => {
  if (!configCache) {
    configCache = { stripePublicKey: process.env.STRIPE_PUBLIC_KEY };
  }
  res.json(configCache);
});

// Status API (cached — refreshes every 5 seconds)
app.get('/api/status', async (req, res) => {
  try {
    const now = Date.now();
    if (now - statusCache.lastUpdate > STATUS_CACHE_TTL) {
      const countRes = await pool.query(`SELECT COUNT(*) FROM donations WHERE audio_status = 'APPROVED' AND amount >= 500 AND audio_base64 IS NOT NULL AND audio_base64 != '' AND customer_name NOT LIKE '@@DUMMY@@%'`);
      statusCache.count = parseInt(countRes.rows[0].count, 10);
      statusCache.lastUpdate = now;
    }
    res.json({ count: statusCache.count });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});



// Profanity filter utility
const badWordsRegex = new RegExp('(ху[йияев]|ху[ёе]в|хуйн|хуйло|хуесос|хуяр|хуяч|ху[еи]та|пизд|еба[тлн]|ёба[нт]|ебану|ебись|еблан|еб[уо]|выеб|доеб|доёб|заеб|наеб|объеб|поеб|проеб|разъеб|отъеб|уеб|уёб|бля|сук[аи]|суч|мудак|мудил|мудозвон|мудач|долбо|долба|дебил|идиот|кретин|тупиц|тупорыл|тупоголов|имбецил|олигофрен|дегенерат|чмо|чмырь|лох|лузер|неудачни|днищ|позорищ|позорни|жалк|ничтож|мраз|мерзав|мерзот|мерзк|твар|скот|выродок|выродки|ублюд|недоносок|недоумок|помойк|шалав|шлюх|проститут|нахуй|отвали|в\\\\s*жопу|fuck|shit|bullshit|horseshit|ass|arsehole|dumbass|jackass|asshat|asswipe|bastard|bitch|biatch|dick|douche|cock|piss|pussy|cunt|twat|wanker|wank|jerkoff|jackoff|blowjob|handjob|bullcrap|crap|damn|убей|сдохни|умри|повесь|перережь|режь|застрелись|kys|kill\\\\s*yourself|go\\\\s*die|die|drop\\\\s*dead|neck\\\\s*yourself|hang\\\\s*yourself|cancer|free\\\\s*(nitro|robux|vbucks|followers|viewers|subscribers|money)|f4f|v4v|s4s|l4l|click\\\\s*my\\\\s*link|click\\\\s*the\\\\s*link|check\\\\s*my\\\\s*bio|check\\\\s*my\\\\s*profile|dm\\\\s*me|message\\\\s*me|contact\\\\s*me|telegram\\\\s*me|whatsapp\\\\s*me|join\\\\s*my\\\\s*discord|join\\\\s*discord|giveaway|prize|crypto|bitcoin|double\\\\s*your\\\\s*money|make\\\\s*money|investment|f[\\\\s\\\\.\\\\-\\\\_\\\\*\\\\@0-4]*u[\\\\s\\\\.\\\\-\\\\_\\\\*\\\\@0-4]*c[\\\\s\\\\.\\\\-\\\\_\\\\*\\\\@0-4]*k|s[h\\\\!\\\\*\\\\@0-4]*t|a[\\\\$\\\\@]+|d[1\\\\!i]ck|c[0\\\\*o]ck|b[\\\\!1i]tch|k[\\\\.\\\\-\\\\s\\\\_]*y[\\\\.\\\\-\\\\s\\\\_]*s|п[\\\\-\\\\s\\\\!1i]*и[\\\\-\\\\s\\\\!1i]*д[\\\\-\\\\s\\\\!1i]*о[\\\\-\\\\s\\\\!1i]*р|д[0oо]лб[0oо][её]б|у[\\\\-\\\\s]*е[\\\\-\\\\s]*б[\\\\-\\\\s]*о[\\\\-\\\\s]*к|м[\\\\-\\\\s]*у[\\\\-\\\\s]*д[\\\\-\\\\s]*а[\\\\-\\\\s]*к|ч[\\\\-\\\\s]*м[\\\\-\\\\s]*о|л[\\\\-\\\\s]*о[\\\\-\\\\s]*х|с[\\\\-\\\\s]*у[\\\\-\\\\s]*к[\\\\-\\\\s]*а|п[\\\\-\\\\s\\\\*\\\\!u3]*и[\\\\-\\\\s\\\\*\\\\!u3]*з[\\\\-\\\\s\\\\*\\\\!u3]*д[\\\\-\\\\s\\\\*\\\\!u3]*[аец]|б[\\\\-\\\\s]*л[\\\\-\\\\s]*я|х[\\\\-\\\\s\\\\*\\\\@y]*у[\\\\-\\\\s\\\\*\\\\@y]*[йяе]|гитлер|гітлер|gitler|hitler|куклус|ку-клукс|ккк|kkk|ku\\s*klux|рашист|чурка|хач|нигер|nigger|nigga|негр)', 'gi');
const urlRegex = /(https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|ru|ua|net|org|me|co|live|io|uk))/i;

function filterProfanity(text) {
  if (!text) return text;
  return text.replace(badWordsRegex, '***');
}

// --- UPLOAD API (rate limited in production) ---

const uploadMiddleware = TEST_MODE
  ? [upload.single('audio')]
  : [uploadLimiter, upload.single('audio')];

app.post('/api/upload', ...uploadMiddleware, async (req, res) => {
  try {
    const { name, message, amount } = req.body;
    const file = req.file;
    const donationAmount = parseInt(amount, 10);

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (name.length > 50) return res.status(400).json({ error: 'Ім\'я занадто довге (макс 50 символів)' });
    if (urlRegex.test(name)) return res.status(400).json({ error: 'Посилання заборонені!' });
    
    if (message && message.length > 250) return res.status(400).json({ error: 'Повідомлення занадто довге (макс 250 символів)' });
    if (message && urlRegex.test(message)) return res.status(400).json({ error: 'Посилання заборонені!' });

    // Anti-spam checks (skipped in TEST_MODE)
    if (!TEST_MODE) {
      // Honeypot: if hidden field is filled, it's a bot
      if (req.body.website) {
        console.log('Honeypot triggered from IP:', req.ip);
        return res.status(400).json({ error: 'Invalid request' });
      }

      // Time-based anti-bot: check submission timestamp
      const submitTime = parseInt(req.body._t, 10) || 0;
      const timeDiff = Date.now() - submitTime;
      if (submitTime > 0 && timeDiff < 3000) {
        console.log('Speed bot detected from IP:', req.ip, 'filled in', timeDiff, 'ms');
        return res.status(400).json({ error: 'Занадто швидко. Спробуйте ще раз.' });
      }

      // Duplicate detection: same name+message from same IP within 3 minutes
      const ip = req.ip || req.connection.remoteAddress;
      const contentHash = simpleHash(name + (message || '') + amount);
      const prevSubmission = recentSubmissions.get(ip);
      if (prevSubmission) {
        const timeSinceLast = Date.now() - prevSubmission.lastSubmitTime;
        if (timeSinceLast < 180000) {
          return res.status(400).json({ error: 'Зачекайте 3 хвилини перед наступним донатом з цього пристрою.' });
        }
      }
      recentSubmissions.set(ip, { lastSubmitTime: Date.now(), lastHash: contentHash });
    }

    if (isNaN(donationAmount) || donationAmount < 50) return res.status(400).json({ error: 'Мінімальна сума 50 грн' });

    // 50 sound limit check (cached)
    const now = Date.now();
    if (now - statusCache.lastUpdate > STATUS_CACHE_TTL) {
      const countRes = await pool.query(`SELECT COUNT(*) FROM donations WHERE audio_status = 'APPROVED' AND amount >= 500 AND audio_base64 IS NOT NULL AND audio_base64 != '' AND customer_name NOT LIKE '@@DUMMY@@%'`);
      statusCache.count = parseInt(countRes.rows[0].count, 10);
      statusCache.lastUpdate = now;
    }
    const limitReached = statusCache.count >= 50;

    if (donationAmount >= 500) {
      if (limitReached && file) {
        return res.status(400).json({ error: 'ЛІМІТ ЗВУКІВ ВИЧЕРПАНО! (50/50). Доступні лише звичайні донати без звуку.' });
      }
    }

    // Convert buffer directly to base64 if file exists
    const base64Audio = file ? file.buffer.toString('base64') : '';
    const mimeType = file ? file.mimetype : '';

    const filteredName = filterProfanity(name);
    const filteredMessage = filterProfanity(message || '');

    if (TEST_MODE) {
      const result = await pool.query(
        `INSERT INTO donations (stripe_payment_id, customer_name, message, amount, audio_base64, audio_type, payment_status, audio_status) 
         VALUES ($1, $2, $3, $4, $5, $6, 'PAID', 'APPROVED') RETURNING id, customer_name, message, amount, audio_type, created_at`,
        ['test_' + Date.now(), filteredName, filteredMessage, donationAmount, base64Audio, mimeType]
      );
      // Invalidate status cache
      statusCache.lastUpdate = 0;
      // Emit ONLY metadata (no audio blob) via WebSocket
      io.emit('new_donation', result.rows[0]);
      return res.json({ id: result.rows[0].id, bypassed: true });
    }

    const result = await pool.query(
      `INSERT INTO donations (customer_name, message, amount, audio_base64, audio_type) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [filteredName, filteredMessage, donationAmount, base64Audio, mimeType]
    );

    res.json({ id: result.rows[0].id });
  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload and save donation' });
  }
});

// --- NEW: Separate endpoint to fetch audio by donation ID ---

app.get('/api/audio/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT audio_base64, audio_type FROM donations WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    
    const { audio_base64, audio_type } = result.rows[0];
    if (!audio_base64) return res.status(404).json({ error: 'No audio' });
    
    // Send raw audio binary with proper content-type
    const buffer = Buffer.from(audio_base64, 'base64');
    res.set({
      'Content-Type': audio_type || 'audio/webm',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400' // Cache audio for 24h
    });
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Create Payment Intent API
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { donation_id } = req.body;
    if (!donation_id) return res.status(400).json({ error: 'Missing donation_id' });

    // Check if donation exists and get amount
    const result = await pool.query('SELECT id, amount FROM donations WHERE id = $1', [donation_id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Donation not found' });
    const donation = result.rows[0];

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(donation.amount * 100), // dynamic UAH amount
      currency: 'uah',
      metadata: { donation_id: donation_id },
      payment_method_types: ['card'],
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Stripe Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- TEMPORARY ENDPOINT TO FILL 50 SOUNDS ---
app.get('/api/fill-50', async (req, res) => {
  try {
    for (let i = 1; i <= 50; i++) {
      await pool.query(
        `INSERT INTO donations (stripe_payment_id, customer_name, message, amount, audio_base64, audio_type, payment_status, audio_status) 
         VALUES ($1, $2, $3, $4, $5, $6, 'PAID', 'APPROVED')`,
        ['test_fill_' + Date.now() + '_' + i, 'Тест Донат ' + i, 'Фейк донат №' + i, 500, 'UklGRiQAAABXRUJN', 'audio/webm']
      );
    }
    statusCache.lastUpdate = 0; // Invalidate cache
    res.send('<h2>Успішно додано 50 звукових донатів!</h2><p>Можете закрити цю вкладку і перевірити ліміт на сайті.</p>');
  } catch (error) {
    res.status(500).send('Помилка: ' + error.message);
  }
});

// --- ADMIN API ---

const adminAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.split(' ')[1];
  if (token !== 'kostiuchenko_static_token_xyz') {
    return res.status(401).json({ error: 'Unauthorized or session expired' });
  }
  next();
};


// Admin Login Endpoint
app.post('/api/admin/login', express.json(), (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const { password } = req.body;

  // Brute-force protection: Block IP for 5 minutes after 5 failed attempts
  const attemptsInfo = failedAttempts.get(ip) || { count: 0, lockUntil: 0 };
  if (attemptsInfo.lockUntil > Date.now()) {
    return res.status(429).json({ error: 'Забагато спроб входу. Зачекайте 5 хвилин.' });
  }

  if (password === process.env.ADMIN_PASSWORD) {
    failedAttempts.delete(ip);
    return res.json({ token: 'kostiuchenko_static_token_xyz' });
  } else {
    attemptsInfo.count += 1;
    if (attemptsInfo.count >= 5) {
      attemptsInfo.lockUntil = Date.now() + 5 * 60 * 1000;
    }
    failedAttempts.set(ip, attemptsInfo);
    return res.status(401).json({ error: 'Невірний пароль' });
  }
});

// Admin Logout Endpoint
app.post('/api/admin/logout', adminAuth, (req, res) => {
  res.json({ success: true });
});

// Admin API: Get pending donations (WITHOUT audio blob)
app.get('/api/admin/pending', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, message, amount, audio_type, created_at 
       FROM donations WHERE audio_status = 'PENDING_MODERATION' ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API: Moderate donation
app.post('/api/admin/moderate', adminAuth, async (req, res) => {
  try {
    const { donation_id, status } = req.body;
    if (!['APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await pool.query(
      `UPDATE donations SET audio_status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, customer_name, message, amount, audio_type`,
      [status, donation_id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Donation not found' });

    // Invalidate status cache
    statusCache.lastUpdate = 0;

    const updatedDonation = result.rows[0];

    // If approved, notify with metadata only (no audio blob)
    if (status === 'APPROVED') {
      io.emit('new_donation', updatedDonation);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API: Get all approved (WITHOUT audio blob — use /api/audio/:id separately)
app.get('/api/admin/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, message, amount, audio_type, created_at 
       FROM donations WHERE audio_status = 'APPROVED' ORDER BY updated_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API: Get album settings
app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT item_key, item_value FROM album_settings');
    const settings = {};
    result.rows.forEach(r => settings[r.item_key] = r.item_value);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API: Update album settings
app.post('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(
      `INSERT INTO album_settings (item_key, item_value) VALUES ($1, $2)
       ON CONFLICT (item_key) DO UPDATE SET item_value = EXCLUDED.item_value`,
      [key, value]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Public API: Get countdown start time
app.get('/api/countdown', async (req, res) => {
  try {
    const result = await pool.query("SELECT item_value FROM album_settings WHERE item_key = 'countdown_start'");
    if (result.rows.length > 0) {
      res.json({ startTime: parseInt(result.rows[0].item_value, 10), serverNow: Date.now() });
    } else {
      res.json({ startTime: null, serverNow: Date.now() });
    }
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API: Set countdown start time (or clear if not provided)
app.post('/api/countdown/start', express.json(), async (req, res) => {
  try {
    const { startTime } = req.body;
    if (startTime) {
      await pool.query(
        `INSERT INTO album_settings (item_key, item_value) VALUES ('countdown_start', $1)
         ON CONFLICT (item_key) DO UPDATE SET item_value = EXCLUDED.item_value`,
        [startTime.toString()]
      );
    } else {
      await pool.query("DELETE FROM album_settings WHERE item_key = 'countdown_start'");
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// DUMMY DONATION ENDPOINT
app.get('/api/admin/insert-sound-dummies', async (req, res) => {
  try {
    function getRandomString(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    const dummyAudio = "UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA=="; 

    // 3 Sound donations
    for(let i=0; i<3; i++) {
        const name = `@@DUMMY@@${getRandomString(8)}`;
        const message = getRandomString(15);
        await pool.query(
            `INSERT INTO donations (customer_name, amount, message, audio_base64, audio_type, payment_status, audio_status)
             VALUES ($1, $2, $3, $4, $5, 'PAID', 'APPROVED')`,
            [name, 500.0, message, dummyAudio, 'audio/wav']
        );
    }

    statusCache.lastUpdate = 0; // Invalidate cache
    res.send('Success! 3 SOUND dummy donations added. Refresh the admin page to see them.');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- WEBSOCKETS ---

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  socket.on('join_admin', () => {
    socket.join('admin');
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// --- STATIC FILES (NO CACHE FOR DEV) ---

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.use(express.static(path.join(__dirname, 'frontend')));

// Routes
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'admin', 'index.html')));
app.get('/countdown', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'countdown', 'index.html')));
app.get('/tiktok', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'tiktok', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'client', 'index.html')));

// --- GRACEFUL SHUTDOWN ---

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    pool.end(() => {
      console.log('Database pool closed.');
      process.exit(0);
    });
  });
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- CRASH PREVENTION ---

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — Server did NOT crash:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION — Server did NOT crash:', reason);
});

// --- START SERVER ---

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(`TEST_MODE: ${TEST_MODE}`);
  console.log(`Pool max connections: ${pool.options?.max || 20}`);
});
