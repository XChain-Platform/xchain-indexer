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
 * XChain Indexer - Utility Class
 * 
 * This file provides utility functions used throughout the indexer
 *
 * The class, its constructor and the rules that read ADDRESS_PARAMS stay in this file; every
 * other method lives in a behaviour part under utility/ and is installed onto the prototype
 * at the foot of this file, so `require('./utility.js')` still hands back the whole class.
 *
 ********************************************************************/

'use strict';

// Load required libraries
const config = require('./config.js');
const crypto = require('crypto');
// The mirror-admission flag day (the time-keyed mirror barrier family), CONSUMER side. Above
// it for (this coin, network) at B a mirrored attest response binds by its signed admission
// height rather than by effective_time <= t(B); below it the predicate is today's, byte for
// byte. The other mirrored selects take the same rule in SQL (db.js, bridge_settle.js).
// Captured HERE, in the entry, and handed to the ATTEST mirror part below: the map freezes
// from the environment at require time, and test/unit/admission_binding.test.js arms it by
// purging this file together with the activation module and re-requiring both. A part required
// on its own would stay cached with the old arm; this capture is re-taken on every re-require.
const { isMirrorAdmissionConsumerActive, isRowReadableAt } = require('./consensus/gates/mirror_admission_gate.js');

// The behaviour parts, installed onto Utility.prototype at the foot of this file.
const generalPart          = require('./utility/general.js');
const valueChecksPart      = require('./utility/value_checks.js');
const actionFormatPart     = require('./utility/action_format.js');
const bcmathPart           = require('./utility/bcmath.js');
const amountValidationPart = require('./utility/amount_validation.js');
const addressCodecPart     = require('./utility/address_codec.js');
const ledgerPart           = require('./utility/ledger.js');
const feesPart             = require('./utility/fees.js');
const oracleFeePart        = require('./utility/oracle_fee.js');
const nativeFeePart        = require('./utility/native_fee.js');
const controllerGuardPart  = require('./utility/controller_guard.js');
const createAttestMirror   = require('./utility/attest_mirror.js');
const votePassesPart       = require('./utility/vote_passes.js');
const blockPassesPart      = require('./utility/block_passes.js');
const crossChainCallsPart  = require('./utility/cross_chain_calls.js');
const dispenserPricesPart  = require('./utility/dispenser_prices.js');

// Address encoding constants and per-coin network parameters
// Base58 version bytes and bech32 HRPs mirror the network definitions used by
// the coin daemons (and the encoder's CryptoNetworks). DOGE has no segwit, so
// no HRP. DOGE/LTC regtest reuse Bitcoin-testnet base58 prefixes by design.
const ADDRESS_PARAMS  = {
    BTC: {
        mainnet: { p2pkh: 0x00, p2sh: 0x05, hrp: 'bc'   },
        testnet: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tb'   },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'bcrt' }
    },
    LTC: {
        mainnet: { p2pkh: 0x30, p2sh: 0x32, hrp: 'ltc'  },
        testnet: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tltc' },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'rltc' }
    },
    DOGE: {
        mainnet: { p2pkh: 0x1e, p2sh: 0x16, hrp: null },
        testnet: { p2pkh: 0x71, p2sh: 0xc4, hrp: null },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: null }
    }
};


class Utility {

    // Handle constructing a class instance
    constructor(cfg){
        // Max market rows the throttled 24h rolling-stats ageing sweep refreshes per block
        // (processMarketUpdates step 2). Bounds per-block refresh cost independent of the total
        // active-market count. markets is unhashed / non-consensus, so this cadence is node-local.
        // (Defined as a static below; referenced as Utility.MARKET_STALE_SWEEP_BATCH.)
        // Track addresses/tickers/transactions across an action parse
        this.addresses = {}; // this.addresses[address] = [tick, tick, tick];
        this.tickers   = [];

        // Reuse the caller's config object when provided so the indexer and its
        // Utility share ONE snapshot. config.getConfig() returns a fresh object
        // every call, so a bare new util() would build a second, independent
        // config; once the hub overlay mutates the indexer's object in place,
        // the two could diverge. Bare construction (CLI tools) still self-loads.
        this.config = cfg || config.getConfig();
    }

