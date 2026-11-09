#!/usr/bin/env bash
#
# Scans the locally built Nerla images for known OS and package vulnerabilities, with Grype
# (https://github.com/anchore/grype) or else Docker's built-in `docker scout`.
# Meant for before a deploy or upgrade, not the pre-commit hook, as the images do not exist at commit time.
#
# Usage:
#   scripts/scan-images.sh                      # build + scan server & web, fail on HIGH+
#   SEVERITY=critical scripts/scan-images.sh    # only fail on CRITICAL
#   SKIP_BUILD=1 scripts/scan-images.sh         # scan already-built images (no rebuild)
#   scripts/scan-images.sh caddy:2.11.8-alpine  # scan a specific image instead
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Fails on this level and above
SEVERITY="${SEVERITY:-high}"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
# The build ignores it, but the compose file requires it
export SITE_ADDRESS="${SITE_ADDRESS:-localhost}"

# --- Decide which images to scan -------------------------------------------------
if [ "$#" -gt 0 ]; then
  IMAGES="$*"
else
  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "-> Building images (so we scan exactly what would deploy)..."
    $COMPOSE build server web
  fi
  # The resolved image refs from Compose, keeping only the two built here
  IMAGES="$($COMPOSE config --images 2>/dev/null | grep -Ei '(server|web)$' || true)"
  if [ -z "$IMAGES" ]; then
    # Falls back to Compose's conventional "<project>-<service>" naming
    proj="$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
    IMAGES="${proj}-server ${proj}-web"
  fi
fi

# --- Pick a scanner --------------------------------------------------------------
if ! command -v grype >/dev/null 2>&1 && ! docker scout version >/dev/null 2>&1; then
  echo "✗ Neither 'grype' nor 'docker scout' is available."
  echo "  Install Grype:  https://github.com/anchore/grype#installation"
  echo "  (or use Docker Desktop's built-in 'docker scout cves')."
  exit 2
fi

# --- Scan ------------------------------------------------------------------------
rc=0
for img in $IMAGES; do
  echo ""
  echo "=== Scanning ${img}  (threshold: ${SEVERITY}+) ==="
  if command -v grype >/dev/null 2>&1; then
    grype "$img" --fail-on "$SEVERITY" || rc=1
  else
    docker scout cves --only-severity "${SEVERITY},critical" --exit-code "$img" || rc=1
  fi
done

echo ""
if [ "$rc" -eq 0 ]; then
  echo "✓ No vulnerabilities at/above '${SEVERITY}'."
else
  echo "✗ Vulnerabilities at/above '${SEVERITY}' found - review the output above."
  echo "  Most base-image CVEs clear after: docker compose ... build --pull"
fi
exit "$rc"
