#!/usr/bin/env bash
# One-command Heroku deploy for Wordseek Bot.
# Usage: ./deploy-to-heroku.sh [app-name]
#
# Requires: Heroku CLI installed and logged in (`heroku login`), and this
# folder to have a `.env` file with your real values (already included in
# the zip you downloaded — just don't commit it anywhere public).

set -e

APP_NAME="${1:-}"

if ! command -v heroku &> /dev/null; then
  echo "Heroku CLI not found. Install it first: https://devcenter.heroku.com/articles/heroku-cli"
  exit 1
fi

if [ ! -f ".env" ]; then
  echo ".env file not found in this folder. Copy .env.example to .env and fill in your values first."
  exit 1
fi

echo "Loading values from .env..."
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "Creating Heroku app..."
if [ -n "$APP_NAME" ]; then
  heroku create "$APP_NAME" --stack heroku-24
else
  heroku create --stack heroku-24
fi

echo "Adding buildpack..."
heroku buildpacks:set https://github.com/dirkwall/heroku-bun-buildpack

echo "Provisioning Postgres and Redis addons..."
heroku addons:create heroku-postgresql:essential-0
heroku addons:create heroku-redis:mini

echo "Setting config vars..."
heroku config:set \
  BOT_TOKEN="$BOT_TOKEN" \
  DAILY_WORDLE_SECRET="$DAILY_WORDLE_SECRET" \
  DAILY_WORDLE_START_DATE="$DAILY_WORDLE_START_DATE" \
  NODE_ENV="$NODE_ENV" \
  ADMIN_USERS="$ADMIN_USERS" \
  TIME_ZONE="$TIME_ZONE" \
  LOGS_CHANNEL="$LOGS_CHANNEL" \
  ANTICHEAT_LOGS_CHANNEL="$ANTICHEAT_LOGS_CHANNEL" \
  GITHUB_TOKEN="$GITHUB_TOKEN" \
  GITHUB_OWNER="$GITHUB_OWNER" \
  GITHUB_REPO="$GITHUB_REPO" \
  GITHUB_BRANCH="$GITHUB_BRANCH" \
  GEMINI_API_KEYS="$GEMINI_API_KEYS" \
  CUSTOM_API_ROOT="$CUSTOM_API_ROOT"

echo ""
echo "IMPORTANT: Heroku's Redis addon sets a REDIS_URL var, but this bot reads REDIS_URI."
echo "Copying it over automatically..."
REDIS_URL_VALUE=$(heroku config:get REDIS_URL)
heroku config:set REDIS_URI="$REDIS_URL_VALUE"

echo "Deploying code..."
git push heroku main

echo "Running database migrations..."
heroku run bun run db:migrate

echo ""
echo "Done! Your bot should now be running. Check logs with: heroku logs --tail"
