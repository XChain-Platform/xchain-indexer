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
 * DISPENSE handler part: the CONTEXT both passes run against.
 *
 * The block fields, the matching-dispenser lookup and its no-match drop, the
 * batch and transaction settlement-value tallies, and the tally scale. Moved
 * verbatim out of parse(); the reads happen in the same order, which is what the
 * call tape pins.
 *
 ********************************************************************/

'use strict';

const divergenceMetrics = require('../../chain/dispenser_divergence_metrics.js');
const tallyScaleActivation = require('../../dispense_payment_tally_scale_activation.js');

// Installed onto Dispense.prototype by dispense.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // Builds the ctx both loops thread: every local the one long scope held, so the
    // pricing pass and the settlement pass read and write the same values they did.
    async prepareDispenseContext(data){
        let ctx = { data };
        await this.loadMatchingDispensers(ctx);
        await this.resolveBatchValueLedger(ctx);
        await this.resolveTransactionValueLedger(ctx);
        this.resolveDispenseTallyScale(ctx);
        return ctx;
    },

    // The block fields, the dispensers this payment triggers, and the drop (with its
    // divergence metric) when it triggers none.
    async loadMatchingDispensers(ctx){
    let { data } = ctx;

        // Save some details from the dispense request
        let block_index = data['BLOCK_INDEX'];
        let block_time  = data['BLOCK_TIME'];
        let tx_index    = data['TX_INDEX'];

        // Placeholder for valid dispenses
        let dispenses  = [];

        // Placeholder for dispenser info
        let dispenserInfo = {}; 

        // Lookup any dispensers that are triggered by this action
        let action_indexes = await this.indexerDb.findMatchingDispensers(data);

        // If we found no valid dispensers, delete the action_index that we created for this DISPENSE
        if(action_indexes.length==0){
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);

            // Observability: a DISPENSE trigger that matches no open dispenser is dropped.
            // When the paid address DID have a dispenser that is now cancelled or expired,
            // this is the upstream decoder still proposing DISPENSE for a dispenser the
            // indexer already closed/re-dated. Tag the reason and count it so the volume of
            // this split can be sized from logs. Measurement only - the drop above is
            // unchanged; this adds no accept/reject behavior.
            let closed = await this.indexerDb.getClosedDispenserAtAddress(data['COIN'], data['COIN_DESTINATION']);
            if(closed)
                divergenceMetrics.recordRejectedDispense(data['COIN'], block_index, data['COIN_DESTINATION'], closed['ACTION_INDEX'], closed['REASON']);
        }

    ctx.block_index = block_index;
    ctx.block_time = block_time;
    ctx.tx_index = tx_index;
    ctx.dispenses = dispenses;
    ctx.dispenserInfo = dispenserInfo;
    ctx.action_indexes = action_indexes;
    },

    // The batch-cumulative settlement-value tally, when this DISPENSE is a sub-command
    // of a BATCH that seeded one.
    async resolveBatchValueLedger(ctx){
    let { data } = ctx;

        // Batch-cumulative settlement-value accounting (BATCH_ISSUANCE_LIMITS).
        //
        // COIN_AMOUNT is TRANSACTION-level state that the batch loop preserves across
        // every sub-command, and nothing decrements it. So before this, each DISPENSE
        // sub-command re-ran against the SAME untouched payment from zero and bought a
        // full multiplier off it: N sub-commands spent one payment N times. batch.js seeds
        // data['BATCH_VALUE_LEDGER'] (only when the flag is active, and only before its
        // baseKeys snapshot so the per-command field clear preserves it), and the tally is
        // shared with COINPAY: both consume the same transaction settlement value.
        //
        // The key's PRESENCE is what says "I am inside a batch" to every reader; its
        // absence is the not-a-batch case.
        //
        // data['FEE_PROBE'] marks the read-only dry-run surfaces; a probe must neither
        // read nor write the ledger.
        let ledger = (!data['FEE_PROBE'] && data['BATCH_VALUE_LEDGER'] && typeof data['BATCH_VALUE_LEDGER'] === 'object')
                        ? data['BATCH_VALUE_LEDGER'] : null;

    ctx.ledger = ledger;
    },

    // The same tally for an ordinary transaction, which the batch ledger cannot cover
    // because its key is absent there.
    async resolveTransactionValueLedger(ctx){
    let { data, block_index, ledger, action_indexes } = ctx;

        // The SAME one-payment-N-settlements shape exists OUTSIDE a batch, and the batch
        // ledger cannot close it because the key is absent there (spec row 19).
        //
        // findMatchingDispensers returns EVERY open dispenser sitting behind the paid
        // address, and the loop below runs once per dispenser. Nothing decremented the
        // payment between iterations, so each dispenser priced itself against the same
        // untouched COIN_AMOUNT and bought a full multiplier off it: one payment, N
        // settlements, in an ordinary single-command transaction. Anyone may open a second
        // dispenser at an address they control, so this is reachable without a batch.
        //
        // This is a CONSENSUS TIGHTENING on the ordinary path, so it activates with this
        // spec's flag (operator decision 2026-08-13: ship it here rather than mint a
        // second flag). Below the flag no tally exists, `available` IS data['COIN_AMOUNT']
        // on every iteration, and the defect replays byte for byte.
        //
        // A LOCAL object, deliberately never written to data['BATCH_VALUE_LEDGER']: that
        // key's presence means "inside a batch" to batch.js, coinpay.js and
        // validateOracleFee, so fabricating one on non-batch data would tell three other
        // readers something untrue. Same field name and same semantics as the batch
        // ledger's coinAmountConsumed, so the drain below is one code path for both; the
        // only difference is the SCOPE it tallies over (this transaction's dispense, not
        // the whole batch). Only coinAmountConsumed is carried, because this handler
        // consumes no native fee and pays no oracle fee.
        //
        // Scoped to this parse() call, which for a non-batch transaction IS the
        // transaction: a fresh DISPENSE action gets a fresh tally, so nothing leaks
        // between transactions or between blocks.
        //
        // A FEE_PROBE gets no tally at all, matching the batch path: the quote surfaces
        // must keep reading the un-drained payment.
        //
        // This also covers the SEND-triggered dispense path
        // (util.processDispenserSends), which builds its own data object carrying the
        // SEND's own amount and deliberately no batch ledger: it lands here with the key
        // absent and gets a tally scoped to that one SEND's value, which is exactly the
        // value its dispensers may spend. See the note at processDispenserSends.
        if(!ledger && !data['FEE_PROBE'] && this.util.isNull(data['BATCH_VALUE_LEDGER']) && action_indexes.length > 0){
            let batchIssuanceLimits = await this.actions.protocolChanges.isEnabled('BATCH_ISSUANCE_LIMITS', block_index);
            if(batchIssuanceLimits)
                ledger = { coinAmountConsumed: '0' };
        }

    ctx.ledger = ledger;
    },

    // The scale every tally read, charge and accumulation below runs at.
    resolveDispenseTallyScale(ctx){
    let { data, block_time } = ctx;

        // Scale every tally read, charge and accumulation below runs at.
        //
        // 8 dp holds a native-coin payment exactly and ROUNDS a token one: a SEND
        // trigger carries the sent tick's own amount, and a tick may be issued with up
        // to MAX_TOKEN_DECIMALS. Gated, because it changes the fill count a payment buys
        // (dispense_payment_tally_scale_activation.js carries the two rounding failures
        // and the unarmed-mainnet argument). The batch pool is excluded there: it counts
        // the transaction's coin settlement value and coinpay.js formats it at 8 dp.
        let tallyScale = tallyScaleActivation.dispenseTallyScale(
            block_time,
            this.config['NETWORK'],
            data['DISPENSE_TYPE'] === 'SEND',
            Object.prototype.hasOwnProperty.call(data, 'BATCH_VALUE_LEDGER'));

    ctx.tallyScale = tallyScale;
    },
};

