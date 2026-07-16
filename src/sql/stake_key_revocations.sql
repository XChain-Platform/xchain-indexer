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

DROP TABLE IF EXISTS stake_key_revocations;
CREATE TABLE stake_key_revocations (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (the revoked stake signing key)
    status_id           BIGINT UNSIGNED,                 -- valid/invalid
    block_index         BIGINT UNSIGNED NOT NULL,
    deactivation_block  BIGINT UNSIGNED NOT NULL         -- block when the revoked stake key stops being a valid signer
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON stake_key_revocations (action_index);
CREATE        INDEX source_id          ON stake_key_revocations (source_id);
CREATE        INDEX signing_pubkey_id  ON stake_key_revocations (signing_pubkey_id);
CREATE        INDEX deactivation_block ON stake_key_revocations (deactivation_block);
