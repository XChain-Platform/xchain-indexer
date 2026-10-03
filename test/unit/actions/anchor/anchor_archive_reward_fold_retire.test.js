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

const settle = require('../../../../src/actions/anchor/settle.js');
const ar = require('../../../../src/consensus/gates/anchor_reward_gate.js');
const observability = require('../../../../src/observability/index.js');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');

const FOLD_GATE_KEY = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const PUBLISHER = '02'.repeat(33);

function makeContext() {
    const indexerDb = {
        createValidatorReward: sinon.stub().resolves(true),
        reconcileAnchorRewardWinner: sinon.stub().resolves(1),
    };
    return {
        handler: { config: { COIN: 'DOGE', NETWORK: 'regtest' }, indexerDb },
        indexerDb,
        data: {
            NETWORK: 'regtest', BLOCK_INDEX: '8400', ACTION_INDEX: '9',
            SNAPSHOT_BLOCK: '8100', MATCH_BATCH_SEQ: '3', PUBLISHER,
        },
        snapPubkeys: new Set([PUBLISHER]),
    };
}

describe('ANCHOR archive reward fold retirement', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('retires the DOGE-side archive reward when the fold is active', async function () {
        sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(false);
        const foldGate = stubActiveAt(sinon, FOLD_GATE_KEY, true);
        const warn = sinon.stub(observability.getLogger(), 'warn');
        const { handler, indexerDb, data, snapPubkeys } = makeContext();

        await settle.creditArchiveReward(handler, data, true, snapPubkeys, 1);

        assert.ok(foldGate.calledOnceWith(FOLD_GATE_KEY, 'regtest', 'DOGE', 8400, null));
        assert.strictEqual(indexerDb.createValidatorReward.called, false);
        assert.strictEqual(indexerDb.reconcileAnchorRewardWinner.called, false);
        assert.ok(warn.calledOnceWith('\t ANCHOR v1 : archive reward is retired at the fold; reward skipped'));
    });

    it('keeps the frozen archive reward unchanged when the fold is inactive', async function () {
        sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(false);
        const foldGate = stubActiveAt(sinon, FOLD_GATE_KEY, false);
        const { handler, indexerDb, data, snapPubkeys } = makeContext();

        await settle.creditArchiveReward(handler, data, true, snapPubkeys, 1);

        assert.ok(foldGate.calledOnceWith(FOLD_GATE_KEY, 'regtest', 'DOGE', 8400, null));
        assert.deepStrictEqual(indexerDb.createValidatorReward.firstCall.args,
            [PUBLISHER, 3, 'anchor_archive', ar.ARCHIVE_REWARD_AMOUNT, 8100, true, null, 8100]);
        assert.deepStrictEqual(indexerDb.reconcileAnchorRewardWinner.firstCall.args,
            [3, 'anchor_archive', 8400, 9, 8100]);
    });

    for(const foldActive of [false, true]){
        it('keeps the derive-side decision first when fold active is ' + foldActive, async function () {
            sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(true);
            const foldGate = stubActiveAt(sinon, FOLD_GATE_KEY, foldActive);
            const { handler, indexerDb, data, snapPubkeys } = makeContext();

            await settle.creditArchiveReward(handler, data, true, snapPubkeys, 1);

            assert.strictEqual(foldGate.called, false);
            assert.strictEqual(indexerDb.createValidatorReward.called, false);
            assert.strictEqual(indexerDb.reconcileAnchorRewardWinner.called, false);
        });
    }
});
