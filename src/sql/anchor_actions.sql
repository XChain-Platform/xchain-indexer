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

-- ANCHOR action rows: the permanent ON-CHAIN record of federation state
-- commitments, parsed from the DOGE-only ANCHOR action (one row per SECTION of an
-- action; rolled back by action_index like any data table, so a bundle's rows drop
-- together):
--   version 0: the per-network checkpoint BUNDLE: one row per per-chain SECTION,
--              all sharing one action_index and separated by section_index
--   version 1: archive head - the checkpoint wrapper carrying the match-archive
--              segment (chunk 0 of the batch) plus the publisher-attestation tail
--   version 2: archive continuation chunk (no signatures of its own)
-- The v0/v1 publisher tail is persisted here in the nullable `publisher` and
-- `publisher_attestations` columns, denormalized onto EVERY section row of a v0
-- bundle (RAW wire bytes, UNVERIFIED transport; consumers re-verify). A v1 head
-- always carries the tail, though `publisher_attestations` is NULL when the
-- attestation round degraded to ATTEST_SIG_COUNT 0. v2 leaves both NULL.
--
-- The version set RESTARTS at 0 at ANCHOR_ACTIVATION (src/anchor_activation.js).
-- Every ANCHOR mined BELOW that DOGE height, of any version, is invalid, and the
-- pre-restart wires (the per-chain anchors, the tail-less archive head and the old
-- bundle/archive-head bytes) are RETIRED: the hub no longer emits them and the
-- indexer no longer parses them. Rows already on chain keep their version byte and
-- stay readable through the txid-keyed reads.
--
-- The live verification source for explorers/wallets is the hub-mirrored
-- state_checkpoints table; this table exists so a full chain parse alone
-- recovers every checkpoint + the complete cross-chain match archive
-- (src/recovery.js). Status semantics: 'valid' (sigs verified at quorum),
-- 'unverified' (no capability snapshot available locally, so recovery
-- re-verifies from the ARCHIVED snapshots), or an 'invalid: ...' reason.
--
-- Spec: xchain-documentation/protocol/actions/ANCHOR.md
DROP TABLE IF EXISTS anchor_actions;
CREATE TABLE anchor_actions (
    action_index         BIGINT UNSIGNED NOT NULL,        -- FK to actions (the ANCHOR action that wrote this row)
    section_index        TINYINT UNSIGNED NOT NULL DEFAULT 0, -- 0-based per-chain section of a v0 bundle, in wire order; always 0 for the single-body versions
    version              TINYINT UNSIGNED NOT NULL,       -- 0=checkpoint bundle section, 1=archive head (checkpoint+archive+publisher tail), 2=continuation
    chain                VARCHAR(10),                     -- checkpointed chain (v0 section / v1 head)
    network              VARCHAR(20),                     -- checkpointed network (v1; on a v0 section, the BUNDLE header network denormalized onto every row)
    block_index          BIGINT UNSIGNED,                 -- checkpointed height on `chain` (v0 section / v1 head)
    block_hash           VARCHAR(64),                     -- chain block hash at block_index
    ledger_hash          VARCHAR(64),                     -- indexer blocks.ledger_hash at block_index
    actions_hash         VARCHAR(64),                     -- indexer blocks.actions_hash
    contract_hash        VARCHAR(64),                     -- indexer blocks.contract_hash
    checkpoint_seq       BIGINT UNSIGNED,                 -- monotonic per (chain, network); replay guard
    snapshot_block       BIGINT UNSIGNED,                 -- BTC block selecting the oracle_publish set
    state_root           CHAR(64),                        -- SPV light-client state_root carried by a v0 section; NULL for v1/v2
    state_root_version   TINYINT UNSIGNED,                -- merkle.js STATE_ROOT_VERSION (root-bearing rows only)
    block_merkle_root    CHAR(64),                        -- SPV per-block content Merkle root carried by a v0 section; NULL otherwise
    block_merkle_version TINYINT UNSIGNED,                -- merkle.js BLOCK_MERKLE_VERSION (root-bearing rows only)
    match_batch_seq      BIGINT UNSIGNED,                 -- archive batch id (v1/v2)
    match_count          INT UNSIGNED,                    -- match records in the batch (v1)
    batch_crc32          VARCHAR(8),                      -- CRC32 of the UNCOMPRESSED archive JSON (v1)
    total_chunks         INT UNSIGNED,                    -- chunks in the batch (v1/v2)
    chunk_index          INT UNSIGNED,                    -- 1-based continuation index (v2 only; v1 carries chunk 0)
    archive_b64          MEDIUMTEXT,                      -- base64url gzip archive chunk (v1 chunk 0 / v2 continuation)
    validator_signatures MEDIUMTEXT,                      -- JSON [{pubkey,sig}] over the canonical (v1 head; per v0 section, that section's own list)
    publisher            VARCHAR(64),                     -- elected PUBLISHER pubkey carried by the v0/v1 tail; NULL for v2
    publisher_attestations MEDIUMTEXT,                    -- JSON [{pubkey,sig}] RAW wire XANCPUB tail (v0/v1), UNVERIFIED transport not the quorum-verified subset (#3076); consumers must re-verify. NULL for v2 and for a degraded v1 tail carrying ATTEST_SIG_COUNT 0
    status_id            BIGINT UNSIGNED,                 -- FK to index_statuses
    block_index_doge     BIGINT UNSIGNED NOT NULL,        -- DOGE block the ANCHOR action landed in (rollback anchor)
    PRIMARY KEY (action_index, section_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX idx_anchor_batch      ON anchor_actions (match_batch_seq, version, chunk_index);
CREATE INDEX idx_anchor_checkpoint ON anchor_actions (chain, network, checkpoint_seq);
