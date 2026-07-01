// server.js - Admia SaaS Backend — Multi-tenant Edition
require("dotenv").config();

const express = require("express");
const axios   = require("axios");
const { pool, initSchema } = require("./db");
const { requireAuth, requireAdmin, requireActiveSubscription } = require("./middleware/auth");

const authRoutes   = require("./routes/auth");
const userRoutes   = require("./routes/users");
const productRoutes= require("./routes/products");
const salesRoutes  = require("./routes/sales");
const subRoutes    = require("./routes/subscriptions");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Raw body FIRST for webhook signature verification
app.use("/api/subscription/webhook", express.raw({ type: "application/json" }));

// JSON for everything else
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── HEALTH ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "Admia SaaS", timestamp: new Date().toISOString() });
});

// ── ROUTES ────────────────────────────────────────────────────────────
app.use("/api/auth",         authRoutes);
app.use("/api/users",        userRoutes);
app.use("/api/products",     productRoutes);
app.use("/api/sales",        salesRoutes);
app.use("/api/subscription", subRoutes);

// ── SETTINGS (per-tenant, inline) ────────────────────────────────────
const guard = [requireAuth, requireActiveSubscription];

app.get("/api/settings", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT shop_name, shop_email, shop_phone, shop_address, sub_status, trial_ends_at, plan FROM tenants WHERE id=$1",
      [req.user.tenant_id]
    );
    res.json(rows[0] || {});
  } catch { res.status(500).json({ error: "Failed to fetch settings" }); }
});

app.put("/api/settings", [...guard, requireAdmin], async (req, res) => {
  const { shop_name, shop_email, shop_phone, shop_address } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET shop_name=$1, shop_email=$2, shop_phone=$3, shop_address=$4
       WHERE id=$5 RETURNING shop_name, shop_email, shop_phone, shop_address`,
      [shop_name, shop_email, shop_phone, shop_address, req.user.tenant_id]
    );
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to save settings" }); }
});

// ── PAYSTACK PAYMENT (for in-app Ecash sales) ─────────────────────────
const PS_SECRET = process.env.PAYSTACK_SECRET_KEY;

app.post("/api/payments/initialize", guard, async (req, res) => {
  const { email, amount_ghs, cart_meta } = req.body;
  if (!email || !amount_ghs) return res.status(400).json({ error: "Email and amount required" });
  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      { email, amount: Math.round(parseFloat(amount_ghs) * 100), currency: "GHS", metadata: { cart_meta, operator: req.user.fullname } },
      { headers: { Authorization: `Bearer ${PS_SECRET}` } }
    );
    res.json(response.data.data);
  } catch (err) {
    console.error("Paystack init error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

app.get("/api/payments/verify/:reference", guard, async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${req.params.reference}`,
      { headers: { Authorization: `Bearer ${PS_SECRET}` } }
    );
    const data = response.data.data;
    if (data.status !== "success") return res.status(400).json({ error: "Payment not successful" });
    res.json({ verified: true, reference: data.reference, amount_ghs: data.amount / 100, channel: data.channel });
  } catch (err) {
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// ── ERROR HANDLERS ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ── BOOT ──────────────────────────────────────────────────────────────
async function start() {
  try {
    await pool.query("SELECT 1");
    console.log("Database connected");
    await initSchema();
    app.listen(PORT, () => {
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  Admia SaaS — Multi-tenant Online");
      console.log(`  Port: ${PORT} | ${process.env.NODE_ENV || "development"}`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });
  } catch (err) {
    console.error("❌ Boot failed:", err.message);
    process.exit(1);
  }
}

start();