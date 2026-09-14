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
// Parties 2 and 3 of the four-party pin in test/unit/snapshot_reorg_buffer.test.js:
// the ATTEST v1 verifier and archive recovery, both in this repo, must resolve a
// declared snapshot_block N at the buried height N - 6 exactly as the hub signer
// does. Every block repeats the suite title, so each full test title is unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const swq = require('../../../src/stake_weighted_quorum.js');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const Attest         = require('../../../src/actions/attest/index.js');
const AnchorRecovery = require('../../../bin/recovery.js');

const { N, BURIED, PK_A, PK_B, PK_C, setAt } = require('./helpers/stake_history.js');

let indexer, handler, ed25519;

const REQ_ID = 'd'.repeat(64);
const SIG    = '1'.repeat(128);

function v1Params(sigs){
    const head = ['1', REQ_ID, 'http_get', Buffer.from('hello', 'utf8').toString('base64'), 'ok', 'm', String(sigs.length)];
    const tail = [];
    for(const s of sigs) tail.push(s.pubkey, s.sig);
    return head.concat(tail);
}

// Party 2's verifier over a db whose capability answers depend on the height asked
// about, with the legacy count path and the pre-mirror era pinned. Every party 2
// block runs it before each test.
function setUpVerifier(){
    ed25519 = require('../../../src/consensus/ed25519.js');
    indexer = createMockIndexer();
    const db = indexer.indexerDb;

    // Height-sensitive capability resolution: the real db.js predicate, so the
    // verifier's answer depends on WHICH height it asks about.
    db.getValidatorsByCapability = sinon.stub().callsFake(
        async (cap, block) => setAt(block).map(pk => ({ pubkey: pk })));
    db.hasCapability = sinon.stub().callsFake(
        async (pk, cap, block) => setAt(block).includes(String(pk).toLowerCase()));
    db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
    db.getAttestationRequestById = sinon.stub().resolves({
        request_id: REQ_ID, provider_id: 'http_get', request_status: 'pending',
        deadline_block: N + 500, block_index: N, redundancy: 2,
        contract_index: 5, callback_method: 'onResult', callback_params_json: '[]',
    });
    db.createAttestationResponse           = sinon.stub().resolves();
    db.incrementAttestationValidatorStat   = sinon.stub().resolves();
    db.updateAttestationRequestStatus      = sinon.stub().resolves();
    db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
    db.getContract                         = sinon.stub().resolves({ contract_index: 5 });
    db.createSavepoint                     = sinon.stub().resolves('sp1');
    db.releaseSavepoint                    = sinon.stub().resolves();
    db.rollbackToSavepoint                 = sinon.stub().resolves();

    handler = new Attest({
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: db,
        actionExecute: { parse: sinon.stub().resolves() },
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
    });
    indexer.util.resetLists();
    // Legacy count path: the source-deduped weighted resolver has its own
    // coverage; this test is about WHICH HEIGHT, not which resolver.
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    // And the response-mirror flag day, armed on regtest at genesis: above it the
    // chain handler refuses an on-chain v1 before any height is resolved, so these
    // burial vectors are the legacy era's (matches attest.test.js default).
    sinon.stub(require('../../../src/attest_response_mirror_activation.js'),
               'isResponseMirrorActive').returns(false);
    sinon.stub(ed25519, 'verify').returns(true);
}

describe('capability-snapshot reorg burial @regression @tier1', function () {

    // ── Party 2: the indexer attestation verifier ────────────────────────────
    describe('party 2: the ATTEST v1 verifier', function () {
        beforeEach(setUpVerifier);

        afterEach(function () { sinon.restore(); });

        it('accepts the set the hub SIGNED: a signer that deactivates inside (N-6, N]', async function () {
            // The hub's responsible set for a request declared at N is the set at N-6,
            // which still contains B. Verifying at the raw N drops B, leaving 1 valid
            // signature against redundancy 2, and rejects a correct deterministic
            // response ("insufficient valid signatures").
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: N + 10, ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PK_A, sig: SIG }, { pubkey: PK_B, sig: SIG }]), data, null);
            assert.strictEqual(data['STATUS'], 'valid',
                'the verifier rejected the set the hub signed: ' + data['STATUS']);
            assert.strictEqual(data['VALID_SIGS'], 2);
        });
    });
});

describe('capability-snapshot reorg burial @regression @tier1', function () {

    describe('party 2: the ATTEST v1 verifier', function () {
        beforeEach(setUpVerifier);

        afterEach(function () { sinon.restore(); });

        it('resolves the capable set and the responsible set at N-6, never at the declared N', async function () {
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: N + 10, ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PK_A, sig: SIG }, { pubkey: PK_B, sig: SIG }]), data, null);
            const heights = indexer.indexerDb.getValidatorsByCapability.getCalls().map(c => c.args[1]);
            assert.ok(heights.length > 0, 'the verifier must resolve a capability set');
            for(const h of heights)
                assert.strictEqual(h, BURIED, 'a capability set was resolved at ' + h + ', not the buried ' + BURIED);
        });
    });
});

