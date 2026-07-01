// routes/subscriptions.js - Paystack subscription management
const express = require("express");
const axios   = require("axios");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
const PS_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PS_BASE   = "https://api.paystack.co";
const PLAN_CODE = process.env.PAYSTACK_PLAN_CODE; // set this in Render env vars

// ── GET /api/subscription/status ─────────────────────────────────────
// Frontend polls this to know if tenant is active/trialing/suspended
router.get("/status", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sub_status, trial_ends_at, sub_renews_at, plan, shop_name, shop_email
       FROM tenants WHERE id = $1`,
      [req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Tenant not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subscription status" });
  }
});

// ── POST /api/subscription/initialize ────────────────────────────────
// Starts a Paystack subscription — returns hosted payment URL
router.post("/initialize", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT shop_email, shop_name FROM tenants WHERE id = $1",
      [req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Tenant not found" });

    const { shop_email, shop_name } = rows[0];

    // Initialize a Paystack transaction tied to the subscription plan
    const response = await axios.post(
      `${PS_BASE}/transaction/initialize`,
      {
        email: shop_email,
        plan: PLAN_CODE,           // recurring plan code from Paystack dashboard
        amount: 0,                  // Paystack uses the plan amount
        currency: "GHS",
        metadata: {
          tenant_id: req.user.tenant_id,
          shop_name,
          cancel_action: `${process.env.FRONTEND_URL}/settings`,
        },
        callback_url: `${process.env.FRONTEND_URL}/subscription-success.html`,
      },
      { headers: { Authorization: `Bearer ${PS_SECRET}` } }
    );

    res.json(response.data.data); // { authorization_url, reference }
  } catch (err) {
    console.error("Sub init error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to initialize subscription" });
  }
});

// ── POST /api/subscription/cancel ────────────────────────────────────
router.post("/cancel", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT paystack_sub_code FROM tenants WHERE id = $1",
      [req.user.tenant_id]
    );
    if (!rows.length || !rows[0].paystack_sub_code) {
      return res.status(400).json({ error: "No active subscription found" });
    }

    await axios.post(
      `${PS_BASE}/subscription/disable`,
      { code: rows[0].paystack_sub_code, token: rows[0].paystack_sub_code },
      { headers: { Authorization: `Bearer ${PS_SECRET}` } }
    );

    await pool.query(
      "UPDATE tenants SET sub_status = 'cancelled' WHERE id = $1",
      [req.user.tenant_id]
    );

    res.json({ success: true, message: "Subscription cancelled" });
  } catch (err) {
    console.error("Cancel error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

// ── POST /api/subscription/webhook ───────────────────────────────────
// Paystack calls this server-to-server on every billing event
// Set this URL in your Paystack dashboard: Settings → Webhooks
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const crypto = require("crypto");

  // Verify the request actually came from Paystack
  const hash = crypto
    .createHmac("sha512", PS_SECRET)
    .update(req.body)
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    console.warn("Webhook signature mismatch — rejected");
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(req.body);
  const { event: eventType, data } = event;

  console.log(`Paystack webhook: ${eventType}`);

  try {
    // Extract tenant_id from metadata if available
    const tenantId = data?.metadata?.tenant_id || null;
    const customerEmail = data?.customer?.email;

    // Log the event for auditing
    await pool.query(
      `INSERT INTO subscription_events (tenant_id, event_type, paystack_ref, payload)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, eventType, data?.reference || null, JSON.stringify(data)]
    );

    // Find tenant by email if we don't have tenant_id in metadata
    let tid = tenantId;
    if (!tid && customerEmail) {
      const { rows } = await pool.query(
        "SELECT id FROM tenants WHERE shop_email = $1",
        [customerEmail.toLowerCase()]
      );
      if (rows.length) tid = rows[0].id;
    }

    if (!tid) {
      console.warn(` Could not find tenant for event ${eventType}`);
      return res.sendStatus(200);
    }

    // ── Handle each event type ────────────────────────────────────────
    switch (eventType) {

      // Payment succeeded — activate the subscription
      case "charge.success":
      case "subscription.create":
        await pool.query(
          `UPDATE tenants SET
             sub_status = 'active',
             sub_start_at = NOW(),
             sub_renews_at = NOW() + INTERVAL '30 days',
             paystack_sub_code = COALESCE($2, paystack_sub_code),
             paystack_customer_code = COALESCE($3, paystack_customer_code)
           WHERE id = $1`,
          [tid, data?.subscription_code || null, data?.customer?.customer_code || null]
        );
        console.log(`Tenant ${tid} activated`);
        break;

      // Renewal succeeded — extend the period
      case "invoice.payment_success":
        await pool.query(
          `UPDATE tenants SET
             sub_status = 'active',
             sub_renews_at = NOW() + INTERVAL '30 days'
           WHERE id = $1`,
          [tid]
        );
        console.log(`🔄 Tenant ${tid} renewed`);
        break;

      // Payment failed — suspend access
      case "invoice.payment_failed":
        await pool.query(
          "UPDATE tenants SET sub_status = 'suspended' WHERE id = $1",
          [tid]
        );
        console.log(`❌ Tenant ${tid} suspended — payment failed`);
        break;

      // Subscription disabled/cancelled
      case "subscription.disable":
      case "subscription.not_renew":
        await pool.query(
          "UPDATE tenants SET sub_status = 'cancelled' WHERE id = $1",
          [tid]
        );
        console.log(`Tenant ${tid} cancelled`);
        break;

      default:
        console.log(`ℹUnhandled event type: ${eventType}`);
    }

  } catch (err) {
    console.error("Webhook processing error:", err);
  }

  // Always respond 200 fast — Paystack retries if we don't
  res.sendStatus(200);
});

module.exports = router;