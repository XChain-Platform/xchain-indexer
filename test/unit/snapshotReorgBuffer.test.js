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
// : the snapshot height a hub SIGNS is not the height it RESOLVED the
// validator set at. CapabilitySnapshot buries every height it is handed by
// CANONICAL_REORG_BUFFER, while the wire (checkpoint.snapshot_block, the
// mirrored capability_snapshots rows, an ATTEST request's block_index) keeps the
// RAW height, on the convention that each consumer buries exactly once. The hub
// was the only party doing so.
//
// This suite is the four-party pin the ledger's verify step asks for: a
// validator whose stake ACTIVATES or DEACTIVATES inside (N - 6, N] must be
// resolved IDENTICALLY, for the same declared snapshot_block N, by
//   1. the hub signer            (xchain-hub CapabilitySnapshot._buriedBlockIndex)
//   2. the attestation verifier  (xchain-indexer actions/attest.js)
//   3. archive recovery          (xchain-indexer recovery.js)
//   4. the SDK light client      (xchain-sdk light.js followForward)
// Parties 1 and 4 live in sibling repos; those blocks skip when the sibling is
// not checked out, matching the existing cross-repo guard convention, unless
// XCHAIN_REQUIRE_SIBLINGS=1 forces a hard failure.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const fs     = require('fs');
const path   = require('path');

const srb = require('../../src/snapshot_reorg_buffer.js');
const swq = require('../../src/stake_weighted_quorum.js');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Attest         = require('../../src/actions/attest.js');
const AnchorRecovery = require('../../src/recovery.js');

const HUB_DIR = path.resolve(__dirname, '../../../xchain-hub');
const SDK_DIR = path.resolve(__dirname, '../../../xchain-sdk');

function requireSibling(dir, rel){
    const p = path.join(dir, rel);
    if(!fs.existsSync(p)){
        if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling module not found at ' + p);
        return null;
    }
    return require(p);
}

// ── The stake history every party is asked about ─────────────────────────────
// Declared snapshot height N; the buried height the hub actually resolves at is
// N - CANONICAL_REORG_BUFFER. A is stable outside the window; B DEACTIVATES and
// C ACTIVATES inside it, so the two heights disagree in both directions.
const N       = 1000;
const BURIED  = N - srb.CANONICAL_REORG_BUFFER;   // 994

const PK_A = 'a'.repeat(64);   // active throughout          -> in both sets
const PK_B = 'b'.repeat(64);   // deactivates at 997         -> in the buried set only
const PK_C = 'c'.repeat(64);   // activates   at 998         -> in the raw set only

const STAKES = [
    { pubkey: PK_A, activation: 100, deactivation: null },
    { pubkey: PK_B, activation: 100, deactivation: 997  },
    { pubkey: PK_C, activation: 998, deactivation: null },
];

// The qualifying set at an arbitrary height, the rule db.js applies:
// activation_block <= h AND (deactivation_block IS NULL OR deactivation_block > h).
function setAt(h){
    return STAKES
        .filter(s => s.activation <= Number(h) && (s.deactivation === null || s.deactivation > Number(h)))
        .map(s => s.pubkey);
}

