#!/bin/bash
set -euo pipefail

# Proves a backup and restore bring back exactly what was there: one row in the database and one
# uploaded file, with everything changed after the backup gone again. It runs once with the files in
# Garage and once with STORAGE_DRIVER=local. The Garage run then backs up and restores once more with the files at
# another S3 provider, which the backup leaves out.
# It runs its own throwaway stack (project nerla-backup-test), never the nerla one.
#
#   bash scripts/test-backup.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"
# shellcheck source=setup-lib.sh
. "$REPO/setup-lib.sh"

if [ -z "${NERLA_TEST_DRIVER:-}" ]; then
    for driver in s3 local; do
        echo "== STORAGE_DRIVER=$driver =="
        NERLA_TEST_DRIVER="$driver" bash "$SCRIPT_DIR/test-backup.sh"
    done
    exit 0
fi
DRIVER="$NERLA_TEST_DRIVER"
# With the local disk, Garage stays stopped, and a stand-in server holds the files volume
SERVICES=()
if [ "$DRIVER" = local ]; then
    export COMPOSE_PROFILES=local
    SERVICES=(postgres server)
fi

export COMPOSE_PROJECT_NAME=nerla-backup-test
export COMPOSE_FILE=scripts/test-backup.compose.yml
COMPOSE=(docker compose)

# Docker on Windows needs C:/ paths, which Git Bash gives with pwd -W
host_path() {
    (cd "$1" && { pwd -W 2>/dev/null || pwd; })
}

fail() {
    echo "FAILED: $*" >&2
    exit 1
}
trap 'echo "FAILED: the command on line $LINENO of scripts/test-backup.sh did not work." >&2' ERR

WORK="$(mktemp -d)"
cleanup() {
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

export NERLA_DIR="$WORK/install"
export BACKUP_DIR="$WORK/backups"
mkdir -p "$NERLA_DIR"
export DB_USER=nerla DB_NAME=nerla
DB_PASSWORD="$(gen_secret 16)"
export DB_PASSWORD
cat >"$NERLA_DIR/.env" <<EOF
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
EOF
# As setup.sh writes them, unquoted. The scripts must read .env as text, never run it as shell code
cat >>"$NERLA_DIR/.env" <<'EOF'
EMAIL_FROM=Nerla <a@b.test>
EMAIL_PASS=p$a;ss&w(rd) "x" 'y'
EOF
[ "$DRIVER" = local ] && echo "STORAGE_DRIVER=local   # own disk" >>"$NERLA_DIR/.env"
sed -e "s|RPC_SECRET_PLACEHOLDER|$(gen_secret 32)|" -e "s|ADMIN_TOKEN_PLACEHOLDER|$(gen_secret 32)|" \
    garage.toml.template >"$NERLA_DIR/garage.toml"
export NERLA_TEST_GARAGE_TOML
NERLA_TEST_GARAGE_TOML="$(host_path "$NERLA_DIR")/garage.toml"

echo "Starting a throwaway stack..."
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait "${SERVICES[@]}" >/dev/null 2>&1 || {
    "${COMPOSE[@]}" logs --tail 30
    fail "The test stack did not start."
}
PG="$("${COMPOSE[@]}" ps -q postgres)"
[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PG")" = nerla-backup-test ] ||
    fail "The database container is not in the nerla-backup-test project, so the test stops before touching it."

garage_endpoint() {
    [ "$DRIVER" = s3 ] || return 0
    S3_ENDPOINT="http://$("${COMPOSE[@]}" port garage 3900)"
}

if [ "$DRIVER" = s3 ]; then
    GARAGE="$("${COMPOSE[@]}" ps -q garage)"
    echo "Setting up storage..."
    garage() {
        docker exec "$GARAGE" /garage "$@" 2>/dev/null
    }
    node_id="$(garage status | grep -oE '[0-9a-f]{16}' | head -1)"
    garage layout assign "$node_id" -z dc1 -c 1G >/dev/null
    garage layout apply --version 1 >/dev/null
    key_output="$(garage key create nerla-backup-test)"
    export S3_KEY S3_SECRET S3_BUCKET=nerla-backup-test S3_ENDPOINT
    S3_KEY="$(echo "$key_output" | grep -i "Key ID" | awk -F': ' '{print $2}' | tr -d ' ')"
    S3_SECRET="$(echo "$key_output" | grep -i "Secret key" | awk -F': ' '{print $2}' | tr -d ' ')"
    [ -n "$S3_KEY" ] && [ -n "$S3_SECRET" ] || fail "Could not read the Garage key."
    garage bucket create "$S3_BUCKET" >/dev/null
    garage bucket allow --read --write --owner "$S3_BUCKET" --key "$S3_KEY" >/dev/null
    garage_endpoint
fi

S3_JS='
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3")
const [mode, Key, seed] = process.argv.slice(1)
// Large enough that Garage keeps it in its data folder, not inline in its metadata
const content = seed.repeat(4000)
const Bucket = process.env.S3_BUCKET
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: "garage",
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_KEY, secretAccessKey: process.env.S3_SECRET },
})
const run = {
  put: () => s3.send(new PutObjectCommand({ Bucket, Key, Body: content })),
  delete: () => s3.send(new DeleteObjectCommand({ Bucket, Key })),
  check: async () => {
    const text = await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToString()
    if (text !== content) throw new Error("the file came back with different contents")
  },
}
// A body stream that just stops leaves the promise unsettled, and node would then end with 0
process.exitCode = 1
run[mode]().then(
  () => (process.exitCode = 0),
  (error) => console.error(`${error.name}: ${error.message}`),
)
'
s3() {
    (cd "$REPO/server" && node -e "$S3_JS" "$@")
}

