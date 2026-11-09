#!/bin/bash
# =============================================================================
# Nerla, Shared setup helpers
# Sourced by setup.sh (production) and setup-dev.sh (local development)
# =============================================================================

# Git Bash on Windows would otherwise turn the Unix paths in docker exec commands into Windows paths
export MSYS_NO_PATHCONV=1

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
preflight_checks() {
    local production="${1:-false}"
    local failed=false

    if ! command -v docker &> /dev/null; then
        echo "ERROR: Docker is not installed."
        echo "  Install it with:  curl -fsSL https://get.docker.com | sh"
        exit 1
    fi

    if ! docker compose version &> /dev/null 2>&1; then
        echo "ERROR: 'docker compose' is not available."
        echo "  Install the compose plugin:  apt-get install docker-compose-plugin"
        exit 1
    fi

    if ! docker info &> /dev/null; then
        echo "ERROR: Docker is installed but the daemon is not responding."
        echo "  Start it with:  sudo systemctl start docker"
        exit 1
    fi

    echo "  Docker is installed and running."

    if [ "$production" = "true" ]; then
        # The web proxy needs 80/443, unless a separate proxy holds them. A stray Apache is the usual cause on a fresh VPS.
        local port holder ports="80 443"
        behind_own_proxy && ports=""
        for port in $ports; do
            if port_in_use "$port"; then
                holder="$(port_holder "$port")"
                echo "ERROR: Port ${port} is already in use${holder:+ by: $holder}."
                echo "  Nerla's web proxy needs ports 80 and 443."
                echo "  Stop the other service, often:  sudo systemctl disable --now apache2"
                failed=true
            fi
        done

        local mem_mb
        mem_mb="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
        if [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt 1800 ]; then
            echo "WARNING: Only ${mem_mb} MB of RAM detected, 2 GB or more is recommended."
            echo "         The build step may be killed on a smaller box."
        fi

        local disk_gb
        disk_gb="$(df -BG --output=avail . 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
        if [ -n "$disk_gb" ] && [ "$disk_gb" -gt 0 ] && [ "$disk_gb" -lt 8 ]; then
            echo "WARNING: Only ${disk_gb} GB of free disk, 10 GB or more is recommended."
        fi

        if [ "$failed" = "true" ]; then
            echo ""
            echo "Fix the errors above and re-run this script."
            exit 1
        fi

        [ -z "$ports" ] || echo "  Ports 80 and 443 are free."
    fi

    echo ""
}

# ---------------------------------------------------------------------------
# Helper: is a TCP port already bound?
# ---------------------------------------------------------------------------
port_in_use() {
    local port="$1"
    if command -v ss &> /dev/null; then
        ss -ltn "sport = :${port}" 2>/dev/null | tail -n +2 | grep -q .
    elif command -v netstat &> /dev/null; then
        netstat -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]"
    else
        return 1
    fi
}

port_holder() {
    local port="$1"
    if command -v ss &> /dev/null; then
        ss -ltnp "sport = :${port}" 2>/dev/null | tail -n +2 | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p' | head -1
    fi
}

