// ============================================================
// BOLI BACKEND SERVER (Node.js + Express + Dodo Payments + Postgres)
// Compatible with Vercel Serverless & standalone Node deployments
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const DodoPayments = require('dodopayments').default;
const { Webhook } = require('standardwebhooks');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));


// Raw body middleware for webhook verification
app.use((req, res, next) => {
  if (req.path === '/api/webhook' || req.path.endsWith('/webhook')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { req.rawBody = data; next(); });
  } else {
    express.json()(req, res, next);
  }
});

// ── Dodo Payments client ────────────────────────────────────
const dodo = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: process.env.DODO_ENV || 'live_mode',
});

// ── In-memory fallback store (Fresh ₹50 start) ───────────────
const fallbackStore = {
  board: {
    current_price: 0,
    current_leader: 'Nobody yet',
    leader_url: '',
  },
  bids: []
};

// ── Database connection pool (Optional) ─────────────────────
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

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
}));

// ── 1. Health check & Reset ─────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', provider: 'dodo', db: pool ? 'postgres' : 'in-memory', time: new Date().toISOString() });
});

app.get('/api/reset', (req, res) => {
  fallbackStore.board = { current_price: 0, current_leader: 'Nobody yet', leader_url: '' };
  fallbackStore.bids = [];
  res.json({ success: true, message: 'Board reset to starting state' });
});

app.post('/api/reset', (req, res) => {
  fallbackStore.board = { current_price: 0, current_leader: 'Nobody yet', leader_url: '' };
  fallbackStore.bids = [];
  res.json({ success: true, message: 'Board reset to starting state' });
});

// ── 2. GET current board state + recent bids ────────────────
app.get('/api/bids', async (req, res) => {
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

// ── 3. POST /api/order — Create Dodo Checkout Session ───────
app.post('/api/order', async (req, res) => {
  const { companyName, websiteUrl } = req.body;
  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: 'Company name is required.' });
  }

  // Determine next bid price (Starts at ₹50)
  let current = fallbackStore.board.current_price || 0;
  if (pool) {
    try {
      const board = await pool.query('SELECT current_price FROM board WHERE id = 1');
      if (board.rows[0]) current = Number(board.rows[0].current_price);
    } catch (e) {
      console.warn('Could not read price from DB:', e.message);
    }
  }

  let nextPrice = current < 50 ? 50 : current + 1;

  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  const productId = process.env.DODO_PRODUCT_ID;
  const siteUrl = process.env.SITE_URL || 'https://bolii.vercel.app';

  if (!apiKey || !productId) {
    return res.status(500).json({ error: 'Dodo Payments not configured. Set DODO_PAYMENTS_API_KEY and DODO_PRODUCT_ID in environment variables.' });
  }

  try {
    const session = await dodo.checkoutSessions.create({
      product_cart: [{
        product_id: productId,
        quantity: 1,
        amount: nextPrice * 100, // Amount in paise
      }],
      billing_currency: 'INR',
      billing_address: { country: 'IN' },
      payment_link: true,
      return_url: `${siteUrl}/?payment_status=success&company=${encodeURIComponent(companyName.trim())}&url=${encodeURIComponent((websiteUrl || '').trim())}&price=${nextPrice}`,
      metadata: {
        company_name: companyName.trim().slice(0, 64),
        website_url: (websiteUrl || '').trim().slice(0, 255),
        bid_price: String(nextPrice),
      },
    });

    res.json({
      checkout_url: session.checkout_url,
      nextPrice,
    });
  } catch (err) {
    console.error('Dodo checkout session error:', err);
    res.status(500).json({ error: 'Could not create Dodo checkout session. Verify API keys.' });
  }
});

// ── 4. POST /api/webhook — Dodo Payment Webhook ─────────────
app.post('/api/webhook', async (req, res) => {
  const webhookSecret = process.env.DODO_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('DODO_WEBHOOK_SECRET not set — skipping verification');
    return res.status(200).json({ received: true });
  }

  try {
    const wh = new Webhook(webhookSecret);
    const webhookHeaders = {
      'webhook-id': req.headers['webhook-id'] || '',
      'webhook-signature': req.headers['webhook-signature'] || '',
      'webhook-timestamp': req.headers['webhook-timestamp'] || '',
    };

    const payload = wh.verify(req.rawBody, webhookHeaders);
    const event = typeof payload === 'string' ? JSON.parse(payload) : payload;

    if (event.type === 'payment.succeeded') {
      const meta = event.data?.metadata || {};
      const companyName = meta.company_name || 'Unknown';
      const websiteUrl = meta.website_url || '';
      const price = Number(meta.bid_price) || 50;

      fallbackStore.board = { current_price: price, current_leader: companyName, leader_url: websiteUrl };
      fallbackStore.bids.unshift({ company_name: companyName, website_url: websiteUrl, price, created_at: new Date().toISOString() });

      if (pool) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const current = await client.query('SELECT current_price FROM board WHERE id = 1 FOR UPDATE');
          const latestPrice = current.rows[0] ? Number(current.rows[0].current_price) : 0;
          const dbPrice = Math.max(latestPrice < 50 ? 50 : latestPrice + 1, price);

          await client.query(
            `UPDATE board SET current_price=$1, current_leader=$2, leader_url=$3, updated_at=now() WHERE id=1`,
            [dbPrice, companyName, websiteUrl]
          );
          await client.query(
            `INSERT INTO bids (company_name, website_url, price, razorpay_order_id, razorpay_payment_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [companyName, websiteUrl, dbPrice, event.data?.payment_id || 'dodo_pay', event.data?.payment_id || 'dodo_pay']
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('DB write error in webhook:', err);
        } finally {
          client.release();
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    res.status(400).json({ error: 'Webhook verification failed.' });
  }
});

// ── 5. POST /api/verify — Return URL Fallback ────────────────
app.post('/api/verify', async (req, res) => {
  const { companyName, websiteUrl, price } = req.body;
  if (!companyName) return res.status(400).json({ error: 'Missing companyName.' });

  const finalPrice = Math.max(50, price || 50);

  fallbackStore.board = { current_price: finalPrice, current_leader: companyName.trim(), leader_url: (websiteUrl || '').trim() };
  fallbackStore.bids.unshift({
    company_name: companyName.trim(),
    website_url: (websiteUrl || '').trim(),
    price: finalPrice,
    created_at: new Date().toISOString(),
  });

  if (!pool) return res.json({ success: true, price: finalPrice });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT current_price FROM board WHERE id = 1 FOR UPDATE');
    const latestPrice = current.rows[0] ? Number(current.rows[0].current_price) : 0;
    const dbPrice = Math.max(latestPrice < 50 ? 50 : latestPrice + 1, price || 50);

    await client.query(
      `UPDATE board SET current_price=$1, current_leader=$2, leader_url=$3, updated_at=now() WHERE id=1`,
      [dbPrice, companyName.trim(), (websiteUrl || '').trim()]
    );
    await client.query(
      `INSERT INTO bids (company_name, website_url, price, razorpay_order_id, razorpay_payment_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyName.trim(), (websiteUrl || '').trim(), dbPrice, 'dodo_return', 'dodo_return']
    );
    await client.query('COMMIT');
    res.json({ success: true, price: dbPrice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DB write error in verify:', err);
    res.status(500).json({ error: 'Failed to record bid.' });
  } finally {
    client.release();
  }
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Boli server live at http://localhost:${PORT}`);
  });
}

module.exports = app;
