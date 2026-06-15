DROP TABLE IF EXISTS contract_slash_debits;
CREATE TABLE contract_slash_debits (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_index     BIGINT UNSIGNED NOT NULL,        -- FK to contract_executions.action_index (the EXECUTE that emitted the SLASH)
    slash_position      INT UNSIGNED NOT NULL,           -- emission-loop index within the EXECUTE (one EXECUTE can emit multiple SLASHes; mirrors contract_emissions.position)
    target_table        ENUM('contract_stakes','contract_unstakes') NOT NULL, -- which stake-ledger table this debit reduced
    stake_action_index  BIGINT UNSIGNED NOT NULL,        -- action_index of the slashed contract_stakes/contract_unstakes row (the reorg restore target)
    prev_amount         VARCHAR(250) NOT NULL,           -- the row's exact `amount` STRING immediately before this debit; the reorg restore copies it back verbatim (no arithmetic → byte-identical on source + replica)
    amount              VARCHAR(250) NOT NULL,           -- per-row delta this debit subtracted (audit; prev_amount - amount = the post-debit value)
    block_index         BIGINT UNSIGNED NOT NULL         -- block of the slash (= the EXECUTE's block); the rollback scoping key
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX execution_index ON contract_slash_debits (execution_index);
CREATE INDEX block_index     ON contract_slash_debits (block_index);
CREATE INDEX stake_row       ON contract_slash_debits (target_table, stake_action_index, block_index);
