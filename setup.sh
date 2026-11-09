#!/bin/bash
set -euo pipefail

# =============================================================================
# Nerla, Production setup
#
# This script is idempotent: safe to re-run. It will:
#   1. Prompt for domain name
#   2. Generate all secrets and write .env with production values
#   3. Configure email (SMTP)
#   4. Generate config files (garage.toml, livekit.yaml)
#   5. Set up HTTPS (the web proxy gets and renews its own certificate)
#   6. Build and start all Docker containers
#   7. Provision Garage storage
#   8. Configure the firewall
#   9. Schedule nightly backups and verify the install from outside
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup-lib.sh"

# shellcheck source=scripts/compose.sh
source "$SCRIPT_DIR/scripts/compose.sh"

# A fresh install moves to the newest release, whose setup.sh may differ from this one, so it runs from a fresh start
release="$(cd "$SCRIPT_DIR" && release_tags | head -1)"
if [ ! -f "$SCRIPT_DIR/.env" ] && [ -n "$release" ] &&
    [ "$(git -C "$SCRIPT_DIR" rev-parse HEAD)" != "$(git -C "$SCRIPT_DIR" rev-parse "$release^{commit}")" ]; then
    git -C "$SCRIPT_DIR" checkout --detach "$release" || {
        echo "Moving to release $release failed, so setup stopped. Fix what the lines above say, then run sudo ./setup.sh again." >&2
        exit 1
    }
    echo "Setup continues on release $release."
    exec bash "$SCRIPT_DIR/setup.sh" "$@"
fi

echo "Nerla, Production Setup"
echo "========================="
echo ""

preflight_checks true

# Production setup targets a Linux server
if [[ "$(uname -s)" != "Linux" ]]; then
    echo "WARNING: Production setup is intended for a Linux VPS."
    echo "         For local development, use setup-dev.sh instead."
    read -rp "  Continue anyway? (y/N): " _continue
    [[ "$_continue" =~ ^[Yy] ]] || exit 0
    echo ""
fi

echo "--- Step 1: Domain configuration ---"

_existing_domain="$(env_get CLIENT_URL 2>/dev/null | sed 's|https://||' || true)"
if [ -n "$_existing_domain" ] && [ "$_existing_domain" != "http://localhost:3001" ]; then
    echo "  Current domain: $_existing_domain"
    read -rp "  Use this domain? (Y/n): " _keep_domain
    if [[ "$_keep_domain" =~ ^[Nn] ]]; then
        _existing_domain=""
    fi
fi

if [ -z "$_existing_domain" ] || [ "$_existing_domain" = "http://localhost:3001" ]; then
    read -rp "  Enter your domain (e.g. app.nerla.com), or this server's IP address: " DOMAIN
    if [ -z "$DOMAIN" ]; then
        echo "ERROR: Domain is required for production setup."
        exit 1
    fi
else
    DOMAIN="$_existing_domain"
fi

echo "  Domain: $DOMAIN"
echo ""

echo "--- Step 2: .env file ---"
generate_secrets

# Production-specific values
env_set CLIENT_URL              "https://${DOMAIN}"
env_set LIVEKIT_PUBLIC_URL      "wss://${DOMAIN}:7880"
env_set NODE_ENV                "production"
env_set DB_SSL                  "false"
env_set TRUST_PROXY             "1"
env_set EXPOSE_RESET_TOKEN      "false"

echo "  Production URLs configured for ${DOMAIN}"
echo ""

echo "--- Step 3: Email configuration ---"
prompt_email false

echo "--- Step 4: Generating garage.toml ---"
generate_garage_toml

echo "--- Step 5: Generating livekit.yaml ---"

if [ ! -f livekit.yaml.template ]; then
    echo "ERROR: livekit.yaml.template not found."
    exit 1
fi

_lk_key="$(env_get LIVEKIT_API_KEY)"
_lk_secret="$(env_get LIVEKIT_API_SECRET)"

sed \
    -e "s|{{LIVEKIT_API_KEY}}|${_lk_key}|" \
    -e "s|{{LIVEKIT_API_SECRET}}|${_lk_secret}|" \
    livekit.yaml.template > livekit.yaml

