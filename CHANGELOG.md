# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `src/XChainIndexer.js` — the hub config overlay is now kept live by a polling loop instead of being applied only once at startup. The indexer overlays operational params served by the hub (`FEE_PAYMENT_MODE`, `ACTIVATION_DELAY_BLOCKS`, `EXPIRATION_FEE_PER_DAY`, `STAKING`) on top of its local config; previously that overlay ran once at boot, so a governance-committed parameter change did not take effect on a running indexer until the process was restarted — the worst-exposed of the hub's config consumers. (Consensus-critical fee inputs `GAS_SCHEDULE` and `GAS_PRICE` are deliberately excluded from the overlay — see Fixed below.) `_startHubConfigPolling()` now re-fetches `getallconfigs` every `HUB_CONFIG_POLL_INTERVAL_MS` (default 60000) and re-applies the overlay only when the hub's committed PBFT sequence (`seq`) advances past the last applied one, so a steady-state poll is a cheap no-op and an unchanged `seq` never re-applies. Against an older hub that returns the bare config map, `seq` stays `0` and the overlay is never re-applied (matching the prior startup-only behaviour), so the change is backward-compatible. The poll timer is `unref`'d and never keeps the process alive. The merge logic was extracted into `_mergeHubParams()` / `_unwrapHubConfigResponse()` with no change to which params are overlaid.
- `.env.example` — added a configuration template enumerating every environment variable the indexer reads (coin/network, decoder/indexer/hub databases, UTXO-tracker and hub endpoints, API key), with safe regtest/placeholder defaults and inline comments, so operators have a single reference for configuring the service instead of reading the source.
- `src/db.js` — `getActiveValidators()` and `getValidatorsByCapability()` now bound their result sets with `LIMIT ?` (default 1000, overridable via `VALIDATOR_QUERY_LIMIT`) and log a warning when the cap is reached. Both queries previously returned every qualifying validator row with no upper bound. They run on every `CapabilitySnapshot` cache miss and — for `getValidatorsByCapability()` — uncached and in-process inside the `ATTEST` block-processing transaction, so an unexpectedly large validator set could turn a single statement into a latency spike on the block-processing hot path. The cap is well above any realistic federation size; hitting it now surfaces a `console.warn` naming the function and block so operators get early warning that the set is outgrowing the assumption, with `VALIDATOR_QUERY_LIMIT` as the escape hatch. Purely additive — no behaviour change below the cap.
- `src/db.js` — the MariaDB connection pool now sets `queryTimeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000`. Without a query timeout a slow or lock-blocked statement had no upper bound and could hang a pooled connection indefinitely; during a large block storm or schema-lock contention the indexer could stall on the block-processing hot path with no timeout-based recovery. A query now aborts after the configured timeout (30s default, overridable via `DB_QUERY_TIMEOUT`) instead of hanging. Matches the pattern already used by `xchain-hub`.
- `src/api.js` — new `health` JSON-RPC method. `ping` only confirms the HTTP server is up; `health` additionally reports `running`, `synced`, `lastIndexedBlock`, the decoder chain tip and `lag`, and the circuit-breaker state of both the decoder and indexer database connections (`decoderDbCircuit` / `indexerDbCircuit`). The database circuit breaker trips open after repeated connection failures and halts block processing during its cooldown, so an operator polling `ping` after a database restart would see a healthy 200 while the indexer was silently stalled at the open circuit; `health` makes that state observable. Mirrors the decoder's existing `health` endpoint. Purely additive — no existing method is changed.
- `src/api.js` — new `GET /status` REST endpoint. The indexer's quantitative sync state (current indexer block height, decoder chain tip, computed indexer→decoder `lag`, and the `isSynced` flag) was previously reachable only through the `health`/`getlatestblock` JSON-RPC methods, which require a POST carrying a JSON-RPC envelope. Monitoring tools that poll with a plain GET — uptime checks, container liveness/readiness probes, load-balancer health checks — could not consume those, leaving operators to query MariaDB directly to measure lag. `GET /status` returns `{ indexerBlock, decoderBlock, lag, isSynced }` as plain JSON; the indexer block is read fresh from the DB (same source as `health`) so it never reports a stale in-memory counter, and `decoderBlock`/`lag` are `null` until the first poll cycle populates the decoder tip rather than reporting a misleading figure. Covered by `test/smoke/connected/api-status.test.js`. Purely additive — no existing route or method is changed.
- `src/hub_push_queue.js` / `src/sql/pending_hub_pushes.sql` / `src/db.js` / `src/actions/price.js` / `src/XChainIndexer.js` — the two best-effort PRICE pushes to `xchain-hub` (the PRICE v0 validated round via `pushPriceRound` and the PRICE v1 user oracle price via `pushOraclePrice`) are now durable. Both pushes are intentionally fire-and-forget so block processing never blocks on hub latency, but a push that failed because the hub was restarting, overloaded, or network-partitioned was previously logged and discarded. The raw on-chain action is always retained locally in the `prices` table, but the hub never reads that table — so a dropped push permanently removed the row from the hub's `oracle_prices` / `price_snapshots` and, because every distributed indexer mirrors its oracle copy from the hub, from all of them; FIAT dispensers depending on the affected oracle then silently saw a missing price or a stale prior one with no recovery path short of a manual re-push. A failed push is now parked in a new `pending_hub_pushes` table (`enqueueHubPush`), and a background `HubPushQueue` poller drains it with per-row exponential backoff (defaults: 30 s interval/base, 10 min cap, 10 attempts ≈ 30 min before a row is retired to `failed` so the queue stays bounded — all overridable via `HUB_PUSH_RETRY_INTERVAL_MS` / `HUB_PUSH_RETRY_BASE_MS` / `HUB_PUSH_RETRY_MAX_MS` / `HUB_PUSH_MAX_ATTEMPTS`). Replays are safe: the hub's `pushpriceround` dedupes by `round_number` and `pushoracleprice` by `(source_address, source_chain, action_index)`, returning a clean no-op for a row it already holds. The queue methods deliberately draw an independent pooled connection (`_poolQuery`) so the poller, which runs concurrently with block processing on the same `indexerDb`, never attaches operational queue I/O to the open block's ACID transaction. The poller is `unref`'d (never keeps the process alive) and is a no-op when no hub is configured, since nothing enqueues in that case. `pending_hub_pushes` carries the source `action_index` and is included in the reorg rollback table list (`src/rollback.js`), so queued pushes for actions orphaned by a reorg are purged alongside their actions.

### Changed
- `package.json` — aligned the `mariadb` driver to the `^3.5.2` range used across the platform. The driver was previously pinned to `~3.4.5` (a patch-only range, one minor line behind the `xchain-dashboard` host); the caret range now tracks 3.x minor releases consistently with every other service, removing the version drift and the mix of `~`/`^` range operators across the platform. No source changes.
- The Docker image is now built with `npm ci` instead of `npm install`. The committed `package-lock.json` is copied into the build context and `npm ci` installs the exact dependency tree it records, failing the build if the lockfile is out of sync with `package.json` rather than silently resolving newer transitive dependency versions.
- `src/actions/deploy.js` — the contract code-size cap (`MAX_CODE_SIZE`, 64 KiB) is now hoisted to an exported module constant instead of an inline instance literal. No behavior change — the value is identical — but it is now importable, so the cross-service regression suite can assert it has not drifted from the canonical protocol value in `xchain-documentation/protocol/constants.js` (kept equal across the SDK, indexer, and VM).
- `src/actions.js` — the `catch` guarding the optional `xchain-vm` require now logs the caught error alongside the warning, so a load failure shows why the contract engine was unavailable instead of printing only a generic warning.

### Removed
- `package.json` — removed the `fs` dependency (`^0.0.1-security`). That npm package is a no-op security placeholder published only to squat the `fs` name on the registry; Node.js always resolves its built-in `fs` module ahead of any installed package, so the entry was never used by the service's `require('fs')` calls. Dropping it removes a spurious entry from the dependency tree and lockfile. No code change — built-in `fs` resolution is unaffected.

