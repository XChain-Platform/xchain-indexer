-- Copyright © 2025–2026 Dankest, LLC
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md.
--
-- ROLLCALL actions, DOGE side: one row per VALID ROLLCALL action.
--
-- rollcall_signers is a first-seen index keyed on (epoch_height, pubkey), so a
-- valid ROLLCALL whose every pubkey was already landed by an earlier action
-- writes no signer row and would be invisible to a reader grouping that table by
-- action_index. This table records the action itself so an explorer can list and
-- render it. It decides nothing: the BTC close still reads rollcall_signers only.
--
-- `carried_count` is the number of signatures that verified in the action;
-- `first_seen_count` is how many of those were new to the epoch when it landed,
-- so carried_count - first_seen_count is the number of already-seen pubkeys.
-- `gates` is the v1 GATES field as carried, NULL on a v0 row.
CREATE TABLE IF NOT EXISTS rollcall_actions (
    action_index     BIGINT UNSIGNED NOT NULL,     -- the ROLLCALL action
    block_index      BIGINT UNSIGNED NOT NULL,     -- DOGE block the action landed in
    epoch_height     BIGINT UNSIGNED NOT NULL,     -- BTC height of the roll-call epoch
    ledger_hash      CHAR(64)        NOT NULL,     -- BTC ledger_hash AS CARRIED, lowercase hex
    publisher        CHAR(64)        NOT NULL,     -- publishing validator's signing key, lowercase hex
    gates            TEXT            DEFAULT NULL, -- ROLLCALL v1 GATES field as carried; NULL for v0
    carried_count    INT UNSIGNED    NOT NULL,     -- verified signatures carried by this action
    first_seen_count INT UNSIGNED    NOT NULL,     -- of those, pubkeys first landed by this action for the epoch
    PRIMARY KEY (action_index),
    KEY idx_rollcall_actions_epoch (epoch_height, action_index),
    KEY idx_rollcall_actions_block (block_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
