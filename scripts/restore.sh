#!/bin/bash
set -euo pipefail

# Restore a Nerla backup created by scripts/backup.sh.
#
#   ./nerla restore backups/20260819_030000
#
# Replaces the current database, the uploaded files and, when chosen at the prompt, the settings. It asks first.
# Everything is checked and unpacked beside what is in use, and swapped in only once all of it worked.
# NERLA_DIR, when set, is the folder holding .env and garage.toml instead of the checkout.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"
# shellcheck source=scripts/compose.sh
. "$SCRIPT_DIR/compose.sh"
NERLA_DIR="${NERLA_DIR:-$PROJECT_DIR}"
umask 077

die() {
    echo "ERROR: $*" >&2
    exit 1
}

STOPPED="The app is stopped. Start it again with ./nerla start."
die_stopped() {
    die "$* $STOPPED"
}

SRC="${1:-}"
if [ -z "$SRC" ]; then
    echo "Usage: ./nerla restore <backup-folder>"
    echo ""
    if [ -d "${BACKUP_DIR:-backups}" ]; then
        echo "Available backups:"
        find "${BACKUP_DIR:-backups}" -maxdepth 1 -mindepth 1 -type d | sort -r | head -10 | sed 's/^/  /'
    fi
    exit 1
fi

[ -d "$SRC" ] || die "$SRC is not a folder. Give the path of a backup folder, for example backups/20260819_030000."
SRC="$(cd "$SRC" && pwd)"
[ -f "$SRC/INCOMPLETE" ] && die "That backup is marked INCOMPLETE, so it never finished. Pick another backup."
INCOMPLETE="so this backup is not complete. Nothing was changed. Pick another backup."
[ -f "$SRC/MANIFEST" ] || die "$SRC/MANIFEST is missing, $INCOMPLETE"
# Where the backup's files were stored
STORAGE="$(sed -n 's/^storage: *//p' "$SRC/MANIFEST" | head -1)"
case "$STORAGE" in
    s3) ARCHIVES="garage-meta.tar.gz garage-data.tar.gz" ;;
    local) ARCHIVES=files.tar.gz ;;
    # An external S3 store holds the files, so the backup has no file archive
    s3-external) ARCHIVES="" ;;
    *) die "$SRC/MANIFEST does not say where the files were stored, $INCOMPLETE" ;;
esac
for file in postgres.dump $ARCHIVES .env garage.toml; do
    [ -f "$SRC/$file" ] || die "$SRC/$file is missing, $INCOMPLETE"
done

# A backup that names a migration this install does not ship comes from a newer Nerla
LAST_MIGRATION="$(sed -n 's/^last_migration: *//p' "$SRC/MANIFEST" | head -1)"
JOURNAL="$PROJECT_DIR/server/drizzle/meta/_journal.json"
if [ -n "$LAST_MIGRATION" ] && [ "$LAST_MIGRATION" != none ]; then
    [ -f "$JOURNAL" ] || die "$JOURNAL is missing, so the backup cannot be checked against this install. Reinstall Nerla, then restore."
    grep -qF "\"$LAST_MIGRATION\"" "$JOURNAL" || die "This backup is from a newer Nerla. Update first, then restore."
fi

nerla_compose

PG="$(nerla_container postgres)"
# With the local disk, the GARAGE_ names below stand for the server's files volume, which is one part
if [ "$STORAGE" = local ]; then
    GARAGE="$(nerla_container server)"
    GARAGE_ROOT=/data
    PARTS=files
    VOLUMES="the files volume"
elif [ "$STORAGE" = s3 ]; then
    GARAGE="$(nerla_container garage)"
    GARAGE_ROOT=/var/lib/garage
    PARTS="meta data"
    VOLUMES="the Garage volumes"
else
    GARAGE="" GARAGE_ROOT="" PARTS="" VOLUMES=""
fi
[ -n "$PG" ] && { [ -n "$GARAGE" ] || [ -z "$PARTS" ]; } ||
    die "Nerla's database or storage container does not exist yet. Run ./setup.sh, or ./nerla start, then restore again. Nothing was changed."
# The postgres image has pg_restore, sh and tar, and is already on this machine at a pinned digest
HELPER_IMAGE="$(docker inspect -f '{{.Image}}' "$PG")"
in_parts() {
    local part
    for part in $PARTS; do printf '%s ' "$GARAGE_ROOT/$part/$1"; done
}

