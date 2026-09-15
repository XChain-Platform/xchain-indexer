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
 * XChain Indexer - Database mixin part: polls (poll create)
 *
 * The VOTE v0 write that creates or re-applies a poll definition row.
 * A part of the polls mixin: src/db/polls/index.js merges it into the one method set that
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The two halves of createPoll's upsert, keyed by action_index. Their column lists alone
// would carry the method past the function limit, so the statements live here, text unchanged.
const POLL_UPDATE_SQL = `UPDATE polls SET
                        block_index=?, tick_id=?, end_block=?, options=?, max_selections=?,
                        tally_mode=?, weight_mode=?, quorum=?, min_voters=?, min_vote_balance=?,
                        decide_threshold=?, question=?, deposit_amount=?, deposit_address_id=?,
                        callback_contract_index=?, callback_method=?, callback_params=?,
                        callback_on=?, gas_escrow=?, callback_delay_blocks=?, status_id=?
                     WHERE action_index=?`;
const POLL_INSERT_SQL = `INSERT INTO polls
                        (block_index, tick_id, end_block, options, max_selections,
                         tally_mode, weight_mode, quorum, min_voters, min_vote_balance,
                         decide_threshold, question, deposit_amount, deposit_address_id,
                         callback_contract_index, callback_method, callback_params,
                         callback_on, gas_escrow, callback_delay_blocks, status_id, action_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

module.exports = {

    // Create/Update a poll record (VOTE v0). Keyed by the create action_index,
    // which is the poll's id. OPTIONS are stored as a JSON array, index-addressed
    // by ballots. Defaults (max_selections=1, tally_mode=approval,
    // weight_mode=balance) are applied by the handler before this is called.
    async createPoll(data){
        let action_index     = data['ACTION_INDEX'];
        let block_index      = data['BLOCK_INDEX'];
        let tick_id          = await this.createTicker(data['TICK']);
        let status_id        = await this.createStatus(data['STATUS']);
        let end_block        = data['END_BLOCK'];
        let optionsArr       = String(data['OPTIONS']).split(',').map(o => o.trim());
        let options          = JSON.stringify(optionsArr);
        let max_selections   = data['MAX_SELECTIONS'];
        let tally_mode       = data['TALLY_MODE'];
        let weight_mode      = data['WEIGHT_MODE'];
        let quorum           = data['QUORUM'];
        let min_voters       = data['MIN_VOTERS'];
        let min_vote_balance = data['MIN_VOTE_BALANCE'];
        let decide_threshold = data['DECIDE_THRESHOLD'];
        let question         = data['QUESTION'];
        // Creation deposit (anti-spam): parseCreate normalizes DEPOSIT to a numeric
        // string ('0' when none). Store the amount and the creator address id (the
        // refund target) so VOTE v2 can release the escrow without re-deriving SOURCE.
        let deposit_amount   = this.util.isNull(data['DEPOSIT']) ? '0' : String(data['DEPOSIT']);
        // Binding-poll callback fields (null on a signaling poll). callback_params is
        // stored as the raw JSON array string; gas_escrow defaults to '0'.
        let binding          = !this.util.isNull(data['CALLBACK_CONTRACT']) && String(data['CALLBACK_CONTRACT']).trim() !== '';
        let cb_contract      = binding ? parseInt(data['CALLBACK_CONTRACT']) : null;
        let cb_method        = binding ? data['CALLBACK_METHOD'] : null;
        let cb_params        = binding ? (this.util.isNull(data['CALLBACK_PARAMS']) ? null : String(data['CALLBACK_PARAMS'])) : null;
        let cb_on            = binding ? (data['CALLBACK_ON'] || 'pass') : null;
        let gas_escrow       = binding ? (this.util.isNull(data['GAS_ESCROW']) ? '0' : String(data['GAS_ESCROW'])) : null;
        // CALLBACK_DELAY_BLOCKS timelock: parseCreate nulls the field below
        // the VOTE_CALLBACK_TIMELOCK flag-day, so a stored value is always gate-legal.
        let cb_delay         = (binding && !this.util.isNull(data['CALLBACK_DELAY_BLOCKS'])) ? parseInt(data['CALLBACK_DELAY_BLOCKS']) : null;
        // deposit_address_id is the escrow PAYER (= creator), stored whenever any GAS
        // is locked (deposit OR gas_escrow) so v2 can resolve the refund target.
        let has_escrow       = this.util.bcgt(deposit_amount, 0) || (binding && this.util.bcgt(gas_escrow, 0));
        let deposit_addr_id  = has_escrow ? await this.createAddress(data['SOURCE']) : null;
        // INSERT/UPDATE keyed by action_index (poll definition is immutable, but
        // reprocessing the same action must be idempotent)
        let query   = `SELECT action_index FROM polls WHERE action_index=?`;
        let results = await this.doQuery(query, [action_index]);
        let exists  = (results.length > 0);
        if(exists){
            query = POLL_UPDATE_SQL;
        } else {
            query = POLL_INSERT_SQL;
        }
        let args = [block_index, tick_id, end_block, options, max_selections,
                    tally_mode, weight_mode, quorum, min_voters, min_vote_balance,
                    decide_threshold, question, deposit_amount, deposit_addr_id,
                    cb_contract, cb_method, cb_params, cb_on, gas_escrow, cb_delay, status_id, action_index];
        await this.doQuery(query, args);
    },

};
