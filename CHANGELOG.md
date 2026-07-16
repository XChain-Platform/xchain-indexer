# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Armed the contract-era (Cohort A) flag-day at 2026-10-01 00:00 UTC (was the 2027-01-01 placeholder) across all six block_TIME gates, re-anchored the CROSS_CHAIN_ROYALTY create-side date to 2027-01-01 (one quarter after), and armed the four remaining BTC-anchored gates (checkpoint commitment, EQUIV header, stake-weighted quorum, anchor reward) at BTC 961000.
- `STATE_COMMITMENT_ACTIVATION` armed mid-chain with per-chain '<COIN>:<network>' keys (same heights as the state-hash gates); the twin module and its call sites now take the coin, mirroring stateHash.js.
- Armed `CROSS_CHAIN_ROYALTY_ACTIVATION` mainnet at BTC anchor 961000 (~2026-08-04, fleet deploy required first); the create-side `CROSS_CHAIN_ROYALTY` date was re-anchored to 2027-01-01 the same day (entry above).
- `stateHash.js` gains the flag-day-gated `token_supply` class covering in-place supply refreshes (F-1 closure); both state-hash gate maps are now per-chain and ARMED (fleet deploy required before the earliest activation height, DOGE mainnet 6,291,000).
- `src/tableLifecycle.js` table-lifecycle registry: declares replication, rollback, and hash coverage per table, generates the rollback table lists, and gates coverage in tests (twin vendored to xchain-sync).
- `stateHash.js` gains a flag-day-gated `poll_finalize` class covering VOTE poll finalization flips (inert on all networks until `POLL_FINALIZE_STATE_HASH_ACTIVATION` is armed).
- `hub_db_sync.js` exports `ensureTables()` for non-indexer mirror consumers and is now the canonical copy vendored into xchain-explorer via `bin/sync-hub-mirror-client.sh`; indexer runtime behavior is unchanged.