# Printed commands to inspect or remove what an unfinished restore set aside
GARAGE_LOOK="docker run --rm --volumes-from $GARAGE --entrypoint ls $HELPER_IMAGE -la $(in_parts .nerla-old)"
GARAGE_REMOVE="docker run --rm --volumes-from $GARAGE --entrypoint rm $HELPER_IMAGE -rf $(in_parts .nerla-old)"
db_look() {
    echo "docker exec -it $PG sh -c 'psql -U \"\$POSTGRES_USER\" -d $1'"
}
db_remove() {
    echo "docker exec $PG sh -c 'dropdb -U \"\$POSTGRES_USER\" $1'"
}
leftover_hint() {
    local databases="$1" folders="$2"
    if [ -n "$databases" ]; then
        echo "  Database $databases holds the install's data from before that restore."
        for db in ${databases//,/ }; do
            echo "    Look at it:  $(db_look "$db")"
            echo "    Remove it:   $(db_remove "$db")"
        done
    fi
    if [ -n "$folders" ] && [ -n "$PARTS" ]; then
        echo "  The .nerla-old folders in $VOLUMES hold the uploaded files from before that restore."
        echo "    Look at them:  $GARAGE_LOOK"
        echo "    Remove them:   $GARAGE_REMOVE"
    fi
}

# An earlier restore that did not finish keeps the previous data aside, and a new restore would delete it
leftover_databases() {
    docker exec "$PG" sh -c "psql -X -tA -U \"\$POSTGRES_USER\" -d postgres -c \"select string_agg(datname, ',') from pg_database where datname like '%\\_before\\_restore'\""
}
leftover_folders() {
    [ -n "$PARTS" ] || return 0
    docker run --rm --volumes-from "$GARAGE" --entrypoint sh "$HELPER_IMAGE" -c \
        "ls -d $GARAGE_ROOT/*/.nerla-old $GARAGE_ROOT/*/.nerla-moved $GARAGE_ROOT/*/.nerla-old/.nerla-moved 2>/dev/null || true"
}
refuse_leftovers() {
    local databases="$1" folders
    folders="$(leftover_folders)"
    [ -z "$databases" ] && [ -z "$folders" ] && return 0
    {
        echo "ERROR: An earlier restore did not finish, and it kept the install's previous data aside."
        leftover_hint "$databases" "$folders"
        echo "  Check that you no longer need it, remove it with the commands above, then run ./nerla restore again. $2"
    } >&2
    exit 1
}
# The database can only be asked while it runs. When it is stopped, the check runs again once it is started
DATABASES_CHECKED=0
if nerla_running postgres; then
    databases="$(leftover_databases)" || die "Could not check the database for an earlier restore that did not finish. Nothing was changed."
    refuse_leftovers "$databases" "Nothing was changed."
    DATABASES_CHECKED=1
else
    refuse_leftovers "" "Nothing was changed."
fi

# Every archive is read in full before anything is touched, so a damaged backup changes nothing
echo "Checking the backup..."
bad_backup() {
    die "$1 in this backup is damaged or unreadable, so nothing was changed. Pick another backup."
}
check_archive() {
    local archive="$SRC/$1" db_pattern="$2" listing
    gzip -t "$archive" 2>/dev/null || bad_backup "$1"
    listing="$(tar tzf "$archive" 2>/dev/null)" || bad_backup "$1"
    if [ -n "$db_pattern" ]; then
        grep -E "$db_pattern" >/dev/null <<<"$listing" || bad_backup "$1 has no Garage database in it, so it"
    fi
}
docker run --rm -i --entrypoint pg_restore "$HELPER_IMAGE" -l <"$SRC/postgres.dump" >/dev/null 2>&1 || bad_backup postgres.dump
if [ "$STORAGE" = local ]; then
    check_archive files.tar.gz ""
elif [ "$STORAGE" = s3 ]; then
    check_archive garage-meta.tar.gz '^(\./)?(db\.lmdb|db\.sqlite)'
    check_archive garage-data.tar.gz ""
fi
# A stack without the web proxy has no certificates to back up
[ -f "$SRC/caddy-data.tar.gz" ] && check_archive caddy-data.tar.gz ""

echo ""
if [ -n "$PARTS" ]; then
    echo "This will REPLACE the current database and uploaded files with:"
else
    echo "Your files are in your own S3 store and stay where they are. This will REPLACE the current database with:"
fi
echo "  $SRC"
echo ""
sed 's/^/  /' "$SRC/MANIFEST"
echo ""
confirm=""
read -rp "Type 'restore' to continue: " confirm || true
[ "$confirm" = "restore" ] || {
    echo "Cancelled. Nothing was changed."
    exit 0
}

# Names only, never values
changed_settings() {
    {
        diff <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | sort) <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$2" | sort) || true
    } | sed -n 's/^[<>] \([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | sort -u | paste -sd, - | sed 's/,/, /g'
}

