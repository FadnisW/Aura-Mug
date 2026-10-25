import { PRODUCT } from './product.js';

export class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'INVALID_INPUT';
    this.field = field;
  }
}

function text(value, { field, label, min = 1, max = 200 }) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length < min) {
    throw new ValidationError(`${label} is required.`, field);
  }
  if (normalized.length > max) {
    throw new ValidationError(`${label} must be ${max} characters or fewer.`, field);
  }
  return normalized;
}

export function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

export function isValidPhone(value) {
  const digits = normalizePhone(value);
  return /^[6-9]\d{9}$/.test(digits);
}

export function isValidEmail(value) {
  const email = String(value ?? '').trim();
  return (
    email.length >= 5 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  );
}

export function isValidPincode(value) {
  return /^[1-9]\d{5}$/.test(String(value ?? '').trim());
}

/**
 * Validates and normalizes a storefront checkout payload.
 * @param {any} body
 */
export function validateOrderInput(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('A checkout payload is required.');
  }

  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > PRODUCT.maxQuantity) {
    throw new ValidationError(
      `Please choose a quantity between 1 and ${PRODUCT.maxQuantity}.`,
      'quantity',
    );
  }

  const customer = body.customer && typeof body.customer === 'object' ? body.customer : {};
  const shipping = body.shipping && typeof body.shipping === 'object' ? body.shipping : {};

  const name = text(customer.name, { field: 'name', label: 'Full name', min: 2, max: 80 });
  const email = String(customer.email ?? '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    throw new ValidationError('Please enter a valid email address.', 'email');
  }
  const phone = normalizePhone(customer.phone);
  if (!isValidPhone(phone)) {
    throw new ValidationError('Please enter a valid 10-digit Indian mobile number.', 'phone');
  }

  const address = text(shipping.address, {
    field: 'address',
    label: 'Address',
    min: 5,
    max: 200,
  });
  const city = text(shipping.city, { field: 'city', label: 'City', min: 2, max: 60 });
  const pincode = String(shipping.pincode ?? '').trim();
  if (!isValidPincode(pincode)) {
    throw new ValidationError('Please enter a valid 6-digit PIN code.', 'pincode');
  }

  return {
    quantity,
    customer: { name, email, phone },
    shipping: { address, city, pincode },
  };
}
