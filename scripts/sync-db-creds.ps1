# Re-syncs the current Postgres credentials onto every dependent app service
# and triggers a redeploy. Use after rotating the Postgres password in the
# Railway dashboard ("Regenerate" button on the Postgres service).
#
# Requires: railway CLI on PATH and either an active `railway login` session
# or RAILWAY_API_TOKEN exported in the shell.
#
# Usage:
#   $env:RAILWAY_API_TOKEN = "<token>"
#   powershell -ExecutionPolicy Bypass -File scripts/sync-db-creds.ps1

$ErrorActionPreference = 'Stop'

$ENVIRONMENT = 'production'
$DEPENDENT_SERVICES = @(
    'superbot-backend',
    'superbot-sales-indexer',
    'superbot-market-indexer'
)

function Get-PasswordFingerprint([string]$url) {
    if (-not $url) { return '<empty>' }
    $pwd = $url -replace '.*://[^:]+:([^@]+)@.*', '$1'
    if ($pwd.Length -lt 12) { return '<unparsable>' }
    return $pwd.Substring(0, 4) + '...' + $pwd.Substring($pwd.Length - 4, 4)
}

Write-Host '==1) Reading current Postgres credentials...'
$pgVars = railway variable list -s Postgres -e $ENVIRONMENT --json | ConvertFrom-Json
$pgFp = Get-PasswordFingerprint $pgVars.DATABASE_URL
Write-Host "    Postgres password fingerprint: $pgFp"

Write-Host '==2) Syncing onto each dependent service (--skip-deploys)...'
foreach ($svc in $DEPENDENT_SERVICES) {
    railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --service $svc --environment $ENVIRONMENT --skip-deploys | Out-Null
    railway variable set 'DATABASE_PUBLIC_URL=${{Postgres.DATABASE_PUBLIC_URL}}' --service $svc --environment $ENVIRONMENT --skip-deploys | Out-Null
    Write-Host "    $svc : DATABASE_URL + DATABASE_PUBLIC_URL synced."
}

Write-Host '==3) Verifying fingerprints match...'
$mismatch = $false
foreach ($svc in $DEPENDENT_SERVICES) {
    $vars = railway variable list -s $svc -e $ENVIRONMENT --json | ConvertFrom-Json
    $svcFp = Get-PasswordFingerprint $vars.DATABASE_URL
    $tag = if ($svcFp -eq $pgFp) { 'OK ' } else { 'MISMATCH'; $mismatch = $true }
    Write-Host "    [$tag] $svc : $svcFp"
}
if ($mismatch) {
    Write-Error 'One or more services did not pick up the new credentials. Aborting before redeploy.'
    exit 1
}

Write-Host '==4) Redeploying...'
foreach ($svc in $DEPENDENT_SERVICES) {
    railway redeploy --service $svc --yes --json | Out-Null
    Write-Host "    $svc redeployed."
}

Write-Host ''
Write-Host 'Done. Wait ~2-3 min for the redeploys to settle, then check service logs.'
