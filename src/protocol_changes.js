/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Protocol Changes Class
 * 
 * This file defines all the supported actions and protocol changes
 *
 ********************************************************************/

class ProtocolChanges {

    // Handle constructing a class instance
    constructor(indexer){
        // Parse in indexer configuration
        this.config    = indexer.config;

        // Setup alias to the utility class instance
        this.util      = indexer.util;

        // Setup alias to the indexer database connection
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // XChain Indexer Version and network
        this.version = process.env.npm_package_version;
        this.network = process.env.INDEXER_NETWORK;

        // Setup alias to the utility class
        // Protocol Changes object
        this.changes = {};

        // Parse in protocol changes
        this.parseChanges();
    }

    // Parse protocol changes and populate protocol changes data object
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
        // (v2/v3), and the chunk carrier (v4) — all gated under this one entry.
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
        // ledger. Keyed on block_TIME (not block_index) on purpose — DEPLOY runs on BTC, LTC
        // and DOGE, whose heights diverge by millions of blocks, so no single shared block
        // height can name one coordinated cutover across all three chains, but a single
        // timestamp can. testnet/regtest activate at genesis (base64-native; no pre-base64
        // history to preserve, and the e2e/regtest stack deploys base64 from block 0).
        // The mainnet timestamp below is a PLACEHOLDER coordinated flag-day (2027-01-01
        // 00:00:00 UTC) that MUST be confirmed and aligned with the SDK base64 rollout
        // before any base64 DEPLOY is broadcast to mainnet — a wrong value is a second fork.
        this.addChange('DEPLOY_BASE64_CODE', '2.0.0',1798761600,0,0,0,0,0);

        // Staking actions — capability variants (STAKE v1/v2, UNSTAKE v0, DELEGATE v0/v2, COLLECT) are BTC-only;
        // contract variants (STAKE v3, UNSTAKE v1, DELEGATE v1/v3) work on any chain
        this.addChange('STAKE',              '2.0.0',0,0,0,0,0,0);
        this.addChange('UNSTAKE',            '2.0.0',0,0,0,0,0,0);
        this.addChange('DELEGATE',           '2.0.0',0,0,0,0,0,0);
        this.addChange('COLLECT',            '2.0.0',0,0,0,0,0,0);

        // PRICE action — validator oracle (v0) and user oracle (v1) pricing
        // Publishable on any chain (DOGE recommended for low fees)
        this.addChange('PRICE',              '2.0.0',0,0,0,0,0,0);

        // External attestation framework — single ATTEST action with v0=request, v1=response, v2=expire
        // (See xchain-documentation/protocol/actions/ATTEST.md)
        this.addChange('ATTEST',             '2.0.0',0,0,0,0,0,0);

        // ANCHOR — DOGE-only on-chain state commitments: v0=checkpoint,
        // v1=checkpoint+match archive, v2=archive continuation
        // (See xchain-documentation/protocol/actions/ANCHOR.md)
        this.addChange('ANCHOR',             '2.0.0',0,0,0,0,0,0);

        // Cross-chain contract calls — XCALL v0=request (VM-emission-only; never
        // decoded from the wire), v2=expire (system-synthesized). The relay rows
        // ride the hub mirror; registered for consistency/documentation.
        // (See xchain-documentation/protocol/actions/XCALL.md)
        this.addChange('XCALL',              '2.0.0',0,0,0,0,0,0);

