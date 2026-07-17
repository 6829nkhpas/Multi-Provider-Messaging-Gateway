import { randomUUID } from 'node:crypto';
import { ProviderError } from '../errors.js';

async function bodyOf(response) {
  if (response && typeof response.json === 'function') return response.json();
  return response?.body ?? {};
}

export class OrbitClient {
  constructor({ baseUrl = null, apiKey, fetchImpl = globalThis.fetch, sendImpl, pollImpl } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.sendImpl = sendImpl;
    this.pollImpl = pollImpl;
  }

  async send(message) {
    let response;
    try {
      response = this.sendImpl ? await this.sendImpl(message) : await this.requestSend(message);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Orbit network error: ${error.message}`, { kind: 'timeout', cause: error });
    }
    if (response.status >= 500) throw new ProviderError(`Orbit returned HTTP ${response.status}.`, { status: response.status, kind: 'server' });
    if (response.status !== 202) throw new ProviderError(`Orbit must accept asynchronously with HTTP 202 (received ${response.status}).`, { status: response.status, kind: 'provider' });
    const raw = await bodyOf(response);
    const providerMessageId = raw.message_id || raw.id;
    if (!providerMessageId) throw new ProviderError('Orbit response did not include a message_id.', { kind: 'provider' });
    return { providerMessageId, raw };
  }

  async poll(providerMessageId) {
    let response;
    try {
      response = this.pollImpl ? await this.pollImpl(providerMessageId) : await this.requestPoll(providerMessageId);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Orbit poll network error: ${error.message}`, { kind: 'timeout', cause: error });
    }
    if (response.status >= 500) throw new ProviderError(`Orbit poll returned HTTP ${response.status}.`, { status: response.status, kind: 'server' });
    if (response.status < 200 || response.status >= 300) throw new ProviderError(`Orbit poll failed with HTTP ${response.status}.`, { status: response.status, kind: 'provider' });
    return bodyOf(response);
  }

  async requestSend(message) {
    if (!this.baseUrl) return { status: 202, body: { message_id: `orb_${randomUUID()}`, status: 'accepted', simulated: true } };
    return this.fetch(`${this.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json', 'idempotency-key': message.client_ref },
      body: JSON.stringify({ sender_id: message.sender_id, destination: message.destination, text: message.text }),
      signal: AbortSignal.timeout(5000)
    });
  }

  async requestPoll(providerMessageId) {
    if (!this.baseUrl) return { status: 200, body: { message_id: providerMessageId, status: 'delivered', simulated: true } };
    return this.fetch(`${this.baseUrl.replace(/\/$/, '')}/messages/${encodeURIComponent(providerMessageId)}`, {
      headers: { 'x-api-key': this.apiKey },
      signal: AbortSignal.timeout(5000)
    });
  }
}
