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
 * XChain Indexer - Database part: credits, the escrow proof's own-state checks
 *
 * This node's own committed sub-roots behind a getbridgeescrowproof envelope, whether they
 * reproduce the signed checkpoint at that height, and how long the divergence answer stands
 * when they do not. Plain functions over a Database handle, required by bridge_reads.js; they
 * add no methods to Database.prototype.
 *
 ********************************************************************/

'use strict';

// The same state-root assembly the consumer's reassembly runs.
const bridgeMerkle = require('../../consensus/merkle.js');
// state_root_version is derived per height; a later row counts only when its stamped version
// is the one this node derives at that height.
const bridgeStateSubtree = require('../../consensus/gates/state_subtree_gate.js');
// The consumer's own re-verification of a mirrored checkpoint's quorum, so a later checkpoint
// counts here only when it would count for the consumer's selector.
const { verifyCheckpointQuorum } = require('../../consensus/bridge_proof_client/checkpoint_source.js');

// Origin blocks past a checkpoint this node's state does not reproduce, after which a later
// checkpoint its state DOES reproduce settles the divergence: about two hours of each chain's
// nominal block interval. A chain with no entry takes the longest.
const DIVERGENCE_SETTLE_BLOCKS = Object.freeze({ BTC: 12, LTC: 48, DOGE: 120 });
const DIVERGENCE_SETTLE_FALLBACK = 120;

// Blocks of this node's own tip past the newest signed checkpoint its mirror holds, after which
// the checkpoint stream reads as stopped: about one day of each chain's nominal block interval,
// against a cadence of one checkpoint every six BTC blocks. A chain with no entry takes the longest.
const CHECKPOINT_STREAM_STALL_BLOCKS = Object.freeze({ BTC: 144, LTC: 576, DOGE: 1440 });
const CHECKPOINT_STREAM_STALL_FALLBACK = 1440;

// Whether sub-roots reassemble to a checkpoint's signed state_root, by the same reassembly the
// consumer runs (bridge_checkpoint_check/bindings.js reassembleStateRoot). A row with no signed
// root carries nothing to compare against and reads as reproduced: the consumer binds its own
// selected checkpoint, not this row.
function reproducesSignedRoot(subRoots, cp){
    let signedRoot = String(cp.state_root || '');
    if(!/^[0-9a-fA-F]{64}$/.test(signedRoot)) return true;
    let assembled;
    try { assembled = bridgeMerkle.toHex(bridgeMerkle.stateRoot(subRoots)); }
    catch(e){ return false; }
    return assembled.toLowerCase() === signedRoot.toLowerCase();
}

// Rows per page of the later-checkpoint scan below.
const DIVERGENCE_SCAN_PAGE = 32;

// Settling rows already found, keyed by the diverged checkpoint (height and signed root), so a
// consumer retrying every block costs one root read instead of a scan. Bounded, oldest first out.
const DIVERGENCE_WITNESS_MAX = 256;

// This node's committed sub-roots at a height, or null when it committed none there.
async function ownSubRootsAt(db, chain, network, height){
    let rootRows = await db.doQueryStrict(
        `SELECT balances_root, stakes_root, contract_state_root
         FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1`,
        [chain, network, height]);
    return rootRows.length ? subRootsOf(db, rootRows[0]) : null;
}

// Whether a later mirrored row settles the divergence on this node: its stamped version is the
// one this node derives at its height, this node's own committed state there reproduces its
// signed root, and its quorum re-verifies the way the consumer's selector re-verifies it. The
// reproduction is checked first: it costs one root read, while the quorum costs a signature
// verification per signer, and on a deep reorg most rows in the window fail reproduction.
async function rowSettles(db, chain, network, later){
    let laterHeight = Number(later.block_index);
    let derivedVersion = bridgeStateSubtree.stateRootVersion(laterHeight, network, chain);
    if(derivedVersion === null || Number(later.state_root_version) !== derivedVersion) return false;
    let own = await ownSubRootsAt(db, chain, network, laterHeight);
    if(!own || !reproducesSignedRoot(own, later)) return false;
    return await verifyCheckpointQuorum(later, db);
}

