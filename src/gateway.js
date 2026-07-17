import { AppError, ProviderError } from './errors.js';
import { senderConfig } from './config.js';
import { mapNexusStatus, mapOrbitStatus } from './status.js';
import { validateMessage } from './validation.js';

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export class MessagingGateway {
  constructor({ store, nexus, orbit, logger, routes = senderConfig }) {
    this.store = store;
    this.nexus = nexus;
    this.orbit = orbit;
    this.logger = logger;
    this.routes = routes;
    this.inFlight = new Map();
  }

  async submit(input) {
    const message = validateMessage(input);
    const routeDefinition = this.routes[message.sender_id];
    if (!routeDefinition) {
      throw new AppError(400, 'UNKNOWN_SENDER_ID', `sender_id "${message.sender_id}" is not configured.`);
    }
    const inserted = this.store.createOrGet(message, routeDefinition.route);
    if (!inserted.fingerprintMatches) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'client_ref was already used with different message content.');
    }
    if (!inserted.created) {
      const running = this.inFlight.get(message.client_ref);
      if (running) await running;
      this.logger?.info('message_idempotent_replay', { client_ref: message.client_ref, status: inserted.message.status });
      return this.store.getMessage(message.client_ref);
    }

    this.logger?.info('message_accepted', {
      client_ref: message.client_ref,
      sender_id: message.sender_id,
      channel: message.channel,
      route: routeDefinition.route,
      destination_last4: message.destination.slice(-4),
      text_length: message.text.length
    });

    const dispatch = this.dispatch(message, routeDefinition.route)
      .catch((error) => {
        this.logger?.error('message_dispatch_unhandled_error', { client_ref: message.client_ref, error: errorText(error) });
        this.store.failMessage(message.client_ref, errorText(error), 'dispatch_unhandled_error');
      })
      .finally(() => this.inFlight.delete(message.client_ref));
    this.inFlight.set(message.client_ref, dispatch);
    await dispatch;
    return this.store.getMessage(message.client_ref);
  }

  async dispatch(message, route) {
    this.logger?.info('message_dispatch_started', { client_ref: message.client_ref, route });
    if (route === 'nexus') {
      await this.sendNexus(message, { failMessage: true });
      return;
    }
    if (route === 'orbit') {
      await this.sendOrbit(message, { failMessage: true });
      return;
    }

    const nexusResult = await this.sendNexus(message, { failMessage: false });
    if (nexusResult.ok) return;
    if (!['server', 'timeout'].includes(nexusResult.error.kind)) {
      this.store.failMessage(message.client_ref, errorText(nexusResult.error), 'nexus_failed_no_failover', { kind: nexusResult.error.kind });
      return;
    }
    this.store.addAudit(message.client_ref, 'failover_to_orbit', null, null, { nexus_error: errorText(nexusResult.error), kind: nexusResult.error.kind });
    this.logger?.info('message_failover_to_orbit', { client_ref: message.client_ref, reason: nexusResult.error.kind });
    await this.sendOrbit(message, { failMessage: true });
  }

  async sendNexus(message, { failMessage }) {
    const attemptId = this.store.startAttempt(message.client_ref, 'nexus');
    this.logger?.info('provider_attempt_started', { client_ref: message.client_ref, provider: 'nexus', attempt_id: attemptId });
    try {
      const result = await this.nexus.send(message);
      this.store.finishAttempt(attemptId, { status: 'ACCEPTED', providerMessageId: result.providerMessageId, rawResponse: result.raw });
      this.store.submitToProvider(message.client_ref, 'nexus', result.providerMessageId, result.raw);
      this.logger?.info('provider_submitted', { client_ref: message.client_ref, provider: 'nexus', provider_message_id: result.providerMessageId });
      return { ok: true };
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : new ProviderError(errorText(error));
      this.store.finishAttempt(attemptId, { status: 'FAILED', error: errorText(providerError) });
      this.store.addAudit(message.client_ref, 'nexus_attempt_failed', null, null, { error: errorText(providerError), kind: providerError.kind });
      this.logger?.error('provider_submission_failed', { client_ref: message.client_ref, provider: 'nexus', error: errorText(providerError), error_kind: providerError.kind, provider_status: providerError.status });
      if (failMessage) this.store.failMessage(message.client_ref, errorText(providerError), 'nexus_failed', { kind: providerError.kind });
      return { ok: false, error: providerError };
    }
  }

  async sendOrbit(message, { failMessage }) {
    const attemptId = this.store.startAttempt(message.client_ref, 'orbit');
    this.logger?.info('provider_attempt_started', { client_ref: message.client_ref, provider: 'orbit', attempt_id: attemptId });
    try {
      const result = await this.orbit.send(message);
      this.store.finishAttempt(attemptId, { status: 'ACCEPTED', providerMessageId: result.providerMessageId, rawResponse: result.raw });
      this.store.submitToProvider(message.client_ref, 'orbit', result.providerMessageId, result.raw);
      this.logger?.info('provider_submitted', { client_ref: message.client_ref, provider: 'orbit', provider_message_id: result.providerMessageId });
      return { ok: true };
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : new ProviderError(errorText(error));
      this.store.finishAttempt(attemptId, { status: 'FAILED', error: errorText(providerError) });
      this.store.addAudit(message.client_ref, 'orbit_attempt_failed', null, null, { error: errorText(providerError), kind: providerError.kind });
      this.logger?.error('provider_submission_failed', { client_ref: message.client_ref, provider: 'orbit', error: errorText(providerError), error_kind: providerError.kind, provider_status: providerError.status });
      if (failMessage) this.store.failMessage(message.client_ref, errorText(providerError), 'orbit_failed', { kind: providerError.kind });
      return { ok: false, error: providerError };
    }
  }

  receiveNexusStatus(payload, eventKey) {
    if (!payload?.message_id || !payload?.status) {
      throw new AppError(400, 'INVALID_WEBHOOK', 'Nexus webhook requires message_id and status.');
    }
    if (!this.store.claimWebhook(eventKey, 'nexus')) {
      const duplicateMessage = this.store.getMessageByProviderId('nexus', payload.message_id);
      this.logger?.info('nexus_webhook_duplicate', { client_ref: duplicateMessage?.client_ref, provider_message_id: payload.message_id });
      return { duplicate: true, message: duplicateMessage };
    }
    const message = this.store.getMessageByProviderId('nexus', payload.message_id);
    if (!message) {
      this.logger?.info('nexus_webhook_unknown_message', { provider_message_id: payload.message_id });
      return { duplicate: false, message: null, ignored: true };
    }
    const mapped = mapNexusStatus(payload.status);
    if (!mapped) {
      this.store.addAudit(message.client_ref, 'nexus_webhook_unmapped_status', null, null, { raw_status: payload.status, payload });
      this.logger?.warn?.('nexus_webhook_unmapped_status', { client_ref: message.client_ref, provider_message_id: payload.message_id, raw_status: payload.status });
      return { duplicate: false, message: this.store.getMessage(message.client_ref), ignored: true };
    }
    if (mapped === 'FAILED') this.store.failMessage(message.client_ref, payload.error || `Nexus reported ${payload.status}.`, 'nexus_delivery_status', { payload });
    else this.store.transition(message.client_ref, mapped, 'nexus_delivery_status', { payload });
    const updated = this.store.getMessage(message.client_ref);
    this.logger?.info('nexus_webhook_processed', { client_ref: message.client_ref, provider_message_id: payload.message_id, status: updated.status });
    return { duplicate: false, message: updated };
  }

  async pollOrbit() {
    const outcomes = [];
    for (const clientRef of this.store.listPendingOrbit()) {
      const message = this.store.getMessage(clientRef);
      try {
        const raw = await this.orbit.poll(message.provider_message_id);
        const mapped = mapOrbitStatus(raw.status);
        if (!mapped) {
          this.store.addAudit(clientRef, 'orbit_poll_unmapped_status', null, null, { raw_status: raw.status, raw });
          outcomes.push({ client_ref: clientRef, status: message.status, ignored: true });
          continue;
        }
        if (mapped === 'FAILED') this.store.failMessage(clientRef, raw.error || `Orbit reported ${raw.status}.`, 'orbit_poll_status', { raw });
        else this.store.transition(clientRef, mapped, 'orbit_poll_status', { raw });
        const updated = this.store.getMessage(clientRef);
        this.logger?.info('orbit_polled', { client_ref: clientRef, provider_message_id: message.provider_message_id, status: updated.status });
        outcomes.push({ client_ref: clientRef, status: updated.status });
      } catch (error) {
        this.store.addAudit(clientRef, 'orbit_poll_error', null, null, { error: errorText(error) });
        this.logger?.error('orbit_poll_failed', { client_ref: clientRef, error: errorText(error) });
        outcomes.push({ client_ref: clientRef, status: message.status, error: errorText(error) });
      }
    }
    return outcomes;
  }
}
