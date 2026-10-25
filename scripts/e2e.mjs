import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { demoUtr } from '../src/gateway.js';
import {
  delay,
  gatewayRoot,
  isPortFree,
  projectRoot,
  randomSecret,
  startService,
  stopService,
  waitForHttp,
} from './lib/dev-utils.mjs';
import { configureGateway } from './configure-gateway.mjs';

const logger = createLogger('e2e');
const MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const STORE_PORT = 5180;
const PAYMENT_API_PORT = 6180;
const CHECKOUT_PORT = 7180;

const storeUrl = `http://127.0.0.1:${STORE_PORT}`;
const gatewayUrl = `http://127.0.0.1:${PAYMENT_API_PORT}`;

function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

async function requestJson(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 750, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function main() {
  for (const port of [STORE_PORT, PAYMENT_API_PORT, CHECKOUT_PORT]) {
    if (!(await isPortFree(port))) {
      throw new Error(`Port ${port} is already in use. Stop the other process first.`);
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-e2e-'));
  const adminToken = randomSecret(32);
  const webhookSecret = randomSecret(32);

  const gatewayEnv = {
    ...process.env,
    NODE_ENV: 'development',
    YOUPI_MODE: 'localhost',
    YOUPI_ALLOW_LOCALHOST_MODE: 'true',
    YOUPI_EXPOSE_DEV_OTP: 'true',
    YOUPI_ALLOW_DEV_TOOLS: 'true',
    YOUPI_ALLOW_PRIVATE_WEBHOOKS: 'true',
    YOUPI_BIND_HOST: '127.0.0.1',
    PAYMENT_API_PORT: String(PAYMENT_API_PORT),
    CHECKOUT_PORTAL_PORT: String(CHECKOUT_PORT),
    COIN_WALLET_STORE_PORT: String(STORE_PORT + 1),
    BASE_PAYMENT_API_URL: gatewayUrl,
    BASE_CHECKOUT_URL: `http://127.0.0.1:${CHECKOUT_PORT}`,
    BASE_DEMO_STORE_URL: storeUrl,
    SQLITE_DB_PATH: path.join(tempDir, 'gateway.sqlite'),
    ADMIN_API_TOKEN: adminToken,
    COIN_STORE_WEBHOOK_SECRET: webhookSecret,
    PAYMENT_ACTIVE_WINDOW_MS: '120000',
  };

  const storeEnv = {
    ...process.env,
    PORT: String(STORE_PORT),
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: storeUrl,
    GATEWAY_API_URL: gatewayUrl,
    GATEWAY_CHECKOUT_URL: `http://127.0.0.1:${CHECKOUT_PORT}`,
    MERCHANT_ID,
    MERCHANT_KEY: webhookSecret,
    WEBHOOK_SECRET: webhookSecret,
    ADMIN_API_TOKEN: adminToken,
    DEMO_MODE: 'true',
    DEMO_AUTO_CONFIRM: 'false',
    STORE_DB_PATH: path.join(tempDir, 'store.sqlite'),
    ORDER_EXPIRY_MINUTES: '15',
  };

  const storeConfig = {
    ...loadConfig(),
    host: '127.0.0.1',
    port: STORE_PORT,
    publicBaseUrl: storeUrl,
    gatewayApiUrl: gatewayUrl,
    gatewayCheckoutUrl: `http://127.0.0.1:${CHECKOUT_PORT}`,
    merchantId: MERCHANT_ID,
    merchantKey: webhookSecret,
    webhookSecret,
    adminToken,
    demoMode: true,
    demoAutoConfirm: false,
    dbPath: path.join(tempDir, 'store.sqlite'),
    orderExpiryMinutes: 15,
  };

  const services = [];
  let failure = null;

  try {
    logger.info('Starting the gateway payment API ...');
    services.push(
      startService({
        name: 'e2e-gateway',
        command: process.execPath,
        args: [path.join(gatewayRoot, 'apps', 'payment-api', 'src', 'index.js')],
        cwd: gatewayRoot,
        env: gatewayEnv,
      }),
    );
    await waitForHttp(`${gatewayUrl}/api/v1/health`, {
      timeoutMs: 30_000,
      label: 'gateway payment API',
    });

    logger.info('Configuring the gateway ...');
    await configureGateway(storeConfig);

    logger.info('Starting the checkout portal ...');
    services.push(
      startService({
        name: 'e2e-checkout',
        command: process.execPath,
        args: [path.join(gatewayRoot, 'apps', 'checkout-portal', 'src', 'index.js')],
        cwd: gatewayRoot,
        env: gatewayEnv,
      }),
    );
    await waitForHttp(`http://127.0.0.1:${CHECKOUT_PORT}/health`, {
      timeoutMs: 20_000,
      label: 'checkout portal',
    });

    logger.info('Starting the storefront ...');
    services.push(
      startService({
        name: 'e2e-store',
        command: process.execPath,
        args: [path.join(projectRoot, 'server.js')],
        cwd: projectRoot,
        env: storeEnv,
      }),
    );
    await waitForHttp(`${storeUrl}/api/health`, {
      timeoutMs: 20_000,
      label: 'storefront',
    });

    const unique = Date.now().toString().slice(-9);
    const mobile = `9${unique}`;
    const email = `e2e-${Date.now()}@example.com`;
    const customerName = 'E2E Tester';

    logger.info('Creating an order ...');
    const created = await requestJson(`${storeUrl}/api/orders`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: {
        quantity: 2,
        customer: { name: customerName, email, phone: mobile },
        shipping: {
          address: '12 Test Lane, Indiranagar',
          city: 'Bengaluru',
          pincode: '560038',
        },
      },
    });

    assert.equal(created.order.status, 'PENDING', 'A new order should start as PENDING');
    assert.equal(created.order.amountPaise, 179800, 'Two mugs should cost ₹1,798');
    assert.ok(created.order.id, 'Order id is required');
    assert.ok(created.accessToken, 'An order access token is required');
    assert.ok(created.checkoutUrl, 'A hosted checkout URL is required');
    const orderId = created.order.id;
    const accessToken = created.accessToken;
    const paymentId = created.order.payment.id;
    assert.ok(paymentId, 'A gateway payment id is required');

    const orderHeaders = { Authorization: `Bearer ${accessToken}` };
    const merchantHeaders = {
      'X-Merchant-Id': MERCHANT_ID,
      'X-Merchant-Key': webhookSecret,
    };
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'X-Merchant-Id': MERCHANT_ID,
    };

    logger.info('Authenticating a gateway customer with WhatsApp OTP ...');
    const otpSent = await requestJson(`${gatewayUrl}/api/v1/customer/send-otp`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: {
        mobileNumber: mobile,
        name: customerName,
        email,
        isNewUser: true,
      },
    });
    assert.match(String(otpSent.devOtp || ''), /^\d{6}$/, 'The dev OTP should be exposed');

    const verified = await requestJson(`${gatewayUrl}/api/v1/customer/verify-otp`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: { mobileNumber: mobile, otp: otpSent.devOtp },
    });
    assert.ok(verified.token, 'A customer session token is required');
    assert.ok(verified.customerId, 'A customer id is required');

    logger.info('Binding the customer to the payment session ...');
    await requestJson(`${gatewayUrl}/api/v1/checkout/${paymentId}/bind-customer`, {
      method: 'POST',
      headers: jsonHeaders({ Authorization: `Bearer ${verified.token}` }),
      body: { token: verified.token, customerId: verified.customerId },
    });

    logger.info('Waiting for the payment slot to become ACTIVE ...');
    const activePayment = await waitFor(
      async () => {
        const payment = await requestJson(`${gatewayUrl}/api/v1/payments/${paymentId}`, {
          headers: merchantHeaders,
        });
        const status = payment.internalStatus || payment.status;
        if (status === 'ACTIVE' || status === 'PROCESSING') return payment;
        if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(status)) {
          throw new Error(`Payment became ${status} instead of ACTIVE`);
        }
        return null;
      },
      { timeoutMs: 30_000, intervalMs: 600, label: 'ACTIVE payment session' },
    );
    assert.ok(activePayment.paymentId, 'The payment should be readable');

    logger.info('Enabling gateway test mode and injecting a synthetic bank credit ...');
    await requestJson(`${gatewayUrl}/api/v1/admin/dev/test-mode`, {
      method: 'POST',
      headers: jsonHeaders(adminHeaders),
      body: { enabled: true },
    });

    const utr = demoUtr(paymentId);
    const amount = (created.order.amountPaise / 100).toFixed(2);
    const injected = await requestJson(`${gatewayUrl}/api/v1/admin/dev/simulator/inject`, {
      method: 'POST',
      headers: jsonHeaders(adminHeaders),
      body: {
        paymentSessionId: paymentId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: `A/C XX9999 credited with Rs ${amount} CR. Ref ${utr}`,
        receivedAt: new Date().toISOString(),
      },
    });
    assert.notEqual(injected.success, false, 'The gateway should accept the simulated credit');

    logger.info('Waiting for the signed webhook to mark the order paid ...');
    const paid = await waitFor(
      async () => {
        const result = await requestJson(`${storeUrl}/api/orders/${orderId}?refresh=1`, {
          headers: orderHeaders,
        });
        return result.order.status === 'PAID' ? result.order : null;
      },
      { timeoutMs: 30_000, intervalMs: 750, label: 'PAID store order' },
    );

    assert.equal(paid.amountPaise, 179800, 'The paid amount should match');
    assert.equal(paid.payment.utr, utr, 'The webhook UTR should match the simulated bank reference');
    assert.ok(paid.payment.verificationTag, 'The payment should carry a verification tag');
    assert.ok(
      Number(paid.payment.verificationLevel) >= 1,
      'The payment should have a positive verification level',
    );
    assert.ok(paid.paidAt, 'A paid timestamp is required');
    assert.ok(
      paid.events.some((event) => event.type === 'order.paid'),
      'A paid event should be recorded',
    );

    const history = await requestJson(`${storeUrl}/api/orders/lookup`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: { orders: [{ id: orderId, token: accessToken }] },
    });
    assert.equal(history.orders.length, 1, 'Order history should find the order');
    assert.equal(history.orders[0].status, 'PAID', 'Order history should show PAID');

    console.log(`
============================================================
  E2E PASS
  Order ${orderId} paid ₹1,798.00
  UTR ${utr} · verification ${paid.payment.verificationTag}
============================================================
`);
  } catch (error) {
    failure = error;
    logger.error('E2E failed:', error?.stack || error);
  } finally {
    for (const service of [...services].reverse()) {
      await stopService(service);
    }
    await delay(300);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort.
    }
  }

  if (failure) process.exit(1);
}

main().catch((error) => {
  logger.error('E2E crashed:', error?.stack || error);
  process.exit(1);
});
