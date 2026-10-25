import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT,
  calculateAmountPaise,
  formatInr,
  toGatewayAmount,
} from '../src/product.js';
import {
  ValidationError,
  isValidEmail,
  isValidPhone,
  isValidPincode,
  normalizePhone,
  validateOrderInput,
} from '../src/validate.js';
import {
  WebhookPayloadError,
  computeSignature,
  computeSignatureV2,
  parseWebhookPayload,
  sha256Hex,
  validateWebhookAgainstOrder,
  verifyWebhookSignature,
} from '../src/webhooks.js';
import {
  OrderError,
  applyGatewaySnapshot,
  buildReturnUrl,
  createOrder,
  generateAccessToken,
  generateOrderId,
  getOrderForToken,
  handleWebhook,
  lookupOrders,
  markOrderPaid,
  markOrderTerminal,
  refreshOrder,
  serializeOrder,
} from '../src/orders.js';
import {
  GatewayClient,
  GatewayError,
  buildCreditSms,
  demoUtr,
} from '../src/gateway.js';
import {
  buildWebhookPayload,
  createMemoryDb,
  hashToken,
  seedOrder,
  silentLogger,
  signedRequest,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Product maths
// ---------------------------------------------------------------------------

test('product pricing is derived on the server from quantity', () => {
  assert.equal(PRODUCT.pricePaise, 89900);
  assert.equal(calculateAmountPaise(1), 89900);
  assert.equal(calculateAmountPaise(3), 269700);
  assert.equal(calculateAmountPaise(10), 899000);
});

test('calculateAmountPaise rejects quantities outside the catalog limits', () => {
  for (const value of [0, -1, 11, 1.5, 'many', null, undefined]) {
    assert.throws(
      () => calculateAmountPaise(value),
      (error) => error.code === 'INVALID_QUANTITY',
      `expected ${String(value)} to be rejected`,
    );
  }
});

test('toGatewayAmount sends a decimal string, not paise', () => {
  assert.equal(toGatewayAmount(89900), '899.00');
  assert.equal(toGatewayAmount(269700), '2697.00');
  assert.equal(toGatewayAmount(1), '0.01');
});

test('formatInr renders Indian rupee amounts without unnecessary decimals', () => {
  assert.equal(formatInr(89900).replace(/\s/g, ''), '₹899');
  assert.equal(formatInr(123456).replace(/\s/g, ''), '₹1,234.56');
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('normalizePhone accepts the common Indian formats', () => {
  assert.equal(normalizePhone('9876543210'), '9876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210');
  assert.equal(normalizePhone('098765 43210'), '9876543210');
  assert.equal(normalizePhone('91-9876543210'), '9876543210');
  assert.equal(normalizePhone(''), '');
});

test('isValidPhone requires a real Indian mobile prefix', () => {
  assert.equal(isValidPhone('9876543210'), true);
  assert.equal(isValidPhone('+91 98765 43210'), true);
  assert.equal(isValidPhone('5876543210'), false);
  assert.equal(isValidPhone('987654321'), false);
  assert.equal(isValidPhone('98765432101'), false);
  assert.equal(isValidPhone('not-a-number'), false);
});

test('isValidEmail and isValidPincode enforce the storefront rules', () => {
  assert.equal(isValidEmail('ananya@example.com'), true);
  assert.equal(isValidEmail('  Ananya@Example.CO  '), true);
  assert.equal(isValidEmail('ananya@example'), false);
  assert.equal(isValidEmail('ananya example.com'), false);
  assert.equal(isValidEmail('a@b.c'), false);

  assert.equal(isValidPincode('560038'), true);
  assert.equal(isValidPincode('060038'), false);
  assert.equal(isValidPincode('56003'), false);
  assert.equal(isValidPincode('5600388'), false);
});

test('validateOrderInput normalizes a complete checkout payload', () => {
  const result = validateOrderInput({
    quantity: 2,
    customer: {
      name: '  Ananya   Rao ',
      email: '  Ananya@Example.COM ',
      phone: '+91 98765 43210',
    },
    shipping: {
      address: '  12,  100 Feet Road, Indiranagar ',
      city: '  Bengaluru ',
      pincode: ' 560038 ',
    },
  });

  assert.deepEqual(result, {
    quantity: 2,
    customer: {
      name: 'Ananya Rao',
      email: 'ananya@example.com',
      phone: '9876543210',
    },
    shipping: {
      address: '12, 100 Feet Road, Indiranagar',
      city: 'Bengaluru',
      pincode: '560038',
    },
  });
});

test('validateOrderInput reports the field for each invalid value', () => {
  const valid = {
    quantity: 1,
    customer: { name: 'Ananya Rao', email: 'ananya@example.com', phone: '9876543210' },
    shipping: { address: '12, Indiranagar', city: 'Bengaluru', pincode: '560038' },
  };

  const cases = [
    [null, null, 'A checkout payload is required.'],
    [{ ...valid, quantity: 0 }, 'quantity', 'between 1 and 10'],
    [{ ...valid, quantity: 11 }, 'quantity', 'between 1 and 10'],
    [{ ...valid, quantity: 2.5 }, 'quantity', 'between 1 and 10'],
    [{ ...valid, customer: { ...valid.customer, name: 'A' } }, 'name', 'required'],
    [{ ...valid, customer: { ...valid.customer, email: 'nope' } }, 'email', 'valid email'],
    [{ ...valid, customer: { ...valid.customer, phone: '12345' } }, 'phone', 'mobile number'],
    [{ ...valid, shipping: { ...valid.shipping, address: 'x' } }, 'address', 'required'],
    [{ ...valid, shipping: { ...valid.shipping, city: '' } }, 'city', 'required'],
    [{ ...valid, shipping: { ...valid.shipping, pincode: '012345' } }, 'pincode', 'PIN code'],
  ];

  for (const [body, field, message] of cases) {
    assert.throws(
      () => validateOrderInput(body),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'INVALID_INPUT');
        assert.equal(error.field, field);
        assert.match(error.message, new RegExp(message, 'i'));
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Webhook signatures and payloads
// ---------------------------------------------------------------------------

const SECRET = 'test-secret';
const RAW_BODY = '{"hello":"world"}';
const TIMESTAMP = '1767225600000';

test('sha256Hex and signature helpers are stable', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    computeSignatureV2(SECRET, TIMESTAMP, RAW_BODY),
    computeSignature(SECRET, `${TIMESTAMP}.${RAW_BODY}`),
  );
  assert.match(computeSignature(SECRET, RAW_BODY), /^[0-9a-f]{64}$/);
});

test('verifyWebhookSignature accepts a correct V2 signature', () => {
  const headers = {
    'x-gateway-timestamp': TIMESTAMP,
    'x-gateway-signature-v2': `sha256=${computeSignatureV2(SECRET, TIMESTAMP, RAW_BODY)}`,
  };
  assert.deepEqual(verifyWebhookSignature({ rawBody: RAW_BODY, headers, secret: SECRET }), {
    valid: true,
    scheme: 'v2',
  });
});

test('verifyWebhookSignature accepts V1 only when V2 is absent', () => {
  const v1 = `sha256=${computeSignature(SECRET, RAW_BODY)}`;
  assert.deepEqual(
    verifyWebhookSignature({
      rawBody: RAW_BODY,
      headers: { 'x-gateway-signature': v1 },
      secret: SECRET,
    }),
    { valid: true, scheme: 'v1' },
  );

  // A present-but-invalid V2 header must not fall back to a valid V1 header.
  const downgrade = verifyWebhookSignature({
    rawBody: RAW_BODY,
    headers: {
      'x-gateway-timestamp': TIMESTAMP,
      'x-gateway-signature-v2': 'sha256=deadbeef',
      'x-gateway-signature': v1,
    },
    secret: SECRET,
  });
  assert.equal(downgrade.valid, false);
  assert.equal(downgrade.scheme, 'v2');
});

test('verifyWebhookSignature rejects missing, malformed, and stale signatures', () => {
  assert.equal(
    verifyWebhookSignature({ rawBody: RAW_BODY, headers: {}, secret: SECRET }).valid,
    false,
  );
  assert.equal(
    verifyWebhookSignature({ rawBody: RAW_BODY, headers: {}, secret: '' }).valid,
    false,
  );
  assert.equal(
    verifyWebhookSignature({ rawBody: '', headers: {}, secret: SECRET }).valid,
    false,
  );
  assert.equal(
    verifyWebhookSignature({
      rawBody: RAW_BODY,
      headers: {
        'x-gateway-timestamp': TIMESTAMP,
        'x-gateway-signature-v2': `sha256=${computeSignatureV2(SECRET, TIMESTAMP, RAW_BODY)}`,
      },
      secret: SECRET,
    }).valid,
    true,
  );
  assert.equal(
    verifyWebhookSignature({
      rawBody: RAW_BODY,
      headers: {
        'x-gateway-timestamp': TIMESTAMP,
        'x-gateway-signature-v2': `sha256=${computeSignatureV2('other-secret', TIMESTAMP, RAW_BODY)}`,
      },
      secret: SECRET,
    }).valid,
    false,
  );
  assert.equal(
    verifyWebhookSignature({
      rawBody: `${RAW_BODY} `,
      headers: {
        'x-gateway-timestamp': TIMESTAMP,
        'x-gateway-signature-v2': `sha256=${computeSignatureV2(SECRET, TIMESTAMP, RAW_BODY)}`,
      },
      secret: SECRET,
    }).valid,
    false,
  );
});

test('verifyWebhookSignature requires a timestamp for V2 and reads array headers', () => {
  const signature = `sha256=${computeSignatureV2(SECRET, TIMESTAMP, RAW_BODY)}`;
  const missingTimestamp = verifyWebhookSignature({
    rawBody: RAW_BODY,
    headers: { 'x-gateway-signature-v2': signature },
    secret: SECRET,
  });
  assert.equal(missingTimestamp.valid, false);
  assert.equal(missingTimestamp.reason, 'Missing X-Gateway-Timestamp.');

  const arrayHeader = verifyWebhookSignature({
    rawBody: RAW_BODY,
    headers: {
      'x-gateway-timestamp': [TIMESTAMP],
      'x-gateway-signature-v2': [signature],
    },
    secret: SECRET,
  });
  assert.equal(arrayHeader.valid, true);
});

test('parseWebhookPayload normalizes a gateway payload', () => {
  const { order } = seedOrder(createMemoryDb());
  const payload = parseWebhookPayload(
    JSON.stringify(
      buildWebhookPayload(order, {
        event: 'success',
        currency: 'inr',
        method: 'upi',
        verificationTag: undefined,
        verificationLevel: undefined,
        timestamp: undefined,
      }),
    ),
  );

  assert.equal(payload.event, 'SUCCESS');
  assert.equal(payload.currency, 'INR');
  assert.equal(payload.method, 'UPI');
  assert.equal(payload.verificationTag, 'UNVERIFIED');
  assert.equal(payload.verificationLevel, 0);
  assert.equal(payload.timestamp, null);
  assert.equal(payload.amountPaise, 89900);
  assert.equal(payload.metadata.storeOrderId, order.id);
});

test('parseWebhookPayload rejects malformed and incomplete payloads', () => {
  const { order } = seedOrder(createMemoryDb());
  const valid = buildWebhookPayload(order);

  const cases = [
    ['not json', /valid JSON/],
    ['[]', /JSON object/],
    ['null', /JSON object/],
    [JSON.stringify({ ...valid, event: 'REFUNDED' }), /Unsupported webhook event/],
    [JSON.stringify({ ...valid, deliveryId: '' }), /deliveryId/],
    [JSON.stringify({ ...valid, paymentId: '' }), /paymentId/],
    [JSON.stringify({ ...valid, orderId: '' }), /orderId/],
    [JSON.stringify({ ...valid, amountPaise: 0 }), /amountPaise/],
    [JSON.stringify({ ...valid, amountPaise: 12.5 }), /amountPaise/],
    [JSON.stringify({ ...valid, amountPaise: 'lots' }), /amountPaise/],
  ];

  for (const [body, message] of cases) {
    assert.throws(
      () => parseWebhookPayload(body),
      (error) => {
        assert.ok(error instanceof WebhookPayloadError);
        assert.equal(error.code, 'INVALID_WEBHOOK_PAYLOAD');
        assert.match(error.message, message);
        return true;
      },
    );
  }
});

test('validateWebhookAgainstOrder cross-checks identity, amount, and currency', () => {
  const { order } = seedOrder(createMemoryDb());
  const payload = parseWebhookPayload(JSON.stringify(buildWebhookPayload(order)));

  assert.deepEqual(validateWebhookAgainstOrder(payload, order), { ok: true });
  assert.equal(validateWebhookAgainstOrder(payload, null).ok, false);
  assert.match(
    validateWebhookAgainstOrder(payload, { ...order, id: 'AURA-OTHER-1234' }).reason,
    /orderId/,
  );
  assert.match(
    validateWebhookAgainstOrder(payload, { ...order, gatewayPaymentId: 'pay_other' }).reason,
    /paymentId/,
  );
  assert.match(
    validateWebhookAgainstOrder(payload, { ...order, amountPaise: 1 }).reason,
    /amount/,
  );
  assert.match(
    validateWebhookAgainstOrder(payload, { ...order, currency: 'USD' }).reason,
    /currency/,
  );
});

// ---------------------------------------------------------------------------
// Order lifecycle
// ---------------------------------------------------------------------------

test('generateOrderId and generateAccessToken produce unique, safe identifiers', () => {
  const ids = new Set();
  const tokens = new Set();
  for (let index = 0; index < 100; index += 1) {
    const id = generateOrderId();
    const token = generateAccessToken();
    assert.match(id, /^AURA-[0-9A-Z]+-[0-9A-F]{6}$/);
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    ids.add(id);
    tokens.add(token);
  }
  assert.equal(ids.size, 100);
  assert.equal(tokens.size, 100);
});

test('buildReturnUrl carries the order and token back to the storefront', () => {
  const url = new URL(
    buildReturnUrl({ publicBaseUrl: 'http://127.0.0.1:5000' }, 'AURA-ABC-123456', 'tok en/+'),
  );
  assert.equal(url.origin, 'http://127.0.0.1:5000');
  assert.equal(url.pathname, '/return');
  assert.equal(url.searchParams.get('order'), 'AURA-ABC-123456');
  assert.equal(url.searchParams.get('token'), 'tok en/+');
});

test('createOrder stores a hash, not the access token, and calls the gateway', async () => {
  const db = createMemoryDb();
  const calls = [];
  const gateway = {
    async createPayment({ order, returnUrl }) {
      calls.push({ order, returnUrl });
      return {
        paymentId: 'pay_created_1',
        orderId: order.id,
        checkoutUrl: 'http://127.0.0.1:7000/checkout/session/created',
        status: 'INITIATED',
        queuePosition: 0,
      };
    },
  };

  const result = await createOrder({
    db,
    gateway,
    config: { publicBaseUrl: 'http://127.0.0.1:5000' },
    body: {
      quantity: 2,
      customer: { name: 'Ananya Rao', email: 'ananya@example.com', phone: '9876543210' },
      shipping: { address: '12, Indiranagar', city: 'Bengaluru', pincode: '560038' },
    },
    logger: silentLogger,
  });

  const stored = db.getOrder(result.order.id);
  assert.equal(stored.status, 'PENDING');
  assert.equal(stored.amountPaise, 179800);
  assert.equal(stored.gatewayPaymentId, 'pay_created_1');
  assert.equal(stored.gatewayStatus, 'INITIATED');
  assert.equal(stored.checkoutUrl, 'http://127.0.0.1:7000/checkout/session/created');
  assert.equal(stored.accessTokenHash, hashToken(result.accessToken));
  assert.notEqual(stored.accessTokenHash, result.accessToken);
  assert.equal(result.checkoutUrl, stored.checkoutUrl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].order.id, stored.id);
  assert.match(calls[0].returnUrl, /\/return\?order=/);

  const types = db.listEvents(stored.id).map((event) => event.type);
  assert.deepEqual(types, ['order.created', 'payment.created']);

  const serialized = serializeOrder(db, stored, { events: true });
  assert.equal(serialized.accessTokenHash, undefined);
  assert.equal(serialized.canPay, true);
  assert.equal(serialized.amountFormatted.replace(/\s/g, ''), '₹1,798');
  assert.equal(serialized.events.length, 2);
});

test('createOrder marks the order failed when the gateway cannot create a payment', async () => {
  const db = createMemoryDb();
  let createdId = null;
  const originalCreate = db.createOrder.bind(db);
  db.createOrder = (order) => {
    createdId = order.id;
    return originalCreate(order);
  };

  const gateway = {
    async createPayment() {
      throw new GatewayError('connection refused', { code: 'GATEWAY_UNREACHABLE' });
    },
  };

  await assert.rejects(
    createOrder({
      db,
      gateway,
      config: { publicBaseUrl: 'http://127.0.0.1:5000' },
      body: {
        quantity: 1,
        customer: { name: 'Ananya Rao', email: 'ananya@example.com', phone: '9876543210' },
        shipping: { address: '12, Indiranagar', city: 'Bengaluru', pincode: '560038' },
      },
      logger: silentLogger,
    }),
    (error) => {
      assert.ok(error instanceof OrderError);
      assert.equal(error.status, 502);
      assert.equal(error.code, 'PAYMENT_SETUP_FAILED');
      return true;
    },
  );

  const stored = db.getOrder(createdId);
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.gatewayStatus, 'ERROR');
  assert.match(stored.failureReason, /Could not start the payment/);
  assert.deepEqual(
    db.listEvents(createdId).map((event) => event.type),
    ['order.created', 'order.payment_setup_failed'],
  );
});

test('createOrder rejects invalid input before touching the database or gateway', async () => {
  const db = createMemoryDb();
  let gatewayCalled = false;
  const gateway = {
    async createPayment() {
      gatewayCalled = true;
    },
  };

  await assert.rejects(
    createOrder({
      db,
      gateway,
      config: { publicBaseUrl: 'http://127.0.0.1:5000' },
      body: { quantity: 0, customer: {}, shipping: {} },
      logger: silentLogger,
    }),
    (error) => error instanceof ValidationError && error.field === 'quantity',
  );

  assert.equal(gatewayCalled, false);
  assert.equal(db.stats().total, 0);
});

test('markOrderPaid records payment details once and is idempotent', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const payment = {
    paymentId: order.gatewayPaymentId,
    utr: '123456789012',
    method: 'upi',
    verificationLevel: 1,
    verificationTag: 'Single Verification (SMS_GATEWAY)',
    completedAt: '2026-01-01T00:05:00.000Z',
  };

  const paid = markOrderPaid({ db, order, payment, source: 'webhook', logger: silentLogger });
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.gatewayStatus, 'SUCCESS');
  assert.equal(paid.utr, '123456789012');
  assert.equal(paid.paymentMethod, 'UPI');
  assert.equal(paid.verificationLevel, 1);
  assert.equal(paid.paidAt, '2026-01-01T00:05:00.000Z');

  const events = db.listEvents(order.id);
  assert.equal(events.filter((event) => event.type === 'order.paid').length, 1);
  assert.match(events.at(-1).message, /UTR 123456789012/);

  const again = markOrderPaid({
    db,
    order: db.getOrder(order.id),
    payment: { ...payment, utr: '999999999999' },
    source: 'poll',
    logger: silentLogger,
  });
  assert.equal(again.utr, '123456789012');
  assert.equal(db.listEvents(order.id).filter((event) => event.type === 'order.paid').length, 1);
});

