-- ============================================================
-- BOLI DATABASE SCHEMA (PostgreSQL)
-- Run this in your Supabase / Neon / Render SQL Editor
-- ============================================================

-- 1. Single-row board table for atomic leaderboard state
CREATE TABLE IF NOT EXISTS board (
  id INTEGER PRIMARY KEY DEFAULT 1,
  current_price INTEGER NOT NULL DEFAULT 1,
  current_leader TEXT NOT NULL DEFAULT 'Nobody yet',
  leader_url TEXT DEFAULT '',
  leader_tagline TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Seed initial row if not already present
INSERT INTO board (id, current_price, current_leader, leader_url, leader_tagline)
VALUES (1, 1, 'Nobody yet', '', 'First boli claims the throne')
ON CONFLICT (id) DO NOTHING;

-- 2. Bids history table (all completed bids)
CREATE TABLE IF NOT EXISTS bids (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  website_url TEXT DEFAULT '',
  tagline TEXT DEFAULT '',
  price INTEGER NOT NULL,
  razorpay_order_id TEXT NOT NULL,
  razorpay_payment_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for instant low-latency reads on leaderboard
CREATE INDEX IF NOT EXISTS idx_bids_created_at ON bids (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bids_price ON bids (price DESC);
