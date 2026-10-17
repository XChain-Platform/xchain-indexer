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

function loadStartup(warnings){
    const originalLoad = Module._load;
    const emptyClass   = class {};
    const changes = Object.assign(emptyClass, {
        UNARMED: 9999999999,
        get(key){
            assert.strictEqual(key,
                'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION');
            return { mainnet: 500000, testnet: 151324, regtest: 0 };
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
        '../observability/index.js': {
            getLogger: () => ({
                info(){},
                warn(message){ warnings.push(message); }
            })
        },
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

function indexer(network){
    return {
        config: { NETWORK: network, COIN: 'BTC' },
        util: {
            throwError(message){
                throw new Error(message);
            }
        }
    };
}

describe('Security: ATTEST response mirror boot guard network policy @regression @tier1', function () {
    const warnings = [];
    const startup = loadStartup(warnings);

    for(const network of ['mainnet', 'testnet']){
        it('refuses an armed BTC ' + network + ' boot without a hub database source', function () {
            assert.throws(
                () => startup.checkLocalPriceSource.call(indexer(network)),
                error => error.message.includes('ATTEST_RESPONSE_MIRROR_ACTIVATION') &&
                    error.message.includes('BTC ' + network) &&
                    error.message.includes('Configure a hub database source before booting')
            );
        });
    }

    it('warns and continues for an armed BTC regtest boot without a hub database source', function () {
        assert.doesNotThrow(
            () => startup.checkLocalPriceSource.call(indexer('regtest'))
        );
        assert(warnings.some(message =>
            message.includes('ATTEST_RESPONSE_MIRROR_ACTIVATION') &&
            message.includes('BTC regtest') &&
            message.includes('Continuing on regtest without a hub database source')));
    });
});
