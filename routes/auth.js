// routes/auth.js - Login + tenant registration
const express = require("express");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// ── POST /api/auth/register ────────────────────────────────────────────
// Shop owner signs up — creates tenant + first admin user
router.post("/register", async (req, res) => {
  const { shop_name, shop_email, owner_name, username, password, plan = "monthly" } = req.body;

  if (!shop_name || !shop_email || !owner_name || !username || !password) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create the tenant (shop)
    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants (shop_name, shop_email, owner_name, plan, sub_status)
       VALUES ($1, $2, $3, $4, 'trialing')
       RETURNING *`,
      [shop_name.trim(), shop_email.trim().toLowerCase(), owner_name.trim(), plan]
    );
    const tenant = tenantRows[0];

    // Create the first admin user for this tenant
    const hash = await bcrypt.hash(password, 10);
    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, fullname, username, password, role)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id, fullname, username, role, tenant_id`,
      [tenant.id, owner_name.trim(), username.trim(), hash]
    );
    const user = userRows[0];

    await client.query("COMMIT");

    // Issue JWT immediately — they're logged in right after signup
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, fullname: user.fullname, tenant_id: tenant.id },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.status(201).json({
      token,
      user: { id: user.id, fullname: user.fullname, username: user.username, role: user.role, tenant_id: tenant.id },
      tenant: { id: tenant.id, shop_name: tenant.shop_name, sub_status: tenant.sub_status, trial_ends_at: tenant.trial_ends_at },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(409).json({ error: "That email is already registered" });
    }
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.*, t.shop_name, t.sub_status, t.trial_ends_at
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1`,
      [username.trim()]
    );

    if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, fullname: user.fullname, tenant_id: user.tenant_id },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      token,
      user: { id: user.id, fullname: user.fullname, username: user.username, role: user.role, tenant_id: user.tenant_id },
      tenant: { shop_name: user.shop_name, sub_status: user.sub_status, trial_ends_at: user.trial_ends_at },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;