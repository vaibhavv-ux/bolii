# ⚡ BOLI — India's Startup Bidding Board

A low-latency, high-performance viral marketing board where founders bid to claim the #1 spot. Every boli raises the price by ₹1, puts their company + website link on the crown, and sends the payment directly to your Indian bank account via Razorpay.

---

## 🚀 Launch Guide

### 1. Configure Environment Variables
In your hosting dashboard (Netlify / Vercel / Render), set:
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `DATABASE_URL` (optional, for persistent PostgreSQL)

### 2. Local Development
```bash
npm install
npm start
```
Open `http://localhost:3001` in your browser.
