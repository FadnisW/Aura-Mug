import crypto from 'node:crypto';
import { PRODUCT, calculateAmountPaise, formatInr } from './product.js';
import { validateOrderInput } from './validate.js';
import { validateWebhookAgainstOrder } from './webhooks.js';

export class OrderError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, field?: string|null, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'OrderError';
    this.status = options.status || 400;
    this.code = options.code || 'ORDER_ERROR';
    this.field = options.field || null;
  }
}

const TERMINAL_FAILURES = new Set(['FAILED', 'EXPIRED', 'CANCELLED']);

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeGatewayStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return status || null;
}

function hashAccessToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokensMatch(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashAccessToken(token), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function generateOrderId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `AURA-${stamp}-${random}`;
}

export function generateAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function buildReturnUrl(config, orderId, accessToken) {
  const url = new URL('/return', `${config.publicBaseUrl}/`);
  url.searchParams.set('order', orderId);
  url.searchParams.set('token', accessToken);
  return url.toString();
}

/**
 * Creates a local order first, then asks the gateway for a hosted checkout.
 * The local row is written before the network call so a webhook can never
 * arrive before the order exists.
 *
 * @param {{
 *   db: import('./db.js').StoreDb,
 *   gateway: import('./gateway.js').GatewayClient,
 *   config: ReturnType<import('./config.js').loadConfig>,
 *   body: unknown,
 *   logger: ReturnType<import('./log.js').createLogger>,
 * }} input
 */
export async function createOrder({ db, gateway, config, body, logger }) {
  const validated = validateOrderInput(body);
  const amountPaise = calculateAmountPaise(validated.quantity);
  const orderId = generateOrderId();
  const accessToken = generateAccessToken();

  const order = db.createOrder({
    id: orderId,
    accessTokenHash: hashAccessToken(accessToken),
    status: 'PENDING',
    productId: PRODUCT.id,
    quantity: validated.quantity,
    amountPaise,
    currency: PRODUCT.currency,
    gatewayOrderId: orderId,
    gatewayStatus: 'CREATING',
    customerName: validated.customer.name,
    customerEmail: validated.customer.email,
    customerPhone: validated.customer.phone,
    shipAddress: validated.shipping.address,
    shipCity: validated.shipping.city,
    shipPincode: validated.shipping.pincode,
  });

  db.addEvent(orderId, 'order.created', 'Order created.', {
    quantity: validated.quantity,
    amountPaise,
  });

  const returnUrl = buildReturnUrl(config, orderId, accessToken);

  try {
    const payment = await gateway.createPayment({ order, returnUrl });
    const gatewayStatus = normalizeGatewayStatus(payment.status) || 'INITIATED';
    const updated = db.updateOrder(orderId, {
      gatewayOrderId: payment.orderId || orderId,
      gatewayPaymentId: payment.paymentId,
      gatewayStatus,
      checkoutUrl: payment.checkoutUrl,
    });

    db.addEvent(orderId, 'payment.created', 'Hosted checkout session created.', {
      paymentId: payment.paymentId,
      gatewayStatus,
      queuePosition: payment.queuePosition ?? 0,
    });

    logger.info(`Order ${orderId} created (payment ${payment.paymentId}, ${gatewayStatus}).`);
    return {
      order: updated,
      accessToken,
      checkoutUrl: payment.checkoutUrl,
    };
  } catch (error) {
    db.updateOrder(orderId, {
      status: 'FAILED',
      gatewayStatus: 'ERROR',
      failureReason: 'Could not start the payment.',
    });
    db.addEvent(orderId, 'order.payment_setup_failed', 'Could not start the payment.', {
      code: error?.code || 'GATEWAY_ERROR',
      message: error?.message || 'Unknown gateway error.',
    });
    logger.error(`Order ${orderId} could not start a payment:`, error?.message || error);
    throw new OrderError(
      'We could not start the payment. Please check that the local gateway is running and try again.',
      { status: 502, code: 'PAYMENT_SETUP_FAILED', cause: error },
    );
  }
}

/**
 * Marks an order paid. Safe to call from both the signed webhook and the
 * reconciliation poll: the first writer wins and later calls are no-ops.
 *
 * @param {{db: import('./db.js').StoreDb, order: any, payment: Record<string, any>, source: string, logger?: any}} input
 */
