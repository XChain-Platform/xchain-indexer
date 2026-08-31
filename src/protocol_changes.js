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
 * XChain Indexer - Protocol Changes Class
 * 
 * This file defines all the supported actions and protocol changes
 *
 ********************************************************************/

// VM async/Promise flag-day, single source of truth for the cross-repo coupling
// guard. This MUST stay byte-identical to xchain-vm's ASYNC_SURFACE_GATE_BLOCK_TIME;
// a one-sided edit forks the fleet on the first async-using DEPLOY/EXECUTE after the
// earlier of the two timestamps. consensus-params.test.js asserts the two are equal.
const VM_BANNED_ASYNC_MAINNET_TIME = 1786060800;

// H-3 flag-day: deterministic (time-gated) price_snapshots selection for
// native-coin fee validation on non-reference chains (see the
// NATIVE_FEE_PRICE_TIME_GATE registration below). Same coordinated 2.0.0
// contract-era timestamp as the other flag-days; a divergent value forks the
// fleet on the first fee-bearing LTC/DOGE action after the earlier timestamp.
const NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME = 1786060800;

// Mainnet arm for UNCAPPED_MAX_SUPPLY_ZERO. 9999999999 (year 2286) is the
// house UNARMED sentinel, the same one price_pair_activation.js uses: the operator
// ratified the PRODUCT direction (MAX_SUPPLY=0 stays the uncapped sentinel) on
// 2026-08-11 but has NOT yet minted the mainnet flag-day the rule switches on, and a
// loosening cannot be armed at a guessed value. Arming it is a one-line edit of this
// constant; until then the rule is inert on mainnet and live from genesis on
// testnet/regtest. Do NOT arm it at the 2026-08-07 contract-era anchor: that date is
// already past, and a loosening with a retroactive boundary makes a from-genesis
// replay accept mints the live fleet rejected.
const UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME = 9999999999;

// Mainnet arm for CROSS_SETTLE_PER_BLOCK_CAP. Same house UNARMED sentinel
// as the constant above (9999999999, year 2286): the operator ruled on 2026-08-11
// that the CROSS_SETTLE per-block cap lands behind a flag day rather than ungated
// under the pre-launch wipe-and-replay route, and ratifying the anchor is a
// separate act that has not happened yet. Arming it is a one-line edit here.
// Until then the cap is inert on mainnet (the pass runs uncapped exactly as the
// live chains have always run it) and live from genesis on testnet/regtest.
// Do NOT arm it at the 2026-08-07 contract-era anchor: that date is already past,
// and a TIGHTENING with a retroactive boundary makes a from-genesis replay defer
// settlements the live fleet already applied, which is the fork the gate exists to
// prevent.
const CROSS_SETTLE_CAP_MAINNET_TIME = 9999999999;

// Mainnet arm for BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR, the per-subcommand root
// discriminator that stops two same-contract EXECUTE subcommands of one BATCH from
// deriving the IDENTICAL ATTEST request_id (see the registration below). Same house
// UNARMED sentinel as the two constants above (9999999999, year 2286): the operator
// ruled the remedy on 2026-08-11 but naming the activation instant is a separate act
// no lane may perform, and a consensus preimage cannot be moved at a guessed value.
// Arming it is a one-line edit here. Until then the discriminator is inert on mainnet
// (the preimage is assembled exactly as the live chains have always assembled it) and
// live from genesis on testnet/regtest. Do NOT arm it at the 2026-08-07 contract-era
// anchor: that date is already past, and a preimage change with a retroactive boundary
// makes a from-genesis replay derive request_ids the live fleet never wrote, which is
// the fork the gate exists to prevent.
const BATCH_ROOT_SUB_INDEX_MAINNET_TIME = 9999999999;

// Arms for ISSUE_INHERITED_MINT_WINDOW, the re-parameterization fix that scopes the ISSUE
// mint-window recency checks (MINT_START_BLOCK / MINT_STOP_BLOCK must be >= the current
// block) to values the ISSUE EXPLICITLY carries on the wire. Below the flag day those
// checks also run against values INHERITED from the existing token record by the
// populate-empty-params merge, which makes every re-parameterizing ISSUE on a token
// permanently invalid the moment its mint window opens: the inherited MINT_START_BLOCK is
// by then necessarily in the past, so an owner ISSUE that raises MAX_MINT while leaving
// the window untouched is rejected with 'MINT_START_BLOCK < BLOCK_INDEX' (and, once the
// window closes, the same again via MINT_STOP_BLOCK). Remedy ruled by the operator on
// 2026-08-22: exempt inherited values, keep the recency check on explicit ones, so the
// anti-backdating purpose is untouched (see actions/issue.js).
//
// Mainnet: house UNARMED sentinel (9999999999, year 2286). The ruling settled the REMEDY;
// naming the mainnet instant is a separate act, and a loosening cannot be armed at a
// guessed value. Arming it is a one-line edit here. Do NOT arm it at a past instant: a
// loosening with a retroactive boundary makes a from-genesis replay accept re-issues the
// live fleet rejected.
const ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME = 9999999999;

// Testnet: ARMED (operator remedy ruling 2026-08-22, pre-launch) at 1787961600 =
// 2026-08-29T00:00:00Z. RE-PINNED FORWARD on 2026-08-25 for the v0.11.0 train, per the
// standing rule below: the original 1787529600 (2026-08-24T00:00:00Z) had lapsed before
// this code shipped, so the live fleet would have applied the legacy rule past it while a
// from-genesis replay applied the new one. The remedy is unchanged and needs no re-ruling;
// only the instant moves, and the fresh 2026-08-24 testnet genesis makes the original
// reason for a future instant (BTC testnet4's recorded rejection at block 149546) moot,
// since that block is now below every chain's first indexed block.
// The instant must still be in the FUTURE when this ships: an
// activation already past is not a flag day at all, because the fleet applies the
// legacy rule beyond it while a from-genesis replay applies the new one, and the two
// diverge at the first comparison. Re-pin this constant forward if it lapses.
// This is the FIRST nonzero testnet threshold in this file, and
// deliberately so: unlike the sibling gates (registered while testnet carried no history
// the rule reinterprets), BTC testnet4 already holds a recorded rejection of exactly this
// shape (the XCHAIN faucet correction ISSUE, block 149546), so a genesis-active testnet
// arm would fork every already-synced testnet node against a fresh reindex. A FUTURE
// instant preserves the recorded history and lets the correction be rebroadcast once the
// boundary passes. Every testnet indexer (all three chains) must be running this code
// before the instant; testnet4 tips may carry timestamps up to ~2h ahead of wall clock,
// so the deploy needs to land with that margin. Regtest stays genesis-active (0): suites
// and regtest venues exercise the corrected rule from block 0.
const ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME = 1787961600;

// Mainnet arm for BATCH_ISSUANCE_LIMITS, the BATCH issuance rework: the dotted-TICK
// exemption that lets one BATCH carry a parent plus any number of child ISSUEs, the global
// 250-command cap that bounds the scan it rides on, the batch-cumulative fee/settlement
// accounting that stops one command's fee from satisfying all N, and the caret-TICK and
// ticker-intern tightenings that ship with them (see the registration below).
//
// ARMED 2026-08-14 (operator), pre-launch, at 1786838400 = 2026-08-16T00:00:00Z.
//
// It was parked on the house UNARMED sentinel (9999999999) while the public-repo release
// was prepared; the operator lifted that on 2026-08-14 on the grounds that the platform is
// pre-launch with no live fleet to coordinate, so the set does not need a ceremonial flag
// day. What it DOES still need is the property this file has always enforced, and the
// instant above satisfies both halves of it:
//
//   - FUTURE, never retroactive. This entry carries BOTH a loosening (the exemption) and
//     several TIGHTENINGS (the cap, the fee ledger), so a backdated boundary forks a
//     from-genesis replay in BOTH directions at once: the replay would reject batches the
//     chain accepted AND accept batches it rejected. That hazard is independent of how
//     busy the chain is, which is why "pre-launch" does not license a past instant.
//   - At or after BATCH_SUBACTION_NORMALIZATION (mainnet 1786060800, 2026-08-07), because
//     classification reads the TICK out of NORMALIZED sub-command params. The assertion in
//     test/unit/batchIssuanceLimitsGate.test.js is what actually holds that ordering.
//
// OPERATIONAL DEPENDENCY, and it is the real one: every mainnet indexer must be running
// this code BEFORE the instant. The mainnet indexers deliberately do not track
// master, so this does not reach them by `xchain-node update` on its own - it is an
// explicit deploy. A node still on the pre-arm code at 2026-08-16T00:00:00Z applies the
// old rules past the boundary and forks from the ones that did.
const BATCH_ISSUANCE_LIMITS_MAINNET_TIME = 1786838400;

// Mainnet arm for BATCH_COST_WEIGHTING, the weighted per-BATCH cost budget that replaces
// the flat 250-command cap registered above (see claude/specs/batch-cost-weighting.md).
//
// UNARMED, on the house sentinel (9999999999, year 2286), and deliberately so.
//
// WHY IT IS A SECOND FLAG RATHER THAN A WIDENING OF THE ONE ABOVE. That one arms at
// 2026-08-16T00:00:00Z, and folding this in would mean shipping a consensus cap-model
// replacement, its client mirrors, its prose and its replay evidence under that clock.
// The operator established on 2026-08-14 that a pre-launch flag day is cheap - arming the
// set above cost one deploy cycle - so a second boundary is a far better price than a
// rushed one. Once the instant above passes, this entry is what makes re-expressing the
// cap possible at all without rewriting armed history.
//
// WHAT IT GATES. The flat count check becomes a WEIGHT BUDGET: each sub-command
// contributes a weight and the batch caps their SUM. The budget stays 250 and the default
// weight is 1, so every batch carrying no VM and no fan-out action is admitted or refused
// EXACTLY as it is today, byte for byte - that compatibility is the design's own proof and
// is what acceptance test A1 measures over a real corpus. The rule only bites where the
// flat cap was already wrong: DEPLOY (one consumes the budget), EXECUTE/XEXEC (VM compute,
// capped at nothing today) and AIRDROP/DIVIDEND (one sub-command writes a row PER
// RECIPIENT).
//
// Gated because it moves verdicts in BOTH directions, which is also why the instant may
// never be backdated: batches that were valid become invalid (a second DEPLOY, N EXECUTEs,
// a wide fan-out) and the weight arithmetic changes which sub-commands run at all, both of
// which change the actions/ledger state hashed into the checkpoint preimage. Keyed on
// block TIME like every sibling BATCH gate, for the same reason: BATCH runs on BTC, LTC and
// DOGE, whose heights diverge by millions of blocks, so no single height names one cutover
// across all three but a single timestamp does.
//
// This entry MUST activate at or after BATCH_ISSUANCE_LIMITS above. The budget check
// REPLACES that entry's command cap in the same position (first, so it still bounds the
// O(N) scans behind it) and reuses its classification of sub-commands; a window where this
// is live and that is not would run a weight scan over un-normalized params AND would leave
// the batch with no bound at all in the gap. Nothing in isEnabled() enforces the ordering,
// so test/unit/batchCostWeightingGate.test.js asserts it per network.
const BATCH_COST_WEIGHTING_MAINNET_TIME = 9999999999;

// Mainnet arm for EMISSION_ISSUANCE_LIMITS: VM-emitted ISSUEs counted against
// the SAME per-transaction top-level issuance limit the wire path has always carried.
//
// UNARMED, on the house sentinel (9999999999, year 2286), and deliberately so.
//
// WHAT IT GATES. Every ISSUE, whatever emitted it, draws from one per-TRANSACTION budget
// of ONE top-level (undotted) tick; dotted child ticks stay exempt exactly as batch.js
// exempts them, and a caret TICK is never exempt (its dot is a decimal, not a namespace
// separator). Below the flag nothing counts and every historical verdict replays
// byte-identically.
//
// WHY IT EXISTS. execute.js routes a VM emission straight to the ISSUE handler, past the
// per-BATCH limit scan that is the only place top-level issuance was ever counted, and
// ISSUANCE_FEE_EMISSION_EXEMPT (armed) makes those emissions fee-free. One EXECUTE could
// therefore register up to maxEmissions (50) top-level names for nothing, and a BATCH of
// 250 EXECUTEs up to 12,450 - which is the namespace the dotted/undotted rule exists to
// protect. Operator decision 2026-08-15: count them, rather than charge them or widen the
// per-EXECUTE emission cap.
//
// WHY IT IS ITS OWN FLAG rather than a widening of BATCH_ISSUANCE_LIMITS above: that entry
// arms at 2026-08-16T00:00:00Z, and a node still on pre-arm code would apply the old rules
// past the boundary and fork. A tightening that lands after an armed instant needs its own
// boundary, never a retroactive edit of an armed one.
//
// Keyed on block TIME like every sibling issuance gate: ISSUE runs on BTC, LTC and DOGE,
// whose heights diverge by millions of blocks, so no single height names one cutover
// across all three but a single timestamp does.
const EMISSION_ISSUANCE_LIMITS_MAINNET_TIME = 9999999999;

// Consensus protocol version, COMPILED IN.
//
// isEnabled() compares this against the version registered on every protocol
// change, so it decides WHICH consensus rules this node applies. It used to be
// `process.env.npm_package_version || require('../package.json').version`,
// which made a consensus input out of npm packaging metadata: a routine
// `npm version` bump moved it, a bare `node src/api.js` resolved it
// differently from `npm run`, and a host whose node_modules/package.json
// disagreed resolved it differently again. Two nodes resolving two values fork
// on the first version-gated action, silently, with no flag-day involved.
//
// Pinning it here decouples packaging from consensus in both directions:
// releasing a new npm version no longer touches consensus, and moving consensus
// is now a deliberate one-line edit reviewed on its own merits. The pin is kept
// equal to the package version by assertConsensusVersionPin() (called at
// indexer boot) and by test/unit/protocol_changes.test.js, so the two cannot
// drift apart unnoticed; that equality is what makes this change a no-op on
// every host today (spec §7 pre-window gate).
// RENUMBERED ONTO THE PLATFORM VERSION STREAM (2026-08-14, first train).
//
// This repo's package version moved from its own stream (2.7.17) to the shared
// platform stream, whose first release is 0.9.0. The pin above must equal the
// package version, so it moved too, and the registry below had to move WITH it:
// every change was registered at 1.0.0 or 2.0.0, and 0.9.0 is BELOW both, so
// leaving the registry alone would have disabled all 89 changes at once and
// made this node compute entirely different state. The gate caught exactly that.
//
// The registry was shifted ORDINALLY, not flattened: 1.0.0 -> 0.1.0 and
// 2.0.0 -> 0.2.0. Flattening both tiers to one number was tried first and the
// suite rejected it, because tests such as "a pre-consensus (v1.x) node treats
// it as not-yet-active" depend on the two tiers being distinguishable. The shift
// preserves that ordering exactly; it only re-expresses it underneath the
// platform stream.
//
// WHY THIS IS NOT A CONSENSUS CHANGE. The version gate disabled nothing before
// (0 of 89 at 2.7.17) and disables nothing after (0 of 89 at 0.9.0), so the
// enabled set is identical; activation is decided by the per-network time/block
// arguments, which were not touched. The registry and this constant live in the
// same file and ship in the same artifact, so a node can never run one without
// the other.
//
// A future change gates normally against the platform stream: register it at the
// platform version it ships in, and nodes below that version treat it as
// not-yet-active exactly as before.

