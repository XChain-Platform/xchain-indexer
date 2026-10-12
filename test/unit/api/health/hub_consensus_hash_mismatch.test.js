// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const coins = require('../../../../src/coins');
const { hubConfigMethods } = require('../../../../src/XChainIndexer/hub_config');
const { buildHealthResponse } = require('../../../../src/api/health');
const { statusBody } = require('../../../../src/api/status_route');

const COIN = 'BTC';
const NETWORK = 'regtest';

function makeIndexer(){
    return {
        config: { COIN, NETWORK },
        decoderDb: null,
        indexerDb: null,
        lastDecoderBlock: 100,
        isSynced: () => true
    };
}

function check(indexer, hashes){
    return hubConfigMethods.checkHubConsensusHash.call(indexer, hashes);
}

function hashes(hash){
    return { [NETWORK]: { [COIN]: hash } };
}

function health(indexer){
    return buildHealthResponse({
        indexer,
        indexerRunning: true,
        indexerError: null,
        lastIndexedBlock: 100,
        inFlightBlock: null,
        now: 1_700_000_000_000,
        reorgStats: null
    });
}

function status(indexer){
    const XChainIndexer = { atProcessableTip: () => true };
    const verdict = {
        now: 1_700_000_000_000,
        stalled: false,
        wedged: false,
        futureWait: false,
        stallClass: 'none',
        lastHubConfigFetchAt: null,
        hubConfigAgeSeconds: null,
        hubConfigStale: false
    };
    return statusBody(XChainIndexer, indexer, {
        indexerBlock: 100,
        inFlightBlock: null,
        decoderBlock: 100,
        verdict,
        hubMirror: { configured: false }
    });
}

describe('hub consensus-hash mismatch health and status reporting', function () {
    it('reports unknown with no detail before a hub supplies a hash map', async function () {
        const indexer = makeIndexer();
        check(indexer, null);

        assert.strictEqual(indexer.hubConsensusHashMismatch, null);
        assert.deepStrictEqual(indexer.hubConsensusHashMismatchDetail, []);

        const healthBody = await health(indexer);
        const statusResponse = status(indexer);
        for(const body of [healthBody, statusResponse]){
            assert.strictEqual(body.hubConsensusHashMismatch, null);
            assert.deepStrictEqual(body.hubConsensusHashMismatchDetail, []);
        }
    });

    it('reports unknown when the supplied hash map lacks this network or coin', async function () {
        for(const suppliedHashes of [{}, { [NETWORK]: {} }, { mainnet: { [COIN]: 'a'.repeat(64) } }]){
            const indexer = makeIndexer();
            check(indexer, hashes('b'.repeat(64)));

            check(indexer, suppliedHashes);

            assert.strictEqual(indexer.hubConsensusHashMismatch, null);
            assert.deepStrictEqual(indexer.hubConsensusHashMismatchDetail, []);
            const healthBody = await health(indexer);
            const statusResponse = status(indexer);
            for(const body of [healthBody, statusResponse]){
                assert.strictEqual(body.hubConsensusHashMismatch, null);
                assert.deepStrictEqual(body.hubConsensusHashMismatchDetail, []);
            }
        }
    });

    it('records and publishes a mismatch without changing health or status behavior', async function () {
        const indexer = makeIndexer();
        const hubHash = 'a'.repeat(64);
        const localHash = coins.consensusHash(COIN, NETWORK);

        check(indexer, hashes(hubHash));

        const detail = [COIN + '/' + NETWORK + ': hub ' + hubHash + ' vs bundled ' + localHash];
        assert.strictEqual(indexer.hubConsensusHashMismatch, true);
        assert.deepStrictEqual(indexer.hubConsensusHashMismatchDetail, detail);

        const healthBody = await health(indexer);
        const statusResponse = status(indexer);
        assert.strictEqual(healthBody.status, 'healthy');
        assert.strictEqual(statusResponse.degraded, false);
        for(const body of [healthBody, statusResponse]){
            assert.strictEqual(body.hubConsensusHashMismatch, true);
            assert.deepStrictEqual(body.hubConsensusHashMismatchDetail, detail);
            assert.deepStrictEqual(Object.keys(body).slice(-2),
                ['hubConsensusHashMismatch', 'hubConsensusHashMismatchDetail']);
        }
    });

    it('records a checked match as false and clears mismatch detail', async function () {
        const indexer = makeIndexer();
        check(indexer, hashes('b'.repeat(64)));

        check(indexer, hashes(coins.consensusHash(COIN, NETWORK)));

        assert.strictEqual(indexer.hubConsensusHashMismatch, false);
        assert.deepStrictEqual(indexer.hubConsensusHashMismatchDetail, []);
        const healthBody = await health(indexer);
        const statusResponse = status(indexer);
        assert.strictEqual(healthBody.hubConsensusHashMismatch, false);
        assert.strictEqual(statusResponse.hubConsensusHashMismatch, false);
        assert.deepStrictEqual(healthBody.hubConsensusHashMismatchDetail, []);
        assert.deepStrictEqual(statusResponse.hubConsensusHashMismatchDetail, []);
    });
});