test('markOrderTerminal never downgrades a paid order', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const paid = markOrderPaid({
    db,
    order,
    payment: { paymentId: order.gatewayPaymentId, utr: '123456789012' },
    source: 'webhook',
    logger: silentLogger,
  });

  const after = markOrderTerminal({
    db,
    order: paid,
    status: 'FAILED',
    reason: 'late failure',
    source: 'webhook',
    logger: silentLogger,
  });
  assert.equal(after.status, 'PAID');
  assert.equal(db.getOrder(order.id).status, 'PAID');

  const unknownStatus = markOrderTerminal({
    db,
    order: db.getOrder(order.id),
    status: 'PROCESSING',
    reason: 'not terminal',
    source: 'webhook',
    logger: silentLogger,
  });
  assert.equal(unknownStatus.status, 'PAID');
});

test('markOrderTerminal stores a failure reason', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const failed = markOrderTerminal({
    db,
    order,
    status: 'EXPIRED',
    reason: 'The payment session expired.',
    source: 'webhook',
    logger: silentLogger,
  });
  assert.equal(failed.status, 'EXPIRED');
  assert.equal(failed.failureReason, 'The payment session expired.');
  assert.equal(db.listEvents(order.id).at(-1).type, 'order.expired');
});

test('applyGatewaySnapshot maps gateway statuses onto the local order', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const active = applyGatewaySnapshot({
    db,
    order,
    payment: { paymentId: order.gatewayPaymentId, internalStatus: 'ACTIVE' },
    source: 'poll',
    logger: silentLogger,
  });
  assert.equal(active.status, 'PENDING');
  assert.equal(active.gatewayStatus, 'ACTIVE');

  const expired = applyGatewaySnapshot({
    db,
    order: db.getOrder(order.id),
    payment: { paymentId: order.gatewayPaymentId, internalStatus: 'EXPIRED' },
    source: 'poll',
    logger: silentLogger,
  });
  assert.equal(expired.status, 'EXPIRED');
  assert.match(expired.failureReason, /expired/);

  const paid = applyGatewaySnapshot({
    db,
    order: db.getOrder(order.id),
    payment: {
      paymentId: order.gatewayPaymentId,
      internalStatus: 'SUCCESS',
      utr: '123456789012',
      verificationLevel: 1,
    },
    source: 'poll',
    logger: silentLogger,
  });
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.utr, '123456789012');

  assert.equal(applyGatewaySnapshot({ db, order: null, payment: {}, source: 'poll' }), null);
});

