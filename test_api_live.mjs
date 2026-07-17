// Live API test script — run while the server is listening on localhost:3000
import { createHmac } from 'node:crypto';

const BASE = 'http://localhost:3000';
const results = [];

async function test(name, method, path, { body, headers = {}, expectedStatus = 200 } = {}) {
  const opts = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  let res, text;
  try {
    res = await fetch(`${BASE}${path}`, opts);
    text = await res.text();
  } catch (err) {
    console.log(`\n[FAIL] ${name}`);
    console.log(`  ${method} ${path} -> NETWORK ERROR: ${err.message}`);
    results.push({ name, pass: false, got: 'ERR', expected: expectedStatus });
    return null;
  }
  const pass = res.status === expectedStatus;
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`\n[${icon}] ${name}`);
  console.log(`  ${method} ${path} -> ${res.status} (expected ${expectedStatus})`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`  Response: ${JSON.stringify(parsed).slice(0, 300)}`);
  results.push({ name, pass, got: res.status, expected: expectedStatus });
  return parsed;
}

function sign(body, secret = 'dev-nexus-webhook-secret') {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

console.log('='.repeat(50));
console.log(' API Endpoint Test Suite');
console.log(' ' + new Date().toISOString());
console.log('='.repeat(50));

// ── Health ──
console.log('\n--- HEALTH CHECK ---');
await test('GET /health', 'GET', '/health');

// ── POST /v1/messages – Happy Paths ──
console.log('\n--- POST /v1/messages (Happy Paths) ---');
const nexusResp = await test('Create Nexus msg (NEXUS01)', 'POST', '/v1/messages', {
  body: { client_ref: 'live-nexus1', sender_id: 'NEXUS01', channel: 'sms', destination: '+14155550100', text: 'Hello from Nexus live test' }
});
await test('Create Nexus msg (NEXUS02)', 'POST', '/v1/messages', {
  body: { client_ref: 'live-nexus2', sender_id: 'NEXUS02', channel: 'sms', destination: '+14155550100', text: 'Hello from Nexus02 live test' }
});
await test('Create Orbit msg (ORBIT01)', 'POST', '/v1/messages', {
  body: { client_ref: 'live-orbit1', sender_id: 'ORBIT01', channel: 'sms', destination: '+14155550100', text: 'Hello from Orbit live test' }
});
await test('Create AUTO01 msg (failover)', 'POST', '/v1/messages', {
  body: { client_ref: 'live-auto1', sender_id: 'AUTO01', channel: 'sms', destination: '+14155550100', text: 'Hello from AUTO01 live test' }
});

// ── GET /v1/messages/{client_ref} – Lookup ──
console.log('\n--- GET /v1/messages/{client_ref} (Lookup) ---');
await test('Get Nexus message', 'GET', '/v1/messages/live-nexus1');
await test('Get Orbit message', 'GET', '/v1/messages/live-orbit1');
await test('Get AUTO01 message', 'GET', '/v1/messages/live-auto1');
await test('Get non-existent message', 'GET', '/v1/messages/does-not-exist-xyz', { expectedStatus: 404 });

// ── Idempotency ──
console.log('\n--- IDEMPOTENCY ---');
await test('Replay same client_ref (idempotent)', 'POST', '/v1/messages', {
  body: { client_ref: 'live-nexus1', sender_id: 'NEXUS01', channel: 'sms', destination: '+14155550100', text: 'Hello from Nexus live test' }
});
await test('Conflict: same ref, different payload', 'POST', '/v1/messages', {
  body: { client_ref: 'live-nexus1', sender_id: 'NEXUS01', channel: 'sms', destination: '+14155550100', text: 'TOTALLY DIFFERENT' },
  expectedStatus: 409
});

// ── Validation Errors ──
console.log('\n--- VALIDATION ERRORS ---');
await test('Unknown sender_id', 'POST', '/v1/messages', {
  body: { client_ref: 'v-unknown', sender_id: 'UNKNOWN', channel: 'sms', destination: '+14155550100', text: 'Hi' },
  expectedStatus: 400
});
await test('Invalid E.164 destination', 'POST', '/v1/messages', {
  body: { client_ref: 'v-bad-e164', sender_id: 'NEXUS01', channel: 'sms', destination: '4155550100', text: 'Hi' },
  expectedStatus: 400
});
await test('Invalid channel', 'POST', '/v1/messages', {
  body: { client_ref: 'v-bad-chan', sender_id: 'NEXUS01', channel: 'email', destination: '+14155550100', text: 'Hi' },
  expectedStatus: 400
});
await test('Missing field (text)', 'POST', '/v1/messages', {
  body: { client_ref: 'v-no-text', sender_id: 'NEXUS01', channel: 'sms', destination: '+14155550100' },
  expectedStatus: 400
});
await test('Empty body', 'POST', '/v1/messages', {
  body: '', headers: { 'content-type': 'application/json' },
  expectedStatus: 400
});
await test('Malformed JSON', 'POST', '/v1/messages', {
  body: '{bad}',
  expectedStatus: 400
});
await test('Blank text', 'POST', '/v1/messages', {
  body: { client_ref: 'v-blank', sender_id: 'NEXUS01', channel: 'sms', destination: '+14155550100', text: '   ' },
  expectedStatus: 400
});
await test('Text > 1600 chars', 'POST', '/v1/messages', {
  body: { client_ref: 'v-long', sender_id: 'NEXUS01', channel: 'sms', destination: '+14155550100', text: 'A'.repeat(1601) },
  expectedStatus: 400
});
await test('Missing client_ref', 'POST', '/v1/messages', {
  body: { sender_id: 'NEXUS01', channel: 'sms', destination: '+14155550100', text: 'Hi' },
  expectedStatus: 400
});

// ── Nexus Webhook ──
console.log('\n--- NEXUS WEBHOOK ---');
const providerMsgId = nexusResp?.provider_message_id;
const webhookBody = JSON.stringify({ message_id: providerMsgId, status: 'delivered' });
const sig = sign(webhookBody);

const whResult = await test('Valid Nexus webhook (delivered)', 'POST', '/webhooks/nexus/status', {
  body: webhookBody,
  headers: { 'x-nexus-signature': sig, 'x-nexus-event-id': 'live-evt-1' }
});

const whDup = await test('Duplicate webhook (same event-id)', 'POST', '/webhooks/nexus/status', {
  body: webhookBody,
  headers: { 'x-nexus-signature': sig, 'x-nexus-event-id': 'live-evt-1' }
});

await test('Invalid webhook signature', 'POST', '/webhooks/nexus/status', {
  body: webhookBody,
  headers: { 'x-nexus-signature': 'sha256=0000bad', 'x-nexus-event-id': 'live-evt-bad' },
  expectedStatus: 401
});

await test('Missing webhook signature', 'POST', '/webhooks/nexus/status', {
  body: webhookBody,
  expectedStatus: 401
});

// ── Post-webhook verification ──
console.log('\n--- POST-WEBHOOK VERIFICATION ---');
const afterWh = await test('Nexus message now DELIVERED', 'GET', '/v1/messages/live-nexus1');
if (afterWh?.status === 'DELIVERED') {
  console.log('  ✓ Status confirmed as DELIVERED');
} else {
  console.log(`  ✗ Expected DELIVERED, got ${afterWh?.status}`);
}
if (whDup?.duplicate === true) {
  console.log('  ✓ Duplicate webhook correctly marked');
}

// ── Orbit DLR Poll ──
console.log('\n--- ORBIT DLR POLL ---');
const pollResult = await test('Poll Orbit delivery status', 'POST', '/v1/dlr/poll');
console.log(`  Polled: ${pollResult?.polled} messages`);

const orbitAfter = await test('Orbit message after poll', 'GET', '/v1/messages/live-orbit1');
console.log(`  Orbit status: ${orbitAfter?.status}`);

// ── Route Not Found ──
console.log('\n--- ROUTE NOT FOUND ---');
await test('GET unknown route', 'GET', '/unknown', { expectedStatus: 404 });
await test('POST unknown route', 'POST', '/v1/unknown', { body: {}, expectedStatus: 404 });
await test('DELETE method (no routes)', 'DELETE', '/v1/messages/live-nexus1', { expectedStatus: 404 });

// ── Summary ──
console.log('\n' + '='.repeat(50));
console.log(' TEST SUMMARY');
console.log('='.repeat(50));
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log(` Total:  ${results.length}`);
console.log(` Passed: ${passed}`);
console.log(` Failed: ${failed}`);
if (failed > 0) {
  console.log('\n FAILED TESTS:');
  results.filter(r => !r.pass).forEach(r => {
    console.log(`   - ${r.name}: got ${r.got}, expected ${r.expected}`);
  });
}
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
