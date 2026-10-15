'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

/*
 * The bytes the per-block supply refresh writes into tokens.supply under
 * token_supply_representation_activation. Armed, the refresh writes fixed notation, the
 * form the rollback rebuild (createToken) writes, so a node that rolled a block back and
 * replayed it holds the same tokens.supply bytes, and the same state_hash token_supply
 * preimage, as one that did not. Unarmed, the refresh hands doQuery the bignumber, whose
 * toString() gives exponent form from 1e21 up and below 1e-7, byte-identical to before.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const tokenQueries      = require('../../../../src/db/tokens/index.js');
const { collectTokenSupply } = require('../../../../src/consensus/state_hash/gated_sections.js');

const ENV = 'XC_TOKEN_SUPPLY_REPRESENTATION_REGTEST_ACTIVATION';

// One block touching tick WIDE (tick_id 7) whose ledger sums to `credits` at `decimals`.
// tokens.supply is kept as real state: the refresh UPDATE writes it through the same
// boxed-value stringification doQuery applies, and the state_hash token_supply class
// reads it back.
function refreshHarness(network, credits, decimals) {
    const config = Object.assign({}, getTestConfig(), { NETWORK: network, COIN: 'BTC' });
    const util   = new Utility(config);
    const stored = {};
    const db = {
        config,
        util,
        async doQuery(query, params) {
            const args = (params || []).map(a => (a !== null && typeof a === 'object') ? a.toString() : a);
            if (query.includes('DISTINCT(x.tick_id)')) return [{ tick_id: 7, tick: 'WIDE', decimals }];
            if (query.includes('FROM credits m')) return [{ tick_id: 7, s: credits }];
            if (query.includes('FROM debits m') || query.includes('FROM escrows m')) return [];
            if (query === 'UPDATE tokens SET supply=? WHERE tick_id=?') { stored[args[1]] = args[0]; return { affectedRows: 1 }; }
            if (query.includes('t.supply AS supply FROM tokens t')) return [{ tick: 'WIDE', supply: stored[7] }];
            throw new Error('unexpected query: ' + query);
        },
    };
    db.refreshTokenSuppliesForBlock = tokenQueries.refreshTokenSuppliesForBlock;
    return { db, stored };
}

async function refreshed(network, credits, decimals) {
    const { db, stored } = refreshHarness(network, credits, decimals);
    await db.refreshTokenSuppliesForBlock(501);
    return { supply: stored[7], preimage: await collectTokenSupply(db, 501) };
}

const E21 = '1000000000000000000000';

describe('token_supply_representation_activation: tokens.supply bytes @regression @tier1', function () {
    afterEach(function () { delete process.env[ENV]; });

    it('armed: writes a supply of 1e21 and above in fixed notation, and hashes those bytes', async function () {
        process.env[ENV] = 'armed';
        const at = await refreshed('regtest', E21, 0);
        assert.strictEqual(at.supply, E21);
        assert.deepStrictEqual(at.preimage, [{ tick: 'WIDE', supply: E21 }]);
        assert.strictEqual((await refreshed('regtest', '15000000000000000000000.5', 18)).supply, '15000000000000000000000.5');
    });

    it('armed: writes a sub-1e-7 supply in fixed notation', async function () {
        process.env[ENV] = 'armed';
        assert.strictEqual((await refreshed('regtest', '0.00000001', 8)).supply, '0.00000001');
    });

    it('unarmed: keeps the exponent form byte-identical on regtest with the variable unset', async function () {
        const at = await refreshed('regtest', E21, 0);
        assert.strictEqual(at.supply, '1e+21');
        assert.deepStrictEqual(at.preimage, [{ tick: 'WIDE', supply: '1e+21' }]);
        assert.strictEqual((await refreshed('regtest', '0.00000001', 8)).supply, '1e-8');
    });

    it('unarmed: keeps the exponent form on mainnet and testnet even with the variable set', async function () {
        process.env[ENV] = 'armed';
        for (const network of ['mainnet', 'testnet'])
            assert.strictEqual((await refreshed(network, E21, 0)).supply, '1e+21', network);
    });

    it('writes a normal-range supply the same either way', async function () {
        const unarmed = (await refreshed('regtest', '13.5', 2)).supply;
        process.env[ENV] = 'armed';
        assert.strictEqual((await refreshed('regtest', '13.5', 2)).supply, unarmed);
        assert.strictEqual(unarmed, '13.5');
    });
});
