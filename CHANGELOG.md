# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-04-02

### Added
- Per-block contract hash (SHA-256) covering contracts, contract_state, contract_executions, contract_emissions, deposits, and withdrawals tables
- `contract_hash_id` column on `blocks` table, following the existing ledger_hash/actions_hash pattern
- Contract hash displayed in block parsing log output alongside ledger and actions hashes

## [2.0.0] - 2026-04-02

### Added
- Hub staking actions: STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION, CLAIM_REWARDS (BTC-only)
- VM actions: DEPLOY, EXECUTE, DEPOSIT, WITHDRAW (all chains)
- Unified gas fee schedule with GAS_PRICE, GAS_SCHEDULE config across all chains
- New shared table: index_pubkeys for Ed25519 signing key normalization
- Staking tables: stakes, unstakes, delegations, validator_rewards, reward_claims
- VM tables: contracts, contract_state (append-only), contract_executions, contract_emissions, contract_balances, deposits, withdrawals
- DB methods: getPubkeyId, getOrCreatePubkeyId, createStake, createUnstake, createDelegation, createRevokeDelegation, createRewardClaim, getActiveStakeBySource, getActiveStakeByPubkey, getActiveDelegation, getUnclaimedRewardTotal
- DB methods: createContract, getContract, getStatusString, createContractExecution, createDeposit, createWithdrawal, updateContractBalance, getContractBalance, updateContractBalances
- Fee utility methods: getUnifiedTransactionFee, getUnifiedExpirationFee, getFeePaymentMode, validateNativeCoinFee (stub for Track B)
- Protocol changes: STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION, CLAIM_REWARDS, DEPLOY, EXECUTE, DEPOSIT, WITHDRAW, UNIFIED_FEES, VM_ACTIONS
- Rollback support for all new tables including contract_emissions deletion and contract_balances recalculation

### Changed
- Fee schedule: unified gas model replaces per-chain fee constants (gated by UNIFIED_FEES protocol change)
- Expiration free days reduced from 182 to 90 across all chains (unified schedule)
- Flat fee rate across all chains (~2 XCHAIN/yr via gas schedule)
- Updated fee handlers in issue.js, airdrop.js, dividend.js, order.js, dispenser.js, swap.js with UNIFIED_FEES gating
- Fees table schema: added gas_cost, gas_price, xchain_amount, payment_mode, fee_preference, fee_version columns
- Removed DEPLOY → ISSUE alias (DEPLOY reclaimed for VM contract deployment)

## [1.15.0] - 2026-04-02

### Added
- COINPAY action handler: processes native coin payments that fulfill COINPay obligations
- Per-output processing pattern (dispense-style): only the output matching payee address and amount triggers settlement
- Settlement logic: releases escrowed tokens to buyer, records payment in coinpays table, updates obligation/match/order statuses
- Order finalization on COINPAY: marks orders complete when fully filled, finalizes cancelling/expiring orders when all obligations resolve
- Database methods: createCoinpay, getOrderMatchAmounts

## [1.14.0] - 2026-04-02

### Changed
- ORDER action: detect native coin sides (null/empty TICK), skip token validation, balance check, and escrow for native coin GIVE; use COIN_DECIMALS for amount format validation; reject coin-for-coin orders
- ORDER cancel (format 1): two-phase cancel with pending COINPay obligations (cancelling status)
- ORDER_MATCH: detect native coin matches, create COINPay obligations instead of instant settlement, set settlement_type='coinpay' and status='pending_coinpay'
- ORDER_EXPIRE: two-phase expiration with pending COINPay obligations (expiring status)
- getOrderInfo query: LEFT JOIN on ticker tables for null tick support
- findOrderMatches query: NULL-safe tick comparison for native coin order matching
- getOrderAmountsRemaining: include pending_coinpay status in remaining calculation
- createOrderMatch: add settlement_type column support
- Test mocks: add all coinpay DB method stubs

