// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The internal SLASH emission: what processSlashEmission deducts, releases,
// credits and records, and when it refuses or no-ops. Split from
// ../execute.test.js by behaviour.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { CONTRACT, executeData, buildExecute } = require('./helpers/fixture.js');

// Rebuilt by setUp before every test. Module-level so the same-title sibling
// suites below, split only to fit the function-length limit with every full
// test title unchanged, share one fixture.
let indexer, handler;

function setUp() {
    ({ indexer, handler } = buildExecute());
}

function tearDown() {
    sinon.restore();
}

const PUBKEY = 'a'.repeat(64);

function slashEmission(overrides = {}) {
    return { action: 'SLASH', params: { contractIndex: CONTRACT, pubkey: PUBKEY, token: 'STK', amount: '100', ...overrides } };
}

function slashData(overrides = {}) {
    return executeData({ CONTRACT_ACTION_INDEX: CONTRACT, ACTION_INDEX: 99, BLOCK_INDEX: 200, ...overrides });
}

// Wire the DB methods processSlashEmission needs (absent from the default mock).
function wireSlashDb(over = {}) {
    indexer.indexerDb.getContract        = sinon.stub().resolves({ slash_destination_id: 42 });
    indexer.indexerDb.getPubkeyId        = sinon.stub().resolves(7);
    indexer.indexerDb.getTickerId        = sinon.stub().resolves(3);
    // { total, releases }: the deduction reports WHOSE escrow it reduced, because a
    // contract stake is LOCKED there and the handler has to release it before it
    // credits the slash destination.
    indexer.indexerDb.slashContractStake = sinon.stub().resolves({ total: '100', releases: [{ address: '1StakerXXXXXXXXXXXXXXXXXXXXXXXX', amount: '100' }] });
    indexer.indexerDb.doQuery            = sinon.stub().resolves([{ address: '1SlashDestXXXXXXXXXXXXXXXXXXXXX' }]);
    // The destination resolve is the real db method over that stubbed doQuery, so the
    // handler still has to go through index_addresses to find where a slash credits.
    indexer.indexerDb.util = indexer.indexerDb.util || indexer.util;
    indexer.indexerDb.getAddressById =
        require('../../../../src/db/index_tables').getAddressById.bind(indexer.indexerDb);
    indexer.indexerDb.createCredit       = sinon.stub().resolves();
    indexer.indexerDb.createEscrow       = sinon.stub().resolves();
    indexer.indexerDb.createSlashEvent   = sinon.stub().resolves();
    for(const [k, v] of Object.entries(over)) indexer.indexerDb[k] = v;
}

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);
    // ─── processSlashEmission (internal SLASH handler) ───────────────────
    // Driven directly: SLASH emissions never reach the wire/decoder, so they are
    // handled inline by this method rather than the generic emission router.
    describe('processSlashEmission', function () {
        it('slashes stake, credits the destination, and writes a slash event (happy path)', async function () {
            wireSlashDb();
            await handler.processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.slashContractStake.calledWith(CONTRACT, 7, 3, '100'));
            assert.ok(indexer.indexerDb.createCredit.calledWith(99, 'STK', '100', '1SlashDestXXXXXXXXXXXXXXXXXXXXX'));
            // The credit REDIRECTS locked tokens, it does not mint them: the staker's escrow
            // must be released by the same amount, or supply grows by the slashed amount and
            // the burned stake stays locked in escrow for ever.
            assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'the slash must release the staker escrow it burns');
            const esc = indexer.indexerDb.createEscrow.firstCall.args;
            assert.strictEqual(esc[0], 99);
            assert.strictEqual(esc[1], 'STK');
            assert.strictEqual(String(esc[2]), '-100');
            assert.strictEqual(esc[3], '1StakerXXXXXXXXXXXXXXXXXXXXXXXX');
            assert.ok(indexer.indexerDb.createSlashEvent.calledOnce);
            const ev = indexer.indexerDb.createSlashEvent.firstCall.args[0];
            assert.strictEqual(ev['TARGET_CONTRACT_INDEX'], CONTRACT);
            assert.strictEqual(ev['SIGNING_PUBKEY_ID'], 7);
            assert.strictEqual(ev['AMOUNT'], '100');
        });

        it('throws on a contractIndex mismatch (defense in depth)', async function () {
            wireSlashDb();
            await assert.rejects(
                handler.processSlashEmission(slashEmission({ contractIndex: 999 }), slashData()),
                /contractIndex mismatch/);
        });

        it('throws when the contract row is missing', async function () {
            wireSlashDb({ getContract: sinon.stub().resolves(null) });
            await assert.rejects(handler.processSlashEmission(slashEmission(), slashData()), /contract not found/);
        });

        it('throws when the contract has no slash destination configured', async function () {
            wireSlashDb({ getContract: sinon.stub().resolves({ slash_destination_id: null }) });
            await assert.rejects(handler.processSlashEmission(slashEmission(), slashData()), /no slash destination/);
        });

        it('no-ops silently when the pubkey is not staked here', async function () {
            wireSlashDb({ getPubkeyId: sinon.stub().resolves(null) });
            await handler.processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.slashContractStake.notCalled);
            assert.ok(indexer.indexerDb.createCredit.notCalled);
        });

        it('no-ops when the token ticker is unknown', async function () {
            wireSlashDb({ getTickerId: sinon.stub().resolves(null) });
            await handler.processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.slashContractStake.notCalled);
            assert.ok(indexer.indexerDb.createCredit.notCalled);
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('processSlashEmission', function () {
        // seam pin. The VM's new '|' guard on contract.slash's token is
        // defense-in-depth precisely because this handler reads the emission by
        // NAMED field; if it ever pipe-splits instead, a '|'-bearing token would
        // shift fields and the guard stops being optional. Assert the property.
        it('consumes a delimiter-bearing token whole (named-field read, never pipe-split)', async function () {
            wireSlashDb();
            await handler.processSlashEmission(slashEmission({ token: 'ST|K' }), slashData());
            assert.ok(indexer.indexerDb.getTickerId.calledWith('ST|K'),
                'token must reach the ticker lookup intact, not split on "|"');
            assert.ok(indexer.indexerDb.createCredit.calledWith(99, 'ST|K', '100', '1SlashDestXXXXXXXXXXXXXXXXXXXXX'));
        });

        it('no-ops when nothing was actually slashed (0 available)', async function () {
            wireSlashDb({ slashContractStake: sinon.stub().resolves({ total: '0', releases: [] }) });
            await handler.processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.createCredit.notCalled);
            assert.ok(indexer.indexerDb.createSlashEvent.notCalled);
        });

        it('throws when the destination address row is missing', async function () {
            wireSlashDb({ doQuery: sinon.stub().resolves([]) });
            await assert.rejects(handler.processSlashEmission(slashEmission(), slashData()), /destination address row missing/);
        });
    });
});
