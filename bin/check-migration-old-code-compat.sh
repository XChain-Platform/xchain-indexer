#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# Prove the migrations pending against a DEPLOYED ref are additive and
# old-code-compatible, against a throwaway MariaDB. The assertions live in
# bin/check-migration-old-code-compat.js; this script is the venue.
#
#  §7 gate: "every pre-window migration proven additive and
# old-code-compatible". The gate is per HOST, not per repo, because mainnet
# indexers deliberately do not run master , so each host's pending set
# is whatever it is behind by. Run this once per distinct deployed ref recorded
# in §8 step 1, not once for the fleet.
#
# USAGE
#   bin/check-migration-old-code-compat.sh <deployed-ref>
#
# ENVIRONMENT (optional)
#   DB_PORT   host port for the throwaway MariaDB (default 23321)
#
# The container is tmpfs-backed, bound to 127.0.0.1 only, and dropped on exit.
# Its root password is generated per run into a 0600 env-file, so it never
# reaches an argv, a log line, or this script's output.
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OLD_REF="${1:-}"
if [[ -z "$OLD_REF" ]]; then
    echo "usage: bin/check-migration-old-code-compat.sh <deployed-ref>" >&2
    echo "       the ref is the commit the target host is ACTUALLY running, read from the" >&2
    echo "       running artifact (image digest or commit SHA), never from git ." >&2
    exit 64
fi
git rev-parse --verify "$OLD_REF^{commit}" >/dev/null 2>&1 || {
    echo "check-migration-old-code-compat: '$OLD_REF' is not a commit in this repo." >&2; exit 64; }

command -v docker >/dev/null 2>&1 || {
    echo "check-migration-old-code-compat: docker is required (it hosts the throwaway MariaDB)." >&2
    exit 69; }

CONTAINER=xchain-indexer-migration-compat
DB_PORT="${DB_PORT:-23321}"
DB_NAME=xc_migration_compat
WORK="$(mktemp -d)"
ENVFILE="$WORK/db.env"

teardown(){
    local rc=$?
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK"
    exit $rc
}
trap teardown EXIT

umask 077
{
    echo "MARIADB_ROOT_PASSWORD=$(openssl rand -hex 24)"
    echo "MARIADB_DATABASE=$DB_NAME"
} > "$ENVFILE"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "migration-compat: starting mariadb:11.4 as $CONTAINER on 127.0.0.1:$DB_PORT (tmpfs)"
docker run -d --name "$CONTAINER" \
    --env-file "$ENVFILE" \
    -p "127.0.0.1:$DB_PORT:3306" \
    --tmpfs /var/lib/mysql \
    mariadb:11.4 >/dev/null

echo -n "migration-compat: waiting for the database"
for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
        echo " ready"; break
    fi
    echo -n "."; sleep 2
done
docker exec "$CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 || {
    echo; echo "migration-compat: the database never came up:" >&2
    docker logs --tail 20 "$CONTAINER" >&2; exit 75; }

DB_PASS="$(sed -n 's/^MARIADB_ROOT_PASSWORD=//p' "$ENVFILE")"
export DB_PASS
export DB_HOST=127.0.0.1 DB_PORT DB_USER=root DB_NAME OLD_REF
export REPO="$REPO_ROOT"
export INDEXER_COIN="${INDEXER_COIN:-BTC}"
export INDEXER_NETWORK="${INDEXER_NETWORK:-regtest}"

echo "migration-compat: deployed ref $OLD_REF vs $(git rev-parse --short HEAD) (HEAD)"
node bin/check-migration-old-code-compat.js
