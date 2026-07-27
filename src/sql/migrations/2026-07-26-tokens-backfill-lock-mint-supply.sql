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

-- xchain:migration mode=manual
-- (manual: this is a data backfill, not DDL. The runner's auto-apply guard flags every
--  UPDATE that is not the AUTO_INCREMENT id repair, so a backfill can only land through
--  an explicit `node src/migrate.js` run. Safe to run with the indexer live: it is a
--  one-directional set of a read-model column the block pipeline does not read.)
--
-- Migration: backfill tokens.lock_mint_supply from the issues rows
--
-- WHY
-- ---
-- createToken() derived and wrote six of the seven token locks and omitted
-- lock_mint_supply entirely, so tokens.lock_mint_supply stayed at its column default (0)
-- on every chain, for every token, even where the lock was set and the chain enforces it
-- . db.js now writes the column, but only tokens re-touched by a later ISSUE
-- would heal on their own, so every already-issued token needs this one-time repair.
--
-- CONSENSUS IS NOT AFFECTED. The enforcement path (issue.js "Verify MINT_SUPPLY is
-- allowed and LOCK_MINT_SUPPLY is not set") reads getTokenInfo(), which re-folds the
-- `issues` ACTION rows, and those rows always carried the flag. tokens.lock_mint_supply
-- feeds only the read model (explorer/SDK `locks.mint_supply`, and through it the
-- wallet's mint form and lock matrix), and no state/block hash covers it: stateHash.js
-- reads tokens.supply only. So this rewrite cannot fork a chain.
--
-- DERIVATION
-- ----------
-- Exactly the rule getTokenInfo() applies: fold the VALID issues rows for the ticker in
-- action order, and a LOCK_ flag can only ever go 0 -> 1 ("Disallow unsetting of LOCK
-- flags"). A sticky-set fold over an ordered scan collapses to "any valid ISSUE for this
-- ticker set the flag", which is what the EXISTS below asks. issues.lock_mint_supply is
-- VARCHAR(1), so compare against the string '1' (the value createIssue writes).
--
-- IDEMPOTENT: the WHERE clause makes a re-run a no-op once the rows are set, and the
-- statement never clears a flag. Fresh installs need it too: the ledger records it once
-- per DB, and on an empty `tokens` it matches nothing.

UPDATE tokens t
   SET t.lock_mint_supply = 1
 WHERE t.lock_mint_supply <> 1
   AND EXISTS (
        SELECT 1
          FROM issues i
          INNER JOIN index_statuses s ON (s.id = i.status_id)
         WHERE i.tick_id = t.tick_id
           AND s.status  = 'valid'
           AND i.lock_mint_supply = '1'
   );