test('refreshOrder polls only pending orders and handles gateway errors', async () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const paid = await refreshOrder({
    db,
    order,
    gateway: {
      async getPayment() {
        return { paymentId: order.gatewayPaymentId, status: 'SUCCESS', utr: '123456789012' };
      },
    },
    logger: silentLogger,
  });
  assert.equal(paid.status, 'PAID');

  const { order: second } = seedOrder(db);
  const missing = await refreshOrder({
    db,
    order: second,
    gateway: {
      async getPayment() {
        throw new GatewayError('not found', { status: 404 });
      },
    },
    logger: silentLogger,
  });
  assert.equal(missing.status, 'FAILED');
  assert.match(missing.failureReason, /no longer exists/);

  const { order: third } = seedOrder(db);
  const unchanged = await refreshOrder({
    db,
    order: third,
    gateway: {
      async getPayment() {
        throw new GatewayError('offline');
      },
    },
    logger: silentLogger,
  });
  assert.equal(unchanged.status, 'PENDING');

  const paidOrder = db.getOrder(order.id);
  const skipped = await refreshOrder({
    db,
    order: paidOrder,
    gateway: {
      async getPayment() {
        throw new Error('should not be called');
      },
    },
    logger: silentLogger,
  });
  assert.equal(skipped.status, 'PAID');
});

