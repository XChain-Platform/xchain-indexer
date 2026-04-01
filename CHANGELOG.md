# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
