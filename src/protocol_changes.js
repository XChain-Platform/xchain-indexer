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
const VM_BANNED_ASYNC_MAINNET_TIME = 1798761600;

class ProtocolChanges {

    constructor(indexer){
        this.config    = indexer.config;
        this.util      = indexer.util;
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // XChain Indexer Version and network.
        // Prefer process.env.npm_package_version (set under `npm run …`, and the
        // hook tests inject it to simulate a shipping consensus version), and fall
        // back to package.json when it is absent. A bare `node src/api.js` (Docker
        // entrypoints, one-off debugging) does NOT set the env var, which left
        // this.version undefined and made isEnabled()'s this.version.split('.')
        // throw, rolling back and silently retrying the same block forever; the
        // package.json fallback closes that crash while keeping both production
        // launch paths (npm run / bare node) resolving to the same version.
        this.version = process.env.npm_package_version || require('../package.json').version;
        this.network = process.env.INDEXER_NETWORK;

        this.changes = {};
        this.parseChanges();
    }

    parseChanges(){

        // Define `ACTION` commands and activation time/blocks (ALL UPPER case)
        this.addChange('ADDRESS',    '1.0.0',0,0,0,0,0,0);
        this.addChange('AIRDROP',    '1.0.0',0,0,0,0,0,0);
        this.addChange('BATCH',      '1.0.0',0,0,0,0,0,0);
        // this.addChange('BET',        '1.0.0',0,0,0,0,0,0);
        this.addChange('BROADCAST',  '1.0.0',0,0,0,0,0,0);
        this.addChange('CALLBACK',   '1.0.0',0,0,0,0,0,0);
        this.addChange('DESTROY',    '1.0.0',0,0,0,0,0,0);
        this.addChange('DISPENSER',  '1.0.0',0,0,0,0,0,0);
        this.addChange('DIVIDEND',   '1.0.0',0,0,0,0,0,0);
        this.addChange('DISPENSE',   '1.0.0',0,0,0,0,0,0);
        this.addChange('FILE',       '1.0.0',0,0,0,0,0,0);
        this.addChange('ISSUE',      '1.0.0',0,0,0,0,0,0);
        this.addChange('LINK',       '1.0.0',0,0,0,0,0,0);
        this.addChange('LIST',       '1.0.0',0,0,0,0,0,0);
        this.addChange('MESSAGE',    '1.0.0',0,0,0,0,0,0);
        this.addChange('MINT',       '1.0.0',0,0,0,0,0,0);
        this.addChange('ORDER',      '1.0.0',0,0,0,0,0,0);
        this.addChange('SEND',       '1.0.0',0,0,0,0,0,0);
        this.addChange('SLEEP',      '1.0.0',0,0,0,0,0,0);
        this.addChange('SWAP',       '1.0.0',0,0,0,0,0,0);
        this.addChange('SWEEP',      '1.0.0',0,0,0,0,0,0);
        this.addChange('COINPAY',        '1.0.0',0,0,0,0,0,0);
        this.addChange('COINPAY_EXPIRE', '1.0.0',0,0,0,0,0,0);

        // VM actions (all chains). DEPLOY covers inline (v0/v1), chunked-assemble
        // (v2/v3), and the chunk carrier (v4): all gated under this one entry.
        this.addChange('DEPLOY',             '2.0.0',0,0,0,0,0,0);
        this.addChange('EXECUTE',            '2.0.0',0,0,0,0,0,0);
        this.addChange('DEPOSIT',            '2.0.0',0,0,0,0,0,0);
        this.addChange('WITHDRAW',           '2.0.0',0,0,0,0,0,0);

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
        // The mainnet timestamp below is a PLACEHOLDER coordinated flag-day (2027-01-01
        // 00:00:00 UTC) that MUST be confirmed and aligned with the SDK base64 rollout
        // before any base64 DEPLOY is broadcast to mainnet; a wrong value is a second fork.
        this.addChange('DEPLOY_BASE64_CODE', '2.0.0',1798761600,0,0,0,0,0);

        // Staking actions: capability variants (STAKE v1/v2, UNSTAKE v0, DELEGATE v0/v2, COLLECT) are BTC-only;
        // contract variants (STAKE v3, UNSTAKE v1, DELEGATE v1/v3) work on any chain
        this.addChange('STAKE',              '2.0.0',0,0,0,0,0,0);
        this.addChange('UNSTAKE',            '2.0.0',0,0,0,0,0,0);
        this.addChange('DELEGATE',           '2.0.0',0,0,0,0,0,0);
        this.addChange('COLLECT',            '2.0.0',0,0,0,0,0,0);
        // SLASH: permissionless capability-stake equivocation slashing (WI-2 bump 2). The
        // verifier only ACCEPTS proofs whose two messages carry the EQUIV header, so slashing
        // is naturally inert until the EQUIV flag-day (no coupling with the SLASH protocol gate).
        this.addChange('SLASH',              '2.0.0',0,0,0,0,0,0);

        // PRICE action: validator oracle (v0) and user oracle (v1) pricing
        // Publishable on any chain (DOGE recommended for low fees)
        this.addChange('PRICE',              '2.0.0',0,0,0,0,0,0);

        // External attestation framework: single ATTEST action with v0=request, v1=response, v2=expire
        // (See xchain-documentation/protocol/actions/ATTEST.md)
        this.addChange('ATTEST',             '2.0.0',0,0,0,0,0,0);

        // ANCHOR: DOGE-only on-chain state commitments: v0=checkpoint,
        // v1=checkpoint+match archive, v2=archive continuation
        // (See xchain-documentation/protocol/actions/ANCHOR.md)
        this.addChange('ANCHOR',             '2.0.0',0,0,0,0,0,0);

        // Cross-chain contract calls: XCALL v0=request (VM-emission-only; never
        // decoded from the wire), v2=expire (system-synthesized). The relay rows
        // ride the hub mirror; registered for consistency/documentation.
        // (See xchain-documentation/protocol/actions/XCALL.md)
        this.addChange('XCALL',              '2.0.0',0,0,0,0,0,0);

        // NODEPROOF: full-node possession-proof verdict (v0; validator-broadcast).
        // Records which validators answered the derived possession challenge, so the
        // verified set earns the full-node oracle-round reward tranche. BTC-only.
        // (See xchain-documentation/protocol/actions/NODEPROOF.md)
        this.addChange('NODEPROOF',          '2.0.0',0,0,0,0,0,0);

        // Define protocol changes (ALL LOWER Case)
        // this.addChange('name','1.0.0',0,0,0,0,0,0);
        this.addChange('UNIFIED_FEES',   '2.0.0',0,0,0,0,0,0);
        this.addChange('VM_ACTIONS',     '2.0.0',0,0,0,0,0,0);
        // Cross-chain DEX gate: when enabled, ORDER/SWAP allow GET_COIN != COIN and the
        // xchain-hub federation drives cross-chain matching + mirror-delivered settlement.
        // Genesis-activated (pre-launch).
        this.addChange('CROSS_CHAIN_DEX','2.0.0',0,0,0,0,0,0);
        // Issuance fee activation. Mainnet turns on at the historical block 862633;
        // testnet/regtest charge from block 0 so the fee path is exercisable there.
        // mainnet_block=862633 is a BTC block height used as an 'always-on' activation
        // for LTC and DOGE (both passed this height long ago). This is intentional legacy
        // behaviour. A single cross-chain activation height is chosen from BTC; see
        // xchain-documentation/protocol/CONFIGURATION.md for the rationale.
        this.addChange('ISSUANCE_FEE',   '1.0.0',0,0,0,862633,0,0);
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
        // timestamp is the same PLACEHOLDER coordinated flag-day as the base64
        // rollout (2027-01-01 00:00:00 UTC) and MUST be confirmed/aligned with the
        // other contract-deploy consensus fixes shipping in this window before any
        // affected DEPLOY is broadcast to mainnet; a wrong value is a second fork.
        // testnet/regtest activate at genesis (no pre-exemption history to preserve;
        // the e2e/regtest stack exercises VM emissions from block 0).
        this.addChange('ISSUANCE_FEE_EMISSION_EXEMPT', '2.0.0',1798761600,0,0,0,0,0);

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
        // does. The mainnet timestamp is the same PLACEHOLDER coordinated flag-day
        // as the other contract-deploy consensus fixes in this window (2027-01-01
        // 00:00:00 UTC) and MUST be confirmed/aligned before any balance-reading
        // contract is broadcast to mainnet; a wrong value is a fork. testnet/regtest
        // activate at genesis (no pre-reader history to preserve; the e2e/regtest
        // stack exercises VM balance reads from block 0).
        this.addChange('VM_BALANCE_TOKENINFO', '2.0.0',1798761600,0,0,0,0,0);

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
        // timestamp is the same PLACEHOLDER coordinated flag-day as the other
        // contract-era consensus fixes in this window (2027-01-01 00:00:00 UTC) and MUST
        // be confirmed/aligned with the operator fleet upgrade before any CONTROLLER-bound
        // token is issued on mainnet; a wrong value is a fork. testnet/regtest activate
        // at genesis (no pre-guard history to preserve; the e2e/regtest stack exercises
        // controller guards from block 0).
        this.addChange('CONTROLLER_GUARD', '2.0.0',1798761600,0,0,0,0,0);

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
        // single timestamp does. The mainnet timestamp is the same PLACEHOLDER
        // coordinated flag-day as the other contract-era consensus fixes in this
        // window (2027-01-01 00:00:00 UTC) and MUST be confirmed/aligned with the
        // fleet upgrade before any async/Promise-relevant DEPLOY is broadcast to
        // mainnet; a wrong value is a fork. testnet/regtest activate at genesis (no
        // pre-activation history to preserve; the e2e/regtest stack has run with the
        // rule live, so genesis activation preserves its current behaviour).
        this.addChange('VM_BANNED_ASYNC', '2.0.0',VM_BANNED_ASYNC_MAINNET_TIME,0,0,0,0,0);

        // ISSUE validity: strict LOCK_MAX_SUPPLY guard. Before this activation the guard used
        // a truthy check, so an explicit LOCK_MAX_SUPPLY=0 field (a no-op lock intent with no
        // cap declared) incorrectly triggered the 'invalid: LOCK_MAX_SUPPLY (no max supply)'
        // outcome. After activation the guard requires LOCK_MAX_SUPPLY==1, matching the field's
        // intended semantics. Gated so a heterogeneous fleet and any from-genesis replay all
        // switch at the same block; pre-launch chains activate at genesis (all zeros), making
        // the strict check effective from block 0 on testnet/regtest and mainnet alike.
        this.addChange('LOCK_MAX_SUPPLY_EXACT', '2.0.0',0,0,0,0,0,0);

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
    // @param {testnet_block} integer Testnet activation block_index
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