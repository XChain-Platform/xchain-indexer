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
 * XChain Platform Action - CROSS_SETTLE (system-injected, mirror-driven)
 *
 * Settles THIS chain's leg of a cross-chain DEX match. The xchain-hub federation
 * matched two cross-chain offers, signed the match (2f+1 `cross_chain` validators),
 * and delivered it through the hub-DB mirror (cross_chain_matches). This handler
 * is injected once per effective, unsettled match for this chain (see
 * utility.js processCrossChainSettlements), verifies the signatures locally, and
 * releases the local offer's escrow to the counterparty's payout address.
 *
 * There is NO on-chain transaction for the settlement; it is an internal action
 * (like SWAP_MATCH), recorded in cross_chain_settlements for idempotency + rollback.
 *
 * Trust: the match terms are only acted on after 2f+1 `cross_chain` signatures
 * verify against the mirrored capability snapshot at the match's snapshot_block;
 * a bad mirror can delay but cannot forge a settlement.
 *
 * Spec: xchain-documentation/protocol/Cross_Chain_DEX.md
 *
 * WHERE THE PARTS LIVE. This file is the entry, the canonical signing string and the
 * per-block dispatch; ./local_leg.js decides which leg is ours and whether it is worth
 * settling, ./quorum.js verifies the signatures, and ./settle_leg.js moves the value.
 *
 ********************************************************************/

const eq      = require('../../equivocation_header.js');
const ccr     = require('../../cross_chain_royalty_activation.js');
const ah      = require('../../mirror_admission_activation.js');

const localLeg   = require('./local_leg.js');
const quorum     = require('./quorum.js');
const settleLeg  = require('./settle_leg.js');

class Cross_Settle {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
        // Matches whose local leg can never settle on this chain (the leg's action index is
        // already parsed and is not a cross-chain offer or order), keyed by match_id with the
        // block that judged them. Process-local on purpose: it changes no row, mints no action
        // and moves no match out of the per-block prefix, so every node still evaluates the
        // same list; it only stops re-reading and re-logging the same verdict on every block.
        // A rollback below the judging block re-evaluates the match (see parse).
        this.dismissed = new Map();
    }

    // Canonical signing string. MUST byte-match the hub's CrossChainDexEngine.canonicalMatch.
    // The partial-fill form appends the fill fields after `network` (the full-fill field order is kept):
    // a_amount/b_amount are the FILL settled by THIS match; *_kind + *_filled_before bind
    // sequential partial fills apart.
    canonical(m){
        let raw = [
            'XMATCH', m.match_id, String(m.snapshot_block),
            m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
            m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
            String(m.effective_time), m.network || '',
            m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
            m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
        ].join('|');
        // Cross-chain royalty legs ride the signed match at/above the CROSS_CHAIN_ROYALTY
        // flag-day; below it the canonical is byte-identical to the legacy format.
        if(ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
            raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
        // The admission map the hub signed, rebuilt from the mirrored row's own admit_block_*
        // columns and era-keyed on the ROW's snapshot_block, exactly as the hub keys it. Below
        // the producer activation the field is empty and these bytes are the legacy bytes; in
        // the admission era a row with no columns set REFUSES (the field throws) rather than
        // verifying as legacy, because the two eras never share a signature. Appended LAST so
        // its '|' separator holds whatever the royalty gate did before it. Must byte-match the
        // hub, which appends the same field in the same position.
        raw += ah.admissionCanonicalField('CrossChainDex', m.network, m.snapshot_block, ah.columnsAdmitBlocks(m));
        // EQUIV header: VIEW = the row's persisted finalizing_view (the view the
        // hub round finalized at; == pending.view when the quorum sigs were taken). TAG=XDEX,
        // ROUND_ID=match_id. Gate on the row's snapshot_block + network. Must byte-match the hub.
        if(eq.isEquivHeaderActive(m.snapshot_block, m.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
        return raw;
    }

    /**
     * The per-block entry: one injected CROSS_SETTLE for one effective, unsettled match.
     * The order of the four steps is the security order and does not change - our leg
     * first (chain state only), then the dismissal probe, then the signature quorum, and
     * only then the value movement.
     *
     * @param {Array<string>} params - unused; a CROSS_SETTLE carries no wire fields
     * @param {Object}        data   - the action row under construction; reads MATCH and
     *                                 BLOCK_INDEX, writes ACTION_INDEX and STATUS
     * @param {string|null}   error  - unused; this action is never broadcast, so no earlier
     *                                 gate can have refused it
     * @returns {Promise<void>}
     */
    async parse(params, data, error){
        let m = data['MATCH'];
        if(!m) return;

        let coin = this.config['COIN'];

        if(!localLeg.matchIsOnThisNetwork.call(this, m))
            return;

        let leg = localLeg.resolveLocalLeg(m, coin);
        if(!leg) return;

        let probe = await localLeg.probeLocalLeg.call(this, data, m, leg, coin);
        if(probe.dismissed) return;

        if(!await quorum.verifyMatchQuorum.call(this, m))
            return;

        // ORDER leg → partial-fill settlement (release the fill, decrement remaining, complete
        // only when fully filled). SWAP leg falls through to the full-release path.
        if(leg.localKind === 'order')
            return await settleLeg.settleOrderLeg.call(this, data, m, coin, leg, probe.localInfo);

        return await settleLeg.settleSwapLeg.call(this, data, m, coin, leg, probe.localInfo);
    }

}

module.exports = Cross_Settle;
