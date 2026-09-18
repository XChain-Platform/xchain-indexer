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
// PRICE v0 batch signature verification (step 4), the quorum rules it keys on
// the batch anchor, and the canonical the signatures cover.
// Part of the PRICE batch suite; see ../price_batch.test.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const {
    newIdentity, signWith, batchBody, uncompressedParams, sixRounds, signBatch,
    v2Data, newPriceHandler, validBatchFor, usePriceBatchHarness,
} = require('./helpers/price_batch_harness.js');

const ed25519       = require('../../../../../src/consensus/ed25519.js');
const swq           = require('../../../../../src/consensus/stake_weighted_quorum.js');
// The verify-first tally rule is a registry row (W5), observed through activeAt().
const gateRegistry  = require('../../../../../src/consensus/gate_registry');
const PRICE_SIG_TALLY_KEY = 'price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION';

// Each test gets a fresh harness from usePriceBatchHarness; bind() hands it to
// the names the test bodies use and builds the handler they drive.
let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newHandler(); };
const newHandler = () => newPriceHandler(indexer, hubClient);
const validBatch = () => validBatchFor(capable);

// -----------------------------------------------------------------------
// 4. Signature verification
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('signature verification (step 4)', function () {
        it('verifies real signatures over the canonical from buildPriceBatchPayload', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects a batch whose body was altered after signing', async function () {
            // A price edited on the wire leaves the signature over the ORIGINAL canonical,
            // which is the whole point of covering the rounds with one signature set.
            const batch = validBatch();
            const body  = batchBody(batch);
            const idx   = body.indexOf('50000.00');
            body[idx]   = '60000.00';
            const data  = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('quorum'), data['STATUS']);
        });

        it('rejects a signature that is valid over the v0 canonical of one contained round', async function () {
            // The new engine tag is what keeps v0 and v2 canonicals unmixable; a v0-shaped
            // signature must not satisfy a batch.
            const id = newIdentity();
            capable.add(id.pubkey);
            const rounds  = sixRounds();
            const v0Bytes = ed25519.buildPriceV0Payload(rounds[0].round, rounds[0].timestamp,
                rounds[0].pairs, 'regtest', rounds[0].btcBlockHeight);
            const batch = { firstRound: 100, lastRound: 105, btcBlockHeight: 799005, rounds,
                            sigs: [{ pubkey: id.pubkey, sig: signWith(id, v0Bytes) }] };
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('skips a signer without the price capability at this block', async function () {
            const id = newIdentity();   // deliberately NOT added to `capable`
            const batch = signBatch(sixRounds(), [id]);
            const data  = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('quorum'));
        });

        it('counts a duplicated pubkey once', async function () {
            const id = newIdentity();
            capable.add(id.pubkey);
            const batch = signBatch(sixRounds(), [id, id]);
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);   // quorum 3
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('1/3'), data['STATUS']);
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('signature verification (step 4)', function () {
        it('meets PBFT quorum at exactly 2f+1', async function () {
            const ids = [newIdentity(), newIdentity(), newIdentity()];
            for(const id of ids) capable.add(id.pubkey);
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);   // quorum 3
            const batch = signBatch(sixRounds(), ids);
            const data  = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('falls back to the per-signer capability path on a TRUNCATED capability read', async function () {
            // Treating a truncated read as the whole set would silently drop a qualified
            // signer and under-count the quorum, which is a rejected but legitimately
            // quorate batch on chain.
            const id = newIdentity();
            capable.add(id.pubkey);
            indexer.indexerDb.getValidatorsByCapability.callsFake(async () => {
                const rows = [];         // truncated reads can come back short or empty
                rows.truncated = true;
                return rows;
            });
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(signBatch(sixRounds(), [id]))), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.hasCapability.called, 'the per-signer path must be taken');
        });

        it('keys the sig-tally, the quorum gate AND the validator set on the BATCH anchor', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            const gateSpy = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
            const tallySpy = sinon.spy(gateRegistry, 'activeAt');

            const batch = validBatch();
            // A DOGE-like landing height, deliberately unlike the BTC anchor.
            await handler.parse(uncompressedParams(batchBody(batch)), v2Data({ BLOCK_INDEX: 5700000 }), null);

            // The gate keyed on the batch anchor (the LAST call is the quorum gate; the two
            // before it are the straddle rule's own probes).
            assert.strictEqual(gateSpy.lastCall.args[0], batch.btcBlockHeight);
            const tallyCalls = tallySpy.getCalls().filter((c) => c.args[0] === PRICE_SIG_TALLY_KEY);
            assert.ok(tallyCalls.length > 0, 'the tally rule was read');
            assert.strictEqual(tallyCalls[tallyCalls.length - 1].args[3], batch.btcBlockHeight);
            // The SET from the BTC anchor too, NOT the landing chain's own height:
            // capability_snapshots.snapshot_block is a BTC height, so a DOGE/LTC height
            // matches nothing off BTC and can match the wrong snapshot on regtest.
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args[1], batch.btcBlockHeight);
            assert.strictEqual(indexer.indexerDb.getActiveCapabilityCount.firstCall.args[1], batch.btcBlockHeight);
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('signature verification (step 4)', function () {
        it('uses stake-weighted quorum when the batch anchor is at or above its gate', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            const id = newIdentity();
            capable.add(id.pubkey);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([{ pubkey: id.pubkey, source: 's1', weight: '100' }]);
            const batch = signBatch(sixRounds(), [id]);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.getStakeWeightsByCapability.calledOnce);
            // The weights come from the same BTC anchor as the capable set, so the tally
            // and the denominator can never be drawn from two different validator sets.
            assert.strictEqual(indexer.indexerDb.getStakeWeightsByCapability.firstCall.args[1], batch.btcBlockHeight);
        });

        it('records the stake shortfall status when the signer stake is too thin', async function () {
            swq.isStakeWeightedQuorumActive.restore();
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            const signer = newIdentity(), whale = newIdentity();
            capable.add(signer.pubkey); capable.add(whale.pubkey);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                { pubkey: signer.pubkey, source: 's1', weight: '1' },
                { pubkey: whale.pubkey,  source: 's2', weight: '1000' },
            ]);
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(signBatch(sixRounds(), [signer]))), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient signer stake');
        });
    });
});

