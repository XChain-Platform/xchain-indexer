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

-- Maps a source address to its public key, copied from the decoder at index time

DROP TABLE IF EXISTS pubkeys;
CREATE TABLE pubkeys (
  address_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  -- 130 hex chars to hold uncompressed (65-byte) source_pubkey values copied from
  -- the decoder; VARCHAR(66) silently truncated/dropped them across the seam.
  pubkey     VARCHAR(130) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
