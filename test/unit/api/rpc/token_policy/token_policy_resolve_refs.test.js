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
const sinon = require('sinon');

const { resolvePolicyRefs } = require('../../../../../src/api/rpc/token_policy/resolve_refs.js');

const SHARED_ROWS = [{ root_index: 12, share_action_index: 13, share_block: 100 }];
const MIRROR = {
    action_index: 40,
    home_chain: 'DOGE',
    home_list_index: 2701,
    block_index: 50
};

function fakeDb(){
    return {
        doQuery: sinon.stub().resolves(SHARED_ROWS),
        getListRootIndex: sinon.stub().callsFake(async index => index === 15 ? 12 : index),
        getListShareMirrorByIndex: sinon.stub().callsFake(async root => root === 40 ? MIRROR : null)
    };
}

describe('token policy reference resolution', function () {
    it('references an edited shared root and a foreign mirror with one shared-list read', async function () {
        const db = fakeDb();

        const refs = await resolvePolicyRefs(db, {
            coin: 'BTC', allowIndex: 15, blockIndex: 40, originBlock: 100
        });

        assert.deepStrictEqual(refs, { allowRef: 'BTC:12', blockRef: 'DOGE:2701' });
        sinon.assert.calledOnce(db.doQuery);
        sinon.assert.calledWithExactly(db.getListRootIndex.firstCall, 15, 16, 100);
        sinon.assert.calledWithExactly(db.getListRootIndex.secondCall, 40, 16, 100);
        sinon.assert.calledWithExactly(db.getListShareMirrorByIndex.firstCall, 12);
        sinon.assert.calledWithExactly(db.getListShareMirrorByIndex.secondCall, 40);
    });

    it('keeps shares and mirrors newer than the origin block as full copies', async function () {
        const db = fakeDb();

        const refs = await resolvePolicyRefs(db, {
            coin: 'BTC', allowIndex: 15, blockIndex: 40, originBlock: 49
        });

        assert.deepStrictEqual(refs, { allowRef: null, blockRef: null });
        sinon.assert.calledOnce(db.doQuery);
    });

    it('keeps an unshared list as a full copy and skips the absent side', async function () {
        const db = fakeDb();

        const refs = await resolvePolicyRefs(db, {
            coin: 'BTC', allowIndex: 41, blockIndex: null, originBlock: 100
        });

        assert.deepStrictEqual(refs, { allowRef: null, blockRef: null });
        sinon.assert.calledOnce(db.doQuery);
        sinon.assert.calledOnceWithExactly(db.getListRootIndex, 41, 16, 100);
        sinon.assert.calledOnceWithExactly(db.getListShareMirrorByIndex, 41);
    });

    it('issues no reads when both policy sides are absent', async function () {
        const db = fakeDb();

        const refs = await resolvePolicyRefs(db, {
            coin: 'BTC', allowIndex: null, blockIndex: undefined, originBlock: 100
        });

        assert.deepStrictEqual(refs, { allowRef: null, blockRef: null });
        sinon.assert.notCalled(db.doQuery);
        sinon.assert.notCalled(db.getListRootIndex);
        sinon.assert.notCalled(db.getListShareMirrorByIndex);
    });
});
