const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event, context) => {
  // CORS setup for Admin Panel if hosted elsewhere
  const headers = {
    'Access-Control-Allow-Origin': '*', // Update to match your admin panel domain in production
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: 'OK' };
  }

  // Basic Authorization (Replace with proper JWT or session verification)
  const authHeader = event.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return { statusCode: 401, headers, body: 'Unauthorized' };
  }

  try {
    const pathParts = event.path.split('/');
    const action = pathParts[pathParts.length - 1]; // e.g. 'approve' or 'reject'
    const id = pathParts[pathParts.length - 2];     // e.g. 'uuid-of-donation'

    if (event.httpMethod === 'GET') {
      // List pending donations
      const { data, error } = await supabase
        .from('donations')
        .select('*')
        .eq('audio_status', 'PENDING_MODERATION')
        .order('created_at', { ascending: true });

      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'POST') {
      if (action !== 'approve' && action !== 'reject') {
        return { statusCode: 400, headers, body: 'Invalid action' };
      }

      const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';

      const { data, error } = await supabase
        .from('donations')
        .update({ audio_status: newStatus, updated_at: new Date() })
        .eq('id', id)
        .select();

      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 404, headers, body: 'Not found' };
  } catch (error) {
    console.error('Admin API Error:', error);
    return { statusCode: 500, headers, body: 'Internal Server Error' };
  }
};
