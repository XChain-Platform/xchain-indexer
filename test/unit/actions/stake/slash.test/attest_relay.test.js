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
// SLASH action handler: the XATTEST engine, its hashed-round relay legs
// verified against cross_chain, and the base v1 family read from the request
// row.
// Part of the SLASH suite; see ../slash.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const eq    = require('../../../../../src/consensus/equivocation_header.js');
const { buried, params, data, useSlashHarness } = require('./helpers/slash_harness.js');

// Each test gets a fresh harness from useSlashHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler, offender;
const bind = (h) => { ({ indexer, handler, offender } = h); };

// XATTEST hosts TWO content families (Phase 5). The base v1 canonical is
// delimiter-less and carries no block, so the slot resolver reads it from the mirrored
// request row; the relay legs are XCALL-shaped (snapshot_block at index 3) under a
// HASHED round id, and are quorum-verified against `cross_chain`, not `attestation`.
// A resolver that knows only the base family leaves every relay double-sign
// unslashable: the hashed round id can never match a request_id.
const RELAY_ROUND = 'f1'.repeat(32);   // sha256('ATTESTRELAY|request|req_1') shape
function relayRequestContent(snap, providerId) {
    return ['ATTEST', 'RELAY_REQUEST', 'req_1', String(snap), 'regtest', 'LTC', '5',
            providerId, 'aa'.repeat(32), '3', '100'].join('|');
}
function relayResponseContent(snap, responseHash) {
    return ['ATTEST', 'RELAY_RESPONSE', 'req_1', String(snap), 'regtest', 'LTC', '5',
            'provider_x', responseHash, '1', ''].join('|');
}
// v1 base canonical: request_id + provider + response_hash + status + meta, no delimiters.
function baseAttestContent(responseHash) {
    return 'req_1' + 'provider_x' + responseHash + '1';
}

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('ACCEPTS a relay REQUEST double-sign and slashes the cross_chain bond', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_y'));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['cross_chain', buried(100)],
            'relay legs are locked under cross_chain, the set _verifyRelayQuorum verifies against');
        assert.ok(indexer.indexerDb.getAttestationRequestById.notCalled,
            'a hashed relay ROUND_ID is never a request_id lookup');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('ACCEPTS a relay RESPONSE double-sign', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayResponseContent(100, 'e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayResponseContent(100, 'e2'.repeat(32)));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['cross_chain', buried(100)]);
    });

    it('REJECTS a relay pair that disagrees on snapshot_block', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(101, 'provider_x'));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('REJECTS a mixed base/relay pair (content family mismatch)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, baseAttestContent('e2'.repeat(32)));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/ATTEST content family mismatch/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a REQUEST-vs-RESPONSE pair (relay phase mismatch)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayResponseContent(100, 'e2'.repeat(32)));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/relay phase mismatch/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a relay proof that declares the base engine capability', async function () {
        // CAPABILITY stays derived, never trusted: the family names the governing set.
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_y'));
        const d = data();
        await handler.parse(params('attestation', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('still resolves a BASE v1 ATTEST double-sign from the mirrored request row', async function () {
        indexer.indexerDb.getAttestationRequestById.resolves({ block_index: 90 });
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, 'req_1', 0, baseAttestContent('e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, 'req_1', 0, baseAttestContent('e2'.repeat(32)));
        const d = data();
        await handler.parse(params('attestation', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.getAttestationRequestById.calledWith('req_1'));
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['attestation', buried(90)]);
    });
});
