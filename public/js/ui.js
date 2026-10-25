/** Shared chrome: bag drawer, toasts, formatting, and status labels. */

import { PRODUCT, cartQuantity, setCartQuantity } from './store.js';

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** @param {number} paise */
export function money(paise) {
  return currencyFormatter.format(Number(paise || 0) / 100);
}

/** @param {string|null|undefined} iso */
export function formatDate(iso) {
  const date = new Date(String(iso || ''));
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

/** @param {string|null|undefined} iso */
export function formatDateTime(iso) {
  const date = new Date(String(iso || ''));
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date);
}

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** @param {string} status */
export function statusMeta(status) {
  const key = String(status || '').toUpperCase();
  switch (key) {
    case 'PAID':
      return { label: 'Paid', className: 'status-paid' };
    case 'PENDING':
      return { label: 'Awaiting payment', className: 'status-pending' };
    case 'FAILED':
      return { label: 'Failed', className: 'status-failed' };
    case 'EXPIRED':
      return { label: 'Expired', className: 'status-expired' };
    case 'CANCELLED':
      return { label: 'Cancelled', className: 'status-cancelled' };
    default:
      return { label: key || 'Unknown', className: 'status-expired' };
  }
}

const BAG_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>`;

const DRAWER_MARKUP = `
  <div class="drawer-head">
    <h2 id="cart-drawer-title">Your bag</h2>
    <button class="icon-button" type="button" data-cart-close aria-label="Close bag">&#10005;</button>
  </div>
  <div class="drawer-body" data-cart-body></div>
  <div class="drawer-foot" data-cart-foot hidden>
    <div class="summary-row"><span>Subtotal</span><strong data-cart-subtotal>${money(0)}</strong></div>
    <p class="fineprint">Shipping is free. Taxes included.</p>
    <button class="button button-primary button-block" type="button" data-cart-checkout>Checkout</button>
    <button class="link-button" type="button" data-cart-close>Continue shopping</button>
  </div>
