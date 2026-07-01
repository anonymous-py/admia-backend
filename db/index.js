// db/index.js - PostgreSQL connection + multi-tenant schema
// Handles migration from old single-tenant schema automatically
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Step 1: Check if we're on the old schema (no tenant_id on users) ──
    const { rows: cols } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'tenant_id'
    `);

    const isOldSchema = cols.length === 0;

    if (isOldSchema) {
      console.log("🔄 Old schema detected — migrating to multi-tenant...");

      // Drop old tables in correct order (foreign keys first)
      await client.query(`
        DROP TABLE IF EXISTS sale_items CASCADE;
        DROP TABLE IF EXISTS sales CASCADE;
        DROP TABLE IF EXISTS products CASCADE;
        DROP TABLE IF EXISTS users CASCADE;
        DROP TABLE IF EXISTS settings CASCADE;
        DROP TABLE IF EXISTS tenants CASCADE;
        DROP TABLE IF EXISTS subscription_events CASCADE;
      `);

      console.log("✅ Old tables dropped");
    }

    // ── Step 2: Create all tables fresh ──────────────────────────────────
    await client.query(`

      CREATE TABLE IF NOT EXISTS tenants (
        id                     SERIAL PRIMARY KEY,
        shop_name              TEXT NOT NULL DEFAULT 'My Shop',
        shop_email             TEXT NOT NULL UNIQUE,
        shop_phone             TEXT DEFAULT '',
        shop_address           TEXT DEFAULT '',
        owner_name             TEXT NOT NULL,
        plan                   TEXT NOT NULL DEFAULT 'monthly' CHECK (plan IN ('monthly','yearly')),
        sub_status             TEXT NOT NULL DEFAULT 'trialing'
                                 CHECK (sub_status IN ('trialing','active','suspended','cancelled')),
        trial_ends_at          TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
        sub_start_at           TIMESTAMPTZ,
        sub_renews_at          TIMESTAMPTZ,
        paystack_customer_code TEXT,
        paystack_sub_code      TEXT,
        created_at             TIMESTAMPTZ DEFAULT NOW()
      );

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

      CREATE TABLE IF NOT EXISTS subscription_events (
        id           SERIAL PRIMARY KEY,
        tenant_id    INTEGER REFERENCES tenants(id),
        event_type   TEXT NOT NULL,
        paystack_ref TEXT,
        payload      JSONB,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_sales_tenant    ON sales(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_users_tenant    ON users(tenant_id);
    `);

    await client.query("COMMIT");
    console.log("✅ Multi-tenant schema ready");

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema };