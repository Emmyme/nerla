# =============================================================================
# Nerla - One-command setup (Windows PowerShell)
#
# This script is idempotent: safe to re-run. It will:
#   1. Generate all secrets and write .env (skips if .env already has real values)
#   2. Start Docker containers
#   3. Wait for Garage to be healthy
#   4. Provision a Garage access key + bucket (if not already done)
#   5. Write the Garage key back into .env
#   6. Restart the server so it picks up the key
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Host "Nerla Setup" -ForegroundColor Cyan
Write-Host "============" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
try {
    docker --version | Out-Null
} catch {
    Write-Host "ERROR: Docker is not installed. https://docs.docker.com/get-docker/" -ForegroundColor Red
    exit 1
}

# A failing native command sets $LASTEXITCODE rather than throwing
docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: 'docker compose' is not available. Install Docker Desktop or the compose plugin." -ForegroundColor Red
    exit 1
}

# Docker Desktop installed but not started answers `docker info` with an error
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker is installed but not running. Start Docker Desktop, wait until it says it is running, then run this script again." -ForegroundColor Red
    exit 1
}

Write-Host "Docker and Docker Compose found."
Write-Host ""

# ---------------------------------------------------------------------------
# Helper: generate a random hex string
# ---------------------------------------------------------------------------
function Gen-Secret {
    param([int]$Bytes = 32)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buf = New-Object byte[] $Bytes
    $rng.GetBytes($buf)
    return ($buf | ForEach-Object { $_.ToString("x2") }) -join ''
}

# ---------------------------------------------------------------------------
# Helper: get a value from .env, return empty string if missing
# ---------------------------------------------------------------------------
function Env-Get {
    param([string]$Key)
    if (-not (Test-Path .env)) { return "" }
    $line = Get-Content .env | Where-Object { $_ -match "^$Key=" } | Select-Object -First 1
    if ($line) {
        return ($line -replace "^$Key=", "")
    }
    return ""
}

# UTF-8 without a BOM, which Windows PowerShell 5.1 would otherwise add
function Env-Write {
    param([string[]]$Lines)
    $path = Join-Path (Get-Location).Path ".env"
    [System.IO.File]::WriteAllLines($path, $Lines, (New-Object System.Text.UTF8Encoding $false))
}

# Sets KEY=value in .env, replacing an existing line or appending one
function Env-Set {
    param([string]$Key, [string]$Value)
    $content = @()
    if (Test-Path .env) { $content = @(Get-Content .env) }
    $found = $false
    $content = @($content | ForEach-Object {
        if ($_ -match "^$Key=") {
            $found = $true
            "$Key=$Value"
        } else {
            $_
        }
    })
    if (-not $found) {
        $content += "$Key=$Value"
    }
    Env-Write $content
}

# Example and known-weak values setup replaces. Keep in step with server/src/config.ts
function Is-Placeholder {
    param([string]$Value)
    $known = @(
        "postgres", "nerla", "nerla_password", "password", "changeme",
        "change-me-in-production", "secret", "jwt_secret",
        "your_super_secret_jwt_key_change_this_in_production", "your_livekit_secret_change_this", "APInerla"
    )
    return ($known -contains $Value)
}

# A secret given through NAME_FILE is never generated, or the server and Postgres would stop on the clash
function From-File {
    param([string]$Key)
    if (-not (Env-Get "${Key}_FILE")) { return $false }
    Write-Host "  $Key comes from ${Key}_FILE, so setup leaves it alone."
    return $true
}

function Set-Generated {
    param([string]$Key, [string]$Value)
    $old = Env-Get $Key
    Env-Set $Key $Value
    if ($old) {
        Write-Host "  Replaced the example $Key with a new random one."
    } else {
        Write-Host "  Generated $Key"
    }
}

# ---------------------------------------------------------------------------
# Step 1: Create / populate .env
# ---------------------------------------------------------------------------
Write-Host "--- Step 1: .env file ---"

if (-not (Test-Path .env)) {
    New-Item -Path .env -ItemType File | Out-Null
}

# Database
if (-not (Env-Get "DB_USER"))  { Env-Set "DB_USER" "nerla" }
if (-not (Env-Get "DB_NAME"))  { Env-Set "DB_NAME" "nerla" }
if (-not (Env-Get "DB_PORT"))  { Env-Set "DB_PORT" "5432" }

$dbpw = Env-Get "DB_PASSWORD"
if (-not (From-File "DB_PASSWORD") -and (-not $dbpw -or (Is-Placeholder $dbpw))) {
    Set-Generated "DB_PASSWORD" (Gen-Secret -Bytes 16)
}

# JWT secret must be at least 32 chars and not a known bad value
$jwt = Env-Get "JWT_SECRET"
if (-not (From-File "JWT_SECRET") -and (-not $jwt -or $jwt.Length -lt 32 -or (Is-Placeholder $jwt))) {
    Set-Generated "JWT_SECRET" (Gen-Secret -Bytes 32)
}