chmod 600 livekit.yaml 2>/dev/null || true
echo "  livekit.yaml generated."
echo ""

echo "--- Step 6: HTTPS ---"

if behind_own_proxy; then
    TLS_MODE=acme
    echo "  SITE_ADDRESS=$(env_get SITE_ADDRESS) in .env, so your own proxy in front holds the certificate"
    echo "  and the web proxy answers plain HTTP behind it."
elif needs_internal_tls "$DOMAIN"; then
    TLS_MODE=internal
    echo "  ${DOMAIN} can't have a Let's Encrypt certificate, so the web proxy makes one"
    echo "  with this server's own certificate authority. Browsers warn about it until"
    echo "  you trust that authority, which the end of setup explains."
else
    TLS_MODE=acme
    _acme_email="$(env_get ACME_EMAIL)"
    if [ -z "$_acme_email" ]; then
        while :; do
            read -rp "  Email for Let's Encrypt notices (optional, press Enter to skip): " _acme_email
            if [ -z "$_acme_email" ] || [[ "$_acme_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
                break
            fi
            echo "  That doesn't look like an email address. Type it again, or press Enter to skip."
        done
    fi
    env_set ACME_EMAIL "$_acme_email"
    echo ""
    echo "  The web proxy gets a free certificate from Let's Encrypt and renews it on its own."
    echo "  Let's Encrypt has to reach ${DOMAIN} on port 80 for that, so ${DOMAIN}"
    echo "  has to point at this server before we continue."
    echo ""
    wait_for_dns "$DOMAIN" || true
fi
if behind_own_proxy; then
    # The default would be :80:7880, which the web proxy can't read
    [ -n "$(env_get SIGNAL_ADDRESS)" ] || env_set SIGNAL_ADDRESS ":7880"
else
    env_set SITE_ADDRESS "$DOMAIN"
fi
env_set TLS_MODE "$TLS_MODE"
echo ""

echo "--- Step 7: Building and starting containers ---"
version="$(release_tags --points-at HEAD | head -1)"
if [ -n "$version" ] && [ "$(env_value NERLA_BUILD .env)" != source ]; then
    export NERLA_VERSION="$version"
    docker compose -f docker-compose.yml -f docker-compose.prod.yml pull || {
        echo "Downloading the release images failed, so setup stopped. Fix what the lines above say, then run sudo ./setup.sh again." >&2
        exit 1
    }
    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
else
    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
fi
echo ""

echo "--- Step 8: Waiting for services ---"
wait_for_garage

# Behind a separate proxy, port 80 belongs to it, and the HTTPS check below goes through it
if behind_own_proxy; then
    echo "  Not probing port 80 for the web proxy, as your own proxy holds it."
else
    echo "  Waiting for the web proxy..."
    MAX_WAIT=120
    elapsed=0
    while [ $elapsed -lt $MAX_WAIT ]; do
        if curl -fsS -o /dev/null "http://localhost/" &>/dev/null; then
            echo "  The web proxy is ready (${elapsed}s)."
            break
        fi
        sleep 3
        elapsed=$((elapsed + 3))
        printf "  waiting... (%ds)\r" "$elapsed"
    done
    if [ $elapsed -ge $MAX_WAIT ]; then
        echo ""
        echo "WARNING: The web proxy did not answer within ${MAX_WAIT}s."
        echo "Check: ./nerla logs web"
    fi
fi
echo ""

echo "--- Step 9: Provisioning Garage ---"
provision_garage

echo "--- Step 10: Restarting server with new keys ---"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d server
echo ""

echo "--- Step 11: HTTPS certificate ---"

if wait_for_https "$DOMAIN" 120 "$TLS_MODE"; then
    echo "  HTTPS works for ${DOMAIN}."
else
    echo "  HTTPS does not answer yet. The web proxy keeps trying on its own."
    echo "  ./nerla logs web says why. Most often ${DOMAIN} doesn't point at this server"
    echo "  yet, or port 80 is closed, which Let's Encrypt needs."
fi
echo ""

echo "--- Step 12: Firewall ---"

if command -v ufw &> /dev/null; then
    echo "  Configuring UFW firewall..."
    ufw allow 22/tcp   comment "SSH"         > /dev/null 2>&1 || true
    ufw allow 80/tcp   comment "HTTP"        > /dev/null 2>&1 || true
    ufw allow 443/tcp  comment "HTTPS"       > /dev/null 2>&1 || true
    ufw allow 7880/tcp comment "LiveKit WSS (web)" > /dev/null 2>&1 || true
    ufw allow 7881/tcp comment "LiveKit TCP" > /dev/null 2>&1 || true
    ufw allow 7882/udp comment "LiveKit RTC" > /dev/null 2>&1 || true

    if ! ufw status | grep -q "Status: active"; then
        echo "  Enabling UFW (SSH is allowed)..."
        ufw --force enable > /dev/null 2>&1
    fi
    echo "  Firewall configured."
else
    echo "  UFW not found, skipping firewall configuration."
    echo "  Make sure ports 80, 443, 7880, 7881, and 7882/udp are open."
fi
echo ""

echo "--- Step 13: Automatic backups ---"

chmod +x "${SCRIPT_DIR}/scripts/backup.sh" "${SCRIPT_DIR}/scripts/restore.sh" "${SCRIPT_DIR}/nerla" 2>/dev/null || true

if crontab -l 2>/dev/null | grep -q "nerla-backup"; then
    echo "  Nightly backup already scheduled."
else
    (crontab -l 2>/dev/null; echo "0 2 * * * cd ${SCRIPT_DIR} && ./scripts/backup.sh >> ${SCRIPT_DIR}/backups/backup.log 2>&1 # nerla-backup") | crontab -
    mkdir -p "${SCRIPT_DIR}/backups"
    echo "  Nightly backup scheduled for 02:00 (database + uploaded files)."
    echo "  Kept for 30 days in ${SCRIPT_DIR}/backups"
fi
echo ""
echo "  Backups live on this server, so they do not protect against losing the"
echo "  server itself. Copy them elsewhere regularly, for example:"
echo "    rsync -az ${SCRIPT_DIR}/backups/ you@another-host:/nerla-backups/"
echo ""

echo "--- Step 14: Verifying the install ---"

_scheme="https"
_verify_ok=true
verify_install "$DOMAIN" "$_scheme" "$TLS_MODE" || _verify_ok=false
echo ""

echo "==========================================="
if [ "$_verify_ok" = "true" ]; then
    echo "  Nerla is up and running!"
else
    echo "  Setup finished, but some checks failed"
fi
echo "==========================================="
echo ""
echo "  Open: ${_scheme}://${DOMAIN}"
echo ""

if [ "$TLS_MODE" = internal ]; then
    echo "  Your browser warns about the certificate until you trust this server's own"
    echo "  certificate authority. Copy it out with:"
    echo "    ./nerla cp web:/data/caddy/pki/authorities/local/root.crt nerla-root.crt"
    echo "  Then add nerla-root.crt to your browser or system as a trusted certificate"
    echo "  authority, on each computer that opens Nerla."
    echo ""
fi

_final_email="$(env_get EMAIL_USER)"
if [ -z "$_final_email" ]; then
    echo "  Email is not configured, which is fine. When you invite someone, the"
    echo "  app shows you a link to send them yourself, under"
    echo "  Settings > Members > Invite."
    echo ""
    echo "  Password resets do need email, so add EMAIL_* to .env later if you"
    echo "  want self-service resets."
    echo ""
fi

echo "Managing your server:"
echo "  ./nerla status     is everything running?"
echo "  ./nerla doctor     check the site is healthy"
echo "  ./nerla logs       watch what is happening"
echo "  ./nerla update     upgrade to the latest version"
echo "  ./nerla backup     back up right now"
echo ""

echo "Next step:"
echo "  Open ${_scheme}://${DOMAIN} and create your admin account."
echo "  The first account you create becomes the administrator."
echo ""

if [ "$_verify_ok" != "true" ]; then
    echo "Some checks failed above. Run './nerla doctor' after a minute,"
    echo "or './nerla logs' to see what went wrong."
    echo ""
fi
