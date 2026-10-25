import {
  PRODUCT,
  cartQuantity,
  clearCart,
  readCheckoutDraft,
  saveCheckoutDraft,
  saveOrderRef,
} from './store.js';
import { api } from './api.js';
import { initChrome, money } from './ui.js';

initChrome();

const form = document.getElementById('checkout-form');
const checkoutRoot = document.querySelector('[data-checkout-root]');
const emptyState = document.querySelector('[data-checkout-empty]');
const summary = document.querySelector('[data-summary]');
const payButton = document.querySelector('[data-pay-button]');
const formError = document.querySelector('[data-form-error]');

const fields = {
  name: document.getElementById('name'),
  email: document.getElementById('email'),
  phone: document.getElementById('phone'),
  address: document.getElementById('address'),
  city: document.getElementById('city'),
  pincode: document.getElementById('pincode'),
};

let submitting = false;
let draftTimer = 0;

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function setFieldError(field, message) {
  const wrapper = document.querySelector(`[data-field-wrap="${field}"]`);
  const target = document.querySelector(`[data-error-for="${field}"]`);
  const input = fields[field];
  if (wrapper) wrapper.classList.toggle('has-error', Boolean(message));
  if (target) target.textContent = message || '';
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function clearErrors() {
  Object.keys(fields).forEach((field) => setFieldError(field, ''));
  formError.hidden = true;
  formError.textContent = '';
}

function readValues() {
  return {
    name: fields.name?.value.trim() || '',
    email: fields.email?.value.trim() || '',
    phone: fields.phone?.value.trim() || '',
    address: fields.address?.value.trim() || '',
    city: fields.city?.value.trim() || '',
    pincode: fields.pincode?.value.trim() || '',
  };
}

function validate(values) {
  const errors = {};
  if (values.name.length < 2) {
    errors.name = 'Please enter your full name.';
  } else if (values.name.length > 80) {
    errors.name = 'Please use 80 characters or fewer.';
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) {
    errors.email = 'Please enter a valid email address.';
  }

  if (!/^[6-9]\d{9}$/.test(normalizePhone(values.phone))) {
    errors.phone = 'Please enter a valid 10-digit Indian mobile number.';
  }

  if (values.address.length < 5) {
    errors.address = 'Please enter your full delivery address.';
  } else if (values.address.length > 200) {
    errors.address = 'Please use 200 characters or fewer.';
  }

  if (values.city.length < 2) {
    errors.city = 'Please enter your city.';
  } else if (values.city.length > 60) {
    errors.city = 'Please use 60 characters or fewer.';
  }

  if (!/^[1-9]\d{5}$/.test(values.pincode)) {
    errors.pincode = 'Please enter a valid 6-digit PIN code.';
  }

  return errors;
}

function showErrors(errors) {
  let firstInvalid = null;
  for (const [field, message] of Object.entries(errors)) {
    setFieldError(field, message);
    if (!firstInvalid && fields[field]) firstInvalid = fields[field];
  }
  if (firstInvalid) {
    firstInvalid.focus({ preventScroll: true });
    firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function updatePayLabel() {
  if (!payButton || submitting) return;
  const total = cartQuantity() * PRODUCT.pricePaise;
  payButton.textContent = total > 0 ? `Pay ${money(total)} with UPI` : 'Pay with UPI';
}

function renderSummary() {
  const quantity = cartQuantity();
  if (!checkoutRoot || !emptyState || !summary) return;

  if (quantity === 0) {
    checkoutRoot.hidden = true;
    emptyState.hidden = false;
    return;
  }

  checkoutRoot.hidden = false;
  emptyState.hidden = true;
  const total = quantity * PRODUCT.pricePaise;

  summary.innerHTML = `
    <div class="summary-item">
      <div class="summary-thumb">
        <img src="${PRODUCT.image}" alt="" width="86" height="86">
      </div>
      <div>
        <h3>${PRODUCT.name}</h3>
        <p>${PRODUCT.subtitle}</p>
      </div>
    </div>
    <div class="summary-qty">
      <span>Quantity</span>
      <span>${quantity}</span>
    </div>
    <div class="summary-totals">
      <div class="summary-row"><span>Subtotal</span><span>${money(total)}</span></div>
      <div class="summary-row"><span>Shipping</span><span>Free</span></div>
      <div class="summary-row total"><span>Total</span><span>${money(total)}</span></div>
    </div>
    <div class="demo-callout">
      <strong>Demo checkout</strong>
      Use any valid Indian mobile number. The gateway's WhatsApp OTP fills itself and the bank credit is simulated. No real money moves.
    </div>
  `;
  updatePayLabel();
}

function saveDraftSoon() {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    saveCheckoutDraft(readValues());
  }, 350);
}

function prefillFromDraft() {
  const draft = readCheckoutDraft();
  for (const [key, input] of Object.entries(fields)) {
    if (input && typeof draft[key] === 'string') input.value = draft[key];
  }
}

form?.addEventListener('input', (event) => {
  const field = event.target instanceof Element ? event.target.closest('[data-field-wrap]')?.dataset.fieldWrap : null;
  if (field) setFieldError(field, '');
  saveDraftSoon();
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;

  if (cartQuantity() === 0) {
    renderSummary();
    return;
  }

  clearErrors();
  const values = readValues();
  const errors = validate(values);
  if (Object.keys(errors).length > 0) {
    showErrors(errors);
    return;
  }

  submitting = true;
  const originalLabel = payButton.textContent;
  payButton.disabled = true;
  payButton.textContent = 'Starting secure checkout…';

  saveCheckoutDraft(values);

  try {
    const result = await api.createOrder({
      quantity: cartQuantity(),
      customer: {
        name: values.name,
        email: values.email,
        phone: normalizePhone(values.phone),
      },
      shipping: {
        address: values.address,
        city: values.city,
        pincode: values.pincode,
      },
    });

    saveOrderRef({
      id: result.order.id,
      token: result.accessToken,
      createdAt: result.order.createdAt,
      amountPaise: result.order.amountPaise,
    });
    clearCart();

    if (!result.checkoutUrl) {
      throw new Error('The gateway did not return a checkout URL.');
    }
    window.location.assign(result.checkoutUrl);
  } catch (error) {
    submitting = false;
    payButton.disabled = false;
    payButton.textContent = originalLabel;
    updatePayLabel();

    if (error?.field && fields[error.field]) {
      setFieldError(error.field, error.message);
      fields[error.field].focus({ preventScroll: true });
      fields[error.field].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    formError.textContent =
      error?.message || 'We could not start the payment. Please try again.';
    formError.hidden = false;
    formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

window.addEventListener('aura:cart-change', renderSummary);

prefillFromDraft();
renderSummary();
