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
 * XChain Platform Action - BATCH: the aggregate gas pre-check
 *
 * The lower-bound collapse of the no-gas spam case: when every sub-command is provably
 * fee-bearing and the SOURCE cannot afford even the cheapest, the whole BATCH is one
 * invalid record instead of N. Holds the fee tables it prices from, the resolve-only
 * token probe and the three nominal-fee helpers. The methods are Batch prototype
 * methods, installed by index.js, so each runs with the instance as `this`.
 *
 ********************************************************************/

// Leaf module (requires nothing of its own), so requiring it cannot form the load-time cycle
// the actions/index.js note in index.js describes.
const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');

// What priceSubCommand answers when a sub-command carries no positive price evidence; the
// gas pre-check then answers false for the whole batch. A Symbol, so no fee value a helper
// can return (null, undefined, 0 or an amount string) is ever mistaken for it.
const NOT_PROVABLE = Symbol('BATCH_GAS_NOT_PROVABLE');

// The two tables the gas pre-check prices sub-commands from, created after the cost weights.
function installFeeTables(){
    // DURATION-METERED CREATE actions whose nominal fee the batch spam collapse can price
    // from the WIRE ALONE (gated on BATCH_COST_WEIGHTING - see isGasProvablyUnaffordable).
    //
    // All three charge one and the same creation fee: getUnifiedExpirationFee's format-0
    // branch, which is getUnifiedDurationFee(EXPIRATION, BLOCK_TIME, 'EXPIRATION_PER_DAY'),
    // a PURE function of one wire field and the transaction's own BLOCK_TIME. No database
    // read, no handler state, so pricing them here costs nothing and cannot drift into the
    // O(commands x reads) work the pre-check exists to avoid.
    //
    // Three more actions a reader might expect to find here are deliberately absent, each
    // for a measured reason rather than an oversight:
    //  - MINT is FREE. mint.js calls neither getUnifiedTransactionFee nor
    //    validateNativeCoinFee; its only gas is an optional controller guardFee defined by
    //    contract code, which is not knowable from params. An all-MINT batch is never
    //    provably unaffordable, so the spec's "all-MINT no-gas batch" case cannot arise.
    //  - EXECUTE is priced, but NOT positionally and NOT from a duration: its floor is a
    //    schedule constant, so it has its own table below (vmBaseFeeActions) rather than a
    //    seat here.
    //  - SEND / ISSUE / SWEEP / DEPLOY use bespoke parsing (repeating recipients,
    //    variable-length constructor params), which is exactly why actions/index.js's
    //    setActionParamHandler omits them. ISSUE is priced here by its own dedicated
    //    path (nominalIssueFee), not positionally.
    this.durationFeeActions = ['ORDER', 'SWAP', 'DISPENSER'];

    // VM actions whose ACCEPTANCE fee is a schedule CONSTANT, so the batch spam collapse can
    // price them without parsing a single param (gated on BATCH_COST_WEIGHTING - see
    // isGasProvablyUnaffordable and nominalExecuteFee).
    //
    // THE FLOOR IS VERIFIED, NOT ASSUMED, because EXECUTE is easy to misread as having no
    // knowable floor at all, so the proof is written down here. execute.js
    // (~209-243) computes `fee = vmGasCost(schedule,'EXECUTE',0) * GAS_PRICE` BEFORE the VM
    // runs, i.e. VM_EXECUTE_BASE priced through the one arithmetic the static quote also
    // uses, and refuses the sub-command with 'invalid: insufficient funds (GAS)' when the
    // SOURCE cannot cover it. Metered gas re-prices only the RECORDED fee afterwards
    // (execute.js ~498-517, and utility.js vmGasCost says so in as many words), and it can
    // only ever raise the bill. So the constant is a true LOWER bound on what an EXECUTE
    // costs its SOURCE, which is the only direction this predicate may err in.
    //
    // XEXEC IS DELIBERATELY ABSENT, and that is a code fact rather than caution: xexec.js
    // injects its executions with IS_EMISSION true and is "fee-less on THIS chain" (:213,
    // :221) because it runs against the cross-chain request's gas_escrow, not a wallet.
    // Pricing it would be an OVER-estimate, the one error this predicate may never make.
    //
    // The two escape hatches execute.js's own fee block has are honoured by
    // nominalExecuteFee and by the transaction-level gates at the top of the predicate:
    // IS_EMISSION (skipFee) and native-coin fee mode both bail before any of this is
    // reached, and a batch's sub-commands inherit both from the ONE data object the
    // dispatch loop mutates, so neither can differ per sub-command.
    this.vmBaseFeeActions = ['EXECUTE'];
}

