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
// Attestation framework: the cross-chain relay legs.
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
//
// The legs are split by behaviour into consecutive sibling blocks under this one
// suite title, sharing attest_relay.test/helpers/relay_fixture.js for the wire
// builders and the per-test handler. This file holds the inertness and
// activation-plane cases; attest_relay.test/ holds the v3 request leg
// (relay_request.test.js), the home-chain callback suppression and the v4
// response leg (relay_response.test.js), the canonical byte shapes
// (relay_canonicals.test.js) and the origin-side v0 admission
// (origin_admission.test.js).

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../fixtures/mocks');

const attestRelay  = require('../../../src/attest_relay_activation.js');
const { v3Params, v4Params, originRequestRow, setupRelay } = require('./attest_relay.test/helpers/relay_fixture.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

// ── 1. Inertness below the flag-day ──────────────────────────────────────

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, gateStub;
    beforeEach(function () { ({ indexer, handler, gateStub } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

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
});

// ── 2. The activation plane ──────────────────────────────────────────────

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, gateStub;
    beforeEach(function () { ({ indexer, handler, gateStub } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

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
    });
});

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let indexer, handler, gateStub;
    beforeEach(function () { ({ indexer, handler, gateStub } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('activation plane', function () {
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
    });

    describe('activation plane', function () {
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
});
