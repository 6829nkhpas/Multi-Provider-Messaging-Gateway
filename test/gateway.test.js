import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MessageStore } from '../src/store.js';
import { MessagingGateway } from '../src/gateway.js';
import { NexusClient } from '../src/providers/nexus.js';
import { OrbitClient } from '../src/providers/orbit.js';
import { ProviderError } from '../src/errors.js';
import { createHttpHandler, signNexusPayload } from '../src/http.js';
import { createLogger } from '../src/logger.js';

const secret = 'test-nexus-secret';

function message(overrides = {}) {
  return {
    client_ref: 'msg_1',
    sender_id: 'NEXUS01',
    channel: 'sms',
    destination: '+14155550100',
    text: 'Hi',
    ...overrides
  };
}

function reply(status, body, headers = {}) {
  return { status, body, headers: { get: (name) => headers[name.toLowerCase()] ?? null } };
}

function makeGateway({ nexusSend, orbitSend, orbitPoll, nexusOptions = {}, orbitOptions = {} } = {}) {
  const store = new MessageStore(':memory:');
  const nexus = new NexusClient({
    maxRateLimitRetries: 3,
    retryBaseMs: 1,
    retryJitterMs: 0,
    sleep: async () => {},
    sendImpl: nexusSend || (async () => reply(202, { message_id: 'nex_default' })),
    ...nexusOptions
  });
  const orbit = new OrbitClient({
    sendImpl: orbitSend || (async () => reply(202, { message_id: 'orb_default' })),
    pollImpl: orbitPoll || (async (id) => reply(200, { message_id: id, status: 'delivered' })),
    ...orbitOptions
  });
  const logs = [];
  const logger = { info: (event, fields) => logs.push({ level: 'info', event, ...fields }), error: (event, fields) => logs.push({ level: 'error', event, ...fields }) };
  const gateway = new MessagingGateway({ store, nexus, orbit, logger });
  return { gateway, store, nexus, orbit, logs };
}

test('routes NEXUS01 only to Nexus', async (t) => {
  let nexusCalls = 0;
  let orbitCalls = 0;
  const { gateway, store } = makeGateway({
    nexusSend: async () => { nexusCalls += 1; return reply(202, { message_id: 'nex_1' }); },
    orbitSend: async () => { orbitCalls += 1; return reply(202, { message_id: 'orb_1' }); }
  });
  t.after(() => store.close());
  const result = await gateway.submit(message({ sender_id: 'NEXUS01' }));
  assert.equal(result.provider, 'nexus');
  assert.equal(result.status, 'SUBMITTED');
  assert.equal(nexusCalls, 1);
  assert.equal(orbitCalls, 0);
});

test('routes NEXUS02 only to Nexus', async (t) => {
  let nexusCalls = 0;
  const { gateway, store } = makeGateway({ nexusSend: async () => { nexusCalls += 1; return reply(202, { message_id: 'nex_2' }); } });
  t.after(() => store.close());
  const result = await gateway.submit(message({ client_ref: 'nexus_2', sender_id: 'NEXUS02' }));
  assert.equal(result.provider, 'nexus');
  assert.equal(nexusCalls, 1);
});

test('routes ORBIT01 only to Orbit', async (t) => {
  let nexusCalls = 0;
  let orbitCalls = 0;
  const { gateway, store } = makeGateway({
    nexusSend: async () => { nexusCalls += 1; return reply(202, { message_id: 'nex_never' }); },
    orbitSend: async () => { orbitCalls += 1; return reply(202, { message_id: 'orb_1' }); }
  });
  t.after(() => store.close());
  const result = await gateway.submit(message({ client_ref: 'orbit_1', sender_id: 'ORBIT01' }));
  assert.equal(result.provider, 'orbit');
  assert.equal(nexusCalls, 0);
  assert.equal(orbitCalls, 1);
});

test('rejects an unknown sender_id', async (t) => {
  const { gateway, store } = makeGateway();
  t.after(() => store.close());
  await assert.rejects(() => gateway.submit(message({ sender_id: 'NOPE01' })), { status: 400, code: 'UNKNOWN_SENDER_ID' });
});

