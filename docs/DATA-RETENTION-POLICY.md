# Data-Retention / Pruning Policy

Status: design + default-off scaffold . The scaffold ships inert; no
production indexer prunes anything until an operator sets the retention env vars.

## Why this exists

Several tables grow without bound. The largest and most delicate is the indexer
light-client state store, whose reclamation was explicitly deferred in
`src/stateCommitment.js` ("Reclamation is deferred to a dedicated design paired
with root-retention pruning"). This document is that design, plus the concrete
scaffold in `src/retention.js`. It also records the policy for the hub and
decoder audit tables so the platform has one place that says what is kept and
for how long.

Guiding rule: retention is **default-off and additive**. Turning it on is an
operator decision per node. Nothing here deletes data on an existing deployment
unless a retention env var is set, and no schema is dropped or altered (the
scaffold only issues `DELETE`s, never `DROP`/`ALTER`, and creates no tables).

## Indexer: the state commitment store (the deferred piece)

Two tables back the SPV light-client commitment:

- `state_tree_roots` - one row per block: `balances_root`, `stakes_root`,
  `state_root`, `block_merkle_root`. Grows one row per block forever.
- `state_tree_nodes` - the content-addressed, copy-on-write SMT internal-node
  store. Append-only during forward processing (`INSERT IGNORE`, identical
  subtrees dedupe by hash). A reorg leaves orphaned nodes behind: the rollback
  drops the `state_tree_roots` pointers for the orphaned blocks but never the
  nodes.

`stateCommitment.reportOrphanStats` already measures growth (total vs reachable
nodes) read-only. It does not delete, for the reason spelled out there: a
content-addressed node orphaned by a reorg is commonly **re-created** by the new
canonical chain (the `INSERT IGNORE` no-ops and the row keeps its id). Deleting
such a node after it has been re-referenced would make the next incremental
`_descend` read a missing row as an EMPTY subtree and **fork the balances_root**.

### The policy: two phases, order is load-bearing

Phase 1 - **root retention**. Keep roots for blocks with
`block_index > (tip - STATE_ROOT_RETENTION_BLOCKS)`; drop older root rows. This
only drops block->root pointers. It never touches the node store, and it never
affects incremental forward processing (which reads only the immediately-prior
root). Its one real consequence: a block whose root row is pruned can no longer
be served as an SPV proof root by the explorer proof server. That is the whole
point of a retention window, and it is why the window is an operator choice.

Phase 2 - **orphan-node reclaim**. After phase 1, delete `state_tree_nodes` rows
that are unreachable from **every surviving root** (union of each retained row's
`balances_root` + `stakes_root`, marked with the exact skip rules of
`reportOrphanStats`: EMPTY constants and absent children are skipped). This is
the reclamation `stateCommitment.js` deferred, and it is only safe under one
condition:

> The mark-and-delete must not interleave with forward block-root insertion.

The scaffold enforces this by requiring the caller to pass a `runExclusive`
wrapper that holds the indexer's db transaction mutex (`_acquireTxLock`) for the
whole mark+delete. Block processing acquires that same lock in
`beginTransaction`, so while a reclaim holds it no new node can be inserted and
no node the reclaim just marked unreachable can be re-referenced underneath it.
`XChainIndexer._startStateRetention` wires exactly this. Phase 2 is a **strict
opt-in on top of** phase 1 (`STATE_NODE_RECLAIM`), because it is the
consensus-sensitive half; phase 1 alone (drop old roots, keep all nodes) is the
conservative default once retention is enabled at all.

Ordering matters: reclaim runs **after** the root prune in the same sweep, so
nodes freshly orphaned by narrowing the root set are actually collectable.

### Config (env), all default-off

| Var | Default | Effect |
|---|---|---|
| `STATE_ROOT_RETENTION_BLOCKS` | unset | Positive integer turns retention ON and sets the phase-1 window. Unset/0 = OFF (keep everything, current behavior). |
| `STATE_NODE_RECLAIM` | off | `1`/`true` additionally enables phase-2 orphan-node reclaim. Ignored unless retention is on. |
| `STATE_RETENTION_INTERVAL_MS` | 6h | Sweep cadence. |
| `STATE_TREE_METRIC_MAX_NODES` | 2,000,000 | Shared with the orphan metric: above this node count the in-memory mark (and thus phase-2 reclaim) is skipped to bound memory. Phase-1 root prune still runs. |

Operational guidance: a retention window must be wider than the deepest reorg a
chain will ever serve, and wide enough for the SPV proof horizon the explorer
advertises. Start with phase-1 only, watch the orphan metric fall as roots age
out, and only enable `STATE_NODE_RECLAIM` once the mutex-serialized reclaim has
been exercised on a regtest venue.

## Hub: audit tables (policy already partly in place)

The hub already prunes its two unbounded audit tables; recorded here for
completeness so the platform policy is in one place.

- `oracle_submissions` - diagnostic only (finalized values live in
  `price_snapshots`). Pruned by `OracleRound._pruneSubmissionsDb` keyed on
  `round_number`, keeping `ORACLE_SUBMISSIONS_RETENTION_ROUNDS` rounds (default
  12,960).
- `telemetry_pings` - pruned daily by the `api.js` cleanup timer, dropping rows
  older than `TELEMETRY_RETENTION_DAYS` (default 90), only when
  `TELEMETRY_ENABLED`.

Both follow the same shape this scaffold uses: best-effort, keyed on an indexed
column, never allowed to crash the money-bearing service. No further hub work is
required by this item; any future audit table should adopt the same pattern.

## Decoder: recommended, not yet scaffolded

The decoder retains full transaction history by design (it is the source the
indexer replays), so its core tables (`transactions`, `blocks`,
`transaction_outputs`) are **not** retention candidates. The one bounded-by-policy
table is `mempool_transactions`, already reconciled against confirmed blocks in
`db.js`. If a decoder deployment ever needs a hard floor on decoded history
below the indexer's start block, it should follow this same default-off,
indexed-column, best-effort `DELETE` pattern. No decoder code ships under .

## Scaffold map

- `src/retention.js` - `parseRetentionConfig`, `planStateRootPrune` (read-only
  planner), `pruneStateRoots` (phase 1), `computeReachable` +
  `reclaimOrphanNodes` (phase 2, `dryRun` + `runExclusive` aware), `runSweep`
  (phase 1 then phase 2).
- `src/XChainIndexer.js` - `_startStateRetention`, armed only when the policy is
  enabled, mirroring `_startStateTreeMetric`; supplies the mutex-backed
  `runExclusive`.
- `test/unit/retention.test.js` - config gating, planner windows, phase-1 delete,
  phase-2 reachability + orphan reclaim, dry-run, exclusivity wiring, and the
  fork-safety invariant (a node reachable from a retained root is never deleted).
