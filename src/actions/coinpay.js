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
 * XChain Platform Action - COINPAY
 *
 * This action processes native coin payments that fulfill COINPay
 * obligations created by ORDER_MATCH for native coin DEX pairs.
 *
 * A COINPAY transaction includes both the action data (OP_RETURN)
 * and a native coin output paying the seller. The indexer processes
 * each output separately; only the output matching the obligation's
 * payee address and amount triggers settlement.
 *
 * Inside a BATCH there is no per-output processing (a BATCH row is not a
 * per-output settlement row, so output_fanout.js collapses it to one row),
 * so a batched sub-command resolves its own payment output from TX_OUTPUTS
 * instead. See the note at the resolution below.
 *
 * Format: COINPAY|0|ORDER_MATCH_ACTION_INDEX
 *
 ********************************************************************/

class Coinpay {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|ORDER_MATCH_ACTION_INDEX';
    }

    // The transaction output that pays `address`, or null.
    //
    // FIRST match, deliberately: the same matcher utility.js validateNativeCoinFee and
    // validateOracleFee use, so a payer sizing one output per payee and the validator
    // reading it back cannot disagree about WHICH output is meant. tx_outputs arrives
    // sorted by vout (db.js getDecoderBlockData), so "first" is the lowest-vout output
    // paying that address and is identical on every node.
    //
    // Consequence worth naming: an address paid by TWO outputs offers only the first as a
    // pool, so a batch settling two obligations to one seller must pay that seller both
    // obligations' worth in a single output. That is the shape the pool arithmetic below
    // already assumes ("surplus above the owed amount stays in the pool for a sibling
    // obligation to the same address") and is why the A5 invariant still binds per address.
    findPaymentOutput(txOutputs, address){
        if(!txOutputs || !Array.isArray(txOutputs) || this.util.isNull(address))
            return null;
        for(let output of txOutputs){
            if(output && (output.address === address || output.scriptPubKey_address === address))
                return output;
        }
        return null;
    }

    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        if(!error)
            data = this.util.setNumberFormats(data);

        let obligationInfo = false;
        if(!error)
            obligationInfo = await this.indexerDb.getCoinpayObligationInfo(data['ORDER_MATCH_ACTION_INDEX']);

        // Each on-chain output is processed independently; only the output that actually
        // matches a pending obligation settles. Every other output early-exits as a no-op.
        if(!obligationInfo || obligationInfo['COINPAY_STATUS'] != 'pending_coinpay'){
            console.log("\t COINPAY (skip): obligation " + data['ORDER_MATCH_ACTION_INDEX'] + " " + (obligationInfo ? "status=" + obligationInfo['COINPAY_STATUS'] : "not found"));
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        // Batch-cumulative settlement-value accounting (BATCH_ISSUANCE_LIMITS).
        //
        // COIN_AMOUNT is TRANSACTION-level state that the batch loop preserves across
        // every sub-command, and nothing decrements it. So before this, each COINPAY
        // sub-command judged the SAME untouched payment from zero: N COINPAYs in one
        // batch settled N obligations out of ONE payment. batch.js seeds
        // data['BATCH_VALUE_LEDGER'] (only when the flag is active, and only before its
        // baseKeys snapshot so the per-command field clear preserves it); this is where
        // the settlement half of that tally is read and written.
        //
        // The key's ABSENCE is both the flag gate and the not-a-batch case: with no
        // ledger `available` IS data['COIN_AMOUNT'], so every line below collapses to the
        // pre-existing behavior byte for byte, which is what a non-BATCH transaction and a
        // pre-flag-day BATCH must still see.
        //
        // data['FEE_PROBE'] marks the read-only dry-run surfaces. TWO capabilities used to
        // hang off one variable here, and conflating them made a probe disagree with the
        // chain (spec row 30):
        //   batchLedger - "am I inside a flagged batch", answered by the key's PRESENCE.
        //                 A probe is inside one too, so this is true for a probe.
        //   ledger      - "may I draw on the tally", answered by !FEE_PROBE. A read-only
        //                 surface must never mutate consensus state, so this is the one
        //                 capability a probe is denied.
        // Denying a probe BOTH left it resolving no per-payee output, so it answered
        // `destination mismatch` for every payee the collapsed row does not name: a false
        // negative on a transaction the chain accepts, the same class the _primaryVerdict
        // snapshot in actions.js fixes for ORDER. A probe now reads the output set and
        // tallies ZERO, so each sub-command is quoted against the payment it will really
        // draw on. FEE_PROBE is false for every decoded transaction (actions.js sources it
        // from the synthetic tx only), so nothing below this line can move a consensus value.
        let batchLedger = (data['BATCH_VALUE_LEDGER'] && typeof data['BATCH_VALUE_LEDGER'] === 'object')
                            ? data['BATCH_VALUE_LEDGER'] : null;
        let ledger      = data['FEE_PROBE'] ? null : batchLedger;

        let payee = obligationInfo['PAYEE_ADDRESS'];

        // Per-payee payment resolution INSIDE a batch (BATCH_ISSUANCE_LIMITS, spec row 25).
        //
        // Outside a batch this handler is reached once per native-coin output: db.js
        // getDecoderBlockData emits one row per stored output and output_fanout.js leaves
        // a COINPAY transaction's rows alone, so COIN_DESTINATION/COIN_AMOUNT walk the
        // whole output set and exactly the row paying the payee settles.
        //
        // A BATCH row is NOT a per-output settlement row (its top-level action is BATCH),
        // so collapseOutputFanout keeps only the LOWEST-VOUT row and every sub-command
        // sees that one output's COIN_DESTINATION. N sub-commands paying N different
        // sellers therefore cleared exactly one of them: the rest failed the destination
        // check against a payment that was never meant for them.
        //
        // The fix is NOT to fan a BATCH row out per output - that would re-execute every
        // sub-command (every ISSUE, SEND, ORDER) once per output. It is for this handler to
        // read the output set directly: getDecoderBlockData attaches the FULL, vout-sorted
        // tx_outputs of the transaction to EVERY emitted row (db.js, `outputsByTx`), so the
        // surviving row already carries every payee's output; only the consumer was missing.
        //
        // Gated by the ledger's presence, which is this spec's flag AND the in-a-batch
        // marker. Off the batch path payeeOutput stays null and the destination check below
        // is the unchanged single-output test. On the READ capability, not the write one:
        // resolving which output pays this payee is a question about the transaction, and a
        // probe that cannot ask it quotes a mismatch the chain does not report.
        let payeeOutput = batchLedger ? this.findPaymentOutput(data['TX_OUTPUTS'], payee) : null;

        if(!payeeOutput && data['COIN_DESTINATION'] != payee){
            console.log("\t COINPAY (skip): destination mismatch tx=" + data['COIN_DESTINATION'] + " payee=" + payee);
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        // Which pool this obligation draws on, and this is the whole reason the tally is
        // no longer a single scalar.
        //
        // coinAmountConsumed was correct while every consumer drew on ONE output: COINPAY
        // and coin-paid DISPENSE both spent the surviving row's COIN_DESTINATION output and
        // nothing else was reachable. Once an obligation can resolve its OWN output, a
        // scalar is wrong in exactly the way a scalar oracle-fee tally would have been
        // wrong (utility.js validateOracleFee, which keys by oracle address for this same
        // reason): seller A's settlement would eat the output that pays seller B, and two
        // sellers each paid in full would settle only once.
        //
        // So the model is per-ADDRESS, with the existing scalar kept as the cell for one
        // address - the row's own COIN_DESTINATION. That address's arithmetic is then
        // untouched (paidAmount IS data['COIN_AMOUNT'], the tally IS coinAmountConsumed),
        // which preserves R5's driven behavior byte for byte and keeps the pool that
        // actions/dispense.js shares through the same key. Every OTHER payee gets its own
        // cell in coinPayeeConsumed, created lazily here rather than seeded in batch.js,
        // and one payee's exhausted output can never invalidate a sibling paid separately.
        let settledOutput = (payee == data['COIN_DESTINATION']) ? null : payeeOutput;

        let paidAmount = settledOutput
                            ? (settledOutput.value || settledOutput.amount || 0)
                            : data['COIN_AMOUNT'];
        let payeeTally = (ledger && ledger['coinPayeeConsumed'] && typeof ledger['coinPayeeConsumed'] === 'object')
                            ? ledger['coinPayeeConsumed'] : null;
        let consumed   = settledOutput
                            ? (payeeTally ? (payeeTally[payee] || '0') : '0')
                            : (ledger ? ledger['coinAmountConsumed'] : '0');
        // A probe holds the read capability and no write one, so `consumed` is '0' on both
        // branches above and this reduces to the payee's OWN output undrained. That is the
        // point: quoting against data['COIN_AMOUNT'] would price this obligation off the
        // lowest-vout output, which belongs to a DIFFERENT payee. The quote is deliberately
        // optimistic about siblings (nothing tracks what an earlier sub-command of the same
        // probe would have spent), exactly as validateNativeCoinFee's probe path already is.
        let available  = batchLedger ? this.util.bcsub(paidAmount, consumed, 8) : data['COIN_AMOUNT'];

        // A later sub-command that the REMAINING payment cannot fully cover takes the
        // existing short-payment path: it skips, settles nothing, and consumes nothing.
        // Partial settlement is deliberately not invented here - an obligation is settled
        // in full or not at all (getCoinpayObligationInfo has no partial-fill state), so
        // "one payment settles one obligation, not N" is enforced by refusing the later
        // command outright rather than by part-paying it.
        if(this.util.bclt(available, obligationInfo['COIN_AMOUNT'])){
            console.log("\t COINPAY (skip): amount short tx=" + available + " owed=" + obligationInfo['COIN_AMOUNT']);
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        if(!error && data['BLOCK_TIME'] >= obligationInfo['EXPIRATION'])
            error = 'invalid: COINPAY obligation expired';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Draw this obligation's OWED amount (never the whole payment) out of the batch
        // pool, and only for a settlement that actually stands: an expired obligation
        // settles nothing, so like a rejected fee command it consumes nothing.
        //
        // Draining at the owed amount rather than at the payment is the same
        // non-compounding rule the native-fee pool uses: N obligations' worth of payment
        // covers exactly N obligations. Any overpayment above the owed amount stays in the
        // pool, which is correct rather than generous - every obligation drawing on a given
        // pool was paid to the SAME address (that is what keys the pool), so the surplus
        // really is value that address received and a sibling obligation to it may draw on
        // it. Ledger values stay decimal STRINGS at 8dp, accumulated with bcadd.
        //
        // The draw lands in the cell for the address that was actually paid: the shared
        // scalar for the row's own COIN_DESTINATION (unchanged, and still visible to
        // actions/dispense.js), or this payee's own cell otherwise.
        if(ledger && status == 'valid'){
            let drawn = this.util.bcformat(this.util.bcadd(consumed, obligationInfo['COIN_AMOUNT'], 8), 8);
            if(settledOutput){
                if(!payeeTally){
                    payeeTally = {};
                    ledger['coinPayeeConsumed'] = payeeTally;
                }
                payeeTally[payee] = drawn;
            } else {
                ledger['coinAmountConsumed'] = drawn;
            }
        }

        console.log("\t COINPAY : " + this.config['COIN'] + ':' + data['ORDER_MATCH_ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Record the output this obligation actually settled against. On the legacy path
        // that is the row's own output, unchanged. On the per-payee path the row describes
        // a DIFFERENT address's payment, so recording it would file seller B's settlement
        // under seller A's payment; `coinpays` is a descriptive record (nothing in the
        // indexer reads the table back), so this corrects the attribution without moving a
        // consensus value.
        let coinpayData = {
            ACTION_INDEX:            data['ACTION_INDEX'],
            OBLIGATION_ACTION_INDEX: obligationInfo['ACTION_INDEX'],
            COIN_AMOUNT:             settledOutput ? paidAmount     : data['COIN_AMOUNT'],
            TXID:                    data['TX_HASH'],
            VOUT:                    settledOutput ? settledOutput.vout : data['TX_VOUT'],
            STATUS:                  status,
            BLOCK_INDEX:             data['BLOCK_INDEX']
        };
        await this.indexerDb.createCoinpay(coinpayData);

        if(status != 'valid'){
            await this.mapper.createMappings(data);
            return;
        }

        // Valid COINPAY: settle the trade.
        let matchOrders = await this.indexerDb.getOrderMatchOrders(obligationInfo['ACTION_INDEX']);
        if(!matchOrders)
            return;

        let giveOrderInfo = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.give_action_index);
        let getOrderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.get_action_index);
        if(!giveOrderInfo || !getOrderInfo)
            return;

        // Determine which order is the token seller (escrowed tokens) and which is the coin
        // offerer. The role split must match order_match.js (which created the obligation) and
        // coinpay_expire.js (the opposite unwind) exactly, or the wrong order's escrowed token
        // is released. Gated by COINPAY_NATIVE_RECIPROCITY: below the flag-day the legacy
        // single-side check is preserved byte-for-byte; at/after it the split keys on which side
        // actually GIVES native coin, reading BOTH orders. On a well-formed native match exactly
        // one side gives coin, so the two agree; the robust form additionally refuses to settle
        // an ambiguous shape (which order_match no longer creates once the flag is active).
        let sellerOrder, coinOrder;
        if(await this.actions.protocolChanges.isEnabled('COINPAY_NATIVE_RECIPROCITY', data['BLOCK_INDEX'])){
            let giveIsCoin = this.util.isNull(giveOrderInfo['GIVE_TICK']) || giveOrderInfo['GIVE_TICK'] == this.config['COIN'];
            let getIsCoin  = this.util.isNull(getOrderInfo['GIVE_TICK'])  || getOrderInfo['GIVE_TICK']  == this.config['COIN'];
            if(giveIsCoin && !getIsCoin){
                coinOrder   = giveOrderInfo;
                sellerOrder = getOrderInfo;
            } else if(getIsCoin && !giveIsCoin){
                coinOrder   = getOrderInfo;
                sellerOrder = giveOrderInfo;
            } else {
                console.log("\t COINPAY (skip): ambiguous native roles for match " + obligationInfo['ACTION_INDEX']);
                return;
            }
        } else if(this.util.isNull(giveOrderInfo['GIVE_TICK']) || giveOrderInfo['GIVE_TICK'] == this.config['COIN']){
            coinOrder   = giveOrderInfo;
            sellerOrder = getOrderInfo;
        } else {
            coinOrder   = getOrderInfo;
            sellerOrder = giveOrderInfo;
        }

        // The buyer (coin payer) receives tokens at their order's GET_ADDRESS
        let buyerGetAddress = coinOrder['GET_ADDRESS'];

        this.util.addAddressTicker(sellerOrder['SOURCE'], sellerOrder['GIVE_TICK']);
        this.util.addAddressTicker(buyerGetAddress, sellerOrder['GIVE_TICK']);

        let credits = [],
            debits  = [],
            escrows = [];

        // Token amount released to the buyer: derived from the ORDER_MATCH, not the
        // obligation's coin_amount (a different asset/leg). give_action_index is the
        // matching order; get_action_index is the original order.
        let matchQuery = await this.indexerDb.getOrderMatchAmounts(obligationInfo['ACTION_INDEX']);
        let tokenAmount;
        if(matchQuery){
            if(sellerOrder['ACTION_INDEX'] == matchQuery.get_action_index){
                // Seller is the original order (get side): token amount is give_amount
                tokenAmount = matchQuery.give_amount;
            } else {
                // Seller is the match order (give side): token amount is get_amount
                tokenAmount = matchQuery.get_amount;
            }
        }

        if(tokenAmount){
            if(Number(sellerOrder['GIVE_OWNERSHIP']||0) == 1){
                // Ownership delivery: clear the escrow gate and transfer ownership to the
                // buyer's GET_ADDRESS. No balance ledger change (the asset is the ownership
                // record itself).
                await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, sellerOrder['GIVE_TICK'], sellerOrder['SOURCE'], buyerGetAddress);
            } else {
                // BigNumber-space negation, not JS unary minus (float truncation, #3736).
                escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, tokenAmount, 64), sellerOrder['SOURCE']]);
                credits.push([sellerOrder['GIVE_TICK'],  tokenAmount, buyerGetAddress]);
            }
        }

        await this.indexerDb.createCoinpayStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'fulfilled');

        // Clear the MATCH. Its status lives on its own order_matches row; order_statuses
        // is keyed by an ORDER index and every reader joins it that way, so a match
        // index written there matches nothing.
        await this.indexerDb.updateOrderMatchStatus(obligationInfo['ACTION_INDEX'], 'valid');

        // Re-fetch order info to get updated GIVE_REMAINING after this settlement
        let updatedSellerOrder = await this.indexerDb.getOrderInfo(this.config['COIN'], sellerOrder['ACTION_INDEX']);
        let updatedCoinOrder   = await this.indexerDb.getOrderInfo(this.config['COIN'], coinOrder['ACTION_INDEX']);

        if(updatedSellerOrder && (this.util.bclte(updatedSellerOrder['GIVE_REMAINING'], 0) || this.util.bclte(updatedSellerOrder['GET_REMAINING'], 0)))
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], sellerOrder['ACTION_INDEX'], 'complete');
        if(updatedCoinOrder && (this.util.bclte(updatedCoinOrder['GIVE_REMAINING'], 0) || this.util.bclte(updatedCoinOrder['GET_REMAINING'], 0)))
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], coinOrder['ACTION_INDEX'], 'complete');

        // Check if seller's order is in a transitional state and can be finalized
        if(updatedSellerOrder){
            let sellerStatus = updatedSellerOrder['ORDER_STATUS'];
            if(sellerStatus == 'cancelling' || sellerStatus == 'expiring'){
                let pendingObligations = await this.indexerDb.getPendingCoinpayObligationsByOrder(sellerOrder['ACTION_INDEX']);
                if(pendingObligations.length == 0){
                    let finalStatus = (sellerStatus == 'cancelling') ? 'cancelled' : 'expired';
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], sellerOrder['ACTION_INDEX'], finalStatus);

                    // Release any remaining escrowed tokens back to the seller, or to
                    // the SWEEP DESTINATION if the cancelling state was triggered by a
                    // SWEEP with ORDERS=1. Ownership orders are single-fill, so no
                    // remaining balance exists and the escrow gate was already cleared
                    // in the settlement branch above.
                    if(Number(sellerOrder['GIVE_OWNERSHIP']||0) != 1 &&
                       updatedSellerOrder['GIVE_REMAINING'] && this.util.bcgt(updatedSellerOrder['GIVE_REMAINING'], 0)){
                        let refundTo = sellerOrder['SOURCE'];
                        if(sellerStatus == 'cancelling'){
                            let sweepDest = await this.indexerDb.getOrderSweepDestination(sellerOrder['ACTION_INDEX']);
                            if(sweepDest){
                                refundTo = sweepDest;
                                this.util.addAddressTicker(refundTo, sellerOrder['GIVE_TICK']);
                            }
                        }
                        // BigNumber-space negation, not JS unary minus (float truncation, #3736).
                        escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, updatedSellerOrder['GIVE_REMAINING'], 64), sellerOrder['SOURCE']]);
                        credits.push([sellerOrder['GIVE_TICK'],  updatedSellerOrder['GIVE_REMAINING'], refundTo]);
                    }
                }
            }
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Coinpay;
