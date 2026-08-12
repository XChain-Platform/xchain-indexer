#!/usr/bin/env bash
#********************************************************************
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
#********************************************************************
#
# Run the DB-backed test tiers against a throwaway MariaDB.
#
# WHY THIS EXISTS, and it is not convenience. Reconstructing this environment from
# memory produces FALSE RESULTS, not merely inconvenience, and it did: a run assembled
# by hand reported two product defects that were nothing but a missing module in the
# venue, because `xchain-vm` is a `file:./xchain-vm` dependency whose vendored
# directory is UNTRACKED. `git archive HEAD` therefore yields a tree where
# require('xchain-vm') fails, and every DEPLOY/EXECUTE suite then fails for a reason
# that has nothing to do with the code under test. The diagnosis had already been
# written down before the discrepancy surfaced.
#
# So the preflight below is the point of this script, more than the database is:
#
#   * require('xchain-vm') must actually load, or the run REFUSES to start. A silent
#     VM-less run reports "deploy VM executor unavailable" and looks like a defect.
#   * XCHAIN_SDK_PATH and XCHAIN_DECODER_SQL_PATH must resolve. Several suites are
#     cross-repo consensus drift guards that deliberately HARD-FAIL rather than skip,
#     so a missing sibling reads as a red tier.
#   * INDEXER_COIN / INDEXER_NETWORK are pinned, because a coin-less lookup makes the
#     per-chain activation gates resolve to "off" and quietly changes what is tested.
#
# USAGE
#   bin/run-db-tiers.sh                       # integration tier (default)
#   bin/run-db-tiers.sh unit integration      # both, in order
#   bin/run-db-tiers.sh --keep integration    # leave the database up afterwards
#   bin/run-db-tiers.sh -- test/integration/scenarios/14-multi-chain-parity.test.js
#                                             # one file, straight to mocha
#
# ENVIRONMENT (all optional; each falls back to the sibling monorepo layout)
#   DB_PORT                  host port for the throwaway MariaDB (default 23320)
#   INDEXER_COIN             default BTC
#   INDEXER_NETWORK          default regtest
#   XCHAIN_SDK_PATH          xchain-sdk checkout
#   XCHAIN_DECODER_SQL_PATH  xchain-decoder/src/sql
#
#********************************************************************

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONTAINER="xchain-indexer-dbtier"
DB_PORT="${DB_PORT:-23320}"
DB_PASS="test"                 # fixture value: throwaway container, dropped on exit
IMAGE="mariadb:11.4"
KEEP=0
TIERS=()
MOCHA_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) KEEP=1; shift ;;
        --) shift; MOCHA_ARGS=("$@"); break ;;
        -h|--help) sed -n '/^# USAGE/,/^#\*\{10,\}$/p' "${BASH_SOURCE[0]}"; exit 0 ;;
        unit|integration|e2e) TIERS+=("$1"); shift ;;
        *) echo "run-db-tiers: unknown argument '$1' (want unit|integration|e2e, --keep, --, -h)" >&2
           exit 64 ;;
    esac
