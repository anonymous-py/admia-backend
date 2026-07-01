// middleware/auth.js - JWT verification + subscription gate + role guard
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

// ── 1. Verify JWT token ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
    req.user = decoded; // { id, username, role, fullname, tenant_id }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── 2. Check tenant subscription is active ────────────────────────────
// Runs after requireAuth. Blocks suspended/cancelled tenants.
async function requireActiveSubscription(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT sub_status, trial_ends_at FROM tenants WHERE id = $1",
      [req.user.tenant_id]
    );

    if (!rows.length) {
      return res.status(403).json({ error: "Tenant not found" });
    }

    const { sub_status, trial_ends_at } = rows[0];

    // Allow active subscriptions
    if (sub_status === "active") return next();

    // Allow trials that haven't expired yet
    if (sub_status === "trialing" && new Date(trial_ends_at) > new Date()) {
      return next();
    }

    // Trial expired or subscription suspended/cancelled
    return res.status(402).json({
      error: "subscription_required",
      message: sub_status === "trialing"
        ? "Your free trial has ended. Please subscribe to continue."
        : "Your subscription is inactive. Please renew to continue.",
      sub_status,
    });
  } catch (err) {
    console.error("Subscription check error:", err);
    return res.status(500).json({ error: "Subscription check failed" });
  }
}

// ── 3. Admin-only guard ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { requireAuth, requireActiveSubscription, requireAdmin };