'use strict';

/**
 * Token-bucket rate limiter with a global cool-down.
 *
 * - acquire() resolves when a send slot is available (ratePerSecond, burst = ratePerSecond).
 * - penalize(ms) blocks all sends for `ms` (used when the provider reports a rate limit).
 *
 * The limit is per worker process: with N worker processes the combined rate is
 * N × SEND_RATE_PER_SECOND. Size it from your provider's current published limits.
 */
class RateLimiter {
  constructor(ratePerSecond, { now = () => Date.now() } = {}) {
    this.rate = ratePerSecond > 0 ? ratePerSecond : Infinity;
    this.capacity = Number.isFinite(this.rate) ? Math.max(1, this.rate) : Infinity;
    this.tokens = this.capacity;
    this.last = now();
    this.now = now;
    this.blockedUntil = 0;
    this.queue = Promise.resolve();
  }

  _refill() {
    const t = this.now();
    if (Number.isFinite(this.rate)) {
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
    }
    this.last = t;
  }

  acquire() {
    // Serialise waiters so they are served in FIFO order.
    const p = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        if (t < this.blockedUntil) {
          await sleep(this.blockedUntil - t);
          continue;
        }
        this._refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      }
    });
    this.queue = p.catch(() => {});
    return p;
  }

  penalize(ms) {
    if (ms > 0) this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

module.exports = { RateLimiter };
