'use strict';

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
// UNSTAKE handler: FORMAT validation, the BTC-only chain restriction, v0
// capability unstake and SIGNING_PUBKEY checks. The v1 contract-targeted and
// partial-unstake blocks live beside it in unstake.test/; every file opens the
// same 'Unstake handler @regression @tier2' describe, so each full test title
// stays under one suite name. unstake.test/helpers/unstake_context.js holds
// the constants, row builders and the mock indexer every block starts from.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { PUBKEY, BLOCK, makeData, makeUnstakeContext } = require('./unstake.test/helpers/unstake_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and UNSTAKE handler.
function freshUnstake() {
    ({ indexer, handler } = makeUnstakeContext());
}

// -----------------------------------------------------------------------
// FORMAT validation
// -----------------------------------------------------------------------

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('FORMAT validation', function () {

        it('unknown format → invalid', async function () {
            const params = ['99', PUBKEY];
            const data   = makeData({ FORMAT: 99 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('null format → invalid', async function () {
            const params = ['', PUBKEY];
            const data   = makeData({ FORMAT: null });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error is preserved', async function () {
            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, 'invalid: upstream error');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

// -----------------------------------------------------------------------
// Chain restriction (v0 capability unstake, BTC only)
// -----------------------------------------------------------------------

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('chain restriction', function () {

        it('DOGE chain with v0 → invalid (capability unstake is BTC-only)', async function () {
            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0, COIN: 'DOGE' });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('BTC only'));
        });

        it('LTC chain with v0 → invalid', async function () {
            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0, COIN: 'LTC' });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('BTC only'));
        });
    });
});

// -----------------------------------------------------------------------
// v0 : Capability unstake
// -----------------------------------------------------------------------

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0 : capability unstake', function () {
        it('valid v0 unstake → STATUS valid, createUnstake called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createUnstake.calledOnce);
        });

        it('valid v0 unstake → setStakeDeactivationByPubkey called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.setStakeDeactivationByPubkey.calledOnce);
        });

        it('valid v0 unstake → mapper.createMappings called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0 : capability unstake', function () {
        it('valid v0 unstake → AMOUNT set to staked amount', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '750.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.AMOUNT, '750.00000000');
        });

        it('valid v0 unstake → COOLDOWN_END_BLOCK set correctly', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            // COOLDOWN_BLOCKS = 1000 in regtest config
            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 1000);
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0 : capability unstake', function () {
        it('no active stake → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('no active stake'));
        });

        it('stake owned by different source → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 99, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(42); // caller is id=42, not 99

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });

        it('source address id null → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(null);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0 : capability unstake', function () {
        it('createUnstake called even on invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null); // invalid : no stake

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createUnstake.calledOnce);
        });

        it('setStakeDeactivationByPubkey NOT called on invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(!indexer.indexerDb.setStakeDeactivationByPubkey.called);
        });
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0 : capability unstake', function () {
        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });
    });
});

// -----------------------------------------------------------------------
// SIGNING_PUBKEY validations
// -----------------------------------------------------------------------

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('SIGNING_PUBKEY validations', function () {

        it('null pubkey → invalid', async function () {
            const params = ['0', ''];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('too-short pubkey → invalid', async function () {
            const params = ['0', 'abcd'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('non-hex pubkey → invalid', async function () {
            const params = ['0', 'z'.repeat(64)];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });
    });
});
