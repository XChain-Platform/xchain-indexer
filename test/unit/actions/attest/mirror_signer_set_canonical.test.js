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
// Mirror apply stores, and settle pays, only the rank-best `redundancy` verified signers.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { REQ_ID } = require('./attest_response_applier.test/helpers/rows.js');
const { applyData, setupEffects } = require('./attest_response_applier.test/helpers/effects_fixture.js');

const k = c => c.repeat(64);
const ranked = [k('c'), k('a'), k('d'), k('b')];
const sig = c => ({ pubkey: k(c), sig: 's' + c });

describe('mirror signer set is canonical @regression @tier3', function () {
    let handler;
    beforeEach(function () {
        ({ handler } = setupEffects());
        sinon.stub(handler, 'computeResponsibleSet').resolves(ranked);
    });
    afterEach(function () { sinon.restore(); });

    async function stamp(verified) {
        const data = applyData();
        const request = { ...data['MIRROR_REQUEST'], redundancy: 2 };
        const row = data['MIRROR_RESPONSE'];
        const verdict = { verifiedSigs: verified, validSigs: verified.length, responseHash: 'h' };
        await handler.stampMirroredResponse(data, row, request, REQ_ID, verdict);
        return { data, verdict };
    }

    it('two different verified supersets store the same signer rows', async function () {
        const x = await stamp([sig('b'), sig('d'), sig('a'), sig('c')]);
        const y = await stamp([sig('a'), sig('c'), sig('b')]);
        assert.strictEqual(x.data['VALIDATOR_SIGNATURES'], y.data['VALIDATOR_SIGNATURES']);
        const stored = JSON.parse(x.data['VALIDATOR_SIGNATURES']).map(s => s.pubkey);
        assert.deepStrictEqual(stored, [k('a'), k('c')]);
        assert.deepStrictEqual(x.verdict.verifiedSigs.map(s => s.pubkey), [k('a'), k('c')]);
    });

    it('the settle pay set is the rank-best redundancy of what the row stores', function () {
        const request = { request_id: REQ_ID, redundancy: 2 };
        const all = JSON.stringify([sig('b'), sig('d'), sig('a'), sig('c')]);
        const paid = handler.signerPaySet(request, { VALIDATOR_SIGNATURES: all }, ranked);
        assert.deepStrictEqual(paid, [k('a'), k('c')]);
    });

    it('a stored set wholly outside the responsible set falls back to it', function () {
        const request = { request_id: REQ_ID, redundancy: 2 };
        const paid = handler.signerPaySet(request, { VALIDATOR_SIGNATURES: JSON.stringify([sig('e')]) }, ranked);
        assert.deepStrictEqual(paid, ranked);
    });
});
