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
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const blockParse = require('../../../src/XChainIndexer/block_parse.js');
const blockPasses = require('../../../src/XChainIndexer/block_passes.js');
const blockCommit = require('../../../src/XChainIndexer/block_commit.js');
const blockFaults = require('../../../src/XChainIndexer/block_faults.js');
const dispatchMethods = require('../../../src/actions/actions_class/dispatch.js');
const Attest = require('../../../src/actions/attest/index.js');
const mirrorApply = require('../../../src/actions/attest/mirror_apply.js');
const Utility = require('../../../src/utility.js');

const BAD_ID = 'a'.repeat(64);
const GOOD_ID = 'b'.repeat(64);
const GOOD_BODY = 'accepted';
const GOOD_SIGS = JSON.stringify([{ pubkey: 'c'.repeat(64), sig: 'd'.repeat(128) }]);

function row(requestId, signatures, body) {
    return {
        request_id: requestId,
        provider_id: 'http_get',
        status: 'ok',
        signatures,
        response_payload: body,
        response_hash: crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
    };
}

function request(requestId) {
    return {
        request_id: requestId,
        request_status: 'pending',
        provider_id: 'http_get'
    };
}

const ROWS = [
    row(BAD_ID, '{not json', 'malformed'),
    row(GOOD_ID, GOOD_SIGS, GOOD_BODY)
];

function followerUtility(config) {
    const util = new Utility(config);
    sinon.stub(util, 'logError');
    sinon.stub(util, 'withTimeout').callsFake((promise) => promise);
    sinon.stub(util, 'processCrossChainCalls').resolves();
    sinon.stub(util, 'selectApplicableAttestationResponses').returns([
        { request: request(BAD_ID), response: ROWS[0] },
        { request: request(GOOD_ID), response: ROWS[1] }
    ]);
    return util;
}

function followerDatabase(config) {
    return {
        config,
        beginTransaction: sinon.stub().resolves(),
        commitTransaction: sinon.stub().resolves(),
        rollbackTransaction: sinon.stub().resolves(),
        currentTxEpoch: () => 1,
        runInTxEpoch: (epoch, fn) => fn(),
        getAttestationRequestsAwaitingMirrorResponse: sinon.stub().resolves([
            request(BAD_ID), request(GOOD_ID)
        ]),
        getMirroredAttestationResponses: sinon.stub().resolves(ROWS)
    };
}

function followerNode(config, util) {
    const node = Object.assign({}, blockParse, blockPasses, blockFaults, {
        config,
        util,
        indexerDb: followerDatabase(config),
        applied: [],
        passTrace: [],
        openBlockTransaction: async () => false,
        blockWatchdogTimeout: () => 1000,
        afterBlockCommit: async (blk, counts, last) => last + 1,
        runOpeningPasses: async function () { this.passTrace.push('opening'); },
        runSettlementPasses: async function () { this.passTrace.push('settlement'); },
        runRewardPasses: async function () { this.passTrace.push('reward'); },
        runClosingPasses: async function () { this.passTrace.push('closing'); },
        finalizeBlock: async function () {
            this.passTrace.push('finalize');
            return [0, 0, 0];
        }
    }, { abandonBlock: blockCommit.abandonBlock });
    return node;
}

function followerActions(node) {
    return Object.assign({}, dispatchMethods, {
        config: node.config,
        util: node.util,
        indexerDb: node.indexerDb,
        decoderDb: {},
        mapper: { createMappings: sinon.stub().resolves() },
        protocolChanges: {},
        _actionCounters: {},
        assignActionAddressIds: sinon.stub().resolves()
    });
}

function followerHandler(node, actions) {
    const handler = new Attest(actions);
    Object.assign(handler, mirrorApply, {
        isMirrorEraRequest: sinon.stub().returns(true),
        verifyMirroredResponse: sinon.stub().resolves({ error: null }),
        stampMirroredResponse: async (data, mirrorRow) => {
            data['STATUS'] = 'valid';
            node.applied.push(mirrorRow.request_id);
        },
        settleMirroredResponse: sinon.stub().resolves()
    });
    sinon.spy(handler, 'applyMirroredResponse');
    return handler;
}

function follower() {
    const config = { COIN: 'BTC', NETWORK: 'regtest', BLOCK_CHECK_INTERVAL: 1 };
    const util = followerUtility(config);
    const node = followerNode(config, util);
    const actions = followerActions(node);
    const handler = followerHandler(node, actions);
    actions.actionAttest = handler;
    node.actions = actions;
    return node;
}

describe('malformed mirrored row rejection @regression @tier1', function () {

    beforeEach(function () { sinon.stub(console, 'info'); });
    afterEach(function () { sinon.restore(); });

    it('has two followers reject the same malformed row identically while the block loop continues', async function () {
        const one = follower();
        const two = follower();
        assert.strictEqual(one.runBlockPasses, blockPasses.runBlockPasses);
        assert.strictEqual(two.runBlockPasses, blockPasses.runBlockPasses);
        assert.strictEqual(one.runCrossChainPasses, blockPasses.runCrossChainPasses);
        assert.strictEqual(two.runCrossChainPasses, blockPasses.runCrossChainPasses);
        const a = await one.processBlock({ blockToParse: 700 }, 699, 699);
        const b = await two.processBlock({ blockToParse: 700 }, 699, 699);
        const rejection = {
            rejected: true,
            source: 'attestation_responses',
            row: BAD_ID,
            code: 'signatures column is not a non-empty JSON array'
        };

        assert.deepStrictEqual(a, { committed: true, stop: false, lastDecoderBlock: 700 });
        assert.deepStrictEqual(a, b);
        assert.deepStrictEqual(await one.actions.actionAttest.applyMirroredResponse.firstCall.returnValue, rejection);
        assert.deepStrictEqual(await two.actions.actionAttest.applyMirroredResponse.firstCall.returnValue, rejection);
        assert.strictEqual(one.actions.actionAttest.applyMirroredResponse.callCount, 2);
        assert.strictEqual(two.actions.actionAttest.applyMirroredResponse.callCount, 2);
        assert.deepStrictEqual(one.applied, [GOOD_ID]);
        assert.deepStrictEqual(one.applied, two.applied);
        assert.deepStrictEqual(one.passTrace, ['opening', 'settlement', 'reward', 'closing', 'finalize']);
        assert.deepStrictEqual(one.passTrace, two.passTrace);
        assert.deepStrictEqual(one.actions.getActionCounters(), { ATTEST: { accepted: 1, rejected: 1 } });
        assert.deepStrictEqual(one.actions.getActionCounters(), two.actions.getActionCounters());
        assert.strictEqual(one.indexerDb.rollbackTransaction.callCount, 0);
        assert.strictEqual(two.indexerDb.rollbackTransaction.callCount, 0);
        assert.strictEqual(one.indexerDb.commitTransaction.callCount, 1);
        assert.strictEqual(two.indexerDb.commitTransaction.callCount, 1);
        assert.strictEqual(one.util.logError.callCount, 0);
        assert.strictEqual(two.util.logError.callCount, 0);
    });
});
