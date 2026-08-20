# ⚡ BOLI — India's Startup Bidding Board

A low-latency, high-performance viral marketing board where founders bid to claim the #1 spot. Every boli raises the price by ₹1, puts their company + website link on the crown, and sends the payment directly to your Indian bank account via Razorpay.

---

## 🚀 10-Minute Launch Guide

### Step 1: Create Free PostgreSQL Database (2 Mins)
1. Go to **[Neon.tech](https://neon.tech)** (Recommended for speed in India: choose `Asia / Singapore` or `AWS Mumbai`).
2. Create a new free project.
3. Open the **SQL Editor** tab.
4. Copy the entire contents of [`schema.sql`](file:///C:/Users/vmidh/.gemini/antigravity/scratch/boli/schema.sql) and paste it into the editor, then click **Run**.
5. Copy your **Database Connection String** (`DATABASE_URL`).

---

### Step 2: Get Your Razorpay Keys (3 Mins)
1. Sign up / log in to **[Razorpay.com](https://razorpay.com)**.
2. Complete your KYC (requires PAN and your Indian Bank Account details for automatic settlements).
3. Go to **Account & Settings > API Keys** → Click **Generate Key**.
4. Save:
   - `RAZORPAY_KEY_ID` (e.g. `rzp_test_...` or `rzp_live_...`)
   - `RAZORPAY_KEY_SECRET`

---

### Step 3: Deploy Live to the Internet (Free)

#### Option A: Render.com (Easiest All-in-One: Frontend + Backend + Payments)
1. Push this folder to your GitHub repository.
2. Go to **[Render.com](https://render.com)** → Click **New + > Web Service**.
3. Connect your GitHub repository.
4. Set:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. In **Environment Variables**, add:
   - `DATABASE_URL` = (your Neon connection string)
   - `RAZORPAY_KEY_ID` = (your Razorpay Key ID)
   - `RAZORPAY_KEY_SECRET` = (your Razorpay Key Secret)
   - `PORT` = `3001`
6. Click **Deploy Web Service**! You'll get an instant live HTTPS link.

---

### Step 4: Connecting Your Custom Domain (e.g., `boli.in`)
When you buy your domain from GoDaddy, Namecheap, or Hostinger:
1. In Render (or Netlify), go to **Settings > Custom Domains** and add your domain (e.g. `boli.in` or `www.boli.in`).
2. Go to your domain registrar's **DNS Management** page and add:
   - **Type**: `CNAME` | **Name**: `www` | **Value**: `your-app-name.onrender.com`
   - **Type**: `A` | **Name**: `@` | **Value**: (Render's provided IP address, e.g., `216.24.57.1`)
3. SSL certificate is generated automatically for free!

---

## 💻 Local Development & Testing

```bash
# 1. Install dependencies
npm install

# 2. Copy .env
cp .env.example .env
# (Fill in your DATABASE_URL and RAZORPAY keys)

# 3. Start server
npm start
```
Open `http://localhost:3001` in your browser!
