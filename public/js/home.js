import { PRODUCT, addToCart, cartQuantity, setCartQuantity } from './store.js';
import { initChrome, money, openCart, toast } from './ui.js';

initChrome();

const stepper = document.querySelector('[data-home-stepper]');
const quantityInput = stepper?.querySelector('[data-qty-input]');
const minusButton = stepper?.querySelector('[data-qty-minus]');
const plusButton = stepper?.querySelector('[data-qty-plus]');
const addLabel = document.querySelector('[data-add-label]');

function clampQuantity(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.min(PRODUCT.maxQuantity, Math.max(1, number));
}

function currentQuantity() {
  return clampQuantity(quantityInput?.value ?? 1);
}

function renderStepper({ normalizeInput = true } = {}) {
  const quantity = currentQuantity();
  if (quantityInput && normalizeInput) quantityInput.value = String(quantity);
  if (minusButton) minusButton.disabled = quantity <= 1;
  if (plusButton) plusButton.disabled = quantity >= PRODUCT.maxQuantity;
  if (addLabel) {
    addLabel.textContent =
      quantity === 1
        ? `Add to bag · ${money(PRODUCT.pricePaise)}`
        : `Add ${quantity} to bag · ${money(quantity * PRODUCT.pricePaise)}`;
  }
}

minusButton?.addEventListener('click', () => {
  if (quantityInput) quantityInput.value = String(currentQuantity() - 1);
  renderStepper();
});

plusButton?.addEventListener('click', () => {
  if (quantityInput) quantityInput.value = String(currentQuantity() + 1);
  renderStepper();
});

quantityInput?.addEventListener('input', () => renderStepper({ normalizeInput: false }));
quantityInput?.addEventListener('change', () => renderStepper());

document.querySelectorAll('[data-add-to-bag]').forEach((button) => {
  button.addEventListener('click', () => {
    const fromCard = button.closest('.buy-card');
    const requested = fromCard ? currentQuantity() : 1;
    const before = cartQuantity();
    const after = addToCart(requested);
    const added = after - before;

    if (added <= 0) {
      toast(`Your bag is already at the ${PRODUCT.maxQuantity}-mug limit.`, { error: true });
      openCart();
      return;
    }
    toast(
      added === 1
        ? 'Added the Aura Mug to your bag.'
        : `Added ${added} Aura Mugs to your bag.`,
    );
    openCart();
  });
});

document.querySelectorAll('[data-buy-now]').forEach((button) => {
  button.addEventListener('click', () => {
    setCartQuantity(currentQuantity());
    window.location.assign('/checkout');
  });
});

renderStepper();
