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
 * XChain Platform - bridge settle pass: which token policy snapshots a block may select, and
 * in which policy_seq order, from BRIDGE_POLICY_APPLY_ORDER_ACTIVATION.
 *
 * Two rules, both read by the pass before the XPOLICY_MAX_PER_BLOCK cap and the second also
 * by the apply's own order guard, so a row the pass selects is never one the guard holds for
 * a reason the pass could have seen:
 *
 *   COPY. A snapshot whose tick has no bridged copy here is left out of the capped selection.
 *   A copy exists when the token row <origin>.<tick> exists at this block, or when a due
 *   finalized lock in-leg names the tick (the apply creates the copy from that in-leg's signed
 *   decimals). The first is this chain's own ledger and the second is a mirror read behind the
 *   bridge barrier, so every node excludes the same rows, and either one appearing re-admits
 *   the row at the next block.
 *
 *   ORDER. A tick's snapshots apply in contiguous policy_seq order. A seq at or below the
 *   highest seq this chain applied never applies. A seq waits while some earlier seq above the
 *   applied one is neither applied nor recorded refused, unless it has waited
 *   XPOLICY_SEQ_GAP_BOUND_S of block time past its own effective_time.
 *
 * Every input to both rules is block time, a quorum-signed row field, this chain's ledger or
 * bridge_settlements, or a mirror row the barriers guarantee is local. None of them is the
 * presence of a row that is not yet due, which is the one thing two honest nodes may disagree
 * on, so the selection is the same on every node.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../gate_registry');
const { resolveTransferOrigin } = require('../bridge_checkpoint_check/origin.js');
const { int, isNull } = require('./reasons.js');

const APPLY_ORDER_KEY = 'bridge_policy_apply_order_activation.BRIDGE_POLICY_APPLY_ORDER_ACTIVATION';

// How long a seq may wait on a missing predecessor, in seconds of block time past its own
// effective_time. The hub signs seq K only once K - 1 is finalized in its own table
// (getLatestPolicySeq is MAX(finalized) + 1), so K - 1 is finalized no later than K. Each is
// stamped at its finalization second plus a margin between the smallest relay floor (240 s)
// and the hub cap RELAY_MARGIN_MAX_S (3000 s), and two federated leaders' clocks differ by at
// most the 3600 s a follower tolerates before refusing to co-sign. So a real K - 1 is
// effective at most 3000 - 240 + 3600 s after K, and the barrier guarantees it is local once
// due; 6600 s covers it with margin to spare. A seq that is still missing past the bound was
// never finalized or can never apply here (a terminal refusal this chain did not record),
// and waiting longer would freeze the tick's policy for good.
const XPOLICY_SEQ_GAP_BOUND_S = 3000 + 3600;

function applyOrderActive(ctx){
    return gateRegistry.activeAt(APPLY_ORDER_KEY, ctx.network, ctx.coin, ctx.blockIndex, null);
}

// The signed decimals of the first lock in-leg in `rows` that carries `origin`'s native tick
// `name`, or null. `rows` is the due, finalized in-leg set for this chain in its pass order.
function lockInLegDecimals(rows, origin, name){
    for(const row of (rows || [])){
        const o = resolveTransferOrigin(row);
        if(o && o.kind === 'lock' && o.originChain === origin && o.nativeTick === name){
            const decimals = int(row.decimals);
            if(decimals !== null) return decimals;
        }
    }
    return null;
}

// Whether some seq between the applied one and a.seq is neither applied nor filled. Counted
// over the filled set, never walked over the seq range: policy_seq is read here before the
// row's signatures are checked, so a range walk would let one forged row with a huge seq
// stall the block.
function gapBefore(a){
    let have = 0;
    for(const s of a.filled) if(s > a.appliedSeq && s < a.seq) have++;
    return have < a.seq - a.appliedSeq - 1;
}