test('rejects a malformed E.164 destination', async (t) => {
  const { gateway, store } = makeGateway();
  t.after(() => store.close());
  await assert.rejects(() => gateway.submit(message({ destination: '4155550100' })), { status: 400, code: 'INVALID_DESTINATION' });
});

test('rejects blank text', async (t) => {
  const { gateway, store } = makeGateway();
  t.after(() => store.close());
  await assert.rejects(() => gateway.submit(message({ text: '   ' })), { status: 400, code: 'INVALID_FIELD' });
});

test('persists accepted and submitted audit trail', async (t) => {
  const { gateway, store } = makeGateway();
  t.after(() => store.close());
  const result = await gateway.submit(message({ client_ref: 'audit_1' }));
  assert.deepEqual(result.audit_trail.map((entry) => entry.event), ['message_accepted', 'provider_attempt_started', 'provider_submitted']);
  assert.equal(result.audit_trail.at(-1).to_status, 'SUBMITTED');
});

test('same client_ref is idempotent sequentially', async (t) => {
  let calls = 0;
  const { gateway, store } = makeGateway({ nexusSend: async () => { calls += 1; return reply(202, { message_id: 'nex_idem' }); } });
  t.after(() => store.close());
  const first = await gateway.submit(message({ client_ref: 'idem_1' }));
  const second = await gateway.submit(message({ client_ref: 'idem_1' }));
  assert.equal(calls, 1);
  assert.equal(first.provider_message_id, second.provider_message_id);
  assert.equal(second.attempts.length, 1);
});

