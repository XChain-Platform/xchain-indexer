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
// Attestation framework: the cross-chain relay legs, v3 materialization on the
// home chain: the origin stamp, the BTC-anchored responsible set, the request_id
// and relay-identity dedupe, and the cross_chain quorum over the signature tail.
//
// The suite title, what the relay tests protect in priority order, and the
// shared setup (./helpers/relay_fixture.js) are described in ../attest_relay.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');

const ed25519      = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, REQ_ID, v3Params, originRequestRow, setupRelay } = require('./helpers/relay_fixture.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

// ── 3. v3 materialization on the home chain ──────────────────────────────

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

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
            const spy = sinon.spy(handler, 'computeResponsibleSet');
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
    });
});

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('ATTEST v3 (relay request)', function () {
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
    });
});

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('ATTEST v3 (relay request)', function () {
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
    });
});

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('ATTEST v3 (relay request)', function () {
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
});
