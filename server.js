// server.js - Admia SaaS Backend Entry Point
// Godspeed Innovations Group
require("dotenv").config();

const express = require("express");
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
//  CORS — manual headers, no library needed
//  JWT auth protects routes so open CORS is safe here
// ============================================================
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  // Preflight — respond immediately, do NOT continue to routes
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
//  HEALTH CHECK
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
//  SETTINGS ROUTES
// ============================================================
app.get("/api/settings", requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM settings LIMIT 1");
    res.json(rows[0] || {});
  } catch {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

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
//  PAYSTACK ROUTES
// ============================================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "https://api.paystack.co";

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
        amount: Math.round(parseFloat(amount_ghs) * 100),
        currency: "GHS",
        metadata: { cart_meta, operator: req.user.fullname, user_id: req.user.id },
        callback_url: `${process.env.FRONTEND_URL || ""}`,
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" } }
    );
    res.json(response.data.data);
  } catch (err) {
    console.error("Paystack init error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

app.get("/api/payments/verify/:reference", requireAuth, async (req, res) => {
  const { reference } = req.params;
  try {
    const response = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    const data = response.data.data;
    if (data.status !== "success") {
      return res.status(400).json({ error: "Payment not successful", status: data.status });
    }
    res.json({
      verified: true,
      reference: data.reference,
      amount_ghs: data.amount / 100,
      channel: data.channel,
      customer: data.customer,
    });
  } catch (err) {
    console.error("Paystack verify error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const crypto = require("crypto");
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(req.body).digest("hex");
  if (hash !== req.headers["x-paystack-signature"]) return res.status(401).send("Invalid signature");
  const event = JSON.parse(req.body);
  if (event.event === "charge.success") {
    console.log(`Webhook: Payment confirmed — ref: ${event.data.reference}`);
  }
  res.sendStatus(200);
});

// ============================================================
//  ERROR HANDLERS
// ============================================================
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ============================================================
//  BOOT
// ============================================================
async function start() {
  try {
    await pool.query("SELECT 1");
    console.log("Database connection established");
    await initSchema();
    app.listen(PORT, () => {
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  Admia SaaS Backend — Node Engine Online");
      console.log(`  Port: ${PORT} | Env: ${process.env.NODE_ENV || "development"}`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  }
}

start();