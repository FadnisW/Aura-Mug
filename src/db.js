import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  gateway_order_id TEXT UNIQUE,
  gateway_payment_id TEXT,
  gateway_status TEXT,
  checkout_url TEXT,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  ship_address TEXT NOT NULL,
  ship_city TEXT NOT NULL,
  ship_pincode TEXT NOT NULL,
  payment_method TEXT,
  utr TEXT,
  verification_level INTEGER,
  verification_tag TEXT,
  simulated_at TEXT,
  simulation_attempts INTEGER NOT NULL DEFAULT 0,
  simulation_last_attempt_at TEXT,
  simulation_error TEXT,
  paid_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_gateway_payment
  ON orders (gateway_payment_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders (status, created_at);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_events_order
  ON order_events (order_id, id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  payment_id TEXT,
  order_id TEXT,
  signature_valid INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  body_sha256 TEXT NOT NULL
);
`;

const ORDER_PATCH_COLUMNS = Object.freeze({
  status: 'status',
  gatewayOrderId: 'gateway_order_id',
  gatewayPaymentId: 'gateway_payment_id',
  gatewayStatus: 'gateway_status',
  checkoutUrl: 'checkout_url',
  paymentMethod: 'payment_method',
  utr: 'utr',
  verificationLevel: 'verification_level',
  verificationTag: 'verification_tag',
  simulatedAt: 'simulated_at',
  simulationAttempts: 'simulation_attempts',
  simulationLastAttemptAt: 'simulation_last_attempt_at',
  simulationError: 'simulation_error',
  paidAt: 'paid_at',
  failureReason: 'failure_reason',
});

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    accessTokenHash: row.access_token_hash,
    status: row.status,
    productId: row.product_id,
    quantity: Number(row.quantity),
    amountPaise: Number(row.amount_paise),
    currency: row.currency,
    gatewayOrderId: row.gateway_order_id,
    gatewayPaymentId: row.gateway_payment_id,
    gatewayStatus: row.gateway_status,
    checkoutUrl: row.checkout_url,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    shipAddress: row.ship_address,
    shipCity: row.ship_city,
    shipPincode: row.ship_pincode,
    paymentMethod: row.payment_method,
    utr: row.utr,
    verificationLevel: row.verification_level === null ? null : Number(row.verification_level),
    verificationTag: row.verification_tag,
    simulatedAt: row.simulated_at,
    simulationAttempts: Number(row.simulation_attempts || 0),
    simulationLastAttemptAt: row.simulation_last_attempt_at,
    simulationError: row.simulation_error,
    paidAt: row.paid_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row) {
  return {
    id: Number(row.id),
    orderId: row.order_id,
    type: row.type,
    message: row.message,
    data: parseJson(row.data),
    createdAt: row.created_at,
  };
}

/**
 * Small SQLite wrapper for storefront orders. The database is intentionally
 * separate from the gateway's database: the store owns its order history and
 * treats the gateway as an external payment service.
 */
export class StoreDb {
  /** @param {string} dbPath */
  constructor(dbPath) {
    if (!dbPath) throw new Error('A database path is required.');
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // WAL is unavailable on some filesystems; the default journal still works.
    }
    this.db.exec(SCHEMA);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Closing twice is harmless.
    }
  }

  /**
   * @param {{
   *   id: string,
   *   accessTokenHash: string,
   *   status: string,
   *   productId: string,
   *   quantity: number,
   *   amountPaise: number,
   *   currency: string,
   *   gatewayOrderId?: string|null,
   *   gatewayPaymentId?: string|null,
   *   gatewayStatus?: string|null,
   *   checkoutUrl?: string|null,
   *   customerName: string,
   *   customerEmail: string,
   *   customerPhone: string,
   *   shipAddress: string,
   *   shipCity: string,
   *   shipPincode: string,
   *   createdAt?: string,
   * }} order
   */
  createOrder(order) {
    const createdAt = order.createdAt || nowIso();
    this.db
      .prepare(
        `INSERT INTO orders (
          id, access_token_hash, status, product_id, quantity, amount_paise, currency,
          gateway_order_id, gateway_payment_id, gateway_status, checkout_url,
          customer_name, customer_email, customer_phone,
          ship_address, ship_city, ship_pincode,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.id,
        order.accessTokenHash,
        order.status,
        order.productId,
        order.quantity,
        order.amountPaise,
        order.currency,
        order.gatewayOrderId ?? null,
        order.gatewayPaymentId ?? null,
        order.gatewayStatus ?? null,
        order.checkoutUrl ?? null,
        order.customerName,
        order.customerEmail,
        order.customerPhone,
        order.shipAddress,
        order.shipCity,
        order.shipPincode,
        createdAt,
        createdAt,
      );
    return this.getOrder(order.id);
  }

  /** @param {string} id */
  getOrder(id) {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    return mapOrder(row);
  }

  /** @param {string} paymentId */
  getOrderByPaymentId(paymentId) {
    const row = this.db
      .prepare('SELECT * FROM orders WHERE gateway_payment_id = ?')
      .get(paymentId);
    return mapOrder(row);
  }

  /**
   * Applies a partial update. Unknown fields are ignored so callers cannot
   * accidentally write arbitrary columns.
   * @param {string} id
   * @param {Record<string, unknown>} patch
   */
  updateOrder(id, patch) {
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(ORDER_PATCH_COLUMNS)) {
      if (!Object.hasOwn(patch, key)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] ?? null);
    }
    if (sets.length === 0) return this.getOrder(id);

    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    this.db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getOrder(id);
  }

  /**
   * @param {string} orderId
   * @param {string} type
   * @param {string} message
   * @param {Record<string, unknown>|null} [data]
   */
  addEvent(orderId, type, message, data = null) {
    const createdAt = nowIso();
    const result = this.db
      .prepare(
        'INSERT INTO order_events (order_id, type, message, data, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(orderId, type, message, data ? JSON.stringify(data) : null, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      orderId,
      type,
      message,
      data,
      createdAt,
    };
  }

  /** @param {string} orderId */
  listEvents(orderId) {
    return this.db
      .prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC')
      .all(orderId)
      .map(mapEvent);
  }

  /**
   * Pending orders are the only ones the demo auto-confirm worker needs.
   * @param {{limit?: number}} [options]
   */
  listPendingOrders({ limit = 25 } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM orders
         WHERE status = 'PENDING'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit)
      .map(mapOrder);
  }

  /** @param {string} deliveryId */
  hasDelivery(deliveryId) {
    const row = this.db
      .prepare('SELECT 1 AS found FROM webhook_deliveries WHERE delivery_id = ?')
      .get(deliveryId);
    return Boolean(row);
  }

  /**
   * Records a webhook delivery for replay protection. Returns false when the
   * delivery id has already been seen.
   * @param {{deliveryId: string, event: string, paymentId: string|null, orderId: string|null, signatureValid: boolean, bodySha256: string}} delivery
   */
  recordDelivery(delivery) {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries
          (delivery_id, event, payment_id, order_id, signature_valid, received_at, body_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delivery.deliveryId,
        delivery.event,
        delivery.paymentId ?? null,
        delivery.orderId ?? null,
        delivery.signatureValid ? 1 : 0,
        nowIso(),
        delivery.bodySha256,
      );
    return result.changes > 0;
  }

  stats() {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM orders GROUP BY status')
      .all();
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = Number(row.count);
    return {
      total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
      byStatus,
    };
  }
}