# The chosen settings are only read here, and written once the database and files are both restored
use_backup_settings=1
if [ -f "$NERLA_DIR/.env" ] && { ! cmp -s "$SRC/.env" "$NERLA_DIR/.env" || ! cmp -s "$SRC/garage.toml" "$NERLA_DIR/garage.toml"; }; then
    echo ""
    echo "The settings in this backup differ from the ones in use now."
    names="$(changed_settings "$SRC/.env" "$NERLA_DIR/.env")"
    [ -n "$names" ] && echo "  Different in .env: $names"
    cmp -s "$SRC/garage.toml" "$NERLA_DIR/garage.toml" || echo "  garage.toml differs too."
    echo ""
    echo "  1) Use the backup's settings. Its passwords and storage keys match the data being restored."
    echo "  2) Keep the settings in use now."
    choice=""
    read -rp "Choose 1 or 2 [1]: " choice || true
    case "$choice" in
        "" | 1) use_backup_settings=1 ;;
        2) use_backup_settings=0 ;;
        *) die "Please answer 1 or 2. Nothing was changed." ;;
    esac
fi
if [ "$use_backup_settings" = 1 ]; then
    SETTINGS="$SRC/.env"
else
    SETTINGS="$NERLA_DIR/.env"
fi

# One value from a settings file, read as text
setting() {
    env_value "$1" "$2"
}
SETTINGS_STORAGE="$(storage_driver "$(setting STORAGE_DRIVER "$SETTINGS")")"
DRIVER="${STORAGE%-external}"
[ "$SETTINGS_STORAGE" = "$DRIVER" ] ||
    die "The backup's files were stored with STORAGE_DRIVER=$DRIVER, but the settings you chose use $SETTINGS_STORAGE, so Nerla would not find the restored files. Use the backup's settings, or set STORAGE_DRIVER=$DRIVER in .env first. Nothing was changed."
# An s3-external backup has no files, so the chosen settings must point at that external store
if [ "$STORAGE" = s3-external ]; then
    case "$(setting S3_ENDPOINT "$SETTINGS")" in
        "" | http://garage:3900 | http://garage:3900/)
            die "This backup's files are in your own S3 store, not in the backup, but the settings you chose use Nerla's own file storage, so Nerla would not find them. Use the backup's settings, or set S3_ENDPOINT and the other S3_ lines in .env to your store first. Nothing was changed." ;;
    esac
fi
DB_USER="$(setting DB_USER "$SETTINGS")"
DB_USER="${DB_USER:-postgres}"
DB_NAME="$(setting DB_NAME "$SETTINGS")"
DB_NAME="${DB_NAME:-nerla}"
# Empty when the password comes from DB_PASSWORD_FILE, and then the database keeps the one it has
DB_PASSWORD="$(setting DB_PASSWORD "$SETTINGS")"
CURRENT_DB_PASSWORD=""
[ -f "$NERLA_DIR/.env" ] && CURRENT_DB_PASSWORD="$(setting DB_PASSWORD "$NERLA_DIR/.env")"
RESTORING_DB="${DB_NAME}_restoring"
PREVIOUS_DB="${DB_NAME}_before_restore"

