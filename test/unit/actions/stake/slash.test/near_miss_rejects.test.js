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
// SLASH action handler: the near misses the verifier must reject, from an
// honest view change, identical bytes and a forged signature to a missing
// snapshot member, a replay, a mislabelled CAPABILITY and a split
// snapshot_block.
// Part of the SLASH suite; see ../slash.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const eq    = require('../../../../../src/equivocation_header.js');
const {
    genKey, sign, b64, dexContent, params, data, dexProof, useSlashHarness,
} = require('./helpers/slash_harness.js');

// Each test gets a fresh harness from useSlashHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler, offender;
const bind = (h) => { ({ indexer, handler, offender } = h); };

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('REJECTS an honest view change (R-3): same round, different view → different key', async function () {
        // Two legit signatures under views 0 and 1; the submitter can only name ONE key,
        // so the other message fails the shared-prefix check.
        const key  = eq.equivKey(eq.ENGINE_TAGS.DEX, 'm_42', 0);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', 0, dexContent(100, '10'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', 1, dexContent(100, '20')); // view 1
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/EQUIV header\/key mismatch/.test(d['STATUS']), 'expected key-mismatch reject, got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS identical messages (PREPARE-then-COMMIT same bytes ≠ equivocation)', async function () {
        const key = eq.equivKey(eq.ENGINE_TAGS.DEX, 'm_42', 0);
        const msg = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', 0, dexContent(100, '10'));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msg, offender.privateKey, msg, offender.privateKey), d, null);

        assert.ok(/identical messages/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a forged signature (sig does not verify against offender)', async function () {
        const { key, msgA, msgB } = dexProof();
        const other = genKey();   // sign msgB with a DIFFERENT key
        const p = ['0', 'cross_chain', offender.pubHex,
                   b64(msgA), sign(offender.privateKey, msgA), b64(msgB), sign(other.privateKey, msgB)];
        const d = data();
        await handler.parse(p, d, null);

        assert.ok(/SIG_B/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('REJECTS when the offender is not in the capability snapshot at the slot', async function () {
        indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([]);   // empty set
        const { key, msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/not in capability snapshot/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a replay once already slashed (idempotent)', async function () {
        indexer.indexerDb.hasCapabilitySlashEvent = sinon.stub().resolves(true);
        const { key, msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/already slashed/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a CAPABILITY that does not match the engine', async function () {
        const { key, msgA, msgB } = dexProof();   // XDEX → cross_chain
        const d = data();
        await handler.parse(params('price', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS when the two messages disagree on snapshot_block', async function () {
        const { key, msgA, msgB } = dexProof(100, 101);   // different snapshot_block in content
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});
