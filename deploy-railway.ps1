# SuperBot Microservices Railway Deployment Helper
Write-Host "Starting SuperBot Microservices Deployment..." -ForegroundColor Cyan

# 1. Initialize Project (if not already done)
# npx railway init --name "SuperBot-Intelligence"

# 2. Add Infrastructure
# Write-Host "Adding PostgreSQL..."
# npx railway add --database postgres
# Write-Host "Adding Redis..."
# npx railway add --database redis

# 3. Deploy Each Microservice
# Note: On Railway, you can create multiple services from the same GitHub repo
# and set their "Root Directory" and "Start Command".

Write-Host "Deploying Admin API..."
# Command: npm run start:api
# Root Directory: (repo root)

Write-Host "Deploying Discord Bot..."
# Command: npm run start:bot
# Root Directory: (repo root)

Write-Host "Deploying Blockchain Indexer..."
# Command: npm run start:indexer
# Root Directory: (repo root)

Write-Host "Deploying Event Worker..."
# Command: npm run start:worker
# Root Directory: (repo root)

Write-Host "Finalizing Deployment..."
Write-Host "Deployment initiated! Go to https://railway.app/dashboard to monitor progress." -ForegroundColor Green
Write-Host "Ensure each service has the following environment variables:" -ForegroundColor Yellow
Write-Host " - DATABASE_URL"
Write-Host " - REDIS_URL"
Write-Host " - DISCORD_TOKEN (for Bot service)"
Write-Host " - PORT (for API service)"
Write-Host " - CLICKHOUSE_URL/USER/PASSWORD (if using analytics)"
