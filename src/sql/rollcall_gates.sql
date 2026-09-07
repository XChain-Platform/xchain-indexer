-- Copyright © 2025–2026 Dankest, LLC
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md.
--
-- ROLLCALL gates, BTC side: which consensus gates each present validator's
-- build knew at a ROLLED epoch, as it signed them in ROLLCALL v1.
--
-- Written by the epoch close, one row per VERIFIED signer of a rolled epoch at
-- or above ROLLCALL_GATES_ACTIVATION, and by nothing else. An unrolled epoch
-- writes nothing here (it decides nothing), and a v0 epoch has no list to
-- record. This is the only BTC-side artifact the rules-aware attestation set
-- can read: ROLLCALL itself is DOGE-only, so rollcall_signers is empty on the
-- indexer the attestation set is derived on, and rollcalls.responsible_set_json
-- is keyed by SOURCE while the attestation set is keyed by PUBKEY.
--
-- The list is the PUBLISHER's, re-signed by every present validator: a signer
-- whose build knew a different list signed different bytes, verified against
-- nothing, and has no row here. So a row is a true statement that this key's
-- build accepted every gate named in it at that epoch.
--
-- READ RULE (rollcall_gates_filter.js): for a request at block H, the filter
-- takes the most recent rolled epoch whose close_block is at or below the
-- buried snapshot block (H - CANONICAL_REORG_BUFFER) and at or above the gates
-- height, and drops a pubkey whose row there is not a superset of the gates
-- active at H. Keyed on close_block, not epoch_height, because the rows exist
-- from the close block on: an epoch chosen by height alone could be selected
-- before its close had written anything, and a replay would then see a set the
-- live run did not. A pubkey with no row is never dropped.
--
-- rollback: 'special' on close_block, exactly like rollcalls: derived at the
-- close block and deleted with it. Not hashed: the verdict it feeds is hashed
-- downstream through attests.responsible_set_json.

CREATE TABLE IF NOT EXISTS rollcall_gates (
    epoch_height  BIGINT UNSIGNED NOT NULL,        -- BTC height of the roll-call epoch (a multiple of ROLLCALL_INTERVAL_BLOCKS)
    pubkey        CHAR(64)        NOT NULL,        -- present validator's Ed25519 signing key, lowercase hex
    close_block   BIGINT UNSIGNED NOT NULL,        -- the BTC block that closed the epoch and wrote this row (rollback anchor)
    gates_json    LONGTEXT        NOT NULL,        -- JSON array of sorted `<module>.<EXPORT>` gate keys, exactly as signed
    PRIMARY KEY (epoch_height, pubkey),
    KEY idx_rollcall_gates_close (close_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
