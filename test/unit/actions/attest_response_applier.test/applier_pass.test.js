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
// THE HUB-MIRROR ATTEST RESPONSE APPLIER, the pass wiring: how
// utility.processAttestationResponses reads the mirror and synthesizes the v1
// action it hands the handler.
//
// The two units under test, why signature verification is stubbed, and the
// shared rows (./helpers/rows.js) are described in ../attest_response_applier.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Utility  = require('../../../../src/utility.js');

const { REQ_ID, BLOCK_TIME, EFFECTIVE_T, mirrorRow, requestRow } = require('./helpers/rows.js');

// Consecutive sibling blocks under the one suite title, so every full test title
// is the one the suite has always reported.

let util, db, actionsSpy;

// -------------------------------------------------------------- the pass wiring

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    describe('§4.1 applier pass (utility.processAttestationResponses)', function () {
        beforeEach(function () {
            util = new Utility();
            db = {
                config: { NETWORK: 'regtest' },
                getAttestationRequestsAwaitingMirrorResponse: sinon.stub().resolves([requestRow()]),
                getMirroredAttestationResponses: sinon.stub().resolves([mirrorRow()]),
            };
            actionsSpy = { processAction: sinon.stub().resolves() };
        });

        afterEach(function () { sinon.restore(); });

        it('synthesizes an ATTEST v1 with NULL tx coordinates, BLOCK_TIME, and the row pair', async function () {
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.ok(actionsSpy.processAction.calledOnce);
            const [action, params, data] = actionsSpy.processAction.firstCall.args;
            assert.strictEqual(action, 'ATTEST');
            assert.deepStrictEqual(params, [1, REQ_ID]);
            assert.strictEqual(data['FORMAT'], 1);
            assert.strictEqual(data['IS_SYNTHETIC'], true);
            assert.strictEqual(data['BLOCK_INDEX'], 100);
            // settleRequestFee reaches the fee-oracle read through BLOCK_TIME.
            assert.strictEqual(data['BLOCK_TIME'], BLOCK_TIME);
            assert.strictEqual(data['TX_INDEX'], null, 'a mirror-applied response has no transaction');
            assert.strictEqual(data['TX_VOUT'], null);
            assert.ok(data['MIRROR_RESPONSE'] && data['MIRROR_REQUEST']);
        });

        it('reads the mirror only for locally pending requests, scoped by network and block time', async function () {
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.ok(db.getAttestationRequestsAwaitingMirrorResponse.calledWith(100));
            const [network, ids, blockTime] = db.getMirroredAttestationResponses.firstCall.args;
            assert.strictEqual(network, 'regtest');
            assert.deepStrictEqual(ids, [REQ_ID]);
            assert.strictEqual(blockTime, BLOCK_TIME,
                'the mirror is filtered on the SIGNED effective_time against protocol time');
        });

        it('does not touch the mirror at all when nothing is pending locally', async function () {
            db.getAttestationRequestsAwaitingMirrorResponse.resolves([]);
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.strictEqual(db.getMirroredAttestationResponses.called, false);
            assert.strictEqual(actionsSpy.processAction.called, false);
        });

        it('synthesizes nothing at a block one second short of the effective_time', async function () {
            await util.processAttestationResponses(actionsSpy, db, 100, EFFECTIVE_T - 1);
            assert.strictEqual(actionsSpy.processAction.called, false);
        });
    });
});

describe('ATTEST hub-mirror response applier @regression @tier3', function () {
    describe('§4.1 applier pass (utility.processAttestationResponses)', function () {
        beforeEach(function () {
            util = new Utility();
            db = {
                config: { NETWORK: 'regtest' },
                getAttestationRequestsAwaitingMirrorResponse: sinon.stub().resolves([requestRow()]),
                getMirroredAttestationResponses: sinon.stub().resolves([mirrorRow()]),
            };
            actionsSpy = { processAction: sinon.stub().resolves() };
        });

        afterEach(function () { sinon.restore(); });

        it('drives two same-block rows through processAction in the deterministic order', async function () {
            const earlyId = 'f'.repeat(64);
            const lateId  = '0'.repeat(64);
            db.getAttestationRequestsAwaitingMirrorResponse.resolves([
                requestRow({ request_id: lateId,  block_index: 95, action_index: 20 }),
                requestRow({ request_id: earlyId, block_index: 90, action_index: 10 }),
            ]);
            db.getMirroredAttestationResponses.resolves([
                mirrorRow({ request_id: lateId }),
                mirrorRow({ request_id: earlyId }),
            ]);
            await util.processAttestationResponses(actionsSpy, db, 100, BLOCK_TIME);
            assert.deepStrictEqual(
                actionsSpy.processAction.getCalls().map(c => c.args[2]['REQUEST_ID']),
                [earlyId, lateId]);
        });
    });
});