# ---------------------------------------------------------------------------
# Helper: this machine's public IP address
# ---------------------------------------------------------------------------
detect_public_ip() {
    local url ip
    for url in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
        ip="$(curl -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')"
        if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
            printf '%s' "$ip"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Helper: resolve a domain's first A record
# ---------------------------------------------------------------------------
have_resolver() {
    command -v dig &> /dev/null || command -v host &> /dev/null || command -v getent &> /dev/null || command -v nslookup &> /dev/null
}

# The HTTP status a URL returns, or 000 when nothing answers. curl's -w always writes a code, so it is never paired
# with a fallback echo. Further arguments go to curl, such as -k for a certificate from the server's own authority
http_code() {
    local out
    out="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null)" || true
    printf '%s' "${out:-000}"
}

resolve_domain_ip() {
    local domain="$1" raw=""
    if command -v dig &> /dev/null; then
        raw="$(dig +short A "$domain" 2>/dev/null)"
    elif command -v host &> /dev/null; then
        raw="$(host -t A "$domain" 2>/dev/null | awk '/has address/ {print $NF}')"
    elif command -v getent &> /dev/null; then
        raw="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}')"
    elif command -v nslookup &> /dev/null; then
        # Only the lines after "Name:" are answers, as earlier "Address:" lines are the resolver's own address.
        # Addresses may continue onto indented lines
        raw="$(nslookup "$domain" 2>/dev/null | tr -d '\r' | awk '/^Name:/{a=1;next} a&&NF{print $NF}')"
    fi
    # IPv4 only, as the comparison is against an IPv4 public address and an AAAA record would never match
    printf '%s' "$raw" | grep -oE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' | head -1
}

# ---------------------------------------------------------------------------
# Wait until the domain's A record points at this server.
#
# Users cannot reliably tell whether DNS is ready, and a wrong guess sends the certificate request into a failure
# that is awkward to recover from. Checking it directly turns that into a wait with one clear instruction.
#
# Returns 0 when DNS matches, 1 when the user carries on without it
# ---------------------------------------------------------------------------
wait_for_dns() {
    local domain="$1"
    local server_ip resolved answer
    local attempt=0
    local max_attempts=60   # 60 x 10s = 10 minutes

    if ! have_resolver; then
        echo "  No DNS lookup tool available on this system, cannot verify automatically."
        read -rp "  Is DNS for ${domain} already pointing here? (y/N): " answer
        [[ "$answer" =~ ^[Yy] ]] && return 0 || return 1
    fi

    server_ip="$(detect_public_ip || true)"
    if [ -z "$server_ip" ]; then
        echo "  Could not determine this server's public IP."
        read -rp "  Is DNS for ${domain} already pointing here? (y/N): " answer
        [[ "$answer" =~ ^[Yy] ]] && return 0 || return 1
    fi

    echo "  This server's public IP: ${server_ip}"
    echo ""

    while [ "$attempt" -lt "$max_attempts" ]; do
        resolved="$(resolve_domain_ip "$domain" || true)"

        if [ "$resolved" = "$server_ip" ]; then
            [ "$attempt" -gt 0 ] && echo ""
            echo "  DNS is correct: ${domain} -> ${resolved}"
            return 0
        fi

        if [ "$attempt" -eq 0 ]; then
            if [ -z "$resolved" ]; then
                echo "  ${domain} does not resolve yet."
            else
                echo "  ${domain} currently points to ${resolved}, not this server."
            fi
            echo ""
            echo "  Add this record at your domain registrar:"
            echo ""
            echo "      Type: A     Name: ${domain}     Value: ${server_ip}"
            echo ""
            echo "  Waiting for it to take effect, usually a few minutes."
            echo "  Press Ctrl-C to stop and re-run this script later."
            echo ""
        fi

        attempt=$((attempt + 1))
        printf "  checking DNS... (%ds elapsed)\r" "$((attempt * 10))"
        sleep 10
    done

    echo ""
    echo "  DNS still does not point here after 10 minutes."
    echo "  Carrying on. Fix the DNS record, and the web proxy gets the certificate"
    echo "  on its own once ${domain} points here."
    return 1
}

# ---------------------------------------------------------------------------
# Post-install verification: prove the site works from the outside.
# With internal as the third argument the certificate comes from the server's own authority, which only machines
# that added it trust, so it is not checked
# ---------------------------------------------------------------------------
verify_install() {
    local domain="$1"
    local scheme="${2:-https}"
    local tls_mode="${3:-acme}"
    local base="${scheme}://${domain}"
    local pass=0 fail=0
    local code k=()
    [ "$tls_mode" = internal ] && k=(-k)

    _report() {
        if [ "$2" = "true" ]; then
            printf "  [ OK ]  %s\n" "$1"
            pass=$((pass + 1))
        else
            printf "  [FAIL]  %s\n" "$1"
            [ -n "$3" ] && printf "          %s\n" "$3"
            fail=$((fail + 1))
        fi
    }

    code="$(http_code ${k[@]+"${k[@]}"} "${base}/health")"
    _report "API responds at ${base}/health" \
        "$([ "$code" = "200" ] && echo true || echo false)" \
        "Got HTTP ${code}. Check: ./nerla logs server"

    code="$(http_code ${k[@]+"${k[@]}"} "${base}/api/auth/setup-status")"
    _report "Database reachable through the API" \
        "$([ "$code" = "200" ] && echo true || echo false)" \
        "Got HTTP ${code}. Check: ./nerla logs server"

    code="$(http_code ${k[@]+"${k[@]}"} "${base}/")"
    _report "Web app is being served" \
        "$([ "$code" = "200" ] && echo true || echo false)" \
        "Got HTTP ${code}. Check: ./nerla logs web"

    if [ "$scheme" = "https" ] && [ "$tls_mode" != internal ]; then
        _report "HTTPS certificate is valid and trusted" \
            "$(curl -sS -o /dev/null --max-time 15 "${base}/health" 2>/dev/null && echo true || echo false)" \
            "Certificate missing or untrusted. ./nerla logs web says why, often DNS that points elsewhere or a closed port 80"
    fi

    echo ""
    if [ "$fail" -eq 0 ]; then
        echo "  All ${pass} checks passed."
        return 0
    fi
    echo "  ${pass} passed, ${fail} failed."
    return 1
}

# Waits up to $2 seconds for https://$1/health to answer through the web proxy on this machine, with a certificate
# valid for $1. With internal as $3 the certificate is not checked, as it comes from the server's own authority
wait_for_https() {
    local domain="$1" deadline=$((SECONDS + $2)) k=()
    [ "${3:-}" = internal ] && k=(-k)
    while [ "$SECONDS" -lt "$deadline" ]; do
        curl -fsS -o /dev/null --max-time 10 ${k[@]+"${k[@]}"} --resolve "${domain}:443:127.0.0.1" "https://${domain}/health" 2>/dev/null &&
            return 0
        sleep 5
    done
    return 1
}

# SITE_ADDRESS=:80 is plain HTTP behind a separate proxy, which then holds 80, 443 and the certificate
behind_own_proxy() {
    [[ "$(env_get SITE_ADDRESS)" == :* ]]
}

# An IP address or localhost can't have a Let's Encrypt certificate, so it gets one from the server's own authority
needs_internal_tls() {
    [ "$1" = localhost ] || [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
}

# ---------------------------------------------------------------------------
# Helper: generate a random hex string (uses openssl, falls back to /dev/urandom)
# ---------------------------------------------------------------------------
gen_secret() {
    local len=${1:-32}
    openssl rand -hex "$len" 2>/dev/null || head -c "$len" /dev/urandom | xxd -p | tr -d '\n'
}

# ---------------------------------------------------------------------------
# Helper: set a key=value in .env (update if exists, append if not)
# ---------------------------------------------------------------------------
env_set() {
    local key="$1" value="$2" file=".env"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        # awk takes the value from the environment as plain text, where sed would read &, | and \ in it.
        # The file is written over in place, so it keeps its permissions and no copy of its secrets is left
        local updated
        updated="$(KEY="$key" VALUE="$value" awk 'index($0, ENVIRON["KEY"] "=") == 1 { $0 = ENVIRON["KEY"] "=" ENVIRON["VALUE"] } { print }' "$file")" &&
            printf '%s\n' "$updated" >"$file"
    else
        # A last line without its newline would otherwise run into the new one
        [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ] && echo >> "$file"
        echo "${key}=${value}" >> "$file"
    fi
}

# Helper: read a value from .env, return empty string if missing
env_get() {
    local key="$1"
    sed -n "s/^${key}=//p" .env 2>/dev/null | head -1 || true
}

# A secret given through NAME_FILE is never generated, or the server and Postgres would stop on the clash
from_file() {
    [ -n "$(env_get "${1}_FILE")" ] || return 1
    echo "  $1 comes from ${1}_FILE, so setup leaves it alone."
}

# The host copy of a NAME_FILE secret. The containers see the secrets folder as /run/secrets
secret_file_value() {
    local path
    path="$(env_get "${1}_FILE")"
    case "$path" in /run/secrets/*) path="secrets/${path#/run/secrets/}" ;; esac
    [ -n "$path" ] && tr -d '\r\n' <"$path" 2>/dev/null || true
}

# Example and known-weak values setup replaces. Keep in step with server/src/config.ts
is_placeholder() {
    case "$1" in
        postgres|nerla|nerla_password|password|changeme) return 0 ;;
        change-me-in-production|secret|jwt_secret) return 0 ;;
        your_super_secret_jwt_key_change_this_in_production|your_livekit_secret_change_this|APInerla) return 0 ;;
    esac
    return 1
}

# ---------------------------------------------------------------------------
# Generate common secrets (DB, JWT, LiveKit, Garage infrastructure)
# ---------------------------------------------------------------------------
generate_secrets() {
    touch .env

    # Database
    [ -z "$(env_get DB_USER)" ]     && env_set DB_USER     "nerla"
    [ -z "$(env_get DB_NAME)" ]     && env_set DB_NAME     "nerla"
    [ -z "$(env_get DB_PORT)" ]     && env_set DB_PORT     "5432"

    _dbpw="$(env_get DB_PASSWORD)"
    if from_file DB_PASSWORD; then
        :
    elif [ -z "$_dbpw" ]; then
        env_set DB_PASSWORD "$(gen_secret 16)"
        echo "  Generated DB_PASSWORD"
    elif is_placeholder "$_dbpw"; then
        env_set DB_PASSWORD "$(gen_secret 16)"
        echo "  Replaced the example DB_PASSWORD with a new random one."
    fi

    _jwt="$(env_get JWT_SECRET)"
    if from_file JWT_SECRET; then
        :
    elif [ -z "$_jwt" ] || [ ${#_jwt} -lt 32 ]; then
        env_set JWT_SECRET "$(gen_secret 32)"
        echo "  Generated JWT_SECRET"
    elif is_placeholder "$_jwt"; then
        env_set JWT_SECRET "$(gen_secret 32)"
        echo "  Replaced the example JWT_SECRET with a new random one."
    fi

    _lk_key="$(env_get LIVEKIT_API_KEY)"
    if from_file LIVEKIT_API_KEY; then
        :
    elif [ -z "$_lk_key" ]; then
        env_set LIVEKIT_API_KEY "APInerla$(gen_secret 8)"
        echo "  Generated LIVEKIT_API_KEY"
    elif is_placeholder "$_lk_key"; then
        env_set LIVEKIT_API_KEY "APInerla$(gen_secret 8)"
        echo "  Replaced the example LIVEKIT_API_KEY with a new random one."
    fi

    _lk_secret="$(env_get LIVEKIT_API_SECRET)"
    if from_file LIVEKIT_API_SECRET; then
        :
    elif [ -z "$_lk_secret" ]; then
        env_set LIVEKIT_API_SECRET "$(gen_secret 32)"
        echo "  Generated LIVEKIT_API_SECRET"
    elif is_placeholder "$_lk_secret"; then
        env_set LIVEKIT_API_SECRET "$(gen_secret 32)"
        echo "  Replaced the example LIVEKIT_API_SECRET with a new random one."
    fi

    # Garage infrastructure secrets
    _rpc="$(env_get GARAGE_RPC_SECRET)"
    if [ -z "$_rpc" ]; then
        env_set GARAGE_RPC_SECRET "$(gen_secret 32)"
        echo "  Generated GARAGE_RPC_SECRET"
    fi

    _admin="$(env_get GARAGE_ADMIN_TOKEN)"
    if [ -z "$_admin" ]; then
        env_set GARAGE_ADMIN_TOKEN "$(gen_secret 32)"
        echo "  Generated GARAGE_ADMIN_TOKEN"
    fi

    # Never replaced once set, a new key would lock out saved AI keys
    if from_file AI_MASTER_KEY; then
        :
    elif [ -z "$(env_get AI_MASTER_KEY)" ]; then
        env_set AI_MASTER_KEY "$(gen_secret 32)"
        echo "  Generated AI_MASTER_KEY"
    fi

    [ -z "$(env_get S3_ENDPOINT)" ] && env_set S3_ENDPOINT "http://garage:3900"
    [ -z "$(env_get S3_REGION)" ]   && env_set S3_REGION   "garage"
    [ -z "$(env_get S3_BUCKET)" ]   && env_set S3_BUCKET   "nerla-files"
    [ -z "$(env_get SERVER_PORT)" ] && env_set SERVER_PORT "5000"

    chmod 600 .env 2>/dev/null || true
    echo "  .env is ready (permissions restricted)."
    echo ""
}

# ---------------------------------------------------------------------------
# Email (SMTP) configuration prompt
# ---------------------------------------------------------------------------
prompt_email() {
    local required="${1:-false}"

    echo "--- Email configuration ---"
    echo ""

    _email_user="$(env_get EMAIL_USER)"
    if [ -z "$_email_user" ]; then
        echo "  SMTP lets Nerla email invite and password-reset links."
        echo "  You can use any provider (Gmail, Outlook, AWS SES, etc.)."
        echo ""
        echo "  You can safely skip this: invites also work as a copyable link in"
        echo "  the app. Only self-service password resets need email."
        echo ""

        if [ "$required" = "true" ]; then
            echo "  Email is required for production."
            _configure_email="y"
        else
            read -rp "  Configure email now? (y/N): " _configure_email
            echo ""
        fi

        if [[ "$_configure_email" =~ ^[Yy] ]]; then
            read -rp "  SMTP host (e.g. smtp.gmail.com): " _smtp_host
            read -rp "  SMTP port (587 for TLS, 465 for SSL) [587]: " _smtp_port
            read -rp "  SMTP username / email: " _smtp_user
            read -rsp "  SMTP password / app password: " _smtp_pass
            echo ""
            read -rp "  From address (e.g. Nerla <noreply@yourdomain.com>): " _smtp_from

            env_set EMAIL_HOST "${_smtp_host}"
            env_set EMAIL_PORT "${_smtp_port:-587}"
            env_set EMAIL_USER "${_smtp_user}"
            env_set EMAIL_PASS "${_smtp_pass}"
            env_set EMAIL_FROM "${_smtp_from:-Nerla <${_smtp_user}>}"
            echo "  Email configured."
        else
            echo "  Skipped. Invite someone from Settings > Members and the app will"
            echo "  give you a link to send them yourself."
            echo "  You can add email later by setting EMAIL_* variables in .env"
        fi
    else
        echo "  Email already configured (${_email_user})."
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Generate garage.toml from template
# ---------------------------------------------------------------------------
generate_garage_toml() {
    echo "--- Generating garage.toml ---"

    if [ ! -f garage.toml.template ]; then
        echo "ERROR: garage.toml.template not found."
        exit 1
    fi

    _rpc="$(env_get GARAGE_RPC_SECRET)"
    _admin="$(env_get GARAGE_ADMIN_TOKEN)"

    sed \
        -e "s|RPC_SECRET_PLACEHOLDER|${_rpc}|" \
        -e "s|ADMIN_TOKEN_PLACEHOLDER|${_admin}|" \
        garage.toml.template > garage.toml

    chmod 600 garage.toml 2>/dev/null || true
    echo "  garage.toml generated with secrets (permissions restricted)."
    echo ""
}

# ---------------------------------------------------------------------------
# Wait for Garage to be healthy
# ---------------------------------------------------------------------------
wait_for_garage() {
    echo "--- Waiting for Garage to be healthy ---"
    local MAX_WAIT=90
    local elapsed=0
    while [ $elapsed -lt $MAX_WAIT ]; do
        if docker exec nerla-garage /garage -c /etc/garage.toml status &>/dev/null; then
            echo "  Garage is ready (${elapsed}s)."
            break
        fi
        sleep 2
        elapsed=$((elapsed + 2))
        printf "  waiting... (%ds)\r" "$elapsed"
    done

    if [ $elapsed -ge $MAX_WAIT ]; then
        echo ""
        echo "ERROR: Garage did not become healthy within ${MAX_WAIT}s."
        echo "Check: docker logs nerla-garage"
        exit 1
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Provision Garage layout, key, and bucket
# ---------------------------------------------------------------------------
provision_garage() {
    echo "--- Provisioning Garage storage ---"

    GARAGE_CMD="docker exec nerla-garage /garage -c /etc/garage.toml"

    # Assign layout if no layout has been applied yet
    NODE_ID=$($GARAGE_CMD status 2>/dev/null | grep -oE '[0-9a-f]{16}' | head -1 || true)
    if [ -n "$NODE_ID" ]; then
        LAYOUT=$($GARAGE_CMD layout show 2>/dev/null || true)
        if ! echo "$LAYOUT" | grep -q "$NODE_ID"; then
            echo "  Assigning layout for node $NODE_ID..."
            $GARAGE_CMD layout assign "$NODE_ID" -z dc1 -c 1G 2>/dev/null || true
            $GARAGE_CMD layout apply --version 1 2>/dev/null || true
        else
            echo "  Layout already assigned."
        fi
    fi

    # Create access key (or reuse existing)
    _existing_ak="$(env_get S3_ACCESS_KEY)"
    if from_file S3_ACCESS_KEY || from_file S3_SECRET_KEY; then
        ACCESS_KEY="${_existing_ak:-$(secret_file_value S3_ACCESS_KEY)}"
    elif [ -n "$_existing_ak" ] && [ "$_existing_ak" != "GK..." ] && [ "$_existing_ak" != "" ]; then
        echo "  Garage access key already in .env, skipping creation."
        ACCESS_KEY="$_existing_ak"
    else
        echo "  Creating Garage access key 'nerla-key'..."
        EXISTING=$($GARAGE_CMD key list 2>/dev/null | grep "nerla-key" | awk '{print $1}' || true)
        for kid in $EXISTING; do
            [[ "$kid" == GK* ]] && $GARAGE_CMD key delete --yes "$kid" 2>/dev/null || true
        done

        KEY_OUTPUT=$($GARAGE_CMD key create nerla-key 2>/dev/null)

        ACCESS_KEY=$(echo "$KEY_OUTPUT" | grep -i "Key ID"    | awk -F': ' '{print $2}' | awk '{print $1}' | tr -d ' ')
        SECRET_KEY=$(echo "$KEY_OUTPUT" | grep -i "Secret key" | awk -F': ' '{print $2}' | tr -d ' ')

        if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
            echo "ERROR: Could not parse Garage key output:"
            echo "$KEY_OUTPUT"
            exit 1
        fi

        env_set S3_ACCESS_KEY "$ACCESS_KEY"
        env_set S3_SECRET_KEY "$SECRET_KEY"
        echo "  Access key written to .env."
    fi

    BUCKET="$(env_get S3_BUCKET)"
    BUCKET="${BUCKET:-nerla-files}"

    # Create bucket (idempotent)
    $GARAGE_CMD bucket create "$BUCKET" 2>/dev/null || true

    # Grant permissions (idempotent)
    if [ -n "$ACCESS_KEY" ]; then
        $GARAGE_CMD bucket allow --read --write --owner "$BUCKET" --key "$ACCESS_KEY" 2>/dev/null || true
        echo "  Bucket '$BUCKET' ready."
    else
        echo "  WARNING: The Garage access key file could not be read, so the key was not given the bucket."
        echo "  Give it the bucket with: $GARAGE_CMD bucket allow --read --write --owner $BUCKET --key <access key>"
    fi
    echo ""
}
