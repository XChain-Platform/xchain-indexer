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
# ci-reusable.yml arms XCHAIN_REQUIRE_SIBLINGS=1 for the ci job's test-gate
# step whenever it checked siblings out (.ci-siblings lists seven here), which
# turns every cross-repo guard's usual "sibling absent, skip" into a hard
# failure; the ci tier below arms the same env so a sibling that is absent or
# moved fails here the same way it fails on GitHub, instead of quietly
# skipping the guards that would have caught it.
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
# >>> ci-tier (generated block; re-run the tier wirer to update) >>>
# Tier classes. A push grades the FAST tier only: the unit job, the pin and
# drift guards, and the structure and hygiene checks the hook runs before it
# dispatches. The tiers named below (coverage re-runs, perf scenarios) are
# skipped when the gate sets CI_TIER=fast, and each skip is recorded so the
# closing verdict can never claim a green it did not earn. Nothing stops
# being graded: a scheduled sweep re-runs this same script with CI_TIER=full
# on every repo every three hours and before any release or deploy, and a
# red there is tracked down and fixed first. CI_TIER is unset for a hand
# run, so a bare `npm run ci:full` still runs every tier as it always did.
CI_TIER_FULL_ONLY=(
  "perf: grown-database (test:perf:grown)"
  "perf: load regimes (test:perf:regimes)"
  "coverage ratchet (coverage:check)"
)
DEFERRED=""
ci_tier_deferred() {
  [ "${CI_TIER:-full}" = "fast" ] || return 1
  local t
  for t in ${CI_TIER_FULL_ONLY[@]+"${CI_TIER_FULL_ONLY[@]}"}; do
    if [ "$t" = "$1" ]; then
      DEFERRED="$DEFERRED [$1]"
      echo; echo "ci:full ===== $1 DEFERRED (CI_TIER=fast, runs in the full sweep) ====="
      return 0
    fi
  done
  return 1
}
# <<< ci-tier <<<
# >>> ci-tier timer (generated block; re-run the tier wirer to update) >>>
run_tier() {
  ci_tier_deferred "$1" && return 0  # ci-tier guard (generated)
  local name="$1"; shift
  local __ci_tier_t0=$SECONDS
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS ($(( SECONDS - __ci_tier_t0 ))s)"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL ($(( SECONDS - __ci_tier_t0 ))s)"
  fi
}
# <<< ci-tier timer <<<
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

# Stage the gitignored vendored VM from the canonical sibling before ANY tier
# runs: the ci tier's own unit suite requires xchain-vm too (actions_class),
# so staging it only ahead of integration left a from-scratch checkout's ci
# tier dying on `Cannot find module 'xchain-vm'` before vendor:vm ever ran.
run_tier "vendor:vm (stage from ../xchain-vm)" npm run vendor:vm

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
run_tier "ci (siblings STRICT)" env XCHAIN_REQUIRE_SIBLINGS=1 npm run ci

# --- job: integration ------------------------------------------------------
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
# >>> ci-tier summary (generated) >>>
echo "ci:full: tier class ${CI_TIER:-full}"
if [ -n "${DEFERRED:-}" ]; then
  echo "ci:full: DEFERRED to the full sweep:$DEFERRED"
fi
# <<< ci-tier summary <<<
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
# >>> ci-tier verdict (generated) >>>
if [ "${CI_TIER:-full}" = "fast" ]; then
  echo "ci:full: all FAST tiers green; the DEFERRED tiers above were NOT graded here"
else
  echo "ci:full: all tiers green (same set GitHub CI runs)"
fi
# <<< ci-tier verdict <<<
