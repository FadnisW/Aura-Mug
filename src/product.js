export const PRODUCT = Object.freeze({
  id: 'aura-mug',
  name: 'Aura Mug',
  subtitle: 'Hand-glazed stoneware · 350 ml',
  description:
    'A quietly beautiful mug, thrown and glazed in small batches. The kind of weight that makes the first sip feel like a ritual.',
  pricePaise: 89900,
  currency: 'INR',
  maxQuantity: 10,
  image: '/assets/aura-mug.svg',
  imageAlt: 'A terracotta hand-glazed Aura Mug with a soft cream rim',
});

export function formatInr(paise) {
  const amount = Number(paise) / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function calculateAmountPaise(quantity) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > PRODUCT.maxQuantity) {
    const error = new Error(`Quantity must be between 1 and ${PRODUCT.maxQuantity}.`);
    error.code = 'INVALID_QUANTITY';
    throw error;
  }
  return PRODUCT.pricePaise * qty;
}

export function toGatewayAmount(amountPaise) {
  return (Number(amountPaise) / 100).toFixed(2);
}