# Ctrl-C or a kill says how far the restore got, and what was kept aside
STATE="Nothing in use was changed."
on_interrupt() {
    trap - INT TERM
    {
        echo ""
        echo "ERROR: The restore was interrupted. $STATE"
        case "$STATE" in
            *"kept as"* | *.nerla-old*)
                leftover_hint "$PREVIOUS_DB" "yes"
                echo "  Run ./nerla restore again once you have checked them. It refuses to start while they are there."
                ;;
        esac
        echo "  $STOPPED"
    } >&2
    exit 130
}
trap on_interrupt INT TERM

echo ""
echo "Stopping the app (the database stays up)..."
APP_SERVICES="$("${COMPOSE[@]}" config --services | grep -vxE 'postgres|garage' || true)"
if [ -n "$APP_SERVICES" ]; then
    # shellcheck disable=SC2086
    "${COMPOSE[@]}" stop $APP_SERVICES || die_stopped "Could not stop the app, so nothing was changed."
fi
"${COMPOSE[@]}" up -d --wait postgres || die_stopped "The database did not start, so nothing was changed. Check it with ./nerla logs postgres."
PG="$(nerla_container postgres)"
if [ "$DATABASES_CHECKED" = 0 ]; then
    databases="$(leftover_databases)" ||
        die_stopped "Could not check the database for an earlier restore that did not finish, so nothing was changed."
    refuse_leftovers "$databases" "Nothing was changed. $STOPPED"
fi

# A value inside single quotes for a psql meta-command
psql_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g")"
}

# The script comes on stdin, so the password never shows in a process list
psql_admin() {
    {
        printf '\\set user %s\n' "$(psql_quote "$DB_USER")"
        printf '\\set password %s\n' "$(psql_quote "$DB_PASSWORD")"
        printf '\\set db %s\n' "$(psql_quote "$DB_NAME")"
        printf '\\set restoring %s\n' "$(psql_quote "$RESTORING_DB")"
        printf '\\set previous %s\n' "$(psql_quote "$PREVIOUS_DB")"
        echo "SET client_min_messages = warning;"
        cat
    } | docker exec -i "$PG" sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres'
}

# Swapping two databases by name in one transaction is atomic, so it can also be undone
swap_databases() {
    psql_admin >/dev/null <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN (:'db', :'restoring', :'previous') AND pid <> pg_backend_pid();
BEGIN;
SELECT format('ALTER DATABASE %I RENAME TO %I', :'db', :'previous') FROM pg_database WHERE datname = :'db' \gexec
ALTER DATABASE :"restoring" RENAME TO :"db";
COMMIT;
SQL
}
swap_databases_back() {
    psql_admin >/dev/null <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN (:'db', :'previous') AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE :"db" RENAME TO :"restoring";
SELECT format('ALTER DATABASE %I RENAME TO %I', :'previous', :'db') FROM pg_database WHERE datname = :'previous' \gexec
COMMIT;
DROP DATABASE IF EXISTS :"restoring";
SQL
}

drop_restoring() {
    psql_admin <<<'DROP DATABASE IF EXISTS :"restoring";' >/dev/null 2>&1 || true
}

# Garage keeps its files in two volumes, the local disk in one. Each archive is unpacked into .nerla-restore inside its volume
garage_helper() {
    docker run --rm -i --volumes-from "$GARAGE" --entrypoint sh "$HELPER_IMAGE" -c "$1"
}
clean_staging() {
    garage_helper "rm -rf $(in_parts .nerla-restore) $(in_parts .nerla-unpack)" \
        </dev/null >/dev/null 2>&1 || true
}
# Each archive holds one volume's contents
stage_part() {
    garage_helper "set -e; cd $GARAGE_ROOT/$1; rm -rf .nerla-restore .nerla-unpack; mkdir .nerla-unpack
        tar xzf - -C .nerla-unpack; mv .nerla-unpack .nerla-restore" <"$2"
}
# Renames inside each volume, so the files in use are only moved aside. They are removed in a later step.
# find ignores a failed mv, so each move is checked: the volume root must be empty before the marker is written,
# and a folder emptied by moves must still pass rmdir. mv -n never overwrites, and rmdir catches anything it skipped.
# The marker says every file in use was moved aside, so a rollback knows which files in place are the new ones
ROOT_EMPTY='[ -z "$(find . -mindepth 1 -maxdepth 1 ! -name .nerla-old ! -name .nerla-restore)" ]'
SWAP_GARAGE="set -e
for part in $PARTS; do
    cd $GARAGE_ROOT/\$part
    mkdir .nerla-old
    find . -mindepth 1 -maxdepth 1 ! -name .nerla-old ! -name .nerla-restore -exec mv -n {} .nerla-old/ \\;
    $ROOT_EMPTY
    touch .nerla-old/.nerla-moved
    find .nerla-restore -mindepth 1 -maxdepth 1 -exec mv -n {} . \\;
    rmdir .nerla-restore
