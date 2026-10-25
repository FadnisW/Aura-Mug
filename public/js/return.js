import { setCartQuantity } from './store.js';
import { api } from './api.js';
import { initChrome, escapeHtml, formatDateTime, money } from './ui.js';

initChrome();

const params = new URLSearchParams(window.location.search);
const orderId = params.get('order') || params.get('orderId') || '';
const token = params.get('token') || '';

const icon = document.querySelector('[data-status-icon]');
const eyebrow = document.querySelector('[data-status-eyebrow]');
const title = document.querySelector('[data-status-title]');
const message = document.querySelector('[data-status-message]');
const body = document.querySelector('[data-status-body]');
const actions = document.querySelector('[data-status-actions]');
const help = document.querySelector('[data-status-help]');

const MAX_ATTEMPTS = 24;
const POLL_INTERVAL_MS = 2500;

const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 5 5L20 6"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pending: '<div class="spinner"></div>',
};

let currentOrder = null;
let attempts = 0;
let timer = 0;
let loading = false;

function setIcon(kind) {
  icon.className = `status-icon is-${kind === 'pending' ? 'pending' : kind}`;
  icon.innerHTML = ICONS[kind] || ICONS.pending;
}

function setStatus({ iconKind, eyebrowText, heading, copy, bodyHtml = '', actionsHtml = '', helpHtml = '' }) {
  setIcon(iconKind);
  eyebrow.innerHTML = `<span class="eyebrow-dot" aria-hidden="true"></span>${escapeHtml(eyebrowText)}`;
  title.textContent = heading;
  message.textContent = copy;
  body.innerHTML = bodyHtml;
  actions.innerHTML = actionsHtml;
  help.innerHTML = helpHtml;
}

function receiptGrid(order) {
  const verification = order.payment.verificationTag
    ? `${escapeHtml(order.payment.verificationTag)}${
        Number(order.payment.verificationLevel)
          ? ` · Level ${Number(order.payment.verificationLevel)}`
          : ''
      }`
    : '—';

  return `
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
          <dt>UTR</dt>
          <dd class="mono">${escapeHtml(order.payment.utr || '—')}</dd>
        </div>
        <div class="receipt-item">
          <dt>Method</dt>
          <dd>${escapeHtml(order.payment.method || 'UPI')}</dd>
        </div>
        <div class="receipt-item">
          <dt>Paid on</dt>
          <dd>${formatDateTime(order.paidAt)}</dd>
        </div>
        <div class="receipt-item">
          <dt>Verification</dt>
          <dd>${verification}</dd>
        </div>
      </dl>
      ${timeline(order)}
    </div>
  `;
}

function timeline(order) {
  const events = Array.isArray(order.events) ? order.events : [];
  if (events.length === 0) return '';
  const items = events
    .slice(-8)
    .map(
      (event) => `
        <li>
          <p>${escapeHtml(event.message)}</p>
          <time datetime="${escapeHtml(event.createdAt)}">${formatDateTime(event.createdAt)}</time>
        </li>
      `,
    )
    .join('');
  return `
    <div class="timeline-block">
      <h2>What happened</h2>
      <ul class="timeline">${items}</ul>
    </div>
  `;
}

function renderPending(order) {
  currentOrder = order;
  setStatus({
    iconKind: 'pending',
    eyebrowText: 'Payment status',
    heading: 'Confirming your payment…',
    copy: 'The gateway is checking the UPI confirmation. This usually takes a few seconds.',
    bodyHtml: `
      <p class="fineprint">Order <span class="mono">${escapeHtml(order.id)}</span> · ${money(order.amountPaise)}</p>
    `,
    actionsHtml: '',
    helpHtml: 'You can safely leave this page — the order will update in <a href="/orders">your orders</a>.',
  });
}

function renderPaid(order) {
  currentOrder = order;
  setStatus({
    iconKind: 'success',
    eyebrowText: 'Payment confirmed',
    heading: 'Paid. Thank you.',
    copy: `Your Aura Mug order is confirmed. This is a demo payment, so no money moved — but the whole flow, including the signed webhook, really happened.`,
    bodyHtml: receiptGrid(order),
    actionsHtml: `
      <a class="button button-primary" href="/orders">View all orders</a>
      <a class="button button-secondary" href="/">Keep shopping</a>
    `,
    helpHtml: 'A receipt is saved in this browser. You can reopen it from <a href="/orders">your orders</a>.',
  });
}

