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
 * XChain Platform Action - BATCH
 * 
 * This action batch executes multiple `ACTION` commands in a single transaction
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - COMMAND - Any valid `ACTION` with `PARAMS`
 * 
 * FORMATS:
 * - 0 = Full (VERSION|COMMAND;COMMAND)
 * 
 ********************************************************************/

// Leaf module (requires nothing of its own), so no cycle with the actions.js note below.
const { rethrowIfInfraFault } = require('./faultGuard.js');


// Resolved at CALL time, never at module load: actions.js requires this file while it is
// still being evaluated, so a top-level require here would bind an empty exports object.
function probeForbiddenSubAction(action){
    return require('../actions.js').isBatchProbeForbiddenSubAction(action);
}

class Batch {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.protocolChanges = action.protocolChanges;

        this.formats = {};
        this.formats[0] = 'VERSION|COMMAND';

        // Per-BATCH usage cap for each ACTION (0 = disallowed inside a BATCH).
        // MINT's 1 is re-read at/after BATCH_ISSUANCE_LIMITS as "1 per DISTINCT token"
        // rather than "1 per batch" (spec decision D7); the number itself does not move,
        // only what it is counted over. See maxMintsPerDistinctTick.
        this.actionLimits = {};
        this.actionLimits['BATCH'] = 0;
        this.actionLimits['MINT']  = 1;
        this.actionLimits['ISSUE'] = 1;

        // Per-ACTION caps that arrive WITH the BATCH_ISSUANCE_LIMITS flag-day, held in their
        // own table so the pre-flag one above stays byte-identical below the flag: adding a
        // row to actionLimits would apply it retroactively and fork a replay.
        //
        // DEPLOY = 1 (spec decision D5, operator 2026-08-13). The chain never capped DEPLOY at
        // all; only the SDK builder and the wallet refused it, which is a client-side line and
        // not a protocol rule, while deploy.js (~536-541) DELIBERATELY supports a DEPLOY inside
        // a BATCH, carrying the sub-command position into the constructor's root discriminator.
        // THE CAP IS NOT ABOUT SIZE. "Too large for BATCH" was a legacy-lane fact (8192 bytes)
        // and the envelope lane carries ~390000, with oversize self-enforcing at the encoder.
        // The reason for the cap is COST: every DEPLOY runs a CONSTRUCTOR IN THE VM, by far the
        // most expensive per-command work in the system, and the 250-command cap above was
        // sized for cheap commands, so 250 constructors is a wholly different unit of work from
        // 250 SENDs. Do not fold this into that cap or drop it because the payload fits.
        // One is the deliberate starting point because the asymmetry is one-way: raising a
        // limit later is a loosening and cheap, lowering one later is a tightening that risks
        // forking a replay.
        this.gatedActionLimits = {};
        this.gatedActionLimits['DEPLOY'] = 1;

        // Distinctness bucket for a MINT TICK that resolves to NO ticker id (D7). A Symbol, so
        // it can never collide with a real id key however a wire tick is spelled.
        this.unresolvedTickKey = Symbol('BATCH_UNRESOLVED_TICK');

        // Global per-BATCH command cap (BATCH_ISSUANCE_LIMITS). Every parse-valid
        // sub-command costs an ACTION_INDEX, mappings and (when it fails) an invalid
        // row, so per-command indexer cost dwarfs per-command on-chain cost: the data
        // lanes admit ~744 minimal sub-commands and the envelope lane ~35,000. This is
        // the only bound on the O(N) scans below, which is why it is checked first.
        this.commandLimit = 250;

        // Weighted cost budget (BATCH_COST_WEIGHTING). The cap above counts sub-commands and
        // charges every one of them 1, which is a proxy for indexer work and a bad one in both
        // directions: EXECUTE runs VM code and is capped at nothing, while 250 minimal SENDs
        // cost far less than 10 DEPLOYs and the count cannot say so. At/after the flag the
        // batch is bounded by the SUM of per-sub-command WEIGHTS instead.
        //
        // THE BUDGET IS DELIBERATELY THE SAME NUMBER AS THE COUNT CAP, and that is the
        // compatibility property rather than a coincidence: with the default weight at 1, the
        // sum over an ordinary batch IS its command count, so every batch carrying no weighted
        // action is admitted or refused exactly as it is today, including the error string. The
        // rule only bites where the flat cap was already wrong. Do not "tidy" these two into one
        // constant: they are equal today and they are separately meaningful, and collapsing them
        // would silently move the pre-flag cap if the budget is ever retuned.
        this.weightBudget = 250;

        // Per-ACTION cost weights (BATCH_COST_WEIGHTING). An action absent from this table
        // weighs the DEFAULT of 1, which is every ordinary action: one ACTION_INDEX, its
        // mappings and at most one invalid-record row, roughly constant whatever the action.
        // ISSUE and its dotted children are deliberately in that class - a child issuance is one
        // row like any other - which is what stops a weighting from repealing bulk child
        // issuance on its first day.
        //
        // EMPTY at this flag's introduction, and that is the whole point of landing it empty:
        // with every weight at the default, the budget check is ARITHMETICALLY IDENTICAL to the
        // count check it replaces, so the machinery can be proven a no-op before any weight is
        // assigned to it. Entries arrive one class at a time, each separately measurable.
        //
        // Keys are canonical post-normalization ACTION names and are matched CASE-SENSITIVELY,
        // exactly like the sibling scans in this file. That is deliberate: the activation scan
        // below rejects a mis-cased action as 'invalid: ACTION (unknown)', and upper-casing here
        // would let a weighted spelling reach the budget check first and change which consensus
        // string wins.
        this.commandWeights = {};

