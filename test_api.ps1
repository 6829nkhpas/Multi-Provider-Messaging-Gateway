$baseUrl = "http://localhost:3000"
$results = @()

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method,
        [string]$Path,
        [string]$Body = $null,
        [hashtable]$Headers = @{},
        [int]$ExpectedStatus = 200
    )
    $uri = "$baseUrl$Path"
    $params = @{
        Method = $Method
        Uri = $uri
        ContentType = "application/json"
        ErrorAction = "Stop"
    }
    if ($Body) { $params.Body = [System.Text.Encoding]::UTF8.GetBytes($Body) }
    foreach ($h in $Headers.GetEnumerator()) { 
        if (-not $params.ContainsKey("Headers")) { $params.Headers = @{} }
        $params.Headers[$h.Key] = $h.Value
    }
    
    try {
        $response = Invoke-WebRequest @params
        $status = $response.StatusCode
        $content = $response.Content
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        $content = ""
        try { 
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $content = $reader.ReadToEnd()
        } catch { $content = $_.Exception.Message }
    }
    
    $pass = $status -eq $ExpectedStatus
    $icon = if ($pass) { "PASS" } else { "FAIL" }
    Write-Host ""
    Write-Host "[$icon] $Name"
    Write-Host "  $Method $Path -> $status (expected $ExpectedStatus)"
    $parsed = $null
    try { $parsed = $content | ConvertFrom-Json | ConvertTo-Json -Depth 10 -Compress } catch {}
    if ($parsed) { Write-Host "  Response: $parsed" } else { Write-Host "  Response: $content" }
    return @{ Name = $Name; Pass = $pass; Status = $status; Expected = $ExpectedStatus }
}

Write-Host "============================================="
Write-Host " API Endpoint Test Suite"
Write-Host " $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "============================================="

# ==============================
# 1. Health Check
# ==============================
Write-Host "`n--- HEALTH CHECK ---"
$results += Test-Endpoint -Name "GET /health" -Method GET -Path "/health" -ExpectedStatus 200

# ==============================
# 2. POST /v1/messages - Happy Paths
# ==============================
Write-Host "`n--- POST /v1/messages (Happy Paths) ---"

$results += Test-Endpoint -Name "Create Nexus message (NEXUS01)" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"api-test-nexus1","sender_id":"NEXUS01","channel":"sms","destination":"+14155550100","text":"Hello from Nexus test"}' `
    -ExpectedStatus 200

$results += Test-Endpoint -Name "Create Nexus message (NEXUS02)" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"api-test-nexus2","sender_id":"NEXUS02","channel":"sms","destination":"+14155550100","text":"Hello from Nexus02 test"}' `
    -ExpectedStatus 200

$results += Test-Endpoint -Name "Create Orbit message (ORBIT01)" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"api-test-orbit1","sender_id":"ORBIT01","channel":"sms","destination":"+14155550100","text":"Hello from Orbit test"}' `
    -ExpectedStatus 200

$results += Test-Endpoint -Name "Create AUTO01 message (failover)" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"api-test-auto1","sender_id":"AUTO01","channel":"sms","destination":"+14155550100","text":"Hello from AUTO01 test"}' `
    -ExpectedStatus 200

# ==============================
# 3. GET /v1/messages/{client_ref} - Lookup
# ==============================
Write-Host "`n--- GET /v1/messages/{client_ref} (Lookup) ---"

$results += Test-Endpoint -Name "Get Nexus message" -Method GET -Path "/v1/messages/api-test-nexus1" -ExpectedStatus 200
$results += Test-Endpoint -Name "Get Orbit message" -Method GET -Path "/v1/messages/api-test-orbit1" -ExpectedStatus 200
$results += Test-Endpoint -Name "Get AUTO01 message" -Method GET -Path "/v1/messages/api-test-auto1" -ExpectedStatus 200
$results += Test-Endpoint -Name "Get non-existent message" -Method GET -Path "/v1/messages/does-not-exist" -ExpectedStatus 404

# ==============================
# 4. Idempotency Tests
# ==============================
Write-Host "`n--- IDEMPOTENCY ---"

$results += Test-Endpoint -Name "Replay same client_ref (idempotent)" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"api-test-nexus1","sender_id":"NEXUS01","channel":"sms","destination":"+14155550100","text":"Hello from Nexus test"}' `
    -ExpectedStatus 200

$results += Test-Endpoint -Name "Conflict: same client_ref, different payload" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"api-test-nexus1","sender_id":"NEXUS01","channel":"sms","destination":"+14155550100","text":"DIFFERENT TEXT"}' `
    -ExpectedStatus 409

# ==============================
# 5. Validation Error Tests
# ==============================
Write-Host "`n--- VALIDATION ERRORS ---"

$results += Test-Endpoint -Name "Unknown sender_id" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"bad-sender-api","sender_id":"UNKNOWN","channel":"sms","destination":"+14155550100","text":"Hi"}' `
    -ExpectedStatus 400

$results += Test-Endpoint -Name "Invalid E.164 destination" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"bad-number-api","sender_id":"NEXUS01","channel":"sms","destination":"4155550100","text":"Hi"}' `
    -ExpectedStatus 400

