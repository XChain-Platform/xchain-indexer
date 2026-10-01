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

DROP TABLE IF EXISTS list_transfers;
CREATE TABLE list_transfers (
    action_index      BIGINT UNSIGNED NOT NULL,
    list_action_index BIGINT UNSIGNED,
    destination_id   BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON list_transfers (action_index);
CREATE        INDEX list_action_index ON list_transfers (list_action_index);
CREATE        INDEX destination_id    ON list_transfers (destination_id);
