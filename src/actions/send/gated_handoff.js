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
 * XChain Platform Action - SEND: gated handoff
 *
 * The gated-content rule: when a leg must travel with a key handoff
 * MESSAGE, and whether the action carries one.
 *
 ********************************************************************/

const gatedHandoffRef = require('../../gated_handoff_ref_activation.js');

// Installed onto Send.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Gated-content rule: if TICK has any active gated FILEs, this
    // SEND must be inside the same tx as a MESSAGE v2 addressed to
    // DESTINATION carrying the key handoff payload. The indexer only
    // checks structural presence; the wallet verifies cryptographic
    // correctness at unlock time.
    // See xchain-documentation/protocol/token-gated-content.md.
    async checkGatedHandoff(send, tokenInfo, data, ctx, error){
        if(!error){
            let packs = ctx.gatedPacks[send['TICK']] || [];
            if(packs.length > 0 && this.gatedHandoffRequired(packs, send, tokenInfo, ctx)){
                if(!(await this.findGatedHandoff(send, data)))
                    error = 'invalid: gated token transfer requires key handoff message';
            }
        }
        return error;
    },

    // Gated-file handoff rule: the handoff is CONDITIONAL. A gated FILE on a tick does
    // NOT make every send of it require a handoff; a pack only compels
    // one when the recipient will actually end up able to unlock it, judged on
    // POST-SEND balance (pre-send balance + everything this action sends them),
    // since a recipient who already holds enough crosses the threshold on any
    // transfer and one who holds nothing may not cross it even on a large one.
    // The "everything this action sends them" half is already exact here, and it
    // is worth saying why because it looks like a gap: legs were CONSOLIDATED by
    // (DESTINATION, TICK) further up, so send['AMOUNT'] is the TOTAL for this
    // pair, not one leg. That consolidation is what closes the
    // split-120-into-two-60s bypass; it is structural rather than something this
    // block re-derives, and a test vector pins it so a future de-consolidation
    // cannot silently reopen it. Self-send is deliberately NOT special-cased:
    // the rule applies literally, the resulting overcount is accepted for
    // determinism, and a sender's self-addressed MESSAGE satisfies the requirement.
    gatedHandoffRequired(packs, send, tokenInfo, ctx){
        let destBal = ctx.destBalances[send['DESTINATION']] || {};
        let held    = destBal[tokenInfo['TICK_ID']];
        if(this.util.isNull(held)) held = '0';
        let postSend = this.util.bcadd(held, send['AMOUNT'], 18);

        // Rule 4: a pack is REQUIRED when it is unconditional (no
        // threshold at all) or the post-send balance reaches its
        // threshold. Rule 5: the MESSAGE is required iff ANY pack is.
        let required = false;
        for(let pack of packs){
            if(pack.threshold === null){ required = true; break; }
            if(!this.util.bclt(postSend, pack.threshold)){ required = true; break; }
        }
        return required;
    },

    // Whether a MESSAGE v2 sibling of this action is addressed to the leg's DESTINATION, which
    // is the structural presence the gated-content rule asks for
    async findGatedHandoff(send, data){
        let siblings = data['SIBLING_ACTIONS'] || [];
        let foundHandoff = false;

        // Siblings hold WIRE parameters (batch.js splits the raw command and
        // resolves no address references), while the SDK compacts a MESSAGE
        // DESTINATION to `^<id>` for any already-indexed recipient, so a byte
        // compare misses the ordinary wallet-composed handoff. Above the flag
        // day a caret spelling is resolved first; plane and arming state in
        // gated_handoff_ref_activation.js.
        let refRule = gatedHandoffRef.isGatedHandoffRefActive(data['BLOCK_TIME'], this.config['NETWORK']);

        for(let s of siblings){
            if(s.action !== 'MESSAGE') continue;
            // MESSAGE v2 fields: VERSION|COIN|DESTINATION|ENCRYPTED_MESSAGE
            // (s.params[0]=VERSION, [1]=COIN, [2]=DESTINATION, [3]=ENCRYPTED_MESSAGE)
            let ver  = String(s.params[0] || '');
            let dest = String(s.params[2] || '');
            if(ver !== '2') continue;

            // Caret-only, so a full-address handoff costs no extra read, and
            // fail-closed on both edges: a rejected reference and a value still
            // caret-prefixed after resolution match nothing.
            if(refRule && dest.substring(0,1) === '^'){
                let destRef = await this.indexerDb.resolveAddressRefChecked(dest, data['BLOCK_INDEX']);
                if(destRef.rejected) continue;
                dest = String(destRef.value || '');
                if(dest.substring(0,1) === '^') continue;
            }

            if(dest === send['DESTINATION']){
                foundHandoff = true;
                break;
            }
        }
        return foundHandoff;
    }
};
