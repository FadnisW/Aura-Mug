import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import {
  delay,
  gatewayRoot,
  isPortFree,
  projectRoot,
  readEnvFile,
  startService,
  stopService,
  waitForHttp,
} from './lib/dev-utils.mjs';
import { configureGateway } from './configure-gateway.mjs';

const logger = createLogger('dev');

function fail(message) {
  logger.error(message);
  process.exit(1);
}

async function main() {
  let config;
  try {
    config = validateConfig(loadConfig());
  } catch (error) {
    fail(`${error.message || error}\nRun "npm run setup" first.`);
  }

  const gatewayEnvFile = path.join(gatewayRoot, '.env');
  if (!fs.existsSync(gatewayEnvFile)) {
    fail('The gateway .env is missing. Run "npm run setup" first.');
  }

  const gatewayEnvFromFile = readEnvFile(gatewayEnvFile);
  const paymentApiPort = Number(gatewayEnvFromFile.PAYMENT_API_PORT || 6100);
  const checkoutPort = Number(gatewayEnvFromFile.CHECKOUT_PORTAL_PORT || 7000);

  const ports = [
    { name: 'store', port: config.port },
    { name: 'payment API', port: paymentApiPort },
    { name: 'checkout portal', port: checkoutPort },
  ];
  for (const { name, port } of ports) {
    if (!(await isPortFree(port))) {
      fail(`Port ${port} (${name}) is already in use. Stop the other process and try again.`);
    }
  }

  const gatewayEnv = {
    ...process.env,
    ...gatewayEnvFromFile,
    NODE_ENV: 'development',
    YOUPI_MODE: 'localhost',
    YOUPI_ALLOW_LOCALHOST_MODE: 'true',
    YOUPI_EXPOSE_DEV_OTP: 'true',
    YOUPI_ALLOW_DEV_TOOLS: 'true',
    YOUPI_ALLOW_PRIVATE_WEBHOOKS: 'true',
    // Local demo convenience: allow re-running the OTP flow without waiting 30s.
    OTP_RESEND_COOLDOWN_MS: '0',
    YOUPI_BIND_HOST: '127.0.0.1',
    PAYMENT_API_PORT: String(paymentApiPort),
    CHECKOUT_PORTAL_PORT: String(checkoutPort),
    BASE_PAYMENT_API_URL: `http://127.0.0.1:${paymentApiPort}`,
    BASE_CHECKOUT_URL: `http://127.0.0.1:${checkoutPort}`,
    BASE_DEMO_STORE_URL: config.publicBaseUrl,
    ADMIN_API_TOKEN: config.adminToken,
    COIN_STORE_WEBHOOK_SECRET: config.webhookSecret,
  };

  const services = [];
  let stopping = false;

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    logger.info('Stopping services ...');
    for (const service of [...services].reverse()) {
      await stopService(service);
    }
    process.exit(code);
  }

  const onExit = (name, code, signal) => {
    if (stopping) return;
    logger.error(`${name} exited unexpectedly (code ${code}, signal ${signal || 'none'}).`);
    shutdown(1);
  };

  process.on('SIGINT', () => {
    logger.info('Ctrl+C received.');
    shutdown(0);
  });
  process.on('SIGTERM', () => shutdown(0));

  logger.info('Starting UPI-PG payment API ...');
  services.push(
    startService({
      name: 'gateway-api',
      command: process.execPath,
      args: [path.join(gatewayRoot, 'apps', 'payment-api', 'src', 'index.js')],
      cwd: gatewayRoot,
      env: gatewayEnv,
      onExit,
    }),
  );

  try {
    await waitForHttp(`http://127.0.0.1:${paymentApiPort}/api/v1/health`, {
      timeoutMs: 30_000,
      label: 'payment API',
    });
  } catch (error) {
    logger.error(error.message);
    await shutdown(1);
    return;
  }

  logger.info('Configuring the gateway webhook and branding ...');
  try {
    await configureGateway(config);
  } catch (error) {
    logger.error(`Gateway configuration failed: ${error.message || error}`);
    await shutdown(1);
    return;
  }

  logger.info('Starting the hosted checkout portal ...');
  services.push(
    startService({
      name: 'checkout',
      command: process.execPath,
      args: [path.join(gatewayRoot, 'apps', 'checkout-portal', 'src', 'index.js')],
      cwd: gatewayRoot,
      env: gatewayEnv,
      onExit,
    }),
  );

  try {
    await waitForHttp(`http://127.0.0.1:${checkoutPort}/health`, {
      timeoutMs: 20_000,
      label: 'checkout portal',
    });
  } catch (error) {
    logger.error(error.message);
    await shutdown(1);
    return;
  }

  logger.info('Starting the AURA storefront ...');
  services.push(
    startService({
      name: 'store',
      command: process.execPath,
      args: [path.join(projectRoot, 'server.js')],
      cwd: projectRoot,
      env: { ...process.env },
      onExit,
    }),
  );

  try {
    await waitForHttp(`${config.publicBaseUrl}/api/health`, {
      timeoutMs: 20_000,
      label: 'storefront',
    });
  } catch (error) {
    logger.error(error.message);
    await shutdown(1);
    return;
  }

  await delay(250);
  console.log(`
============================================================
  AURA is running

  Storefront      ${config.publicBaseUrl}
  Payment API     http://127.0.0.1:${paymentApiPort}
  Hosted checkout http://127.0.0.1:${checkoutPort}

  Demo mode is on. Payments are simulated by UPI-PG.
  Press Ctrl+C to stop everything.
============================================================
`);
}

main().catch((error) => {
  logger.error('Development stack failed:', error?.stack || error);
  process.exit(1);
});
