#!/usr/bin/env bash
# Runs ./nerla update against stub docker and git commands that record their calls, so it needs no Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/install/scripts" "$TMP/bin"
cp "$ROOT/nerla" "$TMP/install/nerla"
cp "$ROOT/scripts/compose.sh" "$TMP/install/scripts/compose.sh"
printf '#!/bin/bash\necho "Backup complete: backups/stub"\n' >"$TMP/install/scripts/backup.sh"

cat >"$TMP/bin/docker" <<'STUB'
#!/bin/bash
echo "docker $* NERLA_VERSION=$NERLA_VERSION" >>"$CALLS"
case "$*" in
    "compose pull") [ -z "${FAIL_PULL:-}" ] || exit 1 ;;
    *"ps -q --status running"* | *"ps -aq"*) echo stubid ;;
    "inspect "*) echo "running 0" ;;
esac
exit 0
STUB

cat >"$TMP/bin/git" <<'STUB'
#!/bin/bash
echo "git $*" >>"$CALLS"
case "$1" in
    tag) case "$*" in
        *--points-at*) cat "$CALLS.head" ;;
        *--sort=-v:refname*) printf '%s\n' $TAGS | sort -rV ;;
        *) printf '%s\n' $TAGS | sort -r ;;
    esac ;;
    checkout) if [ "$2" = --detach ]; then echo "$3" >"$CALLS.head"; else : >"$CALLS.head"; fi ;;
    rev-parse) case "$*" in *--abbrev-ref*) echo main ;; *) echo abc1234 ;; esac ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/docker" "$TMP/bin/git" "$TMP/install/nerla"

fails=0
PROD=docker-compose.yml:docker-compose.prod.yml
# Runs ./nerla update with the current TAGS, leaving the calls in $TMP/calls and the output in $out
run() {
    : >"$TMP/calls"
    : >"$TMP/calls.head"
    : >"$TMP/install/.env"
    out="$(cd "$TMP/install" && PATH="$TMP/bin:$PATH" CALLS="$TMP/calls" TAGS="${TAGS:-}" COMPOSE_FILE="$PROD" ./nerla update 2>&1)" || true
}
expect() { grep -q -- "$1" <<<"$2" || { echo "FAIL $name: missing: $1"; fails=$((fails + 1)); }; }
forbid() { ! grep -q -- "$1" <<<"$2" || { echo "FAIL $name: unexpected: $1"; fails=$((fails + 1)); }; }

name="a: no tags builds from source"
TAGS="" run
calls="$(cat "$TMP/calls")"
expect "No release yet, so Nerla is built from source." "$out"
expect "compose build" "$calls"
expect "git pull --ff-only" "$calls"

name="b: newest tag by version, then pull, then up"
TAGS="v1.0.0 v1.2.0 v1.10.0" run
calls="$(cat "$TMP/calls")"
expect "git checkout --detach v1.10.0" "$calls"
expect "compose pull NERLA_VERSION=v1.10.0" "$calls"
forbid "compose build" "$calls"
[ "$(grep -n -m1 'compose pull' "$TMP/calls" | cut -d: -f1)" -lt "$(grep -n -m1 'compose up -d' "$TMP/calls" | cut -d: -f1)" ] ||
    { echo "FAIL $name: pull did not come before up"; fails=$((fails + 1)); }

name="f: a release candidate is never picked"
TAGS="v1.2.0 v1.10.0 v1.10.0-rc1" run
calls="$(cat "$TMP/calls")"
expect "git checkout --detach v1.10.0$" "$calls"
expect "compose pull NERLA_VERSION=v1.10.0$" "$calls"

name="c: a failed pull restarts nothing"
TAGS="v1.0.0" FAIL_PULL=1 run
calls="$(cat "$TMP/calls")"
expect "Downloading the new version failed, so nothing changed and Nerla keeps running abc1234." "$out"
forbid "compose up" "$calls"
expect "git checkout main" "$calls"

name="d: NERLA_BUILD=source builds even with tags"
: >"$TMP/calls"
echo "NERLA_BUILD=source" >"$TMP/install/.env"
(cd "$TMP/install" && PATH="$TMP/bin:$PATH" CALLS="$TMP/calls" TAGS="v1.0.0" COMPOSE_FILE="$PROD" ./nerla update >/dev/null 2>&1) || true
calls="$(cat "$TMP/calls")"
expect "compose build" "$calls"
forbid "compose pull" "$calls"

name="e: build reaches compose build"
: >"$TMP/calls"
(cd "$TMP/install" && PATH="$TMP/bin:$PATH" CALLS="$TMP/calls" ./nerla build >/dev/null 2>&1) || true
expect "compose build" "$(cat "$TMP/calls")"

[ "$fails" -eq 0 ] && echo "nerla update tests passed"
exit "$fails"
