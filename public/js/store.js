/**
 * Browser-side store state: the bag, remembered order references, and the
 * checkout draft. Everything lives in localStorage so the demo works without
 * accounts; the server never trusts these values.
 */

export const PRODUCT = Object.freeze({
  id: 'aura-mug',
  name: 'Aura Mug',
  subtitle: 'Hand-glazed stoneware · 350 ml',
  pricePaise: 89900,
  currency: 'INR',
  maxQuantity: 10,
  image: '/assets/aura-mug.svg',
});

const CART_KEY = 'aura.cart.v1';
const ORDERS_KEY = 'aura.orders.v1';
const DRAFT_KEY = 'aura.checkoutDraft.v1';
const MAX_SAVED_ORDERS = 50;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key, fallback) {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function clampQuantity(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(PRODUCT.maxQuantity, Math.max(0, number));
}

function announceCart(quantity) {
  window.dispatchEvent(
    new CustomEvent('aura:cart-change', { detail: { quantity } }),
  );
}

/** @returns {number} 0 when the bag is empty. */
export function cartQuantity() {
  const cart = readJson(CART_KEY, { quantity: 0 });
  return clampQuantity(cart?.quantity ?? 0);
}

/** @param {number} quantity */
export function setCartQuantity(quantity) {
  const next = clampQuantity(quantity);
  writeJson(CART_KEY, { quantity: next, updatedAt: new Date().toISOString() });
  announceCart(next);
  return next;
}

/** @param {number} [count] */
export function addToCart(count = 1) {
  return setCartQuantity(cartQuantity() + Math.max(1, Number(count) || 1));
}

export function clearCart() {
  return setCartQuantity(0);
}

export function cartSubtotalPaise() {
  return cartQuantity() * PRODUCT.pricePaise;
}

/** @returns {Array<{id: string, token: string, createdAt: string}>} */
export function orderRefs() {
  const value = readJson(ORDERS_KEY, []);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry) =>
      entry &&
      typeof entry.id === 'string' &&
      typeof entry.token === 'string' &&
      entry.id.length > 0 &&
      entry.token.length > 0,
  );
}

/** @param {{id: string, token: string, createdAt?: string, amountPaise?: number}} ref */
export function saveOrderRef(ref) {
  if (!ref?.id || !ref?.token) return orderRefs();
  const next = [
    {
      id: ref.id,
      token: ref.token,
      createdAt: ref.createdAt || new Date().toISOString(),
      amountPaise: ref.amountPaise ?? null,
    },
    ...orderRefs().filter((entry) => entry.id !== ref.id),
  ].slice(0, MAX_SAVED_ORDERS);
  writeJson(ORDERS_KEY, next);
  return next;
}

/** @param {string} id */
export function removeOrderRef(id) {
  const next = orderRefs().filter((entry) => entry.id !== id);
  writeJson(ORDERS_KEY, next);
  return next;
}

/** @param {string} id */
export function findOrderRef(id) {
  return orderRefs().find((entry) => entry.id === id) || null;
}

/** @param {Record<string, string>} draft */
export function saveCheckoutDraft(draft) {
  writeJson(DRAFT_KEY, { ...draft, savedAt: new Date().toISOString() });
}

/** @returns {Record<string, string>} */
export function readCheckoutDraft() {
  const value = readJson(DRAFT_KEY, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const draft = {};
  for (const key of ['name', 'email', 'phone', 'address', 'city', 'pincode']) {
    if (typeof value[key] === 'string') draft[key] = value[key];
  }
  return draft;
}

export function clearCheckoutDraft() {
  const store = storage();
  try {
    store?.removeItem(DRAFT_KEY);
  } catch {
    // Storage can be unavailable; nothing else to do.
  }
}
