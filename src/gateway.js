import crypto from 'node:crypto';
import { toGatewayAmount } from './product.js';

export class GatewayError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, details?: unknown, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'GatewayError';
    this.code = options.code || 'GATEWAY_ERROR';
    this.status = options.status || 0;
    this.details = options.details ?? null;
  }
}

/**
 * Twelve-digit demo UTR derived from the payment id. Stable across restarts so
 * a retried simulation cannot create two different bank references for the
 * same payment.
 * @param {string} paymentId
 */
export function demoUtr(paymentId) {
  const hex = crypto.createHash('sha256').update(String(paymentId)).digest('hex').slice(0, 16);
  const value = (BigInt(`0x${hex}`) % 900000000000n) + 100000000000n;
  return value.toString();
}

export function buildCreditSms(amountPaise, utr) {
  const amount = (Number(amountPaise) / 100).toFixed(2);
  return `A/C XX9999 credited with Rs ${amount} CR. Ref ${utr}`;
}

/**
 * Thin client for the self-hosted UPI-PG payment API.
 *
 * Merchant calls use the merchant key. Developer calls (test mode, simulator)
 * use the gateway admin token. Both are local demo credentials.
 */
export class GatewayClient {
  /**
   * @param {ReturnType<import('./config.js').loadConfig>} config
   * @param {ReturnType<import('./log.js').createLogger>} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.baseUrl = config.gatewayApiUrl;
  }

  async request(pathname, { method = 'GET', body, auth = 'merchant', timeoutMs, headers = {} } = {}) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    const requestHeaders = {
      Accept: 'application/json',
      ...headers,
    };

    if (auth === 'merchant') {
      requestHeaders['X-Merchant-Id'] = this.config.merchantId;
      requestHeaders['X-Merchant-Key'] = this.config.merchantKey;
    } else if (auth === 'admin') {
      requestHeaders.Authorization = `Bearer ${this.config.adminToken}`;
      requestHeaders['X-Merchant-Id'] = this.config.merchantId;
    }

    let payload;
    if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs || this.config.gatewayTimeoutMs),
      });
    } catch (error) {
      throw new GatewayError(
        `Could not reach the payment gateway at ${this.baseUrl}. Is it running?`,
        { code: 'GATEWAY_UNREACHABLE', cause: error },
      );
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 500) };
      }
    }

    if (!response.ok) {
      const message =
        (data && (data.message || data.error)) ||
        `Payment gateway returned HTTP ${response.status}.`;
      throw new GatewayError(String(message), {
        status: response.status,
        code: data?.code || `GATEWAY_HTTP_${response.status}`,
        details: data,
      });
    }

    return data;
  }

  async health() {
    return this.request('/api/v1/health', { auth: 'none', timeoutMs: 2500 });
  }

  /**
   * Creates a hosted checkout session.
   * @param {{order: any, returnUrl: string}} input
   */
  async createPayment({ order, returnUrl }) {
    const data = await this.request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: order.id,
        amount: toGatewayAmount(order.amountPaise),
        currency: order.currency,
        returnUrl,
        metadata: {
          storeOrderId: order.id,
          productId: order.productId,
          quantity: order.quantity,
          source: 'aura-upi-store',
        },
      },
    });

    if (!data?.paymentId || !data?.checkoutUrl) {
      throw new GatewayError('The payment gateway did not return a checkout URL.', {
        code: 'INVALID_GATEWAY_RESPONSE',
        details: data,
      });
    }
    return data;
  }

  /** @param {string} paymentId */
  async getPayment(paymentId) {
    return this.request(`/api/v1/payments/${encodeURIComponent(paymentId)}`);
  }

  /** @param {boolean} [enabled] */
  async enableTestMode(enabled = true) {
    return this.request('/api/v1/admin/dev/test-mode', {
      method: 'POST',
      auth: 'admin',
      body: { enabled },
    });
  }

  /**
   * Pushes a synthetic bank credit SMS through the gateway's real verification
   * pipeline. Only works while the gateway test mode is active.
   * @param {{paymentId: string, amountPaise: number}} input
   */
  async injectSimulatedSms({ paymentId, amountPaise }) {
    const utr = demoUtr(paymentId);
    return this.request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      auth: 'admin',
      body: {
        paymentSessionId: paymentId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: buildCreditSms(amountPaise, utr),
        receivedAt: new Date().toISOString(),
      },
    });
  }

  async getMerchantSettings() {
    return this.request('/api/v1/admin/merchant-settings', { auth: 'admin' });
  }

  /** @param {Record<string, unknown>} settings */
  async updateMerchantSettings(settings) {
    return this.request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      auth: 'admin',
      body: { merchantId: this.config.merchantId, ...settings },
    });
  }
}
