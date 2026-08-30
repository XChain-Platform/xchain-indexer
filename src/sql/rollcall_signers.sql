-- Copyright © 2025–2026 Dankest, LLC
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md.
--
-- ROLLCALL presence signatures, DOGE side.
--
-- A first-seen index, not a ledger: the DOGE indexer has no BTC view (no stake
-- rows, no BTC ledger hashes, no responsible set), so it verifies each signature
-- STRUCTURALLY against the canonical rebuilt from the carried fields and stores
-- the raw material. Every question about who those signers are is answered
-- BTC-side at the epoch close, which re-verifies against its OWN ledger_hash.
--
-- The unique key on (epoch_height, pubkey) is what makes this a first-seen
-- index: the first valid signature landed for a key in an epoch is the one
-- served, inserted with INSERT IGNORE. No spam row can pre-empt a real signer,
-- because only the holder of that key can produce a signature that verifies,
-- and a real signature carried under a wrong LEDGER_HASH never gets here.
--
-- Rows for epochs that never close, or over hashes the BTC side will reject,
-- are fee-priced inert rows -- the same class as any other spam action.
--
-- Raw hex, never ids (the anchor_actions model): a federation read must answer
-- from this table without joining a mapper the caller cannot reproduce.

CREATE TABLE IF NOT EXISTS rollcall_signers (
    epoch_height  BIGINT UNSIGNED NOT NULL,        -- BTC height of the roll-call epoch (a multiple of ROLLCALL_INTERVAL_BLOCKS)
    pubkey        CHAR(64)        NOT NULL,        -- present validator's Ed25519 signing key, lowercase hex
    sig           CHAR(128)       NOT NULL,        -- signature over the EQUIV-wrapped canonical, lowercase hex
    ledger_hash   CHAR(64)        NOT NULL,        -- BTC ledger_hash at epoch_height AS CARRIED; the BTC close compares it to its own and discards a mismatch
    publisher     CHAR(64)        NOT NULL,        -- publishing validator's signing key; what the publish reward attaches to
    action_index  BIGINT UNSIGNED NOT NULL,        -- the ROLLCALL action this signature landed in
    block_index   BIGINT UNSIGNED NOT NULL,        -- DOGE block the action landed in (window cut + rollback anchor)
    PRIMARY KEY (epoch_height, pubkey),
    KEY idx_rollcall_signers_action (action_index),
    KEY idx_rollcall_signers_block (block_index),
    KEY idx_rollcall_signers_epoch_pub (epoch_height, publisher)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
