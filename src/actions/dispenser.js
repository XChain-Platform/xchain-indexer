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
 * XChain Platform Action - DISPENSER
 * 
 * This action creates a dispenser (vending machine) to dispense `TICK` when triggered
 * 
 * PARAMS:
 * VERSION                - Format Version
 * GIVE_COIN              - `COIN` name (BTC, LTC, DOGE, etc)
 * GIVE_TICK              - Ticker name or Ticker ID
 * GIVE_AMOUNT            - Quantity of `GIVE_TICK` to `DISPENSE` when triggered (empty when GIVE_OWNERSHIP=1)
 * GIVE_OWNERSHIP         - 1 = dispense GIVE_TICK ownership (single-shot); GIVE_AMOUNT / GIVE_ESCROW must be empty (default 0)
 * GIVE_ESCROW            - Quantity of `GIVE_TICK` to escrow in dispenser (empty when GIVE_OWNERSHIP=1)
 * GET_COIN               - `COIN` name (BTC, LTC, DOGE, etc)
 * GET_TICK               - Ticker name or Ticker ID
 * GET_AMOUNT             - Quantity of `GET_COIN` or `GET_TICK` required to `DISPENSE`
 * GET_ADDRESS             - Address for dispenser to operate on (default=`SOURCE`)
 * FIAT_CODE              - Code for `FIAT` currency your dispenser is priced in (USD, JPY, GPB, etc.)
 * FIAT_AMOUNT            - Amount of `FIAT` currency required to trigger a `DISPENSE` (ignored when ORACLE_ADDRESS is set)
 * ORACLE_ADDRESS         - Optional address of a user oracle (PRICE v1) that prices the dispensed token in `FIAT_CODE`
 * EXPIRATION             - Timestamp of when dispenser should close, in Unix time
 * ALLOW_LIST             - `ACTION_INDEX` of a `LIST` of addresses allowed to trigger dispenser       
 * BLOCK_LIST             - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to trigger a dispenser 
 * MEMO                   - An optional memo to include                                                
 * DISPENSER_ACTION_INDEX - `ACTION_INDEX` of existing `DISPENSER`                                     
 * 
 * FORMATS:
 * - 0 = Create Dispenser
 * - 1 = Cancel Dispenser
 * - 2 = Edit Dispenser
 *
 ********************************************************************/

const divergenceMetrics = require('../dispenserDivergenceMetrics.js');
const dispenserFreshness = require('../dispenser_freshness_activation.js');
const dispenserCaps = require('../dispenser_caps_activation.js');
const dispenserGiveAmount = require('../dispenser_give_amount_activation.js');
const dispenserOraclePrice = require('../dispenser_oracle_price_activation.js');
const dispenserAmountPositivity = require('../dispenser_amount_positivity_activation.js');

class Dispenser {

    constructor(action){
        this.actions     = action;
        this.config      = action.config;
        this.decoderDb   = action.decoderDb;
        this.indexerDb   = action.indexerDb;
        this.util        = action.util;
        this.mapper      = action.mapper;
        this.utxoTracker = action.utxoTracker || null;
        
        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';
        this.formats[1] = 'VERSION|DISPENSER_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define array of supported list types (1=Tick, 2=Address)
        this.listTypes = [2];
    }

