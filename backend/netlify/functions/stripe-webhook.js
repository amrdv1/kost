const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed:`, err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
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
        return { statusCode: 500, body: 'Database Error' };
      }
      console.log('Payment processed for donation:', donationId);
    }
  }

  return { statusCode: 200, body: 'Received' };
};
