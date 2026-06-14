DROP TABLE IF EXISTS address_controllers;
CREATE TABLE address_controllers (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action_index        BIGINT UNSIGNED NOT NULL,         -- ADDRESS action that emitted this bind/unbind event (rollback key)
    address_id          BIGINT UNSIGNED NOT NULL,         -- FK index_addresses.id (the self-gated account)
    action_class        VARCHAR(16) NOT NULL,             -- transfer|trade|burn|mint|stake
    contract_index      BIGINT UNSIGNED NOT NULL,         -- FK contracts.action_index (the guard contract; on unbind, the contract being dropped)
    is_unbind           TINYINT(1) NOT NULL DEFAULT 0,    -- 0 = bind, 1 = unbind (drop request)
    cooldown_blocks     INT UNSIGNED NOT NULL DEFAULT 0,  -- committed at bind; copied onto the unbind event for reference
    cooldown_end_block  BIGINT UNSIGNED,                  -- unbind: block_index + cooldown_blocks (gates until then); NULL on bind
    block_index         BIGINT UNSIGNED NOT NULL          -- block of this event
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Append-only event log (self-signed account gates). Same model as token_controllers: effective
-- controller = latest event <= X; a `bind` gates, an `unbind` gates only while X < cooldown_end_block.
-- Read-time cooldown, no sweep, rolls back cleanly as a dataTable. See Controller_Bound_Tokens.md.

CREATE UNIQUE INDEX action_index   ON address_controllers (action_index);
CREATE        INDEX address_id     ON address_controllers (address_id);
CREATE        INDEX contract_index ON address_controllers (contract_index);
CREATE        INDEX address_class  ON address_controllers (address_id, action_class);
CREATE        INDEX block_index    ON address_controllers (block_index);
