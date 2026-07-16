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

DROP TABLE IF EXISTS sweeps;
CREATE TABLE sweeps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    balances         BIGINT UNSIGNED,          -- Indicates if token balances should be swept
    ownerships       BIGINT UNSIGNED,          -- Indicates if token ownerships should be swept
    orders           BIGINT UNSIGNED,          -- Indicates if open ORDERs should be cancelled and escrow credited to DESTINATION
    swaps            BIGINT UNSIGNED,          -- Indicates if open SWAPs should be cancelled and escrow credited to DESTINATION
    dispensers       BIGINT UNSIGNED,          -- Indicates if open DISPENSERs should be closed and escrow credited to DESTINATION
    destination_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON sweeps (action_index);
CREATE        INDEX destination_id ON sweeps (destination_id);
CREATE        INDEX memo_id        ON sweeps (memo_id);
CREATE        INDEX status_id      ON sweeps (status_id);