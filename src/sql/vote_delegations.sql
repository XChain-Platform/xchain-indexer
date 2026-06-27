-- VOTE vote-delegation event log (liquid democracy, Section 13). One row per
-- VOTE v3 action: a holder sets (or clears) a standing per-token delegation of
-- their voting weight to another address. Append-only - the latest active row per
-- (tick_id, delegator) at or before a block wins at read time (db.getActiveDelegations),
-- so a deep reorg reverts via the generic action_index delete with no in-place
-- mutation to undo (matches how token_controllers is handled).
--
-- A row with delegate_address_id NULL is a CLEAR (revoke): if it is the latest for
-- a delegator, that delegator has no active delegation. Delegation only flows the
-- weight of delegators who did NOT vote directly and still hold the token at close
-- (resolved in db.getPollTally); the table just records the standing instruction.
--
-- Spec: xchain-documentation/protocol/actions/VOTE.md
DROP TABLE IF EXISTS vote_delegations;
CREATE TABLE vote_delegations (
    action_index          BIGINT UNSIGNED NOT NULL,   -- FK to actions (the VOTE v3 that set/cleared this delegation)
    block_index           BIGINT UNSIGNED NOT NULL,   -- block (rollback key + latest-active ordering)
    tick_id               BIGINT UNSIGNED,            -- FK to index_tickers: the governance token this applies to
    delegator_address_id  BIGINT UNSIGNED,            -- FK to index_addresses: the holder delegating their weight
    delegate_address_id   BIGINT UNSIGNED,            -- FK to index_addresses: recipient; NULL = cleared (revoke)
    status_id             BIGINT UNSIGNED             -- FK to index_statuses (validation status of the v3 action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Latest-active lookup is per (tick, delegator) by highest action_index at/before
-- a block; the composite index serves that grouping and the per-delegator scan.
CREATE INDEX tick_delegator ON vote_delegations (tick_id, delegator_address_id, action_index);
CREATE INDEX action_index   ON vote_delegations (action_index);
CREATE INDEX block_index    ON vote_delegations (block_index);