## [1.13.0] - 2026-04-02

### Added
- COINPay Phase 1: core infrastructure for native coin DEX pairs (BTC/LTC/DOGE)
- Database tables: coinpay_obligations, coinpays, coinpay_expires, coinpay_statuses
- settlement_type column on order_matches table (instant/coinpay)
- COINPAY and COINPAY_EXPIRE protocol change registrations
- COINPAY_EXPIRE action handler with obligation expiration, escrow release, and order state finalization
- Database methods: createCoinpayObligation, createCoinpayStatus, createCoinpayExpire, getCoinpayObligationInfo, getExpiredCoinpayObligations, getOrderMatchOrders, getPendingCoinpayObligationsByOrder
- Expired COINPay obligation processing in block expiration loop
- Rollback support for all coinpay tables with market pair recalculation
- COIN_DECIMALS (8) and COINPAY_EXPIRATION (7200s) config values

## [1.12.1] - 2026-04-01

### Changed
- Rewrite README with features, quick start, scripts, documentation links, and test suite breakdown
- Remove inline ACTION commands table in favor of xchain-documentation/indexer/ACTIONS.md reference

## [1.12.0] - 2026-04-01

### Added
- Regression testing suite with tiered tag-based execution across all existing test suites
- @regression @tier1 tags on core state integrity tests (ISSUE, SEND, MINT, DESTROY, balance arithmetic, fees)
- @regression @tier2 tags on lifecycle and matching tests (ORDER, DISPENSER, SWAP, AIRDROP, DIVIDEND)
- @regression @tier3 tags on infrastructure tests (block discovery, reorg, rollback, routing, config, protocol changes)
- @regression @tier4 tags on all security tests (SQL safety, input validation, arithmetic integrity, config validation)
- npm scripts: test:regression (all tiers), test:regression:fast (tier1+tier4 only, <60s), test:regression:full (all tiers with extended timeout)
- 958 unit-level regression tests passing across all four tiers
- 442 fast regression tests (tier1+tier4) passing in ~2 seconds
- Comprehensive regression testing plan in claude/reports/INDEXER_REGRESSION_TESTING_PLAN.md

## [1.11.0] - 2026-04-01

### Added
- Mutation testing suite with 125 tests across 5 suites assessing test suite effectiveness
- Custom mutation testing engine with runtime monkey-patching via sinon stubs
- 12 mutation operator types: AOR, ROR, LCR, UOI, SVR, SDL, BCR, SBR, EMR, ACR, PRM, EHR
- Tier 1 math mutations (36 tests): bcadd/bcsub/bcmul/bcdiv operator swaps, boundary conditions, parameter reorder
- Tier 1 validation mutations (28 tests): isValidAmountFormat, isCryptoAddress, hasBalance, isNull negation and boundary
- Tier 1 action mutations (32 tests): Send/Destroy/Issue parse() guard deletion, value replacement, logical connector bypass
- Tier 2 balance mutations (18 tests): getTokenSupply formula mutations, createLedgerChangeRecord whitelist, SQL filter verification
- Tier 2 state mutations (11 tests): consolidateLedgerRecords array/separator mutations, debitBalances arithmetic, rollback boundary
- MutationRegistry singleton for cross-suite result accumulation and reporting
- Console mutation report with per-operator breakdown and survived mutant identification
- JSON report generation via MUTATION_REPORT=1 environment variable
- npm scripts: test:mutation, test:mutation:tier1, test:mutation:report
- Mutation score: 90.4% (113/125 killed; 12 survived are confirmed equivalent mutants)

## [1.10.0] - 2026-04-01

