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

-- xchain:migration mode=manual deploy-precondition=required
-- Migration: shared-list mirror tables.
--
-- Idempotent and non-destructive. Each CREATE block matches its fresh-build
-- src/sql definition, with only IF NOT EXISTS added for an aged database.

CREATE TABLE IF NOT EXISTS list_snapshots (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    snapshot_id          CHAR(64) NOT NULL,
    snapshot_block       BIGINT UNSIGNED NOT NULL,
    network              VARCHAR(20),
    home_chain           VARCHAR(10),
    home_list_index      BIGINT UNSIGNED,
    list_type            TINYINT UNSIGNED,
    seq                  BIGINT UNSIGNED,
    kind                 VARCHAR(8),
    added                MEDIUMTEXT NOT NULL,
    removed              MEDIUMTEXT NOT NULL,
    members_hash         CHAR(64),
    name                 VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    description          VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    meta_hash            CHAR(64) NULL,
    origin_block         BIGINT UNSIGNED,
    admit_block_btc      BIGINT UNSIGNED DEFAULT NULL,
    admit_block_ltc      BIGINT UNSIGNED DEFAULT NULL,
    admit_block_doge     BIGINT UNSIGNED DEFAULT NULL,
    finalizing_view      INT NOT NULL DEFAULT 0,
    validator_signatures TEXT NOT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'finalized',
    btc_chain_id         CHAR(64) NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_list_snapshot_seq (network, home_chain, home_list_index, seq),
    UNIQUE KEY snapshot_id (snapshot_id),
    KEY home_list (home_chain, home_list_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE TABLE IF NOT EXISTS list_share_mirrors (
    action_index         BIGINT UNSIGNED NOT NULL,
    home_chain           VARCHAR(10) NOT NULL,
    home_list_index      BIGINT UNSIGNED NOT NULL,
    block_index          BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_home_list (home_chain, home_list_index),
    UNIQUE KEY uq_action_index (action_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
