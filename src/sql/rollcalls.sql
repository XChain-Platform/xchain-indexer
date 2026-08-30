-- Copyright © 2025–2026 Dankest, LLC
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md.
--
-- ROLLCALL epoch closes, BTC side. One row per epoch that reached its close
-- block, whether or not it rolled.
--
-- An UNROLLED epoch still writes its row, with rolled = 0 and no absences. That
-- is not bookkeeping: the K-streak has to know which epochs to SKIP, and an
-- epoch that is simply missing from this table is indistinguishable from one
-- that has not closed yet. An unrolled epoch counts for nobody -- a partition, a
-- fee spike, a dead federation or a truncated validator read can never evict
-- anyone -- so it must be recorded as "happened, decided nothing".
--
-- rollback: 'block'. These rows are derived at the close block and delete with
-- it, so a reorg past C removes the epoch's verdict along with the synthetic
-- UNSTAKE actions and the reward row it produced.

CREATE TABLE IF NOT EXISTS rollcalls (
    epoch_height   BIGINT UNSIGNED NOT NULL,       -- BTC height of the roll-call epoch (a multiple of ROLLCALL_INTERVAL_BLOCKS)
    snapshot_block BIGINT UNSIGNED NOT NULL,       -- buried snapshot the responsible set R(E) was resolved at
    close_block    BIGINT UNSIGNED NOT NULL,       -- C = E + ACCEPT_WINDOW + PROOF_DELAY; the block that wrote this row
    rolled         TINYINT UNSIGNED NOT NULL,      -- 1 = present set met the whole-federation stake-weighted threshold; 0 = counts for nobody
    PRIMARY KEY (epoch_height),
    KEY idx_rollcalls_close (close_block),
    KEY idx_rollcalls_rolled (rolled, epoch_height)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