done"
# Each volume is put back in its own run, so one that fails does not stop the other, and set -e holds in each
rollback_part() {
    echo "set -e
cd $GARAGE_ROOT/$1
if [ -d .nerla-old ]; then
    if [ -f .nerla-old/.nerla-moved ]; then
        mkdir -p .nerla-restore
        find . -mindepth 1 -maxdepth 1 ! -name .nerla-old ! -name .nerla-restore -exec mv -n {} .nerla-restore/ \\;
        $ROOT_EMPTY
        rm .nerla-old/.nerla-moved
    fi
    find .nerla-old -mindepth 1 -maxdepth 1 -exec mv -n {} . \\;
    rmdir .nerla-old
fi
rm -rf .nerla-restore || echo 'Some unpacked files from the backup are left in .nerla-restore inside $VOLUMES. They are safe to delete.' >&2"
}
rollback_garage() {
    local failed=0 part
    for part in $PARTS; do
        garage_helper "$(rollback_part "$part")" </dev/null || failed=1
    done
    return "$failed"
}
CLEAN_OLD_GARAGE="rm -rf $(in_parts .nerla-old)"

echo "Loading the backup's database beside the one in use..."
psql_admin <<'SQL' || die_stopped "Could not prepare a database for the restore, so nothing was changed."
DROP DATABASE IF EXISTS :"restoring";
CREATE DATABASE :"restoring" OWNER :"user";
SQL
if ! docker exec -i "$PG" pg_restore -U "$DB_USER" -d "$RESTORING_DB" --clean --if-exists --no-owner --single-transaction \
    <"$SRC/postgres.dump"; then
    drop_restoring
    die_stopped "The backup's database could not be loaded, so nothing was changed. The lines above say why."
fi

[ -n "$PARTS" ] && echo "Unpacking the backup's files beside the ones in use..."
# The server, which holds the local disk's files, stopped with the app
if [ "$STORAGE" = s3 ] && ! "${COMPOSE[@]}" stop garage; then
    drop_restoring
    die_stopped "Could not stop Garage, so nothing was changed."
fi
staged=ok
if [ "$STORAGE" = local ]; then
    staged="$(stage_part files "$SRC/files.tar.gz" && echo ok || true)"
elif [ "$STORAGE" = s3 ]; then
    staged="$(stage_part meta "$SRC/garage-meta.tar.gz" && stage_part data "$SRC/garage-data.tar.gz" && echo ok || true)"
fi
if [ "$staged" != ok ]; then
    clean_staging
    drop_restoring
    die_stopped "The backup's files could not be unpacked, so nothing was changed."
fi

echo "Swapping in the restored database and files..."
STATE="The database was being swapped in. That swap is a single transaction, so either the database in use before is still in place, or it is kept as $PREVIOUS_DB and the files in use before may be in .nerla-old inside $VOLUMES."
if ! swap_databases; then
    STATE="Nothing in use was changed."
    clean_staging
    drop_restoring
    die_stopped "The restored database could not take the place of the one in use, so nothing was changed."
fi
STATE="The restored database is in place and the database in use before is kept as $PREVIOUS_DB. The files were being swapped in, and the files in use before may be in .nerla-old inside $VOLUMES."
if [ -n "$PARTS" ] && ! garage_helper "$SWAP_GARAGE" </dev/null; then
    files_back="The files were put back as they were."
    files_ok=1
    if ! rollback_garage; then
        files_back="The files could not all be put back, and those in use before are in .nerla-old inside $VOLUMES."
        files_ok=0
    fi
    if swap_databases_back; then
        STATE="Nothing in use was changed."
        [ "$files_ok" = 1 ] ||
            leftover_hint "" "yes" >&2
        die_stopped "The restored files could not take the place of the ones in use. The database was put back as it was. $files_back" \
            "The settings were not changed."
    fi
    leftover_hint "$PREVIOUS_DB" "$([ "$files_ok" = 1 ] || echo yes)" >&2
    die_stopped "The restored files could not take the place of the ones in use, and the database could not be put back." \
        "The database in use before is kept as $PREVIOUS_DB. $files_back The settings were not changed."
