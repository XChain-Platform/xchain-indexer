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
 * XChain Platform Action - BATCH: the per-token MINT cap
 *
 * At/after BATCH_ISSUANCE_LIMITS a BATCH may carry one MINT per DISTINCT token rather
 * than one MINT in total. Distinctness is judged on the resolved ticker id, read
 * without interning. These are Batch prototype methods, installed by index.js, so
 * each runs with the instance as `this`.
 *
 ********************************************************************/

// Resolve a TICK to its ticker id WITHOUT interning it (BATCH_ISSUANCE_LIMITS per-token MINT cap).
//
// Same resolve-only discipline as probeTokenInfo (fees.js), for the same reason: this runs over
// untrusted wire ticks, before validity is decided, up to the 250-command cap. getTickerId
// is a pure SELECT today (createTicker is the only interning path, and it hands any ^-led
// tick straight back to getTickerId without ever inserting one), so the lever changes no
// verdict here; it is set anyway so a future interning read cannot silently start burning
// dense id space from a pre-check. `prior` is restored (not hardcoded false) in a finally,
// so nesting and throws cannot leak suppression into the next read.
async function probeTickerId(tick){
    let prior = this.indexerDb.suppressIndexIdCreation;
    this.indexerDb.suppressIndexIdCreation = true;
    try {
        return await this.indexerDb.getTickerId(tick);
    } finally {
        this.indexerDb.suppressIndexIdCreation = prior;
    }
}

// Largest number of MINT sub-commands in this BATCH naming the SAME token
// (the per-token MINT cap that arrives with BATCH_ISSUANCE_LIMITS).
//
// The flag replaces the flat "one MINT per BATCH" with "one MINT per DISTINCT token, any number
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
async function maxMintsPerDistinctTick(ticks){
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

module.exports = { probeTickerId, maxMintsPerDistinctTick };
