<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Indexer

<p align="center">
  <img src="https://img.shields.io/badge/version-0.11.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-5200%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20boundary%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20regression%20%7C%20performance%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

State-processing engine for the XChain Platform. Reads decoded blockchain transactions from a Decoder database, validates and executes each ACTION according to protocol rules, and maintains authoritative token state (balances, supplies, ownership, DEX orders, dispensers, smart contracts) in a separate MariaDB database.

## Features

- **ACTION types**: ADDRESS, AIRDROP, ANCHOR, ATTEST, BATCH, BROADCAST, CALLBACK, COINPAY, COLLECT, CROSS_SETTLE, DELEGATE, DEPLOY, DEPOSIT, DESTROY, DISPENSER, DISPENSE, DIVIDEND, EXECUTE, FILE, ISSUE, LINK, LIST, MESSAGE, MINT, NODEPROOF, ORDER, PRICE, SEND, SLASH, SLEEP, STAKE, SWAP, SWEEP, UNKNOWN, UNSTAKE, VOTE, WITHDRAW, XCALL, XEXEC (47 handlers)
- **Virtual Machine**: deterministic JavaScript smart contracts via [xchain-vm](https://github.com/XChain-Platform/xchain-vm) (sandboxed V8 isolates, AST-based gas metering, attestation gateway namespace, cross-contract re-entrant calls via `emit.execute` with call-depth cap and gas budgeting)
- **Cross-chain VM calls**: contracts invoke `emit.crossExecute` to emit XCALL requests; the hub federation relays quorum-signed results; XEXEC is system-injected on the target chain; callbacks are delivered back to the source contract
- **Capability-based staking**: STAKE (VERSION 1 new / VERSION 2 top-up) and UNSTAKE (pubkey-based). A validator's aggregate active stake auto-qualifies it for each of five independent capabilities (`price`, `cross_chain`, `oracle_publish`, `attestation`, `full_node`) per governance-configurable `min_stake[capability]`. Stake rows carry `version`, `activation_block`, `deactivation_block`.
- **Contract-targeted staking**: STAKE v3 / UNSTAKE v1 / DELEGATE v1 let any token be staked against a smart contract deployed via DEPLOY v1 (which carries `COOLDOWN_BLOCKS` + `SLASH_DESTINATION` metadata). Cooldown is per-contract; the contract's own VM logic governs slashing via SLASH.
- **External attestation framework**: contracts emit ATTEST v0 via `xchain.attestation.request`; hub federation reaches PBFT quorum; ATTEST v1 is submitted on-chain; indexer fires the request's callback EXECUTE on quorum or system-injects ATTEST v2 on deadline.
- **PRICE oracles**: PRICE v0 (validator COIN/FIAT snapshots, gated by the `price` and `oracle_publish` capabilities) and PRICE v1 (permissionless user TOKEN/FIAT oracles). Both feed the hub's `oracle_prices` / `price_snapshots` tables that every indexer reads during block processing.
- **Token-gated content**: FILE action supports AES-256-GCM gated payloads with a compact 33-byte binary key handoff; new `gated_files` table.
- **COINPay**: native coin DEX pairs with two-phase settlement (ORDER_MATCH -> COINPAY)
- **Unified gas fee schedule**: all protocol fees expressed in gas units, converted via GAS_PRICE to XCHAIN
- **Multi-chain support**: Bitcoin, Litecoin, and Dogecoin today on mainnet, testnet, and regtest
- **Atomic block processing**: every block wrapped in a DB transaction; failures roll back cleanly
- **Block reorg handling**: detects reorganizations from the Decoder DB, rolls back and re-indexes
- **Double-entry ledger**: all token movements recorded as credits, debits, and escrows (including contract derived addresses)
- **Per-block sanity check**: verifies token supplies match the sum of credits minus debits
- **Three block hashes**: ledger, actions, and contract hashes per block for state verification
- **DEX engine**: ORDER matching, SWAP matching, DISPENSER triggering with automatic expiration; cross-chain DEX settlement via CROSS_SETTLE
- **Protocol versioning**: actions activate at specific block heights or timestamps per network
- **Action mapping**: address/ticker/action_index cross-references for fast lookups
- **Circuit-breaker DB connections**: automatic failure detection and recovery
- **Watchdog timeout**: configurable per-block processing timeout detects deadlocks
- **Hub-facing RPCs**: `getownstake`, `getactivevalidators`, `getactivestakeweights`, `getcapabilityvalidators`, `getstakeweightsbycapability`, `getfullnodeverifiers`, `getpendingattestation_requests`, `getrelayedattestation_requests`, `getopencrosschainorders`, `getpendingcrosschaincalls`, `getcrosschaincall`, `getcrosschaincallresult`, `getactionconfirmations`, `getstakesourcebypubkey`, `getlatestblock`, `getblockhashes`. `pushvalidatorrewards` is retired: it refuses every reward type, because every validator reward is derived from on-chain bytes
- **Comprehensive test suite**: unit, integration, e2e, boundary, security, fuzz, chaos, mutation, regression, performance, smoke

## Documentation

Full indexer documentation is available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/indexer) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/README.md) | Overview, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/architecture.md) | Data pipeline, internal components, action handlers, block processing pipeline |
| [Configuration](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/configuration.md) | Environment variables, coin-specific config, indexer constants |
| [Actions](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/actions.md) | All ACTION types, categories, format versions, protocol versioning |
| [Database](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/database.md) | Full schema reference: core, ledger, action, state, index, and mapping tables |
| [Ledger](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/ledger.md) | Double-entry ledger, balance calculation, sanity checks, gas token fees |
| [Operations](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/operations.md) | Running, Docker, API endpoints, resilience, troubleshooting |

