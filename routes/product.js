// routes/products.js
const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// GET /products - all products (any logged-in user)
router.get("/", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM products ORDER BY name ASC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// POST /products - create product (admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { name, category, wholesale, retail, stock } = req.body;

  if (!name) return res.status(400).json({ error: "Product name required" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO products (name, category, wholesale, retail, stock)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        name.trim(),
        (category || "General").trim(),
        parseFloat(wholesale) || 0,
        parseFloat(retail) || 0,
        parseInt(stock) || 0,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create product" });
  }
});

// PUT /products/:id - update product (admin only)
router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, category, wholesale, retail, stock } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE products
       SET name=$1, category=$2, wholesale=$3, retail=$4, stock=$5, updated_at=NOW()
       WHERE id=$6
       RETURNING *`,
      [
        name.trim(),
        (category || "General").trim(),
        parseFloat(wholesale) || 0,
        parseFloat(retail) || 0,
        parseInt(stock) || 0,
        id,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update product" });
  }
});

// DELETE /products/:id (admin only)
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM products WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// POST /products/bulk-import - bulk import from Excel export (admin only)
router.post("/bulk-import", requireAuth, requireAdmin, async (req, res) => {
  const { products } = req.body; // array of product objects
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "No products provided" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = [];

    for (const p of products) {
      const { rows } = await client.query(
        `INSERT INTO products (name, category, wholesale, retail, stock)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          (p.name || "Unlabelled SKU").trim(),
          (p.category || "General").trim(),
          parseFloat(p.wholesale) || 0,
          parseFloat(p.retail) || 0,
          parseInt(p.stock) || 0,
        ]
      );
      inserted.push(rows[0]);
    }

    await client.query("COMMIT");
    res.status(201).json({ inserted: inserted.length, products: inserted });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Bulk import failed" });
  } finally {
    client.release();
  }
});

module.exports = router;