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

DROP TABLE IF EXISTS stakes;
CREATE TABLE stakes (
    action_index        BIGINT UNSIGNED NOT NULL,        -- FK to actions table (each STAKE action gets its own row)
    source_id           BIGINT UNSIGNED NOT NULL,        -- FK to index_addresses (staking address)
    version             TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- STAKE format: 1=new stake, 2=top-up of existing stake
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (Ed25519 hot key)
    amount              VARCHAR(250) NOT NULL,           -- XCHAIN added by this action (active stake = SUM of amounts for pubkey)
    status_id           BIGINT UNSIGNED,                 -- valid/invalid/etc
    block_index         BIGINT UNSIGNED NOT NULL,
    activation_block    BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- block when this stake row becomes active (block_index + ACTIVATION_DELAY_BLOCKS)
    deactivation_block  BIGINT UNSIGNED                       -- block when this stake row becomes inactive (set on UNSTAKE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON stakes (action_index);
CREATE        INDEX source_id          ON stakes (source_id);
CREATE        INDEX signing_pubkey_id  ON stakes (signing_pubkey_id);
CREATE        INDEX status_id          ON stakes (status_id);
CREATE        INDEX activation_block   ON stakes (activation_block);
CREATE        INDEX deactivation_block ON stakes (deactivation_block);
CREATE        INDEX version            ON stakes (version);
