#!/bin/bash
set -e

echo "🚀 Deploying SuperBot to Production..."

# Pull latest code
echo "📦 Pulling latest changes from git..."
# git pull origin main

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  No .env file found! Please copy production.env.example to .env and configure it."
    exit 1
fi

# Bring down existing stack and rebuild
echo "🔨 Building and starting Docker containers..."
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d --build

echo "✅ Deployment successful!"
echo "📡 Traefik Dashboard: http://localhost:8080 (if enabled)"
echo "📡 Web Dashboard: http://YOUR_SERVER_IP"
