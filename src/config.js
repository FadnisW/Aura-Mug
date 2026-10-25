import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const rootDir = path.resolve(__dirname, '..');
export const publicDir = path.join(rootDir, 'public');

/** Loads the project .env file when present. Missing files are fine. */
export function loadEnvFile(file = path.join(rootDir, '.env')) {
  if (typeof process.loadEnvFile !== 'function') return false;
  try {
    if (!fs.existsSync(file)) return false;
    process.loadEnvFile(file);
    return true;
  } catch {
    return false;
  }
}

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value);
}

function envFlag(name, fallback) {
  const raw = env(name, '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function envInt(name, fallback) {
  const value = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

function resolveDbPath(value) {
  if (!value || value === ':memory:') return value || ':memory:';
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

/**
 * Reads configuration from the environment. Call validateConfig before starting.
 * @returns {ReturnType<typeof loadConfig>}
 */
export function loadConfig() {
  loadEnvFile();

  const host = env('HOST', '127.0.0.1').trim() || '127.0.0.1';
  const port = envInt('PORT', 5000);
  const publicBaseUrl = env('PUBLIC_BASE_URL', `http://${host}:${port}`)
    .trim()
    .replace(/\/+$/, '');
  const gatewayApiUrl = env('GATEWAY_API_URL', 'http://127.0.0.1:6100')
    .trim()
    .replace(/\/+$/, '');
  const gatewayCheckoutUrl = env('GATEWAY_CHECKOUT_URL', 'http://127.0.0.1:7000')
    .trim()
    .replace(/\/+$/, '');
  const demoMode = envFlag('DEMO_MODE', true);
  const webhookSecret = env('WEBHOOK_SECRET', env('MERCHANT_KEY', '')).trim();
  const merchantKey = env('MERCHANT_KEY', webhookSecret).trim();

  return {
    rootDir,
    publicDir,
    host,
    port,
    publicBaseUrl,
    gatewayApiUrl,
    gatewayCheckoutUrl,
    merchantId: env('MERCHANT_ID', '00000000-0000-0000-0000-000000000001').trim(),
    merchantKey,
    webhookSecret,
    adminToken: env('ADMIN_API_TOKEN', '').trim(),
    demoMode,
    demoAutoConfirm: demoMode && envFlag('DEMO_AUTO_CONFIRM', true),
    dbPath: resolveDbPath(env('STORE_DB_PATH', './data/store.sqlite').trim()),
    gatewayTimeoutMs: envInt('GATEWAY_TIMEOUT_MS', 10000),
    autoConfirmIntervalMs: envInt('AUTO_CONFIRM_INTERVAL_MS', 2000),
    autoConfirmActivationDelayMs: envInt('AUTO_CONFIRM_ACTIVATION_DELAY_MS', 1600),
    orderExpiryMinutes: envInt('ORDER_EXPIRY_MINUTES', 15),
    webhookMaxBytes: envInt('WEBHOOK_MAX_BYTES', 64 * 1024),
  };
}

/**
 * Throws a readable error when required settings are missing.
 * @param {ReturnType<typeof loadConfig>} config
 */
export function validateConfig(config) {
  const errors = [];

  for (const [name, value] of [
    ['PUBLIC_BASE_URL', config.publicBaseUrl],
    ['GATEWAY_API_URL', config.gatewayApiUrl],
    ['GATEWAY_CHECKOUT_URL', config.gatewayCheckoutUrl],
  ]) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(`${name} must use http or https.`);
      }
    } catch {
      errors.push(`${name} is not a valid URL: ${value}`);
    }
  }

  if (!config.merchantId) errors.push('MERCHANT_ID is required.');
  if (!config.webhookSecret) errors.push('WEBHOOK_SECRET is required.');
  if (!config.merchantKey) errors.push('MERCHANT_KEY is required.');
  if (config.demoMode && !config.adminToken) {
    errors.push('ADMIN_API_TOKEN is required while DEMO_MODE=true.');
  }

  if (errors.length) {
    const error = new Error(
      `Configuration is incomplete:\n  - ${errors.join('\n  - ')}\n\nRun "npm run setup" first.`,
    );
    error.code = 'INVALID_CONFIG';
    throw error;
  }

  return config;
}
