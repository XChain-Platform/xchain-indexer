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
// Stake handler: SIGNING_PUBKEY validation, the SOURCE sleeping check and the
// v2 top-up of an existing capability stake.
// Part of the Stake suite; see ../stake.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { PUBKEY, makeData, useStakeHarness } = require('./helpers/stake_harness.js');

// Each test gets a fresh harness from useStakeHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

// -----------------------------------------------------------------------
// SIGNING_PUBKEY validations
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('SIGNING_PUBKEY validations', function () {

        it('null SIGNING_PUBKEY → invalid', async function () {
            const params = ['1', '100.00000000', ''];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('too-short pubkey → invalid', async function () {
            const params = ['1', '100.00000000', 'abcd1234']; // 8 chars, not 64
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('non-hex pubkey → invalid', async function () {
            const params = ['1', '100.00000000', 'z'.repeat(64)];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('valid 64-char hex pubkey → passes pubkey check', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            const params = ['1', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

// -----------------------------------------------------------------------
// SOURCE sleeping
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['1', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });
    });
});

// -----------------------------------------------------------------------
// v2 : Top-up existing capability stake
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v2 : top-up existing capability stake', function () {

        it('valid v2 top-up → STATUS valid', async function () {
            // Active stake exists and is owned by SOURCE (source_id=42)
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(42);

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('v2 top-up : no active stake → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('no active stake to top up'));
        });

        it('v2 top-up : stake owned by different source → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 99, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(42); // current SOURCE id=42, not 99

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });

        it('v2 top-up : source address id null → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(null); // source not found

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });
    });
});
