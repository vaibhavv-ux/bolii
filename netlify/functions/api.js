// ============================================================
// BOLI NETLIFY SERVERLESS FUNCTION
// Powers Razorpay & Leaderboard directly on Netlify Edge
// ============================================================

const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory fallback store
const fallbackStore = {
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
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 4000,
  });
}

// Razorpay SDK Instance (Loads securely from Netlify Environment Variables)
const getRazorpay = () => {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

const router = express.Router();

// --- 1. Health check ---
router.get('/health', (req, res) => {
  res.json({ status: 'ok', serverless: true, time: new Date().toISOString() });
});

// --- 2. GET current board state + recent bids ---
router.get('/bids', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!pool) {
    return res.json({
      board: fallbackStore.board,
      bids: fallbackStore.bids,
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
      board: board.rows[0] || fallbackStore.board,
      bids: bids.rows || [],
    });
  } catch (err) {
    console.warn('DB read fallback:', err.message);
    res.json({
      board: fallbackStore.board,
      bids: fallbackStore.bids,
    });
  }
});

// --- 3. POST /order — Create Razorpay order for current price + 1 ---
router.post('/order', async (req, res) => {
  const { companyName, websiteUrl } = req.body;
  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: 'Company name is required.' });
  }

  let nextPrice = (fallbackStore.board.current_price || 0) + 1;

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

  nextPrice = Math.max(1, nextPrice);

  const keyId = process.env.RAZORPAY_KEY_ID;
  if (!keyId || !process.env.RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Razorpay keys not configured in Netlify Environment Variables.' });
  }

  try {
    const razorpay = getRazorpay();
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
      keyId: keyId,
      nextPrice,
    });
  } catch (err) {
    console.error('Razorpay order creation error:', err);
    res.status(500).json({ error: 'Could not create payment order with Razorpay. Verify API keys.' });
  }
});

// --- 4. POST /verify — Verify signature & record new leader ---
router.post('/verify', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    companyName,
    websiteUrl,
    price,
  } = req.body;

  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (keySecret) {
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed.' });
    }
  }

  const finalPrice = Math.max((fallbackStore.board.current_price || 0) + 1, price || 1);
  fallbackStore.board = {
    current_price: finalPrice,
    current_leader: companyName.trim(),
    leader_url: (websiteUrl || '').trim(),
  };
  fallbackStore.bids.unshift({
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

// Mount routes under both /api and /
app.use('/api', router);
app.use('/.netlify/functions/api', router);
app.use('/', router);

module.exports.handler = serverless(app);