    // JSON.stringify with BigInt support. BigInts serialize as decimal strings.
    // JSON.stringify consults BigInt.prototype.toJSON BEFORE the replacer, so a
    // process that also loads a module patching that prototype (xchain-sdk does,
    // emitting raw unquoted digits) would silently change our output, and this
    // feeds getDataHash. Reading the pre-toJSON value via this[key] pins the
    // string form regardless of any global patch.
    jsonStringify(obj){
        return JSON.stringify(obj, function(key, value){
            const raw = this[key];
            return typeof raw === 'bigint' ? raw.toString() : value;
        });
    }

    // Get a SHA256 hash of a given data object
    getDataHash(data){
        let obj  = Object.assign({}, data); // Convert data to object if not already
        let json = this.jsonStringify(obj);
        let hash = crypto.createHash('sha256').update(json).digest('hex');
        return hash;
    }

    /* Price the pre-VM protocol fee for a VM action, in gas units.
     *
     * Single-sources the arithmetic shared by four sites: the three acceptance
     * handlers (deploy.js, deploy_chunk.js, execute.js) and the static quote that sizes
     * the native fee output for them (actions.staticProtocolFee). Kept apart, those four agree by
     * inspection only, so a term added to one and not the others would quote a
     * client an output the handler then refuses, and no check could see it.
     *
     * Returns the schedule value uncoerced, so a schedule missing a key still yields the
     * non-finite result each caller already guards on; the helper never substitutes a
     * default, because a silent 0 here is a free VM action.
     */
    vmGasCost(schedule, family, bytes){
        let s = (schedule && typeof schedule === 'object') ? schedule : {};
        switch(family){
            // Metered gas re-prices only the recorded fee, never this acceptance number.
            case 'EXECUTE':        return s.VM_EXECUTE_BASE;
            case 'DEPLOY_INLINE':  return s.VM_DEPLOY_BASE + (bytes * s.VM_DEPLOY_PER_BYTE);
            // Chunked (v2/v3) charges base only (its v4 carriers already paid per-byte). The
            // trailing + 0 is deploy.js's own per-byte term zeroed, kept literal so the
            // extraction is arithmetic-identical even for a schedule missing a key.
            case 'DEPLOY_CHUNKED': return s.VM_DEPLOY_BASE + 0;
            // The v4 carrier is billed on the slice it puts on-chain, with no base.
            case 'DEPLOY_CARRIER': return bytes * s.VM_DEPLOY_PER_BYTE;
            default:               return null;
        }
    }

    // Re-encode an address from one coin's encoding to another's for the SAME key
    // owner: P2PKH/P2SH share the hash160 across BTC/LTC/DOGE (only the version
    // byte differs), segwit shares the witness program (only the HRP differs).
    // Used by cross-chain royalty legs: leg `to` addresses are expressed in the
    // controlled token's chain encoding and re-encoded to the proceeds chain at
    // settlement. Fail-closed (returns null) on anything not deterministically
    // portable: contract ledger addresses (chain-tagged), the 'BURN' sentinel,
    // malformed or foreign-version base58 payloads, and segwit when the target
    // coin has no bech32 HRP (e.g. DOGE). Pure and deterministic.
    crossChainReencodeAddress(address, fromCoin, toCoin, network){
        if(this.isNull(address))
            return null;
        let str = String(address);
        if(this.isContractAddress(str) || str=='BURN')
            return null;
        let net        = (network) ? network : this.config['NETWORK'];
        let fromParams = (ADDRESS_PARAMS[fromCoin]) ? ADDRESS_PARAMS[fromCoin][net] : false;
        let toParams   = (ADDRESS_PARAMS[toCoin])   ? ADDRESS_PARAMS[toCoin][net]   : false;
        if(!fromParams || !toParams)
            return null;
        // Segwit address: keep version + witness program, swap the HRP
        if(fromParams.hrp && str.toLowerCase().startsWith(fromParams.hrp + '1')){
            let decoded = this.bech32Decode(str);
            if(!decoded || decoded.hrp!=fromParams.hrp || !toParams.hrp)
                return null;
            let encoded = this.bech32Encode(toParams.hrp, decoded.version, decoded.program);
            return (encoded) ? encoded : null;
        }
        // Base58check address: classify by the source coin's version byte, keep the hash160
        let payload = this.base58CheckDecode(str);
        if(!payload || payload.length!=21)
            return null;
        let versionByte = null;
        if(payload[0]==fromParams.p2pkh)
            versionByte = toParams.p2pkh;
        else if(payload[0]==fromParams.p2sh)
            versionByte = toParams.p2sh;
        if(versionByte===null)
            return null;
        let encoded = this.base58CheckEncode(Buffer.concat([Buffer.from([versionByte]), payload.subarray(1)]));
        return (encoded) ? encoded : null;
    }

