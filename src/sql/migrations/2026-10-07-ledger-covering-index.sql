-- xchain:migration mode=auto
-- Migration: covering index (tick_id, action_index, amount) on credits, debits and escrows.
--
-- WHY
-- ---
-- getTokenSupply and sanityCheck run exact SUMs over amount scoped by tick_id and joined to
-- actions on action_index. The single-column tick_id index finds the tick's rows but every
-- row then needs a clustered-index lookup for action_index and amount, so the cost grows with
-- a hot tick's history. A (tick_id, action_index, amount) index serves the filter, the join key
-- and the summed column from the index alone.
--
-- Additive and idempotent (ADD INDEX IF NOT EXISTS); the InnoDB secondary-index build is
-- INPLACE and does not block DML. No query text changes, so results are identical.

ALTER TABLE credits
  ADD INDEX IF NOT EXISTS credits_tick_action_amount (tick_id, action_index, amount);

ALTER TABLE debits
  ADD INDEX IF NOT EXISTS debits_tick_action_amount (tick_id, action_index, amount);

ALTER TABLE escrows
  ADD INDEX IF NOT EXISTS escrows_tick_action_amount (tick_id, action_index, amount);
