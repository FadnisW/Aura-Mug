import {
  PRODUCT,
  addToCart,
  orderRefs,
  removeOrderRef,
  setCartQuantity,
} from './store.js';
import { api } from './api.js';
import {
  initChrome,
  escapeHtml,
  formatDateTime,
  money,
  openCart,
  statusMeta,
  toast,
} from './ui.js';

initChrome();

const list = document.querySelector('[data-orders-list]');
const loadingPanel = document.querySelector('[data-orders-loading]');
const emptyPanel = document.querySelector('[data-orders-empty]');
const errorPanel = document.querySelector('[data-orders-error]');
const errorMessage = document.querySelector('[data-orders-error-message]');
const retryButton = document.querySelector('[data-orders-retry]');

let refs = orderRefs();
let tokenById = new Map(refs.map((ref) => [ref.id, ref.token]));
let ordersById = new Map();

function setView(view) {
  list.hidden = view !== 'list';
  loadingPanel.hidden = view !== 'loading';
  emptyPanel.hidden = view !== 'empty';
  errorPanel.hidden = view !== 'error';
}

function detailLink(order) {
  const token = tokenById.get(order.id);
  if (!token) return null;
  return `/return?order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(token)}`;
}

function actionsFor(order) {
  const details = detailLink(order);
  const detailButton = details
    ? `<a class="button button-secondary" href="${escapeHtml(details)}">${order.status === 'PAID' ? 'View receipt' : 'View status'}</a>`
    : '';

  if (order.status === 'PENDING') {
    return `
      <a class="button button-primary" href="${escapeHtml(order.checkoutUrl || '/checkout')}">Complete payment</a>
      ${detailButton}
    `;
  }

  if (order.status === 'PAID') {
    return `
      ${detailButton}
      <button class="button button-secondary" type="button" data-buy-again>Buy again</button>
    `;

  }

  return `
    <button class="button button-primary" type="button" data-retry>Try again</button>
    ${detailButton}
  `;
}

function paymentLine(order) {
  if (order.status === 'PAID') {
    return `UPI${order.payment.utr ? ` · UTR ${escapeHtml(order.payment.utr)}` : ''}`;
  }
  if (order.status === 'PENDING') return 'Awaiting UPI payment';
  return escapeHtml(order.failureReason || 'Not completed');
}

function orderCard(order) {
  const meta = statusMeta(order.status);
  return `
    <article class="order-card" data-order-id="${escapeHtml(order.id)}">
      <div class="order-card-head">
        <div>
          <p class="order-id">${escapeHtml(order.id)}</p>
          <p class="order-date">Placed ${formatDateTime(order.createdAt)}</p>
        </div>
        <span class="status-chip ${meta.className}">${meta.label}</span>
      </div>

      <div class="order-product">
        <div class="order-thumb">
          <img src="${PRODUCT.image}" alt="" width="78" height="78">
        </div>
        <div>
          <h3>${PRODUCT.name}</h3>
          <p>${order.quantity} × ${money(PRODUCT.pricePaise)} · ${PRODUCT.subtitle}</p>
        </div>
        <span class="order-amount">${money(order.amountPaise)}</span>
      </div>

      <div class="order-detail-grid">
        <div>
          <h4>Delivery</h4>
          <p>${escapeHtml(order.shipping.address)}, ${escapeHtml(order.shipping.city)} ${escapeHtml(order.shipping.pincode)}</p>
        </div>
        <div>
          <h4>Payment</h4>
          <p>${paymentLine(order)}</p>
        </div>
        <div>
          <h4>Contact</h4>
          <p>${escapeHtml(order.customer.email)}<br>+91 ${escapeHtml(order.customer.phone)}</p>
        </div>
      </div>

      <div class="order-actions">
        <div class="order-actions-right">${actionsFor(order)}</div>
        <button class="link-button" type="button" data-forget>Remove from this device</button>
      </div>
    </article>
  `;
}

function render(orders) {
  ordersById = new Map(orders.map((order) => [order.id, order]));
  if (orders.length === 0) {
    list.innerHTML = '';
    setView('empty');
    return;
  }
  list.innerHTML = orders.map(orderCard).join('');
  setView('list');
}

async function refreshPending(orders) {
  const pending = orders
    .filter((order) => order.status === 'PENDING' && tokenById.has(order.id))
    .slice(0, 6);
  if (pending.length === 0) return;

  const results = await Promise.allSettled(
    pending.map((order) => api.getOrder(order.id, tokenById.get(order.id), { refresh: true })),
  );

  let changed = false;
  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value?.order) continue;
    const fresh = result.value.order;
    const previous = ordersById.get(fresh.id);
    if (!previous || previous.status !== fresh.status) changed = true;
    ordersById.set(fresh.id, fresh);
  }
  if (changed) render([...ordersById.values()]);
}

async function load() {
  refs = orderRefs();
  tokenById = new Map(refs.map((ref) => [ref.id, ref.token]));

  if (refs.length === 0) {
    setView('empty');
    return;
  }

  setView('loading');
  try {
    const data = await api.lookupOrders(refs.map(({ id, token }) => ({ id, token })));
    render(data.orders || []);
    if ((data.orders || []).length > 0) refreshPending(data.orders);
  } catch (error) {
    errorMessage.textContent =
      error?.message || 'We could not load your orders. Please try again.';
    setView('error');
  }
}

list.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('button') : null;
  if (!target) return;

  const card = target.closest('[data-order-id]');
  const id = card?.dataset.orderId;
  const order = id ? ordersById.get(id) : null;

  if (target.hasAttribute('data-retry') && order) {
    setCartQuantity(order.quantity);
    window.location.assign('/checkout');
    return;
  }

  if (target.hasAttribute('data-buy-again') && order) {
    addToCart(order.quantity);
    toast(`Added ${order.quantity === 1 ? 'the Aura Mug' : `${order.quantity} Aura Mugs`} to your bag.`);
    openCart();
    return;
  }

  if (target.hasAttribute('data-forget') && id) {
    removeOrderRef(id);
    ordersById.delete(id);
    tokenById.delete(id);
    refs = orderRefs();
    card.remove();
    toast('Order removed from this device.');
    if (ordersById.size === 0) setView('empty');
  }
});

retryButton?.addEventListener('click', load);

load();