export function markOrderPaid({ db, order, payment, source, logger }) {
  if (!order) return null;
  if (order.status === 'PAID') return order;

  const paymentId = String(payment.paymentId || order.gatewayPaymentId || '').trim() || null;
  const utr = String(payment.utr || '').trim() || null;
  const method = String(payment.method || 'UPI').toUpperCase();
  const verificationLevel = Number(payment.verificationLevel);
  const verificationTag = String(payment.verificationTag || 'UNVERIFIED');
  const paidAt = toIso(payment.completedAt) || nowIso();

  const updated = db.updateOrder(order.id, {
    status: 'PAID',
    gatewayStatus: 'SUCCESS',
    gatewayPaymentId: paymentId,
    paymentMethod: method,
    utr,
    verificationLevel: Number.isFinite(verificationLevel) ? verificationLevel : null,
    verificationTag,
    paidAt,
    failureReason: null,
  });

  db.addEvent(
    order.id,
    'order.paid',
    utr ? `Payment confirmed · UTR ${utr}.` : 'Payment confirmed.',
    {
      source,
      paymentId,
      utr,
      method,
      verificationLevel: Number.isFinite(verificationLevel) ? verificationLevel : null,
      verificationTag,
    },
  );

  logger?.info(`Order ${order.id} paid via ${source}${utr ? ` (UTR ${utr})` : ''}.`);
  return updated;
}

/**
 * @param {{db: import('./db.js').StoreDb, order: any, status: string, reason: string, source: string, logger?: any}} input
 */
export function markOrderTerminal({ db, order, status, reason, source, logger }) {
  if (!order) return null;
  const nextStatus = String(status || '').toUpperCase();
  if (!TERMINAL_FAILURES.has(nextStatus)) return order;
  if (order.status === 'PAID') {
    logger?.warn(`Ignoring ${nextStatus} for already-paid order ${order.id}.`);
    return order;
  }
  if (order.status === nextStatus) return order;

  const updated = db.updateOrder(order.id, {
    status: nextStatus,
    gatewayStatus: nextStatus,
    failureReason: reason || null,
  });
  db.addEvent(order.id, `order.${nextStatus.toLowerCase()}`, reason || `Payment ${nextStatus.toLowerCase()}.`, {
    source,
  });
  logger?.info(`Order ${order.id} moved to ${nextStatus} via ${source}.`);
  return updated;
}

/**
 * Applies a `GET /api/v1/payments/:id` response to the local order.
 * @param {{db: import('./db.js').StoreDb, order: any, payment: any, source: string, logger?: any}} input
 */
export function applyGatewaySnapshot({ db, order, payment, source, logger }) {
  if (!order) return null;
  const gatewayStatus = normalizeGatewayStatus(payment.internalStatus || payment.status);

  if (gatewayStatus === 'SUCCESS') {
    return markOrderPaid({ db, order, payment, source, logger });
  }

  if (TERMINAL_FAILURES.has(gatewayStatus)) {
    const reason =
      gatewayStatus === 'EXPIRED'
        ? 'The payment session expired before it was confirmed.'
        : gatewayStatus === 'CANCELLED'
          ? 'The payment was cancelled.'
          : 'The payment failed.';
    return markOrderTerminal({ db, order, status: gatewayStatus, reason, source, logger });
  }

  if (gatewayStatus && gatewayStatus !== order.gatewayStatus) {
    return db.updateOrder(order.id, {
      gatewayStatus,
      gatewayPaymentId: payment.paymentId || order.gatewayPaymentId,
    });
  }

  return order;
}

/**
 * Polls the gateway for one order. Network errors are logged and the local
 * state is returned unchanged so the storefront can keep waiting.
 */
export async function refreshOrder({ db, gateway, order, logger }) {
  if (!order || order.status !== 'PENDING' || !order.gatewayPaymentId) return order;
  try {
    const payment = await gateway.getPayment(order.gatewayPaymentId);
    return applyGatewaySnapshot({ db, order, payment, source: 'poll', logger });
  } catch (error) {
    if (error?.status === 404) {
      return markOrderTerminal({
        db,
        order,
        status: 'FAILED',
        reason: 'The payment session no longer exists at the gateway.',
        source: 'poll',
        logger,
      });
    }
    logger?.warn(`Could not refresh order ${order.id}:`, error?.message || error);
    return order;
  }
}

/**
 * @param {{db: import('./db.js').StoreDb, payload: any, logger?: any}} input
 */