$results += Test-Endpoint -Name "Invalid channel" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"bad-channel-api","sender_id":"NEXUS01","channel":"email","destination":"+14155550100","text":"Hi"}' `
    -ExpectedStatus 400

$results += Test-Endpoint -Name "Missing required field (text)" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"bad-field-api","sender_id":"NEXUS01","channel":"sms","destination":"+14155550100"}' `
    -ExpectedStatus 400

$results += Test-Endpoint -Name "Empty body" -Method POST -Path "/v1/messages" `
    -Body '' `
    -ExpectedStatus 400

$results += Test-Endpoint -Name "Malformed JSON" -Method POST -Path "/v1/messages" `
    -Body '{bad json}' `
    -ExpectedStatus 400

$results += Test-Endpoint -Name "Empty text" -Method POST -Path "/v1/messages" `
    -Body '{"client_ref":"empty-text-api","sender_id":"NEXUS01","channel":"sms","destination":"+14155550100","text":"   "}' `
    -ExpectedStatus 400

# ==============================
# 6. Nexus Webhook (signed)
# ==============================
Write-Host "`n--- NEXUS WEBHOOK ---"

# First, get the provider_message_id from the nexus message
try {
    $nexusMsg = Invoke-WebRequest -Uri "$baseUrl/v1/messages/api-test-nexus1" -Method GET -ContentType "application/json" -ErrorAction Stop
    $nexusMsgData = $nexusMsg.Content | ConvertFrom-Json
    $providerMsgId = $nexusMsgData.provider_message_id
} catch {
    $providerMsgId = "unknown"
}

$webhookBody = "{`"message_id`":`"$providerMsgId`",`"status`":`"delivered`"}"
$secret = "dev-nexus-webhook-secret"
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
$hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($webhookBody))
$hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
$signature = "sha256=$hex"

$results += Test-Endpoint -Name "Valid Nexus webhook (delivered)" -Method POST -Path "/webhooks/nexus/status" `
    -Body $webhookBody `
    -Headers @{ "x-nexus-signature" = $signature; "x-nexus-event-id" = "test-event-1" } `
    -ExpectedStatus 200

# Duplicate webhook
$results += Test-Endpoint -Name "Duplicate Nexus webhook (same event-id)" -Method POST -Path "/webhooks/nexus/status" `
    -Body $webhookBody `
    -Headers @{ "x-nexus-signature" = $signature; "x-nexus-event-id" = "test-event-1" } `
    -ExpectedStatus 200

# Invalid signature
$results += Test-Endpoint -Name "Invalid Nexus webhook signature" -Method POST -Path "/webhooks/nexus/status" `
    -Body $webhookBody `
    -Headers @{ "x-nexus-signature" = "sha256=badbadbadbad"; "x-nexus-event-id" = "test-event-bad" } `
    -ExpectedStatus 401

# Missing signature
$results += Test-Endpoint -Name "Missing Nexus webhook signature" -Method POST -Path "/webhooks/nexus/status" `
    -Body $webhookBody `
    -ExpectedStatus 401

# ==============================
# 7. Verify message after webhook delivery
# ==============================
Write-Host "`n--- POST-WEBHOOK VERIFICATION ---"

$results += Test-Endpoint -Name "Nexus message now DELIVERED" -Method GET -Path "/v1/messages/api-test-nexus1" -ExpectedStatus 200

# ==============================
# 8. Orbit DLR Poll
# ==============================
Write-Host "`n--- ORBIT DLR POLL ---"

$results += Test-Endpoint -Name "Poll Orbit delivery status" -Method POST -Path "/v1/dlr/poll" -ExpectedStatus 200

# Verify orbit message after poll
$results += Test-Endpoint -Name "Orbit message after poll" -Method GET -Path "/v1/messages/api-test-orbit1" -ExpectedStatus 200

# ==============================
# 9. Route Not Found
# ==============================
Write-Host "`n--- ROUTE NOT FOUND ---"

$results += Test-Endpoint -Name "Unknown route (GET /unknown)" -Method GET -Path "/unknown" -ExpectedStatus 404
$results += Test-Endpoint -Name "Unknown route (POST /v1/unknown)" -Method POST -Path "/v1/unknown" -Body '{}' -ExpectedStatus 404

# ==============================
# SUMMARY
# ==============================
Write-Host ""
Write-Host "============================================="
Write-Host " TEST SUMMARY"
Write-Host "============================================="
$passed = ($results | Where-Object { $_.Pass }).Count
$failed = ($results | Where-Object { -not $_.Pass }).Count
$total = $results.Count
Write-Host " Total:  $total"
Write-Host " Passed: $passed"
Write-Host " Failed: $failed"
if ($failed -gt 0) {
    Write-Host ""
    Write-Host " FAILED TESTS:"
    $results | Where-Object { -not $_.Pass } | ForEach-Object {
        Write-Host "   - $($_.Name): got $($_.Status), expected $($_.Expected)"
    }
}
Write-Host "============================================="
