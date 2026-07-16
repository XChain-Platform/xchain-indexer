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
-- Migration: widen attests.request_status ENUM to include 'rejected'
--
-- ATTEST v0 (request) rows that fail structural validation (oversize payload,
-- unknown provider, disallowed redundancy, out-of-window deadline, insufficient
-- fee funds, bad request_id derivation, …) were previously persisted with
-- request_status='pending' regardless of the validation outcome — the lifecycle
-- column was hardcoded before `error` was evaluated. Every downstream consumer
-- keys solely off request_status='pending' (the hub's pending poll, the
-- block-level deadline-expiry sweep, and the v1 response path), so a
-- protocol-rejected request was indistinguishable from a valid one and flowed
-- through the full fetch → quorum → callback EXECUTE pipeline.
--
-- The handler now records invalid requests as request_status='rejected', a new
-- terminal value that none of those pending-only consumers select. This
-- migration adds 'rejected' to the live ENUM so existing databases accept the
-- new value. Purely additive ENUM widening — MODIFY to the same definition is a
-- no-op, so the migration is idempotent and safe to re-run. No data backfill:
-- historical rows keep their existing status.

ALTER TABLE attests
    MODIFY request_status ENUM('pending','fulfilled','expired','errored','rejected');
