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
// Attestation framework: the cross-chain relay legs, the response side: a v1
// fulfilling a relayed request fires no home-chain callback, and the v4 relay
// response closes the origin request and injects the contract callback there.
//
// The suite title, what the relay tests protect in priority order, and the
// shared setup (./helpers/relay_fixture.js) are described in ../attest_relay.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');

const ed25519      = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, SIG_A, REQ_ID, b64, v4Params, originRequestRow, setupRelay } = require('./helpers/relay_fixture.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

// ── 4. v1 callback suppression on the home chain ─────────────────────────

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, executeStub;
    beforeEach(function () { ({ indexer, handler, executeStub } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

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
});

// ── 5. v4 response relay + callback injection on the origin chain ────────

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, executeStub;
    beforeEach(function () { ({ indexer, handler, executeStub } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

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
    });
});

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('ATTEST v4 (relay response)', function () {
        beforeEach(function () {
            indexer.config['COIN'] = 'LTC';
            indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow());
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
});