// Read a TICK's token info WITHOUT interning the tick (BATCH_ISSUANCE_LIMITS gas pre-check).
//
// getTokenInfo resolves its argument through createTicker, which INSERTS an unseen name
// into index_tickers - the same free consumption of dense id space the ISSUE path's gating
// closes. A pre-check probing up to 250 unseen ticks per BATCH would re-open it at 250x,
// and would do it before validity is decided, so every probe here runs under db.js's
// existing resolve-only lever. A not-yet-interned tick then resolves to a null tick_id and
// the token query finds no row: the SAME answer an interned-but-tokenless tick gives, so
// only the side effect is skipped, never the verdict. `prior` is restored (not hardcoded
// false) in a finally, so nesting and throws cannot leak suppression into the next read.
async function probeTokenInfo(tick, data){
    let prior = this.indexerDb.suppressIndexIdCreation;
    this.indexerDb.suppressIndexIdCreation = true;
    try {
        return await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    } finally {
        this.indexerDb.suppressIndexIdCreation = prior;
    }
}

// Nominal gas cost of ONE new-tick ISSUE, reproduced from the SAME shared helper and the
// SAME config keys issue.js prices with, never a second copy of the schedule:
//   unified: util.getUnifiedTransactionFee(1, 'ISSUE'|'ISSUE_SUBTOKEN')
//            == bcmul(schedule[key], GAS_PRICE, 8), which is issue.js's expression verbatim.
//   legacy:  config ISSUANCE_FEE_SUBTOKEN / ISSUANCE_FEE_TOKEN, the two values issue.js reads.
//
// issue.js selects the subtoken price on `parentInfo` (the parent token EXISTS), not on the
// dot. Dotted-but-parentless is rejected before the fee block ever runs, so on every path
// that can reach a fee, dotted <=> subtoken price and this mapping is exact; on the paths
// that cannot, it quotes the SMALLER of the two prices, which is the safe direction for a
// lower bound.
function nominalIssueFee(tick, unified){
    let child = String(tick).includes('.');
    if(unified)
        return this.util.getUnifiedTransactionFee(1, child ? 'ISSUE_SUBTOKEN' : 'ISSUE').fee;
    return child ? this.config['ISSUANCE_FEE_SUBTOKEN'] : this.config['ISSUANCE_FEE_TOKEN'];
}

// Nominal creation fee of ONE duration-metered sub-command (gated on BATCH_COST_WEIGHTING).
//
// Returns a fee AMOUNT (which may legitimately be 0, meaning "free and therefore always
// affordable"), or null meaning THE COST IS NOT POSITIVELY KNOWN. The caller must treat
// null as "let the batch through": the gas pre-check collapses on positive price evidence only.
//
// WHY IT IS A LOWER BOUND, AND WHY THAT IS THE ONLY SAFE DIRECTION. The handler's real
// fee for a create is the expiration fee PLUS, on some shapes, an ownership-escrow premium
// (order.js getOwnershipEscrowFee) and a controller guardFee, both of which are derived
// from database state this pre-check refuses to read. Omitting them can only UNDER-state
// the cost. Under-stating is safe in exactly one direction and it is this one: the caller
// collapses only when the balance is below the cheapest cost, so a cost quoted too low can
// only SUPPRESS a collapse, never cause a wrong one. An over-estimate would reject a
// sub-command that would have succeeded, which this predicate may never do.
//
// ONLY THE CREATE FORMAT IS PRICEABLE. Format 1 is a cancel (no fee at all) and format 2 is
// an EDIT, whose fee is the DIFFERENCE against the stored record's EXPIRATION and so needs
// a read; both return null. FORMAT is derived with util.getFormatVersion off params[0],
// byte-for-byte the derivation the dispatch loop performs, so this and the handler can
// never disagree about which format a sub-command is.
//
// The EXPIRATION POSITION is read out of the HANDLER'S OWN format string rather than
// hardcoded (it is index 10 for ORDER/SWAP and 13 for DISPENSER today), through the same
// actions/index.js seam - setActionParamHandler - that already exists to say which handlers have
// a fixed positional layout. A format string that gains or loses a field therefore moves
// this pre-check with it instead of silently mispricing. If the seam is absent (a partial
// test double, an older Actions), the answer is null: unpriceable, no collapse.
//
// Never throws, for the same reason every other helper in this handler does not: a crash here
// would halt block processing, and the safe fallback is null, which is the pre-flag verdict.
function nominalDurationFee(action, parts, data, unified){
    try {
        if(typeof this.actions.setActionParamHandler !== 'function')
            return null;
        let handler = this.actions.setActionParamHandler(action);
        if(!handler || !handler.formats)
            return null;
        // Only the CREATE format is priceable; see above.
        if(this.util.getFormatVersion(parts[0]) !== 0)
            return null;
        let fields = String(handler.formats[0]).split('|');
        let idx    = fields.indexOf('EXPIRATION');
        if(idx < 1)
            return null;
        // Same read setActionParams performs: positional, trimmed, absent means null.
        let expiration = (typeof parts[idx] === 'undefined') ? null : String(parts[idx]).trim();
        // No EXPIRATION is the free case, and it is a POSITIVE answer of zero rather than
        // "unknown": the handler skips its whole fee block, so the sub-command really can
        // be valid on an empty balance and the caller must not collapse the batch.
        if(this.util.isNull(expiration))
            return 0;
        if(!this.util.isNumeric(expiration) || this.util.isNull(data['BLOCK_TIME']))
            return null;
        if(unified)
            return this.util.getUnifiedDurationFee(expiration, data['BLOCK_TIME'], 'EXPIRATION_PER_DAY').fee;
        // Legacy lane: getExpirationFee's format-0 branch reads only EXPIRATION, BLOCK_TIME
        // and config, so a minimal data object reproduces it exactly. `info` is unused on
        // that branch and is passed null rather than fabricated.
        return this.util.getExpirationFee({ FORMAT: 0, EXPIRATION: expiration, BLOCK_TIME: data['BLOCK_TIME'] }, null);
    } catch(e) {
        return null;
    }
}

