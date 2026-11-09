#!/bin/bash
# Sourced by ./nerla, setup.sh, backup.sh and restore.sh so they run docker compose and read .env the same way.
# COMPOSE_FILE and COMPOSE_PROJECT_NAME, when set, pick another stack (scripts/test-backup.sh uses them).

# Git Bash on Windows would turn the container paths in docker commands into Windows paths
export MSYS_NO_PATHCONV=1

# A stack started without docker-compose.prod.yml is a dev stack, so it keeps its override file.
# NERLA_DIR, when set, is the folder holding .env
nerla_compose() {
    # The release tag at HEAD names the images to run, and anything else means images built from source
    NERLA_VERSION="$(release_tags --points-at HEAD | head -1)"
    if [ -z "$NERLA_VERSION" ] || [ "$(env_value NERLA_BUILD "${NERLA_DIR:-.}/.env")" = source ]; then
        NERLA_VERSION=source
    fi
    export NERLA_VERSION
    if [ -n "${COMPOSE_FILE:-}" ]; then
        COMPOSE=(docker compose)
        return
    fi
    local files
    files="$(docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-nerla}" \
        --format '{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | head -1 || true)"
    # With no containers yet, .env says which, as setup.sh writes NODE_ENV=production
    if [ -z "$files" ] && [ "$(env_value NODE_ENV "${NERLA_DIR:-.}/.env")" = production ]; then
        files=docker-compose.prod.yml
    fi
    case "$files" in
        *docker-compose.prod.yml*) COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml) ;;
        *) COMPOSE=(docker compose) ;;
    esac
}

# Release tags, newest first. The release workflow only builds vX.Y.Z, so other v tags are skipped
release_tags() {
    git tag --list 'v*' --sort=-v:refname "$@" 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true
}

# The id of a service's container, running or not
nerla_container() {
    "${COMPOSE[@]}" ps -aq "$1" 2>/dev/null | head -1
}

nerla_running() {
    [ -n "$("${COMPOSE[@]}" ps -q --status running "$1" 2>/dev/null | head -1)" ]
}

# The text after KEY= on the last line for a key in a .env file, as written
env_text() {
    { tr -d '\r' <"$2" | sed -n "s/^$1=//p" | tail -1; } 2>/dev/null || true
}

unquote() {
    local value="$1"
    case "$value" in
        \"*\") value="${value#\"}" && value="${value%\"}" ;;
        \'*\') value="${value#\'}" && value="${value%\'}" ;;
    esac
    printf '%s' "$value"
}

# One value from a .env file, read as text so a value with spaces, $, ; or < is never run as shell code.
# One pair of surrounding quotes is removed, as docker compose does. The last line for a key wins
env_value() {
    unquote "$(env_text "$1" "$2")"
}

# A value as docker compose reads it: an inline " #" comment and the spaces around it go, then one pair of quotes
compose_value() {
    unquote "$(printf '%s' "$1" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
}

# STORAGE_DRIVER as docker compose reads it. Unset is s3
storage_driver() {
    local value
    value="$(compose_value "$1")"
    printf '%s' "${value:-s3}"
}

# Sets each named variable from a .env file that has a line for it, and leaves the others as they are
load_env_values() {
    local file="$1" key
    shift
    [ -f "$file" ] || return 0
    for key in "$@"; do
        grep -q "^$key=" "$file" && printf -v "$key" '%s' "$(env_value "$key" "$file")"
    done
    return 0
}
