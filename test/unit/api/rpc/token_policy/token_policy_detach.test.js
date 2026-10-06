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
const crypto = require('crypto');
const sinon  = require('sinon');

const { buildTokenPolicyRpc, bridgePolicyHash } = require('../../../../../src/api/rpc/token_policy.js');

const BLOCK = 123;
const TICK  = 'FUFU';

function buildRpc(tokenInfo, listAtBlock){
    const db = {
        getTokenInfo: sinon.stub().resolves(tokenInfo),
        getListAtBlock: sinon.stub().callsFake(listAtBlock),
        isTickSleepingAtBlock: sinon.stub().resolves(false)
    };
    const indexer = { indexerDb: { apiView: sinon.stub().returns(db) } };
    return { db, rpc: buildTokenPolicyRpc({ indexer }) };
}

function assertOriginRead(db){
    sinon.assert.calledOnceWithExactly(db.getTokenInfo, TICK, BLOCK);
    sinon.assert.calledOnceWithExactly(db.isTickSleepingAtBlock, TICK, BLOCK);
}

describe('JSON-RPC detached token policy reads', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps a detached allow list absent while reading the attached block list', async function () {
        const members = ['addrA', 'addrB'];
        const { db, rpc } = buildRpc({ ALLOW_LIST: null, BLOCK_LIST: 42 }, async (id) => {
            assert.strictEqual(id, 42);
            return members;
        });

        const result = await rpc.gettokenpolicy({ tick: TICK, origin_block: BLOCK });

        assert.strictEqual(result.allow_list, null);
        assert.deepStrictEqual(result.block_list, members);
        assert.strictEqual(result.policy_hash, bridgePolicyHash(null, members, false));
        assertOriginRead(db);
        sinon.assert.calledOnceWithExactly(db.getListAtBlock, 42, BLOCK);
        sinon.assert.neverCalledWith(db.getListAtBlock, null, sinon.match.any);
        sinon.assert.neverCalledWith(db.getListAtBlock, 0, sinon.match.any);
    });

    it('distinguishes two absent lists from two existing empty lists', async function () {
        const { db, rpc } = buildRpc({ ALLOW_LIST: null, BLOCK_LIST: null }, async () => []);

        const result = await rpc.gettokenpolicy({ tick: TICK, origin_block: BLOCK });
        const absentHash = crypto.createHash('sha256')
            .update('ALLOW|-|BLOCK|-|SLEEP|0')
            .digest('hex');

        assert.strictEqual(result.allow_list, null);
        assert.strictEqual(result.block_list, null);
        assert.strictEqual(result.policy_hash, absentHash);
        assert.notStrictEqual(result.policy_hash, bridgePolicyHash([], [], false));
        assertOriginRead(db);
        sinon.assert.notCalled(db.getListAtBlock);
    });

    it('returns an existing empty allow list as an empty array', async function () {
        const { db, rpc } = buildRpc({ ALLOW_LIST: 7, BLOCK_LIST: null }, async () => []);

        const result = await rpc.gettokenpolicy({ tick: TICK, origin_block: BLOCK });

        assert.deepStrictEqual(result.allow_list, []);
        assert.strictEqual(result.block_list, null);
        assertOriginRead(db);
        sinon.assert.calledOnceWithExactly(db.getListAtBlock, 7, BLOCK);
    });
});
