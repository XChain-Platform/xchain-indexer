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
 * XChain Indexer - ATTEST relay fee carve helpers
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const attestBcastFee = require('../gates/attest_broadcast_fee_gate.js');
const gateRegistry = require('../../../consensus/gate_registry');
const srb = require('../../../consensus/snapshot_reorg_buffer.js');
const { rethrowIfInfraFault } = require('../../../consensus/fault_guard.js');
const { maxPriceAgeSecondsAt } = require('../../../utility/price_age/oracle_price_age.js');
const { HOME_CHAIN } = require('../constants.js');

const RELAY_FEE_KEY = 'attest_relay_fee_activation.ATTEST_RELAY_FEE_ACTIVATION';

async function relayFeeLegAllowance(handler, coin, data, capNative, feeCap){
    let maxAge = maxPriceAgeSecondsAt(
        handler.config, handler.config['NETWORK'], coin, data['BLOCK_INDEX']);
    let prices;
    try {
        prices = await handler.util.getFeeOraclePrices(
            handler.indexerDb, coin, data['BLOCK_INDEX'], data['BLOCK_TIME'], maxAge);
    } catch(e){
        rethrowIfInfraFault(e);
        return '0';
    }
    if(!prices || prices.error) return '0';
    return String(handler.util.bcmuldivfloor(
        capNative, prices.coinUsdPrice, prices.xchainUsdPrice, feeCap));
}

module.exports = {
    // Pick one verified v4 signer without trusting transaction authorship. This is
    // the same request-bound hash order used by the attestation responsible set.
    relayFeePayee(requestId, validSigners){
        let seen = new Set();
        let ranked = [];
        for(let signer of (validSigners || [])){
            if(signer === null || signer === undefined) continue;
            let pubkey = String(signer).toLowerCase();
            if(pubkey === '') continue;
            if(seen.has(pubkey)) continue;
            seen.add(pubkey);
            ranked.push({
                pubkey,
                hash: crypto.createHash('sha256')
                    .update(String(requestId), 'utf8').update(pubkey, 'utf8').digest('hex')
            });
        }
        ranked.sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1
            : (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
        return ranked.length > 0 ? ranked[0].pubkey : null;
    },

    // Resolve the selected signer's staking source from the same buried snapshot
    // used for relay quorum, then express that BTC address on the origin chain.
    async relayFeePayoutAddress(payeePubkey, snapshotBlock){
        if(payeePubkey === null || payeePubkey === undefined) return null;
        let resolvedBlock = srb.buriedSnapshotBlock(snapshotBlock, this.config['NETWORK']);
        let rows = await this.indexerDb.getCapabilitySnapshotWeights('cross_chain', resolvedBlock);
        if(!Array.isArray(rows) || rows.truncated) return null;
        let wanted = String(payeePubkey).toLowerCase();
        let match = rows.find(row => row && String(row.pubkey).toLowerCase() === wanted);
        if(!match || match.source === null || match.source === undefined) return null;
        return this.util.crossChainReencodeAddress(
            String(match.source), HOME_CHAIN, this.config['COIN'], this.config['NETWORK']);
    },

    // Price one flat native allowance for each relay broadcast leg. Either oracle
    // leg may independently resolve to zero; the combined carve never exceeds escrow.
    async relayFeeAllowance(request, data, feeAmount, feeCap){
        let rawSnapshot = data && data['SNAPSHOT_BLOCK'];
        if(rawSnapshot === null || rawSnapshot === undefined || rawSnapshot === '' ||
           typeof rawSnapshot === 'boolean') return '0';
        let snapshotBlock = Number(rawSnapshot);
        if(!Number.isFinite(snapshotBlock) ||
           !gateRegistry.activeAt(RELAY_FEE_KEY, this.config['NETWORK'], null, snapshotBlock, null))
            return '0';
        if(!this.util.bcgt(feeAmount, '0')) return '0';

        let providerId = String((request && request.provider_id) || '');
        let capNative = attestBcastFee.broadcastFeeCapNative(
            providerId, this.providerRegistry.getProvider(providerId));
        if(!this.util.bcgt(capNative, '0')) return '0';

        let home = await relayFeeLegAllowance(this, HOME_CHAIN, data, capNative, feeCap);
        let origin = await relayFeeLegAllowance(
            this, this.config['COIN'], data, capNative, feeCap);
        let allowance = String(this.util.bcadd(home, origin, feeCap));
        if(this.util.bcgt(allowance, feeAmount))
            allowance = String(this.util.bcmulfloor(feeAmount, '1', feeCap));
        return allowance;
    }
};
