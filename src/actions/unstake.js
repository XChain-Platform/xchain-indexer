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
 * XChain Platform Action - UNSTAKE
 *
 * Begins the unstaking cooldown for an active stake.
 *   v0 (capability): BTC-only; unwinds all rows for the pubkey (original + top-ups).
 *   v1 (contract):   any chain; scoped to a single (target, pubkey, tick) triple.
 *
 * FORMATS:
 *   v0 - VERSION|SIGNING_PUBKEY[|AMOUNT]                                    (capability stake, all rows for pubkey)
 *   v1 - VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK[|AMOUNT]         (contract-targeted stake, per (target, tick))
 *
 * The trailing AMOUNT is OPTIONAL (gated by PARTIAL_UNSTAKE_COLLECT):
 * absent = full sweep (the historical behavior, byte-identical); present = move
 * only AMOUNT into cooldown, the residual stays staked via a synthetic re-stake
 * row that activates exactly when the swept rows deactivate. Below the flag-day
 * a present AMOUNT is ignored (a legacy node cannot see it, so ignoring is the
 * only rule the whole fleet agrees on pre-activation).
 *
 ********************************************************************/

class Unstake {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|SIGNING_PUBKEY|AMOUNT';                                   // capability unstake (AMOUNT optional)
        this.formats[1] = 'VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK|AMOUNT';        // contract-targeted unstake (AMOUNT optional)
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // v1 = contract-targeted unstake; dispatch to its own handler
        if(!error && format === 1){
            return await this._parseContractUnstake(params, data, error);
        }

        data['SIGNING_PUBKEY'] = params[1];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';

        // Verify SIGNING_PUBKEY is 64 hex characters (Ed25519)
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';

