# Idempotent setup for the Railway `superbot-sales-indexer` service.
# Requires: railway CLI on PATH and either `railway login` or RAILWAY_API_TOKEN env var.
#
# Usage (from any directory):
#   pwsh -File scripts/setup-sales-indexer.ps1
#   # or, with a real Reservoir key:
#   pwsh -File scripts/setup-sales-indexer.ps1 -ReservoirApiKey "rk_live_..."

[CmdletBinding()]
param(
    [string]$ProjectId   = "d42f654c-8936-477d-84d4-7777c8c862cd",
    [string]$Environment = "production",
    [string]$ServiceName = "superbot-sales-indexer",
    [string]$Repo        = "singledavinci/superbot-backend",
    [string]$ReservoirApiKey,
    [int]   $PollIntervalMs = 30000
)

$ErrorActionPreference = "Stop"

function Invoke-Railway {
    param([Parameter(Mandatory = $true)][string[]]$Args)
    & railway @Args
    if ($LASTEXITCODE -ne 0) { throw "railway $($Args -join ' ') failed with exit code $LASTEXITCODE" }
}

# Ensure CLI is reachable
$null = & railway whoami
if ($LASTEXITCODE -ne 0) {
    throw "Railway CLI is not authenticated. Run `railway login` or set RAILWAY_API_TOKEN."
}

Write-Host "[setup] Listing existing services to check for $ServiceName..."
$servicesJson = railway service list --json
if ($LASTEXITCODE -ne 0) { throw "Failed to list Railway services" }
$services = $servicesJson | ConvertFrom-Json
$existing  = $services | Where-Object { $_.name -eq $ServiceName }

$reservoirValue = if ($ReservoirApiKey) { $ReservoirApiKey } else { "PLACEHOLDER_set_a_real_key" }

if ($existing) {
    Write-Host "[setup] Service $ServiceName already exists (id=$($existing.id)). Updating variables..."
    Invoke-Railway @("variable", "set", "SERVICE_TYPE=sales-indexer",            "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    Invoke-Railway @("variable", "set", 'DATABASE_URL=${{Postgres.DATABASE_URL}}', "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    Invoke-Railway @("variable", "set", 'REDIS_URL=${{Redis.REDIS_URL}}',          "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    Invoke-Railway @("variable", "set", "RESERVOIR_POLL_INTERVAL_MS=$PollIntervalMs", "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    if ($ReservoirApiKey) {
        Invoke-Railway @("variable", "set", "RESERVOIR_API_KEY=$ReservoirApiKey", "--service", $ServiceName, "--environment", $Environment, "--skip-deploys")
    }
    Write-Host "[setup] Triggering redeploy..."
    Invoke-Railway @("redeploy", "--service", $ServiceName, "--yes")
} else {
    Write-Host "[setup] Creating service $ServiceName from repo $Repo..."
    Invoke-Railway @(
        "add",
        "--service", $ServiceName,
        "--repo",    $Repo,
        "--variables", "SERVICE_TYPE=sales-indexer",
        "--variables", 'DATABASE_URL=${{Postgres.DATABASE_URL}}',
        "--variables", 'REDIS_URL=${{Redis.REDIS_URL}}',
        "--variables", "RESERVOIR_POLL_INTERVAL_MS=$PollIntervalMs",
        "--variables", "RESERVOIR_API_KEY=$reservoirValue",
        "--json"
    )
}

Write-Host ""
Write-Host "[setup] Done. To watch logs:"
Write-Host "  railway logs --service $ServiceName --environment $Environment"
if (-not $ReservoirApiKey) {
    Write-Host ""
    Write-Host "[setup] NOTE: RESERVOIR_API_KEY is set to a placeholder. The indexer will stay disabled until you set a real key:"
    Write-Host "  railway variable set RESERVOIR_API_KEY=<YOUR_KEY> --service $ServiceName --environment $Environment --skip-deploys"
    Write-Host "  railway redeploy --service $ServiceName --environment $Environment --yes"
}