/**
 * The verdict for one snapshot under the ORDER rule.
 *
 * @param {Object} a
 * @param {number} a.seq          - the row's policy_seq
 * @param {number} a.effectiveTime - the row's effective_time
 * @param {number} a.blockTime    - this block's protocol time
 * @param {number} a.appliedSeq   - the highest seq applied for the tick here, 0 for none
 * @param {Set<number>} a.filled  - seqs above appliedSeq that are recorded refused here
 * @returns {'apply'|'stale'|'hold'}
 */
function seqVerdict(a){
    if(a.seq <= a.appliedSeq) return 'stale';
    if(!gapBefore(a)) return 'apply';
    return (a.blockTime >= a.effectiveTime + XPOLICY_SEQ_GAP_BOUND_S) ? 'apply' : 'hold';
}

// The applied seq and the refused seqs of one tick, read from this chain's own records.
async function seqState(db, network, origin, name){
    const st = await db.getPolicySeqState(network, origin, name);
    return { appliedSeq: st.appliedSeq, filled: new Set(st.refusedSeqs) };
}

/**
 * The apply's order guard, armed: the ORDER rule for one row against this chain's records.
 *
 * @returns {Promise<'apply'|'stale'|'hold'>}
 */
async function orderVerdict(db, row, ctx, f){
    const st = await seqState(db, row.network, f.origin, f.name);
    return seqVerdict({ seq: f.seq, effectiveTime: Number(row.effective_time),
                        blockTime: Number(ctx.blockTime), appliedSeq: st.appliedSeq, filled: st.filled });
}

/**
 * The armed selection: `rows` (the unapplied snapshots in pass order) less every row the COPY
 * or ORDER rule leaves out, in the same order. A row this chain originates, or one whose
 * fields do not parse, is kept, so its own refusal in the apply judges it as before.
 *
 * @param {Array<Object>} rows
 * @param {Object} ctx - the pass context
 * @param {{bind: Object}} opts - the pass's mirror bind clause
 * @returns {Promise<Array<Object>>}
 */
async function selectArmed(rows, ctx, opts){
    const db = ctx.indexerDb;
    const coin = String(ctx.coin || '');
    let inLegs = null;
    const copies = new Map();
    const states = new Map();
    const out = [];
    for(const row of rows){
        const origin = String(row.origin_chain || '');
        const name = String(row.tick || '');
        const seq = int(row.policy_seq);
        if(!origin || !name || seq === null || origin === coin){ out.push(row); continue; }
        const key = origin + '|' + name;

        if(!copies.has(key)){
            let has = false;
            const copyTick = origin + '.' + name;
            if(!isNull(await db.getTickerId(copyTick)) && await db.getTokenInfo(copyTick, ctx.blockIndex)) has = true;
            if(!has){
                const mirror = db.mirrorDb();
                if(inLegs === null)
                    inLegs = (typeof mirror.getFinalizedBridgeTransfersForChain === 'function')
                        ? await mirror.getFinalizedBridgeTransfersForChain(ctx.network, ctx.coin, opts.bind) : [];
                has = lockInLegDecimals(inLegs, origin, name) !== null;
            }
            copies.set(key, has);
        }
        if(!copies.get(key)) continue;

        if(!states.has(key)) states.set(key, await seqState(db, row.network, origin, name));
        const st = states.get(key);
        const at = { seq: seq, effectiveTime: Number(row.effective_time),
                     blockTime: Number(ctx.blockTime), appliedSeq: st.appliedSeq, filled: st.filled };
        if(seqVerdict(at) !== 'apply') continue;
        // A selected row with no gap before it stands as the applied seq for the rows after it,
        // which is what the apply's guard reads once it has applied earlier in this block; if it
        // does not apply, that guard holds the later row instead. A row selected over a gap by
        // the bound does not: its signatures are unchecked until it applies, and taking its seq
        // here would mark the tick's real earlier seqs stale in this block.
        if(!gapBefore(at)) st.appliedSeq = seq;
        out.push(row);
    }
    return out;
}

module.exports = {
    APPLY_ORDER_KEY,
    XPOLICY_SEQ_GAP_BOUND_S,
    applyOrderActive,
    lockInLegDecimals,
    seqVerdict,
    orderVerdict,
    selectArmed,
};
