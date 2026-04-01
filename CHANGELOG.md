# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] - 2026-04-01

### Added
- Performance and load testing suite with 15 tests across 5 scenario files measuring indexer throughput, latency, and resource utilization
- Baseline throughput benchmarks for empty, light, normal, and heavy block loads
- Per-action-type benchmarks comparing SEND, ISSUE+MINT, ORDER, and mixed workloads
- Sustained load test with configurable duration and degradation detection
- Spike load tests simulating sudden traffic surges and bursty patterns
- Scaling tests measuring sanity check and market update cost across 10-200 tokens
- Instrumented block processor with per-phase timing (decoderRead, actionProcessing, expirations, cancellations, blockCreation, marketUpdates, sanityCheck, commit)
- Metrics collector tracking block timing distributions (min/avg/p50/p95/p99/max), memory usage, and event loop delay
- Report generator producing console summaries, JSON data files, and Markdown reports
- Bulk data generator with 5 action profiles: send-only, normal, token-launch, heavy-dex, mixed-heavy
- `npm run test:perf` and per-scenario scripts (`test:perf:baseline`, `test:perf:benchmarks`, `test:perf:sustained`, `test:perf:spike`, `test:perf:scaling`)

## [1.6.0] - 2026-04-01

### Added
- Security test suite with 47 tests across 6 files validating vulnerability fixes and regression guards
- Tests cover negative amount rejection, parameter injection, DECIMAL precision clamping, ledger table whitelist, balance arithmetic integrity, and startup configuration validation
- `npm run test:security` script for running security tests in isolation

## [1.5.1] - 2026-04-01

### Fixed
- Reject negative amounts in `isValidAmountFormat()` to prevent balance inflation via sign bypass
- Clamp token decimal precision to [0, 18] in `getTokenDecimalPrecision()` to prevent SQL injection via DECIMAL CAST
- Whitelist table names in `createLedgerChangeRecord()` to prevent SQL injection
- Validate database name format in `createDatabase()` and use backtick quoting
- Mask SQL error details in logs to prevent information disclosure

### Changed
- Add `connectTimeout`, `acquireTimeout`, `idleTimeout` to MariaDB connection pool
- Restrict CORS to configured origin (defaults to `http://localhost`, POST-only)
- Validate all required environment variables at startup with fail-fast behavior

## [1.5.0] - 2026-04-01

### Added
- Smoke test suite with 15 tests across 6 files validating service startup, DB connectivity, API liveness, action processing, and indexer lifecycle
- Unit smoke mode (`npm run test:smoke:unit`) runs in ~1s with no external dependencies
- Connected smoke mode (`npm run test:smoke:connected`) validates DB pools, schema, tables, JSON-RPC ping, and start/stop lifecycle against MariaDB
- Combined `npm run test:smoke` script for running all smoke tests

## [1.4.0] - 2026-04-01

### Added
- Boundary test suite with 91 tests across 12 files covering amount precision, string limits, timestamp/expiration edges, batch composition, order matching, dispenser dispense, token state machine, fee activation, and address validation
- `npm run test:boundary` script for running boundary tests in isolation
- Tests document production behavior findings: mathjs precision loss at 10^21+1, DESCRIPTION/MEMO off-by-one asymmetry, SLEEP RESUME_BLOCK boundary semantics

## [1.3.0] - 2026-04-01

### Added
- End-to-end test suite with 43 tests across 6 scenario files validating the full data pipeline through xchain-explorer API
- E2E test infrastructure: explorer launcher, HTTP API client, API assertion helpers
- `npm run test:e2e` script for running E2E tests against MariaDB + explorer API
- Coverage for token lifecycle, DEX orders, dispensers, reorgs, error handling, pagination, and query patterns via Explorer HTTP endpoints

## [1.2.1] - 2026-04-01

### Fixed
- Integration test DB connection reads credentials from `.env` file instead of hardcoded `root`/`test` defaults
- `seedGasToken` ISSUE had wrong MAX_MINT (8 instead of 999999999), causing MINT and downstream actions to fail
- Multi-block YTOKEN ISSUE MAX_MINT too low (100) for MINT of 200
- Block count assertion corrected from 4 to 103 (accounts for gas setup blocks 1-3 plus indexer gap-fill)

## [1.2.0] - 2026-04-01

### Added
- Integration test suite with 109 tests across 6 scenario files (97 passing)
- Test infrastructure: decoder seeder, indexer launcher, assertion helpers, DB connection manager
- `npm run test:integration` script for running integration tests against MariaDB
- Coverage for block discovery, token lifecycle, DEX orders, dispensers, reorgs, and error handling

### Fixed
- Rollback used `block_index > ?` instead of `>= ?`, leaving data at the reorg block uncleaned
- `normalizeDataValues()` nullified LOCK fields when values were bignumber or string (broke all LOCK_* flags set via protocol actions)
- `isValidValue()` could not match bignumber objects against valid value arrays (broke SWEEP action)

## [1.1.0] - 2026-03-31

### Added
- Comprehensive unit test suite with 820 tests across 34 test files
- Test coverage for all 9 core modules and 27 action handlers
- Mock infrastructure (MockDatabase, fixtures, config loader) for isolated testing
- Mocha and Sinon as dev dependencies
- `npm test` script for running the full unit test suite
- `.mocharc.yml` configuration file
- `.env` added to `.gitignore`
