# curl / PowerShell examples

Start the service first:

```powershell
npm.cmd start
```

## Happy paths

Create a Nexus message:

```powershell
curl.exe -i -X POST http://localhost:3000/v1/messages `
  -H "content-type: application/json" `
  -d '{"client_ref":"nexus-demo-1","sender_id":"NEXUS01","channel":"sms","destination":"+14155550100","text":"Hello from Nexus"}'
```

Create an Orbit message, then poll its delivery status:

```powershell
curl.exe -i -X POST http://localhost:3000/v1/messages `
  -H "content-type: application/json" `
  -d '{"client_ref":"orbit-demo-1","sender_id":"ORBIT01","channel":"sms","destination":"+14155550100","text":"Hello from Orbit"}'

curl.exe -i -X POST http://localhost:3000/v1/dlr/poll
curl.exe -s http://localhost:3000/v1/messages/orbit-demo-1
```

Inspect any message:

```powershell
curl.exe -s http://localhost:3000/v1/messages/nexus-demo-1
```

Send a signed Nexus delivery webhook. Set `NEXUS_WEBHOOK_SECRET` to the running server's secret (the default below is for local development):

```powershell
$secret = 'dev-nexus-webhook-secret'
$body = '{"message_id":"<provider_message_id_from_POST_response>","status":"delivered"}'
$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret))
$hex = -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body)) | ForEach-Object { $_.ToString('x2') })
curl.exe -i -X POST http://localhost:3000/webhooks/nexus/status `
  -H "content-type: application/json" `
  -H "x-nexus-event-id: nexus-demo-delivered-1" `
  -H "x-nexus-signature: sha256=$hex" `
  -d $body
```

Run that identical webhook a second time to see `{ "duplicate": true }` with no extra state change.

## Failure paths

Unknown sender IDs are rejected before any provider call:

```powershell
curl.exe -i -X POST http://localhost:3000/v1/messages `
  -H "content-type: application/json" `
  -d '{"client_ref":"bad-sender-1","sender_id":"UNKNOWN","channel":"sms","destination":"+14155550100","text":"Hi"}'
```

Malformed E.164 numbers are also rejected clearly:

```powershell
curl.exe -i -X POST http://localhost:3000/v1/messages `
  -H "content-type: application/json" `
  -d '{"client_ref":"bad-number-1","sender_id":"NEXUS01","channel":"sms","destination":"4155550100","text":"Hi"}'
```

For provider failures and AUTO failover, point `NEXUS_BASE_URL` and `ORBIT_BASE_URL` at test doubles that return a Nexus 503/timeout and an Orbit 202, respectively. The exact dispatch and single Orbit-attempt behaviour is demonstrated in `test/gateway.test.js`.
