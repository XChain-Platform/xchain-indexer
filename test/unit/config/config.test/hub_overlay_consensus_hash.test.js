// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The hub consensus-hash check runs on every config poll, so a standing mismatch
// logs once and only a changed or re-appearing mismatch logs again.
// Part of the hub config overlay suite; see ../config.test.js.

const assert = require('assert');
const sinon = require('sinon');
const coins = require('../../../../src/coins');
const { makeIndexer, restoreOverlay } = require('./helpers/overlay_indexer.js');

let indexer;

// Count the CONSENSUS HASH MISMATCH lines an error stub has captured.
function mismatchLogs(errStub){
    return errStub.getCalls().filter(c => /CONSENSUS HASH MISMATCH/.test(String(c.args[0]))).length;
}

// Build the served hash map for the indexer's own coin and network.
function served(hash){
    return { [indexer.config.NETWORK]: { [indexer.config.COIN]: hash } };
}

describe('XChainIndexer hub consensus-hash check', function () {
    afterEach(restoreOverlay);

    it('logs a standing mismatch once, and logs again when it changes or returns', function () {
        indexer = makeIndexer();
        let localHash = coins.consensusHash(indexer.config.COIN, indexer.config.NETWORK);
        let errStub = sinon.stub(console, 'error');

        indexer.checkHubConsensusHash(served('a'.repeat(64)));
        indexer.checkHubConsensusHash(served('a'.repeat(64)));
        assert.strictEqual(mismatchLogs(errStub), 1, 'a standing mismatch must log once, not per poll');

        indexer.checkHubConsensusHash(served('b'.repeat(64)));
        assert.strictEqual(mismatchLogs(errStub), 2, 'a changed hub hash must log again');

        indexer.checkHubConsensusHash(served(localHash));
        assert.strictEqual(mismatchLogs(errStub), 2, 'a matching hash must not log');

        indexer.checkHubConsensusHash(served('b'.repeat(64)));
        assert.strictEqual(mismatchLogs(errStub), 3, 'a mismatch that clears and returns must log again');
    });

    it('logs once across repeated polls that serve the same mismatch', async function () {
        indexer = makeIndexer();
        let errStub = sinon.stub(console, 'error');
        let hubStub = { configEnabled: true, getAllConfigs: sinon.stub() };
        hubStub.getAllConfigs.resolves({
            configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 1,
            coin_consensus_hashes: served('c'.repeat(64))
        });
        indexer.hubClient = hubStub;

        await indexer.pollHubConfigOnce();
        await indexer.pollHubConfigOnce();
        await indexer.pollHubConfigOnce();
        assert.strictEqual(hubStub.getAllConfigs.callCount, 3);
        assert.strictEqual(mismatchLogs(errStub), 1, 'three polls of one mismatch must log one ERROR');
    });
});
