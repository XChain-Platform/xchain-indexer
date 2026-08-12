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
 * XChain Platform Action - SEND
 *
 * This action sends one or more `TICK` to an `ADDRESS`.
 *
 * PARAMS:
 * - VERSION     - Format Version
 * - TICK        - Ticker name or Ticker ID
 * - AMOUNT      - Amount of `tokens` to send
 * - DESTINATION - Address to transfer `tokens` to
 * - MEMO        - An optional memo to include
 *
 * FORMATS:
 * - 0 = Single Send
 * - 1 = Multi-Send (Brief)
 * - 2 = Multi-Send (Full)
 * - 3 = Multi-Send (Full) with Multiple Memos
 *
 ********************************************************************/

class Send {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO';
        this.formats[1] = 'VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|DESTINATION|TICK|AMOUNT|DESTINATION|MEMO';
        this.formats[3] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO|TICK|AMOUNT|DESTINATION|MEMO';
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Array of sends [TICK, AMOUNT, DESTINATION, MEMO]
        let sends = [];

        // Extract memo
        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==4) || (format==1 && idx%2==0) || (format==2 && idx%3==1)))
                memo = params[idx];

        // If we encountered an invalid version error add it to the sends list so we create a record of it in sends
        if(error)
            sends.push([params[0], params[1], memo]);

        let lastIdx = params.length - 1;
        for(let idx in params){
            // Force index to integer value (for-in yields string keys)
            idx = parseInt(idx);

            // Single Send
            if(format==0 && idx==0)
                sends.push([params[1], params[2], params[3], memo]);

            // Multi-Send (Brief)
            if(format==1 && idx>1 && idx%2==1)
                sends.push([params[1], params[idx-1], params[idx], memo]);

            // Multi-Send (Full)
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                sends.push([params[idx], params[(idx+1)], params[idx+2], memo]);

            // Multi-Send (Full) with Multiple Memos
            if(format==3 && idx>0 && idx%4==1 && idx < lastIdx)
                sends.push([params[idx], params[idx+1], params[idx+2], params[idx+3]]);
        }

        // Get token data for every TICK (reduces duplicated sql queries)
        let ticks = {};
        for(let send of sends){
            let tick = send[0];
            if(ticks[tick] === undefined)
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Get address preferences for all destination addresses (used in MEMO requirement check)
        let preferences = {};
        for(let send of sends){
            let destination = send[2];
            if(!preferences[destination])
                preferences[destination] = await this.indexerDb.getAddressPreferences(destination, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Get active gated key hashes for every TICK (reduces duplicated sql queries).
        // The gate is a property of the TICK, not of the leg, so an N-recipient SEND
        // needs O(distinct ticks) queries, not one per leg. Same dedupe pattern as
        // `ticks` and `preferences` above; SEND runs on every ~5s index tick, so the
        // per-leg form scaled per-block DB work with recipient count.
        let gatedPacks = {};
        for(let send of sends){
            let tick = send[0];
            if(gatedPacks[tick] === undefined)
                gatedPacks[tick] = await this.indexerDb.getGatedPackThresholds(tick);
        }

        // Consolidate sends by DESTINATION and TICK
        let keys = {};
        for(let info of sends){
            let [tick, amount, destination, memo] = info;
            let key = destination + '|' + tick;
            if(!this.util.isNull(keys[key]))
                amount = this.util.bcadd(amount, keys[key][1], ticks[tick] && ticks[tick]['DECIMALS']);
            keys[key] = [tick, amount, destination, memo];
        }

        sends = [];
        for(let key in keys)
            sends.push(keys[key]);

        // PC-29 rule 3: the destination's PRE-SEND balance, snapshotted once here,
        // before any leg of this action settles. Scoping by (BLOCK_INDEX, ACTION_INDEX)
        // is what makes the snapshot base right: it includes every preceding
        // transaction in the block AND every preceding action in this transaction, so
        // two SEND actions of the same tick in one transaction COMPOUND rather than
        // both reading the pre-transaction balance. Validating against pre-tx state
        // would reopen the split-the-amount bypass one level up.
        //
        // Only fetched when the tick actually has gated packs: an ungated SEND must not
        // pay for a destination-balance read on every leg.
        let destBalances = {};
        for(let send of sends){
            let [tick, , destination] = send;
            if((gatedPacks[tick] || []).length === 0) continue;
            if(destBalances[destination] !== undefined) continue;
            destBalances[destination] = await this.indexerDb.getAddressBalances(
                destination, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Controller-bound token gas context. A SEND of a token whose `transfer` class is bound to
        // a controller runs that contract's `guard` before settling; the SOURCE pays the (bounded)
        // guard gas. Load the SOURCE's GAS balance once so a multi-send debits it cumulatively
        // across controlled legs (maybeRunControllerGuard reserves the ceiling against it).
        let gasTick      = this.config['GAS'];
        let gasInfo      = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let gasBalances  = await this.indexerDb.getAddressBalances(data['SOURCE'], gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        let origError = error;

        // SOURCE sleeping-state check is byte-identical for every leg (same SOURCE, same
        // BLOCK_INDEX, tick arg null), so run it once here instead of once per leg. Read-only,
        // so hoisting it out of the loop does not change any leg's validation outcome; each leg
        // still gates on it under its own !error guard below. Same motive as the ticks/
        // preferences/gatedKeyHashes dedupe above: SEND runs on every ~5s index tick and the
        // per-leg form scaled per-block DB work with recipient count.
        let sourceActionAllowed = await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']);

        // Memoize the TICK sleeping-state check per distinct tick. The check depends only on
        // (TICK, BLOCK_INDEX); BLOCK_INDEX is fixed for the tx, so a repeated tick reuses the
        // first result. A multi-send of the same tick to N recipients now costs one query, not N.
        let tickActionAllowed = {};

        // Memoize the SOURCE-side allow/block-list check per distinct tick, same motive.
        // It depends only on (SOURCE, TICK): SOURCE is fixed for the whole action (send is
        // an alias of data and only TICK/AMOUNT/DESTINATION are re-set per leg), and the
        // call passes no block_index, so the answer cannot change across legs of one tick.
        // Each miss costs a getTokenInfo plus up to two getList reads, so a Multi-Send
        // (Brief) to N recipients was paying up to 3N round-trips for one answer.
        let sourceTickAllowed = {};

        let credits = [],
            debits  = [];

        for(let idx in sends){

            let info = sends[idx];

            // Reset error to the original value (per-leg validation restarts from origError)
            error = origError;

            // Guard gas fee billed to SOURCE for this leg (0 = uncontrolled token)
            let guardFee = 0;

            // `send` aliases `data`: mutating it below also mutates the shared transaction
            // object, which the multi-leg loop relies on for each leg's downstream calls.
            let send = data;

            send['TICK']        = info[0];
            send['AMOUNT']      = info[1];
            send['DESTINATION'] = info[2];
            send['MEMO']        = info[3];

            // Convert NUMBER fields from string value to number value so comparisons are mathematical
            if(!error)
                send = this.util.setNumberFormats(send);

            let tokenInfo = ticks[send['TICK']];

            if(!error && !tokenInfo)
                error = 'invalid: TICK (unknown)';

            if(!error && !this.util.isNull(send['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], send['AMOUNT']))
                error = "invalid: AMOUNT (format)";

            if(!error && !this.util.isNull(send['DESTINATION']) && !this.util.isCryptoAddress(send['DESTINATION']))
                error = "invalid: DESTINATION (format)";

            // Verify SOURCE is not sleeping (hoisted, byte-identical across legs)
            if(!error && sourceActionAllowed == false)
                error = 'invalid: SOURCE (sleeping)';

            // Verify TICK is not sleeping (memoized per distinct tick for the tx's BLOCK_INDEX)
            if(!error){
                if(tickActionAllowed[send['TICK']] === undefined)
                    tickActionAllowed[send['TICK']] = await this.indexerDb.isActionAllowed(null, send['TICK'], send['BLOCK_INDEX']);
                if(tickActionAllowed[send['TICK']] == false)
                    error = 'invalid: TICK (sleeping)';
            }

            // Verify TICK action is allowed from SOURCE (allow/block lists, memoized per distinct tick)
            if(!error){
                if(sourceTickAllowed[send['TICK']] === undefined)
                    sourceTickAllowed[send['TICK']] = await this.indexerDb.isActionAllowed(send['SOURCE'], send['TICK']);
                if(sourceTickAllowed[send['TICK']] == false)
                    error = 'invalid: SOURCE (not authorized)';
            }

            // Verify TICK action is allowed to DESTINATION (allow/block lists)
            if(!error && await this.indexerDb.isActionAllowed(send['DESTINATION'], send['TICK']) == false)
                error = 'invalid: DESTINATION (not authorized)';

            // Verify no pipe in MEMO (pipe is field delimiter)
            if(!error && String(send['MEMO']).indexOf('|')!=-1)
                error = 'invalid: MEMO (pipe)';

            // Verify no semicolon in MEMO (semicolon is action delimiter)
            if(!error && String(send['MEMO']).indexOf(';')!=-1)
                error = 'invalid: MEMO (semicolon)';

            if(!error && String(send['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
                error = 'invalid: MEMO (length)';

            if(!error && preferences[send['DESTINATION']]['REQUIRE_MEMO']==1 && this.util.isNull(send['MEMO']))
                error = 'invalid: MEMO (required)';

            if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], send['AMOUNT']))
                error = 'invalid: insufficient funds';

            // Gated-content rule: if TICK has any active gated FILEs, this
            // SEND must be inside the same tx as a MESSAGE v2 addressed to
            // DESTINATION carrying the key handoff payload. The indexer only
            // checks structural presence; the wallet verifies cryptographic
            // correctness at unlock time.
            // See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
            if(!error){
                let packs = gatedPacks[send['TICK']] || [];
                if(packs.length > 0){
                    // PC-29 rule 3-5: the handoff is now CONDITIONAL. Previously ANY gated FILE
                    // on a tick made EVERY send of it require a handoff; now a pack only compels
                    // one when the recipient will actually end up able to unlock it, judged on
                    // POST-SEND balance (pre-send balance + everything this action sends them),
                    // since a recipient who already holds enough crosses the threshold on any
                    // transfer and one who holds nothing may not cross it even on a large one.
                    // send['AMOUNT'] is already the TOTAL for this (DESTINATION, TICK) pair
                    // (legs were CONSOLIDATED further up), which is what closes the
                    // split-into-many-small-sends bypass; a test vector pins that consolidation
                    // so it cannot silently regress. Self-send is deliberately NOT special-cased:
                    // the rule applies literally, the resulting overcount is accepted for
                    // determinism, and a sender's self-addressed MESSAGE satisfies the requirement.
                    let destBal = destBalances[send['DESTINATION']] || {};
                    let held    = destBal[tokenInfo['TICK_ID']];
                    if(this.util.isNull(held)) held = '0';
                    let postSend = this.util.bcadd(held, send['AMOUNT'], 18);

                    // Rule 4: a pack is REQUIRED when it is unconditional (no
                    // threshold at all) or the post-send balance reaches its
                    // threshold. Rule 5: the MESSAGE is required iff ANY pack is.
                    let required = false;
                    for(let pack of packs){
                        if(pack.threshold === null){ required = true; break; }
                        if(!this.util.bclt(postSend, pack.threshold)){ required = true; break; }
                    }

                    if(required){
                        let siblings = data['SIBLING_ACTIONS'] || [];
                        let foundHandoff = false;
                        for(let s of siblings){
                            if(s.action !== 'MESSAGE') continue;
                            // MESSAGE v2 fields: VERSION|COIN|DESTINATION|ENCRYPTED_MESSAGE
                            // (s.params[0]=VERSION, [1]=COIN, [2]=DESTINATION, [3]=ENCRYPTED_MESSAGE)
                            let ver  = String(s.params[0] || '');
                            let dest = String(s.params[2] || '');
                            if(ver === '2' && dest === send['DESTINATION']){
                                foundHandoff = true;
                                break;
                            }
                        }
                        if(!foundHandoff)
                            error = 'invalid: gated token transfer requires key handoff message';
                    }
                }
            }

            // Controller-bound token: defer to the bound contract's `guard` method
            // before the transfer settles. The guard may DENY (revert) or run
            // programmable side effects (state writes, royalty/fee emissions). It is
            // the final gate: all other validation has passed when it runs, so an
            // allow leads directly to a valid send. SOURCE must have reserved the
            // guard gas ceiling fee (mirrors the cross-contract-call reservation) so
            // a cheap/denied guard never drives GAS negative; the actual metered fee
            // is billed in the valid block below.
            //
            // `balances` (all ticks) and `gasBalances` (GAS only) are two independent
            // in-memory snapshots. When the token being sent IS the gas token they both
            // track the exact same underlying balance, so reserving/debiting the guard
            // fee against the separate `gasBalances` snapshot lets AMOUNT and guardFee
            // each pass their checks against a full, undebited copy of the same balance
            // and be spent twice. Mirror the airdrop/dividend/sweep pattern: when the
            // send tick equals the gas tick, reserve and debit the guard fee against a
            // clone of `balances` that is already pre-debited by this leg's AMOUNT, so a
            // single balance must cover AMOUNT + guardFee together.
            let sameTick = !!(gasInfo && tokenInfo && String(gasInfo['TICK_ID']) === String(tokenInfo['TICK_ID']));
            let baseGasBalances = gasBalances;
            if(sameTick && !error)
                baseGasBalances = this.util.debitBalances(Object.assign({}, balances), tokenInfo['TICK_ID'], send['AMOUNT']);

            if(!error && tokenInfo){
                let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'SEND',
                    tick:        send['TICK'],
                    from:        send['SOURCE'],
                    to:          send['DESTINATION'],
                    amount:      send['AMOUNT'],
                    data:        send,
                    gasInfo:     gasInfo,
                    gasBalances: baseGasBalances,
                    seq:         parseInt(idx) || 0
                });
                if(result.error)
                    error = 'invalid: ' + result.error;
                else
                    guardFee = result.guardFee;
            }

            // SOURCE-side gate: the SENDER's own `transfer` address-controller may gate its OUTBOUND
            // transfers (self-imposed spending controls: velocity, allowlists, compliance). Runs
            // after the token's guard, before the recipient gate. A single `transfer` address binding
            // it fires whether the account is SOURCE (here) or DESTINATION (below); the
            // guard distinguishes direction via its from/to (from === subject ⇒ outbound). SOURCE pays
            // the guard gas, reserved cumulatively after this leg's token guardFee (a shallow clone, so
            // gasBalances only commits in the valid block) so GAS can't be driven negative.
            if(!error && !this.util.isNull(send['SOURCE'])){
                let reserveBalances = baseGasBalances;
                if(gasInfo && this.util.bcgt(guardFee, 0))
                    reserveBalances = this.util.debitBalances(Object.assign({}, baseGasBalances), gasInfo['TICK_ID'], guardFee);
                let outbound = await this.util.maybeRunAddressControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'SEND',
                    actionClass: 'transfer',
                    address:     send['SOURCE'],
                    tick:        send['TICK'],
                    from:        send['SOURCE'],
                    to:          send['DESTINATION'],
                    amount:      send['AMOUNT'],
                    data:        send,
                    gasInfo:     gasInfo,
                    gasBalances: reserveBalances,
                    seq:         parseInt(idx) || 0
                });
                if(outbound.error)
                    error = 'invalid: ' + outbound.error;
                else
                    guardFee = this.util.bcadd(guardFee, outbound.guardFee, 8);
            }

            // Recipient-side gate: the DESTINATION's own `transfer` address-controller may refuse an
            // incoming direct SEND it didn't solicit (spam/compliance). Refusal reverts this leg;
            // SOURCE pays the guard gas. Its reservation runs against the GAS balance ALREADY reduced
            // by this leg's token guardFee (a shallow clone, so gasBalances only commits in the valid
            // block), keeping the two-guard reservation cumulative so GAS can't be driven negative.
            // DEX/dispense deliveries are solicited pulls, not direct sends, so they are never gated.
            if(!error && !this.util.isNull(send['DESTINATION'])){
                let reserveBalances = baseGasBalances;
                if(gasInfo && this.util.bcgt(guardFee, 0))
                    reserveBalances = this.util.debitBalances(Object.assign({}, baseGasBalances), gasInfo['TICK_ID'], guardFee);
                let recip = await this.util.maybeRunAddressControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'SEND',
                    actionClass: 'transfer',
                    address:     send['DESTINATION'],
                    tick:        send['TICK'],
                    from:        send['SOURCE'],
                    to:          send['DESTINATION'],
                    amount:      send['AMOUNT'],
                    data:        send,
                    gasInfo:     gasInfo,
                    gasBalances: reserveBalances,
                    seq:         parseInt(idx) || 0
                });
                if(recip.error)
                    error = 'invalid: ' + recip.error;
                else
                    guardFee = this.util.bcadd(guardFee, recip.guardFee, 8);
            }

            if(!error)
                balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], send['AMOUNT']);

            let status = (error) ? error : 'valid';
            data['STATUS'] = send['STATUS'] = status;

            console.log("\t SEND : " + send['TICK'] + ' : ' + send['AMOUNT'] + ' : ' + send['DESTINATION'] + ' : '+ data['STATUS']);

            await this.indexerDb.createSend(send);

            this.util.addAddressTicker(data['SOURCE'], send['TICK']);

            if(status=='valid'){

                this.util.addAddressTicker(send['DESTINATION'], send['TICK']);

                debits.push([send['TICK'], send['AMOUNT'], send['SOURCE']]);

                credits.push([send['TICK'], send['AMOUNT'], send['DESTINATION']]);

                // Bill the controller-guard gas to SOURCE (in GAS). Reduce the
                // in-memory GAS balance so a later controlled leg in this same
                // multi-send sees the spend when it re-checks its reservation.
                if(this.util.bcgt(guardFee, 0)){
                    debits.push([gasTick, guardFee, send['SOURCE']]);
                    this.util.addAddressTicker(send['SOURCE'], gasTick);
                    if(gasInfo){
                        // When the sent tick IS the gas tick, debit the guard fee out of the same
                        // `balances` snapshot that AMOUNT was already debited from above, so
                        // AMOUNT + guardFee together are enforced against one balance. Otherwise
                        // (unchanged) debit the independent `gasBalances` snapshot.
                        if(sameTick)
                            balances = this.util.debitBalances(balances, gasInfo['TICK_ID'], guardFee);
                        else
                            gasBalances = this.util.debitBalances(gasBalances, gasInfo['TICK_ID'], guardFee);
                    }
                }
            }
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply. updateTokens is required because a
        // controller guardFee is burned as a GAS debit with no offsetting credit (above);
        // tokens.supply (GAS) must be recomputed from the ledger or the per-block sanityCheck
        // (ledger == supply == balances) trips and halts the indexer. Mirrors the other
        // guarded handlers (order.js/swap.js/dispenser.js) and execute.js.
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);

        await this.util.processDispenserSends(this.actions, this.indexerDb, data);

    }
}

module.exports = Send;
