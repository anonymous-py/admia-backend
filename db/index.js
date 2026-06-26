// db/index.js - PostgreSQL connection pool + schema bootstrap
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Run once on server start - creates all tables if they don't exist
async function initSchema() {
  await pool.query(`
    -- USERS TABLE
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL PRIMARY KEY,
      fullname  TEXT NOT NULL,
      username  TEXT UNIQUE NOT NULL,
      password  TEXT NOT NULL,          -- bcrypt hash
      role      TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('admin','cashier')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- PRODUCTS TABLE
    CREATE TABLE IF NOT EXISTS products (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT 'General',
      wholesale  NUMERIC(12,2) NOT NULL DEFAULT 0,
      retail     NUMERIC(12,2) NOT NULL DEFAULT 0,
      stock      INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- SALES TABLE (one row per transaction)
    CREATE TABLE IF NOT EXISTS sales (
      id             SERIAL PRIMARY KEY,
      total          NUMERIC(12,2) NOT NULL,
      profit         NUMERIC(12,2) NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'Cash',
      served_by      TEXT NOT NULL,
      user_id        INTEGER REFERENCES users(id),
      paystack_ref   TEXT,                          -- populated for Ecash payments
      payment_status TEXT DEFAULT 'completed',      -- completed | pending | failed
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    -- SALE ITEMS TABLE (line items for each sale)
    CREATE TABLE IF NOT EXISTS sale_items (
      id           SERIAL PRIMARY KEY,
      sale_id      INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id   INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,                   -- snapshot at time of sale
      qty          INTEGER NOT NULL,
      unit_price   NUMERIC(12,2) NOT NULL,
      price_mode   TEXT NOT NULL DEFAULT 'retail',  -- retail | wholesale
      subtotal     NUMERIC(12,2) NOT NULL
    );

    -- SETTINGS TABLE (one row, keyed by shop)
    CREATE TABLE IF NOT EXISTS settings (
      id           SERIAL PRIMARY KEY,
      shop_name    TEXT DEFAULT 'Admia Store',
      shop_email   TEXT DEFAULT '',
      shop_phone   TEXT DEFAULT '',
      shop_address TEXT DEFAULT '',
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );

    -- Seed a default settings row if empty
    INSERT INTO settings (shop_name)
    SELECT 'Erican Classic Enterprise'
    WHERE NOT EXISTS (SELECT 1 FROM settings);
  `);

  // Seed the default admin user if no users exist
  const { rows } = await pool.query("SELECT COUNT(*) FROM users");
  if (parseInt(rows[0].count) === 0) {
    const bcrypt = require("bcryptjs");
    const hash = await bcrypt.hash("admin123", 10);
    await pool.query(
      `INSERT INTO users (fullname, username, password, role)
       VALUES ($1, $2, $3, $4)`,
      ["Administrator Profile Node", "admin", hash, "admin"]
    );
    console.log("Default admin seeded (username: admin / password: admin123)");
  }

  console.log("Database schema ready");
}

module.exports = { pool, initSchema };