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
// SLASH action handler: the XCONFIG engine, whose snapshot_block comes from
// the signed content and whose membership is the whole federation.
// Part of the SLASH suite; see ../slash.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const eq    = require('../../../../../src/consensus/equivocation_header.js');
const { buried, params, data, configProof, useSlashHarness } = require('./helpers/slash_harness.js');

// Each test gets a fresh harness from useSlashHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler, offender;
const bind = (h) => { ({ indexer, handler, offender } = h); };

// ── XCONFIG (the 6th engine: whole-federation membership) ──
// Config content = `snapshot_block|config_digest`; equivocation = same (seq, view),
// same snapshot_block, DIFFERENT digest. Membership resolves against getActiveValidators
// (the whole federation), labelled with the sentinel capability 'config'.
// configProof in helpers/slash_harness.js builds the equivocating pair.

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('ACCEPTS an XCONFIG equivocation (snapshot_block recovered from content; federation membership)', async function () {
        const { msgA, msgB } = configProof(150);
        const d = data();
        await handler.parse(params('config', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        // membership checked against the WHOLE federation at the BURIED in-content snapshot_block
        assert.deepStrictEqual(indexer.indexerDb.getActiveValidators.firstCall.args, [buried(150)]);
        assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled, 'config must NOT use a capability set');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
        // audit row keyed by the sentinel 'config' capability
        assert.strictEqual(indexer.indexerDb.createCapabilitySlashEvent.firstCall.args[0]['CAPABILITY'], 'config');
    });

    it('REJECTS XCONFIG when the offender is not in the federation snapshot', async function () {
        indexer.indexerDb.getActiveValidators = sinon.stub().resolves([]);   // empty federation set
        const { msgA, msgB } = configProof(150);
        const d = data();
        await handler.parse(params('config', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/not in federation snapshot/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS XCONFIG when the two messages disagree on snapshot_block', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, '5', 0, '150|digestA');
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, '5', 0, '151|digestA');   // different block
        const d = data();
        await handler.parse(params('config', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS XCONFIG with a non-config CAPABILITY label (derived, not trusted)', async function () {
        const { msgA, msgB } = configProof(150);
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});