# put, delete or check one file, in Garage or in the files volume as the server's user
files() {
    [ "$DRIVER" = s3 ] && {
        s3 "$@"
        return
    }
    local server
    server="$("${COMPOSE[@]}" ps -q server)"
    case "$1" in
        put) docker exec -u 1001 "$server" sh -c 'printf %s "$1" >"/data/files/$2"' sh "$3" "$2" ;;
        delete) docker exec "$server" rm -f "/data/files/$2" ;;
        check) [ "$(docker exec "$server" cat "/data/files/$2" 2>/dev/null)" = "$3" ] ;;
    esac
}

sql() {
    docker exec "$PG" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -tA -c "$1"
}

echo "Migrating the test database..."
# The yarn shim on Windows needs Git Bash to convert its own path
env -u MSYS_NO_PATHCONV yarn workspace server build >/dev/null
(
    cd "$WORK"
    DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$("${COMPOSE[@]}" port postgres 5432)/$DB_NAME" DB_SSL=false \
        node "$(host_path "$REPO")/server/dist/db/migrate.js"
)

echo "Writing one row and one file..."
sql "insert into users (email, first_name) values ('backup-check@example.com', 'Before')" >/dev/null
SEED="backup check $(gen_secret 8) "
files put check.txt "$SEED"
# The stand-in web proxy runs with Garage, and its certificates go in the backup too
certificate() {
    local web
    web="$("${COMPOSE[@]}" ps -q web)"
    if [ -n "${1:-}" ]; then
        docker exec "$web" sh -c 'mkdir -p /data/caddy && printf %s "$1" >/data/caddy/site.crt' sh "$1"
    else
        docker exec "$web" cat /data/caddy/site.crt
    fi
}
[ "$DRIVER" = s3 ] && certificate "certificate before"

echo "Backing up..."
bash scripts/backup.sh
BACKUP="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$BACKUP" ] && [ ! -f "$BACKUP/INCOMPLETE" ] || fail "The backup did not finish."
grep -qx "storage: $DRIVER" "$BACKUP/MANIFEST" || fail "The backup's MANIFEST does not say storage: $DRIVER."
# A backup that had to stop Garage leaves it on a new random port
"${COMPOSE[@]}" up -d --wait "${SERVICES[@]}" >/dev/null 2>&1 || fail "The test stack did not come back after the backup."
garage_endpoint

