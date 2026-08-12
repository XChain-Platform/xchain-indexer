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
-- Migration: gated_files gains gate_min_amount + publisher_address (PC-29)
--
-- WHY
-- ---
-- FILE format 0 gains an optional ninth field, GATE_MIN_AMOUNT: the minimum
-- balance of GATE_TICKER a recipient must hold to be given the decryption key.
-- Two columns, not one, because the threshold is only half of it.
--
-- publisher_address is load-bearing. A "pack" (files that unlock together) is
-- keyed (publisher_address, gate_ticker, key_hash), not the older
-- (gate_ticker, key_hash), and the effective threshold of a pack is the MINIMUM
-- gate_min_amount across its files. gate_ticker and key_hash are BOTH public on
-- chain, so without the publisher in the key one publisher's file could join
-- another's pack and drag its threshold down, or (via a NULL threshold) force it
-- unconditional forever.
--
-- Publication is issuer-restricted at HEAD (actions/file.js rejects a SOURCE that
-- is not the GATE_TICKER issuer), so that exposure is not open to outsiders
-- today. The reason the column is still required is quieter: tick ownership
-- TRANSFERS. Without it, a former issuer's files and the current issuer's files
-- share one pack, and the old owner's threshold keeps governing a tick they no
-- longer control.
--
-- BOTH ARE ADDITIVE AND NULLABLE, SO THIS IS PRE-WINDOW SAFE
-- ----------------------------------------------------------
-- Unlike the state_checkpoints fence migration (which tightens a unique key and
-- must wait for §8 step 4a), this one only ADDS nullable/defaulted columns. Old
-- code neither reads nor writes them and is unaffected, so it is mode=auto and
-- applies at boot with the rest of the pre-window migrations (spec §8 step 2).
--
-- NO BACKFILL, AND NONE IS POSSIBLE FOR THE THRESHOLD
-- ---------------------------------------------------
-- gate_min_amount has no historical value to recover: no conforming emitter has
-- ever produced a nine-field FILE (the SDK dropped unknown positional fields), so
-- every pre-existing row is genuinely unconditional and NULL is correct.
--
-- publisher_address defaults to '' rather than being backfilled here. Under a
-- fleet-wide rebase every indexer DB is rebuilt from the base schema and replayed, so
-- the column is populated from each FILE's SOURCE during replay and the default
-- is never observed. A DB that was NOT rebuilt keeps '' on its historical rows,
-- which collapses them into a single legacy pack per (gate_ticker, key_hash):
-- exactly the prior behaviour, so such a DB degrades to what it already did
-- rather than mis-scoping anything. Backfilling it correctly would require
-- joining every gated FILE back to its action SOURCE, which the replay does for
-- free and which a live migration should not attempt.

ALTER TABLE gated_files
    ADD COLUMN IF NOT EXISTS publisher_address VARCHAR(255) NOT NULL DEFAULT '' AFTER key_hash;

ALTER TABLE gated_files
    ADD COLUMN IF NOT EXISTS gate_min_amount VARCHAR(40) NULL AFTER publisher_address;

-- Pack lookup key: the SEND threshold check resolves packs by
-- (publisher_address, gate_ticker, key_hash), so index in that order.
CREATE INDEX IF NOT EXISTS gated_files_pack ON gated_files (publisher_address, gate_ticker, key_hash);
