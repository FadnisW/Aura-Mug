import { applyGatewaySnapshot, markOrderTerminal } from './orders.js';
import { demoUtr } from './gateway.js';

const TEST_MODE_REFRESH_MS = 8 * 60 * 1000;
const SIMULATION_RETRY_MS = 10 * 1000;
const MAX_SIMULATION_ATTEMPTS = 5;
const GATEWAY_WARNING_INTERVAL_MS = 30 * 1000;

/**
 * Demo-only helper. Once a customer has completed the gateway's WhatsApp OTP
 * and the payment session becomes ACTIVE, it injects a synthetic bank credit
 * SMS through UPI-PG's real verification pipeline. The gateway then dispatches
 * its signed webhook, which is what actually marks the store order paid.
 *
 * This never runs when DEMO_AUTO_CONFIRM is false.
 */
export class DemoAutoConfirm {
  constructor({ config, db, gateway, logger }) {
    this.config = config;
    this.db = db;
    this.gateway = gateway;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.testModeEnabledAt = 0;
    this.lastGatewayWarningAt = 0;
  }

  start() {
    if (!this.config.demoAutoConfirm) {
      this.logger.info('Demo auto-confirm is disabled.');
      return;
    }
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error('Demo auto-confirm tick failed:', error?.message || error);
      });
    }, this.config.autoConfirmIntervalMs);
    this.timer.unref?.();

    this.tick().catch((error) => {
      this.logger.error('Initial demo auto-confirm tick failed:', error?.message || error);
    });

    this.logger.info(
      `Demo auto-confirm active (every ${Math.round(this.config.autoConfirmIntervalMs / 1000)}s).`,
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const orders = this.db.listPendingOrders({ limit: 25 });
      for (const order of orders) {
        await this.processOrder(order);
      }
    } finally {
      this.running = false;
    }
  }

  /** @param {any} order */
  async processOrder(order) {
    if (!order.gatewayPaymentId) return;

    let payment;
    try {
      payment = await this.gateway.getPayment(order.gatewayPaymentId);
    } catch (error) {
      if (error?.status === 404) {
        markOrderTerminal({
          db: this.db,
          order,
          status: 'FAILED',
          reason: 'The payment session no longer exists at the gateway.',
          source: 'demo-poll',
          logger: this.logger,
        });
        return;
      }
      this.warnGatewayOnce(error);
      return;
    }

    const updated = applyGatewaySnapshot({
      db: this.db,
      order,
      payment,
      source: 'demo-poll',
      logger: this.logger,
    });

    if (!updated || updated.status !== 'PENDING') return;

    if (updated.gatewayStatus === 'ACTIVE' || updated.gatewayStatus === 'PROCESSING') {
      await this.injectDemoCredit(updated);
      return;
    }

    if (
      ['INITIATED', 'QUEUED', 'CREATING', null].includes(updated.gatewayStatus) &&
      this.isStale(updated)
    ) {
      markOrderTerminal({
        db: this.db,
        order: updated,
        status: 'EXPIRED',
        reason: 'The checkout was not completed in time.',
        source: 'demo-expiry',
        logger: this.logger,
      });
    }
  }

  /** @param {any} order */
  isStale(order) {
    const created = Date.parse(order.createdAt);
    if (!Number.isFinite(created)) return false;
    return Date.now() - created > this.config.orderExpiryMinutes * 60 * 1000;
  }

  async ensureTestMode() {
    if (Date.now() - this.testModeEnabledAt < TEST_MODE_REFRESH_MS) return;
    await this.gateway.enableTestMode(true);
    this.testModeEnabledAt = Date.now();
    this.logger.info('Gateway test mode enabled.');
  }

  /** @param {any} order */
  async injectDemoCredit(order) {
    if (order.simulatedAt) return;
    if (order.simulationAttempts >= MAX_SIMULATION_ATTEMPTS) return;

    const lastAttempt = order.simulationLastAttemptAt
      ? Date.parse(order.simulationLastAttemptAt)
      : 0;
    if (lastAttempt && Date.now() - lastAttempt < SIMULATION_RETRY_MS) return;

    try {
      await this.ensureTestMode();
      const result = await this.gateway.injectSimulatedSms({
        paymentId: order.gatewayPaymentId,
        amountPaise: order.amountPaise,
      });

      if (result?.success === false) {
        throw new Error(result?.reason || result?.error || 'The gateway rejected the simulated credit.');
      }

      const attemptedAt = new Date().toISOString();
      this.db.updateOrder(order.id, {
        simulatedAt: attemptedAt,
        simulationAttempts: order.simulationAttempts + 1,
        simulationLastAttemptAt: attemptedAt,
        simulationError: null,
      });
      this.db.addEvent(order.id, 'payment.simulated', 'Demo bank credit pushed through the gateway.', {
        utr: demoUtr(order.gatewayPaymentId),
        amountPaise: order.amountPaise,
        pipelineStatus: result?.status || 'VERIFIED',
      });
      this.logger.info(`Injected demo bank credit for order ${order.id}.`);
    } catch (error) {
      const attemptedAt = new Date().toISOString();
      const attempts = order.simulationAttempts + 1;
      if (error?.status === 403 && /test mode/i.test(error.message || '')) {
        this.testModeEnabledAt = 0;
      }
      const message = String(error?.message || error).slice(0, 500);
      this.db.updateOrder(order.id, {
        simulationAttempts: attempts,
        simulationLastAttemptAt: attemptedAt,
        simulationError: message,
      });
      this.db.addEvent(
        order.id,
        'payment.simulation_failed',
        'Demo bank credit could not be injected.',
        { attempt: attempts, error: message },
      );
      this.logger.warn(
        `Demo injection failed for order ${order.id} (attempt ${attempts}/${MAX_SIMULATION_ATTEMPTS}):`,
        message,
      );
    }
  }

  warnGatewayOnce(error) {
    const now = Date.now();
    if (now - this.lastGatewayWarningAt < GATEWAY_WARNING_INTERVAL_MS) return;
    this.lastGatewayWarningAt = now;
    this.logger.warn('Demo auto-confirm cannot reach the gateway:', error?.message || error);
  }
}
