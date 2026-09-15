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
// ANCHOR activation: the retired wire versions and the ANCHOR_ACTIVATION height
// gate that runs ahead of every body parser. Part of the ANCHOR suite; see
// ../anchor.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../../fixtures/mocks');
const { v0Params, THREE_CHAINS, v1Params, ARCHIVE_JSON, armAnchor, disarmAnchor } = require('./helpers/anchor_fixtures.js');
const Anchor = require('../../../../../src/actions/anchor/index.js');
const aact = require('../../../../../src/anchor_activation.js');

let indexer, handler, verifyStub, swqStub, deriveGateStub;

// A second handler over the SAME mock DB, bound to another network. Built by
// re-wrapping `indexer` rather than by minting a fresh mock, so the reward/row
// assertions still read indexer.indexerDb and the suite does not accumulate a
// second full set of stubs per case.
function handlerOn(network) {
    return new Anchor(Object.assign({}, indexer,
        { config: Object.assign({}, indexer.config, { NETWORK: network }) }));
}

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    // At/above ANCHOR_ACTIVATION the wire set is exactly {0, 1, 2}, so every
    // pre-restart byte - the per-chain anchors AND the old bundle/archive-head pair a
    // not-yet-redeployed hub might still emit - falls out of the unknown-version check.
    it('the pre-restart versions no longer parse at all, v6 and v7 included', async function () {
        for (const v of [3, 4, 5, 6, 7]) {
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: v, COIN: 'DOGE' });
            await handler.parse(['' + v, 'BTC', 'regtest'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: VERSION (unknown)',
                'ANCHOR v' + v + ' is retired; its parser is deleted, not merely unused');
        }
    });

    // The activation gate runs BEFORE the format table, so a wire that is
    // well-formed under the live set is still invalid when it was mined below the
    // restart height. Keyed on the anchor's OWN DOGE height, never on SNAPSHOT_BLOCK.
    it('a v0 mined BELOW ANCHOR_ACTIVATION is invalid whatever it decodes to', async function () {
        let h = handlerOn('testnet');
        let below = aact.ANCHOR_ACTIVATION.testnet - 1;
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE', BLOCK_INDEX: below });
        await h.parse(v0Params({ network: 'testnet', sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: ANCHOR before activation');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled,
            'a pre-activation anchor pays nothing: the gate runs ahead of every body parser');
        // One block higher the same bytes are the live wire.
        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE',
                                     BLOCK_INDEX: aact.ANCHOR_ACTIVATION.testnet });
        await h.parse(v0Params({ network: 'testnet', sections: THREE_CHAINS }), data2, null);
        assert.strictEqual(data2['STATUS'], 'valid', 'the threshold block itself is active');
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('the activation gate covers EVERY version and fails closed on a junk height', async function () {
        let h = handlerOn('testnet');
        let below = aact.ANCHOR_ACTIVATION.testnet - 1;
        // A v1 and a v2 below the height are 'before activation', not 'VERSION (unknown)':
        // the same bytes meant something else on the pre-restart wire, so no shape check
        // on them means anything down there.
        let d1 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', BLOCK_INDEX: below });
        await h.parse(v1Params(ARCHIVE_JSON, { network: 'testnet' }), d1, null);
        assert.strictEqual(d1['STATUS'], 'invalid: ANCHOR before activation');
        let d2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', BLOCK_INDEX: below });
        await h.parse(['2', '9', '1', '3', 'BBBB'], d2, null);
        assert.strictEqual(d2['STATUS'], 'invalid: ANCHOR before activation');
        // A retired byte below the height reports the activation reason too: the gate is
        // first, so the version table never gets to speak.
        let d7 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE', BLOCK_INDEX: below });
        await h.parse(['7', 'BTC', 'testnet'], d7, null);
        assert.strictEqual(d7['STATUS'], 'invalid: ANCHOR before activation');
        // Fail closed: a non-numeric height is not a reason to admit an anchor.
        let dj = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE', BLOCK_INDEX: 'not-a-height' });
        await h.parse(v0Params({ network: 'testnet', sections: THREE_CHAINS }), dj, null);
        assert.strictEqual(dj['STATUS'], 'invalid: ANCHOR before activation');
    });
});