    // Report a below-gate fresh-address verdict that rests on a null get_first_seen
    // from a tracker whose own view is lagging, halted, or of unknown lag.
    //
    // Deliberately a SECOND call rather than switching the verdict itself onto
    // get_first_seen_status: that verdict is replay-frozen (it decides DISPENSER
    // validity already baked into hashed history), so the call feeding it must not
    // change method. A tracker deployed before the sibling existed answers -32601,
    // and the caller's catch turns any throw into isFresh=false, i.e. a rejection
    // of a create the chain already accepted. This call cannot reach that path: it
    // runs after the verdict is fixed, swallows everything, and is skipped entirely
    // when the client has no getFirstSeenStatus.
    //
    // Log-only, in the shape of dispenserDivergenceMetrics: no DB write, no
    // influence on validation, never an input to block hashing.
    async _logStaleFreshness(data){
        try {
            if(!this.utxoTracker || typeof this.utxoTracker.getFirstSeenStatus !== 'function')
                return;
            let status = await this.utxoTracker.getFirstSeenStatus(data['GET_ADDRESS']);
            let sync   = (status && status.sync) || null;
            // Unknown lag is never treated as zero, and an absent sync surface is
            // itself untrustworthy: both mean the tracker could not vouch for the
            // null answer the verdict above rests on.
            if(sync && sync.synced === true && sync.halted !== true && sync.lag !== null)
                return;
            console.log('DISPENSER_FRESHNESS_STALE : addr=' + data['GET_ADDRESS'] +
                        ' block=' + data['BLOCK_INDEX'] +
                        ' synced=' + (sync ? sync.synced : 'unknown') +
                        ' halted=' + (sync ? (sync.halted === true) : 'unknown') +
                        ' lag=' + (sync ? sync.lag : 'unknown') +
                        ' tracker_height=' + (sync ? sync.tracker_height : 'unknown'));
        } catch (e) {
            // Diagnostic only: a failure here must never disturb the frozen verdict.
        }
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // Resolve compacted ^<id> address references (GET_ADDRESS, ORACLE_ADDRESS)
        // back to their canonical address strings before validation/use. At/after the
        // flag-day an unresolvable reference is a hard reject here; below it the
        // value is left as-is and rejected by the isCryptoAddress checks lower down.
        // ORACLE_ADDRESS is exactly why the resolver has to state the verdict: its
        // format check only runs when `usingOracle` is true, so a malformed reference
        // on a non-oracle dispenser rides straight through the legacy path.
        // See resolveAddressRefChecked / caret_ref_strict_activation.js.
        if(!error){
            let getRef = await this.indexerDb.resolveAddressRefChecked(data['GET_ADDRESS'], data['BLOCK_INDEX']);
            data['GET_ADDRESS'] = getRef.value;
            let oracleRef = await this.indexerDb.resolveAddressRefChecked(data['ORACLE_ADDRESS'], data['BLOCK_INDEX']);
            data['ORACLE_ADDRESS'] = oracleRef.value;
            if(getRef.rejected)
                error = 'invalid: GET_ADDRESS (unresolvable ^id)';
            else if(oracleRef.rejected)
                error = 'invalid: ORACLE_ADDRESS (unresolvable ^id)';
        }

        // Default ownership flag to 0 when omitted; coerce to Number for downstream comparisons
        if(format==0)
            data['GIVE_OWNERSHIP'] = this.util.isNull(data['GIVE_OWNERSHIP']) ? 0 : Number(data['GIVE_OWNERSHIP']);
        let isOwnershipGive = (format==0 && data['GIVE_OWNERSHIP']==1);

        // Get information on a dispenser given the COIN network and DISPENSER_ACTION_INDEX
        var dispenserInfo = false;
        if(format==1 || format==2)
            dispenserInfo = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['DISPENSER_ACTION_INDEX'], data['BLOCK_TIME']);

