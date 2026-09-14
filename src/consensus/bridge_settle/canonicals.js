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
 * XChain Platform - bridge settle pass: the signed canonicals and the mirrored-select bind
 * clause, the three places the pass reads an activation.
 *
 * BUILT BY THE ENTRY, NEVER REQUIRED DIRECTLY, and that is the whole reason this part is a
 * factory. The mirror-admission and equivocation activations freeze their maps from the
 * environment at REQUIRE time, and the suites that drive an arming purge the entry together
 * with the activation module and re-require both (test/unit/admission_binding.test.js,
 * test/unit/bridge_settle.test.js requireDisarmed). A part that required the activation
 * itself would not be purged with them and would keep answering from the pre-arming map,
 * which is a silent consensus change in exactly the case those suites exist to pin. Taking
 * the modules from the entry means every arming the entry sees is the arming this part uses.
 *
 *
 * THE BODIES ARE PLAIN NAMED FUNCTIONS that take the entry's deps as their first argument, and
 * the factory at the foot only binds them. That keeps every step its own named function instead
 * of one long closure, while every capture still comes from the entry.
 ********************************************************************/

'use strict';

/**
 * The binding clause of a mirrored select at this pass's block, with its bindings.
 *
 * Below the consumer activation for (ctx.coin, ctx.network) at ctx.blockIndex this is
 * `effective_time <= ?` byte for byte, one binding, so the SQL a pre-train node issues is the
 * SQL this node issues. Above it, the null-safe admission form for THIS chain's column, never a bare comparison
 * on the nullable column: a bare `admit_block_<c> <= ?` evaluates to NULL for every legacy row
 * and silently drops it, which is a silent consensus change. The IS NULL arm is what lets a row
 * finalized below the producer activation, and a row whose map does not name this chain, bind
 * exactly as they do today at every height.
 *
 * The same clause text lives in db.js for the match, call and attest-response selects; the
 * admission-binding suite pins the two spellings equal so they cannot drift apart.
 *
 * @param {Object} ctx - the pass context (coin, network, blockIndex, blockTime)
 * @returns {{sql: string, args: Array}}
 */
function mirrorBindClause(deps, ctx){
    const ah = deps.ah;
    const blockTime = Number(ctx.blockTime);
    const height    = ctx.blockIndex;
    const active    = (height !== null && height !== undefined)
                   && ah.isMirrorAdmissionConsumerActive(ctx.coin, ctx.network, height);
    if(!active) return { sql: 'effective_time <= ?', args: [blockTime] };
    const col = 'admit_block_' + String(ctx.coin).toLowerCase();
    return {
        sql:  '((' + col + ' IS NULL AND effective_time <= ?) OR (' + col + ' IS NOT NULL AND ' + col + ' <= ?))',
        args: [blockTime, Number(height)]
    };
}

/**
 * The signed content canonical of a transfer record, wrapped by the equivocation header.
 * MUST byte-match the hub's CrossChainBridgeEngine. Every field is String()-coerced and a
 * null is an empty string, the platform's canonical rule.
 *
 * @param {Object} row - a bridge_transfers row
 * @returns {string}
 */
function transferCanonical(deps, row){
    const { ah, eq } = deps;
    const raw = [
        'XBRIDGE', row.transfer_id, String(row.snapshot_block),
        row.tick || '', String(row.decimals),
        row.src_chain || '', String(row.src_action_index), row.src_address || '',
        row.dest_chain || '', row.dest_address || '',
        String(row.amount), String(row.effective_time), row.network || ''
    ].join('|');
    // The admission map the hub signed, rebuilt from the row's admit_block_* columns and
    // era-keyed on the ROW's snapshot_block. A transfer is read by dest_chain alone, so the
    // map names one chain. Empty below the producer activation (legacy bytes unchanged); a
    // modern row with no columns REFUSES here rather than verifying as legacy.
    const admitted = raw + ah.admissionCanonicalField('CrossChainBridge', row.network, row.snapshot_block,
                                                      ah.columnsAdmitBlocks(row));
    if(eq.isEquivHeaderActive(row.snapshot_block, row.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, row.transfer_id,
                                      (row.finalizing_view != null ? row.finalizing_view : 0), admitted);
    return admitted;
}

/**
 * The signed content canonical of a policy snapshot, wrapped by the equivocation header.
 * MUST byte-match the hub. `sleeping` is deliberately ABSENT: it is committed through
 * policy_hash alone, so repeating it here would be a second, divergent
 * commitment of the same fact.
 *
 * @param {Object} row - a policy_snapshots row
 * @returns {string}
 */
function policyCanonical(deps, row){
    const { ah, eq } = deps;
    const raw = [
        'XPOLICY', row.snapshot_id, String(row.snapshot_block),
        row.origin_chain || '', row.tick || '', String(row.policy_seq),
        String(row.origin_block), row.policy_hash || '',
        String(row.effective_time), row.network || ''
    ].join('|');
    // A policy snapshot is the sharp case: its consuming select carries NO chain clause, so
    // the hub stamps every chain the federation serves and this rebuilds exactly the columns
    // that are set. A chain added after the row was signed is simply absent from its map and
    // binds there by the legacy effective_time rule, safe by construction.
    const admitted = raw + ah.admissionCanonicalField('CrossChainPolicy', row.network, row.snapshot_block,
                                                      ah.columnsAdmitBlocks(row));
    if(eq.isEquivHeaderActive(row.snapshot_block, row.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.POLICY, row.snapshot_id,
                                      (row.finalizing_view != null ? row.finalizing_view : 0), admitted);
    return admitted;
}

/**
 * @param {Object} deps - { ah: mirror_admission_activation, eq: equivocation_header }, as the
 *                        ENTRY required them
 */
module.exports = function createCanonicals(deps){
    return {
        mirrorBindClause:  (ctx) => mirrorBindClause(deps, ctx),
        transferCanonical: (row) => transferCanonical(deps, row),
        policyCanonical:   (row) => policyCanonical(deps, row),
    };
};