    // Create-side validation companion: true when the address will re-encode to
    // toCoin at settlement (so a listing can be denied up front instead of ever
    // hitting an unpayable royalty leg on a trade that already delivered).
    canReencodeAddress(address, fromCoin, toCoin, network){
        return this.crossChainReencodeAddress(address, fromCoin, toCoin, network) !== null;
    }

    // Handle validating that an address is a real crypto address on the given
    // COIN + NETWORK (defaults to the configured COIN/NETWORK; pass a coin
    // explicitly for cross-chain destinations like a SWAP GET_ADDRESS).
    // Performs full base58check (version byte + checksum) and bech32/bech32m
    // validation so checksum typos and wrong-network addresses are rejected
    // instead of becoming unspendable destinations.
    isCryptoAddress(address, coin, network){
        if(this.isNull(address))
            return false;
        let coins  = ADDRESS_PARAMS[(coin) ? coin : this.config['COIN']];
        let params = (coins) ? coins[(network) ? network : this.config['NETWORK']] : false;
        if(!params)
            return false;
        let str = String(address);
        // Segwit address (only on coins with a bech32 HRP, e.g. not DOGE)
        if(params.hrp && str.toLowerCase().startsWith(params.hrp + '1')){
            let decoded = this.bech32Decode(str);
            return (decoded && decoded.hrp==params.hrp) ? true : false;
        }
        // Base58check address (P2PKH / P2SH): payload is version byte + hash160
        let payload = this.base58CheckDecode(str);
        if(!payload || payload.length!=21)
            return false;
        return (payload[0]==params.p2pkh || payload[0]==params.p2sh);
    }

