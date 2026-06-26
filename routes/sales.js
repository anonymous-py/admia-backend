// routes/sales.js
const express = require("express");
const { pool } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// POST /sales - complete a sale (any cashier)
// Body: { items: [{product_id, product_name, qty, unit_price, price_mode}], payment_method, paystack_ref? }
router.post("/", requireAuth, async (req, res) => {
  const { items, payment_method, paystack_ref } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: "Cart is empty" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let total = 0;
    let profit = 0;

    // Validate stock and calculate totals
    for (const item of items) {
      const { rows } = await client.query(
        "SELECT * FROM products WHERE id = $1 FOR UPDATE",
        [item.product_id]
      );
      if (rows.length === 0) throw new Error(`Product ${item.product_id} not found`);

      const product = rows[0];
      if (product.stock < item.qty) {
        throw new Error(`Insufficient stock for: ${product.name}`);
      }

      const subtotal = item.unit_price * item.qty;
      const itemProfit = (item.unit_price - product.wholesale) * item.qty;
      total += subtotal;
      profit += itemProfit;
    }

    // Insert the sale header
    const { rows: saleRows } = await client.query(
      `INSERT INTO sales (total, profit, payment_method, served_by, user_id, paystack_ref, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        total.toFixed(2),
        profit.toFixed(2),
        payment_method || "Cash",
        req.user.fullname,
        req.user.id,
        paystack_ref || null,
        paystack_ref ? "completed" : "completed", // verified before this call for Paystack
      ]
    );
    const sale = saleRows[0];

    // Insert line items + deduct stock
    for (const item of items) {
      const subtotal = item.unit_price * item.qty;
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price, price_mode, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sale.id, item.product_id, item.product_name, item.qty, item.unit_price, item.price_mode, subtotal]
      );

      await client.query(
        "UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2",
        [item.qty, item.product_id]
      );
    }

    await client.query("COMMIT");

    // Return full sale with items for receipt printing
    const { rows: itemRows } = await pool.query(
      "SELECT * FROM sale_items WHERE sale_id = $1",
      [sale.id]
    );

    res.status(201).json({ ...sale, items: itemRows });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Sale error:", err.message);
    res.status(400).json({ error: err.message || "Sale failed" });
  } finally {
    client.release();
  }
});

// GET /sales - sales history (any logged-in user sees own sales; admin sees all)
router.get("/", requireAuth, async (req, res) => {
  try {
    let query, params;

    if (req.user.role === "admin") {
      query = `
        SELECT s.*, json_agg(si.*) AS items
        FROM sales s
        LEFT JOIN sale_items si ON si.sale_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 200
      `;
      params = [];
    } else {
      query = `
        SELECT s.*, json_agg(si.*) AS items
        FROM sales s
        LEFT JOIN sale_items si ON si.sale_id = s.id
        WHERE s.user_id = $1
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 100
      `;
      params = [req.user.id];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

// GET /sales/dashboard - aggregated stats for dashboard (admin only)
router.get("/dashboard", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        -- Daily
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN total END), 0)  AS daily_sales,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN profit END), 0) AS daily_profit,
        -- Weekly
        COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN total END), 0)  AS weekly_sales,
        COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN profit END), 0) AS weekly_profit,
        -- Monthly
        COALESCE(SUM(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW()) THEN total END), 0)  AS monthly_sales,
        COALESCE(SUM(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW()) THEN profit END), 0) AS monthly_profit
      FROM sales
      WHERE payment_status = 'completed'
    `);

    // Top/bottom products by qty sold
    const { rows: topProducts } = await pool.query(`
      SELECT product_name, SUM(qty) AS total_qty
      FROM sale_items
      GROUP BY product_name
      ORDER BY total_qty DESC
      LIMIT 5
    `);

    const { rows: bottomProducts } = await pool.query(`
      SELECT product_name, SUM(qty) AS total_qty
      FROM sale_items
      GROUP BY product_name
      ORDER BY total_qty ASC
      LIMIT 5
    `);

    // Category distribution for pie chart
    const { rows: categoryDist } = await pool.query(`
      SELECT p.category, SUM(si.qty) AS total_qty
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      GROUP BY p.category
      ORDER BY total_qty DESC
    `);

    // Low stock alerts
    const { rows: lowStock } = await pool.query(`
      SELECT id, name, stock, category FROM products WHERE stock < 5 ORDER BY stock ASC
    `);

    // Inventory value
    const { rows: inventoryValue } = await pool.query(`
      SELECT COALESCE(SUM(wholesale * stock), 0) AS total_value, COUNT(*) AS total_products FROM products
    `);

    res.json({
      ...rows[0],
      top_products: topProducts,
      bottom_products: bottomProducts,
      category_distribution: categoryDist,
      low_stock: lowStock,
      inventory_value: inventoryValue[0].total_value,
      total_products: inventoryValue[0].total_products,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

module.exports = router;