export function handleWebhook({ db, payload, logger }) {
  const order = db.getOrder(payload.orderId) || db.getOrderByPaymentId(payload.paymentId);
  const check = validateWebhookAgainstOrder(payload, order);
  if (!check.ok) {
    const status = order ? 400 : 404;
    throw new OrderError(check.reason || 'Webhook does not match an order.', {
      status,
      code: order ? 'WEBHOOK_ORDER_MISMATCH' : 'WEBHOOK_ORDER_NOT_FOUND',
    });
  }

  const alreadyPaid = order.status === 'PAID';
  let updated;

  if (payload.event === 'SUCCESS') {
    updated = markOrderPaid({ db, order, payment: payload, source: 'webhook', logger });
  } else {
    const reason =
      payload.event === 'EXPIRED'
        ? 'The payment session expired before it was confirmed.'
        : payload.event === 'CANCELLED'
          ? 'The payment was cancelled.'
          : 'The payment failed.';
    updated = markOrderTerminal({
      db,
      order,
      status: payload.event,
      reason,
      source: 'webhook',
      logger,
    });
  }

  return {
    order: updated,
    applied: !alreadyPaid && updated?.status !== order.status,
  };
}

/**
 * @param {import('./db.js').StoreDb} db
 * @param {any} order
 * @param {{events?: boolean}} [options]
 */
export function serializeOrder(db, order, { events = false } = {}) {
  if (!order) return null;
  return {
    id: order.id,
    status: order.status,
    gatewayStatus: order.gatewayStatus,
    quantity: order.quantity,
    amountPaise: order.amountPaise,
    amountFormatted: formatInr(order.amountPaise),
    currency: order.currency,
    product: {
      id: PRODUCT.id,
      name: PRODUCT.name,
      subtitle: PRODUCT.subtitle,
      image: PRODUCT.image,
      pricePaise: PRODUCT.pricePaise,
      priceFormatted: formatInr(PRODUCT.pricePaise),
    },
    customer: {
      name: order.customerName,
      email: order.customerEmail,
      phone: order.customerPhone,
    },
    shipping: {
      address: order.shipAddress,
      city: order.shipCity,
      pincode: order.shipPincode,
    },
    checkoutUrl: order.status === 'PENDING' ? order.checkoutUrl : null,
    canPay: order.status === 'PENDING' && Boolean(order.checkoutUrl),
    payment: {
      id: order.gatewayPaymentId,
      method: order.paymentMethod,
      utr: order.utr,
      verificationLevel: order.verificationLevel,
      verificationTag: order.verificationTag,
    },
    demo: {
      simulatedAt: order.simulatedAt,
      simulationAttempts: order.simulationAttempts,
      simulationError: order.simulationError,
    },
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paidAt: order.paidAt,
    failureReason: order.failureReason,
    ...(events ? { events: db.listEvents(order.id) } : {}),
  };
}

/**
 * @param {{db: import('./db.js').StoreDb, orderId: string, token: string}} input
 */
export function getOrderForToken({ db, orderId, token }) {
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(String(orderId || ''))) {
    throw new OrderError('Order not found.', { status: 404, code: 'ORDER_NOT_FOUND' });
  }
  const order = db.getOrder(orderId);
  if (!order) {
    throw new OrderError('Order not found.', { status: 404, code: 'ORDER_NOT_FOUND' });
  }
  if (!tokensMatch(token, order.accessTokenHash)) {
    throw new OrderError('This order link is not valid.', {
      status: 401,
      code: 'INVALID_ORDER_TOKEN',
    });
  }
  return order;
}

/**
 * Resolves a batch of browser-remembered order references.
 * @param {{db: import('./db.js').StoreDb, entries: unknown}} input
 */
export function lookupOrders({ db, entries }) {
  if (!Array.isArray(entries)) {
    throw new OrderError('A list of orders is required.', {
      status: 400,
      code: 'INVALID_LOOKUP',
    });
  }
  if (entries.length > 50) {
    throw new OrderError('You can look up at most 50 orders at a time.', {
      status: 400,
      code: 'LOOKUP_TOO_LARGE',
    });
  }

  const orders = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '');
    const token = String(entry.token || '');
    if (!id || !token) continue;
    try {
      const order = getOrderForToken({ db, orderId: id, token });
      orders.push(order);
    } catch {
      // A stale browser entry is not an error: skip it silently.
    }
  }

  orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return orders;
}
