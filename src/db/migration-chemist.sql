-- ─── City Chemist: Products & Orders ─────────────────────────────────────────
-- Run this in your Supabase SQL editor.
--
-- Storage: product images are stored in the existing "crop-images" bucket
-- under the "products/" prefix path (e.g. products/1713890000000.jpg).
-- Make sure the crop-images bucket has public access enabled.

-- Products catalogue
CREATE TABLE IF NOT EXISTS products (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT,
  image_url   TEXT,
  category    TEXT        NOT NULL
                CHECK (category IN ('pesticide', 'fertilizer', 'herbicide', 'fungicide', 'other')),
  price       NUMERIC(10, 2),
  unit        TEXT        DEFAULT 'unit',
  in_stock    BOOLEAN     DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Farmer orders placed through /city-chemist
CREATE TABLE IF NOT EXISTS chemist_orders (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id   UUID        REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT        NOT NULL,   -- denormalised so history survives product deletes
  farmer_name  TEXT        NOT NULL,
  phone        TEXT        NOT NULL,
  location     TEXT        NOT NULL,
  reason       TEXT        NOT NULL,
  status       TEXT        DEFAULT 'pending'
                 CHECK (status IN ('pending', 'fulfilled', 'not_fulfilled')),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Optional: index on status for fast admin filtering
CREATE INDEX IF NOT EXISTS chemist_orders_status_idx ON chemist_orders (status);
CREATE INDEX IF NOT EXISTS chemist_orders_created_at_idx ON chemist_orders (created_at DESC);
