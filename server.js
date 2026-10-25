import http from 'node:http';
import { loadConfig, validateConfig } from './src/config.js';
import { createLogger } from './src/log.js';
import { StoreDb } from './src/db.js';
import { GatewayClient } from './src/gateway.js';
import { createApp } from './src/http.js';
import { DemoAutoConfirm } from './src/auto-confirm.js';

const logger = createLogger('store');

let config;
try {
  config = validateConfig(loadConfig());
} catch (error) {
  logger.error(error.message || error);
  process.exit(1);
}

const db = new StoreDb(config.dbPath);
const gateway = new GatewayClient(config, logger.child('gateway'));
const app = createApp({
  config,
  db,
  gateway,
  logger: logger.child('http'),
});

const server = http.createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 35_000;

const autoConfirm = new DemoAutoConfirm({
  config,
  db,
  gateway,
  logger: logger.child('demo'),
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received; shutting down.`);
  autoConfirm.stop();

  const finish = (code) => {
    try {
      db.close();
    } catch {
      // Ignore double-close.
    }
    process.exit(code);
  };

  const timer = setTimeout(() => {
    logger.warn('Forcing shutdown after timeout.');
    finish(1);
  }, 5000);
  timer.unref?.();

  server.close(() => {
    clearTimeout(timer);
    finish(0);
  });
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(
      `Port ${config.port} is already in use. Stop the other process or set PORT to a free port.`,
    );
  } else {
    logger.error('HTTP server error:', error.message || error);
  }
  shutdown('server-error');
});

server.listen(config.port, config.host, () => {
  logger.info(`AURA store listening on ${config.publicBaseUrl}`);
  logger.info(`Gateway API: ${config.gatewayApiUrl}`);
  logger.info(`Hosted checkout: ${config.gatewayCheckoutUrl}`);
  logger.info(`Demo mode: ${config.demoMode ? 'on' : 'off'} · auto-confirm: ${config.demoAutoConfirm ? 'on' : 'off'}`);
  autoConfirm.start();
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error?.stack || error);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error?.stack || error);
});
