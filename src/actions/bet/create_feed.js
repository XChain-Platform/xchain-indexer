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
 * BET feed creation: the format 0 (Create Feed) checks, from the feed's
 * definition and terms to its gating lists and the optional DETAILS document.
 *
 * Everything here judges the market as the oracle wrote it, before any stake
 * exists, which is why it sits apart from the checks on an existing feed in
 * validate.js.
 *
 ********************************************************************/

// Installed onto Bet.prototype by bet.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Format 0 (Create Feed) validations, in three phases
    async validateCreateFeed(data, format, tokenInfo, outcomeLabels, error){
        if(format!=0)
            return error;

        error = await this.validateFeedDefinition(data, tokenInfo, outcomeLabels, error);

        error = this.validateFeedTerms(data, tokenInfo, error);

        error = await this.validateFeedGating(data, outcomeLabels, error);

        return error;
    },

    // Feed definition: label, outcome set and the wagered tick
    async validateFeedDefinition(data, tokenInfo, outcomeLabels, error){

        // Verify LABEL is present and within length bounds
        if(!error && (this.util.isNull(data['LABEL']) || String(data['LABEL']).length < 1 || String(data['LABEL']).length > this.config['MAX_BET_LABEL_LENGTH']))
            error = 'invalid: LABEL (length)';

        // Verify OUTCOMES: comma-split count bounds
        if(!error){
            let rawOutcomes = this.util.isNull(data['OUTCOMES']) ? [] : String(data['OUTCOMES']).split(',');
            // A feed needs at least two outcomes to be a market at all, and the ceiling bounds
            // the settlement work every node does when the feed resolves.
            if(rawOutcomes.length < 2 || rawOutcomes.length > this.config['MAX_BET_OUTCOMES'])
                error = 'invalid: OUTCOMES (count)';
            // Each label trimmed non-empty, within length, and free of the wire
            // delimiters and ASCII control characters (comma cannot survive the
            // split; pipe / semicolon cannot reach us through the wire format;
            // the checks are defense-in-depth per spec)
            if(!error){
                for(let label of rawOutcomes){
                    let trimmed = String(label).trim();
                    if(trimmed.length < 1 || trimmed.length > this.config['MAX_BET_OUTCOME_LENGTH'] ||
                       /[,|;]/.test(trimmed) || /[\x00-\x1F\x7F]/.test(trimmed)){
                        error = 'invalid: OUTCOMES (label)';
                        break;
                    }
                    outcomeLabels.push(trimmed);
                }
            }
            // Labels unique by byte-exact comparison after trim (case variants
            // may coexist; wallets warn)
            if(!error && new Set(outcomeLabels).size !== outcomeLabels.length)
                error = 'invalid: OUTCOMES (duplicate)';
        }

        // Verify TICK: native coin (empty) rejects in v0; token must exist
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (native coin not supported)';
        // The wagered tick must be an issued token: stakes are escrowed at its DECIMALS,
        // which an unknown tick cannot supply.
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Verify TICK is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        // Controller-bound ticks reject in v0: betting would otherwise bypass the
        // trade controller's listing veto and royalty legs entirely (stake-and-lose
        // to a colluding winner is an uncontrolled transfer). Resolved through the
        // same most-specific-wins map the ORDER guard uses ('trade' falls back to a
        // catch-all 'all' binding), so an all-bound token also rejects.
        if(!error){
            let tickId = await this.indexerDb.getTickerId(data['TICK']);
            let controller = this.util.isNull(tickId) ? null : await this.indexerDb.getEffectiveTokenControllerForGuard(tickId, 'trade', data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(controller)
                error = 'invalid: TICK (controller-bound)';
        }

        return error;
    },

    // Feed terms: oracle fee, deadline, refund window and minimum stake
    validateFeedTerms(data, tokenInfo, error){
        // Verify FEE: optional percent of the pot, <= 2 decimals, 0..MAX_FEED_FEE
        if(!error && !this.util.isNull(data['FEE'])){
            // Two decimal places at most, checked here rather than at settlement, where a bad
            // value would already have taken stakes it could not pay back.
            if(!/^\d+(\.\d{1,2})?$/.test(String(data['FEE'])))
                error = 'invalid: FEE (format)';
            else if(this.util.bclt(data['FEE'], 0) || this.util.bcgt(data['FEE'], this.config['MAX_FEED_FEE']))
                error = 'invalid: FEE (range)';
        }

        // Verify DEADLINE: required integer unix time strictly in the future
        if(!error && (this.util.isNull(data['DEADLINE']) || !this.util.isNumeric(data['DEADLINE']) || !this.util.isInteger(data['DEADLINE'])))
            error = 'invalid: DEADLINE (format)';
        if(!error && this.util.bclte(data['DEADLINE'], data['BLOCK_TIME']))
            error = 'invalid: DEADLINE (past)';
        // Horizon cap bounds the expire_at arithmetic and keeps open feeds out of
        // the per-block passes indefinitely
        if(!error && this.util.bcgt(data['DEADLINE'], this.util.bcadd(data['BLOCK_TIME'], this.config['MAX_BET_DEADLINE_HORIZON'], 0)))
            error = 'invalid: DEADLINE (too far)';

        // Verify REFUND_WINDOW: optional (defaulted), integer seconds within bounds
        if(!error && this.util.isNull(data['REFUND_WINDOW']))
            data['REFUND_WINDOW'] = this.config['DEFAULT_BET_REFUND_WINDOW'];
        // Verify REFUND_WINDOW is a whole number of seconds
        if(!error && (!this.util.isNumeric(data['REFUND_WINDOW']) || !this.util.isInteger(data['REFUND_WINDOW'])))
            error = 'invalid: REFUND_WINDOW (format)';
        // Verify REFUND_WINDOW falls between the configured minimum and maximum
        if(!error && (this.util.bclt(data['REFUND_WINDOW'], this.config['MIN_BET_REFUND_WINDOW']) || this.util.bcgt(data['REFUND_WINDOW'], this.config['MAX_BET_REFUND_WINDOW'])))
            error = 'invalid: REFUND_WINDOW (range)';

        // Materialize expire_at at parse (64-bit columns; the horizon + window caps
        // above keep the sum from wrapping)
        if(!error)
            data['EXPIRE_AT'] = this.util.bcadd(data['DEADLINE'], data['REFUND_WINDOW'], 0);

        // Verify MIN_AMOUNT: optional minimum stake at the tick's DECIMALS, > 0
        if(!error && !this.util.isNull(data['MIN_AMOUNT']) && (!this.util.isValidAmountFormat(tokenInfo['DECIMALS'], data['MIN_AMOUNT'], data['BLOCK_TIME']) || !this.util.bcgt(data['MIN_AMOUNT'], 0)))
            error = 'invalid: MIN_AMOUNT (format)';

        return error;
    },

    // Gating lists and the optional DETAILS document
    async validateFeedGating(data, outcomeLabels, error){
        // Validate LIST fields (ALLOW_LIST / BLOCK_LIST): list exists and is a
        // supported (address) type
        if(!error){
            for(let name of ['ALLOW_LIST', 'BLOCK_LIST']){
                // Only check a LIST field that was actually provided
                if(!error && !this.util.isNull(data[name])){
                    let type = await this.indexerDb.getListType(data[name]);
                    if(type===false)
                        error = 'invalid: ' + name + ' (unknown)';
                    else if(!this.listTypes.includes(type))
                        error = 'invalid: ' + name + ' (unsupported)';
                }
            }
        }

        // When both gating lists are set they must differ: the same list in both
        // slots builds a feed nobody can ever bet on, which looks live in the
        // explorer and only burns pass rows until it expires
        if(!error && !this.util.isNull(data['ALLOW_LIST']) && !this.util.isNull(data['BLOCK_LIST']) && Number(data['ALLOW_LIST'])===Number(data['BLOCK_LIST']))
            error = 'invalid: BLOCK_LIST (same as ALLOW_LIST)';

        // Validate DETAILS (optional): strict base64 wrapping a JSON object whose
        // optional `outcomes` array must agree with the consensus OUTCOMES field
        if(!error && !this.util.isNull(data['DETAILS']))
            error = this.validateDetails(String(data['DETAILS']), outcomeLabels);

        return error;
    },

    /*****************************************************************
     * DETAILS validation
     ****************************************************************/
    // Validate the base64 JSON market definition. Returns an error string or null.
    validateDetails(details, outcomeLabels){
        // Strict base64: charset with = padding, length % 4 == 0, and a re-encode
        // that round-trips byte-identically (rejects non-canonical encodings)
        if(!/^[A-Za-z0-9+/]+={0,2}$/.test(details) || details.length % 4 !== 0)
            return 'invalid: DETAILS (format)';
        let decoded = Buffer.from(details, 'base64');
        if(decoded.toString('base64') !== details)
            return 'invalid: DETAILS (format)';
        if(decoded.length > this.config['MAX_BET_DETAILS_LENGTH'])
            return 'invalid: DETAILS (length)';
        let parsed = null;
        try {
            parsed = JSON.parse(decoded.toString('utf8'));
        } catch(e){
            return 'invalid: DETAILS (json)';
        }
        // Top-level object (not array/scalar) with bounded nesting depth: the depth
        // cap bounds the recursion the SDK schema check and the explorer renderer
        // perform on attacker-chosen input (total walk work is already bounded by
        // MAX_BET_DETAILS_LENGTH)
        if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return 'invalid: DETAILS (json shape)';
        if(this.jsonDepth(parsed) > this.config['MAX_BET_DETAILS_DEPTH'])
            return 'invalid: DETAILS (json shape)';
        // An `outcomes` key must be an array whose labels equal the canonical
        // OUTCOMES exactly (order + count + byte-equal after trim); present-but-
        // not-array is also a mismatch
        if(Object.prototype.hasOwnProperty.call(parsed, 'outcomes')){
            let list = parsed['outcomes'];
            if(!Array.isArray(list) || list.length !== outcomeLabels.length)
                return 'invalid: DETAILS (outcomes mismatch)';
            for(let i = 0; i < list.length; i++){
                if(String(list[i]).trim() !== outcomeLabels[i])
                    return 'invalid: DETAILS (outcomes mismatch)';
            }
        }
        return null;
    },

    // Nesting depth of a parsed JSON value (objects and arrays count one level each)
    jsonDepth(node, depth = 1){
        if(node === null || typeof node !== 'object')
            return depth;
        let max = depth;
        // Early exit once past the cap: bounded work on adversarial input
        for(let key of Object.keys(node)){
            let child = this.jsonDepth(node[key], depth + 1);
            if(child > max) max = child;
            if(max > this.config['MAX_BET_DETAILS_DEPTH']) return max;
        }
        return max;
    }
};
