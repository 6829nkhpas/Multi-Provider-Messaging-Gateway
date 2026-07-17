# Multi-Provider Messaging Gateway

A Node.js 22 + SQLite SMS gateway that routes exclusively by `sender_id`, persists message lifecycle/audit data, receives signed Nexus delivery webhooks, and polls Orbit delivery status.

No third-party runtime packages are required. SQLite is the durable system of record via Node's built-in `node:sqlite` module.

## Assignment deliverables

| Requirement | Included implementation |
| --- | --- |
| Durable store | SQLite schema for messages, provider attempts, audit events, and webhook receipts |
| Sender based routing | Nexus-only, Orbit-only, and AUTO failover rules in `src/config.js` |
| Idempotency and race safety | Unique `client_ref`, request fingerprinting, SQLite transaction, and in-process single-flight dispatch |
| Delivery tracking | Signed Nexus webhook plus Orbit polling endpoint/scheduled poller |
| Tests | 24 automated tests; routing, failover, concurrency, duplicate DLR, and rate-limit cases are all covered |
| One-page design note | [docs/design-note.md](docs/design-note.md) |
| Runnable API examples | [PowerShell/curl guide](examples/curl.md) and [Postman collection](postman/Messaging-Gateway.postman_collection.json) |

## Run

Requires Node **22.5+** (the project was built and tested with Node 22.14).

```powershell
npm.cmd test
npm.cmd start
```

The server starts on `http://localhost:3000`, stores data in `./data/gateway.sqlite`, and uses simulated providers when no provider base URLs are configured. The simulated Nexus provider accepts messages; invoke the Nexus webhook to provide delivery updates. The simulated Orbit provider accepts messages and returns `delivered` on the next poll.

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default `3000`) |
| `DATABASE_PATH` | SQLite database path |
| `NEXUS_BASE_URL` / `NEXUS_BEARER_TOKEN` | Real/fake Nexus endpoint and Bearer credential |
| `NEXUS_WEBHOOK_SECRET` | Secret used for `X-Nexus-Signature` validation |
| `ORBIT_BASE_URL` / `ORBIT_API_KEY` | Real/fake Orbit endpoint and API key |
| `POLL_INTERVAL_MS` | Optional automatic Orbit poll interval; `0` disables it |

With a configured provider URL, Nexus sends `POST {NEXUS_BASE_URL}/messages` with `Authorization: Bearer …`; Orbit sends `POST {ORBIT_BASE_URL}/messages` with `X-API-Key: …` and polls `GET {ORBIT_BASE_URL}/messages/{message_id}`.

## Architecture

```text
HTTP router
  -> MessagingGateway (validation, routing, idempotency, failover)
      -> NexusClient (Bearer auth, 429 retry, HMAC webhook source)
      -> OrbitClient (API key, asynchronous acceptance, polling source)
      -> MessageStore (SQLite messages, attempts, audits, webhook receipts)
  -> OrbitPoller (optional recurring poll trigger)
```

The modules are intentionally separated so the provider clients can be swapped for real HTTP integrations without changing routing or persistence rules.

## API

`POST /v1/messages`

```json
{
  "client_ref": "msg_1",
  "sender_id": "AUTO01",
  "channel": "sms",
  "destination": "+14155550100",
  "text": "Hi"
}
```

The first accepted request persists the message and performs the configured provider dispatch. Its response contains the current state and traceability data:

```json
{
  "client_ref": "msg_1",
  "route": "failover",
  "provider": "nexus",
  "provider_message_id": "nex_123",
  "status": "SUBMITTED",
  "last_error": null,
  "attempts": [{ "provider": "nexus", "status": "ACCEPTED" }],
  "audit_trail": [
    { "event": "message_accepted", "to_status": "ACCEPTED" },
    { "event": "provider_submitted", "to_status": "SUBMITTED" }
  ]
}
```

`GET /v1/messages/{client_ref}` returns the message, current lifecycle state, all provider attempts, `last_error`, and `audit_trail`.

`POST /webhooks/nexus/status` accepts a Nexus JSON payload such as:

```json
{ "message_id": "nex_123", "status": "delivered" }
```

It requires `X-Nexus-Signature: sha256=<HMAC of exact raw request body>` and accepts an optional `X-Nexus-Event-Id` for event-level deduplication.

`POST /v1/dlr/poll` polls every pending Orbit message once.

See [examples/curl.md](examples/curl.md) and [the Postman collection](postman/Messaging-Gateway.postman_collection.json) for runnable calls.

### Validation and error responses

All errors are JSON and use a stable code, for example:

```json
{
  "error": {
    "code": "INVALID_DESTINATION",
    "message": "destination must be a valid E.164 phone number (for example +14155550100)."
  }
}
```

| Case | Status | Code |
| --- | --- | --- |
| Empty/malformed JSON or missing field | `400` | `INVALID_BODY`, `INVALID_JSON`, or `INVALID_FIELD` |
| Unsupported channel | `400` | `INVALID_CHANNEL` |
| Bad E.164 destination | `400` | `INVALID_DESTINATION` |
| Empty/oversized text | `400` | `INVALID_FIELD` or `INVALID_TEXT` |
| Unknown sender | `400` | `UNKNOWN_SENDER_ID` |
| Same reference, different immutable payload | `409` | `IDEMPOTENCY_CONFLICT` |
| Missing message | `404` | `NOT_FOUND` |
| Invalid Nexus signature | `401` | `INVALID_SIGNATURE` |

