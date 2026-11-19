-- xchain:migration mode=auto
-- Migration: indexes for the per-block poll tally watermark probes.
--
-- The vote finalization sweep probes MAX(action_index) by poll or tick on every
-- block. The existing composite indexes put an address column before action_index,
-- so those probes scan the full vote or delegation history for their key.
-- These additive indexes preserve query results while bounding the endpoint reads.

ALTER TABLE votes
  ADD INDEX IF NOT EXISTS poll_action (poll_index, action_index);

ALTER TABLE vote_delegations
  ADD INDEX IF NOT EXISTS tick_action (tick_id, action_index);
