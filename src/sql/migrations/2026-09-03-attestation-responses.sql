-- xchain:migration mode=auto
-- Migration: attestation_responses, the hub-mirrored ATTEST response table.
--
-- WHY
-- ---
-- Before this table an attestation cost TWO on-chain transactions. The request is
-- an emission inside the EXECUTE the user already paid for, but the response was a
-- whole ATTEST v1 transaction the leader validator broadcast and paid a Bitcoin fee
-- for, and the contract callback fired only when it mined. A contract executed a
-- thousand times was a thousand validator-paid Bitcoin transactions, each waiting on
-- Bitcoin block time. PRICE rounds already solved the same shape of problem, so
-- ATTEST responses take that road: finalize over P2P, live in the hub DB, stream to
-- every indexer through the hub mirror, and land on chain periodically in
-- full-bodied ATTEST v5/v6 batches so the history stays reconstructible from chain
-- parse (the ATTEST response-mirror design).
--
-- Purely additive: one CREATE TABLE IF NOT EXISTS, no column changes on any existing
-- table, no data migration, nothing dropped. An indexer that has not been upgraded
-- simply lacks the table; it also cannot be served rows for it, because the whole
-- mirror parks on a HUB_SCHEMA_VERSION mismatch, and the response mirror is inert
-- below ATTEST_RESPONSE_MIRROR_ACTIVATION on every network with mainnet shipping null.
--
-- NOT parked in the baseline fixtures: the schema parity guards require a dated
-- migration whose composed shape is byte-identical to the definition file, and
-- forbid baseline-fixture shortcuts for exactly this case. The definition twin is
-- src/sql/attestation_responses.sql, itself byte-identical to the hub's authoring
-- copy and to the explorer's vendored mirror copy.

CREATE TABLE IF NOT EXISTS attestation_responses (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, -- hub-LOCAL paging cursor; stripped on mirror apply, never part of row identity
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; the mirror's scope and purge key
    request_id           CHAR(64)     NOT NULL,                    -- the v0 request id, lower-case hex; the row's identity
    request_action_index BIGINT UNSIGNED DEFAULT NULL,             -- the v0 row's action_index on BTC; ORDERING AID ONLY, the applier re-derives it from its own request row
    request_block_index  BIGINT UNSIGNED DEFAULT NULL,             -- the v0 row's BTC block; same status: informational, re-derived locally
    provider_id          VARCHAR(64)  NOT NULL,                    -- as in the on-chain v1
    status               VARCHAR(20)  NOT NULL,                    -- TERMINAL vocabulary only: 'ok' or 'expired'
    response_payload     MEDIUMTEXT,                               -- the agreed body, stored decoded as UTF-8 exactly as attests.response_payload is
    response_hash        CHAR(64)     NOT NULL,                    -- sha256 of the body bytes; the field the canonical already signs
    meta                 TEXT,                                     -- as in the on-chain v1
    effective_time       BIGINT UNSIGNED NOT NULL,                 -- unix seconds, leader-chosen, INSIDE the signed canonical: the applying block is a pure function of it
    signer_pubkeys       TEXT         NOT NULL,                    -- JSON array, ordered responsible-set pubkeys that signed
    signatures           TEXT         NOT NULL,                    -- JSON [{pubkey,sig}], Ed25519 over the mirror-era canonical
    widen                TINYINT UNSIGNED DEFAULT 0,               -- the widening step the leader used; INFORMATIONAL, the verifier recomputes it
    finalized_at         BIGINT UNSIGNED DEFAULT NULL              -- hub wall clock at quorum; AUDIT ONLY, never a consensus input, never compared across hubs
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Row identity within a network. request_id alone is already collision-free in
-- practice (it is a sha256 over chain data), but two hubs on different networks can
-- legitimately both be served through one mirror table during a re-point, and scoping
-- the key matches how every reader and _purgeForeignNetworkRows scope theirs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attest_response ON attestation_responses (network, request_id);
-- The applicability scan reads rows whose signed effective_time has been reached.
CREATE        INDEX IF NOT EXISTS idx_effective_time ON attestation_responses (network, effective_time);
-- Deterministic applier order within a block, and the batch publisher's window read.
CREATE        INDEX IF NOT EXISTS idx_request_order  ON attestation_responses (network, request_block_index, request_action_index);