        // FAN-OUT actions (operator decision 2026-08-14). AIRDROP and DIVIDEND write a row PER
        // RECIPIENT, so one sub-command really is worth many. They take a FLAT weight rather
        // than the spec's original '1 + recipients', and the reason is that the exact recipient
        // count is not knowable here at any acceptable price:
        //
        //   - it is not on the wire. AIRDROP carries a LIST_ACTION_INDEX, not a list, and
        //     DIVIDEND carries only a TICK whose holders are the recipients;
        //   - the number that matters is the FILTERED count, not the raw one. airdrop.js
        //     resolves the list and then filters it through the token's ALLOW_LIST and
        //     BLOCK_LIST; dividend.js fetches every holder, filters the same two ways, and then
        //     drops holders whose share rounds to zero at the dividend token's decimals;
        //   - so an exact count means re-running each handler's own resolution inside this
        //     pre-check. That duplicates consensus logic into a second place it can drift from,
        //     and it performs precisely the O(commands x recipients) work the budget exists to
        //     prevent, before the batch is even known to be valid.
        //
        // A flat weight keeps the weight scan free of database reads, which is what lets it stay
        // cheap enough to run FIRST, ahead of every other check.
        //
        // THE NUMBER IS A DELIBERATE STARTING POINT, NOT A MEASUREMENT, and it is chosen HIGH
        // for the asymmetry this file already applies to DEPLOY: for a weight the directions are
        // reversed from a limit, so LOWERING one later is a loosening and cheap, while RAISING
        // one later is a tightening that risks forking a replay. 25 admits 10 fan-out
        // sub-commands per batch. Retune it before the mainnet instant is armed, never after.
        this.commandWeights['AIRDROP']  = 25;
        this.commandWeights['DIVIDEND'] = 25;

        // VM actions (D8 for EXECUTE/XEXEC, D5's cost half for DEPLOY). RATIFIED AT 30 BY THE
        // OPERATOR ON 2026-08-15, on the measurement in bin/measure-batch-execute-cost.js and
        // claude/reports/2026-08-14_batch-execute-cost-measurement.md. This is a consensus
        // constant: it decides verdicts, so it may only move behind a flag day.
        //
        // WHY 30, stated so a future retune can re-derive it rather than guess. A worst-case
        // EXECUTE measured 10.7x to 27.4x an ordinary sub-command (pooled 17.9x / 14.9x /
        // 18.7x), and a worst-case DEPLOY 13.0x to 29.5x. 30 is the SMALLEST ROUND WEIGHT at
        // which a full batch of worst-case VM sub-commands stays under the status-quo bound of
        // 250 ordinary ones AT EVERY RATIO OBSERVED: it admits 8 per batch, and 8 x 27.4 is 219
        // ordinary-equivalents. Weight 25 admits 10, which is 274 at the same ratio, over by 10%.
        // The pooled parity floor is 19, so 30 is above every ratio measured and far below the
        // 250 the spec's original table proposed for DEPLOY.
        //
        // TWO PROPERTIES OF THE MEASUREMENT THAT MUST TRAVEL WITH THE NUMBER:
        //  - the cost curve is LINEAR from N=1 to N=50 (r^2 0.9987 / 0.9994), because
        //    ProcessExecutor forks one worker and dispatches sequentially and beginBlock/endBlock
        //    scope the compile cache per block. So a per-sub-command constant is the right shape
        //    and there is no unamortized setup a weight would have to absorb;
        //  - WALL TIME IS NOT BOUNDED BY GAS (xchain-vm/src/index.js ~304-306 records a shape
        //    burning ~13.5s at ~540k gas), so the architectural worst case is well above the
        //    measured one. It IS bounded, identically on every node, by the consensus constant
        //    CONSENSUS_MAX_WALL_MS (xchain-vm, 30000 ms), which is the ceiling this weight is
        //    measured against: 30 s is ~40x the measured worst case, so any future widening of
        //    VM metering coverage still moves this number's grounding and it must be
        //    re-derived, never inherited.
        //
        // XEXEC RIDES WITH EXECUTE HERE, which is the OPPOSITE of its treatment in
        // vmBaseFeeActions above, and the difference is not an inconsistency - the two tables
        // measure different things. That one is about what a sub-command COSTS ITS SOURCE, and
        // XEXEC is fee-less on this chain, so pricing it there would be an over-estimate and
        // wrong. This one is about what a sub-command COSTS THE INDEXER, and an XEXEC runs the
        // same contract code an EXECUTE does; leaving it at the default 1 would leave the VM
        // class bounded for one spelling and unbounded for the other.
        //
        // DEPLOY IS WEIGHED, AND IT ALSO KEEPS ITS CAP OF 1 (gatedActionLimits above). The spec
        // claimed D5 would be "subsumed with IDENTICAL behavior" by weighing DEPLOY at the whole
        // budget; that claim is FALSE, and the proof is short enough to keep here. Today's rule
        // is a CONJUNCTION of two independent caps (count <= 250 AND deploys <= 1). For a DEPLOY
        // weight w, refusing two DEPLOYs needs 2w > 250, i.e. w >= 126, while keeping the
        // valid-today "1 DEPLOY + 249 SENDs" valid needs w + 249 <= 250, i.e. w <= 1. The two are
        // contradictory, so NO weight reproduces today's DEPLOY behaviour: a weighted SUM cannot
        // express a conjunction of caps. The cap therefore stays exactly where it is - which is
        // also what keeps 'invalid: DEPLOY (limit)' being reported from its own loop - and the
        // weight expresses only the COST half, i.e. how many companions one DEPLOY may carry
        // (220 at weight 30, against 249 today).
        //
        // CHUNKED DEPLOY (deploy.js format 4) IS DISCOUNTED TO THE DEFAULT WEIGHT OF 1
        // (operator ruling 2026-08-20; subCommandWeight below). A chunk carrier runs no
        // constructor - deploy.js short-circuits format 4 into DeployChunk.parse() before the
        // VM path - so it is really a row write, and 30 charged VM cost for work that has none.
        // The drift objection that first kept it over-charged does not hold up: the format is
        // read with the SAME util.getFormatVersion(params[0]) call the dispatcher (actions.js)
        // uses to set data['FORMAT'], one shared derivation rather than a second one, and
        // DEPLOY is outside normalizeSubAction's legacy VERSION injection so params[0] is
        // always the explicit version field. The asymmetry still binds for the change itself:
        // lowering a weight is a loosening (it can only accept more), applied while the flag is
        // unarmed on mainnet.
        this.commandWeights['DEPLOY']  = 30;
        this.commandWeights['EXECUTE'] = 30;
        this.commandWeights['XEXEC']   = 30;