// The registry stays put across the 0.9.0 -> 0.10.0 move: every change registers
// at 0.1.0 or 0.2.0, and isEnabled() ranks components numerically rather than
// lexically, so 0.10.0 outranks both and the enabled set holds at 90 of 90.
// 0.12.0 -> 0.12.1 registers nothing new. The patch restores admission of anchor
// bytes the judge already had to read, so the enabled set is identical and no
// activation argument moved; the pin advances only because it must track the
// package version, which is what keeps a node from applying a rule set it was
// not built for.
const CONSENSUS_VERSION = '0.12.1';

// Predicate for the NATIVE_FEE_PRICE_TIME_GATE flag-day. Its ONE consumer is
// utility.getFeeOraclePrices (query selection); nothing else in src/ consults it.
// XChainIndexer's time-keyed price barrier is deliberately NOT gated on this
// predicate: it runs on every chain whenever hub-db sync is enabled, because FIAT
// dispenser settlement reads price_snapshots by time from day one. Rationale and
// the divergence it closes: XChainIndexer.js:877-888. Semantics match the
// registry entry: testnet/regtest active from genesis, mainnet at the
// flag-day; an unknown/empty network is treated like mainnet (conservative:
// requires the flag-day).
function isNativeFeePriceTimeGateActive(network, blockTime){
    if(network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(Number(blockTime)) && Number(blockTime) >= NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;
}

// No-op proof for the consensus-version pin (spec §7 pre-window gate).
//
// Called at indexer boot. Asserts that pinning the consensus version changed
// nothing on THIS host, by comparing the compiled pin against the value the
// pre-pin code would have resolved. Both pre-pin sources are checked: the
// package.json this process actually loaded, and npm_package_version when the
// launcher set it. A mismatch means this host's consensus rules would have
// moved at the moment the pin shipped, which is the fork the pin exists to
// prevent, so it aborts the boot instead of reporting it.
//
// It stays in place after the rollout as a drift guard: it is what keeps a
// later `npm version` bump from silently separating the package version from
// the consensus version. Bumping the package is then a two-line change, and the
// second line is the deliberate consensus decision.
function assertConsensusVersionPin(){
    const packaged = require('../package.json').version;
    if(packaged !== CONSENSUS_VERSION)
        throw new Error('ProtocolChanges: consensus version pin ' + CONSENSUS_VERSION +
            ' does not match package.json version ' + packaged +
            '. These must move together: update CONSENSUS_VERSION in src/protocol_changes.js ' +
            'as a deliberate consensus decision, or revert the package bump. Refusing to boot ' +
            'rather than apply a consensus rule set this host was not meant to apply.');
    const env = process.env.npm_package_version;
    if(env && env !== CONSENSUS_VERSION)
        throw new Error('ProtocolChanges: consensus version pin ' + CONSENSUS_VERSION +
            ' does not match npm_package_version ' + env +
            '. Before the pin this host resolved consensus from that env var, so the pin is ' +
            'NOT a no-op here and deploying it would move this node\'s activation set.');
    return CONSENSUS_VERSION;
}

class ProtocolChanges {

    // @param {indexer}          object  Indexer instance
    // @param {consensusVersion} string  TEST-ONLY explicit consensus version
    //                                   (semantic XX.XX.XX). Production passes
    //                                   nothing and gets the compiled pin.
    constructor(indexer, consensusVersion){
        this.config    = indexer.config;
        this.util      = indexer.util;
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // Consensus version: the compiled pin, never npm metadata (see
        // CONSENSUS_VERSION). The override exists so the activation suites can
        // drive isEnabled() across version boundaries without reaching through
        // the environment; it is an explicit argument precisely so no ambient
        // value can supply it by accident, and production (XChainIndexer:
        // `new changes(this)`) never passes it. A malformed override throws
        // rather than falling back, since a silent fallback would let a broken
        // test seam masquerade as the production pin.
        if(consensusVersion !== undefined){
            if(typeof consensusVersion !== 'string' || consensusVersion.split('.').length !== 3)
                throw new Error('ProtocolChanges: consensusVersion override must be a semantic version string (XX.XX.XX), got ' + JSON.stringify(consensusVersion));
            this.version = consensusVersion;
        } else {
            this.version = CONSENSUS_VERSION;
        }
        // Read the network from the validated config (config.getConfig() sets NETWORK after
        // boot rejects an invalid network via coins.getCoinConfig) rather than re-reading the
        // raw process.env.INDEXER_NETWORK. A single validated source keeps the consensus
        // activation gate in isEnabled() aligned with every other config.NETWORK consumer and
        // removes the chance of the two diverging if the env is ever mutated after boot.
        this.network = this.config.NETWORK;

        // PROTOTYPE-FREE, and that is a consensus property rather than tidiness. Every read of
        // this map is a bare `this.changes[name]` where `name` is an UNTRUSTED ACTION name off
        // the wire, so on a plain object `constructor`, `toString`, `valueOf`, `hasOwnProperty`
        // and `__proto__` all resolve to an inherited member. That member is truthy, so
        // isEnabled() takes its `if(change)` branch, every gate field is undefined, every
        // numeric comparison is NaN (so no `>` is ever true), and `enabled` stays TRUE at any
        // block on any network. A BATCH sub-command named `constructor` therefore PASSED the
        // activation scan that an unregistered name fails - the same scan the decoder's
        // whole-batch-rejection mirror relies on. isDefined() answered true for all five, and
        // addChange() would also have refused a legitimately-named change as a duplicate.
        // Object.create(null) closes all of it at the source instead of at each read site, so a
        // future reader cannot reintroduce it by adding a sixth lookup.
        this.changes = Object.create(null);
        this.parseChanges();
    }

    parseChanges(){

        // Define `ACTION` commands and activation time/blocks (ALL UPPER case)
        this.addChange('ADDRESS',    '0.1.0',0,0,0,0,0,0);
        this.addChange('AIRDROP',    '0.1.0',0,0,0,0,0,0);
        this.addChange('BATCH',      '0.1.0',0,0,0,0,0,0);
        this.addChange('BET',        '0.1.0',0,0,0,0,0,0);
        this.addChange('BROADCAST',  '0.1.0',0,0,0,0,0,0);
        this.addChange('CALLBACK',   '0.1.0',0,0,0,0,0,0);
        this.addChange('DESTROY',    '0.1.0',0,0,0,0,0,0);
        this.addChange('DISPENSER',  '0.1.0',0,0,0,0,0,0);
        this.addChange('DIVIDEND',   '0.1.0',0,0,0,0,0,0);
        this.addChange('DISPENSE',   '0.1.0',0,0,0,0,0,0);
        this.addChange('FILE',       '0.1.0',0,0,0,0,0,0);
        this.addChange('ISSUE',      '0.1.0',0,0,0,0,0,0);
        this.addChange('LINK',       '0.1.0',0,0,0,0,0,0);
        this.addChange('LIST',       '0.1.0',0,0,0,0,0,0);
        this.addChange('MESSAGE',    '0.1.0',0,0,0,0,0,0);
        this.addChange('MINT',       '0.1.0',0,0,0,0,0,0);
        this.addChange('ORDER',      '0.1.0',0,0,0,0,0,0);
        this.addChange('SEND',       '0.1.0',0,0,0,0,0,0);
        this.addChange('SLEEP',      '0.1.0',0,0,0,0,0,0);
        this.addChange('SWAP',       '0.1.0',0,0,0,0,0,0);
        this.addChange('SWEEP',      '0.1.0',0,0,0,0,0,0);
        this.addChange('COINPAY',        '0.1.0',0,0,0,0,0,0);
        this.addChange('COINPAY_EXPIRE', '0.1.0',0,0,0,0,0,0);

        // VM actions (all chains). DEPLOY covers inline (v0/v1), chunked-assemble
        // (v2/v3), and the chunk carrier (v4): all gated under this one entry.
        this.addChange('DEPLOY',             '0.2.0',0,0,0,0,0,0);
        this.addChange('EXECUTE',            '0.2.0',0,0,0,0,0,0);
        this.addChange('DEPOSIT',            '0.2.0',0,0,0,0,0,0);
        this.addChange('WITHDRAW',           '0.2.0',0,0,0,0,0,0);

        // Inline DEPLOY (v0/v1) CODE_ENCODING format. Below this activation the inline
        // contract source is decoded as HEX (the original format); at/above it as BASE64
        // (1.33x the source vs hex's 2x, and base64's alphabet has no '|' so it stays safe
        // in the pipe-delimited action string). Gated so a heterogeneous fleet and any
        // from-genesis replay decode every historical inline DEPLOY identically: an ungated
        // flip silently re-reads every hex-era DEPLOY as base64, which changes its code_hash
        // → the per-block contract_hash → the federation checkpoint preimage, forking the
        // ledger. Keyed on block_TIME (not block_index) on purpose: DEPLOY runs on BTC, LTC
        // and DOGE, whose heights diverge by millions of blocks, so no single shared block
        // height can name one coordinated cutover across all three chains, but a single
        // timestamp can. testnet/regtest activate at genesis (base64-native; no pre-base64
        // history to preserve, and the e2e/regtest stack deploys base64 from block 0).
        // The mainnet timestamp below is the coordinated contract-era flag-day:
        // 1786060800 == 2026-08-07 00:00:00 UTC, aligned with
        // the SDK base64 rollout. It must stay equal to every other 2.0.0
        // contract-era entry in this file and to xchain-vm's
        // ASYNC_SURFACE_GATE_BLOCK_TIME; a wrong value is a second fork.
        this.addChange('DEPLOY_BASE64_CODE', '0.2.0',1786060800,0,0,0,0,0);

        // Staking actions: capability variants (STAKE v1/v2, UNSTAKE v0, DELEGATE v0/v2, COLLECT) are BTC-only;
        // contract variants (STAKE v3, UNSTAKE v1, DELEGATE v1/v3) work on any chain
        this.addChange('STAKE',              '0.2.0',0,0,0,0,0,0);
        this.addChange('UNSTAKE',            '0.2.0',0,0,0,0,0,0);
        this.addChange('DELEGATE',           '0.2.0',0,0,0,0,0,0);
        this.addChange('COLLECT',            '0.2.0',0,0,0,0,0,0);
        // SLASH: permissionless capability-stake equivocation slashing (WI-2 bump 2). The
        // verifier only ACCEPTS proofs whose two messages carry the EQUIV header, so slashing
        // is naturally inert until the EQUIV flag-day (no coupling with the SLASH protocol gate).
        this.addChange('SLASH',              '0.2.0',0,0,0,0,0,0);

        // PRICE action: validator oracle (v0) and user oracle (v1) pricing
        // Publishable on any chain (DOGE recommended for low fees)
        this.addChange('PRICE',              '0.2.0',0,0,0,0,0,0);

        // VOTE action: token-weighted governance polls. Single action with
        // v0=create poll, v1=cast ballot (v2=system finalize is Phase 2).
        // Genesis-active here for regtest/testnet prototyping; mainnet gets a
        // coordinated flag-day timestamp before BTC activation.
        // (See xchain-documentation/protocol/actions/VOTE.md)
        this.addChange('VOTE',               '0.2.0',0,0,0,0,0,0);

        // External attestation framework: single ATTEST action with v0=request, v1=response, v2=expire
        // (See xchain-documentation/protocol/actions/ATTEST.md)
        this.addChange('ATTEST',             '0.2.0',0,0,0,0,0,0);

        // ANCHOR: DOGE-only on-chain state commitments: v0=checkpoint,
        // v1=checkpoint+match archive, v2=archive continuation
        // (See xchain-documentation/protocol/actions/ANCHOR.md)
        this.addChange('ANCHOR',             '0.2.0',0,0,0,0,0,0);

        // Cross-chain contract calls: XCALL v0=request (VM-emission-only; never
        // decoded from the wire), v2=expire (system-synthesized). The relay rows
        // ride the hub mirror; registered for consistency/documentation.
        // (See xchain-documentation/protocol/actions/XCALL.md)
        this.addChange('XCALL',              '0.2.0',0,0,0,0,0,0);

        // NODEPROOF: full-node possession-proof verdict (v0; validator-broadcast).
        // Records which validators answered the derived possession challenge, so the
        // verified set earns the full-node oracle-round reward tranche. BTC-only.
        // (See xchain-documentation/protocol/actions/NODEPROOF.md)
        this.addChange('NODEPROOF',          '0.2.0',0,0,0,0,0,0);

        // ROLLCALL: validator liveness presence proofs (v0; validator-broadcast).
        // Inverts its NODEPROOF neighbour above: DOGE-only, because that is where
        // every validator can already publish. Carries a BTC epoch height and is
        // proved BTC-side at the epoch close. Registered at all-zero columns like
        // every other action: the per-network HEIGHT gate is ROLLCALL_ACTIVATION in
        // rollcall_activation.js, not this registry, so mainnet stays inert here.
        // (See xchain-documentation/protocol/actions/rollcall.md)
        this.addChange('ROLLCALL',           '0.2.0',0,0,0,0,0,0);

        this.addChange('UNIFIED_FEES',   '0.2.0',0,0,0,0,0,0);
        // INVENTORY-ONLY, gates nothing. Nothing calls
        // isEnabled('VM_ACTIONS'): the VM actions it nominally covered
        // (DEPLOY/EXECUTE/DEPOSIT/WITHDRAW) are gated by their own '2.0.0' action
        // registrations above and dispatched directly from actions.processAction.
        // Kept declared, not deleted, because the cross-repo action-manifest prose
        // cites it by name as the canonical example of a non-action feature gate.
        // Genesis-active (all-zero), so there is no enablement hazard either way;
        // do NOT wire a consumer to it without a flag-day, since flipping a
        // genesis-active gate into a real one changes replay.
        this.addChange('VM_ACTIONS',     '0.2.0',0,0,0,0,0,0);
        // Cross-chain DEX gate: when enabled, ORDER/SWAP allow GET_COIN != COIN and the
        // xchain-hub federation drives cross-chain matching + mirror-delivered settlement.
        // Genesis-activated (pre-launch).
        this.addChange('CROSS_CHAIN_DEX','0.2.0',0,0,0,0,0,0);
        // Origin-standing dispenser creates: the SOURCE of a prior VALID
        // dispenser create on GET_ADDRESS (its "origin") may open additional
        // dispensers on that address without the freshness check or
        // DISPENSER_PREFERENCE=2. Completes the one-main-address-managing-
        // many-dispenser-addresses pattern (origin already holds permanent
        // refill/close authority via the v1/v2 owner check).
        // Genesis-activated (pre-launch).
        this.addChange('DISPENSER_ORIGIN_STANDING','0.2.0',0,0,0,0,0,0);
        // FIAT dispenser settlement: a dispenser carrying FIAT_CODE is priced by
        // reverse price matching rather than by GET_AMOUNT, in either mode
        // (validator PRICE v0 snapshot, or a user PRICE v1 oracle when
        // ORACLE_ADDRESS is set). Below activation a FIAT dispenser cannot settle
        // at all and its dispense records 'invalid: FIAT dispenser pricing not
        // active'; above it, actions/dispense.js runs the reverse match.
        //
        // Genesis-activated (pre-launch), and provably free of replay
        // consequences: retrofitted 2026-07-24 after confirming every mainnet
        // chain holds ZERO dispensers and ZERO dispenses (BTC, LTC and DOGE
        // mainnet indexer DBs all read 0/0/0), so there is no history in which
        // the gated branch was ever taken and genesis-on is byte-identical to
        // the ungated code it replaces.
        //
        // Registered for two reasons even though it is on everywhere today.
        // First, inventory: every sibling dispenser rule is gated
        // (dispenser_caps, dispenser_freshness, dispenser_ownership_cancel,
        // DISPENSER_CLOSE_PER_UNIT, DISPENSER_ORIGIN_STANDING) and a
        // consensus-affecting settlement path that appears in no activation map
        // is invisible to the flag-day tooling. Second, and the reason to do it
        // now rather than later: any future correction to the matching algorithm
        // needs a gate to hang a height off, and once a mainnet FIAT dispenser
        // exists that retrofit costs a cohort height plus a replay-compatibility
        // branch. Doing it while the set is empty costs nothing (an earlier
        // dispenser-unit correction already demonstrated the shape this will need).
        this.addChange('FIAT_DISPENSER_PRICING','0.2.0',0,0,0,0,0,0);
        // Issuance fee activation. Mainnet turns on at the historical block 862633;
        // testnet/regtest charge from block 0 so the fee path is exercisable there.
        // mainnet_block=862633 is a BTC block height used as an 'always-on' activation
        // for LTC and DOGE (both passed this height long ago). This is intentional legacy
        // behaviour. A single cross-chain activation height is chosen from BTC; see
        // xchain-documentation/protocol/CONFIGURATION.md for the rationale.
        this.addChange('ISSUANCE_FEE',   '0.1.0',0,0,0,862633,0,0);
        // VM-emitted ISSUE (IS_EMISSION) issuance-fee exemption. A contract
        // constructor (or EXECUTE) that emits an ISSUE has no XCHAIN balance on the
        // freshly deployed contract address, so charging ISSUANCE_FEE against the
        // emitted ISSUE fails fee validation and reverts the constructor, so the
        // deployer already paid the DEPLOY/EXECUTE gas (base + per-byte + per-
        // emission), so the emitted ISSUE is fee-exempt. Gated as its own
        // consensus rule so the change in fee behaviour switches over at a
        // coordinated flag-day rather than implicitly the moment a node upgrades:
        // an ungated flip charges the fee on one node version and exempts it on
        // another at the SAME block, forking the ledger and the contract-state
        // checkpoint on the first constructor that emits an ISSUE. Keyed on
        // block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE. Emitted
        // ISSUEs ride DEPLOY/EXECUTE, which run on BTC, LTC and DOGE whose heights
        // diverge by millions of blocks, so no single shared block height names one
        // cutover across all three chains, but a single timestamp does. The mainnet
        // timestamp is the same coordinated contract-era flag-day as the base64
        // rollout (2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07), aligned with the
        // other contract-deploy consensus fixes shipping in this window; a wrong
        // value is a second fork.
        // testnet/regtest activate at genesis (no pre-exemption history to preserve;
        // the e2e/regtest stack exercises VM emissions from block 0).
        this.addChange('ISSUANCE_FEE_EMISSION_EXEMPT', '0.2.0',1786060800,0,0,0,0,0);

        // VM getBalance()/getTokenInfo() reader. Below this activation the gateway
        // receives balances:null / tokenInfo:null in every execution path (the
        // original VM behaviour through 2.7.10); at/above it the indexer feeds the
        // deterministic buildVmBalancesAndTokenInfo snapshot scoped to SOURCE + the
        // contract's derived address. Gated as its own consensus rule because the
        // accessor is a NEW VM input: the first contract that calls getBalance or
        // getTokenInfo computes different gas_used, emitted_count, and ledger
        // movements on a node that feeds real balances vs one that still passes
        // null: an ungated flip forks the contract_hash (and the federation
        // checkpoint preimage) the moment a balance-reading contract executes, even
        // within the 2.x line (2.2.0–2.7.10 lack the reader; 2.7.11+ have it).
        // Keyed on block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE and
        // ISSUANCE_FEE_EMISSION_EXEMPT. DEPLOY/EXECUTE run on BTC, LTC and DOGE
        // whose heights diverge by millions of blocks, so no single shared block
        // height names one cutover across all three chains, but a single timestamp
        // does. The mainnet timestamp is the same coordinated contract-era flag-day
        // as the other contract-deploy consensus fixes in this window (2026-08-07
        // 00:00:00 UTC, CONFIRMED 2026-07-07); a wrong value is a fork. testnet/regtest
        // activate at genesis (no pre-reader history to preserve; the e2e/regtest
        // stack exercises VM balance reads from block 0).
        this.addChange('VM_BALANCE_TOKENINFO', '0.2.0',1786060800,0,0,0,0,0);

        // Programmable-policy controller guard. Below this activation the bound
        // controller's `guard` method is NEVER run: every SEND/ORDER/SWAP/DISPENSER/
        // DESTROY on a controller-bound token settles with its plain (un-guarded)
        // semantics, no allow/deny veto, no royalty/fee payout_legs written, and no
        // guard contract_executions row, exactly as a node that lacks the controller
        // layer behaves. At/above it the shared chokepoint (_invokeController in
        // utility.js) runs the guard, may DENY the action, and may attach payout_legs
        // that the match-time proceeds split applies. Gated as its own consensus rule
        // because the guard is a NEW, ungated acceptance + ledger rule: a node version
        // with the controller layer and one without it process the SAME guarded action
        // differently (one allows/redirects funds, the other settles plainly), forking
        // the ledger AND the per-block contract_hash (guard emissions now write a guard
        // contract_executions row, so they contribute to the checkpoint preimage) on the
        // first guarded action. A single flag-day flips the whole surface: VM execution,
        // payout_legs write, match-time applyProceedsSplit, and the contract_hash
        // contribution, atomically across all nodes. Keyed on block_TIME (not
        // block_index), mirroring DEPLOY_BASE64_CODE / ISSUANCE_FEE_EMISSION_EXEMPT /
        // VM_BALANCE_TOKENINFO. Guarded actions run on BTC, LTC and DOGE whose heights
        // diverge by millions of blocks, so no single shared block height names one
        // cutover across all three chains, but a single timestamp does. The mainnet
        // timestamp is the same coordinated contract-era flag-day as the other
        // contract-era consensus fixes in this window (2026-08-07 00:00:00 UTC,
        // CONFIRMED 2026-07-07), aligned with the operator fleet upgrade before any
        // CONTROLLER-bound token is issued on mainnet; a wrong value is a fork. testnet/regtest activate
        // at genesis (no pre-guard history to preserve; the e2e/regtest stack exercises
        // controller guards from block 0).
        this.addChange('CONTROLLER_GUARD', '0.2.0',1786060800,0,0,0,0,0);

        // MINT-1: per-address mint allowance counts SELF-MINTED supply only.
        // Below this activation the MINT_ADDRESS_MAX check measures MINT-action
        // credits to SOURCE (the original behaviour), which also counts tokens the
        // address merely RECEIVED as another mint's DESTINATION, so a griefer can
        // exhaust any address's allowance by gifting minted supply to it. At/above
        // it the check measures the mints table by the action's SOURCE (only mints
        // the address itself authored count). Gated as its own consensus rule
        // because the fix is a validity LOOSENING: a MINT that historical processing
        // rejected ('mint exceeds MINT_ADDRESS_MAX' because of received supply)
        // becomes valid under the new measure, so an ungated flip forks a
        // heterogeneous fleet on the first such mint and breaks from-genesis replay
        // byte-identity. Keyed on block_TIME and armed at the ratified coordinated
        // anchor 1786060800 (2026-08-07 00:00:00 UTC), the confirmed 2.0.0
        // contract-era cohort, for the reasons stated at DEPLOY_BASE64_CODE above;
        // a divergent value is a fork.
        // testnet/regtest activate at genesis (no history to preserve; the
        // e2e/regtest stack exercises the corrected measure from block 0).
        this.addChange('MINT_SELF_MINTED_ONLY', '0.2.0',1786060800,0,0,0,0,0);

        // BonkDAO-class guard: a BINDING poll (VOTE v0 that names a
        // CALLBACK_CONTRACT, so its finalization can move contract-held value)
        // must set its own turnout floor: QUORUM required, MIN_VOTERS >= 1
        // required. Without them a treasury-binding poll with the default
        // 'balance' weighting is exactly the 2026-07 BonkDAO drain: an attacker
        // buys a sliver of supply, proposes, and passes it alone while nobody
        // is watching. Signaling polls
        // (blank CALLBACK_CONTRACT) stay permissive. Gated as its own consensus
        // rule because the requirement is a validity TIGHTENING: a v0 create
        // that historical processing accepted becomes invalid, so an ungated
        // flip forks a heterogeneous fleet on the first such poll and breaks
        // from-genesis replay byte-identity. Keyed on block_TIME and armed at
        // the ratified coordinated anchor 1786060800 (2026-08-07 00:00:00 UTC),
        // the confirmed 2.0.0 contract-era cohort, for the reasons stated at
        // DEPLOY_BASE64_CODE above; a divergent value is
        // a fork. testnet/regtest activate at genesis (no history to preserve;
        // the e2e/regtest stack exercises the requirement from block 0).
        this.addChange('VOTE_BINDING_MINIMUMS', '0.2.0',1786060800,0,0,0,0,0);

        // BonkDAO lesson 3: optional timelock between poll finalization
        // and the binding callback's execution. v0 gains a trailing
        // CALLBACK_DELAY_BLOCKS field: when set (> 0), the v2 finalize freezes
        // the tally and settles the deposit as always but DEFERS the callback
        // EXECUTE to resolved_block + delay (stamped as polls.callback_due_block,
        // fired by the per-block sweep), giving holders and guardians a reaction
        // window between a hostile pass and the value actually moving. Below the
        // activation the field is IGNORED (parsed but nulled, exactly how a
        // legacy node's setActionParams drops params beyond its format), so
        // acceptance and callback timing stay byte-identical to old nodes.
        // Gated as its own consensus rule because honoring the field changes
        // WHICH BLOCK the callback EXECUTE lands in (different actions rows,
        // contract_hash, checkpoint preimage): an ungated flip forks a
        // heterogeneous fleet on the first delayed poll. Keyed on block_TIME
        // and armed at the ratified coordinated anchor 1786060800
        // (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort,
        // for the reasons stated at DEPLOY_BASE64_CODE above; a divergent
        // value is a fork. testnet/regtest activate at
        // genesis (no history to preserve; the e2e/regtest stack exercises the
        // timelock from block 0).
        this.addChange('VOTE_CALLBACK_TIMELOCK', '0.2.0',1786060800,0,0,0,0,0);

        // VOTE-SLEEP-1: VOTE respects the self-sleep gate. SLEEP v0
        // freezes an address ("pauses actions on an ADDRESS") and every sibling
        // governance/content handler (list/link/broadcast/message/file/address)
        // rejects a sleeping SOURCE via isActionAllowed, but VOTE never checked
        // it: a self-slept address could still create and fund polls (v0 moves
        // GAS into escrow), cast ballots (v1) and set delegations (v3) during
        // its own freeze window. At/after this activation all three
        // user-broadcast VOTE versions reject a sleeping SOURCE with
        // 'invalid: SOURCE (sleeping)'; v2 finalize is system-synthesized and
        // stays exempt. The same activation also makes v3 validate a set
        // (non-blank) DELEGATE_TO with isCryptoAddress, matching
        // MESSAGE/DISPENSER address handling (before, a malformed target was
        // accepted and simply resolved to no holder at tally time). Gated
        // because both checks TIGHTEN validity on a genesis-active action (a
        // previously-valid VOTE becomes invalid), so an ungated flip forks a
        // heterogeneous fleet and diverges a from-genesis replay; mirrors
        // SLEEP_RESPECTS_LOCK_SLEEP. Keyed on block_TIME at the ratified
        // coordinated anchor 1786060800 (2026-08-07 00:00:00 UTC), the
        // confirmed 2.0.0 contract-era cohort; a divergent value is a fork.
        // testnet/regtest activate at genesis.
        this.addChange('VOTE_RESPECTS_SLEEP', '0.2.0',1786060800,0,0,0,0,0);

        // BonkDAO lesson 4: expose a poll's electorate TICK to
        // contracts so a binding-poll callback can verify WHICH token decided
        // it (the treasury template's arm() pins poll.tick === its governing
        // govTick, defeating a "raid a throwaway token's poll to drain an
        // unrelated treasury" swap). Two surfaces flip together at this
        // activation: (1) the finalize/timelock callback EXECUTE gains a `tick`
        // positional arg inserted after min_voters_met and before the
        // developer callback params, and (2) each getPollResultsForVM snapshot
        // entry (backing xchain.getPollResult) gains a `tick` field. The tick
        // is the poll's immutable electorate (polls.tick_id resolved through
        // index_tickers), deterministic on every node and on replay. Gated as
        // its own consensus rule because BOTH changes alter VM execution
        // inputs: the callback arg shifts every developer param one position
        // (a contract reading getInputParam(7) reads a different value), and
        // adding a snapshot key changes what a contract observes via the poll
        // accessor - an ungated flip forks a heterogeneous fleet on the first
        // binding-poll callback or tick-reading contract. Keyed on block_TIME
        // and armed at the ratified coordinated anchor 1786060800 (2026-08-07
        // 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort, for the reasons
        // stated at DEPLOY_BASE64_CODE above; a divergent value is a fork. testnet/regtest
        // activate at genesis (no history to preserve; the e2e/regtest stack
        // exercises the visible tick from block 0).
        this.addChange('VOTE_POLL_TICK_VISIBLE', '0.2.0',1786060800,0,0,0,0,0);

        // ATTEST v1 canonical id-case normalization. Below this activation
        // the canonical signing bytes (and the EQUIV ROUND_ID) use the RAW wire
        // REQUEST_ID case, the original behaviour: a case-mutated replay of a
        // pending v1 fails ed25519 verification because the hub signed the
        // lowercase id, and every node rejects it identically. At/above it the
        // canonical uses the LOWERCASED id, making byte-identity with the hub's
        // AttestationConsensus._buildCanonical self-contained instead of resting
        // on the external producer-lowercases invariant. Gated as its own
        // consensus rule because the switch is a validity LOOSENING: wire bytes a
        // legacy node rejects (uppercase id, lowercase-signed sigs) verify on an
        // upgraded node, so an ungated flip lets any attacker split a
        // heterogeneous fleet with a single case-mutated replay (which is why the
        // inline fix was deferred to this flag-day). Keyed on block_TIME and
        // armed at the ratified coordinated anchor 1786060800 (2026-08-07
        // 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort, for the reasons
        // stated at DEPLOY_BASE64_CODE above; a divergent value is
        // a fork. testnet/regtest activate at genesis (no history to preserve;
        // the e2e/regtest stack exercises the self-contained canonical from
        // block 0).
        this.addChange('ATTEST_CANONICAL_LOWERCASE_ID', '0.2.0',1786060800,0,0,0,0,0);

        // Attestation Phase 5 (spec §12): the origin-side half of the
        // cross-chain relay. Below this activation an ATTEST v0 emitted by an
        // LTC or DOGE contract is REJECTED at admission, because
        // Attest._computeResponsibleSet returns [] on any non-BTC chain (the
        // capability stake that qualifies attestation validators exists only on
        // BTC) and ATTEST_ADMISSION_ACTIVATION rejects a request whose
        // responsible set is smaller than its REDUNDANCY. At/above it such a
        // request is instead admitted 'pending' and marked with its origin
        // chain, so the hub's relay driver can materialize it onto BTC (ATTEST
        // v3) and relay the response back (ATTEST v4). Nothing else about
        // admission changes: a request that fails any OTHER validation is still
        // rejected, and on BTC the rule is a no-op because a BTC responsible set
        // is never empty by construction.
        //
        // Keyed on block_TIME for the same reason ATTEST_CANONICAL_LOWERCASE_ID
        // above is: the rule must flip on LTC and DOGE, whose local heights sit
        // millions of blocks above any BTC-derived threshold, so a height gate
        // carrying a BTC value would already be satisfied there and would ship
        // the rule live instead of inert (the ATTEST_ADMISSION_ACTIVATION plane
        // trap, documented in attest_admission_activation.js). The mainnet
        // timestamp is ARMED to the same ratified contract-era cohort anchor
        // 1786060800; a divergent value is a fork. The BTC-anchored half of
        // Phase 5 (accepting v3/v4 on the wire) rides ATTEST_RELAY_ACTIVATION in
        // attest_relay_activation.js; either order of the two is safe, see the
        // note there. testnet/regtest activate at genesis.
        this.addChange('ATTEST_RELAY_ORIGIN', '0.2.0',1786060800,0,0,0,0,0);

        // VM xchain.attestation.getResponse(requestId) reader. Below this
        // activation the VM snapshot's attestationData is always null, so
        // getResponse() returns null for every request (the pre-reader behaviour);
        // the callback EXECUTE remains the only channel a contract observes a
        // response through. At/above it execute.js pre-loads this contract's
        // fulfilled responses (getAttestationDataForVM) into the snapshot and
        // getResponse() returns { status, payload, providerId, blockIndex,
        // validatorCount } for any prior fulfilled request from the SAME contract.
        // Gated as its own consensus rule because it adds a NEW read source to the
        // VM: a contract that branches on getResponse() sees null on a legacy node
        // and a populated object on an upgraded node, forking a heterogeneous fleet
        // (and the per-block contract_hash, since the divergent branch writes
        // different state) on the first getResponse-reading contract. Keyed on
        // block_TIME and armed at the ratified coordinated anchor 1786060800
        // (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort, for
        // the reasons stated at DEPLOY_BASE64_CODE above; a divergent value is a
        // fork. testnet/regtest
        // activate at genesis (no pre-reader history to preserve; the e2e/regtest
        // stack exercises getResponse from block 0).
        this.addChange('VM_ATTESTATION_GETRESPONSE', '0.2.0',1786060800,0,0,0,0,0);

        // Synthesized-execution TX_HASH on the injected-callback seam. Four
        // sites inject a system EXECUTE that runs a contract callback (attest.js v1
        // response + v2 expiry, vote.js poll-finalize, xcall.js result); two of them
        // historically omitted TX_HASH, so a contract emitting ATTEST/XCALL from
        // inside its expiry or poll-finalize callback was charged gas for an id the
        // indexer then hard-rejected ('invalid: TX_HASH'), stranding the contract
        // permanently. Below this activation those two sites keep the hashless
        // context (the original behaviour, so a from-genesis mainnet replay stays
        // byte-identical); at/above it every injected context carries a TX_HASH
        // (real when the trigger rode an on-chain tx, else the deterministic
        // sha256('TAG:NETWORK:CHAIN:UNIQUE_ID') synthesis in actions/execContext.js)
        // and execute.js hard-asserts the invariant so a fifth injector site cannot
        // regress the class. Gated as its own consensus rule because the switch is a
        // validity LOOSENING: an ATTEST/XCALL emission every legacy node rejects
        // becomes valid on an upgraded node, so an ungated flip forks a
        // heterogeneous fleet on the first contract that emits from such a callback.
        // Keyed on block_TIME and armed at the ratified coordinated anchor
        // 1786060800 (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era
        // cohort, for the reasons stated at DEPLOY_BASE64_CODE above; a divergent
        // value is a fork.
        // testnet/regtest activate at genesis (no hashless-callback history to
        // preserve; the e2e/regtest stack exercises the synthesized hash from
        // block 0).
        this.addChange('SYNTH_EXEC_TX_HASH', '0.2.0',1786060800,0,0,0,0,0);

        // Dispenser auto-close compares remaining inventory against the
        // PER-UNIT price, not a buyer's aggregate purchase. The legacy check
        // closes the dispenser when GIVE_REMAINING drops below the triggering
        // dispense's total give_amount (multiplier * GIVE_AMOUNT), so a large
        // order shuts a dispenser down early and non-deterministically based on
        // any one buyer's order size, even though enough escrow remains to
        // serve further single-unit buyers. At/above this activation the close
        // fires only when GIVE_REMAINING < the dispenser's per-unit GIVE_AMOUNT
        // (it genuinely cannot serve another unit). Gated as its own consensus
        // rule because the switch changes WHICH BLOCK a DISPENSER_CLOSE system
        // action lands in (different actions/dispenser_statuses rows, hence
        // different consensus block hashes): an ungated flip forks a
        // heterogeneous fleet on the first multi-unit dispense that empties
        // below the aggregate but not the per-unit threshold. Keyed on
        // block_TIME and armed at the ratified coordinated anchor 1786060800
        // (2026-08-07 00:00:00 UTC), the confirmed 2.0.0 contract-era cohort,
        // for the reasons stated at DEPLOY_BASE64_CODE above; a
        // divergent value is a fork. testnet/regtest activate at genesis (no
        // early-close history to preserve; the e2e/regtest stack exercises the
        // per-unit close from block 0).
        this.addChange('DISPENSER_CLOSE_PER_UNIT', '0.2.0',1786060800,0,0,0,0,0);

        // Mode B (user PRICE v1 oracle) dispenser settlement prices one TOKEN, not
        // one FILL. Below this activation actions/dispense.js takes the affordable
        // token count straight from utility.reverseOraclePriceMatch and uses it as
        // the FILL multiplier, then credits multiplier x GIVE_AMOUNT tokens, so a
        // dispenser giving N tokens per fill sold every token at 1/N of the price
        // its oracle published. At/above it the affordable token count is divided by
        // GIVE_AMOUNT first, so the published figure is what one token costs.
        //
        // Per-token is the canonical reading, and settlement was the only one of four
        // surfaces disagreeing with it: the protocol docs' Mode A and Mode B examples,
        // the wallet's oracle publishing form ("Price of one <TICK> in <FIAT>") and the
        // oracle-fee base all state the per-token price. That last one is money: the
        // fee is FEE x (oracle_price x GIVE_ESCROW) / coin_price, which is only the
        // projected proceeds if one dispense costs oracle_price x GIVE_AMOUNT, so
        // pre-activation an oracle at GIVE_AMOUNT 5 is PAID on five times what the
        // dispenser can actually take in.
        //
        // Gated as its own consensus rule because the switch changes the token
        // amount a settled dispense credits (different dispenses/credits/escrow
        // rows, hence different consensus block hashes): an ungated flip forks a
        // heterogeneous fleet on the first Mode B dispense against a dispenser whose
        // GIVE_AMOUNT is not 1. At GIVE_AMOUNT 1 the two readings coincide exactly,
        // which is why every documented example and every test before 2026-07-31
        // missed it.
        //
        // Keyed on block_TIME like the sibling dispenser rules. Minted at its own
        // future instant rather than reusing the contract-era anchor for the reason
        // CONTRACT_DELEGATION_MATERIALIZE states above: that anchor is already in
        // the past, and a retroactive boundary makes a from-genesis replay credit
        // different balances than the live fleet settled. It shares
        // CONTRACT_DELEGATION_MATERIALIZE's already-ratified post-contract-era
        // instant (2026-09-15 00:00:00 UTC) rather than inventing a second date;
        // mainnet is economically pre-launch, so this may be repinned EARLIER at any
        // time provided the value is still in the future when the last indexer and
        // sync process finishes deploying. Every indexer and sync process must carry
        // this gate before mainnet crosses it; a divergent value is a fork.
        // testnet/regtest activate at genesis (the per-fill reading has no history
        // worth preserving there, and the regtest stack is where the defect was
        // measured).
        this.addChange('DISPENSER_ORACLE_PER_TOKEN_PRICE', '0.2.0',1789430400,0,0,0,0,0);

        // Cross-chain royalty enforcement, layered on CONTROLLER_GUARD. Once the guard
        // produces royalty payout_legs (post-CONTROLLER_GUARD), a CROSS-CHAIN listing of
        // a royalty-bearing token needs its legs applied on the PROCEEDS chain, which
        // only a fleet that carries legs in the validator-signed match canonical can do.
        // Below this activation such a listing is DENIED at create ('royalty not
        // enforceable cross-chain', fail-closed: accepting it would silently evade the
        // royalty); at/above it the listing is accepted after every leg address proves
        // re-encodable to GET_COIN (Utility.canReencodeAddress), and the legs travel in
        // the signed match for settlement-time application. Same-chain royalties and
        // leg-less cross-chain listings are unaffected either side of the flag. This
        // entry gates the CREATE-side acceptance rule (local block, like any acceptance
        // rule); the match-canonical format flip is keyed on the BTC-anchored
        // snapshot_block via the twin-module pattern (see the STAKE_WEIGHTED_QUORUM note
        // below), NOT this entry. The mainnet timestamp is CONFIRMED (2026-07-07,
        // re-anchored the same day when the contract-era cohort moved to 2026-08-07) at
        // one quarter AFTER the CONTROLLER_GUARD flag-day (2027-01-01 00:00:00 UTC): the
        // deny window between the two dates is the safe interim while the fleet upgrades
        // to legs-in-canonical. The canonical partner is ARMED at BTC anchor 961000
        // (~2026-08-04), months before this date, satisfying the canonical-first
        // ordering; if the CONTROLLER_GUARD cohort moves again, re-anchor this one
        // quarter after it (never before the canonical partner); a wrong value is a
        // fork. testnet/regtest activate at genesis so the
        // propagate+apply path is exercisable from block 0; regtest accepts an env
        // override (a future activation time) so the OFF/deny path stays drillable on a
        // single-node regtest stack. The override is regtest-only ON PURPOSE: two
        // regtest nodes with different overrides fork each other, which is fine for a
        // one-node drill and unacceptable anywhere else.
        let ccRoyaltyRegtestTime = parseInt(process.env.CROSS_CHAIN_ROYALTY_REGTEST_TIME) || 0;
        this.addChange('CROSS_CHAIN_ROYALTY', '0.2.0',1798761600,0,ccRoyaltyRegtestTime,0,0,0);

        // Async/Promise contract surface (VM CONSENSUS_VERSION '2'). Below this
        // activation the on-chain deploy validator (validateSyntax) ACCEPTS a
        // contract that uses async/await or references the global Promise, and the
        // VM executes it with the Promise global present; the original pre-2.x.y
        // behaviour. At/above it the deploy validator REJECTS such a contract
        // (CODE_ENCODING: banned async surface) and the sandbox strips the Promise
        // global at execution. Gated as its own consensus rule because the change
        // flips both a deploy verdict (the resolved status string is hashed into the
        // block, and the contract's registration/non-registration is hashed state)
        // and an execution result (a Promise-referencing contract gets a different
        // gasUsed/status/emission set → contract_hash → federation checkpoint
        // preimage): an ungated flip forks a heterogeneous fleet on the first such
        // DEPLOY/EXECUTE, and a from-genesis replay on a new build would otherwise
        // produce a different verdict than the original live processing. The indexer
        // threads the resolved activation into vm.validateSyntax(code, {enforceBannedAsync})
        // (deploy.js); the matching execution-side Promise strip is gated VM-side on
        // the same flag-day (xchain-vm ASYNC_SURFACE_GATE_BLOCK_TIME). Keyed on
        // block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE: DEPLOY/EXECUTE
        // run on BTC, LTC and DOGE whose heights diverge by millions of blocks, so no
        // single shared block height names one cutover across all three chains, but a
        // single timestamp does. The mainnet timestamp is the same coordinated
        // contract-era flag-day as the other consensus fixes in this window
        // (2026-08-07 00:00:00 UTC, CONFIRMED 2026-07-07), aligned with the fleet
        // upgrade before any async/Promise-relevant DEPLOY is broadcast to
        // mainnet; a wrong value is a fork. testnet/regtest activate at genesis (no
        // pre-activation history to preserve; the e2e/regtest stack has run with the
        // rule live, so genesis activation preserves its current behaviour).
        this.addChange('VM_BANNED_ASYNC', '0.2.0',VM_BANNED_ASYNC_MAINNET_TIME,0,0,0,0,0);

        // VM deploy-linter hardening: one gate for the
        // six hardened lint-core rules (exponentiation `**`/`**=` ban, reserved
        // CONTRACT_WRAPPER control bindings, SAFE_MATH-complement Math ban,
        // dynamic import() rejection, shorthand `{ Promise }` rejection, and the
        // shadowed-local Promise relaxation), plus the VM's gated wrapper
        // closure move and corroborated error classifier. Deploy verdicts are
        // consensus: below the activation a deploy resolves exactly as it did
        // historically; deploy.js threads the resolved activation into
        // vm.validateSyntax(code, {enforceLintHardening}). Armed at the ratified
        // contract-era anchor, the SAME instant VM_BANNED_ASYNC activates (zero
        // partially-hardened window); the literal timestamp is pinned by
        // test/unit/flagdayPlaceholderGuard.test.js. testnet/regtest activate at
        // genesis (no pre-activation history to preserve). A divergent value is
        // a fork.
        this.addChange('VM_LINT_HARDENING', '0.2.0',1786060800,0,0,0,0,0);

        // ISSUE validity: strict LOCK_MAX_SUPPLY guard. Before this activation the guard used
        // a truthy check, so an explicit LOCK_MAX_SUPPLY=0 field (a no-op lock intent with no
        // cap declared) incorrectly triggered the 'invalid: LOCK_MAX_SUPPLY (no max supply)'
        // outcome. After activation the guard requires LOCK_MAX_SUPPLY==1, matching the field's
        // intended semantics. Gated so a heterogeneous fleet and any from-genesis replay all
        // switch at the same block: mainnet pins the same coordinated contract-era flag-day
        // as the sibling ISSUE/SLEEP validity gates below (2026-08-07 00:00:00 UTC) - a
        // mainnet_time of 0 would flip the verdict on binary version alone, forking a skewed
        // fleet on any ISSUE carrying an explicit LOCK_MAX_SUPPLY=0 and diverging a
        // from-genesis replay. testnet/regtest activate at genesis (all zeros).
        this.addChange('LOCK_MAX_SUPPLY_EXACT', '0.2.0',1786060800,0,0,0,0,0);

        // ISSUE validity: a NULL/absent prior lock value counts as UNSET.
        // getTokenInfo rebuilds token state by replaying the `issues` rows and SKIPS a
        // column that is NULL, so a token whose genesis ISSUE simply omitted the lock
        // fields (the create-time "don't lock anything" path, and 108 of 109 ticks on the
        // BTC regtest venue) reaches isValidLock with an UNDEFINED prior. Every comparison
        // there is loose-equality against '' / value / 0, and `undefined` matches none of
        // them, so the function fell through to false and issue.js reported
        // "invalid: <FIELD> (locked)" for a flag that had never been locked. Net effect:
        // a later LOCK was impossible for effectively every token, the create-time
        // checkbox was the only way a token ever became locked, each attempt burned a
        // protocol fee on a guaranteed-invalid action, and the refusal text asserted the
        // opposite of the truth. After activation an unset prior is treated exactly like
        // the '' prior the function already accepted, so an owner can freeze
        // supply/description/mint after launch. Locking stays one-way: a prior of 1 is
        // still refused a move to 0 on both sides of the gate.
        //
        // UNGATED as of the pre-launch redesign (spec §0). This rule was built under the
        // v1 three-key train and registered on its Key A block TIME (1796083200 =
        // 2026-12-01), because it CHANGES WHICH ACTIONS ARE VALID: an ungated flip on a
        // LIVE network would accept an ISSUE that peers on the old binary reject, forking
        // a heterogeneous fleet, and would break from-genesis replay byte-identity for any
        // historical LOCK that committed 'invalid'.
        //
        // Both of those hazards are what the redesign's mandatory fleet-wide
        // wipe-and-replay rebase removes: the platform has not launched, every byte of
        // derived state is operator-owned, no service keeps pre-batch derived state
        // through the window, and every node replays from genesis under these rules. With
        // no old prefix to preserve and no mixed fleet to straddle, the flag day protects
        // nothing and only costs a divergence risk of its own (a node that replays before
        // the date and one that replays after would disagree). So the gate is removed
        // rather than moved, per spec §0 "Fixes ship plain".
        //
        // The rule is applied to PRIOR STATE, not to issuance date, so on replay every
        // token with an unset lock prior becomes lockable regardless of when it was
        // issued: no reconciliation pass and no per-token grandfathering. Locking stays
        // one-way (a prior of 1 is still refused a move to 0). Any historical LOCK whose
        // verdict flips from 'invalid' to 'valid' on replay surfaces in the §3.1
        // snapshot diff and is adjudicated in the deploy report, which is exactly the
        // mechanism the redesign put there for this class of change.
        this.addChange('LOCK_NULL_PRIOR_UNSET', '0.2.0',0,0,0,0,0,0);

        // DEPLOY validity: integer COOLDOWN_BLOCKS. Before this activation the staking
        // cooldown was gated only by isNumeric + range, so a fractional value ('50.5')
        // deployed successfully and stored a fractional contracts.cooldown_blocks,
        // violating the documented unsigned-int bound (protocol/Contract_Staking.md
        // DEPLOY v1 field type) and flowing a non-integer COOLDOWN_END_BLOCK into
        // UNSTAKE. After activation the guard requires an integer, matching the
        // EXPIRATION siblings (order/swap/dispenser). Gated so a from-genesis replay
        // reproduces any historic fractional-cooldown accept verdict below the
        // flag-day: mainnet pins the same coordinated contract-era flag-day as the
        // sibling validity gates (2026-08-07 00:00:00 UTC); testnet/regtest activate
        // at genesis (all zeros).
        this.addChange('COOLDOWN_BLOCKS_INTEGER', '0.2.0',1786060800,0,0,0,0,0);

        // DEPLOY validity (Pkg6 / dede7788): an EXPLICIT SLASH_DESTINATION on a stakeable
        // DEPLOY (v1/v3) must resolve to a well-formed chain address. Before this activation
        // deploy.js only resolved the SDK's ^<id> compaction and never validated the result,
        // so an unresolvable caret id or a malformed literal was interned into the IMMUTABLE
        // contracts.slash_destination; every later slash then routed stake to an unspendable
        // address (permanent money loss). After activation the resolved destination is checked
        // with isCryptoAddress (mirroring mint.js / issue.js / dispenser.js). The 'BURN' sentinel
        // and the default-to-BURN path are exempt (they resolve to the trusted configured burn
        // address). Gated as its own consensus rule because rejecting a DEPLOY that historically
        // committed 'valid' changes both the acceptance verdict AND the contract_hash
        // (contracts.status_id is contract-hashed): an ungated flip forks a heterogeneous fleet
        // and breaks from-genesis replay byte-identity on the first stakeable DEPLOY carrying a
        // malformed SLASH_DESTINATION. mainnet pins the coordinated contract-era flag-day
        // (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis (all zeros).
        this.addChange('DEPLOY_SLASH_DEST_ADDRESS_VALID', '0.2.0',1786060800,0,0,0,0,0);

        // UNSTAKE validity (Pkg6 / 048fdea9 + ce6a484f): strict contract-cooldown derivation.
        // _parseContractUnstake historically computed COOLDOWN_END_BLOCK from
        // `(contractInfo && contractInfo.cooldown_blocks) ? Number(...) : 1000` - a fallback to
        // the capability-staking global 1000 that is a DEAD branch on the valid path (the
        // handler already rejects a null/non-stakeable cooldown, and DEPLOY enforces an integer
        // cooldown in [1,100000]) yet FIRED on every ERROR path (unknown target, not-stakeable,
        // no active stake), persisting a phantom BLOCK_INDEX+1000 into the INVALID
        // contract_unstakes row - a replicated, state_hash-covered column. After activation the
        // handler rejects a non-positive-integer contract cooldown outright (closing the latent
        // cross-file trap) and computes COOLDOWN_END_BLOCK only on the valid path, leaving error
        // rows at 0. The valid-path value is UNCHANGED (it always took Number(cooldown_blocks)),
        // so the only observable change is the error-path row value; gated so a from-genesis
        // replay / heterogeneous fleet reproduces the historic (phantom-1000) error-row values
        // below the flag-day. mainnet pins the coordinated contract-era flag-day (2026-08-07
        // 00:00:00 UTC); testnet/regtest activate at genesis (all zeros).
        this.addChange('UNSTAKE_CONTRACT_COOLDOWN_STRICT', '0.2.0',1786060800,0,0,0,0,0);

        // ISSUE validity: cumulative MINT_SUPPLY cap. Before this activation the only guard on
        // an ISSUE's MINT_SUPPLY was a single-shot `MINT_SUPPLY > MAX_SUPPLY` check, which
        // ignores supply that already exists: an owner could re-ISSUE the same tick with
        // MINT_SUPPLY repeatedly (LOCK_MINT_SUPPLY unset) and mint fresh supply past MAX_SUPPLY
        // (and past a locked NFT edition size), because MINT_SUPPLY is credited on every valid
        // ISSUE, not just the first. After activation the cap is enforced against
        // SUPPLY + MINT_SUPPLY, matching mint.js's cumulative MAX_SUPPLY invariant (bcadd(SUPPLY,
        // AMOUNT) > MAX_SUPPLY). Gated because it TIGHTENS validity (a previously-valid over-cap
        // re-ISSUE becomes invalid): an ungated flip would fork a heterogeneous fleet on the
        // first such re-ISSUE and diverge a from-genesis replay from the committed ledger_hash.
        // Same coordinated contract-era flag-day timestamp as the other tightening consensus
        // fixes in this window (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis
        // (all zeros) so the check is in force from block 0 there and in the unit/e2e suites.
        this.addChange('ISSUE_MINT_SUPPLY_CUMULATIVE_CAP', '0.2.0',1786060800,0,0,0,0,0);

        // SLEEP validity: honor the token's LOCK_SLEEP flag. Before this activation the SLEEP
        // handler never inspected tokenInfo['LOCK_SLEEP'], so a token issued with LOCK_SLEEP=1
        // (a documented, immutable "cannot be paused" guarantee holders rely on) could still be
        // frozen indefinitely by its owner (SLEEP|1|-1|TICK) - the only LOCK_* flag with zero
        // enforcement anywhere in src/. After activation a TICK sleep of a LOCK_SLEEP=1 token is
        // rejected ('invalid: LOCK_SLEEP'), mirroring the LOCK_MINT (mint.js) / LOCK_CALLBACK
        // (callback.js) enforcement pattern. Gated because it TIGHTENS validity (a previously-
        // valid SLEEP becomes invalid), so the fleet and any from-genesis replay must flip at one
        // coordinated block. Same contract-era flag-day timestamp as the other tightening fixes
        // (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis.
        this.addChange('SLEEP_RESPECTS_LOCK_SLEEP', '0.2.0',1786060800,0,0,0,0,0);

        // COINPAY_EXPIRE escrow-release amount correctness. A native-coin ORDER_MATCH
        // escrows the SELLER's token leg (order_matches give/get amount) and records a
        // coinpay_obligation whose COIN_AMOUNT is the BUYER's native-coin leg (a different
        // asset and quantity). The fulfill path (coinpay.js) correctly releases the token
        // leg (getOrderMatchAmounts) from escrow to the buyer. Before this activation the
        // EXPIRE path released obligation.COIN_AMOUNT of the seller's TOKEN back to the
        // seller instead: it credited a token quantity equal to the native-coin amount,
        // over- or under-releasing the seller's escrow by (COIN_AMOUNT - tokenAmount). An
        // over-release is a net-zero (+credit / -escrow) phantom mint out of the global
        // escrow pool that evades the per-block supply sanity check (same class as OM-1);
        // an under-release strands tokens in escrow. After activation the EXPIRE path
        // releases the same token leg the fulfill path does. Gated because it CHANGES a
        // consensus-visible ledger movement (the credited/escrow amounts, hashed into
        // balances_root + ledger_hash): an ungated flip forks a heterogeneous fleet on the
        // first native-coin coinpay expiry and diverges a from-genesis replay from the
        // committed ledger. Keyed on block_TIME (not block_index), mirroring the other
        // multi-chain gates: native-coin DEX pairs settle on BTC, LTC and DOGE whose
        // heights diverge by millions of blocks, so no single shared height names one
        // cutover across all three chains, but a single timestamp does. Same coordinated
        // contract-era flag-day as the other tightening fixes in this window (2026-08-07
        // 00:00:00 UTC); testnet/regtest activate at genesis (all zeros) so the correct
        // release is in force from block 0 there and in the unit/e2e suites.
        this.addChange('COINPAY_EXPIRE_TOKEN_AMOUNT', '0.2.0',1786060800,0,0,0,0,0);

        // COINPAY native-coin match reciprocity + role detection. A native-coin ORDER_MATCH
        // settles two-phase: order_match.js reserves the token seller's escrowed leg and
        // records a coinpay_obligation whose PAYER is the coin offerer and PAYEE is the token
        // seller; COINPAY/COINPAY_EXPIRE later release the seller's token leg. Which order is
        // the coin offerer vs the token seller must be identified IDENTICALLY in all three
        // files. findOrderMatches enforces the forward leg (orderInfo.GIVE == matchInfo.GET)
        // strictly but NULL-relaxes the reverse leg (orderInfo.GET == matchInfo.GIVE) so a
        // native-coin side can pair. That relaxation also lets a token-for-COIN order
        // (GET_TICK null) match a token-for-token maker whose GIVE_TICK is a real token: no
        // side actually gives native coin to the coin-wanting side, yet order_match would mint
        // a bogus COINPay obligation, and its 4-case role detection (which reads GET_TICK)
        // disagrees with coinpay.js / coinpay_expire.js's 2-case detection (which reads only a
        // single GIVE_TICK) - releasing the WRONG order's escrowed token on fulfill/expire
        // (a net-zero +credit / -phantom-escrow mint out of the global escrow pool, same class
        // as OM-1 / the COINPAY_EXPIRE_TOKEN_AMOUNT bug, invisible to the supply sanity check).
        // After activation order_match.js skips a native match whose legs are not an exact
        // null-to-null / token mirror (so a legitimate native match has exactly one coin-giving
        // side), and coinpay.js / coinpay_expire.js key the seller/coin split on which side
        // actually GIVES native coin (checking BOTH orders) and refuse to settle an ambiguous
        // shape. On the only reachable well-formed shapes (exactly one GIVE_TICK null) the new
        // and legacy detections agree byte-for-byte, so this only removes the mis-paired path.
        // Gated because it CHANGES which matches settle (a consensus-visible ledger movement
        // hashed into balances_root + ledger_hash): an ungated flip forks a heterogeneous fleet
        // and diverges a from-genesis replay. Keyed on block_TIME like the sibling native-coin
        // gates (BTC/LTC/DOGE heights diverge; one timestamp names the cutover across all three).
        // Same coordinated contract-era flag-day (2026-08-07 00:00:00 UTC); testnet/regtest
        // activate at genesis (all zeros) so the correct routing holds from block 0 there and in
        // the unit/e2e suites.
        this.addChange('COINPAY_NATIVE_RECIPROCITY', '0.2.0',1786060800,0,0,0,0,0);

        // UNSTAKE cooldown-completion action attribution. When a capability/contract
        // UNSTAKE cooldown elapses, processCooldownCompletions credits the returned
        // tokens back to the source. Before this activation the credit reused the
        // UNSTAKE's OWN action_index (whose block_index is the earlier UNSTAKE block),
        // so the block-hash query buckets the credit into the UNSTAKE's origin block,
        // whose ledger_hash was committed BEFORE the credit existed, while a
        // recompute-from-final-state (a snapshot-bootstrapped xchain-sync replica, an
        // SPV verifier) buckets it there too and diverges from the committed hash. The
        // balances_root already attributes the effect to the cooldown block, so the
        // ledger_hash was the sole mis-attributed commitment. After activation the
        // return credit is attributed to a fresh synthetic UNSTAKE (format 2) action
        // minted at the cooldown-expiry block, so it hashes into the block where the
        // effect is applied and the ledger_hash chain agrees with balances_root and
        // with any recompute. Consensus-breaking (changes actions_hash + ledger_hash
        // for cooldown-completion blocks), so it is gated on the same coordinated
        // flag-day as the other contract-era consensus fixes (2026-08-07 00:00:00 UTC,
        // CONFIRMED 2026-07-07, aligned with the fleet upgrade; a wrong value forks).
        // testnet/regtest activate at genesis (all zeros); the e2e/regtest stack must
        // be rebuilt fresh so no pre-activation cooldown-completion blocks remain.
        this.addChange('UNSTAKE_COOLDOWN_COMPLETION_ACTION', '0.2.0',1786060800,0,0,0,0,0);

        // FIX_OUTPUT_FANOUT: collapse the reader-side per-output fan-out for data-bearing,
        // non-COINPAY transactions. getDecoderBlockData (db.js) LEFT JOINs transaction_outputs
        // and emits ONE row per stored native-coin output, each carrying the same tx `data`;
        // the block loop runs processTransaction once per row and createActionIndex dedupes on
        // a per-row tx_vout, so a data-bearing action (e.g. SEND) whose transaction ALSO pays a
        // dispenser and/or a native fee-destination output executes once PER output row -
        // duplicate credits/debits for a single on-chain transaction. Per-output processing is
        // only intended for COINPAY payment settlement and empty-data DISPENSE triggers. At/after
        // this flag-day, output_fanout.collapseOutputFanout keeps exactly one row (the lowest
        // vout, deterministic across nodes) for every other transaction; COINPAY and empty-data
        // rows keep their fan-out. BELOW the flag-day the historical per-row behaviour is
        // preserved, except that such a multi-row data-bearing transaction is a consensus-critical
        // fault that aborts the block (visible halt via the watchdog/rollback path) rather than
        // silently double-executing. Consensus-visible (changes actions_hash + ledger_hash for any
        // affected block), so gated on the same coordinated contract-era flag-day as the other
        // 2026-08-07 00:00:00 UTC fixes (a wrong value forks); keyed on block TIME because the
        // affected native-coin payment/dispenser flows settle on BTC, LTC and DOGE whose heights
        // diverge, so no single height names one cutover. testnet/regtest activate at genesis
        // (all zeros) so the collapse is in force from block 0 there and in the unit/e2e suites.
        this.addChange('FIX_OUTPUT_FANOUT', '0.2.0',1786060800,0,0,0,0,0);

        // Staking-family stress-sweep fixes (2026-07-09). All three are consensus-visible
        // validity/derivation changes, gated on the same coordinated contract-era flag-day
        // as the other 2026-08-07 fixes (a wrong value forks); testnet/regtest at genesis.

        // DEL-1: DELEGATE v2 delegation-revoke previously INSERTed a fresh status=valid,
        // activation_block=0 delegations row (createRevokeDelegation -> createDelegation) in
        // addition to deactivating the parent, so a repeat revoke before maturity EXTENDED the
        // revoked key's signer lifetime and the stray rows corrupt historical as-of effective-set
        // reads. At/after this flag-day the revoke mirrors the v3 path: NO insert, deactivate the
        // parent only. Changes the delegations table that feeds _stakeWeightsSql/stakes_root, so
        // it is a hashed-derivation change (flag-day, not a query tweak).
        this.addChange('DELEGATE_REVOKE_NO_REINSERT', '0.2.0',1786060800,0,0,0,0,0);

        // STAKE-1: the contract-targeted TARGET_CONTRACT_INDEX was validated with /^[0-9]+$/, which
        // accepts non-canonical leading-zero forms ('007'). Benign at runtime (Number-coerced
        // consistently, no fund-stranding, unlike the DEPOSIT custody-address bug), but it is a
        // non-canonical validity surface inconsistent with deposit/withdraw's /^[1-9]\d*$/. At/after
        // this flag-day STAKE v3 / UNSTAKE v1 / DELEGATE v1,v3 reject leading zeros. UNLIKE the
        // deposit/withdraw tightening (ungated - a leading-zero deposit was ALREADY a stranded-funds
        // bug, so rejecting forked nothing valid), a leading-zero contract stake currently produces a
        // VALID, correct row, so tightening it is a live validity change and MUST be gated.
        // EXEC-1 joins the same flag-day: EXECUTE's CONTRACT_ACTION_INDEX was also
        // /^\d+$/, and there a leading-zero index is NOT benign - the VM hashes Number(index)
        // into the attestation request_id preimage while the host re-hashes the raw EMITTER
        // string, so '007' makes the two disagree and the host rejects an ATTEST the VM
        // accepted. Same gate because it is the same validity change (an index form that is
        // valid today stops being valid), and it also rejects indexes past the safe-integer
        // range, whose Number() rounding is the same divergence class.
        this.addChange('CONTRACT_INDEX_CANONICAL', '0.2.0',1786060800,0,0,0,0,0);

        // DEL-2 (#4366): a DELEGATE v1 signing-key rotation wrote contract_delegations but NEVER
        // reached contract_stakes, so the rotated key owned nothing the protocol actually reads.
        // All three contract-stake lookup surfaces key on contract_stakes.signing_pubkey_id:
        // getContractStakeDataForVM (the getStake/getStakers/getTotalStaked snapshot a contract
        // observes), getActiveContractStakeByPubkey (the UNSTAKE refund aggregate) and
        // slashContractStake (the SLASH deduction). The rotated key therefore never appeared in
        // getStakers, could not UNSTAKE, and a SLASH against it deducted nothing while the
        // contract still recorded the punishment - the incoherence the build-a-stakeable-contract
        // guide promises does not exist.
        //
        // At/after this flag-day the rotation is MATERIALIZED onto contract_stakes: the end-of-
        // activation-delay sweep (utility.processContractDelegationMaterializations ->
        // db.materializeContractDelegations) rewrites signing_pubkey_id on the delegating source's
        // active (target, tick) stake rows and journals each rewrite in
        // contract_delegation_rotations so a reorg restores the previous key verbatim. The three
        // lookup surfaces then agree by construction, with no per-surface remap: remapping only
        // the READ (the finding's proposal A) would make a contract emit SLASH against a key the
        // ledger cannot debit, which is worse than the coherent gap it replaces.
        //
        // Gated because it changes what EXECUTE observes through getStake/getStakers/
        // getTotalStaked, so historical blocks must replay byte-identically. Minted at its own
        // future instant rather than reusing the contract-era anchor: that anchor is already in
        // the past, and a retroactive boundary would make a from-genesis replay hand contracts a
        // DIFFERENT staker set than the live fleet observed. The value lives here and is
        // rendered into the docs by xchain-documentation/bin/generate-flag-days.js; every
        // indexer and sync process must be deployed before mainnet crosses it.
        // testnet/regtest are live from genesis, exactly like the sibling contract-era gates.
        this.addChange('CONTRACT_DELEGATION_MATERIALIZE', '0.2.0',1789430400,0,0,0,0,0);

        // SLASH-1: slashCapabilityStake Pass 1 filtered `activation_block <= block`, so a
        // pending-activation capability top-up (debited at STAKE time) escaped the equivocation bond
        // burn and could later be UNSTAKEd/refunded (the sibling slashContractStake has no such
        // filter). At/after this flag-day the whole locked bond burns, activated or not. Gated on the
        // BTC-anchored EQUIV activation HEIGHT (equivocation_header.js EQUIV_HEADER_ACTIVATION.mainnet
        // = 961000), NOT the 2026-08-07 timestamp: real slashing is inert below the EQUIV flag-day,
        // and 961000 (~2026-08-04) precedes 2026-08-07, so a timestamp gate would leave a window where
        // slashing ran with the old (incomplete) burn. Height-gated so the fix goes live exactly when
        // slashing does. slashCapabilityStake is indexer-only (the follower mirrors the zeroed rows),
        // so this is not a byte-locked twin.
        this.addChange('SLASH_BURNS_PENDING_STAKE', '0.2.0',0,0,0,961000,0,0);

        // SLASH-2: an XORACLE equivocation proof must agree on the ORACLE ROUND
        // carried in the signed JSON, not just on the BTC height in the EQUIV key. Oracle
        // rounds advance on wall-clock while the captured BTC tip can stand still, so an
        // honest validator signing rounds N and N+1 at one tip produced two messages sharing
        // the header prefix `EQUIV|XORACLE|<height>|0||` with different content, which
        // slash.js read as equivocation and burned its ENTIRE bond (permanent, fleet-wide
        // disqualification). Same gate as SLASH-1 and for the same reason: real slashing is
        // inert below the BTC-anchored EQUIV activation HEIGHT (equivocation_header.js
        // EQUIV_HEADER_ACTIVATION.mainnet = 961000), so a height gate lands the fix exactly
        // where the rule it narrows can first fire. Gated rather than unconditional because
        // this REJECTS proofs a pre-fix node accepts, and a half-upgraded fleet disagreeing
        // on a SLASH's validity is a ledger fork.
        this.addChange('SLASH_ORACLE_ROUND_DISCRIMINATED', '0.2.0',0,0,0,961000,0,0);

        // H-3: deterministic price_snapshots selection for native-coin fee
        // validation on NON-reference chains. Price rounds are anchored to BTC
        // heights, so getLatestPrice's `reference_block <= blockIndex` gate is
        // vacuously true against LTC/DOGE heights (numerically far above any BTC
        // anchor): the query returned whatever globally-latest round the local
        // mirror held, so mirror lag forked the fleet AND a from-genesis replay
        // read today's newest round instead of the round used live. At/after
        // this flag-day, non-BTC chains select by the round's consensus
        // timestamp instead (`block_timestamp <= block time`, the same pair of
        // quantities the staleness guard already compares). Keyed on block TIME (not
        // height) for the same reason as DEPLOY_BASE64_CODE: no single height
        // names one cutover across chains. Evaluation happens in exactly one place,
        // utility.getFeeOraclePrices via isNativeFeePriceTimeGateActive() above;
        // registered here so the flag-day inventory carries it. The block loop's
        // time-keyed price barrier is NOT a consumer of this flag: it is unconditional
        // on every chain (XChainIndexer.js:877-888), and re-conditioning it on this
        // flag-day would re-open the LTC/DOGE FIAT-dispense divergence window.
        this.addChange('NATIVE_FEE_PRICE_TIME_GATE', '0.2.0', NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME,0,0,0,0,0);

        // DEPLOY_INIT_STRICT (F-14 follow-on): a contract that exports `initialize`
        // (a constructor) deployed with NO CONSTRUCTOR_PARAMS today runs no
        // constructor yet still commits 'valid' - it silently deploys uninitialized.
        // At/after this flag-day the DEPLOY of a constructor-declaring contract with
        // no CONSTRUCTOR_PARAMS field is REJECTED, and the constructor trigger moves
        // from truthy to field-present so an explicit empty CONSTRUCTOR_PARAMS runs a
        // zero-arg initialize (deploy.js). Below the flag-day: byte-identical to today
        // (truthy trigger, no reject), so a from-genesis replay reproduces the historic
        // accept-below/reject-above verdict. Keyed on block TIME with the 2026-08-07
        // contract-era cohort (CONTROLLER_GUARD / VM_BANNED_ASYNC); testnet/regtest
        // genesis-on. Indexer-only verdict (uses the VM readManifest `hasInitialize`
        // flag), so not a byte-locked twin; the VM readManifest change ships alongside.
        this.addChange('DEPLOY_INIT_STRICT', '0.2.0',1786060800,0,0,0,0,0);

        // BATCH sub-action normalization: the top-level dispatcher
        // (actions.js) rewrites ACTION aliases (TRANSFER->SEND, ADDR->ADDRESS,
        // DROP->AIRDROP, CAST->BROADCAST, MSG->MESSAGE) and injects the implied
        // legacy VERSION 0 for BTNS-style ISSUE/MINT/SEND params, but batch.js
        // historically did neither for its sub-actions: an aliased sub-action
        // name fails the activation lookup (whole BATCH -> 'invalid: ACTION
        // (unknown)') and a legacy-format sub-action parses its TICK as the
        // FORMAT version. At/after this flag-day BATCH sub-actions are
        // normalized exactly like top-level actions (alias rewrite in the
        // limit/validity scans, the sibling pre-parse and the dispatch loop;
        // VERSION-0 injection before FORMAT derivation and handler dispatch).
        // Below it: byte-identical to today, so a from-genesis replay
        // reproduces every historic reject/misparse verdict (a previously-
        // invalid BATCH becoming valid changes actions/ledger state hashed
        // into the checkpoint preimage; an ungated flip forks a skewed fleet
        // on the first aliased or legacy-format sub-action). Keyed on block
        // TIME with the ratified 2026-08-07 contract-era cohort;
        // testnet/regtest activate at genesis (all zeros).
        this.addChange('BATCH_SUBACTION_NORMALIZATION', '0.2.0',1786060800,0,0,0,0,0);

        // BATCH issuance limits v2. One entry gating the whole rework so a fleet can never
        // run half of it:
        //   - the per-action ISSUE limit stops counting DOTTED (child) ticks, so one BATCH
        //     may register a parent and any number of its children. A caret TICK ('^<id>')
        //     is NEVER exempt: its dot is an id/precision separator, not a namespace one.
        //   - a global 250-command cap per BATCH, checked FIRST so it bounds the scan loops
        //     the exemption runs inside and so its error wins over the per-action limit for
        //     a batch that breaks both. Without it the envelope lane admits ~35,000
        //     sub-commands, each buying its own ACTION_INDEX, mappings and invalid row.
        //   - fee and settlement value accounted CUMULATIVELY across the batch. TX_OUTPUTS
        //     is transaction-level state the batch loop preserves, and every per-command
        //     check read it untouched, so N fee-bearing sub-commands were satisfied by ONE
        //     command's worth of native fee (and N COINPAYs settled from one payment).
        //   - an ISSUE whose TICK is a caret form containing '.' is rejected rather than
        //     landing a valid issuance under a NULL ticker id, and an invalid ISSUE no
        //     longer interns its name into index_tickers for free.
        //
        // Gated because all four move consensus verdicts: a batch that was invalid becomes
        // valid (the exemption) and batches that were valid become invalid (the cap, the fee
        // ledger), and both directions change the actions/ledger state hashed into the
        // checkpoint preimage. Keyed on block TIME like the sibling BATCH gates: BATCH runs
        // on BTC, LTC and DOGE, whose heights diverge by millions of blocks, so no single
        // height names one cutover across all three but a single timestamp does.
        //
        // This entry MUST activate at or after BATCH_SUBACTION_NORMALIZATION above:
        // classification reads the TICK out of NORMALIZED sub-command params, and below the
        // normalization flag a legacy-format sub-action's params are not yet shifted, so
        // params[1] is not the TICK. Nothing in isEnabled() enforces the ordering, so
        // test/unit/batchIssuanceLimitsGate.test.js asserts it per network.
        //
        // MAINNET IS ARMED at 2026-08-16T00:00:00Z (see BATCH_ISSUANCE_LIMITS_MAINNET_TIME
        // above for the instant and the deploy dependency it carries);
        // testnet/regtest activate at genesis (all zeros).
        this.addChange('BATCH_ISSUANCE_LIMITS', '0.2.0',BATCH_ISSUANCE_LIMITS_MAINNET_TIME,0,0,0,0,0);

        // Weighted per-BATCH cost budget (BATCH_COST_WEIGHTING). Replaces the flat
        // 250-command cap registered immediately above with a budget over per-action
        // COST WEIGHTS, so the rule bounds worst-case indexer work directly instead of
        // by proxy. Budget 250, default weight 1: a batch with no VM and no fan-out
        // sub-command is decided exactly as it is today.
        //
        // MAINNET IS UNARMED (see BATCH_COST_WEIGHTING_MAINNET_TIME above for the
        // sentinel and for why this is a second flag day rather than a widening of the
        // entry above); testnet/regtest activate at genesis (all zeros), so drills and
        // suites run the post-flag-day rules.
        this.addChange('BATCH_COST_WEIGHTING', '0.2.0',BATCH_COST_WEIGHTING_MAINNET_TIME,0,0,0,0,0);

        // Per-TRANSACTION top-level issuance budget that VM emissions draw from too
        // (EMISSION_ISSUANCE_LIMITS). One transaction may register ONE top-level
        // (undotted) tick, counting wire sub-commands and VM-emitted ISSUEs alike; dotted
        // child ticks are exempt exactly as the BATCH classifier exempts them, and a caret
        // TICK is never exempt. The wire path is already capped at one per BATCH by
        // actionLimits['ISSUE'], so this entry moves no wire verdict: it closes the emission
        // path, which routes past that scan and is fee-exempt under
        // ISSUANCE_FEE_EMISSION_EXEMPT.
        //
        // MAINNET IS UNARMED (see EMISSION_ISSUANCE_LIMITS_MAINNET_TIME above for the
        // sentinel and for why this is its own flag day rather than a widening of
        // BATCH_ISSUANCE_LIMITS, which is already armed); testnet/regtest activate at
        // genesis (all zeros), so drills and suites run the post-flag-day rules.
        this.addChange('EMISSION_ISSUANCE_LIMITS', '0.2.0',EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,0,0,0,0,0);

        // Numeric legacy-fee db_hits accumulation. The legacy
        // (non-UNIFIED_FEES) transaction-fee model in dividend.js / callback.js / sweep.js
        // accumulates a db_hits count and prices it via getTransactionFee. The original
        // accumulators used `db_hits += this.util.bcmul(count, N, 0)`; bcmul returns a
        // mathjs BigNumber whose valueOf() is a string, so the `+=` STRING-CONCATENATED the
        // running integer instead of adding it (e.g. 4 + bcmul(2,3,0) -> 4 + "6" -> "46",
        // and even a zero-escrow SWEEP concatenated "0" -> "10" -> "100"), inflating the
        // priced fee by orders of magnitude (getTransactionFee("100") = 0.001 vs the correct
        // 0.00001). Below this activation the code reproduces that string concatenation
        // byte-for-byte, so a from-genesis replay and a heterogeneous fleet commit the
        // IDENTICAL (inflated) fee that live pre-activation nodes committed. At/above it the
        // count accumulates numerically and getTransactionFee prices the true db_hits.
        // Gated as its own consensus rule because the fix CHANGES a consensus-visible ledger
        // amount (fees.AMOUNT / the fee DEBIT, hashed into balances_root + ledger_hash): an
        // ungated flip (the earlier un-gated numeric fix) forks a skewed fleet on the first
        // fee-bearing DIVIDEND-legacy/CALLBACK/SWEEP and diverges a from-genesis replay from
        // the committed ledger. Keyed on block_TIME (not block_index), mirroring the other
        // multi-chain gates: these actions run on BTC, LTC and DOGE whose heights diverge by
        // millions of blocks, so no single shared block height names one cutover across all
        // three chains, but a single timestamp does. The mainnet timestamp joins the
        // ratified coordinated contract-era anchor 1786060800 (2026-08-07 00:00:00 UTC);
        // testnet/regtest activate at genesis (all zeros) so the numeric model holds from
        // block 0 there and in the unit/e2e suites (the regtest stack is rebuilt fresh, so
        // no pre-activation fee-bearing blocks remain to replay).
        this.addChange('LEGACY_FEE_NUMERIC_DBHITS', '0.2.0',1786060800,0,0,0,0,0);

        // Partial claim + partial unstake. UNSTAKE v0/v1 and COLLECT v0 gain a
        // trailing OPTIONAL AMOUNT field (no new action versions):
        //   UNSTAKE v0: VERSION|SIGNING_PUBKEY[|AMOUNT]
        //   UNSTAKE v1: VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK[|AMOUNT]
        //   COLLECT v0: VERSION[|AMOUNT]
        // AMOUNT absent = the historical full sweep, byte-identical, so every action
        // already on-chain decodes and applies unchanged. AMOUNT present at/after this
        // flag-day = partial: UNSTAKE moves only that much into cooldown and the residual
        // stays staked (a synthetic re-stake row keyed by the UNSTAKE's own action_index,
        // activating exactly when the swept rows deactivate, so stake weight is continuous
        // with no double-count window); COLLECT claims only that much and the remainder
        // stays pending. An AMOUNT equal to the full balance is treated exactly as absent
        // (identical resulting state). Over-ask and malformed amounts REJECT (operator
        // decision 2026-07-23; matches house validator strictness, never clamps). BELOW
        // the flag-day a present AMOUNT is IGNORED (full sweep): every legacy layer
        // (decoder pass-through, actions.js blind split, the handlers' positional reads)
        // already drops extra trailing fields, so ignoring is the only pre-activation rule
        // an un-upgraded indexer can agree with; rejecting early would itself fork the
        // fleet on the first early-broadcast partial. Gated because honoring the field
        // changes consensus-visible state (unstakes/stakes/reward_claims rows, balances,
        // stake weights, all hashed): an ungated flip forks a heterogeneous fleet on the
        // first partial action. Keyed on block_TIME for the reasons stated at
        // DEPLOY_BASE64_CODE above. The mainnet timestamp joins the ratified coordinated
        // contract-era anchor 1786060800 (2026-08-07 00:00:00 UTC); a divergent value is a
        // fork. testnet/regtest activate at genesis (no partial-era history to preserve;
        // the e2e/regtest stack exercises partials from block 0).
        this.addChange('PARTIAL_UNSTAKE_COLLECT', '0.2.0',1786060800,0,0,0,0,0);

        // Retirement of XCALL result rows the source chain can never deliver.
        // A mirrored, finalized result row that matches no local XCALL v0 request (or
        // whose request routes to a different target chain, or whose signatures do not
        // meet the cross_chain quorum) is rejected by processResult on every block and
        // pruned by nothing, because pruning is keyed on a recorded callback and those
        // paths record none. The delivery pass is capped at XCALL_MAX_CALLS_PER_BLOCK,
        // so as few as 25 such rows at a low snapshot_block occupy the whole per-block
        // slice permanently and starve every real result behind them (measured on a
        // drill venue: 229 rows, head slice 25/25 unmatched, re-fetched every
        // block forever). At/above this activation such a row is retired once it can no
        // longer become deliverable: past the request's deadline_block where a request
        // exists, or XCALL_RESULT_ORPHAN_GRACE_SECONDS of block time past the row's
        // quorum-signed effective_time where none does. Retirement records a
        // 'skipped:<reason>' cross_chain_call_callbacks row against a freshly minted
        // action_index, exactly like the existing already-terminal skip branch.
        //
        // Gated because retirement is CONSENSUS-VISIBLE in two ways: it mints an actions
        // row (hashed), and freeing a capped delivery slot moves which block a real
        // result's callback EXECUTE lands in (contract hash, action indices). An ungated
        // flip would fork a heterogeneous fleet on the first orphaned result row. Keyed
        // on block_TIME for the reasons stated at DEPLOY_BASE64_CODE above. The mainnet
        // timestamp joins the ratified coordinated contract-era anchor 1786060800
        // (2026-08-07 00:00:00 UTC); testnet/regtest activate at genesis (no
        // orphaned-result history worth preserving there, and the drill venue needs the
        // rule from block 0).
        this.addChange('XCALL_RESULT_ORPHAN_RETIREMENT', '0.2.0',1786060800,0,0,0,0,0);

        // MAX_SUPPLY=0 is the UNCAPPED sentinel, so the supply ceiling is not
        // applied at all on a token that declares no cap. MAX_SUPPLY is stored as 0 when
        // the ISSUE omits it (createToken / db.js) and the protocol documents such a token
        // as unlimited, but mint.js applied `SUPPLY + AMOUNT > MAX_SUPPLY` with no
        // bcgt(MAX_SUPPLY,0) pre-condition, unlike all four sibling optional-cap checks in
        // the same function (MAX_MINT, MINT_ADDRESS_MAX, MINT_START_BLOCK,
        // MINT_STOP_BLOCK). Against a stored 0 that comparison is true for EVERY positive
        // AMOUNT, so every mint on an uncapped token was rejected and the token was
        // permanently unmintable. The same missing exemption sits on three ISSUE
        // cross-checks that compare another field against MAX_SUPPLY (MINT_SUPPLY single-
        // shot, MINT_SUPPLY cumulative, MINT_ADDRESS_MAX), which reject an uncapped token's
        // own genesis parameters for exceeding a cap that does not exist. At/above this
        // activation all four sites skip the comparison when no positive cap is declared.
        //
        // LOCK_MAX_SUPPLY is deliberately untouched: locking an uncapped token is still
        // refused by the unchanged 'invalid: LOCK_MAX_SUPPLY (no max supply)' guard, since
        // there is no cap to freeze.
        //
        // Gated as its own consensus rule because the change is a validity LOOSENING: a
        // MINT (or ISSUE) that every legacy node rejects becomes valid on an upgraded node,
        // so an ungated flip forks a heterogeneous fleet on the first mint of an uncapped
        // token and breaks from-genesis replay byte-identity. Keyed on block_TIME for the
        // reasons stated at DEPLOY_BASE64_CODE above.
        //
        // MAINNET IS UNARMED (see UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME above): the
        // operator's 2026-08-11 ruling settled the product direction, not the flag day.
        // testnet/regtest activate at genesis (all zeros) so the exemption is in force from
        // block 0 there and in the unit/e2e suites.
        this.addChange('UNCAPPED_MAX_SUPPLY_ZERO', '0.2.0',UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME,0,0,0,0,0);

        // Per-block cap on the CROSS_SETTLE pass
        // (CROSS_SETTLE_MAX_PER_BLOCK in protocol/constants.js). With the
        // gate ON, processCrossChainSettlements settles at most the cap of finalized,
        // effective, unsettled matches per block and carries the remainder forward in
        // (snapshot_block, match_id) order; with it OFF the pass drains the whole
        // backlog in one block transaction, which is the legacy behavior.
        //
        // Gated because the cap is CONSENSUS-VISIBLE: deferring a settlement moves the
        // block it lands in, and with it the actions rows, the contract hash and the
        // checkpoint preimage. CROSS_CHAIN_DEX is genesis-active on every network
        // (all-zero thresholds below) and the fresh-genesis restart of 816d1e1 covered
        // the three TESTNET chains only, so mainnet carries settled history that an
        // ungated cap would reinterpret on any from-genesis replay. The sibling
        // ATTEST_MAX_EXPIRIES_PER_BLOCK could ship ungated only because the pre-launch
        // fleet-wide replay recomputed the history it reinterpreted; this cap has no
        // such vehicle. Operator ruling of 2026-08-11, option (b).
        //
        // Keyed on block_TIME like the other multi-chain gates: CROSS_SETTLE runs on
        // BTC, LTC and DOGE, whose heights diverge by millions of blocks, so no single
        // height names one cutover across all three but a single timestamp does.
        //
        // MAINNET IS UNARMED (see CROSS_SETTLE_CAP_MAINNET_TIME above): the ruling
        // settled the ROUTE, not the flag day, and the anchor is still the operator's
        // to ratify. testnet/regtest activate at genesis (all zeros) so the cap is in
        // force from block 0 there and in the unit/e2e suites.
        this.addChange('CROSS_SETTLE_PER_BLOCK_CAP', '0.2.0',CROSS_SETTLE_CAP_MAINNET_TIME,0,0,0,0,0);

        // Per-subcommand root discriminator for the ATTEST request_id / XCALL call_id
        // preimages.
        //
        // Those preimages carry a per-root discriminator whose value is the root action's
        // on-chain output index TX_VOUT, which was assumed unique per root within a
        // transaction. A BATCH breaks the assumption: actions.js assigns TX_VOUT once per
        // TRANSACTION and every subcommand of the batch is its own root action under it,
        // each seeding call-path ''. Two EXECUTE subcommands against the SAME contract in
        // one BATCH therefore derived the IDENTICAL request_id for their first attestation,
        // and db.createAttestationRequest dropped the second (warn-and-return on the prior
        // row), leaving the second execution bound to the first request's provider,
        // payload and callback while its value stayed escrowed against no row of its own.
        //
        // With the gate ON, a root action that is a BATCH subcommand carries the composite
        // discriminator "<TX_VOUT>.<subcommand position>" instead of the bare TX_VOUT (see
        // src/batch_root_discriminator.js). Nothing else about the preimages changes: a
        // non-BATCH root keeps the bare TX_VOUT, so every id derived outside a BATCH is
        // byte-identical across the flag day and no pending request's id moves.
        //
        // Gated because the request_id is a CONSENSUS preimage: it is what the handler
        // re-derives to accept an ATTEST v0, what validators sign over, and what the
        // callback resolves against. Mainnet carries live history, so a from-genesis
        // replay must reproduce the historical (colliding) id below the flag day.
        //
        // Keyed on block_TIME like the sibling contract-era gates: EXECUTE runs on BTC,
        // LTC and DOGE, whose heights diverge by millions of blocks, so no single height
        // names one cutover across all three but a single timestamp does.
        //
        // MAINNET IS UNARMED (see BATCH_ROOT_SUB_INDEX_MAINNET_TIME above): the operator
        // ruled the REMEDY on 2026-08-11 and naming the activation instant is a separate
        // act that has not happened yet. testnet/regtest activate at genesis (all zeros),
        // so the discriminator is in force from block 0 there and in the unit/e2e suites.
        this.addChange('BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR', '0.2.0',BATCH_ROOT_SUB_INDEX_MAINNET_TIME,0,0,0,0,0);

        // ISSUE mint-window re-parameterization fix. Below this activation the
        // MINT_START_BLOCK / MINT_STOP_BLOCK recency checks in actions/issue.js run
        // against the MERGED action data, which the populate-empty-params step has
        // already filled with the existing token record's values, so a
        // re-parameterizing ISSUE that leaves the mint window untouched inherits the
        // stored MINT_START_BLOCK and is rejected the moment the window has opened
        // (the inherited value is by then in the past). At/above it the recency
        // checks apply only to a value the ISSUE explicitly carries on the wire (the
        // pre-merge snapshot), mirroring how the CALLBACK edit checks already detect
        // explicit fields; an explicitly restated past value is still rejected, so
        // the checks' anti-backdating purpose is untouched, and the
        // stop-before-start cross-check still runs on the merged (effective) window.
        //
        // Gated as its own consensus rule because the fix is a validity LOOSENING:
        // an ISSUE that historical processing rejected ('MINT_START_BLOCK <
        // BLOCK_INDEX' via inheritance) becomes valid, so an ungated flip forks a
        // heterogeneous fleet on the first such re-issue and breaks from-genesis
        // replay byte-identity. Keyed on block_TIME like the sibling multi-chain
        // gates: ISSUE runs on BTC, LTC and DOGE, whose heights diverge by millions
        // of blocks, so no single height names one cutover across all three but a
        // single timestamp does.
        //
        // MAINNET IS UNARMED and TESTNET IS ARMED at 2026-08-24T00:00:00Z - the
        // first nonzero testnet threshold in this registry; the constants above
        // (ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME / _TESTNET_TIME) carry the
        // reasoning, including why testnet cannot be genesis-active here. Regtest
        // activates at genesis (0) so the unit/e2e suites exercise the corrected
        // rule from block 0.
        this.addChange('ISSUE_INHERITED_MINT_WINDOW', '0.2.0',ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME,ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME,0,0,0,0);

        // NOTE: STAKE_WEIGHTED_QUORUM (WI-1) is deliberately NOT registered here.
        // Standard activations gate on the LOCAL processing block via isEnabled();
        // stake-weighted quorum must gate on the BTC-anchored `snapshot_block`
        // carried by each settlement (so BTC/LTC/DOGE + the hub flip on the same
        // anchor). Registering it would invite a wrong isEnabled(localBlock) call.
        // The gate + predicate live in src/stake_weighted_quorum.js
        // (isStakeWeightedQuorumActive / meetsStakeThreshold). Canonical activation
        // height: xchain-documentation/protocol/constants.js.
    }

    // Add protocol changes to protocol changes data object
    // @param {name}          string  Unique name for protocol change
    // @param {version}       string  Semantic version (XX.XX.XX)
    // @param {mainnet_time}  integer Mainnet activation block_time
    // @param {testnet_time}  integer Testnet activation block_time
    // @param {regtest_time}  integer Regtest activation block_time
    // @param {mainnet_block} integer Mainnet activation block_index
    // @param {testnet_block} integer Testnet activation block_index
    // @param {regtest_block} integer Regtest activation block_index
    addChange(name, version, mainnet_time, testnet_time, regtest_time, mainnet_block, testnet_block, regtest_block){
        let error = false;
        if(typeof name != 'string')
            error = 'protocol change name must be string!';
        if(!error && this.changes[name])
            error = 'protocol change name must be unique!';
        if(!error && typeof version != 'string')
            error = 'protocol change version must be string!';
        if(!error && version.split('.').length != 3)
            error = 'protocol change version must be in semantic version format (XX.XX.XX)!';
        if(!error && arguments[2] && typeof arguments[2] != 'number')
            error = 'protocol change mainnet_time must be integer!';
        if(!error && arguments[3] && typeof arguments[3] != 'number')
            error = 'protocol change testnet_time must be integer!';
        if(!error && arguments[4] && typeof arguments[4] != 'number')
            error = 'protocol change regtest_time must be integer!';
        if(!error && arguments[5] && typeof arguments[5] != 'number')
            error = 'protocol change mainnet_block must be integer!';
        if(!error && arguments[6] && typeof arguments[6] != 'number')
            error = 'protocol change testnet_block must be integer!';
        if(!error && arguments[7] && typeof arguments[7] != 'number')
            error = 'protocol change regtest_block must be integer!';
        if(error){
            this.util.throwError(error);
        } else {
            // Parse the protocol change into this.changes
            var change = {};
            let semantic_version    = version.split('.');
            change.version_major    = parseInt(semantic_version[0]);
            change.version_minor    = parseInt(semantic_version[1]);
            change.version_revision = parseInt(semantic_version[2]);
            change.mainnet_time     = parseInt(mainnet_time);
            change.testnet_time     = parseInt(testnet_time);
            change.regtest_time     = parseInt(regtest_time);
            change.mainnet_block    = parseInt(mainnet_block);
            change.testnet_block    = parseInt(testnet_block);
            change.regtest_block    = parseInt(regtest_block);
            this.changes[name] = change;
        }
    }

    // Determine of a protocol change has been defined
    isDefined(name){
        var change = this.changes[name];
        if(change)
            return true;
        return false;
    }

    // Determine if a specific protocol change is enabled based on version, block_time, and block_index
    // @param {name}        string  Unique protocol change name
    // @param {block_index} string  Block index
    async isEnabled(name, block_index){
        let enabled = true;
        try {
            let change  = this.changes[name];
            if(change){
                let current              = {};
                let network              = this.network;
                // Fail CLOSED on an unrecognized network. The mainnet/testnet/regtest branches
                // below have no else, so an unknown network (unset/typo'd INDEXER_NETWORK, or a
                // future network the gate logic doesn't handle) would match none of them, apply
                // NO time/block gate, and leave enabled=true - every flag-day change would read
                // as active from genesis and this node would activate gated consensus rules early
                // and fork the fleet. An un-evaluatable network is not "no gate": treat it like
                // the catch below and propagate, so block processing halts loudly instead of
                // silently diverging. (Boot already rejects an invalid network via
                // coins.getCoinConfig; this is the consensus-path backstop, and it also fails
                // closed rather than open the way the sibling isNativeFeePriceTimeGateActive does.)
                if(network !== 'mainnet' && network !== 'testnet' && network !== 'regtest')
                    throw new Error('ProtocolChanges.isEnabled: unrecognized network "' + network +
                        '" (expected mainnet/testnet/regtest); refusing to evaluate activation to avoid a silent fork');
                let semantic_version     = this.version.split('.');
                current.version_major    = parseInt(semantic_version[0]);
                current.version_minor    = parseInt(semantic_version[1]);
                current.version_revision = parseInt(semantic_version[2]);
                // Verify semantic versioning (compare major, then minor, then revision)
                if(enabled && change.version_major > current.version_major)
                    enabled = false;
                if(enabled && change.version_major == current.version_major && change.version_minor > current.version_minor)
                    enabled = false;
                if(enabled && change.version_major == current.version_major && change.version_minor == current.version_minor && change.version_revision > current.version_revision)
                    enabled = false;
                // Get block information given a block_index
                if(enabled){
                    // Get block time for a given block_index from the decoder database
                    current.block_time  = await this.decoderDb.getBlockTime(block_index);
                    current.block_index = parseInt(block_index);
                    // Verify block_time
                    if(enabled && network=='mainnet' && change.mainnet_time > current.block_time)
                        enabled = false;
                    if(enabled && network=='testnet' && change.testnet_time > current.block_time)
                        enabled = false;
                    if(enabled && network=='regtest' && change.regtest_time > current.block_time)
                        enabled = false;
                    // Verify block_index
                    if(enabled && network=='mainnet' && change.mainnet_block > current.block_index)
                        enabled = false;
                    if(enabled && network=='testnet' && change.testnet_block > current.block_index)
                        enabled = false;
                    if(enabled && network=='regtest' && change.regtest_block > current.block_index)
                        enabled = false;
                }
            } else {
                enabled = false;
            }
        } catch (e){
            // Could-not-evaluate is NOT the same as not-enabled. Swallowing an error here
            // (e.g. a transient decoder-DB fault in getBlockTime) would mark the action as
            // disabled on this node only, invalidating actions that healthy peers process
            // normally and silently forking the ledger. Propagate instead so block
            // processing rolls back and retries the block with correct activation state.
            console.log('protocol error e=',e);
            throw e;
        }
        return enabled;
    }
 
}

module.exports = ProtocolChanges;
// Canonical async-gate flag-day, exported for the cross-repo byte-identity guard in
// test/unit/consensus-params.test.js (must equal xchain-vm ASYNC_SURFACE_GATE_BLOCK_TIME).
module.exports.VM_BANNED_ASYNC_MAINNET_TIME = VM_BANNED_ASYNC_MAINNET_TIME;
// H-3 price-selection flag-day + its shared gate predicate (see registration).
module.exports.NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME = NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;
module.exports.isNativeFeePriceTimeGateActive = isNativeFeePriceTimeGateActive;
// Compiled consensus-version pin and its no-op proof. Exported for the
// boot path (XChainIndexer) and for test/unit/protocol_changes.test.js, which
// pins the constant against package.json so the two cannot drift.
module.exports.CONSENSUS_VERSION = CONSENSUS_VERSION;
module.exports.assertConsensusVersionPin = assertConsensusVersionPin;
// UNARMED mainnet sentinel for UNCAPPED_MAX_SUPPLY_ZERO, exported so the suite can assert
// the gate is still waiting on the operator's flag day rather than armed at a guessed value.
module.exports.UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME = UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME;
// UNARMED mainnet sentinel for the CROSS_SETTLE cap, exported for the same reason: the suite asserts the
// CROSS_SETTLE cap is still waiting on the operator's anchor, never armed at a guess.
module.exports.CROSS_SETTLE_CAP_MAINNET_TIME = CROSS_SETTLE_CAP_MAINNET_TIME;
// UNARMED mainnet sentinel for the per-subcommand root discriminator, exported for the same
// reason: the suite asserts this consensus-preimage change is still waiting on the operator's
// flag day rather than armed at a guessed instant.
module.exports.BATCH_ROOT_SUB_INDEX_MAINNET_TIME = BATCH_ROOT_SUB_INDEX_MAINNET_TIME;
// UNARMED mainnet sentinel + ARMED testnet instant for the ISSUE mint-window
// re-parameterization fix, exported so the suite can assert mainnet is still waiting on
// the operator's flag day and that the testnet arm is the ratified 2026-08-24T00:00:00Z
// instant rather than a retroactive or drifted value.
module.exports.ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME = ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME;
module.exports.ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME = ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME;
// ARMED mainnet instant for the BATCH issuance-limits rework (1786838400, 2026-08-16T00:00Z,
// armed 2026-08-14 pre-launch), exported so the suite can pin the ratified value, assert it
// was never retroactive, that it never precedes BATCH_SUBACTION_NORMALIZATION, and that it
// equals the decoder's BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION (one boundary).
module.exports.BATCH_ISSUANCE_LIMITS_MAINNET_TIME = BATCH_ISSUANCE_LIMITS_MAINNET_TIME;
module.exports.BATCH_COST_WEIGHTING_MAINNET_TIME = BATCH_COST_WEIGHTING_MAINNET_TIME;
module.exports.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME = EMISSION_ISSUANCE_LIMITS_MAINNET_TIME;