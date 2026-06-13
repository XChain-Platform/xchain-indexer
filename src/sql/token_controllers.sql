DROP TABLE IF EXISTS token_controllers;
CREATE TABLE token_controllers (
    id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick_id               BIGINT UNSIGNED NOT NULL,         -- FK index_tickers.id (the controlled token)
    action_class          VARCHAR(16) NOT NULL,             -- transfer|trade|burn|mint|stake
    contract_index        BIGINT UNSIGNED NOT NULL,         -- FK contracts.action_index (the guard contract)
    bound_by_id           BIGINT UNSIGNED NOT NULL,         -- FK index_addresses.id (token owner who bound it)
    binding_action_index  BIGINT UNSIGNED NOT NULL,         -- ISSUE action_index that created/changed this binding
    cooldown_blocks       INT UNSIGNED NOT NULL DEFAULT 0,  -- blocks from an unbind request to the effective drop
    cooldown_end_block    BIGINT UNSIGNED,                  -- NULL until unbinding; then block_index + cooldown_blocks
    status_id             BIGINT UNSIGNED NOT NULL,         -- active | unbinding | unbound
    block_index           BIGINT UNSIGNED NOT NULL          -- block of the last status change
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX tick_id            ON token_controllers (tick_id);
CREATE        INDEX contract_index     ON token_controllers (contract_index);
CREATE        INDEX cooldown_end_block ON token_controllers (cooldown_end_block);
CREATE        INDEX status_id          ON token_controllers (status_id);
CREATE        INDEX tick_class         ON token_controllers (tick_id, action_class);