test('same client_ref sends once under concurrent requests', async (t) => {
  let calls = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { gateway, store } = makeGateway({
    nexusSend: async () => { calls += 1; await waiting; return reply(202, { message_id: 'nex_race' }); }
  });
  t.after(() => store.close());
  const first = gateway.submit(message({ client_ref: 'race_1' }));
  const second = gateway.submit(message({ client_ref: 'race_1' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.provider_message_id, 'nex_race');
  assert.equal(two.provider_message_id, 'nex_race');
  assert.equal(store.getMessage('race_1').attempts.length, 1);
});

test('same client_ref with a different request returns conflict', async (t) => {
  const { gateway, store } = makeGateway();
  t.after(() => store.close());
  await gateway.submit(message({ client_ref: 'conflict_1' }));
  await assert.rejects(() => gateway.submit(message({ client_ref: 'conflict_1', text: 'Different' })), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
});

test('AUTO01 stops after successful Nexus send', async (t) => {
  let orbitCalls = 0;
  const { gateway, store } = makeGateway({ orbitSend: async () => { orbitCalls += 1; return reply(202, { message_id: 'orb_never' }); } });
  t.after(() => store.close());
  const result = await gateway.submit(message({ client_ref: 'auto_nexus', sender_id: 'AUTO01' }));
  assert.equal(result.provider, 'nexus');
  assert.equal(orbitCalls, 0);
  assert.equal(result.attempts.length, 1);
});

test('AUTO01 retries through Orbit exactly once after Nexus 5xx', async (t) => {
  let nexusCalls = 0;
  let orbitCalls = 0;
  const { gateway, store } = makeGateway({
    nexusSend: async () => { nexusCalls += 1; return reply(503, {}); },
    orbitSend: async () => { orbitCalls += 1; return reply(202, { message_id: 'orb_failover' }); }
  });
  t.after(() => store.close());
  const result = await gateway.submit(message({ client_ref: 'auto_5xx', sender_id: 'AUTO01' }));
  assert.equal(nexusCalls, 1);
  assert.equal(orbitCalls, 1);
  assert.equal(result.provider, 'orbit');
  assert.equal(result.status, 'SUBMITTED');
  assert.equal(result.attempts.length, 2);
});

test('AUTO01 fails over to Orbit on Nexus timeout', async (t) => {
  let orbitCalls = 0;
  const { gateway, store } = makeGateway({
    nexusSend: async () => { throw new ProviderError('timed out', { kind: 'timeout' }); },
    orbitSend: async () => { orbitCalls += 1; return reply(202, { message_id: 'orb_timeout' }); }
  });
  t.after(() => store.close());
  const result = await gateway.submit(message({ client_ref: 'auto_timeout', sender_id: 'AUTO01' }));
  assert.equal(orbitCalls, 1);
  assert.equal(result.provider, 'orbit');
});

test('AUTO01 does not fail over after an exhausted Nexus 429', async (t) => {
  let orbitCalls = 0;
  const { gateway, store } = makeGateway({
    nexusSend: async () => reply(429, {}),
    orbitSend: async () => { orbitCalls += 1; return reply(202, { message_id: 'orb_should_not_send' }); },
    nexusOptions: { maxRateLimitRetries: 0 }
  });
  t.after(() => store.close());
  const result = await gateway.submit(message({ client_ref: 'auto_429', sender_id: 'AUTO01' }));
  assert.equal(orbitCalls, 0);
  assert.equal(result.status, 'FAILED');
  assert.match(result.last_error, /rate limit/i);
});

test('Nexus retries 429 with exponential backoff and jitter cap', async () => {
  const responses = [reply(429, {}), reply(429, {}), reply(202, { message_id: 'nex_after_retry' })];
  const waits = [];
  const nexus = new NexusClient({
    sendImpl: async () => responses.shift(),
    retryBaseMs: 20,
    retryJitterMs: 0,
    random: () => 0,
    sleep: async (ms) => waits.push(ms)
  });
  const result = await nexus.send(message());
  assert.equal(result.providerMessageId, 'nex_after_retry');
  assert.deepEqual(waits, [20, 40]);
});

test('Nexus stops after at most three 429 retries', async () => {
  let calls = 0;
  const nexus = new NexusClient({
    maxRateLimitRetries: 3,
    sendImpl: async () => { calls += 1; return reply(429, {}); },
    sleep: async () => {},
    retryJitterMs: 0
  });
  await assert.rejects(() => nexus.send(message()), { name: 'ProviderError', kind: 'rate_limit' });
  assert.equal(calls, 4);
});

test('Nexus webhook maps SENT and DELIVERED statuses', async (t) => {
  const { gateway, store } = makeGateway();
  t.after(() => store.close());
  await gateway.submit(message({ client_ref: 'webhook_1' }));
  gateway.receiveNexusStatus({ message_id: 'nex_default', status: 'sent' }, 'event-sent');
  assert.equal(store.getMessage('webhook_1').status, 'SENT');
  gateway.receiveNexusStatus({ message_id: 'nex_default', status: 'delivered' }, 'event-delivered');
  assert.equal(store.getMessage('webhook_1').status, 'DELIVERED');
});

test('duplicate Nexus webhooks do not change state or audit twice', async (t) => {
  const { gateway, store } = makeGateway();
  t.after(() => store.close());
  await gateway.submit(message({ client_ref: 'dup_webhook' }));
  const first = gateway.receiveNexusStatus({ message_id: 'nex_default', status: 'sent' }, 'event-dup');
  const auditCount = store.getMessage('dup_webhook').audit_trail.length;
  const second = gateway.receiveNexusStatus({ message_id: 'nex_default', status: 'sent' }, 'event-dup');
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.getMessage('dup_webhook').audit_trail.length, auditCount);
});

test('Orbit poll maps a pending message to SENT then DELIVERED', async (t) => {
  const statuses = ['sent', 'delivered'];
  const { gateway, store } = makeGateway({ orbitPoll: async (id) => reply(200, { message_id: id, status: statuses.shift() }) });
  t.after(() => store.close());
  await gateway.submit(message({ client_ref: 'orbit_poll', sender_id: 'ORBIT01' }));
  const first = await gateway.pollOrbit();
  assert.equal(first[0].status, 'SENT');
  const second = await gateway.pollOrbit();
  assert.equal(second[0].status, 'DELIVERED');
  assert.equal(store.getMessage('orbit_poll').status, 'DELIVERED');
});

test('Orbit poll failure is audited without corrupting pending message', async (t) => {
  const { gateway, store } = makeGateway({ orbitPoll: async () => { throw new Error('temporarily unavailable'); } });
  t.after(() => store.close());
  await gateway.submit(message({ client_ref: 'orbit_poll_err', sender_id: 'ORBIT01' }));
  const result = await gateway.pollOrbit();
  assert.equal(result[0].status, 'SUBMITTED');
  assert.match(result[0].error, /unavailable/);
  assert.equal(store.getMessage('orbit_poll_err').status, 'SUBMITTED');
});

test('HTTP endpoint rejects an invalid Nexus HMAC', async (t) => {
  const { gateway, store } = makeGateway();
  const server = createServer(createHttpHandler({ gateway, nexusWebhookSecret: secret }));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => { server.close(); store.close(); });
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/nexus/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nexus-signature': 'sha256=wrong' }, body: JSON.stringify({ message_id: 'nex_any', status: 'sent' })
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'INVALID_SIGNATURE');
});

