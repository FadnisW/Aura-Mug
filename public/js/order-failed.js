import { findOrderRef, setCartQuantity } from './store.js';
import { api } from './api.js';
import { initChrome, escapeHtml, money } from './ui.js';

initChrome();

const params = new URLSearchParams(window.location.search);
const orderId = params.get('orderId') || params.get('order') || '';
const paymentId = params.get('paymentId') || '';
const reason = String(params.get('reason') || '').toUpperCase();

const title = document.querySelector('[data-failed-title]');
const message = document.querySelector('[data-failed-message]');
const body = document.querySelector('[data-failed-body]');
const actions = document.querySelector('[data-failed-actions]');
const help = document.querySelector('[data-failed-help]');

const REASON_COPY = {
  EXPIRED: 'The payment window closed before the UPI confirmation came through.',
  CANCELLED: 'The payment was cancelled at checkout.',
  FAILED: 'The gateway reported that the payment did not complete.',
};

let currentOrder = null;
let currentToken = '';

function detailLink(order) {
  if (!currentToken) return '';
  return `/return?order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(currentToken)}`;
}

function renderGeneric(copy) {
  currentOrder = null;
  title.textContent = 'That payment did not go through.';
  message.textContent = copy || REASON_COPY[reason] || 'The payment did not complete.';
  body.innerHTML = orderId
    ? `<p class="fineprint">Order <span class="mono">${escapeHtml(orderId)}</span>${
        paymentId ? ` · Payment <span class="mono">${escapeHtml(paymentId)}</span>` : ''
      }</p>`
    : '';
  actions.innerHTML = `
    <a class="button button-primary" href="/">Back to the store</a>
    <a class="button button-secondary" href="/orders">View your orders</a>
  `;
  help.innerHTML = 'No money moved in this demo. You can retry safely.';
}

function renderOrder(order) {
  currentOrder = order;
  const copy = order.failureReason || REASON_COPY[reason] || 'The payment did not complete.';
  const details = detailLink(order);

  title.textContent = 'That payment did not go through.';
  message.textContent = copy;
  body.innerHTML = `
    <div class="receipt">
      <dl class="receipt-grid">
        <div class="receipt-item">
          <dt>Order</dt>
          <dd class="mono">${escapeHtml(order.id)}</dd>
        </div>
        <div class="receipt-item">
          <dt>Amount</dt>
          <dd>${money(order.amountPaise)}</dd>
        </div>
        <div class="receipt-item">
          <dt>Quantity</dt>
          <dd>${order.quantity} × ${escapeHtml(order.product.name)}</dd>
        </div>
        <div class="receipt-item">
          <dt>Status</dt>
          <dd>${escapeHtml(order.status)}</dd>
        </div>
      </dl>
    </div>
  `;
  actions.innerHTML = `
    <button class="button button-primary" type="button" data-retry>Try again</button>
    ${details ? `<a class="button button-secondary" href="${details}">View order</a>` : '<a class="button button-secondary" href="/orders">View your orders</a>'}
  `;
  help.innerHTML = 'Your bag will be restored with the same quantity when you retry. No money moved in this demo.';
}

async function init() {
  if (!orderId) {
    title.textContent = 'No payment to show.';
    message.textContent =
      'This page appears when a payment does not complete. There is no order reference in the link.';
    actions.innerHTML = `
      <a class="button button-primary" href="/">Back to the store</a>
      <a class="button button-secondary" href="/orders">View your orders</a>
    `;
    help.innerHTML = 'You can find any saved orders in <a href="/orders">your order history</a>.';
    return;
  }

  const ref = findOrderRef(orderId);
  if (!ref) {
    renderGeneric();
    return;
  }

  currentToken = ref.token;
  try {
    const result = await api.getOrder(orderId, ref.token, { refresh: true });
    const order = result.order;

    if (order.status === 'PAID') {
      window.location.replace(detailLink(order));
      return;
    }
    renderOrder(order);
  } catch (error) {
    renderGeneric(
      error?.status === 401 || error?.status === 404
        ? 'We could not find this order in the store. It may belong to another browser.'
        : 'We could not check the order with the gateway. The payment did not complete.',
    );
  }
}

actions.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-retry]') : null;
  if (!target) return;
  if (currentOrder) {
    setCartQuantity(currentOrder.quantity);
    window.location.assign('/checkout');
    return;
  }
  window.location.assign('/#the-mug');
});

init();
