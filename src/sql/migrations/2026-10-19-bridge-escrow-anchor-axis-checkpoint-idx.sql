-- xchain:migration mode=auto
-- Migration: index anchor_actions and state_checkpoints on (chain, network, snapshot_block).
--
-- WHY
-- ---
-- From BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION a DOGE- or LTC-origin bridge escrow checkpoint
-- is selected on the BTC anchor axis (src/consensus/bridge_checkpoint_check/anchor_match.js):
-- getEarliestValidAnchorCheckpointAfterAnchor and
-- getMirroredStateCheckpointCandidatesAfterAnchor (src/db/anchors/checkpoint_anchor_axis.js)
-- range on chain = ? AND network = ? AND snapshot_block > ? once per block. No existing key
-- puts snapshot_block after that equality prefix, so without these each call would read and
-- filesort every checkpoint for the chain, the shape the 2026-10-14 migration removed for the
-- block_index reads.
--
-- NOT consensus-visible. Index-only DDL: no predicate, ORDER BY or selected column changes;
-- only the access path differs. Non-unique, and outside the uq_chain_seq split-brain fence.
--
-- Additive + idempotent: CREATE INDEX IF NOT EXISTS, a no-op wherever boot-time
-- reconcileTableIndexes already healed the indexes in from src/sql/anchor_actions.sql and
-- src/sql/state_checkpoints.sql. The names and column lists are byte-equal to those
-- definitions. This file reaches only the indexer DB; a separate <INDEXER_DB_NAME>_HubMirror
-- schema gets the state_checkpoints index only once xchain-explorer/src/sql/hub-mirror/
-- state_checkpoints.sql declares the same KEY.
--
-- HOW TO RUN
--   node src/db/migration/migrate.js   (or apply this file to the indexer DB)

CREATE INDEX IF NOT EXISTS idx_anchor_chain_snapshot ON anchor_actions (chain, network, snapshot_block);

CREATE INDEX IF NOT EXISTS idx_chain_snapshot ON state_checkpoints (chain, network, snapshot_block);
