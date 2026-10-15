--
-- anchor_reward_attestation_copies: every distinct copy of a mirrored anchor reward tuple.
--
-- anchor_reward_attestations keeps ONE row per reward tuple (uq_reward_tuple, INSERT
-- IGNORE), so the first copy a node receives is the one it keeps. doge_anchor_txid and
-- publisher_attestations sit outside the XANCPUB canonical the signatures cover, so two
-- copies of one signed tuple can differ in either, and the kept copy decides whether the
-- reward proves. The hub mirror apply (hub_db_sync/attestation_copies.js) also writes each
-- applied row here, keyed by the tuple plus copy_digest, so a node holds every distinct
-- copy it has received whatever their arrival order. From
-- ANCHOR_REWARD_COPY_SELECTION_ACTIVATION the BTC derive pass reads these copies beside the
-- kept row and pays a tuple if any copy meets quorum and proves on DOGE
-- (anchor_reward_derive/copy_selection.js); below it nothing reads this table.
--
-- Local, append-only, never retracted, never rolled back: a copy carries no block of its
-- own and only adds candidates for a tuple the main table already holds, so the derive read
-- joins every copy to its main row and a purged main row takes its copies out of the read.
--
-- copy_digest is sha256 over doge_anchor_txid (empty when absent), '|', and the
-- publisher_attestations text, computed in JS at apply, so a re-delivered copy is an
-- INSERT IGNORE no-op.

CREATE TABLE anchor_reward_attestation_copies (
    id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, -- local surrogate; never read
    chain                  VARCHAR(10)  NOT NULL,                    -- the main row's chain
    network                VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest
    reward_type            VARCHAR(32)  NOT NULL,                    -- anchor_bundle or anchor_archive (live); anchor_<CHAIN> is retired
    round_reference        BIGINT UNSIGNED NOT NULL,                 -- as anchor_reward_attestations.round_reference
    snapshot_block         BIGINT UNSIGNED NOT NULL,                 -- BTC block selecting the oracle_publish set
    publisher              VARCHAR(64)  NOT NULL,                    -- elected publisher pubkey (lowercase hex)
    publisher_attestations TEXT         NOT NULL,                    -- this copy's JSON [{pubkey,sig}] list
    doge_anchor_txid       VARCHAR(64)  DEFAULT NULL,                -- this copy's DOGE anchor txid
    copy_digest            CHAR(64)     NOT NULL,                    -- sha256(txid or '' | publisher_attestations), lowercase hex
    UNIQUE KEY uq_reward_copy (chain, network, reward_type, round_reference, snapshot_block, publisher, copy_digest),
    KEY idx_snapshot_block (network, snapshot_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
