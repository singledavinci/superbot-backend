# SuperBot Railway Deployment Helper
Write-Host "Starting SuperBot Railway Deployment..." -ForegroundColor Cyan

# 1. Initialize Project
Write-Host "Initializing Railway Project..."
npx railway init --name "SuperBot-Intelligence"

# 2. Add Infrastructure
Write-Host "Adding PostgreSQL..."
npx railway add --database postgres
Write-Host "Adding Redis..."
npx railway add --database redis
Write-Host "Adding ClickHouse..."
npx railway add --service "superbot-clickhouse" --image "clickhouse/clickhouse-server:latest"

# 3. Push Backend
Write-Host "Pushing Backend..."
npx railway up --service "superbot-backend" --detach

# 4. Push Dashboard
Write-Host "Pushing Dashboard..."
Set-Location ..\nft-intelligence-dashboard
npx railway up --service "superbot-dashboard" --detach

Write-Host "Deployment initiated! Go to https://railway.app/dashboard to monitor progress." -ForegroundColor Green
Write-Host "Don't forget to link the VITE_API_URL and Discord secrets in the Railway Settings." -ForegroundColor Yellow