test('getOrderForToken enforces both the order id and the access token', () => {
  const db = createMemoryDb();
  const { order, token } = seedOrder(db);

  assert.equal(getOrderForToken({ db, orderId: order.id, token }).id, order.id);
  assert.throws(
    () => getOrderForToken({ db, orderId: order.id, token: 'wrong' }),
    (error) => error instanceof OrderError && error.status === 401 && error.code === 'INVALID_ORDER_TOKEN',
  );
  assert.throws(
    () => getOrderForToken({ db, orderId: '../../etc/passwd', token }),
    (error) => error instanceof OrderError && error.status === 404,
  );
  assert.throws(
    () => getOrderForToken({ db, orderId: 'AURA-NOT-REAL', token }),
    (error) => error instanceof OrderError && error.status === 404,
  );
});

test('lookupOrders silently skips stale entries and sorts newest first', () => {
  const db = createMemoryDb();
  const first = seedOrder(db, { createdAt: '2026-01-01T00:00:01.000Z' });
  const second = seedOrder(db, { createdAt: '2026-01-02T00:00:00.000Z' });
  const third = seedOrder(db, { createdAt: '2026-01-03T00:00:00.000Z' });

  const orders = lookupOrders({
    db,
    entries: [
      { id: first.order.id, token: first.token },
      { id: second.order.id, token: 'wrong' },
      { id: 'AURA-MISSING', token: 'whatever' },
      null,
      { id: third.order.id, token: third.token },
    ],
  });

  assert.deepEqual(
    orders.map((order) => order.id),
    [third.order.id, first.order.id],
  );

  assert.throws(
    () => lookupOrders({ db, entries: 'nope' }),
    (error) => error.code === 'INVALID_LOOKUP',
  );
  assert.throws(
    () => lookupOrders({ db, entries: Array.from({ length: 51 }, () => ({})) }),
    (error) => error.code === 'LOOKUP_TOO_LARGE',
  );
});

