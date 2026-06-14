DROP TABLE IF EXISTS contract_permissions;
CREATE TABLE contract_permissions (
    action_index    BIGINT UNSIGNED NOT NULL,         -- DEPLOY action that declared the manifest (== contract_index); rollback key
    contract_index  BIGINT UNSIGNED NOT NULL,         -- FK contracts.action_index (the contract this manifest governs)
    permissions     TEXT,                             -- JSON array of permitted emission action types; NULL = unrestricted (legacy / no manifest); '[]' = emits nothing
    max_take_bps    INT UNSIGNED,                     -- tighter per-contract royalty cap (<= global CONTROLLER_MAX_TAKE_BPS); NULL = global cap applies
    block_index     BIGINT UNSIGNED NOT NULL          -- block of the DEPLOY
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Phase E — contract permissions manifest. One row per contract that exports a `permissions`
-- and/or `maxTakeBps` manifest (read deterministically at deploy via vm.readManifest). The
-- declared values are immutable (contract code is immutable), so this is a static per-contract
-- policy table, not an event log: the indexer enforces the emission allowlist in
-- execute.js processEmission (all emission paths) and the per-contract maxTakeBps in
-- runControllerGuard. Keyed by the DEPLOY action_index so it rolls back cleanly as a dataTable
-- (DELETE WHERE action_index >= orphan) and is cleared by deleteContract on a failed deploy.
-- See xchain-documentation/protocol/Controller_Bound_Tokens.md.

CREATE UNIQUE INDEX action_index   ON contract_permissions (action_index);
CREATE        INDEX contract_index ON contract_permissions (contract_index);
CREATE        INDEX block_index    ON contract_permissions (block_index);
