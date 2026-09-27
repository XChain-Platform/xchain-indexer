'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../../fixtures/mocks');
const { buildIssue, makeData } = require('./helpers/fixture.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');

const GATE_KEY = 'issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH';
const OWNER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const TICK = 'BTC.PEPECASH';

function disableDetachGate() {
    const activeAt = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
        key === GATE_KEY ? false : activeAt(key, ...args));
}

async function runDetach(params) {
    const { indexer, handler } = buildIssue();
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({
        TICK, OWNER, ALLOW_LIST: 4242, BLOCK_LIST: 4343, BRIDGED: 0,
    }));
    indexer.indexerDb.isValidList.callsFake(async (value) => Number(value) > 0);
    const data = makeData({ FORMAT: 5, SOURCE: OWNER, IS_GENESIS: true });
    await handler.parse(params, data, null);
    return { data, indexer };
}

describe('ISSUE bridged copy policy detach @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('detaches both policy lists on an injected copy update', async function () {
        const { data, indexer } = await runDetach(['5', TICK, '0', '0', '']);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].ALLOW_LIST, null);
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].BLOCK_LIST, null);
        sinon.assert.notCalled(indexer.indexerDb.isValidList);
    });

    it('detaches one policy list and inherits the other', async function () {
        const { data, indexer } = await runDetach(['5', TICK, '0', '', '']);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].ALLOW_LIST, null);
        assert.strictEqual(indexer.indexerDb.createToken.firstCall.args[0].BLOCK_LIST, 4343);
    });

    it('rejects the detach sentinel while its ISSUE gate is inactive', async function () {
        disableDetachGate();
        const { data } = await runDetach(['5', TICK, '0', '0', '']);

        assert.strictEqual(data.STATUS, 'invalid: ALLOW_LIST (bad list)');
    });
});