echo "Changing everything after the backup..."
sql "update users set first_name = 'After' where email = 'backup-check@example.com'" >/dev/null
sql "insert into users (email) values ('after-backup@example.com')" >/dev/null
files delete check.txt "$SEED"
files check check.txt "$SEED" 2>/dev/null && fail "The file was not deleted, so the restore would prove nothing."
files put after.txt "$SEED"
[ "$DRIVER" = s3 ] && certificate "certificate after"
echo "AFTER_BACKUP=1" >>"$NERLA_DIR/.env"

echo "Checking that a damaged backup is refused with nothing touched..."
DAMAGED="$WORK/damaged"
cp -R "$BACKUP" "$DAMAGED"
FILES_ARCHIVE=garage-data.tar.gz
[ "$DRIVER" = local ] && FILES_ARCHIVE=files.tar.gz
half=$(($(wc -c <"$BACKUP/$FILES_ARCHIVE") / 2))
head -c "$half" "$BACKUP/$FILES_ARCHIVE" >"$DAMAGED/$FILES_ARCHIVE"
cp "$NERLA_DIR/.env" "$WORK/env-before-damaged"
if refused="$(printf 'restore\n\n' | bash scripts/restore.sh "$DAMAGED" 2>&1)"; then
    fail "A damaged backup was restored."
fi
grep -qF "$FILES_ARCHIVE in this backup is damaged or unreadable, so nothing was changed." <<<"$refused" ||
    fail "The refusal of a damaged backup did not say why: $refused"
rows="$(sql "select email || '|' || coalesce(first_name, '') from users order by email")"
[ "$rows" = "$(printf 'after-backup@example.com|\nbackup-check@example.com|After')" ] ||
    fail "Refusing a damaged backup changed the database. Found: $rows"
files check after.txt "$SEED" || fail "Refusing a damaged backup changed the files."
cmp -s "$WORK/env-before-damaged" "$NERLA_DIR/.env" || fail "Refusing a damaged backup changed .env."

echo "Checking that the copy an unfinished restore kept aside is never deleted..."
sql "create database ${DB_NAME}_before_restore" >/dev/null
if refused="$(printf 'restore\n\n' | bash scripts/restore.sh "$BACKUP" 2>&1)"; then
    fail "A restore ran while an earlier one had kept the previous data aside."
fi
grep -qF "An earlier restore did not finish, and it kept the install's previous data aside." <<<"$refused" ||
    fail "The refusal did not say why: $refused"
grep -qF "${DB_NAME}_before_restore" <<<"$refused" || fail "The refusal did not name the database kept aside: $refused"
[ "$(sql "select count(*) from pg_database where datname = '${DB_NAME}_before_restore'")" = 1 ] ||
    fail "The database kept aside was deleted."
rows="$(sql "select email || '|' || coalesce(first_name, '') from users order by email")"
[ "$rows" = "$(printf 'after-backup@example.com|\nbackup-check@example.com|After')" ] ||
    fail "Refusing because of a kept copy changed the database. Found: $rows"
files check after.txt "$SEED" || fail "Refusing because of a kept copy changed the files."
sql "drop database ${DB_NAME}_before_restore with (force)" >/dev/null

echo "Checking that a backup from a newer Nerla is refused..."
FUTURE="$WORK/future"
cp -R "$BACKUP" "$FUTURE"
sed -i.bak 's/^last_migration: .*/last_migration: 9999_from_the_future/' "$FUTURE/MANIFEST"
if refused="$(bash scripts/restore.sh "$FUTURE" </dev/null 2>&1)"; then
    fail "A backup from a newer Nerla was restored."
fi
grep -qF "This backup is from a newer Nerla. Update first, then restore." <<<"$refused" ||
    fail "The refusal did not say why: $refused"