    // Finalize unstakes (capability + contract) whose cooldown has elapsed.
    // For each completed row: writes a return credit, updates the source address's
    // balance, and marks the unstake row as 'completed' so the same release doesn't
    // fire twice. The credit's action_index is resolved by completionAttribution
    // below: a fresh synthetic UNSTAKE (format 2) action minted at this cooldown
    // block once UNSTAKE_COOLDOWN_COMPLETION_ACTION is active (so it hashes into the
    // block where it is applied), or the unstake's own action_index before activation
    // (legacy behaviour, preserved so pre-activation history still validates).
    //
    // Skips rows where amount=0 (fully slashed). Operates inside the block transaction
    // so the credit + balance update + status flip are all atomic with the block.
    async processCooldownCompletions(actions, db, block_index){
        let sweep = await db.sweepCompletedCooldowns(block_index);
        if(!sweep || sweep.credits.length === 0) return;
        let addressesToRebalance = new Set();
        let ticksToRebalance     = new Set();
        // Consensus attribution of the return credit (activation-gated). The credit is
        // applied at THIS block (the cooldown-expiry block), but the block-hash query buckets
        // every ledger row by its action's block_index. Before UNSTAKE_COOLDOWN_COMPLETION_ACTION
        // the credit reused the UNSTAKE's own action_index, whose block_index is the earlier
        // UNSTAKE block, so it hashed into the wrong block (its committed ledger_hash predates the
        // credit; a recompute-from-final-state diverges). After activation each return credit is
        // attributed to a fresh synthetic UNSTAKE (format 2) action minted at THIS block, so it
        // hashes where the effect lands and the ledger_hash agrees with balances_root and any
        // recompute. `completionAttribution` resolves, per unstake, the action_index the credit
        // is written under: the new synthetic action when active, the unstake's own when not.
        const completionActive = await actions.protocolChanges.isEnabled('UNSTAKE_COOLDOWN_COMPLETION_ACTION', block_index);
        const completionAttribution = async (unstakeActionIndex) => {
            if(!completionActive) return unstakeActionIndex;
            // Mint a synthetic UNSTAKE v2 completion at the cooldown-expiry block. force=true so a
            // distinct action_index is allocated per matured unstake (no natural tx to key on); its
            // block_index buckets the credit + the action row into this block for both the ledger
            // and actions hashes. Rolls back with the block via the generic action-range delete.
            return await db.createActionIndex({ ACTION: 'UNSTAKE', BLOCK_INDEX: block_index, FORMAT: 2 }, true);
        };
        // Apply credits: each tuple is [tick, amount, sourceAddress].
        // capabilityRows and contractRows preserve action_index order; re-query for tick/amount/address.
        if(sweep.capabilityRows.length > 0 || sweep.contractRows.length > 0){
            // Re-fetch with action_index so each credit gets its own action_index trail
            if(sweep.capabilityRows.length > 0)
                await releaseCapabilityCooldowns(this, db, sweep.capabilityRows, completionAttribution,
                                                 addressesToRebalance, ticksToRebalance);
            if(sweep.contractRows.length > 0)
                await releaseContractCooldowns(this, db, sweep.contractRows, completionAttribution,
                                               addressesToRebalance, ticksToRebalance);
        }
        // Update balances AND token supply for everything the release credits touched, so the
        // per-block sanityCheck (ledger == supply == balances) sees a consistent picture.
        //
        // Both loops now pair their credit with a negative escrow row, so a maturing cooldown
        // is tokens becoming spendable again rather than tokens being created, and supply does
        // not move on either path. The two were briefly asymmetric while only the contract half
        // was fixed; the operator's decision to roll testnet back and reparse forward removed
        // the reason to keep the capability half on the old rules.
        if(addressesToRebalance.size > 0){
            await db.updateBalances(Array.from(addressesToRebalance));
            await db.updateTokens(Array.from(ticksToRebalance));
        }
        // Flip the unstake rows to 'completed' so they won't be swept again
        await db.markCooldownsCompleted(sweep.capabilityRows, sweep.contractRows, sweep.completedId);
    }

    // Handle creating and updating DEX market information.
    //
    // Split into two paths so per-block cost tracks blocks that actually touched a market rather
    // than the total active-market count (a getMarkets(update=true) refresh of EVERY market pair
    // with a valid open order older than 24h would touch effectively all active markets each block):
    //   (1) Touched-this-block refresh: refresh only the pairs traded in THIS block. createMarket
    //       assigns a NEW markets-row id only for a genuinely new pair, which can only appear from an
    //       order/match in this touched set (an aged pair already has its row), so the deterministic
    //       serial id-assignment order is fully preserved.
    //   (2) Throttled 24h rolling-stats ageing sweep: refresh a bounded batch of the most-stale
    //       existing market rows so the 24h window still ages out without recomputing all markets
    //       every block. The `markets` table is unhashed / snapshot-replicated with no consensus
    //       reader (see rollback.js), so a node-local sweep cadence never diverges block state.
    async processMarketUpdates(db, block_index, block_time){
        // (1) Refresh only the pairs touched by an order action in this block (update=false ->
        // WHERE b1.block_index=?), processed serially to pin new-pair id assignment to iteration order.
        let markets = await db.getMarkets(block_index, false);
        for(let pair of markets){
            let market_id = await db.createMarket(pair.tick1_id, pair.tick2_id, pair.coin1_id, pair.coin2_id);
            let data = await db.getMarketInfo(market_id, block_time);
            // Set the last_updated time to the current block time
            data.last_updated = block_time;
            await db.updateMarketInfo(data);
        }

        // (2) Throttled ageing sweep: refresh a bounded batch of markets whose stats last refreshed
        // more than 24h ago (oldest-first). Pairs already refreshed in step 1 carry last_updated =
        // block_time, so they are naturally excluded here. Bounded by MARKET_STALE_SWEEP_BATCH.
        // getBlockTime returns a `false` sentinel when the block row is unresolvable (older-schema
        // decoder DB); markets is non-consensus, so skipping the sweep for that block is safe,
        // while bcsub("false") would throw and wedge block processing.
        if(!Number.isFinite(Number(block_time)) || block_time === false || block_time === null)
            return;
        let time_24hr = this.bcsub(String(block_time), '86400');
        let stale = await db.getStaleMarkets(time_24hr, Utility.MARKET_STALE_SWEEP_BATCH);
        for(let row of stale){
            let data = await db.getMarketInfo(row.id, block_time);
            data.last_updated = block_time;
            await db.updateMarketInfo(data);
        }
    }

}

