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
// Attestation framework: the cross-chain relay legs, the canonical byte shapes
// the hub must reproduce for both legs, and the EQUIV round separation between
// them.
//
// The suite title, what the relay tests protect in priority order, and the
// shared setup (./helpers/relay_fixture.js) are described in ../attest_relay.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { REQ_ID, setupRelay } = require('./helpers/relay_fixture.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

// ── 6. Canonical byte-shape (the cross-service contract) ─────────────────

describe('Attest cross-chain relay (ATTEST v3/v4) @regression @tier3', function () {
    let handler;
    beforeEach(function () { ({ handler } = setupRelay()); });
    afterEach(function () { sinon.restore(); });

    describe('relay canonicals', function () {

        it('the request canonical is the pinned field order the hub must reproduce', function () {
            sinon.stub(require('../../../../src/consensus/equivocation_header.js'), 'isEquivHeaderActive').returns(false);
            const canonical = handler.relayRequestCanonical({
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
            sinon.stub(require('../../../../src/consensus/equivocation_header.js'), 'isEquivHeaderActive').returns(false);
            const bodyHash = crypto.createHash('sha256').update('body', 'utf8').digest('hex');
            const canonical = handler.relayResponseCanonical({
                requestId: REQ_ID, snapshotBlock: 963000, network: 'mainnet',
                originChain: 'DOGE', homeResponseActionIndex: 777, providerId: 'http_get',
                responseHash: bodyHash, status: 'ok', meta: '200'
            });
            assert.strictEqual(canonical,
                'ATTEST|RELAY_RESPONSE|' + REQ_ID + '|963000|mainnet|DOGE|777|http_get|' +
                bodyHash + '|ok|200');
        });

        it('the two legs of one request_id never share an EQUIV round id', function () {
            const eq = require('../../../../src/consensus/equivocation_header.js');
            sinon.stub(eq, 'isEquivHeaderActive').returns(true);
            const req = handler.relayRequestCanonical({
                requestId: REQ_ID, snapshotBlock: 963000, network: 'mainnet',
                originChain: 'LTC', originActionIndex: 1, providerId: 'http_get',
                requestPayload: '', redundancy: 1, deadlineBlocks: 10
            });
            const res = handler.relayResponseCanonical({
                requestId: REQ_ID, snapshotBlock: 963000, network: 'mainnet',
                originChain: 'LTC', homeResponseActionIndex: 1, providerId: 'http_get',
                responseHash: 'f'.repeat(64), status: 'ok', meta: ''
            });
            assert.notStrictEqual(req, res);
            assert.ok(req.includes('XATTEST'), 'the EQUIV header must be applied when active');
        });
    });
});
