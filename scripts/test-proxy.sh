#!/bin/bash
set -euo pipefail

# Proves what the web image routes and protects: the app with its cache headers, the API, health and MCP on
# the server, board fonts across origins, the body limits, WebSockets and meeting signalling on 7880, and the CSP.
# It runs its own throwaway stack (project nerla-proxytest) with SITE_ADDRESS=localhost and TLS_MODE=internal.
#
#   bash scripts/test-proxy.sh                          builds the image as nerla-proxytest-web:local first
#   NERLA_PROXY_IMAGE=<tag> bash scripts/test-proxy.sh  tests an image already built

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
export MSYS_NO_PATHCONV=1
export COMPOSE_PROJECT_NAME=nerla-proxytest COMPOSE_FILE=scripts/test-proxy.compose.yml
COMPOSE=(docker compose)

if [ -z "${NERLA_PROXY_IMAGE:-}" ]; then
    export NERLA_PROXY_IMAGE=nerla-proxytest-web:local
    echo "Building $NERLA_PROXY_IMAGE..."
    docker build -q -f proxy/Dockerfile -t "$NERLA_PROXY_IMAGE" . >/dev/null
fi

failed=0
check() {
    if [ "$2" = true ]; then
        echo "  ok    $1"
    else
        echo "  FAIL  $1${3:+, got: $3}"
        failed=1
    fi
}
is() { [ "$1" = "$2" ] && echo true || echo false; }
has() { grep -qiF -- "$2" <<<"$1" && echo true || echo false; }

cleanup() {
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
"${COMPOSE[@]}" up -d --wait >/dev/null 2>&1 || {
    "${COMPOSE[@]}" logs --tail 30
    echo "FAILED: the test stack did not start." >&2
    exit 1
}
HTTPS="127.0.0.1:$("${COMPOSE[@]}" port web 443 | sed 's/.*://')"
SIGNAL="127.0.0.1:$("${COMPOSE[@]}" port web 7880 | sed 's/.*://')"
BASE="https://localhost:${HTTPS##*:}"
SIGNAL_BASE="https://localhost:${SIGNAL##*:}"
CURL=(curl -sk --max-time 10 --resolve "localhost:${HTTPS##*:}:127.0.0.1" --resolve "localhost:${SIGNAL##*:}:127.0.0.1")

# The certificate comes from Caddy's own authority, a moment after the start
for _ in $(seq 1 30); do
    "${CURL[@]}" -o /dev/null "$BASE/" && break
    sleep 1
done

echo "Checking the web image..."
headers() { "${CURL[@]}" -o /dev/null -D - "$@" | tr -d '\r'; }
header() { headers "${@:2}" | sed -n "s/^$1: //Ip" | head -1; }
code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@" || true; }

body="$("${CURL[@]}" "$BASE/")"
check "/ gives the app" "$(has "$body" '<div id="root">')"
check "/ is never cached" "$(is "$(header Cache-Control "$BASE/")" no-store)" "$(header Cache-Control "$BASE/")"
check "an app route gives the app" "$(has "$("${CURL[@]}" "$BASE/project/some-slug")" '<div id="root">')"

for path in /api/health /health /health/ready; do
    body="$("${CURL[@]}" "$BASE$path" || true)"
    check "$path reaches the server" "$(has "$body" '"stub":true')" "${body:0:80}"
done
# The first event arrives while the stream is still open, so nothing in between holds it back
body="$("${CURL[@]}" -N --max-time 1 "$BASE/mcp" || true)"
check "/mcp reaches the server and streams its events as they come" "$(has "$body" 'data: first')" "${body:0:80}"

asset="$(sed -n 's|.*src="\(/assets/[^"]*\)".*|\1|p' <<<"$("${CURL[@]}" "$BASE/")" | head -1)"
check "an asset carries the long cache header" \
    "$(is "$(header Cache-Control "$BASE$asset")" "public, max-age=31536000, immutable")" "$asset $(header Cache-Control "$BASE$asset")"
check "a missing asset is a 404, not the app" "$(is "$(code "$BASE/assets/x")" 404)" "$(code "$BASE/assets/x")"
check "/excalidraw-assets/x carries the CORS header" "$(is "$(header Access-Control-Allow-Origin "$BASE/excalidraw-assets/x")" "*")"
check "a missing board font is a 404, not the app" "$(is "$(code "$BASE/excalidraw-assets/x")" 404)"

CSP="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https://localhost wss://localhost wss://localhost:7880; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src blob:"
check "the CSP header matches" "$(is "$(header Content-Security-Policy "$BASE/")" "$CSP")" "$(header Content-Security-Policy "$BASE/")"
check "HSTS is on" "$(is "$(header Strict-Transport-Security "$BASE/")" "max-age=31536000; includeSubDomains")"
check "X-Frame-Options is DENY" "$(is "$(header X-Frame-Options "$BASE/api/health")" DENY)"

big="$(mktemp)"
head -c 2097152 /dev/zero >"$big"
check "a 2 MB upload reaches the server" "$(is "$(code -X POST --data-binary @- "$BASE/api/files/upload" <"$big")" 200)"
check "a 2 MB body elsewhere is refused" "$(is "$(code -X POST --data-binary @- "$BASE/api/other" <"$big")" 413)"
rm -f "$big"

UPGRADE=(--http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
check "a WebSocket upgrade on /ws works" "$(is "$(code "${UPGRADE[@]}" "$BASE/ws/collab")" 101)" "$(code "${UPGRADE[@]}" "$BASE/ws/collab")"
check "/ws without an upgrade is refused" "$(is "$(code "$BASE/ws")" 403)"
check "meeting signalling on 7880 upgrades" "$(is "$(code "${UPGRADE[@]}" "$SIGNAL_BASE/rtc")" 101)" "$(code "${UPGRADE[@]}" "$SIGNAL_BASE/rtc")"

if [ "$failed" = 1 ]; then
    echo ""
    echo "The web proxy's last lines:"
    "${COMPOSE[@]}" logs --no-log-prefix --tail 30 web
    echo "FAILED: the web image does not behave as above." >&2
    exit 1
fi
echo ""
echo "Web proxy check passed"
