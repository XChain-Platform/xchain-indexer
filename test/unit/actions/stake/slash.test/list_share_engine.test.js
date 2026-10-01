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

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const eq = require('../../../../../src/consensus/equivocation_header.js');

const hadListShareTag = eq.ENGINE_TAGS.LIST_SHARE !== undefined;
if(!hadListShareTag) eq.ENGINE_TAGS.LIST_SHARE = 'XLISTSHARE';
assert.strictEqual(eq.ENGINE_TAGS.LIST_SHARE, 'XLISTSHARE');
after(function () {
    if(!hadListShareTag) delete eq.ENGINE_TAGS.LIST_SHARE;
});

const { buried, genKey, params, data, useSlashHarness } = require('./helpers/slash_harness.js');

let indexer, handler, offender;
const bind = (h) => { ({ indexer, handler, offender } = h); };

const SNAPSHOT_ID = 'ab'.repeat(32);
const BELOW_TESTNET_GATE = 154776;

function listShareContent(snapshotBlock, membersHash, network){
    return ['XLISTSHARE', SNAPSHOT_ID, String(snapshotBlock), 'DOGE', '880001', '2', '1',
        'full', '160000', membersHash, network, 'ADMIT', '100', '101', '102'].join('|');
}

function listShareProof(snapshotA = 100, snapshotB = 100, network = 'regtest'){
    const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.LIST_SHARE, SNAPSHOT_ID, 0,
        listShareContent(snapshotA, '11'.repeat(32), network));
    const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.LIST_SHARE, SNAPSHOT_ID, 0,
        listShareContent(snapshotB, '22'.repeat(32), network));
    return { msgA, msgB };
}

describe('SLASH LIST_SHARE engine @regression', function () {
    useSlashHarness(bind);

    it('burns the cross_chain bond for two armed list versions in one slot', async function () {
        const { msgA, msgB } = listShareProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey,
            msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['cross_chain', buried(100)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('rejects list versions whose snapshot_block fields differ', async function () {
        const { msgA, msgB } = listShareProof(100, 101);
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey,
            msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'invalid: snapshot_block (mismatch or format)');
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('rejects a declared capability other than cross_chain', async function () {
        const { msgA, msgB } = listShareProof();
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey,
            msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'invalid: CAPABILITY (does not match engine)');
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});

describe('SLASH LIST_SHARE producer gate @regression', function () {
    useSlashHarness(bind);

    beforeEach(function () {
        handler.config.NETWORK = 'testnet';
    });

    it('keeps a valid below-gate pair not slashable', async function () {
        const { msgA, msgB } = listShareProof(BELOW_TESTNET_GATE, BELOW_TESTNET_GATE, 'testnet');
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey,
            msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'invalid: ENGINE_TAG (not slashable)');
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('answers the below-gate verdict before a bad SIG_A', async function () {
        const { msgA, msgB } = listShareProof(BELOW_TESTNET_GATE, BELOW_TESTNET_GATE, 'testnet');
        const other = genKey();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, other.privateKey,
            msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'invalid: ENGINE_TAG (not slashable)');
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('answers the below-gate verdict before malformed field 2', async function () {
        const { msgA, msgB } = listShareProof('not-a-height', 'not-a-height', 'testnet');
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey,
            msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'invalid: ENGINE_TAG (not slashable)');
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});
