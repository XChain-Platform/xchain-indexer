'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const Module = require('module');
const { requireWithFreshConfig } = require('../../../helpers/fresh_config.js');

const startupPath = require.resolve('../../../../src/XChainIndexer/startup.js');

function loadStartup(){
    const originalLoad = Module._load;
    const emptyClass   = class {};
    const changes = Object.assign(emptyClass, {
        UNARMED: 9999999999,
        get(key){
            assert.strictEqual(key,
                'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION');
            return { mainnet: null, testnet: 151324, regtest: 0 };
        }
    });
    const stubs = {
        '../protocol_changes.js': changes,
        '../db': emptyClass,
        '../actions/index.js': emptyClass,
        '../rollback/index.js': emptyClass,
        '../chain/mapper.js': emptyClass,
        '../hub/hub_client.js': emptyClass,
        '../hub/hub_db_sync.js': emptyClass,
        '../hub/hub_db_sync/hub_selector.js': () => ({}),
        '../consensus/doge_peer_clients/anchor_proof_client.js': emptyClass,
        '../consensus/doge_peer_clients/rollcall_proof_client.js': { RollcallProofClient: emptyClass },
        '../hub/hub_push_queue.js': emptyClass,
        '../chain/utxo_tracker.js': emptyClass,
        '../chain/genesis.js': emptyClass,
        '../observability/index.js': { getLogger: () => ({ info(){}, warn(){} }) },
        '../config.js': { CONFIG_ENV: { INDEXER_ALLOW_LOCAL_PRICE_SOURCE: 'true' } }
    };

    Module._load = function(request){
        if(Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
        return originalLoad.apply(this, arguments);
    };
    try {
        return requireWithFreshConfig(startupPath);
    } finally {
        Module._load = originalLoad;
    }
}

const startup = loadStartup();

function indexer(network, coin){
    return {
        config: { NETWORK: network, COIN: coin },
        util: {
            throwError(message){
                throw new Error(message);
            }
        }
    };
}

describe('Security: ATTEST response mirror boot guard @regression @tier1', function () {
    for(const network of ['testnet', 'regtest']){
        it('refuses BTC ' + network + ' without a hub database source', function () {
            assert.throws(
                () => startup.checkLocalPriceSource.call(indexer(network, 'BTC')),
                error => error.message.includes('ATTEST_RESPONSE_MIRROR_ACTIVATION') &&
                    error.message.includes('attestation_responses') &&
                    error.message.includes('AnchorRecovery cannot rebuild it')
            );
        });
    }

    it('does not apply the response-mirror refusal on unpinned mainnet', function () {
        assert.doesNotThrow(
            () => startup.checkLocalPriceSource.call(indexer('mainnet', 'BTC'))
        );
    });

    it('does not apply the BTC-only response-mirror refusal to another chain', function () {
        assert.doesNotThrow(
            () => startup.checkLocalPriceSource.call(indexer('regtest', 'DOGE'))
        );
    });
});
