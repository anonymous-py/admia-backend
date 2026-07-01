// routes/users.js - tenant-scoped staff management
const express = require("express");
const bcrypt  = require("bcryptjs");
const { pool } = require("../db");
const { requireAuth, requireAdmin, requireActiveSubscription } = require("../middleware/auth");

const router = express.Router();
const guard = [requireAuth, requireActiveSubscription, requireAdmin];

router.get("/", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, fullname, username, role, created_at FROM users WHERE tenant_id=$1 ORDER BY created_at ASC",
      [req.user.tenant_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch users" }); }
});

router.post("/", guard, async (req, res) => {
  const { fullname, username, password, role } = req.body;
  if (!fullname || !username || !password) return res.status(400).json({ error: "All fields required" });
  if (!["admin","cashier"].includes(role)) return res.status(400).json({ error: "Invalid role" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (tenant_id, fullname, username, password, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, fullname, username, role, created_at`,
      [req.user.tenant_id, fullname.trim(), username.trim(), hash, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Username already exists" });
    res.status(500).json({ error: "Failed to create user" });
  }
});

router.delete("/:id", guard, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }
  try {
    await pool.query("DELETE FROM users WHERE id=$1 AND tenant_id=$2", [req.params.id, req.user.tenant_id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete user" }); }
});

module.exports = router;