// Nominal ACCEPTANCE fee of ONE EXECUTE sub-command (gated on BATCH_COST_WEIGHTING).
//
// Returns a fee AMOUNT (0 is a legitimate positive answer meaning "free, therefore always
// affordable"), or null meaning THE COST IS NOT POSITIVELY KNOWN, which the caller must
// treat as "let the batch through".
//
// WHY THIS IS A LOWER BOUND. It is the SAME arithmetic execute.js runs before it enters the
// VM: vmGasCost(schedule,'EXECUTE',0) priced at GAS_PRICE. What the handler bills at
// settlement is gas actually CONSUMED, which starts at this base and only grows, so quoting
// the base can only UNDER-state the real cost. Under-stating is the one safe direction:
// the caller collapses only when the balance is below the cheapest cost, so a cost quoted
// too low can only SUPPRESS a collapse, never cause a wrong one.
//
// THE ONE READ, AND WHY IT IS NOT OPTIONAL. execute.js gates its whole fee block on
// `tokenInfo` for the GAS token: on a chain where the gas token has no valid issuance
// as-of this block, an EXECUTE is charged NOTHING and really can be valid on an empty
// balance. Quoting a positive fee there would be an over-estimate, so the token is probed
// (through probeTokenInfo, which suppresses ticker interning exactly as the ISSUE path
// does) and its absence answers "unknown". The caller memoizes this, so a 250-EXECUTE
// batch pays for ONE read, not 250.
//
// No param is read at all, which is why EXECUTE needs no positional seam: the floor does
// not depend on the contract, the method or the arguments. A DETERMINISTIC failure never
// throws, for the same reason its siblings do not - a crash there would halt block
// processing - and the fallback is null, which is the verdict below BATCH_COST_WEIGHTING.
//
// AN INFRASTRUCTURE FAULT IS NOT A DETERMINISTIC FAILURE, and the catch must not treat it
// as one. The probe below is a DB read (indexerDb.getTokenInfo), so a deadlock (1213),
// lock-wait timeout (1205) or killed connection lands in this catch; returning null for it
// makes the caller's verdict node-local. null short-circuits isGasProvablyUnaffordable to
// false, so the faulted node writes STATUS 'valid' and dispatches every sub-command while
// a healthy peer writes one 'invalid: GAS (insufficient)' record - a fork committed into
// the block. rethrowIfInfraFault propagates exactly that class and nothing else, so the
// block rolls back and retries; it is the same guard the sibling ISSUE probe gets for
// free by calling probeTokenInfo UNWRAPPED (see isGasProvablyUnaffordable).
async function nominalExecuteFee(data){
    try {
        let gasCost = this.util.vmGasCost(this.config['GAS_SCHEDULE'], 'EXECUTE', 0);
        if(gasCost === null || !this.util.isNumeric(gasCost))
            return null;
        if(!await this.probeTokenInfo(this.config['GAS'], data))
            return null;
        return this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);
    } catch(e) {
        rethrowIfInfraFault(e);
        return null;
    }
}

