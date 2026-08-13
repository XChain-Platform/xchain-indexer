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
    // prevent, and the same aliasing hole XC-1457 closed on the ISSUE path.
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
    // WHAT IS COVERED: ISSUE of a non-caret TICK that does not already exist. Everything else
    // returns false (let it through) on FIRST sight, because its nominal cost is not knowable
    // here:
    //  - non-ISSUE actions: ORDER/SWAP/DISPENSER/BET price off EXPIRATION days and escrow
    //    state, AIRDROP/DIVIDEND off recipient counts, CALLBACK/SWEEP off db_hits, DEPLOY off
    //    code bytes. Each is computed by the handler from params it alone parses.
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
    async isGasProvablyUnaffordable(commands, data, normalize){
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

        for(let command of commands){
            let parts  = String(command).split('|');
            let action = String(parts.shift()).toUpperCase();
            // Same normalization the dispatch loop applies, on this loop's own split copy, so
            // the TICK read below is the one the handler will parse (params[1] in all seven
            // ISSUE formats, after the implied legacy VERSION 0 is injected).
            if(normalize)
                action = this.normalizeSubAction(action, parts);
            if(action !== 'ISSUE')
                return false;

            let tick = (parts[1] === undefined || parts[1] === null) ? '' : String(parts[1]).trim();
            if(tick === '' || tick.charAt(0) == '^' || tick.toUpperCase() === gasTick)
                return false;

            if(priced[tick] === undefined){
                if(await this.probeTokenInfo(tick, data))
                    return false;
                priced[tick] = this.nominalIssueFee(tick, unified);
            }
            if(cheapest === null || this.util.bclt(priced[tick], cheapest))
                cheapest = priced[tick];
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
        // Clone before mutation: this raw copy is what gets stored in the batches table.
        let batch = structuredClone(data);

        let actions = {};

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
        if(!error && limitsActive && commands.length > this.commandLimit)
            error = 'invalid: COMMAND (limit)';

        for(let command of commands){
            let action = String(command).split('|')[0];
            if(normalize)
                action = this.normalizeSubAction(action);
            if(limitsActive){
                action = this.classifyLimitAction(action, command, normalize);
                if(action === 'MINT')
                    mintTicks.push(this.subCommandTick(action, command, normalize));
            }
            if(this.util.isNull(actions[action]))
                actions[action] = 0;
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

        for(let action in actions){
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
        if(!error && limitsActive && await this.isGasProvablyUnaffordable(commands, data, normalize))
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

                await this.actions.processAction(action, params, data, error);
            }
        }
    }
}

module.exports = Batch;