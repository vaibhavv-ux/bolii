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

// Fresh brand-new initial store (Starts at ₹0, next boli is ₹1)
const demoStore = {
  board: {
    current_price: 0,
    current_leader: 'Nobody yet',
    leader_url: '',
  },
  bids: []
};

// Database connection pool
let pool = null;
if (process.env.DATABASE_URL) {
  const isLocalDb = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocalDb ? false : { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

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
  res.json({ status: 'ok', db: pool ? 'postgres' : 'in-memory', time: new Date().toISOString() });
});

// --- 2. GET current board state + recent bids ---
app.get('/api/bids', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!pool) {
    return res.json({
      board: demoStore.board,
      bids: demoStore.bids,
    });
  }

  try {
    const board = await pool.query(
      'SELECT current_price, current_leader, leader_url FROM board WHERE id = 1 LIMIT 1'
    );
    const bids = await pool.query(
      'SELECT company_name, website_url, price, created_at FROM bids ORDER BY created_at DESC LIMIT 50'
    );

    res.json({
      board: board.rows[0] || demoStore.board,
      bids: bids.rows || [],
    });
  } catch (err) {
    console.warn('DB read fallback:', err.message);
    res.json({
      board: demoStore.board,
      bids: demoStore.bids,
    });
  }
});

// --- 3. POST /api/order — Create Razorpay order for current price + 1 ---
app.post('/api/order', async (req, res) => {
  const { companyName, websiteUrl } = req.body;
  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: 'Company name is required.' });
  }

  let nextPrice = (demoStore.board.current_price || 0) + 1;

  if (pool) {
    try {
      const board = await pool.query('SELECT current_price FROM board WHERE id = 1');
      if (board.rows[0]) {
        nextPrice = Number(board.rows[0].current_price) + 1;
      }
    } catch (e) {
      console.warn('Could not read price from DB:', e.message);
    }
  }

  // Ensure minimum bid is at least ₹1
  nextPrice = Math.max(1, nextPrice);

  // If Razorpay keys are placeholders, handle simulation for instant local testing
  if (!process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET === 'secret_placeholder') {
    return res.json({
      orderId: `order_demo_${Date.now()}`,
      amount: nextPrice * 100,
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
      nextPrice,
      isDemo: true,
    });
  }

  try {
    const order = await razorpay.orders.create({
      amount: nextPrice * 100,
      currency: 'INR',
      receipt: `boli_${Date.now()}`,
      notes: {
        companyName: companyName.trim().slice(0, 32),
        websiteUrl: (websiteUrl || '').trim().slice(0, 255),
      },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      keyId: process.env.RAZORPAY_KEY_ID,
      nextPrice,
    });
  } catch (err) {
    console.error('Razorpay order creation error:', err);
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
    price,
  } = req.body;

  // Verify HMAC signature in production mode
  if (process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_KEY_SECRET !== 'secret_placeholder') {
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed.' });
    }
  }

  // Update in memory fallback
  const finalPrice = Math.max((demoStore.board.current_price || 0) + 1, price || 1);
  demoStore.board = {
    current_price: finalPrice,
    current_leader: companyName.trim(),
    leader_url: (websiteUrl || '').trim(),
  };
  demoStore.bids.unshift({
    company_name: companyName.trim(),
    website_url: (websiteUrl || '').trim(),
    price: finalPrice,
    created_at: new Date().toISOString(),
  });

  if (!pool) {
    return res.json({ success: true, price: finalPrice });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT current_price FROM board WHERE id = 1 FOR UPDATE');
    const latestPrice = current.rows[0] ? Number(current.rows[0].current_price) : 0;
    const dbPrice = Math.max(latestPrice + 1, price || 1);

    await client.query(
      `UPDATE board
       SET current_price = $1,
           current_leader = $2,
           leader_url = $3,
           updated_at = now()
       WHERE id = 1`,
      [dbPrice, companyName.trim(), (websiteUrl || '').trim()]
    );

    await client.query(
      `INSERT INTO bids (company_name, website_url, price, razorpay_order_id, razorpay_payment_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        companyName.trim(),
        (websiteUrl || '').trim(),
        dbPrice,
        razorpay_order_id || 'order_paid',
        razorpay_payment_id || 'pay_confirmed',
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, price: dbPrice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Database write error:', err);
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
  console.log(`🚀 Boli server live at http://localhost:${PORT}`);
});
