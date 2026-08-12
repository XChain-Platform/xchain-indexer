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
-- commitments, parsed from the DOGE-only ANCHOR action (one row per
-- action_index; rolled back by action_index like any data table):
--   version 0: checkpoint (quorum-signed per-chain state-hash commitment)
--   version 1: checkpoint + match-archive segment (chunk 0 of the batch)
--   version 2: archive continuation chunk (no signatures of its own)
--   version 3: checkpoint + SPV light-client roots (state_root + block_merkle_root)
--   version 4: v0 checkpoint + publisher-attestation tail (elected PUBLISHER pubkey +
--              a SECOND 2f+1 oracle_publish attestation, for anchor-reward re-derivation)
--   version 5: v3 checkpoint + publisher-attestation tail
--   version 6: v1 archive anchor + publisher-attestation tail (archive-reward)
-- The v4/v5/v6 publisher tail is persisted here in the nullable `publisher` and
-- `publisher_attestations` columns; v0-v3 leave both NULL.
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
    version              TINYINT UNSIGNED NOT NULL,       -- 0=checkpoint, 1=checkpoint+archive, 2=continuation, 3=checkpoint+SPV roots, 4=v0+publisher tail, 5=v3+publisher tail, 6=v1 archive+publisher tail
    chain                VARCHAR(10),                     -- checkpointed chain (v0/v1)
    network              VARCHAR(20),                     -- checkpointed network (v0/v1)
    block_index          BIGINT UNSIGNED,                 -- checkpointed height on `chain` (v0/v1)
    block_hash           VARCHAR(64),                     -- chain block hash at block_index
    ledger_hash          VARCHAR(64),                     -- indexer blocks.ledger_hash at block_index
    actions_hash         VARCHAR(64),                     -- indexer blocks.actions_hash
    contract_hash        VARCHAR(64),                     -- indexer blocks.contract_hash
    checkpoint_seq       BIGINT UNSIGNED,                 -- monotonic per (chain, network); replay guard
    snapshot_block       BIGINT UNSIGNED,                 -- BTC block selecting the oracle_publish set
    state_root           CHAR(64),                        -- SPV light-client state_root carried by ANCHOR v3; NULL for v0/v1/v2
    state_root_version   TINYINT UNSIGNED,                -- merkle.js STATE_ROOT_VERSION (v3 only)
    block_merkle_root    CHAR(64),                        -- SPV per-block content Merkle root carried by ANCHOR v3; NULL otherwise
    block_merkle_version TINYINT UNSIGNED,                -- merkle.js BLOCK_MERKLE_VERSION (v3 only)
    match_batch_seq      BIGINT UNSIGNED,                 -- archive batch id (v1/v2)
    match_count          INT UNSIGNED,                    -- match records in the batch (v1)
    batch_crc32          VARCHAR(8),                      -- CRC32 of the UNCOMPRESSED archive JSON (v1)
    total_chunks         INT UNSIGNED,                    -- chunks in the batch (v1/v2)
    chunk_index          INT UNSIGNED,                    -- 1-based continuation index (v2 only; v1 carries chunk 0)
    archive_b64          MEDIUMTEXT,                      -- base64url gzip archive chunk (v1 chunk 0 / v2 continuation)
    validator_signatures MEDIUMTEXT,                      -- JSON [{pubkey,sig}] over the canonical (v0/v1)
    publisher            VARCHAR(64),                     -- elected PUBLISHER pubkey carried by the v4/v5/v6 tail; NULL for v0-v3
    publisher_attestations MEDIUMTEXT,                    -- JSON [{pubkey,sig}] RAW wire XANCPUB tail (v4/v5/v6), UNVERIFIED transport not the quorum-verified subset (#3076); consumers must re-verify. NULL for v0-v3
    status_id            BIGINT UNSIGNED,                 -- FK to index_statuses
    block_index_doge     BIGINT UNSIGNED NOT NULL,        -- DOGE block the ANCHOR action landed in (rollback anchor)
    PRIMARY KEY (action_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX idx_anchor_batch      ON anchor_actions (match_batch_seq, version, chunk_index);
CREATE INDEX idx_anchor_checkpoint ON anchor_actions (chain, network, checkpoint_seq);
