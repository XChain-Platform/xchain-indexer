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
// (attestation framework Phase 5, spec §12): the cross-chain relay legs.
//
// What these tests are actually protecting, in priority order:
//   1. INERTNESS. The whole item ships gated. Below ATTEST_RELAY_ACTIVATION a v3
//      or v4 must persist NOTHING, which is what makes replay byte-identical to a
// pre- node treating it as an unknown VERSION.
//   2. THE PLANE. Both legs resolve the flag-day on the BTC-anchored SNAPSHOT_BLOCK
//      they carry. For v4 that is the whole gate: resolving it on an LTC/DOGE local
//      height would ship it live on day one (the documented ATTEST_ADMISSION plane
//      trap). For v3 the snapshot plane is checked ON TOP OF the unforgeable landing
//      height, so this node accepts exactly what the hub will co-sign; the hub has no
//      landing height when it decides, so the snapshot is the only shared predicate.
//   3. THE ANCHOR. The v3 row's responsible set is pinned at the v3's own BTC
//      block_index. That anchor is the entire reason the relay model was chosen
//      over direct polling.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Attest       = require('../../../src/actions/attest.js');
const swq          = require('../../../src/stake_weighted_quorum.js');
const attestRelay  = require('../../../src/attest_relay_activation.js');
const ed25519      = require('../../../src/ed25519.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const REQ_ID   = 'd'.repeat(64);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Positional wire builders. Written out longhand rather than generated so a field
// reorder in the handler shows up here as a failing assertion instead of being
// mirrored silently by a shared helper.
function v3Params(o = {}) {
    return [
        3,
        o.requestId      !== undefined ? o.requestId      : REQ_ID,
        o.originChain    !== undefined ? o.originChain    : 'LTC',
        o.originAction   !== undefined ? o.originAction   : 4242,
        o.providerId     !== undefined ? o.providerId     : 'http_get',
        o.payload        !== undefined ? o.payload        : 'https://example.com/score',
        o.redundancy     !== undefined ? o.redundancy     : 1,
        o.deadlineBlocks !== undefined ? o.deadlineBlocks : 10,
        o.snapshotBlock  !== undefined ? o.snapshotBlock  : 100,
        ...(o.sigTail !== undefined ? o.sigTail : [1, PUBKEY_A, SIG_A]),
    ];
}

function v4Params(o = {}) {
    return [
        4,
        o.requestId       !== undefined ? o.requestId       : REQ_ID,
        o.homeResponseIdx !== undefined ? o.homeResponseIdx : 777,
        o.payloadB64      !== undefined ? o.payloadB64      : b64('{"winner":"home"}'),
        o.status          !== undefined ? o.status          : 'ok',
        o.meta            !== undefined ? o.meta            : '200',
        o.snapshotBlock   !== undefined ? o.snapshotBlock   : 100,
        ...(o.sigTail !== undefined ? o.sigTail : [1, PUBKEY_A, SIG_A]),
    ];
}

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, actionsCtx, handler, executeStub, gateStub, protocolGates;

    function addAttestationDbStubs(db) {
        db.getContract                         = sinon.stub().resolves({ contract_index: 5 });
        db.createAttestationRequest            = sinon.stub().resolves();
        db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
        db.getAttestationRequestById           = sinon.stub().resolves(null);
        db.getRelayRequestById                 = sinon.stub().resolves(null);
        db.getRelayRequestByOrigin             = sinon.stub().resolves(null);
        db.hasCapability                       = sinon.stub().resolves(true);
        db.createAttestationResponse           = sinon.stub().resolves();
        db.incrementAttestationValidatorStat   = sinon.stub().resolves();
        db.updateAttestationRequestStatus      = sinon.stub().resolves();
        db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
        db.getValidatorsByCapability           = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
        db.getStakeWeightsByCapability         = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
        db.createValidatorReward               = sinon.stub().resolves(true);
        db.createActionIndex                   = sinon.stub().resolves(999);
        db.createSavepoint                     = sinon.stub().resolves('sp1');
        db.releaseSavepoint                    = sinon.stub().resolves();
        db.rollbackToSavepoint                 = sinon.stub().resolves();
        db.getTokenDecimalPrecision            = sinon.stub().resolves(8);
        db.getTickerId                         = sinon.stub().resolves(1);
    }

    // An origin-side v0 row that this chain admitted for relay.
    function originRequestRow(overrides = {}) {
        return {
            request_id:           REQ_ID,
            provider_id:          'http_get',
            request_status:       'pending',
            deadline_block:       500,
            block_index:          3160000,      // an LTC local height, deliberately huge
            action_index:         4242,
            redundancy:           1,
            contract_index:       5,
            callback_method:      'onResult',
            callback_params_json: '[]',
            origin_chain:         'LTC',
            fee_amount:           null,
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addAttestationDbStubs(indexer.indexerDb);
        executeStub = { parse: sinon.stub().resolves() };

        // Per-name protocol-change control. A blanket `resolves(true)` would hide the
        // ATTEST_RELAY_ORIGIN gate, which is one of the two things under test.
        protocolGates = { ATTEST_RELAY_ORIGIN: true };
        actionsCtx = {
            config:        indexer.config,
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     indexer.indexerDb,
            actionExecute: executeStub,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().callsFake(async (name) =>
                    protocolGates[name] !== undefined ? protocolGates[name] : true),
            },
        };
        handler = new Attest(actionsCtx);
        indexer.util.resetLists();

        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        // The response-mirror flag day, which regtest arms at genesis: at and above it an
        // on-chain ATTEST v1 is refused outright, and two cases here fulfil a relayed
        // request with exactly that wire. The relay legs themselves are untouched by that
        // era, so these fixtures run below it (attest.test.js owns the gate's own cases).
        sinon.stub(require('../../../src/attest_response_mirror_activation.js'),
                   'isResponseMirrorActive').returns(false);
        // Signature verification is stubbed: these tests are about the relay's
        // structure and gating, not about ed25519 itself.
        sinon.stub(ed25519, 'verify').returns(true);
        // Gate ON by default; the inertness describe drives it OFF explicitly.
        gateStub = sinon.stub(attestRelay, 'isAttestRelayActive').returns(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── 1. Inertness below the flag-day ──────────────────────────────────────

    describe('below ATTEST_RELAY_ACTIVATION', function () {

        it('a v3 persists nothing (indistinguishable from an unknown VERSION)', async function () {
            gateStub.returns(false);
            indexer.config['COIN'] = 'BTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.strictEqual(indexer.indexerDb.createAttestationRequest.called, false);
            assert.strictEqual(indexer.mapper.createMappings.called, false);
            assert.strictEqual(data['STATUS'], undefined,
                'a pre-activation v3 must not even produce a stored status');
        });

        it('a v4 persists nothing', async function () {
            gateStub.returns(false);
            indexer.config['COIN'] = 'LTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160000 });

            await handler.parse(v4Params(), data, null);

            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
            assert.strictEqual(data['STATUS'], undefined);
        });

        it('the real gate (unstubbed) is inert on mainnet below 963000 and live at it', function () {
            gateStub.restore();
            assert.strictEqual(attestRelay.isAttestRelayActive(962999, 'mainnet'), false);
            assert.strictEqual(attestRelay.isAttestRelayActive(963000, 'mainnet'), true);
            // An unknown network must fail closed, never open.
            assert.strictEqual(attestRelay.isAttestRelayActive(99999999, 'devnet'), false);
        });
    });

    // ── 2. The activation plane ──────────────────────────────────────────────

    describe('activation plane', function () {

        it('v4 resolves the gate on the carried SNAPSHOT_BLOCK, not on the local height', async function () {
            gateStub.restore();
            indexer.config['COIN']    = 'LTC';
            indexer.config['NETWORK'] = 'mainnet';
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow());

            // An LTC local height far above the BTC threshold. If the handler gated on
            // BLOCK_INDEX the leg would be live here, which is the exact trap this
            // item was told to avoid.
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160000 });
            await handler.parse(v4Params({ snapshotBlock: 962999 }), data, null);

            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false,
                'a BTC snapshot below the anchor must stay inert even at a huge LTC height');

            // Same action, one BTC block later: now live.
            const data2 = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160000 });
            await handler.parse(v4Params({ snapshotBlock: 963000 }), data2, null);
            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, true);
        });

        it('v3 rejects a SNAPSHOT_BLOCK ahead of its own block (no future-snapshot pinning)', async function () {
            indexer.config['COIN'] = 'BTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params({ snapshotBlock: 900001 }), data, null);

            assert.match(data['STATUS'], /SNAPSHOT_BLOCK/);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
        });

        // The window the v3 gate used to miss. The hub resolves the same flag-day on
        // the snapshot it is about to pin and refuses to co-sign below it, so a v3
        // accepted here on its landing height alone is one the federation never
        // produced, verified against the pre-activation cross_chain signer set.
        it('v3 stays inert when it lands past the flag-day carrying a pre-activation SNAPSHOT_BLOCK', async function () {
            gateStub.restore();
            indexer.config['COIN']    = 'BTC';
            indexer.config['NETWORK'] = 'mainnet';

            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 963000 });
            await handler.parse(v3Params({ snapshotBlock: 962999 }), data, null);

            assert.strictEqual(indexer.indexerDb.createAttestationRequest.called, false,
                'the landing height alone must not materialize a v3 the hub would refuse to co-sign');
            assert.strictEqual(data['STATUS'], undefined,
                'below the flag-day on either plane a v3 persists nothing, not even a verdict');

            // Same landing block, one BTC block later on the signed plane: now live.
            indexer.indexerDb.createAttestationRequest.resetHistory();
            const data2 = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 963000 });
            await handler.parse(v3Params({ snapshotBlock: 963000 }), data2, null);

            assert.strictEqual(data2['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createAttestationRequest.calledOnce, true);
        });

        // The other half of the same gate, and the reason the landing-height check
        // survives rather than being replaced: SNAPSHOT_BLOCK is broadcaster-supplied,
        // so gating on it ALONE would let an invented future snapshot pull the leg
        // live before the flag day and store an 'invalid' verdict where a pre
        // node persists nothing at all.
        it('v3 stays inert below the flag-day even carrying a SNAPSHOT_BLOCK past it', async function () {
            gateStub.restore();
            indexer.config['COIN']    = 'BTC';
            indexer.config['NETWORK'] = 'mainnet';

            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 962999 });
            await handler.parse(v3Params({ snapshotBlock: 963000 }), data, null);

            assert.strictEqual(indexer.indexerDb.createAttestationRequest.called, false);
            assert.strictEqual(data['STATUS'], undefined,
                'a forged future snapshot must not pull the leg live before its landing height');
        });
    });

    // ── 3. v3 materialization on the home chain ──────────────────────────────

    describe('ATTEST v3 (relay request)', function () {

        it('materializes an origin request with the origin stamped on the row', async function () {
            indexer.config['COIN'] = 'BTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
            assert.strictEqual(data['ORIGIN_CHAIN'], 'LTC');
            assert.strictEqual(data['ORIGIN_ACTION_INDEX'], 4242);
            assert.strictEqual(indexer.indexerDb.createAttestationRequest.calledOnce, true);
        });

        it('pins the responsible set at its OWN block index, the BTC anchor the model exists for', async function () {
            indexer.config['COIN'] = 'BTC';
            const spy = sinon.spy(handler, '_computeResponsibleSet');
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params({ snapshotBlock: 899000 }), data, null);

            assert.strictEqual(spy.calledOnce, true);
            assert.strictEqual(spy.firstCall.args[2], 900000,
                'the set must be pinned at the v3 BTC block, not at the signing snapshot');
            assert.strictEqual(data['RESPONSIBLE_SET_JSON'], JSON.stringify([PUBKEY_A]));
        });

        it('carries no callback and no fee on the home chain', async function () {
            indexer.config['COIN'] = 'BTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.strictEqual(data['CALLBACK_METHOD'], null);
            assert.strictEqual(data['CONTRACT_INDEX'], null);
            assert.strictEqual(data['FEE_AMOUNT'], null);
            assert.strictEqual(data['GAS_ESCROW'], '0');
        });

        it('is refused outright on a non-home chain', async function () {
            indexer.config['COIN'] = 'LTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 3160000 });

            await handler.parse(v3Params(), data, null);

            assert.strictEqual(indexer.indexerDb.createAttestationRequest.called, false);
            assert.strictEqual(data['STATUS'], undefined);
        });

        it('rejects an unknown ORIGIN_CHAIN, including the home chain itself', async function () {
            indexer.config['COIN'] = 'BTC';
            for (const chain of ['BTC', 'XMR', '']) {
                indexer.indexerDb.createAttestationRequest.resetHistory();
                const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });
                await handler.parse(v3Params({ originChain: chain }), data, null);
                assert.match(data['STATUS'], /ORIGIN_CHAIN/, 'origin ' + JSON.stringify(chain));
                assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
            }
        });

        it('rejects a request_id already materialized on this chain', async function () {
            indexer.config['COIN'] = 'BTC';
            indexer.indexerDb.getRelayRequestById.resolves(originRequestRow());
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.match(data['STATUS'], /already present/);
        });

        // The griefing shape the narrow lookup exists to close. request_id rides the
        // wire and is derivable in public from the origin chain's v0, so a watcher can
        // front-run the federation with a malformed v3 naming the pending id. That
        // attempt is refused, but it is still STORED as a rejected audit row - and a
        // dedupe that counted stored rows then answered "taken" for the federation's
        // real relay, forever, for one transaction fee.
        it('admits the federation relay after a malformed v3 front-ran its request_id', async function () {
            indexer.config['COIN'] = 'BTC';

            // Step one: the attacker's v3, malformed only in its provider, lands first.
            const griefData = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });
            await handler.parse(v3Params({ providerId: 'not_a_provider' }), griefData, null);

            assert.strictEqual(griefData['REQUEST_STATUS'], 'rejected',
                'the front-run is refused, and the audit row is still written');
            assert.strictEqual(griefData['REQUEST_ID'], REQ_ID,
                'carrying the very request_id the federation is about to relay');

            // Step two: the real relay arrives at the same id. The admitted-only lookup
            // sees nothing, because nothing was admitted.
            const realData = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900001 });
            await handler.parse(v3Params(), realData, null);

            assert.strictEqual(realData['STATUS'], 'valid');
            assert.strictEqual(realData['REQUEST_STATUS'], 'pending',
                'a stored rejected verdict must not consume the request_id');
            assert.strictEqual(indexer.indexerDb.getRelayRequestById.calledWith(REQ_ID), true,
                'the guard asks the admitted-only lookup, not the shared row lookup');
        });

        it('leaves the shared request lookup out of the v3 admission path entirely', async function () {
            // The other half of the ruling: getAttestationRequestById keeps its current
            // behaviour for the four consensus callers that need to see rejected rows
            // (v1 response, v2 expiry, v4 relay response, slash round lookup), so the v3
            // guard must not be reaching for it any more.
            indexer.config['COIN'] = 'BTC';
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow());
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.strictEqual(indexer.indexerDb.getAttestationRequestById.called, false,
                'a row the shared lookup would return must not decide v3 admission');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        // request_id derives from the ORIGIN tx_hash, so a deep origin reorg
        // re-emitting one origin action from a different transaction arrives with a NEW
        // request_id. The request_id guard above waves it through; only the relay identity
        // stops a second, unretractable BTC materialization.
        it('rejects a relay identity already materialized under a different request_id', async function () {
            indexer.config['COIN'] = 'BTC';
            indexer.indexerDb.getRelayRequestByOrigin
                .withArgs('LTC', 4242).resolves(originRequestRow({ request_id: 'b'.repeat(64) }));
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.strictEqual(indexer.indexerDb.getRelayRequestById.calledOnce, true,
                'the request_id guard must have passed: this is the case it cannot see');
            assert.match(data['STATUS'], /ORIGIN_ACTION_INDEX \(relay identity already materialized/);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected',
                'a stored verdict every node reaches identically, not a DB-layer throw');
        });

        it('admits a relay identity this chain has not materialized', async function () {
            indexer.config['COIN'] = 'BTC';
            indexer.indexerDb.getRelayRequestByOrigin
                .withArgs('LTC', 4243).resolves(originRequestRow());
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.strictEqual(indexer.indexerDb.getRelayRequestByOrigin.calledWith('LTC', 4242), true);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
        });

        it('rejects when the cross_chain snapshot is empty (fails closed)', async function () {
            indexer.config['COIN'] = 'BTC';
            indexer.indexerDb.getValidatorsByCapability.resolves([]);
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.match(data['STATUS'], /cross_chain quorum/);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
        });

        it('rejects when a signature does not verify', async function () {
            indexer.config['COIN'] = 'BTC';
            ed25519.verify.returns(false);
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params(), data, null);

            assert.match(data['STATUS'], /cross_chain quorum/);
        });

        it('rejects a malformed signature tail rather than counting a short list', async function () {
            indexer.config['COIN'] = 'BTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            // SIG_COUNT claims two pairs, only one is present.
            await handler.parse(v3Params({ sigTail: [2, PUBKEY_A, SIG_A] }), data, null);

            assert.match(data['STATUS'], /SIG_COUNT/);
        });

        it('does not let a duplicate pubkey inflate the signer count', async function () {
            indexer.config['COIN'] = 'BTC';
            // A 4-key snapshot needs 3 signers; the same key repeated three times must not reach it.
            indexer.indexerDb.getValidatorsByCapability.resolves(
                [PUBKEY_A, PUBKEY_B, 'c'.repeat(64), 'e'.repeat(64)].map(pubkey => ({ pubkey })));
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 3, BLOCK_INDEX: 900000 });

            await handler.parse(v3Params({ sigTail: [3, PUBKEY_A, SIG_A, PUBKEY_A, SIG_A, PUBKEY_A, SIG_A] }), data, null);

            assert.match(data['STATUS'], /cross_chain quorum/);
        });
    });

    // ── 4. v1 callback suppression on the home chain ─────────────────────────

    describe('home-chain callback suppression', function () {

        it('a v1 fulfilling a relayed request fires no local callback', async function () {
            indexer.config['COIN'] = 'BTC';
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({
                block_index: 900000, deadline_block: 900100, origin_chain: 'LTC'
            }));
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 900010 });

            await handler.parse(
                [1, REQ_ID, 'http_get', b64('{"winner":"home"}'), 'ok', '200', 1, PUBKEY_A, SIG_A],
                data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, true,
                'the home-chain request still closes');
            assert.strictEqual(executeStub.parse.called, false,
                'but the contract callback belongs to the origin chain');
        });

        it('a v1 fulfilling a native request still fires the callback', async function () {
            indexer.config['COIN'] = 'BTC';
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({
                block_index: 900000, deadline_block: 900100, origin_chain: null
            }));
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 900010 });

            await handler.parse(
                [1, REQ_ID, 'http_get', b64('ok body'), 'ok', '200', 1, PUBKEY_A, SIG_A],
                data, null);

            assert.strictEqual(executeStub.parse.calledOnce, true);
        });
    });

    // ── 5. v4 response relay + callback injection on the origin chain ────────

    describe('ATTEST v4 (relay response)', function () {

        beforeEach(function () {
            indexer.config['COIN'] = 'LTC';
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow());
        });

        it('closes the origin request and injects the contract callback', async function () {
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160010 });

            await handler.parse(v4Params(), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(
                indexer.indexerDb.updateAttestationRequestStatus.firstCall.args.slice(0, 2),
                [REQ_ID, 'fulfilled']);
            assert.strictEqual(executeStub.parse.calledOnce, true);

            // The callback signature contracts see must be identical to a locally
            // serviced attestation: [request_id, provider_id, status, payload, ...params]
            const callbackArgs = executeStub.parse.firstCall.args[0];
            assert.strictEqual(callbackArgs[0], 0);            // EXECUTE VERSION
            assert.strictEqual(callbackArgs[1], 5);            // contract_index
            assert.strictEqual(callbackArgs[2], 'onResult');   // callback method
            assert.strictEqual(callbackArgs[3], REQ_ID);
            assert.strictEqual(callbackArgs[4], 'http_get');
            assert.strictEqual(callbackArgs[5], 'ok');
            assert.strictEqual(callbackArgs[6], '{"winner":"home"}');
        });

        it('a relayed expiry closes the request as errored with an empty payload', async function () {
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160010 });

            await handler.parse(v4Params({ status: 'expired', payloadB64: '' }), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.firstCall.args[1], 'errored');
            const callbackArgs = executeStub.parse.firstCall.args[0];
            assert.strictEqual(callbackArgs[5], 'expired');
            assert.strictEqual(callbackArgs[6], '');
        });

        it('refuses a retryable status: those must not close an origin request', async function () {
            for (const status of ['no_quorum', 'timeout', 'provider_error']) {
                indexer.indexerDb.updateAttestationRequestStatus.resetHistory();
                const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160010 });
                await handler.parse(v4Params({ status }), data, null);
                assert.match(data['STATUS'], /STATUS/, status);
                assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false, status);
            }
        });

        it('refuses to close a request this chain never admitted for relay', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({ origin_chain: null }));
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160010 });

            await handler.parse(v4Params(), data, null);

            assert.match(data['STATUS'], /not relay-eligible/);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        });

        it('refuses to re-close an already terminal request', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({ request_status: 'fulfilled' }));
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160010 });

            await handler.parse(v4Params(), data, null);

            assert.match(data['STATUS'], /already fulfilled/);
        });

        it('is refused outright on the home chain', async function () {
            indexer.config['COIN'] = 'BTC';
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 900010 });

            await handler.parse(v4Params(), data, null);

            assert.strictEqual(indexer.indexerDb.createAttestationResponse.called, false);
            assert.strictEqual(data['STATUS'], undefined);
        });

        it('rejects when the relay quorum does not verify', async function () {
            ed25519.verify.returns(false);
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160010 });

            await handler.parse(v4Params(), data, null);

            assert.match(data['STATUS'], /cross_chain quorum/);
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false);
        });
    });

    // ── 6. Canonical byte-shape (the cross-service contract) ─────────────────

    describe('relay canonicals', function () {

        it('the request canonical is the pinned field order the hub must reproduce', function () {
            sinon.stub(require('../../../src/equivocation_header.js'), 'isEquivHeaderActive').returns(false);
            const canonical = handler._relayRequestCanonical({
                requestId: REQ_ID, snapshotBlock: 963000, network: 'mainnet',
                originChain: 'LTC', originActionIndex: 4242, providerId: 'http_get',
                requestPayload: 'https://example.com/score', redundancy: 3, deadlineBlocks: 10
            });
            const payloadHash = crypto.createHash('sha256')
                .update('https://example.com/score', 'utf8').digest('hex');
            assert.strictEqual(canonical,
                'ATTEST|RELAY_REQUEST|' + REQ_ID + '|963000|mainnet|LTC|4242|http_get|' +
                payloadHash + '|3|10');
        });

        it('the response canonical is the pinned field order the hub must reproduce', function () {
            sinon.stub(require('../../../src/equivocation_header.js'), 'isEquivHeaderActive').returns(false);
            const bodyHash = crypto.createHash('sha256').update('body', 'utf8').digest('hex');
            const canonical = handler._relayResponseCanonical({
                requestId: REQ_ID, snapshotBlock: 963000, network: 'mainnet',
                originChain: 'DOGE', homeResponseActionIndex: 777, providerId: 'http_get',
                responseHash: bodyHash, status: 'ok', meta: '200'
            });
            assert.strictEqual(canonical,
                'ATTEST|RELAY_RESPONSE|' + REQ_ID + '|963000|mainnet|DOGE|777|http_get|' +
                bodyHash + '|ok|200');
        });

        it('the two legs of one request_id never share an EQUIV round id', function () {
            const eq = require('../../../src/equivocation_header.js');
            sinon.stub(eq, 'isEquivHeaderActive').returns(true);
            const req = handler._relayRequestCanonical({
                requestId: REQ_ID, snapshotBlock: 963000, network: 'mainnet',
                originChain: 'LTC', originActionIndex: 1, providerId: 'http_get',
                requestPayload: '', redundancy: 1, deadlineBlocks: 10
            });
            const res = handler._relayResponseCanonical({
                requestId: REQ_ID, snapshotBlock: 963000, network: 'mainnet',
                originChain: 'LTC', homeResponseActionIndex: 1, providerId: 'http_get',
                responseHash: 'f'.repeat(64), status: 'ok', meta: ''
            });
            assert.notStrictEqual(req, res);
            assert.ok(req.includes('XATTEST'), 'the EQUIV header must be applied when active');
        });
    });

    // ── 7. Origin-side admission relaxation (ATTEST_RELAY_ORIGIN) ────────────

    describe('origin-side v0 admission', function () {

        // A minimal, otherwise-valid v0 emission on the origin chain.
        function v0Emission(coin) {
            const txHash = 'a'.repeat(64);
            const preimage = txHash + ':' + 1 + ':' + '' + ':' + 5 + ':' + 0;
            const rid = crypto.createHash('sha256').update(preimage).digest('hex');
            const data = createBaseData({
                ACTION: 'ATTEST', FORMAT: 0, BLOCK_INDEX: 3160000, TX_HASH: txHash,
                IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0, EMITTER_PATH: '',
                ROOT_ACTION_INDEX: 1, SOURCE: 'origin-addr'
            });
            indexer.config['COIN'] = coin;
            return { data, params: [0, rid, 'http_get', 'https://example.com', 'onResult', '[]', 1, 10] };
        }

        it('admits an off-BTC request and stamps its origin chain when the gate is on', async function () {
            protocolGates.ATTEST_RELAY_ORIGIN = true;
            const { data, params } = v0Emission('LTC');

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
            assert.strictEqual(data['ORIGIN_CHAIN'], 'LTC',
                'the origin stamp is the only marker the hub relay poll keys on');
            // the paired half. On an origin row "the origin chain's v0
            // action_index" is this row's own, and the pair is the relay identity the
            // BTC-side exactly-once guard keys on.
            assert.strictEqual(data['ORIGIN_ACTION_INDEX'], data['ACTION_INDEX']);
            assert.notStrictEqual(data['ORIGIN_ACTION_INDEX'], null);
        });

        it('leaves the admission rejection intact when the gate is off', async function () {
            protocolGates.ATTEST_RELAY_ORIGIN = false;
            const attestAdmission = require('../../../src/attest_admission_activation.js');
            sinon.stub(attestAdmission, 'isAttestAdmissionActive').returns(true);
            const { data, params } = v0Emission('LTC');

            await handler.parse(params, data, null);

            assert.match(data['STATUS'], /responsible set/);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
            assert.strictEqual(data['ORIGIN_CHAIN'], null);
            assert.strictEqual(data['ORIGIN_ACTION_INDEX'], null,
                'both halves of the relay identity share one predicate: a rejected row carries neither');
        });

        it('never stamps an origin on the home chain', async function () {
            protocolGates.ATTEST_RELAY_ORIGIN = true;
            const { data, params } = v0Emission('BTC');

            await handler.parse(params, data, null);

            assert.strictEqual(data['ORIGIN_CHAIN'], null,
                'a BTC request is serviced in place and must never look relay-eligible');
            assert.strictEqual(data['ORIGIN_ACTION_INDEX'], null);
        });
    });
});
