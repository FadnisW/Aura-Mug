import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { GatewayClient } from '../src/gateway.js';
import { delay } from './lib/dev-utils.mjs';

const logger = createLogger('configure');

async function waitForGateway(gateway, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await gateway.health();
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(
    `The payment API did not become ready: ${lastError?.message || 'no response'}`,
  );
}

/**
 * Points the local gateway at this store's webhook and applies AURA branding.
 * Safe to run repeatedly.
 * @param {ReturnType<typeof loadConfig>} config
 */
export async function configureGateway(config) {
  const gateway = new GatewayClient(config, logger);
  await waitForGateway(gateway);

  const webhookUrl = `${config.publicBaseUrl}/api/webhooks/upi-pg`;

  await gateway.updateMerchantSettings({
    businessName: 'AURA',
    webhookUrl,
    webhookSecret: config.webhookSecret,
    sellingMode: 'ONLINE',
    enabledPaymentMethods: ['UPI'],
    codEnabled: false,
    cashEnabled: false,
    cardEnabled: false,
    branding: {
      appName: 'AURA',
      primaryColor: '#b4552d',
      headerTheme: 'gradient',
      checkoutNotice: 'AURA demo checkout · payments are simulated by UPI-PG',
      footerGuarantee: 'Demo store — no real money moves.',
      supportEmails: ['care@aura.example'],
      hidePoweredBy: false,
    },
  });

  const settings = await gateway.getMerchantSettings();
  if (settings.webhookUrl !== webhookUrl) {
    throw new Error(
      `The gateway did not accept the webhook URL (expected ${webhookUrl}, got ${settings.webhookUrl || 'none'}).`,
    );
  }
  if (settings.webhookSecret !== config.webhookSecret) {
    throw new Error('The gateway webhook secret does not match the store secret.');
  }

  logger.info(`Gateway configured for ${settings.businessName} (${settings.merchantId}).`);
  logger.info(`Webhook: ${settings.webhookUrl}`);
  return settings;
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const config = validateConfig(loadConfig());
    await configureGateway(config);
  } catch (error) {
    logger.error(error.message || error);
    process.exit(1);
  }
}