test('serializeOrder only exposes a checkout URL while the order is payable', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const pending = serializeOrder(db, order);
  assert.equal(pending.canPay, true);
  assert.equal(pending.checkoutUrl, order.checkoutUrl);

  const paid = markOrderPaid({
    db,
    order,
    payment: { paymentId: order.gatewayPaymentId, utr: '123456789012' },
    source: 'webhook',
    logger: silentLogger,
  });
  const serialized = serializeOrder(db, paid);
  assert.equal(serialized.canPay, false);
  assert.equal(serialized.checkoutUrl, null);
  assert.equal(serialized.events, undefined);
});

// ---------------------------------------------------------------------------
// Demo gateway helpers and client
// ---------------------------------------------------------------------------

test('demoUtr is a stable 12-digit bank reference per payment', () => {
  const first = demoUtr('pay_abc');
  assert.match(first, /^\d{12}$/);
  assert.equal(demoUtr('pay_abc'), first);
  assert.notEqual(demoUtr('pay_xyz'), first);
});

test('buildCreditSms matches the format the gateway parser expects', () => {
  const sms = buildCreditSms(89900, '123456789012');
  assert.equal(sms, 'A/C XX9999 credited with Rs 899.00 CR. Ref 123456789012');
});

test('GatewayClient.createPayment maps the order onto the gateway contract', async () => {
  const client = new GatewayClient(
    {
      gatewayApiUrl: 'http://127.0.0.1:6100',
      merchantId: 'merchant-1',
      merchantKey: 'key-1',
      adminToken: 'admin-1',
      gatewayTimeoutMs: 1000,
    },
    silentLogger,
  );

  const calls = [];
  client.request = async (pathname, options) => {
    calls.push({ pathname, options });
    return {
      paymentId: 'pay_1',
      orderId: 'AURA-1',
      checkoutUrl: 'http://127.0.0.1:7000/checkout/session/1',
      status: 'INITIATED',
    };
  };

  const payment = await client.createPayment({
    order: { id: 'AURA-1', amountPaise: 179800, currency: 'INR', productId: 'aura-mug', quantity: 2 },
    returnUrl: 'http://127.0.0.1:5000/return?order=AURA-1&token=x',
  });

  assert.equal(payment.paymentId, 'pay_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api/v1/payments');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.body, {
    orderId: 'AURA-1',
    amount: '1798.00',
    currency: 'INR',
    returnUrl: 'http://127.0.0.1:5000/return?order=AURA-1&token=x',
    metadata: {
      storeOrderId: 'AURA-1',
      productId: 'aura-mug',
      quantity: 2,
      source: 'aura-upi-store',
    },
  });
});

