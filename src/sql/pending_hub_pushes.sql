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

DROP TABLE IF EXISTS pending_hub_pushes;
CREATE TABLE pending_hub_pushes (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    push_type           VARCHAR(32) NOT NULL,                     -- 'price_round' (PRICE v0) | 'oracle_price' (PRICE v1) | 'price_retraction' | 'xcall_retraction' | 'match_retraction' (reorg write-ahead retractions, staged inside the rollback transaction and exempt from its purge)
    action_index        BIGINT UNSIGNED NOT NULL,                 -- source PRICE action; lets a reorg purge queued pushes for orphaned actions
    payload             TEXT NOT NULL,                            -- JSON args for the hub JSON-RPC call
    attempts            INT UNSIGNED NOT NULL DEFAULT 0,          -- delivery attempts made so far
    last_attempted_at   DATETIME NULL,                           -- time of most recent attempt (NULL = not yet tried by poller)
    last_error          VARCHAR(500),                            -- last failure message (diagnostics only)
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',   -- pending | failed  (delivered rows are deleted)
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)                                              -- AUTO_INCREMENT column must be a key, else ER_WRONG_AUTO_KEY (table never creates → indexer can't init)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX status       ON pending_hub_pushes (status);
CREATE INDEX push_type    ON pending_hub_pushes (push_type);
CREATE INDEX action_index ON pending_hub_pushes (action_index);
CREATE INDEX created_at   ON pending_hub_pushes (created_at);