// -----------------------------------------------------------------------
// The canonical the signatures cover
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('the batch canonical', function () {

        it('carries first_round and last_round as JSON INTEGERS, never strings', async function () {
            // The equivocation reader that resolves an XORACLEB slash requires
            // Number.isInteger on both, so a string here would not surface as an invalid
            // action; it would surface as an unresolvable slashing decision. Caught here.
            const batch = validBatch();
            const json  = JSON.parse(batch.payload.slice(batch.payload.indexOf('{"first_round"')));
            assert.ok(Number.isInteger(json.first_round), 'first_round must be a JSON integer');
            assert.ok(Number.isInteger(json.last_round),  'last_round must be a JSON integer');
            assert.ok(Number.isInteger(json.btc_block_height));
            for(const r of json.rounds){
                assert.ok(Number.isInteger(r.round));
                assert.ok(Number.isInteger(r.timestamp));
                assert.ok(Number.isInteger(r.btc_block_height));
            }
            assert.ok(batch.payload.includes('"first_round":100,"last_round":105,'),
                'the window must serialize unquoted');
        });

        it('is built by ed25519.buildPriceBatchPayload, never inlined by the parser', async function () {
            // A second spelling of the canonical anywhere is a fork; this asserts the parser
            // verifies against the ONE builder's bytes.
            const batch = validBatch();
            const spy   = sinon.spy(ed25519, 'buildPriceBatchPayload');
            const verifySpy = sinon.spy(ed25519, 'verify');
            await handler.parse(uncompressedParams(batchBody(batch)), v2Data(), null);
            assert.ok(spy.calledOnce, 'the canonical must be built once per action');
            assert.deepStrictEqual(spy.firstCall.args.slice(0, 3), [100, 105, 799005]);
            assert.strictEqual(verifySpy.firstCall.args[0], spy.firstCall.returnValue);
        });
    });
});
