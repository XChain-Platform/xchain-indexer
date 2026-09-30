/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility = require('../../../src/utility');
const Database = require('../../../src/db');
const airdropRecipients = require('../../../src/actions/airdrop/recipients');
const betValidate = require('../../../src/actions/bet/validate');
const Callback = require('../../../src/actions/callback');
const dispensePricing = require('../../../src/actions/dispense/pricing');
const Dividend = require('../../../src/actions/dividend');
const swapMatch = require('../../../src/actions/swap_match/match');

const TARGET = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
const OTHER = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';
const OWNER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const LIST_INDEX = 10;
const BLOCK_INDEX = 100;

// Serve one stored invalid ADDRESS LIST. The validity gate controls whether the
// real reader returns null or exposes its legacy membership.
function invalidListDb(active){
    const config = Object.assign({}, getTestConfig(), { NETWORK: active ? 'regtest' : 'mainnet' });
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'doQuery').callsFake(async (query) => {
        if(/INNER JOIN index_statuses/.test(query))
            return [];
        if(/SELECT type FROM lists/.test(query))
            return [{ type: '2' }];
        if(/FROM\s+list_items/.test(query))
            return [{ item: OTHER }];
        return [];
    });
    return { config, util, db };
}

afterEach(function () {
    sinon.restore();
});

describe('invalid LIST references in policy consumers @regression @tier2', function () {
    it('swap_match skips the rejected list above the gate and denies below it', async function () {
        async function match(active){
            const { config, util, db } = invalidListDb(active);
            sinon.stub(db, 'getTokenInfo').resolves(null);
            const swap = { ACTION_INDEX: 20, BLOCK_INDEX };
            const swapInfo = {
                GIVE_COIN: 'BTC', GIVE_TICK: 'GIVE', GET_COIN: 'BTC', GET_TICK: 'GET',
                GET_ADDRESS: OWNER, ALLOW_LIST: LIST_INDEX, BLOCK_LIST: null
            };
            const candidate = {
                GIVE_COIN: 'BTC', GIVE_TICK: 'GET', GET_COIN: 'BTC', GET_TICK: 'GIVE',
                GET_ADDRESS: TARGET, ALLOW_LIST: null, BLOCK_LIST: null
            };
            return swapMatch.findSwapMatch.call(
                { config, util, indexerDb: db, loadSwapLists: swapMatch.loadSwapLists },
                { BLOCK_INDEX }, swap, swapInfo, [candidate]
            );
        }

        assert.strictEqual(await match(false), false);
        assert.ok(await match(true));
    });

    it('callback skips the rejected list above the gate and denies below it', async function () {
        async function recipients(active){
            const { config, util, db } = invalidListDb(active);
            sinon.stub(db, 'getTokenInfo').callsFake(async (tick) => tick === 'TEST'
                ? { CALLBACK_TICK: 'CALLBACK', CALLBACK_AMOUNT: '1' }
                : { ALLOW_LIST: LIST_INDEX, BLOCK_LIST: null, DECIMALS: 0 });
            sinon.stub(db, 'getAddressBalances').resolves({});
            sinon.stub(db, 'getAddressPreferences').resolves({});
            sinon.stub(db, 'getHolders').resolves({ [TARGET]: '1' });
            sinon.stub(util, 'createFeesObject').resolves({});
            const ctx = { config, util, indexerDb: db };
            const data = { TICK: 'TEST', SOURCE: OWNER, BLOCK_INDEX, ACTION_INDEX: 30 };
            const state = await Callback.prototype.loadCallbackState.call(ctx, data);
            Callback.prototype.buildCallbackTotals.call(ctx, data, state.tokenInfo, state.callbackTokenInfo,
                state.holders, state.allowList, state.blockList, state.hasAllowList, state.recipients);
            return state.recipients;
        }

        assert.deepStrictEqual(await recipients(false), {});
        assert.deepStrictEqual(Object.keys(await recipients(true)), [TARGET]);
    });

    it('airdrop skips the rejected list above the gate and denies below it', async function () {
        async function approved(active){
            const { util, db } = invalidListDb(active);
            return airdropRecipients.approveAirdropRecipients.call(
                { util, indexerDb: db }, new Set([TARGET]),
                { ALLOW_LIST: LIST_INDEX, BLOCK_LIST: null }, { BLOCK_INDEX }
            );
        }

        assert.deepStrictEqual([...await approved(false)], []);
        assert.deepStrictEqual([...await approved(true)], [TARGET]);
    });

    it('dividend skips the rejected list above the gate and denies below it', async function () {
        async function recipients(active){
            const { util, db } = invalidListDb(active);
            return Dividend.prototype.buildDividendRecipients.call(
                { util, indexerDb: db },
                { SOURCE: OWNER, AMOUNT: '1', BLOCK_INDEX },
                { [TARGET]: '1' },
                { ALLOW_LIST: LIST_INDEX, BLOCK_LIST: null, DECIMALS: 0 },
                {}
            );
        }

        assert.deepStrictEqual(await recipients(false), {});
        assert.deepStrictEqual(Object.keys(await recipients(true)), [TARGET]);
    });

    it('bet skips the rejected list above the gate and denies below it', async function () {
        async function error(active){
            const { config, util, db } = invalidListDb(active);
            sinon.stub(db, 'isActionAllowed').resolves(true);
            return betValidate.validatePlaceGating.call(
                { config, util, indexerDb: db },
                { SOURCE: TARGET, BLOCK_INDEX }, 2,
                { TICK: 'TEST', ALLOW_LIST: LIST_INDEX, BLOCK_LIST: null }, null
            );
        }

        assert.strictEqual(await error(false), 'invalid: SOURCE (not authorized)');
        assert.strictEqual(await error(true), null);
    });

    it('dispense skips the rejected list above the gate and denies below it', async function () {
        async function error(active){
            const { config, util, db } = invalidListDb(active);
            sinon.stub(db, 'getTokenInfo').resolves(null);
            const ctx = {
                config,
                util,
                indexerDb: db,
                checkDispenseLists: dispensePricing.checkDispenseLists
            };
            const row = {
                error: null,
                multiplier: 1,
                dispenser: {
                    GET_TICK: null,
                    GIVE_TICK: null,
                    GET_ADDRESS: TARGET,
                    ALLOW_LIST: LIST_INDEX,
                    BLOCK_LIST: null
                }
            };
            await dispensePricing.checkDispenseSettlement.call(ctx, { data: { SOURCE: TARGET, BLOCK_INDEX } }, row);
            return row.error;
        }

        assert.match(await error(false), /dispenser allow list/);
        assert.strictEqual(await error(true), null);
    });
});