// Aggregate gas pre-check (BATCH_ISSUANCE_LIMITS, ruled 2026-08-13).
//
// WHAT IT IS: a conservative LOWER-BOUND collapse of the no-gas spam case. True only when
// EVERY sub-command is provably fee-bearing at a positively-known price and the SOURCE
// cannot afford even the CHEAPEST of them; the caller then invalidates the whole BATCH as
// one record instead of writing N invalid rows. It is never a second opinion on validity:
// whenever it returns false the batch proceeds untouched and every sub-command bills itself
// exactly as it does today.
//
// WHY THE CHEAPEST AND NOT THE SUM (a deliberate choice over summing every sub-command's
// cost): gas debits are batch-cumulative, so the sub-commands are billed GREEDILY in
// list order against one running budget. A source holding gas for K of N therefore lands
// exactly K valid commands, which the batch gas tests pin. Rejecting on
// balance < SUM would kill those K, i.e. reject work that really would have succeeded, the
// one failure mode this check may never have. Zero sub-commands can be paid if and only if
// the balance is below the MINIMUM cost, so that predicate is both safe AND the strongest
// safe one: the sum can only add false positives, never extra collapses.
//
// WHAT IS COVERED: ISSUE of a non-caret TICK that does not already exist, and - at/after
// BATCH_COST_WEIGHTING only - a duration-metered CREATE of an ORDER, SWAP or
// DISPENSER, priced by nominalDurationFee from EXPIRATION and BLOCK_TIME with no database
// read, plus EXECUTE at its schedule-constant acceptance floor (nominalExecuteFee, one
// memoized read for the whole batch). EXECUTE is the case the cost weighting exists
// for: it runs VM code, it is capped at nothing, and without this check an attacker who
// cannot pay for one buys N invalid rows for free. Everything else returns false (let it
// through) on FIRST sight, because its nominal cost is not knowable here:
//  - non-ISSUE actions BELOW the weighting flag: unchanged, every one of them exits here,
//    which is what keeps this predicate byte-identical on a pre-flag replay. The widening
//    rides BATCH_COST_WEIGHTING and NOT BATCH_ISSUANCE_LIMITS deliberately: the latter is
//    already armed on mainnet, and hanging an unrehearsed consensus change off an arming
//    flag would ship it with no replay evidence behind it.
//  - AIRDROP/DIVIDEND price off recipient counts, CALLBACK/SWEEP off db_hits, DEPLOY off
//    code bytes. Each is computed by the handler from state or params it alone has; see
//    durationFeeActions for why the three that ARE priced positionally are the only three
//    that can be.
//  - XEXEC is system-injected and fee-less on this chain (xexec.js:213/:221), so pricing it
//    would be an over-estimate; see vmBaseFeeActions.
//  - caret TICKs (^<id>): an id reference, resolved (not interned) by db.js, and ISSUE rejects
//    the caret-dot form outright; no positive price evidence, so no evidence of cost.
//  - the GAS tick itself: its genesis issuance is fee-exempt (chicken-and-egg).
//  - a TICK that already has a valid issuance: a re-issue is FREE, so that sub-command can
//    be valid on a zero balance and the batch must proceed. This also covers the intended
//    "create, add supply, lock, transfer ownership as a sequence" shape.
//  - a repeated new TICK inside one batch costs the same nominal fee on every occurrence:
//    under this predicate the first occurrence cannot pay, so it never becomes valid, so it
//    never creates the token (getTokenInfo reads valid issues only) and the repeat is still
//    a new issuance. Memoized per TICK, so N copies cost ONE read.
//
// Scope gates before any of that: the whole check applies only to the XCHAIN-balance
// settlement lane. In native-coin mode the fee never touches this balance (the native fee
// ledger owns that lane) and in 'rejected' mode the failure has nothing to do with gas, so
// both return false. IS_GENESIS/IS_EMISSION and an inactive ISSUANCE_FEE flag are fee-exempt
// outright. All of these are TRANSACTION-level, so one verdict covers the whole batch.
//
// Reads are as-of (BLOCK_INDEX, the BATCH's own ACTION_INDEX) - the budget and the token
// set exactly as they stand before the first sub-command runs - and are read-only. The
// command loop is bounded ONLY by the 250-command cap, which is why that cap is the first
// check in parse() and why this runs behind `!error`.
//
// `weightsActive` is the BATCH_COST_WEIGHTING verdict parse() already resolved once for
// this batch. It is a PARAMETER rather than a second isEnabled call so every gated site in
// this handler reads ONE verdict, and it defaults to false so any caller written against the
// signature without it keeps exactly the behaviour below the flag.
async function isGasProvablyUnaffordable(commands, data, normalize, weightsActive = false){
    if(data['IS_GENESIS'] || data['IS_EMISSION'])
        return false;
    if(this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']) !== 'xchain')
        return false;
    if(await this.protocolChanges.isEnabled('ISSUANCE_FEE', data['BLOCK_INDEX']) == false)
        return false;
    let unified = await this.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);

    let gasTick  = String(this.config['GAS']).toUpperCase();
    let memo     = {
        priced:  {},   // TICK -> nominal fee, memoized so a repeated TICK costs one read
        // EXECUTE's floor is the same number for every sub-command in the batch, and computing
        // it costs one GAS-token probe. `undefined` means not computed yet; `null` means
        // computed and NOT positively known. Memoized here rather than in the constructor
        // because the probe is as-of THIS batch's (BLOCK_INDEX, ACTION_INDEX).
        vmFloor: undefined
    };
    let cheapest = null;

    for(let command of commands){
        let cost = await priceSubCommand.call(this, command, data, normalize, weightsActive, unified, gasTick, memo);
        if(cost === NOT_PROVABLE)
            return false;
        if(cheapest === null || this.util.bclt(cost, cheapest))
            cheapest = cost;
    }

    // No commands at all, or a schedule that prices an issuance at zero: nothing is provable.
    if(cheapest === null || !this.util.bcgt(cheapest, 0))
        return false;

    // Same balance idiom every handler uses (getAddressBalances as-of BLOCK_INDEX +
    // ACTION_INDEX, then util.hasBalance), against the gas TICK_ID resolved by the same
    // getTickerId(config.GAS) call util.createFeesObject makes. The full fees object is not
    // built here: nothing below the TICK_ID is used, and creating one would need an address
    // preferences read this check has no reason to make.
    let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    let tickId   = await this.indexerDb.getTickerId(this.config['GAS']);
    return !this.util.hasBalance(balances, tickId, cheapest);
}