// The capability half of processCooldownCompletions: credit each matured capability unstake's
// GAS back to its source under the action_index completionAttribution resolves, and record every
// address and tick it touched for the sweep's rebalance. Kept in this file beside the contract
// half, whose release test/unit/stake_escrow_conservation.test.js reads by text.
async function releaseCapabilityCooldowns(util, db, capabilityRows, completionAttribution,
                                          addressesToRebalance, ticksToRebalance){
    let rows = await db.getMaturedUnstakeCreditRows(capabilityRows);
    let gas = db.config['GAS'];
    for(let row of rows){
        if(!util.bcgt(row.amount, '0')) continue;
        let creditIndex = await completionAttribution(row.action_index);
        await db.createCredit(creditIndex, gas, String(row.amount), row.source_address);
        // Release the bond the stake locked, rather than minting it back. Same
        // shape as the contract release below.
        await db.createEscrow(creditIndex, gas,
                              util.bcsub(0, row.amount, 64), row.source_address);
        addressesToRebalance.add(row.source_address);
        ticksToRebalance.add(gas);
    }
}

// The contract half of processCooldownCompletions: the same credit and release for each matured
// contract unstake, in the token the stake locked.
async function releaseContractCooldowns(util, db, contractRows, completionAttribution,
                                        addressesToRebalance, ticksToRebalance){
    let rows = await db.getMaturedContractUnstakeCreditRows(contractRows);
    for(let row of rows){
        if(!util.bcgt(row.amount, '0')) continue;
        let creditIndex = await completionAttribution(row.action_index);
        await db.createCredit(creditIndex, row.tick, String(row.amount), row.source_address);
        // RELEASE the escrow the stake locked, rather than minting the tokens back.
        // The negative escrow row offsets the credit, so the pair is net-zero on
        // `ledger = credits - debits + escrows` and supply is unchanged - which is
        // the whole point: a cooldown maturing is tokens becoming spendable again,
        // not tokens being created. Mirrors order.js:499's release idiom.
        await db.createEscrow(creditIndex, row.tick,
                              util.bcsub(0, row.amount, 64), row.source_address);
        addressesToRebalance.add(row.source_address);
        ticksToRebalance.add(row.tick);
    }
}

// Install the behaviour parts from utility/ NON-ENUMERABLE, the shape the class body they came
// from produced: call sites reach them as this.<method> or util.<method>, suites can stub them
// through Utility.prototype, and for-in over an instance stays empty. Same install as coinpay.js
// and db/index.js use for their parts. The ATTEST mirror part is built from the mirror-admission
// capture above, so every load of this file binds its own.
const attestMirrorPart = createAttestMirror({ isMirrorAdmissionConsumerActive, isRowReadableAt });
for(const part of [generalPart, valueChecksPart, actionFormatPart, bcmathPart, amountValidationPart,
                   addressCodecPart, ledgerPart, feesPart, oracleFeePart, nativeFeePart,
                   controllerGuardPart, attestMirrorPart, votePassesPart, blockPassesPart,
                   crossChainCallsPart, dispenserPricesPart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Utility.prototype, descriptors);
}

Utility.MARKET_STALE_SWEEP_BATCH = 25;

module.exports = Utility;