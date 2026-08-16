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
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as five parallel jobs (ci,
# integration, perf-regression, drift-guards, coverage). The pre-push venue
# gate used to run only `npm run ci`, so a push could gate green locally and
# then go red on GitHub on a job the gate never ran (2026-08-15: exactly that,
# on three repos at once). This script IS the local twin of the workflow: every
# job's run-steps, transcribed, in job order. When ci.yml gains or changes a
# job, change this script in the same commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
#
# Database: TEST_DB_* env if already set; else the venue's CI_DB_* (exported by
# ci-gate.sh from venue.env); else localhost root with the GitHub service-
# container fixture password, so a hand-run beside a stock `mariadb:11.4 -e
# MARIADB_ROOT_PASSWORD=xchain-fixture-throwaway` container behaves like CI.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
run_tier() {
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

export TEST_DB_HOST="${TEST_DB_HOST:-${CI_DB_HOST:-127.0.0.1}}"
export TEST_DB_PORT="${TEST_DB_PORT:-${CI_DB_PORT:-3306}}"
export TEST_DB_USER="${TEST_DB_USER:-${CI_DB_USER:-root}}"
export TEST_DB_PASS="${TEST_DB_PASS:-${CI_DB_PASS:-xchain-fixture-throwaway}}"
export XCHAIN_DECODER_SQL_PATH="${XCHAIN_DECODER_SQL_PATH:-$SIB/xchain-decoder/src/sql}"
export XCHAIN_SDK_PATH="${XCHAIN_SDK_PATH:-$SIB/xchain-sdk}"

need_sib xchain-vm xchain-decoder xchain-sdk xchain-hub

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
run_tier "ci" npm run ci

# --- job: integration ------------------------------------------------------
# The workflow stages the gitignored vendored VM from the canonical sibling
# BEFORE the tier (a missing vendored copy fails at require time as `deploy VM
# executor unavailable`, not at install time).
run_tier "vendor:vm (stage from ../xchain-vm)" npm run vendor:vm
run_tier "integration (test:integration:ci)" npm run test:integration:ci

# --- job: perf-regression --------------------------------------------------
# Ratio-gated within a single run, so the verdicts hold on any host. The
# regime sizes and the relaxed fast-chain budget mirror the workflow's env.
run_tier "perf: grown-database (test:perf:grown)" npm run test:perf:grown
run_tier "perf: load regimes (test:perf:regimes)" \
  env PERF_FASTCHAIN_BLOCKS=200 PERF_FASTCHAIN_BUDGET_MS=250 \
      PERF_FEESPIKE_TXS=2000 PERF_FEESPIKE_TX_PER_BLOCK=250 PERF_FEESPIKE_SENDERS=200 \
  npm run test:perf:regimes

# --- job: drift-guards -----------------------------------------------------
# Run FROM the parent so sync-coins.sh sees the canonical + vendored pair the
# way the workflow lays them out (hub checkout beside this repo's checkout).
sync_coins_check() { (cd "$SIB" && "xchain-hub/bin/sync-coins.sh" --check --only "$(basename "$SELF")"); }
run_tier "drift: coin-registry byte-identity" sync_coins_check
run_tier "drift: coin consensus-pin conformance" node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'
run_tier "drift: pre-flight <-> handler gate" \
  env XCHAIN_INDEXER_PATH="$SELF" node "$SIB/xchain-sdk/bin/check-preflight-drift.js"

# --- job: coverage ---------------------------------------------------------
run_tier "coverage ratchet (coverage:check)" npm run coverage:check

echo
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
echo "ci:full: all tiers green (same set GitHub CI runs)"
