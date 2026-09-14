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
// The XCALL deadline-expiry gate (resultSuppressesExpiry). Part of the XCALL
// suite; see ../xcall.test.js, whose describe title each block here repeats so
// every full test title is unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

// Same module instance Xcall holds a reference to; stubbing `verify` here
// controls signature acceptance inside processResult.
const ed25519 = require('../../../../src/consensus/ed25519.js');

const { PUBKEY_A, SIG_A, freshXcall, makeRequestRow } = require('./helpers/xcall_fixtures.js');

let indexer, handler;

function freshHandler() {
    ({ indexer, handler } = freshXcall());
}

function restoreStubs() {
    sinon.restore();
}

function makeResultRow(overrides = {}) {
    return {
        call_id:              'c'.repeat(64),
        phase:                'result',
        snapshot_block:       150,
        network:              'regtest',
        source_chain:         'BTC',
        target_chain:         'DOGE',
        result_status:        'ok',
        return_payload_b64:   Buffer.from('"42"', 'utf8').toString('base64'),
        effective_time:       1700000000,
        validator_signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        ...overrides,
    };
}

// Result expiry: the deadline-expiry gate (utility.processCrossChainCalls pass 3) must suppress
// expiry ONLY for results that legitimately defer or verify - never on mere row presence,
// or a Byzantine/buggy hub mirror could deadlock the requester's callback (and diverge
// indexers on the synthesized v2 action). resultSuppressesExpiry mirrors processResult's
// delivery gates exactly.
describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('resultSuppressesExpiry', function () {

        it('true when the 2f+1 quorum verifies (deliverable, may be cap-deferred)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            assert.strictEqual(await handler.resultSuppressesExpiry(makeResultRow()), true);
        });

        it('FALSE when the result is finalized but signatures do not verify (Byzantine mirror)', async function () {
            sinon.stub(ed25519, 'verify').returns(false);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            // Presence alone must NOT suppress expiry: the callback would deadlock forever.
            assert.strictEqual(await handler.resultSuppressesExpiry(makeResultRow()), false);
        });

        it('true when the capability snapshot is not mirrored yet (defer, will still deliver)', async function () {
            indexer.indexerDb.getValidatorsByCapability.resolves([]);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([]);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            assert.strictEqual(await handler.resultSuppressesExpiry(makeResultRow()), true);
        });
    });
});

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('resultSuppressesExpiry', function () {

        it('FALSE for an unknown local request', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(null);
            assert.strictEqual(await handler.resultSuppressesExpiry(makeResultRow()), false);
        });

        it('FALSE when the result target_chain does not match the local request (forged routing)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow({ target_chain: 'LTC' }));
            assert.strictEqual(await handler.resultSuppressesExpiry(makeResultRow()), false);
        });

        it('FALSE for another network (belt-and-suspenders)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            assert.strictEqual(await handler.resultSuppressesExpiry(makeResultRow({ network: 'mainnet' })), false);
        });
    });
});