describe('capability-snapshot reorg burial @regression @tier1', function () {

    describe('party 2: the ATTEST v1 verifier', function () {
        beforeEach(setUpVerifier);

        afterEach(function () { sinon.restore(); });

        it('rejects a signer that only ACTIVATES inside (N-6, N]: it was not in the signed set', async function () {
            // C qualifies at the raw N but not at N-6, so the hub never selected it. A
            // verifier reading the raw height would admit a signer the hub never had.
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: N + 10, ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PK_A, sig: SIG }, { pubkey: PK_C, sig: SIG }]), data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'),
                'a signer outside the hub-resolved set must not count toward quorum');
            assert.strictEqual(data['VALID_SIGS'], 1);
        });
    });
});

describe('capability-snapshot reorg burial @regression @tier1', function () {

    describe('party 2: the ATTEST v1 verifier', function () {
        beforeEach(setUpVerifier);

        afterEach(function () { sinon.restore(); });

        it('the flag-day input itself is NOT shifted by the buffer', async function () {
            // Burying the height the EQUIV/SWQ gates are evaluated at would move the
            // cutover block by 6, which is its own fork. Pin that the stake-weighted gate
            // still sees the DECLARED height.
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: N + 10, ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PK_A, sig: SIG }, { pubkey: PK_B, sig: SIG }]), data, null);
            const gateHeights = swq.isStakeWeightedQuorumActive.getCalls().map(c => c.args[0]);
            assert.ok(gateHeights.length > 0, 'the stake-weighted gate must be consulted');
            for(const h of gateHeights)
                assert.strictEqual(h, N, 'the flag-day gate was evaluated at ' + h + ', not the declared ' + N);
        });
    });
});

// BTC-side stub whose answers depend on the height asked about, unlike the
// block-blind stub the rest of recovery.test.js uses.
function btcDbAtHeight(){
    const calls = [];
    const rowsAt = (h) => setAt(h).map(pk => ({ pubkey: pk, source: 'src_' + pk.slice(0, 16), weight: '5' }));
    return {
        calls,
        // Stage-1 direct-stake probe: params are [pubkey, atBlock, atBlock].
        async doQuery(sql, params){
            const pk = String(params[0]).toLowerCase();
            const at = Number(params[1]);
            calls.push({ method: 'doQuery', block: at });
            return setAt(at).includes(pk) ? [{ 1: 1 }] : [];
        },
        async getValidatorsByCapability(cap, block, minStake){
            calls.push({ method: 'getValidatorsByCapability', block: Number(block), minStake });
            return rowsAt(block);
        },
        async getStakeWeightsByCapability(cap, block, minStake){
            calls.push({ method: 'getStakeWeightsByCapability', block: Number(block), minStake });
            return rowsAt(block);
        },
    };
}

// The archive a correct hub wrote: the set it RESOLVED (at N-6) stamped with the
// raw label N, which is exactly what _persistCapabilitySnapshot writes.
const honestArchive = setAt(BURIED).map(pk => ({
    capability: 'oracle_publish', snapshot_block: N,
    signing_pubkey: pk, source: 'src_' + pk.slice(0, 16), amount: '5',
}));

describe('capability-snapshot reorg burial @regression @tier1', function () {

    // ── Party 3: archive recovery ────────────────────────────────────────────
    describe('party 3: archive recovery', function () {
        it('_verifyStakes accepts an honest archive whose signer deactivates inside (N-6, N]', async function () {
            const btcDb = btcDbAtHeight();
            const rec   = new AnchorRecovery({}, { btcDb, verifyStakes: true, log: () => {} });
            // Pre-fix this threw "has no on-chain stake at block 1000 (fabricated set?)"
            // for B and the whole archive became unrecoverable.
            await rec._verifyStakes(honestArchive, 'regtest');
            for(const c of btcDb.calls)
                assert.strictEqual(c.block, BURIED, c.method + ' probed block ' + c.block + ', not the buried ' + BURIED);
        });

        it('_verifyCompleteness accepts an honest archive that omits a source activating inside (N-6, N]', async function () {
            const btcDb = btcDbAtHeight();
            const rec   = new AnchorRecovery({}, { btcDb, verifyStakes: true, log: () => {} });
            // C activates at 998, so it is absent from the hub-resolved set at 994 and
            // therefore absent from the archive. Re-resolving at the raw N reports C and
            // condemns the honest archive for a "dropped qualifying source".
            await rec.verifyCompleteness(honestArchive, 'regtest');
            const resolutions = btcDb.calls.filter(c => c.method !== 'doQuery');
            assert.ok(resolutions.length > 0, 'completeness must re-resolve the set');
            for(const c of resolutions)
                assert.strictEqual(c.block, BURIED, c.method + ' resolved at ' + c.block + ', not the buried ' + BURIED);
        });
    });
});

describe('capability-snapshot reorg burial @regression @tier1', function () {

    describe('party 3: archive recovery', function () {
        it('still rejects a genuinely fabricated key (the existence guard is not weakened)', async function () {
            const btcDb = btcDbAtHeight();
            const rec   = new AnchorRecovery({}, { btcDb, verifyStakes: true, log: () => {} });
            const forged = honestArchive.concat([{
                capability: 'oracle_publish', snapshot_block: N,
                signing_pubkey: 'f'.repeat(64), source: 'src_forged', amount: '5',
            }]);
            await assert.rejects(() => rec._verifyStakes(forged, 'regtest'), /fabricated set\?/);
        });
    });
});