## Routing and reliability behaviour

| Sender ID | Route |
| --- | --- |
| `NEXUS01`, `NEXUS02` | NexusSMS only |
| `ORBIT01` | OrbitMsg only |
| `AUTO01` | Nexus first; Orbit exactly once only if Nexus gives 5xx or times out |
| anything else | `400 UNKNOWN_SENDER_ID` |

Nexus `429` responses use exponential backoff plus jitter, with at most **three retries** (four requests total). A final 429 is terminal and deliberately does not trigger AUTO failover.

`client_ref` is a SQLite primary key. A request with the same reference and same immutable payload returns the stored result; an in-flight duplicate waits for the original dispatch. A different payload for an existing reference returns `409 IDEMPOTENCY_CONFLICT`. Provider submissions carry the same idempotency key.

### Delivery lifecycle

`ACCEPTED -> SUBMITTED -> SENT -> DELIVERED | FAILED`

- `ACCEPTED`: the SQLite message row was created.
- `SUBMITTED`: Nexus accepted the message, or Orbit returned asynchronous `202`.
- `SENT` / `DELIVERED` / `FAILED`: mapped from a signed Nexus webhook or an Orbit poll response.

Terminal states are not overwritten. Nexus receipt event IDs (or a payload hash when no event ID is supplied) are unique in SQLite, so duplicate webhooks cannot add a second state transition or corrupt the audit history. See the [design note](docs/design-note.md) for the mapping table and full state-machine rationale.

### Failover boundary

For `AUTO01`, a confirmed Nexus acceptance stops the workflow immediately. Only a Nexus server error or timeout permits exactly one Orbit attempt; exhausted rate limits and validation/provider rejections do not. Every attempt and decision is stored before the next action, so `GET /v1/messages/{client_ref}` remains an auditable account of what happened.

## Structured logs

The service writes one JSON object per line to standard output. This is directly consumable by production log collectors and avoids putting credentials, message content, or full phone numbers in logs.

Every record includes `timestamp`, `level`, `service`, and `event`. Request-completion records add `request_id`, HTTP method/path, status code, duration, and `client_ref` when known. Message records add the route/provider and use `destination_last4` plus `text_length` instead of sensitive payload data.

```json
{
  "timestamp": "2026-07-18T10:15:00.000Z",
  "level": "info",
  "service": "messaging-gateway",
  "event": "provider_submitted",
  "client_ref": "msg_1",
  "provider": "nexus",
  "provider_message_id": "nex_123"
}
```

Set `LOG_LEVEL=debug` to include request-start events; the default is `info`. Supported levels are `debug`, `info`, `warn`, and `error`. The logs cover message acceptance/replay, provider attempts/retries/failover, webhook duplication/status handling, polling, HTTP completion/error outcomes, and server lifecycle.

## Tests

```powershell
npm.cmd test
```

The suite has **24 tests**. It runs without external services because the provider adapters are injected with deterministic fakes.

| Requirement proven | Test coverage |
| --- | --- |
| Routing per sender | `NEXUS01`, `NEXUS02`, `ORBIT01`, and unknown sender tests |
| Failover | successful Nexus stops failover; Nexus 5xx/timeout sends Orbit once; terminal 429 does not |
| Concurrency/idempotency | sequential replay, simultaneous same-reference requests, and conflicting payload reuse |
| Duplicate DLR | duplicate Nexus event does not change state or append an audit event |
| Nexus rate limit | exponential backoff, jitter control, and three-retry cap |
| Delivery tracking | Nexus status mapping, signed webhook validation, Orbit `SENT`/`DELIVERED` polling |
| Provider protocol | Nexus Bearer token/idempotency header and Orbit API-key/202 contract |

The test file is [test/gateway.test.js](test/gateway.test.js). Run it before the walkthrough and before submitting:

```powershell
npm.cmd test
```

## Demo material

- [Design note](docs/design-note.md): one-page routing, state machine, idempotency, and reliability explanation.
- [curl guide](examples/curl.md): Nexus and Orbit happy paths, signed webhook delivery, duplicate-webhook check, and invalid sender/E.164 failures.
- [Postman collection](postman/Messaging-Gateway.postman_collection.json): import it, set `baseUrl`, then run the Nexus, Orbit, poll, lookup, and validation-failure requests.

## 20-minute walkthrough

1. **0–3 min:** `npm.cmd test`; point out the 24 passing behavioural tests.
2. **3–7 min:** start the service and send a Nexus and an Orbit message from `examples/curl.md`.
3. **7–10 min:** `GET /v1/messages/{client_ref}`; show the lifecycle, provider attempt, and audit trail.
4. **10–13 min:** send the signed Nexus webhook twice; show the second response is marked duplicate.
5. **13–15 min:** create an Orbit message and call `/v1/dlr/poll`; show it reaches `DELIVERED`.
6. **15–18 min:** tour `src/gateway.js`, `src/store.js`, and the two provider adapters.
7. **18–20 min:** cover the routing table, idempotency and timeout/failover trade-off in [docs/design-note.md](docs/design-note.md).
