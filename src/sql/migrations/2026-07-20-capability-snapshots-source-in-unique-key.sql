-- xchain:migration mode=auto
-- WHY: uq_cap_snap = (snapshot_block, capability, signing_pubkey) omits `source`.
-- At/above STAKE_WEIGHTED_QUORUM (BTC 961000) a key delegated by two sources yields
-- one row per (source, pubkey); INSERT IGNORE collapses them on the narrower key and
-- silently drops the second source, understating stake for any mirror-reading verifier.
-- Widening an already-enforced UNIQUE key is monotonically safe (current index already
-- guarantees at most one row per (snapshot_block, capability, signing_pubkey), so adding
-- `source` can only relax it): no pre-dedup DELETE required, mode=auto.
ALTER TABLE capability_snapshots DROP INDEX IF EXISTS uq_cap_snap;
ALTER TABLE capability_snapshots ADD UNIQUE INDEX IF NOT EXISTS uq_cap_snap (snapshot_block, capability, signing_pubkey, source);
