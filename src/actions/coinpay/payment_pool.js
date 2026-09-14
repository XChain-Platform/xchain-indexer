const { getLogger } = require('../../observability/index.js');
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
 * COINPAY payment pool: which payment an obligation draws on and how much of it
 * is left. Outside a BATCH that is the row's own output, unchanged; inside a
 * flagged BATCH it is the payee's own output (or the row's shared scalar cell),
 * tallied per address in the batch value ledger so N obligations need N
 * obligations' worth of payment. A payment that cannot settle the obligation is
 * skipped here (logged, its action index deleted, nothing settled or consumed).
 *
 ********************************************************************/

// Installed onto Coinpay.prototype by coinpay.js; each method runs with `this` bound to
// the handler, exactly as the class method it was.
module.exports = {

    // The pool this obligation draws on: { batchLedger, ledger, payee, payeeOutput,
    // settledOutput, paidAmount, payeeTally, consumed }, or null once the payment has
    // been skipped as unable to settle it.
    async resolvePaymentPool(data, obligationInfo){
        let pool = this.openBatchLedger(data);
        pool.payee = obligationInfo['PAYEE_ADDRESS'];
        if(!(await this.resolvePayeeOutput(data, pool)))
            return null;
        if(!(await this.measurePool(data, obligationInfo, pool)))
            return null;
        return pool;
    },

    // Batch-cumulative settlement-value accounting (BATCH_ISSUANCE_LIMITS).
    //
    // COIN_AMOUNT is TRANSACTION-level state that the batch loop preserves across
    // every sub-command, and nothing decrements it, so a running tally is the only
    // thing that stops each COINPAY sub-command judging the SAME untouched payment
    // from zero: without one, N COINPAYs in a batch settle N obligations out of ONE
    // payment. batch.js seeds
    // data['BATCH_VALUE_LEDGER'] (only when the flag is active, and only before its
    // baseKeys snapshot so the per-command field clear preserves it); this is where
    // the settlement half of that tally is read and written.
    //
    // The key's ABSENCE is both the flag gate and the not-a-batch case: with no
    // ledger `available` IS data['COIN_AMOUNT'], so every line below collapses to the
    // pre-existing behavior byte for byte, which is what a non-BATCH transaction and a
    // pre-flag-day BATCH must still see.
    //
    // data['FEE_PROBE'] marks the read-only dry-run surfaces. TWO capabilities hang
    // off the pair of variables below and must stay apart, because collapsing them
    // into one makes a probe disagree with the chain (spec row 30):
    //   batchLedger - "am I inside a flagged batch", answered by the key's PRESENCE.
    //                 A probe is inside one too, so this is true for a probe.
    //   ledger      - "may I draw on the tally", answered by !FEE_PROBE. A read-only
    //                 surface must never mutate consensus state, so this is the one
    //                 capability a probe is denied.
    // Denying a probe BOTH capabilities leaves it resolving no per-payee output, so it
    // answers `destination mismatch` for every payee the collapsed row does not name: a
    // false negative on a transaction the chain accepts, the same class the _primaryVerdict
    // snapshot in actions/index.js fixes for ORDER. Granting batchLedger while denying
    // ledger lets a probe read the output set and tally ZERO, so each sub-command is quoted
    // against the payment it will really draw on. FEE_PROBE is false for every decoded
    // transaction (actions/index.js sources it
    // from the synthetic tx only), so nothing below this line can move a consensus value.
    openBatchLedger(data){
        let batchLedger = (data['BATCH_VALUE_LEDGER'] && typeof data['BATCH_VALUE_LEDGER'] === 'object')
                            ? data['BATCH_VALUE_LEDGER'] : null;
        let ledger      = data['FEE_PROBE'] ? null : batchLedger;
        return { batchLedger, ledger };
    },

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
    async resolvePayeeOutput(data, pool){
        let { batchLedger, payee } = pool;
        let payeeOutput = batchLedger ? this.findPaymentOutput(data['TX_OUTPUTS'], payee) : null;

        // Early exit: if this output's destination does not match the payee address
        if(!payeeOutput && data['COIN_DESTINATION'] != payee){
            getLogger().info("\t COINPAY (skip): destination mismatch tx=" + data['COIN_DESTINATION'] + " payee=" + payee);
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return false;
        }
        pool.payeeOutput = payeeOutput;
        return true;
    },

    // Which pool this obligation draws on, and this is the whole reason the tally is
    // kept per address, not as a single scalar.
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
    // which preserves the single-address behavior byte for byte and keeps the pool that
    // actions/dispense.js shares through the same key. Every OTHER payee gets its own
    // cell in coinPayeeConsumed, created lazily here rather than seeded in batch.js,
    // and one payee's exhausted output can never invalidate a sibling paid separately.
    async measurePool(data, obligationInfo, pool){
        let { batchLedger, ledger, payee, payeeOutput } = pool;
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
            getLogger().info("\t COINPAY (skip): amount short tx=" + available + " owed=" + obligationInfo['COIN_AMOUNT']);
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return false;
        }
        Object.assign(pool, { settledOutput, paidAmount, payeeTally, consumed });
        return true;
    },

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
    drawFromPool(pool, obligationInfo, status){
        let { ledger, payee, settledOutput, payeeTally, consumed } = pool;
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
    }
};
