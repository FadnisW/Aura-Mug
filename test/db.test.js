import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StoreDb } from '../src/db.js';
import { createMemoryDb, seedOrder } from './helpers.js';

test('StoreDb creates an order and maps every column to camelCase', () => {
  const db = createMemoryDb();
  const { order, token } = seedOrder(db, {
    quantity: 3,
    amountPaise: 269700,
    gatewayPaymentId: 'pay_mapped',
    gatewayStatus: 'ACTIVE',
    createdAt: '2026-01-01T10:00:00.000Z',
  });

  assert.equal(order.id.startsWith('AURA-TEST-'), true);
  assert.equal(order.status, 'PENDING');
  assert.equal(order.productId, 'aura-mug');
  assert.equal(order.quantity, 3);
  assert.equal(order.amountPaise, 269700);
  assert.equal(order.currency, 'INR');
  assert.equal(order.gatewayOrderId, order.id);
  assert.equal(order.gatewayPaymentId, 'pay_mapped');
  assert.equal(order.gatewayStatus, 'ACTIVE');
  assert.equal(order.customerName, 'Ananya Rao');
  assert.equal(order.customerEmail, 'ananya@example.com');
  assert.equal(order.customerPhone, '9876543210');
  assert.equal(order.shipAddress, '12, 100 Feet Road, Indiranagar');
  assert.equal(order.shipCity, 'Bengaluru');
  assert.equal(order.shipPincode, '560038');
  assert.equal(order.simulationAttempts, 0);
  assert.equal(order.createdAt, '2026-01-01T10:00:00.000Z');
  assert.equal(order.updatedAt, order.createdAt);
  assert.equal(order.accessTokenHash.length, 64);
  assert.notEqual(order.accessTokenHash, token);

  db.close();
});

test('StoreDb rejects duplicate order ids and unique gateway order ids', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  assert.throws(() => seedOrder(db, { id: order.id }), /UNIQUE|constraint/i);

  assert.throws(
    () =>
      seedOrder(db, {
        id: 'AURA-DUPLICATE-GATEWAY',
        gatewayOrderId: order.gatewayOrderId,
      }),
    /UNIQUE|constraint/i,
  );

  db.close();
});

test('StoreDb looks orders up by id and gateway payment id', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db, { gatewayPaymentId: 'pay_lookup' });

  assert.equal(db.getOrder(order.id).id, order.id);
  assert.equal(db.getOrderByPaymentId('pay_lookup').id, order.id);
  assert.equal(db.getOrder('AURA-NOPE'), null);
  assert.equal(db.getOrderByPaymentId('pay_nope'), null);

  db.close();
});

test('StoreDb updateOrder only writes known columns', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const updated = db.updateOrder(order.id, {
    status: 'PAID',
    utr: '123456789012',
    verificationLevel: 2,
    verificationTag: 'Double Verification',
    paidAt: '2026-01-01T00:10:00.000Z',
    failureReason: null,
    somethingElse: 'ignored',
    accessTokenHash: 'should-not-change',
  });

  assert.equal(updated.status, 'PAID');
  assert.equal(updated.utr, '123456789012');
  assert.equal(updated.verificationLevel, 2);
  assert.equal(updated.verificationTag, 'Double Verification');
  assert.equal(updated.paidAt, '2026-01-01T00:10:00.000Z');
  assert.equal(updated.accessTokenHash, order.accessTokenHash);
  assert.equal(updated.id, order.id);

  const untouched = db.updateOrder(order.id, { notAColumn: true });
  assert.equal(untouched.utr, '123456789012');

  assert.equal(db.updateOrder('AURA-MISSING', { status: 'PAID' }), null);

  db.close();
});

test('StoreDb appends and lists events in insertion order', () => {
  const db = createMemoryDb();
  const { order } = seedOrder(db);

  const created = db.addEvent(order.id, 'order.created', 'Order created.', { quantity: 1 });
  const paid = db.addEvent(order.id, 'order.paid', 'Payment confirmed.');

  assert.equal(created.id, 1);
  assert.equal(paid.id, 2);

  const events = db.listEvents(order.id);
  assert.deepEqual(
    events.map((event) => event.type),
    ['order.created', 'order.paid'],
  );
  assert.deepEqual(events[0].data, { quantity: 1 });
  assert.equal(events[1].data, null);
  assert.equal(events[0].orderId, order.id);
  assert.match(events[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(db.listEvents('AURA-MISSING'), []);

  db.close();
});

test('StoreDb rejects events for unknown orders via the foreign key', () => {
  const db = createMemoryDb();
  assert.throws(() => db.addEvent('AURA-MISSING', 'order.paid', 'Nope.'), /FOREIGN KEY|constraint/i);
  db.close();
});

test('StoreDb lists only pending orders, oldest first, with a limit', () => {
  const db = createMemoryDb();
  seedOrder(db, { createdAt: '2026-01-03T00:00:00.000Z' });
  const older = seedOrder(db, { createdAt: '2026-01-01T00:00:00.000Z' });
  seedOrder(db, { createdAt: '2026-01-02T00:00:00.000Z', status: 'PAID' });

  const pending = db.listPendingOrders();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].id, older.order.id);

  const limited = db.listPendingOrders({ limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, older.order.id);

  db.close();
});

test('StoreDb records webhook deliveries exactly once', () => {
  const db = createMemoryDb();
  const delivery = {
    deliveryId: 'dlv_1',
    event: 'SUCCESS',
    paymentId: 'pay_1',
    orderId: 'AURA-1',
    signatureValid: true,
    bodySha256: 'abc123',
  };

  assert.equal(db.hasDelivery('dlv_1'), false);
  assert.equal(db.recordDelivery(delivery), true);
  assert.equal(db.hasDelivery('dlv_1'), true);
  assert.equal(db.recordDelivery(delivery), false);

  const invalid = db.recordDelivery({ ...delivery, deliveryId: 'dlv_2', signatureValid: false });
  assert.equal(invalid, true);
  assert.equal(db.hasDelivery('dlv_2'), true);

  db.close();
});

test('StoreDb reports totals grouped by status', () => {
  const db = createMemoryDb();
  seedOrder(db);
  seedOrder(db);
  seedOrder(db, { status: 'PAID' });
  seedOrder(db, { status: 'PAID' });
  seedOrder(db, { status: 'FAILED' });

  assert.deepEqual(db.stats(), {
    total: 5,
    byStatus: { PENDING: 2, PAID: 2, FAILED: 1 },
  });

  db.close();
});

test('StoreDb persists orders and events across reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-db-'));
  const file = path.join(directory, 'store.sqlite');

  try {
    const first = new StoreDb(file);
    const { order } = seedOrder(first, { id: 'AURA-PERSIST-0001' });
    first.addEvent(order.id, 'order.created', 'Order created.');
    first.close();

    const second = new StoreDb(file);
    const reloaded = second.getOrder('AURA-PERSIST-0001');
    assert.equal(reloaded.status, 'PENDING');
    assert.equal(reloaded.amountPaise, 89900);
    assert.deepEqual(
      second.listEvents('AURA-PERSIST-0001').map((event) => event.type),
      ['order.created'],
    );
    second.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('StoreDb requires a path and tolerates double close', () => {
  assert.throws(() => new StoreDb(''), /path is required/);
  const db = createMemoryDb();
  db.close();
  db.close();
});
