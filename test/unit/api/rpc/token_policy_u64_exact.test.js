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

const assert = require('assert');

const { buildTokenPolicyRpc } = require('../../../../src/api/rpc/token_policy.js');

function rpcFor(allowList, blockList){
    const db = {
        getTokenInfo: async () => ({
            ALLOW_LIST: allowList,
            BLOCK_LIST: blockList,
            BRIDGED: 1
        }),
        getLatestBlockIndex: async () => 100,
        isTickSleeping: async () => false,
        getAppliedPolicySnapshot: async () => null
    };
    const indexer = {
        indexerDb: { apiView: () => db },
        util: { parseBridgedTick: () => ({ origin: 'DOGE', name: 'FUFU' }) }
    };
    return buildTokenPolicyRpc({ indexer });
}

describe('getappliedpolicy exact u64 list ids @regression @tier1', function () {
    it('keeps an unsafe allow-list id exact while returning a safe block-list id as a number', async function () {
        const result = await rpcFor('18446744073709551615', '42')
            .getappliedpolicy({ tick: 'DOGE.FUFU' });

        assert.strictEqual(result.allow_list, '18446744073709551615');
        assert.strictEqual(result.block_list, 42);
    });

    it('keeps an unsafe block-list id exact while returning a safe allow-list id as a number', async function () {
        const result = await rpcFor('42', '18446744073709551615')
            .getappliedpolicy({ tick: 'DOGE.FUFU' });

        assert.strictEqual(result.allow_list, 42);
        assert.strictEqual(result.block_list, '18446744073709551615');
    });
});