        let totalAmount = '0';
        if(!error){
            // undeactivatedOnly: an UNSTAKE may only target stake that is not already
            // being unstaked. A second UNSTAKE inside the activation-delay window would
            // otherwise re-read the same still-"active" rows and write a duplicate
            // cooldown credit.
            let aggregate = await this.indexerDb.getActiveStakeByPubkey(data['SIGNING_PUBKEY'], data['BLOCK_INDEX'], {undeactivatedOnly: true});
            if(!aggregate){
                error = 'invalid: SIGNING_PUBKEY (no active stake or unstake already in progress)';
            } else {
                let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
                if(sourceId === null || Number(sourceId) !== Number(aggregate.source_id))
                    error = 'invalid: SOURCE (does not own this stake)';
                else
                    totalAmount = aggregate.amount;
            }
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Optional partial AMOUNT, gated by PARTIAL_UNSTAKE_COLLECT. A present-but-full
        // AMOUNT falls through with requestedAmount null so the
        // resulting state is byte-identical to the absent-amount form. Over-ask and
        // malformed amounts REJECT (never clamp). Below the flag-day the field is
        // never read, preserving the legacy ignore-extra-params behavior exactly.
        let requestedAmount = null;
        if(!error && params.length > 2 && await this.actions.protocolChanges.isEnabled('PARTIAL_UNSTAKE_COLLECT', data['BLOCK_INDEX'])){
            let amountStr = String(params[2]);
            if(!/^[0-9]+(\.[0-9]{1,8})?$/.test(amountStr))
                error = 'invalid: AMOUNT (format)';
            else if(!this.util.bcgt(amountStr, '0'))
                error = 'invalid: AMOUNT (must be greater than 0)';
            else if(this.util.bcgt(amountStr, totalAmount))
                error = 'invalid: AMOUNT (exceeds active stake)';
            else if(this.util.bclt(amountStr, totalAmount))
                requestedAmount = this.util.bcformat(amountStr, 8);
        }

        let staking         = this.config['STAKING'];
        let cooldownBlocks  = (staking && staking['COOLDOWN_BLOCKS'])         ? staking['COOLDOWN_BLOCKS']         : 1000;
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        data['COOLDOWN_END_BLOCK'] = parseInt(data['BLOCK_INDEX']) + cooldownBlocks;
        data['AMOUNT']             = (requestedAmount !== null) ? requestedAmount : totalAmount;

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t UNSTAKE : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0, 16) + '... : amount=' + data['AMOUNT'] + ' : ' + data['STATUS']);

        await this.indexerDb.createUnstake(data);

        // Mark all active stake rows for this pubkey with deactivation_block
        // (validator continues to participate for ACTIVATION_DELAY_BLOCKS blocks before being removed from active set)
        if(status === 'valid')
            await this.indexerDb.setStakeDeactivationByPubkey(
                data['SIGNING_PUBKEY'],
                parseInt(data['BLOCK_INDEX']) + activationDelay,
                parseInt(data['BLOCK_INDEX'])
            );

        // Partial unstake: re-stake the residual as a synthetic top-up row keyed by this
        // UNSTAKE's own action_index (unique in `stakes`; deleted with this block on
        // rollback, exactly like a real STAKE row). Its activation_block is the SAME
        // block the swept rows deactivate at, and active-set reads gate on
        // (activation_block <= blk AND deactivation_block > blk), so the residual takes
        // over the instant the old rows drop out: stake weight is continuous, with no
        // double-count window and no gap. During the handoff window a second UNSTAKE on
        // this pubkey rejects (the residual is still pending activation), matching the
        // existing full-unstake re-unstake guard.
        if(status === 'valid' && requestedAmount !== null){
            let residual = this.util.bcformat(this.util.bcsub(totalAmount, requestedAmount, 8), 8);
            await this.indexerDb.createStake({
                'STATUS':           'valid',
                'SOURCE':           data['SOURCE'],
                'SIGNING_PUBKEY':   data['SIGNING_PUBKEY'],
                'ACTION_INDEX':     data['ACTION_INDEX'],
                'VERSION':          2,
                'AMOUNT':           residual,
                'BLOCK_INDEX':      data['BLOCK_INDEX'],
                'ACTIVATION_BLOCK': parseInt(data['BLOCK_INDEX']) + activationDelay
            });
        }

        let gas = this.config['GAS'];
        this.util.addAddressTicker(data['SOURCE'], gas);

        let credits = [],
            debits  = [];

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }

    // UNSTAKE v1: contract-targeted unstake. Writes to contract_unstakes table,
    // sets deactivation_block on the matching contract_stakes rows, uses the contract's
    // own cooldown_blocks (vs. the global 1000 used for capability staking).
    async _parseContractUnstake(params, data, error){
        data['SIGNING_PUBKEY']        = params[1];
        data['TARGET_CONTRACT_INDEX'] = params[2];
        data['TICK']                  = params[3];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';
        if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
            error = 'invalid: TARGET_CONTRACT_INDEX (required)';
        // Gated by CONTRACT_INDEX_CANONICAL: reject non-canonical leading zeros at/after the flag-day.
        let idxRe = (await this.actions.protocolChanges.isEnabled('CONTRACT_INDEX_CANONICAL', data['BLOCK_INDEX'])) ? /^[1-9]\d*$/ : /^[0-9]+$/;
        if(!error && (!idxRe.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (format)';
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (required)';

        let contractInfo = null;
        if(!error){
            contractInfo = await this.indexerDb.getContract(data['TARGET_CONTRACT_INDEX']);
            if(!contractInfo){
                error = 'invalid: TARGET_CONTRACT_INDEX (unknown)';
            } else if(contractInfo.cooldown_blocks === null || contractInfo.cooldown_blocks === undefined){
                error = 'invalid: TARGET_CONTRACT_INDEX (contract is not stakeable)';
            }
        }

        let totalAmount = '0';
        if(!error){
            let aggregate = await this.indexerDb.getActiveContractStakeByPubkey(
                data['TARGET_CONTRACT_INDEX'], data['SIGNING_PUBKEY'], data['TICK'], data['BLOCK_INDEX'], {undeactivatedOnly: true}
            );
            if(!aggregate){
                error = 'invalid: SIGNING_PUBKEY (no active stake on contract for this tick)';
            } else {
                let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
                if(sourceId === null || Number(sourceId) !== Number(aggregate.source_id))
                    error = 'invalid: SOURCE (does not own this stake)';
                else
                    totalAmount = aggregate.amount;
            }
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Optional partial AMOUNT, gated by PARTIAL_UNSTAKE_COLLECT. Same
        // semantics as the v0 lane; precision is bounded by the staked token's own
        // decimals (mirroring STAKE v3's AMOUNT validation), and a present-but-full
        // amount falls through as a full sweep for byte-identity with the absent form.
        let requestedAmount = null;
        let tickDecimals    = 8;
        if(!error && params.length > 4 && await this.actions.protocolChanges.isEnabled('PARTIAL_UNSTAKE_COLLECT', data['BLOCK_INDEX'])){
            let amountStr = String(params[4]);
            let tickTokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(tickTokenInfo && tickTokenInfo['DECIMALS'] !== undefined && tickTokenInfo['DECIMALS'] !== null)
                tickDecimals = Number(tickTokenInfo['DECIMALS']);
            if(!/^[0-9]+(\.[0-9]+)?$/.test(amountStr)){
                error = 'invalid: AMOUNT (format)';
            } else {
                let parts = amountStr.split('.');
                let fracDigits = parts.length > 1 ? parts[1].replace(/0+$/, '').length : 0;
                if(fracDigits > tickDecimals)
                    error = 'invalid: AMOUNT (exceeds token decimals)';
            }
            if(!error && !this.util.bcgt(amountStr, '0'))
                error = 'invalid: AMOUNT (must be greater than 0)';
            if(!error && this.util.bcgt(amountStr, totalAmount))
                error = 'invalid: AMOUNT (exceeds active stake)';
            if(!error && this.util.bclt(amountStr, totalAmount))
                requestedAmount = this.util.bcformat(amountStr, tickDecimals);
        }

        let staking         = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        data['AMOUNT']             = (requestedAmount !== null) ? requestedAmount : totalAmount;

        // Gated by UNSTAKE_CONTRACT_COOLDOWN_STRICT: the cooldown is the target contract's own
        // validated stake parameter (DEPLOY enforces an integer in [1,100000]). The legacy
        // ternary fell back to the capability global 1000 whenever the contract cooldown_blocks
        // was falsy, a dead branch on the valid path (the checks above already reject a
        // null/non-stakeable cooldown) that nonetheless fired on every error path (unknown
        // target / not-stakeable / no-active-stake), persisting a phantom BLOCK_INDEX+1000
        // cooldown_end_block into the invalid contract_unstakes row (a replicated,
        // state_hash-covered column). At/after the flag-day: reject a non-positive-integer
        // contract cooldown outright and compute COOLDOWN_END_BLOCK only on the valid path,
        // leaving error rows at 0. The valid-path value is unchanged. Below it: byte-identical
        // to the legacy ternary so a from-genesis replay reproduces the historic error-row
        // values.
        if(await this.actions.protocolChanges.isEnabled('UNSTAKE_CONTRACT_COOLDOWN_STRICT', data['BLOCK_INDEX'])){
            if(!error){
                let cb = Number(contractInfo.cooldown_blocks);
                if(!Number.isInteger(cb) || cb < 1)
                    error = 'invalid: TARGET_CONTRACT_INDEX (contract cooldown invalid)';
            }
            data['COOLDOWN_END_BLOCK'] = (!error) ? (parseInt(data['BLOCK_INDEX']) + Number(contractInfo.cooldown_blocks)) : 0;
        } else {
            let cooldownBlocks = (contractInfo && contractInfo.cooldown_blocks) ? Number(contractInfo.cooldown_blocks) : 1000;
            data['COOLDOWN_END_BLOCK'] = parseInt(data['BLOCK_INDEX']) + cooldownBlocks;
        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t UNSTAKE v1 : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0, 16) +
            '... : target=' + data['TARGET_CONTRACT_INDEX'] +
            ' : tick=' + data['TICK'] +
            ' : amount=' + data['AMOUNT'] +
            ' : ' + data['STATUS']);

        await this.indexerDb.createContractUnstake(data);

        // Mark all active contract_stakes rows for (target, pubkey, tick) with deactivation_block
        if(status === 'valid'){
            await this.indexerDb.setContractStakeDeactivationByPubkey(
                data['TARGET_CONTRACT_INDEX'],
                data['SIGNING_PUBKEY'],
                data['TICK'],
                parseInt(data['BLOCK_INDEX']) + activationDelay,
                parseInt(data['BLOCK_INDEX'])
            );

            // Partial unstake: re-stake the residual as a synthetic row keyed by this
            // UNSTAKE's own action_index, activating exactly when the swept rows
            // deactivate (see the v0 lane comment for the continuity/rollback argument).
            if(requestedAmount !== null){
                let residual = this.util.bcformat(this.util.bcsub(totalAmount, requestedAmount, tickDecimals), tickDecimals);
                await this.indexerDb.createContractStake({
                    'STATUS':                'valid',
                    'SOURCE':                data['SOURCE'],
                    'SIGNING_PUBKEY':        data['SIGNING_PUBKEY'],
                    'TARGET_CONTRACT_INDEX': data['TARGET_CONTRACT_INDEX'],
                    'TICK':                  data['TICK'],
                    'ACTION_INDEX':          data['ACTION_INDEX'],
                    'VERSION':               3,
                    'AMOUNT':                residual,
                    'BLOCK_INDEX':           data['BLOCK_INDEX'],
                    'ACTIVATION_BLOCK':      parseInt(data['BLOCK_INDEX']) + activationDelay
                });
            }
        }

        // Tickers/addresses tracking (no credits/debits at unstake time; funds are released by block-end sweep)
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        let credits = [],
            debits  = [];
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Unstake;
