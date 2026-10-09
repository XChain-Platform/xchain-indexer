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

-- xchain:migration mode=auto
-- Migration: remote token mirror snapshots.

CREATE TABLE IF NOT EXISTS remote_token_snapshots (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    snapshot_id          CHAR(64) NOT NULL,
    snapshot_block       BIGINT UNSIGNED NOT NULL,
    network              VARCHAR(20) NOT NULL,
    coin                 VARCHAR(10) NOT NULL,
    tick                 VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    decimals             TINYINT UNSIGNED NOT NULL,
    owner                VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    source_action_index  BIGINT UNSIGNED NOT NULL,
    finalizing_view      INT NOT NULL DEFAULT 0,
    validator_signatures TEXT NOT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'finalized',
    btc_chain_id         CHAR(64) NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY snapshot_id (snapshot_id),
    KEY pinned_remote_token (network, coin, tick, snapshot_block),
    KEY idx_source_ref (coin, source_action_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
