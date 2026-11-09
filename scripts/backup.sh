#!/bin/bash
set -euo pipefail

# Nerla backup: the database, the uploaded files (the Garage object store, or the files volume with
# STORAGE_DRIVER=local), the web proxy's certificates and the install's settings (.env and garage.toml) go into one
# timestamped folder. Files kept with another S3 provider stay there, and only the rest is backed up.
#
# Run manually with:  ./nerla backup
# setup.sh installs a nightly cron entry that calls this script.
# NERLA_DIR, when set, is the folder holding .env and garage.toml instead of the checkout.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"
# shellcheck source=scripts/compose.sh
. "$SCRIPT_DIR/compose.sh"
NERLA_DIR="${NERLA_DIR:-$PROJECT_DIR}"

# The backup holds secrets, so nothing in it is readable by other users
umask 077

# Cron runs with an almost empty environment, so the settings have to come from .env rather than
# from whatever happens to be exported. They are read as text, never run as shell code
load_env_values "$NERLA_DIR/.env" DB_USER DB_NAME BACKUP_DIR BACKUP_RETENTION_DAYS STORAGE_DRIVER

DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-nerla}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STORAGE_DRIVER="$(storage_driver "${STORAGE_DRIVER:-}")"
# From .env only, as that is what the server reads. Empty means the bundled Garage
S3_ENDPOINT="$(compose_value "$(env_text S3_ENDPOINT "$NERLA_DIR/.env")")"
STORAGE="$STORAGE_DRIVER"
[ "$STORAGE" = s3 ] && [ -n "$S3_ENDPOINT" ] && [ "$S3_ENDPOINT" != http://garage:3900 ] && STORAGE=s3-external
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DEST="$BACKUP_DIR/$TIMESTAMP"

nerla_compose

mkdir -p "$BACKUP_DIR" "$DEST"
chmod 700 "$DEST"

finished=0
# Leave a marker so a half-finished backup is never mistaken for a good one
trap '[ "$finished" = 1 ] || touch "$DEST/INCOMPLETE"' EXIT

fail() {
    echo "ERROR: $*" >&2
    echo "The unfinished backup in $DEST is marked INCOMPLETE and restore will refuse it." >&2
    exit 1
}

size() {
    wc -c <"$1" | tr -d ' '
}

case "$STORAGE_DRIVER" in
    s3 | local) ;;
    *) fail "STORAGE_DRIVER in .env must be s3 or local. Fix it, then back up again." ;;
esac
nerla_running postgres || fail "The database is not running. Start Nerla with ./nerla start, then run the backup again."
PG="$(nerla_container postgres)"
if [ "$STORAGE" = local ]; then
    SERVER="$(nerla_container server)"
    [ -n "$SERVER" ] || fail "The server container does not exist yet. Start Nerla with ./nerla start, then run the backup again."
elif [ "$STORAGE" = s3 ]; then
    nerla_running garage || fail "File storage (Garage) is not running. Start Nerla with ./nerla start, then run the backup again."
    GARAGE="$(nerla_container garage)"
fi
# The postgres image has sh and tar, and is already on this machine at a pinned digest
HELPER_IMAGE="$(docker inspect -f '{{.Image}}' "$PG")"
GARAGE_ROOT=/var/lib/garage

# The database goes first, so every file the dump points to is already stored when the files are copied
echo "Backing up the database..."
docker exec "$PG" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$DEST/postgres.dump" ||
    fail "pg_dump failed. Check that DB_USER and DB_NAME in .env match the database."
[ "$(size "$DEST/postgres.dump")" -gt 0 ] || fail "The database dump is empty, so it is not usable."
docker exec -i "$PG" pg_restore -l <"$DEST/postgres.dump" >/dev/null ||
    fail "The database dump cannot be read back, so it is not usable."

psql_value() {
    docker exec "$PG" psql -X -U "$DB_USER" -d "$DB_NAME" -tAc "$1"
}
LAST_MIGRATION=""
HAS_MIGRATIONS="$(psql_value "select to_regclass('nerla_migrations') is not null")" ||
    fail "Could not read the applied migrations from the database."
if [ "$HAS_MIGRATIONS" = t ]; then
    LAST_MIGRATION="$(psql_value "select coalesce(max(name), '') from nerla_migrations")" ||
        fail "Could not read the applied migrations from the database."
fi

if [ "$STORAGE" = s3-external ]; then
    echo "Your files are in $S3_ENDPOINT, so this backup holds the database and settings but not the files. Turn on your provider's versioning or backups."
    FILES=""
    STORAGE_LINES="storage: s3-external"
elif [ "$STORAGE" = local ]; then
    echo "Backing up uploaded files (local disk)..."
    # A write in progress is still a temp file, and the server removes those at start
    docker run --rm --volumes-from "$SERVER:ro" --entrypoint tar "$HELPER_IMAGE" czf - --numeric-owner --exclude '.*.tmp' -C /data/files . \
        >"$DEST/files.tar.gz" || fail "Copying the uploaded files failed."
    gzip -t "$DEST/files.tar.gz" 2>/dev/null || fail "files.tar.gz was not written correctly to $DEST."
    FILES=", files.tar.gz"
    STORAGE_LINES="storage: local"
else
    echo "Backing up uploaded files (Garage)..."
    # A snapshot is a consistent copy of the metadata taken while Garage runs. The staged copy holds it
    # where Garage keeps its live database, so a restore only has to unpack it
    GARAGE_MODE=snapshot
    STAGE_META='
