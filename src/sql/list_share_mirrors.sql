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

CREATE TABLE list_share_mirrors (
    action_index         BIGINT UNSIGNED NOT NULL,
    home_chain           VARCHAR(10) NOT NULL,
    home_list_index      BIGINT UNSIGNED NOT NULL,
    block_index          BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_home_list (home_chain, home_list_index),
    UNIQUE KEY uq_action_index (action_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