### Added
- Chaos engineering test suite with 42 tests across 5 suites verifying resilience mechanisms
- Circuit breaker state machine tests (12 tests): closed/open/half-open transitions, threshold, cooldown, per-instance isolation
- Exponential backoff and retry tests (8 tests): delay doubling, jitter, max cap, attempt limits
- Query error propagation tests (8 tests): re-throw in transactions, safe fallback outside, connection release
- Watchdog timeout tests (6 tests): resolve/reject behavior, label inclusion, timer cleanup
- Block processing resilience tests (8 tests): rollback on failure, watchdog timeout, recovery, multi-tx blocks
- Chaos test harness with FakePool and FakeConnection for controlled fault injection
- npm script: test:chaos

## [1.9.1] - 2026-04-01

### Added
- safeToString() utility for defensive string conversion of objects with broken or missing toString

### Fixed
- normalizeDataValues() crash on objects with toString overridden to a non-function — now uses safeToString(), falls back to null
- isValidAmountFormat() crash on objects/arrays with broken toString — now uses safeToString(), rejects unconvertible values while still accepting mathjs bignumbers

## [1.9.0] - 2026-04-01

### Added
- Block processing watchdog timeout (5 min) — detects deadlocks and infinite loops, rolls back stalled blocks
- Circuit breaker on database connections — opens after 10 consecutive failures, 30s cooldown before retry
- Exponential backoff with jitter on connection retries — prevents thundering herd on database recovery
- Connection pool validation via minDelayValidation (3s) — detects stale/half-open connections after network partitions
- withTimeout() utility for promise-based timeout enforcement

### Fixed
- doQuery() now re-throws errors inside ACID transactions instead of silently returning empty results

## [1.8.1] - 2026-04-01

### Fixed
- bcnum() no longer crashes on non-numeric, NaN, or Infinity inputs — returns bignumber(0) as safe fallback
- bcnum() trims whitespace from string inputs before parsing to prevent mathjs DecimalError
- bcdiv() returns bignumber(0) on division by zero instead of returning Infinity
- isInteger() no longer crashes on objects with broken toString — returns false for non-primitive types, supports bignumber objects via toNumber()
- getFormatVersion() no longer crashes on object inputs — returns null; correctly rejects decimal strings like '1.5' instead of truncating to integer
- setNumberFormats() uses isNumeric() guard instead of try/catch for bcnum() calls
- Address handler validates numeric input before bcnum() conversion to prevent DecimalError crash
- Issue and Dividend handlers use Object.assign() instead of structuredClone() to prevent DataCloneError on bignumber objects during BATCH processing
- normalizeDataValues() removed redundant ENCRYPTION_METHOD truncation that conflicted with NUMBER_FIELDS validation
- bcgt/bclt/bcgte/bclte and hasBalance() routed through bcnum() for consistent input validation

## [1.8.0] - 2026-04-01

### Added
- Property-based fuzz testing suite with 123 tests across 8 test files using fast-check
- Custom fast-check arbitraries for amounts, tick names, addresses, hashes, and ACTION data strings
- Tier 1 suites: validation functions, BigNumber math, normalizeDataValues, processTransaction crash safety, BATCH handler invariants
- Tier 2 suites: tick name handling through Issue handler, ISSUE+MINT lifecycle crash safety
- Tier 3 suites: Send handler, balance operations, lock validation, ledger consolidation, getFormatVersion edge cases
- Crash report logging in processTransaction fuzz suite documenting known error patterns
- npm scripts: test:fuzz, test:fuzz:quick (@tier1 only), test:fuzz:full (10K runs)
- fast-check devDependency for property-based testing

### Discovered
- getFormatVersion crashes on objects with null toString (utility.js:198)
- isInteger crashes on objects with broken toString (utility.js:165)
- bcnum silently accepts 'NaN' and 'Infinity' strings via mathjs
- bcdiv returns Infinity on division by zero instead of throwing
- structuredClone fails in Issue handler when data contains bignumber objects (issue.js:108)
- normalizeDataValues MESSAGE truncation re-introduces strings after NUMBER_FIELDS nullification
- Address handler calls bcnum on non-numeric data without validation (address.js:90)
- getFormatVersion truncates decimal strings (e.g., '1.5' → 1) due to isFloat type mismatch

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
