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

-- Idempotency + rollback record for every APPLIED bridge leg, classified in
-- tableLifecycle.js verbatim as cross_chain_settlements (stream:action / action / mirror /
-- DERIVED). One row per (transfer_id, kind): the XBRIDGE pass skips a row already present
-- here, and a local reorg below the applying block drops the row by action_index so the
-- leg re-applies on replay.
--
-- WHY THIS IS LOCAL AND NOT A READ OF THE MIRROR. The mirrored bridge_transfers row can be
-- deleted later (a fenced retraction), so "did this chain already apply it?" must be
-- answered from a local, reorg-rollback-able table, exactly as cross_chain_settlements
-- answers it for the DEX.
--
-- `kind` IS INSIDE THE IDEMPOTENCY KEY (the token bridge policy spec
-- section 6, D24): a transfer settle and a policy snapshot are different applications and
-- carry different ids in the same column (a bridge_transfers.transfer_id for
-- kind='transfer', a policy_snapshots.snapshot_id for kind='policy'). Both are lowercase
-- sha256 hex, so one CHAR(64) column holds either. The column ships in the base DDL rather
-- than in a later migration because both specs build in one run.
--
-- DELIBERATE DEVIATION from cross_chain_settlements: no `local_action_index`. That column
-- names the local ORDER/SWAP released from escrow, and a bridge leg releases no local
-- offer: an in-leg has no prior local action at all, and an out-leg's source is the burn
-- on another chain (already named by src_chain/src_action_index).
DROP TABLE IF EXISTS bridge_settlements;
CREATE TABLE bridge_settlements (
    action_index     BIGINT UNSIGNED NOT NULL, -- internal settle action_index (rollback-able; minted when the leg is applied)
    transfer_id      CHAR(64)        NOT NULL, -- bridge_transfers.transfer_id when kind='transfer', policy_snapshots.snapshot_id when kind='policy'
    kind             VARCHAR(10)     NOT NULL DEFAULT 'transfer', -- 'transfer' (an XBRIDGE v2/v5 leg) | 'policy' (an applied XPOLICY snapshot)
    block_index      BIGINT UNSIGNED NOT NULL, -- block height at which this leg was applied
    -- Source-leg reference captured from the SIGNED row at apply time. The mirror row can
    -- be deleted later, so anything that must survive a retraction reads from here.
    src_chain        VARCHAR(10)     NULL,     -- lock/burn chain (origin_chain for a policy row)
    src_action_index BIGINT UNSIGNED NULL,     -- lock/burn action_index (NULL for a policy row: a snapshot has no single source action)
    dest_chain       VARCHAR(10)     NULL,     -- chain the credit landed on (NULL for a policy row: a snapshot targets every chain holding a copy)
    dest_address     VARCHAR(255)    NULL,     -- address credited (NULL for a policy row)
    tick             VARCHAR(250)    NULL,     -- the native tick the leg moved, as signed
    UNIQUE KEY uq_transfer_kind (transfer_id, kind),
    KEY idx_action_index (action_index),
    KEY idx_block_index (block_index),
    KEY idx_src_ref (src_chain, src_action_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
