// routes/products.js - tenant-scoped product CRUD
const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin, requireActiveSubscription } = require("../middleware/auth");

const router = express.Router();
const guard = [requireAuth, requireActiveSubscription];

router.get("/", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM products WHERE tenant_id = $1 ORDER BY name ASC",
      [req.user.tenant_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch products" }); }
});

router.post("/", [...guard, requireAdmin], async (req, res) => {
  const { name, category, wholesale, retail, stock } = req.body;
  if (!name) return res.status(400).json({ error: "Product name required" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO products (tenant_id, name, category, wholesale, retail, stock)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.tenant_id, name.trim(), (category||"General").trim(), parseFloat(wholesale)||0, parseFloat(retail)||0, parseInt(stock)||0]
    );
    res.status(201).json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to create product" }); }
});

router.put("/:id", [...guard, requireAdmin], async (req, res) => {
  const { name, category, wholesale, retail, stock } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE products SET name=$1, category=$2, wholesale=$3, retail=$4, stock=$5, updated_at=NOW()
       WHERE id=$6 AND tenant_id=$7 RETURNING *`,
      [name.trim(), (category||"General").trim(), parseFloat(wholesale)||0, parseFloat(retail)||0, parseInt(stock)||0, req.params.id, req.user.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to update product" }); }
});

router.delete("/:id", [...guard, requireAdmin], async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM products WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.user.tenant_id]
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete product" }); }
});

router.post("/bulk-import", [...guard, requireAdmin], async (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: "No products provided" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = [];
    for (const p of products) {
      const { rows } = await client.query(
        `INSERT INTO products (tenant_id, name, category, wholesale, retail, stock)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.user.tenant_id, (p.name||"Unlabelled").trim(), (p.category||"General").trim(), parseFloat(p.wholesale)||0, parseFloat(p.retail)||0, parseInt(p.stock)||0]
      );
      inserted.push(rows[0]);
    }
    await client.query("COMMIT");
    res.status(201).json({ inserted: inserted.length, products: inserted });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Bulk import failed" });
  } finally { client.release(); }
});

module.exports = router;