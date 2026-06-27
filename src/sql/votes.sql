-- VOTE ballots. One row per (poll, voter, option) on a voter's CURRENT ballot.
-- A VOTE v1 carries the voter's whole ballot (one or more options); the handler
-- writes it as an atomic set, deleting the voter's prior rows for the poll and
-- inserting the new set (wholesale last-write-wins). All rows of one ballot share
-- the v1 action_index.
--
-- Effective weight is NOT stored: it derives from the voter's balance at the
-- effective close block (the hold-to-count gate) split by `share`, computed at
-- tally time (db.getPollTally / VOTE v2). `share` is the voter's relative share
-- for this option in split tally_mode ('1' in approval mode).
--
-- Spec: xchain-documentation/protocol/actions/VOTE.md
DROP TABLE IF EXISTS votes;
CREATE TABLE votes (
    action_index      BIGINT UNSIGNED NOT NULL,   -- FK to actions (the VOTE v1 ballot that wrote this row)
    block_index       BIGINT UNSIGNED NOT NULL,   -- cast block (rollback key)
    poll_index        BIGINT UNSIGNED NOT NULL,   -- FK to polls.action_index
    voter_address_id  BIGINT UNSIGNED NOT NULL,   -- FK to index_addresses (the SOURCE that cast the ballot)
    choice            SMALLINT UNSIGNED NOT NULL, -- option index into the poll's options array
    share             VARCHAR(60),                -- relative share for this option (split mode); '1' in approval mode
    memo              MEDIUMTEXT,                 -- optional voter note
    resolved_block    BIGINT UNSIGNED,            -- reserved for finalization re-arm on reorg (Phase 2)
    status_id         BIGINT UNSIGNED             -- FK to index_statuses (validation status of the ballot action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- One active row per (poll, voter, option). A voter's active approval set is all
-- their rows for the poll, capped at the poll's max_selections by the handler.
CREATE UNIQUE INDEX poll_voter_choice ON votes (poll_index, voter_address_id, choice);
CREATE        INDEX poll_index        ON votes (poll_index);
CREATE        INDEX voter_address_id  ON votes (voter_address_id);
CREATE        INDEX action_index      ON votes (action_index);
CREATE        INDEX block_index       ON votes (block_index);
