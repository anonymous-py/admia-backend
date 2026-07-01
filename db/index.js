// db/index.js - PostgreSQL connection + full multi-tenant schema
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`

    -- ── TENANTS ────────────────────────────────────────────────────────
    -- One row per shop/business that subscribes to Admia SaaS
    CREATE TABLE IF NOT EXISTS tenants (
      id               SERIAL PRIMARY KEY,
      shop_name        TEXT NOT NULL DEFAULT 'My Shop',
      shop_email       TEXT NOT NULL UNIQUE,
      shop_phone       TEXT DEFAULT '',
      shop_address     TEXT DEFAULT '',
      owner_name       TEXT NOT NULL,
      plan             TEXT NOT NULL DEFAULT 'monthly' CHECK (plan IN ('monthly','yearly')),
      sub_status       TEXT NOT NULL DEFAULT 'trialing'
                         CHECK (sub_status IN ('trialing','active','suspended','cancelled')),
      trial_ends_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
      sub_start_at     TIMESTAMPTZ,
      sub_renews_at    TIMESTAMPTZ,
      paystack_customer_code TEXT,
      paystack_sub_code      TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── USERS ──────────────────────────────────────────────────────────
    -- Staff members belonging to a tenant
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      fullname    TEXT NOT NULL,
      username    TEXT NOT NULL,
      password    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('admin','cashier')),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, username)
    );

    -- ── PRODUCTS ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'General',
      wholesale   NUMERIC(12,2) NOT NULL DEFAULT 0,
      retail      NUMERIC(12,2) NOT NULL DEFAULT 0,
      stock       INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── SALES ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sales (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      total          NUMERIC(12,2) NOT NULL,
      profit         NUMERIC(12,2) NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'Cash',
      served_by      TEXT NOT NULL,
      user_id        INTEGER REFERENCES users(id),
      paystack_ref   TEXT,
      payment_status TEXT DEFAULT 'completed',
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── SALE ITEMS ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sale_items (
      id           SERIAL PRIMARY KEY,
      sale_id      INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id   INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      qty          INTEGER NOT NULL,
      unit_price   NUMERIC(12,2) NOT NULL,
      price_mode   TEXT NOT NULL DEFAULT 'retail',
      subtotal     NUMERIC(12,2) NOT NULL
    );

    -- ── SUBSCRIPTION EVENTS ────────────────────────────────────────────
    -- Audit log of every Paystack webhook event received
    CREATE TABLE IF NOT EXISTS subscription_events (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id),
      event_type  TEXT NOT NULL,
      paystack_ref TEXT,
      payload     JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── INDEXES ────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_products_tenant  ON products(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sales_tenant     ON sales(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_users_tenant     ON users(tenant_id);
  `);

  console.log("Multi-tenant schema ready");
}

module.exports = { pool, initSchema };