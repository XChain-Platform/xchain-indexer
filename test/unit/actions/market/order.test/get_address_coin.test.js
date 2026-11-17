// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// ORDER format 0 GET_ADDRESS format under ORDER_GET_ADDRESS_COIN: from the flag a
// cross-chain GET_ADDRESS is checked against GET_COIN's address format, as SWAP's is;
// below it, against this chain's format. Same-chain ORDERs never consult the flag.
// Part of the ORDER suite; see ../order.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData, signedRemoteTokenRow, stubRemoteTokenValidators } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, makeOrderContext } = require('./helpers/order_context.js');

const FLAG = 'ORDER_GET_ADDRESS_COIN';

// A BTC regtest bech32 address, and an LTC regtest one: each valid only on its own coin.
const BTC_ONLY_ADDR = 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul';
const LTC_ONLY_ADDR = 'rltc1qjvuwa4wxg2cvxxkt9hacuujeweamzpu8gs3cvg';

let indexer;
let actionsCtx;
let order;

// Each test starts from its own mock indexer and ORDER handler, with the remote GET token
// a cross-chain ORDER needs, and every protocol change on except FLAG, which `active` sets.
function freshOrder(active) {
    ({ indexer, actionsCtx, order } = makeOrderContext());
    stubRemoteTokenValidators(indexer.indexerDb);
    indexer.indexerDb.mirrorDb = () => ({ getPinnedRemoteToken: sinon.stub().resolves(signedRemoteTokenRow()) });
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => (name === FLAG ? active : true));
}

async function parseOrder(getCoin, getAddress) {
    const params = makeParams(`0|BTC|RAREPEPE|1||${getCoin}|PEPECASH|10||${getAddress}|${EXPIRATION}|||`);
    const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
    await order.parse(params, data, false);
    return data;
}

function flagLookups() {
    return actionsCtx.protocolChanges.isEnabled.getCalls().filter((c) => c.args[0] === FLAG);
}

describe('Order action handler @regression @tier2', function () {
    afterEach(() => sinon.restore());

    describe('Format 0 – GET_ADDRESS coin (ORDER_GET_ADDRESS_COIN)', function () {
        it('the fixture addresses are each valid only on their own coin', function () {
            freshOrder(true);
            const util = indexer.util;
            assert.strictEqual(util.isCryptoAddress(BTC_ONLY_ADDR, 'BTC'), true);
            assert.strictEqual(util.isCryptoAddress(BTC_ONLY_ADDR, 'LTC'), false);
            assert.strictEqual(util.isCryptoAddress(LTC_ONLY_ADDR, 'LTC'), true);
            assert.strictEqual(util.isCryptoAddress(LTC_ONLY_ADDR, 'BTC'), false);
            assert.strictEqual(util.isCryptoAddress(OWNER_ADDR, 'BTC'), true);
            assert.strictEqual(util.isCryptoAddress(OWNER_ADDR, 'LTC'), true);
        });

        it('below the flag a cross-chain ORDER paying a GET_COIN-only address keeps its format refusal', async function () {
            freshOrder(false);
            const data = await parseOrder('LTC', LTC_ONLY_ADDR);
            assert.strictEqual(data['STATUS'], 'invalid: GET_ADDRESS (format)');
            assert.strictEqual(flagLookups().length, 1);
            assert.deepStrictEqual(flagLookups()[0].args, [FLAG, data['BLOCK_INDEX']]);
        });

        it('below the flag a cross-chain ORDER paying a local-only address stays valid', async function () {
            freshOrder(false);
            const data = await parseOrder('LTC', BTC_ONLY_ADDR);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('from the flag a cross-chain ORDER paying a GET_COIN address is valid', async function () {
            freshOrder(true);
            const data = await parseOrder('LTC', LTC_ONLY_ADDR);
            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.notCalled(actionsCtx.processAction);
            assert.strictEqual(flagLookups().length, 1);
        });

        it('from the flag a cross-chain ORDER paying a local-only address is refused on format', async function () {
            freshOrder(true);
            const data = await parseOrder('LTC', BTC_ONLY_ADDR);
            assert.strictEqual(data['STATUS'], 'invalid: GET_ADDRESS (format)');
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    afterEach(() => sinon.restore());

    describe('Format 0 – GET_ADDRESS coin (ORDER_GET_ADDRESS_COIN), unchanged verdicts', function () {
        it('an address valid on both coins stays valid on either side of the flag', async function () {
            for (const active of [false, true]) {
                freshOrder(active);
                const data = await parseOrder('LTC', OWNER_ADDR);
                assert.strictEqual(data['STATUS'], 'valid', `flag ${active}`);
                sinon.restore();
            }
        });

        it('a same-chain ORDER never consults the flag and keeps its verdicts', async function () {
            for (const active of [false, true]) {
                freshOrder(active);
                const local = await parseOrder('BTC', BTC_ONLY_ADDR);
                assert.strictEqual(local['STATUS'], 'valid', `local address, flag ${active}`);
                assert.strictEqual(flagLookups().length, 0);
                sinon.restore();

                freshOrder(active);
                const foreign = await parseOrder('BTC', LTC_ONLY_ADDR);
                assert.strictEqual(foreign['STATUS'], 'invalid: GET_ADDRESS (format)', `foreign address, flag ${active}`);
                assert.strictEqual(flagLookups().length, 0);
                sinon.restore();
            }
        });
    });
});
