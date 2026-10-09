// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The DOGE handlers validate checkpoint signatures and persist the raw
// publisher tail. Reward attestation verification belongs to BTC derivation.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const quorum = require('../../../../../src/actions/anchor/quorum.js');
const settle = require('../../../../../src/actions/anchor/settle.js');
const {
    v0Params, v1Params, ARCHIVE_JSON, armAnchor, disarmAnchor
} = require('./helpers/anchor_fixtures.js');
const { v3Params } = require('./helpers/anchor_v3_fixtures.js');

describe('ANCHOR DOGE-side reward callers removed @regression @tier3', function () {
    let indexer, handler, verifyStub, swqStub, deriveGateStub;
    let headAttestation, bundleAttestation, legacyInstall;

    beforeEach(function () {
        headAttestation = sinon.stub(quorum, 'headAttestationMet')
            .throws(new Error('DOGE must not evaluate archive reward attestations'));
        bundleAttestation = sinon.stub(quorum, 'bundleAttestationMet')
            .throws(new Error('DOGE must not evaluate bundle reward attestations'));
        legacyInstall = sinon.stub(settle, 'installLegacyRewardCredits')
            .throws(new Error('DOGE must not install legacy reward credits'));
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });

    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('v0 records a valid bundle without the reward-side pass', async function () {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });

        await handler.parse(v0Params(), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(bundleAttestation.notCalled);
        assert.ok(legacyInstall.notCalled);
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v1 records a valid archive head without the reward-side pass', async function () {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });

        await handler.parse(v1Params(ARCHIVE_JSON), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(headAttestation.notCalled);
        assert.ok(legacyInstall.notCalled);
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v3 records a valid fold without the reward-side pass', async function () {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parseFold(v3Params({ archive: false }), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(bundleAttestation.notCalled);
        assert.ok(legacyInstall.notCalled);
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });
});
