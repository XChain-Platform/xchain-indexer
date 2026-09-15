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
--  an explicit `node src/migrate.js` run. Safe to run with the indexer live: it writes
--  one read-model column the block pipeline never reads, and it only ever fills a NULL.)
--
-- Migration: backfill issues.transfer_supply_id from the ledger rows the same ISSUE wrote
--
-- WHY
-- ---
-- ISSUE.TRANSFER_SUPPLY is an ADDRESS, but it sat in config NUMBER_FIELDS, and
-- normalizeDataValues() nulls every NUMBER_FIELDS entry whose value is not numeric. An
-- address is never numeric, so createIssue() stored transfer_supply_id = NULL on every
-- ISSUE that transferred its initial supply, on every chain, since the column existed.
--
-- The LEDGER IS UNAFFECTED. issue.js builds its credits/debits from the un-normalized
-- `data` copy, so the recipient was credited correctly and balances/supply are right.
-- What broke is the REORG RECOMPUTE: rollback.js's `issues` recompute query reads
-- `m.transfer_supply_id` to collect the addresses whose balances must be recomputed after
-- a rollback (a4.address -> row.address3 -> util.addAddressTicker). Against an
-- always-NULL column that address was never collected, so a reorg that unwound an ISSUE
-- left the recipient's balance row stale until some later action touched it.
--
-- src/config.js no longer lists TRANSFER_SUPPLY in NUMBER_FIELDS and
-- test/unit/number-fields-exclude-address-fields.test.js keeps the whole address-bearing
-- class out of it, so new ISSUEs store the column. Only rows already written need this
-- one-time repair, and nothing re-touches them on its own: `issues` rows are per-action
-- audit rows, never rewritten except by a re-index of that exact action.
--
-- CONSENSUS IS NOT AFFECTED. No consensus reader touches this column: the only readers
-- are rollback.js's recompute set, db.js getActionData(), and the explorer read model
-- (action-detail/tokens.js, db/readers/action-lists.js). stateHash.js does not read
-- `issues` at all. So this rewrite cannot fork a chain, and it can run against a live
-- indexer.
--
-- DERIVATION
-- ----------
-- Recomputed from the un-normalized copy of TRANSFER_SUPPLY that the same action already
-- persisted: its ledger rows. For a valid ISSUE carrying MINT_SUPPLY and TRANSFER_SUPPLY,
-- src/actions/issue.js pushes exactly
--
--     credits: (TICK, MINT_SUPPLY, SOURCE), (TICK, MINT_SUPPLY, TRANSFER_SUPPLY)
--     debits : (TICK, MINT_SUPPLY, SOURCE)
--
-- (the debit pair is pushed ONLY when both MINT_SUPPLY and TRANSFER_SUPPLY are set, and
-- TRANSFER_SUPPLY == SOURCE is deleted upstream, so the two credit addresses always
-- differ), plus, when the platform fee is paid from an XCHAIN balance, a fee debit from
-- SOURCE and - for METHOD > 1 - a fee credit to the configured donation address. Those
-- ledger rows are consolidated per (tick, address), so each address appears at most once
-- per table per action.
--
-- The recipient is therefore the single credit row for this action, in the ISSUE's own
-- tick, whose address was NOT debited in that same tick and is NOT the action's fee
-- destination. Three guards keep that identification exact:
--
--   1. a debit must exist for (action_index, tick_id). Without it, a plain ISSUE that
--      minted to itself (credit to SOURCE, no debit) would have exactly one undebited
--      credit - SOURCE - and would be mis-healed to its own issuer.
--   2. the fee destination is excluded. It matters only in the pathological case where
--      the ISSUE's own tick IS the fee tick (a re-ISSUE of the gas token with METHOD > 1):
--      there the donation credit is undebited too, and without this clause it would be
--      mistaken for the supply recipient.
--   3. exactly one candidate must remain. Anything ambiguous is left NULL rather than
--      guessed.
--
-- WHAT IT DOES NOT HEAL, deliberately:
--   * INVALID ISSUEs. A non-valid ISSUE writes its `issues` row but no credits/debits, so
--     no un-normalized copy of the address survives. It also moved no balance, so it is
--     not in the reorg-recompute defect's blast radius; the row stays NULL as an
--     unrecoverable read-model gap.
--   * ISSUEs with TRANSFER_SUPPLY but no MINT_SUPPLY. Same reason - no ledger rows, and
--     no balance to recompute.
--
-- IDEMPOTENT: `transfer_supply_id IS NULL` makes a re-run a no-op, and the statement
-- never clears a value. Fresh installs need it too: the ledger records it once per DB,
-- and on an empty `issues` it matches nothing.

-- `UPDATE issues AS i` + an UNQUALIFIED SET target: the one spelling both MariaDB (the
-- deployed engine) and sqlite (the engine the unit test drives this file on for real)
-- accept, so the shipped file itself is what the test executes.
UPDATE issues AS i
   SET transfer_supply_id = (
        SELECT c.address_id
          FROM credits c
         WHERE c.action_index = i.action_index
           AND c.tick_id      = i.tick_id
           AND c.address_id IS NOT NULL
           AND NOT EXISTS (
                SELECT 1
                  FROM debits d
                 WHERE d.action_index = i.action_index
                   AND d.tick_id      = i.tick_id
                   AND d.address_id   = c.address_id
           )
           AND NOT EXISTS (
                SELECT 1
                  FROM fees f
                 WHERE f.action_index   = i.action_index
                   AND f.destination_id = c.address_id
           )
   )
 WHERE i.transfer_supply_id IS NULL
   AND i.tick_id IS NOT NULL
   AND EXISTS (
        SELECT 1
          FROM debits d2
         WHERE d2.action_index = i.action_index
           AND d2.tick_id      = i.tick_id
   )
   AND (
        SELECT COUNT(*)
          FROM credits c2
         WHERE c2.action_index = i.action_index
           AND c2.tick_id      = i.tick_id
           AND c2.address_id IS NOT NULL
           AND NOT EXISTS (
                SELECT 1
                  FROM debits d3
                 WHERE d3.action_index = i.action_index
                   AND d3.tick_id      = i.tick_id
                   AND d3.address_id   = c2.address_id
           )
           AND NOT EXISTS (
                SELECT 1
                  FROM fees f2
                 WHERE f2.action_index   = i.action_index
                   AND f2.destination_id = c2.address_id
           )
       ) = 1;
