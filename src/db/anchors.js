/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Database mixin: anchors
 * 
 * The queries over the anchors table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');
const path    = require('path');
const { buildStateHashData, ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL } = require('../stateHash');
const { CHECKPOINT_VERSIONS: ANCHOR_CHECKPOINT_VERSIONS,
        ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
        ARCHIVE_ANCHOR_BY_CONTENT_SQL, selectArchiveHeadRow,
        dedupeArchiveChunks } = require('../actions/anchor/anchor_action_query');
// The validator_rewards ledger-key qualifier rule, shared with the two JS writers so the
// SQL predicate here and they cannot disagree about which reward type is qualified.
const arKey = require('../actions/anchor/anchor_reward_key.js');

module.exports = {

    // Option C (derive-on-BTC-side): mirrored anchor_reward_attestations rows whose
    // reward has NOT yet been derived into validator_rewards, matured to `maxSnapshotBlock`.
    //
    // `maxSnapshotBlock` is the MATURITY WATERMARK the caller computed, i.e. the current BTC
    // block MINUS ANCHOR_REWARD_MIRROR_MATURITY, not the current block itself. Keying on the
    // current block matured a row the instant its snapshot_block was reached, but
    // snapshot_block is a height already in the PAST when the row is written (the hub writes
    // only after the DOGE anchor buries, after the publisher failover ladder, and after the
    // hub-to-hub federation hop), so two nodes whose mirrors differed by one row derived the
    // same reward at different heights and forked the ledger hash. See
    // anchor_reward_activation.ANCHOR_REWARD_MIRROR_MATURITY for the watermark and
    // HubDbSync.waitForAnchorAttestationSync for the completeness half of the rule.
    // Returned flat, ordered by (reward_type, round_reference, publisher) so the
    // caller can group each logical reward and reconcile the smallest-pubkey winner across a
    // failover double-publish. NOT-EXISTS-scoped so a group already derived is skipped and a
    // reorg that block-scoped-deletes the reward at snapshot_block re-exposes it for replay.
    //
    // The exclusion is PUBLISHER-scoped, not round-scoped. A round-scoped
    // `NOT EXISTS (... reward_type + round_reference)` drops the WHOLE round the moment any
    // publisher is derived, so a failover publisher whose attestation mirrors in AFTER that
    // first derive is never inserted and reconcileAnchorRewardWinner never compares it. The
    // smallest-pubkey winner rule is then order-dependent: a node (or a from-genesis replay)
    // that saw both publishers in one fetch keeps MIN(pubkey), while a node that saw the
    // smaller one late keeps the larger - divergent COLLECT credit with no self-healing path,
    // since this is the only surviving materialization path at/above the derive flag-day.
    // Comparing against the already-derived pubkey restores order-independence: an attestation
    // that would LOSE to (sorts >= ) a derived winner stays excluded, so a settled round never
    // re-derives, while one that would WIN is re-admitted, inserted, and collapses the round to
    // the true minimum. Self-terminating - after the promotion the new winner excludes both.
    // Compared under the shared utf8_general_ci collation, the same one MIN(pk.pubkey) in
    // reconcileAnchorRewardWinner elects, so the two predicates cannot disagree. Driven
    // against a real MariaDB in test/integration/anchor-reward-late-publisher.test.js: the
    // unit tier stubs doQuery, and doQuery swallows a non-transactional query error, so a
    // shape-only test cannot tell this predicate from one that derives nothing at all.
    async getPendingAnchorRewardAttestations(network, maxSnapshotBlock){
        return await this.doQuery(
            'SELECT ara.chain, ara.network, ara.reward_type, ara.round_reference, ara.snapshot_block, ' +
            '       ara.publisher, ara.publisher_attestations, ara.doge_anchor_txid ' +
            '  FROM anchor_reward_attestations ara ' +
            ' WHERE ara.network = ? AND ara.snapshot_block <= ? ' +
            // The exclusion is also QUALIFIER-scoped. Matching on (reward_type,
            // round_reference) alone made this the FIRST place the archive collapse bit:
            // 'anchor_archive' round_reference is MATCH_BATCH_SEQ, a dense hub counter a
            // wipe-and-replay rebase reissues, so once ONE archive anchor was derived, a
            // genuinely distinct later archive anchor that happened to reuse that seq matched
            // this NOT EXISTS and was never returned as pending at all - suppressed before
            // reconcile ever saw it, so no amount of reconcile-side fixing could recover it.
            // Comparing the qualifier a derived row WOULD carry (snapshot_block for the
            // archive leg, 0 otherwise - the SQL twin of anchor_reward_key.rewardRoundQualifier,
            // emitted from that module so the two forms cannot drift) makes the exclusion
            // speak about the same logical reward the ledger key does.
            '   AND NOT EXISTS (SELECT 1 FROM validator_rewards vr ' +
            '                     JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id ' +
            '                    WHERE vr.reward_type = ara.reward_type ' +
            '                      AND vr.round_reference = ara.round_reference ' +
            '                      AND vr.round_qualifier = ' + arKey.sqlRoundQualifier('ara.reward_type', 'ara.snapshot_block') + ' ' +
            '                      AND pk.pubkey <= LOWER(ara.publisher)) ' +
            // Tiebreak on snapshot_block, the remaining component of uq_reward_tuple, BEFORE
            // ara.id. Two rows can share (reward_type, round_reference, publisher) and differ
            // only in snapshot_block, and deriveAnchorRewards upserts each one in this order
            // while validator_rewards' UNIQUE key omits snapshot_block, so the LAST row
            // processed decides the reward's earn-block block_index. ara.id is a per-node
            // AUTO_INCREMENT (arrival order on this mirror, reassigned by a from-genesis
            // re-mirror), so leaving it as the deciding term let two nodes credit the reward at
            // different heights, which COLLECT's `block_index <= ?` SUM and the block-scoped
            // rollback both read: a ledger-hash fork. Same discipline getOraclePrice states.
            // ara.id stays last only as a total-order fallback; it can no longer decide.
            ' ORDER BY ara.reward_type, ara.round_reference, ara.publisher, ara.snapshot_block, ara.id',
            [network, maxSnapshotBlock]);
    },

    /*
     * ANCHOR action methods (DOGE-only on-chain state commitments).
     * anchor_actions is the permanent on-chain record (action-indexed, rolled back
     * like any data table); the hub-mirrored state_checkpoints copy is the live
     * verification source. Spec: xchain-documentation/protocol/actions/ANCHOR.md
     */

    // Create/Update record in `anchor_actions` table.
    //
    // Keyed on (action_index, section_index), not action_index alone: an ANCHOR v0 bundle
    // is ONE action carrying N per-chain sections, and each section gets its own row so
    // idx_anchor_checkpoint and every per-chain reader keep working unchanged. Every
    // version that carries a single body (the v1/v2 archive rows) writes section_index 0,
    // which is also the column's DEFAULT, so old rows and old writers land where they
    // always did.
    async createAnchorAction(data){
        data            = this.normalizeDataValues(data);
        let status_id   = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];

        // EVERY bound value must be storable in its column, whatever the wire carried.
        //
        // anchor.js records a rejected wire rather than dropping it (a retired version below
        // ANCHOR_ACTIVATION, an unknown version byte, a malformed field), and the row it hands
        // over holds the RAW positional walk: on a pre-restart v5/v7 wire, or on a hostile v1,
        // hashes and chain names sit in numeric slots and 64-char strings sit in 8-char columns.
        // Coercing those with Number() gave NaN, which the mariadb driver serializes as the bare
        // literal `NaN` ("Unknown column 'NaN' in 'VALUES'"), and an over-long string is refused
        // outright ("Data too long for column"). Either way the INSERT failed on every retry
        // and the block never parsed: a from-genesis replay of DOGE testnet looped forever at
        // 67856088, the first legacy anchor (AT-T2, 2026-09-09), and one malformed permissionless
        // ANCHOR could park a live DOGE indexer the same way. A field that does not fit its
        // column is stored NULL; the row (version byte, status, mined height) is still recorded.
        // anchor_actions is not consensus state, so this changes no hash, and a VALID row never
        // reaches this path with an unstorable field because every format check bounds it first.
        //
        // Integer columns: integer-shaped only. "Finite" is not enough (a 64-digit hash coerces
        // to 1e64, which BIGINT refuses just as loudly), and each column has its own ceiling.
        const U8  = 255, U32 = 4294967295, U64 = Number.MAX_SAFE_INTEGER;
        const intOrNull = (v, max) => {
            if(v == null) return null;
            let n;
            if(typeof v === 'number') n = v;
            else {
                let s = String(v).trim();
                if(!/^\d{1,16}$/.test(s)) return null;
                n = Number(s);
            }
            return (Number.isSafeInteger(n) && n >= 0 && n <= max) ? n : null;
        };
        // String columns: NULL when longer than the column (never truncated: a cut hash would be
        // a plausible-looking lie, NULL says "unreadable" and the status says why).
        const strOrNull = (v, max) => {
            if(v == null || v === '') return null;
            let s = String(v);
            return (s.length <= max) ? s : null;
        };
        // MEDIUMTEXT holds 16 MiB; a wire cannot approach that, but the bound is stated.
        const TEXT = 16777215;

        let section_index = intOrNull(data['SECTION_INDEX'], U8);
        if(section_index === null) section_index = 0;
        // The dispatcher bounds the version byte to 0-255 or null; null (an unparseable byte)
        // has always stored as 0 alongside its 'invalid: VERSION (unknown)' status.
        let version = intOrNull(data['FORMAT'], U8);
        if(version === null) version = 0;
        // Publisher tail (#2486): carried by v0 and v1, NULL on v2. Mirrors validator_signatures
        // exactly: anchor.js pre-serializes the XANCPUB sig list to a JSON string (as it does
        // VALIDATOR_SIGNATURES = JSON.stringify(sigs)) before dispatch, so both are stored as-is.
        let publisher = strOrNull(data['PUBLISHER'], 64);
        let publisherAttestations = strOrNull(data['PUBLISHER_ATTESTATIONS'], TEXT);
        let args = [
            section_index,
            version,
            strOrNull(data['CHAIN'], 10),
            strOrNull(data['NETWORK'], 20),
            intOrNull(data['BLOCK_INDEX_CHECKPOINTED'], U64),
            strOrNull(data['BLOCK_HASH'], 64),
            strOrNull(data['LEDGER_HASH'], 64),
            strOrNull(data['ACTIONS_HASH'], 64),
            strOrNull(data['CONTRACT_HASH'], 64),
            intOrNull(data['CHECKPOINT_SEQ'], U64),
            intOrNull(data['SNAPSHOT_BLOCK'], U64),
            strOrNull(data['STATE_ROOT'], 64),
            intOrNull(data['STATE_ROOT_VERSION'], U8),
            strOrNull(data['BLOCK_MERKLE_ROOT'], 64),
            intOrNull(data['BLOCK_MERKLE_VERSION'], U8),
            intOrNull(data['MATCH_BATCH_SEQ'], U64),
            intOrNull(data['MATCH_COUNT'], U32),
            strOrNull(data['BATCH_CRC32'], 8),
            intOrNull(data['TOTAL_CHUNKS'], U32),
            intOrNull(data['CHUNK_INDEX'], U32),
            strOrNull(data['ARCHIVE_B64'], TEXT),
            strOrNull(data['VALIDATOR_SIGNATURES'], TEXT),
            // Publisher-attestation tail (#2486), written on v0 and v1. Both NULL on v2. anchor.js must set
            // data['PUBLISHER_ATTESTATIONS'] = JSON.stringify(publisherSigs) for the attestations
            // to flow (that one-line hand-off is owned in anchor.js).
            publisher,
            publisherAttestations,
            status_id,
            data['BLOCK_INDEX']
        ];
        let exists = (await this.doQuery(
            "SELECT action_index FROM anchor_actions WHERE action_index=? AND section_index=? LIMIT 1",
            [action_index, section_index])).length > 0;
        if(exists){
            await this.doQuery(
                `UPDATE anchor_actions SET section_index=?, version=?, chain=?, network=?, block_index=?, block_hash=?,
                        ledger_hash=?, actions_hash=?, contract_hash=?, checkpoint_seq=?, snapshot_block=?,
                        state_root=?, state_root_version=?, block_merkle_root=?, block_merkle_version=?,
                        match_batch_seq=?, match_count=?, batch_crc32=?, total_chunks=?, chunk_index=?,
                        archive_b64=?, validator_signatures=?, publisher=?, publisher_attestations=?,
                        status_id=?, block_index_doge=?
                 WHERE action_index=? AND section_index=?`, args.concat([action_index, section_index]));
        } else {
            await this.doQuery(
                `INSERT INTO anchor_actions
                        (section_index, version, chain, network, block_index, block_hash, ledger_hash, actions_hash,
                         contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version,
                         block_merkle_root, block_merkle_version, match_batch_seq, match_count,
                         batch_crc32, total_chunks, chunk_index, archive_b64, validator_signatures,
                         publisher, publisher_attestations,
                         status_id, block_index_doge, action_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args.concat([action_index]));
        }
    },

    // Highest VALID checkpoint_seq recorded for (chain, network) - the ANCHOR
    // replay guard. Only status 'valid'/'unverified' rows count (an 'invalid: ...'
    // replay attempt must not poison the watermark).
    async getMaxAnchorCheckpointSeq(chain, network){
        // Version set is the single source of truth in anchor_action_query.js
        // (shared with getAnchorActionByCheckpoint + the RPC) so the replay
        // watermark can never drift from the checkpoint-bearing definition
        // (a hand-copied literal here once omitted a live checkpoint version, freezing the guard).
        let versions = ANCHOR_CHECKPOINT_VERSIONS;
        let query = `SELECT MAX(a.checkpoint_seq) AS max_seq
                     FROM anchor_actions a
                     JOIN index_statuses s ON s.id = a.status_id
                     WHERE a.chain = ? AND a.network = ?
                       AND a.version IN (${versions.map(() => '?').join(', ')})
                       AND s.status IN ('valid', 'unverified')`;
        let rows = await this.doQuery(query, [chain, network, ...versions]);
        return (rows.length > 0 && rows[0].max_seq != null) ? Number(rows[0].max_seq) : null;
    },

    // Look up the on-chain ANCHOR checkpoint record for one checkpoint identity
    // (chain, network, block_index, checkpoint_seq), joined to its status. Only
    // checkpoint-bearing versions (0/1, per the ANCHOR_CHECKPOINT_VERSIONS constant
    // below; a v0 row is one bundle SECTION and carries its own checkpoint identity,
    // v1 is the archive head and carries its wrapper checkpoint's, and v2 is an
    // archive continuation chunk with no checkpoint identity at all). A bundle
    // therefore answers this read per section, with no bundle-level RPC of its own.
    // Returns the highest action_index
    // match (a reorg-replayed re-anchor supersedes an earlier one) or null. Read path
    // for the getanchoraction RPC: it lets the hub confirm an announced anchor actually
    // landed on-chain, with the matching payload, at DOGE depth, before trusting an
    // anchor-gossip stamp/reward (the block_index_doge column carries the DOGE height).
    async getAnchorActionByCheckpoint(chain, network, block_index, checkpoint_seq){
        // Version set is the single source of truth in anchor_action_query.js (shared
        // with the RPC + tests) so the SQL filter can never drift from it.
        let versions = ANCHOR_CHECKPOINT_VERSIONS;
        let query = `SELECT a.action_index, a.version, a.chain, a.network, a.block_index,
                            a.block_hash, a.ledger_hash, a.actions_hash, a.contract_hash,
                            a.checkpoint_seq, a.snapshot_block, a.state_root, a.state_root_version,
                            a.block_merkle_root, a.block_merkle_version, a.block_index_doge, s.status
                     FROM anchor_actions a
                     JOIN index_statuses s ON s.id = a.status_id
                     WHERE a.chain = ? AND a.network = ? AND a.block_index = ? AND a.checkpoint_seq = ?
                       AND a.version IN (${versions.map(() => '?').join(', ')})
                     ORDER BY a.action_index DESC
                     LIMIT 1`;
        let rows = await this.doQuery(query,
            [chain, network, Number(block_index), Number(checkpoint_seq), ...versions]);
        return rows.length > 0 ? rows[0] : null;
    },

    // The two watermarks the v1 archive replay guard needs, read from ONE row
    // set so they cannot disagree: the highest archive batch seq recorded, and the
    // highest wrapper checkpoint seq among those same archive-head rows.
    //
    // They are returned together deliberately. The guard rejects a stale
    // batch seq only when the wrapper checkpoint is ALSO not advancing, so two
    // independently-read watermarks could describe row sets that never coexisted
    // (one stubbed, one live; one filtered on a drifted version list) and the guard
    // would then reject a legitimate archive or admit a replay. Reading both in one
    // statement makes the impossible combination unrepresentable, and the version
    // predicate comes from ARCHIVE_HEAD_VERSIONS rather than a hand-copied literal
    // for the same reason getMaxAnchorCheckpointSeq stopped hand-copying its set
    // (a copied literal once omitted a live archive-head version and froze that guard).
    //
    // 'unverified' is included for the same reason it is in getMaxAnchorCheckpointSeq:
    // a node with no mirrored oracle_publish snapshot cannot verify signatures and
    // stores every well-formed ANCHOR unverified, so excluding it would make the
    // watermark differ between mirrored and unmirrored nodes. Note the direction of
    // that exposure: a poisoned row can only push either watermark UP, which makes
    // the guard stricter, never more permissive.
    async getArchiveReplayWatermarks(){
        let versions = ARCHIVE_HEAD_VERSIONS;
        let query = `SELECT MAX(a.match_batch_seq) AS max_batch_seq,
                            MAX(a.checkpoint_seq)  AS max_checkpoint_seq
                     FROM anchor_actions a
                     JOIN index_statuses s ON s.id = a.status_id
                     WHERE a.version IN (${versions.map(() => '?').join(', ')})
                       AND s.status IN ('valid', 'unverified')`;
        let rows = await this.doQuery(query, [...versions]);
        let row  = rows.length > 0 ? rows[0] : {};
        return {
            batchSeq:      (row.max_batch_seq      != null) ? Number(row.max_batch_seq)      : null,
            checkpointSeq: (row.max_checkpoint_seq != null) ? Number(row.max_checkpoint_seq) : null,
        };
    },

    // The archive-head anchor (v1, which always carries the publisher tail) that started an
    // archive batch (status irrelevant - chunk geometry checks belong to the caller).
    // match_batch_seq is NOT unique: the replay guard in anchor.js _parseCheckpoint accepts
    // an EQUAL MATCH_BATCH_SEQ ('never below the recorded max; equal is allowed'), so a
    // permissionless re-broadcast or failover double-publish stores a SECOND v1 row for
    // the same batch. The returned parent feeds a consensus-visible geometry/CRC verdict in
    // anchor.js _parseContinuation (TOTAL_CHUNKS gate + batch_crc32 reassembly, which stamps
    // setAnchorArchiveStatus(parent.action_index,'invalid_archive')), so the pick MUST be a
    // deterministic total order or two honest nodes select different parents and persist
    // divergent anchor_actions status fleet-wide. ORDER BY action_index ASC picks the EARLIEST
    // (canonical) head - the one that actually STARTED the batch - matching the 'lowest
    // action_index wins' tie-break the v2-continuation dedup below already uses. Order on
    // action_index (consensus-visible, unique on this single-network table), never the local
    // AUTO_INCREMENT id, which differs per node.
    // The row also carries `source`: the head's AUTHOR address, resolved through
    // actions.source_id (#3075). anchor.js binds every v2 continuation chunk to it, so a
    // junk chunk can no longer squat a slot and deny the batch. LEFT JOINed so the head
    // PICK is unchanged from the pre-#3075 query (an inner join would skip an unlinked
    // head and select a different one, moving a consensus-visible geometry verdict); an
    // unresolvable author arrives as null and anchor.js fails the chunk closed.
    // `author`, when supplied, narrows the candidates to heads authored by
    // that address, i.e. the batch key becomes (match_batch_seq, head author). The
    // caller (anchor.js, gated on the flag day) passes it so a junk head broadcast at
    // another publisher's batch seq can no longer be the parent that governs that
    // publisher's chunks. Omitted / null keeps the legacy canonical-head pick exactly,
    // including the query text, so nothing moves below the flag day. The narrowing
    // rides on the SAME LEFT-joined address the row already exposes as `source`: a head
    // whose author cannot be resolved compares unequal and is skipped, which is
    // fail-closed (the chunk lands 'orphan' rather than authenticated against nothing).
    async getAnchorV1ByBatchSeq(batchSeq, author){
        let scoped = (author !== undefined && author !== null);
        // Version set from ARCHIVE_HEAD_VERSIONS, never a hand-copied literal, for the
        // reason getArchiveReplayWatermarks states above: this is the same earliest-head
        // pick as ARCHIVE_HEAD_AUTHOR_SQL in anchor_action_query.js, and it feeds the
        // consensus-visible geometry/CRC verdict in anchor.js _parseContinuation. A
        // hand-copied set drifts the moment a new publisher-bearing head version is
        // added, and the two head picks would then disagree fleet-wide.
        let rows = await this.doQuery(
            `SELECT a.*, adr.address AS source
             FROM anchor_actions a
             LEFT JOIN actions         act ON act.action_index = a.action_index
             LEFT JOIN index_addresses adr ON adr.id           = act.source_id
             WHERE a.version ${ARCHIVE_HEAD_VERSIONS_SQL} AND a.match_batch_seq = ?` +
            (scoped ? ` AND adr.address = ?` : ``) +
            ` ORDER BY a.action_index ASC LIMIT 1`,
            scoped ? [batchSeq, String(author)] : [batchSeq]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Flag an anchor row (e.g. 'invalid_archive' when chunk reassembly fails CRC).
    //
    // Keyed on action_index ALONE, deliberately, even though the table's PK is now
    // (action_index, section_index): the anchor verdict is ALL-OR-NOTHING (spec D15), so
    // every section row of one action always carries the same status and stamping them
    // together is the correct behavior, not an oversight. Do not "fix" this into a
    // section-scoped update: an archive head is a single-body v1 row at section 0
    // anyway, and a per-section stamp would let one action hold two verdicts, which no
    // reader is built to reconcile.
    async setAnchorArchiveStatus(actionIndex, status){
        let status_id = await this.createStatus(status);
        await this.doQuery("UPDATE anchor_actions SET status_id = ? WHERE action_index = ?", [status_id, actionIndex]);
    },


    // Lowest locally parsed ANCHOR section at or above a height whose quorum THIS node
    // verified at parse time. status 'valid' only: 'unverified' means the row was stored
    // without a signature check because no capability snapshot was on hand, and that is
    // exactly the checkpoint a bridge proof must never be handed.
    async getEarliestValidAnchorCheckpoint(version, chain, network, atOrAfterBlock){
        return await this.doQuery(
            `SELECT a.chain, a.network, a.block_index, a.checkpoint_seq, a.snapshot_block,
                    a.state_root, a.state_root_version
             FROM anchor_actions a
             JOIN index_statuses s ON s.id = a.status_id
             WHERE a.version = ? AND a.chain = ? AND a.network = ? AND a.block_index >= ?
               AND a.state_root IS NOT NULL AND s.status = 'valid'
             ORDER BY a.block_index ASC, a.checkpoint_seq DESC
             LIMIT 1`,
            [version, chain, network, atOrAfterBlock]);
    },

    // The hub-mirrored state_checkpoints candidates at or above a height, lowest first. The
    // caller re-verifies each and keeps the first that passes, so this returns several rows
    // rather than one: a row at the lowest qualifying height may fail re-verification, and
    // the next candidate up is then the honest pick rather than a stall. Capped at 8 because
    // it runs inside the block loop. Reads the mirror home, not the indexer's own tables.
    async getMirroredStateCheckpointCandidates(chain, network, atOrAfterBlock){
        return await this._mirrorDb().doQuery(
            `SELECT * FROM state_checkpoints
             WHERE chain = ? AND network = ? AND block_index >= ? AND state_root IS NOT NULL
             ORDER BY block_index ASC, checkpoint_seq DESC
             LIMIT 8`,
            [chain, network, atOrAfterBlock]);
    },

};
