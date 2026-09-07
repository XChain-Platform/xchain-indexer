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

DROP TABLE IF EXISTS messages;
-- TODO : Convert encryption_method field to INTEGER UNSIGNED and force value to 0-9 (0=null)
CREATE TABLE messages (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    coin                VARCHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,               -- Destination coin network (BTC, LTC, DOGE)
    destination_id      BIGINT UNSIGNED,          -- id of record in index_addresses table
    encryption_method   VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,               -- Encryption Method (1=ECIES, 2=ECDH, 3=AES)
    -- utf8mb4: all three land on the wire verbatim and are only length-checked, so a
    -- 4-byte character reaches the column whether or not the MESSAGE validates.
    encryption_key      MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- Public key to be used to exchange messages
    encrypted_message   MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- Encrypted Message
    plaintext_message   MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, -- Plaintext Message
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON messages (action_index);
CREATE        INDEX coin              ON messages (coin);
CREATE        INDEX encryption_method ON messages (encryption_method);
CREATE        INDEX destination_id    ON messages (destination_id);
CREATE        INDEX status_id         ON messages (status_id);