// Whether this node holds a quorum-verified checkpoint at least DIVERGENCE_SETTLE_BLOCKS past
// `height` whose signed root its own committed state at that checkpoint's height reproduces.
// The federation signs later checkpoints over the chain it follows, so a node that reorged
// below a signed checkpoint together with the federation finds one, and a node on a minority
// fork never does.
//
// THE SCAN. The mirrored rows from height + DIVERGENCE_SETTLE_BLOCKS up to this node's own tip,
// lowest first, DIVERGENCE_SCAN_PAGE at a time, until one settles. Every row in the window can
// predate the reorg (the federation may have signed many checkpoints over the old chain before
// it reorged), so no fixed prefix of the window is enough. It stops at the tip because this node
// has no state above it to reproduce. Worst case, one call reads every mirrored row in
// [height + DIVERGENCE_SETTLE_BLOCKS, tip] (about (tip - height) / cadence rows, times the
// sequences per height) with one root read each, and verifies quorum only on rows its state
// reproduces. A minority-fork node pays that on every call, which is the price of answering
// DIVERGED and falls only on the consumers asking it.
//
// THE MEMO. Once a row settles, it is remembered for that diverged checkpoint and re-checked
// on the next call with one root read: a later reorg of this node that stops reproducing it
// drops the memo and the scan runs again. A negative verdict is not remembered, because a
// settling row can arrive in the mirror at any time.
async function divergenceSettled(db, chain, network, height, cp){
    let memoKey = chain + '|' + network + '|' + height + '|' + String(cp.state_root || '').toLowerCase();
    let memo = db._bridgeDivergenceWitness || (db._bridgeDivergenceWitness = new Map());
    let witness = memo.get(memoKey);
    if(witness){
        let own = await ownSubRootsAt(db, chain, network, Number(witness.block_index));
        if(own && reproducesSignedRoot(own, witness)) return true;
        memo.delete(memoKey);
    }

    let settle = DIVERGENCE_SETTLE_BLOCKS[String(chain || '').toUpperCase()];
    if(!Number.isInteger(settle)) settle = DIVERGENCE_SETTLE_FALLBACK;
    let tip = Number(await db.getLatestBlockIndex());
    // Keyset paging over (block_index ASC, checkpoint_seq DESC), starting just below the window.
    let lastHeight = height + settle - 1, lastSeq = -1;
    while(lastHeight < tip){
        let page = await db.mirrorDb().doQueryStrict(
            `SELECT * FROM state_checkpoints
             WHERE chain = ? AND network = ? AND state_root IS NOT NULL AND block_index <= ?
               AND (block_index > ? OR (block_index = ? AND checkpoint_seq < ?))
             ORDER BY block_index ASC, checkpoint_seq DESC
             LIMIT ${DIVERGENCE_SCAN_PAGE}`,
            [chain, network, tip, lastHeight, lastHeight, lastSeq]);
        for(let later of page){
            if(await rowSettles(db, chain, network, later)){
                if(memo.size >= DIVERGENCE_WITNESS_MAX) memo.delete(memo.keys().next().value);
                memo.set(memoKey, later);
                return true;
            }
        }
        if(page.length < DIVERGENCE_SCAN_PAGE) break;
        let last = page[page.length - 1];
        lastHeight = Number(last.block_index);
        lastSeq = Number(last.checkpoint_seq);
    }
    return false;
}

// Whether the checkpoint stream has stopped as this node sees it: the newest signed row its
// mirror holds for this chain is CHECKPOINT_STREAM_STALL_BLOCKS or more below its own tip, so
// no later checkpoint is arriving that divergenceSettled could ever find. Any row with a signed
// root counts, quorum or not: a forged fresh row only keeps the divergence answer standing,
// which is the waiting side, so the cheap read is the safe one.
async function checkpointStreamStopped(db, chain, network){
    let stall = CHECKPOINT_STREAM_STALL_BLOCKS[String(chain || '').toUpperCase()];
    if(!Number.isInteger(stall)) stall = CHECKPOINT_STREAM_STALL_FALLBACK;
    let rows = await db.mirrorDb().doQueryStrict(
        `SELECT MAX(block_index) AS newest_block FROM state_checkpoints
         WHERE chain = ? AND network = ? AND state_root IS NOT NULL`,
        [chain, network]);
    let newest = rows.length ? rows[0].newest_block : null;
    // No signed row at all reads as a stream not yet started, never as one that stopped.
    if(newest === null || newest === undefined) return false;
    let tip = Number(await db.getLatestBlockIndex());
    if(!Number.isFinite(tip)) return false;
    return tip - Number(newest) >= stall;
}

// The envelope's sub_roots: the balances and stakes roots always, the contract-state root
// only when this height committed one.
function subRootsOf(db, rootRow){
    let subRoots = {
        balances_root: rootRow.balances_root,
        stakes_root:   rootRow.stakes_root
    };
    if(!db.util.isNull(rootRow.contract_state_root))
        subRoots.contract_state_root = rootRow.contract_state_root;
    return subRoots;
}

// Whether getBridgeEscrowProof answers DIVERGED instead of its envelope: this node's own roots
// do not reproduce the signed checkpoint, no later checkpoint settles the divergence, and the
// checkpoint stream that could settle it has not stopped.
async function divergenceAnswerStands(db, chain, network, height, subRoots, cp){
    if(reproducesSignedRoot(subRoots, cp)) return false;
    if(await divergenceSettled(db, chain, network, height, cp)) return false;
    return !await checkpointStreamStopped(db, chain, network);
}

module.exports = {
    DIVERGENCE_SETTLE_BLOCKS, CHECKPOINT_STREAM_STALL_BLOCKS,
    subRootsOf, divergenceSettled, checkpointStreamStopped, divergenceAnswerStands,
};
