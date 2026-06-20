DROP TABLE IF EXISTS recovery_pending_rewards;
-- Recovery-local staging for archived validator rewards (F1a id-determinism fix).
--
-- recovery.js used to pre-seed reward-source addresses via createAddress() OUTSIDE a
-- block tx (legacy AUTO_INCREMENT, block_index NULL) BEFORE the reindex. Because
-- getNextAddressId() is MAX(id)+1 over ALL rows, those low pre-seeded ids offset every
-- subsequent in-block deterministic id, so a recovered node built a DIFFERENT
-- index_addresses id map than a from-genesis node (forking ^id resolution and breaking
-- validator_rewards parity across the recovery boundary).
--
-- Instead recovery now stages each archived reward here keyed by the RAW source address
-- string + signing pubkey, assigning NO index id. During the reindex, when an address
-- first receives its deterministic in-block id (db.js createAddress), the apply hook
-- materializes that address's staged rewards into validator_rewards under the just-assigned
-- deterministic source_id. The counter is never perturbed out-of-band, so a recovered node
-- reproduces the exact from-genesis id map.
--
-- This is a restore-time scratch artifact: recovery-local, NOT consensus-hashed and NOT
-- replicated by xchain-sync (excluded from replicatedTables.js and from
-- SnapshotBuilder.OPERATOR_LOCAL_TABLES). source_id is NULL until the row is applied;
-- the rollback re-arm (rollback.js) resets applied=0 + source_id=NULL when the materialized
-- source address is rolled out of the index, so a reapply re-runs the hook.
CREATE TABLE recovery_pending_rewards (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_address   VARCHAR(120) NOT NULL,            -- raw staking address string (never an id)
    validator_pubkey CHAR(64) NOT NULL,                -- lowercase hex signing pubkey
    reward_type      VARCHAR(20) NOT NULL,
    round_reference  BIGINT UNSIGNED,
    amount           VARCHAR(250) NOT NULL,
    block_index      BIGINT UNSIGNED NOT NULL,         -- archived reward block (carried onto validator_rewards verbatim)
    source_id        BIGINT UNSIGNED,                  -- deterministic id assigned at materialize time (NULL until applied)
    applied          TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX source_address ON recovery_pending_rewards (source_address, applied);