### Operational env vars (non-consensus)

Observability / tuning knobs read from the environment. None affects ledger output.

| Variable | Units | Default | Meaning |
|---|---|---|---|
| `HUB_CONFIG_POLL_INTERVAL_MS` | ms | `60000` | Hub to indexer config-overlay poll cadence. This is the sole staleness / propagation bound for the live-polled governance overlay: nothing else refreshes it. |

Derived staleness boundary: an overlay that has not refreshed within `HUB_CONFIG_POLL_INTERVAL_MS * 3` is reported as `hubConfigStale: true` on both the `/health` API and the internal health response (three poll intervals tolerate a couple of missed or slow polls before flagging). The boundary lives in code as `hubConfigStalenessLimitMs()` (`src/XChainIndexer.js`), which reads the poll interval at call time so a value supplied through `.env` is honoured; it is not separately configurable.

## Quick Start

```bash
git clone https://github.com/XChain-Platform/xchain-indexer.git
cd xchain-indexer
npm install
```

Create a `.env` file:

```env
DECODER_DB_HOST=127.0.0.1
DECODER_DB_PORT=3306
DECODER_DB_NAME=XChain_BTC_Mainnet_Decoder
DECODER_DB_USER=xchain_reader
DECODER_DB_PASS=your_password

INDEXER_DB_HOST=127.0.0.1
INDEXER_DB_PORT=3306
INDEXER_DB_NAME=XChain_BTC_Mainnet_Indexer
INDEXER_DB_USER=xchain_writer
INDEXER_DB_PASS=your_password

INDEXER_API_PORT=3000
INDEXER_COIN=BTC
INDEXER_NETWORK=mainnet
```

Start the indexer:

```bash
npm run api
```

## Database migrations

The repo has two migration directories, and they are not interchangeable.
`src/sql/migrations/` is the runner-tracked home: it is the only directory
`Database.runMigrations()` scans, checksums, and records in the
`schema_migrations` ledger, and it is where every new migration belongs. The
top-level `migrations/` directory holds legacy, manual, one-off runbook SQL
that is never auto-applied; see [`migrations/README.md`](migrations/README.md)
for how (and whether) to run something from it by hand.

## Metrics and log shipping (optional, off by default)

A Prometheus `/metrics` endpoint and a structured log shim ship with this
service and stay inert unless switched on: with no env set, no route is
registered, no timer starts and no socket opens. Turn the endpoint on with
`METRICS_ENABLED=1` (add `METRICS_TOKEN` to gate the scrape on a reachable
box), and ship logs with `LOG_SHIP_ENABLED=1` plus `LOG_SHIP_URL`. Full
variable list and the exported metric names are in
[`src/observability/README.md`](src/observability/README.md).

The module is vendored byte-identically from xchain-hub. Edit it there
and re-run `xchain-hub/bin/sync-observability.sh`; a local edit fails the
parity check CI runs across the vendored copies.

### Shim controls, and the defaults in force

