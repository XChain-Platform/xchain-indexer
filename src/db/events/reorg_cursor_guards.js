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
 * XChain Indexer - Database mixin part: events, the reorg-cursor guards
 *
 * The two fail-loud checks getReorgsSince runs around its REORG read, one before and one
 * after. Plain functions over the Database instance the mixin method was called on (the
 * decoderDb), so they add no methods to Database.prototype.
 *
 ********************************************************************/

// #2735 (witness the cursor row): closes the UNDER-cursor silent skip that the
// length===0 && maxId<afterId guard below cannot see. BEFORE the id>afterId select,
// confirm the exact decoder REORG event the cursor points at still exists; and, for a
// marker recorded WITH a witness, that its live time + payload hash still match what we
// recorded. A rebuilt decoder whose fresh id space overtook a stranded cursor returns
// non-empty id>afterId results, so without this it would silently drop new-incarnation
// REORG events at/below the cursor. Additive: a legacy (null-witness) marker keeps only
// the old over-cursor guard so upgrades are unaffected.
async function assertCursorWitness(db, afterId, cursorWitness){
    let witnessRows = await db.doQueryStrict(
        `SELECT time, data FROM events WHERE id = ? AND code='REORG'`, [Number(afterId)]);
    if(witnessRows.length === 0)
        throw db.reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
            ' points at no live decoder REORG event (the cursor row is gone).');
    if(cursorWitness && cursorWitness.time != null && cursorWitness.hash != null){
        let live     = witnessRows[0];
        let liveHash = db.hashReorgData(live.data);
        if(String(live.time) !== String(cursorWitness.time) || liveHash !== String(cursorWitness.hash))
            throw db.reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
                ' witness mismatch (the live decoder REORG event at that id has a different ' +
                'time/payload than when it was recorded).');
    }
}

// Incarnation guard (/ RE-1): the cursor is a decoder events.id, and the
// decoder never deletes events rows, so a cursor ABOVE the decoder's newest REORG
// id can only mean the decoder DB was rebuilt or restored out-of-band (AUTO_INCREMENT
// reset). With the old behavior that stranded cursor made this query return [] forever,
// silently disabling every future rollback while the indexer kept committing blocks.
// Fail loud instead: the throw aborts the pass with no block committed (same contract
// as a read fault above), so the incoherence pages the operator rather than rotting.
// Called only when the id>afterId read came back empty.
async function assertCursorNotAboveNewest(db, afterId){
    let maxRow = await db.doQueryStrict(`SELECT MAX(id) AS max_id FROM events WHERE code='REORG'`);
    let maxId  = (maxRow.length > 0) ? maxRow[0]["max_id"] : null;
    if(maxId === null || Number(maxId) < Number(afterId)){
        throw db.reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
            ' exceeds the decoder\'s newest REORG event id (' + maxId + ').');
    }
}

module.exports = { assertCursorWitness, assertCursorNotAboveNewest };
