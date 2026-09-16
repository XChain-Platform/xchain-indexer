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
 * XChain Indexer - Utility: balances and ledger changes
 *
 * Address/ticker bookkeeping, balance checks, ledger record consolidation, the fee and
 * ownership transfers, the controlled-sale proceeds split, and the one writer of a
 * transaction's credits, debits and escrows.
 *
 ********************************************************************/

'use strict';

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Detect a contract's derived ledger address (e.g. "C:BTC:500"). Contracts ARE
    // valid on-ledger balance holders, so this format is a legitimate recipient
    // wherever proceeds settle purely on the XChain ledger (e.g. the GET_ADDRESS of a
    // same-chain token ORDER). It is NOT a real on-chain address: callers MUST keep
    // rejecting it anywhere native coin must actually be paid out (every DISPENSER,
    // and the native-coin side of an ORDER), since a synthetic address can't receive
    // a UTXO. Format-only check; see contract address derivation in
    // actions/execute.js (`'C:' + CHAIN + ':' + index`).
    isContractAddress(address){
        return /^C:[A-Z]+:[0-9]+$/.test(String(address));
    },

    // Split a bridged token's rooted tick into its origin chain and its native name.
    // A bridged copy is named `<ORIGIN>.<NAME>` on every destination chain (the origin-rooted
    // namespace), so `BTC.PEPECASH` read on DOGE is PEPECASH, native to BTC. Returns
    // { origin, name }, else null when any of these fails:
    //   - the tick carries EXACTLY one dot, so a dotted native name (`BTC.PEPE.CASH`) never
    //     parses as a bridged row; lock-time validation refuses those instead,
    //   - the prefix names a supported coin (config COINS),
    //   - that coin is NOT this chain's coin, because a row rooted at the local coin is a
    //     subasset of the local reserved root, never a bridged copy.
    // The prefix is compared case-folded and `origin` comes back as the coin's canonical
    // upper-case symbol: every ticker lookup is LOWER(tick), so a burn naming `btc.pepecash`
    // reaches the same row as `BTC.PEPECASH` and must reach the same verdict. `name` is
    // returned verbatim, because that is the string the caller looks the row up by. `coin`
    // defaults to the configured chain, the isCryptoAddress convention above.
    parseBridgedTick(tick, coin){
        if(this.isNull(tick))
            return null;
        let parts = String(tick).split('.');
        if(parts.length !== 2)
            return null;
        let prefix = parts[0].toUpperCase();
        let name   = parts[1];
        // An empty name denotes no row at all: MIN_TICK_LENGTH is 1, so `BTC.` is not a token.
        if(name === '')
            return null;
        let coins = this.config['COINS'] || [];
        if(!coins.includes(prefix))
            return null;
        let local = String((coin) ? coin : this.config['COIN']).toUpperCase();
        if(prefix === local)
            return null;
        return { origin: prefix, name: name };
    },

    // Handle adding a ticker to the addreses
    addAddressTicker(address, tick){
        let type = typeof tick;
        let list = (!this.isNull(this.addresses[address])) ? this.addresses[address] : [];
        // If tick is not null and type is an object, loop through tickers
        if(type=="object" && !this.isNull(tick)){
            for(let t of tick){
                // Add ticker to addresses list 
                if(!list.includes(t))
                    list.push(t);
                // Add ticker to tickers list
                if(!this.tickers.includes(t))
                    this.tickers.push(t);
            }
        } else if(type!='undefined'){
            // Add ticker to addresses list 
            if(!list.includes(tick))
                list.push(tick);
            // Add ticker to tickers list
            if(!this.tickers.includes(tick))
                this.tickers.push(tick);
        }
        // Update address list with updated list of tickers
        this.addresses[address] = list;
    },

    // Validate if a balances array holds a certain amount of a tick token
    hasBalance(balances, tick_id, amount){
        let balance = (!this.isNull(balances[tick_id])) ? balances[tick_id] : 0;
        if(this.bcgte(balance, amount))
            return true;
        return false;
    },

    // Handle deducting TICK AMOUNT from balances and return updated balances array
    debitBalances(balances, tick_id, amount){
        let balance = (!this.isNull(balances[tick_id])) ? balances[tick_id] : 0;
        balances[tick_id] = this.bcsub(balance, amount, 18);
        return balances;
    },

    // Consolidate ledger records (credits / debits / escrows)
    consolidateLedgerRecords(records){
        let arr  = [],
            data = [];
        // Consolidate amount using TICK\0ADDRESS as key (\0 cannot appear in tick names or addresses)
        for(let idx in records){
            let [tick, amount, address] = records[idx];
            let key = tick + '\0' + address;
            arr[key] = (arr[key]) ? this.bcadd(arr[key], amount, 18) : amount;
        }
        // Build out array of consolidated records
        for(let key in arr){
            let amount = arr[key];
            let [tick, address] = String(key).split('\0');
            let info = [tick, amount, address];
            data.push(info);
        }
        return data;
    },

    // Process any transaction FEE according the user's ADDRESS preferences
    async processTransactionFees(db, credits, debits, fees){
        if(this.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = fees['PAYMENT_MODE'] || 2;

            if(paymentMode === 1){
                // Native coin payment mode: fee is paid via on-chain output
                // No XCHAIN debit or credit; the native coin is already in the fee destination address
                // Just record the fee in the fees table
            } else {
                // XCHAIN balance deduction mode (default / Track A)
                debits.push([fees['TICK'], fees['AMOUNT'], fees['SOURCE']]);
                // Handle using FEE according the the users ADDRESS preferences
                if(fees['METHOD']>1){
                    let address = this.config['ADDRESS'];
                    fees['DESTINATION'] = (fees['METHOD']==2) ? address['DONATE1'] : address['DONATE2'];
                    this.addAddressTicker(fees['DESTINATION'], fees['TICK']);
                    credits.push([fees['TICK'], fees['AMOUNT'], fees['DESTINATION']]);
                }
            }

            // Create record of FEE in `fees` table
            await db.createFeeRecord(fees);
        }
        // Return updated list of credits and debits
        return [credits, debits];
    },

    // Transfer ownership of a tick from one address to another by clearing the ownership
    // escrow gate and writing a synthetic ISSUE+TRANSFER. `tokens.owner_id` is then
    // re-derived by db.updateTokens(). Called by order_match / swap_match / dispense /
    // coinpay / sweep when an ownership offer settles or is closed with delivery routing.
    async transferTokenOwnership(db, mapper, data, tick, fromAddress, toAddress){
        await db.clearTokenEscrow(tick);
        let issue = {
            ACTION:       'ISSUE',
            TICK:         tick,
            TRANSFER:     toAddress,
            SOURCE:       fromAddress,
            BLOCK_INDEX:  data['BLOCK_INDEX'],
            TX_INDEX:     data['TX_INDEX'],
            BLOCK_TIME:   data['BLOCK_TIME'],
            STATUS:       'valid'
        };
        issue['ACTION_INDEX'] = await db.createActionIndex(issue, true);
        await db.createIssue(issue);
        await db.updateTokens(tick);
        this.addAddressTicker(fromAddress, tick);
        this.addAddressTicker(toAddress,   tick);
        await mapper.createMappings(issue);
    },

    // Programmable policy layer: apply a controlled-token sale's royalty/fee split to ONE proceeds
    // credit at match/dispense. `legs` is the stored split (JSON string or array of {to, bps}); each
    // leg takes bps/10000 of the ACTUAL fill `proceeds` (so partial fills split proportionally with no
    // stored-amount scaling). Returns the credit tuples [tick, amount, address] that REPLACE the single
    // full-proceeds credit: the seller's remainder FIRST, then one credit per non-zero leg. Conservation
    // is exact by construction (remainder = proceeds − Σlegs). A malformed or over-cap legs set yields
    // NO split (seller keeps full proceeds); defensive: a buggy/rogue controller can never trap or
    // inflate funds. `decimals` = the proceeds tick's precision; `maxTakeBps` caps Σbps (default 10000).
    applyProceedsSplit(tick, proceeds, sellerAddress, legs, decimals, maxTakeBps){
        let full = [[tick, proceeds, sellerAddress]];
        let parsed = legs;
        if(typeof legs === 'string'){
            try { parsed = JSON.parse(legs); } catch(e){ return full; }
        }
        if(!Array.isArray(parsed) || parsed.length === 0) return full;
        if(this.isNull(proceeds) || !this.bcgt(proceeds, '0')) return full;
        let dec = (Number.isInteger(decimals) && decimals >= 0) ? decimals : 8;
        let cap = (Number.isInteger(maxTakeBps) && maxTakeBps >= 0 && maxTakeBps <= 10000) ? maxTakeBps : 10000;
        // Validate every leg + sum the basis points (fail-closed: any malformed leg → no split).
        let totalBps = 0;
        for(let leg of parsed){
            let bps = (leg && this.isNumeric(leg.bps)) ? parseInt(leg.bps) : NaN;
            if(!Number.isInteger(bps) || bps < 0 || this.isNull(leg.to)) return full;
            totalBps += bps;
        }
        if(totalBps > cap || totalBps > 10000) return full;
        // Compute each leg deterministically: floor((proceeds * bps) / 10000) to tick precision.
        // MUST floor, not round: bcdiv rounds half-up, so multiple legs landing on a half-fraction
        // would each round UP and Σlegs could exceed proceeds, driving the seller's remainder
        // NEGATIVE (a conservation break + negative balance credit). bcmulfloor guarantees
        // distributed ≤ exact ≤ proceeds, so the remainder is always ≥ 0.
        let out = [];
        let distributed = '0';
        for(let leg of parsed){
            let bps = parseInt(leg.bps);
            if(bps === 0) continue;
            let amount = this.bcmulfloor(this.bcmul(proceeds, String(bps), dec + 4), '0.0001', dec);
            if(this.bcgt(amount, '0')){
                out.push([tick, amount, String(leg.to)]);
                distributed = this.bcadd(distributed, amount, dec);
            }
        }
        // Seller's remainder first (deterministic ordering); remainder absorbs the floored-away
        // fractions so the split conserves the proceeds exactly, and is always ≥ 0 (legs floored).
        let result = [[tick, this.bcsub(proceeds, distributed, dec), sellerAddress]];
        for(let c of out) result.push(c);
        return result;
    },

    // Process any transaction ledger changes (credits / debits / escrows)
    async processTransactionLedgerChanges(db, data, credits, debits, escrows){
        // Programmable policy layer: completeness assertion (opt-in, test/audit only via
        // ASSERT_CONTROLLER_COMPLETENESS). Anti-drift backstop: if a transfer-controlled token is
        // debited from SOURCE but its controller was never consulted this action, a handler shipped
        // an ungated path. OFF by default so it can never affect production or the normal suite.
        if(db.config && db.config['ASSERT_CONTROLLER_COMPLETENESS'] && data && !data['IS_EMISSION'] && !data['IS_GUARD_EMISSION']){
            let guarded = data['_GUARDED_TICKS'] || {};
            for(let [tick, amount, address] of debits){
                if(address !== data['SOURCE']) continue;
                if(String(tick) === String(db.config['GAS'])) continue;
                if(!this.bcgt(amount, '0')) continue;
                let tickId = await db.getTickerId(tick);
                if(this.isNull(tickId)) continue;
                let eff = await db.getEffectiveTokenControllerForGuard(tickId, 'transfer', data['BLOCK_INDEX'], data['ACTION_INDEX']);
                if(eff && !guarded[String(tick)])
                    throw new Error('controller completeness: unguarded transfer-controlled debit of ' + tick + ' from SOURCE (action ' + data['ACTION_INDEX'] + ')');
            }
        }
        // Consolidate the credit / debit / escrow records to write as few records as possible
        debits  = this.consolidateLedgerRecords(debits);
        credits = this.consolidateLedgerRecords(credits);
        escrows = this.consolidateLedgerRecords(escrows);
        let action_index = data['ACTION_INDEX'];
        // Create records in debits table
        for(let idx in debits){
            let [tick, amount, address] = debits[idx];
            await db.createDebit(action_index, tick, amount, address);
        }
        // Create records in credits table
        for(let idx in credits){
            let [tick, amount, address] = credits[idx];
            await db.createCredit(action_index, tick, amount, address);
        }
        // Create records in escrows table
        for(let idx in escrows){
            let [tick, amount, address] = escrows[idx];
            await db.createEscrow(action_index, tick, amount, address);
        }
    }
};