`;

let drawer = null;
let backdrop = null;
let cartBody = null;
let cartFoot = null;
let cartSubtotal = null;
let cartCheckout = null;
let closeButton = null;
let toastRegion = null;
let isOpen = false;
let lastFocused = null;
let closeTimer = 0;
let initialized = false;

function injectDrawer() {
  if (drawer) return;
  backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.dataset.drawerBackdrop = '';
  backdrop.hidden = true;

  drawer = document.createElement('aside');
  drawer.className = 'cart-drawer';
  drawer.id = 'cart-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-labelledby', 'cart-drawer-title');
  drawer.hidden = true;
  drawer.innerHTML = DRAWER_MARKUP;

  document.body.append(backdrop, drawer);

  cartBody = drawer.querySelector('[data-cart-body]');
  cartFoot = drawer.querySelector('[data-cart-foot]');
  cartSubtotal = drawer.querySelector('[data-cart-subtotal]');
  cartCheckout = drawer.querySelector('[data-cart-checkout]');
  closeButton = drawer.querySelector('.icon-button');
}

function emptyCartMarkup() {
  return `
    <div class="cart-empty">
      <div class="cart-empty-icon">${BAG_ICON}</div>
      <h3>Your bag is empty</h3>
      <p>The Aura Mug is waiting. It is a small batch, so they tend to go quickly.</p>
      <a class="button button-secondary" href="/#the-mug" data-cart-close>Meet the mug</a>
    </div>
  `;
}

/** @param {number} quantity */
function cartItemMarkup(quantity) {
  return `
    <div class="cart-item">
      <div class="cart-thumb">
        <img src="${PRODUCT.image}" alt="" width="88" height="88">
      </div>
      <div>
        <h3>${PRODUCT.name}</h3>
        <p class="cart-item-price">${money(PRODUCT.pricePaise)} each</p>
        <div class="cart-item-controls">
          <div class="qty-stepper">
            <button type="button" data-qty-step="-1" aria-label="Decrease quantity"${quantity <= 1 ? ' disabled' : ''}>&minus;</button>
            <input type="number" value="${quantity}" min="1" max="${PRODUCT.maxQuantity}" inputmode="numeric" aria-label="Quantity" data-qty-input>
            <button type="button" data-qty-step="1" aria-label="Increase quantity"${quantity >= PRODUCT.maxQuantity ? ' disabled' : ''}>+</button>
          </div>
          <button type="button" class="cart-remove" data-cart-remove>Remove</button>
        </div>
      </div>
    </div>
    <p class="fineprint">One mug, packed by hand in recycled paper. Free shipping across India.</p>
  `;
}

function renderCart() {
  const quantity = cartQuantity();

  document.querySelectorAll('[data-cart-count]').forEach((node) => {
    node.textContent = String(quantity);
  });
  document.querySelectorAll('.cart-button[data-cart-open]').forEach((node) => {
    node.setAttribute(
      'aria-label',
      quantity ? `Open bag, ${quantity} item${quantity === 1 ? '' : 's'}` : 'Open bag',
    );
  });

  if (!drawer) return;
  if (quantity === 0) {
    cartBody.innerHTML = emptyCartMarkup();
    cartFoot.hidden = true;
    return;
  }

  cartBody.innerHTML = cartItemMarkup(quantity);
  cartFoot.hidden = false;
  const total = quantity * PRODUCT.pricePaise;
  cartSubtotal.textContent = money(total);
  cartCheckout.textContent = `Checkout · ${money(total)}`;
}

export function openCart() {
  if (!drawer) return;
  if (isOpen) return;
  window.clearTimeout(closeTimer);
  isOpen = true;
  lastFocused = document.activeElement;
  renderCart();
  drawer.hidden = false;
  backdrop.hidden = false;
  document.body.classList.add('drawer-open');
  window.requestAnimationFrame(() => {
    if (!isOpen) return;
    drawer.classList.add('is-open');
    backdrop.classList.add('is-open');
  });
  closeButton?.focus({ preventScroll: true });
}

export function closeCart({ restoreFocus = true } = {}) {
  if (!drawer || !isOpen) return;
  isOpen = false;
  drawer.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  document.body.classList.remove('drawer-open');
  closeTimer = window.setTimeout(() => {
    if (isOpen) return;
    drawer.hidden = true;
    backdrop.hidden = true;
  }, 380);
  if (restoreFocus && lastFocused instanceof HTMLElement && document.contains(lastFocused)) {
    lastFocused.focus({ preventScroll: true });
  }
}

/** @param {string} message */
export function toast(message, { error = false, duration = 3400 } = {}) {
  if (!toastRegion) {
    toastRegion = document.createElement('div');
    toastRegion.className = 'toast-region';
    toastRegion.dataset.toastRegion = '';
    toastRegion.setAttribute('role', 'status');
    toastRegion.setAttribute('aria-live', 'polite');
    document.body.append(toastRegion);
  }

  const node = document.createElement('div');
  node.className = `toast${error ? ' toast-error' : ''}`;
  node.textContent = message;
  toastRegion.append(node);

  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 240);
  }, duration);
}

function onKeydown(event) {
  if (!isOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeCart();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = Array.from(
    drawer.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((node) => node.offsetParent !== null);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function onDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('[data-cart-open]')) {
    event.preventDefault();
    openCart();
    return;
  }

  if (target.closest('[data-cart-close]')) {
    closeCart();
    return;
  }

  if (target.closest('[data-drawer-backdrop]')) {
    closeCart();
    return;
  }

  if (target.closest('[data-cart-remove]')) {
    setCartQuantity(0);
    toast('Removed from your bag.');
    return;
  }

  const stepButton = target.closest('[data-qty-step]');
  if (stepButton) {
    const delta = Number(stepButton.dataset.qtyStep);
    if (Number.isFinite(delta)) setCartQuantity(cartQuantity() + delta);
    return;
  }

  if (target.closest('[data-cart-checkout]')) {
    if (window.location.pathname === '/checkout') {
      closeCart({ restoreFocus: false });
      const firstInput = document.getElementById('name');
      firstInput?.focus({ preventScroll: true });
      firstInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    window.location.assign('/checkout');
  }
}

function onQuantityChange(event) {
  const input = event.target instanceof Element ? event.target.closest('[data-qty-input]') : null;
  if (!input || !drawer?.contains(input)) return;
  const next = setCartQuantity(input.value);
  if (next === 0) renderCart();
}

export function initChrome() {
  if (initialized) return;
  initialized = true;
  injectDrawer();
  renderCart();

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('change', onQuantityChange);
  window.addEventListener('aura:cart-change', renderCart);

  document.querySelectorAll('[data-year]').forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });
}