done
if [[ ${#TIERS[@]} -eq 0 && ${#MOCHA_ARGS[@]} -eq 0 ]]; then TIERS=(integration); fi

command -v docker >/dev/null 2>&1 || {
    echo "run-db-tiers: docker is required (it hosts the throwaway MariaDB)." >&2; exit 69; }

# ---- Preflight. Every check below fails the run rather than degrading it, because a
# ---- degraded run of this tier does not look degraded: it looks like broken code.

# The vendored VM. Checked by LOADING it, not by testing for the directory: the
# node_modules entry is a symlink to ./xchain-vm, so the path can exist while the
# require fails, which is exactly how false findings like this happened before.
if ! node -e "require('xchain-vm')" >/dev/null 2>&1; then
    cat >&2 <<'VMERR'
run-db-tiers: require('xchain-vm') FAILS, so this run would report false failures.

  xchain-vm is a "file:./xchain-vm" dependency and the vendored directory is NOT
  tracked in git, so a tree built with `git archive HEAD` (or any copy that skips
  untracked files) lacks it. Every DEPLOY/EXECUTE suite then fails with
  "deploy VM executor unavailable", which reads as a product defect and is not one.

  Fix: restore the vendored copy (npm run vendor:vm, or copy xchain-vm/ from a
  working checkout) and re-run.
VMERR
    exit 78
fi

SDK_PATH="${XCHAIN_SDK_PATH:-$REPO_ROOT/../xchain-sdk}"
DECODER_SQL="${XCHAIN_DECODER_SQL_PATH:-$REPO_ROOT/../xchain-decoder/src/sql}"
[[ -d "$SDK_PATH" ]] || {
    echo "run-db-tiers: no xchain-sdk at $SDK_PATH. The SDK parity suite is a consensus" >&2
    echo "              drift guard that refuses to skip, so the tier would report red." >&2
    exit 78; }
[[ -d "$DECODER_SQL" ]] || {
    echo "run-db-tiers: no decoder schema at $DECODER_SQL. Suites that build a decoder DB" >&2
    echo "              hard-fail in their root hook without it." >&2
    exit 78; }

teardown(){
    local status=$?
    if [[ $KEEP -eq 1 ]]; then
        echo "run-db-tiers: leaving $CONTAINER up on port $DB_PORT (--keep)."
    else
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    fi
    exit $status
}
trap teardown EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "run-db-tiers: starting $IMAGE as $CONTAINER on 127.0.0.1:$DB_PORT (tmpfs)"
docker run -d --name "$CONTAINER" \
    -e MARIADB_ROOT_PASSWORD="$DB_PASS" \
    -p "127.0.0.1:$DB_PORT:3306" \
    --tmpfs /var/lib/mysql \
    "$IMAGE" >/dev/null

# Poll the image's own healthcheck rather than sleeping a fixed amount: a cold pull
# makes any fixed wait either flaky or slow.
echo -n "run-db-tiers: waiting for the database"
for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
        echo " ready"; break
    fi
    echo -n "."; sleep 2
done
docker exec "$CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 || {
    echo; echo "run-db-tiers: the database never came up; last container logs:" >&2
    docker logs --tail 20 "$CONTAINER" >&2; exit 75; }

export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT="$DB_PORT"
export TEST_DB_USER=root
export TEST_DB_PASS="$DB_PASS"
export XCHAIN_SDK_PATH="$SDK_PATH"
export XCHAIN_DECODER_SQL_PATH="$DECODER_SQL"
export INDEXER_COIN="${INDEXER_COIN:-BTC}"
export INDEXER_NETWORK="${INDEXER_NETWORK:-regtest}"

echo "run-db-tiers: coin=$INDEXER_COIN network=$INDEXER_NETWORK vm=ok sdk=$SDK_PATH"

rc=0
if [[ ${#MOCHA_ARGS[@]} -gt 0 ]]; then
    echo "run-db-tiers: mocha ${MOCHA_ARGS[*]}"
    npx mocha --no-config --timeout 300000 --exit "${MOCHA_ARGS[@]}" || rc=$?
else
    for tier in "${TIERS[@]}"; do
        echo "run-db-tiers: === $tier tier ==="
        case "$tier" in
            unit)        npm run ci || rc=$? ;;
            integration) npm run test:integration:ci || rc=$? ;;
            e2e)         npm run test:e2e || rc=$? ;;
        esac
        # Keep going through a failing tier so one red tier cannot hide the next, and
        # report the first failure's status at the end.
        [[ $rc -ne 0 ]] && echo "run-db-tiers: $tier tier FAILED (rc=$rc), continuing" >&2
    done
fi

echo "run-db-tiers: done (rc=$rc)"
exit $rc