test('HTTP endpoint accepts a signed Nexus webhook and deduplicates it', async (t) => {
  const { gateway, store } = makeGateway();
  await gateway.submit(message({ client_ref: 'signed_hook' }));
  const server = createServer(createHttpHandler({ gateway, nexusWebhookSecret: secret }));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => { server.close(); store.close(); });
  const body = JSON.stringify({ message_id: 'nex_default', status: 'sent' });
  const headers = { 'content-type': 'application/json', 'x-nexus-signature': signNexusPayload(body, secret), 'x-nexus-event-id': 'hook_1' };
  const first = await fetch(`http://127.0.0.1:${port}/webhooks/nexus/status`, { method: 'POST', headers, body });
  const second = await fetch(`http://127.0.0.1:${port}/webhooks/nexus/status`, { method: 'POST', headers, body });
  assert.equal((await first.json()).duplicate, false);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(store.getMessage('signed_hook').status, 'SENT');
});

test('real Nexus HTTP adapter sends Bearer authentication and idempotency key', async () => {
  let captured;
  const nexus = new NexusClient({
    baseUrl: 'https://nexus.example', bearerToken: 'bearer-value',
    fetchImpl: async (url, options) => { captured = { url, options }; return reply(202, { message_id: 'nex_headers' }); }
  });
  await nexus.send(message({ client_ref: 'headers_1' }));
  assert.equal(captured.url, 'https://nexus.example/messages');
  assert.equal(captured.options.headers.authorization, 'Bearer bearer-value');
  assert.equal(captured.options.headers['idempotency-key'], 'headers_1');
});

test('real Orbit HTTP adapter sends API-key header and requires 202', async () => {
  let captured;
  const orbit = new OrbitClient({
    baseUrl: 'https://orbit.example', apiKey: 'orbit-key',
    fetchImpl: async (url, options) => { captured = { url, options }; return reply(202, { message_id: 'orb_headers' }); }
  });
  await orbit.send(message({ sender_id: 'ORBIT01', client_ref: 'orbit_headers' }));
  assert.equal(captured.url, 'https://orbit.example/messages');
  assert.equal(captured.options.headers['x-api-key'], 'orbit-key');
  assert.equal(captured.options.headers['idempotency-key'], 'orbit_headers');
});

test('structured logger emits correlation fields and redacts sensitive values', () => {
  const lines = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => '2026-07-18T10:15:00.000Z'
  }).child({ request_id: 'req_123' });
  logger.info('message_accepted', {
    client_ref: 'log_1',
    destination: '+14155550100',
    destination_last4: '0100',
    text: 'private message text',
    api_key: 'private-key'
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.timestamp, '2026-07-18T10:15:00.000Z');
  assert.equal(record.level, 'info');
  assert.equal(record.service, 'messaging-gateway');
  assert.equal(record.event, 'message_accepted');
  assert.equal(record.request_id, 'req_123');
  assert.equal(record.client_ref, 'log_1');
  assert.equal(record.destination, '[REDACTED]');
  assert.equal(record.text, '[REDACTED]');
  assert.equal(record.api_key, '[REDACTED]');
  assert.equal(record.destination_last4, '0100');
});

test('logger honors the configured minimum severity', () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line), level: 'warn' });
  logger.info('not_written');
  logger.warn('written');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'written');
  assert.equal(JSON.parse(lines[0]).level, 'warn');
});
