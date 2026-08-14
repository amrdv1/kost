const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    // 1. Verify Shopify HMAC Signature
    const hmacHeader = event.headers['x-shopify-hmac-sha256'];
    const body = event.body;
    const generatedHash = crypto
      .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(body, 'utf8')
      .digest('base64');

    if (generatedHash !== hmacHeader) {
      console.error('Invalid signature');
      return { statusCode: 401, body: 'Unauthorized: Invalid signature' };
    }

    // 2. Parse Order Data
    const order = JSON.parse(body);

    if (order.financial_status !== 'paid') {
      return { statusCode: 200, body: 'Order not paid yet. Ignoring.' };
    }

    // 3. Find the Sound Donation Line Item
    const donationItem = order.line_items.find(item => 
      item.title.toLowerCase().includes('sound donation') || item.product_id
    );

    if (!donationItem) {
      return { statusCode: 200, body: 'No sound donation in this order.' };
    }

    // 4. Extract _donation_id
    let donationId = null;
    if (donationItem.properties && donationItem.properties.length > 0) {
      const prop = donationItem.properties.find(p => p.name === '_donation_id');
      if (prop) donationId = prop.value;
    }

    if (!donationId) {
      console.error('No _donation_id found in properties');
      return { statusCode: 400, body: 'Missing _donation_id' };
    }

    // 5. Update Record in Supabase Database
    const { data, error } = await supabase
      .from('donations')
      .update({
        shopify_order_id: order.id.toString(),
        payment_status: 'PAID',
        audio_status: 'PENDING_MODERATION',
        updated_at: new Date()
      })
      .eq('id', donationId);

    if (error) {
      console.error('DB Update Error:', error);
      return { statusCode: 500, body: 'Database Error' };
    }

    return { statusCode: 200, body: 'Webhook processed successfully' };

  } catch (error) {
    console.error('Webhook Error:', error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
