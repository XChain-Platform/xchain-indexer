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
// ---------------------------------------------------------------------------
// ATTEST v1 response-verification byte vectors: the capability read, which query
// runs and at which height, on the unweighted and the stake-weighted branch.
//
// How the vectors were captured, why the keys come from fixed seeds and why the
// capability read answers at one height only are described in
// ../attest_response_verify_vectors.test.js. The keys and captured literals are
// in ./helpers/vectors.js; the drive harness is ./helpers/vector_harness.js.
// ---------------------------------------------------------------------------

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const swq     = require('../../../../../src/stake_weighted_quorum.js');

const { K1, BURIED_BLOCK } = require('./helpers/vectors.js');
const { setupVectors, seatUnweighted, seatWeighted, driveOnce, driveSigned } = require('./helpers/vector_harness.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    let indexer;
    beforeEach(function () { ({ indexer } = setupVectors()); });
    afterEach(function () { sinon.restore(); });

    describe('the capability read: which query, at which height', function () {
        it('unweighted branch resolves at the ONCE-buried height', async function () {
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
            const blocks = indexer.indexerDb.getValidatorsByCapability.getCalls().map(c => c.args[1]);
            assert.ok(blocks.length > 0);
            assert.ok(blocks.every(b => b === BURIED_BLOCK),
                'every capability read must land on ' + BURIED_BLOCK + ', saw ' + JSON.stringify(blocks));
        });

        it('a TRUNCATED unweighted read falls back per signer to hasCapability', async function () {
            // The signature is GOOD here: the only thing that can reject it is the
            // per-signer probe, which is exactly what this vector is measuring. The
            // canonical is learned from a permissive first drive, because a rejected
            // signer never reaches the verifier and so never reveals it.
            seatUnweighted([K1.pubkey], { truncated: true });
            indexer.indexerDb.hasCapability = sinon.stub().resolves(true);
            const learn = await driveSigned([K1.pubkey]);
            assert.strictEqual(learn.status, 'valid');
            const good = crypto.sign(null, Buffer.from(learn.canonical, 'utf8'), K1.priv).toString('hex');

            indexer.indexerDb.hasCapability = sinon.stub().resolves(false);
            const r = await driveOnce([{ pubkey: K1.pubkey, sig: good }]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)',
                'the per-signer probe must be the gate on the unweighted truncated branch');
            assert.ok(indexer.indexerDb.hasCapability.calledWith(K1.pubkey, 'attestation', BURIED_BLOCK));
        });

        it('the same truncated read with hasCapability true is valid', async function () {
            seatUnweighted([K1.pubkey], { truncated: true });
            indexer.indexerDb.hasCapability = sinon.stub().resolves(true);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
        });

        it('weighted branch reads the stake-weight query and never the pubkey-aggregate one', async function () {
            swq.isStakeWeightedQuorumActive.returns(true);
            seatWeighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.callCount, 0);
            const blocks = indexer.indexerDb.getStakeWeightsByCapability.getCalls().map(c => c.args[1]);
            assert.ok(blocks.every(b => b === BURIED_BLOCK), JSON.stringify(blocks));
        });
    });
});

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = setupVectors()); });
    afterEach(function () { sinon.restore(); });

    describe('the capability read: which query, at which height', function () {
        it('a TRUNCATED weighted read is taken as it stands, never re-probed per signer', async function () {
            // The fixed bug: hasCapability is the pubkey aggregate, so a per-signer
            // fallback here drops the very source-split signers the weighted query
            // exists to admit. hasCapability answers FALSE; the row must still count.
            swq.isStakeWeightedQuorumActive.returns(true);
            seatWeighted([K1.pubkey], { truncated: true });
            indexer.indexerDb.hasCapability = sinon.stub().resolves(false);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(
                indexer.indexerDb.hasCapability.getCalls().filter(c => c.args[1] === 'attestation').length, 0,
                'no pubkey-aggregate probe may run on the weighted branch');
        });

        it('the weighted branch is gated on COIN === BTC as well as the height', async function () {
            swq.isStakeWeightedQuorumActive.returns(true);
            handler.config['COIN'] = 'LTC';
            seatWeighted([K1.pubkey]);
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            // Off BTC the eligibility read stays the pubkey-aggregate query, and
            // computeResponsibleSet returns [] by plane, so nothing is responsible.
            assert.strictEqual(indexer.indexerDb.getStakeWeightsByCapability.callCount, 0);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
        });
    });
});
