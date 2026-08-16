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
 * XChain Platform Action - AIRDROP
 * 
 * This action airdrops `TICK` supply to one or more lists.
 * 
 * PARAMS:
 * - VERSION           - Format Version
 * - TICK              - Ticker name or Ticker ID
 * - AMOUNT            - Amount of tokens to airdrop
 * - LIST_ACTION_INDEX - `ACTION_INDEX` of a `LIST`
 * - MEMO              - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Single Airdrop
 * - 1 = Multi-Airdrop (Brief)
 * - 2 = Multi-Airdrop (Full)
 * - 3 = Multi-Airdrop (Full) with Multiple Memos
 * 
 ********************************************************************/

class Airdrop {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';
        this.formats[1] = 'VERSION|LIST_ACTION_INDEX|TICK|AMOUNT|TICK|AMOUNT|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';
        this.formats[3] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';

        // 1=Tick list, 2=Address list.
        this.listTypes = [1,2];
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // [TICK, AMOUNT, LIST, MEMO] per airdrop leg.
        let airdrops = [];

        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==4) || (format==1 && idx%2==0) || (format==2 && idx%3==1)))
                memo = params[idx];

        let lastIdx = params.length - 1;
        for(let idx in params){
            idx = parseInt(idx); // for-in yields string keys; the modulo checks below need integers

            // Format 0: Single Airdrop
            if(format==0 && idx==0)
                airdrops.push([params[1], params[2], params[3], memo]);

            // Format 1: Multi-Airdrop (Brief)
            if(format==1 && idx>1 && idx%2==1)
                airdrops.push([params[idx-1], params[idx], params[1], memo]);

            // Format 2: Multi-Airdrop (Full)
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                airdrops.push([params[idx], params[(idx+1)], params[idx+2], memo]);

            // Format 3: Multi-Airdrop (Full) with Multiple Memos
            if(format==3 && idx>0 && idx%4==1 && idx < lastIdx)
                airdrops.push([params[idx], params[idx+1], params[idx+2], params[idx+3]]);
        }

        // Fetch token info for each distinct TICK once, up front, instead of per airdrop leg.
        let ticks = {};
        for(let airdrop of airdrops){
            let tick = airdrop[0];
            if(ticks[tick] === undefined)
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Load gas token info once before the loop: a controller-bound TICK's guard bills SOURCE
        // metered gas in GAS, reserved against `balances` so a denied/cheap guard can't drive GAS negative.
        let gasTick = this.config['GAS'];
        let gasInfo = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        let origError = error;
        let credits = [],
            debits  = [];

        for(let idx in airdrops){
            let info = airdrops[idx];
            error = origError; // each leg validates independently against the original error state

            let airdrop = data;

            // Guard gas fee billed to SOURCE for this leg (0 = uncontrolled token)
            let guardFee = 0;

            // Set, not array: membership is tested once per holder and a list can carry thousands
            // of addresses, so an array made dedup O(n^2) on the synchronous per-block path. Set
            // over a plain object because insertion order is guaranteed, keeping the credit order
            // below deterministic for consensus.
            let recipients = new Set();

            let type = false,
                list = null;

            airdrop['TICK']              = info[0];
            airdrop['AMOUNT']            = info[1];
            airdrop['LIST_ACTION_INDEX'] = info[2];
            airdrop['MEMO']              = info[3];

            let tokenInfo = ticks[airdrop['TICK']];

            // Convert NUMBER fields from string to number so comparisons below are mathematical, not lexical.
            if(!error)
                data = this.util.setNumberFormats(data);

            if(!error && !tokenInfo)
                error = 'invalid: TICK (unknown)';

            if(!error && !this.util.isNull(airdrop['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], airdrop['AMOUNT']))
                error = "invalid: AMOUNT (format)";

            if(!error && !this.util.isNull(airdrop['LIST_ACTION_INDEX']) && !this.util.isNumeric(airdrop['LIST_ACTION_INDEX']))
                error = "invalid: LIST_ACTION_INDEX (format)";

            if(!error && await this.indexerDb.isActionAllowed(airdrop['SOURCE'], null, airdrop['BLOCK_INDEX']) == false)
                error = 'invalid: SOURCE (sleeping)';

            if(!error && await this.indexerDb.isActionAllowed(null, airdrop['TICK'], airdrop['BLOCK_INDEX']) == false)
                error = 'invalid: TICK (sleeping)';

            // Verify no pipe in MEMO (pipe is field delimiter)
            if(!error && String(airdrop['MEMO']).indexOf('|')!=-1)
                error = 'invalid: MEMO (pipe)';

            // Verify no semicolon in MEMO (semicolon is action delimiter)
            if(!error && String(airdrop['MEMO']).indexOf(';')!=-1)
                error = 'invalid: MEMO (semicolon)';

            if(!error && String(airdrop['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
                error = 'invalid: MEMO (length)';

            if(!error){
                type = await this.indexerDb.getListType(airdrop['LIST_ACTION_INDEX']);
                list = await this.indexerDb.getList(airdrop['LIST_ACTION_INDEX'], data['BLOCK_INDEX']);
            }

            if(!error && type===false)
                error = 'invalid: LIST (unknown)';

            if(!error && !this.listTypes.includes(type))
                error = 'invalid: LIST TYPE (unsupported)';

            // TICK LIST: expand to all current holders of each listed tick.
            if(!error && this.listTypes.indexOf(type)!=-1){
                let holders = {};
                for(let tick of list){
                    if(type==1)
                        holders = await this.indexerDb.getHolders(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                    for(let address in holders)
                        recipients.add(address);   // Set.add is already idempotent, so no membership test
                }
            }

            // ADDRESS LIST: recipients are exactly the listed addresses.
            if(!error && type==2)
                recipients = new Set(list);

            if(!error && await this.indexerDb.isActionAllowed(airdrop['SOURCE'], airdrop['TICK']) == false)
                error = 'invalid: SOURCE (not authorized)';

            if(!error && await this.util.hasBalance(balances, tokenInfo['TICK_ID'], airdrop['AMOUNT']) == false)
                error = 'invalid: insufficient funds';

            // Fetch TICK's allow/block lists ONCE before the recipient loop, then check membership in
            // memory via Sets (matching isActionAllowed's no-block_index behavior) so each recipient
            // costs an O(1) hash probe instead of an O(n) scan, previously O(recipients x list).
            // Determinism rides on `recipients` iteration order, which Sets preserve; an empty list
            // stays truthy as a Set exactly as it was as an array, so an empty ALLOW_LIST still
            // approves nobody.
            let approved = new Set();
            let hasAllowList = tokenInfo && !this.util.isNull(tokenInfo['ALLOW_LIST']) && this.util.isNumeric(tokenInfo['ALLOW_LIST']);
            let hasBlockList = tokenInfo && !this.util.isNull(tokenInfo['BLOCK_LIST']) && this.util.isNumeric(tokenInfo['BLOCK_LIST']);
            let recipientAllowList = hasAllowList ? new Set(await this.indexerDb.getList(tokenInfo['ALLOW_LIST'], data['BLOCK_INDEX'])) : null;
            let recipientBlockList = hasBlockList ? new Set(await this.indexerDb.getList(tokenInfo['BLOCK_LIST'], data['BLOCK_INDEX'])) : null;

            for(let address of recipients){
                if(approved.has(address))
                    continue;
                let allowed = true;
                if(allowed && recipientAllowList && !recipientAllowList.has(address))
                    allowed = false;
                if(allowed && recipientBlockList && recipientBlockList.has(address))
                    allowed = false;
                if(allowed)
                    approved.add(address);
            }
            recipients = approved;

            airdrop['DEBIT'] = (!error) ? this.util.bcmul(recipients.size, airdrop['AMOUNT'], tokenInfo['DECIMALS']) : 0;

            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                // Unified gas schedule: per-recipient gas
                let result = this.util.getUnifiedTransactionFee(recipients.size, 'AIRDROP_PER_RECIPIENT');
                fees['GAS_COST']    = result.gasCost;
                fees['AMOUNT']      = result.fee;
                fees['FEE_VERSION'] = 2;
            } else {
                // Legacy: database hits model
                let db_hits  = recipients.size * 2;
                    db_hits += 3;
                fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
            }
            // Emitted (VM-synthesized) actions pay no separate per-tx fee; see util.feeForAction.
            // The airdrop DEBIT to recipients is unaffected.
            fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);

            if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], airdrop['DEBIT']))
                error = 'invalid: insufficient funds (TICK)';

            // Stage this leg's debits on a cloned view; commit to shared `balances` only once the whole
            // leg validates. The clone must still carry the pending TICK debit so a same-leg check
            // sees it even when the airdropped tick is also the GAS/fee tick.
            let legBalances = (!error)
                ? this.util.debitBalances(Object.assign({}, balances), tokenInfo['TICK_ID'], airdrop['DEBIT'])
                : balances;

            // Run the controller guard once on the aggregate outbound move (from=SOURCE, amount=total
            // DEBIT), reserving its metered fee against `balances` before the per-tx fee check so a
            // GAS-short holder cannot over-debit GAS and trip the sanity check.
            if(!error && tokenInfo){
                let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'AIRDROP',
                    tick:        airdrop['TICK'],
                    from:        data['SOURCE'],
                    to:          '',
                    amount:      airdrop['DEBIT'],
                    data:        airdrop,
                    gasInfo:     gasInfo,
                    gasBalances: legBalances,
                    seq:         parseInt(idx) || 0
                });
                if(result.error){
                    error = 'invalid: ' + result.error;
                } else if(this.util.bcgt(result.guardFee, 0)){
                    guardFee = result.guardFee;
                    if(gasInfo)
                        legBalances = this.util.debitBalances(legBalances, gasInfo['TICK_ID'], guardFee);
                }
            }

            if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
                let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
                if(paymentMode === 'native'){
                    let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                    if(!validation.valid){
                        error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                    } else {
                        fees['PAYMENT_MODE']       = 1;
                        fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                        fees['NATIVE_COIN']        = validation.nativeCoin;
                        fees['ORACLE_ROUND']       = validation.oracleRound;
                    }
                } else if(paymentMode === 'rejected'){
                    error = 'invalid: insufficient fee (native coin output required)';
                } else {
                    if(!this.util.hasBalance(legBalances, fees['TICK_ID'], fees['AMOUNT']))
                        error = 'invalid: insufficient funds (FEE)';
                }
            }

            // Only for XCHAIN deduction mode (no PAYMENT_MODE, or mode 2)
            if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
                legBalances = this.util.debitBalances(legBalances, fees['TICK_ID'], fees['AMOUNT']);

            // Commit the staged view: only a fully-valid leg mutates the shared balances that the
            // next leg is measured against.
            if(!error)
                balances = legBalances;

            let status = (error) ? error : 'valid';
            data['STATUS'] = airdrop['STATUS'] = status;

            console.log("\t AIRDROP : " + airdrop['TICK'] + ' : ' + this.util.logAmount(airdrop['AMOUNT']) + ' : '+ airdrop['STATUS']);

            await this.indexerDb.createAirdrop(airdrop);

            this.util.addAddressTicker(data['SOURCE'], airdrop['TICK']);

            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            if(status=='valid'){
                debits.push([airdrop['TICK'], airdrop['DEBIT'], data['SOURCE']]);

                // Bill the controller-guard gas to SOURCE (a GAS burn with no offsetting credit). The
                // end-of-action updateTokens recomputes GAS supply from the ledger so the per-block
                // sanityCheck (ledger == supply == balances) holds. `balances` was already reduced above.
                if(this.util.bcgt(guardFee, 0)){
                    debits.push([gasTick, guardFee, data['SOURCE']]);
                    this.util.addAddressTicker(data['SOURCE'], gasTick);
                }

                [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

                for(let address of recipients){
                    this.util.addAddressTicker(address, airdrop['TICK']);
                    credits.push([airdrop['TICK'], airdrop['AMOUNT'], address]);
                }
            }
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Airdrop;