        // DURATION-METERED CREATE actions whose nominal fee the R4 spam collapse can price
        // from the WIRE ALONE (D10, gated on BATCH_COST_WEIGHTING - see isGasProvablyUnaffordable).
        //
        // All three charge one and the same creation fee: getUnifiedExpirationFee's format-0
        // branch, which is getUnifiedDurationFee(EXPIRATION, BLOCK_TIME, 'EXPIRATION_PER_DAY'),
        // a PURE function of one wire field and the transaction's own BLOCK_TIME. No database
        // read, no handler state, so pricing them here costs nothing and cannot drift into the
        // O(commands x reads) work the pre-check exists to avoid.
        //
        // The three actions the spec's D10 sentence ALSO named are deliberately absent, each
        // for a measured reason rather than an oversight:
        //  - MINT is FREE. mint.js calls neither getUnifiedTransactionFee nor
        //    validateNativeCoinFee; its only gas is an optional controller guardFee defined by
        //    contract code, which is not knowable from params. An all-MINT batch is never
        //    provably unaffordable, so the spec's "all-MINT no-gas batch" case cannot arise.
        //  - EXECUTE is priced, but NOT positionally and NOT from a duration: its floor is a
        //    schedule constant, so it has its own table below (vmBaseFeeActions) rather than a
        //    seat here.
        //  - SEND / ISSUE / SWEEP / DEPLOY use bespoke parsing (repeating recipients,
        //    variable-length constructor params), which is exactly why actions.js's
        //    _setActionParamHandler omits them. ISSUE is priced here by its own dedicated
        //    path (nominalIssueFee), not positionally.
        this.durationFeeActions = ['ORDER', 'SWAP', 'DISPENSER'];

        // VM actions whose ACCEPTANCE fee is a schedule CONSTANT, so the R4 spam collapse can
        // price them without parsing a single param (D10, gated on BATCH_COST_WEIGHTING - see
        // isGasProvablyUnaffordable and nominalExecuteFee).
        //
        // THE FLOOR IS VERIFIED, NOT ASSUMED, and the earlier reading of this code that said
        // EXECUTE had no knowable floor was wrong in a way worth writing down. execute.js
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

