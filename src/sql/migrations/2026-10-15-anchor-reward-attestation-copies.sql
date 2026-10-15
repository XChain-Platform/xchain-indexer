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
-- Migration: every distinct copy of a mirrored anchor reward tuple (src/sql/anchor_reward_attestation_copies.sql).

CREATE TABLE IF NOT EXISTS anchor_reward_attestation_copies (
    id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    chain                  VARCHAR(10)  NOT NULL,
    network                VARCHAR(20)  NOT NULL,
    reward_type            VARCHAR(32)  NOT NULL,
    round_reference        BIGINT UNSIGNED NOT NULL,
    snapshot_block         BIGINT UNSIGNED NOT NULL,
    publisher              VARCHAR(64)  NOT NULL,
    publisher_attestations TEXT         NOT NULL,
    doge_anchor_txid       VARCHAR(64)  DEFAULT NULL,
    copy_digest            CHAR(64)     NOT NULL,
    UNIQUE KEY uq_reward_copy (chain, network, reward_type, round_reference, snapshot_block, publisher, copy_digest),
    KEY idx_snapshot_block (network, snapshot_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