# LiveKit
$lkKey = Env-Get "LIVEKIT_API_KEY"
if (-not (From-File "LIVEKIT_API_KEY") -and (-not $lkKey -or (Is-Placeholder $lkKey))) {
    Set-Generated "LIVEKIT_API_KEY" ("APInerla" + (Gen-Secret -Bytes 8))
}
$lkSecret = Env-Get "LIVEKIT_API_SECRET"
if (-not (From-File "LIVEKIT_API_SECRET") -and (-not $lkSecret -or (Is-Placeholder $lkSecret))) {
    Set-Generated "LIVEKIT_API_SECRET" (Gen-Secret -Bytes 32)
}
if (-not (Env-Get "VITE_LIVEKIT_URL")) { Env-Set "VITE_LIVEKIT_URL" "ws://localhost:7880" }

# Never replaced once set, a new key would lock out saved AI keys
if (-not (From-File "AI_MASTER_KEY") -and -not (Env-Get "AI_MASTER_KEY")) {
    Env-Set "AI_MASTER_KEY" (Gen-Secret -Bytes 32)
    Write-Host "  Generated AI_MASTER_KEY"
}

# Garage infrastructure secrets
$rpc = Env-Get "GARAGE_RPC_SECRET"
if (-not $rpc) {
    Env-Set "GARAGE_RPC_SECRET" (Gen-Secret -Bytes 32)
    Write-Host "  Generated GARAGE_RPC_SECRET"
}

$admin = Env-Get "GARAGE_ADMIN_TOKEN"
if (-not $admin) {
    Env-Set "GARAGE_ADMIN_TOKEN" (Gen-Secret -Bytes 32)
    Write-Host "  Generated GARAGE_ADMIN_TOKEN"
}

# File storage in the bundled Garage, whose keys Step 5 fills in
if (-not (Env-Get "S3_ENDPOINT")) { Env-Set "S3_ENDPOINT" "http://garage:3900" }
if (-not (Env-Get "S3_REGION"))   { Env-Set "S3_REGION"   "garage" }
if (-not (Env-Get "S3_BUCKET"))   { Env-Set "S3_BUCKET"   "nerla-files" }

# Server / Client defaults
if (-not (Env-Get "SERVER_PORT"))  { Env-Set "SERVER_PORT"  "5000" }
if (-not (Env-Get "CLIENT_URL"))   { Env-Set "CLIENT_URL"   "http://localhost:3001" }
if (-not (Env-Get "NODE_ENV"))     { Env-Set "NODE_ENV"     "development" }
if (-not (Env-Get "TRUST_PROXY"))  { Env-Set "TRUST_PROXY"  "false" }
if (-not (Env-Get "EXPOSE_RESET_TOKEN")) { Env-Set "EXPOSE_RESET_TOKEN" "true" }

Write-Host "  .env is ready."
Write-Host ""

# ---------------------------------------------------------------------------
# Step 2: Generate garage.toml from template with real secrets
# ---------------------------------------------------------------------------
Write-Host "--- Step 2: Generating garage.toml ---"

if (-not (Test-Path "garage.toml.template")) {
    Write-Host "ERROR: garage.toml.template not found." -ForegroundColor Red
    exit 1
}

$rpcSecret = Env-Get "GARAGE_RPC_SECRET"
$adminToken = Env-Get "GARAGE_ADMIN_TOKEN"

$garage = (Get-Content "garage.toml.template" -Raw) `
    -replace 'RPC_SECRET_PLACEHOLDER', $rpcSecret `
    -replace 'ADMIN_TOKEN_PLACEHOLDER', $adminToken
# UTF-8 without a byte order mark, which a TOML parser may refuse
[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path "garage.toml"), $garage, (New-Object System.Text.UTF8Encoding $false))

Write-Host "  garage.toml generated with secrets."
Write-Host ""

# ---------------------------------------------------------------------------
# Step 3: Start containers
# ---------------------------------------------------------------------------
Write-Host "--- Step 3: Starting containers ---"
docker compose up -d --build
Write-Host ""

# ---------------------------------------------------------------------------
# Step 4: Wait for Garage to be healthy
# ---------------------------------------------------------------------------
Write-Host "--- Step 4: Waiting for Garage to be healthy ---"
$maxWait = 90
$elapsed = 0
while ($elapsed -lt $maxWait) {
    $result = docker exec nerla-garage /garage -c /etc/garage.toml status 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Garage is ready (${elapsed}s)."
        break
    }
    Start-Sleep -Seconds 2
    $elapsed += 2
    Write-Host "  waiting... (${elapsed}s)" -NoNewline
    Write-Host "`r" -NoNewline
}

if ($elapsed -ge $maxWait) {
    Write-Host ""
    Write-Host "ERROR: Garage did not become healthy within ${maxWait}s." -ForegroundColor Red
    Write-Host "Check: docker logs nerla-garage"
    exit 1
}
Write-Host ""

# ---------------------------------------------------------------------------
# Step 5: Provision Garage layout, key, and bucket
# ---------------------------------------------------------------------------
Write-Host "--- Step 5: Provisioning Garage storage ---"

