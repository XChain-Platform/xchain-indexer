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

-- xchain:migration mode=auto
--
-- WHY: TIMESTAMP stops at 2038. UTC makes the stored instant become the same
-- DATETIME literal during conversion.
--
-- IDEMPOTENT: MODIFY to the same type is a no-op.

SET time_zone = '+00:00';
ALTER TABLE bridge_transfers MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE policy_snapshots MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
