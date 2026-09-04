--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************
--
-- attestation_responses: the finalized ATTEST response, carried by the hub
-- mirror instead of by a validator-paid on-chain transaction.
--
-- Before this table an attestation cost TWO on-chain transactions. The request
-- is an emission inside the EXECUTE the user already paid for, but the response
-- was a whole ATTEST v1 transaction the leader validator broadcast and paid a
-- Bitcoin fee for, and the contract callback fired only when it mined. A
-- contract executed a thousand times was a thousand validator-paid Bitcoin
-- transactions, each waiting on Bitcoin block time. PRICE rounds already solved
-- the same shape of problem: finalize over P2P, live in the hub DB, stream to
-- indexers through this mirror, gate block processing through a barrier, and
-- land on chain periodically in full-bodied batches. ATTEST responses take that
-- road (the ATTEST response-mirror design).
--
-- Hub-authored federation-state table mirrored to every indexer via hub_db_sync
-- (HUB_STATE_TABLES). Every consensus-bearing column is fixed at insert. The ONE
-- column set later is `batch_action_index`: when the ATTEST v5 batch carrying this
-- row lands on DOGE, the hub records the batch action on the row and re-broadcasts
-- it, and the mirror apply upserts that single column on the natural key. It is a
-- display link (the explorer batch link) and nothing reads it into hashed state, so
-- a stale value after a DOGE reorg is a cosmetic gap until the batch re-lands, never
-- a fork.
--
-- ONE ROW PER TERMINAL ROUND. `status` is `ok` or `expired`, today's terminal v1
-- vocabulary. The retryable statuses (no_quorum, timeout, provider_error) are
-- deliberately NOT mirrored: they have no chain effect today beyond an audit row,
-- and they are the only unbounded multiplier on the size of the periodic on-chain
-- batch that makes this table reconstructible from chain parse.
--
-- NATURAL-KEY MIRROR, not id-parity. Every hub that holds the finalized artifact
-- writes its own row: the responsible set reaches quorum, and the result is then
-- gossiped to the rest of the federation (ATTEST_RESULT), which verifies the
-- signatures against its own capability snapshot and inserts its own copy. So the
-- `id` below is hub-LOCAL and two hubs carry different ids for the same logical
-- row. The indexer's _applyRow therefore STRIPS id and lets local AUTO_INCREMENT
-- assign, exactly as it does for capability_snapshots, and for exactly the same
-- reason (#2270): a wire id can otherwise collide with a locally-assigned PK and
-- the INSERT IGNORE silently drops the row, leaving a permanent mirror hole. The
-- table is in FULL_REPAGE_TABLES for the same reason - a since_id = MAX(local id)
-- cursor is not a position in the followed hub's id space once ids are local.
--
-- `network` is what lets the mirror scope its cursor and purge rows a previous
-- hub served for a different network (_mirrorNetworkScope /
-- _purgeForeignNetworkRows). Without it that scope resolves null and re-pointing
-- an indexer at a hub on another network strands the mirror silently.
--
-- The mirror is TRANSPORT, NEVER AUTHORITY. The indexer re-verifies
-- `signatures` against the responsible set resolved from ITS OWN local v0 request
-- row's buried block height - never a height this row states - with the same
-- shared verifier the on-chain v1 path uses. A row that fails verification is
-- skipped identically on every node, so a bad row is inert rather than a fork.
--
-- `effective_time` is INSIDE the signed canonical (leader-chosen, follower-bounded),
-- which is what makes the applying block a pure function of signed data plus the
-- indexer's own chain state rather than of any hub's clock. `finalized_at` is the
-- opposite: hub wall clock, audit only, NEVER a consensus input and never compared
-- across hubs. `widen` is likewise informational - the verifier recomputes the
-- widening step itself.
--
-- Forward migration is idempotent and automatic on both sides: the hub and indexer
-- reconcile column drift from this file at startup (db.alterTableForDrift).
--
-- Idempotent on the natural key: a re-delivered, re-gossiped or replayed row leaves
-- every signed column exactly as first inserted; only a null batch_action_index can
-- be filled, and only once.

CREATE TABLE attestation_responses (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, -- hub-LOCAL paging cursor; stripped on mirror apply, never part of row identity
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; the mirror's scope and purge key
    request_id           CHAR(64)     NOT NULL,                    -- the v0 request id, lower-case hex; the row's identity
    request_action_index BIGINT UNSIGNED DEFAULT NULL,             -- the v0 row's action_index on BTC; ORDERING AID ONLY, the applier re-derives it from its own request row
    request_block_index  BIGINT UNSIGNED DEFAULT NULL,             -- the v0 row's BTC block; same status: informational, re-derived locally
    provider_id          VARCHAR(64)  NOT NULL,                    -- as in the on-chain v1
    status               VARCHAR(20)  NOT NULL,                    -- TERMINAL vocabulary only: 'ok' or 'expired'
    response_payload     MEDIUMTEXT,                               -- the agreed body, stored decoded as UTF-8 exactly as attests.response_payload is
    response_hash        CHAR(64)     NOT NULL,                    -- sha256 of the body bytes; the field the canonical already signs
    meta                 TEXT,                                     -- as in the on-chain v1
    effective_time       BIGINT UNSIGNED NOT NULL,                 -- unix seconds, leader-chosen, INSIDE the signed canonical: the applying block is a pure function of it
    signer_pubkeys       TEXT         NOT NULL,                    -- JSON array, ordered responsible-set pubkeys that signed
    signatures           TEXT         NOT NULL,                    -- JSON [{pubkey,sig}], Ed25519 over the mirror-era canonical
    widen                TINYINT UNSIGNED DEFAULT 0,               -- the widening step the leader used; INFORMATIONAL, the verifier recomputes it
    batch_action_index   BIGINT UNSIGNED DEFAULT NULL,             -- the DOGE action_index of the ATTEST v5 batch that carried this row; the ONE column set after insert, display link only, never a consensus input
    finalized_at         BIGINT UNSIGNED DEFAULT NULL              -- hub wall clock at quorum; AUDIT ONLY, never a consensus input, never compared across hubs
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Standalone CREATE INDEX rather than inline KEY, deliberately: the indexer's
-- reconcileTableIndexes self-heals only standalone statements, so an aged database
-- can back-fill a missing index instead of silently serving full scans.
--
-- Row identity within a network. request_id alone is already collision-free in
-- practice (it is a sha256 over chain data), but two hubs on different networks can
-- legitimately both be served through one mirror table during a re-point, and scoping
-- the key matches how every reader and _purgeForeignNetworkRows scope theirs.
CREATE UNIQUE INDEX uq_attest_response ON attestation_responses (network, request_id);
-- Two range reads over the one column both sides agree on: the indexer's applicability
-- scan takes rows whose signed effective_time has been reached, and the hub's batch
-- publisher takes one window as [window_start, window_end). Keying the window on the
-- signed column rather than on per-hub finalized_at is what makes two hubs partition a
-- boundary row the same way, and this index is what keeps that read off a full scan.
CREATE        INDEX idx_effective_time ON attestation_responses (network, effective_time);
-- Deterministic applier order within a block.
CREATE        INDEX idx_request_order  ON attestation_responses (network, request_block_index, request_action_index);
