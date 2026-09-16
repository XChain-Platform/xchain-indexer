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

// ASSEMBLER. The flag-day constants, the 97 time-table rows and the registry API
// live in the part files under src/protocol_changes/; this file is the one entry
// every reader requires and it puts them together. The class below builds its
// table from the same rows the registry exposes through rows(), so the two
// cannot disagree, and it re-exports every constant under the name it always had.
const {
    UNARMED, UNPINNED, RegistryMissError, createRegistry, applyChanges,
} = require('./protocol_changes/core.js');
const { registerRows } = require('./protocol_changes/shared_rows.js');
// The gate rows, in registration order: the SHARED block parts (twinned into
// hub, sync, explorer and sdk), the indexer-only parts, and the registry's own
// constants. Each part queues its addGate() calls into shared_rows.js as it
// loads; registerRows() below replays them into the registry.
require('./protocol_changes/shared_rows_1.js');
require('./protocol_changes/shared_rows_2.js');
require('./protocol_changes/shared_rows_3.js');
require('./protocol_changes/shared_rows_4.js');
require('./protocol_changes/shared_rows_5.js');
require('./protocol_changes/gates_1.js');
require('./protocol_changes/gates_2.js');
require('./protocol_changes/gates_3.js');
require('./protocol_changes/gates_flag_times.js');
const {
    VM_BANNED_ASYNC_MAINNET_TIME,
    NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME,
    UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME,
    CROSS_SETTLE_CAP_MAINNET_TIME,
    BATCH_ROOT_SUB_INDEX_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME,
    DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME,
    CONTRACT_META_REQUIRED_MAINNET_TIME,
    CONTRACT_META_REQUIRED_TESTNET_TIME,
} = require('./protocol_changes/flag_times.js');
const {
    BATCH_ISSUANCE_LIMITS_MAINNET_TIME,
    BATCH_COST_WEIGHTING_MAINNET_TIME,
    EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME,
    UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME,
} = require('./protocol_changes/flag_times_batch_fees.js');
// The time table, in registration order. A new row goes at the end of the last
// part; a part that would pass 400 lines is closed and the next one started.
const CHANGES_1 = require('./protocol_changes/changes_1.js');
const CHANGES_2 = require('./protocol_changes/changes_2.js');
const CHANGES_3 = require('./protocol_changes/changes_3.js');
const CHANGES_4 = require('./protocol_changes/changes_4.js');
const CHANGE_PARTS = [CHANGES_1, CHANGES_2, CHANGES_3, CHANGES_4];

// The compiled consensus-version pin lives in its own part file (with the
// history of every move it has made) so the registry can register it as a row.
const { CONSENSUS_VERSION } = require('./protocol_changes/consensus_version.js');

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
        // The 97 rows live in src/protocol_changes/changes_*.js; see CHANGE_PARTS.
        applyChanges(this, CHANGE_PARTS);
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

// THE registry (activation-registry spec 6.1), built once per load from the
// gate-row parts and the same time-table parts parseChanges() feeds the class.
// The venue's regtest arming is read here, at load, so a process that reloads
// this entry re-reads its environment and every shim that follows sees it.
const registry = createRegistry();
registerRows(registry, process.env);
applyChanges(registry, CHANGE_PARTS);

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
// the operator's flag day and that the testnet arm is the ratified 1787961600
// (2026-08-29T00:00:00Z) instant rather than a retroactive or drifted value.
module.exports.ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME = ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME;
module.exports.ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME = ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME;
// Genesis-active mainnet arm + UNARMED testnet sentinel for deferred chunked-DEPLOY
// assembly, exported so the suite can assert mainnet is at 0 (no chunked-DEPLOY history on
// any mainnet chain) and that testnet still waits on the shipping release to pin an instant
// above Bitcoin testnet4's recorded out-of-order group at blocks 150679-150681.
module.exports.DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME = DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME;
module.exports.DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME = DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME;
// Genesis-active mainnet arm + UNARMED testnet sentinel for the required contract meta
// export, exported so the suite can assert mainnet is at 0 (no mainnet contracts) and that
// testnet still waits on the shipping release to pin an instant above the 9 recorded TBTC
// contracts, none of which exports a meta-shaped object.
module.exports.CONTRACT_META_REQUIRED_MAINNET_TIME = CONTRACT_META_REQUIRED_MAINNET_TIME;
module.exports.CONTRACT_META_REQUIRED_TESTNET_TIME = CONTRACT_META_REQUIRED_TESTNET_TIME;
// ARMED mainnet instant for the BATCH issuance-limits rework (1786838400, 2026-08-16T00:00Z,
// armed 2026-08-14 pre-launch), exported so the suite can pin the ratified value, assert it
// was never retroactive, that it never precedes BATCH_SUBACTION_NORMALIZATION, and that it
// equals the decoder's BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION (one boundary).
module.exports.BATCH_ISSUANCE_LIMITS_MAINNET_TIME = BATCH_ISSUANCE_LIMITS_MAINNET_TIME;
module.exports.BATCH_COST_WEIGHTING_MAINNET_TIME = BATCH_COST_WEIGHTING_MAINNET_TIME;
module.exports.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME = EMISSION_ISSUANCE_LIMITS_MAINNET_TIME;
// UNARMED mainnet AND testnet sentinels for UNIFIED_FEES_SWEEP_CALLBACK, exported so the
// suite can assert both stay unarmed until an operator arms them, and that neither is ever
// backdated. Testnet carries its own sentinel because testnet is a live public ledger; see
// the constants' comment.
module.exports.UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME = UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME;
module.exports.UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME = UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME;
// The registry API. get() throws RegistryMissError on a miss, never null, and
// returns the frozen row; copy() returns the same row as a fresh mutable deep
// copy, which is what a shim exports when its module owned a mutable table
// before (tests patch those tables to drive a boundary, and a frozen export
// would refuse them). activeAt() is the one generic predicate; rows() is the
// fingerprint's input. `registry`, UNARMED and UNPINNED are deliberately
// NON-ENUMERABLE: the armed-map manifest reads every enumerable non-function
// export of this module as a consensus row, and these are the API, not rows.
module.exports.get = (key) => registry.get(key);
module.exports.copy = (key) => registry.copy(key);
module.exports.activeAt = (key, network, coin, height, time) => registry.activeAt(key, network, coin, height, time);
module.exports.rows = () => registry.rows();
module.exports.RegistryMissError = RegistryMissError;
Object.defineProperty(module.exports, 'registry', { value: registry, enumerable: false });
Object.defineProperty(module.exports, 'UNARMED', { value: UNARMED, enumerable: false });
Object.defineProperty(module.exports, 'UNPINNED', { value: UNPINNED, enumerable: false });
