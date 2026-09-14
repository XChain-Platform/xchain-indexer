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
// THE ATTEST HANDLER SUITE. One handler, split by behaviour across
// test/unit/actions/attest.test.js and its parts in test/unit/actions/attest.test/, every part under
// the same suite title so each full test title is what it was when the suite was
// one file. The shared setup, the wire builders and the fixture constants live in
// test/helpers/attest_fixture.js; the batch-rail fixtures in
// test/helpers/attest_batch_rail_fixture.js.
//
// This part: which signers a v1 response may count, under the stake-weighted quorum
// and the deterministic responsible set.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const crypto = require('crypto');

const swq = require('../../../../src/stake_weighted_quorum.js');
const srb = require('../../../../src/snapshot_reorg_buffer.js');
const wid = require('../../../../src/attest_responsible_widening_activation.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, SIG_B, REQ_ID, makeRequestRow, setUpAttestHandler, v1Data, v1Params, verifyAllSignatures } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler, executeStub;
function setUpHandler() {
    ({ indexer, handler, executeStub } = setUpAttestHandler());
}

// The stake-split source: in the weighted (source-aggregate) set, absent
// from the pubkey-aggregate set, and holding no delegation row.
function stakeSplitSource() {
    indexer.indexerDb.getValidatorsByCapability.resolves([]);
    indexer.indexerDb.hasCapability.resolves(false);
    indexer.indexerDb.getStakeWeightsByCapability.resolves([
        { pubkey: PUBKEY_A, source: 'S1', weight: '50000' },
    ]);
}

// ── responsible-set membership (deterministic selection) ─────────
//
// Quorum requires signers from the request's deterministic responsible
// set: top-REDUNDANCY validators ranked by SHA256(request_id || pubkey),
// the same set parseExpire charges missed_count to. Capability + a valid
// sig is necessary but not sufficient: otherwise any capable coalition
// could assemble a valid v1 (first-lands-wins, non-deterministic) and
// fulfilled_count would drift from missed_count.

// Rank a universe of pubkeys exactly as computeResponsibleSet does, so the
// tests can pick in-set vs out-of-set coalitions without hard-coding hashes.
const PUBKEY_OUT1 = 'c'.repeat(64);
const PUBKEY_OUT2 = 'e'.repeat(64);
const PUBKEY_OUT3 = 'f'.repeat(64);
const SIG_C = '3'.repeat(128);
const SIG_D = '4'.repeat(128);
const SIG_E = '5'.repeat(128);
// Regtest is above ATTEST_ZERO_CONF_ACTIVATION (armed at 0), so the stage-2 ladder
// grants one headroom slot from the request block: the set the verifier admits is
// redundancy + widenSlots(responseBlock 100, requestBlock 90, deadline 200) = 2 + 1.
const WIDEN_AT_100 = wid.widenSlots(100, 90, 200, 'regtest');
function rankResponsible(reqId, pubkeys, redundancy) {
    return pubkeys
        .map(pk => ({ pk, h: crypto.createHash('sha256').update(String(reqId), 'utf8').update(pk, 'utf8').digest('hex') }))
        .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
        .slice(0, redundancy)
        .map(x => x.pk);
}

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        // STAKE_WEIGHTED_QUORUM: the v1 eligibility pre-filter must be derived from
        // the SAME query the responsible set is, or a responsible signer is dropped
        // before it is counted. getValidatorsByCapability / hasCapability qualify a
        // PUBKEY on its own aggregate; getStakeWeightsByCapability qualifies a SOURCE
        // on its aggregate and emits all of that source's keys, so a source clearing
        // MIN_STAKE only across sub-threshold keys is responsible yet was ineligible.
        // The responsible set is exactly REDUNDANCY keys, so one dropped member made
        // the request permanently unfulfillable, burning a fee on every retry.
        describe('STAKE_WEIGHTED_QUORUM: v1 signer eligibility follows the responsible-set derivation', function () {
            it('counts a responsible signer the pubkey-aggregate set excludes', async function () {
                swq.isStakeWeightedQuorumActive.returns(true);
                stakeSplitSource();
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['VALID_SIGS'], 1,
                    'a weighted responsible-set member must not be dropped by the eligibility gate: ' + data['STATUS']);
                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('reads eligibility from the weighted query, at the BURIED height', async function () {
                swq.isStakeWeightedQuorumActive.returns(true);
                indexer.indexerDb.getValidatorsByCapability.resolves([]);
                indexer.indexerDb.hasCapability.resolves(false);
                // Height-sensitive stub: only the once-buried height (90 buried once)
                // resolves the responsible signer. Both the eligibility read and
                // computeResponsibleSet's own internal read land here, so an
                // unburied or double-buried height on EITHER one drops the signer
                // and reds the quorum, rather than a `calledWith` check that a
                // second, independently-correct read could satisfy on its own.
                const buriedOnce = srb.buriedSnapshotBlock(90, 'regtest');
                indexer.indexerDb.getStakeWeightsByCapability = sinon.stub().callsFake(
                    async (capability, height) => (capability === 'attestation' && height === buriedOnce)
                        ? [{ pubkey: PUBKEY_A, source: 'S1', weight: '50000' }]
                        : []);
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1, block_index: 90 }));
                const data = v1Data({ BLOCK_INDEX: 100 });
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['VALID_SIGS'], 1,
                    'eligibility and the responsible set must both resolve at the request height buried once (90 buried), got: ' + data['STATUS']);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled,
                    'the pubkey-aggregate query must not gate eligibility above the flag-day');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        describe('STAKE_WEIGHTED_QUORUM: v1 signer eligibility follows the responsible-set derivation', function () {
            it('a TRUNCATED weighted read is used as it stands, never re-probed per signer', async function () {
                // hasCapability sums per signing_pubkey_id, the pubkey aggregate again, so a
                // per-signer fallback would reinstate the bug exactly where the federation is
                // largest. computeResponsibleSet reads the same truncated set at the same
                // block, so eligibility still covers it.
                swq.isStakeWeightedQuorumActive.returns(true);
                indexer.indexerDb.getValidatorsByCapability.resolves([]);
                indexer.indexerDb.hasCapability.resolves(false);
                const capped = [{ pubkey: PUBKEY_A, source: 'S1', weight: '50000' }];
                capped.truncated = true;
                indexer.indexerDb.getStakeWeightsByCapability.resolves(capped);
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(
                    indexer.indexerDb.hasCapability.getCalls().filter(c => c.args[1] === 'attestation').length, 0,
                    'no pubkey-aggregate probe may run on the weighted branch');
                assert.strictEqual(data['STATUS'], 'valid');
            });
        });

        describe('STAKE_WEIGHTED_QUORUM: v1 signer eligibility follows the responsible-set derivation', function () {
            it('below the flag-day the pubkey-aggregate gate is byte-preserved', async function () {
                swq.isStakeWeightedQuorumActive.returns(false);
                stakeSplitSource();
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.ok(indexer.indexerDb.getStakeWeightsByCapability.notCalled,
                    'pre-flag-day replay must never consult the weighted query');
                assert.strictEqual(data['VALID_SIGS'], 0);
                assert.ok(String(data['STATUS']).includes('insufficient'));
            });

            it('off BTC the BTC-anchored gate is never evaluated against a local height', async function () {
                // isStakeWeightedQuorumActive compares against a BTC height; an LTC/DOGE
                // local height is already past it, so consulting the gate there resolves
                // TRUE out of band. computeResponsibleSet returns [] off BTC for the same
                // reason, so the two stay on one plane.
                swq.isStakeWeightedQuorumActive.returns(true);
                indexer.config['COIN'] = 'LTC';
                stakeSplitSource();
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), v1Data(), null);
                assert.ok(indexer.indexerDb.getStakeWeightsByCapability.notCalled,
                    'the weighted eligibility read is BTC-only');
            });
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        it('rejects a v1 signed by a capable-but-not-responsible validator coalition', async function () {
            // Four capable validators, redundancy 2 → 2 are responsible, 2 are not.
            // The non-responsible pair signs a well-formed bundle (valid capability +
            // valid ed25519). Pre-fix this counted toward quorum (capability + sig
            // only) and produced a valid v1; post-fix the out-of-set signers are
            // filtered out and the response is rejected as insufficient.
            const universe = [PUBKEY_A, PUBKEY_B, PUBKEY_OUT1, PUBKEY_OUT2, PUBKEY_OUT3];
            const sigByPub = { [PUBKEY_A]: SIG_A, [PUBKEY_B]: SIG_B, [PUBKEY_OUT1]: SIG_C, [PUBKEY_OUT2]: SIG_D, [PUBKEY_OUT3]: SIG_E };
            const responsible = rankResponsible(REQ_ID.toLowerCase(), universe, 2 + WIDEN_AT_100);
            const outsiders   = universe.filter(pk => !responsible.includes(pk));
            assert.strictEqual(outsiders.length, 2, 'sanity: a 2-signer coalition outside the responsible set');

            indexer.indexerDb.getValidatorsByCapability.resolves(universe.map(pk => ({ pubkey: pk })));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params(outsiders.map(pk => ({ pubkey: pk, sig: sigByPub[pk] }))), data, null);

            assert.strictEqual(data['VALID_SIGS'], 0, 'no out-of-set signature counts toward quorum');
            assert.ok(String(data['STATUS']).includes('insufficient valid signatures'),
                'capable-but-not-responsible coalition must be rejected, got: ' + data['STATUS']);
            assert.ok(executeStub.parse.notCalled, 'no callback injected for an out-of-set coalition');
        });

        it('accepts a v1 signed by the deterministic responsible set', async function () {
            // The complement of the test above: the SAME universe, but now the
            // in-set members sign (the assigned pair plus the headroom slot) → quorum is
            // met and the response is valid.
            const universe = [PUBKEY_A, PUBKEY_B, PUBKEY_OUT1, PUBKEY_OUT2, PUBKEY_OUT3];
            const sigByPub = { [PUBKEY_A]: SIG_A, [PUBKEY_B]: SIG_B, [PUBKEY_OUT1]: SIG_C, [PUBKEY_OUT2]: SIG_D, [PUBKEY_OUT3]: SIG_E };
            const responsible = rankResponsible(REQ_ID.toLowerCase(), universe, 2 + WIDEN_AT_100);

            indexer.indexerDb.getValidatorsByCapability.resolves(universe.map(pk => ({ pubkey: pk })));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params(responsible.map(pk => ({ pubkey: pk, sig: sigByPub[pk] }))), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            // Every admitted signer counts, the headroom member included: the ladder widens
            // who may SIGN, and the verifier counts what it admitted, not the redundancy.
            assert.strictEqual(data['VALID_SIGS'], 2 + WIDEN_AT_100, 'every responsible signer counts, headroom included');
        });
    });
});