test('GatewayClient.createPayment rejects responses without a checkout URL', async () => {
  const client = new GatewayClient(
    {
      gatewayApiUrl: 'http://127.0.0.1:6100',
      merchantId: 'merchant-1',
      merchantKey: 'key-1',
      adminToken: 'admin-1',
      gatewayTimeoutMs: 1000,
    },
    silentLogger,
  );
  client.request = async () => ({ paymentId: 'pay_1' });

  await assert.rejects(
    () =>
      client.createPayment({
        order: { id: 'AURA-1', amountPaise: 89900, currency: 'INR', productId: 'aura-mug', quantity: 1 },
        returnUrl: 'http://127.0.0.1:5000/return',
      }),
    (error) =>
      error instanceof GatewayError && error.code === 'INVALID_GATEWAY_RESPONSE',
  );
});

// ---------------------------------------------------------------------------
// handleWebhook unit-level behaviour (full HTTP coverage lives in webhook.test.js)
// ---------------------------------------------------------------------------

test('handleWebhook applies a matching success exactly once', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const payload = parseWebhookPayload(JSON.stringify(buildWebhookPayload(order)));

  const first = handleWebhook({ db, payload, logger: silentLogger });
  assert.equal(first.applied, true);
  assert.equal(first.order.status, 'PAID');

  const second = handleWebhook({ db, payload, logger: silentLogger });
  assert.equal(second.applied, false);
  assert.equal(db.listEvents(order.id).filter((event) => event.type === 'order.paid').length, 1);
});

test('handleWebhook rejects an amount that does not match the local order', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const payload = parseWebhookPayload(
    JSON.stringify(buildWebhookPayload(order, { amountPaise: 1 })),
  );

  assert.throws(
    () => handleWebhook({ db, payload, logger: silentLogger }),
    (error) =>
      error instanceof OrderError &&
      error.status === 400 &&
      error.code === 'WEBHOOK_ORDER_MISMATCH',
  );
  assert.equal(db.getOrder(order.id).status, 'PENDING');
});

test('signedRequest helper produces a verifiable request', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const request = signedRequest(buildWebhookPayload(order));
  assert.equal(
    verifyWebhookSignature({ ...request, secret: 'test-secret' }).valid,
    true,
  );
});
