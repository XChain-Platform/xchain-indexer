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

DROP TABLE IF EXISTS events;
CREATE TABLE events (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    time DATETIME,
    code VARCHAR(50),
    data VARCHAR(250),
    witness_time DATETIME,           -- #2735: REORG marker witness - the decoder event's `time` when recorded; NULL on legacy markers / non-REORG rows
    witness_hash CHAR(64)            -- #2735: REORG marker witness - sha256 of the decoder event's data payload when recorded; NULL on legacy markers / non-REORG rows
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX code_id ON events (code, id);

