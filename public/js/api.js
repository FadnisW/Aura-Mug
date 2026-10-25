/** Small fetch wrapper for the storefront JSON API. */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, field?: string|null}} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status || 0;
    this.code = options.code || 'API_ERROR';
    this.field = options.field || null;
  }
}

/**
 * @param {string} path
 * @param {{method?: string, body?: unknown, token?: string, timeoutMs?: number}} [options]
 */
async function request(path, { method = 'GET', body, token, timeoutMs = 20_000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new ApiError(
      timedOut
        ? 'The store took too long to respond. Please try again.'
        : 'We could not reach the store. Check your connection and try again.',
      { code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR' },
    );
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      data?.error || `Something went wrong (HTTP ${response.status}).`,
      {
        status: response.status,
        code: data?.code,
        field: data?.field,
      },
    );
  }

  return data;
}

export const api = {
  getProduct() {
    return request('/api/product');
  },

  /** @param {{quantity: number, customer: object, shipping: object}} payload */
  createOrder(payload) {
    return request('/api/orders', { method: 'POST', body: payload });
  },

  /**
   * @param {string} orderId
   * @param {string} token
   * @param {{refresh?: boolean}} [options]
   */
  getOrder(orderId, token, { refresh = false } = {}) {
    const query = refresh ? '?refresh=1' : '';
    return request(`/api/orders/${encodeURIComponent(orderId)}${query}`, { token });
  },

  /** @param {Array<{id: string, token: string}>} orders */
  lookupOrders(orders) {
    return request('/api/orders/lookup', { method: 'POST', body: { orders } });
  },
};
