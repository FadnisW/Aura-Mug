import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  gatewayRoot,
  isPortFree,
  projectRoot,
  randomSecret,
  readEnvFile,
  runNpm,
  runNode,
  upsertEnvFile,
} from './lib/dev-utils.mjs';
import { patchCheckoutOtp } from './patch-gateway-otp.mjs';

const GATEWAY_REPO = 'https://github.com/devstroop/UPI-PG';
const GATEWAY_COMMIT = 'd7b07414d803094525ceedd5cf81e8a38157263e';

function fail(message) {
  console.error(`\nSetup failed: ${message}\n`);
  process.exit(1);
}

function isPlaceholder(value) {
  return !value || /^replace-with/i.test(String(value).trim());
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'npm',
    ...options,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with code ${result.status}.`);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  fail(`Node.js 24 or newer is required. Found ${process.version}.`);
}

console.log('AURA store setup');
console.log('================');

if (!fs.existsSync(path.join(gatewayRoot, 'package.json'))) {
  console.log(`Cloning UPI-PG into ${gatewayRoot} ...`);
  run('git', ['clone', GATEWAY_REPO, gatewayRoot], { cwd: projectRoot });
  run('git', ['checkout', GATEWAY_COMMIT], { cwd: gatewayRoot });
} else {
  console.log(`Using the existing gateway at ${gatewayRoot}.`);
}

if (!fs.existsSync(path.join(gatewayRoot, 'node_modules'))) {
  console.log('Installing gateway dependencies (this can take a minute) ...');
  const status = runNpm(gatewayRoot, ['install', '--no-audit', '--no-fund']);
  if (status !== 0) fail('Gateway dependency installation failed.');
} else {
  console.log('Gateway dependencies are already installed.');
}

const storeEnvFile = path.join(projectRoot, '.env');
const gatewayEnvFile = path.join(gatewayRoot, '.env');
const storeEnv = readEnvFile(storeEnvFile);
const gatewayEnv = readEnvFile(gatewayEnvFile);

const adminToken = isPlaceholder(gatewayEnv.ADMIN_API_TOKEN)
  ? isPlaceholder(storeEnv.ADMIN_API_TOKEN)
    ? randomSecret(32)
    : storeEnv.ADMIN_API_TOKEN
  : gatewayEnv.ADMIN_API_TOKEN;

const webhookSecret = isPlaceholder(gatewayEnv.COIN_STORE_WEBHOOK_SECRET)
  ? isPlaceholder(storeEnv.WEBHOOK_SECRET)
    ? isPlaceholder(storeEnv.MERCHANT_KEY)
      ? randomSecret(32)
      : storeEnv.MERCHANT_KEY
    : storeEnv.WEBHOOK_SECRET
  : gatewayEnv.COIN_STORE_WEBHOOK_SECRET;

const merchantId =
  (storeEnv.MERCHANT_ID && !isPlaceholder(storeEnv.MERCHANT_ID)
    ? storeEnv.MERCHANT_ID
    : null) || '00000000-0000-0000-0000-000000000001';

upsertEnvFile(storeEnvFile, {
  PORT: 5000,
  HOST: '127.0.0.1',
  PUBLIC_BASE_URL: 'http://127.0.0.1:5000',
  GATEWAY_API_URL: 'http://127.0.0.1:6100',
  GATEWAY_CHECKOUT_URL: 'http://127.0.0.1:7000',
  MERCHANT_ID: merchantId,
  MERCHANT_KEY: webhookSecret,
  WEBHOOK_SECRET: webhookSecret,
  ADMIN_API_TOKEN: adminToken,
  DEMO_MODE: 'true',
  DEMO_AUTO_CONFIRM: 'true',
  STORE_DB_PATH: './data/store.sqlite',
});

upsertEnvFile(gatewayEnvFile, {
  NODE_ENV: 'development',
  YOUPI_MODE: 'localhost',
  YOUPI_ALLOW_LOCALHOST_MODE: 'true',
  YOUPI_EXPOSE_DEV_OTP: 'true',
  YOUPI_ALLOW_DEV_TOOLS: 'true',
  YOUPI_ALLOW_PRIVATE_WEBHOOKS: 'true',
  // Local demo convenience: allow re-running the OTP flow without waiting 30s.
  OTP_RESEND_COOLDOWN_MS: '0',
  YOUPI_BIND_HOST: '127.0.0.1',
  PAYMENT_API_PORT: 6100,
  CHECKOUT_PORTAL_PORT: 7000,
  CONTROL_CENTER_PORT: 8090,
  COIN_WALLET_STORE_PORT: 5001,
  BASE_PAYMENT_API_URL: 'http://127.0.0.1:6100',
  BASE_CHECKOUT_URL: 'http://127.0.0.1:7000',
  BASE_DEMO_STORE_URL: 'http://127.0.0.1:5000',
  ADMIN_API_TOKEN: adminToken,
  COIN_STORE_WEBHOOK_SECRET: webhookSecret,
});

console.log('Environment files written.');

const patched = patchCheckoutOtp();
console.log(
  `${patched.replaced ? 'Updated' : 'Added'} demo OTP autofill in ${path.relative(projectRoot, patched.file)}.`,
);

fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });

console.log('Initializing the gateway database ...');
const initEnv = {
  ...process.env,
  ...readEnvFile(gatewayEnvFile),
  SQLITE_DB_PATH: path.join(gatewayRoot, 'data', 'youpi_pg.sqlite'),
};
const initStatus = runNode(path.join(gatewayRoot, 'scripts', 'init-db.cjs'), [], {
  cwd: gatewayRoot,
  env: initEnv,
});
if (initStatus !== 0) fail('Gateway database initialization failed.');

const ports = [
  { name: 'store', port: 5000 },
  { name: 'payment API', port: 6100 },
  { name: 'checkout portal', port: 7000 },
];
for (const { name, port } of ports) {
  if (!(await isPortFree(port))) {
    console.warn(`Warning: port ${port} (${name}) is already in use.`);
  }
}

console.log(`
AURA is ready.

  Storefront      http://127.0.0.1:5000
  Payment API     http://127.0.0.1:6100
  Hosted checkout http://127.0.0.1:7000

Start everything with:

  npm run dev

Demo only: payments are simulated through UPI-PG and no real money moves.
`);