echo "Restoring, keeping the default answer for the settings..."
printf 'restore\n\n' | bash scripts/restore.sh "$BACKUP"
"${COMPOSE[@]}" up -d --wait >/dev/null 2>&1 || fail "The test stack did not come back after the restore."
PG="$("${COMPOSE[@]}" ps -q postgres)"
garage_endpoint

echo "Checking the result..."
rows="$(sql "select email || '|' || coalesce(first_name, '') from users order by email")"
[ "$rows" = "backup-check@example.com|Before" ] || fail "Expected exactly the first row, unchanged. Found: $rows"
files check check.txt "$SEED" || fail "The file is not back as it was after the restore."
files check after.txt "$SEED" 2>/dev/null && fail "A file uploaded after the backup is still there after the restore."
spare="$(sql "select string_agg(datname, ', ') from pg_database where datname in ('${DB_NAME}_restoring', '${DB_NAME}_before_restore')")"
[ -z "$spare" ] || fail "The restore left a spare database behind: $spare"
if [ "$DRIVER" = local ]; then
    STORE=server STORE_ROOT=/data
    owner="$(docker exec "$("${COMPOSE[@]}" ps -q server)" stat -c %u /data/files/check.txt)"
    [ "$owner" = 1001 ] || fail "The restored file belongs to user $owner, not the server's user 1001."
else
    STORE=garage STORE_ROOT=/var/lib/garage
fi
staging="$(docker run --rm --volumes-from "$("${COMPOSE[@]}" ps -q "$STORE")" --entrypoint sh "$(docker inspect -f '{{.Image}}' "$PG")" \
    -c "ls -d $STORE_ROOT/*/.nerla-* 2>/dev/null || true")"
[ -z "$staging" ] || fail "The restore left staging folders in the $STORE volumes: $staging"
cmp -s "$BACKUP/.env" "$NERLA_DIR/.env" || fail "The backup's .env was not put back, though that is the default answer."
if [ "$DRIVER" = s3 ]; then
    [ "$(certificate)" = "certificate before" ] || fail "The HTTPS certificates are not back as they were after the restore."
fi
[ -f "$NERLA_DIR/.env.before-restore" ] || fail "The .env in use before the restore was not kept aside."

if [ "$DRIVER" = s3 ]; then
    echo "Checking a backup and restore with the files at another S3 provider..."
    echo "S3_ENDPOINT=https://s3.example.test" >>"$NERLA_DIR/.env"
    out="$(bash scripts/backup.sh)"
    grep -qF "Your files are in https://s3.example.test, so this backup holds the database and settings but not the files." <<<"$out" ||
        fail "The backup did not say the files stay with the provider: $out"
    EXTERNAL="$(sed -n 's/^Backup complete: //p' <<<"$out")"
    grep -qx "storage: s3-external" "$EXTERNAL/MANIFEST" || fail "The backup's MANIFEST does not say storage: s3-external."
    [ -z "$(find "$EXTERNAL" -name 'garage-*')" ] || fail "The backup archived Garage, though the files are with another provider."
    sql "update users set first_name = 'After' where email = 'backup-check@example.com'" >/dev/null
    out="$(printf 'restore\n\n' | bash scripts/restore.sh "$EXTERNAL")"
    grep -qF "Your files are in your own S3 store and stay where they are." <<<"$out" || fail "The restore did not say the files stay: $out"
    "${COMPOSE[@]}" up -d --wait >/dev/null 2>&1 || fail "The test stack did not come back after the restore."
    PG="$("${COMPOSE[@]}" ps -q postgres)"
    garage_endpoint
    rows="$(sql "select email || '|' || coalesce(first_name, '') from users order by email")"
    [ "$rows" = "backup-check@example.com|Before" ] || fail "The database did not come back from a backup without the files. Found: $rows"
    files check check.txt "$SEED" || fail "A restore without the files changed the files in Garage."
fi

echo ""
echo "Backup and restore check passed (STORAGE_DRIVER=$DRIVER)"
