/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Retirement age for rows in the capped mirror-driven passes.
 *
 * The CROSS_SETTLE, XEXEC dispatch and XCALL result passes each take the first
 * 25 eligible mirrored rows in (snapshot_block, id) order and exclude only rows
 * that already carry an idempotency record. A row that can never apply and
 * records nothing therefore holds its slot on every block, and 25 of them ahead
 * of a valid row hold it back for good. From PASS_PROGRESS_RETIREMENT_ACTIVATION
 * such a row is retired once it has been selectable for a grace of blocks, and
 * this module says when that grace has run.
 *
 * THE CLOCK IS THE ROW'S OWN ELIGIBILITY, NOT ITS SLOT. A row is aged at block B
 * when the pass's own bind rule (db.mirrorBindClause) would already have
 * selected it at block B - grace:
 *
 *   admission era, row carries admit_block_<c>   admit_block_<c> <= B - grace
 *   otherwise                                    effective_time <= protocol time of B - grace
 *
 * Both inputs are consensus data: the quorum-signed mirrored row and the
 * decoder's stored block stamps, read through the memo-free protocol-time
 * reader so it is the same clock the bind rule compares against. Nothing is
 * remembered per node. Every row admitted together ages together, wherever it
 * sits in the queue, so once the head retires the rows behind it are already
 * old enough to retire or apply on the next block, and a valid row lands within
 * the grace plus one block per 25 rows ahead of it. A row whose signed content is
 * replaced (a revive with a new effective_time or admission height) ages from the
 * new value. On a chain whose protocol time is not monotone the time arm can only
 * read a row as YOUNGER than its first selection, never older, so it may retire a
 * block late and never early.
 *
 * THE GRACE. RETIREMENT_GRACE_BLOCKS is about two hours of each chain's nominal
 * block interval (BTC 600 s, LTC 150 s, DOGE 60 s, the hub's
 * NOMINAL_BLOCK_INTERVAL_S). That is fifteen times the hub's longest-lived
 * cross-chain round (XDEX_ROUND_MAX_LIFETIME_MS, four 120 s round timeouts, after
 * which a straggler is caught up by FINAL_SYNC), twice the one-hour orphan grace
 * the result pass already uses for the deepest source relay window, and above
 * the 3000 s ceiling on any relay margin. A short signature set that is still
 * converging across hubs, or a mirror catching up, settles long before it.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../gate_registry');

const PASS_RETIREMENT_KEY = 'pass_progress_retirement_activation.PASS_PROGRESS_RETIREMENT_ACTIVATION';

// Blocks a row stays selectable before an unapplicable verdict retires it, per processing chain.
const RETIREMENT_GRACE_BLOCKS = Object.freeze({ BTC: 12, LTC: 48, DOGE: 120 });

// A chain with no entry takes the longest grace, so an unlisted chain can only retire late.
const RETIREMENT_GRACE_FALLBACK = 120;

/**
 * Whether the capped passes retire unapplicable rows at this block.
 *
 * @param {Object} config     - the indexer config; reads NETWORK and COIN
 * @param {number} blockIndex - the block being processed
 * @returns {boolean}
 */
function isPassRetirementActive(config, blockIndex){
    return gateRegistry.activeAt(PASS_RETIREMENT_KEY, config['NETWORK'], config['COIN'], Number(blockIndex), null);
}

/**
 * The grace in blocks for a processing chain.
 *
 * @param {string} coin - the processing chain
 * @returns {number}
 */
function retirementGraceBlocks(coin){
    let g = RETIREMENT_GRACE_BLOCKS[String(coin || '').toUpperCase()];
    return Number.isInteger(g) ? g : RETIREMENT_GRACE_FALLBACK;
}

/**
 * The height the bind rule admits the row at in the admission era: its own
 * admit_block_<c>. Undefined when the era is not armed at this block or the row
 * carries no height for this chain, which is when the bind falls back to the
 * clock; NaN when the column holds a value that is not a height, which never ages.
 *
 * @param {Object} db         - the indexer Database; reads mirrorAdmissionActiveAt and admitColumn
 * @param {Object} row        - the mirrored row
 * @param {number} blockIndex - the block being processed
 * @returns {number|undefined}
 */
function admittedHeight(db, row, blockIndex){
    if(!db.mirrorAdmissionActiveAt(blockIndex)) return undefined;
    let v = row[db.admitColumn()];
    if(v === null || v === undefined) return undefined;
    let h = Number(v);
    return (Number.isInteger(h) && h >= 0) ? h : NaN;
}

/**
 * Whether a row admitted by height has been selectable for the grace. Null when
 * the row is not admitted by height at this block, so the caller keeps its own clock.
 *
 * @param {Object} db         - the indexer Database
 * @param {Object} row        - the mirrored row
 * @param {number} blockIndex - the block being processed
 * @param {string} coin       - the processing chain, which sizes the grace
 * @returns {boolean|null}
 */
function heightAgedOut(db, row, blockIndex, coin){
    let h = admittedHeight(db, row, blockIndex);
    if(h === undefined) return null;
    if(Number.isNaN(h)) return false;
    return h + retirementGraceBlocks(coin) <= Number(blockIndex);
}

/**
 * Whether a mirrored row has been selectable by its pass's bind rule for the
 * grace, i.e. the bind would already have selected it at block B - grace.
 *
 * @param {Object} db         - the indexer Database
 * @param {Object} decoderDb  - the decoder Database; reads protocolTimeForStoredBlock
 * @param {Object} row        - the mirrored row; reads effective_time and admit_block_<c>
 * @param {number} blockIndex - the block being processed
 * @param {string} coin       - the processing chain, which sizes the grace
 * @returns {Promise<boolean>}
 */
async function rowAgedOut(db, decoderDb, row, blockIndex, coin){
    let byHeight = heightAgedOut(db, row, blockIndex, coin);
    if(byHeight !== null) return byHeight;
    let ref = Number(blockIndex) - retirementGraceBlocks(coin);
    if(!Number.isFinite(ref) || ref < 0) return false;
    // parseInt, not Number: a missing effective_time must never read as time 0.
    let effective = parseInt(row.effective_time);
    if(!Number.isFinite(effective)) return false;
    let refTime = await decoderDb.protocolTimeForStoredBlock(ref);
    if(refTime === false || refTime === null || refTime === undefined) return false;
    let t = Number(refTime);
    return Number.isFinite(t) && effective <= t;
}

module.exports = {
    PASS_RETIREMENT_KEY,
    RETIREMENT_GRACE_BLOCKS,
    isPassRetirementActive,
    retirementGraceBlocks,
    heightAgedOut,
    rowAgedOut
};
