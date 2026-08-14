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
      audio_url TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
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
          `UPDATE donations SET stripe_payment_id = $1, payment_status = 'PAID', audio_status = 'PENDING_MODERATION', updated_at = NOW() WHERE id = $2`,
          [paymentId, donationId]
        );
        console.log('Payment processed for donation:', donationId);
        
        // Notify admins that a new donation needs moderation
        io.to('admin').emit('new_donation_pending');
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

// Configure Cloudinary explicitly from URL
if (process.env.CLOUDINARY_URL) {
  try {
    const cloudinaryUrl = process.env.CLOUDINARY_URL.trim();
    // Format: cloudinary://api_key:api_secret@cloud_name
    const url = new URL(cloudinaryUrl);
    cloudinary.config({
      cloud_name: url.hostname,
      api_key: url.username,
      api_secret: url.password
    });
  } catch (err) {
    console.error("Failed to parse CLOUDINARY_URL:", err.message);
  }
}

// Helper function to upload buffer to Cloudinary
const uploadToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: 'auto', folder: 'donations' }, // 'auto' handles audio, video, images
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

// Upload API
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    const { name, message } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No audio file provided' });
    if (!name) return res.status(400).json({ error: 'Name is required' });

    // Upload to Cloudinary
    const cloudinaryResult = await uploadToCloudinary(file.buffer);
    const audioUrl = cloudinaryResult.secure_url;

    const result = await pool.query(
      `INSERT INTO donations (customer_name, message, amount, audio_url) 
       VALUES ($1, $2, 500, $3) RETURNING id`,
      [name, message || '', audioUrl]
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

    // Check if donation exists
    const result = await pool.query('SELECT id FROM donations WHERE id = $1', [donation_id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Donation not found' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 500 * 100, // 500 UAH
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

// Admin API: Get pending donations
app.get('/api/admin/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, message, amount, audio_url, created_at 
       FROM donations WHERE audio_status = 'PENDING_MODERATION' ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin API: Approve or Reject
app.post('/api/admin/moderate', async (req, res) => {
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
        audio_url: updatedDonation.audio_url
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
      `SELECT id, customer_name, message, audio_url 
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
