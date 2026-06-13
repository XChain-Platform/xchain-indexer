DROP TABLE IF EXISTS address_controllers;
CREATE TABLE address_controllers (
    id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address_id            BIGINT UNSIGNED NOT NULL,         -- FK index_addresses.id (the account, self-bound)
    action_class          VARCHAR(16) NOT NULL,             -- transfer|trade|burn|mint|stake
    contract_index        BIGINT UNSIGNED NOT NULL,         -- FK contracts.action_index (the guard contract)
    binding_action_index  BIGINT UNSIGNED NOT NULL,         -- ADDRESS action_index that created/changed this binding
    cooldown_blocks       INT UNSIGNED NOT NULL DEFAULT 0,  -- blocks from an unbind request to the effective drop
    cooldown_end_block    BIGINT UNSIGNED,                  -- NULL until unbinding; then block_index + cooldown_blocks
    status_id             BIGINT UNSIGNED NOT NULL,         -- active | unbinding | unbound
    block_index           BIGINT UNSIGNED NOT NULL          -- block of the last status change
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX address_id         ON address_controllers (address_id);
CREATE        INDEX contract_index     ON address_controllers (contract_index);
CREATE        INDEX cooldown_end_block ON address_controllers (cooldown_end_block);
CREATE        INDEX status_id          ON address_controllers (status_id);
CREATE        INDEX address_class      ON address_controllers (address_id, action_class);