$garageCmd = "docker exec nerla-garage /garage -c /etc/garage.toml"

# Assign a layout if none has been applied yet
$statusOutput = Invoke-Expression "$garageCmd status 2>`$null" | Out-String
$nodeMatch = [regex]::Match($statusOutput, '[0-9a-f]{16}')
if ($nodeMatch.Success) {
    $nodeId = $nodeMatch.Value
    $layoutOutput = Invoke-Expression "$garageCmd layout show 2>`$null" | Out-String
    if ($layoutOutput -notmatch [regex]::Escape($nodeId)) {
        Write-Host "  Assigning layout for node $nodeId..."
        Invoke-Expression "$garageCmd layout assign `"$nodeId`" -z dc1 -c 1G 2>`$null" | Out-Null
        Invoke-Expression "$garageCmd layout apply --version 1 2>`$null" | Out-Null
    } else {
        Write-Host "  Layout already assigned."
    }
}

# Create the access key, or reuse the existing one
$existingAk = Env-Get "S3_ACCESS_KEY"
if ((From-File "S3_ACCESS_KEY") -or (From-File "S3_SECRET_KEY")) {
    $accessKey = $existingAk
    $akPath = Env-Get "S3_ACCESS_KEY_FILE"
    if (-not $accessKey -and $akPath) {
        $hostPath = $akPath -replace '^/run/secrets/', 'secrets/'
        if (Test-Path $hostPath) { $accessKey = (Get-Content $hostPath -Raw).Trim() }
    }
} elseif ($existingAk -and $existingAk -ne "GK..." -and $existingAk -ne "") {
    Write-Host "  Garage access key already in .env - skipping creation."
    $accessKey = $existingAk
} else {
    Write-Host "  Creating Garage access key 'nerla-key'..."
    # Delete a stale key of the same name
    $keyList = Invoke-Expression "$garageCmd key list 2>`$null" | Out-String
    $staleKeys = [regex]::Matches($keyList, '(GK\S+)\s+nerla-key')
    foreach ($m in $staleKeys) {
        $kid = $m.Groups[1].Value
        Invoke-Expression "$garageCmd key delete --yes `"$kid`" 2>`$null" | Out-Null
    }

    $keyOutput = Invoke-Expression "$garageCmd key create nerla-key 2>`$null" | Out-String

    $akMatch = [regex]::Match($keyOutput, 'Key ID:\s*(\S+)')
    $skMatch = [regex]::Match($keyOutput, 'Secret key:\s*(\S+)')

    if (-not $akMatch.Success -or -not $skMatch.Success) {
        Write-Host "ERROR: Could not parse Garage key output:" -ForegroundColor Red
        Write-Host $keyOutput
        exit 1
    }

    $accessKey = $akMatch.Groups[1].Value
    $secretKey = $skMatch.Groups[1].Value

    Env-Set "S3_ACCESS_KEY" $accessKey
    Env-Set "S3_SECRET_KEY" $secretKey
    Write-Host "  Access key written to .env."
}

# Create the server's bucket (idempotent)
$bucket = Env-Get "S3_BUCKET"
if (-not $bucket) { $bucket = "nerla-files" }
Invoke-Expression "$garageCmd bucket create $bucket 2>`$null" | Out-Null

# Grant the key access to the bucket (idempotent)
if ($accessKey) {
    Invoke-Expression "$garageCmd bucket allow --read --write --owner $bucket --key `"$accessKey`" 2>`$null" | Out-Null
    Write-Host "  Bucket '$bucket' ready."
} else {
    Write-Host "  WARNING: The Garage access key file could not be read, so the key was not given the bucket." -ForegroundColor Yellow
    Write-Host "  Give it the bucket with: $garageCmd bucket allow --read --write --owner $bucket --key <access key>"
}
Write-Host ""

# ---------------------------------------------------------------------------
# Step 6: Restart server so it picks up the new keys
# ---------------------------------------------------------------------------
Write-Host "--- Step 6: Restarting server with new keys ---"
docker compose up -d server
Write-Host ""

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
$serverPort = Env-Get "SERVER_PORT"
$clientUrl = Env-Get "CLIENT_URL"

Write-Host "==========================================="
Write-Host "  Setup complete!"
Write-Host "==========================================="
Write-Host ""
Write-Host "Services:"
Write-Host "  API server   : http://localhost:$serverPort"
Write-Host "  Frontend     : $clientUrl"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open http://localhost:$serverPort to verify the API is running"
Write-Host "  2. The frontend needs Node.js 26 and Yarn 4. On Node 25+ install Corepack first:"
Write-Host "     npm i -g corepack; corepack enable"
Write-Host "     Then start it:  cd desktop; yarn tauri:dev"
Write-Host "  3. Open $clientUrl and create your admin account"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  docker compose logs -f          - tail all logs"
Write-Host "  docker compose down             - stop everything"
Write-Host "  docker compose up -d            - start everything"
Write-Host ""
