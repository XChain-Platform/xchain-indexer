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

CREATE TABLE capability_snapshots (
    id             BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,        -- LOCAL surrogate only, NO hub parity:
                                                             -- hub ids are hub-local (each hub persists
                                                             -- independently) and AnchorRecovery rebuilds
                                                             -- id-less, so the mirror strips wire ids and
                                                             -- bootstraps from since_id=0 (natural-key
                                                             -- mirror on uq_cap_snap; hub_db_sync #2270)
    snapshot_block BIGINT NOT NULL,                          -- BTC-anchored block boundary
    capability     VARCHAR(20)  NOT NULL,                    -- e.g. 'cross_chain'
    signing_pubkey VARCHAR(64)  NOT NULL,                    -- Ed25519 validator pubkey (64 hex)
    amount         VARCHAR(250) NOT NULL,                    -- source AGGREGATE active stake = the
                                                             -- voting weight (STAKE_WEIGHTED_QUORUM).
                                                             -- Every key of a source carries the same
                                                             -- amount; dedupe by `source` before summing.
    source         VARCHAR(255) NOT NULL DEFAULT '',         -- staking address (source) this key signs
                                                             -- for. Quorum weight is per-source, NOT
                                                             -- per-key (DELEGATE v0 is additive).
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Presence of a row = that pubkey QUALIFIED for `capability` at `snapshot_block`
    -- (the hub only mirrors pubkeys already filtered by min_stake). Lets a non-BTC
    -- indexer verify cross-chain match signatures without local capability stakes.
    UNIQUE KEY uq_cap_snap (snapshot_block, capability, signing_pubkey),
    KEY idx_cap_block (capability, snapshot_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
