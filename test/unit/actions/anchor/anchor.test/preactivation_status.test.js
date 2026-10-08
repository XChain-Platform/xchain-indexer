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
// An anchor mined below ANCHOR_ACTIVATION is stamped with the node-class status
// 'unverified' once the table's PREACTIVATION_STATUS selector is active, so the
// BTC reward derivation reads the row as a candidate on every node.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { v0Params, THREE_CHAINS, armAnchor, disarmAnchor } = require('./helpers/anchor_fixtures.js');
const Anchor = require('../../../../../src/actions/anchor/index.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const binding = require('../../../../../src/consensus/doge_peer_clients/anchor_proof_client/binding.js');

const GATE = 'anchor_activation.ANCHOR_ACTIVATION';
const SELECTOR = 'PREACTIVATION_STATUS';
const ANCHOR_HEIGHTS = gateRegistry.get('anchor_activation.ANCHOR_ACTIVATION');

describe('Anchor pre-activation status gate @regression @tier3', function () {
    let indexer, handler, verifyStub, swqStub, deriveGateStub, activeAt, realActiveAt;

    function handlerOn(network) {
        return new Anchor(Object.assign({}, indexer,
            { config: Object.assign({}, indexer.config, { NETWORK: network }) }));
    }
    function gateOn(height) {
        activeAt.callsFake((key, ...rest) =>
            (key === GATE && rest[1] === SELECTOR ? Number(rest[2]) >= height : realActiveAt(key, ...rest)));
    }
    async function parseAt(height) {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE', BLOCK_INDEX: height });
        await handlerOn('testnet').parse(v0Params({ network: 'testnet', sections: THREE_CHAINS }), data, null);
        return data;
    }

    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
        realActiveAt = gateRegistry.activeAt.bind(gateRegistry);
        activeAt = sinon.stub(gateRegistry, 'activeAt').callThrough();
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('is registered unarmed on mainnet and testnet and armed from genesis on regtest', function () {
        const heights = gateRegistry.get(GATE);
        assert.ok(heights[SELECTOR + ':mainnet'] >= 9999999999);
        assert.ok(heights[SELECTOR + ':testnet'] >= 9999999999);
        assert.strictEqual(heights[SELECTOR + ':regtest'], 0);
    });

    it('keeps the old text byte for byte while the gate is inactive', async function () {
        const data = await parseAt(ANCHOR_HEIGHTS.testnet - 1);
        assert.strictEqual(data['STATUS'], 'invalid: ANCHOR before activation');
    });

    it('stamps unverified below ANCHOR_ACTIVATION once the gate is active', async function () {
        gateOn(0);
        const data = await parseAt(ANCHOR_HEIGHTS.testnet - 1);
        assert.strictEqual(data['STATUS'], 'unverified');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled, 'still pays nothing');
        assert.ok(binding.NODE_CLASS_DEPENDENT_STATUS.test(data['STATUS']));
        assert.strictEqual(binding.isRewardCandidateRow(
            { status: data['STATUS'], checkpoint_network: 'testnet', publisher: 'abc' }, 'testnet', 'abc'), true);
    });

    it('reads the old spelling as a non-candidate, so the stamp is what changes the verdict', function () {
        assert.strictEqual(binding.isRewardCandidateRow(
            { status: 'invalid: ANCHOR before activation', checkpoint_network: 'testnet', publisher: 'abc' },
            'testnet', 'abc'), false);
    });

    it('leaves the gate inert for an anchor below its own height', async function () {
        gateOn(ANCHOR_HEIGHTS.testnet - 1);
        const below = await parseAt(ANCHOR_HEIGHTS.testnet - 2);
        assert.strictEqual(below['STATUS'], 'invalid: ANCHOR before activation');
        const at = await parseAt(ANCHOR_HEIGHTS.testnet - 1);
        assert.strictEqual(at['STATUS'], 'unverified');
    });

    it('changes nothing at or above ANCHOR_ACTIVATION', async function () {
        gateOn(0);
        const data = await parseAt(ANCHOR_HEIGHTS.testnet);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('fails closed on a junk height whatever the gate says', async function () {
        gateOn(0);
        const data = await parseAt('not-a-height');
        assert.strictEqual(data['STATUS'], 'invalid: ANCHOR before activation');
    });
});
