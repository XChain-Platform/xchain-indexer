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

DROP TABLE IF EXISTS reward_claims;
CREATE TABLE reward_claims (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,
    amount              VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON reward_claims (action_index);
-- Composite (source_id, block_index): the other half of getUnclaimedRewardTotal SUMs a
-- source's valid claims, block-scoped for replay determinism. The composite range-scans
-- exactly the source's at-or-before-block rows and covers `WHERE source_id=?` as a leading
-- prefix, so it replaces the old single-column source_id index.
CREATE        INDEX source_block  ON reward_claims (source_id, block_index);
CREATE        INDEX status_id    ON reward_claims (status_id);