// The nominal cost of ONE sub-command for isGasProvablyUnaffordable, or NOT_PROVABLE. Every
// branch either establishes a positively-known cost or answers NOT_PROVABLE, which the caller
// turns into false for the whole batch: that is the rule the whole predicate rests on, no
// positive price evidence, no collapse. `memo` is the caller's per-batch memo, so a repeated
// TICK and every EXECUTE after the first cost no further read.
async function priceSubCommand(command, data, normalize, weightsActive, unified, gasTick, memo){
    let parts  = String(command).split('|');
    let action = String(parts.shift()).toUpperCase();
    // Same normalization the dispatch loop applies, on this loop's own split copy, so
    // the TICK read below is the one the handler will parse (params[1] in all seven
    // ISSUE formats, after the implied legacy VERSION 0 is injected).
    if(normalize)
        action = this.normalizeSubAction(action, parts);

    if(action === 'ISSUE'){
        let tick = (parts[1] === undefined || parts[1] === null) ? '' : String(parts[1]).trim();
        if(tick === '' || tick.charAt(0) == '^' || tick.toUpperCase() === gasTick)
            return NOT_PROVABLE;

        if(memo.priced[tick] === undefined){
            if(await this.probeTokenInfo(tick, data))
                return NOT_PROVABLE;
            memo.priced[tick] = this.nominalIssueFee(tick, unified);
        }
        return memo.priced[tick];
    }
    if(weightsActive && this.durationFeeActions.includes(action)){
        // Duration-metered create. null means "not positively known" (an edit, a cancel,
        // an unparseable EXPIRATION), which is a bail-out exactly like an unknown action.
        let cost = this.nominalDurationFee(action, parts, data, unified);
        return (cost === null) ? NOT_PROVABLE : cost;
    }
    if(weightsActive && this.vmBaseFeeActions.includes(action)){
        // The VM floor. Params are not read at all: the acceptance fee is a
        // schedule constant, so every EXECUTE in the batch quotes the same number and
        // one probe answers for all of them.
        if(memo.vmFloor === undefined)
            memo.vmFloor = await this.nominalExecuteFee(data);
        return (memo.vmFloor === null) ? NOT_PROVABLE : memo.vmFloor;
    }
    return NOT_PROVABLE;
}

module.exports = {
    installFeeTables, probeTokenInfo, nominalIssueFee, nominalDurationFee, nominalExecuteFee,
    isGasProvablyUnaffordable,
};
