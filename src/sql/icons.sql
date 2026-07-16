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

DROP TABLE IF EXISTS icons;
CREATE TABLE icons (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    token_id         BIGINT UNSIGNED NOT NULL,                       -- references tokens.id
    description_hash CHAR(32) DEFAULT NULL,                          -- md5 of tokens.description we last processed (drives invalidation)
    source_url       VARCHAR(500) DEFAULT NULL,                      -- URL we last fetched from (post-resolver)
    source_hash      CHAR(32) DEFAULT NULL,                          -- md5 of the bytes we fetched
    icon_hash        CHAR(32) DEFAULT NULL,                          -- md5 of the generated PNG
    status           ENUM('pending','ok','failed','stale') NOT NULL DEFAULT 'pending',
    attempts         INT UNSIGNED NOT NULL DEFAULT 0,
    last_error       VARCHAR(255) DEFAULT NULL,
    next_retry_at    DATETIME DEFAULT NULL,                          -- backoff: don't reprocess before this time
    last_checked_at  DATETIME DEFAULT NULL,
    created          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX token_id        ON icons (token_id);
CREATE        INDEX status          ON icons (status);
CREATE        INDEX next_retry_at   ON icons (next_retry_at);
CREATE        INDEX last_checked_at ON icons (last_checked_at);
