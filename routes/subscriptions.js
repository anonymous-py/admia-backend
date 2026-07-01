// routes/subscriptions.js
const express = require("express");
const axios   = require("axios");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
const PS_SECRET  = process.env.PAYSTACK_SECRET_KEY;
const PS_BASE    = "https://api.paystack.co";
const PLAN_CODE  = process.env.PAYSTACK_PLAN_CODE; // PLN_xxxx from Paystack dashboard
const SUB_AMOUNT = 5000; // GHS 50 in pesewas (50 × 100)

// GET /api/subscription/status
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

// POST /api/subscription/initialize
// Two modes:
//   - If PAYSTACK_PLAN_CODE is set in env: creates a recurring subscription
//   - If not set: creates a one-time charge (still works, just not auto-recurring)
router.post("/initialize", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT shop_email, shop_name FROM tenants WHERE id = $1",
      [req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Tenant not found" });

    const { shop_email, shop_name } = rows[0];

    // Build the payload — plan code makes it recurring, amount is fallback
    const payload = {
      email: shop_email,
      amount: SUB_AMOUNT,
      currency: "GHS",
      metadata: {
        tenant_id: req.user.tenant_id,
        shop_name,
        custom_fields: [
          { display_name: "Shop", variable_name: "shop_name", value: shop_name }
        ]
      },
      callback_url: `${process.env.FRONTEND_URL || ""}`,
    };

    // Only attach plan if the env var is actually set
    if (PLAN_CODE && PLAN_CODE.startsWith("PLN_")) {
      payload.plan = PLAN_CODE;
    }

    console.log(`Initializing subscription for tenant ${req.user.tenant_id} (${shop_email})`);

    const response = await axios.post(
      `${PS_BASE}/transaction/initialize`,
      payload,
      { headers: { Authorization: `Bearer ${PS_SECRET}`, "Content-Type": "application/json" } }
    );

    res.json(response.data.data); // { authorization_url, reference, access_code }
  } catch (err) {
    const psErr = err?.response?.data;
    console.error("Paystack subscription init error:", psErr || err.message);

    // Send back a meaningful error message
    const message = psErr?.message || err.message || "Payment initialization failed";
    res.status(500).json({ error: message });
  }
});

// POST /api/subscription/verify/:reference
// Called after Paystack redirects back — verifies payment and activates tenant
router.get("/verify/:reference", requireAuth, async (req, res) => {
  try {
    const response = await axios.get(
      `${PS_BASE}/transaction/verify/${req.params.reference}`,
      { headers: { Authorization: `Bearer ${PS_SECRET}` } }
    );
    const data = response.data.data;

    if (data.status !== "success") {
      return res.status(400).json({ error: "Payment not successful", status: data.status });
    }

    // Activate the tenant
    await pool.query(
      `UPDATE tenants SET
         sub_status = 'active',
         sub_start_at = NOW(),
         sub_renews_at = NOW() + INTERVAL '30 days'
       WHERE id = $1`,
      [req.user.tenant_id]
    );

    res.json({ verified: true, amount_ghs: data.amount / 100 });
  } catch (err) {
    console.error("Verify error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

// POST /api/subscription/cancel
router.post("/cancel", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT paystack_sub_code FROM tenants WHERE id = $1",
      [req.user.tenant_id]
    );

    if (rows[0]?.paystack_sub_code) {
      await axios.post(
        `${PS_BASE}/subscription/disable`,
        { code: rows[0].paystack_sub_code, token: rows[0].paystack_sub_code },
        { headers: { Authorization: `Bearer ${PS_SECRET}` } }
      ).catch(() => {}); // Don't fail if Paystack call fails
    }

    await pool.query(
      "UPDATE tenants SET sub_status = 'cancelled' WHERE id = $1",
      [req.user.tenant_id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel" });
  }
});

// POST /api/subscription/webhook
// Paystack calls this on every billing event — set in Paystack dashboard
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const crypto = require("crypto");
  const hash = crypto
    .createHmac("sha512", PS_SECRET)
    .update(req.body)
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(req.body);
  const { event: eventType, data } = event;
  console.log(`Webhook received: ${eventType}`);

  try {
    const customerEmail = data?.customer?.email;
    let tid = data?.metadata?.tenant_id || null;

    // Log event
    await pool.query(
      `INSERT INTO subscription_events (tenant_id, event_type, paystack_ref, payload)
       VALUES ($1, $2, $3, $4)`,
      [tid, eventType, data?.reference || null, JSON.stringify(data)]
    );

    // Find tenant by email if no tenant_id in metadata
    if (!tid && customerEmail) {
      const { rows } = await pool.query(
        "SELECT id FROM tenants WHERE shop_email = $1",
        [customerEmail.toLowerCase()]
      );
      if (rows.length) tid = rows[0].id;
    }

    if (!tid) { console.warn(`No tenant found for ${eventType}`); return res.sendStatus(200); }

    switch (eventType) {
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

      case "invoice.payment_success":
        await pool.query(
          `UPDATE tenants SET sub_status = 'active', sub_renews_at = NOW() + INTERVAL '30 days' WHERE id = $1`,
          [tid]
        );
        break;

      case "invoice.payment_failed":
        await pool.query("UPDATE tenants SET sub_status = 'suspended' WHERE id = $1", [tid]);
        break;

      case "subscription.disable":
      case "subscription.not_renew":
        await pool.query("UPDATE tenants SET sub_status = 'cancelled' WHERE id = $1", [tid]);
        break;
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  res.sendStatus(200);
});

module.exports = router;