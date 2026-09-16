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
// PRICE v0 batch anchor rule (step 3): BTC_BLOCK_HEIGHT must equal the last
// round anchor, driven as the quorum-selection attack it closes.
// Part of the PRICE batch suite; see ../price_batch.test.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const {
    newIdentity, batchBody, uncompressedParams, compressedParams, sixRounds,
    signBatch, v2Data, newPriceHandler, usePriceBatchHarness,
} = require('./helpers/price_batch_harness.js');

const swq           = require('../../../../../src/stake_weighted_quorum.js');

// Each test gets a fresh harness from usePriceBatchHarness; bind() hands it to
// the names the test bodies use and builds the handler they drive.
let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newHandler(); };
const newHandler = () => newPriceHandler(indexer, hubClient);

const GATE          = 961000;      // stands in for mainnet's stake-weighted height
const ROUND_ANCHOR  = GATE - 10;   // rounds 960990..960995, all below the gate
const ATTACK_HEADER = GATE + 500;  // the header alone claims the far side

let gate, signers, whole;

const attackRounds = () => sixRounds({ anchorBase: ROUND_ANCHOR });

// -----------------------------------------------------------------------
// The batch anchor rule (part of step 3): BTC_BLOCK_HEIGHT must equal the LAST
// included round's anchor.
//
// THE ATTACK this closes, driven end to end rather than asserted as a mismatch.
// Both quorum gates resolve on the header anchor and the straddle rule inspects
// only the per-round anchors, so an unconstrained header lets a colluding signing
// quorum choose WHICH consensus rule judges its own batch. Below, four price
// validators hold wildly uneven stake: the two that sign are one short of the
// count quorum of 3 but carry ~99.999% of the stake, so the very same batch is
// refused under the count rule and accepted under the stake-weighted one. Every
// per-round anchor sits honestly below the gate; only the HEADER claims otherwise.
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('batch anchor rule (step 3)', function () {
        beforeEach(function () {
            // A height-keyed gate, exactly as an armed activation height behaves. The
            // parser resolves it through the same predicate the quorum uses, so this
            // moves the real rule rather than a copy of it.
            swq.isStakeWeightedQuorumActive.restore();
            gate = sinon.stub(swq, 'isStakeWeightedQuorumActive').callsFake(h => parseInt(h) >= GATE);

            signers = [newIdentity(), newIdentity()];
            const dust = [newIdentity(), newIdentity()];
            whole = signers.concat(dust);
            for(const id of whole) capable.add(id.pubkey);

            // Count rule: 4 price-capable validators, so quorum is 3 and two signers fail.
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);
            // Stake rule: the same two signers hold 3*200000 > 2*200002, so they pass.
            indexer.indexerDb.getStakeWeightsByCapability.resolves(whole.map((id, i) => ({
                pubkey: id.pubkey, source: 's' + i, weight: i < 2 ? '100000' : '1'
            })));
        });

        it('refuses a header anchor that is not the last round anchor, before either quorum gate resolves', async function () {
            // Otherwise perfect: the quorum really signed this header, so nothing but the
            // anchor rule can tell this batch apart from an honest one.
            const batch = signBatch(attackRounds(), signers, { btcBlockHeight: ATTACK_HEADER });
            const data  = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(data['STATUS'], 'invalid: batch anchor does not match the last round');
            // The check has to run BEFORE the gates or it protects nothing: neither gate
            // was ever consulted, so no quorum rule was selected on the attacker's value.
            assert.ok(!gate.called, 'the stake-weighted gate must never have resolved');
            assert.ok(!indexer.indexerDb.getStakeWeightsByCapability.called);
            assert.ok(!indexer.indexerDb.getActiveCapabilityCount.called);
            // Nothing partial is stored and nothing reaches the hub.
            assert.strictEqual(data['ROUNDS_JSON'], null);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });

        it('judges the SAME signature set under the honest count rule once the header is truthful', async function () {
            // The control that makes the case above an attack rather than a typo: pinned to
            // the last round's own anchor, the batch resolves under the count rule its
            // per-round anchors really sit under, and two of four signers is short of
            // quorum. The lie was worth telling.
            const rounds = attackRounds();
            const batch  = signBatch(rounds, signers,
                { btcBlockHeight: rounds[rounds.length - 1].btcBlockHeight });
            const data   = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);

            assert.strictEqual(data['STATUS'], 'invalid: insufficient PBFT quorum (2/3)');
            assert.ok(!indexer.indexerDb.getStakeWeightsByCapability.called,
                'the honest anchor is below the gate, so the stake rule must not apply');
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('batch anchor rule (step 3)', function () {
        beforeEach(function () {
            // A height-keyed gate, exactly as an armed activation height behaves. The
            // parser resolves it through the same predicate the quorum uses, so this
            // moves the real rule rather than a copy of it.
            swq.isStakeWeightedQuorumActive.restore();
            gate = sinon.stub(swq, 'isStakeWeightedQuorumActive').callsFake(h => parseInt(h) >= GATE);

            signers = [newIdentity(), newIdentity()];
            const dust = [newIdentity(), newIdentity()];
            whole = signers.concat(dust);
            for(const id of whole) capable.add(id.pubkey);

            // Count rule: 4 price-capable validators, so quorum is 3 and two signers fail.
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);
            // Stake rule: the same two signers hold 3*200000 > 2*200002, so they pass.
            indexer.indexerDb.getStakeWeightsByCapability.resolves(whole.map((id, i) => ({
                pubkey: id.pubkey, source: 's' + i, weight: i < 2 ? '100000' : '1'
            })));
        });

        it('accepts an honest batch whose header anchor equals the last round anchor', async function () {
            const rounds = attackRounds();
            const batch  = signBatch(rounds, whole.slice(0, 3),
                { btcBlockHeight: rounds[rounds.length - 1].btcBlockHeight });
            const data   = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('refuses a header anchor that is off by one in either direction', async function () {
            // No tolerance: the rule is equality, so the nearest possible lie is refused.
            const rounds = attackRounds();
            const last   = rounds[rounds.length - 1].btcBlockHeight;
            for(const header of [last - 1, last + 1]){
                const batch = signBatch(rounds, whole.slice(0, 3), { btcBlockHeight: header });
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['STATUS'], 'invalid: batch anchor does not match the last round',
                    'header ' + header);
            }
        });

        it('applies to the compressed wire form as well, since both forms share the parser', async function () {
            const batch = signBatch(attackRounds(), signers, { btcBlockHeight: ATTACK_HEADER });
            const data  = v2Data();
            await handler.parse(compressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: batch anchor does not match the last round');
        });
    });
});
