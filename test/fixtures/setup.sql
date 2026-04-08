-- sql-shield integration test schema
-- Run once against test PostgreSQL to set up fixtures.

DROP SCHEMA IF EXISTS sql_shield_test CASCADE;
CREATE SCHEMA sql_shield_test;

-- Customers
CREATE TABLE sql_shield_test.customers (
  customer_id SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  region      TEXT,
  segment     TEXT,
  email       TEXT
);

INSERT INTO sql_shield_test.customers (name, region, segment, email) VALUES
  ('Acme Corp',    'EU',   'Enterprise', 'acme@example.com'),
  ('Beta Inc',     'US',   'SMB',        'beta@example.com'),
  ('Gamma Ltd',    'APAC', 'Enterprise', 'gamma@example.com'),
  ('Delta GmbH',   'EU',   'Mid-Market', 'delta@example.com'),
  ('Epsilon SA',   'LATAM','SMB',        'epsilon@example.com');

-- Orders
CREATE TABLE sql_shield_test.orders (
  order_id    SERIAL PRIMARY KEY,
  customer_id INT REFERENCES sql_shield_test.customers(customer_id),
  order_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  total       NUMERIC(12,2) NOT NULL,
  status      TEXT DEFAULT 'pending'
);

INSERT INTO sql_shield_test.orders (customer_id, order_date, total, status) VALUES
  (1, '2026-03-01', 1500.00, 'shipped'),
  (1, '2026-03-15', 2300.50, 'delivered'),
  (2, '2026-03-10',  800.00, 'shipped'),
  (3, '2026-04-01', 5000.00, 'pending'),
  (4, '2026-04-05', 1200.00, 'shipped'),
  (1, '2026-04-07', 3100.00, 'pending');

-- Products
CREATE TABLE sql_shield_test.products (
  product_id  SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT,
  price       NUMERIC(10,2)
);

INSERT INTO sql_shield_test.products (name, category, price) VALUES
  ('Widget A',  'Hardware',  29.99),
  ('Widget B',  'Hardware',  49.99),
  ('Service X', 'Software', 199.00),
  ('Service Y', 'Software', 399.00);

-- A view to test views in whitelist
CREATE VIEW sql_shield_test.v_customer_orders AS
  SELECT c.customer_id, c.name AS customer_name, c.region,
         o.order_id, o.order_date, o.total, o.status
    FROM sql_shield_test.customers c
    JOIN sql_shield_test.orders o ON o.customer_id = c.customer_id;

-- Internal table that should be excluded
CREATE TABLE sql_shield_test.migrations (
  id      SERIAL PRIMARY KEY,
  version TEXT,
  applied TIMESTAMP DEFAULT NOW()
);