describe(' capability-snapshot reorg burial @regression @tier1', function () {

    // ── The shared constant + gate ───────────────────────────────────────────
    describe('shared snapshot_reorg_buffer module', function () {

        it('the canonical buffer is the 6-block BTC confirmation depth the hub buries by', function () {
            assert.strictEqual(srb.CANONICAL_REORG_BUFFER, 6);
        });

        it('regtest (genesis-on) buries the declared height by exactly the buffer', function () {
            assert.strictEqual(srb.buriedSnapshotBlock(N, 'regtest'), BURIED);
            assert.strictEqual(srb.buriedSnapshotBlock(6, 'regtest'), 0);
        });

        it('clamps at 0 rather than returning a negative height near genesis', function () {
            assert.strictEqual(srb.buriedSnapshotBlock(0, 'regtest'), 0);
            assert.strictEqual(srb.buriedSnapshotBlock(3, 'regtest'), 0);
        });

        it('mainnet and testnet are INERT: the declared height passes through untouched', function () {
            // Arming changes acceptance and re-reads already-anchored artifacts, so the
            // activation height is an operator decision. Until it is ratified every
            // consumer must behave exactly as it did before this module existed.
            assert.strictEqual(srb.SNAPSHOT_BURIAL_ACTIVATION.mainnet, null);
            assert.strictEqual(srb.SNAPSHOT_BURIAL_ACTIVATION.testnet, null);
            assert.strictEqual(srb.buriedSnapshotBlock(N, 'mainnet'), N);
            assert.strictEqual(srb.buriedSnapshotBlock(N, 'testnet'), N);
            assert.strictEqual(srb.isSnapshotBurialActive(N, 'mainnet'), false);
            assert.strictEqual(srb.isSnapshotBurialActive(N, 'testnet'), false);
        });

        it('fails closed (no burial) on an unknown network or an unusable height', function () {
            assert.strictEqual(srb.buriedSnapshotBlock(N, 'nosuchnet'), N);
            // null/''/false must NOT be coerced to a finite 0, which would read as ACTIVE
            // on a genesis-on network and silently bury a missing height.
            for(const bad of [null, undefined, '', false, NaN, 'abc']){
                assert.strictEqual(srb.isSnapshotBurialActive(bad, 'regtest'), false,
                    String(bad) + ' must not evaluate the gate as active');
                assert.strictEqual(Object.is(srb.buriedSnapshotBlock(bad, 'regtest'), bad), true,
                    String(bad) + ' must pass through verbatim');
            }
        });
    });

    // ── Party 1: the hub signer ──────────────────────────────────────────────
    describe('party 1: the hub signer', function () {
        let CapabilitySnapshot = null;
        before(function () {
            CapabilitySnapshot = requireSibling(HUB_DIR, 'src/CapabilitySnapshot.js');
            if(!CapabilitySnapshot) this.skip();
        });

        it('resolves at the SAME height the shared helper hands every verifier', function () {
            // The hub buries unconditionally (it always has); the shared helper is what
            // the verifiers use. A drift between the two is the whole defect, so pin them
            // across the boundary and well away from it.
            const cs = new CapabilitySnapshot({ network: 'regtest' });
            for(const h of [0, 3, 6, 7, 993, BURIED, N, N + 1, 250000]){
                assert.strictEqual(cs._buriedBlockIndex(h), srb.buriedSnapshotBlock(h, 'regtest'),
                    'hub and verifier disagree on the resolved height for declared ' + h);
            }
        });

        it('shares ONE literal buffer with the verifiers (no vendored copy to drift)', function () {
            const hubSrb = requireSibling(HUB_DIR, 'src/snapshot_reorg_buffer.js');
            assert.ok(hubSrb, 'the hub must vendor the shared module');
            assert.strictEqual(hubSrb.CANONICAL_REORG_BUFFER, srb.CANONICAL_REORG_BUFFER);
            assert.strictEqual(
                fs.readFileSync(path.join(HUB_DIR, 'src/snapshot_reorg_buffer.js'), 'utf8'),
                fs.readFileSync(path.join(__dirname, '../../src/snapshot_reorg_buffer.js'), 'utf8'),
                'the hub and indexer copies of snapshot_reorg_buffer.js have drifted');
        });
    });

    // ── Party 2: the indexer attestation verifier ────────────────────────────
    describe('party 2: the ATTEST v1 verifier', function () {
        let indexer, handler, ed25519;

        const REQ_ID = 'd'.repeat(64);
        const SIG    = '1'.repeat(128);

        beforeEach(function () {
            ed25519 = require('../../src/ed25519.js');
            indexer = createMockIndexer();
            const db = indexer.indexerDb;

            // Height-sensitive capability resolution: the real db.js predicate, so the
            // verifier's answer depends on WHICH height it asks about.
            db.getValidatorsByCapability = sinon.stub().callsFake(
                async (cap, block) => setAt(block).map(pk => ({ pubkey: pk })));
            db.hasCapability = sinon.stub().callsFake(
                async (pk, cap, block) => setAt(block).includes(String(pk).toLowerCase()));
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
            sinon.stub(ed25519, 'verify').returns(true);
        });

        afterEach(function () { sinon.restore(); });

        function v1Params(sigs){
            const head = ['1', REQ_ID, 'http_get', Buffer.from('hello', 'utf8').toString('base64'), 'ok', 'm', String(sigs.length)];
            const tail = [];
            for(const s of sigs) tail.push(s.pubkey, s.sig);
            return head.concat(tail);
        }

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

        it('resolves the capable set and the responsible set at N-6, never at the declared N', async function () {
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: N + 10, ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PK_A, sig: SIG }, { pubkey: PK_B, sig: SIG }]), data, null);
            const heights = indexer.indexerDb.getValidatorsByCapability.getCalls().map(c => c.args[1]);
            assert.ok(heights.length > 0, 'the verifier must resolve a capability set');
            for(const h of heights)
                assert.strictEqual(h, BURIED, 'a capability set was resolved at ' + h + ', not the buried ' + BURIED);
        });

        it('rejects a signer that only ACTIVATES inside (N-6, N]: it was not in the signed set', async function () {
            // C qualifies at the raw N but not at N-6, so the hub never selected it. A
            // verifier reading the raw height would admit a signer the hub never had.
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: N + 10, ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PK_A, sig: SIG }, { pubkey: PK_C, sig: SIG }]), data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'),
                'a signer outside the hub-resolved set must not count toward quorum');
            assert.strictEqual(data['VALID_SIGS'], 1);
        });

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

    // ── Party 3: archive recovery ────────────────────────────────────────────
    describe('party 3: archive recovery', function () {

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
            await rec._verifyCompleteness(honestArchive, 'regtest');
            const resolutions = btcDb.calls.filter(c => c.method !== 'doQuery');
            assert.ok(resolutions.length > 0, 'completeness must re-resolve the set');
            for(const c of resolutions)
                assert.strictEqual(c.block, BURIED, c.method + ' resolved at ' + c.block + ', not the buried ' + BURIED);
        });

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

    // ── Party 4: the SDK light client ────────────────────────────────────────
    describe('party 4: the SDK light client', function () {
        let light = null;
        before(function () {
            light = requireSibling(SDK_DIR, 'src/light.js');
            if(!light) this.skip();
        });

        it('vendors the identical shared module', function () {
            assert.strictEqual(
                fs.readFileSync(path.join(SDK_DIR, 'src/snapshot_reorg_buffer.js'), 'utf8'),
                fs.readFileSync(path.join(__dirname, '../../src/snapshot_reorg_buffer.js'), 'utf8'),
                'the sdk and indexer copies of snapshot_reorg_buffer.js have drifted');
        });

        it('followForward proves the signer set at N-6, not at the checkpoint\'s declared snapshot_block', async function () {
            // The light client trusts a checkpoint only if a quorum of the set proven at
            // its snapshot_block signed it. That set has to be the one the hub resolved,
            // or a stake change inside the buried window either rejects a valid checkpoint
            // or counts a signer the hub never had. Pin the height it ASKS for; the proof
            // body is deliberately unusable, so followForward stops right after the fetch.
            const urls = [];
            const fetchImpl = async (url) => {
                urls.push(String(url));
                return { ok: true, json: async () => (String(url).includes('/checkpoints/range')
                    ? { checkpoints: [{ block_index: 42, network: 'regtest', snapshot_block: N,
                                        state_root: '0'.repeat(64), validator_signatures: [] }] }
                    : { proof: {} }) };
            };
            const out = await light.followForward({
                explorerUrl: 'http://explorer.invalid',
                trustedCheckpoint: { block_index: 41, network: 'regtest', state_root: '0'.repeat(64) },
                toHeight: 42,
                fetchImpl,
            });
            assert.strictEqual(out.reason, 'VALIDATOR_SET_UNVERIFIED@42',
                'the stubbed proof must fail verification AFTER the set height is requested');
            const proofUrl = urls.find(u => u.includes('/proof/validator-set'));
            assert.ok(proofUrl, 'followForward must request a validator-set proof');
            assert.ok(proofUrl.includes('height=' + BURIED),
                'the light client asked for ' + proofUrl + ', not the buried height ' + BURIED);
            assert.ok(!proofUrl.includes('height=' + N),
                'the light client must not prove the set at the declared height');
        });
    });

    // ── The comment the ledger asked to be true or gone ──────────────────────
    it('actions/attest.js no longer claims the verifier "byte-matches the hub" for the snapshot height', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../src/actions/attest.js'), 'utf8');
        const declLine = src.split('\n').findIndex(l => l.includes('let declaredBlock ='));
        assert.ok(declLine > 0, 'the declared/resolved split must exist');
        // The false claim sat in the three comment lines immediately above the height.
        const preamble = src.split('\n').slice(Math.max(0, declLine - 20), declLine).join('\n');
        assert.ok(!/byte-matches the hub/.test(preamble),
            'the snapshot-height comment still asserts a byte-match the verifier does not have');
    });
});
