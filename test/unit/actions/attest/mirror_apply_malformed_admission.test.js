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
// A malformed stored admission height must halt before the applier writes effects.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { REQ_ID } = require('./attest_response_applier.test/helpers/rows.js');
const { applyData, setupEffects } = require('./attest_response_applier.test/helpers/effects_fixture.js');

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    let indexer, handler;

    describe('malformed admit_block_* column halts instead of skipping', function () {
        beforeEach(function () { ({ indexer, handler } = setupEffects()); });

        afterEach(function () { sinon.restore(); });

        it('a non-numeric admit_block_btc throws out of the applier and writes NOTHING', async function () {
            const data = applyData({}, { admit_block_btc: 'abc' });

            await assert.rejects(
                () => handler.parse([1, REQ_ID], data, null),
                /not a usable admission height/,
                'the gate\'s refusal must reach the caller unabsorbed, not be swallowed into a skip');

            assert.strictEqual(indexer.indexerDb.createActionIndex.called, false,
                'no action index is minted for a row the gate refused to spell');
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false,
                'the request must stay pending: a halt is not a terminal verdict');
        });

        it('a negative admit_block_ltc throws the same way', async function () {
            const data = applyData({}, { admit_block_ltc: -1 });

            await assert.rejects(
                () => handler.parse([1, REQ_ID], data, null),
                /not a usable admission height/);

            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        });

        it('a non-integer admit_block_doge throws the same way', async function () {
            const data = applyData({}, { admit_block_doge: 1.5 });

            await assert.rejects(
                () => handler.parse([1, REQ_ID], data, null),
                /not a usable admission height/);

            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        });

        it('a usable admit_block_btc does not throw: the refusal is specific to an unusable column', async function () {
            const data = applyData({}, { admit_block_btc: 123 });
            await handler.parse([1, REQ_ID], data, null);
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, true,
                'a usable admission height must apply normally, proving the throw is not on the column\'s mere presence');
        });
    });
});
