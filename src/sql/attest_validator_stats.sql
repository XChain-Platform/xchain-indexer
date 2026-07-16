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

-- Per-validator attestation accountability rollup, keyed by (validator_pubkey,
-- provider_id). A cross-attestation aggregate — it cannot fold into `attests`
-- because missed_count/slashed_count record absences (a responsible validator
-- that did NOT sign), which aren't derivable from the response rows themselves.
-- Counters are written incrementally by the ATTEST handler and recomputed on
-- reorg by Rollback._recomputeAttestationValidatorStats(). See src/rollback.js.
DROP TABLE IF EXISTS attest_validator_stats;
CREATE TABLE attest_validator_stats (
    validator_pubkey   CHAR(64) NOT NULL,                -- 32-byte Ed25519 pubkey (hex)
    provider_id        VARCHAR(32) NOT NULL,             -- attestation provider type (e.g. 'http_get')
    fulfilled_count    BIGINT UNSIGNED NOT NULL DEFAULT 0, -- valid signatures contributed to a fulfilled response
    missed_count       BIGINT UNSIGNED NOT NULL DEFAULT 0, -- responsible-set rounds that timed out without this validator's sig
    slashed_count      BIGINT UNSIGNED NOT NULL DEFAULT 0, -- recorded slash events (Phase 4)
    quality_score      DECIMAL(8,4) NOT NULL DEFAULT 0,  -- normalized 0..1 quality metric (Phase 4)
    last_updated_block BIGINT UNSIGNED                   -- most recent block this row was touched
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX validator_pubkey_provider ON attest_validator_stats (validator_pubkey, provider_id);
CREATE        INDEX provider_id               ON attest_validator_stats (provider_id);
CREATE        INDEX last_updated_block        ON attest_validator_stats (last_updated_block);
