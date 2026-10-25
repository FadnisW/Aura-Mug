import crypto from 'node:crypto';

export const WEBHOOK_EVENTS = Object.freeze(['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED']);

export class WebhookPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookPayloadError';
    this.code = 'INVALID_WEBHOOK_PAYLOAD';
  }
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function computeSignature(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function computeSignatureV2(secret, timestamp, body) {
  return computeSignature(secret, `${timestamp}.${body}`);
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function signatureValue(header) {
  if (typeof header !== 'string') return '';
  return header.trim().replace(/^sha256=/i, '').trim();
}

/**
 * Verifies the gateway webhook signature. V2 (timestamped) is preferred; V1 is
 * accepted only when V2 is absent. A present-but-invalid V2 header is always a
 * rejection so a caller cannot downgrade the scheme.
 *
 * @param {{rawBody: string, headers: Record<string, string|string[]|undefined>, secret: string}} input
 * @returns {{valid: boolean, scheme: 'v2'|'v1'|null, reason?: string}}
 */
export function verifyWebhookSignature({ rawBody, headers, secret }) {
  if (!secret) return { valid: false, scheme: null, reason: 'Webhook secret is not configured.' };
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return { valid: false, scheme: null, reason: 'Empty webhook body.' };
  }

  const readHeader = (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const v2 = signatureValue(readHeader('x-gateway-signature-v2'));
  const v1 = signatureValue(readHeader('x-gateway-signature'));
  const timestamp = readHeader('x-gateway-timestamp');

  if (v2) {
    if (!timestamp) {
      return { valid: false, scheme: 'v2', reason: 'Missing X-Gateway-Timestamp.' };
    }
    const expected = computeSignatureV2(secret, timestamp, rawBody);
    if (!safeEqualText(expected, v2)) {
      return { valid: false, scheme: 'v2', reason: 'Invalid V2 signature.' };
    }
    return { valid: true, scheme: 'v2' };
  }

  if (v1) {
    const expected = computeSignature(secret, rawBody);
    if (!safeEqualText(expected, v1)) {
      return { valid: false, scheme: 'v1', reason: 'Invalid V1 signature.' };
    }
    return { valid: true, scheme: 'v1' };
  }

  return { valid: false, scheme: null, reason: 'Missing webhook signature.' };
}

/**
 * Parses and normalizes a gateway webhook payload.
 * @param {string} rawBody
 */
export function parseWebhookPayload(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError('Webhook body is not valid JSON.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookPayloadError('Webhook body must be a JSON object.');
  }

  const event = String(payload.event || '').trim().toUpperCase();
  if (!WEBHOOK_EVENTS.includes(event)) {
    throw new WebhookPayloadError(`Unsupported webhook event: ${payload.event || '(missing)'}.`);
  }

  const deliveryId = String(payload.deliveryId || '').trim();
  const paymentId = String(payload.paymentId || '').trim();
  const orderId = String(payload.orderId || '').trim();
  if (!deliveryId) throw new WebhookPayloadError('Webhook is missing deliveryId.');
  if (!paymentId) throw new WebhookPayloadError('Webhook is missing paymentId.');
  if (!orderId) throw new WebhookPayloadError('Webhook is missing orderId.');

  const amountPaise = Number(payload.amountPaise);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new WebhookPayloadError('Webhook is missing a valid amountPaise.');
  }

  const verificationLevel = Number(payload.verificationLevel);
  const timestamp = Number(payload.timestamp);

  return {
    event,
    deliveryId,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    paymentId,
    orderId,
    amount: String(payload.amount || ''),
    amountPaise,
    currency: String(payload.currency || 'INR').toUpperCase(),
    method: String(payload.method || 'UPI').toUpperCase(),
    utr: String(payload.utr || '').trim(),
    verificationTag: String(payload.verificationTag || 'UNVERIFIED'),
    verificationLevel: Number.isFinite(verificationLevel) ? verificationLevel : 0,
    completedAt: payload.completedAt ? String(payload.completedAt) : null,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };
}

/**
 * Cross-checks the signed payload against the locally stored order. The
 * signature proves the gateway sent it; this proves it belongs to this order
 * and that the amount was not altered before signing.
 *
 * @param {ReturnType<typeof parseWebhookPayload>} payload
 * @param {any} order
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateWebhookAgainstOrder(payload, order) {
  if (!order) return { ok: false, reason: `Unknown order: ${payload.orderId}` };
  if (order.id !== payload.orderId) {
    return { ok: false, reason: 'Webhook orderId does not match the stored order.' };
  }
  if (order.gatewayPaymentId && order.gatewayPaymentId !== payload.paymentId) {
    return { ok: false, reason: 'Webhook paymentId does not match the stored order.' };
  }
  if (Number(order.amountPaise) !== payload.amountPaise) {
    return { ok: false, reason: 'Webhook amount does not match the stored order.' };
  }
  if (String(order.currency).toUpperCase() !== payload.currency) {
    return { ok: false, reason: 'Webhook currency does not match the stored order.' };
  }
  return { ok: true };
}