function renderFailure(order) {
  currentOrder = order;
  const reason =
    order.failureReason ||
    (order.status === 'EXPIRED'
      ? 'The payment window closed before the UPI confirmation came through.'
      : order.status === 'CANCELLED'
        ? 'The payment was cancelled at checkout.'
        : 'The gateway reported that the payment did not complete.');

  setStatus({
    iconKind: 'error',
    eyebrowText: `Payment ${String(order.status || 'failed').toLowerCase()}`,
    heading: 'That payment did not go through.',
    copy: reason,
    bodyHtml: `
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
            <dt>Payment</dt>
            <dd>${escapeHtml(order.payment.id || '—')}</dd>
          </div>
          <div class="receipt-item">
            <dt>Status</dt>
            <dd>${escapeHtml(order.status)}</dd>
          </div>
        </dl>
      </div>
    `,
    actionsHtml: `
      <button class="button button-primary" type="button" data-retry>Try again</button>
      <a class="button button-secondary" href="/orders">View all orders</a>
    `,
    helpHtml: 'No money moved in this demo. You can retry the payment as many times as you like.',
  });
}

function renderStillPending() {
  currentOrder = null;
  setStatus({
    iconKind: 'pending',
    eyebrowText: 'Still confirming',
    heading: 'This is taking a little longer.',
    copy: 'The gateway has not confirmed the payment yet. It may still be processing — check again in a moment, or look at your orders later.',
    bodyHtml: `
      <p class="fineprint">Order <span class="mono">${escapeHtml(orderId)}</span></p>
    `,
    actionsHtml: `
      <button class="button button-primary" type="button" data-refresh>Check again</button>
      <a class="button button-secondary" href="/orders">View all orders</a>
    `,
    helpHtml: 'If the payment went through, the order will be marked paid automatically by the gateway webhook.',
  });
}

function renderMissing(copy) {
  currentOrder = null;
  setStatus({
    iconKind: 'error',
    eyebrowText: 'Order unavailable',
    heading: 'We could not open this order.',
    copy: copy || 'This payment link is missing or has expired.',
    bodyHtml: '',
    actionsHtml: `
      <a class="button button-primary" href="/orders">View your orders</a>
      <a class="button button-secondary" href="/">Back to the store</a>
    `,
    helpHtml: 'Order links are saved in the browser you checked out with. <a href="/orders">See what is saved here</a>.',
  });
}

function schedule() {
  if (attempts >= MAX_ATTEMPTS) {
    renderStillPending();
    return;
  }
  attempts += 1;
  window.clearTimeout(timer);
  timer = window.setTimeout(load, POLL_INTERVAL_MS);
}

async function load() {
  if (loading) return;
  window.clearTimeout(timer);
  loading = true;
  try {
    const result = await api.getOrder(orderId, token, { refresh: true });
    const order = result.order;
    document.title = `Order ${order.id} — AURA`;

    if (order.status === 'PAID') {
      renderPaid(order);
    } else if (order.status === 'PENDING') {
      renderPending(order);
      schedule();
    } else {
      renderFailure(order);
    }
  } catch (error) {
    if (error?.status === 401 || error?.status === 404) {
      renderMissing(error.message);
      return;
    }
    if (currentOrder?.status === 'PAID') return;
    if (attempts < MAX_ATTEMPTS) schedule();
    else renderStillPending();
  } finally {
    loading = false;
  }
}

actions.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('[data-retry]') && currentOrder) {
    setCartQuantity(currentOrder.quantity);
    window.location.assign('/checkout');
    return;
  }

  if (target.closest('[data-refresh]')) {
    attempts = 0;
    document.title = 'Payment status — AURA';
    setStatus({
      iconKind: 'pending',
      eyebrowText: 'Payment status',
      heading: 'Confirming your payment…',
      copy: 'Checking with the gateway again.',
      bodyHtml: '',
      actionsHtml: '',
      helpHtml: '',
    });
    load();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (currentOrder?.status === 'PENDING') {
    attempts = 0;
    load();
  }
});

if (!orderId || !token) {
  renderMissing('This page needs an order reference and access token. Open it from the payment return link or your order history.');
} else {
  load();
}
