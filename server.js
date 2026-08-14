require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL', 
  process.env.SUPABASE_SERVICE_KEY || 'YOUR_SERVICE_KEY'
);

// Middleware
app.use(cors());

// Webhook endpoint needs raw body for Stripe signature verification
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const paymentIntent = stripeEvent.data.object;
    const donationId = paymentIntent.metadata.donation_id;
    const paymentId = paymentIntent.id;

    if (donationId) {
      // Update Supabase Database
      const { data, error } = await supabase
        .from('donations')
        .update({
          stripe_payment_id: paymentId,
          payment_status: 'PAID',
          audio_status: 'PENDING_MODERATION',
          updated_at: new Date()
        })
        .eq('id', donationId);

      if (error) {
        console.error('DB Update Error:', error);
        return res.status(500).send('Database Error');
      }
      console.log('Payment processed for donation:', donationId);
    }
  }

  res.json({ received: true });
});

// JSON middleware for other routes
app.use(express.json());

// Create Payment Intent API
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, donation_id } = req.body;

    if (!amount || !donation_id) {
      return res.status(400).json({ error: 'Missing amount or donation_id' });
    }

    // Verify donation exists in Supabase
    const { data: donation, error: dbError } = await supabase
      .from('donations')
      .select('id')
      .eq('id', donation_id)
      .single();

    if (dbError || !donation) {
      return res.status(404).json({ error: 'Donation record not found' });
    }

    // Create a PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // Stripe expects amounts in cents
      currency: currency || 'uah',
      metadata: { donation_id: donation_id },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Stripe Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend')));

// Fallback to client/index.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'client', 'index.html'));
});

// Start Server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
