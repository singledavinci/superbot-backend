# Idempotent setup for Railway `superbot-floor-worker`.
# Reads floor cache (`floor:<chain>:<contract>`) written by `superbot-market-indexer`
# and emits FLOOR_DROP / FLOOR_RISE Discord alerts based on per-collection thresholds.
#
# Requires: railway CLI on PATH and `railway login` or RAILWAY_API_TOKEN.
#
# Usage:
#   pwsh -File scripts/setup-floor-worker.ps1

[CmdletBinding()]
param(
    [string]$Environment             = "production",
    [string]$ServiceName             = "superbot-floor-worker",
    [string]$Repo                    = "singledavinci/superbot-backend",
    [int]   $FloorPollIntervalSeconds = 600
)

$ErrorActionPreference = "Stop"

function Invoke-Railway {
    param([Parameter(Mandatory = $true)][string[]]$Args)
    & railway @Args
    if ($LASTEXITCODE -ne 0) { throw "railway $($Args -join ' ') failed with exit code $LASTEXITCODE" }
}

$null = & railway whoami
if ($LASTEXITCODE -ne 0) {
    throw "Railway CLI is not authenticated. Run `railway login` or set RAILWAY_API_TOKEN."
}

Write-Host "[setup] Listing existing services to check for $ServiceName..."
$servicesJson = railway service list --json
if ($LASTEXITCODE -ne 0) { throw "Failed to list Railway services" }
$services = $servicesJson | ConvertFrom-Json
$existing  = $services | Where-Object { $_.name -eq $ServiceName }

if ($existing) {
    Write-Host "[setup] Service $ServiceName already exists (id=$($existing.id)). Updating variables..."
    Invoke-Railway @("variable", "set", "SERVICE_TYPE=floor-worker", "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    Invoke-Railway @("variable", "set", 'DATABASE_URL=${{Postgres.DATABASE_URL}}', "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    Invoke-Railway @("variable", "set", 'REDIS_URL=${{Redis.REDIS_URL}}', "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    Invoke-Railway @("variable", "set", "FLOOR_POLL_INTERVAL_SECONDS=$FloorPollIntervalSeconds", "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    Write-Host "[setup] Triggering redeploy..."
    Invoke-Railway @("redeploy", "--service", $ServiceName, "--yes")
} else {
    Write-Host "[setup] Creating service $ServiceName from repo $Repo..."
    Invoke-Railway @(
        "add",
        "--service", $ServiceName,
        "--repo",    $Repo,
        "--variables", "SERVICE_TYPE=floor-worker",
        "--variables", 'DATABASE_URL=${{Postgres.DATABASE_URL}}',
        "--variables", 'REDIS_URL=${{Redis.REDIS_URL}}',
        "--variables", "FLOOR_POLL_INTERVAL_SECONDS=$FloorPollIntervalSeconds",
        "--json"
    )
}

Write-Host ""
Write-Host "[setup] Done. Tail logs with:"
Write-Host "  railway logs --service $ServiceName --environment $Environment"