These four names configure the shim itself. The fleet deploy path carries them
into the container: `xchain-node` forwards any of them set in the module config
store or in the deploy host's environment (`ModuleService.resolveObservabilityEnv`),
and the validator compose files under `claude/deploy/testnet-validators/` name
them outright. Nothing is fabricated when neither source sets one, so these
defaults hold on an unconfigured box:

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Lowest level emitted. `debug` \| `info` \| `warn` \| `error`; an unrecognised value falls back to `info`. |
| `LOG_FORMAT` | `text` | `text` emits `<iso-ts> <level> [<service>] <msg> key=value`; `json` emits one NDJSON record per line. |
| `METRICS_ENABLED` | `false` | Registers the `/metrics` route. The counter registry is built either way, so counters are collected whether or not the route is exposed. |
| `XCHAIN_LOG_PATCH` | `1` | Routes bare `console.*` calls through the shim so they carry the level and service prefix. `0` leaves `console` untouched, which is what the test bootstrap sets. |

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the indexer and API server |
| `bin/run-db-tiers.sh` | Run the DB-backed tiers against a throwaway MariaDB it starts and drops |
| `npm test` | Run unit tests (~4,600 tests) |
| `npm run test:integration` | Integration tests (~215 tests, requires MariaDB) |
| `npm run test:e2e` | End-to-end tests (43 tests, requires full stack) |
| `npm run test:boundary` | Boundary condition tests |
| `npm run test:smoke` | Smoke tests (unit + connected) |
| `npm run test:security` | Security tests |
| `npm run test:fuzz` | Fuzz tests (property-based) |
| `npm run test:fuzz:quick` | Quick fuzz (1,000 iterations, tier1) |
| `npm run test:fuzz:full` | Full fuzz (10,000 iterations) |
| `npm run test:chaos` | Chaos engineering tests |
| `npm run test:mutation` | Mutation tests |
| `npm run test:mutation:tier1` | Tier1 mutation tests |
| `npm run test:mutation:report` | Mutation tests with coverage report |
| `npm run test:perf` | All performance tests |
| `npm run test:perf:regimes` | Load-regime scenarios: fast chain (DOGE) and fee spike |
| `npm run test:regression` | Regression tests (tagged across all suites) |
| `npm run test:regression:fast` | Fast regression (tier1 + tier4, unit only) |
| `npm run test:regression:full` | Full regression suite |
| `npm run test:nodb` | All tests that don't require a database |
| `npm run test:full` | Complete test suite |

### Running the DB-backed tiers

`bin/run-db-tiers.sh` starts a throwaway tmpfs-backed MariaDB, wires the environment
the tiers expect, runs them and drops the container again.

```bash
bin/run-db-tiers.sh                    # integration tier
bin/run-db-tiers.sh unit integration
bin/run-db-tiers.sh -- test/integration/scenarios/14-multi-chain-parity.test.js
```

**Its preflight matters more than the database does.** Reassembling this environment
by hand produces false results rather than inconvenience:

- `xchain-vm` is a `file:./xchain-vm` dependency and the vendored directory is **not
  tracked in git**, so any tree built without untracked files (`git archive HEAD`, for
  instance) lacks it. Every DEPLOY/EXECUTE suite then fails with "deploy VM executor
  unavailable", which reads exactly like a product defect. The script refuses to run
  unless `require('xchain-vm')` actually loads.
- the SDK-parity and decoder-schema suites are cross-repo consensus drift guards that
  deliberately hard-fail rather than skip, so a missing sibling reads as a red tier.
  Both paths are checked before anything starts.
- `INDEXER_COIN` / `INDEXER_NETWORK` are pinned, because a coin-less lookup makes the
  per-chain activation gates resolve to "off" and quietly changes what is tested.

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit - Core | ~2,900 | `actions.test.js`, `utility.test.js`, `db.test.js`, `config.test.js`, `rollback.test.js`, `mapper.test.js`, `protocol_changes.test.js`, plus attestation |
| Unit - Actions | ~1,580 | action handlers: `send.test.js`, `issue.test.js`, `mint.test.js`, `order.test.js`, `dispenser.test.js`, ... |
| Unit - Security | ~50 | SQL safety, parameter injection, negative amounts, balance integrity, startup validation |
| Boundary | ~100 | Supply limits, tick length, fees, expiration, sleep/resume, address validation, DEX price matching |
| Fuzz | ~120 | Property-based testing via fast-check: mathematical properties, format fuzzing |
| Chaos | ~45 | Database failures, circuit breaker, timeout handling, malformed data |
| Mutation | ~125 | Mutation testing harness: arithmetic, validation, boundary mutations |
| Smoke | ~20 | Config loading, utility functions, handler instantiation, API liveness |
| Regression | ~18 | Tagged tests across all suites for fast verification |
| Integration | ~215 | Full scenario tests against MariaDB |
| E2E | 43 | Full-stack tests exercising decoder -> indexer -> explorer pipeline |
| Performance | 9 suites | Baseline throughput, action benchmarks, sustained/spike load, scaling, genesis bootstrap, fast chain, fee spike |
| **Total** | **~5,200+** | |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
