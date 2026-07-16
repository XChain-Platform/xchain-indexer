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
-- Migration: relax the attests (request_id, version) index from UNIQUE to non-unique.
--
-- The retry-then-ok attestation lifecycle (#4373) legitimately produces MULTIPLE v1
-- response rows for one request_id: a retryable round (no_quorum / timeout / provider_error)
-- leaves the request pending, and a later terminal `ok` round must also land. The old
-- UNIQUE(request_id, version) index rejected the second v1 INSERT, so the ok was never
-- recorded and the request expired instead of fulfilling. Each v1 round is its own
-- immutable, action-indexed on-chain action (covered by the action-scoped consensus hash
-- and rolled back by action_index), so allowing multiple rows stays deterministic and
-- reorg-safe. v0 single-request integrity is now enforced in code (createAttestationRequest
-- keeps the first v0 row canonical and skips a duplicate for an existing request_id).
--
-- Fresh installs get the corrected non-unique index from src/sql/attests.sql. This
-- migration relaxes the index on already-provisioned databases. Relaxing UNIQUE to
-- non-unique can never fail on existing data (every prior row was already distinct).
-- Idempotent: the DROP is IF EXISTS, and the recreate follows it so the index is always
-- present afterward as non-unique. Part of a coordinated consensus deploy + clean reindex.
--
-- HOW TO RUN (manual path)
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-06-17-attests-drop-unique-request-id-version.sql

ALTER TABLE attests DROP INDEX IF EXISTS request_id_version;
CREATE INDEX request_id_version ON attests (request_id, version);