set -e
meta='"$GARAGE_ROOT"'/meta
snap="$(ls -1d "$meta"/snapshots/*/ 2>/dev/null | sort | tail -1)"
mkdir -p /stage
for path in "$meta"/* "$meta"/.[!.]*; do
    [ -e "$path" ] || continue
    case "${path##*/}" in db.lmdb | db.sqlite | snapshots) ;; *) cp -a "$path" /stage/ ;; esac
done
if [ -f "$snap/db.lmdb" ]; then
    mkdir /stage/db.lmdb
    cp "$snap/db.lmdb" /stage/db.lmdb/data.mdb
elif [ -f "$snap/db.sqlite" ]; then
    cp "$snap/db.sqlite" /stage/db.sqlite
else
    exit 3
fi
tar czf - -C /stage .
'
    if snapshot_log="$(docker exec "$GARAGE" /garage meta snapshot 2>&1)" &&
        docker run --rm --volumes-from "$GARAGE:ro" --entrypoint sh "$HELPER_IMAGE" -c "$STAGE_META" >"$DEST/garage-meta.tar.gz"; then
        docker run --rm --volumes-from "$GARAGE:ro" --entrypoint tar "$HELPER_IMAGE" czf - -C "$GARAGE_ROOT/data" . \
            >"$DEST/garage-data.tar.gz" || fail "Copying the Garage data failed."
    else
        echo "  The Garage metadata snapshot did not work, so Garage is stopped while its files are copied."
        [ -n "$snapshot_log" ] && echo "$snapshot_log" | tail -3 | sed 's/^/  /'
        GARAGE_MODE=stopped
        "${COMPOSE[@]}" stop garage >/dev/null || fail "Could not stop Garage for the copy."
        copied=1
        docker run --rm --volumes-from "$GARAGE:ro" --entrypoint tar "$HELPER_IMAGE" czf - -C "$GARAGE_ROOT/meta" . \
            >"$DEST/garage-meta.tar.gz" || copied=0
        [ "$copied" = 1 ] && { docker run --rm --volumes-from "$GARAGE:ro" --entrypoint tar "$HELPER_IMAGE" czf - -C "$GARAGE_ROOT/data" . \
            >"$DEST/garage-data.tar.gz" || copied=0; }
        "${COMPOSE[@]}" start garage >/dev/null || fail "Garage did not start again after the copy. Run ./nerla start."
        [ "$copied" = 1 ] || fail "Copying the Garage files failed."
    fi

    # A zero exit is not proof the archives landed, so check them
    for archive in garage-meta.tar.gz garage-data.tar.gz; do
        gzip -t "$DEST/$archive" 2>/dev/null || fail "$archive was not written correctly to $DEST."
    done
    # grep reads the whole listing, as quitting early would end tar with a broken pipe
    tar tzf "$DEST/garage-meta.tar.gz" | grep -E '(^|/)(db\.lmdb|db\.sqlite)' >/dev/null ||
        fail "The Garage metadata archive has no database in it, so it is not usable."
    FILES=", garage-meta.tar.gz, garage-data.tar.gz"
    STORAGE_LINES="storage: s3
garage: $GARAGE_MODE"
fi

# The web proxy's certificates and keys, so a restore never has to ask Let's Encrypt again. A dev stack has no web proxy
WEB="$(nerla_container web || true)"
CERTS=""
if [ -n "$WEB" ]; then
    echo "Backing up the HTTPS certificates..."
    docker run --rm --volumes-from "$WEB:ro" --entrypoint tar "$HELPER_IMAGE" czf - --numeric-owner -C /data . \
        >"$DEST/caddy-data.tar.gz" || fail "Copying the HTTPS certificates failed."
    gzip -t "$DEST/caddy-data.tar.gz" 2>/dev/null || fail "caddy-data.tar.gz was not written correctly to $DEST."
    CERTS=", caddy-data.tar.gz"
fi

echo "Backing up the settings (.env and garage.toml)..."
for file in .env garage.toml; do
    [ -f "$NERLA_DIR/$file" ] || fail "$NERLA_DIR/$file is missing. Run ./setup.sh to create it, then back up again."
    cp "$NERLA_DIR/$file" "$DEST/$file"
    chmod 600 "$DEST/$file"
done

VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

cat >"$DEST/MANIFEST" <<EOF
created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
nerla_version: $VERSION
last_migration: ${LAST_MIGRATION:-none}
database: $DB_NAME (user $DB_USER)
$STORAGE_LINES
files: postgres.dump$FILES, .env, garage.toml$CERTS
restore: ./nerla restore $DEST
EOF
chmod 600 "$DEST"/*
finished=1

echo ""
echo "Backup complete: $DEST"
du -sh "$DEST" | awk '{print "  size: " $1}'
echo ""
echo "This backup holds the install's secrets (its .env and garage.toml), so only its owner can read it."
echo "Keep every copy of it as private as the server itself."

# Prune old backups, but never the one just written.
prune_err=$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -mtime "+$RETENTION_DAYS" \
    -not -path "$DEST" -exec rm -rf {} + 2>&1) ||
    echo "Couldn't remove old backups in $BACKUP_DIR: $(printf %s "$prune_err" | tr '\n' ' '). Free the space or fix the folder's owner." >&2

echo ""
echo "NOTE: these backups sit on the same server as the data they protect."
echo "      Copy them somewhere else regularly, for example:"
echo "        rsync -az $BACKUP_DIR/ you@another-host:/nerla-backups/"
