#!/bin/bash
set -euo pipefail

# =============================================================================
# Nerla, Local development setup
#
# This script is idempotent: safe to re-run. It will:
#   1. Generate all secrets and write .env with localhost defaults
#   2. Optionally configure email (or use Mailpit)
#   3. Generate garage.toml from template
#   4. Start Docker containers (the server applies database migrations on boot)
#   5. Wait for Garage to be healthy
#   6. Provision a Garage access key + bucket (if not already done)
#   7. Restart the server so it picks up the key
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-lib.sh"

echo "Nerla, Local Development Setup"
echo "================================="
echo ""

preflight_checks

echo "--- Step 1: .env file ---"
generate_secrets

# Dev-specific defaults
[ -z "$(env_get CLIENT_URL)" ]              && env_set CLIENT_URL              "http://localhost:3001"
[ -z "$(env_get VITE_LIVEKIT_URL)" ]        && env_set VITE_LIVEKIT_URL        "ws://localhost:7880"
[ -z "$(env_get VITE_API_URL)" ]            && env_set VITE_API_URL            "http://localhost:5000/api"
[ -z "$(env_get NODE_ENV)" ]                && env_set NODE_ENV                "development"
[ -z "$(env_get DB_SSL)" ]                  && env_set DB_SSL                  "false"
[ -z "$(env_get TRUST_PROXY)" ]             && env_set TRUST_PROXY             "false"
[ -z "$(env_get EXPOSE_RESET_TOKEN)" ]      && env_set EXPOSE_RESET_TOKEN      "true"

echo ""

echo "--- Step 2: Email configuration ---"
prompt_email false

echo "--- Step 3: Generating garage.toml ---"
generate_garage_toml

echo "--- Step 4: Starting containers ---"
docker compose up -d --build
echo ""

echo "--- Step 5: Waiting for Garage ---"
wait_for_garage

echo "--- Step 6: Provisioning Garage ---"
provision_garage

echo "--- Step 7: Restarting server with new keys ---"
docker compose up -d server
echo ""

echo "==========================================="
echo "  Dev setup complete!"
echo "==========================================="
echo ""
echo "Services:"
echo "  API server   : http://localhost:$(env_get SERVER_PORT)"
echo "  Mailpit      : http://localhost:8025 (catches all outgoing email)"
echo "  LiveKit      : ws://localhost:7880"
echo ""

_final_email="$(env_get EMAIL_USER)"
if [ -z "$_final_email" ]; then
    echo "  Email        : NOT CONFIGURED (invite links will only appear in server logs)"
    echo "                 Or check Mailpit at http://localhost:8025"
    echo ""
    echo "  To enable real emails, set EMAIL_HOST/PORT/USER/PASS in .env"
    echo "  and restart:  docker compose up -d server"
else
    echo "  Email (SMTP) : ${_final_email}"
fi
echo ""

echo "Next steps:"
echo "  0. The frontend needs Node.js 26 and Yarn 4. On Node 25+ install Corepack first:"
echo "     npm i -g corepack && corepack enable"
echo "  1. Start the frontend:  cd website && yarn dev  (or cd desktop && yarn tauri:dev)"
echo "  2. Open http://localhost:3001 and create your admin account"
echo ""
echo "Useful commands:"
echo "  docker compose logs -f, tail all logs"
echo "  docker compose down, stop everything"
echo "  docker compose up -d, start everything"
echo ""
