/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
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
 * XChain Indexer - Genesis Mixin: Bridged Token Rows
 *
 * Creates the two rows an XBRIDGE v2 in-leg needs on a destination chain (the
 * root row for the origin chain, and the child row for the bridged asset).
 * Installed onto Genesis.prototype by ../genesis.js, so call sites stay
 * this.injectBridgedToken().
 *
 ********************************************************************/

// Every lock a bridged row carries, fixed at creation. The copy is keyless
// by design, so these are set once at creation and can never be changed afterwards: nobody
// can mint it, rename it, sleep it or attach a callback to it. LOCK_MAX_SUPPLY is NOT in the
// set and must not be added: issue.js refuses a lock with no positive cap, and a bridged row
// is deliberately uncapped.
const BRIDGE_ROW_LOCKS = {
    LOCK_MINT:        '1',
    LOCK_MINT_SUPPLY: '1',
    LOCK_MAX_MINT:    '1',
    LOCK_DESCRIPTION: '1',
    LOCK_SLEEP:       '1',
    LOCK_CALLBACK:    '1'
};

module.exports = {

    /**
     * Create the two rows a bridged token needs on THIS chain, as
     * the bridge protocol defines them, and enforce the
     * existing-row rules. Called by the settle pass on a v5 in-leg, before any
     * credit; the caller logs the single refusal line naming the transfer id.
     *
     * 1. The root row `<ORIGIN>` if absent: owned by this chain's bridge role address for
     *    that origin, uncapped (MAX_SUPPLY omitted, stored 0), DECIMALS 0, every lock set.
     *    LOCK_MAX_SUPPLY is deliberately NOT set: locking with no positive cap is refused
     *    (issue.js), and nothing can mint anyway (mint locked, window at the sentinel, owner
     *    keyless). One per origin chain per destination chain, ever.
     * 2. The child row `<ORIGIN>.<NAME>`: the same owner and locks, DECIMALS from the signed
     *    record, uncapped (a copied cap would go stale on the origin's next MINT). Nothing
     *    else is copied from the origin.
     *
     * EXISTING ROWS. A root owned by anyone but the bridge role address refuses the leg: that
     * is only possible on a chain that squatted the name before the reserved-tick guard
     * landed, and minting under someone else's root would hand them the child's parent gate.
     * The child needs no separate owner check, because a child under a bridge-owned root can
     * only have been created by the bridge (issue.js's parent gate refuses any other source).
     * A child whose DECIMALS already match applies; different decimals with SUPPLY 0
     * re-parameterize the row (the rule issue.js gives every token: decimals move until
     * supply exists); different decimals WITH supply refuse and apply nothing.
     *
     * @param {Object} params - { origin, name, decimals, owner }: the origin chain's coin
     *                          symbol, the origin's native tick (never rooted), the signed
     *                          decimals from the transfer record, and this chain's
     *                          ADDRESS.BRIDGE_<ORIGIN>
     * @param {Object} ctx - { blockIndex, blockTime, txHashPrefix }, as injectProtocolToken
     * @returns {Promise<{ok: boolean, reason: (string|null), tick: string, rootCreated:
     *          boolean, childCreated: boolean, reparameterized: boolean}>} ok false means
     *          apply NOTHING; `reason` is what the caller's single log line names
     */
    async injectBridgedToken(params, ctx){
        ctx = ctx || {};
        let origin = String(params.origin);
        let owner  = params.owner;
        let child  = origin + '.' + String(params.name);

        // Root row.
        let root = await this.ensureBridgeRootRow(origin, owner, ctx);
        if(!root.ok)
            return { ok: false, reason: root.reason, tick: child, rootCreated: false, childCreated: false, reparameterized: false };

        // Child row.
        let kid = await this.ensureBridgeChildRow(child, origin, owner, params.decimals, ctx);
        return {
            ok:              kid.ok,
            reason:          kid.reason,
            tick:            child,
            rootCreated:     root.rootCreated,
            childCreated:    kid.childCreated,
            reparameterized: kid.reparameterized
        };
    },

    // Ensure the bridge ROOT row `<origin>` exists and is bridge-owned, creating it when
    // absent. Returns { ok, reason, rootCreated } - ok false means the caller must return
    // immediately without touching the child row (see injectBridgedToken's EXISTING ROWS
    // comment for why an existing root under a foreign owner refuses the whole leg).
    async ensureBridgeRootRow(origin, owner, ctx){
        let rootInfo = await this.tokenRow(origin);
        if(rootInfo){
            if(String(rootInfo['OWNER']) !== String(owner))
                return {
                    ok:          false,
                    reason:      'root row ' + origin + ' is owned by ' + rootInfo['OWNER'] + ', not the bridge role address ' + owner,
                    rootCreated: false
                };
            return { ok: true, reason: null, rootCreated: false };
        }
        let res = await this.injectProtocolToken({
            tick:           origin,
            owner:          owner,
            maxSupply:      '',             // uncapped sentinel
            decimals:       '0',
            lockMaxSupply:  '',             // see injectBridgedToken's comment: never set
            mintStartBlock: '999999999',
            mintSupply:     '',
            description:    'Bridge root for assets native to ' + origin,
            locks:          BRIDGE_ROW_LOCKS
        }, Object.assign({}, ctx, { txHashFamily: 'BRIDGE' }));
        return { ok: true, reason: null, rootCreated: res.created };
    },

    // Ensure the bridge CHILD row `<origin>.<name>` exists with the signed DECIMALS,
    // creating or re-parameterizing it as injectBridgedToken's EXISTING ROWS comment
    // describes. Returns { ok, reason, childCreated, reparameterized }.
    async ensureBridgeChildRow(child, origin, owner, decimals, ctx){
        let childInfo = await this.tokenRow(child);
        if(!childInfo){
            let res = await this.injectProtocolToken({
                tick:           child,
                owner:          owner,
                maxSupply:      '',             // uncapped sentinel
                decimals:       String(decimals),
                lockMaxSupply:  '',
                mintStartBlock: '999999999',
                mintSupply:     '',
                description:    'Bridged from ' + origin,
                locks:          BRIDGE_ROW_LOCKS
            }, Object.assign({}, ctx, { txHashFamily: 'BRIDGE' }));
            return { ok: true, reason: null, childCreated: res.created, reparameterized: false };
        }

        if(String(childInfo['DECIMALS']) === String(decimals))
            return { ok: true, reason: null, childCreated: false, reparameterized: false };

        let supply = this.util.isNull(childInfo['SUPPLY']) ? '0' : String(childInfo['SUPPLY']);
        if(this.util.bcgt(supply, '0'))
            return {
                ok:              false,
                reason:          'decimals mismatch on ' + child + ': record ' + decimals + ', row ' + childInfo['DECIMALS'] + ', supply ' + supply,
                childCreated:    false,
                reparameterized: false
            };

        // SUPPLY is 0, so the precision still moves. An ISSUE format 0 carrying only the new
        // DECIMALS: every empty field back-fills from the current row, so the owner, locks,
        // description and window are untouched. The new precision is the hash salt, which is
        // what keeps this transaction distinct from the creation (and from a later
        // re-parameterization to a different precision) for the same tick.
        let fields = ['ISSUE', '0', child, '', '', String(decimals)];
        let tx     = this.syntheticIssueTx(fields, child, owner,
            Object.assign({}, ctx, { txHashFamily: 'BRIDGEDEC', txHashSalt: String(decimals) }));
        await this.actions.processTransaction(tx, true); // isGenesis = true
        return { ok: true, reason: null, childCreated: false, reparameterized: true };
    },

};
