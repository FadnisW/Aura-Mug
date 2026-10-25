import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEBHOOK_EVENTS,
  parseWebhookPayload,
  sha256Hex,
  verifyWebhookSignature,
} from '../src/webhooks.js';
import { OrderError, handleWebhook } from '../src/orders.js';
import {
  buildWebhookPayload,
  createMemoryDb,
  seedOrder,
  silentLogger,
  signedRequest,
} from './helpers.js';

const SECRET = 'test-secret';

/**
 * Runs the same sequence the HTTP endpoint does: verify the raw body, parse it,
 * record the delivery, then apply it to the order.
 */
function receiveWebhook(db, payload, { secret = SECRET, scheme = 'v2', record = true } = {}) {
  const request = signedRequest(payload, secret, { scheme });
  const verification = verifyWebhookSignature({ ...request, secret });
  if (!verification.valid) {
    return { verification, parsed: null, result: null };
  }

  const parsed = parseWebhookPayload(request.rawBody);
  let firstDelivery = true;
  if (record) {
    firstDelivery = db.recordDelivery({
      deliveryId: parsed.deliveryId,
      event: parsed.event,
      paymentId: parsed.paymentId,
      orderId: parsed.orderId,
      signatureValid: true,
      bodySha256: sha256Hex(request.rawBody),
    });
  }

  if (!firstDelivery) {
    return { verification, parsed, result: { duplicate: true, applied: false } };
  }

  return {
    verification,
    parsed,
    result: handleWebhook({ db, payload: parsed, logger: silentLogger }),
  };
}

test('WEBHOOK_EVENTS is the supported set', () => {
  assert.deepEqual(WEBHOOK_EVENTS, ['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED']);
  assert.equal(Object.isFrozen(WEBHOOK_EVENTS), true);
});

test('a signed SUCCESS webhook marks the order paid with full payment details', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const payload = buildWebhookPayload(order, {
    utr: '987654321098',
    verificationTag: 'Single Verification (SMS_GATEWAY)',
    verificationLevel: 1,
  });

  const { verification, parsed, result } = receiveWebhook(db, payload);
  assert.equal(verification.valid, true);
  assert.equal(verification.scheme, 'v2');
  assert.equal(parsed.event, 'SUCCESS');
  assert.equal(result.applied, true);

  const stored = db.getOrder(order.id);
  assert.equal(stored.status, 'PAID');
  assert.equal(stored.gatewayStatus, 'SUCCESS');
  assert.equal(stored.utr, '987654321098');
  assert.equal(stored.paymentMethod, 'UPI');
  assert.equal(stored.verificationLevel, 1);
  assert.equal(stored.verificationTag, 'Single Verification (SMS_GATEWAY)');
  assert.equal(stored.paidAt, '2026-01-01T00:05:00.000Z');
  assert.equal(stored.failureReason, null);

  const paidEvent = db.listEvents(order.id).at(-1);
  assert.equal(paidEvent.type, 'order.paid');
  assert.equal(paidEvent.data.source, 'webhook');
  assert.equal(paidEvent.data.utr, '987654321098');
});

test('a replayed delivery id is ignored and does not rewrite the order', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const payload = buildWebhookPayload(order);

  const first = receiveWebhook(db, payload);
  assert.equal(first.result.applied, true);

  const second = receiveWebhook(db, payload);
  assert.deepEqual(second.result, { duplicate: true, applied: false });
  assert.equal(db.listEvents(order.id).filter((event) => event.type === 'order.paid').length, 1);
});

test('a repeated SUCCESS with a new delivery id stays idempotent', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  receiveWebhook(db, buildWebhookPayload(order, { utr: '111111111111' }));
  const second = receiveWebhook(
    db,
    buildWebhookPayload(order, { utr: '222222222222', deliveryId: 'dlv_second' }),
  );

  assert.equal(second.result.applied, false);
  assert.equal(db.getOrder(order.id).utr, '111111111111');
  assert.equal(db.listEvents(order.id).filter((event) => event.type === 'order.paid').length, 1);
});

test('a tampered body fails signature verification and changes nothing', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const payload = buildWebhookPayload(order);
  const request = signedRequest(payload);

  // Attacker flips the amount after the signature was computed.
  const tampered = request.rawBody.replace('"amountPaise":89900', '"amountPaise":1');
  const verification = verifyWebhookSignature({
    rawBody: tampered,
    headers: request.headers,
    secret: SECRET,
  });

  assert.equal(verification.valid, false);
  assert.equal(db.getOrder(order.id).status, 'PENDING');
});

test('V1 signatures are accepted when V2 is absent', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const { verification, result } = receiveWebhook(db, buildWebhookPayload(order), {
    scheme: 'v1',
  });
  assert.equal(verification.valid, true);
  assert.equal(verification.scheme, 'v1');
  assert.equal(result.order.status, 'PAID');
});

test('a wrong secret is rejected', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const request = signedRequest(buildWebhookPayload(order), SECRET);

  const verification = verifyWebhookSignature({ ...request, secret: 'wrong-secret' });
  assert.equal(verification.valid, false);
  assert.equal(verification.scheme, 'v2');
  assert.equal(db.getOrder(order.id).status, 'PENDING');
});

