-- ============================================================
-- BOLI DATABASE SCHEMA (PostgreSQL)
-- Fresh production state (Bidding starts at ₹1)
-- ============================================================

-- 1. Single-row board table for atomic leaderboard state
CREATE TABLE IF NOT EXISTS board (
  id INTEGER PRIMARY KEY DEFAULT 1,
  current_price INTEGER NOT NULL DEFAULT 0,
  current_leader TEXT NOT NULL DEFAULT 'Nobody yet',
  leader_url TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Seed initial blank row (Starts at ₹0, so first Boli is ₹1)
INSERT INTO board (id, current_price, current_leader, leader_url)
VALUES (1, 0, 'Nobody yet', '')
ON CONFLICT (id) DO UPDATE SET current_price = 0, current_leader = 'Nobody yet', leader_url = '';

-- 2. Bids history table (permanent ledger)
CREATE TABLE IF NOT EXISTS bids (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  website_url TEXT DEFAULT '',
  price INTEGER NOT NULL,
  razorpay_order_id TEXT NOT NULL,
  razorpay_payment_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for instant low-latency reads
CREATE INDEX IF NOT EXISTS idx_bids_created_at ON bids (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bids_price ON bids (price DESC);
