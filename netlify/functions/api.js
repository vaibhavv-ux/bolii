// ============================================================
// BOLI NETLIFY SERVERLESS FUNCTION
// Dodo Payments Checkout Sessions + Leaderboard
// ============================================================

const express    = require('express');
const serverless = require('serverless-http');
const cors       = require('cors');
const { Pool }   = require('pg');
const DodoPayments = require('dodopayments').default;
const { Webhook } = require('standardwebhooks');

const app = express();
app.use(cors());

// Raw body needed for webhook signature verification — must be before express.json()
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path.endsWith('/webhook')) {
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

// ── In-memory fallback store ────────────────────────────────
const fallbackStore = {
  board: { current_price: 0, current_leader: 'Nobody yet', leader_url: '' },
  bids: [],
};

// ── Database connection pool ────────────────────────────────
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 4000,
  });
}

const router = express.Router();

// ── 1. Health check ─────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', provider: 'dodo', time: new Date().toISOString() });
});

// ── 2. GET current board + recent bids ──────────────────────
router.get('/bids', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (!pool) {
    return res.json({ board: fallbackStore.board, bids: fallbackStore.bids });
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
      bids:  bids.rows  || [],
    });
  } catch (err) {
    console.warn('DB read fallback:', err.message);
    res.json({ board: fallbackStore.board, bids: fallbackStore.bids });
  }
});

// ── 3. POST /order — Create Dodo Checkout Session ───────────
router.post('/order', async (req, res) => {
  const { companyName, websiteUrl } = req.body;

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: 'Company name is required.' });
  }

  // Determine next bid price (minimum starts at ₹50)
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

  const apiKey    = process.env.DODO_PAYMENTS_API_KEY;
  const productId = process.env.DODO_PRODUCT_ID;
  const siteUrl   = process.env.SITE_URL || 'https://bolii.netlify.app';

  if (!apiKey || !productId) {
    return res.status(500).json({ error: 'Dodo Payments not configured. Set DODO_PAYMENTS_API_KEY and DODO_PRODUCT_ID in Netlify env vars.' });
  }

  try {
    const session = await dodo.checkoutSessions.create({
      product_cart: [{
        product_id: productId,
        quantity:   1,
        amount:     nextPrice * 100,  // Dodo uses smallest currency unit (paise)
      }],
      // Without this, Dodo falls back to the product's stored currency (USD),
      // which puts every bid behind the $0.50 USD card floor instead of the
      // much lower ₹1 UPI floor. This forces INR + India billing explicitly.
      billing_currency: 'INR',
      billing_address: { country: 'IN' },
      payment_link: true,
      return_url:   `${siteUrl}/?payment_status=success&company=${encodeURIComponent(companyName.trim())}&url=${encodeURIComponent((websiteUrl || '').trim())}&price=${nextPrice}`,
      metadata: {
        company_name: companyName.trim().slice(0, 64),
        website_url:  (websiteUrl || '').trim().slice(0, 255),
        bid_price:    String(nextPrice),
      },
    });

    res.json({
      checkout_url: session.checkout_url,
      nextPrice,
    });
  } catch (err) {
    console.error('Dodo checkout session error:', err);
    res.status(500).json({ error: 'Could not create Dodo checkout session. Check your API key and product ID.' });
  }
});

// ── 4. POST /webhook — Dodo payment webhook ─────────────────
router.post('/webhook', async (req, res) => {
  const webhookSecret = process.env.DODO_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('DODO_WEBHOOK_SECRET not set — skipping verification');
    return res.status(200).json({ received: true });
  }

  try {
    const wh = new Webhook(webhookSecret);
    const webhookHeaders = {
      'webhook-id':        req.headers['webhook-id']        || '',
      'webhook-signature': req.headers['webhook-signature'] || '',
      'webhook-timestamp': req.headers['webhook-timestamp'] || '',
    };

    const payload = wh.verify(req.rawBody, webhookHeaders);
    const event   = typeof payload === 'string' ? JSON.parse(payload) : payload;

    if (event.type === 'payment.succeeded') {
      const meta        = event.data?.metadata || {};
      const companyName = meta.company_name || 'Unknown';
      const websiteUrl  = meta.website_url  || '';
      const price       = Number(meta.bid_price) || 50;

      // Update in-memory store
      fallbackStore.board = { current_price: price, current_leader: companyName, leader_url: websiteUrl };
      fallbackStore.bids.unshift({ company_name: companyName, website_url: websiteUrl, price, created_at: new Date().toISOString() });

      // Persist to DB if available
      if (pool) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const current   = await client.query('SELECT current_price FROM board WHERE id = 1 FOR UPDATE');
          const latestPrice = current.rows[0] ? Number(current.rows[0].current_price) : 0;
          const dbPrice   = Math.max(latestPrice + 1, price);

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

// ── 5. POST /verify — Fallback after return-URL redirect ────
// Called by the frontend when it detects ?payment_status=success in the URL.
// The webhook is the authoritative source; this is a belt-and-suspenders update.
router.post('/verify', async (req, res) => {
  const { companyName, websiteUrl, price } = req.body;

  if (!companyName) return res.status(400).json({ error: 'Missing companyName.' });

  const finalPrice = Math.max(50, price || 50);

  fallbackStore.board = { current_price: finalPrice, current_leader: companyName.trim(), leader_url: (websiteUrl || '').trim() };
  fallbackStore.bids.unshift({
    company_name: companyName.trim(),
    website_url:  (websiteUrl || '').trim(),
    price:        finalPrice,
    created_at:   new Date().toISOString(),
  });

  if (!pool) return res.json({ success: true, price: finalPrice });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current     = await client.query('SELECT current_price FROM board WHERE id = 1 FOR UPDATE');
    const latestPrice = current.rows[0] ? Number(current.rows[0].current_price) : 0;
    const dbPrice     = Math.max(latestPrice < 50 ? 50 : latestPrice + 1, price || 50);

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

// Mount routes
app.use('/api', router);
app.use('/.netlify/functions/api', router);
app.use('/', router);

module.exports.handler = serverless(app);
