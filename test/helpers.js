import crypto from 'node:crypto';
import { StoreDb } from '../src/db.js';
import { computeSignature, computeSignatureV2 } from '../src/webhooks.js';

export const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createMemoryDb() {
  return new StoreDb(':memory:');
}

let sequence = 0;

/**
 * Seeds a realistic pending order and returns both the row and its plaintext
 * access token, which only the browser would normally hold.
 */
export function seedOrder(db, overrides = {}) {
  sequence += 1;
  const id = overrides.id || `AURA-TEST-${String(sequence).padStart(4, '0')}`;
  const token = overrides.token || `token-${sequence}-${crypto.randomBytes(8).toString('hex')}`;
  const createdAt =
    overrides.createdAt || new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();

  const order = db.createOrder({
    id,
    accessTokenHash: hashToken(token),
    status: 'PENDING',
    productId: 'aura-mug',
    quantity: 1,
    amountPaise: 89900,
    currency: 'INR',
    gatewayOrderId: id,
    gatewayPaymentId: `pay_${id}`,
    gatewayStatus: 'INITIATED',
    checkoutUrl: 'http://127.0.0.1:7000/checkout/session/test',
    customerName: 'Ananya Rao',
    customerEmail: 'ananya@example.com',
    customerPhone: '9876543210',
    shipAddress: '12, 100 Feet Road, Indiranagar',
    shipCity: 'Bengaluru',
    shipPincode: '560038',
    createdAt,
    ...overrides,
  });

  return { order, token };
}

export function buildWebhookPayload(order, overrides = {}) {
  return {
    event: 'SUCCESS',
    deliveryId: `dlv_${crypto.randomBytes(6).toString('hex')}`,
    timestamp: 1767225600000,
    paymentId: order.gatewayPaymentId,
    orderId: order.id,
    amount: '899.00',
    amountPaise: order.amountPaise,
    currency: 'INR',
    method: 'UPI',
    utr: '123456789012',
    verificationTag: 'Single Verification (SMS_GATEWAY)',
    verificationLevel: 1,
    completedAt: '2026-01-01T00:05:00.000Z',
    metadata: { storeOrderId: order.id },
    ...overrides,
  };
}

/**
 * Serializes and signs a payload the way UPI-PG does. V2 is the default.
 */
export function signedRequest(
  payload,
  secret = 'test-secret',
  { scheme = 'v2', timestamp = '1767225600000' } = {},
) {
  const rawBody = JSON.stringify(payload);
  if (scheme === 'v1') {
    return {
      rawBody,
      headers: { 'x-gateway-signature': `sha256=${computeSignature(secret, rawBody)}` },
    };
  }
  return {
    rawBody,
    headers: {
      'x-gateway-timestamp': timestamp,
      'x-gateway-signature-v2': `sha256=${computeSignatureV2(secret, timestamp, rawBody)}`,
    },
  };
}
