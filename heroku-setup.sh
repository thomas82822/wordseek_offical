#!/bin/bash
# ============================================================
# Wordseek Bot — Post-Deploy Setup Script
# Usage: bash heroku-setup.sh your-heroku-app-name
# ============================================================

APP_NAME="${1}"

if [ -z "$APP_NAME" ]; then
  echo "Usage: bash heroku-setup.sh <your-heroku-app-name>"
  exit 1
fi

echo "Setting up Heroku app: $APP_NAME"
echo ""

# Step 1: Sanity-check the Redis addon is present.
# The bot reads REDIS_URI, but falls back to Heroku's own REDIS_URL
# automatically (see src/config/env.ts), so no manual copy step is needed.
echo "Step 1: Checking Redis addon..."
REDIS_URL=$(heroku config:get REDIS_URL --app "$APP_NAME" 2>/dev/null)
if [ -z "$REDIS_URL" ]; then
  echo "  ⚠️  REDIS_URL not found. Make sure Heroku Redis addon is added."
else
  echo "  ✅ Redis addon detected."
fi

# Step 2: Run database migrations
echo ""
echo "Step 2: Running database migrations..."
heroku run bun run db:migrate --app "$APP_NAME"

# Step 3: Scale worker dyno to 1
echo ""
echo "Step 3: Starting worker dyno..."
heroku ps:scale worker=1 --app "$APP_NAME"

echo ""
echo "✅ Setup complete!"
echo ""
echo "Check logs with: heroku logs --tail --app $APP_NAME"
echo "Check dyno status: heroku ps --app $APP_NAME"
