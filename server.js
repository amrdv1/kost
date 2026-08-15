require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const port = process.env.PORT || 3000;

// Initialize PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Auto-create table if not exists (so it works on Railway instantly)
pool.query(`
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE TABLE IF NOT EXISTS donations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  
  -- Add new columns if they don't exist (for migration)
  ALTER TABLE donations ADD COLUMN IF NOT EXISTS audio_base64 TEXT;
  ALTER TABLE donations ADD COLUMN IF NOT EXISTS audio_type VARCHAR;
  
  -- Drop old unused columns
  ALTER TABLE donations DROP COLUMN IF EXISTS audio_url;
`).then(() => console.log('Database initialized')).catch(e => console.error('DB Init Error:', e));

// Configure Multer for in-memory file uploads (max 10MB)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// Middleware
app.use(cors());

// Webhook endpoint needs raw body
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
        
        // Fetch the donation details to broadcast
        const resDonation = await pool.query(`SELECT id, customer_name, message, amount, audio_base64, audio_type, created_at FROM donations WHERE id = $1`, [donationId]);
        if (resDonation.rowCount > 0) {
          // Notify clients that a new sound is ready to play
          io.emit('play_sound', resDonation.rows[0]);
        }
      } catch (err) {
        console.error('DB Update Error:', err);
      }
    }
  }
  res.json({ received: true });
});

// JSON middleware for other routes
app.use(express.json());

// Public config API (so keys are not hardcoded in HTML)
app.get('/api/config', (req, res) => {
  res.json({ stripePublicKey: process.env.STRIPE_PUBLIC_KEY });
});

// Status API to check limit
app.get('/api/status', async (req, res) => {
  try {
    const countRes = await pool.query(`SELECT COUNT(*) FROM donations WHERE audio_status = 'APPROVED' AND amount >= 500`);
    res.json({ count: parseInt(countRes.rows[0].count, 10) });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Upload API
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    const { name, message, amount } = req.body;
    const file = req.file;
    const donationAmount = parseInt(amount, 10);

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (isNaN(donationAmount) || donationAmount < 50) return res.status(400).json({ error: 'Мінімальна сума 50 грн' });

    if (donationAmount >= 500 && !file) {
      return res.status(400).json({ error: 'Для донату від 500 грн необхідно прикріпити звук' });
    }

    // 50 sound limit check (only for sound donations)
    if (donationAmount >= 500) {
      const countRes = await pool.query(`SELECT COUNT(*) FROM donations WHERE audio_status = 'APPROVED' AND amount >= 500`);
      if (parseInt(countRes.rows[0].count, 10) >= 50) {
        return res.status(400).json({ error: 'ЛІМІТ ЗВУКІВ ВИЧЕРПАНО! (50/50)' });
      }
    }

    // Convert buffer directly to base64 if file exists
    const base64Audio = file ? file.buffer.toString('base64') : '';
    const mimeType = file ? file.mimetype : '';

    const result = await pool.query(
      `INSERT INTO donations (customer_name, message, amount, audio_base64, audio_type) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, message || '', donationAmount, base64Audio, mimeType]
    );

    res.json({ id: result.rows[0].id });
  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload and save donation' });
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
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Stripe Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin Auth Middleware
const adminAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Admin API: Get pending donations
app.get('/api/admin/pending', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, message, amount, audio_base64, audio_type, created_at 
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
      `UPDATE donations SET audio_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, donation_id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Donation not found' });

    const updatedDonation = result.rows[0];

    // If approved, notify the live soundboard to play it!
    if (status === 'APPROVED') {
      io.emit('play_sound', {
        id: updatedDonation.id,
        name: updatedDonation.customer_name,
        message: updatedDonation.message,
        audio_base64: updatedDonation.audio_base64,
        audio_type: updatedDonation.audio_type
      });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API: Get all approved (for history on soundboard load)
app.get('/api/live/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, message, amount, audio_base64, audio_type, created_at 
       FROM donations WHERE audio_status = 'APPROVED' ORDER BY updated_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// WebSockets logic
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Admins can join a special room to receive pending donation alerts
  socket.on('join_admin', () => {
    socket.join('admin');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend')));

// Routes
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'admin', 'index.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'live', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'client', 'index.html')));

// Start Server using `server` (not `app`) because of socket.io
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
