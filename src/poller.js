export class OrbitPoller {
  constructor(gateway, { intervalMs = 0, logger } = {}) {
    this.gateway = gateway;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    if (!this.intervalMs || this.timer) return;
    this.timer = setInterval(() => {
      this.gateway.pollOrbit().catch((error) => this.logger?.error('scheduled_orbit_poll_failed', { error: error.message }));
    }, this.intervalMs);
    this.timer.unref?.();
    this.logger?.info('orbit_poller_started', { interval_ms: this.intervalMs });
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
