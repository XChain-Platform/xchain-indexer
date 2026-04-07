<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform Indexer

<p align="center">
  <img src="https://img.shields.io/badge/version-2.2.1-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-958%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20boundary%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

State-processing engine for the XChain Platform. Reads decoded blockchain transactions from a Decoder database, validates and executes each ACTION according to protocol rules, and maintains authoritative token state (balances, supplies, ownership, DEX orders, dispensers, smart contracts) in a separate MariaDB database.

## Features

- **29 ACTION types** — ADDRESS, AIRDROP, BATCH, BROADCAST, CALLBACK, COINPAY, DESTROY, DEPLOY, DEPOSIT, DISPENSER, DISPENSE, DIVIDEND, EXECUTE, FILE, ISSUE, LINK, LIST, MESSAGE, MINT, ORDER, SEND, SLEEP, STAKE, SWAP, SWEEP, UNSTAKE, DELEGATE, REVOKE_DELEGATION, CLAIM_REWARDS, WITHDRAW
- **Virtual Machine** — deterministic JavaScript smart contracts via [xchain-vm](https://github.com/XChain-platform/xchain-vm) (sandboxed V8 isolates, AST-based gas metering, 16 emittable action types)
- **Hub staking** — STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION, CLAIM_REWARDS for validator staking on BTC chain
- **COINPay** — native coin DEX pairs with two-phase settlement (ORDER_MATCH → COINPAY)
- **Unified gas fee schedule** — all protocol fees expressed in gas units, converted via GAS_PRICE to XCHAIN
- **Multi-chain support** — Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest
- **Atomic block processing** — every block wrapped in a DB transaction; failures roll back cleanly
- **Block reorg handling** — detects reorganizations from the Decoder DB, rolls back and re-indexes
- **Double-entry ledger** — all token movements recorded as credits, debits, and escrows (including contract derived addresses)
- **Per-block sanity check** — verifies token supplies match the sum of credits minus debits
- **Three block hashes** — ledger, actions, and contract hashes per block for state verification
- **DEX engine** — ORDER matching, SWAP matching, DISPENSER triggering with automatic expiration
- **Protocol versioning** — actions activate at specific block heights or timestamps per network
- **Action mapping** — address/ticker/action_index cross-references for fast lookups
- **Circuit-breaker DB connections** — automatic failure detection and recovery
- **Watchdog timeout** — configurable per-block processing timeout detects deadlocks
- **958 tests** — unit, integration, e2e, fuzz, chaos, mutation, boundary, smoke, performance, regression

## Documentation

Full indexer documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/indexer) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/indexer/README.md) | Overview, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-platform/xchain-documentation/blob/master/indexer/ARCHITECTURE.md) | Data pipeline, internal components, action handlers, block processing pipeline |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/indexer/CONFIGURATION.md) | Environment variables, coin-specific config, indexer constants |
| [Actions](https://github.com/XChain-platform/xchain-documentation/blob/master/indexer/ACTIONS.md) | All 20 ACTION types, categories, format versions, protocol versioning |
| [Database](https://github.com/XChain-platform/xchain-documentation/blob/master/indexer/DATABASE.md) | Full schema reference — core, ledger, action, state, index, and mapping tables |
| [Ledger](https://github.com/XChain-platform/xchain-documentation/blob/master/indexer/LEDGER.md) | Double-entry ledger, balance calculation, sanity checks, gas token fees |
| [Operations](https://github.com/XChain-platform/xchain-documentation/blob/master/indexer/OPERATIONS.md) | Running, Docker, API endpoints, resilience, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-platform/xchain-indexer.git
cd xchain-indexer
npm install
```

Create a `.env` file:

```env
DECODER_DB_HOST=localhost
DECODER_DB_PORT=3306
DECODER_DB_NAME=XChain_BTC_Mainnet_Decoder
DECODER_DB_USER=xchain_reader
DECODER_DB_PASS=your_password

INDEXER_DB_HOST=localhost
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

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the indexer and API server |
| `npm test` | Run unit tests (~820 tests) |
| `npm run test:integration` | Integration tests (~929 tests, requires MariaDB) |
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
| `npm run test:regression` | Regression tests (tagged across all suites) |
| `npm run test:regression:fast` | Fast regression (tier1 + tier4, unit only) |
| `npm run test:regression:full` | Full regression suite |
| `npm run test:nodb` | All tests that don't require a database |
| `npm run test:full` | Complete test suite |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit — Core | ~130 | `actions.test.js`, `utility.test.js`, `db.test.js`, `config.test.js`, `rollback.test.js`, `mapper.test.js`, `protocol_changes.test.js` |
| Unit — Actions | ~530 | 27 action handlers: `send.test.js`, `issue.test.js`, `mint.test.js`, `order.test.js`, `dispenser.test.js`, ... |
| Unit — Security | ~60 | SQL safety, parameter injection, negative amounts, balance integrity, startup validation |
| Boundary | ~100 | Supply limits, tick length, fees, expiration, sleep/resume, address validation, DEX price matching |
| Fuzz | ~50 | Property-based testing via fast-check: mathematical properties, format fuzzing |
| Chaos | ~30 | Database failures, circuit breaker, timeout handling, malformed data |
| Mutation | ~30 | Mutation testing harness: arithmetic, validation, boundary mutations |
| Smoke | ~10 | Config loading, utility functions, handler instantiation, API liveness |
| Regression | ~18 | Tagged tests across all suites for fast verification |
| Integration | ~929 | Full scenario tests against MariaDB |
| E2E | 43 | Full-stack tests exercising decoder → indexer → explorer pipeline |
| Performance | 5 suites | Baseline throughput, action benchmarks, sustained load, spike load, scaling |
| **Total** | **~958+** | |

---

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
