-- xchain:migration mode=auto
-- Migration: attests.origin_chain / attests.origin_action_index
-- (attestation Phase 5 cross-chain relay).
--
-- WHY
-- ---
-- The relay correlates one logical attestation across two chains: an ATTEST v0
-- emitted by an LTC or DOGE contract, and the ATTEST v3 that materializes it
-- onto BTC so BTC-staked validators can fulfill it at a real BTC block_index.
-- Both rows need to name that pairing:
--
--   origin_chain         on a BTC v3 row, the chain the request came from; on an
--                        origin v0 row, that chain itself, which is what marks the
--                        row relay-eligible for the hub's poll. NULL on every
--                        native single-chain request, so existing rows and every
--                        pre-activation replay are unaffected.
--   origin_action_index  the origin chain's v0 action_index, the correlation key
--                        the response leg (ATTEST v4) relays back on.
--
-- The lookup index serves the hub's relay poll (relay-eligible pending requests
-- on this chain) and the BTC side's origin-row resolution, both of which would
-- otherwise scan attests.
--
-- Additive + idempotent: ADD COLUMN / ADD INDEX IF NOT EXISTS re-run as no-ops,
-- and the column specs plus the AFTER anchor match attests.sql exactly. Safe to
-- apply ahead of the flag-day: with ATTEST_RELAY_ACTIVATION and
-- ATTEST_RELAY_ORIGIN both inert, nothing ever writes a non-NULL value.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-30-attests-add-relay-origin-columns.sql

ALTER TABLE attests ADD COLUMN IF NOT EXISTS origin_chain VARCHAR(8) AFTER responsible_set_json;
ALTER TABLE attests ADD COLUMN IF NOT EXISTS origin_action_index BIGINT UNSIGNED AFTER origin_chain;
ALTER TABLE attests ADD INDEX IF NOT EXISTS origin_chain_status (origin_chain, request_status, version);
