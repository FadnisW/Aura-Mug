import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT, formatInr } from './product.js';
import { ValidationError } from './validate.js';
import {
  OrderError,
  createOrder,
  getOrderForToken,
  handleWebhook,
  lookupOrders,
  refreshOrder,
  serializeOrder,
} from './orders.js';
import {
  WebhookPayloadError,
  parseWebhookPayload,
  sha256Hex,
  verifyWebhookSignature,
} from './webhooks.js';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

const PAGE_ROUTES = Object.freeze({
  '/': 'index.html',
  '/checkout': 'checkout.html',
  '/return': 'return.html',
  '/orders': 'orders.html',
  '/order-failed': 'order-failed.html',
});

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
});

class HttpError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', field = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, error, logger) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong. Please try again.';
  let field = null;

  if (error instanceof ValidationError) {
    status = 400;
    code = error.code;
    message = error.message;
    field = error.field;
  } else if (error instanceof OrderError) {
    status = error.status;
    code = error.code;
    message = error.message;
    field = error.field;
  } else if (error instanceof WebhookPayloadError) {
    status = 400;
    code = error.code;
    message = error.message;
  } else if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
    message = error.message;
    field = error.field;
  } else {
    logger?.error('Unhandled request error:', error?.stack || error);
  }

  if (res.headersSent) {
    res.destroy();
    return;
  }

  sendJson(res, status, {
    error: message,
    code,
    ...(field ? { field } : {}),
  });
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError('The request body is too large.', {
        status: 413,
        code: 'BODY_TOO_LARGE',
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const text = await readRawBody(req, maxBytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('The request body must be valid JSON.', {
      status: 400,
      code: 'INVALID_JSON',
    });
  }
}

function tokenFromRequest(req, url) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  return url.searchParams.get('token') || '';
}

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

async function serveFile(req, res, filePath, status = 200) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new HttpError('Not found.', { status: 404, code: 'NOT_FOUND' });
  }
  if (stat.isDirectory()) {
    throw new HttpError('Not found.', { status: 404, code: 'NOT_FOUND' });
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const cacheControl = extension === '.html' ? 'no-cache' : 'public, max-age=3600';

  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }

  const headers = {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': cacheControl,
  };

  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  const content = await fs.promises.readFile(filePath);
  res.writeHead(status, headers);
  res.end(content);
}

async function serveStatic(req, res, url, config) {
  const pathname = normalizePathname(url.pathname);
  const relative = PAGE_ROUTES[pathname] || pathname.replace(/^\/+/, '');
  if (!relative) {
    throw new HttpError('Not found.', { status: 404, code: 'NOT_FOUND' });
  }

  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    throw new HttpError('Malformed path.', { status: 400, code: 'BAD_PATH' });
  }
  if (decoded.includes('\0')) {
    throw new HttpError('Malformed path.', { status: 400, code: 'BAD_PATH' });
  }

  const filePath = path.resolve(config.publicDir, decoded);
  const insidePublic =
    filePath === config.publicDir || filePath.startsWith(`${config.publicDir}${path.sep}`);
  if (!insidePublic) {
    throw new HttpError('Not found.', { status: 404, code: 'NOT_FOUND' });
  }

  try {
    await serveFile(req, res, filePath);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    const notFoundPath = path.join(config.publicDir, '404.html');
    if (!decoded.includes('.') && fs.existsSync(notFoundPath)) {
      await serveFile(req, res, notFoundPath, 404);
      return;
    }
    throw error;
  }
}

/**
 * Builds the storefront HTTP handler.
 * @param {{
 *   config: ReturnType<import('./config.js').loadConfig>,
 *   db: import('./db.js').StoreDb,
 *   gateway: import('./gateway.js').GatewayClient,
 *   logger: ReturnType<import('./log.js').createLogger>,
 * }} input
 */