        // Define protocol changes (ALL LOWER Case)
        // this.addChange('name','1.0.0',0,0,0,0,0,0);
        this.addChange('UNIFIED_FEES',   '2.0.0',0,0,0,0,0,0);
        this.addChange('VM_ACTIONS',     '2.0.0',0,0,0,0,0,0);
        // Cross-chain DEX gate — when enabled, ORDER/SWAP allow GET_COIN != COIN and the
        // xchain-hub federation drives cross-chain matching + mirror-delivered settlement.
        // Genesis-activated (pre-launch).
        this.addChange('CROSS_CHAIN_DEX','2.0.0',0,0,0,0,0,0);
        // Issuance fee activation. Mainnet turns on at the historical block 862633;
        // testnet/regtest charge from block 0 so the fee path is exercisable there.
        this.addChange('ISSUANCE_FEE',   '1.0.0',0,0,0,862633,0,0);
        // VM-emitted ISSUE (IS_EMISSION) issuance-fee exemption. A contract
        // constructor (or EXECUTE) that emits an ISSUE has no XCHAIN balance on the
        // freshly deployed contract address, so charging ISSUANCE_FEE against the
        // emitted ISSUE fails fee validation and reverts the constructor — the
        // deployer already paid the DEPLOY/EXECUTE gas (base + per-byte + per-
        // emission), so the emitted ISSUE is fee-exempt. Gated as its own
        // consensus rule so the change in fee behaviour switches over at a
        // coordinated flag-day rather than implicitly the moment a node upgrades:
        // an ungated flip charges the fee on one node version and exempts it on
        // another at the SAME block, forking the ledger and the contract-state
        // checkpoint on the first constructor that emits an ISSUE. Keyed on
        // block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE — emitted
        // ISSUEs ride DEPLOY/EXECUTE, which run on BTC, LTC and DOGE whose heights
        // diverge by millions of blocks, so no single shared block height names one
        // cutover across all three chains, but a single timestamp does. The mainnet
        // timestamp is the same PLACEHOLDER coordinated flag-day as the base64
        // rollout (2027-01-01 00:00:00 UTC) and MUST be confirmed/aligned with the
        // other contract-deploy consensus fixes shipping in this window before any
        // affected DEPLOY is broadcast to mainnet — a wrong value is a second fork.
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
        // null — an ungated flip forks the contract_hash (and the federation
        // checkpoint preimage) the moment a balance-reading contract executes, even
        // within the 2.x line (2.2.0–2.7.10 lack the reader; 2.7.11+ have it).
        // Keyed on block_TIME (not block_index), mirroring DEPLOY_BASE64_CODE and
        // ISSUANCE_FEE_EMISSION_EXEMPT — DEPLOY/EXECUTE run on BTC, LTC and DOGE
        // whose heights diverge by millions of blocks, so no single shared block
        // height names one cutover across all three chains, but a single timestamp
        // does. The mainnet timestamp is the same PLACEHOLDER coordinated flag-day
        // as the other contract-deploy consensus fixes in this window (2027-01-01
        // 00:00:00 UTC) and MUST be confirmed/aligned before any balance-reading
        // contract is broadcast to mainnet — a wrong value is a fork. testnet/regtest
        // activate at genesis (no pre-reader history to preserve; the e2e/regtest
        // stack exercises VM balance reads from block 0).
        this.addChange('VM_BALANCE_TOKENINFO', '2.0.0',1798761600,0,0,0,0,0);

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
        // Verify name is string
        if(typeof name != 'string')
            error = 'protocol change name must be string!';
        if(!error && this.changes[name])
            error = 'protocol change name must be unique!';
        // Verify version is string
        if(!error && typeof version != 'string')
            error = 'protocol change version must be string!';
        // Verify version is in semantic version format
        if(!error && version.split('.').length != 3)
            error = 'protocol change version must be in semantic version format (XX.XX.XX)!';
        // Verify mainnet_time is integer
        if(!error && arguments[2] && typeof arguments[2] != 'number')
            error = 'protocol change mainnet_time must be integer!';
        // Verify testnet_time is integer
        if(!error && arguments[3] && typeof arguments[3] != 'number')
            error = 'protocol change testnet_time must be integer!';
        // Verify regtest_time is integer
        if(!error && arguments[4] && typeof arguments[4] != 'number')
            error = 'protocol change regtest_time must be integer!';
        // Verify mainnet_block is integer
        if(!error && arguments[5] && typeof arguments[5] != 'number')
            error = 'protocol change mainnet_block must be integer!';
        // Verify testnet_block is integer
        if(!error && arguments[6] && typeof arguments[6] != 'number')
            error = 'protocol change testnet_block must be integer!';
        // Verify regtest_block is integer
        if(!error && arguments[7] && typeof arguments[7] != 'number')
            error = 'protocol change regtest_block must be integer!';
        // Throw error on any protocol change parsing issue
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
            // disabled on this node only — invalidating actions that healthy peers process
            // normally and silently forking the ledger. Propagate instead so block
            // processing rolls back and retries the block with correct activation state.
            console.log('protocol error e=',e);
            throw e;
        }
        return enabled;
    }
 
}

module.exports = ProtocolChanges;