        // Get information on the GIVE and GET tokens
        let info = (format==0) ? data : dispenserInfo;
        let giveTokenInfo = await this.indexerDb.getTokenInfo(info['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let getTokenInfo  = false;

        // Get the GET token info if this is the correct COIN network
        if(info['GET_COIN'] == this.config['COIN'] && !this.util.isNull(info['GET_TICK']))
            getTokenInfo = await this.indexerDb.getTokenInfo(info['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
        if(this.config['COIN']==data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            data['GET_ADDRESS'] = data['SOURCE'];

        // Set default EXPIRATION value if none is given
        if(format==0 && this.util.isNull(data['EXPIRATION']))
            data['EXPIRATION'] = this.util.getDefaultExpiration(data['BLOCK_TIME']);

        // Clone the raw data for storage in dispensers table
        let dispenser = Object.assign({}, data);

        // Validate GIVE_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GIVE_COIN']))
            error = 'invalid: GIVE_COIN (unsupported COIN network)';

        // Validate GET_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GET_COIN']))
            error = 'invalid: GET_COIN (unsupported COIN network)';

        // validate GIVE_COIN network is current COIN network
        if(!error && format==0 && this.config['COIN']!=data['GIVE_COIN'])
            error = "invalid: GIVE_COIN (network)";

        // validate GET_COIN network is current COIN network
        // TODO: cross-chain dispensers (GET_COIN != GIVE_COIN) are not currently wired; this guard enforces same-chain only
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'])
            error = "invalid: GET_COIN (network)";

        // Validate GIVE_TICK exists
        if(!error && format==0 && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Validate GET_TICK exists
        if(!error && format==0 && !this.util.isNull(data['GET_TICK']) && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        // Validate FIAT_CODE is valid
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && this.util.isNull(this.config['FIATS'][data['FIAT_CODE']]))
            error = 'invalid: FIAT_CODE (unsupported FIAT)';

        // Validate FIAT_CODE and FIAT_AMOUNT are both provided or both empty
        // Exception: when ORACLE_ADDRESS is set, the oracle provides the price so FIAT_AMOUNT is optional/ignored
        let usingOracle = !this.util.isNull(data['ORACLE_ADDRESS']);
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && this.util.isNull(data['FIAT_AMOUNT']) && !usingOracle)
            error = 'invalid: FIAT_AMOUNT (required when FIAT_CODE is set without ORACLE_ADDRESS)';
        if(!error && format==0 && this.util.isNull(data['FIAT_CODE']) && !this.util.isNull(data['FIAT_AMOUNT']))
            error = 'invalid: FIAT_CODE (required when FIAT_AMOUNT is set)';

        // ORACLE_ADDRESS rules: only valid for FIAT-denominated dispensers, must be a valid crypto address
        if(!error && format==0 && usingOracle && this.util.isNull(data['FIAT_CODE']))
            error = 'invalid: FIAT_CODE (required when ORACLE_ADDRESS is set)';
        if(!error && format==0 && usingOracle && !this.util.isCryptoAddress(data['ORACLE_ADDRESS']))
            error = 'invalid: ORACLE_ADDRESS (format)';

        // Verify GIVE_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GIVE_AMOUNT']) && giveTokenInfo && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GIVE_ESCROW format. Covers format 2 (edit/refill) too: a refill
        // carries GIVE_ESCROW against the existing dispenser's GIVE_TICK, and an
        // unvalidated non-numeric / over-precision value would reach bcsub and throw,
        // halting the indexer at that block.
        if(!error && (format==0 || format==2) && !this.util.isNull(data['GIVE_ESCROW']) && giveTokenInfo && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_ESCROW']))
            error = "invalid: GIVE_ESCROW (format)";

        // GIVE_OWNERSHIP must be 0 or 1
        if(!error && format==0 && ![0,1].includes(data['GIVE_OWNERSHIP']))
            error = "invalid: GIVE_OWNERSHIP (format)";

        // Ownership dispensers are single-shot: GIVE_AMOUNT and GIVE_ESCROW must be empty,
        // SOURCE must be the current GIVE_TICK owner, and the tick's ownership must not
        // already be escrowed by another offer.
        if(!error && isOwnershipGive){
            if(!this.util.isNull(data['GIVE_AMOUNT']))
                error = "invalid: GIVE_AMOUNT (must be empty when GIVE_OWNERSHIP=1)";
            else if(!this.util.isNull(data['GIVE_ESCROW']))
                error = "invalid: GIVE_ESCROW (must be empty when GIVE_OWNERSHIP=1)";
            else if(!giveTokenInfo)
                error = "invalid: GIVE_TICK (unknown)";
            else if(giveTokenInfo['OWNER'] != data['SOURCE'])
                error = "invalid: SOURCE (not GIVE_TICK owner)";
            else if(await this.indexerDb.isOwnershipEscrowed(data['GIVE_TICK']))
                error = "invalid: GIVE_TICK (ownership already escrowed)";
        }

        // A balance dispenser must hand out something. Empty or "0" GIVE_AMOUNT
        // passed every check above (the format rule at 184 only runs when the field
        // is present, and the block above binds only GIVE_OWNERSHIP=1), and opened a
        // dispenser that settles buyer payments as VALID fills crediting nothing:
        // every downstream guard reads a non-positive GIVE_AMOUNT as "ownership
        // dispenser" and skips (dispense.js giveAmountIsPositive clamp, the
        // bcgt(GIVE_AMOUNT,0) credit/escrow branch), while the auto-close threshold
        // is that same non-positive value, so it never closes and keeps absorbing
        // payments. GIVE_ESCROW is deliberately NOT constrained here: an empty
        // escrow is a legitimate open-now-refill-later dispenser, and with a
        // positive GIVE_AMOUNT the clamp drives the multiplier to 0 so the dispense
        // settles invalid and consumes nothing. Gated (see
        // dispenser_give_amount_activation.js): this rejects creates the engine used
        // to accept, so replay below the flag-day stays byte-identical.
        if(!error && format==0 && !isOwnershipGive &&
           dispenserGiveAmount.isDispenserGiveAmountActive(data['BLOCK_TIME'], this.config['NETWORK']) &&
           (this.util.isNull(data['GIVE_AMOUNT']) || !this.util.bcgt(data['GIVE_AMOUNT'], '0')))
            error = "invalid: GIVE_AMOUNT (required and greater than 0 when GIVE_OWNERSHIP=0)";

        // Verify GET_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GET_AMOUNT']) && getTokenInfo && !this.util.isValidAmountFormat(getTokenInfo['DECIMALS'], data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (format)";

        // Verify a NATIVE-COIN-priced GET_AMOUNT against COIN_DECIMALS, as order.js resolves
        // its native side. The rule above is a conjunct on getTokenInfo, which an empty
        // GET_TICK never loads, so that shape reached storage with no sign or precision
        // check. Gated (dispenser_amount_positivity_activation.js): it rejects creates the
        // ungated engine accepts, so replay below the threshold stays byte-identical.
        let getAmountPositivity = dispenserAmountPositivity.isDispenserAmountPositivityActive(data['BLOCK_TIME'], this.config['NETWORK']);
        if(!error && format==0 && getAmountPositivity && this.util.isNull(data['GET_TICK']) &&
           !this.util.isNull(data['GET_AMOUNT']) && !this.util.isValidAmountFormat(this.config['COIN_DECIMALS'], data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (format)";

        // Require a strictly-positive GET_AMOUNT on a dispenser that names its own price,
        // mirroring the ORDER-AMT-1 rule at order.js. Skipped for FIAT and oracle
        // dispensers, where the price comes from FIAT_AMOUNT or the oracle round and an
        // empty GET_AMOUNT is legitimate. Gated for the same reason as the rule above.
        if(!error && format==0 && getAmountPositivity &&
           this.util.isNull(data['FIAT_CODE']) && this.util.isNull(data['ORACLE_ADDRESS']) &&
           !this.util.bcgt(data['GET_AMOUNT'], '0'))
            error = "invalid: GET_AMOUNT (must be positive)";

        // Verify GET_ADDRESS is given if COIN network differs from GET_COIN network
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS";

        // Verify GET_ADDRESS is valid for the given GET_COIN network
        if(!error && format==0 && !this.util.isNull(data['GET_ADDRESS']) && !this.util.isCryptoAddress(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS (format)";

        // Validate that EXPIRATION is an integer
        if(!error && !this.util.isNull(data['EXPIRATION']) && (!this.util.isNumeric(data['EXPIRATION']) || !this.util.isInteger(data['EXPIRATION'])))
            error = "invalid: EXPIRATION (format)";

        // Validate that FIAT_AMOUNT is in 0.00 format
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && !this.util.isNull(data['FIAT_AMOUNT']) && !this.util.isValidFiatFormat(2, data['FIAT_AMOUNT']))
            error = 'invalid: FIAT_AMOUNT (format)';

        // A Mode B create must name an oracle that already has an EFFECTIVE price. This is
        // a VALIDITY rule, not a pricing one, and it is deliberately checked HERE rather
        // than left to the oracle-fee block below: that block is gated on GIVE_ESCROW > 0,
        // because the fee it computes is sized by the escrow being added. The price
        // precondition has no such scope. An ownership dispenser is REQUIRED to carry an
        // empty GIVE_ESCROW (see the block above) and cannot be refilled later once the
        // caps cohort is active, so before this check existed a GIVE_OWNERSHIP=1 create
        // naming a never-priced oracle was accepted outright: it escrowed the tick's
        // ownership behind a dispenser that can never settle (reverseOraclePriceMatch
        // finds no row) and used the oracle for free. Same for an open-now-refill-later
        // balance create.
        //
        // Deliberately NOT gated on data['FEE_PROBE']. Unlike the fee block's OUTPUT half,
        // an effective oracle price is knowable in advance and is the one verdict a caller
        // can act on ("publish, wait out the 24h window, then create"), so the read-only
        // quote/preflight surfaces must report it too rather than green-light a create the
        // chain will reject.
        //
        // format-0 only. An escrow-bearing format-2 refill already reaches the same rule
        // through the fee path, and checking every edit unconditionally would newly reject
        // expiration-only or list-only edits on a dispenser whose oracle is perfectly fine.
        //
        // Gated (see dispenser_oracle_price_activation.js): this rejects creates the engine
        // used to accept, so replay below the flag-day stays byte-identical.
        if(!error && format==0 && !this.util.isNull(data['ORACLE_ADDRESS']) &&
           dispenserOraclePrice.isDispenserOraclePriceActive(data['BLOCK_TIME'], this.config['NETWORK']) &&
           await this.actions.protocolChanges.isEnabled('FIAT_DISPENSER_PRICING', data['BLOCK_INDEX'])){
            let priceCheck = await this.util.requireEffectiveOraclePrice(data['BLOCK_TIME'], {
                ORACLE_ADDRESS: data['ORACLE_ADDRESS'],
                GIVE_COIN:      data['GIVE_COIN'],
                GIVE_TICK:      data['GIVE_TICK'],
                FIAT_CODE:      data['FIAT_CODE'],
            }, this.indexerDb);
            if(!priceCheck.valid)
                error = priceCheck.error;
        }

        // PRICE v1 oracle usage fee, Counterparty parity: a Mode B dispenser
        // pays the oracle operator UP FRONT, as a real native-coin output, charged to the
        // address opening (or refilling) it rather than to buyers per dispense. The fee
        // scales with the escrow this action adds, so a refill pays for what it adds and
        // an opener cannot escrow one token, pay nothing, then top up to millions.
        //
        // Gated with the rest of FIAT settlement: below activation no fee is owed and the
        // create behaves exactly as it did before this rule existed.
        //
        // v0 charges on the opening GIVE_ESCROW; v2 charges on its refill amount, read
        // from the existing dispenser for the fields the edit format does not carry.
        // Ownership dispensers escrow no balance (GIVE_ESCROW empty), so nothing is owed.
        if(!error && (format==0 || format==2) && !this.util.isNull(data['GIVE_ESCROW']) &&
           this.util.bcgt(data['GIVE_ESCROW'], '0') &&
           await this.actions.protocolChanges.isEnabled('FIAT_DISPENSER_PRICING', data['BLOCK_INDEX'])){
            let oracleAddress = (format==0) ? data['ORACLE_ADDRESS'] : (dispenserInfo ? dispenserInfo['ORACLE_ADDRESS'] : null);
            if(!this.util.isNull(oracleAddress)){
                let feeDispenser = {
                    ORACLE_ADDRESS: oracleAddress,
                    GIVE_COIN:      (format==0) ? data['GIVE_COIN'] : dispenserInfo['GIVE_COIN'],
                    GIVE_TICK:      (format==0) ? data['GIVE_TICK'] : dispenserInfo['GIVE_TICK'],
                    FIAT_CODE:      (format==0) ? data['FIAT_CODE'] : dispenserInfo['FIAT'],
                    GET_COIN:       (format==0) ? data['GET_COIN']  : dispenserInfo['GET_COIN'],
                    GIVE_ESCROW:    data['GIVE_ESCROW'],
                };
                // A read-only dry run (the public feequote / preflight surfaces) has no
                // transaction behind it and therefore no outputs, so the OUTPUT half of this
                // check can only ever fail there - and what it demands is the very amount the
                // refused quote exists to compute, so no client can satisfy it. Check the
                // half that IS knowable in advance (the oracle has an effective price, and
                // there is a validator price to value its fee against, both of which a caller
                // can act on) and skip the half that structurally cannot exist yet. The
                // native-coin fee check gets a probe OUTPUT for the same reason
                // (actions.js _dryRunAction); this one cannot, because ORACLE_ADDRESS may be
                // a ^id reference that is only resolved above.
                let feeCheck = data['FEE_PROBE']
                    ? await this.util.quoteOracleFee(data['BLOCK_TIME'], feeDispenser, this.indexerDb)
                    : await this.util.validateOracleFee(data, feeDispenser, this.indexerDb);
                if(!feeCheck.valid)
                    error = feeCheck.error;

                // Probe-only disclosure (spec row 46). quoteOracleFee reads no output, so it
                // cannot see what a SIBLING sub-command in the same batch already owes the same
                // oracle: N Mode B DISPENSERs naming one oracle each quote the same single fee
                // as covered, where validateOracleFee makes N commands' worth cover exactly N.
                // The probe cannot close that by tallying against an output it does not have,
                // so it reports the SUM owed per oracle instead and leaves the judgement to the
                // composer. A probe-LOCAL object, never data['BATCH_VALUE_LEDGER']: writing
                // that one would be a read-only surface mutating consensus state, and its
                // presence is what three other readers use to mean "inside a batch".
                // Accumulated only when a fee is actually owed, matching validateOracleFee's
                // own belowDust early-return, which spends nothing and tallies nothing.
                if(data['FEE_PROBE'] && feeCheck.valid && !feeCheck.belowDust){
                    if(!data['PROBE_ORACLE_FEES']) data['PROBE_ORACLE_FEES'] = {};
                    let owed = data['PROBE_ORACLE_FEES'][oracleAddress] || '0';
                    data['PROBE_ORACLE_FEES'][oracleAddress] =
                        this.util.bcformat(this.util.bcadd(owed, feeCheck.expectedFee, 8), 8);
                }
            }
        }


        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && format==0 && await this.indexerDb.isActionAllowed(null, data['GIVE_TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Verify TICK action is allowed from SOURCE (allow/block lists)
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Verify TICK action is allowed from GET_ADDRESS (allow/block lists)
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['GET_ADDRESS'], data['GIVE_TICK']) == false)
            error = 'invalid: GET_ADDRESS (not authorized)';

        // Verify SOURCE may open a dispenser on GET_ADDRESS.
        // SOURCE == GET_ADDRESS: always allowed (owner self-opening).
        // Otherwise: GET_ADDRESS must either set DISPENSER_PREFERENCE=2 (anyone),
        // be a fresh address (no prior on-chain activity as of BLOCK_INDEX − 1),
        // or (DISPENSER_ORIGIN_STANDING) SOURCE must be the address's established
        // origin: the SOURCE of a prior VALID dispenser create on GET_ADDRESS.
        // Freshness is spent after the first create; origin standing is what
        // lets the same main address keep opening dispensers on its sub-address.
        if(!error && format==0 && data['GET_ADDRESS']!=data['SOURCE']){
            let getPrefs = await this.indexerDb.getAddressPreferences(data['GET_ADDRESS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(Number(getPrefs['DISPENSER_PREFERENCE']) !== 2){
                let isFresh = false;
                // Freshness causality flag-day (see dispenser_freshness_activation.js).
                // At/after the gate the verdict derives from
                // deterministic indexer-local chain state (no XChain activity strictly
                // before BLOCK_INDEX); the external utxo-tracker is NEVER consulted. Below
                // the gate the legacy tracker HTTP path runs byte-identically so historical
                // replay is preserved.
                if(dispenserFreshness.isDispenserFreshnessLocalActive(data['BLOCK_INDEX'], this.config['NETWORK'], this.config['COIN'])){
                    isFresh = !(await this.indexerDb.hasXChainActivityBefore(data['GET_ADDRESS'], data['BLOCK_INDEX']));
                } else if(this.utxoTracker && this.utxoTracker.enabled){
                    try {
                        let firstSeen = await this.utxoTracker.getFirstSeen(data['GET_ADDRESS']);
                        isFresh = !firstSeen || firstSeen.height >= data['BLOCK_INDEX'];
                        // get_first_seen answers null both for "never appeared on chain"
                        // and for "this tracker has not indexed that far yet, or is halted
                        // on an unwinding reorg", so a fresh-by-null verdict computed
                        // against a lagging tracker is a false positive that leaves no
                        // trace (the catch below only fires on a hard RPC failure, not on
                        // a stale-but-successful answer). Record when that happened.
                        // Log-only, and never an input to isFresh.
                        if(isFresh && !firstSeen)
                            await this._logStaleFreshness(data);
                    } catch (err) {
                        console.log('WARNING: utxo-tracker get_first_seen failed for ' + data['GET_ADDRESS'] + ': ', err);
                    }
                }
                let hasStanding = false;
                if(!isFresh && await this.actions.protocolChanges.isEnabled('DISPENSER_ORIGIN_STANDING', data['BLOCK_INDEX']))
                    hasStanding = await this.indexerDb.hasDispenserOriginStanding(data['SOURCE'], data['GET_ADDRESS'], data['ACTION_INDEX']);
                if(!isFresh && !hasStanding)
                    error = 'invalid: GET_ADDRESS (dispenser not permitted)';
            }
        }

        // Validate DISPENSER_ACTION_INDEX is valid dispenser
        if(!error && (format==1 || format==2) && !dispenserInfo)
            error = 'invalid: DISPENSER_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the DISPENSER_ACTION_INDEX dispenser
        if(!error && format!=0 && data['SOURCE']!=dispenserInfo['SOURCE'] && data['SOURCE']!=dispenserInfo['GET_ADDRESS'])
            error = 'invalid: SOURCE (not owner)';

        // Validate DISPENSER_ACTION_INDEX is valid dispenser with a status of open
        if(!error && format!=0 && dispenserInfo['DISPENSER_STATUS']!='open')
            error = 'invalid: DISPENSER_ACTION_INDEX (dispenser not open)';

        // An ownership dispenser never holds balance escrow, on edit as on create.
        // isOwnershipGive is format-0 only, so a format-2 edit of an ownership
        // dispenser fell through as an ordinary refill: it debited GIVE_ESCROW
        // (below) while both terminal paths take the GIVE_OWNERSHIP branch that
        // credits nothing back (dispenser_close.js / dispenser_expire.js), stranding
        // the balance and breaking deposit = dispensed + remaining + refunded.
        // Mirrors the create-time rule verbatim rather than widening
        // isOwnershipGive, which would route these edits through the create-time
        // ownership block and wrongly reject expiration-only or list-only edits on
        // its isOwnershipEscrowed check. Gated with the dispenser-family cohort,
        // like MAX_REFILLS below, so replay below the flag-day stays byte-identical.
        if(!error && format==2 && Number(dispenserInfo['GIVE_OWNERSHIP']||0)==1 &&
           !this.util.isNull(data['GIVE_ESCROW']) &&
           dispenserCaps.isDispenserCapsActive(data['BLOCK_TIME'], this.config['NETWORK']))
            error = "invalid: GIVE_ESCROW (must be empty when GIVE_OWNERSHIP=1)";

        // MAX_REFILLS cap (see dispenser_caps_activation.js). A refill is a
        // format-2 DISPENSER_EDIT that tops up GIVE_ESCROW; each refill resets the
        // dispense count (derived since the last refill in dispense.js), and the 6th
        // refill is rejected (Counterparty parity). Rate/give-quantity are inherently
        // unchanged (format-2 edits carry only give_escrow/expiration/lists, never
        // give_amount/get_amount) and owner authority is enforced above. Gated with the
        // dispenser-family cohort so historical replay stays byte-identical below it.
        if(!error && format==2 && !this.util.isNull(data['GIVE_ESCROW']) &&
           this.util.bcgt(data['GIVE_ESCROW'], 0) &&
           dispenserCaps.isDispenserCapsActive(data['BLOCK_TIME'], this.config['NETWORK'])){
            let refills = await this.indexerDb.getDispenserRefillCount(data['DISPENSER_ACTION_INDEX']);
            if(refills >= this.config['MAX_REFILLS'])
                error = 'invalid: MAX_REFILLS (dispenser refill limit reached)';
        }

        // Validate that EXPIRATION is greater than current BLOCK_TIME
        if(!error && !this.util.isNull(data['EXPIRATION']) && this.util.bclte(data['EXPIRATION'], data['BLOCK_TIME']))
            error = "invalid: EXPIRATION (past)";

        // Validate LIST fields (ALLOW_LIST / BLOCK_LIST)
        if(!error){
            for(let name of this.config['LIST_FIELDS']){
                if(!error && !this.util.isNull(data[name]) && this.util.isNumeric(data[name])){
                    // Get LIST type and information
                    let type = await this.indexerDb.getListType(data[name]);

                    // Verify LIST exist
                    if(!error && type===false)
                        error = 'invalid: ' + name + ' (unknown)';

                    // Verify LIST type is supported
                    if(!error && !this.listTypes.includes(type))
                        error = 'invalid: ' + name + ' (unsupported)';
                }
            }
        }

        // Verify SOURCE has enough balances to cover GIVE_ESCROW (skip for ownership: no balance to escrow)
        if(!error && !isOwnershipGive && !this.util.isNull(data['GIVE_ESCROW']) && !this.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_ESCROW']))
            error = 'invalid: insufficient funds (GIVE_ESCROW)';

        // Adjust balances to reduce by dispenser GIVE_ESCROW (skip for ownership)
        if(!error && !isOwnershipGive && !this.util.isNull(data['GIVE_ESCROW']))
            balances = this.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_ESCROW']);

        // Calculate total fee for this dispenser (expiration + ownership-escrow premium, create only)
        fees['AMOUNT'] = 0;

        if(!error){
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                let gasCost = 0;
                let fee     = 0;
                if(!this.util.isNull(data['EXPIRATION'])){
                    let exp = this.util.getUnifiedExpirationFee(data, dispenserInfo);
                    gasCost = this.util.bcadd(gasCost, exp.gasCost, 0);
                    fee     = this.util.bcadd(fee, exp.fee, 8);
                }
                if(format==0 && isOwnershipGive){
                    let own = this.util.getOwnershipEscrowFee();
                    gasCost = this.util.bcadd(gasCost, own.gasCost, 0);
                    fee     = this.util.bcadd(fee, own.fee, 8);
                }
                fees['GAS_COST']    = gasCost;
                fees['AMOUNT']      = fee;
                fees['FEE_VERSION'] = 2;
            } else if(!this.util.isNull(data['EXPIRATION'])){
                fees['AMOUNT'] = this.util.getExpirationFee(data, dispenserInfo);
            }
        }

        // Validate fee payment (native coin or XCHAIN balance)
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
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Controller-bound GIVE token: the bound contract's `guard` must approve
        // opening a dispenser that sells this token before it opens. This guard is
        // VETO-ONLY at create: only result.error and result.guardFee are consumed
        // below; the guard's payoutLegs are intentionally discarded here.
        // SOURCE pays the bounded guard gas (reserved up front).
        //
        // KNOWN GAP: unlike ORDER and SWAP sales of a controller-bound token
        // (which persist payout_legs at create and apply the royalty split at match
        // time via applyProceedsSplit), DISPENSER sales apply NO royalty/proceeds
        // split. dispense.js has no royalty path: it credits the give token to the
        // buyer directly, and dispense proceeds are native coin paid directly
        // on-chain. So a controller cannot veto or take a cut per buy at dispense
        // time. TODO: if dispenser sales must honor the royalty split, that needs
        // dedicated design for a per-buy split/veto over native-coin proceeds; it is
        // NOT implemented today. Do not read this comment as an enforced invariant.
        let guardFee = 0;
        if(!error && format==0 && giveTokenInfo){
            let gasInfo = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let result  = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                actionType:   'DISPENSER_CREATE',
                tick:         data['GIVE_TICK'],
                from:         data['SOURCE'],
                to:           '',
                amount:       isOwnershipGive ? '' : data['GIVE_ESCROW'],
                price:        data['GET_AMOUNT'],
                proceedsTick: data['GET_TICK'],
                data:         data,
                gasInfo:      gasInfo,
                gasBalances:  balances
            });
            if(result.error)
                error = 'invalid: ' + result.error;
            else
                guardFee = result.guardFee;
        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = dispenser['STATUS'] = status;

        // Set DISPENSER status to 'open' when creating a valid dispenser
        dispenser['DISPENSER_STATUS'] = (status=='valid') ? 'open' : 'invalid';

        // Print status message
        if(format==0)
            console.log("\t DISPENSER : " + this.util.logAmount(data['GIVE_AMOUNT']) + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  this.util.logAmount(data['GET_AMOUNT']) + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
        if(format==1)
            console.log("\t DISPENSER_CANCEL : " + this.config['COIN'] + ':' + data['DISPENSER_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t DISPENSER_EDIT : " + this.config['COIN'] + ':' + data['DISPENSER_ACTION_INDEX'] + ' : ' + data['STATUS']);
 
        // Create record in dispensers table
        if(format==0)
            await this.indexerDb.createDispenser(dispenser);

        // Update action from DISPENSER to DISPENSER_CANCEL and create record in dispenser_cancels table
        if(format==1){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'DISPENSER_CANCEL');
            await this.indexerDb.createDispenserCancel(dispenser);
        }

        // Update action from DISPENSER to DISPENSER_EDIT and create record in dispenser_edits table
        if(format==2){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'DISPENSER_EDIT');
            await this.indexerDb.createDispenserEdit(dispenser);

            // Observability: a valid edit that re-dates EXPIRATION moves the indexer's
            // effective expiry while the upstream decoder still holds the original. Log
            // the change (old vs new, shortened vs lengthened) so this half of the split
            // can be sized from logs. dispenserInfo['EXPIRATION'] is the current effective
            // value (prior edits applied). Measurement only - no state change.
            if(status=='valid' && !this.util.isNull(data['EXPIRATION']) && dispenserInfo &&
               Number(data['EXPIRATION']) !== Number(dispenserInfo['EXPIRATION']))
                divergenceMetrics.recordExpirationEdit(this.config['COIN'], data['BLOCK_INDEX'],
                    data['DISPENSER_ACTION_INDEX'], dispenserInfo['GET_ADDRESS'],
                    dispenserInfo['EXPIRATION'], data['EXPIRATION']);
        }

        // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
        if(format==0){
            this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
            this.util.addAddressTicker(data['GET_ADDRESS'], [data['GIVE_TICK'], data['GET_TICK']]);
        } else {
            this.util.addAddressTicker(dispenserInfo['SOURCE'], [dispenserInfo['GIVE_TICK'], dispenserInfo['GET_TICK']]);
            this.util.addAddressTicker(dispenserInfo['GET_ADDRESS'], [dispenserInfo['GIVE_TICK'], dispenserInfo['GET_TICK']]);
        }

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid'){

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Debit GIVE_ESCROW GIVE_TICK from SOURCE and add to escrow (skip for ownership)
            if((format==0||format==2) && !isOwnershipGive && !this.util.isNull(data['GIVE_ESCROW'])){
                debits.push([giveTokenInfo['TICK'], data['GIVE_ESCROW'], data['SOURCE']]);
                escrows.push([giveTokenInfo['TICK'], data['GIVE_ESCROW'], data['SOURCE']]);
            }

            // Format 0 - Create Dispenser
            if(format==0){
                if(isOwnershipGive){
                    // Ownership dispenser: no balance escrow; mark the tick as ownership-escrowed
                    // for this dispenser. tokens.owner_id stays at SOURCE; admin actions are gated
                    // by escrow_action_index until DISPENSE / cancel / expire clears it.
                    await this.indexerDb.setTokenEscrow(data['GIVE_TICK'], data['ACTION_INDEX']);
                }
                await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
            }

            // Format 1 - Cancel Dispenser
            // Note: Dispenser remains open for a set amount of time (DISPENSER_CLOSE_DELAY) before being closed.
            // Record SOURCE as the canceller so dispenser_close can route escrow per DISPENSER.md rules.
            if(format==1)
                await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], dispenserInfo['ACTION_INDEX'], 'cancelling', data['SOURCE']);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Bill the controller-guard gas to SOURCE (in GAS), reserved above.
            if(this.util.bcgt(guardFee, 0)){
                debits.push([this.config['GAS'], guardFee, data['SOURCE']]);
                this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);
            }

            // Process any transaction ledger changes (credits / debits / escrows)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            // Get a list of tickers & addresses
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // Update address balances and token supply
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);

        }

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Dispenser;