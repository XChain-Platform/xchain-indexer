-- xchain:migration mode=auto
-- Migration: index (type_id, id, action_index) on mappings_actions.
--
-- WHY
-- ---
-- The explorer's address history pages an address's actions with
-- `type_id = 2 AND id IN (..) AND action_index < ? ORDER BY action_index DESC LIMIT n`.
-- The single-column id index finds the address's mapping rows, but every row then needs
-- a clustered-index lookup for type_id and action_index, so a page costs one lookup per
-- action the address ever touched. A (type_id, id, action_index) index serves the filter,
-- the cursor range and the sort key from the index alone.
--
-- Additive and idempotent (ADD INDEX IF NOT EXISTS); the InnoDB secondary-index build is
-- INPLACE and does not block DML. No query text changes, so results are identical.

ALTER TABLE mappings_actions
  ADD INDEX IF NOT EXISTS mappings_type_id_action (type_id, id, action_index);
