import { randomUUID } from 'node:crypto';
import { ProviderError } from '../errors.js';

function responseBody(response) {
  if (response && typeof response.json === 'function') return response.json();
  return Promise.resolve(response?.body ?? {});
}

function header(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.[name.toLowerCase()] ?? null;
}

function toProviderError(error) {
  if (error instanceof ProviderError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new ProviderError('Nexus request timed out.', { kind: 'timeout', cause: error });
  }
  return new ProviderError(`Nexus network error: ${error.message}`, { kind: 'timeout', cause: error });
}

export class NexusClient {
  constructor({ baseUrl = null, bearerToken, maxRateLimitRetries = 3, retryBaseMs = 100, retryJitterMs = 50, fetchImpl = globalThis.fetch, sleep = defaultSleep, random = Math.random, logger, sendImpl } = {}) {
    this.baseUrl = baseUrl;
    this.bearerToken = bearerToken;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.retryBaseMs = retryBaseMs;
    this.retryJitterMs = retryJitterMs;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.random = random;
    this.logger = logger;
    this.sendImpl = sendImpl;
  }

  async send(message) {
    let retryCount = 0;
    while (true) {
      let response;
      try {
        response = await this.request(message);
      } catch (error) {
        throw toProviderError(error);
      }

      if (response.status === 429) {
        if (retryCount >= this.maxRateLimitRetries) {
          throw new ProviderError('Nexus rate limit retries exhausted.', { status: 429, kind: 'rate_limit' });
        }
        const retryAfterMs = parseRetryAfter(header(response, 'retry-after'));
        const delay = retryAfterMs ?? (this.retryBaseMs * (2 ** retryCount)) + Math.floor(this.random() * this.retryJitterMs);
        retryCount += 1;
        this.logger?.info('nexus_rate_limited_retry', { client_ref: message.client_ref, retry: retryCount, delay_ms: delay });
        await this.sleep(delay);
        continue;
      }
      if (response.status >= 500) {
        throw new ProviderError(`Nexus returned HTTP ${response.status}.`, { status: response.status, kind: 'server' });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ProviderError(`Nexus rejected the message with HTTP ${response.status}.`, { status: response.status, kind: 'provider' });
      }
      const raw = await responseBody(response);
      const providerMessageId = raw.message_id || raw.id;
      if (!providerMessageId) {
        throw new ProviderError('Nexus response did not include a message_id.', { kind: 'provider' });
      }
      return { providerMessageId, raw };
    }
  }

  async request(message) {
    if (this.sendImpl) return this.sendImpl(message);
    if (!this.baseUrl) {
      return { status: 202, body: { message_id: `nex_${randomUUID()}`, status: 'accepted', simulated: true } };
    }
    return this.fetch(`${this.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        'content-type': 'application/json',
        'idempotency-key': message.client_ref
      },
      body: JSON.stringify({ sender_id: message.sender_id, destination: message.destination, text: message.text }),
      signal: AbortSignal.timeout(5000)
    });
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