        // Counting bucket for child (dotted-TICK) ISSUE sub-commands. Deliberately not a
        // legal ACTION name, so it can never collide with an entry in actionLimits and
        // child issuance stays uncapped no matter what actions are added later.
        this.childIssueKey = 'ISSUE.CHILD';
    }

    // Normalize a sub-action the same way the top-level dispatcher (actions.js)
    // does: rewrite ACTION aliases, then (when params are given) inject the
    // implied legacy VERSION 0 for BTNS-style ISSUE/MINT/SEND params so FORMAT
    // derivation sees a version field. Mutates params in place; returns the
    // canonical ACTION name. Callers only invoke this at/after the
    // BATCH_SUBACTION_NORMALIZATION flag-day; before it, sub-actions keep the
    // historical un-normalized behaviour (aliased names invalidate the BATCH,
    // legacy-format params misparse) for byte-identical replay.
    normalizeSubAction(action, params){
        for(let alias in this.actions.actionAliases){
            if(action == alias)
                action = this.actions.actionAliases[alias];
        }
        if(params && ['ISSUE','MINT','SEND'].includes(action) && this.util.isLegacyActionFormat(params))
            params.splice(0,0,0);
        return action;
    }

    // Classify a sub-command for the per-ACTION limit scan (BATCH_ISSUANCE_LIMITS).
    //
    // Only ISSUE is reclassified: a CHILD issuance (dotted TICK, e.g. JDOG.1) is exempt
    // from the top-level limit of 1, so one BATCH may register a parent plus any number
    // of its children, while an undotted TICK still consumes the single top-level slot.
    // The dot test runs on the TICK the EXECUTOR will see: params[1] in all seven ISSUE
    // formats, read off a private split copy after the same normalizeSubAction the
    // dispatch loop applies (that call injects the implied legacy VERSION 0 in place, so
    // it must never touch the caller's array).
    //
    // Caret TICKs (^<id>[.<n>]) are NEVER exempt: the caret form is an id reference and
    // its dot is a decimal, not a namespace separator, so it counts as top-level.
    // A malformed command with no TICK is likewise counted as top-level: exemption is
    // granted on positive evidence only. Never throws - a classifier crash here would
    // halt block processing - so any surprise falls back to the unclassified name, which
    // is the pre-flag behaviour.
    classifyLimitAction(action, command, normalize){
        if(action !== 'ISSUE')
            return action;
        try {
            let params = String(command).split('|').slice(1);
            // Mirror the dispatch loop exactly: it normalizes params only under the
            // normalization flag, and classification must read TICK from the same shape
            // the handler will parse.
            if(normalize)
                this.normalizeSubAction(action, params);
            let tick = params[1];
            if(tick === undefined || tick === null)
                return action;
            tick = String(tick);
            if(tick.charAt(0) == '^')
                return action;
            if(tick.includes('.'))
                return this.childIssueKey;
            return action;
        } catch(e) {
            return action;
        }
    }

    // Read a TICK's token info WITHOUT interning the tick (BATCH_ISSUANCE_LIMITS / R4).
    //
    // getTokenInfo resolves its argument through createTicker, which INSERTS an unseen name
    // into index_tickers - the same free consumption of dense id space R6 closed on the ISSUE
    // path. A pre-check that probes up to 250 unseen ticks per BATCH would re-open it at 250x,
    // and would do it before validity is decided, so every probe here runs under db.js's
    // existing resolve-only lever. A not-yet-interned tick then resolves to a null tick_id and
    // the token query finds no row: the SAME answer an interned-but-tokenless tick gives, so
    // only the side effect is skipped, never the verdict. `prior` is restored (not hardcoded
    // false) in a finally, so nesting and throws cannot leak suppression into the next read.
    async probeTokenInfo(tick, data){
        let prior = this.indexerDb.suppressIndexIdCreation;
        this.indexerDb.suppressIndexIdCreation = true;
        try {
            return await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        } finally {
            this.indexerDb.suppressIndexIdCreation = prior;
        }
    }

    // Read the TICK a sub-command's handler will parse (BATCH_ISSUANCE_LIMITS / D7).
    //
    // TICK sits at params[1] in ALL SEVEN ISSUE formats and in MINT's SINGLE format
    // (VERSION|TICK|AMOUNT|DESTINATION|MEMO, mint.js:41), so positional extraction is not
    // format-fragile for either action and no per-action position rule is needed. It must be
    // read AFTER the same normalizeSubAction the dispatch loop applies: that call injects the
    // implied legacy VERSION 0 for BTNS-style params, and an un-normalized legacy MINT carries
    // its TICK one position earlier (MINT|TICK|AMOUNT|DESTINATION).
    //
    // Runs on a PRIVATE split copy because normalizeSubAction splices params in place and must
    // never reach the caller's array. Returns '' when there is no TICK at all, which callers
    // read as "no positive evidence", never as a token named the empty string. The trim mirrors
    // the R4 probe: an untrimmed spelling the executor would reject can only COLLAPSE into a
    // real tick's bucket here, which is the safe direction (it rejects, never admits). Never
    // throws, because a classifier crash here would halt block processing.
    //
    // classifyLimitAction above predates this helper and deliberately keeps its own copy of the
    // extraction: it is landed consensus code already driven green on chain, so it is not
    // re-derived through a new shared path just for tidiness.
    subCommandTick(action, command, normalize){
        try {
            let params = String(command).split('|').slice(1);
            if(normalize)
                this.normalizeSubAction(action, params);
            let tick = params[1];
            if(tick === undefined || tick === null)
                return '';
            return String(tick).trim();
        } catch(e) {
            return '';
        }
    }

    // Resolve a TICK to its ticker id WITHOUT interning it (BATCH_ISSUANCE_LIMITS / D7).
    //
    // Same resolve-only discipline as probeTokenInfo above, for the same reason: this runs over
    // untrusted wire ticks, before validity is decided, up to the 250-command cap. getTickerId
    // is a pure SELECT today (createTicker is the only interning path, and it hands any ^-led
    // tick straight back to getTickerId without ever inserting one), so the lever changes no
    // verdict here; it is set anyway so a future interning read cannot silently start burning
    // dense id space from a pre-check. `prior` is restored (not hardcoded false) in a finally,
    // so nesting and throws cannot leak suppression into the next read.
    async probeTickerId(tick){
        let prior = this.indexerDb.suppressIndexIdCreation;
        this.indexerDb.suppressIndexIdCreation = true;
        try {
            return await this.indexerDb.getTickerId(tick);
        } finally {
            this.indexerDb.suppressIndexIdCreation = prior;
        }
    }

    // Largest number of MINT sub-commands in this BATCH naming the SAME token
    // (BATCH_ISSUANCE_LIMITS / spec decision D7, operator 2026-08-13).
    //
    // D7 replaces the flat "one MINT per BATCH" with "one MINT per DISTINCT token, any number
    // of tokens". The flat cap protected FAIRNESS, not cost: a fair-mint token's supply is
    // contended, and 100 MINTs of one tick in one transaction beat 100 separate transactions on
    // both fee and in-block ordering, while minting twelve DIFFERENT tokens takes nothing from
    // anyone. Returning the per-token MAXIMUM keeps the cap itself in actionLimits ("at most 1
    // MINT per distinct tick") instead of restating the number here.
    //
    // DISTINCTNESS IS JUDGED ON THE RESOLVED TICKER ID, NEVER THE LITERAL STRING. `JDOG` and
    // `^614` can name the SAME token, so comparing raw strings would let a minter spell one
    // scarce tick both ways and take two bites at it: precisely the bypass this rule exists to
    // prevent, and the same aliasing hole closed on the ISSUE path.
    //
    // A TICK THAT RESOLVES TO NO ID gets no evidence that it is distinct from anything, so ALL
    // unresolvable ticks share ONE bucket: at most one such MINT per batch, which is exactly
    // the pre-flag limit, so this direction loosens nothing it cannot prove. It is the same
    // "on positive evidence only" rule classifyLimitAction already applies to a TICK-less
    // ISSUE, and it is what closes the intra-batch variant of the alias hole: in
    // `ISSUE FOO; MINT FOO; MINT ^<the id FOO is about to get>` NEITHER MINT resolves here,
    // because this scan reads the token set as it stands BEFORE the first sub-command runs, yet
    // both would name one token by the time they execute. One shared bucket rejects that pair.
    // A MINT of a genuinely unknown tick is invalid at execution anyway, so the work this
    // forgoes could never have landed; raising the rule later is a loosening and cheap, while
    // lowering it later would fork a replay.
    //
    // Reads: ONE getTickerId per DISTINCT tick STRING, memoized, so 250 copies of one tick cost
    // one read and the worst case is bounded by the 250-command cap. Every read is read-only
    // and intern-suppressed. Both tables are Maps rather than plain objects because the keys
    // are untrusted wire strings and a `constructor`/`__proto__` tick would read as an
    // already-present entry on an object literal, skipping its probe.
    async maxMintsPerDistinctTick(ticks){
        let resolved = new Map();   // tick string -> distinctness key (memoized, one read each)
        let counts   = new Map();   // distinctness key -> MINTs in this batch naming it
        let max      = 0;
        for(let tick of ticks){
            if(!resolved.has(tick)){
                let id = (tick === '') ? null : await this.probeTickerId(tick);
                resolved.set(tick, (id === null || id === undefined) ? this.unresolvedTickKey : id);
            }
            let key   = resolved.get(tick);
            let count = (counts.get(key) || 0) + 1;
            counts.set(key, count);
            if(count > max)
                max = count;
        }
        return max;
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
    nominalIssueFee(tick, unified){
        let child = String(tick).includes('.');
        if(unified)
            return this.util.getUnifiedTransactionFee(1, child ? 'ISSUE_SUBTOKEN' : 'ISSUE').fee;
        return child ? this.config['ISSUANCE_FEE_SUBTOKEN'] : this.config['ISSUANCE_FEE_TOKEN'];
    }

    // Nominal creation fee of ONE duration-metered sub-command (D10, BATCH_COST_WEIGHTING).
    //
    // Returns a fee AMOUNT (which may legitimately be 0, meaning "free and therefore always
    // affordable"), or null meaning THE COST IS NOT POSITIVELY KNOWN. The caller must treat
    // null as "let the batch through": R4 collapses on positive price evidence only.
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
    // actions.js seam - _setActionParamHandler - that already exists to say which handlers have
    // a fixed positional layout. A format string that gains or loses a field therefore moves
    // this pre-check with it instead of silently mispricing. If the seam is absent (a partial
    // test double, an older Actions), the answer is null: unpriceable, no collapse.
    //
    // Never throws, for the same reason every other helper in this file does not: a crash here
    // would halt block processing, and the safe fallback is null, which is the pre-flag verdict.
    nominalDurationFee(action, parts, data, unified){
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

    // Nominal ACCEPTANCE fee of ONE EXECUTE sub-command (D10, BATCH_COST_WEIGHTING).
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
    // processing - and the fallback is null, which is the pre-D10 verdict.
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
    async nominalExecuteFee(data){
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

    // Aggregate gas pre-check (BATCH_ISSUANCE_LIMITS / R4, spec decision D3 2026-08-13).
    //
    // WHAT IT IS: a conservative LOWER-BOUND collapse of the no-gas spam case. True only when
    // EVERY sub-command is provably fee-bearing at a positively-known price and the SOURCE
    // cannot afford even the CHEAPEST of them; the caller then invalidates the whole BATCH as
    // one record instead of writing N invalid rows. It is never a second opinion on validity:
    // whenever it returns false the batch proceeds untouched and every sub-command bills itself
    // exactly as it does today.
    //
    // WHY THE CHEAPEST AND NOT THE SUM (deviation from the spec's R4 sentence, reported to the
    // frontier): gas debits are batch-cumulative, so the sub-commands are billed GREEDILY in
    // list order against one running budget. A source holding gas for K of N therefore lands
    // exactly K valid commands - which is what acceptance test A6 pins. Rejecting on
    // balance < SUM would kill those K, i.e. reject work that really would have succeeded, the
    // one failure mode this check may never have. Zero sub-commands can be paid if and only if
    // the balance is below the MINIMUM cost, so that predicate is both safe AND the strongest
    // safe one: the sum can only add false positives, never extra collapses.
    //
    // WHAT IS COVERED: ISSUE of a non-caret TICK that does not already exist, and - at/after
    // BATCH_COST_WEIGHTING only (D10) - a duration-metered CREATE of an ORDER, SWAP or
    // DISPENSER, priced by nominalDurationFee from EXPIRATION and BLOCK_TIME with no database
    // read, plus EXECUTE at its schedule-constant acceptance floor (nominalExecuteFee, one
    // memoized read for the whole batch). EXECUTE is the case the whole weighting spec exists
    // for: it runs VM code, it is capped at nothing, and an attacker who cannot pay for one of
    // them currently buys N invalid rows for free. Everything else returns false (let it
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
    //  - caret TICKs (^<id>): an id reference, resolved (not interned) by db.js, and R6 rejects
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
    // settlement lane. In native-coin mode the fee never touches this balance (R5's ledger owns
    // that lane) and in 'rejected' mode the failure has nothing to do with gas, so both return
    // false. IS_GENESIS/IS_EMISSION and an inactive ISSUANCE_FEE flag are fee-exempt outright.
    // All of these are TRANSACTION-level, so one verdict covers the whole batch.
    //
    // Reads are as-of (BLOCK_INDEX, the BATCH's own ACTION_INDEX) - the budget and the token
    // set exactly as they stand before the first sub-command runs - and are read-only. The
    // command loop is bounded ONLY by the 250-command cap, which is why that cap is the first
    // check in parse() and why this runs behind `!error`.
    //
    // `weightsActive` is the BATCH_COST_WEIGHTING verdict parse() already resolved once for
    // this batch. It is a PARAMETER rather than a second isEnabled call so every gated site in
    // this file reads ONE verdict, and it defaults to false so any caller written against the
    // pre-D10 signature keeps exactly the pre-D10 behaviour.
    async isGasProvablyUnaffordable(commands, data, normalize, weightsActive = false){
        if(data['IS_GENESIS'] || data['IS_EMISSION'])
            return false;
        if(this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']) !== 'xchain')
            return false;
        if(await this.protocolChanges.isEnabled('ISSUANCE_FEE', data['BLOCK_INDEX']) == false)
            return false;
        let unified = await this.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);

        let gasTick  = String(this.config['GAS']).toUpperCase();
        let priced   = {};   // TICK -> nominal fee, memoized so a repeated TICK costs one read
        let cheapest = null;
        // EXECUTE's floor is the same number for every sub-command in the batch, and computing
        // it costs one GAS-token probe. `undefined` means not computed yet; `null` means
        // computed and NOT positively known. Memoized here rather than in the constructor
        // because the probe is as-of THIS batch's (BLOCK_INDEX, ACTION_INDEX).
        let vmFloor;

        for(let command of commands){
            let parts  = String(command).split('|');
            let action = String(parts.shift()).toUpperCase();
            // Same normalization the dispatch loop applies, on this loop's own split copy, so
            // the TICK read below is the one the handler will parse (params[1] in all seven
            // ISSUE formats, after the implied legacy VERSION 0 is injected).
            if(normalize)
                action = this.normalizeSubAction(action, parts);

            // The nominal cost of THIS sub-command, or a bail-out. Every branch either
            // establishes a positively-known cost or returns false, which is the rule the
            // whole predicate rests on: no positive price evidence, no collapse.
            let cost = null;

            if(action === 'ISSUE'){
                let tick = (parts[1] === undefined || parts[1] === null) ? '' : String(parts[1]).trim();
                if(tick === '' || tick.charAt(0) == '^' || tick.toUpperCase() === gasTick)
                    return false;

                if(priced[tick] === undefined){
                    if(await this.probeTokenInfo(tick, data))
                        return false;
                    priced[tick] = this.nominalIssueFee(tick, unified);
                }
                cost = priced[tick];
            } else if(weightsActive && this.durationFeeActions.includes(action)){
                // D10. null means "not positively known" (an edit, a cancel, an unparseable
                // EXPIRATION), which is a bail-out exactly like an unknown action.
                cost = this.nominalDurationFee(action, parts, data, unified);
                if(cost === null)
                    return false;
            } else if(weightsActive && this.vmBaseFeeActions.includes(action)){
                // D10, the VM floor. Params are not read at all: the acceptance fee is a
                // schedule constant, so every EXECUTE in the batch quotes the same number and
                // one probe answers for all of them.
                if(vmFloor === undefined)
                    vmFloor = await this.nominalExecuteFee(data);
                if(vmFloor === null)
                    return false;
                cost = vmFloor;
            } else {
                return false;
            }

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

    // Cost weight of ONE sub-command (BATCH_COST_WEIGHTING / R7).
    //
    // THE INVARIANT, and every future weight class must preserve it: the return is an integer
    // >= 1. It is what makes the cheap count pre-filter in parse() a sound bound on this scan
    // (count > budget implies weight sum > budget, so an oversized batch is refused without
    // weighing anything), and a weight of 0 would let a batch carry unbounded sub-commands of
    // that action for free, which is the exact failure the budget exists to prevent.
    //
    // `action` arrives already alias-normalized by the caller, matching the dispatch loop.
    // `data` and `normalize` are unused by the default and table paths and are threaded through
    // for the fan-out classes (AIRDROP, DIVIDEND), whose weight is 1 + recipients and whose
    // recipient count is NOT on the wire: AIRDROP carries a LIST_ACTION_INDEX and DIVIDEND
    // carries only a TICK, so both need an as-of read. Those reads must be as-of
    // (BLOCK_INDEX, ACTION_INDEX) and resolve-only, the discipline probeTokenInfo and
    // probeTickerId already set in this file, or two nodes will weigh the same batch
    // differently and fork.
    //
    // Async from the outset for that reason: adding the first fan-out class must not change
    // this signature, because the signature is what parse() and every other weight class are
    // written against.
    //
    // Never throws. A weight crash here would halt block processing, and the safe fallback is
    // the default 1, which is the pre-flag behaviour for that sub-command.
    async subCommandWeight(action, command, data, normalize){
        try {
            let weight = this.commandWeights[action];
            if(weight === undefined)
                return 1;
            // Chunk-carrier DEPLOY (format 4) runs no constructor, so it takes the default
            // row-write weight rather than DEPLOY's VM weight. The format comes from the same
            // util.getFormatVersion(params[0]) derivation the dispatcher uses (see the
            // commandWeights['DEPLOY'] note above); anything unparseable falls through to the
            // full weight, which is the safe (over-charging) direction.
            if(action === 'DEPLOY' && this.util.getFormatVersion(String(command).split('|')[1]) === 4)
                return 1;
            return (Number.isInteger(weight) && weight >= 1) ? weight : 1;
        } catch(e) {
            return 1;
        }
    }

    // Total cost weight of a BATCH (BATCH_COST_WEIGHTING / R7).
    //
    // Plain integer arithmetic, not the bc* helpers: these are small counts, not token amounts,
    // and the surrounding cap logic has always compared counts with `>`. The loop is bounded by
    // the count pre-filter in parse(), which is why that filter runs first.
    //
    // Actions are read and alias-normalized exactly as the two scans below do it, off the raw
    // sub-command string, so the weight scan and the dispatch loop can never disagree about
    // what a sub-command IS.
    async batchWeight(commands, data, normalize){
        let total = 0;
        for(let command of commands){
            let action = String(command).split('|')[0];
            if(normalize)
                action = this.normalizeSubAction(action);
            total += await this.subCommandWeight(action, command, data, normalize);
        }
        return total;
    }

    async parse(params, data, error){
        // BATCH_SUBACTION_NORMALIZATION flag-day: when active, sub-actions get the same
        // alias rewrite + legacy VERSION-0 injection as top-level actions. Resolved once
        // per BATCH so every scan below gates identically.
        let normalize = await this.protocolChanges.isEnabled('BATCH_SUBACTION_NORMALIZATION', data['BLOCK_INDEX']);
        // BATCH_ISSUANCE_LIMITS flag-day: the global command cap, the dotted-TICK
        // exemption and the batch-cumulative value ledger below. Resolved once per BATCH,
        // like `normalize`, so every gated site in this file and every sub-command the
        // dispatch loop runs sees ONE verdict. The gate is registered at or after
        // BATCH_SUBACTION_NORMALIZATION (asserted in test/unit/batchIssuanceLimitsGate),
        // so wherever this is true, sub-command params are already normalized.
        let limitsActive = await this.protocolChanges.isEnabled('BATCH_ISSUANCE_LIMITS', data['BLOCK_INDEX']);
        // BATCH_COST_WEIGHTING flag-day: the flat command cap becomes a budget over per-action
        // cost weights. Resolved once per BATCH like the two above, so every gated site sees ONE
        // verdict. Registered at or after BATCH_ISSUANCE_LIMITS (asserted in
        // test/unit/batchCostWeightingGate.test.js), so wherever this is true the classification
        // and normalization the weight scan reads from are already in force.
        let weightsActive = await this.protocolChanges.isEnabled('BATCH_COST_WEIGHTING', data['BLOCK_INDEX']);
        // Clone before mutation: this raw copy is what gets stored in the batches table.
        let batch = structuredClone(data);

        let actions = {};

        // The DISTINCT keys of `actions`, in the order their FIRST sub-command appears in the
        // command list. R2b DECLARES that order: among per-ACTION caps, a batch breaking two of
        // them reports the action whose first sub-command comes earliest, and that string is
        // consensus. It is kept as its own list rather than read back off `actions` because the
        // tally is a plain object whose iteration order is a property of key INSERTION (and of
        // integer-like keys, which an unknown ACTION can produce), not a stated rule: a later
        // tidy-up to a Map, a sort, or a second counting pass would silently move a consensus
        // string. First-appearance was chosen precisely because it is what this loop and the SDK
        // mirror already did, so declaring it moves no verdict; do not "simplify" the cap loop
        // below back into an iteration over the tally.
        let actionOrder = [];

        // TICKs of this batch's MINT sub-commands, in list order, collected in the SAME pass
        // that counts them so the two can never disagree about which commands are MINTs
        // (D7 caps MINTs per DISTINCT token, so the count alone is no longer the whole story).
        // Populated only under the flag: below it nothing reads it and no work is done.
        let mintTicks = [];

        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        let commands = String(data['TX_DATA']).split(';');
        if(!error && (this.util.isNull(commands) || commands.length < 1)){
            error = 'invalid: COMMAND (unknown)';
        } else {
            // The first command still carries the BATCH|VERSION prefix; strip it.
            commands[0] = commands[0].replace('BATCH|' + format + '|','');
        }

        // Global command cap (BATCH_ISSUANCE_LIMITS), FIRST of the command checks.
        // It is the only check that bounds the two O(N) scans below, and running it
        // first PINS error precedence: a batch that breaks this rule and others reports
        // the cap, never the rule a later loop would have found. Counting semantics are
        // consensus-pinned: the raw ';'-split list AFTER the BATCH|<version>| prefix
        // strip, EMPTY elements included (an empty element already whole-batch-rejects
        // via the activation scan, so charging it a slot is consistent). Over-limit
        // takes the existing whole-batch shape: one invalid record, no sub-command runs.
        //
        // BATCH_COST_WEIGHTING replaces the count with a WEIGHT BUDGET in this same position,
        // for the same reason it had to be first, and reports the SAME string: the error is
        // still "this batch is too much work", only measured better.
        //
        // The count test survives as a PRE-FILTER rather than being deleted, and it is load
        // bearing twice over. Every weight is >= 1 (see subCommandWeight), so a batch whose raw
        // count already exceeds the budget cannot possibly weigh in under it: rejecting it here
        // is exact, not conservative. And weighing is not free - the fan-out classes need an
        // as-of read per sub-command - so without this filter the envelope lane's ~35,000
        // sub-commands would each buy a database read BEFORE anything bounded them, which is
        // the denial-of-service the budget exists to close rather than open.
        if(!error && limitsActive){
            if(commands.length > (weightsActive ? this.weightBudget : this.commandLimit)){
                error = 'invalid: COMMAND (limit)';
            } else if(weightsActive && await this.batchWeight(commands, data, normalize) > this.weightBudget){
                error = 'invalid: COMMAND (limit)';
            }
        }

        for(let command of commands){
            let action = String(command).split('|')[0];
            if(normalize)
                action = this.normalizeSubAction(action);
            if(limitsActive){
                action = this.classifyLimitAction(action, command, normalize);
                if(action === 'MINT')
                    mintTicks.push(this.subCommandTick(action, command, normalize));
            }
            if(this.util.isNull(actions[action])){
                actions[action] = 0;
                // First sighting, and this IS the list walk, so pushing here is what makes the
                // cap loop's order list-driven (R2b) rather than tally-driven.
                actionOrder.push(action);
            }
            actions[action]++;
        }

        for(let command of commands){
            let action = String(command).split('|')[0];
            if(normalize)
                action = this.normalizeSubAction(action);
            if(!error && await this.protocolChanges.isEnabled(action, data['BLOCK_INDEX']) == false)
                error = 'invalid: ACTION (unknown)';
        }

        // Per-ACTION caps in force for THIS batch. Below the flag this IS the pre-flag table,
        // by identity, so nothing about an old batch can move; at/after it the gated caps
        // (DEPLOY, D5) are merged into a COPY, never into either stored table.
        let actionLimits = limitsActive ? Object.assign({}, this.actionLimits, this.gatedActionLimits) : this.actionLimits;

        // Walked in first-appearance order (R2b), which is why `actionOrder` exists: the action
        // that names the error must be decided by the command LIST, never by however the tally
        // object happens to enumerate.
        for(let action of actionOrder){
            let count = actions[action];
            // D7: MINT is capped per DISTINCT TOKEN rather than per batch, so what the cap is
            // compared against is the largest number of MINTs naming ONE token, not the raw
            // occurrence count. Guarded by !error because it is the only branch in this loop
            // that touches the database: an already-invalid batch keeps its cheaper verdict
            // and pays for no reads, exactly as the R4 pre-check below does.
            if(!error && limitsActive && action === 'MINT')
                count = await this.maxMintsPerDistinctTick(mintTicks);
            if(!error && Object.keys(actionLimits).includes(action) && count > actionLimits[action])
                error = 'invalid: ' + action  + ' (limit)';
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Aggregate gas pre-check (BATCH_ISSUANCE_LIMITS / R4, spec decision D3 2026-08-13).
        // LAST of the checks by design: it is the only one that costs database reads (one per
        // DISTINCT new TICK plus one balance read), so every cheaper verdict above short-circuits
        // it through `!error`, and the 250-command cap - still the FIRST check - is what bounds
        // its loop. Precedence therefore stays exactly as R2/F7 pinned it: a batch that breaks
        // the cap, the per-ACTION limits or the activation scan reports THAT error, never this
        // one. See isGasProvablyUnaffordable for why the predicate is the cheapest sub-command
        // and not the sum.
        //
        // `weightsActive` is threaded in for D10: at/after BATCH_COST_WEIGHTING the predicate
        // can also price an ORDER/SWAP/DISPENSER create, so an all-ORDER no-gas batch collapses
        // to one invalid record the same way an all-ISSUE one already does. Below that flag the
        // argument is false and the predicate is byte-identical to its pre-D10 self.
        if(!error && limitsActive && await this.isGasProvablyUnaffordable(commands, data, normalize, weightsActive))
            error = 'invalid: GAS (insufficient)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = batch['STATUS'] = status;

        console.log("\t BATCH : " + data['SOURCE'] + ' : ' + data['STATUS']);

        await this.indexerDb.createBatch(batch);

        this.util.addAddressTicker(data['SOURCE']);

        await this.mapper.createMappings(data);

        if(status=='valid'){

            // Pre-parse all sibling commands so child handlers can inspect them
            // (e.g. SEND verifying a paired MESSAGE for gated token transfers).
            // See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
            let siblings = [];
            for(let command of commands){
                let parts  = String(command).split('|');
                let name   = String(parts[0]).toUpperCase();
                let sibParams = parts.slice(1);
                if(normalize)
                    name = this.normalizeSubAction(name, sibParams);
                siblings.push({ action: name, params: sibParams, raw: command });
            }
            data['SIBLING_ACTIONS'] = siblings;

            // Snapshot the transaction-level field names. Anything a sub-action
            // adds beyond these is action-specific and must be cleared before the
            // next sub-action runs, otherwise it bleeds across commands (e.g. a
            // FILE leaves FORMAT=0 + ENCRYPTION_METHOD set, and a following
            // MESSAGE v2 then parses under FILE's v0 format (its ciphertext lands
            // in ENCRYPTION_METHOD) and is wrongly rejected).

            // Batch-cumulative value ledger (BATCH_ISSUANCE_LIMITS).
            //
            // TX_OUTPUTS and the transaction's settlement values are TRANSACTION-level
            // state: the loop below preserves them across every sub-command, and each
            // per-command check read them UNTOUCHED. Sub-command i asked "does this
            // transaction carry enough to cover me?", passed, and sub-command i+1 asked the
            // same question of the same untouched value, so ONE command's worth of native
            // fee satisfied all N (and one COINPAY payment settled N obligations).
            //
            // This object is the running tally of what earlier sub-commands already spent.
            // It is seeded HERE, before the baseKeys snapshot, precisely so the
            // field-clearing loop below treats it as transaction-level and preserves it;
            // seeded after the snapshot it would be deleted before the second sub-command
            // ran, which is the bug wearing a ledger. Consumers live in the SHARED
            // validators (util.validateNativeCoinFee and the COINPAY/DISPENSE value reads)
            // so all twelve fee-bearing handlers are covered by one change rather than
            // twelve; a handler that never sees this key (any non-BATCH transaction, or a
            // pre-flag-day BATCH) behaves byte-identically to before.
            //
            // Amounts are decimal STRINGS accumulated with bcadd at 8dp, never JS numbers.
            // The three fields cover the three transaction-level values a sub-command can
            // consume: the native fee output paying FEE_DESTINATION, the settlement value
            // COINPAY/DISPENSE draw down, and the per-oracle fee outputs a DISPENSER pays.
            // oracleFeeConsumed is keyed BY ORACLE ADDRESS, not a scalar: one batch can
            // reference several oracles, and one oracle's exhausted output must not
            // invalidate a sub-command paying a different one.
            if(limitsActive)
                data['BATCH_VALUE_LEDGER'] = {
                    nativeFeeConsumed:  '0',
                    coinAmountConsumed: '0',
                    oracleFeeConsumed:  {}
                };

            // Public BATCH pre-flight collectors (spec row 46). data['FEE_PROBE'] is set ONLY
            // on the synthetic transaction the read-only quote surfaces build (actions.js
            // sources it from tx.fee_probe), so it is false for every decoded transaction and
            // nothing in this block can move a consensus value. Seeded here, above the
            // baseKeys snapshot, for the same reason the value ledger is: the per-sub-command
            // field clear below would otherwise delete them before the second command ran.
            //
            //   PROBE_SUB_VERDICTS - each dispatched sub-command's own verdict, in list order.
            //   PROBE_ORACLE_FEES  - per-oracle fees owed, filled in by dispenser.js.
            //
            // Both are probe-LOCAL and deliberately separate from BATCH_VALUE_LEDGER: that
            // key's PRESENCE is how coinpay.js, dispense.js and validateOracleFee recognise
            // "inside a flagged batch", and its CONTENTS are consensus state a read-only
            // surface must never write. Nothing below writes to it.
            let isProbe = data['FEE_PROBE'] === true;
            if(isProbe){
                data['PROBE_SUB_VERDICTS'] = [];
                data['PROBE_ORACLE_FEES']  = {};
            }

            let baseKeys = new Set(Object.keys(data));

            let batchPosition = -1;
            for(let command of commands){
                batchPosition++;
                params = String(command).split('|');
                let action = String(params.shift()).toUpperCase();

                // Normalize the sub-action like a top-level action would be
                // (alias rewrite + legacy VERSION-0 injection) so FORMAT
                // derivation and handler dispatch below see canonical input.
                if(normalize)
                    action = this.normalizeSubAction(action, params);

                // Clear action-specific fields left by the previous sub-action.
                for(let key of Object.keys(data))
                    if(!baseKeys.has(key)) delete data[key];

                // Update ACTION transaction data object. FORMAT must be derived
                // from THIS command's version (params[0]) rather than left stale.
                data['ACTION']  = action;
                data['TX_DATA'] = command;
                data['FORMAT']  = this.util.getFormatVersion(params[0]);

                // Each command gets its own ACTION_INDEX.
                data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(data, true);

                // This subcommand's 0-based position in the BATCH's command list.
                // Every subcommand is its own ROOT action but they all share the
                // transaction's single TX_VOUT, so the position is the only
                // content-derived value that tells two same-contract EXECUTE
                // subcommands apart in the ATTEST request_id / XCALL call_id
                // preimages (src/batch_root_discriminator.js; whether it actually
                // enters a preimage is decided by that gate, not here). Set after
                // the clear above, which drops every non-base key each iteration.
                data['BATCH_POSITION'] = batchPosition;

                // STRUCTURAL VM REFUSAL on the public pre-flight path (spec row 46). This is
                // what lets BATCH be pre-flighted at all without lifting it out of
                // FEE_QUOTE_DENYLIST: the batch runs for real here, minus the commit, while
                // holding the block-loop transaction mutex, so dispatching a sub-command that
                // enters the VM would hand an unauthenticated caller exactly the block-loop-
                // stalling compute primitive that denylist exists to close.
                //
                // Placed HERE, immediately above the dispatch, on the SAME `action` variable
                // processAction receives - after the uppercase and after normalizeSubAction's
                // alias rewrite. A pre-scan of the wire string (actions.js
                // _batchProbeForbiddenSubAction) refuses the batch earlier and more cheaply,
                // but only this one is impossible to spell around, because there is no further
                // transformation between the check and the call.
                if(isProbe && probeForbiddenSubAction(action)){
                    data['PROBE_SUB_VERDICTS'].push({
                        position: batchPosition,
                        action:   action,
                        status:   null,
                        refused:  'VM action not dispatched on the public pre-flight'
                    });
                    continue;
                }

                // Probe only: clear the previous sub-command's verdict so a handler that
                // returns without recording one (a settlement leg that skips, e.g. coinpay.js
                // on an unmatched payee) reports null rather than inheriting its predecessor's
                // status. STATUS is a base key, so the field clear above never touches it.
                if(isProbe) delete data['STATUS'];

                await this.actions.processAction(action, params, data, error);

                if(isProbe)
                    data['PROBE_SUB_VERDICTS'].push({
                        position: batchPosition,
                        action:   action,
                        status:   (data['STATUS'] === undefined) ? null : data['STATUS'],
                        refused:  null
                    });
            }
        }

        // Probe only: the dispatch loop leaves data['STATUS'] holding the LAST sub-command's
        // verdict, so restore the BATCH's own. Without this the pre-flight would answer for
        // whichever command happened to come last - which reads as a verdict on the batch and
        // is not one. Per-sub-command verdicts are reported separately in PROBE_SUB_VERDICTS.
        if(data['FEE_PROBE'] === true) data['STATUS'] = status;
    }
}

module.exports = Batch;