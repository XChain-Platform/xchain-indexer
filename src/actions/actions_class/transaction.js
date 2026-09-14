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
 * XChain Indexer - Actions class: transaction intake
 *
 * processTransaction, mixed into Actions.prototype by actions/index.js: turns one decoded
 * (or synthetic) transaction into the ACTION data object every handler reads, records it,
 * and hands it to processAction.
 *
 ********************************************************************/

// Trim the PARAMS in place, take the ACTION off the front, expand aliases, and apply the
// legacy VERSION-0 injection. Mutates `params` exactly as the handler dispatch expects.
function normalizeTransactionAction(actions, params){
    // Trim whitespace from any PARAMS
    params.forEach(function(value, idx){
        params[idx] = String(value).trim();
    });

    // Extract ACTION from PARAMS
    let action = String(params.shift()).toUpperCase();

    // Set correct ACTION for any aliases
    for(var alias in actions.actionAliases){
        if(action==alias)
            action = actions.actionAliases[alias];
    }

    // Legacy compatibility: VERSION 0 default injection for BTNS-style legacy
    // ISSUE/MINT/SEND that carry no explicit VERSION field. This is permanent
    // consensus behaviour, not a pre-release shim; do NOT remove.
    if(['ISSUE','MINT','SEND'].includes(action) && actions.util.isLegacyActionFormat(params))
        params.splice(0,0,0);

    return action;
}

// The ACTION data object for one transaction, before the tx/action index rows exist.
function buildActionData(tx, action, format, coin, isGenesis){
    // Define basic ACTION transaction data object
    let data = {};
    data['ACTION']           = action;      // Action (ISSUE, MINT, SEND, etc)
    data['FORMAT']           = format;      // Action FORMAT (0-255)
    data['BLOCK_INDEX']      = tx.block_index; // Block index
    data['BLOCK_TIME']       = tx.block_time;  // Block time (seconds since epoch)
    data['SOURCE']           = tx.source;      // Source address
    data['COIN']             = coin;        // COIN network
    data['COIN_DESTINATION'] = tx.destination; // COIN Destination address
    data['COIN_AMOUNT']      = tx.amount;      // Amount of native COIN
    data['TX_HASH']          = tx.tx_hash;     // Transaction Hash
    data['TX_VOUT']          = tx.vout;     // Transaction vout index
    data['TX_DATA']          = tx.data;     // Raw tx data string
    data['RAW_DATA']         = tx.raw_data; // Raw payload bytes (FILE ciphertext, etc.)
    data['FEE']              = tx.fee;      // Miners fee in satoshis
    data['SOURCE_PUBKEY']    = tx.source_pubkey; // Public key for the source address
    data['TX_OUTPUTS']       = tx.tx_outputs || []; // Full native-coin output set (fee detection)
    data['IS_GENESIS']       = isGenesis === true;  // synthetic genesis bootstrap action (genesis.js)
    // Guard-inert marker for the public feequote dry-run: when set, a controller guard
    // refuses at the invokeController chokepoint instead of entering the VM (utility.js),
    // so the unauthenticated feequote endpoint cannot run caller-influenced contract code
    // while holding the block-loop mutex. Sourced from tx.guard_inert, which only
    // computeFeeQuote's synthetic tx carries; ALWAYS false for real decoded transactions.
    data['GUARD_INERT']      = tx.guard_inert === true;
    // Read-only dry-run marker for output-matching fee checks (see dryRunAction's
    // fee_probe). Sourced from tx.fee_probe, which only the public feequote/preflight
    // synthetic tx carries; ALWAYS false for real decoded transactions.
    data['FEE_PROBE']        = tx.fee_probe === true;

    // Per-TRANSACTION top-level issuance budget (EMISSION_ISSUANCE_LIMITS).
    // Seeded HERE, at the transaction, because that is the only scope the rule can have:
    // a VM emission's own data object is built fresh per emission (execute.js
    // processEmission) and a BATCH sub-command's is cleared down to `baseKeys` between
    // commands, so a counter living in either would reset exactly where the abuse
    // accumulates. Being present before batch.js takes its baseKeys snapshot is what
    // makes the batch loop preserve it, the same way it preserves BATCH_VALUE_LEDGER.
    //
    // Consumed by issue.js (the single choke point every ISSUE reaches, wire or emitted).
    // Held as an OBJECT rather than a number so the reference threads unchanged through
    // the emission contexts (execute.js emissionData/guardCtxData, deploy.js
    // emissionContext) and every nested EXECUTE shares one tally rather than a copy.
    // Below the flag nothing reads it and nothing writes it.
    data['ISSUANCE_LIMIT_LEDGER'] = { topLevel: 0 };
    return data;
}

module.exports = {

    // Generalized function to handle processing a transaction
    // @param tx             object     Transaction object
    // @param tx.source      string     Source address
    // @param tx.data        string     Action `data`
    // @param tx.tx_hash     string     Transaction hash
    // @param tx.block_index integer    Block index of tx
    // isGenesis flags a synthetic genesis-bootstrap action (genesis.js): it is not decoded
    // from a real coin transaction, so it is fee-exempt and its TRANSFER owner may be a
    // wrong-network address on regtest. The flag is copied onto `data` (data['IS_GENESIS'])
    // and read by issue.js. Always false for real decoded transactions.
    async processTransaction(tx, isGenesis = false){
        let error       = false;
        let params      = String(tx.data).split('|');
        let destination = tx.destination;

        // Create database records and get ids for tx_hash and source address.
        // Address creation is sequential (NOT Promise.all) so the explicit dense
        // counter (getNextAddressId) assigns address_ids in a deterministic
        // source-before-destination order on every node. The counter is read-then-insert
        // per call, so concurrent INSERTs on separate pool connections would race and
        // assign ids in an unpredictable order, producing per-node mismatches that
        // feed the consensus ledger hash and fork it across validators.
        await this.indexerDb.createAddress(tx.source);
        await this.indexerDb.createAddress(destination);
        await this.indexerDb.createTransaction(tx.tx_hash);

        let action = normalizeTransactionAction(this, params);

        // Extract FORMAT from PARAMS
        let format = this.util.getFormatVersion(params[0]);

        let data = buildActionData(tx, action, format, this.config['COIN'], isGenesis);

        // Treat plain BTC transactions (empty data) as DISPENSE triggers
        // The decoder records these when the destination matches an active dispenser address
        if(action == '' && !this.util.isNull(destination)){
            action = 'DISPENSE';
            data['ACTION'] = action;
        }

        // Validate Action is known
        if(!this.protocolChanges.isDefined(action)){
            error = 'invalid: Unknown ACTION';
            data['ACTION'] = action = 'UNKNOWN';
        }

        // Verify ACTION is activated
        if(!error && await this.protocolChanges.isEnabled(action, tx.block_index) == false)
            error = 'invalid: ACTION is not yet activated';

        // Create a record of this transaction in the transactions table
        data['TX_INDEX'] = await this.indexerDb.createTxIndex(data);

        // Create a record of this action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(data);

        // Scoped to THIS transaction: the originating action's own verdict, captured if a
        // follow-on matcher takes its record over (see processAction below).
        this._primaryVerdict = null;

        // Process the specific ACTION commands
        await this.processAction(action, params, data, error);

        // Return the populated data object. The block loop ignores this; the read-only
        // feequote dry-run (computeFeeQuoteDryRun) reads data['STATUS'] to report validity.
        return data;
    }
};