export function createApp({ config, db, gateway, logger }) {
  async function route(req, res, url) {
    const pathname = normalizePathname(url.pathname);

    if (pathname === '/api/health' && req.method === 'GET') {
      const stats = db.stats();
      let gatewayStatus = 'down';
      try {
        await gateway.health();
        gatewayStatus = 'up';
      } catch {
        gatewayStatus = 'down';
      }
      sendJson(res, 200, {
        status: 'ok',
        store: 'up',
        gateway: gatewayStatus,
        demoMode: config.demoMode,
        orders: stats.total,
        ordersByStatus: stats.byStatus,
        time: new Date().toISOString(),
      });
      return;
    }

    if (pathname === '/api/product' && req.method === 'GET') {
      sendJson(res, 200, {
        storeName: 'AURA',
        product: {
          ...PRODUCT,
          priceFormatted: formatInr(PRODUCT.pricePaise),
        },
        demoMode: config.demoMode,
        autoConfirm: config.demoAutoConfirm,
      });
      return;
    }

    if (pathname === '/api/orders' && req.method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      const result = await createOrder({
        db,
        gateway,
        config,
        body,
        logger,
      });
      sendJson(res, 201, {
        order: serializeOrder(db, result.order, { events: true }),
        accessToken: result.accessToken,
        checkoutUrl: result.checkoutUrl,
      });
      return;
    }

    if (pathname === '/api/orders/lookup' && req.method === 'POST') {
      const body = await readJsonBody(req, 128 * 1024);
      const orders = lookupOrders({ db, entries: body.orders });
      sendJson(res, 200, {
        orders: orders.map((order) => serializeOrder(db, order, { events: true })),
      });
      return;
    }

    const refreshMatch = /^\/api\/orders\/([A-Za-z0-9_-]+)\/refresh$/.exec(pathname);
    if (refreshMatch && req.method === 'POST') {
      const token = tokenFromRequest(req, url);
      let order = getOrderForToken({ db, orderId: refreshMatch[1], token });
      order = await refreshOrder({ db, gateway, order, logger });
      sendJson(res, 200, { order: serializeOrder(db, order, { events: true }) });
      return;
    }

    const orderMatch = /^\/api\/orders\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (orderMatch && req.method === 'GET') {
      const token = tokenFromRequest(req, url);
      let order = getOrderForToken({ db, orderId: orderMatch[1], token });
      if (url.searchParams.get('refresh') === '1' && order.status === 'PENDING') {
        order = await refreshOrder({ db, gateway, order, logger });
      }
      sendJson(res, 200, { order: serializeOrder(db, order, { events: true }) });
      return;
    }

    if (pathname === '/api/webhooks/upi-pg' && req.method === 'POST') {
      const rawBody = await readRawBody(req, config.webhookMaxBytes);
      const signature = verifyWebhookSignature({
        rawBody,
        headers: req.headers,
        secret: config.webhookSecret,
      });
      if (!signature.valid) {
        logger.warn(`Rejected webhook (${signature.reason || 'invalid signature'}).`);
        sendJson(res, 401, {
          error: 'Invalid webhook signature.',
          code: 'INVALID_SIGNATURE',
        });
        return;
      }

      const payload = parseWebhookPayload(rawBody);
      if (db.hasDelivery(payload.deliveryId)) {
        sendJson(res, 200, { received: true, duplicate: true });
        return;
      }

      const result = handleWebhook({ db, payload, logger });
      db.recordDelivery({
        deliveryId: payload.deliveryId,
        event: payload.event,
        paymentId: payload.paymentId,
        orderId: payload.orderId,
        signatureValid: true,
        bodySha256: sha256Hex(rawBody),
      });
      sendJson(res, 200, {
        received: true,
        applied: result.applied,
        orderId: result.order?.id || payload.orderId,
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      throw new HttpError('API route not found.', { status: 404, code: 'NOT_FOUND' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError('Method not allowed.', { status: 405, code: 'METHOD_NOT_ALLOWED' });
    }

    await serveStatic(req, res, url, config);
  }

  return async function handler(req, res) {
    const started = Date.now();
    applySecurityHeaders(res);

    let url;
    try {
      url = new URL(req.url || '/', config.publicBaseUrl);
    } catch {
      sendJson(res, 400, { error: 'Malformed request URL.', code: 'BAD_REQUEST' });
      return;
    }

    res.on('finish', () => {
      const pathname = url.pathname;
      const isApi = pathname.startsWith('/api/');
      if (isApi || res.statusCode >= 400) {
        logger.info(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS' });
      res.end();
      return;
    }

    try {
      await route(req, res, url);
    } catch (error) {
      sendError(res, error, logger);
    }
  };
}