### Fixed
- `LOCK_MAX_SUPPLY_EXACT` (the strict ISSUE `LOCK_MAX_SUPPLY` guard) now pins its mainnet activation to the coordinated 2026-10-01 00:00 UTC contract-era flag-day instead of `0`; an unpinned mainnet time flipped the verdict on binary version alone, forking a heterogeneous fleet on any ISSUE carrying an explicit `LOCK_MAX_SUPPLY=0` and diverging a from-genesis replay from the committed ledger hash. testnet/regtest stay genesis-active, matching the sibling ISSUE/SLEEP validity gates.
- `order_match.js` subtracts the running remaining at precision 64 (was bcsub's default 0, which rounded a fractional remaining to an integer, prematurely completing orders with escrow stranded or filling past exhaustion).
- All 12 remaining escrow-release sites (order/swap/coinpay expire+cancel, sweep, cross_settle) negate via `bcsub(0, amount, 64)` instead of JS unary minus, which float-truncated high-decimal amounts and desynced the release from the paired credit; a source-scan regression guards the whole family.
- `pushvalidatorrewards` writes through the new `db.apiView()` pooled-connection view, so a hub push landing mid-block no longer joins the block's open transaction and can't be rolled back after the API acked it.
- `tick_id` is now nullable on the five invalid-tolerant detail tables (`deposits`, `withdrawals`, `contract_stakes`, `contract_unstakes`, `contract_delegations`) via an auto migration, closing a fleet-halt wedge where an invalid DEPOSIT/WITHDRAW/STAKE/UNSTAKE/DELEGATE carrying an unresolvable TICK (empty, or a `^<id>` reference to a non-existent ticker) wrote its row with a NULL `tick_id` and threw `ER_BAD_NULL_ERROR`, hard-looping block processing (F-18 sibling; found by the flag-day transition drill).
- `hub_db_sync.js _applyRow` upgrades mirrored `cross_chain_matches.anchor_txid` in place (first-stamp-wins), so the hub's ANCHOR back-fill re-broadcast lands instead of being dropped by INSERT IGNORE.
- `hub_db_sync.js ensureTables()` gates each SQL file on table existence (probed inside the retry loop), so a mirror consumer restarting against an already-built schema no longer fails with ER_TABLE_EXISTS_ERROR.
- Pin `decimal.js` to `10.4.3` in the indexer's own `overrides` (mirroring the bundled VM): the deployed consensus process pulls the precision-64 BigNumber backend transitively via `mathjs` (caret `^10.4.3`), and npm honors `overrides` only from the top-level package, so a fresh install or `npm update` could otherwise float the backend within 10.x and silently change contract math roots. A new freeze-guard assertion pins the installed `decimal.js` (10.4.3) and `mathjs` (15.2.0) versions where consensus actually runs.
- `DISPENSER_EXPIRE` and `DISPENSER_CLOSE` return escrow via `bcsub(0, GIVE_REMAINING, 64)` instead of JS unary minus, which coerced an 18-decimal remaining balance to a float and desynced the escrow debit from the full-precision credit (mirrors the `dispense.js` pattern).
- The orphaned `contract_balances` drop migration is tagged `mode=manual` so its destructive `DROP TABLE` no longer auto-runs at indexer startup across the fleet; it now applies only via an explicit operator migrate run.
- CI integration scenarios 11/14 boot LTC/DOGE test indexers with real fee destinations and pin the xchain fee path post-init (`withCoin` `xchainFeeMode`), replacing the placeholder env override the startup guard now fails closed on.
- Cross-node content-mode equivalence no longer compares `push_generations`: the monotonic reorg fence differs between a survivor and a fresh re-parse by design.
- The SDK fee-fragment parity drift guard moved from the unit tier to integration scenario 15 with a read-only sdk checkout in CI, so the unit tier no longer requires a sibling xchain-sdk checkout.
- The integration launcher shares one config snapshot between the indexer and its Utility, matching production wiring.
- VOTE ballots are stored append-only (unique key gains `action_index`; tally reads each voter's latest set), so a reorg orphaning a re-vote restores the voter's prior ballot instead of losing it forever.
- Amount strings are rendered in normal notation everywhere (`Utility.bcstr`): sub-1e-7 amounts previously stringified exponentially ("3e-8"), which the SMT leaf encoder rejects, hard-wedging the indexer at that block.
- VM-emitted VOTE deposits/gas escrows are classified in the emission amount-truncation map (fixed GAS denomination).

### Added
- `recovery_pending_rewards` staging table: recovery-local scratch for archived validator rewards, not consensus-hashed, rollback-exempt, and excluded from replication.
- Behavioral regression test pinning the `index_addresses`/`index_tickers` rollback delete predicate (`WHERE block_index >= ?`) and its ordering after the data deletes.
- Golden-vector test pinning the stakes-root primitives (`stakeMemberLeaf`/`stakeTotalLeaf`/`sumCanonicalAmounts`) and the `blockMerkleLeaves` cross-kind ordering.

### Changed
- Index-map `state_hash` promotion: per-block `index_addresses`/`index_tickers` preimage class, activation-gated and consensus-inert until flag-day.

### Security
- Resolve a wire `^<id>` index reference only when it is canonical (`^[1-9][0-9]*`, no leading zero) and backs an existing block-stamped row, across `getAddressId`, `getTickerId`, and `resolveAddressRef`.
- Reject malformed, dangling, and non-canonical caret forms (`^007`, `^1.5`, `^-1`, `^0x10`, `^1e3`) instead of resolving them to a phantom, aliased, or coerced id.
- Skip the deterministic index-id pre-pass for actions rejected before their handler, so a rejected action mints no `index_addresses` id.
- Stamp index ids from a single authoritative `block_index` and warn on out-of-band or NULL-`block_index` ids that would offset the deterministic counter.

## [2.7.14] - 2026-07-16

### Fixed
- ANCHOR replay-guard watermark parameterized from shared ANCHOR_CHECKPOINT_VERSIONS instead of a hand-copied literal ().
- getAnchorChunks excludes invalid chunks and dedupes to the lowest action_index per chunk_index, so junk ANCHOR v2 chunks can no longer block disaster-recovery rebuilds; recovery inlines the same shape ().
- capability_snapshots hub mirror converted to a natural-key mirror (wire id stripped, bootstrap pages from since_id=0) closing silent permanent mirror holes ().
- Hub-config poll gains a reentrancy guard released in finally, mirroring _startStateTreeMetric ().
- DEPLOY COOLDOWN_BLOCKS strict-integer gate, consensus-gated via new COOLDOWN_BLOCKS_INTEGER protocol change in the 2.0.0 contract-era cohort ().
- reconcileTableIndexes keeps per-column prefixes and warns on prefix-width drift (deliberately no DDL) ().
- New manual migration repositions state_key_bin so aged and fresh table tails converge ().
- tableLifecycle ORPHAN_SWEEPS icons sweep marked replica-mirrored with flag semantics documented ().


## [2.7.11] - 2026-06-20

### Security
- Gate `getfullnodeverifiers` behind `INDEXER_API_KEY`, completing the validator-enumeration read auth set.
- Break same-block contract-stake slash reorg-restore ties on `(execution_index, slash_position)` instead of the AUTO_INCREMENT `id`.
- Gate the programmable-policy controller guard behind a `CONTROLLER_GUARD` activation instead of running from genesis.
- Stop applying `ACTIVATION_DELAY_BLOCKS`, `EXPIRATION_FEE_PER_DAY`, and `STAKING` from the live hub-config overlay; they now come only from local per-chain config.
- Write a parent `contract_executions` row for controller-guard runs so guard emissions enter the per-block `contract_hash`.
- Gate inline DEPLOY `CODE_ENCODING` base64 decoding behind a `DEPLOY_BASE64_CODE` activation (hex before, base64 after).
- Gate the VM-emitted-ISSUE issuance-fee exemption behind an `ISSUANCE_FEE_EMISSION_EXEMPT` activation.
- Remove the emitting EXECUTE's `action_index` from the XCALL `call_id` preimage.
- Record structurally-invalid ATTEST v0 requests as `request_status='rejected'` so they no longer flow through the quorum pipeline.
- Create source and destination address records sequentially (not via `Promise.all`) so `address_id` assignment is deterministic across nodes.
- Add a lexicographic address tiebreak to `getHolders()` so equal-balance holders iterate in a stable order.
- Apply the hub's simple-majority quorum floor to PRICE / CROSS_SETTLE / ANCHOR signature verification.
- Re-derive a `GIVE_OWNERSHIP` token's `escrow_action_index` (SET and CLEAR) when a reorg orphans its offer.
- Remove the unused wall-clock `getCurrentTime()` helper and add a `check:consensus-time` build guard against its reintroduction.
- Require `INDEXER_API_KEY` on the federation read RPCs (`getownstake`, `getactivevalidators`, `getcapabilityvalidators`, `getpendingattestation_requests`) when a key is configured.

### Fixed
- Add a direct-hub-DB call-presence barrier so single-host nodes don't fork from a replaying node on cross-chain calls.
- Enforce the write/federation-read API-key gate only when `INDEXER_API_KEY` is set, and warn loudly at startup in no-key mode.
- Persist `encryption_method=1` (ECIES) on decoded MESSAGE v2 rows instead of `NULL`.
- Reset a parent v1 anchor left stamped `invalid_archive` when a reorg orphans the completing chunk.
- Accept an explicit `LOCK_MAX_SUPPLY=0` on an uncapped token instead of rejecting it.
- Correct the DELEGATE file-header comment (only the capability flavors are BTC-only).
- Replace the length-only `isCryptoAddress()` with real base58check and bech32/bech32m validation against the configured coin/network.
- Make `isEnabled()` rethrow on evaluation failure instead of silently returning "disabled", so a transient DB blip no longer invalidates actions.
- Stop a full-cleanup SWEEP from writing two ownership-transfer ISSUEs for an escrowed tick.
- Remove `FEE_PAYMENT_MODE` from the hub-config overlay; the runtime never read it.
- Declare `STAKING.CAPABILITIES` as `{}` (not `[]`) on LTC/DOGE to match BTC's shape.
- Widen the `index_addresses` unique index from a 62-char prefix to the full `address` column.
- Normalize `pubkeys.sql` / `addresses.sql` to the `DROP TABLE IF EXISTS` + `CREATE TABLE` reset pattern.
- Refresh the decoder chain tip after every committed block during catch-up so reported lag and `isSynced` stay accurate.
- Make the ATTEST v0 `request_id` verification unconditional and require `EMITTER_POSITION` / `TX_HASH`.
- Stop applying `GAS_SCHEDULE` and `GAS_PRICE` from the hub-config overlay; these consensus-critical fee inputs now come only from local config.
- Keep an ATTEST v1 response carrying a retryable status (`no_quorum` / `timeout` / `provider_error`) `pending` instead of closing the request.
- Add an `oracle_prices` block-processing sync barrier so distributed nodes settle FIAT dispensers against a consistent mirror.
- Pass per-provider attestation deadline windows to the VM so a contract's over-limit `deadlineBlocks` is rejected at call time.
- Sweep orphaned `icons` rows on reorg.
- Process a reorg whose lowest rolled-back action has `action_index = 0` (the falsy sentinel skipped the whole phase).
- Return an explicit `capability not configured` error from `getcapabilityvalidators` for an unknown capability instead of an empty set.
- Compute `validateNativeCoinFee()` in bignumber math instead of IEEE-754 floats.
- Validate ATTEST v0 emitters with `CONTRACT_INDEX != null` so a legitimate index-0 emitter is accepted.
- Add an optional keyset cursor to `getpendingattestation_requests` so a poller can page the full pending set.
- Rewrite `scripts/repair-validator-stats.js` against the real unified `attests` schema.
- Regenerate `package-lock.json` to capture the `file:`-linked `xchain-vm` transitive dependencies.
- Add a composite `(code, id)` index on `events` for reorg-detection lookups.
- Drop the redundant single-column `address_id` index on `balances` (the composite unique key covers it).
- Order `sweepCompletedCooldowns()` SELECTs by `action_index ASC` for deterministic completion-credit order.
- Assign a stable cross-node `market_id` per pair (sequential `processMarketUpdates` inserts plus a `uq_markets_pair` unique key).
- Add a price-sync barrier so a BTC indexer waits for its `price_snapshots` mirror before validating native-coin fees.
- Exclude zero-credit holders from `DIVIDEND` so `SOURCE` is not over-charged per-recipient fees.
- Let `getValidatorsByCapability` / `getcapabilityvalidators` accept a caller-supplied `min_stake` (override-wins, local fallback, `0`-is-real).
- Extend the `min_stake` override contract to `getActiveCapabilityCount` / `hasCapability` for API symmetry.
- Re-bootstrap both mirrored hub tables on WebSocket reconnect so the mirror can't silently diverge across an outage.
- Reset an ATTEST v0 request to `pending` on reorg when its resolving response or expiry is orphaned.
- Re-derive `attest_validator_stats` on reorg.
- Reverse matured UNSTAKE cooldown completions whose `cooldown_end_block` falls in an orphaned range.
- Detect consecutive reorgs by decoder event identity instead of block-height magnitude.
- Return the full request row (including `gas_escrow`, `fee_payer_id`, `status_id`) from `getPendingAttestationRequests`.

### Added
- `health` now reports a `stallReason` so an operator can tell why the block counter is not advancing.
- `health` and `GET /status` now report `lastHubConfigFetchAt` / `hubConfigAgeSeconds`.
- Warn once when the hub price tables fall back to the local DB, so a misconfigured distributed node is visible.
- Keep the hub-config overlay live via a polling loop instead of applying it only at startup.
- `.env.example` template enumerating every environment variable the indexer reads.
- Bound `getActiveValidators` / `getValidatorsByCapability` with `LIMIT` (`VALIDATOR_QUERY_LIMIT`, default 1000) and warn at the cap.
- Set a MariaDB `queryTimeout` (`DB_QUERY_TIMEOUT`, default 30000) on the connection pool.
- New `health` JSON-RPC method reporting sync state and decoder/indexer DB circuit-breaker status.
- New `GET /status` REST endpoint returning `{ indexerBlock, decoderBlock, lag, isSynced }`.
- Durable hub-push queue (`pending_hub_pushes`) with backoff retry for the best-effort PRICE pushes.
- `token_controllers` / `address_controllers` event-log tables (controller-bound tokens).
- `contract_permissions` table (controller-bound tokens Phase E).
- `capability_slash_events` / `capability_slash_debits` tables (WI-2 equivocation slashing) plus `finalizing_view` columns.
- `full_node_verifications` table (NODEPROOF full-node verified reward tier, BTC-only).
- Per-block `state_hash_id` integrity hash (`src/stateHash.js`) covering five in-place mutation classes.
- `deploy_chunks` table for the chunked DEPLOY v4 carrier format.
- Operator-runnable migration for the four new `dispensers` columns (`give_ownership` plus the oracle-price trio).
- Rollback-coverage guard test asserting every owned table is handled on reorg.
- One-off `scripts/repair-validator-stats.js` operator tool that rebuilds `attest_validator_stats`.
- Regression test for the `attest_validator_stats` reorg recompute.
- Operator-runnable migration for the SWEEP three-flag restructure (`orders` / `swaps` / `dispensers`, drop `escrows`).
- Operator-runnable migration adding `uq_markets_pair` to `markets`.

### Changed
- Pin `mariadb` to exact `3.5.2` (drop the caret) to match the lockfile.
- Pin `mathjs` to exact `15.2.0` and add a matching `overrides` entry so the whole tree resolves one bignumber implementation.
- Align the `mariadb` driver to the platform-wide `^3.5.2` range.
- Build the Docker image with `npm ci` instead of `npm install`.
- Hoist `MAX_CODE_SIZE` (64 KiB) to an exported constant for cross-service drift checks.
- Log the caught error when the optional `xchain-vm` require fails.
- Calibrate `STAKING.ACTIVATION_DELAY_BLOCKS` per chain (BTC 6, LTC 24, DOGE 60) for ~60 minutes of reorg protection.
- Read the chain-sourced `ACTIVATION_DELAY_BLOCKS` instead of a literal `6` fallback in the staking handlers.

### Removed
- Remove the `fs` dependency (a no-op registry-squat placeholder; Node's built-in always wins).
- Remove the `contract_balances` table; contract balances now derive from the standard credits/debits ledger (auto migration drops it).

## [2.7.9] - 2026-05-29

### Fixed
- Floor dispenser unit counts in bignumber space via a new `bcfloor()` helper, fixing a precision bug that `Math.floor(Number(...))` and `parseInt()` on `bcdiv` results both got wrong.

## [2.7.8] - 2026-05-29

### Fixed
- Fix FIAT/COINPAY dispenser unit calculation that could dispense tokens for a dust payment (`parseInt` misread exponential `bcdiv` output); raise COINPAY division precision to 64 decimals.

## [2.7.7] - 2026-05-29

### Fixed
- Add `ORDER BY action_index ASC` to three expiration/obligation gather queries so same-block expiries process in a deterministic order across nodes.

### Added
- Integration test asserting the expiry-ordering queries return rows ascending by `action_index`.

## [2.7.6] - 2026-05-29

### Fixed
- Add a well-formed `STAKING` config block to LTC/DOGE (was `undefined`); `CAPABILITIES` is empty because capability staking is BTC-only.

## [2.7.5] - 2026-05-29

### Fixed
- Roll back `price_snapshots` on reorg (`DELETE ... WHERE reference_block >= ?`); it was outside the `block_index`-keyed delete loop.
- Reclassify `price_snapshots` in the rollback-coverage test from exempt to special-case.

## [2.7.4] - 2026-05-28

### Fixed
- Gather affected addresses/tickers for the contract-staking tables (`contract_stakes` / `contract_unstakes` / `contract_delegations`) in the reorg pre-scan so the post-rollback balance recompute is correct.

## [2.7.3] - 2026-05-28

### Fixed
- Correct `FEE_PAYMENT_MODE` from `'xchain'` to `'native'` on DOGE/LTC to match the detected runtime behaviour (informational only today).

## [2.7.2] - 2026-05-28

### Security
- Add the missing `VM_ATTEST_REQUEST: 5000` gas-schedule entry to LTC/DOGE; the undefined cost let ATTEST v0 emissions flood the federation queue for free.

## [2.7.1] - 2026-05-28

### Fixed
- Advance the catch-up block counter only after a successful commit (and retry the failed block) so a block that fails to process is never silently skipped, leaving a permanent gap in chain history.

## [2.7.0] - 2026-05-28

### Fixed
- Make every `index_*` lookup-table upsert in `db.js` race-safe with `INSERT IGNORE` + refetch instead of a SELECT-then-INSERT (TOCTOU duplicate-key race).

## [2.6.7] - 2026-05-28

### Fixed
- Add `contract_unstakes` and `contract_delegations` to the `dataTables` rollback list so reorgs purge orphaned contract-staking rows (notably stale `cooldown_end_block`s).

## [2.6.6] - 2026-05-28

### Fixed
- Add `ORDER BY m.action_index ASC` to `findCancelledDispensers` so same-block dispenser closes process deterministically across nodes.

## [2.6.5] - 2026-05-28

### Fixed
- Add `prices` to the `dataTables` rollback list so reorgs purge orphaned on-chain PRICE rows.
- Signal the hub on rollback (new `pushpricereorg` RPC) to retract `price_snapshots` / `oracle_prices` seeded from orphaned PRICE actions; best-effort, logs and continues on hub failure.
- Handle hub `row:deleted` events in `hub_db_sync.js` to prune rolled-back prices from the local mirror (delete column resolved locally, never from the wire).

## [2.6.4] - 2026-05-28

### Fixed
- Validate the requested `block_index` against the latest indexed block in `getactivevalidators` / `getcapabilityvalidators`, returning an explicit error instead of a mislabelled snapshot for a future block.

## [2.6.3] - 2026-05-28

### Fixed
- Add `slash_events` to the `blockTables` rollback list so reorgs purge phantom slash events.

## [2.6.2] - 2026-05-28

### Fixed
- Add `gated_files` to the `dataTables` rollback list so reorgs purge it alongside `files`; orphaned rows had blocked all further SENDs of the gated token.

## [2.6.1] - 2026-04-24

### Security
- Apply `npm audit fix` to clear 8 transitive advisories in the `express` dependency chain (no `package.json` range changes; `express` resolved to the latest 4.x patch).

## [2.6.0] - 2026-04-24

### Added
- `actions/address.js`: `DISPENSER_PREFERENCE` field on `ADDRESS` format `0` (`1`=owner only default, `2`=anyone). Numeric + valid-value validation. Persisted via `createAddressOption()`; defaulted to `1` on first lookup for addresses that have never set the field.
- `actions/dispenser.js`: authorization gate for opening a dispenser on a non-`SOURCE` `GET_ADDRESS`: allowed only when the target has `DISPENSER_PREFERENCE=2` or is a fresh address (`utxo-tracker get_first_seen` returns null or a height `>= BLOCK_INDEX`). Rejected with `invalid: GET_ADDRESS (dispenser not permitted)` otherwise. `GET_ADDRESS == SOURCE` bypasses the check (owner self-open).
- `UtxoTracker.js`: new thin JSON-RPC client for `xchain-utxo-tracker`. Exposes `getFirstSeen(address)` used by the DISPENSER fresh-address check. `enabled` flag gated on `UTXO_TRACKER_URL` / `UTXO_TRACKER_API_PORT` env vars; when disabled, all non-owner dispensers on non-preference-open addresses are rejected (logged at startup).
- `XChainIndexer.js` / `api.js`: plumb `UTXO_TRACKER_URL` and `UTXO_TRACKER_API_PORT` env vars through to the new `UtxoTracker` client; startup warning when the client is disabled.
- `db.js getDispenserCanceller()`: returns the address recorded on the most recent `cancelling` status row for a dispenser, used by `dispenser_close` to route escrow per spec.
- `sql/dispenser_statuses.sql`: new `cancelled_by_id` column (FK to `index_addresses`) recording the address that triggered a cancel; indexed for lookup.

### Changed
- `actions/dispenser.js` (format 1 cancel) and `actions/sweep.js` (dispenser cancel branch), now pass `SOURCE` as the canceller when writing the `cancelling` status row, so `dispenser_close` has the canceller identity available.
- `actions/dispenser_close.js`: escrow destination now resolves in this priority order: (1) `SWEEP` destination if the cancel came from a `SWEEP`, (2) recorded canceller (`GET_ADDRESS` or `SOURCE`) per `DISPENSER.md`, (3) dispenser `SOURCE` fallback. Matches the spec's close-path escrow rules.
- `db.js createDispenserStatus()`: accepts optional `cancelled_by` address; writes/updates the new `cancelled_by_id` column.
- `db.js createAddressOption()` / `getAddressPreferences()`: read/write the new `dispenser_preference` column. Defaults to `1` (owner only) when the address has no prior non-null value.
- `sql/addresses.sql`: added `dispenser_preference BIGINT UNSIGNED` column.
- `test/unit/actions/address.test.js` / `test/fixtures/mocks.js`: parameter helper and `makeParams()` signature updated for the new `DISPENSER_PREFERENCE` field position; `getDispenserCanceller` stub added to the mock DB.

## [2.5.0] - 2026-04-08

### Added
- `actions/price.js`: new PRICE action handler supporting both v0 (validator COIN/FIAT snapshots) and v1 (user TOKEN/FIAT oracles). v0 parses variable-length PBFT signatures, verifies each signer has an active Tier 1 stake, validates Ed25519 signatures against the canonical payload, and checks PBFT quorum (`2*floor((tier1_count-1)/3)+1`). v1 validates COIN/TICK/FIAT/VALUE/FEE fields. After validation, pushes to `xchain-hub` for cross-chain aggregation.
- `sql/prices.sql`: new action table for on-chain PRICE actions. Stores v0 fields (`round_number`, `pairs_json`, `sigs_json`) and v1 fields (`coin_id`, `tick_id`, `fiat_id`, `value`, `fee`). One row per processed PRICE transaction.
- `ed25519.js`: lightweight Ed25519 verification helper using Node.js built-in `crypto` (no external deps). Provides `pubkeyFromHex()`, `verify()`, and `buildPriceV0Payload()` for canonical sortable JSON payload construction matching the xchain-hub signer format.
- `hub_client.js`: dependency-free JSON-RPC client for pushing data to `xchain-hub` (`pushChainTip`, `pushPriceRound`, `pushOraclePrice`). Uses Node's built-in `http`/`https` modules.
- `hub_db_sync.js`: WebSocket sync client that maintains a local copy of the hub's `price_snapshots` and `oracle_prices` tables for geographic distribution. Bootstraps via REST snapshot (`GET /hub-db/snapshot/...`) then subscribes to `/hub-db/subscribe` for live row updates. Applies rows via `INSERT IGNORE` (idempotent). Falls back to periodic polling if the `ws` package isn't available. Opt-in via `HUB_DB_SYNC_ENABLED=true`.
- Third database connection in `XChainIndexer.js`: new `hubDb` connection points at a local read-only copy of hub cross-chain infrastructure tables. Created when `HUB_DB_HOST` / `HUB_DB_NAME` env vars are set.
- Tier 3 oracle publisher staking support in `configs/BTC.js`: `STAKING.TIERS[3]` = 500 XCHAIN, `STAKING.ACTIVATION_DELAY_BLOCKS` = 6.
- `DOGE_ADDRESS` field on Tier 3 STAKE actions, validates D-prefix + 34-char base58 format. Recorded on-chain in `stakes.doge_address` column.
- 6-block activation delay for all validator state changes (STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION). Tracked via new `activation_block` and `deactivation_block` columns on the `stakes` and `delegations` tables. Active-stake queries filter by `activation_block <= current_block AND (deactivation_block IS NULL OR deactivation_block > current_block)`: eliminates BTC reorg edge cases for reorgs of ≤5 blocks.
- `createValidatorReward()` in `db.js`: resolves a signing pubkey to the staking source address via the `stakes → index_pubkeys` join and inserts into the indexer's `validator_rewards` table. Called by the new `pushvalidatorrewards` JSON-RPC endpoint when xchain-hub's RewardTracker pushes reward records.
- `getActiveStakeCount(tier, blockIndex)` in `db.js`: counts active stakes at a given tier for PBFT quorum calculation in PRICE v0 signature validation.
- `getOraclePrice()` and `getOraclePricesInTimeRange()` in `db.js`: query helpers for `oracle_prices` with `effective_at` gating (enforces the 24-hour price lock window).
- `reverseOraclePriceMatch()` in `utility.js`: user oracle reverse price matching for FIAT dispensers. Combines PRICE v1 user oracle (TOKEN/FIAT) with PRICE v0 validator oracle (COIN/FIAT) for cross-conversion. Walks historical oracle prices newest-first within a 24-hour window.
- `ORACLE_ADDRESS` field on DISPENSER action (format 0), references a user PRICE v1 oracle for TOKEN/FIAT pricing. When set, `FIAT_AMOUNT` is ignored and the oracle provides the price. `dispense.js` branches between `reversePriceMatch` (validator path) and `reverseOraclePriceMatch` (user oracle path).
- `oracle_address_id` column on `dispensers` table (FK to `index_addresses`).
- `pushvalidatorrewards` JSON-RPC endpoint on indexer `api.js`: receives reward push from xchain-hub's `RewardTracker`, writes to the indexer's `validator_rewards` table. Requires `INDEXER_API_KEY` for auth.
- `HubClient.pushChainTip()` called after every successful block commit in `XChainIndexer.js`: anchors oracle rounds to BTC chain tip (fire-and-forget, never blocks indexing).
- `EUR` and `KRW` added to `config.FIATS` and `sql/index_fiats.sql`: 12 supported FIAT currencies total.
- `PRICE` action registered in `protocol_changes.js`, `actions.js`, and decoder `VALID_ACTION_NAMES`.

### Changed
- `getLatestPrice(coinPair, blockHeight)` in `db.js`: now accepts an optional `blockHeight` parameter and filters `reference_block <= blockHeight`. Gates price lookups by the current block so two independent nodes processing the same block always see the same price (cross-node determinism fix).
- `utility.js validateNativeCoinFee()`: passes `data['BLOCK_INDEX']` to `getLatestPrice()` and prefers the local hub DB connection (`db.indexer.hubDb`) when available.
- `utility.js reversePriceMatch()`: same hub DB preference for price snapshots.
- `db.js` `Database` constructor, now stores `this.indexer` reference so dependent code can resolve `db.indexer.hubDb` automatically.
- `actions/stake.js`: format expanded to `VERSION|TIER|CHAINS|SIGNING_PUBKEY|DOGE_ADDRESS`. Accepts tier 3. Tier 3 rules: CHAINS must be empty, DOGE_ADDRESS required with format validation. Tier 1/2 rules: DOGE_ADDRESS must be empty. Calculates `ACTIVATION_BLOCK = BLOCK_INDEX + 6`.
- `actions/unstake.js`: accepts tier 3. Active-stake lookup gated by block index. Sets `deactivation_block = BLOCK_INDEX + 6` on the parent stake when valid.
- `actions/delegate.js`: accepts new delegation with 6-block activation delay. Active-stake lookup gated by block index.
- `actions/revoke_delegation.js`: sets `deactivation_block = BLOCK_INDEX + 6` on the parent delegation when valid. Active-delegation lookup gated by block index.
- `actions/claim_rewards.js`: active-stake lookup gated by block index.
- `actions/dispense.js`: FIAT dispenser flow now branches on `dispenser.ORACLE_ADDRESS`: uses `reverseOraclePriceMatch()` (user oracle path) when set, otherwise uses existing `reversePriceMatch()` (validator path).
- `actions/dispenser.js`: added `ORACLE_ADDRESS` parser and validation. Requires `FIAT_CODE` when set; makes `FIAT_AMOUNT` optional when set.
- `actions/deploy.js` and `actions/execute.js`: `getOracleDataForVM()` calls now prefer `actions.hubDb || indexerDb`.
- `sql/stakes.sql`: added `doge_address`, `activation_block`, `deactivation_block` columns with indexes.
- `sql/delegations.sql`: added `activation_block`, `deactivation_block` columns with indexes.
- `sql/dispensers.sql`: added `oracle_address_id` column with index.
- `sql/index_fiats.sql`: added EUR and KRW rows; fixed spelling (Australian, Britain, Brazilian).
- `db.js createStake()` / `setStakeDeactivation()` / `createDelegation()` / `setDelegationDeactivation()`: write and update the new activation/deactivation block columns.
- `db.js createDispenser()` / `getDispenserInfo()`: write and return `oracle_address_id` / `oracle_address`.
- `XChainIndexer.js` constructor, accepts hub DB connection parameters (`hubDbHost`, `hubDbPort`, `hubDbName`, `hubDbUser`, `hubDbPass`). Creates `HubClient` for fire-and-forget pushes to xchain-hub. Creates `HubDbSync` (opt-in) for WebSocket-based local hub DB maintenance.
- `api.js`: added `pushvalidatorrewards` write endpoint with optional `INDEXER_API_KEY` auth. Passes hub DB env vars through to `XChainIndexer`.
- `actions.js`: `Actions` class now exposes `hubDb` and `hubClient` to action instances via the constructor.

## [2.4.0] - 2026-04-07

### Added
- `getPricesInTimeRange()` in `db.js`: queries finalized oracle price snapshots within a time range (newest-first)
- `reversePriceMatch()` in `utility.js`: floor-based reverse price matching for FIAT dispensers against historical oracle snapshots within a 24-hour window
- `FIAT_DISPENSER_PRICE_WINDOW` config (86400 seconds), configurable price matching window for FIAT dispensers
- FIAT-aware dispense logic in `dispense.js`: uses reverse price matching to determine token units for FIAT-priced dispensers

### Fixed
- `createDispenser()` in `db.js`: `data['FIAT']` changed to `data['FIAT_CODE']` so `fiat_id` is stored correctly
- `dispensers.sql`: `fiat_amount` column changed from `BIGINT UNSIGNED` to `VARCHAR(250)` to preserve decimal values (e.g., "0.05")

### Changed
- `findMatchingDispensers()` in `db.js`: FIAT dispensers are now included regardless of `coin_amount` vs `get_amount` comparison; actual matching deferred to `dispense.js`

## [2.3.0] - 2026-04-07

### Added
- `coin` column in `messages` table for cross-chain messaging, identifies the destination address network (BTC, LTC, DOGE)
- COIN field validation in MESSAGE action parser

### Changed
- MESSAGE format strings updated to include COIN field: `VERSION|COIN|DESTINATION|...`
- `createMessage()` stores the COIN value alongside other message fields

## [2.2.2] - 2026-04-07

### Changed
- `MESSAGE_ENCRYPTION_METHODS` config updated to `[1, 2, 3]`: reordered to 1=ECIES, 2=ECDH, 3=AES
- Updated encryption method comment in `message.js` action handler

## [2.2.1] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

### Changed
- README: update features list to reflect all 29 action types, VM integration, hub staking, COINPay, unified gas fees, contract derived addresses, and three block hashes

## [2.2.0] - 2026-04-03

### Added
- VM runtime integration, EXECUTE actions now run contract code in sandboxed V8 isolates via xchain-vm
- Full emission routing, contracts can emit 16 action types (SEND, DESTROY, ISSUE, etc.) processed through existing handlers
- `processEmission()`, `getActionHandler()`, `buildActionParams()` methods in execute.js for routing emitted actions
- Savepoint-based atomicity for VM execution, state changes and emissions roll back together on failure
- `getContractState()`, `createContractState()`, `createContractEmission()` DB methods for VM state persistence
- `createSavepoint()`, `releaseSavepoint()`, `rollbackToSavepoint()` DB methods for nested transaction control
- `deleteContract()` DB method for constructor failure rollback
- `getOracleDataForVM()` and `getCrossChainDataForVM()` stubs (return null until Track B / Phase 4)
- `api_version` column on `contracts` table (default 1) for future gateway versioning
- Deploy-time syntax validation via `vm.validateSyntax()`: rejects invalid code before charging gas
- Deploy-time float usage warnings via `vm.checkFloatWarnings()`
- Contract derived address creation (`C:<CHAIN>:<action_index>`) in deploy.js
- Constructor execution, DEPLOY with CONSTRUCTOR_PARAMS runs `initialize` method through the VM
- Per-block VM compilation cache lifecycle (`beginBlock()`/`endBlock()`) in XChainIndexer.js
- Deterministic block hash derivation from block_index + block_time (until decoder provides real hashes)
- Gas fee recalculation based on actual VM gas usage (not just base gas)
- `emission_params.test.js`: mandatory format validation for all 16 emittable action types

### Changed
- execute.js: replaced TODO block with full VM execution, savepoint atomicity, and emission processing
- deploy.js: added syntax validation, derived address creation, constructor execution, api_version support
- deposit.js: migrated from `contract_balances` table to derived address credits/debits in standard ledger
- withdraw.js: migrated from `contract_balances` solvency check to `getAddressBalances()` on derived address
- actions.js: instantiates XChainVM at startup (graceful fallback if xchain-vm not installed)
- actions.test.js: added VM/staking handler stubs, updated DEPLOY routing test (no longer aliased to ISSUE)

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
- normalizeDataValues() crash on objects with toString overridden to a non-function, now uses safeToString(), falls back to null
- isValidAmountFormat() crash on objects/arrays with broken toString, now uses safeToString(), rejects unconvertible values while still accepting mathjs bignumbers

## [1.9.0] - 2026-04-01

### Added
- Block processing watchdog timeout (5 min), detects deadlocks and infinite loops, rolls back stalled blocks
- Circuit breaker on database connections, opens after 10 consecutive failures, 30s cooldown before retry
- Exponential backoff with jitter on connection retries, prevents thundering herd on database recovery
- Connection pool validation via minDelayValidation (3s), detects stale/half-open connections after network partitions
- withTimeout() utility for promise-based timeout enforcement

### Fixed
- doQuery() now re-throws errors inside ACID transactions instead of silently returning empty results

## [1.8.1] - 2026-04-01

### Fixed
- bcnum() no longer crashes on non-numeric, NaN, or Infinity inputs, returns bignumber(0) as safe fallback
- bcnum() trims whitespace from string inputs before parsing to prevent mathjs DecimalError
- bcdiv() returns bignumber(0) on division by zero instead of returning Infinity
- isInteger() no longer crashes on objects with broken toString, returns false for non-primitive types, supports bignumber objects via toNumber()
- getFormatVersion() no longer crashes on object inputs, returns null; correctly rejects decimal strings like '1.5' instead of truncating to integer
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
