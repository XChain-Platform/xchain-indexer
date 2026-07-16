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

DROP TABLE IF EXISTS delegations;
CREATE TABLE delegations (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys
    status_id           BIGINT UNSIGNED,                 -- active/revoked
    block_index         BIGINT UNSIGNED NOT NULL,
    activation_block    BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- block when delegation becomes active
    deactivation_block  BIGINT UNSIGNED                       -- block when delegation becomes inactive (set on DELEGATE v2 revoke)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON delegations (action_index);
CREATE        INDEX source_id          ON delegations (source_id);
CREATE        INDEX signing_pubkey_id  ON delegations (signing_pubkey_id);
CREATE        INDEX status_id          ON delegations (status_id);
CREATE        INDEX activation_block   ON delegations (activation_block);
CREATE        INDEX deactivation_block ON delegations (deactivation_block);
