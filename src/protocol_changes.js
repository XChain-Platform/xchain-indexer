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

        // VM actions (all chains)
        this.addChange('DEPLOY',             '2.0.0',0,0,0,0,0,0);
        this.addChange('EXECUTE',            '2.0.0',0,0,0,0,0,0);
        this.addChange('DEPOSIT',            '2.0.0',0,0,0,0,0,0);
        this.addChange('WITHDRAW',           '2.0.0',0,0,0,0,0,0);

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

        // Define protocol changes (ALL LOWER Case)
        // this.addChange('name','1.0.0',0,0,0,0,0,0);
        this.addChange('UNIFIED_FEES',   '2.0.0',0,0,0,0,0,0);
        this.addChange('VM_ACTIONS',     '2.0.0',0,0,0,0,0,0);
        // Issuance fee activation. Mainnet turns on at the historical block 862633;
        // testnet/regtest charge from block 0 so the fee path is exercisable there.
        this.addChange('ISSUANCE_FEE',   '1.0.0',0,0,0,862633,0,0);

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
            enabled = false;
            console.log('protocol error e=',e);
        }
        return enabled;
    }
 
}

module.exports = ProtocolChanges;