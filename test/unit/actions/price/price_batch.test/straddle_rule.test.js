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
// PRICE v0 batch straddle rule (step 3): a batch whose round anchors sit on
// both sides of an armed oracle gate is refused.
// Part of the PRICE batch suite; see ../price_batch.test.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const {
    newIdentity, batchBody, uncompressedParams, sixRounds, signBatch, v2Data,
    newPriceHandler, usePriceBatchHarness,
} = require('./helpers/price_batch_harness.js');

const swq           = require('../../../../../src/consensus/stake_weighted_quorum.js');
// The verify-first tally rule is a registry row (W5), stubbed through activeAt() by its key.
const { stubGate } = require('../../../../helpers/gate_modules.js');
const PRICE_SIG_TALLY_KEY = 'price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION';

// Each test gets a fresh harness from usePriceBatchHarness; bind() hands it to
// the names the test bodies use and builds the handler they drive.
let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newHandler(); };
const newHandler = () => newPriceHandler(indexer, hubClient);

// Regtest arms every oracle gate at genesis, so no anchor can straddle one there.
// The gates are therefore driven directly, at a boundary standing in for mainnet's
// sig-tally height (963000). The parser resolves the rule through the SAME
// predicates the quorum uses, so a stub here moves both together, exactly as an
// armed height would.
const GATE = 963000;

function armGateAt(height){
    stubGate(sinon, PRICE_SIG_TALLY_KEY, false)
        .callsFake((key, network, coin, h) => parseInt(h) >= height);
}

function batchAcross(firstAnchor){
    const rounds = sixRounds({ anchorBase: firstAnchor });
    const id = newIdentity();
    capable.add(id.pubkey);
    return signBatch(rounds, [id]);
}

// -----------------------------------------------------------------------
// 3. Straddle rule
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('straddle rule (step 3)', function () {
        it('rejects a batch whose first and last round anchors sit on opposite sides of an armed gate', async function () {
            armGateAt(GATE);
            // anchors 962998..963003: the window crosses 963000.
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(GATE - 2))), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(data['STATUS'], 'invalid: batch straddles an oracle flag day');
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called,
                'a straddling batch must not reach the hub');
        });

        it('accepts the same batch entirely below the gate, and entirely at or above it', async function () {
            armGateAt(GATE);
            const below = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(GATE - 20))), below, null);
            assert.strictEqual(below['STATUS'], 'valid');

            const above = v2Data();
            await newHandler().parse(uncompressedParams(batchBody(batchAcross(GATE))), above, null);
            assert.strictEqual(above['STATUS'], 'valid');
        });

        it('straddles on the stake-weighted gate too, not only the sig-tally one', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            sinon.stub(swq, 'isStakeWeightedQuorumActive').callsFake(h => parseInt(h) >= 961000);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(960998))), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: batch straddles an oracle flag day');
        });

        it('an UNARMED gate straddles nothing', async function () {
            // Both sides resolve false, so the difference the rule looks for cannot exist.
            armGateAt(Number.MAX_SAFE_INTEGER);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batchAcross(GATE - 2))), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});
