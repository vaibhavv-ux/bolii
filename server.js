// ============================================================
// BOLI BACKEND SERVER (Node.js + Express + Razorpay + Postgres)
// Ultra-fast, Indian latency optimized & production ready
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const Razorpay = require('razorpay');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// Performance & Security Middlewares
app.use(cors());
app.use(express.json());

// Database connection pool with SSL support for Neon/Supabase/Railway
const isLocalDb = (process.env.DATABASE_URL || '').includes('localhost') || (process.env.DATABASE_URL || '').includes('127.0.0.1');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: 20, // Connection pool size for handling concurrent spikes
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Razorpay SDK Instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder',
});

// Serve frontend static assets with cache headers
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
}));

// --- 1. Health check endpoint ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- 2. GET current board state + recent bids (Fast Read) ---
app.get('/api/bids', async (req, res) => {
  try {
    const board = await pool.query(
      'SELECT current_price, current_leader, leader_url, leader_tagline FROM board WHERE id = 1 LIMIT 1'
    );
    const bids = await pool.query(
      'SELECT company_name, website_url, tagline, price, created_at FROM bids ORDER BY created_at DESC LIMIT 50'
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      board: board.rows[0] || { current_price: 1, current_leader: 'Nobody yet', leader_url: '', leader_tagline: '' },
      bids: bids.rows || [],
    });
  } catch (err) {
    console.error('Error fetching board state:', err.message);
    res.status(500).json({ error: 'Could not load board data' });
  }
});

// --- 3. POST /api/order — Create Razorpay order for current price + 1 ---
app.post('/api/order', async (req, res) => {
  const { companyName, websiteUrl, tagline } = req.body;
  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: 'Company name is required.' });
  }

  try {
    const board = await pool.query('SELECT current_price FROM board WHERE id = 1');
    const currentPrice = board.rows[0] ? board.rows[0].current_price : 0;
    const nextPrice = currentPrice + 1;

    // Razorpay amounts are in paise (₹1 = 100 paise)
    const order = await razorpay.orders.create({
      amount: nextPrice * 100,
      currency: 'INR',
      receipt: `boli_${Date.now()}`,
      notes: {
        companyName: companyName.trim().slice(0, 32),
        websiteUrl: (websiteUrl || '').trim().slice(0, 255),
        tagline: (tagline || '').trim().slice(0, 60),
      },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      keyId: process.env.RAZORPAY_KEY_ID,
      nextPrice,
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    res.status(500).json({ error: 'Could not create payment order with Razorpay. Verify your API keys.' });
  }
});

// --- 4. POST /api/verify — Verify signature & atomically record the new king ---
app.post('/api/verify', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    companyName,
    websiteUrl,
    tagline,
    price,
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment signature details.' });
  }

  // Verify HMAC SHA256 signature
  const body = razorpay_order_id + '|' + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(body)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch current state under row lock
    const current = await client.query('SELECT current_price FROM board WHERE id = 1 FOR UPDATE');
    const latestPrice = current.rows[0] ? current.rows[0].current_price : 0;
    const finalPrice = Math.max(latestPrice + 1, price);

    // Atomically bump the crown
    await client.query(
      `UPDATE board
       SET current_price = $1,
           current_leader = $2,
           leader_url = $3,
           leader_tagline = $4,
           updated_at = now()
       WHERE id = 1`,
      [finalPrice, companyName.trim(), (websiteUrl || '').trim(), (tagline || '').trim()]
    );

    // Insert into permanent ledger
    await client.query(
      `INSERT INTO bids (company_name, website_url, tagline, price, razorpay_order_id, razorpay_payment_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        companyName.trim(),
        (websiteUrl || '').trim(),
        (tagline || '').trim(),
        finalPrice,
        razorpay_order_id,
        razorpay_payment_id,
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, price: finalPrice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Database transaction error:', err);
    res.status(500).json({ error: 'Failed to record bid on the board.' });
  } finally {
    client.release();
  }
});

// Fallback to index.html for single-origin deployment
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Boli server running on port ${PORT}`);
});