fi
STATE="The restored database and files are in place. The database in use before may still be kept as $PREVIOUS_DB, and the files in use before may still be in .nerla-old inside $VOLUMES. The settings were not changed."

# Clean-up is not part of the swap, so a failure here only leaves the previous data behind
psql_admin <<<'DROP DATABASE IF EXISTS :"previous";' || {
    echo "  WARNING: The database in use before is still there as $PREVIOUS_DB. Remove it once you are happy with the restore:"
    echo "    $(db_remove "$PREVIOUS_DB")"
}
if [ -n "$PARTS" ] && ! garage_helper "$CLEAN_OLD_GARAGE" </dev/null; then
    echo "  WARNING: The files in use before are still in .nerla-old inside $VOLUMES. Remove them once you are happy with the restore:"
    echo "    $GARAGE_REMOVE"
fi
STATE="The restored database and files are in place. The settings were not changed."

# Laid over what is there, so a certificate the backup lacks stays. The web proxy stopped with the app
WEB="$(nerla_container web || true)"
if [ -f "$SRC/caddy-data.tar.gz" ] && [ -n "$WEB" ]; then
    echo "Putting back the HTTPS certificates..."
    docker run --rm -i --volumes-from "$WEB" --entrypoint tar "$HELPER_IMAGE" xzf - --numeric-owner -C /data <"$SRC/caddy-data.tar.gz" ||
        echo "  WARNING: The HTTPS certificates could not be put back, so the web proxy asks Let's Encrypt for new ones when it starts."
fi

if [ "$use_backup_settings" = 1 ] && [ -n "$DB_PASSWORD" ] && [ "$DB_PASSWORD" != "$CURRENT_DB_PASSWORD" ]; then
    psql_admin <<<'ALTER ROLE :"user" WITH PASSWORD :'"'"'password'"'"';' ||
        die_stopped "The database and files are restored, but the database password could not be set to the one in the backup's .env. The settings were not changed."
    echo "  The database password was changed to the one in the backup's .env."
    STATE="The restored database and files are in place, and the database password is the one in the backup's .env. The settings were not changed yet."
fi

if [ "$use_backup_settings" = 1 ]; then
    for file in .env garage.toml; do
        cmp -s "$SRC/$file" "$NERLA_DIR/$file" 2>/dev/null && continue
        finish="To finish by hand, run: cp \"$SRC/$file\" \"$NERLA_DIR/$file\" && chmod 600 \"$NERLA_DIR/$file\""
        if [ -f "$NERLA_DIR/$file" ]; then
            cp "$NERLA_DIR/$file" "$NERLA_DIR/$file.before-restore" ||
                die_stopped "The database and files are restored, but $file could not be saved as $file.before-restore, so it was not replaced. $finish"
            chmod 600 "$NERLA_DIR/$file.before-restore" ||
                die_stopped "The database and files are restored, but $file.before-restore could not be made private, so $file was not replaced. Run: chmod 600 \"$NERLA_DIR/$file.before-restore\", then: cp \"$SRC/$file\" \"$NERLA_DIR/$file\" && chmod 600 \"$NERLA_DIR/$file\""
            echo "  The previous $file is saved as $file.before-restore."
        fi
        cp "$SRC/$file" "$NERLA_DIR/$file" ||
            die_stopped "The database and files are restored, but $file could not be written, so it still holds the settings from before. $finish"
        chmod 600 "$NERLA_DIR/$file" ||
            die_stopped "The database and files are restored and $file holds the backup's settings, but it could not be made private. Run: chmod 600 \"$NERLA_DIR/$file\""
        echo "  $file now holds the backup's settings."
        STATE="The restored database and files are in place, and $file holds the backup's settings."
    done
fi
trap - INT TERM

echo "Starting the app again..."
"${COMPOSE[@]}" up -d || die "The restore is done but the app did not start. Check it with ./nerla status and ./nerla logs."

echo ""
echo "Restore complete. Verify with: ./nerla doctor"