test('a FAILED event marks the order failed with a reason', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const { result } = receiveWebhook(db, buildWebhookPayload(order, { event: 'FAILED' }));
  assert.equal(result.applied, true);

  const stored = db.getOrder(order.id);
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.failureReason, 'The payment failed.');
  assert.equal(db.listEvents(order.id).at(-1).type, 'order.failed');
});

test('EXPIRED and CANCELLED events use their specific reasons', () => {
  const db = createMemoryDb();
  const expired = seedOrder(db);
  const cancelled = seedOrder(db);

  receiveWebhook(db, buildWebhookPayload(expired.order, { event: 'EXPIRED' }));
  receiveWebhook(db, buildWebhookPayload(cancelled.order, { event: 'CANCELLED' }));

  assert.match(db.getOrder(expired.order.id).failureReason, /expired/);
  assert.match(db.getOrder(cancelled.order.id).failureReason, /cancelled/);
});

test('a FAILED event never downgrades a paid order', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  receiveWebhook(db, buildWebhookPayload(order));
  const { result } = receiveWebhook(
    db,
    buildWebhookPayload(order, { event: 'FAILED', deliveryId: 'dlv_failure' }),
  );

  assert.equal(result.applied, false);
  assert.equal(db.getOrder(order.id).status, 'PAID');
});

test('a late SUCCESS after FAILED wins, because the bank credit is authoritative', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  receiveWebhook(db, buildWebhookPayload(order, { event: 'FAILED' }));
  assert.equal(db.getOrder(order.id).status, 'FAILED');

  const { result } = receiveWebhook(
    db,
    buildWebhookPayload(order, {
      deliveryId: 'dlv_late_success',
      utr: '444444444444',
    }),
  );

  assert.equal(result.applied, true);
  assert.equal(db.getOrder(order.id).status, 'PAID');
  assert.equal(db.getOrder(order.id).utr, '444444444444');
});

test('a webhook for an unknown order is rejected with 404', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  assert.throws(
    () =>
      handleWebhook({
        db,
        payload: parseWebhookPayload(
          JSON.stringify(
            buildWebhookPayload(order, {
              orderId: 'AURA-UNKNOWN-9999',
              paymentId: 'pay_unknown',
            }),
          ),
        ),
        logger: silentLogger,
      }),
    (error) =>
      error instanceof OrderError &&
      error.status === 404 &&
      error.code === 'WEBHOOK_ORDER_NOT_FOUND',
  );
});

test('a mismatched order id on a known payment is rejected with 400', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  assert.throws(
    () =>
      handleWebhook({
        db,
        payload: parseWebhookPayload(
          JSON.stringify(buildWebhookPayload(order, { orderId: 'AURA-OTHER-0001' })),
        ),
        logger: silentLogger,
      }),
    (error) =>
      error instanceof OrderError &&
      error.status === 400 &&
      error.code === 'WEBHOOK_ORDER_MISMATCH',
  );
});

test('a mismatched payment id is rejected with 400', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  assert.throws(
    () =>
      handleWebhook({
        db,
        payload: parseWebhookPayload(
          JSON.stringify(buildWebhookPayload(order, { paymentId: 'pay_other' })),
        ),
        logger: silentLogger,
      }),
    (error) => error instanceof OrderError && error.status === 400,
  );
});

test('a mismatched amount or currency is rejected with 400', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  for (const overrides of [{ amountPaise: 1 }, { currency: 'USD' }]) {
    assert.throws(
      () =>
        handleWebhook({
          db,
          payload: parseWebhookPayload(
            JSON.stringify(buildWebhookPayload(order, overrides)),
          ),
          logger: silentLogger,
        }),
      (error) => error instanceof OrderError && error.status === 400,
    );
  }

  assert.equal(db.getOrder(order.id).status, 'PENDING');
});

test('a signed payload for a paid order cannot be reused for another order', () => {
  const db = createMemoryDb();
  const first = seedOrder(db);
  const second = seedOrder(db);

  receiveWebhook(db, buildWebhookPayload(first.order));

  // Same signature is valid, but the orderId does not belong to this delivery.
  assert.throws(
    () =>
      handleWebhook({
        db,
        payload: parseWebhookPayload(
          JSON.stringify(
            buildWebhookPayload(second.order, {
              paymentId: first.order.gatewayPaymentId,
            }),
          ),
        ),
        logger: silentLogger,
      }),
    (error) => error instanceof OrderError && error.status === 400,
  );

  assert.equal(db.getOrder(second.order.id).status, 'PENDING');
});

test('the delivery log stores a hash of the raw body', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);
  const payload = buildWebhookPayload(order);
  const request = signedRequest(payload);

  receiveWebhook(db, payload);

  const rows = db.db
    .prepare('SELECT delivery_id, event, payment_id, order_id, signature_valid, body_sha256 FROM webhook_deliveries')
    .all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'SUCCESS');
  assert.equal(rows[0].payment_id, order.gatewayPaymentId);
  assert.equal(rows[0].order_id, order.id);
  assert.equal(rows[0].signature_valid, 1);
  assert.equal(rows[0].body_sha256, sha256Hex(request.rawBody));
});
