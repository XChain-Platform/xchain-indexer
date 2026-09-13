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
 * XChain Indexer - Database mixin: events
 * 
 * The queries over the events table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// Single decoder for the decoder's REORG event payload, shared with the getreorghistory RPC
// so the array-of-{block_index, block_hash} contract is defined once. Pure leaf module (no
// requires of its own), so no cycle.
const reorgHistoryQuery = require('../api/reorg_history_query');

const { getLogger } = require('../observability/index.js');
module.exports = {

    // The getreorghistory page: recent decoder REORG events above `sinceId`. Newest-first,
    // the opposite of getReorgsSince above, because a caller checking whether a RECENT reorg
    // happened must see the relevant rows before `limit` truncates the page. `id` is the
    // decoder's monotonic events id, and the limit is bounded upstream so a peer can never
    // make this node serialize an unbounded events scan.
    //
    // This one reads the DECODER schema: the caller invokes it on decoderDb, not indexerDb.
    async getReorgEventsSince(sinceId, limit){
        return await this.doQuery(
            `SELECT id, data FROM events WHERE code = 'REORG' AND id > ? ORDER BY id DESC LIMIT ?`,
            [sinceId, limit]);
    },

    // `cursorWitness` (optional #2735): { time, hash } captured for the cursor's decoder REORG
    // event when the marker was recorded. Non-null enables the additive under-cursor check;
    // null (legacy marker) falls back to the pre-existing one-directional over-cursor guard.
    async getReorgsSince(afterId, cursorWitness){
        let query, args;
        if(afterId === null || afterId === undefined){
            query = `SELECT id, data FROM events WHERE code='REORG' ORDER BY id ASC`;
            args  = [];
        } else {
            query = `SELECT id, data FROM events WHERE code='REORG' AND id > ? ORDER BY id ASC`;
            args  = [Number(afterId)];
        }
        // #2735 (witness the cursor row): closes the UNDER-cursor silent skip that the
        // length===0 && maxId<afterId guard below cannot see. BEFORE the id>afterId select,
        // confirm the exact decoder REORG event the cursor points at still exists; and, for a
        // marker recorded WITH a witness, that its live time + payload hash still match what we
        // recorded. A rebuilt decoder whose fresh id space overtook a stranded cursor returns
        // non-empty id>afterId results, so without this it would silently drop new-incarnation
        // REORG events at/below the cursor. Additive: a legacy (null-witness) marker keeps only
        // the old over-cursor guard so upgrades are unaffected.
        if(afterId !== null && afterId !== undefined){
            let witnessRows = await this.doQueryStrict(
                `SELECT time, data FROM events WHERE id = ? AND code='REORG'`, [Number(afterId)]);
            if(witnessRows.length === 0)
                throw this.reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
                    ' points at no live decoder REORG event (the cursor row is gone).');
            if(cursorWitness && cursorWitness.time != null && cursorWitness.hash != null){
                let live     = witnessRows[0];
                let liveHash = this.hashReorgData(live.data);
                if(String(live.time) !== String(cursorWitness.time) || liveHash !== String(cursorWitness.hash))
                    throw this.reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
                        ' witness mismatch (the live decoder REORG event at that id has a different ' +
                        'time/payload than when it was recorded).');
            }
        }
        // doQueryStrict (not doQuery): this runs on decoderDb, which never opens a
        // transaction, so doQuery would collapse any read fault to [] - indistinguishable
        // from "no unprocessed reorgs". That silently suppresses the rollback trigger and
        // lets the catch-up loop commit and publish blocks on un-rolled-back old-chain
        // state. Throwing instead aborts the pass with no block committed; the loop retries
        // on the next tick. Mirrors the throwing sibling read on the indexer side.
        let results = await this.doQueryStrict(query, args);
        // Incarnation guard (/ RE-1): the cursor is a decoder events.id, and the
        // decoder never deletes events rows, so a cursor ABOVE the decoder's newest REORG
        // id can only mean the decoder DB was rebuilt or restored out-of-band (AUTO_INCREMENT
        // reset). With the old behavior that stranded cursor made this query return [] forever,
        // silently disabling every future rollback while the indexer kept committing blocks.
        // Fail loud instead: the throw aborts the pass with no block committed (same contract
        // as a read fault above), so the incoherence pages the operator rather than rotting.
        if(afterId !== null && afterId !== undefined && results.length === 0){
            let maxRow = await this.doQueryStrict(`SELECT MAX(id) AS max_id FROM events WHERE code='REORG'`);
            let maxId  = (maxRow.length > 0) ? maxRow[0]["max_id"] : null;
            if(maxId === null || Number(maxId) < Number(afterId)){
                throw this.reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
                    ' exceeds the decoder\'s newest REORG event id (' + maxId + ').');
            }
        }
        let reorgs = [];
        for(let row of results){
            // ONE decoder for the decoder's REORG payload, shared with the getreorghistory
            // RPC (reorg-history-query.parseReorgEvent). Two hand-rolled copies of the
            // array-of-{block_index, block_hash} contract, with different acceptance rules,
            // let a payload reshape be absorbed by one and silently dropped by the other: the
            // hub-facing RPC answering "not orphaned" while this path still rolled back, or the
            // reverse. Defining the contract once means a reshape breaks in exactly one place.
            // min_block_index is the deepest (lowest) orphaned block, the rollback target.
            // parseReorgEvent swallows a JSON parse fault and yields no blocks, which lands on
            // the same LOUD drop below that the old inline try/catch did.
            let block_index = reorgHistoryQuery.parseReorgEvent(row).min_block_index;
            // A malformed or empty payload must never be treated as a valid rollback target
            // (a null/non-finite block_index here would let `lastIndexerBlock >= null` coerce
            // true and call rollback(null), whose predicates match no rows - a silently missed
            // rollback). We SKIP rather than throw - a benign payload reshape must not halt
            // indexing, and three regression tests pin skip-not-throw - but the skip must not be
            // SILENT: getLastProcessedReorgId can later advance the cursor PAST this id via a
            // newer well-formed marker, permanently losing this rollback with zero operator
            // signal. Log LOUD (the decoder REORG contract is [{block_index, block_hash}]) so a
            // payload-shape drift pages the operator instead of rotting.
            if(!Number.isFinite(block_index)){
                getLogger().error('getReorgsSince: DROPPING malformed REORG event id=' + row.id +
                    ' (afterId=' + afterId + '): payload yields no finite block_index, so it has no ' +
                    'rollback target and the cursor may later pass this id and miss the rollback. ' +
                    'Expected decoder contract [{block_index, block_hash}]; got data=' +
                    String(row.data).slice(0, 200));
                continue;
            }
            reorgs.push({ id: Number(row.id), block_index: block_index });
        }
        return reorgs;
    },

    // #2736: probe for a durable REORG_HALT marker the decoder writes when it halts (e.g. a
    // reorg deeper than it can safely rewind). getReorgsSince only ever selects code='REORG',
    // so without this a halted decoder is invisible to the indexer and merely presents as idle
    // or lagging. Runs on decoderDb with the SAME throwing read contract as getReorgsSince
    // (doQueryStrict): a swallowed read fault must not masquerade as "not halted". Returns
    // { halted:boolean, payload:(string|null) } - the payload is the marker's `data` column
    // (operator context: why the decoder halted), null when not halted or absent.
    //
    // The NEWEST of REORG_HALT / REORG_HALT_CLEARED decides, mirroring the writer-side
    // contract in xchain-decoder/src/db.js readReorgHaltState. `xchain-node clear-reorg-halt`
    // clears a reviewed halt by writing a REORG_HALT_CLEARED row and never deletes the halt
    // row, so the audit trail survives; selecting only REORG_HALT reads a cleared halt as
    // live forever. A later halt writes a newer REORG_HALT row that is live again.
    // Fail-closed: a row whose code is missing or unreadable still counts as halted, because
    // "we could not tell" must never reach a caller as "not halted".
    async isReorgHalted(){
        let rows = await this.doQueryStrict(
            `SELECT code, data FROM events WHERE code IN ('REORG_HALT','REORG_HALT_CLEARED') ORDER BY id DESC LIMIT 1`);
        if(rows.length === 0) return { halted: false, payload: null };
        if(rows[0].code === 'REORG_HALT_CLEARED') return { halted: false, payload: null };
        return { halted: true, payload: (rows[0].data != null) ? String(rows[0].data) : null };
    },

    // Get the decoder event id of the most-recent reorg the indexer has already recorded,
    // or null if none. getReorgsSince() selects every decoder reorg with an id greater than
    // this value - an IDENTITY check, not a block-height compare.
    async getLastProcessedReorgId(){
        // Scan REORG markers newest-first and return the newest one that carries a decoder_event_id
        // (REORG-4). The previous code inspected ONLY the single newest row and returned null if it
        // was a legacy plain-block-number payload - so on a partially-migrated DB whose newest marker
        // is legacy but older markers are new-format, it wrongly reported "no reorg ever processed",
        // and getReorgsSince(null) then re-replayed the decoder's entire reorg history (a massive
        // spurious rollback). Scanning back finds the real cursor whenever any new-format marker
        // exists. LIMIT bounds the scan; new-format markers are the steady state, so in practice this
        // returns on the first row.
        let query = `SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 200`;
        // doQueryStrict (not doQuery): symmetry with getReorgsSince/createReorg. A swallowed
        // read fault here would return [] -> null, indistinguishable from "no reorg ever
        // processed", causing getReorgsSince(null) to replay the entire decoder reorg history.
        // Fail loud so the cursor read cannot silently collapse into a full-history rollback.
        let results = await this.doQueryStrict(query);
        if(results.length === 0)
            return null;
        for(let row of results){
            try {
                let parsed = JSON.parse(row["data"]);
                if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.decoder_event_id !== undefined)
                    return Number(parsed.decoder_event_id);
            } catch(e){
                // Legacy plain-block-number rows carry no decoder event id; keep scanning.
            }
        }
        // Only legacy markers found. Returning null makes getReorgsSince replay the full decoder reorg
        // history; on a synced node upgraded from a pre-decoder_event_id release that has not reorged
        // since, that is a large spurious rollback. We deliberately do NOT auto-seed a baseline here
        // (that could silently skip a reorg that landed between the last legacy-scheme processing and
        // the upgrade); warnOnLegacyReorgCursor() surfaces the condition at startup so an operator can
        // do the one-time clean reindex the platform already treats as the norm.
        return null;
    },

    // #2735: read back the stored witness ({ time, hash }) for the CURRENT reorg cursor - the
    // newest new-format marker, the same one getLastProcessedReorgId returns an id for. Returns
    // null when that marker predates the witness columns (legacy), so getReorgsSince falls back
    // to the one-directional over-cursor guard. Runs on the indexer marker DB (doQueryStrict
    // symmetry with getLastProcessedReorgId).
    async getLastProcessedReorgWitness(){
        let results = await this.doQueryStrict(
            `SELECT data, witness_time, witness_hash FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 200`);
        for(let row of results){
            try {
                let parsed = JSON.parse(row["data"]);
                if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.decoder_event_id !== undefined){
                    if(row.witness_time != null && row.witness_hash != null)
                        return { time: row.witness_time, hash: String(row.witness_hash) };
                    return null; // newest new-format marker predates the witness columns
                }
            } catch(e){ /* legacy bare-number row; keep scanning */ }
        }
        return null;
    },

    // #2735: capture the witness ({ time, hash }) for a decoder REORG event by id, so the caller
    // can persist it via createReorg. Runs on decoderDb (SELECT time, data ... code='REORG').
    // Returns null when the event is absent. doQueryStrict for the throwing read contract shared
    // with getReorgsSince.
    async getReorgEventWitness(decoder_event_id){
        let rows = await this.doQueryStrict(
            `SELECT time, data FROM events WHERE id = ? AND code='REORG'`, [Number(decoder_event_id)]);
        if(rows.length === 0) return null;
        return { time: rows[0].time, hash: this.hashReorgData(rows[0].data) };
    },

    // Startup probe: warn loudly if the indexer has REORG markers but NONE carry a decoder_event_id
    // (all legacy format). On a synced node that means the first reorg detection after upgrade would
    // replay the decoder's entire reorg history (REORG-4). Surfaced, not auto-fixed, because there is
    // no safe way to derive the correct new-format cursor from legacy rows. No-op on a clean DB.
    async warnOnLegacyReorgCursor(){
        try {
            let rows = await this.doQuery(`SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 200`);
            if(rows.length === 0) return;
            let hasNewFormat = false;
            for(let row of rows){
                try {
                    let parsed = JSON.parse(row["data"]);
                    if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.decoder_event_id !== undefined){
                        hasNewFormat = true; break;
                    }
                } catch(e){ /* legacy row */ }
            }
            if(!hasNewFormat)
                getLogger().warn('Reorg cursor invariant: all REORG event markers are legacy (no decoder_event_id). ' +
                    'The next reorg detection would replay the full decoder reorg history. A clean genesis reindex ' +
                    'is recommended to restore the new-format cursor.');
        } catch(e){
            getLogger().warn('Reorg cursor invariant probe failed (non-fatal):', e.message);
        }
    },

    // Handle creating a record of a block reorg. Persists the decoder event id alongside the
    // block index so reorgs can be matched by identity (see getLastProcessedReorgId), not by
    // block-height magnitude - which silently misses every reorg after the first.
    // `witnessTime`/`witnessHash` (optional #2735) witness the decoder REORG event this marker
    // records: its `time` and a sha256 of its `data` payload, captured so getReorgsSince can
    // later detect an out-of-band decoder rebuild that reused this cursor id for a different
    // event. NULL when the caller does not supply them (legacy behavior / back-compat).
    async createReorg(block_index, decoder_event_id, witnessTime, witnessHash){
        let payload = JSON.stringify({ block_index: Number(block_index), decoder_event_id: Number(decoder_event_id) });
        let query = `INSERT INTO events (time, code, data, witness_time, witness_hash) values (now(), 'REORG', ?, ?, ?)`;
        let args  = [payload, (witnessTime != null ? witnessTime : null), (witnessHash != null ? String(witnessHash) : null)];
        // doQueryStrict (not doQuery): this marker advances the processed-reorg cursor and runs
        // outside any transaction, where doQuery would swallow an INSERT failure into []. A
        // swallowed failure leaves the cursor un-advanced while the loop replays past minReorgBlock,
        // so the next iteration re-detects the same reorg and performs a full spurious re-rollback of
        // already-canonical blocks (plus a redundant push-generation bump + hub retractions). Throwing
        // instead crashes to a clean restart where the committed rollback makes the reorg a no-op and
        // the marker is retried, matching the crash-safety ordering the call site documents.
        let results = await this.doQueryStrict(query, args);
    },

    // Read-only reorg observability counters for the /health payload (#1813): the total
    // number of processed reorgs, plus the block index and timestamp of the most recent
    // one. Sourced from the durable REORG markers in the events table (see createReorg).
    // Uses doQuery (not strict) and never throws: health must degrade to null fields, not
    // fail, when the DB read hiccups or the events table is absent.
    async getReorgHealthStats(){
        let stats = { reorgsProcessed: 0, lastReorgBlock: null, lastReorgAt: null };
        try {
            let countRows = await this.doQuery("SELECT COUNT(*) AS n FROM events WHERE code='REORG'");
            if(countRows.length > 0 && countRows[0].n != null)
                stats.reorgsProcessed = Number(countRows[0].n);
            let lastRows = await this.doQuery("SELECT time, data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1");
            if(lastRows.length > 0){
                let ms = new Date(lastRows[0].time).getTime();
                stats.lastReorgAt = Number.isFinite(ms) ? ms : null;
                try {
                    let parsed = JSON.parse(lastRows[0].data);
                    if(parsed && typeof parsed === 'object' && parsed.block_index != null)
                        stats.lastReorgBlock = Number(parsed.block_index);
                } catch(e){ /* legacy/plain payload: leave lastReorgBlock null */ }
            }
        } catch(e){
            // DB unreachable / events table absent; return the null-safe defaults.
        }
        return stats;
    },


    // The most recent durable TRAIN_ACTIVATION_HALT marker, or an empty list when the halt
    // has never been recorded. The caller writes the marker only once, so this is what
    // makes the write idempotent across restarts.
    async getLatestTrainActivationHaltEvent(){
        return await this.doQuery(
            "SELECT id FROM events WHERE code='TRAIN_ACTIVATION_HALT' ORDER BY id DESC LIMIT 1");
    },

    // Write that marker. events.data is a VARCHAR(250), so the caller passes the
    // machine-readable fields already serialized and truncated, never the prose reason.
    async recordTrainActivationHaltEvent(payload){
        await this.doQuery(
            "INSERT INTO events (time, code, data) values (now(), 'TRAIN_ACTIVATION_HALT', ?)", [payload]);
    },

};
