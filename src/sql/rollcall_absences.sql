-- Copyright © 2025–2026 Dankest, LLC
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md.
--
-- ROLLCALL absences, BTC side. One row per source in the responsible set R(E)
-- that was NOT present at a ROLLED epoch. Unrolled epochs write no absences.
--
-- KEYED ON SOURCE, NOT ON SIGNING KEY, and that is a correctness requirement
-- rather than a preference. Weight is per source: a DELEGATE key owns no stake
-- row, so a key-keyed eviction would be a permanent no-op against a delegated
-- validator, while evicting a rotated source's OLD key would un-member the live
-- delegated key that replaced it. A source is present if ANY of its effective
-- keys signed.
--
-- PINNED AT CLOSE, never re-derived. SLASH rewrites stakes.amount in place, so
-- R(E) recomputed later can differ from the set this verdict was actually taken
-- over; a streak counted against a re-derived set would evict on arithmetic
-- nobody performed at the time. The count is a query over these rows, never a
-- stored counter.
--
-- `evicted` marks the rows that actually triggered an eviction at this close. It
-- is the rollback key: the delegations repair clause finds the affected sources
-- by looking for evicted = 1 in the rolled-back range, because the eviction
-- writes no DELEGATE-revoke row for the generic repair to self-join on.

CREATE TABLE IF NOT EXISTS rollcall_absences (
    epoch_height BIGINT UNSIGNED NOT NULL,         -- the ROLLED epoch this absence was pinned at
    source_id    BIGINT UNSIGNED NOT NULL,         -- staking source that was in R(E) and did not sign
    close_block  BIGINT UNSIGNED NOT NULL,         -- C, the block that wrote this row
    evicted      TINYINT UNSIGNED NOT NULL,        -- 1 = this absence completed a K-streak and evicted the source at close_block
    PRIMARY KEY (epoch_height, source_id),
    KEY idx_rollcall_absences_source (source_id, epoch_height),
    KEY idx_rollcall_absences_close (close_block),
    KEY idx_rollcall_absences_evicted (evicted, close_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
