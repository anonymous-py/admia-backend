// server.js - Admia SaaS Backend Entry Point
// Godspeed Innovations Group
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { pool, initSchema } = require("./db");
const { requireAuth, requireAdmin } = require("./middleware/auth");

// Route modules
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const productRoutes = require("./routes/products");
const salesRoutes = require("./routes/sales");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  MIDDLEWARE STACK
// ============================================================
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "5mb" })); // 5mb covers bulk Excel imports
app.use(express.urlencoded({ extended: true }));

// Request logger (lightweight - no external dependency)
app.use((req, _res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
//  HEALTH CHECK (Render pings this to keep the service alive)
// ============================================================
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Admia SaaS Backend",
    company: "Godspeed Innovations Group",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
//  API ROUTES
// ============================================================
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/products", productRoutes);
app.use("/api/sales", salesRoutes);

// ============================================================
//  SETTINGS ROUTES (inline - simple enough not to need a file)
// ============================================================

// GET /api/settings
app.get("/api/settings", requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM settings LIMIT 1");
    res.json(rows[0] || {});
  } catch {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// PUT /api/settings (admin only)
app.put("/api/settings", requireAuth, requireAdmin, async (req, res) => {
  const { shop_name, shop_email, shop_phone, shop_address } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE settings
       SET shop_name=$1, shop_email=$2, shop_phone=$3, shop_address=$4, updated_at=NOW()
       WHERE id=(SELECT id FROM settings LIMIT 1)
       RETURNING *`,
      [shop_name, shop_email, shop_phone, shop_address]
    );
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// ============================================================
//  PAYSTACK PAYMENT ROUTES
// ============================================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "https://api.paystack.co";

// POST /api/payments/initialize
// Called when customer wants to pay via Ecash (MoMo / card)
// Body: { email, amount_ghs, cart_meta }
app.post("/api/payments/initialize", requireAuth, async (req, res) => {
  const { email, amount_ghs, cart_meta } = req.body;

  if (!email || !amount_ghs) {
    return res.status(400).json({ error: "Email and amount required" });
  }

  try {
    const response = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email,
        // Paystack expects amount in pesewas (GHS × 100)
        amount: Math.round(parseFloat(amount_ghs) * 100),
        currency: "GHS",
        metadata: {
          cart_meta,
          operator: req.user.fullname,
          user_id: req.user.id,
        },
        // Where Paystack redirects after payment
        callback_url: `${process.env.FRONTEND_URL}/payment-callback.html`,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Returns { authorization_url, access_code, reference }
    res.json(response.data.data);
  } catch (err) {
    console.error("Paystack init error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

// GET /api/payments/verify/:reference
// Called after Paystack redirects the customer back to confirm payment succeeded
app.get("/api/payments/verify/:reference", requireAuth, async (req, res) => {
  const { reference } = req.params;

  try {
    const response = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      }
    );

    const data = response.data.data;

    if (data.status !== "success") {
      return res.status(400).json({ error: "Payment not successful", status: data.status });
    }

    res.json({
      verified: true,
      reference: data.reference,
      amount_ghs: data.amount / 100,
      channel: data.channel,       // mobile_money, card, bank
      customer: data.customer,
    });
  } catch (err) {
    console.error("Paystack verify error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// POST /api/payments/webhook
// Paystack sends payment events here server-to-server (set this URL in your Paystack dashboard)
// This is the secure backup — it fires even if the customer closes the browser
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const crypto = require("crypto");
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET)
    .update(req.body)
    .digest("hex");

  // Reject requests that didn't come from Paystack
  if (hash !== req.headers["x-paystack-signature"]) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(req.body);

  if (event.event === "charge.success") {
    const { reference, metadata } = event.data;
    console.log(`✅ Webhook: Payment confirmed — ref: ${reference}`);
    // If you want to auto-finalize sales from webhooks, add logic here.
    // For now the frontend verify route handles this flow.
  }

  res.sendStatus(200); // Always respond 200 fast so Paystack doesn't retry
});

// ============================================================
//  GLOBAL ERROR HANDLER
// ============================================================
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ============================================================
//  BOOT SEQUENCE
// ============================================================
async function start() {
  try {
    // 1. Verify database connection
    await pool.query("SELECT 1");
    console.log("Database connection established");

    // 2. Run schema migrations (safe - uses IF NOT EXISTS)
    await initSchema();

    // 3. Start HTTP server
    app.listen(PORT, () => {
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  Admia SaaS Backend — Node Engine Online");
      console.log(`  Godspeed Innovations Group`);
      console.log(`  Port   : ${PORT}`);
      console.log(`  Env    : ${process.env.NODE_ENV || "development"}`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();