// routes/users.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// GET /users - list all users (admin only)
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, fullname, username, role, created_at FROM users ORDER BY created_at ASC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /users - create a new staff member (admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { fullname, username, password, role } = req.body;

  if (!fullname || !username || !password || !role) {
    return res.status(400).json({ error: "All fields required" });
  }
  if (!["admin", "cashier"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or cashier" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (fullname, username, password, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, fullname, username, role, created_at`,
      [fullname.trim(), username.trim(), hash, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: "Failed to create user" });
  }
});

// DELETE /users/:id (admin only, cannot delete yourself)
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  try {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

module.exports = router;