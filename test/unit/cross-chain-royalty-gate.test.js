// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Create-side CROSS_CHAIN_ROYALTY gate in the ORDER and SWAP handlers: a
// cross-chain listing whose controller guard returns royalty payout_legs is
// DENIED below the flag-day ('royalty not enforceable cross-chain'), and at
// or above it is accepted only when every leg address re-encodes to GET_COIN
// (Utility.canReencodeAddress). Same-chain listings and leg-less cross-chain
// listings are unaffected either side of the flag.
// Design

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../fixtures/mocks');

const Order = require('../../src/actions/order.js');
const Swap  = require('../../src/actions/swap.js');

const OWNER_ADDR  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
// Regtest p2pkh: portable to any coin (shared 0x6f prefix). Regtest segwit
// (bcrt1): portable to LTC (rltc) but NOT to DOGE (no bech32 HRP), which is
// the only leg shape that can fail re-encoding on a regtest-params test.
const LEG_P2PKH   = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const LEG_SEGWIT  = 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul';

const BLOCK_TIME  = 1700000000;
const EXPIRATION  = BLOCK_TIME + 86400 * 30;

function makeActionsCtx(indexer, royaltyEnabled) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            // Every other flag (CROSS_CHAIN_DEX, UNIFIED_FEES, CONTROLLER_GUARD...) stays
            // genesis-active, matching regtest; only the royalty flag is under test.
            isEnabled: sinon.stub().callsFake(async (name) =>
                (name === 'CROSS_CHAIN_ROYALTY') ? royaltyEnabled : true),
        },
        processAction: sinon.stub().resolves(),
    };
}

// Drive one ORDER or SWAP create through the real handler with the guard
// stubbed to return `legs`, and return the parsed data object.
async function runCreate(Handler, action, getCoin, legs, royaltyEnabled) {
    const indexer    = createMockIndexer();
    const actionsCtx = makeActionsCtx(indexer, royaltyEnabled);
    const handler    = new Handler(actionsCtx);

    indexer.indexerDb.getTokenInfo
        .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0 }));
    indexer.indexerDb.getTokenInfo
        .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 0 }));
    indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 20: '999999' });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTickerId.resolves(99);

    sinon.stub(indexer.util, 'maybeRunControllerGuard')
        .resolves({ error: null, guardFee: 0, payoutLegs: legs });

    const params = `0|BTC|RAREPEPE|1||${getCoin}|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`.split('|');
    const data   = createBaseData({ ACTION: action, FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
    await handler.parse(params, data, false);
    return data;
}

describe('Cross-chain royalty create-side gate @regression @tier1', function () {

    afterEach(function () {
        sinon.restore();
    });

    for (const [name, Handler] of [['ORDER', Order], ['SWAP', Swap]]) {
        describe(`${name} create`, function () {

            it('cross-chain + legs + flag OFF → denied (fail-closed), no legs stored', async function () {
                const data = await runCreate(Handler, name, 'LTC', [{ to: LEG_P2PKH, bps: 500 }], false);
                assert.strictEqual(data['STATUS'], 'invalid: royalty not enforceable cross-chain');
                assert.strictEqual(data['PAYOUT_LEGS'], undefined);
            });

            it('cross-chain + legs + flag ON + portable legs → valid, legs stored', async function () {
                const legs = [{ to: LEG_P2PKH, bps: 500 }, { to: LEG_SEGWIT, bps: 100 }];
                const data = await runCreate(Handler, name, 'LTC', legs, true);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(data['PAYOUT_LEGS'], JSON.stringify(legs));
            });

            it('cross-chain + legs + flag ON + non-portable leg → denied, no legs stored', async function () {
                // Segwit leg with GET_COIN=DOGE: DOGE has no bech32 HRP, so the leg can
                // never be paid on the proceeds chain; the listing must not open.
                const data = await runCreate(Handler, name, 'DOGE', [{ to: LEG_SEGWIT, bps: 500 }], true);
                assert.strictEqual(data['STATUS'], 'invalid: royalty leg not payable on proceeds chain');
                assert.strictEqual(data['PAYOUT_LEGS'], undefined);
            });

            it('cross-chain + NO legs + flag OFF → valid (nothing to enforce)', async function () {
                const data = await runCreate(Handler, name, 'LTC', null, false);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(data['PAYOUT_LEGS'], undefined);
            });

            it('same-chain + legs + flag OFF → valid, legs stored (same-chain unaffected)', async function () {
                const legs = [{ to: LEG_P2PKH, bps: 500 }];
                const data = await runCreate(Handler, name, 'BTC', legs, false);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(data['PAYOUT_LEGS'], JSON.stringify(legs));
            });
        });
    }

    describe('CROSS_CHAIN_ROYALTY protocol change registration', function () {
        it('is defined, mainnet flag-day is AFTER CONTROLLER_GUARD, regtest/testnet genesis', function () {
            const ProtocolChanges = require('../../src/protocol_changes.js');
            const Utility = require('../../src/utility.js');
            const pc = new ProtocolChanges({ config: {}, util: new Utility(), decoderDb: {}, indexerDb: {} });
            assert.strictEqual(pc.isDefined('CROSS_CHAIN_ROYALTY'), true);
            const royalty = pc.changes['CROSS_CHAIN_ROYALTY'];
            const guard   = pc.changes['CONTROLLER_GUARD'];
            assert.ok(royalty.mainnet_time > guard.mainnet_time,
                'the deny window requires the royalty flag-day to be strictly after CONTROLLER_GUARD');
            assert.strictEqual(royalty.testnet_time, 0);
            assert.strictEqual(royalty.regtest_time, 0);
        });

        it('regtest activation honors the CROSS_CHAIN_ROYALTY_REGTEST_TIME drill override', function () {
            process.env.CROSS_CHAIN_ROYALTY_REGTEST_TIME = '9999999999';
            try {
                delete require.cache[require.resolve('../../src/protocol_changes.js')];
                const ProtocolChanges = require('../../src/protocol_changes.js');
                const Utility = require('../../src/utility.js');
                const pc = new ProtocolChanges({ config: {}, util: new Utility(), decoderDb: {}, indexerDb: {} });
                assert.strictEqual(pc.changes['CROSS_CHAIN_ROYALTY'].regtest_time, 9999999999);
            } finally {
                delete process.env.CROSS_CHAIN_ROYALTY_REGTEST_TIME;
                delete require.cache[require.resolve('../../src/protocol_changes.js')];
            }
        });
    });
});