### Fixed
- `src/XChainIndexer.js` — the decoder chain tip exposed to monitoring is now refreshed after every committed block during catch-up instead of being snapshotted once per outer-loop iteration. `lastDecoderBlock` (and the `this.lastDecoderBlock` field read by the `GET /status` REST endpoint, the `health` JSON-RPC method, and the `getlatestblock` JSON-RPC method) was read once at the top of the outer block-processing loop and left frozen for the entire inner catch-up loop. During a large catch-up (e.g. the indexer climbing from 500K toward 600K while the decoder advanced to 610K), the reported decoder tip stayed at its pre-catch-up value while the indexer block advanced, so the computed lag (`decoderBlock - indexerBlock`) shrank to zero and `isSynced` flipped true several seconds before the indexer was actually caught up — a false all-clear with thousands of blocks still unprocessed. The cross-service impact was sharper: `xchain-hub`'s `_resolveBtcLatestBlock` trusts the lag returned by `getlatestblock` to enforce `MAX_INDEXER_LAG_BLOCKS` (default 200), so the false-zero lag let the hub anchor a consensus snapshot on an indexer tip thousands of blocks behind the decoder — exactly the case that guard exists to reject. The inner loop now re-reads the decoder's last block after each successful commit, keeping all three API surfaces and the synced check live throughout catch-up. An indexed last-block lookup is cheap enough to run per block; no schema, API-shape, or `api.js` change is required since those surfaces already read `this.lastDecoderBlock` by reference.
- `src/actions/attest.js` / `src/actions/execute.js` — the `ATTEST v0` (request) handler's deterministic `request_id` verification is now unconditional. The handler re-derives `request_id` as `sha256(tx_hash : contract_index : emitter_position)` and rejects a mismatch, anchoring the on-chain `request_id` to the emission's position so a compromised or buggy VM cannot fabricate one. That check previously fired only when `EMITTER_POSITION` was present in the emission data and silently passed when it was absent — so any code path that omitted the field (a future synthetic ATTEST emitter, a refactor dropping the position argument) would have accepted an arbitrary, unverified `REQUEST_ID`. `EMITTER_POSITION` (and `TX_HASH`) are now treated as required inputs: their absence is a hard validation error (`invalid: EMITTER_POSITION (required for request_id derivation)`) rather than a bypass. `Execute.processEmission()` additionally throws if an `ATTEST` emission is constructed without a position argument, enforcing the invariant at the source before it can reach the handler. Covered by new regression cases in `test/unit/actions/attest.test.js` (rejection when `EMITTER_POSITION` is missing, and on derivation mismatch) and `test/unit/emission_params.test.js` (the `processEmission` throw); the existing happy-path case now supplies a correctly-derived `REQUEST_ID`. No behaviour change on the current production path, where `processEmission` always injects the position.
- `src/XChainIndexer.js` — `GAS_SCHEDULE` and `GAS_PRICE` are no longer applied from the hub-config overlay, closing a consensus-divergence (soft-fork) vector. Both are consensus-critical fee inputs: `GAS_SCHEDULE` sets the `gasUsed` charged on every EXECUTE/DEPLOY/ISSUE/AIRDROP/DIVIDEND/ORDER/SWAP/DISPENSER action and the in-VM `GasTracker` cost per operation, and `GAS_PRICE` multiplies that into the fee debited from the caller (`fee = gasUsed * GAS_PRICE` in `actions/execute.js`, `actions/deploy.js`, `actions/issue.js`). Both feed directly into `contract_executions` rows and block hashes. Because the overlay applies a committed change the moment a node observes it — and different federation nodes poll `getallconfigs` at different wall-clock times, hence different block heights — a governance change to either value opened a window (up to `HUB_CONFIG_POLL_INTERVAL_MS`, default 60 s, plus jitter) in which two honest nodes processed the *same* block with different schedules/prices and produced divergent `gasUsed`, fees, execution rows, and ultimately block hashes. `GAS_SCHEDULE` is removed from `BLOB_PARAMS` and `GAS_PRICE` from `SCALAR_PARAMS`, so both now come solely from the per-chain local defaults (`configs/BTC.js`, `LTC.js`, `DOGE.js`) and may change only via a coordinated node upgrade. This also removes the earlier VM-gas-schedule re-point shim from `_mergeHubParams()`, which only addressed intra-action divergence and is unnecessary once the schedule object is never swapped at runtime. Any future governance mechanism for these values must gate the switch on a protocol-agreed activation block height applied during block processing (a hard-fork-style upgrade), not a live config poll. Covered by regression cases in `test/unit/config.test.js`.
- `src/actions/attest.js` — a valid `ATTEST v1` response carrying a *retryable* status (`no_quorum`, `timeout`, or `provider_error`) no longer closes the request. The response handler mapped every non-`ok` status to `errored` via a binary ternary and unconditionally flipped `attestation_requests.request_status` away from `pending`. Because the top-of-handler replay guard rejects any response to a non-`pending` request (`invalid: REQUEST already <status>`), a single `no_quorum` round permanently closed the request — the responsible set could never run another PBFT round before the deadline, the deadline-expiry `ATTEST v2` synthesis path was skipped (it only fires on still-`pending` rows), and the explorer surfaced a misleading `errored` status over REST/WebSocket. The handler now consults a `RETRYABLE_STATUSES` set: a retryable response is still persisted into `attestation_responses` (for audit) and still suppresses `fulfilled_count`, but leaves `request_status='pending'` and fires no callback, so a later `ok` response can still fulfill the request or the deadline sweep can flip it to `expired`. Only `ok` (→ `fulfilled`) and genuinely terminal failures such as `expired` (→ `errored`) close the request and inject the callback EXECUTE. `allowedStatuses` is `['ok','timeout','no_quorum','provider_error','expired']`; the three retryable members are now handled as retryable and the rest stay terminal. Covered by new regression cases in `test/unit/actions/attest.test.js`.
- `src/hub_db_sync.js` / `src/XChainIndexer.js` — added a block-processing sync barrier for the local `oracle_prices` mirror, closing a consensus gap on FIAT dispenser settlement in distributed deployments (`HUB_DB_SYNC_ENABLED=true`). `HubDbSync` already tracked `priceSyncHeight` (the highest `reference_block` in the local `price_snapshots` copy) and gated BTC block processing on `waitForPriceSyncHeight()`, but `oracle_prices` — mirrored alongside `price_snapshots` and read by `reverseOraclePriceMatch()` for FIAT dispenser settlement — had no equivalent barrier. Two indexers could therefore enter the same block with different `oracle_prices` mirror states; because `getOraclePricesInTimeRange()` selects rows by `effective_at <= blockTime`, each node could read a different set of effective oracle prices and settle the same FIAT dispenser at a different amount, silently forking the ledger. `HubDbSync` now also tracks `oracleSyncTimestamp` (the highest `effective_at` in the local `oracle_prices` copy), refreshes it on bootstrap, on every `oracle_prices` WebSocket insert/delete, and on poll, and exposes `waitForOracleSyncTimestamp(blockTime)`. The block loop awaits it before opening each block's transaction on **every** chain (BTC, LTC, DOGE) — not just BTC like the price barrier — because oracle prices are keyed by wall-clock `effective_at` rather than a chain block height, and FIAT dispensers exist on all chains. Unlike the foundational `price_snapshots` table, `oracle_prices` is optional: a deployment with no FIAT oracles never populates it, so the barrier distinguishes "mirror not yet synced" (wait, with the same timeout-defer-and-retry semantics as the price barrier) from "mirror genuinely holds no oracle prices" (an `oracleBootstrapped` flag → resolve immediately), ensuring non-oracle deployments never stall. The barrier is also a no-op when sync is disabled (single-host, where the local hub DB is the hub itself). Covered by `test/unit/hub_db_sync.test.js`. Behaviour is unchanged for single-host deployments and for distributed deployments that do not use FIAT-denominated dispensers.
- `src/actions/execute.js` / `src/actions/deploy.js` / `src/attestation/providerRegistry.js` — the VM gateway is now given the per-provider attestation deadline windows so a contract's `xchain.attestation.request()` rejects an over-limit `deadlineBlocks` at call time instead of letting it land on-chain and be silently dropped. The VM gateway validated `deadlineBlocks` only against the platform-wide `[1, 100]` cap, but each provider defines its own (possibly narrower) `deadline_window_blocks` — e.g. `http_get` allows 100 while the judge-model `llm` provider allows 20. A contract calling `request('llm', …, { deadlineBlocks: 50 })` therefore passed VM validation (50 ≤ 100), emitted the `ATTEST v0`, and received a `request_id`, but the request then failed the `ProviderRegistry.isDeadlineAllowed()` structural check (50 > 20), never became a `pending` row, was never picked up by the hub, and the contract's callback was never delivered — with no signal back to the contract or its developer. `ProviderRegistry` gains `getDeadlineWindows()` (the single source of truth for the `{ provider_id: deadline_window_blocks }` map), and both VM call sites — contract `EXECUTE` and the constructor run on `DEPLOY` — now pass that map to the VM as `providerDeadlines` in the execution options, so the gateway throws `deadlineBlocks N exceeds the "<provider>" provider window of M blocks` before the emission is ever queued. Requires `xchain-vm` ≥ the companion gateway change that honours `opts.providerDeadlines`; against an older VM that ignores the option the behaviour is unchanged (the request still dead-letters as before), so the two can be deployed in either order. Covered by regression tests in `xchain-vm/test/integration/gateway-attestation.test.js`.
- `src/rollback.js` — the `icons` metadata-cache table is now swept for orphaned rows on reorg. `icons` is keyed by `token_id` and carries no `action_index`/`block_index` of its own, so it appears in neither rollback delete loop, and `src/sql/icons.sql` declares the `token_id`→`tokens.id` relationship only as a comment (no enforced `FOREIGN KEY`), so MariaDB never cascades the delete. When a reorg removed a token row (`tokens` is in `dataTables`), every `icons` row pointing at it was left dangling; a stale orphan makes the icon-fetch pipeline believe an icon already exists for a token that no longer does, suppressing regeneration after the token is re-created on the new chain. `rollback()` now issues `DELETE FROM icons WHERE token_id NOT IN (SELECT id FROM tokens)` immediately after the `dataTables` delete loop (so the orphaned token rows are already gone before the sub-query evaluates) and inside the same atomic transaction as the rest of the rollback. The sweep runs only when the rolled-back range contains actions (the only case that can delete a token), and is a harmless no-op when no tokens were removed. Practical impact is low — `icons` is a derived cache, not consensus state — so no schema migration or enforced FK is added; the runtime sweep alone keeps the cache consistent on existing deployments.
- `src/rollback.js` — a reorg whose lowest rolled-back action had `action_index = 0` skipped the entire action-indexed rollback phase. `firstActionIndex` was initialized to the boolean `false` as a "no actions in range" sentinel and then assigned `Number(rows[0].action_index)`, but every guard tested it for truthiness (`if(firstActionIndex)`), and `Number(0)` is falsy — so when the first surviving action to delete was index 0, none of the guarded work ran: no `dataTables` rows were deleted, contract emissions were not cleared, ATTEST `request_status` rows were not reset, and — most damaging — the hub `retractPriceRange()` call never fired. Orphaned rows then survived in the hub's `oracle_prices` / `price_snapshots` tables and propagated to every indexer mirroring them, so prices that were never finalized on-chain kept being served, diverging from any node that processed the canonical chain. The sentinel is now `null` and all six guards test `firstActionIndex !== null`, so a legitimate `action_index = 0` is processed like any other while a genuinely empty range still skips the phase. Same falsy-guard class as the `attest.js` `CONTRACT_INDEX === 0` fix. One-time recovery: if a deployment already experienced such a reorg before this fix, flush the stale hub rows once via the price-reorg reconciliation (`pushpricereorg`) with `from_action_index=0` for each affected chain before resuming indexing (documented inline at the retraction call site).
- `src/api.js` / `src/db.js` — the `getcapabilityvalidators` federation RPC returned `{ count: 0, validators: [] }` for a capability absent from this indexer's `STAKING.CAPABILITIES` config, making a misconfigured/unknown capability indistinguishable from one that legitimately has no qualified validators at the requested block. During a capability rollout where an indexer's config lags the hub's, every attestation request for the new capability silently produced an empty snapshot and was dropped with no operator-visible signal. The handler now consults a new `isCapabilityConfigured()` helper and returns `{ error: 'capability not configured: <name>' }` for an unknown capability — the hub's `CapabilitySnapshot.getSnapshot()` already maps a `result.error` to a null snapshot (degraded mode), so the behaviour is unchanged for the consumer except that the misconfiguration now surfaces as an error instead of a silent miss. `getValidatorsByCapability()` is unchanged and still returns an array, so the internal callers (`actions/attest.js`, `rollback.js`, the repair script) that treat its result as a list are unaffected.
- `src/utility.js` — `validateNativeCoinFee()`, the acceptance gate that decides whether a native-coin fee output is large enough, computed entirely in IEEE-754 floating point (`parseFloat` plus bare `* / <`). `fees['AMOUNT']` is a mathjs bignumber whose `.toString()` can emit scientific notation (e.g. `"1e-7"`), and a double cannot represent 8-decimal satoshi fractions exactly, so the paid-vs-expected comparison could drift by several ULPs and reject a sufficient fee or pass an insufficient one — and because two nodes can coerce the same value differently, that drift was a consensus hazard on the fee gate. The whole computation now runs through the platform bignumber helpers (`bcnum`/`bcmul`/`bcdiv`/`bclt`/`bclte`/`bcformat`): USD intermediates are carried at 18-decimal precision and the native-coin amount, tolerance band, and final comparison resolve at satoshi (8-decimal) precision, making the gate exact and deterministic across nodes. No change to the tolerance semantics or the returned field shapes.
- `src/actions/attest.js` — the `ATTEST v0` validator rejected any request whose `CONTRACT_INDEX` was falsy (`if(data['CONTRACT_INDEX'])`), which treated `CONTRACT_INDEX === 0` — the first contract in a block — as a missing emitter and failed the request with `invalid: CONTRACT_INDEX (missing emitter)` before the `request_id` was ever re-derived. The guard now uses `data['CONTRACT_INDEX'] != null`, so a legitimate index-0 emitter is validated against `getContract()` like any other while genuinely absent values are still rejected. Pairs with the xchain-vm fix (≥ 1.11.11) that preserves index 0 in the `request_id` preimage; both must ship together, since a fleet running mixed versions would disagree on the `request_id` for any contract at index 0.
- `src/db.js` / `src/api.js` — `getpendingattestation_requests` now accepts an optional keyset cursor (`after_block_index` / `after_action_index`) so a poller can page through the full set of pending attestation requests instead of being limited to the oldest `limit` rows. `getPendingAttestationRequests()` appends `AND (block_index > ? OR (block_index = ? AND action_index > ?))` to its WHERE clause when the cursor is supplied; ordering and the existing `limit` behaviour are unchanged, and the cursor is honoured only when both components are finite numbers (otherwise a full oldest-first page is returned, preserving the previous contract). Without this, any consumer that re-fetched the oldest `limit` rows each cycle could never see a newer request while ≥ `limit` older requests stayed pending — a starvation/priority-inversion hazard once the pending backlog exceeded the page size. Companion to the hub poller change (xchain-hub ≥ 2.2.11) that sends the cursor and pages forward across poll cycles.
- `scripts/repair-validator-stats.js` — the standalone `attest_validator_stats` repair tool queried tables that do not exist in the deployed schema (`attestation_validator_signatures`, `attestation_responses`, `attestation_requests`), a leftover of an earlier split-table design that was never reconciled when the unified `attests` table (one row per ATTEST action, validator signatures inlined as the `validator_signatures` JSON column on v1 response rows) was adopted. The script therefore failed on its first query with `Table '…attestation_validator_signatures' doesn't exist`, leaving an operator with no working recovery path for a deployment whose `attest_validator_stats` counters were overcounted by a pre-fix reorg. It is rewritten to mirror `Rollback._recomputeAttestationValidatorStats()` against the real schema: `fulfilled_count` aggregates the `validator_signatures` array on `attests` v1 rows with `response_status='ok'`, and `missed_count` reproduces the deterministic responsible-set expansion over the surviving v0 request rows that actually expired — `deadline_block < tip` (the expiry sweep occurred) AND no surviving *valid* v1 response — deriving eligibility from surviving rows rather than the reorg-stale `request_status`. The whole `attest_validator_stats` table is then rebuilt in one transaction. CLI wiring, env-var contract, and progress logging are unchanged; the script remains standalone (no import from `rollback.js`).
- Regenerated `package-lock.json` so it captures the transitive dependencies of the `file:`-linked `xchain-vm` library (`isolated-vm`, `acorn`, `acorn-walk`, `astring`). The lockfile previously recorded only the `xchain-vm` link itself, so an exact `npm ci` install would have omitted xchain-vm's own runtime dependencies; the `npm install` build had been masking this by re-resolving them at build time. (Required for the `npm ci` build above to produce a working image.)
- `src/sql/events.sql` — added a composite index `code_id` on `events (code, id)`. Reorg detection runs `SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1` against both the decoder and indexer `events` tables once per block cycle. With no index on `code`, MariaDB had to full-scan the whole `events` table to evaluate the `WHERE` filter before applying the `ORDER BY id DESC LIMIT 1` — a cost that grows linearly as the table accumulates hundreds of thousands of rows over months of mainnet operation. The composite `(code, id)` index satisfies both the filter and the descending-id ordering in a single backward index scan, with no separate sort step. Schema-source change only; existing deployments need a one-time `ALTER TABLE events ADD INDEX code_id (code, id)`.
- `src/sql/balances.sql` — dropped the now-redundant single-column `address_id` index on the `balances` table, leaving the composite `UNIQUE` index `addr_tick (address_id, tick_id)` to cover it (a single-column index on a composite's leading column is wholly redundant, so it was pure write overhead). Every balance mutation in `db.js` filters on `WHERE address_id=? AND tick_id=?`, and the hot path upserts via `INSERT ... ON DUPLICATE KEY UPDATE` against the composite unique key — a path hit once per SEND/ISSUE/BURN/SWEEP/dispense. The single-column `tick_id` index is kept; it serves `WHERE tick_id=?` lookups (supply sums, the explorer holders count) that the composite cannot. A migration for existing deployments is provided at `src/sql/migrations/add_balances_composite_index.sql` — the schema-drift reconciler only manages columns, not indexes, so existing databases need this one-time `ALTER TABLE`, which also adds the composite on any database created before it was introduced.
- `src/db.js` — `sweepCompletedCooldowns()` now appends `ORDER BY action_index ASC` to both completed-cooldown SELECTs (capability unstakes from `unstakes`, contract unstakes from `contract_unstakes`). Without an explicit ordering, MariaDB could return the matching rows in any order, so when several stakers' cooldowns expire on the same block their completion credits were written in a non-deterministic sequence — differing row order across indexer instances and adding avoidable noise to log/replay diffing between nodes. The added clause makes the sweep emit rows in the same `action_index ASC` order that downstream consumers (the ledger-hash re-read in `getBlockHashes`) already enforce. Purely additive ordering on an indexed column; no schema, logic, or call-site change, and no effect on aggregated balances (a pure SUM) or block hashes (already deterministic).

### Security
- `src/utility.js` / `package.json` — removed the unused wall-clock `getCurrentTime()` helper from the shared `Utility` instance and added a `check:consensus-time` build guard against its reintroduction in block-processing code. `getCurrentTime()` returned `Date.now()`-derived seconds and lived on the `this.util` object reachable by every action handler, yet was never called — block processing correctly derives the current time from the deterministic block timestamp (`block_time` / `data['BLOCK_TIME']`). The danger was structural rather than active: any future handler that reached for `this.util.getCurrentTime()` instead of the block timestamp would have written a non-deterministic wall-clock value into consensus state, and since two instances observe different `Date.now()` values even nanoseconds apart, the resulting ledger records would diverge silently with no error. The method is deleted, and the new `check:consensus-time` npm script (wired into `test:nodb` and `test:full`) greps `src/actions/` and fails the build if any `getCurrentTime(` call reappears. `getDefaultExpiration(block_time)` and the other block-timestamp-parameterised helpers are unchanged.
- `src/api.js` — the four federation read RPC methods (`getownstake`, `getactivevalidators`, `getcapabilityvalidators`, `getpendingattestation_requests`) now require the `INDEXER_API_KEY` via the `x-api-key` header when a key is configured, matching the existing gate on the `pushvalidatorrewards` write method. Previously only write methods were gated, leaving these reads publicly accessible to anyone with network access to the indexer port: the complete staked validator set (pubkeys + amounts) could be enumerated, and the pending attestation work queue — including the raw provider URLs queued for external `http_get` resolution — could be dumped without credentials. The attestation-queue exposure is the sharper risk: an observer who pre-fetches a queued URL and poisons a CDN/DNS cache before validators resolve it could skew the response that reaches PBFT consensus. A new `FEDERATION_READ_METHODS` set fronts the same middleware check as `WRITE_METHODS`; when no key is configured the methods remain open (unchanged single-host behaviour). Hub callers (≥ 2.2.9) attach the key from `BTC_INDEXER_API_KEY`. The longer-term Ed25519 hub-request-signing path remains desirable but is not required by this gate.

### Added
- `migrations/20260529_dispensers_add_ownership_oracle_price.sql` — operator-runnable migration for the four columns added to the `dispensers` table in `src/sql/dispensers.sql`: `give_ownership TINYINT(1) NOT NULL DEFAULT 0` (token-ownership dispensers) and the oracle-price trio `fiat_id`, `fiat_amount`, `oracle_address_id` (nullable). `verifyTables()` auto-adds these on startup against an indexer-created DB, but that reconciliation never runs on replica/validator databases bootstrapped from a SQL snapshot — so the first DISPENSER action (`createDispenser()` names all four columns in its INSERT) and any streamed `dispensers` snapshot row would fail with `Unknown column`. This idempotent migration (`ADD COLUMN IF NOT EXISTS` / `ADD INDEX IF NOT EXISTS`) adds the four columns plus the three indexes the canonical source declares (`give_ownership`, `fiat_id`, `oracle_address_id`), bringing any pre-change database fully in line. Column types/nullability mirror `src/sql/dispensers.sql` exactly. The bootstrap SQL dumps (`XChain_Indexer.sql`, `tmp/XChain_Indexer.sql`) were also regenerated to match (`fiat_amount` corrected from `BIGINT UNSIGNED` to `VARCHAR(250)`).
- `test/unit/rollback-coverage.test.js` — a rollback-coverage guard. It derives the set of tables the indexer owns from `src/sql/*.sql` (the same source `verifyTables()` uses) and asserts every one is handled by `Rollback` on reorg: in `dataTables` (action_index-keyed delete), `blockTables` (block_index-keyed delete), recomputed during rollback, special-cased, or explicitly exempt with a reason. Also guards against stale references in the rollback lists and a table appearing in both lists. New tables have previously shipped before being wired into the rollback set (e.g. `gated_files` had a 6-day window); this fails at CI time when a table is left unhandled instead of surfacing as silent post-reorg divergence on mainnet.
- `scripts/repair-validator-stats.js` — one-off operator tool that rebuilds the entire `attest_validator_stats` table from the surviving ledger (`fulfilled_count` from the verified signatures on `STATUS='ok'` responses; `missed_count` by reproducing the deterministic responsible set for each expired request; `slashed_count`/`quality_score` are Phase 4 and recompute to 0). Idempotent and safe to run on a healthy DB; intended for any deployment that processed a chain reorg before the rollback fix below landed and therefore carries overcounted aggregates. Reads the same `INDEXER_DB_*` / `INDEXER_COIN` / `INDEXER_NETWORK` environment the indexer uses and prints a summary of rows recomputed.
- `test/unit/rollback-attestation-stats.test.js` — behavioral regression for the `attestation_validator_stats` recompute. Drives `Rollback._recomputeAttestationValidatorStats()` against an in-memory model of the source tables and asserts the rebuilt rows equal a fresh aggregation: a validator touched in the orphaned range is recomputed to its surviving `fulfilled_count`/`missed_count` (discarding orphaned increments), a validator untouched in that range is left byte-for-byte intact, and a validator whose entire history was orphaned disappears rather than lingering. Locks in the precise invariant a reorg must preserve so the path can't silently revert to append-monotone behaviour and reintroduce cross-operator counter divergence ahead of Phase 4 slashing.
- `migrations/20260529_sweeps_restructure_flags.sql` — operator-runnable migration for the SWEEP three-flag restructure. The `sweeps` table's single `escrows` flag was replaced by three independent per-primitive flags (`orders`, `swaps`, `dispensers`) in `src/sql/sweeps.sql`. `verifyTables()` auto-adds the three nullable columns on startup but never drops the now-unused `escrows` column, and that reconciliation does not run on replica/validator databases bootstrapped from a SQL snapshot. This idempotent migration (`IF NOT EXISTS` / `IF EXISTS`) adds the three flags and drops `escrows`, bringing any pre-restructure database fully in line. Column types mirror `src/sql/sweeps.sql` exactly (nullable `BIGINT UNSIGNED`, no DEFAULT).
- `migrations/20260529_markets_unique_pair.sql` — operator-runnable migration adding the `uq_markets_pair (tick1_id, tick2_id)` unique key now declared in `src/sql/markets.sql`. The `markets` table (derived DEX summary data, one row per traded pair) previously had no uniqueness guarantee on the pair, so two inserts that raced past `createMarket()`'s existence check could both create a row for the same pair; `getMarketInfo()` would then resolve to one arbitrarily and the `AUTO_INCREMENT` id assigned to a pair was non-deterministic across nodes. `verifyTables()` reconciles missing columns on startup but never adds indexes, and does not run on replica/validator databases bootstrapped from a SQL snapshot, so the constraint has to be applied out of band. The migration first deletes existing duplicate pairs keeping the lowest `id`, then adds the unique key (`ADD UNIQUE INDEX IF NOT EXISTS`), making it safe to re-run. See the `### Fixed` entry below for the matching code changes.

### Fixed
- `src/utility.js` / `src/db.js` / `src/sql/markets.sql` — `processMarketUpdates` now assigns a stable `market_id` to each traded pair across nodes. The function fanned every market pair for a block out concurrently with `Promise.all(markets.map(...))`; each iteration calls `createMarket()`, which inserts a new `markets` row on first sight of a pair, so the row's `AUTO_INCREMENT` id was assigned in DB-completion order rather than a logical order. Two instances processing the same block could therefore give the same pair different `market_id` values depending on connection scheduling — a divergence that surfaces through the explorer REST/WebSocket API (any join on `markets.id`) and is replicated to every validator. The fan-out is replaced with a sequential `for...of` loop so inserts happen one at a time in pair-iteration order; that order is itself deterministic because `getMarkets` builds the list from queries ordered by the consensus-assigned `action_index`, with a first-seen dedup that preserves order. Paired with this, `createMarket`'s insert is hardened to `INSERT INTO markets (...) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` and `src/sql/markets.sql` gains a `UNIQUE INDEX uq_markets_pair (tick1_id, tick2_id)`, so even if two inserts race past the existence check the database collapses them to a single row and returns the existing id rather than creating a duplicate. See the `migrations/20260529_markets_unique_pair.sql` entry above for applying the unique key to pre-existing databases.
- `src/XChainIndexer.js` / `src/hub_db_sync.js` — added a price-sync barrier so a BTC indexer does not process a block until its local `price_snapshots` mirror has caught up to that block height, closing a cross-operator ledger-divergence race in native-coin fee validation. `validateNativeCoinFee` (used by ISSUE, DEPLOY, EXECUTE, ORDER, SWAP, DISPENSER, CALLBACK, DIVIDEND, SWEEP, AIRDROP) reads the latest finalized price round at or before the block height from the locally-synced mirror, which `HubDbSync` populates asynchronously (30s poll, or WebSocket with reconnect gaps). Two operators processing the same block could therefore hold different rounds under `reference_block <= blockIndex`, compute a different expected native-coin fee threshold, accept/reject the same fee payment differently, and diverge `ledger_hash`. `HubDbSync` now tracks `priceSyncHeight` (the highest finalized `reference_block` present locally), refreshed after every successful sync of the table (bootstrap, poll, live `row:inserted`, and reorg `row:deleted`), and exposes `waitForPriceSyncHeight(blockHeight, timeoutMs)` which resolves once the mirror covers the block or rejects on timeout. `XChainIndexer` awaits this barrier before opening the per-block transaction; on timeout it defers the block (leaving `lastIndexerBlock` un-advanced for retry) rather than validating fees against a stale copy. Timeout is configurable via `HUB_PRICE_SYNC_TIMEOUT_MS` (default 60000). Price rounds are anchored to BTC block heights (`reference_chain='BTC'`), so the height comparison is only meaningful on the BTC chain; the barrier is scoped to BTC indexers and is a no-op when hub-db sync is disabled (single-host, where the local hub DB is the hub itself). Covered by `test/unit/hub_db_sync.test.js`.
- `src/actions/dividend.js` — `DIVIDEND` no longer over-charges `SOURCE` for holders who receive nothing. When `DIVIDEND_TICK` is non-divisible (`DECIMALS=0`) and a `TICK` holder carries a fractional balance, each holder's share is `bcmul(balance, AMOUNT, DECIMALS)`, which rounds to `0` for any holder whose computed share is below the smallest representable unit. The handler still wrote those zero-amount addresses into the `recipients` map, and both fee paths count `Object.keys(recipients).length` with no filter — the unified gas schedule (`DIVIDEND_PER_RECIPIENT`) and the legacy `db_hits += recipients.length * 2` model — so `SOURCE` paid a per-recipient fee for every holder receiving no `DIVIDEND_TICK`. For a widely-distributed token the overcharge scaled linearly with the number of zero-credit holders, with no corresponding token movement; because fee debits are consensus-critical and irreversible on-chain this is a real economic defect, not just an estimate. The fix computes each share first and only writes the entry when `share != 0`, so zero-amount holders never enter `recipients` — fixing both fee-counting paths and the downstream DEBIT/payout loops in a single guard. Spec clarified in `xchain-documentation/protocol/actions/DIVIDEND.md` to state that such holders are excluded from the recipient list and therefore do not count toward the per-recipient fee. Covered by the existing `test/unit/actions/dividend.test.js` suite (proportional-payout, source-exclusion, and block-list cases all still pass).
- `src/db.js` / `src/api.js` — `getValidatorsByCapability` (and the `getcapabilityvalidators` RPC that fronts it) now accept a caller-supplied `min_stake` threshold and prefer it over this indexer's local `STAKING.CAPABILITIES.<cap>.MIN_STAKE` config. Previously the `HAVING total >= MIN_STAKE` filter was always sourced from the indexer's own config file, so the validator-set snapshot returned to a hub depended on *that indexer's* configured threshold. In a multi-hub federation pointing at independently-operated indexers, drifting (or mid-round-updated) `MIN_STAKE` values produced different validator sets for the same `(capability, block_index)` — different `N`, different PBFT quorum thresholds — silently breaking the cross-hub determinism the snapshot RPC is documented to guarantee, with deadlock or false quorum the only symptom. The hub (≥ 2.2.7) now passes its own governance-sourced threshold as `min_stake`, making the validator set a function of on-chain stake state plus the hub's governance view alone. The RPC handler validates and forwards the field to the db method; when absent (non-hub callers, or hubs whose capability registry isn't ready yet) the local config is used exactly as before, so the change is fully backward-compatible. A `0` override is honoured as a real threshold rather than treated as a falsy fallback. New unit coverage in `test/unit/db.test.js` (db method: override-wins, string coercion, local fallback, `0`-is-real) and the hub's `test/unit/CapabilitySnapshot.test.js` (payload includes/omits `min_stake` correctly).
- `src/db.js` / `src/api.js` — extended the caller-supplied `MIN_STAKE` override to the two sibling capability-query methods (`getActiveCapabilityCount`, `hasCapability`) so all three share one threshold-resolution contract (override-wins, local-config fallback, `0`-is-real). These two are only called by the indexer's own block-processing (PRICE/ATTEST quorum count + per-validator eligibility), which deliberately keeps passing no override and so reads local config exactly as before — the parameter is added for API symmetry and to give a future hub-driven caller the same single-source-of-truth path the validator-set snapshot RPC already has. The internal call sites are intentionally left unchanged: injecting a live hub value into deterministic, consensus-critical ledger processing would itself be a non-determinism hazard, so threshold sourcing for those paths remains the indexer's consensus config (the cross-hub propagation of governance-voted thresholds is a separate, larger change). The `getcapabilityvalidators` RPC also now logs the applied threshold and its source (caller-supplied vs local-config) plus the resulting validator count on every snapshot, so a hub↔indexer `MIN_STAKE` mismatch is visible in the indexer log instead of surfacing only as a silently-divergent quorum `N`. New unit coverage in `test/unit/db.test.js` for both methods (override-wins, string coercion, local fallback, `0`-is-real).
- `src/hub_db_sync.js` — the WebSocket reconnect path now re-bootstraps both mirrored hub tables after re-establishing the connection. Previously `_scheduleReconnect()` only re-opened the socket; the live subscription delivers only rows broadcast after resubscribe, so any `price_snapshots` or `oracle_prices` rows the hub inserted during the outage window were never replayed and the local mirror silently diverged from hub state for every block processed after the gap. The reconnect callback now calls `_bootstrapTable('price_snapshots')` and `_bootstrapTable('oracle_prices')` (each in its own try/catch) exactly as the initial connect and polling-fallback paths already do; `_bootstrapTable` uses the local max-ID as `since_id`, so it fetches only genuinely-missing rows and re-receives stay harmless under `_applyRow`'s `INSERT IGNORE`. The initial `start()` path is unchanged and does not double-bootstrap.
- `src/rollback.js` — `attestation_requests.request_status` is now reset to `'pending'` on reorg when the response that resolved it is orphaned. The forward path (`actions/attest.js` `_parseResponse`) flips a request from `'pending'` to `'fulfilled'`/`'errored'` via a direct UPDATE on the request row — but that row was created in an earlier block (`action_index < firstActionIndex`) and so survives the bulk delete, while the ATTEST v1 response row (in the orphaned range) is deleted. A reorg that orphaned a response block therefore left the originating request stuck non-`'pending'`: on re-application the response was rejected as already-resolved (the `request_status !== 'pending'` guard), the contract's VM callback never fired, and the deadline-expiry sweep (`getExpiredAttestationRequests`, which only scans `'pending'`) never re-armed — the attestation was silently and permanently broken on the post-reorg chain with no automatic recovery. `rollback()` now issues a companion `UPDATE attestation_requests ar JOIN attestation_responses resp ON resp.request_id = ar.request_id SET ar.request_status = 'pending' WHERE resp.action_index >= ?` immediately before the data-table delete loop, so the join to the soon-to-be-deleted response rows still resolves; requests whose own row is in the orphaned range are reset harmlessly before being deleted. New regression tests in `test/unit/rollback.test.js` assert the reset is issued, joins on `request_id`, is parameterised with `firstActionIndex`, runs before the `attestation_responses` DELETE, and is skipped when the rolled-back range is empty. (The expiry path — ATTEST v2 flipping `request_status` to `'expired'` — has no response row to join and is not yet reset on reorg; the `attestation_validator_stats` recompute below intentionally derives eligibility from surviving rows rather than `request_status` for exactly this reason.)
- `src/rollback.js` — `attestation_validator_stats` is now re-derived on reorg. The table is a monotone per-(validator, provider) aggregate (`fulfilled_count` / `missed_count` / `slashed_count`) with no `action_index` or block FK, so neither generic delete loop touched it and a chain reorg left its counters permanently overcounted for any validator that participated in an orphaned round — recoverable only by a from-genesis replay. `rollback()` now drops the rows whose most-recent touch falls in the orphaned block range and rebuilds those exact pairs from surviving data: `fulfilled_count` from `attestation_validator_signatures` joined to `STATUS='ok'` responses, and `missed_count` by replaying the deterministic responsible-set selection (`SHA256(request_id || pubkey)` over the capability snapshot at the request's block, top `REDUNDANCY`) for each surviving request that would have expired before the new tip — eligibility derived from surviving rows, not the in-place `request_status` (which a reorg does not reset). The result matches a clean replay to the rollback target. `slashed_count`/`quality_score` re-derive to 0 (Phase 4 unshipped). This needs to land before Phase 4 `quality_score` drives live responsible-set selection, or reorged nodes would silently bias attestation consensus. `rollback-coverage.test.js` reclassifies the table from exempt to recomputed.
- `src/XChainIndexer.js` / `src/db.js` — consecutive chain reorganizations are now detected by event identity instead of block-height magnitude, closing a silent ledger-divergence window. The reorg-detection loop compared the decoder's latest reorg block height against the indexer's last-recorded reorg block (`lastDecoderReorgBlock < lastIndexerReorgBlock`); once the indexer had recorded a reorg at block N, any later reorg at a higher block M > N evaluated `M < N = false` and was silently skipped. Because block heights increase monotonically, every reorg after the first was permanently undetected — the indexer never rolled back and its MariaDB drifted from canonical chain state (balances, ownership, ACTION history) for all blocks past the missed reorg, with no error signal to explorer/hub/SDK consumers. Detection now keys on the decoder's reorg `events.id` (identity), not block height: `db.getLatestReorg()` returns `{ id, block_index }` for the decoder's most-recent reorg event, `createReorg(block_index, decoder_event_id)` persists that decoder event id alongside the block in the indexer's own REORG record, and `getLastProcessedReorgId()` reads it back so each cycle compares `decoderReorg.id !== lastProcessedReorgId`. This catches every new reorg regardless of its block height relative to prior ones. The indexer's REORG `data` column now stores a `{block_index, decoder_event_id}` JSON payload; `getBlockIndex('indexer','reorg')` parses both the new JSON form and legacy bare-number rows. New regression coverage in `test/unit/db.test.js` (getLatestReorg shape, createReorg persistence, getLastProcessedReorgId readback + legacy fallback, and the explicit second-higher-block reorg the old magnitude compare missed); the integration and perf reorg harnesses (`test/integration/setup/indexer-launcher.js`, `test/perf/setup/instrumented-processor.js`) were updated to mirror the identity check.
- `src/db.js` — `getPendingAttestationRequests` now returns the full `attestation_requests` row. The SELECT named only 11 of the table's 14 columns, omitting `gas_escrow` (XCHAIN reserved for the callback `EXECUTE`), `fee_payer_id` (the address billed for callback gas), and `status_id`. The result is published over the indexer's pending-requests endpoint and consumed by the hub's attestation round/consensus code, which carries the row whole into per-request round state. No current consumer reads the three fields, so there is no live defect — but once callback gas accounting is wired up (`gas_escrow` is presently a hardcoded `'0'` stub), any consumer reading `request.gas_escrow` off the round state would have silently received `undefined` and constructed a zero-escrow callback transaction. The three columns are added to the SELECT; `fee_payer_id` and `status_id` (both `BIGINT UNSIGNED`) join the existing BigInt→Number serialization pass, and `gas_escrow` (`VARCHAR`) needs no conversion. Purely additive and backward-compatible — existing consumers ignore fields they don't read.

## [2.7.9] - 2026-05-29

### Fixed
- `src/utility.js`, `src/actions/dispense.js` — replaced the dispenser unit-count flooring with a new `bcfloor()` helper that floors in bignumber space, fixing a precision bug that survived two prior attempts. The three sites (`reverseOraclePriceMatch`, `reversePriceMatch`, and the non-FIAT multiplier in `dispense.js`) compute a unit count from a 64-decimal `bcdiv()` result and must floor it to a JS integer. `Math.floor(Number(bignumber))` (the 2.7.8 state) coerces through IEEE 754 first, so a 64-decimal residual like `2.99999…964` floors to the wrong integer; the earlier `parseInt(bignumber)` attempt instead misread `bcdiv`'s exponential string form (`parseInt("3e-8") === 3`, over-dispensing for dust). `bcfloor(num)` does `bcnum(num).floor().toNumber()` — `bcnum` parses the exponential string correctly into a bignumber, and decimal.js's native `.floor()` truncates the true value without a float64 round-trip. It deliberately avoids `mathjs.floor()`, which is configured with a default precision that rounds `137.99999999999` up to `138`. New `bcfloor()` unit tests in `test/unit/utility.test.js` lock in the float64-residual, exponential-dust, sat-divisor, and `mathjs.floor()`-precision cases. This alters a computed/indexed value, so it is consensus-relevant: safe to land pre-launch (no chain history to diverge), but post-launch an equivalent change would need block-gating via `protocol_changes.js`.

## [2.7.8] - 2026-05-29

### Fixed
- `src/utility.js`, `src/actions/dispense.js` — fixed FIAT/COINPAY dispenser unit calculation that could dispense tokens for a dust payment. `bcdiv()` returns a mathjs BigNumber whose string form switches to exponential notation below ~1e-7 (e.g. `"3e-8"`); a prior edit floored it with `parseInt()`, and `parseInt("3e-8")` is `3`, not `0`, so a payment whose true unit count rounds to zero cleared the `units >= 1` affordability gate in `reverseOraclePriceMatch`/`reversePriceMatch` and dispensed tokens (symmetrically, `parseInt("2e+21")` is `2`, under-crediting very large buys). Reverted to `Math.floor(Number(...))`, which parses exponential strings correctly, and made the non-FIAT multiplier in `dispense.js` wrap `Number()` explicitly for the same reason. Also raised the division precision on the two COINPAY unit calcs from 18 to 64 decimals (matching the non-FIAT path) to reduce off-by-one truncation from chained-division rounding. This alters a computed/indexed value, so it is consensus-relevant: safe to land pre-launch (no chain history to diverge), but post-launch an equivalent change would need block-gating via `protocol_changes.js`.

## [2.7.7] - 2026-05-29

### Fixed
- `src/db.js` — three expiration/obligation gather queries lacked an `ORDER BY`, making their row order non-deterministic across instances. `processExpirations` iterates the result and emits credits/debits via `processAction`, each allocating a fresh `AUTO_INCREMENT` `action_index`; `getBlockHashes` then orders credits/debits by `action_index ASC` to derive the per-block ledger hash. When two or more items expired on the same block, two honest indexers could process them in different orders, assign `action_index` values differently, and derive divergent ledger hashes for that block — a consensus split. Added `ORDER BY co.action_index ASC` to `getExpiredCoinpayObligations` and `getPendingCoinpayObligationsByOrder`, and `ORDER BY action_index ASC` to the `getExpiredItems` UNION (ordered by the output column name, since the union erases table aliases). `findCancelledDispensers` already ordered by `m.action_index ASC` and was left unchanged.

### Added
- `test/integration/scenarios/07-expiry-ordering.test.js` — seeds several coinpay obligations whose `action_index` values are inserted in descending order, all expiring on the same block, and asserts both `getExpiredCoinpayObligations` and `getPendingCoinpayObligationsByOrder` return them strictly ascending by `action_index`. Guards against the `ORDER BY` being dropped (without it the query returns the rows descending and the test fails).

## [2.7.6] - 2026-05-29

### Fixed
- `src/configs/LTC.js`, `src/configs/DOGE.js` — added the `STAKING` config block that BTC already declared, so all three chain configs expose a well-formed `STAKING` object instead of `undefined` on LTC/DOGE. `CAPABILITIES` is an empty array on both chains because capability staking is BTC-only at the protocol level; the comment now documents that intent in the config itself. Previously, code reading `config['STAKING']` had to null-guard per call site, and the BTC-only invariant was enforced only by scattered per-handler coin checks — any future handler or utility that read `config['STAKING']` without a guard would have thrown on LTC/DOGE indexers. The stub keeps the practical effect unchanged (the `db.js` capability lookups key into `CAPABILITIES` and find nothing) while making the schema uniform across chains.

## [2.7.5] - 2026-05-29

### Fixed
- `src/rollback.js` — `price_snapshots` was not rolled back on reorg. The table anchors each consensus price round to a block via `reference_block` (its equivalent of `block_index`), so it fell outside the generic `blockTables` delete loop, which keys on `block_index`. After a reorg, snapshot rows tied to orphaned blocks survived with `status='finalized'`; because a from-genesis replay on the post-reorg chain never re-produces those rounds (the triggering blocks no longer exist), replaying nodes and surviving nodes diverged permanently on this table at any snapshot round boundary touched by the reorg. Added a dedicated `DELETE FROM price_snapshots WHERE reference_block >= ?` inside the rollback transaction, alongside the other per-table deletes, so it participates in the same atomicity guarantee.
- `test/unit/rollback-coverage.test.js` — corrected the coverage classification for `price_snapshots`. It had been listed in `ROLLBACK_EXEMPT` with the justification that the indexer has no write path to it, which was wrong (`OracleConsensus` writes consensus rounds to it). Moved it to `SPECIAL_CASE` to reflect the new bespoke `reference_block` delete, so the coverage guard now asserts the table is handled on reorg.

## [2.7.4] - 2026-05-28

### Fixed
- `src/rollback.js` — the reorg read/pre-scan phase collected no affected addresses or tickers for the contract-staking tables (`contract_stakes`, `contract_unstakes`, `contract_delegations`). Their rows were deleted from `dataTables` on reorg, but because no pre-scan gathered the staking addresses/tickers, the post-rollback `updateBalances`/`updateTokens` recompute could undercount staking positions whose balances should be refreshed. Added a pre-scan branch (mirroring the `credits`/`debits`/`escrows` pattern, joined to `index_addresses` on `source_id` and `index_tickers` on `tick_id`) that gathers the staking address and ticker for each of the three tables. Added a regression test asserting the pre-scan SELECTs fire for all three tables and that the collected addresses/tickers reach the post-rollback recompute.

## [2.7.3] - 2026-05-28

### Fixed
- `src/configs/DOGE.js`, `src/configs/LTC.js` — corrected `FEE_PAYMENT_MODE` from `'xchain'` to `'native'` on both chains. The inline comment on each line already documented the intended behaviour (`'native'` only — no XCHAIN balance deduction), but the value contradicted it. The key is currently informational only — fee payment mode is detected implicitly at runtime by `detectFeePaymentMode()` in `src/utility.js` from the transaction's fee output and coin name, so this had no behavioural effect today — but a future change making detection config-driven would have silently applied the wrong (`'xchain'`) mode on DOGE/LTC, corrupting fee accounting on both chains. Value now mirrors the implicit per-chain behaviour.

## [2.7.2] - 2026-05-28

### Security
- `src/configs/LTC.js`, `src/configs/DOGE.js` — added the missing `VM_ATTEST_REQUEST: 5000` entry to each chain's `GAS_SCHEDULE`. BTC already declared it, but LTC and DOGE did not, so an `ATTEST v0` (off-chain data request) emission on those chains looked up an undefined gas cost. Downstream this charged zero gas, letting any actor emit attestation requests for free and flood the federation request queue on LTC/DOGE. The value matches BTC's; gas units are chain-agnostic so no chain-specific tuning is needed.

## [2.7.1] - 2026-05-28

### Fixed
- `XChainIndexer.js` — the inner catch-up loop in `run()` advanced its block counter (`lastIndexerBlock++`) *before* the `try` that processes the block, and the `catch` rolled back and logged but then fell through to the next loop iteration. When a block failed to process (VM watchdog timeout, DB deadlock, sanity-check failure, etc.), the counter was already pointing past the failed block, so the loop processed the next block instead — and because `getBlockIndex('indexer', 'last')` is `SELECT MAX(block_index) FROM blocks`, once later blocks committed the failed block was permanently absent with no gap signal, leaving every downstream consumer serving chain history with a hole. The counter is now advanced only after a successful `commitTransaction()` (via a local `blockToParse`), and the `catch` `break`s out of the inner loop so the outer loop re-fetches the last indexed block from the DB and retries the same block after the sleep interval — the intended retry behaviour. Added chaos regression tests (BK-09, BK-10) asserting a failing block is never skipped and a transient failure is retried with no gap in the committed block sequence.

## [2.7.0] - 2026-05-28

### Fixed
- Every `index_*` lookup-table upsert in `db.js` (`createTransaction`, `createAddress`, `createAction`, `createTicker`, `createStatus`, `createMemo`, `createMimeType`, `createCoin`, `createFiat`, `getOrCreatePubkeyId`) used a SELECT-then-INSERT — a time-of-check/time-of-use race in which a concurrent caller inserting the same key between the lookup and the bare INSERT triggered an uncaught duplicate-key error against the table's UNIQUE index. Each now upserts with `INSERT IGNORE` + refetch, which is race-safe and swallows the duplicate-key collision. The case-insensitive get-first lookup is retained for `createTicker` (its UNIQUE index is binary but `getTickerId` folds case via `LOWER(tick)`), so the refetch preserves the existing case-folding behaviour. Note: `index_actions` carries only a non-unique index, so `INSERT IGNORE` there does not itself prevent duplicate rows — the single-threaded block-processing loop is what serializes those inserts; it is changed for consistency.

## [2.6.7] - 2026-05-28

### Fixed
- `rollback.js` — added `contract_unstakes` and `contract_delegations` to the `dataTables` rollback list, completing the contract-staking set alongside the already-listed `contract_stakes`. Each table is keyed on `action_index` and carries a `block_index` column, so a chain reorg previously left orphaned contract-staking rows from rolled-back blocks in place. The `contract_unstakes` case is the most acute: every UNSTAKE v1 action writes a row carrying a `cooldown_end_block` computed against the abandoned chain tip, so after a reorg the cooldown either expires at the wrong height (phantom fund release) or appears still-locked (delayed release) — both surfaced through the explorer read paths until the chain advanced past the orphaned tip. Adding the two tables to the delete loop purges the stale rows so contract-staking state tracks canonical chain state across reorgs.

## [2.6.6] - 2026-05-28

### Fixed
- `db.js` — `findCancelledDispensers` now appends `ORDER BY m.action_index ASC` to its SELECT. The query finds dispensers whose latest status is `cancelling` and whose `DISPENSER_CLOSE_DELAY` has expired, and `processCancellations` iterates the result to emit a `DISPENSER_CLOSE` per dispenser. Without an explicit ordering, when two or more dispensers reached their close-delay threshold in the same block MariaDB could return them in any order, so different nodes processed the closures in different sequences. Because each `DISPENSER_CLOSE` writes `credits` / `debits` / `escrows` / `dispenser_statuses` rows with AUTO_INCREMENT primary keys, divergent processing order assigned divergent IDs, splitting ledger state and corrupting the block digest hash chain. Ordering by `action_index` makes the close sequence deterministic across all nodes.

## [2.6.5] - 2026-05-28

### Fixed
- `rollback.js` — added `prices` to the `dataTables` rollback list so on-chain PRICE oracle rows (v0 validator COIN/FIAT snapshots and v1 user TOKEN/FIAT oracle prices, keyed by `action_index`) are purged during a block rollback. Previously a chain reorg left orphaned `prices` rows from rolled-back blocks in place, so the explorer and any consumer of the `prices` table kept serving prices that were never finalized on-chain. `prices` carries no balance/ticker impact (the PRICE handlers write no credits/debits/escrows), so it joins the delete loop only — no read-phase address scan and no `source_id` rebalancing are required.
- `rollback.js` / `hub_client.js` — after a rollback commits, the indexer now signals the cross-chain hub (new `pushpricereorg` JSON-RPC call carrying the source chain + lowest rolled-back `action_index`) to retract any `price_snapshots` / `oracle_prices` rows the hub seeded from the orphaned PRICE actions. Previously the hub only invalidated price snapshots on a separate PBFT reorg attestation, which never arrives for non-PBFT reorgs — leaving the hub (and every indexer mirroring its price tables) serving never-finalized prices to fee validation, DEX dispenser settlement, and VM oracle calls. The signal is best-effort: a hub failure logs a warning and never leaves the local rollback half-applied.
- `hub_db_sync.js` — the hub DB sync client now handles `row:deleted` events from the hub's price-table broadcast channel, pruning the matching rows from the local `price_snapshots` / `oracle_prices` copy. This propagates a reorg retraction to distributed indexers so their local hub DB mirror stops serving rolled-back prices. The deletion column is resolved from a local table→column map (never the wire) so the `DELETE` cannot interpolate an untrusted column name.

## [2.6.4] - 2026-05-28

### Fixed
- `api.js` — `getactivevalidators` and `getcapabilityvalidators` now validate the requested `block_index` against the latest indexed block before querying. Previously both handlers echoed the caller-supplied `block_index` straight into the response without confirming the indexer had processed that far. A caller requesting a future block (e.g. during indexer lag) received a snapshot accurate only through the latest indexed block but labelled with the requested block. Consumers caching validator-set snapshots keyed on that block index could lock incorrect quorum membership. Both handlers now return `{ error: 'block_index N not yet indexed (latest: M)' }` when `blk > latestBlock`, so callers that already check `result.error` surface the lag explicitly instead of trusting a mislabelled snapshot.

## [2.6.3] - 2026-05-28

### Fixed
- `rollback.js` — added `slash_events` to the `blockTables` rollback list so its rows are purged during a block rollback. `slash_events` is a persistent log table keyed by `block_index`; previously a chain reorg left rows from rolled-back blocks in place, producing phantom slash events that corrupted contract-staking state (validator quality scores, slashed balances) and propagated to downstream consumers (explorer API, SDK `getSlashEvents`, wallet) until the chain advanced past the orphaned tip. The table has no enforced foreign key on `execution_index` (index only), and `blockTables` is deleted after `dataTables` (which already removes `contract_executions`), so delete ordering is safe as-is.

## [2.6.2] - 2026-05-28

### Fixed
- `rollback.js` — added `gated_files` to the `dataTables` rollback list so its rows are purged alongside `files` during a block rollback. Previously a chain reorg deleted the parent `files` row but left the `gated_files` metadata row behind, orphaning it by `action_index`. Stale gated-file rows caused the `SEND` handler to reject all further transfers of the affected token (gated token with no valid key-handoff message) and the explorer to serve ciphertext from rolled-back blocks. `gated_files` carries no balance/ticker impact and no enforced foreign key, so it joins the delete loop only (no read-phase query) and delete ordering relative to `files` is immaterial.

## [2.6.1] - 2026-04-24

### Security
- `package-lock.json` — applied `npm audit fix` to clear 8 transitive advisories in the `express` dependency chain (`body-parser` <1.20.3 DoS, `cookie` <0.7.0 OOB chars, `path-to-regexp` ReDoS, `qs` DoS, `send` <0.19.0 template-injection/XSS, `serve-static`, plus `@babel/runtime` RegExp complexity). No `package.json` dependency ranges changed; `express` resolved to the latest 4.x patch. Unit suite delta: 0 new failures. `mathjs` and `mocha` breaking bumps deferred.

## [2.6.0] - 2026-04-24

### Added
- `actions/address.js` — `DISPENSER_PREFERENCE` field on `ADDRESS` format `0` (`1`=owner only default, `2`=anyone). Numeric + valid-value validation. Persisted via `createAddressOption()`; defaulted to `1` on first lookup for addresses that have never set the field.
- `actions/dispenser.js` — authorization gate for opening a dispenser on a non-`SOURCE` `GET_ADDRESS`: allowed only when the target has `DISPENSER_PREFERENCE=2` or is a fresh address (`utxo-tracker get_first_seen` returns null or a height `>= BLOCK_INDEX`). Rejected with `invalid: GET_ADDRESS (dispenser not permitted)` otherwise. `GET_ADDRESS == SOURCE` bypasses the check (owner self-open).
- `UtxoTracker.js` — new thin JSON-RPC client for `xchain-utxo-tracker`. Exposes `getFirstSeen(address)` used by the DISPENSER fresh-address check. `enabled` flag gated on `UTXO_TRACKER_URL` / `UTXO_TRACKER_API_PORT` env vars; when disabled, all non-owner dispensers on non-preference-open addresses are rejected (logged at startup).
- `XChainIndexer.js` / `api.js` — plumb `UTXO_TRACKER_URL` and `UTXO_TRACKER_API_PORT` env vars through to the new `UtxoTracker` client; startup warning when the client is disabled.
- `db.js getDispenserCanceller()` — returns the address recorded on the most recent `cancelling` status row for a dispenser, used by `dispenser_close` to route escrow per spec.
- `sql/dispenser_statuses.sql` — new `cancelled_by_id` column (FK to `index_addresses`) recording the address that triggered a cancel; indexed for lookup.

### Changed
- `actions/dispenser.js` (format 1 cancel) and `actions/sweep.js` (dispenser cancel branch) — now pass `SOURCE` as the canceller when writing the `cancelling` status row, so `dispenser_close` has the canceller identity available.
- `actions/dispenser_close.js` — escrow destination now resolves in this priority order: (1) `SWEEP` destination if the cancel came from a `SWEEP`, (2) recorded canceller (`GET_ADDRESS` or `SOURCE`) per `DISPENSER.md`, (3) dispenser `SOURCE` fallback. Matches the spec's close-path escrow rules.
- `db.js createDispenserStatus()` — accepts optional `cancelled_by` address; writes/updates the new `cancelled_by_id` column.
- `db.js createAddressOption()` / `getAddressPreferences()` — read/write the new `dispenser_preference` column. Defaults to `1` (owner only) when the address has no prior non-null value.
- `sql/addresses.sql` — added `dispenser_preference BIGINT UNSIGNED` column.
- `test/unit/actions/address.test.js` / `test/fixtures/mocks.js` — parameter helper and `makeParams()` signature updated for the new `DISPENSER_PREFERENCE` field position; `getDispenserCanceller` stub added to the mock DB.

## [2.5.0] - 2026-04-08

### Added
- `actions/price.js` — new PRICE action handler supporting both v0 (validator COIN/FIAT snapshots) and v1 (user TOKEN/FIAT oracles). v0 parses variable-length PBFT signatures, verifies each signer has an active Tier 1 stake, validates Ed25519 signatures against the canonical payload, and checks PBFT quorum (`2*floor((tier1_count-1)/3)+1`). v1 validates COIN/TICK/FIAT/VALUE/FEE fields. After validation, pushes to `xchain-hub` for cross-chain aggregation.
- `sql/prices.sql` — new action table for on-chain PRICE actions. Stores v0 fields (`round_number`, `pairs_json`, `sigs_json`) and v1 fields (`coin_id`, `tick_id`, `fiat_id`, `value`, `fee`). One row per processed PRICE transaction.
- `ed25519.js` — lightweight Ed25519 verification helper using Node.js built-in `crypto` (no external deps). Provides `pubkeyFromHex()`, `verify()`, and `buildPriceV0Payload()` for canonical sortable JSON payload construction matching the xchain-hub signer format.
- `hub_client.js` — dependency-free JSON-RPC client for pushing data to `xchain-hub` (`pushChainTip`, `pushPriceRound`, `pushOraclePrice`). Uses Node's built-in `http`/`https` modules.
- `hub_db_sync.js` — WebSocket sync client that maintains a local copy of the hub's `price_snapshots` and `oracle_prices` tables for geographic distribution. Bootstraps via REST snapshot (`GET /hub-db/snapshot/...`) then subscribes to `/hub-db/subscribe` for live row updates. Applies rows via `INSERT IGNORE` (idempotent). Falls back to periodic polling if the `ws` package isn't available. Opt-in via `HUB_DB_SYNC_ENABLED=true`.
- Third database connection in `XChainIndexer.js` — new `hubDb` connection points at a local read-only copy of hub cross-chain infrastructure tables. Created when `HUB_DB_HOST` / `HUB_DB_NAME` env vars are set.
- Tier 3 oracle publisher staking support in `configs/BTC.js` — `STAKING.TIERS[3]` = 500 XCHAIN, `STAKING.ACTIVATION_DELAY_BLOCKS` = 6.
- `DOGE_ADDRESS` field on Tier 3 STAKE actions — validates D-prefix + 34-char base58 format. Recorded on-chain in `stakes.doge_address` column.
- 6-block activation delay for all validator state changes (STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION). Tracked via new `activation_block` and `deactivation_block` columns on the `stakes` and `delegations` tables. Active-stake queries filter by `activation_block <= current_block AND (deactivation_block IS NULL OR deactivation_block > current_block)` — eliminates BTC reorg edge cases for reorgs of ≤5 blocks.
- `createValidatorReward()` in `db.js` — resolves a signing pubkey to the staking source address via the `stakes → index_pubkeys` join and inserts into the indexer's `validator_rewards` table. Called by the new `pushvalidatorrewards` JSON-RPC endpoint when xchain-hub's RewardTracker pushes reward records.
- `getActiveStakeCount(tier, blockIndex)` in `db.js` — counts active stakes at a given tier for PBFT quorum calculation in PRICE v0 signature validation.
- `getOraclePrice()` and `getOraclePricesInTimeRange()` in `db.js` — query helpers for `oracle_prices` with `effective_at` gating (enforces the 24-hour price lock window).
- `reverseOraclePriceMatch()` in `utility.js` — user oracle reverse price matching for FIAT dispensers. Combines PRICE v1 user oracle (TOKEN/FIAT) with PRICE v0 validator oracle (COIN/FIAT) for cross-conversion. Walks historical oracle prices newest-first within a 24-hour window.
- `ORACLE_ADDRESS` field on DISPENSER action (format 0) — references a user PRICE v1 oracle for TOKEN/FIAT pricing. When set, `FIAT_AMOUNT` is ignored and the oracle provides the price. `dispense.js` branches between `reversePriceMatch` (validator path) and `reverseOraclePriceMatch` (user oracle path).
- `oracle_address_id` column on `dispensers` table (FK to `index_addresses`).
- `pushvalidatorrewards` JSON-RPC endpoint on indexer `api.js` — receives reward push from xchain-hub's `RewardTracker`, writes to the indexer's `validator_rewards` table. Requires `INDEXER_API_KEY` for auth.
- `HubClient.pushChainTip()` called after every successful block commit in `XChainIndexer.js` — anchors oracle rounds to BTC chain tip (fire-and-forget, never blocks indexing).
- `EUR` and `KRW` added to `config.FIATS` and `sql/index_fiats.sql` — 12 supported FIAT currencies total.
- `PRICE` action registered in `protocol_changes.js`, `actions.js`, and decoder `VALID_ACTION_NAMES`.

### Changed
- `getLatestPrice(coinPair, blockHeight)` in `db.js` — now accepts an optional `blockHeight` parameter and filters `reference_block <= blockHeight`. Gates price lookups by the current block so two independent nodes processing the same block always see the same price (cross-node determinism fix).
- `utility.js validateNativeCoinFee()` — passes `data['BLOCK_INDEX']` to `getLatestPrice()` and prefers the local hub DB connection (`db.indexer.hubDb`) when available.
- `utility.js reversePriceMatch()` — same hub DB preference for price snapshots.
- `db.js` `Database` constructor — now stores `this.indexer` reference so dependent code can resolve `db.indexer.hubDb` automatically.
- `actions/stake.js` — format expanded to `VERSION|TIER|CHAINS|SIGNING_PUBKEY|DOGE_ADDRESS`. Accepts tier 3. Tier 3 rules: CHAINS must be empty, DOGE_ADDRESS required with format validation. Tier 1/2 rules: DOGE_ADDRESS must be empty. Calculates `ACTIVATION_BLOCK = BLOCK_INDEX + 6`.
- `actions/unstake.js` — accepts tier 3. Active-stake lookup gated by block index. Sets `deactivation_block = BLOCK_INDEX + 6` on the parent stake when valid.
- `actions/delegate.js` — accepts new delegation with 6-block activation delay. Active-stake lookup gated by block index.
- `actions/revoke_delegation.js` — sets `deactivation_block = BLOCK_INDEX + 6` on the parent delegation when valid. Active-delegation lookup gated by block index.
- `actions/claim_rewards.js` — active-stake lookup gated by block index.
- `actions/dispense.js` — FIAT dispenser flow now branches on `dispenser.ORACLE_ADDRESS`: uses `reverseOraclePriceMatch()` (user oracle path) when set, otherwise uses existing `reversePriceMatch()` (validator path).
- `actions/dispenser.js` — added `ORACLE_ADDRESS` parser and validation. Requires `FIAT_CODE` when set; makes `FIAT_AMOUNT` optional when set.
- `actions/deploy.js` and `actions/execute.js` — `getOracleDataForVM()` calls now prefer `actions.hubDb || indexerDb`.
- `sql/stakes.sql` — added `doge_address`, `activation_block`, `deactivation_block` columns with indexes.
- `sql/delegations.sql` — added `activation_block`, `deactivation_block` columns with indexes.
- `sql/dispensers.sql` — added `oracle_address_id` column with index.
- `sql/index_fiats.sql` — added EUR and KRW rows; fixed spelling (Australian, Britain, Brazilian).
- `db.js createStake()` / `setStakeDeactivation()` / `createDelegation()` / `setDelegationDeactivation()` — write and update the new activation/deactivation block columns.
- `db.js createDispenser()` / `getDispenserInfo()` — write and return `oracle_address_id` / `oracle_address`.
- `XChainIndexer.js` constructor — accepts hub DB connection parameters (`hubDbHost`, `hubDbPort`, `hubDbName`, `hubDbUser`, `hubDbPass`). Creates `HubClient` for fire-and-forget pushes to xchain-hub. Creates `HubDbSync` (opt-in) for WebSocket-based local hub DB maintenance.
- `api.js` — added `pushvalidatorrewards` write endpoint with optional `INDEXER_API_KEY` auth. Passes hub DB env vars through to `XChainIndexer`.
- `actions.js` — `Actions` class now exposes `hubDb` and `hubClient` to action instances via the constructor.

## [2.4.0] - 2026-04-07

### Added
- `getPricesInTimeRange()` in `db.js` — queries finalized oracle price snapshots within a time range (newest-first)
- `reversePriceMatch()` in `utility.js` — floor-based reverse price matching for FIAT dispensers against historical oracle snapshots within a 24-hour window
- `FIAT_DISPENSER_PRICE_WINDOW` config (86400 seconds) — configurable price matching window for FIAT dispensers
- FIAT-aware dispense logic in `dispense.js` — uses reverse price matching to determine token units for FIAT-priced dispensers

### Fixed
- `createDispenser()` in `db.js` — `data['FIAT']` changed to `data['FIAT_CODE']` so `fiat_id` is stored correctly
- `dispensers.sql` — `fiat_amount` column changed from `BIGINT UNSIGNED` to `VARCHAR(250)` to preserve decimal values (e.g., "0.05")

### Changed
- `findMatchingDispensers()` in `db.js` — FIAT dispensers are now included regardless of `coin_amount` vs `get_amount` comparison; actual matching deferred to `dispense.js`

## [2.3.0] - 2026-04-07

### Added
- `coin` column in `messages` table for cross-chain messaging — identifies the destination address network (BTC, LTC, DOGE)
- COIN field validation in MESSAGE action parser

### Changed
- MESSAGE format strings updated to include COIN field: `VERSION|COIN|DESTINATION|...`
- `createMessage()` stores the COIN value alongside other message fields

## [2.2.2] - 2026-04-07

### Changed
- `MESSAGE_ENCRYPTION_METHODS` config updated to `[1, 2, 3]` — reordered to 1=ECIES, 2=ECDH, 3=AES
- Updated encryption method comment in `message.js` action handler

## [2.2.1] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

### Changed
- README: update features list to reflect all 29 action types, VM integration, hub staking, COINPay, unified gas fees, contract derived addresses, and three block hashes

## [2.2.0] - 2026-04-03

### Added
- VM runtime integration — EXECUTE actions now run contract code in sandboxed V8 isolates via xchain-vm
- Full emission routing — contracts can emit 16 action types (SEND, DESTROY, ISSUE, etc.) processed through existing handlers
- `processEmission()`, `getActionHandler()`, `buildActionParams()` methods in execute.js for routing emitted actions
- Savepoint-based atomicity for VM execution — state changes and emissions roll back together on failure
- `getContractState()`, `createContractState()`, `createContractEmission()` DB methods for VM state persistence
- `createSavepoint()`, `releaseSavepoint()`, `rollbackToSavepoint()` DB methods for nested transaction control
- `deleteContract()` DB method for constructor failure rollback
- `getOracleDataForVM()` and `getCrossChainDataForVM()` stubs (return null until Track B / Phase 4)
- `api_version` column on `contracts` table (default 1) for future gateway versioning
- Deploy-time syntax validation via `vm.validateSyntax()` — rejects invalid code before charging gas
- Deploy-time float usage warnings via `vm.checkFloatWarnings()`
- Contract derived address creation (`C:<CHAIN>:<action_index>`) in deploy.js
- Constructor execution — DEPLOY with CONSTRUCTOR_PARAMS runs `initialize` method through the VM
- Per-block VM compilation cache lifecycle (`beginBlock()`/`endBlock()`) in XChainIndexer.js
- Deterministic block hash derivation from block_index + block_time (until decoder provides real hashes)
- Gas fee recalculation based on actual VM gas usage (not just base gas)
- `emission_params.test.js` — mandatory format validation for all 16 emittable action types

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
