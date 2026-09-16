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
 * ISSUE supply rules: MAX_SUPPLY and DECIMALS bounds, the LOCK_MAX_SUPPLY cap guard,
 * the TRANSFER and TRANSFER_SUPPLY addresses, and the MINT_SUPPLY and MINT_ADDRESS_MAX
 * caps, including the uncapped-token exemption.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls each as
 * fn.call(this, ctx)) and reads and writes the shared context.
 *
 ********************************************************************/

'use strict';

// MAX_SUPPLY bounds and floor, the LOCK_MAX_SUPPLY cap guard, and the DECIMALS bounds
// and lock-after-supply rule.
async function validateSupplyFields(ctx){
    let { data, tokenInfo } = ctx;
    let error = ctx.error;

    // Verify MAX_SUPPLY min/max
    if(!error && !this.util.isNull(data['MAX_SUPPLY']) && this.util.bcgt(data['MAX_SUPPLY'], 0) && (this.util.bclt(data['MAX_SUPPLY'], this.config.MIN_TOKEN_SUPPLY) || this.util.bcgt(data['MAX_SUPPLY'], this.config.MAX_TOKEN_SUPPLY)))
        error = 'invalid: MAX_SUPPLY (min/max)';

    // Verify MAX_SUPPLY is not set below current SUPPLY
    if(!error && !this.util.isNull(data['MAX_SUPPLY']) && this.util.bcgt(data['MAX_SUPPLY'], 0) && this.util.bclt(data['MAX_SUPPLY'], await this.indexerDb.getTokenSupply(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'])))
        error = 'invalid: MAX_SUPPLY < SUPPLY';

    // Verify a MAX_SUPPLY cap is declared before allowing LOCK_MAX_SUPPLY. The cap is taken from
    // this action when present, else the existing token record. Minted supply is NOT
    // required (a fair-mint token locks its cap at issuance, before any supply exists);
    // locking with no declared cap would permanently brick the TICK at a cap of zero.
    //
    // Gate: LOCK_MAX_SUPPLY_EXACT changes the guard from a truthy check to a strict ==1
    // check, fixing a false-positive where an explicit LOCK_MAX_SUPPLY=0 field (a no-op
    // lock intent) triggered the cap validation and produced an invalid outcome. The change
    // is gated so that a heterogeneous fleet and any from-genesis replay all switch over at
    // the same coordinated block, avoiding a ledger fork on any block carrying an explicit
    // LOCK_MAX_SUPPLY=0 field. Pre-launch chains activate at genesis (all zeros), so the
    // strict check is in force from block 0.
    let lockMaxSupplyExact = await this.actions.protocolChanges.isEnabled('LOCK_MAX_SUPPLY_EXACT', data['BLOCK_INDEX']);
    let lockMaxSupplySet   = lockMaxSupplyExact ? (data['LOCK_MAX_SUPPLY']==1) : data['LOCK_MAX_SUPPLY'];
    if(!error && lockMaxSupplySet){
        let lockCap = (!this.util.isNull(data['MAX_SUPPLY'])) ? data['MAX_SUPPLY'] : ((tokenInfo) ? tokenInfo['MAX_SUPPLY'] : null);
        if(this.util.isNull(lockCap) || this.util.bclt(lockCap, this.config.MIN_TOKEN_SUPPLY))
            error = 'invalid: LOCK_MAX_SUPPLY (no max supply)';
    }

    // Verify DECIMAL min/max
    if(!error && !this.util.isNull(data['DECIMALS']) && (this.util.bclt(data['DECIMALS'], this.config.MIN_TOKEN_DECIMALS) || this.util.bcgt(data['DECIMALS'], this.config.MAX_TOKEN_DECIMALS)))
        error = 'invalid: DECIMALS (min/max)';

    // Verify DECIMALS cannot be changed after supply has been issued
    if(!error && !this.util.isNull(data['DECIMALS']) && tokenInfo && this.util.bcgt(tokenInfo['SUPPLY'], 0) && String(data['DECIMALS'])!=String(tokenInfo['DECIMALS']))
        error = 'invalid: DECIMALS (locked)';

    ctx.error = error;
}

// The TRANSFER and TRANSFER_SUPPLY address formats, and the MINT_SUPPLY lock.
function validateTransferFields(ctx){
    let { data, tokenInfo } = ctx;
    let error = ctx.error;

    // Verify TRANSFER addresses. Genesis bootstrap is exempt: it seeds Counterparty/
    // Dogeparty owner addresses that are mainnet-format and so fail isCryptoAddress on a
    // regtest network. The manifest is trusted (hash-pinned), so the format check is skipped.
    if(!error && !this.util.isNull(data['TRANSFER']) && !data['IS_GENESIS'] && !this.util.isCryptoAddress(data['TRANSFER']))
        error = 'invalid: TRANSFER (bad address)';

    // Verify TRANSFER_SUPPLY and SOURCE are different
    if(data['TRANSFER_SUPPLY'] == data['SOURCE'])
        delete data['TRANSFER_SUPPLY'];

    // Verify TRANSFER_SUPPLY addresses. Genesis bootstrap is exempt for the same reason
    // as TRANSFER above: the airdrop pass (genesis.js) credits XCP/XDP snapshot holders
    // whose addresses are source-chain mainnet format, and the snapshots are hash-pinned.
    if(!error && !this.util.isNull(data['TRANSFER_SUPPLY']) && !data['IS_GENESIS'] && !this.util.isCryptoAddress(data['TRANSFER_SUPPLY']))
        error = 'invalid: TRANSFER_SUPPLY (bad address)';

    // Verify MINT_SUPPLY is allowed and LOCK_MINT_SUPPLY is not set
    if(!error && !this.util.isNull(data['MINT_SUPPLY']) && tokenInfo && tokenInfo['LOCK_MINT_SUPPLY']==1)
        error = 'invalid: MINT_SUPPLY (locked)';

    ctx.error = error;
}

// MINT_SUPPLY and MINT_ADDRESS_MAX against MAX_SUPPLY (skipped on an uncapped token),
// the cumulative MINT_SUPPLY cap, and MINT_ADDRESS_MAX against MAX_MINT.
async function validateMintSupplyCaps(ctx){
    let { data } = ctx;
    let error = ctx.error;

    // Resolve the uncapped-supply exemption ONCE for the three cross-checks below that
    // compare another field against MAX_SUPPLY. MAX_SUPPLY is stored as 0 when the ISSUE
    // omits it (createToken / db.js) and 0 is the documented UNCAPPED sentinel, so on such
    // a token there is no ceiling for MINT_SUPPLY or MINT_ADDRESS_MAX to exceed, and the
    // comparisons would otherwise reject an uncapped token's own genesis parameters.
    // At/after the UNCAPPED_MAX_SUPPLY_ZERO flag-day the checks are skipped when no
    // positive cap is declared (matching the bcgt(MAX_SUPPLY,0) guards above and mint.js's
    // ceiling); below it every verdict is unchanged, so a from-genesis replay stays
    // byte-identical. Resolved once, not per check, since the gate must not differ between
    // comparisons inside one action, and only on the still-valid path, so a rejected action
    // never spends a decoder-DB read it cannot use. LOCK_MAX_SUPPLY is deliberately not
    // covered: locking a cap that does not exist is still refused by the unchanged guard
    // above.
    let uncappedSupply = !error && !this.util.bcgt(data['MAX_SUPPLY'], 0) &&
        await this.actions.protocolChanges.isEnabled('UNCAPPED_MAX_SUPPLY_ZERO', data['BLOCK_INDEX']);

    // Verify MINT_SUPPLY is less than MAX_SUPPLY
    if(!error && !uncappedSupply && !this.util.isNull(data['MINT_SUPPLY']) && this.util.bcgt(data['MINT_SUPPLY'], data['MAX_SUPPLY']))
        error = 'invalid: MINT_SUPPLY > MAX_SUPPLY';

    // Cumulative MINT_SUPPLY cap: MINT_SUPPLY mints fresh supply on EVERY valid ISSUE (line
    // ~640 credits it unconditionally), so on a re-ISSUE it stacks on top of the supply that
    // already exists. The single-shot MINT_SUPPLY>MAX_SUPPLY guard above ignores that, letting
    // an owner re-ISSUE MINT_SUPPLY repeatedly (LOCK_MINT_SUPPLY unset) and inflate past
    // MAX_SUPPLY - and past a locked NFT edition size, since LOCK_MAX_SUPPLY only freezes the
    // cap, not minting. Enforce the cap against SUPPLY + MINT_SUPPLY, mirroring mint.js's
    // cumulative invariant. getTokenSupply reflects earlier same-block mints/issues; this
    // action's own MINT_SUPPLY is credited later, so it is not yet counted. Gated (tightens
    // validity): flips fleet-wide at one coordinated block; pre-launch chains activate at
    // genesis. The cumulative cap is likewise inapplicable to an uncapped token, for the
    // same reason as the checks above.
    if(!error && !uncappedSupply && !this.util.isNull(data['MINT_SUPPLY']) && this.util.bcgt(data['MINT_SUPPLY'], 0)
       && await this.actions.protocolChanges.isEnabled('ISSUE_MINT_SUPPLY_CUMULATIVE_CAP', data['BLOCK_INDEX'])){
        let currentSupply = await this.indexerDb.getTokenSupply(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let projected     = this.util.bcadd(currentSupply, data['MINT_SUPPLY'], data['DECIMALS']);
        if(this.util.bcgt(projected, this.util.bcadd(data['MAX_SUPPLY'], 0, data['DECIMALS'])))
            error = 'invalid: MINT_SUPPLY exceeds MAX_SUPPLY';
    }

    // Verify MINT_ADDRESS_MAX is less than MAX_SUPPLY (skipped on an uncapped token, see uncappedSupply above)
    if(!error && !uncappedSupply && !this.util.isNull(data['MINT_ADDRESS_MAX']) && this.util.bcgt(data['MINT_ADDRESS_MAX'], 0) && this.util.bcgt(data['MINT_ADDRESS_MAX'], data['MAX_SUPPLY']))
        error = 'invalid: MINT_ADDRESS_MAX > MAX_SUPPLY';

    // Verify MINT_ADDRESS_MAX is greater than than MAX_MINT
    if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && this.util.bcgt(data['MINT_ADDRESS_MAX'], 0) && this.util.bclt(data['MINT_ADDRESS_MAX'], data['MAX_MINT']))
        error = 'invalid: MINT_ADDRESS_MAX < MAX_MINT';

    ctx.error = error;
}

module.exports = { validateSupplyFields, validateTransferFields, validateMintSupplyCaps };
