// routes/sales.js - tenant-scoped sales + dashboard stats
const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin, requireActiveSubscription } = require("../middleware/auth");

const router = express.Router();
const guard = [requireAuth, requireActiveSubscription];

// POST /api/sales
router.post("/", guard, async (req, res) => {
  const { items, payment_method, paystack_ref } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: "Cart is empty" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let total = 0, profit = 0;

    for (const item of items) {
      const { rows } = await client.query(
        "SELECT * FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [item.product_id, req.user.tenant_id]
      );
      if (!rows.length) throw new Error(`Product ${item.product_id} not found`);
      const product = rows[0];
      if (product.stock < item.qty) throw new Error(`Insufficient stock for: ${product.name}`);
      total  += item.unit_price * item.qty;
      profit += (item.unit_price - product.wholesale) * item.qty;
    }

    const { rows: saleRows } = await client.query(
      `INSERT INTO sales (tenant_id, total, profit, payment_method, served_by, user_id, paystack_ref, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed') RETURNING *`,
      [req.user.tenant_id, total.toFixed(2), profit.toFixed(2), payment_method||"Cash", req.user.fullname, req.user.id, paystack_ref||null]
    );
    const sale = saleRows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price, price_mode, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sale.id, item.product_id, item.product_name, item.qty, item.unit_price, item.price_mode, (item.unit_price * item.qty)]
      );
      await client.query(
        "UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3",
        [item.qty, item.product_id, req.user.tenant_id]
      );
    }

    await client.query("COMMIT");
    const { rows: itemRows } = await pool.query("SELECT * FROM sale_items WHERE sale_id = $1", [sale.id]);
    res.status(201).json({ ...sale, items: itemRows });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/sales
router.get("/", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, json_agg(si.*) AS items
       FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.tenant_id = $1
       GROUP BY s.id ORDER BY s.created_at DESC LIMIT 200`,
      [req.user.tenant_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch sales" }); }
});

// GET /api/sales/dashboard
router.get("/dashboard", [...guard, requireAdmin], async (req, res) => {
  const tid = req.user.tenant_id;
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN total END),0) AS daily_sales,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN profit END),0) AS daily_profit,
        COALESCE(SUM(CASE WHEN created_at >= NOW()-INTERVAL '7 days' THEN total END),0) AS weekly_sales,
        COALESCE(SUM(CASE WHEN created_at >= NOW()-INTERVAL '7 days' THEN profit END),0) AS weekly_profit,
        COALESCE(SUM(CASE WHEN DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW()) THEN total END),0) AS monthly_sales,
        COALESCE(SUM(CASE WHEN DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW()) THEN profit END),0) AS monthly_profit
      FROM sales WHERE tenant_id=$1 AND payment_status='completed'`, [tid]);

    const { rows: top } = await pool.query(
      `SELECT product_name, SUM(qty) AS total_qty FROM sale_items si
       JOIN sales s ON s.id=si.sale_id WHERE s.tenant_id=$1
       GROUP BY product_name ORDER BY total_qty DESC LIMIT 5`, [tid]);

    const { rows: bot } = await pool.query(
      `SELECT product_name, SUM(qty) AS total_qty FROM sale_items si
       JOIN sales s ON s.id=si.sale_id WHERE s.tenant_id=$1
       GROUP BY product_name ORDER BY total_qty ASC LIMIT 5`, [tid]);

    const { rows: cats } = await pool.query(
      `SELECT p.category, SUM(si.qty) AS total_qty
       FROM sale_items si JOIN products p ON p.id=si.product_id
       JOIN sales s ON s.id=si.sale_id WHERE s.tenant_id=$1
       GROUP BY p.category ORDER BY total_qty DESC`, [tid]);

    const { rows: low } = await pool.query(
      "SELECT id, name, stock FROM products WHERE tenant_id=$1 AND stock < 5 ORDER BY stock ASC", [tid]);

    const { rows: inv } = await pool.query(
      "SELECT COALESCE(SUM(wholesale*stock),0) AS total_value, COUNT(*) AS total_products FROM products WHERE tenant_id=$1", [tid]);

    res.json({
      ...rows[0],
      top_products: top, bottom_products: bot,
      category_distribution: cats, low_stock: low,
      inventory_value: inv[0].total_value,
      total_products: inv[0].total_products,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dashboard failed" });
  }
});

module.exports = router;